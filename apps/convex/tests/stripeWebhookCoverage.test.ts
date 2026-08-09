import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HANDLED_STRIPE_EVENTS,
  isCovered,
} from "../stripeWebhookCoverage";

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
 * Source with comments stripped — `http.ts` names event types in prose
 * (`// invoice.paid / invoice.payment_failed:` above the payload type), and a
 * documented type is not a handled one.
 */
function httpSourceWithoutComments(): string {
  return readFileSync(HTTP_TS, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

/** Every event type the fan-out actually branches on. */
function handledInHttpTs(): string[] {
  const src = httpSourceWithoutComments();
  const found = new Set<string>();
  for (const m of src.matchAll(/event\.type\s*===\s*"([^"]+)"/g)) {
    found.add(m[1]);
  }
  for (const m of src.matchAll(/event\.type\.startsWith\(\s*"([^"]+)"\s*\)/g)) {
    found.add(m[1]);
  }
  return [...found].sort();
}

describe("stripe webhook coverage", () => {
  test("HANDLED_STRIPE_EVENTS matches the branches in http.ts", () => {
    const inSource = handledInHttpTs();
    const declared = [...HANDLED_STRIPE_EVENTS].sort();

    const undeclared = inSource.filter((t) => !declared.includes(t));
    const stale = declared.filter((t) => !inSource.includes(t));

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
    // If a refactor changes how http.ts dispatches, the parser above would
    // quietly find nothing and the test would "pass" against an empty set.
    const inSource = handledInHttpTs();
    expect(inSource.length).toBeGreaterThanOrEqual(6);
    expect(inSource).toContain("checkout.session.completed");
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
      "financial_connections.",
    ]) {
      expect(missing).toContain(dead);
    }
    expect(missing).not.toContain("checkout.session.completed");
    expect(missing).not.toContain("checkout.session.expired");
  });
});
