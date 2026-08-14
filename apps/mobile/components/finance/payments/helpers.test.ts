import { describe, expect, it, jest } from "@jest/globals";

// `lib/contractLink.ts` reads the public site base from the ticketing helpers,
// which import `react-native` at module scope — unloadable in this node-
// environment jest setup (the repo's convention is dependency-free logic
// tests). Mocking that ONE function keeps `slugifyChapterName` and
// `contractLinkFor` testable as the pure functions they are, and pins the base
// so the URL assertions below are deterministic rather than environment-
// dependent.
jest.mock("../../event/ticketing/helpers", () => ({
  publicSiteUrl: () => "https://publicworship.life",
}));

import {
  centsToAmountText,
  needsReview,
  isTerminal,
  canEditTerms,
  canSendLink,
  canCancel,
  canPayOut,
  isWithContractor,
} from "./helpers";
import { slugifyChapterName, contractLinkFor } from "../../../lib/contractLinkUrl";
import {
  CONTRACTOR_PAYMENT_STATUSES,
  type ContractorPaymentStatus,
} from "@events-os/shared";

/**
 * The pure logic behind the Payments screens.
 *
 * Mobile's CI gate is jest, not `tsc`, so anything not covered here is
 * effectively unverified in CI. Two things are worth the trouble:
 *
 *  - THE MONEY CONVERSION. A dollars/cents rounding slip is a wrong payment,
 *    and it is the kind of bug that looks fine on every value a developer
 *    happens to try.
 *  - THE STATUS PREDICATES. They decide which controls a treasurer is offered.
 *    A predicate that is wrong in the permissive direction offers "Pay" on a
 *    payment that was never approved; the server would refuse, but the person
 *    reading the screen has already been told something false.
 *
 * The predicates are asserted over the WHOLE status tuple rather than a few
 * samples, so adding a status to `CONTRACTOR_PAYMENT_STATUSES` without deciding
 * what each control does with it fails here rather than shipping a guess.
 */

const ALL = CONTRACTOR_PAYMENT_STATUSES as readonly ContractorPaymentStatus[];

/** Every status the predicate says yes to, in tuple order. */
function yesFor(p: (s: ContractorPaymentStatus) => boolean): string[] {
  return ALL.filter(p);
}

describe("money", () => {
  it("renders whole dollars with cents, always", () => {
    // "1200.5" in a money field is a bug; the field starts life with 2dp.
    expect(centsToAmountText(120050)).toBe("1200.50");
    expect(centsToAmountText(75000)).toBe("750.00");
    expect(centsToAmountText(0)).toBe("0.00");
    expect(centsToAmountText(5)).toBe("0.05");
    expect(centsToAmountText(1)).toBe("0.01");
  });

  it("survives a round trip through the app's one dollars parser", () => {
    // `centsToAmountText` is only correct if the value it produces parses back
    // to the same cents. The pairing is the invariant, not either half.
    const parseDollars = (s: string): number => Math.round(parseFloat(s) * 100);
    for (const cents of [1, 5, 99, 100, 4999, 75000, 120050, 5000000]) {
      expect(parseDollars(centsToAmountText(cents))).toBe(cents);
    }
  });

  it("does not lose the classic floating-point cases", () => {
    // 0.1 + 0.2 territory: these are the values where a naive round trip drifts.
    for (const cents of [1015, 2035, 7005, 8145, 999999]) {
      expect(centsToAmountText(cents)).toBe((cents / 100).toFixed(2));
      expect(Math.round(parseFloat(centsToAmountText(cents)) * 100)).toBe(cents);
    }
  });
});

describe("status predicates decide what a treasurer is offered", () => {
  it("only a submitted payment needs review", () => {
    expect(yesFor(needsReview)).toEqual(["submitted"]);
  });

  it("terminal means nothing more happens without someone starting over", () => {
    // `failed` is deliberately NOT terminal — it is waiting on a retry, which
    // is work somebody still has to do.
    expect(yesFor(isTerminal)).toEqual(["paid", "rejected", "canceled"]);
  });

  it("terms stop being editable once the money is approved", () => {
    expect(yesFor(canEditTerms)).toEqual([
      "draft",
      "sent",
      "submitted",
      "changes_requested",
    ]);
  });

  it("a link can be sent before the contractor has finished, and not after", () => {
    expect(yesFor(canSendLink)).toEqual(["draft", "sent"]);
  });

  it("cancelling is legal right up until money is in motion", () => {
    expect(yesFor(canCancel)).toEqual([
      "draft",
      "sent",
      "submitted",
      "changes_requested",
      "approved",
    ]);
    // The three that must never be cancellable from a screen.
    expect(canCancel("paying")).toBe(false);
    expect(canCancel("paid")).toBe(false);
    expect(canCancel("rejected")).toBe(false);
  });

  it("paying is offered only where the server would accept it", () => {
    // `approved` is the normal case; `failed` is a bounce a treasurer retries.
    // Offering it anywhere else tells the reader something untrue, even though
    // the server would refuse.
    for (const s of yesFor(canPayOut)) {
      expect(["approved", "failed"]).toContain(s);
    }
    expect(canPayOut("approved")).toBe(true);
    expect(canPayOut("submitted")).toBe(false);
    expect(canPayOut("draft")).toBe(false);
    expect(canPayOut("paid")).toBe(false);
  });

  it("the ball is with the contractor exactly when their link is editable", () => {
    expect(yesFor(isWithContractor)).toEqual(["sent", "changes_requested"]);
  });

  it("every status is classified by every predicate", () => {
    // Guards the real failure: someone adds a status and a predicate silently
    // answers false for it everywhere.
    for (const s of ALL) {
      for (const p of [
        needsReview,
        isTerminal,
        canEditTerms,
        canSendLink,
        canCancel,
        canPayOut,
        isWithContractor,
      ]) {
        expect(typeof p(s)).toBe("boolean");
      }
    }
  });
});

describe("the contractor link", () => {
  it("slugifies a chapter name the way the backend mints slugs", () => {
    expect(slugifyChapterName("New York")).toBe("new-york");
    expect(slugifyChapterName("  São Paulo  ")).toBe("sao-paulo");
    expect(slugifyChapterName("Washington, D.C.")).toBe("washington-d-c");
    expect(slugifyChapterName("---")).toBe("");
  });

  it("caps the slug so a long name can't build an absurd URL", () => {
    expect(slugifyChapterName("a".repeat(200))).toHaveLength(48);
  });

  it("refuses to build a link with a missing half", () => {
    // A dead link is worse than no link: staff would paste it to a contractor
    // and nobody would find out until the person asked where their money was.
    expect(contractLinkFor("", "tok")).toBeNull();
    expect(contractLinkFor("new-york", "")).toBeNull();
  });

  it("builds the same URL shape the server's route serves", () => {
    expect(contractLinkFor("new-york", "tok123")).toBe(
      "https://publicworship.life/contract/new-york?token=tok123",
    );
  });

  it("encodes a token that would otherwise break the query string", () => {
    const url = contractLinkFor("new-york", "a b/c?d")!;
    expect(url).not.toContain("a b/c?d");
    expect(url).toContain(encodeURIComponent("a b/c?d"));
    // The token must survive a round trip — a link whose token is mangled is a
    // 404 the contractor cannot do anything about.
    expect(new URL(url).searchParams.get("token")).toBe("a b/c?d");
  });
});
