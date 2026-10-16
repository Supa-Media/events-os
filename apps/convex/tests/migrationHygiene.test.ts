import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MIGRATION HYGIENE GUARDS — two failure classes that both bit production on
 * 2026-07-27 and that neither typecheck nor the normal test suite can catch,
 * because both only misbehave against a REAL Convex backend with real data.
 *
 *  1. DUPLICATE NUMBERS. Sequentially-numbered migrations and parallel PRs
 *     don't mix: two branches open at once both grab the next free number, and
 *     whichever merges second lands a duplicate. It happened twice in one day
 *     (#452 fixed `0049` colliding with `0049_seed_builtin_campaign_templates`).
 *     A duplicate misleads the next author and breaks the registry's ordering
 *     assumption.
 *
 *  2. A LOOPED `.paginate()`. Convex allows exactly ONE paginated query per
 *     function. A `for (;;) { …paginate… }` loop therefore throws
 *     "This query or mutation function ran multiple paginated queries" the
 *     moment the data no longer fits in a single page. It took the production
 *     deploy red at the post-deploy `migrations:runPending` step (#454).
 *     Use an indexed `.take()` walk instead, or one `.paginate()` per
 *     invocation with a scheduler self-reschedule.
 *
 * The lesson worth keeping: green CI said nothing about whether a migration
 * survives contact with a real backend. These two tests close that gap for the
 * cheapest, most repeatable half of it.
 */

const CONVEX_DIR = join(__dirname, "..");
const MIGRATIONS_DIR = join(CONVEX_DIR, "migrations");

/** Every Convex source file, excluding generated code, tests, and node_modules. */
function convexSourceFiles(dir: string = CONVEX_DIR, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "_generated" || entry.name === "tests") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) convexSourceFiles(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

/** Every `NNNN_name.ts` migration file, excluding `index.ts`. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.ts$/.test(f))
    .sort();
}

/**
 * Source with comments removed, so a `.paginate()` mentioned in a doc comment
 * (this file's own subject matter, and the note left in
 * `0051_backfill_people_persona.ts` explaining why it must NOT loop) never
 * trips the guard.
 */
function codeWithoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * True when `body` contains a BUILT-IN `.paginate()` — i.e. one reached from
 * `ctx.db`, not from `convex-helpers`' `paginator(...)`. `paginator` is the
 * sanctioned escape hatch: it is explicitly documented as safe to call
 * multiple times in one function, so a loop around it is correct, not a bug.
 * Walks back from each `.paginate(` to the start of its statement and checks
 * whether that expression was rooted in `paginator(`.
 */
function hasBuiltinPaginate(body: string): boolean {
  let from = 0;
  for (;;) {
    const at = body.indexOf(".paginate(", from);
    if (at === -1) return false;
    // Delimit on `;`/`{` ONLY. An `=` would be wrong: the arrow in a
    // `withIndex((q) => …)` callback sits between `paginator(` and
    // `.paginate(`, so treating `=` as a boundary hides the root of the chain.
    const stmtStart = Math.max(body.lastIndexOf(";", at), body.lastIndexOf("{", at));
    const expression = body.slice(stmtStart + 1, at);
    if (!expression.includes("paginator(")) return true;
    from = at + ".paginate(".length;
  }
}

/** Index just past the `)` matching the `(` at `openParen`. */
function endOfParams(code: string, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return openParen;
}

/** Brace-match the body that starts at the first `{` at or after `from`. */
function bodyAfter(code: string, from: number): { start: number; end: number } | null {
  const start = code.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

/**
 * Names of functions declared in `code` whose own body issues a built-in
 * `.paginate()`. Calling one from inside a loop is just as fatal as
 * paginating in the loop directly — and that INDIRECTION is exactly what took
 * the People tab down on 2026-07-27: `listPaginated` looped, while the
 * `.paginate()` lived one call away in `paginateSortedPeople`. A detector that
 * only inspected the loop body would have missed the real outage, so it has to
 * follow same-file calls too.
 */
function paginatingFunctionNames(code: string): Set<string> {
  const names = new Set<string>();
  const decl =
    /(?:async\s+function|function)\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(code)) !== null) {
    const name = m[1] ?? m[2];
    // Skip PAST the parameter list before looking for the body brace: a param
    // with an inline object type (`opts: { numItems: number }`) would otherwise
    // be mistaken for the function body — which silently made this guard blind
    // to the very outage it exists to catch.
    const body = bodyAfter(code, endOfParams(code, m.index + m[0].length - 1));
    if (name && body && hasBuiltinPaginate(code.slice(body.start, body.end))) names.add(name);
  }
  return names;
}

/**
 * True when a `.paginate(` call sits lexically inside a `for`/`while` block.
 * Brace-matches from each loop header to its closing brace rather than
 * regex-guessing across the whole file, so a loop that merely appears
 * somewhere in the same file as an unrelated single `.paginate()` is not
 * flagged.
 */
function hasLoopedPaginate(code: string): boolean {
  const paginating = paginatingFunctionNames(code);
  const loopHeader = /\b(for|while)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = loopHeader.exec(code)) !== null) {
    // Walk from the loop keyword to the `{` that opens its body.
    let i = match.index;
    let depth = 0;
    let bodyStart = -1;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
      else if (code[i] === "{" && depth === 0) {
        bodyStart = i;
        break;
      }
    }
    if (bodyStart === -1) continue;
    // Brace-match to the end of the loop body.
    let braces = 0;
    let bodyEnd = code.length;
    for (let j = bodyStart; j < code.length; j++) {
      if (code[j] === "{") braces++;
      else if (code[j] === "}") {
        braces--;
        if (braces === 0) {
          bodyEnd = j;
          break;
        }
      }
    }
    const loopBody = code.slice(bodyStart, bodyEnd);
    if (hasBuiltinPaginate(loopBody)) return true;
    // …or calls a same-file helper that paginates (the #458 shape).
    for (const fn of paginating) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(loopBody)) return true;
    }
  }
  return false;
}

/**
 * GRANDFATHERED, deliberately not fixed. Each of these loops `.paginate()` and
 * would throw if its table ever outgrew one page — but every one has ALREADY
 * RUN to completion in production, and the migration ledger never re-runs an
 * applied migration, so the latent bug can no longer fire. (A brand-new
 * deployment runs them against an empty database, where the loop exits on its
 * first page.) Rewriting applied migrations would be churn with no payoff.
 *
 * DO NOT ADD TO THIS LIST. A new migration must use an indexed `.take()` walk.
 * If you are here because CI failed, that is the guard working.
 */
const GRANDFATHERED_LOOPED_PAGINATE = new Set([
  "0031_gift_method_sources.ts",
  "0032_link_donor_people.ts",
  "0035_backfill_receipt_documents.ts",
  "0037_link_rsvp_people.ts",
  "0038_backfill_contact_only_people.ts",
  "0039_backfill_person_emails.ts",
  "0040_migrate_legacy_audiences.ts",
  "0041_migrate_guest_audiences.ts",
  "0042_wrap_targeting.ts",
  "0043_split_person_names.ts",
  "0044_reimbursement_payouts_outflow.ts",
  "0045_backfill_personal_repayments.ts",
]);

describe("migration hygiene", () => {
  test("no two migrations share a number", () => {
    const byNumber = new Map<string, string[]>();
    for (const file of migrationFiles()) {
      const number = file.slice(0, 4);
      byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
    }
    const duplicates = [...byNumber.entries()].filter(([, files]) => files.length > 1);
    expect(
      duplicates.map(([number, files]) => `${number}: ${files.join(", ")}`),
      "Two migrations claim the same number — rebase and renumber the later one. " +
        "Remember the number hides in FIVE places: the filename, the internal " +
        "`name:` string, the import in migrations/index.ts, the registration in " +
        "that same file, and tests/migrations.test.ts's order list (plus any " +
        "`internal.migrations[\"...\"]` lookups and doc-comment references).",
    ).toEqual([]);
  });

  test("no NEW migration loops .paginate() — Convex allows one paginated query per function", () => {
    const offenders = migrationFiles().filter((file) => {
      if (GRANDFATHERED_LOOPED_PAGINATE.has(file)) return false;
      const code = codeWithoutComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      return hasLoopedPaginate(code);
    });
    expect(
      offenders,
      "A migration loops `.paginate()`. Convex only supports ONE paginated query " +
        "per function, so this throws the moment the table outgrows a single page " +
        "— it took the production deploy red on 2026-07-27. Walk with an indexed " +
        "`.take()` instead (see 0051_backfill_people_persona.ts), or issue one " +
        "`.paginate()` per invocation and self-reschedule via ctx.scheduler.",
    ).toEqual([]);
  });

  test("the guard itself detects a looped paginate (and ignores comments and unlooped calls)", () => {
    expect(hasLoopedPaginate('for (;;) { const p = await q.paginate({}); }')).toBe(true);
    expect(hasLoopedPaginate('while (more) { await q.paginate({}); }')).toBe(true);
    // A single paginate outside any loop is fine.
    expect(hasLoopedPaginate('const p = await q.paginate({}); for (const x of xs) { f(x); }')).toBe(
      false,
    );
    // A loop that doesn't paginate is fine.
    expect(hasLoopedPaginate("for (const x of xs) { await ctx.db.patch(x._id, {}); }")).toBe(false);
    // `paginator(...)` is the sanctioned escape hatch — looping it is CORRECT.
    expect(
      hasLoopedPaginate('for (;;) { const p = await paginator(ctx.db, schema).query("t").paginate({}); }'),
    ).toBe(false);
    // Regression: an arrow function between `paginator(` and `.paginate(` must
    // not hide the chain's root (this shape defeated the first detector).
    expect(
      hasLoopedPaginate(
        'for (;;) { const r = await paginator(ctx.db, schema).query("g").withIndex("by_d", (q) => q.eq("d", id)).paginate({}); }',
      ),
    ).toBe(false);
    expect(
      hasLoopedPaginate(
        'for (;;) { const r = await ctx.db.query("g").withIndex("by_d", (q) => q.eq("d", id)).paginate({}); }',
      ),
    ).toBe(true);
    // THE #458 SHAPE: the loop calls a helper that paginates one level away.
    // The first version of this guard missed exactly this and would NOT have
    // caught the real outage.
    expect(
      hasLoopedPaginate(
        'async function helper(ctx) { return await ctx.db.query("p").paginate({}); }\n' +
          "for (let i = 0; i < 10; i++) { const b = await helper(ctx); }",
      ),
    ).toBe(true);
    // …and with an inline object type in the parameter list, which is the
    // EXACT signature of `people.ts#paginateSortedPeople`. An earlier version
    // of this guard mistook that param for the function body and reported a
    // clean bill of health on the real, live outage.
    expect(
      hasLoopedPaginate(
        'async function helper(ctx, opts: { numItems: number; cursor: string | null }) {\n' +
          '  return await ctx.db.query("p").paginate(opts);\n' +
          "}\n" +
          "for (let i = 0; i < 10; i++) { const b = await helper(ctx, o); }",
      ),
    ).toBe(true);
    // Comments must never trip it.
    expect(hasLoopedPaginate(codeWithoutComments("/* for (;;) { .paginate( } */ const a = 1;"))).toBe(
      false,
    );
  });

  test("NO Convex function anywhere loops .paginate() — not just migrations", () => {
    // Scoping the guard to `migrations/` was itself a mistake: within an hour
    // of adding it, the SAME rule took the whole People tab down from
    // `people.ts#listPaginated` (#458), which the migrations-only guard could
    // never have seen. Two production incidents from one rule; the guard
    // belongs at backend scope.
    const offenders = convexSourceFiles()
      .filter((full) => !GRANDFATHERED_LOOPED_PAGINATE.has(full.split("/").pop() ?? ""))
      .filter((full) => hasLoopedPaginate(codeWithoutComments(readFileSync(full, "utf8"))))
      .map((full) => full.slice(CONVEX_DIR.length + 1));
    expect(
      offenders,
      "A Convex function loops `.paginate()`. Convex allows exactly ONE paginated " +
        "query per function, so this throws as soon as the data outgrows a single " +
        "page — and `convex-test` does NOT enforce the limit, so your tests will " +
        "pass while production 500s. Use `paginator(ctx.db, schema)` from " +
        "`convex-helpers/server/pagination`, which is safe to call repeatedly in " +
        "one function (see `people.ts#paginateSortedPeople`), or walk with an " +
        "indexed `.take()`.",
    ).toEqual([]);
  });

  test("every grandfathered file still exists (prune the list when one is deleted)", () => {
    const present = new Set(migrationFiles());
    const stale = [...GRANDFATHERED_LOOPED_PAGINATE].filter((f) => !present.has(f));
    expect(stale, "Grandfather list names a migration that no longer exists.").toEqual([]);
  });
});
