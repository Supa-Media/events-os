import { describe, expect, test } from "@jest/globals";
import {
  codingLine,
  countingTransfers,
  lineIdentity,
  lineTitle,
  railAndStatus,
  railLabel,
  signedAmount,
  titleUsedNote,
  transferNote,
  zeroReasonLabel,
  type BookValueLineIdentity,
} from "./bookValueLines";

/** A row with nothing on it — each test turns on exactly the field it means. */
const bare: BookValueLineIdentity = {
  description: "",
  merchantName: null,
  merchantNameOverride: null,
  note: null,
  cardLast4: null,
  personName: null,
  source: "stripe_fc",
  transferOrigin: null,
};

describe("lineTitle", () => {
  test("a bookkeeper's rename wins over everything the provider sent", () => {
    expect(
      lineTitle({
        ...bare,
        merchantNameOverride: "Costco",
        merchantName: "IC* COSTCO BY IN CAR",
        description: "Purchase from IC* COSTCO",
      }),
    ).toBe("Costco");
  });

  test("the provider's merchant string is used when nothing was renamed — the real shape of the rows that read '(no description)'", () => {
    // Verbatim from production: every `stripe_fc` row lands with an empty
    // description and the merchant string in `merchantName`.
    expect(
      lineTitle({
        ...bare,
        merchantName:
          "Purchase from AMAZON.COM*569YQ  |  Address: SEATTLE, WA, US  |  **8728",
      }),
    ).toBe(
      "Purchase from AMAZON.COM*569YQ  |  Address: SEATTLE, WA, US  |  **8728",
    );
  });

  test("description carries the row when there is no merchant string", () => {
    expect(
      lineTitle({ ...bare, description: "Givebutter processing fees — 2025-06" }),
    ).toBe("Givebutter processing fees — 2025-06");
  });

  test("the bookkeeper's note is a better identifier than a shrug", () => {
    expect(lineTitle({ ...bare, note: "Van hire for the Eden shoot" })).toBe(
      "Van hire for the Eden shoot",
    );
    expect(titleUsedNote({ ...bare, note: "Van hire for the Eden shoot" })).toBe(
      true,
    );
  });

  test("a row carrying nothing at all names its rail, so the reader knows which statement to open", () => {
    expect(lineTitle(bare)).toBe("Unlabeled relay bank feed row");
    expect(lineTitle({ ...bare, source: "relay_csv" })).toBe(
      "Unlabeled relay statement import row",
    );
    expect(lineTitle({ ...bare, source: "increase_card" })).toBe(
      "Unlabeled increase card row",
    );
  });

  test("whitespace-only strings are not identifiers", () => {
    expect(lineTitle({ ...bare, merchantName: "   ", description: "\n" })).toBe(
      "Unlabeled relay bank feed row",
    );
  });

  test("titleUsedNote is false whenever a real identifier was found", () => {
    expect(
      titleUsedNote({ ...bare, merchantName: "Uber", note: "airport run" }),
    ).toBe(false);
    expect(titleUsedNote(bare)).toBe(false);
  });
});

describe("railLabel", () => {
  test("the two enums a treasurer has never seen are spelled out", () => {
    expect(railLabel({ ...bare, source: "stripe_fc" })).toBe("Relay bank feed");
    expect(railLabel({ ...bare, source: "relay_csv" })).toBe(
      "Relay statement import",
    );
  });

  test("an engine transfer names the engine step, not its generic source", () => {
    // Every engine leg is `source: "transfer"`, which would say nothing about
    // why the row exists.
    expect(
      railLabel({
        ...bare,
        source: "transfer",
        transferOrigin: "auto_settlement",
      }),
    ).toBe("Auto settlement");
    expect(
      railLabel({
        ...bare,
        source: "transfer",
        transferOrigin: "balance_settlement",
      }),
    ).toBe("Balance settlement");
  });

  test("an unknown source renders as words rather than disappearing", () => {
    expect(railLabel({ ...bare, source: "some_new_rail" })).toBe(
      "some new rail",
    );
  });

  test("an unknown transfer origin falls back to the source", () => {
    expect(
      railLabel({ ...bare, source: "transfer", transferOrigin: "future_thing" }),
    ).toBe("Recorded transfer");
  });
});

describe("railAndStatus", () => {
  test("replaces the raw `stripe_fc · categorized` pair", () => {
    expect(
      railAndStatus({ ...bare, source: "stripe_fc", status: "categorized" }),
    ).toBe("Relay bank feed · Categorized");
  });

  test("an unknown status is passed through rather than dropped", () => {
    expect(railAndStatus({ ...bare, status: "brand_new" })).toBe(
      "Relay bank feed · brand_new",
    );
  });

  test("no status at all leaves just the rail", () => {
    expect(railAndStatus(bare)).toBe("Relay bank feed");
  });
});

describe("lineIdentity", () => {
  test("names the card, the holder and the paperwork", () => {
    expect(
      lineIdentity({
        ...bare,
        cardLast4: "8728",
        personName: "Oluseyi Olujide",
        hasDocumentation: true,
      }),
    ).toBe("Card ···8728 · Oluseyi Olujide · Receipt on file");
  });

  test("a row with none of them says nothing rather than printing separators", () => {
    expect(lineIdentity(bare)).toBe("");
  });

  test("partial identity keeps its order", () => {
    expect(lineIdentity({ ...bare, personName: "Jane Doe" })).toBe("Jane Doe");
  });
});

describe("codingLine", () => {
  test("both halves of the coding are named", () => {
    expect(
      codingLine({ category: "Hospitality", budgetName: "Pop The Balloon" }),
    ).toBe("Hospitality · Pop The Balloon");
  });

  test("an uncoded row says so instead of leaving a blank to interpret", () => {
    expect(codingLine({ category: "Uncategorised", budgetName: null })).toBe(
      "Not coded to a category or budget",
    );
    expect(codingLine({ budgetName: null })).toBe(
      "Not coded to a category or budget",
    );
  });

  test("half-coded rows name the missing half", () => {
    expect(codingLine({ category: "Travel", budgetName: null })).toBe(
      "Travel · no budget named",
    );
    expect(
      codingLine({ category: "Uncategorised", budgetName: "Q3 Programs" }),
    ).toBe("No category · Q3 Programs");
  });
});

describe("transferNote", () => {
  const settlement = {
    flow: "transfer",
    source: "transfer",
    transferOrigin: "auto_settlement",
    amountCents: -200395,
    counterpartyName: "New York",
  };

  test("ordinary spend gets no badge — a badge on every row is a badge on none", () => {
    expect(
      transferNote({
        flow: "outflow",
        source: "stripe_fc",
        transferOrigin: null,
        amountCents: -8085,
        counterpartyName: null,
      }),
    ).toBeNull();
  });

  test("the $2,003.95 settlement the owner asked about reads as an exception, and says why", () => {
    const note = transferNote(settlement);
    expect(note?.badge).toBe("Counts against book value");
    expect(note?.sentence).toContain("New York");
    expect(note?.sentence).toContain("BORE");
    expect(note?.sentence).toContain(
      "an ordinary internal transfer does not",
    );
  });

  test("the side is read off the sign the server computed, never re-derived", () => {
    expect(transferNote({ ...settlement, amountCents: 200395 })?.badge).toBe(
      "Counts toward book value",
    );
  });

  test("a settlement with no resolvable counterparty still reads as a sentence", () => {
    expect(
      transferNote({ ...settlement, counterpartyName: null })?.sentence,
    ).toContain("the other book");
  });

  test("a repayment credit explains itself as the charge coming back", () => {
    const note = transferNote({
      flow: "transfer",
      source: "repayment",
      transferOrigin: null,
      amountCents: 5000,
      counterpartyName: null,
    });
    expect(note?.badge).toBe("Counts toward book value");
    expect(note?.sentence).toContain("personal charge");
  });

  test("a legacy reimbursement leg says it is legacy", () => {
    expect(
      transferNote({
        flow: "transfer",
        source: "reimbursement",
        transferOrigin: null,
        amountCents: -12000,
        counterpartyName: null,
      })?.sentence,
    ).toContain("0044");
  });

  test("a hand-recorded directed pair names which way it went", () => {
    expect(
      transferNote({
        flow: "transfer",
        source: "transfer",
        transferOrigin: null,
        amountCents: -287321,
        counterpartyName: "New York",
      })?.sentence,
    ).toContain("to New York");
    expect(
      transferNote({
        flow: "transfer",
        source: "transfer",
        transferOrigin: null,
        amountCents: 287321,
        counterpartyName: "Central",
      })?.sentence,
    ).toContain("from Central");
  });
});

describe("countingTransfers", () => {
  test("counts only the transfer legs", () => {
    expect(
      countingTransfers([
        { flow: "outflow" },
        { flow: "transfer" },
        { flow: "inflow" },
        { flow: "transfer" },
      ]),
    ).toBe(2);
    expect(countingTransfers([])).toBe(0);
  });
});

describe("zeroReasonLabel", () => {
  test("each zero gets its OWN reason — the bug was one sentence for all of them", () => {
    const marked = zeroReasonLabel("marked_transfer");
    const balance = zeroReasonLabel("balance_settlement");
    const unknown = zeroReasonLabel("unknown_transfer_shape");
    expect(marked).not.toBe(balance);
    expect(balance).not.toBe(unknown);
    // Only the genuinely unrecognized shape is described as a gap to fix.
    expect(unknown).toContain("no recorded direction");
    expect(marked).not.toContain("no recorded direction");
    expect(balance).not.toContain("no recorded direction");
  });

  test("a payout deposit points at the layer that already counted it", () => {
    expect(zeroReasonLabel("payout_deposit")).toContain("already counted");
    expect(zeroReasonLabel("linked_gift")).toContain("gift");
  });
});

describe("signedAmount", () => {
  test("a credit is marked, a debit keeps the minus formatCents already gives it", () => {
    expect(signedAmount(200395)).toBe("+$2,003.95");
    expect(signedAmount(-200395)).toBe("-$2,003.95");
    expect(signedAmount(0)).toBe("$0.00");
  });
});
