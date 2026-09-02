import { describe, expect, test } from "vitest";
import {
  FINANCE_AUDIT_ACTIONS,
  PAYOUT_PROCESSORS,
  PAYOUT_PROCESSOR_LABELS,
  RECEIPT_EXCEPTION_REASONS,
  RECEIPT_EXCEPTION_REASON_LABELS,
  TRANSACTION_FLOWS,
  TRANSACTION_FLOW_LABELS,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
} from "./finance";
import {
  CODING_AUDIT_STATE_LABELS,
  FINANCE_AUDIT_LABEL_ALIASES,
  FINANCE_AUDIT_VALUE_KINDS,
  PAYER_ATTRIBUTION_LABELS,
  PERSONAL_FLAG_LABELS,
  RECEIPT_STATE_LABELS,
  REFUND_STATE_LABELS,
  financeAuditKeyFromLabel,
  financeAuditValueKind,
  financeAuditValueLabel,
  receiptExceptionApprovedKey,
  receiptExceptionFiledKey,
  type FinanceAuditValueKind,
} from "./financeAuditValue";

/**
 * `financeAuditValue` — the KEY side of the finance audit trail and the one
 * renderer that words it. See that file's header for the whole design; these
 * tests hold the three promises it makes:
 *
 *  1. A LABEL RENAME MOVES HISTORY. `reconciled` rows written when the word was
 *     "Reconciled" read "Closed" today, from the same key, with nothing
 *     rewritten. That is the founder's ask ("store the status key and render
 *     the label") and it is the first test below.
 *  2. EVERY ACTION IS CLASSIFIED DELIBERATELY. A new `FINANCE_AUDIT_ACTION` is
 *     either keyed or explicitly free text — never accidentally the latter
 *     because nobody thought about it.
 *  3. THE BACKFILL'S 1:1 CLAIM HOLDS. No label has ever meant two different
 *     states inside one vocabulary, so mapping legacy words back to keys is a
 *     lookup rather than a guess.
 */

/** Every key each vocabulary can legitimately carry, enumerated from the
 *  vocabularies themselves so a new member cannot slip past unrendered. */
const KEYS_BY_KIND: Record<FinanceAuditValueKind, readonly string[]> = {
  transaction_status: TRANSACTION_STATUSES,
  transaction_flow: TRANSACTION_FLOWS,
  receipt_state: Object.keys(RECEIPT_STATE_LABELS),
  personal_flag: Object.keys(PERSONAL_FLAG_LABELS),
  payer_attribution: Object.keys(PAYER_ATTRIBUTION_LABELS),
  refund_state: Object.keys(REFUND_STATE_LABELS),
  payout_processor: PAYOUT_PROCESSORS,
  coding_state: Object.keys(CODING_AUDIT_STATE_LABELS),
  receipt_exception: [
    "pending",
    "approved",
    "rejected",
    "withdrawn",
    "withdrawn_amount_corrected",
    ...RECEIPT_EXCEPTION_REASONS.map(receiptExceptionFiledKey),
    ...RECEIPT_EXCEPTION_REASONS.map(receiptExceptionApprovedKey),
  ],
};

describe("the rename that started this (#717)", () => {
  test('a `reconciled` row written as "Reconciled" now reads "Closed"', () => {
    // Exactly the legacy shape: the key backfilled from the old word, the old
    // word still frozen on the row (append-only — nothing was rewritten).
    expect(
      financeAuditValueLabel("transaction_status", "reconciled", "Reconciled"),
    ).toBe("Closed");
    // And it is the KEY doing the work, not a string swap: the frozen word is
    // ignored entirely once the key resolves.
    expect(
      financeAuditValueLabel("transaction_status", "reconciled", "Nonsense"),
    ).toBe("Closed");
  });

  test("the trail no longer reads two ways about one state", () => {
    const legacy = financeAuditValueLabel(
      "transaction_status",
      "reconciled",
      "Reconciled",
    );
    const fresh = financeAuditValueLabel(
      "transaction_status",
      "reconciled",
      "Closed",
    );
    expect(legacy).toBe(fresh);
  });

  test("the retired word still maps back to the state it named", () => {
    expect(financeAuditKeyFromLabel("transaction_status", "Reconciled")).toBe(
      "reconciled",
    );
    expect(financeAuditKeyFromLabel("transaction_status", "Closed")).toBe(
      "reconciled",
    );
  });
});

describe("financeAuditValueKind — every action classified on purpose", () => {
  const KEYED: Partial<Record<string, FinanceAuditValueKind>> = {
    status_change: "transaction_status",
    transfer_mark: "transaction_flow",
    receipt_attach: "receipt_state",
    receipt_detach: "receipt_state",
    refund_mark: "refund_state",
    refund_mark_auto: "refund_state",
    payout_mark: "payout_processor",
    coding_submit: "coding_state",
    coding_decide: "coding_state",
    receipt_exception_attest: "receipt_exception",
    receipt_exception_decide: "receipt_exception",
    receipt_exception_withdraw: "receipt_exception",
  };

  /** The one action with TWO vocabularies, split by `field` — asserted on its
   *  own below, and listed here so the coverage check sees it classified. */
  const SPLIT_BY_FIELD = ["personal_flag"];

  /** Free text ON PURPOSE — an entity's own name, a sentence, a dollar figure.
   *  Listed rather than defaulted so adding an action forces the question. */
  const FREE_TEXT = [
    "recode", // a category / budget NAME
    "correction", // amount, date, merchant string, description
    "note_edit", // prose
    "manual_create", // a composed "what — $X (flow)" line
    "budget_amount_change", // formatted dollars
    "budget_delete", // "Name ($X)"
    "coding_redact", // two published sentences
    "coding_amend", // a budget/category name, a route, an expense type
    "merchant_rename", // merchant strings
    "sale_items_set", // a composed basket ("2 × PW Tee + Popcorn")
    "sale_event_set", // an event's name
  ];

  test("every FINANCE_AUDIT_ACTION is either keyed or deliberately free text", () => {
    const classified = new Set([
      ...Object.keys(KEYED),
      ...SPLIT_BY_FIELD,
      ...FREE_TEXT,
    ]);
    expect([...FINANCE_AUDIT_ACTIONS].sort()).toEqual([...classified].sort());
  });

  test("keyed actions resolve to their vocabulary", () => {
    for (const [action, kind] of Object.entries(KEYED)) {
      expect(financeAuditValueKind(action as never, "whatever")).toBe(kind);
    }
  });

  test("free-text actions resolve to null on any field", () => {
    for (const action of FREE_TEXT) {
      expect(financeAuditValueKind(action as never, null)).toBeNull();
      expect(financeAuditValueKind(action as never, "amount")).toBeNull();
    }
  });

  test("personal_flag splits by field — the boolean and the payer are different states", () => {
    expect(financeAuditValueKind("personal_flag", "isPersonal")).toBe(
      "personal_flag",
    );
    expect(financeAuditValueKind("personal_flag", "personId")).toBe(
      "payer_attribution",
    );
  });
});

describe("financeAuditValueLabel — every key words itself", () => {
  test("every key in every vocabulary renders a non-empty label", () => {
    for (const kind of FINANCE_AUDIT_VALUE_KINDS) {
      for (const key of KEYS_BY_KIND[kind]) {
        const label = financeAuditValueLabel(kind, key, null);
        expect(label, `${kind}/${key}`).toBeTruthy();
      }
    }
  });

  test("the labels are the app's own, never restated here", () => {
    expect(financeAuditValueLabel("transaction_status", "excluded", null)).toBe(
      TRANSACTION_STATUS_LABELS.excluded,
    );
    expect(financeAuditValueLabel("transaction_flow", "outflow", null)).toBe(
      TRANSACTION_FLOW_LABELS.outflow,
    );
    expect(financeAuditValueLabel("payout_processor", "stripe", null)).toBe(
      PAYOUT_PROCESSOR_LABELS.stripe,
    );
    expect(financeAuditValueLabel("coding_state", "submitted", null)).toBe(
      CODING_AUDIT_STATE_LABELS.submitted,
    );
  });

  test("receipt exceptions carry their reason through the compound key", () => {
    expect(
      financeAuditValueLabel(
        "receipt_exception",
        receiptExceptionFiledKey("lost"),
        null,
      ),
    ).toBe(RECEIPT_EXCEPTION_REASON_LABELS.lost);
    expect(
      financeAuditValueLabel(
        "receipt_exception",
        receiptExceptionApprovedKey("lost"),
        null,
      ),
    ).toBe(`Approved — ${RECEIPT_EXCEPTION_REASON_LABELS.lost}`);
  });

  test("a free-text row falls straight through to the words it was written with", () => {
    expect(financeAuditValueLabel(null, null, "Coffee with a donor")).toBe(
      "Coffee with a donor",
    );
    expect(financeAuditValueLabel(null, null, null)).toBeNull();
  });

  test("an unkeyed legacy row keeps rendering its frozen string", () => {
    // What every row looks like before the backfill reaches it.
    expect(
      financeAuditValueLabel("transaction_status", null, "Reconciled"),
    ).toBe("Reconciled");
  });

  test("a key the vocabulary has since retired falls back rather than blanking", () => {
    // The case the frozen string is KEPT for: no label to render, but the row
    // still has to say something true.
    expect(
      financeAuditValueLabel("transaction_status", "archived", "Archived"),
    ).toBe("Archived");
    // And with nothing frozen either, the raw key beats a blank.
    expect(financeAuditValueLabel("transaction_status", "archived", null)).toBe(
      "archived",
    );
  });

  test("a malformed receipt-exception key never invents a label", () => {
    expect(
      financeAuditValueLabel("receipt_exception", "approved:not_a_reason", "X"),
    ).toBe("X");
  });
});

describe("the backfill's 1:1 claim — checked, not assumed", () => {
  test("no label has ever meant two states inside one vocabulary", () => {
    // The claim the whole migration rests on. `assertUnambiguous` enforces this
    // at module load; this states it as a property so the failure names the
    // offending word rather than a stack trace at import time.
    for (const kind of FINANCE_AUDIT_VALUE_KINDS) {
      const meanings = new Map<string, string>();
      for (const [label, key] of FINANCE_AUDIT_LABEL_ALIASES[kind]) {
        const seen = meanings.get(label);
        expect(
          seen === undefined || seen === key,
          `${kind}: "${label}" has meant both "${seen}" and "${key}"`,
        ).toBe(true);
        meanings.set(label, key);
      }
    }
  });

  test("two labels MAY mean one state — that is what a rename is", () => {
    const statuses = FINANCE_AUDIT_LABEL_ALIASES.transaction_status.filter(
      ([, key]) => key === "reconciled",
    );
    expect(statuses.map(([label]) => label).sort()).toEqual([
      "Closed",
      "Reconciled",
    ]);
  });

  test("every current label round-trips to the key that renders it", () => {
    for (const kind of FINANCE_AUDIT_VALUE_KINDS) {
      for (const key of KEYS_BY_KIND[kind]) {
        const label = financeAuditValueLabel(kind, key, null)!;
        expect(financeAuditKeyFromLabel(kind, label), `${kind}/${key}`).toBe(
          key,
        );
      }
    }
  });

  test("a word no vocabulary has shown maps to nothing, rather than to a guess", () => {
    expect(
      financeAuditKeyFromLabel("transaction_status", "Half-done"),
    ).toBeNull();
    expect(financeAuditKeyFromLabel("receipt_state", null)).toBeNull();
  });

  test("the flow vocabulary keys the raw enums the trail used to display", () => {
    // `markAsTransfer` wrote `leg.txn.flow` straight into the display field, so
    // legacy rows literally say "outflow". Those ARE keys already.
    expect(financeAuditKeyFromLabel("transaction_flow", "outflow")).toBe(
      "outflow",
    );
    expect(
      financeAuditValueLabel("transaction_flow", "outflow", "outflow"),
    ).toBe("Money out");
  });
});
