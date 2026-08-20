import { describe, expect, it } from "vitest";
import { defaultFeeRate } from "./processorFees";
import {
  CARD_RAIL_MAX_CENTS,
  DEFAULT_SPONSOR_RAILS,
  cardRailBlockedReason,
  inKindTotalCents,
  parseSponsorProse,
  railAllowedAtAmount,
  selectableRails,
  sponsorAmountProblems,
  sponsorBalance,
  sponsorFeeQuote,
  sponsorPortalState,
  sponsorSignatureProblems,
} from "./sponsorPortal";

describe("rails", () => {
  it("defaults to bank transfer alone — the founder's instruction, not a preference", () => {
    expect(DEFAULT_SPONSOR_RAILS).toEqual(["ach"]);
  });

  it("allows bank transfer at any size and card only under the ceiling", () => {
    expect(railAllowedAtAmount("ach", 350_000)).toBe(true);
    expect(railAllowedAtAmount("card", CARD_RAIL_MAX_CENTS)).toBe(true);
    expect(railAllowedAtAmount("card", CARD_RAIL_MAX_CENTS + 1)).toBe(false);
    expect(selectableRails(350_000)).toEqual(["ach"]);
    expect(selectableRails(50_000)).toEqual(["ach", "card"]);
  });

  it("explains the block with the money it would have cost", () => {
    expect(cardRailBlockedReason(50_000)).toBeNull();
    // $3,500 — the Ignite Production Partner spot.
    const reason = cardRailBlockedReason(350_000);
    expect(reason).toContain("$101.80");
    expect(reason).toContain("$5.00");
  });
});

describe("fee quote", () => {
  const ACH = defaultFeeRate("stripe", "ach_debit")!;
  const CARD = defaultFeeRate("stripe", "card")!;

  it("caps a $3,500 bank transfer's fee at $5 — the whole reason ACH is the default", () => {
    const { feeCents, chargeCents } = sponsorFeeQuote(350_000, ACH);
    expect(feeCents).toBe(500);
    expect(chargeCents).toBe(350_500);
  });

  it("shows what the same payment costs on a card", () => {
    // Grossed up, so the org still nets the full $3,500.
    const { feeCents } = sponsorFeeQuote(350_000, CARD);
    expect(feeCents).toBeGreaterThan(10_000); // north of $100
  });

  it("degrades to face value when no rate resolves", () => {
    expect(sponsorFeeQuote(350_000, null)).toEqual({
      feeCents: 0,
      chargeCents: 350_000,
    });
  });
});

describe("sponsorBalance", () => {
  it("nets in-kind and cash against the commitment", () => {
    // The deck's worked example: $3,500 spot, $2,500 production valued in-kind.
    const b = sponsorBalance({ committedCents: 350_000, inKindCents: 250_000 });
    expect(b.balanceCents).toBe(100_000);
    expect(b.percentCovered).toBe(71);
    expect(b.settled).toBe(false);
  });

  it("settles when cash closes the remainder", () => {
    const b = sponsorBalance({
      committedCents: 350_000,
      inKindCents: 250_000,
      paidCents: 100_000,
    });
    expect(b.balanceCents).toBe(0);
    expect(b.percentCovered).toBe(100);
    expect(b.settled).toBe(true);
  });

  it("never reports a negative balance on an overpayment", () => {
    const b = sponsorBalance({ committedCents: 350_000, paidCents: 400_000 });
    expect(b.balanceCents).toBe(0);
    expect(b.percentCovered).toBe(100);
  });

  it("clamps malformed inputs rather than inverting the page", () => {
    const b = sponsorBalance({ committedCents: -1, inKindCents: -5, paidCents: -9 });
    expect(b).toMatchObject({ committedCents: 0, balanceCents: 0, settled: true });
  });

  it("ignores malformed credit rows when summing", () => {
    expect(
      inKindTotalCents([
        { label: "Backline", amountCents: 150_000 },
        { label: "AV", amountCents: Number.NaN },
        { label: "Power", amountCents: 100_000 },
      ]),
    ).toBe(250_000);
  });
});

describe("portal state", () => {
  const base = { hasLiveLink: true, termsVersion: 2, balanceCents: 100_000 };

  it("is unissued without a live link", () => {
    expect(sponsorPortalState({ ...base, hasLiveLink: false })).toBe("unissued");
  });

  it("awaits a signature until one exists", () => {
    expect(sponsorPortalState(base)).toBe("awaiting_signature");
  });

  it("re-opens for signature when the terms move past what was signed", () => {
    expect(sponsorPortalState({ ...base, signedTermsVersion: 1 })).toBe(
      "awaiting_signature",
    );
  });

  it("awaits payment once the current terms are signed", () => {
    expect(sponsorPortalState({ ...base, signedTermsVersion: 2 })).toBe(
      "awaiting_payment",
    );
  });

  it("says clearing while a bank debit is in flight", () => {
    expect(
      sponsorPortalState({ ...base, signedTermsVersion: 2, pendingCents: 100_000 }),
    ).toBe("payment_clearing");
  });

  it("settles when nothing is owed", () => {
    expect(
      sponsorPortalState({ ...base, signedTermsVersion: 2, balanceCents: 0 }),
    ).toBe("settled");
  });
});

describe("signature + amount validation", () => {
  it("refuses a signature too short to be evidence", () => {
    expect(sponsorSignatureProblems("")).toHaveLength(1);
    expect(sponsorSignatureProblems(" A ")).toHaveLength(1);
    expect(sponsorSignatureProblems("A. Okey-che")).toHaveLength(0);
  });

  it("refuses a nonsense amount", () => {
    expect(sponsorAmountProblems(0)).toHaveLength(1);
    expect(sponsorAmountProblems(350_000.5)).toHaveLength(1);
    expect(sponsorAmountProblems(99_999_999_99)).toHaveLength(1);
    expect(sponsorAmountProblems(350_000)).toHaveLength(0);
  });
});

describe("parseSponsorProse", () => {
  it("groups paragraphs, headings and bullets", () => {
    const blocks = parseSponsorProse(
      [
        "## What Ignite receives",
        "- A full public worship gathering on your streets",
        "* We run everything: production, hosting, the altar",
        "",
        "Nothing here is binding until we agree together,",
        "in writing.",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", text: "What Ignite receives" },
      {
        kind: "bullets",
        items: [
          "A full public worship gathering on your streets",
          "We run everything: production, hosting, the altar",
        ],
      },
      {
        kind: "paragraph",
        text: "Nothing here is binding until we agree together, in writing.",
      },
    ]);
  });

  it("emits nothing for empty input", () => {
    expect(parseSponsorProse("")).toEqual([]);
    expect(parseSponsorProse(null)).toEqual([]);
    expect(parseSponsorProse("   \n  \n")).toEqual([]);
  });

  it("carries markup through as text — the renderer escapes, the parser never trusts", () => {
    expect(parseSponsorProse("<script>alert(1)</script>")).toEqual([
      { kind: "paragraph", text: "<script>alert(1)</script>" },
    ]);
  });

  it("normalises CRLF so a pasted Windows/Google Doc body doesn't become one blob", () => {
    expect(parseSponsorProse("One\r\n\r\nTwo")).toEqual([
      { kind: "paragraph", text: "One" },
      { kind: "paragraph", text: "Two" },
    ]);
  });
});
