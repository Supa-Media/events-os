/**
 * Pure helpers for the CONTRACTOR ROSTER — "it's this person again".
 *
 * The roster is what the org remembers about someone BETWEEN payments, so a
 * contractor we've already paid isn't asked to re-file a W-9 and a staffer
 * isn't asked to re-type a name. Its sibling `helpers.ts` owns the payment
 * QUEUE's derivations; this file owns the person's.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE — and the reason the prefill is a
 * function rather than an object spread at the call site:
 *
 *   IDENTITY AUTOFILLS. TERMS DO NOT.
 *
 * Who they are (name, email, phone) is a fact about the person, unchanged since
 * last time, and re-typing it is pure friction. The AMOUNT, the SERVICE
 * DESCRIPTION and the SERVICE DATE are this job's terms: the description
 * publishes verbatim and permanently on the public ledger, and an amount that
 * arrives pre-filled is an amount nobody decided — a staffer who tabs past it
 * has still, on the record, committed the chapter to paying it. So
 * `contractorIdentityPatch` returns exactly three keys, `NEVER_PREFILLED` names
 * the three it must never return, and the test asserts the two sets don't
 * intersect. `usualRateUsd` comes back as a tappable HINT
 * (`usualRateHint`), which is a different thing from a filled field: a person
 * has to press it, and pressing it is a decision.
 *
 * Kept JSX-free and react-native-free (the sibling `helpers.ts` is the
 * precedent) so all of the above is trivially testable — mobile's CI gate is
 * jest, not `tsc`, so logic that isn't tested here isn't verified at all.
 * Row shapes are derived from the LIVE `api.contractorProfiles` returns, so a
 * backend projection change surfaces as a type error rather than a screen that
 * renders `undefined`.
 */
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import {
  CONTRACTOR_TAX_CLASSIFICATIONS,
  CONTRACTOR_TAX_CLASSIFICATION_LABELS,
  CONTRACTOR_TAX_DOC_KIND_LABELS,
  contractorDescriptionProblems,
  publicTextProblems,
  type ContractorTaxClassification,
  type ContractorTaxDocKind,
} from "@events-os/shared";
import { formatDate } from "../../../lib/format";

// ── Backend shapes ───────────────────────────────────────────────────────────
/** The whole roster read, flags included. */
export type ContractorRoster = FunctionReturnType<
  typeof api.contractorProfiles.list
>;

/** One person on the roster — the exact `list` row shape. */
export type ContractorRosterRow = ContractorRoster["contractors"][number];

/** What's on file for ONE person — `onFileFor`, which adds the phone and the
 *  usual rate the roster rows don't carry. */
export type ContractorOnFile = FunctionReturnType<
  typeof api.contractorProfiles.onFileFor
>;

/** The tax-document METADATA both reads return. Never a storage id — making a
 *  contractor easier to find must not make their W-9 easier to open. */
export type ContractorTaxDocMeta = NonNullable<
  ContractorRosterRow["taxDocument"]
>;

/** What `forget` reports back. */
export type ForgetResult = FunctionReturnType<
  typeof api.contractorProfiles.forget
>;

// ── The prefill, and its blast radius ────────────────────────────────────────
/**
 * The ONLY three fields picking a contractor may write into the composer.
 *
 * Deliberately its own named type rather than `Partial<AgreementDraft>`: a
 * `Partial` would let a future edit quietly add `amountText` and nothing would
 * complain. These three, spread into the draft, and no others.
 */
export type ContractorIdentityPatch = {
  payeeName: string;
  payeeEmail: string;
  payeePhone: string;
};

/**
 * Draft fields that must stay EMPTY when a contractor is picked — this job's
 * terms, not this person's facts. Exported so the test can assert the patch
 * never grows one of them; see this file's header for why each is here.
 */
export const NEVER_PREFILLED = [
  "serviceDescription",
  "serviceDate",
  "amountText",
] as const;

/**
 * Identity from the roster → the composer's fields. Missing values become `""`
 * rather than being omitted, because an omitted key would leave whatever the
 * PREVIOUS pick wrote in the field — picking a contractor with no phone on file
 * must clear the last one's phone, not inherit it.
 */
export function contractorIdentityPatch(
  onFile: Pick<ContractorOnFile, "name" | "email" | "phone">,
): ContractorIdentityPatch {
  return {
    payeeName: onFile.name ?? "",
    payeeEmail: onFile.email ?? "",
    payeePhone: onFile.phone ?? "",
  };
}

/**
 * The contractor's usual rate as a tappable suggestion, or `null` when there
 * isn't a sane one.
 *
 * `amountText` is what the Amount field would hold IF the person presses it —
 * dollars with cents, exactly as `centsToAmountText` shapes an edited amount,
 * so the app's one `parseDollars` reads it back to the same integer cents.
 * Nothing here writes it anywhere; that is the composer's job, on a press.
 */
export function usualRateHint(
  usualRateUsd: number | undefined,
): { label: string; amountText: string } | null {
  if (usualRateUsd == null) return null;
  if (!Number.isFinite(usualRateUsd) || usualRateUsd <= 0) return null;
  const amountText = usualRateUsd.toFixed(2);
  // Whole dollars read as money; a rate with cents keeps them.
  const shown =
    Number.isInteger(usualRateUsd) ? `$${usualRateUsd}` : `$${amountText}`;
  return {
    label: `Usually ${shown} — use this?`,
    amountText,
  };
}

// ── What's on file, said as reassurance ──────────────────────────────────────
/**
 * The sentence under a picked contractor: what we already hold, so the staffer
 * knows what they are NOT about to ask this person for again.
 *
 * `reaskProblem` is the honest other half. A W-8 lapses (a W-9 doesn't), and a
 * lapsed one is still on file — it just can't be reused. That has to be said
 * where the agreement is being written, and it must NOT block the payment: the
 * contractor gets asked for a new form through their link, which is the normal
 * path, not an error.
 */
export type OnFileSummary = {
  /** e.g. "W-9 on file since Mar 14, 2026" — `null` when nothing is filed. */
  taxLine: string | null;
  /** e.g. "account ending 6789" — `null` when no bank is remembered. */
  bankLine: string | null;
  /** The whole reassurance sentence, or `null` when we hold nothing yet. */
  sentence: string | null;
  /** Why the form on file can't be reused, or `null` when it can. */
  reaskProblem: string | null;
};

export function onFileSummary(row: {
  hasBankOnFile: boolean;
  bankAccountLast4?: string;
  taxDocument: ContractorTaxDocMeta | null;
}): OnFileSummary {
  const doc = row.taxDocument;
  const reusable = doc != null && doc.isCurrent;
  const kindLabel = doc
    ? (CONTRACTOR_TAX_DOC_KIND_LABELS[doc.kind as ContractorTaxDocKind] ??
      doc.kind.toUpperCase())
    : null;

  // A lapsed form is described in the past tense — "on file since" would be
  // true and misleading in the same breath, because they WILL be asked again.
  const taxLine =
    doc == null
      ? null
      : reusable
        ? `${kindLabel} on file since ${formatDate(doc.signedAt ?? doc.uploadedAt)}`
        : `${kindLabel} on file, but not usable`;

  const bankLine =
    row.hasBankOnFile && row.bankAccountLast4
      ? `account ending ${row.bankAccountLast4}`
      : row.hasBankOnFile
        ? "bank details on file"
        : null;

  const kept = [taxLine, bankLine].filter((s): s is string => s != null);
  // The promise is only made about what can actually be reused. With a lapsed
  // form and no bank, there is nothing to reassure anyone about.
  const reusableParts = [reusable ? taxLine : null, bankLine].filter(
    (s): s is string => s != null,
  );
  const sentence =
    kept.length === 0
      ? null
      : reusableParts.length === 0
        ? kept.join(" · ")
        : `${kept.join(" · ")} — they won't be asked again.`;

  return {
    taxLine,
    bankLine,
    sentence,
    reaskProblem: doc != null && !doc.isCurrent ? (doc.problem ?? null) : null,
  };
}

/** The one-line "what's on file" a roster ROW shows, always a sentence even
 *  when the answer is nothing — an empty cell reads as a loading bug. */
export function onFileShortLine(row: {
  hasBankOnFile: boolean;
  bankAccountLast4?: string;
  taxDocument: ContractorTaxDocMeta | null;
}): string {
  const { taxLine, bankLine } = onFileSummary(row);
  const parts = [taxLine, bankLine].filter((s): s is string => s != null);
  return parts.length > 0 ? parts.join(" · ") : "Nothing on file yet";
}

/** When we last paid them, said plainly. A roster row can exist without one —
 *  a profile saved by hand before the first payout. */
export function lastPaidLine(lastPaidAt: number | undefined): string {
  return lastPaidAt == null
    ? "Not paid through the app yet"
    : `Last paid ${formatDate(lastPaidAt)}`;
}

// ── Tax classification ───────────────────────────────────────────────────────
/**
 * How the contractor is organised, as a label. `unknown` is a REAL value —
 * every contractor on file predates the question — so it renders as "Not
 * recorded" and never as an error. A value the app doesn't recognise falls back
 * to the same words rather than printing a raw enum at a treasurer.
 */
export function taxClassificationLabel(value: string | undefined): string {
  const known = CONTRACTOR_TAX_CLASSIFICATION_LABELS[
    value as ContractorTaxClassification
  ];
  return known ?? CONTRACTOR_TAX_CLASSIFICATION_LABELS.unknown;
}

/** True when the classification decides nothing yet — the prompt-worthy case,
 *  and the only one the roster nudges about. Not a problem, just unanswered. */
export function taxClassificationMissing(value: string | undefined): boolean {
  return value == null || value === "unknown";
}

/** Options for the classification `Select`, in the shared tuple's order so the
 *  picker can't drift from the enum. */
export function taxClassificationOptions(): { value: string; label: string }[] {
  return CONTRACTOR_TAX_CLASSIFICATIONS.map((c) => ({
    value: c,
    label: CONTRACTOR_TAX_CLASSIFICATION_LABELS[c],
  }));
}

// ── Finding someone ──────────────────────────────────────────────────────────
/** Roster rows in the order a person looks for them: most recently paid first,
 *  then never-paid profiles, alphabetically within each. */
export function sortContractors<
  T extends { name: string; lastPaidAt?: number },
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const al = a.lastPaidAt ?? -1;
    const bl = b.lastPaidAt ?? -1;
    if (al !== bl) return bl - al;
    return a.name.localeCompare(b.name);
  });
}

/** Does this row answer what was typed? Name, business name and email, because
 *  those are the three things a staffer actually remembers about a contractor.
 *  An empty query matches everything rather than nothing. */
export function matchesContractorQuery(
  row: { name: string; email?: string; businessName?: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [row.name, row.email, row.businessName].some(
    (s) => s != null && s.toLowerCase().includes(q),
  );
}

export function filterContractors<
  T extends { name: string; email?: string; businessName?: string; lastPaidAt?: number },
>(rows: readonly T[], query: string): T[] {
  return sortContractors(rows).filter((r) => matchesContractorQuery(r, query));
}

// ── Forgetting someone ───────────────────────────────────────────────────────
/**
 * The confirmation copy for `forget`, which has to be honest about a thing
 * people find surprising: the bank details ALWAYS go, and a tax document still
 * inside its retention window STAYS, because it substantiates money that moved
 * and a return that was filed. Promising a clean erase and then keeping the
 * form would be the worst of both — so the promise is made narrow up front.
 */
export const FORGET_CONFIRM_TITLE = "Forget this contractor?";

export function forgetConfirmMessage(name: string): string {
  return (
    `We'll delete the bank details we remember for ${name}, so nothing can be ` +
    "paid out to them again without re-entering an account.\n\n" +
    "Their tax form may have to stay. The chapter is required to keep a W-9 " +
    "or W-8 for four years after the last payment it substantiates — anything " +
    "still inside that window is kept, and we'll tell you exactly what was " +
    "kept when it's done. Their payment history is never deleted."
  );
}

/**
 * What actually happened, in the same plain terms. Says the kept documents out
 * loud rather than reporting a success the caller would read as "all gone".
 */
export function forgetOutcomeMessage(result: ForgetResult): string {
  const parts: string[] = [];
  parts.push(
    result.bankDetailsCleared
      ? "Bank details deleted."
      : "There were no bank details to delete.",
  );
  if (result.documentsDeleted > 0) {
    parts.push(
      `${result.documentsDeleted} tax ${plural(result.documentsDeleted, "form")} deleted.`,
    );
  }
  if (result.documentsKept > 0) {
    parts.push(
      `${result.documentsKept} tax ${plural(result.documentsKept, "form")} kept — ` +
        `still inside the retention window the chapter is required to hold ${
          result.documentsKept === 1 ? "it" : "them"
        } for.`,
    );
  }
  if (result.documentsDeleted === 0 && result.documentsKept === 0) {
    parts.push("There were no tax forms on file.");
  }
  return parts.join(" ");
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

// ── The service description's floor ──────────────────────────────────────────
/**
 * Everything wrong with a proposed service description, in the composer's own
 * words.
 *
 * THIS CLOSES A REAL BUG. The payout path codes the transaction through the
 * shared `codingFieldProblems` rule, which demands `MIN_PURPOSE_LENGTH`
 * characters of purpose. The composer used to accept three. So a description of
 * "mix" passed composition, passed the contractor's acceptance, passed
 * APPROVAL — and then failed at the moment a treasurer pressed Pay, with a
 * message about "which org work it served" that makes no sense on a payout
 * screen and money that didn't move for a reason nobody could act on.
 * `contractorDescriptionProblems` is the shared rule, enforced here at the door.
 *
 * The empty field gets its own sentence: "at least 20 characters" is a strange
 * thing to say to someone who hasn't started typing. The leak warnings
 * (`publicTextProblems`) get the reason appended, because "this looks like it
 * contains a phone number" is an observation and the person needs the
 * instruction — those two sets never co-occur, since the shared rule returns
 * the length problem alone when it fires.
 */
export function descriptionProblems(raw: string): string[] {
  const text = raw.trim();
  if (text.length === 0) {
    return ["Say what the work was — this appears on the public ledger."];
  }
  const leaks = new Set(publicTextProblems(text));
  return contractorDescriptionProblems(text).map((p) =>
    leaks.has(p)
      ? `${p} This description is published publicly, so please reword it without personal details.`
      : p,
  );
}
