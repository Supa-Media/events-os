import { describe, expect, test } from "vitest";
import {
  autoExplainedKind,
  autoExplanationLine,
  personalExpenseState,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
  documentationState,
  DOCUMENTATION_STATES,
  DOCUMENTATION_STATE_LABELS,
  exceptionNeedsSecondApprover,
  DEFAULT_EXCEPTION_APPROVAL_THRESHOLD_CENTS,
  RECEIPT_EXCEPTION_REASONS,
  RECEIPT_EXCEPTION_REASON_LABELS,
  RECEIPT_EXCEPTION_REASON_HINTS,
  RECEIPT_EXCEPTION_STATUSES,
  RECEIPT_EXCEPTION_STATUS_LABELS,
  isReceiptExtractionActive,
  receiptExtractionFraction,
  RECEIPT_EXTRACTION_STALE_MS,
  displayMerchantName,
  providerMerchantName,
  FINANCE_AUDIT_ACTIONS,
  FINANCE_AUDIT_ACTION_LABELS,
  TRANSACTION_SOURCES,
  TRANSACTION_SOURCE_LABELS,
  transactionSourceLabel,
  BOOK_VALUE_ZERO_REASONS,
  BOOK_VALUE_ZERO_REASON_LABELS,
  bookValueLineTitle,
  bookValueRailLabel,
  bookValueTitleUsedNote,
} from "./finance";

/**
 * `personalExpenseState` — the derived (NOT persisted) personal-expense
 * lifecycle: not_personal → personal_unpaid → personal_reimbursed. See the
 * function's own doc comment in `finance.ts` for the full design rationale
 * (why this is derived from `isPersonal` + a linked repayment's status rather
 * than a new persisted field).
 */
describe("personalExpenseState", () => {
  test("not personal regardless of any stray repaymentStatus value", () => {
    expect(personalExpenseState(false, null)).toBe("not_personal");
    expect(personalExpenseState(undefined, null)).toBe("not_personal");
    expect(personalExpenseState(null, "paid")).toBe("not_personal");
  });

  test("personal + no/pending repayment reads unpaid", () => {
    expect(personalExpenseState(true, null)).toBe("personal_unpaid");
    expect(personalExpenseState(true, undefined)).toBe("personal_unpaid");
    expect(personalExpenseState(true, "pending")).toBe("personal_unpaid");
  });

  test("a failed repayment attempt still reads unpaid — the debt is still owed", () => {
    expect(personalExpenseState(true, "failed")).toBe("personal_unpaid");
  });

  test("only a paid repayment reads reimbursed", () => {
    expect(personalExpenseState(true, "paid")).toBe("personal_reimbursed");
  });

  // ── §2 invariant: this derived state can NEVER represent "personal" in a
  // way `isSpend` (finances.ts) would disagree with. `isSpend` excludes a
  // transaction from spend whenever `isPersonal === true` — full stop,
  // regardless of repayment status. Both `personal_unpaid` AND
  // `personal_reimbursed` correspond to `isPersonal === true`, so BOTH must
  // be excluded from spend; only `not_personal` corresponds to `isPersonal
  // !== true`, which is the one case `isSpend` does NOT exclude on this
  // axis. This table-driven check pins that correspondence for every
  // (isPersonal, repaymentStatus) combination the type allows, mirroring
  // `finances.ts#isSpend`'s own `tr.isPersonal !== true` clause exactly so a
  // future edit to either side that breaks the correspondence fails HERE.
  test("invariant: personalExpenseState !== 'not_personal' iff isSpend would exclude on isPersonal", () => {
    const isPersonalValues = [true, false, undefined, null] as const;
    const repaymentStatusValues = ["pending", "paid", "failed", null, undefined] as const;
    for (const isPersonal of isPersonalValues) {
      for (const repaymentStatus of repaymentStatusValues) {
        const state = personalExpenseState(isPersonal, repaymentStatus);
        const isSpendExcludesOnPersonal = isPersonal === true; // mirrors `finances.ts#isSpend`
        expect(state !== "not_personal").toBe(isSpendExcludesOnPersonal);
      }
    }
  });
});

// ── §7 (moneyViews dedup): TRANSACTION_STATUSES stays the single source for
// any hand-written status union — pinned here as a companion to the moneyViews
// fix so a status added/removed from the tuple is caught wherever a consumer
// still hand-lists literals instead of deriving from the tuple.
describe("TRANSACTION_STATUSES / TRANSACTION_STATUS_LABELS stay in lock-step", () => {
  test("every status has a label and vice versa", () => {
    for (const status of TRANSACTION_STATUSES) {
      expect(TRANSACTION_STATUS_LABELS[status]).toBeTruthy();
    }
    expect(Object.keys(TRANSACTION_STATUS_LABELS).sort()).toEqual(
      [...TRANSACTION_STATUSES].sort(),
    );
  });
});

// ── Receipt exceptions: the documented "there is no receipt" ────────────────
// See `docs/plans/receipt-exceptions.md`. These are the pure halves of the
// feature — the derived publishing state and the separation-of-duties
// threshold. The stateful invariants (the denormalized pointer, the
// auto-convert escape valve, the reconciled-means-documented guard) live in
// `apps/convex/tests/receiptExceptions.test.ts`.
describe("documentationState", () => {
  test("a receipt outranks an exception", () => {
    // Both present is a real, transient state: the document turned up after an
    // exception was approved. The receipt is the better answer, and the link
    // path retires the exception right behind this read.
    expect(documentationState(true, true)).toBe("receipt");
    expect(documentationState(true, false)).toBe("receipt");
  });

  test("an approved exception IS documentation", () => {
    expect(documentationState(false, true)).toBe("exception");
  });

  test("neither reads as undocumented — the state that blocks publishing", () => {
    expect(documentationState(false, false)).toBe("undocumented");
  });

  test("every state has a label and vice versa", () => {
    for (const state of DOCUMENTATION_STATES) {
      expect(DOCUMENTATION_STATE_LABELS[state]).toBeTruthy();
    }
    expect(Object.keys(DOCUMENTATION_STATE_LABELS).sort()).toEqual(
      [...DOCUMENTATION_STATES].sort(),
    );
  });
});

describe("exceptionNeedsSecondApprover", () => {
  test("the default threshold is the IRS substantiation line, and it's inclusive", () => {
    expect(DEFAULT_EXCEPTION_APPROVAL_THRESHOLD_CENTS).toBe(7_500);
    expect(exceptionNeedsSecondApprover(7_499)).toBe(false);
    // "At or above" — exactly $75 needs the second name.
    expect(exceptionNeedsSecondApprover(7_500)).toBe(true);
    expect(exceptionNeedsSecondApprover(7_501)).toBe(true);
  });

  test("magnitude, not sign — an outflow stored negative still crosses", () => {
    expect(exceptionNeedsSecondApprover(-9_000)).toBe(true);
    expect(exceptionNeedsSecondApprover(-400)).toBe(false);
  });

  test("an org-set threshold overrides the default in both directions", () => {
    expect(exceptionNeedsSecondApprover(8_000, 50_000)).toBe(false);
    expect(exceptionNeedsSecondApprover(400, 100)).toBe(true);
  });
});

describe("receipt-exception enums stay in lock-step with their labels", () => {
  test("every reason has a label AND a hint — the hint is what keeps a filer honest", () => {
    for (const reason of RECEIPT_EXCEPTION_REASONS) {
      expect(RECEIPT_EXCEPTION_REASON_LABELS[reason]).toBeTruthy();
      expect(RECEIPT_EXCEPTION_REASON_HINTS[reason]).toBeTruthy();
    }
    expect(Object.keys(RECEIPT_EXCEPTION_REASON_LABELS).sort()).toEqual(
      [...RECEIPT_EXCEPTION_REASONS].sort(),
    );
    expect(Object.keys(RECEIPT_EXCEPTION_REASON_HINTS).sort()).toEqual(
      [...RECEIPT_EXCEPTION_REASONS].sort(),
    );
  });

  test("every status has a label and vice versa", () => {
    for (const status of RECEIPT_EXCEPTION_STATUSES) {
      expect(RECEIPT_EXCEPTION_STATUS_LABELS[status]).toBeTruthy();
    }
    expect(Object.keys(RECEIPT_EXCEPTION_STATUS_LABELS).sort()).toEqual(
      [...RECEIPT_EXCEPTION_STATUSES].sort(),
    );
  });
});

// ── Receipt extraction progress ──────────────────────────────────────────────
// The rule that decides whether the UI shows a live "reading…" strip. A
// spinner that never stops is worse than no spinner: a scheduled function
// that never landed must eventually read as "not running", which is why
// staleness is a reader-side rule and not just a stored flag.
describe("isReceiptExtractionActive", () => {
  const now = 1_760_000_000_000;

  test("nothing pending is never active", () => {
    expect(isReceiptExtractionActive(null, now)).toBe(false);
    expect(isReceiptExtractionActive(undefined, now)).toBe(false);
  });

  test("a fresh run is active; one older than the stale window is not", () => {
    expect(isReceiptExtractionActive({ status: "running", since: now - 5_000 }, now)).toBe(true);
    expect(
      isReceiptExtractionActive(
        { status: "running", since: now - RECEIPT_EXTRACTION_STALE_MS - 1 },
        now,
      ),
    ).toBe(false);
  });

  test("a queued attempt stays active until well past its fire time", () => {
    expect(
      isReceiptExtractionActive(
        { status: "queued", since: now, nextAttemptAt: now + 15 * 60_000 },
        now,
      ),
    ).toBe(true);
    // Fired minutes ago and nothing ever moved to `running` — the scheduled
    // function is gone; stop claiming a retry is coming.
    expect(
      isReceiptExtractionActive(
        { status: "queued", since: now - 60 * 60_000, nextAttemptAt: now - 30 * 60_000 },
        now,
      ),
    ).toBe(false);
  });
});

describe("receiptExtractionFraction", () => {
  const now = 1_760_000_000_000;

  test("a queued wait fills toward its fire time", () => {
    const at = (elapsed: number) =>
      receiptExtractionFraction(
        { status: "queued", since: now, nextAttemptAt: now + 60_000 },
        now + elapsed,
      );
    expect(at(0)).toBe(0);
    expect(at(30_000)).toBeCloseTo(0.5, 2);
    // Capped below full — the bar completing is the row updating, nothing else.
    expect(at(60_000)).toBeLessThan(1);
  });

  test("a running read creeps but never claims to be finished", () => {
    expect(receiptExtractionFraction({ status: "running", since: now }, now)).toBe(0);
    expect(
      receiptExtractionFraction({ status: "running", since: now }, now + 10 * 60_000),
    ).toBeLessThan(1);
  });
});

describe("merchant display name", () => {
  // The whole feature in one property: a rename is something rendered IN FRONT
  // of the provider's value, never something written over it.
  const BANK = "IC* COSTCO BY IN CAR";
  const ENGINE = "Auto: settlement of cross-book card spend through 2026-08-07";

  test("the bookkeeper's rename wins when there is one", () => {
    expect(
      displayMerchantName({ merchantNameOverride: "Costco", merchantName: BANK }),
    ).toBe("Costco");
  });

  test("the provider's value shows through when there is no rename", () => {
    expect(displayMerchantName({ merchantName: BANK })).toBe(BANK);
    expect(
      displayMerchantName({ merchantNameOverride: null, merchantName: BANK }),
    ).toBe(BANK);
  });

  test("a structured card descriptor is cleaned to the merchant alone", () => {
    // The exact production shape that made the coding list unreadable (owner,
    // 2026-08-11): the address is noise and the card suffix already renders
    // in the row's subtitle. Only the STRUCTURE is stripped — the merchant's
    // own text is untouched.
    expect(
      displayMerchantName({
        merchantName:
          "Purchase from GIVEBUTTER | Address: GIVEBUTTER.CO, DE, US | **9370",
      }),
    ).toBe("GIVEBUTTER");
    expect(
      displayMerchantName({
        merchantName:
          "Purchase from 9TH AVE ROYAL DELI INC | Address: 212-7656475, NY, US | **2702",
      }),
    ).toBe("9TH AVE ROYAL DELI INC");
    // A free-form provider string is NOT rewritten — that's what renames are
    // for (the BANK case above pins the same rule).
    expect(displayMerchantName({ merchantName: "OLLAMA" })).toBe("OLLAMA");
    // A rename still beats everything, cleaning included.
    expect(
      displayMerchantName({
        merchantNameOverride: "Givebutter",
        merchantName: "Purchase from GIVEBUTTER | Address: X | **9370",
      }),
    ).toBe("Givebutter");
  });

  test("a merchant-less row falls back to its description, then to the fallback", () => {
    expect(displayMerchantName({ description: ENGINE })).toBe(ENGINE);
    expect(displayMerchantName({})).toBe("Unlabeled charge");
    expect(displayMerchantName({}, "Transaction")).toBe("Transaction");
  });

  test("the provider's own name stays retrievable behind a rename", () => {
    expect(
      providerMerchantName({ merchantNameOverride: "Costco", merchantName: BANK }),
    ).toBe(BANK);
    // An engine-written row has no merchant at all — its description IS what
    // the row was called before anyone renamed it.
    expect(
      providerMerchantName({
        merchantNameOverride: "Aug settlement — NY",
        description: ENGINE,
      }),
    ).toBe(ENGINE);
  });
});

describe("finance audit actions", () => {
  test("every action carries a label (a new action must not render blank)", () => {
    for (const action of FINANCE_AUDIT_ACTIONS) {
      expect(FINANCE_AUDIT_ACTION_LABELS[action]).toBeTruthy();
    }
  });
});

describe("transaction source labels", () => {
  test("every source carries a label (a new rail must not render as an enum)", () => {
    for (const source of TRANSACTION_SOURCES) {
      expect(TRANSACTION_SOURCE_LABELS[source]).toBeTruthy();
    }
  });

  test("the two that read as jargon on a money screen name the bank, not the pipe", () => {
    // `stripe_fc` is the Relay bank feed read through Stripe Financial
    // Connections; the money never touched Stripe. The owner, looking at his
    // own bank rows: "I just see like stripe rows and stuff like that."
    expect(transactionSourceLabel("stripe_fc")).toBe("Relay bank feed");
    expect(transactionSourceLabel("relay_csv")).toBe("Relay statement import");
    expect(transactionSourceLabel("stripe_fc")).not.toMatch(/stripe/i);
  });

  test("a source this map has never seen renders as words", () => {
    expect(transactionSourceLabel("some_future_rail")).toBe("some future rail");
  });
});

describe("naming a book-value row", () => {
  const bare = {
    description: "",
    merchantName: null,
    merchantNameOverride: null,
    note: null,
    source: "stripe_fc",
    transferOrigin: null,
  };

  test("an EMPTY description is not an answer — the trap `displayMerchantName` fell into", () => {
    // Both book-value queries normalize `description` to `""` so the field can
    // be a plain `v.string()`. `displayMerchantName(row, fallback)` chains on
    // `??`, so `""` counts as a value, the fallback is unreachable, and the
    // row renders as nothing at all.
    expect(displayMerchantName(bare, "fallback")).toBe("");
    expect(bookValueLineTitle(bare)).toBe("Unlabeled relay bank feed row");
  });

  test("whitespace is not an answer either", () => {
    expect(
      bookValueLineTitle({ ...bare, merchantName: "  ", description: "\n" }),
    ).toBe("Unlabeled relay bank feed row");
  });

  test("the chain runs rename → merchant → description → note", () => {
    expect(
      bookValueLineTitle({ ...bare, merchantNameOverride: "Costco", merchantName: "IC* COSTCO" }),
    ).toBe("Costco");
    expect(bookValueLineTitle({ ...bare, merchantName: "IC* COSTCO" })).toBe(
      "IC* COSTCO",
    );
    expect(bookValueLineTitle({ ...bare, description: "Givebutter fees" })).toBe(
      "Givebutter fees",
    );
    expect(bookValueLineTitle({ ...bare, note: "Van hire" })).toBe("Van hire");
    expect(bookValueTitleUsedNote({ ...bare, note: "Van hire" })).toBe(true);
    expect(
      bookValueTitleUsedNote({ ...bare, merchantName: "Uber", note: "airport" }),
    ).toBe(false);
  });

  test("an engine leg names its step, not the generic source every one of them carries", () => {
    expect(
      bookValueRailLabel({ ...bare, source: "transfer", transferOrigin: "auto_settlement" }),
    ).toBe("Auto settlement");
    expect(bookValueRailLabel({ ...bare, source: "transfer" })).toBe(
      "Recorded transfer",
    );
    // An origin this map hasn't been taught falls back rather than blanking.
    expect(
      bookValueRailLabel({ ...bare, source: "transfer", transferOrigin: "future" }),
    ).toBe("Recorded transfer");
  });

  test("the unlabeled fallback uses the SAME rail name the row is badged with", () => {
    const row = { ...bare, source: "transfer", transferOrigin: "auto_settlement" };
    expect(bookValueLineTitle(row)).toBe("Unlabeled auto settlement row");
    expect(bookValueLineTitle(row)).toContain(
      bookValueRailLabel(row).toLowerCase(),
    );
  });
});

describe("book-value zero reasons", () => {
  test("every reason carries a label", () => {
    for (const reason of BOOK_VALUE_ZERO_REASONS) {
      expect(BOOK_VALUE_ZERO_REASON_LABELS[reason]).toBeTruthy();
    }
  });

  test("the reasons are distinct — the bug was one sentence standing in for all of them", () => {
    const labels = BOOK_VALUE_ZERO_REASONS.map(
      (r) => BOOK_VALUE_ZERO_REASON_LABELS[r],
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("only the unrecognized shape asks the reader to do something about it", () => {
    // A marked transfer and a balance settlement are zero deliberately and
    // correctly; describing them as missing a direction sent the treasurer
    // after work that doesn't exist.
    expect(BOOK_VALUE_ZERO_REASON_LABELS.unknown_transfer_shape).toContain(
      "no recorded direction",
    );
    expect(BOOK_VALUE_ZERO_REASON_LABELS.marked_transfer).not.toContain(
      "no recorded direction",
    );
    expect(BOOK_VALUE_ZERO_REASON_LABELS.balance_settlement).not.toContain(
      "no recorded direction",
    );
  });
});

/**
 * `autoExplainedKind` / `autoExplanationLine` — the 2026-08-12 founder
 * directive: fees and personal charges never enter the Explain worklist, and
 * the public ledger prints their status line for them. The line is derived
 * from structured state, so "paid back" can never precede the money.
 */
describe("autoExplainedKind", () => {
  test("a fee row is auto-explained even if somebody also flagged it personal (fee wins — it was never anyone's charge)", () => {
    expect(autoExplainedKind({ feeOrigin: "stripe_processing" })).toBe("fee");
    expect(
      autoExplainedKind({ feeOrigin: "stripe_processing", isPersonal: true }),
    ).toBe("fee");
  });

  test("a personal charge is auto-explained; an ordinary charge is not", () => {
    expect(autoExplainedKind({ isPersonal: true })).toBe("personal");
    expect(autoExplainedKind({})).toBeNull();
    expect(autoExplainedKind({ isPersonal: false })).toBeNull();
    expect(autoExplainedKind({ feeOrigin: null })).toBeNull();
  });

  test("a bank cashback payment is auto-explained — keyed on the provider's own category, never on text", () => {
    // Owner, 2026-08-13: "there's literally nothing for me to code there.
    // It's just money back… auto code these ones as well."
    expect(autoExplainedKind({ sourceCategory: "cashback_payment" })).toBe(
      "cashback",
    );
    // Any OTHER provider category is not the marker — an ordinary inbound
    // ACH still gets explained by a human.
    expect(
      autoExplainedKind({ sourceCategory: "inbound_ach_transfer" }),
    ).toBeNull();
    expect(autoExplainedKind({ sourceCategory: null })).toBeNull();
  });
});

describe("autoExplanationLine", () => {
  test("the personal line tracks the repayment's real state — the founder's exact wording", () => {
    expect(autoExplanationLine("personal", "personal_reimbursed")).toBe(
      "Accidental personal charge — paid back.",
    );
    expect(autoExplanationLine("personal", "personal_unpaid")).toBe(
      "Accidental personal charge — awaiting repayment.",
    );
    // No resolvable repayment reads as awaiting — never "paid back" on faith.
    expect(autoExplanationLine("personal")).toBe(
      "Accidental personal charge — awaiting repayment.",
    );
  });

  test("the fee line says why there is no receipt", () => {
    expect(autoExplanationLine("fee")).toContain("Payment processing fees");
    expect(autoExplanationLine("fee")).toContain("no receipt");
  });

  test("the cashback line says what the money is", () => {
    expect(autoExplanationLine("cashback")).toContain("Card cashback");
  });
});
