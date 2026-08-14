// No @types/jest / ambient globals configured for this package — import test
// globals explicitly (mirrors `finance/bookScope.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { REIMBURSEMENT_STATUSES } from "@events-os/shared";
import { QUEUE_SECTIONS, isTerminal, queueSection } from "./helpers";

/**
 * The approval queue's four who-is-blocked bands.
 *
 * Founder, 2026-08-14: "it shows all reimbursements, like, just in a line.
 * Things are already paid, things haven't been paid, doesn't collapse
 * anything. It doesn't make any sense."
 *
 * The risk in a grouping like this isn't that a status lands in the wrong
 * band — it's that a status lands in NO band and silently disappears off the
 * screen. So the exhaustive test below is the important one: every member of
 * the shared status union must resolve to a real section, forever, including
 * statuses added after this file was written.
 */
describe("queueSection", () => {
  test("every status in the shared union lands in exactly one real section", () => {
    const keys = new Set(QUEUE_SECTIONS.map((s) => s.key));
    for (const status of REIMBURSEMENT_STATUSES) {
      expect(keys.has(queueSection(status))).toBe(true);
    }
  });

  test("a status nobody has classified defaults to the section people look at", () => {
    // The failure mode this prevents: a new status quietly filed into History,
    // where a request needing a decision would sit unread. `queueSection`'s
    // fallthrough is `waiting` on purpose.
    for (const status of REIMBURSEMENT_STATUSES) {
      if (isTerminal(status)) continue;
      if (status === "paying" || status === "changes_requested") continue;
      expect(queueSection(status)).toBe("waiting");
    }
  });

  test("finished work is History and nothing else", () => {
    expect(queueSection("paid")).toBe("history");
    expect(queueSection("rejected")).toBe("history");
    expect(queueSection("canceled")).toBe("history");
  });

  test("approved-but-unpaid and a bounced payout are WAITING, not done", () => {
    // Both read as "handled" at a glance and are not: `approved` still needs
    // the payout started, `failed` needs it retried. Filing either under
    // History or Paying is how a volunteer goes unpaid for a month.
    expect(queueSection("approved")).toBe("waiting");
    expect(queueSection("failed")).toBe("waiting");
  });

  test("money in motion is its own band — nobody is blocked on it", () => {
    expect(queueSection("paying")).toBe("in_flight");
  });

  test("sent back sits with the claimant, never in the reviewer's to-do", () => {
    expect(queueSection("changes_requested")).toBe("sent_back");
  });

  test("the two bands nobody is blocked on start collapsed; the work does not", () => {
    const collapsed = Object.fromEntries(
      QUEUE_SECTIONS.map((s) => [s.key, s.collapsed]),
    );
    expect(collapsed.waiting).toBe(false);
    expect(collapsed.in_flight).toBe(false);
    expect(collapsed.sent_back).toBe(true);
    expect(collapsed.history).toBe(true);
  });

  test("only the sections worth celebrating empty carry an empty message", () => {
    // A section with no `emptyMessage` renders nothing when empty; one with a
    // message renders its header and the reassurance. "Waiting on you — 0" is
    // useful; "History — 0" is noise.
    const byKey = Object.fromEntries(QUEUE_SECTIONS.map((s) => [s.key, s]));
    expect(byKey.waiting.emptyMessage).toBeTruthy();
    expect(byKey.history.emptyMessage).toBeUndefined();
  });
});
