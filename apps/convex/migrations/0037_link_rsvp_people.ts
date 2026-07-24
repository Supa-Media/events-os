/**
 * RSVP↔People link backfill (person-centric audiences Phase 1 item 3 —
 * specs/person-centric-audiences.md).
 *
 * `rsvps.personId` shipped in the same deploy as this file, so every
 * pre-existing rsvp row needs its `people` link stamped retroactively — new
 * rsvps get it for free at write time (all six insert sites call
 * `lib/rsvpPeople.ts#linkRsvpToPerson` directly; see that file's doc).
 *
 * NOT wired into the `migrations/index.ts` auto-registry, unlike most files
 * in this folder — same reasoning as the sibling `donorIdentityBackfill.ts`
 * (which this pattern deliberately mirrors, per the spec): `runPending`'s
 * `Migration.run(ctx)` has no arguments and always executes for real on the
 * FIRST deploy that reaches it, with no human review in between. Grouping
 * guests by email and picking a "winning" name (see below) is exactly the
 * kind of judgment call a family-shared-inbox edge case can get wrong, so
 * this is invoked MANUALLY — dry-run (`execute: false`, the default) first to
 * eyeball the counts, then `execute: true` — the same two-step the orchestrator
 * already uses for `donorIdentityBackfill`. It's still numbered (0037, the
 * registry's next slot) purely for discoverability/sequencing alongside the
 * rest of this folder, not because it's ledger-tracked.
 *
 * ============================================================================
 * ONE `.paginate()` PER INVOCATION — hotfix 0037-single-paginate (prod
 * incident, 2026-07-24): Convex hard-fails a query/mutation that calls
 * `.paginate()` more than once during a SINGLE execution ("This query or
 * mutation function ran multiple paginated queries. Convex only supports a
 * single paginated query in each function.") — a RUNTIME rule the
 * `convex-test` harness used by this repo's vitest suite does NOT enforce, so
 * the original version of this file (a `for(;;)` scan loop draining up to
 * `SCAN_CAP` rows across as many `.paginate()` calls as it took, all inside
 * ONE mutation invocation) passed the full suite + CI green and then
 * hard-failed on `npx convex run migrations/0037_link_rsvp_people:
 * backfillLinkRsvpPeople` (dry-run, `{}`) in production — the exact same
 * failure class as the `0039` hotfix. See `tests/migrations0037.test.ts`'s
 * "runner invocation pattern" test, which exercises this the ONLY way that
 * actually catches it: separate `t.run` calls threading the cursor, never
 * more than one `.paginate()` per call.
 *
 * So `linkRsvpPeoplePage` now processes EXACTLY ONE page of `rsvps` per call.
 * This was ALREADY the documented contract for a `SCAN_CAP`-truncated scan
 * (`truncated: true` + `continueCursor`, re-invoke until `isDone`) — that
 * contract is now simply the NORMAL path on every invocation instead of a
 * rare cap-hit fallback, so no caller-facing shape changed. `SCAN_CAP` is
 * gone — there's nothing left for it to bound.
 * ============================================================================
 *
 * ============================================================================
 * ONE ROSTER LOAD PER CHAPTER PER INVOCATION — hotfix 0037-roster-reads (prod
 * incident, 2026-07-24, the very next production attempt after the fix
 * above): making pagination single-call didn't make execute SAFE — the first
 * real production execute (`{execute: true}`, page 1) logged 256+ "linkRsvpToPerson
 * failed" errors ("Too many documents read in a single function execution
 * (limit: 32000)") and silently miscounted every one of them as
 * `skippedNoIdentifier` (`lib/rsvpPeople.ts#linkRsvpToPerson` catches and logs
 * every error — see that file's BEST-EFFORT BY DESIGN doc — so the failure
 * never surfaced as a failure). Root cause: `linkRsvpToPerson` self-loads the
 * chapter roster (`chapterRoster` — an unbounded `.collect()`) on EVERY call,
 * but THIS file was already loading + caching its own roster per chapter for
 * anchor lookups (`loadRoster` below) — so every linked/created row paid for
 * the SAME roster collect TWICE: once for this file's own anchor check, once
 * again inside `linkRsvpToPerson`. At `PAGE_SIZE` rows/page that blew past
 * Convex's 32,000-documents-read-per-execution cap partway through the page.
 * Dry-run never called `linkRsvpToPerson` at all (its preview path already
 * matched against the cached roster directly), which is why dry-run and
 * execute counts diverged for the identical page — not a preview-logic bug,
 * purely the crash.
 *
 * Fixed by using `lib/rsvpPeople.ts#linkRsvpToPersonWithRoster` — the SAME
 * cached `loadRoster(chapterId)` array this file already builds is now
 * threaded into the link call too, so a chapter's roster is read from
 * storage AT MOST ONCE per invocation, no matter how many of that chapter's
 * rows this page links or creates. A newly created contact is appended to
 * that cached array in place (see that function's doc), so a LATER row in
 * the SAME page for the SAME chapter/email still converges onto it — this is
 * what makes cross-row convergence WITHIN one page work at all now that the
 * roster isn't reloaded (and re-observed via the database's own
 * reads-your-writes) on every call.
 *
 * TRUTHFUL COUNTING: `linkRsvpToPersonWithRoster` returns a discriminated
 * `{status: "linked" | "skipped" | "failed"}` instead of swallowing every
 * non-link into a bare `null`, so a genuine "no email/phone to link or create
 * from" (`skippedNoIdentifier`) is never confused with an actual FAILURE
 * (`failed`, surfaced below AND logged loudly if non-zero) the way the prod
 * incident's errors were. With the roster now loaded once, `failed` should
 * be 0 in ordinary operation — it stays as a truthful safety net, not a
 * silence.
 *
 * READ BUDGET (worst case, `PAGE_SIZE` = 500 — see below for why this was
 * lowered back from 1000): reads(page) ≈
 *   PAGE_SIZE                                    // the rsvps page itself
 *   + Σ over each DISTINCT chapter in this page of |that chapter's people|
 *                                                 // one roster collect per
 *                                                 // chapter, cached — see above
 *   + (rows actually linked or created) × ~2      // `ctx.db.get(rsvpId)` for
 *                                                 // the emailVerified check +
 *                                                 // `personEmails`'s own small
 *                                                 // by-person collect
 *   + (rows that CREATE a new contact) × 1        // the `ctx.db.get` needed to
 *                                                 // append the fresh doc to
 *                                                 // the cached roster array
 * With every row in one chapter (the overwhelmingly common case — a page is
 * usually one event's/chapter's guest history), worst case is
 * `500 + |roster| + 500×2 + 500 ≈ 2000 + |roster|` — comfortably inside the
 * 32,000 cap unless a single chapter's `people` table is itself in the tens
 * of thousands, which this app's guest/contact volume is nowhere near today
 * (same footing as `0032_link_donor_people`'s "small at this stage" note).
 * Worst case across MANY distinct chapters in one page (a pathological
 * chapter-shuffled page) sums each chapter's own roster size once — bounded
 * by the number of chapters this app has (small) times a typical chapter's
 * roster size, not by `PAGE_SIZE`. If either assumption stops holding
 * (a single chapter's contact volume grows into the thousands, or a page
 * routinely spans dozens of chapters), lower `PAGE_SIZE` again or add an
 * explicit per-chapter roster cap here — do NOT touch `chapterRoster` itself,
 * which many unrelated authorization call sites also depend on being a
 * complete, uncapped roster.
 * ============================================================================
 *
 * ONE HUMAN, N EVENTS, ONE PERSON: unlike a single live insert (which only
 * ever sees ONE rsvp row and matches it into the roster/contacts on its own),
 * this backfill sees a PAGE of history at a time, so it groups that page's
 * un-linked rsvp rows by (chapterId, normalized email) BEFORE calling
 * `lib/rsvpPeople.ts#linkRsvpToPersonWithRoster` — a repeat attendee whose rows land on
 * the SAME page converges onto ONE person row instead of accidentally
 * matching a differently-created identity per event (email is already the
 * primary match key, so in practice this mostly matters for deciding what to
 * do with a DIVERGENT group — see below). A repeat attendee split across
 * DIFFERENT pages still converges — see "CROSS-PAGE CONVERGENCE" below.
 *
 * DIVERGENT NAMES ON A SHARED EMAIL (spec risk #4 — a household inbox used by
 * more than one attendee): within a page's group, if the rows don't all share
 * the same trimmed name, this picks the "winning" name (most rows IN THIS
 * PAGE, ties broken by earliest `createdAt`, UNLESS an anchor person already
 * exists for the email — see below) and links ONLY that subset via
 * `linkRsvpToPersonWithRoster` (which will match-or-create ONE person for them); every
 * row carrying a different name is left UNLINKED — never guessed at, never
 * merged into a mismatched person. A human resolves it from the People tab
 * like any other bad match. Rows with NO email (phone-only or name-only)
 * aren't groupable — they're linked individually via the same helper
 * (phone/name matching only).
 *
 * IDEMPOTENT: a row with `personId` already set is skipped outright (never
 * re-matched, never re-grouped), so a re-run only ever touches what's still
 * unlinked — including a previous run's intentionally-skipped divergent rows,
 * which stay skipped until a human links them by hand (they'll never
 * spontaneously resolve on their own, by design).
 *
 * CROSS-PAGE CONVERGENCE (this is what makes split-scan-by-default safe):
 * once a page's `execute` pass links a group's winning name, it creates or
 * confirms an "anchor" `people` row for that (chapter, email). Every LATER
 * page's group for the SAME email finds that anchor via `findPersonMatch`
 * first (`winningNameFor` below) and adopts ITS name as the winner instead of
 * re-voting from scratch on whatever rows happen to be on that later page —
 * so a repeat attendee whose rows land on different pages still converges on
 * one person, and a divergent name that lost on an earlier page stays lost on
 * a later one, exactly like a divergent row loses on a same-page re-run.
 * RISK (accepted, same as the original doc's cap-fallback note): if a group's
 * rows straddle a page boundary and NEITHER page alone contains the group's
 * true global majority (e.g. the real majority name is split evenly across
 * two pages, with a third page holding a single divergent row), the FIRST
 * page to observe the email decides the anchor from only ITS OWN slice — a
 * "locally correct" majority that isn't necessarily the GLOBAL majority.
 * Acceptable at this app's guest volume (small enough that this stays a rare,
 * hand-fixable edge case rather than a systemic risk) — a human can always
 * re-point a bad anchor from the People tab.
 *
 * DRY-RUN IS A PER-INVOCATION ESTIMATE, NOT A GLOBAL PREVIEW: dry-run
 * (`execute: false`) never writes, so a later page's preview can't see an
 * earlier page's would-be links/creates — there is no anchor yet for a group
 * that first appeared on an earlier dry-run page, so each page's dry-run
 * counts are independently estimated from ONLY that page's rows. Summing
 * every page's `linked`/`skippedDivergentName` gives a reasonable ballpark of
 * the full run, but — unlike `donorIdentityBackfill`'s single-pass dry-run,
 * which has no comparable cross-invocation split — it is not authoritative.
 * Eyeball the dry-run totals, then trust `execute: true`'s actual
 * anchor-based convergence (described above) for the real, authoritative
 * outcome.
 *
 * SCALE: `PAGE_SIZE` rows scanned per invocation (mirrors `0032_link_donor_
 * people`'s "the CRM's donor count is small at this stage" — guest volume is
 * the same order of magnitude for this app today, so most chapters finish in
 * a single page). Whenever more rows remain, `isDone: false` comes back with
 * `continueCursor` set; a human (or the run-convex-function workflow)
 * re-invokes with `{ cursor: continueCursor }` (same `execute` value) until
 * `isDone: true`. Lowered back to 500 (from an intermediate 1000) by the
 * "ONE ROSTER LOAD PER CHAPTER PER INVOCATION" hotfix above, for read-budget
 * margin — see that section's math.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { normalizeEmail } from "../lib/access";
import { findPersonMatch, linkRsvpToPersonWithRoster } from "../lib/rsvpPeople";
import { hasPersonIdentifier } from "../lib/givingDonors";
import { chapterRoster } from "../lib/org";

/** Rows read per (single) `.paginate()` call — see the module doc's
 *  "ONE `.paginate()` PER INVOCATION" banner, "ONE ROSTER LOAD PER CHAPTER
 *  PER INVOCATION" read-budget math, and "SCALE" note. */
const PAGE_SIZE = 500;

/** Pick the "winning" name within a (chapter, email) group: the name shared
 *  by the most rows, ties broken by the earliest `createdAt` among them. Pure
 *  — no I/O, so both the dry-run preview and the execute path share it. */
function pickWinningName(rows: Doc<"rsvps">[]): string {
  const stats = new Map<string, { count: number; earliest: number }>();
  for (const r of rows) {
    const name = r.name.trim();
    // `createdAt` (the domain timestamp, sometimes backdated to a REAL
    // purchase/RSVP time — e.g. the Givebutter sync) rather than
    // `_creationTime` (this row's own insertion time into OUR db), so a
    // backfilled historical import still ties-break by when it actually
    // happened, not when it happened to be imported.
    const cur = stats.get(name) ?? { count: 0, earliest: r.createdAt };
    cur.count += 1;
    cur.earliest = Math.min(cur.earliest, r.createdAt);
    stats.set(name, cur);
  }
  let winner = "";
  let best = { count: -1, earliest: Number.POSITIVE_INFINITY };
  for (const [name, s] of stats) {
    if (s.count > best.count || (s.count === best.count && s.earliest < best.earliest)) {
      winner = name;
      best = s;
    }
  }
  return winner;
}

type Stats = {
  scanned: number;
  unlinkedFound: number;
  groups: number;
  divergentGroups: number;
  linked: number;
  skippedDivergentName: number;
  skippedNoIdentifier: number;
  /** A genuine infrastructure FAILURE (an exception from `linkRsvpToPersonWithRoster`),
   *  never a legitimate skip — see the module doc's "ONE ROSTER LOAD PER CHAPTER
   *  PER INVOCATION" banner. Should be 0 in ordinary operation; non-zero is
   *  logged loudly (see below) and the affected rows are safely retryable
   *  (idempotent — a re-run only touches what's still unlinked). */
  failed: number;
  truncated: boolean;
  isDone: boolean;
  continueCursor: string | null;
};

/** The paginated worker: scan ONE page, group, and (iff `execute`) link.
 *  Shared by the manual entry point below; kept as a plain function so it's
 *  directly testable without going through `internalMutation`'s wrapper.
 *  `pageSize` is a TEST-ONLY override (not exposed on the public
 *  `backfillLinkRsvpPeople` mutation, which always uses `PAGE_SIZE`) — lets
 *  `tests/migrations0037.test.ts` force a page boundary with a handful of
 *  seeded rows instead of seeding thousands to exercise the real `PAGE_SIZE`. */
export async function linkRsvpPeoplePage(
  ctx: MutationCtx,
  args: { execute: boolean; cursor: string | null; pageSize?: number },
): Promise<Stats> {
  // ── Exactly ONE `.paginate()` call — see the module doc's banner above. ──
  const page = await ctx.db
    .query("rsvps")
    .paginate({ numItems: args.pageSize ?? PAGE_SIZE, cursor: args.cursor });
  const scanned = page.page.length;
  const isDone = page.isDone;
  const unlinked = page.page.filter((r) => r.personId === undefined);

  // ── Group by (chapterId, normalized email) WITHIN THIS PAGE ONLY; rows
  // with no email can't be cross-event deduped, so they're linked
  // individually below. A group split across pages still converges via the
  // anchor mechanism below — see the module doc's "CROSS-PAGE CONVERGENCE". ──
  const groups = new Map<string, Doc<"rsvps">[]>();
  const ungrouped: Doc<"rsvps">[] = [];
  for (const r of unlinked) {
    const email = normalizeEmail(r.email);
    if (!email) {
      ungrouped.push(r);
      continue;
    }
    const key = `${r.chapterId}::${email}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  let linked = 0;
  let skippedDivergentName = 0;
  let skippedNoIdentifier = 0;
  let failed = 0;
  let divergentGroups = 0;

  // Roster cache, one load per chapter — used to find an ALREADY-ESTABLISHED
  // person for a group's email (from a prior run, a live insert, or a donor
  // link) before falling back to majority vote. THIS is what keeps the
  // divergent-name guard idempotent across separate runs: once a group's
  // winning subset links (creating or confirming the anchor person), a LATER
  // run only sees the STILL-divergent rows left over — with no competing
  // sibling in the unlinked pool anymore, a naive per-run majority vote would
  // wrongly treat the minority name as its own trivial "winner" and merge it
  // into the anchor via email. Anchoring on the EXISTING person's name (when
  // one exists) instead of re-voting keeps a once-rejected divergent row
  // rejected on every subsequent run, not just the first.
  const rosterByChapter = new Map<string, Doc<"people">[]>();
  const loadRoster = async (chapterId: Id<"chapters">) => {
    const key = String(chapterId);
    const cached = rosterByChapter.get(key);
    if (cached) return cached;
    const fresh = await chapterRoster(ctx, chapterId);
    rosterByChapter.set(key, fresh);
    return fresh;
  };
  const winningNameFor = async (
    chapterId: Id<"chapters">,
    email: string,
    rows: Doc<"rsvps">[],
  ): Promise<string> => {
    const roster = await loadRoster(chapterId);
    const anchor = findPersonMatch(roster, { email });
    return anchor ? anchor.name.trim() : pickWinningName(rows);
  };

  if (args.execute) {
    // Tally one `linkRsvpToPersonWithRoster` outcome truthfully — a FAILURE
    // (an infrastructure exception) is never folded into `skippedNoIdentifier`
    // (see the module doc's "ONE ROSTER LOAD PER CHAPTER PER INVOCATION"
    // banner — that miscount is exactly what hid the prod incident).
    const tally = (result: Awaited<ReturnType<typeof linkRsvpToPersonWithRoster>>) => {
      if (result.status === "linked") linked++;
      else if (result.status === "skipped") skippedNoIdentifier++;
      else failed++;
    };

    for (const rows of groups.values()) {
      const chapterId = rows[0].chapterId;
      const email = normalizeEmail(rows[0].email) as string; // group key guarantees this
      const winner = await winningNameFor(chapterId, email, rows);
      const winning = rows.filter((r) => r.name.trim() === winner);
      const divergent = rows.filter((r) => r.name.trim() !== winner);
      if (divergent.length > 0) divergentGroups++;
      skippedDivergentName += divergent.length;
      // The SAME cached array `winningNameFor` just read via `loadRoster` —
      // a cache hit, not a second DB read (see the read-budget math above).
      const roster = await loadRoster(chapterId);
      for (const r of winning) {
        // Sequential on purpose: the first call in a group may INSERT the
        // contact person (appending it to `roster` in place); every
        // subsequent call for the SAME group then MATCHES it off that same
        // in-memory roster — one person for the whole group, never one per
        // row, and never a second DB read for this chapter.
        tally(
          await linkRsvpToPersonWithRoster(
            ctx,
            { rsvpId: r._id, chapterId: r.chapterId, name: r.name, email: r.email, phone: r.phone },
            roster,
          ),
        );
      }
    }
    for (const r of ungrouped) {
      const roster = await loadRoster(r.chapterId);
      tally(
        await linkRsvpToPersonWithRoster(
          ctx,
          { rsvpId: r._id, chapterId: r.chapterId, name: r.name, email: r.email, phone: r.phone },
          roster,
        ),
      );
    }

    if (failed > 0) {
      // Loud, distinct from the per-row `console.error` inside
      // `linkRsvpToPersonWithRoster` — a page-level summary an operator
      // scanning logs can't miss. Safe to re-run: idempotent, and a failed
      // row's `personId` was never set, so it stays in the unlinked pool.
      console.error(
        `migrations/0037_link_rsvp_people: ${failed} row(s) FAILED to link on this page ` +
          `(see individual errors above) — safe to re-run, this migration is idempotent`,
      );
    }
  } else {
    // Dry run: preview counts WITHOUT writing. Mirrors the real matcher
    // read-for-read (`findPersonMatch` + `hasPersonIdentifier`) but never
    // calls `ctx.db.insert`/`patch`. `plannedInserts` dedupes "would create a
    // new contact" within this preview the same way `donorIdentityBackfill`'s
    // `plannedKeys` does, so N un-matched rows for the same identity in this
    // dry run don't inflate the estimate into N phantom inserts.
    const plannedInserts = new Set<string>();

    const previewOne = async (r: Doc<"rsvps">) => {
      const roster = await loadRoster(r.chapterId);
      const match = findPersonMatch(roster, {
        email: r.email,
        phone: r.phone,
        name: r.name,
      });
      if (match) {
        linked++;
        return;
      }
      if (!hasPersonIdentifier({ email: r.email, phone: r.phone })) {
        skippedNoIdentifier++;
        return;
      }
      const key = `${r.chapterId}::${normalizeEmail(r.email) ?? r.phone?.trim() ?? r.name.trim()}`;
      if (!plannedInserts.has(key)) plannedInserts.add(key);
      linked++;
    };

    for (const rows of groups.values()) {
      const email = normalizeEmail(rows[0].email) as string;
      const winner = await winningNameFor(rows[0].chapterId, email, rows);
      const winning = rows.filter((r) => r.name.trim() === winner);
      const divergent = rows.filter((r) => r.name.trim() !== winner);
      if (divergent.length > 0) divergentGroups++;
      skippedDivergentName += divergent.length;
      for (const r of winning) await previewOne(r);
    }
    for (const r of ungrouped) await previewOne(r);
  }

  return {
    scanned,
    unlinkedFound: unlinked.length,
    groups: groups.size,
    divergentGroups,
    linked,
    skippedDivergentName,
    skippedNoIdentifier,
    failed,
    truncated: !isDone,
    isDone,
    continueCursor: isDone ? null : page.continueCursor,
  };
}

/**
 * Manual entry point — `npx convex run migrations/0037_link_rsvp_people:backfillLinkRsvpPeople`
 * (add `--prod` for production), dry-run by default. Pass `{ execute: true }`
 * to actually write. Processes ONE page per call (see the module doc's "ONE
 * `.paginate()` PER INVOCATION" banner) — pass `{ cursor }` from the previous
 * call's `continueCursor` to keep going, and repeat (same `execute` value)
 * until the result comes back `isDone: true`.
 */
export const backfillLinkRsvpPeople = internalMutation({
  args: {
    execute: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    return await linkRsvpPeoplePage(ctx, {
      execute: args.execute ?? false,
      cursor: args.cursor ?? null,
    });
  },
});
