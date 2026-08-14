import {
  bulkExplainFailureHeadline,
  summarizeBulkExplain,
  type BulkExplainRowOutcome,
} from "./bulkExplainOutcome";

/**
 * The point of this module is that a bulk apply NAMES what it couldn't do.
 * These tests pin that: the counts, the sentence, and — the bit that actually
 * matters — that every failed row appears in a group with a label somebody can
 * recognise.
 */

const LABELS: Record<string, string> = {
  a: "MTA*NYCT · Mar 3 · $2.90",
  b: "MTA*NYCT · Mar 4 · $2.90",
  c: "MTA*NYCT · Mar 5 · $2.90",
  d: "Peter Pan Bus · Mar 9 · $58.00",
};
const labelFor = (id: string) => LABELS[id] ?? null;

function row(
  transactionId: string,
  outcome: BulkExplainRowOutcome["outcome"],
  code?: string,
  message?: string,
): BulkExplainRowOutcome {
  return {
    transactionId,
    outcome,
    code: code ?? null,
    message: message ?? null,
  };
}

describe("summarizeBulkExplain", () => {
  test("counts applied rows including resubmissions", () => {
    const s = summarizeBulkExplain(
      [row("a", "submitted"), row("b", "resubmitted"), row("c", "submitted")],
      labelFor,
    );
    expect(s.applied).toBe(3);
    expect(s.failed).toBe(0);
    expect(s.groups).toEqual([]);
    expect(s.line).toBe("3 explained");
  });

  test("the founder's sentence: applied, then each pile named", () => {
    const rows = [
      ...Array.from({ length: 2 }, (_, i) => row(`ok${i}`, "submitted")),
      row("a", "failed", "DOCUMENTATION_REQUIRED", "Attach the receipt…"),
      row("b", "failed", "DOCUMENTATION_REQUIRED", "Attach the receipt…"),
      row("d", "failed", "CODING_APPROVED", "This coding is already approved."),
    ];
    const s = summarizeBulkExplain(rows, labelFor);
    expect(s.applied).toBe(2);
    expect(s.failed).toBe(3);
    expect(s.line).toBe("2 explained · 2 need a receipt first · 1 already approved");
  });

  test("every failed row is listed under its code, with a label you can recognise", () => {
    const s = summarizeBulkExplain(
      [
        row("a", "failed", "DOCUMENTATION_REQUIRED", "Attach the receipt…"),
        row("b", "failed", "DOCUMENTATION_REQUIRED", "Attach the receipt…"),
        row("d", "failed", "CODING_APPROVED", "Already approved."),
      ],
      labelFor,
    );
    const docs = s.groups.find((g) => g.code === "DOCUMENTATION_REQUIRED")!;
    expect(docs.transactionIds).toEqual(["a", "b"]);
    expect(docs.labels).toEqual([LABELS.a, LABELS.b]);
    expect(docs.message).toBe("Attach the receipt…");
    const approved = s.groups.find((g) => g.code === "CODING_APPROVED")!;
    expect(approved.labels).toEqual([LABELS.d]);
  });

  test("biggest pile first, code as a stable tie-break", () => {
    const s = summarizeBulkExplain(
      [
        row("d", "failed", "CODING_APPROVED", "m"),
        row("a", "failed", "DOCUMENTATION_REQUIRED", "m"),
        row("b", "failed", "DOCUMENTATION_REQUIRED", "m"),
      ],
      labelFor,
    );
    expect(s.groups.map((g) => g.code)).toEqual([
      "DOCUMENTATION_REQUIRED",
      "CODING_APPROVED",
    ]);

    // Equal sizes fall back to the code, so two renders of one result can't
    // shuffle.
    const tied = summarizeBulkExplain(
      [
        row("d", "failed", "NOT_FOUND", "m"),
        row("a", "failed", "CODING_APPROVED", "m"),
      ],
      labelFor,
    );
    expect(tied.groups.map((g) => g.code)).toEqual([
      "CODING_APPROVED",
      "NOT_FOUND",
    ]);
  });

  test("a row the grid can no longer name is still listed, never dropped", () => {
    // A failure with a poor label is still a failure someone must see — the
    // one thing this module exists to prevent is a row going quiet.
    const s = summarizeBulkExplain(
      [row("k57q9zvanished", "failed", "DOCUMENTATION_REQUIRED", "m")],
      labelFor,
    );
    expect(s.failed).toBe(1);
    expect(s.groups[0].labels).toEqual(["charge …nished"]);
  });

  test("an unknown code gets a neutral phrase, never the machine constant", () => {
    const s = summarizeBulkExplain(
      [row("a", "failed", "SOME_NEW_SERVER_CODE", "Server said no.")],
      labelFor,
    );
    expect(s.line).toBe("1 wouldn't take it");
    // …but the server's own sentence still reaches the person.
    expect(s.groups[0].message).toBe("Server said no.");
  });

  test("an empty result says so rather than rendering an empty sentence", () => {
    expect(summarizeBulkExplain([], labelFor).line).toBe("Nothing to explain.");
  });
});

describe("bulkExplainFailureHeadline", () => {
  test("phrases each refusal as the next step, not as an error", () => {
    expect(bulkExplainFailureHeadline("DOCUMENTATION_REQUIRED")).toBe(
      "need a receipt first",
    );
    expect(bulkExplainFailureHeadline("LODGING_RECEIPT_REQUIRED")).toBe(
      "need an itemised folio",
    );
    expect(bulkExplainFailureHeadline("FORBIDDEN")).toBe("aren't yours to code");
    expect(bulkExplainFailureHeadline(null)).toBe("wouldn't take it");
  });
});
