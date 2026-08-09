import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDLED_STRIPE_EVENTS, isCovered } from "../stripeWebhookCoverage";

/**
 * STRIPE WEBHOOK COVERAGE GUARD.
 *
 * `stripeWebhookCoverage.ts` compares the event types `http.ts` handles against
 * what the live Stripe endpoint is subscribed to. That check is only as good as
 * its hand-written list, and a list that silently falls behind `http.ts` would
 * recreate the exact blind spot it exists to close (a handler nobody is
 * subscribed to, failing silently — see that module's header).
 *
 * So this parses the real `http.ts` fan-out and fails when the two disagree.
 * Adding a branch to the fan-out means adding one string to
 * `HANDLED_STRIPE_EVENTS`; this test tells you so by name.
 */

const HTTP_TS = join(__dirname, "..", "http.ts");

/**
 * Strip comments so prose doesn't read as code — `http.ts` names event types in
 * comments (`// invoice.paid / invoice.payment_failed:` above the payload type),
 * and a documented type is not a handled one.
 *
 * ORDER IS LOAD-BEARING: line comments go FIRST. `http.ts` documents route globs
 * in line comments (`// … (/api/give/*).`, and two more). Run the block pass
 * first and that `/*` opens a match that runs to the next `*` + `/` — deleting
 * every line in between, real code included. A branch sitting in that window
 * vanishes from the parse, `undeclared` and `stale` both come back empty, and
 * this file goes green while the list is wrong: precisely the silent pass it
 * exists to prevent. Found in review of the PR that added this file.
 *
 * Pure and separate from the file read so the hazard can be unit-tested below
 * rather than depending on where `http.ts` happens to put its comments today.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every event type dispatched on in a (comment-stripped) source. */
function dispatchTypesIn(src: string): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(/event\.type\s*===\s*"([^"]+)"/g)) {
    found.add(m[1]);
  }
  for (const m of src.matchAll(/event\.type\.startsWith\(\s*"([^"]+)"\s*\)/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

function handledInHttpTs(): string[] {
  return dispatchTypesIn(stripComments(readFileSync(HTTP_TS, "utf8")));
}

/** Declared entries that exist to pin a specific event inside a prefix branch
 *  (e.g. `payout.paid` under `payout.`) — real, but not their own branch. */
function isConcreteUnderDeclaredPrefix(entry: string): boolean {
  return HANDLED_STRIPE_EVENTS.some(
    (p) => p.endsWith(".") && p !== entry && entry.startsWith(p),
  );
}

describe("stripe webhook coverage", () => {
  test("HANDLED_STRIPE_EVENTS matches the branches in http.ts", () => {
    const inSource = handledInHttpTs();
    const declared = [...HANDLED_STRIPE_EVENTS].sort();

    const undeclared = inSource.filter((t) => !declared.includes(t));
    const stale = declared.filter(
      (t) => !inSource.includes(t) && !isConcreteUnderDeclaredPrefix(t),
    );

    expect(
      undeclared,
      `http.ts branches on event type(s) missing from HANDLED_STRIPE_EVENTS in ` +
        `stripeWebhookCoverage.ts: ${undeclared.join(", ")}. Add them there, or the ` +
        `daily coverage check can't tell you when Stripe stops sending them.`,
    ).toEqual([]);

    expect(
      stale,
      `HANDLED_STRIPE_EVENTS lists event type(s) http.ts no longer handles: ` +
        `${stale.join(", ")}. Remove them from stripeWebhookCoverage.ts.`,
    ).toEqual([]);
  });

  test("the fan-out is actually being parsed (guards the regexes)", () => {
    // If a refactor changes how http.ts dispatches, the parser would quietly
    // find nothing and the test would "pass" against an empty set.
    const inSource = handledInHttpTs();
    expect(inSource.length).toBeGreaterThanOrEqual(6);
    expect(inSource).toContain("checkout.session.completed");
  });

  test("comment stripping never swallows a dispatch line in the real http.ts", () => {
    // Belt to the synthetic test's braces: catches the day someone adds a
    // comment to http.ts positioned such that the stripper mishandles it.
    const raw = readFileSync(HTTP_TS, "utf8");
    const parsed = handledInHttpTs();

    const dispatched: string[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      for (const m of line.matchAll(/event\.type\s*===\s*"([^"]+)"/g)) {
        dispatched.push(m[1]);
      }
      for (const m of line.matchAll(
        /event\.type\.startsWith\(\s*"([^"]+)"\s*\)/g,
      )) {
        dispatched.push(m[1]);
      }
    }
    expect(dispatched.length).toBeGreaterThanOrEqual(6);

    const swallowed = [...new Set(dispatched)].filter(
      (n) => !parsed.includes(n),
    );
    expect(
      swallowed,
      `comment stripping removed real dispatch code for: ${swallowed.join(", ")}.`,
    ).toEqual([]);
  });
});

describe("stripComments", () => {
  test("a route glob in a line comment does not eat the code below it", () => {
    // The exact hazard, reduced. `(/api/give/*)` is http.ts's own comment
    // style; the `*` + `/` that closes the runaway match is the doc comment
    // further down. With the block pass first, the branch in between is gone.
    const hazard = [
      `    // JSON API for the public giving form (/api/give/*).`,
      `    } else if (event.type === "charge.dispute.created") {`,
      `      await handleDispute();`,
      `    }`,
      `/** A later doc comment, which closes the runaway match. */`,
      `const after = 1;`,
    ].join("\n");

    const stripped = stripComments(hazard);
    expect(dispatchTypesIn(stripped)).toContain("charge.dispute.created");
    expect(stripped).toContain("handleDispute");
    expect(stripped).toContain("const after = 1;");
  });

  test("it still removes the prose that would otherwise read as code", () => {
    const proseOnly = [
      `// invoice.paid / invoice.payment_failed handled below`,
      `/* if (event.type === "invoice.upcoming") { } */`,
      `if (event.type === "invoice.paid") {}`,
    ].join("\n");

    expect(dispatchTypesIn(stripComments(proseOnly))).toEqual(["invoice.paid"]);
  });
});

describe("isCovered", () => {
  test("exact event types must be enabled by name", () => {
    expect(isCovered("invoice.paid", ["invoice.paid"])).toBe(true);
    expect(isCovered("invoice.paid", ["checkout.session.completed"])).toBe(false);
    expect(isCovered("invoice.paid", [])).toBe(false);
  });

  test("a prefix branch is covered by any event beneath it", () => {
    expect(isCovered("payout.", ["payout.paid"])).toBe(true);
    expect(isCovered("payout.", ["payout.created", "payout.failed"])).toBe(true);
    expect(isCovered("payout.", ["invoice.paid"])).toBe(false);
    // The trailing dot is what stops a same-stem event from matching.
    expect(isCovered("payout.", ["payout_something"])).toBe(false);
  });

  test("a partially-enabled namespace still reports the event that matters", () => {
    // Why concrete entries live alongside the prefixes: `payout.created` alone
    // satisfies `payout.`, but the reconciliation fast-path needs `payout.paid`.
    const partial = ["payout.created", "payout.updated"];
    expect(isCovered("payout.", partial)).toBe(true);
    expect(isCovered("payout.paid", partial)).toBe(false);
    expect(
      HANDLED_STRIPE_EVENTS.filter((t) => !isCovered(t, partial)),
    ).toContain("payout.paid");
  });

  test("the wildcard covers everything", () => {
    for (const t of HANDLED_STRIPE_EVENTS) {
      expect(isCovered(t, ["*"])).toBe(true);
    }
  });

  test("the incident config reports every dead branch and no live one", () => {
    // What production actually had: only these two events enabled. This is the
    // regression case — the check must name every handler that can't fire, and
    // must not cry wolf about the two that could. Asserted as membership rather
    // than an exact list so that adding a fan-out branch doesn't churn it.
    const incident = ["checkout.session.completed", "checkout.session.expired"];
    const missing = HANDLED_STRIPE_EVENTS.filter((t) => !isCovered(t, incident));

    for (const dead of [
      "invoice.paid",
      "invoice.payment_failed",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "payout.",
      "payout.paid",
      "financial_connections.",
    ]) {
      expect(missing).toContain(dead);
    }
    expect(missing).not.toContain("checkout.session.completed");
    expect(missing).not.toContain("checkout.session.expired");
  });
});
