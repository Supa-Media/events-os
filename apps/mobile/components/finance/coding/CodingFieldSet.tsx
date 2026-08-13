/**
 * THE CODING FIELD SET — purpose, the type-driven §274(d) extras, and the
 * budget picker, extracted from `TransactionCodingModal` so every host that
 * asks these questions renders the SAME form instead of a forked copy. Two
 * hosts today:
 *  - `TransactionCodingModal` (Reconcile's grid + the workbench panel) — the
 *    modal frame around this content.
 *  - `FinishChargeSheetBody`'s inline "What it was for" flow — this content
 *    directly inside the sheet, no modal frame at all.
 *
 * ONE FORM, MANY FRAMES: this file owns the fields; each host owns its own
 * chrome (dialog vs. inline block) and its own category picker, if it has
 * one. `useCodingFormState` is the state; `CodingFieldSet` is the render.
 *
 * CATEGORY-AWARE BY CONSTRUCTION (founder, 2026-08-1x): "it should be an
 * inline thing that already knows the category and just asks for more
 * information." The expense-type picker used to be a bare "What kind of
 * expense?" radio, ignorant of whatever category the charge already carried.
 * Now it's a compact chip row whose selection FOLLOWS the category's
 * `expenseTypeHint` — a QUESTION-SET hint, never an answer (see
 * `budgetCategories.expenseType`'s schema doc and `deriveExpenseType.ts`'s
 * own module doc: this machinery only ever decides which fields to ASK for,
 * never writes into the purpose/attendees/headcount the human types). A host
 * with no category to offer (or a category with no hint) passes
 * `category: null` and the chips start unselected, exactly as the old radio
 * did.
 *
 * NO MACHINE EVER WRITES AN ANSWER (owner decision, 2026-08-08: no AI in
 * coding). The derivation above decides which QUESTIONS appear, never what
 * fills them in. One deliberate carve-out (owner directive, 2026-08-12:
 * "auto populate with request purpose notes that we already have… remove a
 * copy and paste step"): a reimbursement payout's pristine form may start
 * from the CLAIMANT'S OWN words off the request — a human's existing
 * testimony carried forward, never composed — via `applyPrefill` below,
 * labeled with its provenance and fully editable. See
 * `reimbursementPrefill.ts` for the rule.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Pressable, Text, View } from "react-native";
import {
  ATTENDEE_AFFILIATIONS,
  ATTENDEE_AFFILIATION_LABELS,
  EXPENSE_TYPES,
  EXPENSE_TYPE_LABELS,
  codingFieldProblems,
  mealNamesRequired,
  type AttendeeAffiliation,
  type CodingProblem,
  type ExpenseType,
} from "@events-os/shared";
import { Button, Icon, Radio, RadioGroup, Select, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import {
  deriveExpenseTypeFromCategory,
  initialExpenseTypeChipState,
  overrideExpenseType,
  type ExpenseTypeChipState,
} from "./deriveExpenseType";
import { mergeBulkAttendees, parseAttendeePaste } from "./attendeePaste";
import type { ReimbursementPrefillPlan } from "./reimbursementPrefill";

/** The category context a host offers the chip row, if any:
 *  - `undefined` — this host has no category concept nearby at all.
 *  - `null` — there IS a category picker, but nothing is chosen yet.
 *  - `{ name, expenseTypeHint }` — a chosen category, whose hint (if any)
 *    drives the chips until the person overrides them. */
export type CodingCategoryContext =
  | { name: string; expenseTypeHint?: ExpenseType }
  | null
  | undefined;

/** Per-chip description. TRAVEL'S COPY NAMES TRANSPORTATION EXPLICITLY
 *  (founder: "it's unclear what the difference is between travel and
 *  transportation") — Transportation is a CATEGORY name, travel is an
 *  EXPENSE TYPE (a proof-question branch); the two vocabularies looked like
 *  they disagreed because nothing said they were the same axis. */
export const TYPE_HINTS: Record<ExpenseType, string> = {
  general: "Supplies, equipment, software, fees — anything without special IRS fields.",
  travel:
    "Getting somewhere — fares, gas, parking, tolls (your Transportation category lands here). Asks where from and where to.",
  meal: "Food or drinks for people — asks who was there.",
  lodging: "A hotel or overnight stay — asks where you stayed, and always needs an itemized receipt.",
};

/** The chip's own short label. Deliberately NOT `EXPENSE_TYPE_LABELS` for
 *  lodging: "Overnight stay" says what to tap for BEFORE you've read the
 *  hint text, where "Lodging" reads as a category name (see the founder
 *  quote above) rather than the question branch it actually is. Everywhere
 *  ELSE a coding's lodging type still reads "Lodging" (`EXPENSE_TYPE_LABELS`,
 *  unchanged) — this override is scoped to the picker only. */
const CHIP_LABELS: Record<ExpenseType, string> = {
  ...EXPENSE_TYPE_LABELS,
  lodging: "Overnight stay",
};

export interface CodingFormValue {
  expenseType: ExpenseType;
  businessPurpose: string;
  travelFrom?: string;
  travelTo?: string;
  headcount?: number;
  attendees?: { name: string; affiliation: AttendeeAffiliation }[];
  groupDescription?: string;
  /** Which budget this came out of — the person coding it says so. Omitted
   *  when they leave it alone; the submit mutation never CLEARS an existing
   *  attribution from here. */
  budgetId?: string;
}

/**
 * WHICH BUDGET — the guidance, in the owner's own mapping (2026-08-09), as
 * plain hints beside the choices rather than a wall of policy. See
 * `TransactionCodingModal`'s original module doc for the full quote; kept
 * here now that the picker itself lives in this file.
 */
const BUDGET_GUIDANCE = [
  "Bought for a specific event? That event's budget.",
  "Team meeting, subscription, or general running cost? Operating.",
  "Equipment that isn't tied to one event? The annual equipment budget.",
];

/** What a bulk-add path (`startWithTeam`/`appendAttendees`) actually did
 *  (`attendeePaste.ts#mergeBulkAttendees`) — `added < requested` only ever
 *  means the absurd `HARD_BULK_ATTENDEE_CAP` bit; an over-THRESHOLD add
 *  keeps every row and is narrated by the live overflow-pruning banner
 *  instead. */
export interface BulkAddResult {
  /** How many candidates actually landed on the form. */
  added: number;
  /** How many candidates were eligible to add (after de-dupe) — `added`
   *  falls short of this exactly when the hard cap bit. */
  requested: number;
}

export interface CodingFormState {
  expenseType: ExpenseType | null;
  /** The manual chip tap — sticky, and the ONLY thing that sets `overridden`
   *  true (see `deriveExpenseType.ts`). */
  setExpenseType: (t: ExpenseType) => void;
  businessPurpose: string;
  setBusinessPurpose: (s: string) => void;
  travelFrom: string;
  setTravelFrom: (s: string) => void;
  travelTo: string;
  setTravelTo: (s: string) => void;
  headcountRaw: string;
  setHeadcountRaw: (s: string) => void;
  attendees: { name: string; affiliation: AttendeeAffiliation }[];
  /** Rows sized to the headcount (or empty) — see `TransactionCodingModal`'s
   *  original doc on why the row COUNT comes from the headcount. */
  rows: { name: string; affiliation: AttendeeAffiliation }[];
  setRow: (
    index: number,
    patch: Partial<{ name: string; affiliation: AttendeeAffiliation }>,
  ) => void;
  /** BULK ATTENDEE ENTRY (founder, 2026-08-12): remove one row, shifting the
   *  rest up. THE HEADCOUNT/ROWS CONSISTENCY RULE: whenever the roster
   *  editor renders (`namesMode === true`, OR the overflow-pruning state
   *  after a bulk add pushed past the threshold), `rows.length` equals
   *  `headcount` exactly, so removing a row always means one fewer expected
   *  attendee and headcount comes down by one too. The equality is checked
   *  explicitly rather than assumed, so a future change that decouples
   *  `rows` from `headcount` fails safe (no headcount edit) instead of
   *  silently under-counting. Counts as touched, like every other content
   *  edit. */
  removeAttendeeRow: (index: number) => void;
  /** "Start with the team" — THE PRUNE-DOWN MODEL (founder, 2026-08-13:
   *  "populate with all the team members, and then I could go in and start
   *  ✕-ing people who weren't there"). Merges the WHOLE team roster into the
   *  filled rows (`mergeBulkAttendees` — deduped, uncapped at the names
   *  threshold, hard-capped only at `HARD_BULK_ATTENDEE_CAP`) and sets
   *  headcount to the merged total, replacing whatever headcount was typed:
   *  the roster IS the new answer to "how many", and pruning keeps the two
   *  in step from there. May land above `namesMaxHeadcount` — that's the
   *  `overflowPruning` state, rows stay rendered for ✕-ing. */
  startWithTeam: (team: { name: string }[]) => BulkAddResult;
  /** "Paste a list" — same merge semantics as `startWithTeam` (the paste is
   *  the roster being declared, prune-down applies the same way), with the
   *  parser's own affiliations preserved. Dedupes defensively even though
   *  the parser already deduped against `existingNames`. */
  appendAttendees: (
    parsed: { name: string; affiliation: AttendeeAffiliation }[],
  ) => BulkAddResult;
  /** True while a bulk add has put MORE named rows on the form than the
   *  names-required threshold: rows stay rendered for pruning, the
   *  submittable value carries no attendees yet, and the host shows the
   *  banner explaining the two ways down (✕ absentees, or keep the
   *  headcount and describe the group). */
  overflowPruning: boolean;
  /** The threshold `rows`/`namesMode` are computed against — exposed so a
   *  host can word a cap notice ("holds up to N people") without having to
   *  be handed the constant separately. */
  namesMaxHeadcount: number;
  groupDescription: string;
  setGroupDescription: (s: string) => void;
  budgetId: string;
  setBudgetId: (s: string) => void;
  headcount: number | undefined;
  namesMode: boolean | null;
  /** `null` while `expenseType` is unset — nothing to submit yet. */
  value: CodingFormValue | null;
  fieldProblems: CodingProblem[];
  /** Has the person typed into ANY content field yet — gates whether
   *  problems show (a form covered in red before anything was typed teaches
   *  people to ignore red) and whether closing warns about unsent input.
   *  EVENT-based, not content-based: a prefill (`applyPrefill`) puts words
   *  in the fields without setting this, so an untouched prefilled form
   *  neither shouts red nor guilt-trips a close. */
  touched: boolean;
  /** Did `applyPrefill` put the claimant's own words in — drives the
   *  provenance line ("started from the reimbursement request") and lets
   *  hosts show field problems for a prefilled-but-incomplete form even
   *  before a touch (otherwise a disabled submit would have no visible
   *  reason). */
  prefilled: boolean;
  /** OWNER DIRECTIVE (2026-08-12): apply a `reimbursementPrefillPlan` to a
   *  PRISTINE form — the auto-populate that replaced the copy-and-paste
   *  step. Hosts guard the pristine-ness (no existing coding, nothing
   *  typed, once per open); this just writes the values. A `null` plan is a
   *  no-op. Does NOT mark the form touched — nothing was typed — but a
   *  "line" plan does mark the expense-type chip overridden, exactly like
   *  `applyExternalLine`, so a later category change can't clobber the
   *  claimant's declared type. */
  applyPrefill: (plan: ReimbursementPrefillPlan) => void;
  /** FINDING 1 (UX audit, 2026-08-12): bulk-apply an externally-authored
   *  line — the ONE write path for "Use these answers" on a reimbursement
   *  payout's already-written substantiation (`reimbursementCodingContext`).
   *  A single explicit human tap, never automatic — see
   *  `ReimbursementContextBlock`'s own module doc for the principle this
   *  guards. Marks the expense-type chip OVERRIDDEN (same as a manual chip
   *  tap) so a later category change can't silently clobber what was just
   *  copied in. */
  applyExternalLine: (line: {
    expenseType: ExpenseType;
    businessPurpose: string;
    travelFrom?: string | null;
    travelTo?: string | null;
    headcount?: number | null;
    attendees?: { name: string; affiliation: AttendeeAffiliation }[] | null;
    groupDescription?: string | null;
  }) => void;
}

/**
 * THE STATE — one hook, so both hosts derive `value`/`fieldProblems` the
 * exact same way `TransactionCodingModal` always has.
 */
export function useCodingFormState({
  initial,
  initialBudgetId,
  namesMaxHeadcount,
  category,
}: {
  initial?: CodingFormValue | null;
  initialBudgetId?: string | null;
  namesMaxHeadcount: number;
  /** See `CodingCategoryContext`. Read once at mount for the STARTING chip
   *  state (`initialExpenseTypeChipState`); every subsequent change flows
   *  through the effect below, so a host that swaps `category` live (the
   *  inline flow's own category Select) gets the chips re-derived exactly
   *  like a fresh mount would have, without losing an override in between. */
  category?: CodingCategoryContext;
}): CodingFormState {
  const [chip, setChip] = useState<ExpenseTypeChipState>(() =>
    initialExpenseTypeChipState({
      existingExpenseType: initial?.expenseType,
      categoryHint: category?.expenseTypeHint ?? null,
    }),
  );
  const lastHintRef = useRef<ExpenseType | null>(category?.expenseTypeHint ?? null);
  useEffect(() => {
    const hint = category?.expenseTypeHint ?? null;
    if (hint === lastHintRef.current) return;
    lastHintRef.current = hint;
    setChip((s) => deriveExpenseTypeFromCategory(s, hint));
  }, [category?.expenseTypeHint]);

  const [businessPurpose, setBusinessPurpose] = useState(
    initial?.businessPurpose ?? "",
  );
  const [travelFrom, setTravelFrom] = useState(initial?.travelFrom ?? "");
  const [travelTo, setTravelTo] = useState(initial?.travelTo ?? "");
  const [headcountRaw, setHeadcountRaw] = useState(
    initial?.headcount != null ? String(initial.headcount) : "",
  );
  const [attendees, setAttendees] = useState<
    { name: string; affiliation: AttendeeAffiliation }[]
  >(initial?.attendees ?? []);
  const [budgetId, setBudgetId] = useState<string>(initialBudgetId ?? "");
  const [groupDescription, setGroupDescription] = useState(
    initial?.groupDescription ?? "",
  );

  const expenseType = chip.expenseType;
  const headcount = /^\d+$/.test(headcountRaw.trim())
    ? parseInt(headcountRaw.trim(), 10)
    : undefined;
  const namesMode =
    expenseType === "meal" && headcount != null && headcount >= 1
      ? mealNamesRequired(headcount, namesMaxHeadcount)
      : null;

  // OVERFLOW-PRUNING (founder, 2026-08-13): a bulk add may put MORE names on
  // the form than the names-required threshold — "populate with all the team
  // members, then start ✕-ing people who weren't there." Above the threshold
  // `namesMode` is false (group-description territory), but the rows must
  // STAY rendered so the pruning can happen; hiding them is exactly the
  // roster-vanishes defect FINDING 1 closed. The submittable `value` still
  // only carries attendees once the count is back at/under the threshold —
  // honest both ways.
  const overflowPruning =
    expenseType === "meal" &&
    headcount != null &&
    headcount > namesMaxHeadcount &&
    attendees.some((r) => r.name.trim().length > 0);

  const rows = useMemo(() => {
    if (headcount == null) return [];
    if (namesMode !== true && !overflowPruning) return [];
    return Array.from(
      { length: overflowPruning ? headcount : Math.min(headcount, namesMaxHeadcount) },
      (_, i) => attendees[i] ?? { name: "", affiliation: "team" as const },
    );
  }, [namesMode, overflowPruning, headcount, namesMaxHeadcount, attendees]);

  function setRow(
    index: number,
    patch: Partial<{ name: string; affiliation: AttendeeAffiliation }>,
  ) {
    setAttendees(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  /**
   * See the `removeAttendeeRow` interface doc for the headcount rule.
   *
   * HARDENING (FINDING 4, adversarial review 2026-08-13): both setters use
   * the UPDATER-FUNCTION form, reading the PREVIOUS state fresh rather than
   * the `rows`/`headcount` this render closed over. That matters if this
   * fires twice before React re-renders (a double-tap on the ✕ queues two
   * calls in the same batch): the render-time `rows`/`headcount` snapshot
   * would be IDENTICAL for both calls, so both would compute "remove index i
   * from THIS SAME array" and both would try to set headcount to the SAME
   * `render value − 1` — the second call's write would land on top of the
   * first's rather than composing with it, silently losing one removal. The
   * updater form instead lets each call see what the OTHER already did.
   */
  function removeAttendeeRow(index: number) {
    const targetHeadcount = headcount;
    const wasAtHeadcount = targetHeadcount != null && rows.length === targetHeadcount;
    // Same length rule the `rows` memo uses — uncapped while overflow-pruning
    // (every row must stay removable on the way down to the threshold).
    const rowLength =
      targetHeadcount == null
        ? 0
        : overflowPruning
          ? targetHeadcount
          : Math.min(targetHeadcount, namesMaxHeadcount);
    setAttendees((prev) => {
      if (targetHeadcount == null) return prev;
      // Recompute the row shape from `prev` — the same derivation `rows`
      // itself uses — rather than trusting this render's `rows`, which may
      // already be stale if an earlier queued update in this same batch
      // changed `prev` first.
      const currentRows = Array.from(
        { length: rowLength },
        (_, i) => prev[i] ?? { name: "", affiliation: "team" as const },
      );
      return currentRows.filter((_, i) => i !== index);
    });
    if (wasAtHeadcount) {
      setHeadcountRaw((prevRaw) => {
        const parsed = /^\d+$/.test(prevRaw.trim())
          ? parseInt(prevRaw.trim(), 10)
          : NaN;
        return Number.isInteger(parsed) && parsed > 0
          ? String(parsed - 1)
          : prevRaw;
      });
    }
  }

  /**
   * THE PRUNE-DOWN MODEL, both bulk paths (founder, 2026-08-13: "it would
   * populate with all the team members, and then I could go in and start
   * ✕-ing people who weren't there"). One shared body: merge the additions
   * into the FILLED rows via the pure, tested `mergeBulkAttendees`
   * (uncapped at the names threshold — the overflow-pruning state renders
   * every row for ✕-ing; only the absurd `HARD_BULK_ATTENDEE_CAP` drops
   * anything), and grow headcount to the merged total.
   *
   * THE BUG THE FIRST VERSION SHIPPED (founder-reported): with a headcount
   * already typed, the old fill-blank-rows-in-place branch mapped over the
   * raw `attendees` STATE — which is `[]` until someone types, because the
   * blank rows on screen are synthesized in the `rows` memo, not stored. It
   * mapped over nothing, wrote nothing, and separately reported "Added 12 of
   * 18". The merge path has no such branch: it writes the merged roster
   * outright and sets headcount to its true length, so what the notice says
   * and what the screen shows can no longer come apart.
   *
   * Updater-form hardening kept: the merge computes from each call's own
   * `prev` snapshot, so queued calls in one batch compose.
   */
  function bulkMerge(
    additions: { name: string; affiliation: AttendeeAffiliation }[],
  ): BulkAddResult {
    let added = 0;
    let requested = 0;
    let newHeadcountRaw: string | null = null;
    setAttendees((prev) => {
      const result = mergeBulkAttendees(prev, additions);
      requested = result.added + result.capped;
      added = result.added;
      if (result.added === 0) return prev;
      newHeadcountRaw = String(result.merged.length);
      return result.merged;
    });
    if (newHeadcountRaw != null) {
      const raw = newHeadcountRaw;
      setHeadcountRaw(() => raw);
    }
    return { added, requested };
  }

  function startWithTeam(team: { name: string }[]): BulkAddResult {
    return bulkMerge(
      team.map((p) => ({ name: p.name, affiliation: "team" as const })),
    );
  }

  function appendAttendees(
    parsed: { name: string; affiliation: AttendeeAffiliation }[],
  ): BulkAddResult {
    return bulkMerge(parsed);
  }

  const value: CodingFormValue | null =
    expenseType == null
      ? null
      : {
          expenseType,
          businessPurpose,
          // Lodging asks ONE place (persisted in `travelTo`) — `travelFrom`
          // is travel-only from here on (Finding 2).
          ...(expenseType === "travel" ? { travelFrom } : {}),
          ...(expenseType === "travel" || expenseType === "lodging"
            ? { travelTo }
            : {}),
          ...(expenseType === "meal" && headcount != null ? { headcount } : {}),
          ...(namesMode === true
            ? { attendees: rows.filter((r) => r.name.trim().length > 0) }
            : {}),
          ...(namesMode === false && groupDescription.trim()
            ? { groupDescription }
            : {}),
          ...(budgetId ? { budgetId } : {}),
        };

  const fieldProblems =
    value == null ? [] : codingFieldProblems(value, namesMaxHeadcount);
  // Event-based, seeded true when revising an existing coding (its content
  // was the old content-derived signal's answer there too). A prefill
  // deliberately does NOT set this — see the interface doc.
  const [touched, setTouched] = useState(initial != null);
  const [prefilled, setPrefilled] = useState(false);

  function applyExternalLine(line: {
    expenseType: ExpenseType;
    businessPurpose: string;
    travelFrom?: string | null;
    travelTo?: string | null;
    headcount?: number | null;
    attendees?: { name: string; affiliation: AttendeeAffiliation }[] | null;
    groupDescription?: string | null;
  }) {
    setChip((s) => overrideExpenseType(s, line.expenseType));
    setBusinessPurpose(line.businessPurpose);
    setTravelFrom(line.travelFrom ?? "");
    setTravelTo(line.travelTo ?? "");
    setHeadcountRaw(line.headcount != null ? String(line.headcount) : "");
    setAttendees(line.attendees ?? []);
    setGroupDescription(line.groupDescription ?? "");
    // An explicit tap is the person putting content in — it counts.
    setTouched(true);
  }

  function applyPrefill(plan: ReimbursementPrefillPlan) {
    if (!plan) return;
    if (plan.kind === "purpose") {
      setBusinessPurpose(plan.purpose);
    } else {
      setChip((s) => overrideExpenseType(s, plan.line.expenseType));
      setBusinessPurpose(plan.line.businessPurpose);
      setTravelFrom(plan.line.travelFrom ?? "");
      setTravelTo(plan.line.travelTo ?? "");
      setHeadcountRaw(
        plan.line.headcount != null ? String(plan.line.headcount) : "",
      );
      setAttendees(plan.line.attendees ?? []);
      setGroupDescription(plan.line.groupDescription ?? "");
    }
    setPrefilled(true);
  }

  return {
    expenseType,
    setExpenseType: (t) => setChip((s) => overrideExpenseType(s, t)),
    businessPurpose,
    setBusinessPurpose: (s) => {
      setTouched(true);
      setBusinessPurpose(s);
    },
    travelFrom,
    setTravelFrom: (s) => {
      setTouched(true);
      setTravelFrom(s);
    },
    travelTo,
    setTravelTo: (s) => {
      setTouched(true);
      setTravelTo(s);
    },
    headcountRaw,
    setHeadcountRaw: (s) => {
      setTouched(true);
      setHeadcountRaw(s);
    },
    attendees,
    rows,
    setRow: (index, patch) => {
      setTouched(true);
      setRow(index, patch);
    },
    removeAttendeeRow: (index) => {
      setTouched(true);
      removeAttendeeRow(index);
    },
    startWithTeam: (team) => {
      if (team.length === 0) return { added: 0, requested: 0 };
      setTouched(true);
      return startWithTeam(team);
    },
    appendAttendees: (parsed) => {
      if (parsed.length === 0) return { added: 0, requested: 0 };
      setTouched(true);
      return appendAttendees(parsed);
    },
    overflowPruning,
    namesMaxHeadcount,
    groupDescription,
    setGroupDescription: (s) => {
      setTouched(true);
      setGroupDescription(s);
    },
    budgetId,
    setBudgetId,
    headcount,
    namesMode,
    value,
    fieldProblems,
    touched,
    prefilled,
    applyExternalLine,
    applyPrefill,
  };
}

/** The compact chip row + its hint-aware copy — the picker itself, split out
 *  so a host that wants to place it somewhere specific (e.g. right under a
 *  category Select) can, while `CodingFieldSet` below still renders it inline
 *  by default for the host that doesn't need to. */
export function ExpenseTypeChips({
  form,
  category,
}: {
  form: CodingFormState;
  category?: CodingCategoryContext;
}) {
  const hint = category?.expenseTypeHint;
  const followLine =
    category === undefined
      ? "This only decides which questions you get asked — it isn't a category, and nothing picks it for you."
      : hint
        ? `Proof questions — follows your ${category?.name ?? "category"} category; change it below if that's wrong.`
        : "Proof questions — pick whichever fits; your category doesn't set one, so nothing picks it for you.";

  return (
    <View className="mb-4">
      {/* FINDING 6 (UX audit, 2026-08-12): this used to read "What kind of
          spend?" (the category picker just above) immediately followed by
          "What kind of expense?" (this chip row) — two near-identical
          questions back to back. This one is a QUESTION-SET picker, not a
          category, so it's renamed to say what it actually decides. */}
      <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
        Which proof questions apply?
      </Text>
      <Text className="mb-2 text-2xs text-muted">{followLine}</Text>
      <RadioGroup
        accessibilityLabel="Which proof questions apply?"
        horizontal
        className="flex-row flex-wrap gap-1.5"
      >
        {EXPENSE_TYPES.map((t) => {
          const selected = form.expenseType === t;
          return (
            <Radio
              key={t}
              checked={selected}
              onSelect={() => form.setExpenseType(t)}
              accessibilityLabel={CHIP_LABELS[t]}
              className={`rounded-full border px-3 py-1.5 active:opacity-70 ${
                selected ? "border-accent bg-accent/10" : "border-border bg-sunken"
              }`}
            >
              <Text
                className={`text-xs ${selected ? "font-semibold text-ink" : "text-muted"}`}
              >
                {CHIP_LABELS[t]}
              </Text>
            </Radio>
          );
        })}
      </RadioGroup>
      {form.expenseType != null ? (
        <Text className="mt-1.5 text-2xs text-muted">
          {TYPE_HINTS[form.expenseType]}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * THE FIELD SET — purpose (+ its publish/PII notices + the personal-charge
 * escape slot), the budget picker, and the travel/meal type-driven extras.
 * Renders NOTHING until `form.expenseType` is set (the chip row above is what
 * sets it) — same gate `TransactionCodingModal` always applied.
 */
export function CodingFieldSet({
  form,
  minPurposeLength,
  personalChargeSlot,
  transactionId,
}: {
  form: CodingFormState;
  minPurposeLength: number;
  /** The personal-charge escape hatch, rendered right under the purpose field
   *  — see `TransactionCodingModal`'s original doc on why it lives there.
   *  Omitted by hosts with no such affordance (e.g. a reviewer coding on
   *  someone else's behalf). */
  personalChargeSlot?: ReactNode;
  /** The charge being coded — needed only to fetch `attendeeSuggestions`
   *  (the roster "Start with the team" / name-suggestion chips autofill
   *  from) once the meal-attendee editor renders. Both current hosts
   *  (`TransactionCodingModal`, `FinishChargeSheetBody`) always have this in
   *  scope, so it's required rather than optional — a host with no
   *  transaction to code has nothing to submit a coding for either. */
  transactionId: Id<"transactions">;
}) {
  const { expenseType } = form;
  const budgetOptions = useQuery(api.transactionCodings.budgetOptions, {});
  const budgetItems = useMemo(() => {
    const o = budgetOptions;
    if (!o) return [];
    const chapterRecurring = o.recurring.filter((r) => r.level === "chapter");
    const centralRecurring = o.recurring.filter((r) => r.level === "central");
    return [
      { value: "", label: "Not sure yet" },
      ...(o.events.length
        ? [{ value: "__g_events", label: "Events", header: true }]
        : []),
      ...o.events.map((e) => ({ value: e.budgetId as string, label: e.label })),
      ...(o.projects.length
        ? [{ value: "__g_projects", label: "Projects", header: true }]
        : []),
      ...o.projects.map((p) => ({ value: p.budgetId as string, label: p.label })),
      ...(chapterRecurring.length
        ? [{ value: "__g_op", label: "Operating · Chapter", header: true }]
        : []),
      ...chapterRecurring.map((r) => ({ value: r.budgetId as string, label: r.label })),
      ...(centralRecurring.length
        ? [{ value: "__g_central", label: "Operating · Central", header: true }]
        : []),
      ...centralRecurring.map((r) => ({ value: r.budgetId as string, label: r.label })),
    ];
  }, [budgetOptions]);

  if (expenseType == null) return null;

  return (
    <>
      <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
        What was it for?
      </Text>
      <TextField
        value={form.businessPurpose}
        onChangeText={form.setBusinessPurpose}
        placeholder={
          expenseType === "meal"
            ? "e.g. Meal for volunteers writing and producing the album"
            : 'e.g. Travel to NY to film the Eden event — say what, for which event or project, and why'
        }
        multiline
        numberOfLines={3}
      />
      <View className="mt-1.5 flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2">
        <Icon name="globe" size={13} color={colors.muted} />
        {/* FINDING 7 (UX audit, 2026-08-12): "This sentence publishes" led
            with the consequence before the reason, which lands cold. Lead
            with the why — a public page this connects to — in one short
            sentence, then the consequence. */}
        <Text className="flex-1 text-2xs text-muted">
          <Text className="font-semibold text-ink">
            Public Worship publishes every transaction at
            publicworship.life/finances
          </Text>{" "}
          — this sentence is what that page prints, word for word, so write
          it for a stranger reading it next year. &quot;Travel to NY to film
          the Eden event&quot;, not &quot;bus to NY&quot;. In your own words,
          at least {minPurposeLength} characters.
        </Text>
      </View>

      <View className="mt-1.5 flex-row items-start gap-2">
        <Icon name="user-x" size={12} color={colors.muted} />
        <Text className="flex-1 text-2xs text-muted">
          <Text className="font-semibold text-ink">Keep people out of it.</Text>{" "}
          No names, addresses, phone numbers or anything else that identifies
          someone
          {expenseType === "meal"
            ? " — put who was there in the attendee list below, where names stay internal and only the breakdown (“5 volunteers, 3 community members”) is ever published."
            : expenseType === "travel"
              ? " — the route publishes at city level, so “to LIRR in Rosedale” is fine and “to Michael’s place” is not."
              : expenseType === "lodging"
                ? " — the place publishes at city level, so “Chicago” is fine and “Michael’s place” is not."
                : " — describe the work, not the person."}
        </Text>
      </View>

      {personalChargeSlot}

      {budgetItems.length > 1 ? (
        <View className="mt-4">
          {/* FINDING 9 (UX audit, 2026-08-12): one clause tying the three
              buckets (events, operating, equipment) together before the
              guidance below unpacks them — the picker used to jump straight
              into "which of these three?" with nothing framing it as the
              last step. */}
          <Text className="mb-1.5 text-2xs text-muted">
            Last one — which budget pays for it.
          </Text>
          <Select
            label="Which budget did this come out of?"
            value={form.budgetId || ""}
            options={budgetItems}
            onChange={form.setBudgetId}
            placeholder="Not sure yet"
            searchable
          />
          <View className="mt-1.5 gap-0.5">
            {BUDGET_GUIDANCE.map((line) => (
              <Text key={line} className="text-2xs text-muted">
                {line}
              </Text>
            ))}
            <Text className="text-2xs text-muted">
              Not sure? Leave it — the finance team will set it, and a guess is
              worse than a blank.
            </Text>
          </View>
        </View>
      ) : null}

      {expenseType === "travel" || expenseType === "lodging" ? (
        <View className="mt-4">
          <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
            {expenseType === "lodging"
              ? "Where did you stay?"
              : "Where from, where to?"}
          </Text>
          {expenseType === "lodging" ? (
            // FINDING 2: lodging asks ONE place, not a route — nobody
            // "traveled from" a hotel. Persisted in `travelTo`.
            <TextField
              value={form.travelTo}
              onChangeText={form.setTravelTo}
              placeholder="e.g. Chicago — city is enough"
            />
          ) : (
            <View className="flex-row gap-2">
              <View className="flex-1">
                <TextField
                  value={form.travelFrom}
                  onChangeText={form.setTravelFrom}
                  placeholder="From — e.g. Boston"
                />
              </View>
              <View className="flex-1">
                <TextField
                  value={form.travelTo}
                  onChangeText={form.setTravelTo}
                  placeholder="To — e.g. New York"
                />
              </View>
            </View>
          )}
          <Text className="mt-1 text-2xs text-muted">
            {expenseType === "lodging"
              ? "An overnight stay needs a place — the city is enough. Lodging always needs an itemized receipt, at any amount — a bank line won't do."
              : "The IRS asks travel for a PLACE, not just a trip — where from and where to. City level is enough, and the route publishes at city level too."}
          </Text>
        </View>
      ) : null}

      {expenseType === "meal" ? (
        <View className="mt-4">
          <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
            How many people?
          </Text>
          <TextField
            value={form.headcountRaw}
            onChangeText={form.setHeadcountRaw}
            placeholder="e.g. 4"
            keyboardType="number-pad"
          />
          <Text className="mt-1 text-2xs text-muted">
            Everyone the meal was bought for, including you.
          </Text>
          {/* Rendered in THREE states: names mode (headcount at/under the
              threshold), overflow-pruning (a bulk add pushed past it), and
              NO HEADCOUNT YET — because the founder's flow is often
              roster-first: "Start with the team" or a paste answers "how
              many?" by itself (bulk adds set headcount to the merged
              total), so demanding a number before offering the roster tools
              would put the steps in the wrong order. */}
          {form.namesMode === true || form.overflowPruning || form.headcount == null ? (
            <View className="mt-3">
              <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                Who was there?
              </Text>
              <Text className="mb-2 text-2xs text-muted">
                The IRS requires who attended and their relationship to the
                org — that&apos;s the business-relationship element, and
                it&apos;s the one a receipt can never carry.
              </Text>
              <View className="mb-2 flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2">
                <Icon name="lock" size={13} color={colors.muted} />
                <Text className="flex-1 text-2xs text-muted">
                  <Text className="font-semibold text-ink">
                    Names stay internal, forever.
                  </Text>{" "}
                  The public ledger prints the breakdown only — &quot;3
                  volunteers, 1 guest&quot; — never who they were.
                </Text>
              </View>
              <AttendeeRosterEditor form={form} transactionId={transactionId} />
            </View>
          ) : null}
          {form.namesMode === false ? (
            <View className="mt-3">
              <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                Who was the group?
              </Text>
              <TextField
                value={form.groupDescription}
                onChangeText={form.setGroupDescription}
                placeholder="e.g. Volunteers writing and producing the album"
                multiline
                numberOfLines={2}
              />
              <Text className="mt-1 text-2xs text-muted">
                An identifiable group is enough — no names needed. It has to
                be identifiable, though: an auditor accepts &quot;volunteers
                writing and producing the album&quot; and rejects &quot;some
                people&quot;. This one publishes.
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

/** The affiliation a freshly-appended row without one of its own should
 *  carry — the LAST row with a name, walking backward so the most recently
 *  entered person's affiliation wins (`attendeePaste.ts`'s own `parseAttendeePaste`
 *  applies the same "carries forward" idea within one paste; this is the
 *  form-level seed for it). `undefined` when nothing has a name yet, which
 *  the parser itself falls back to `"team"` for. */
function lastUsedAffiliation(
  rows: readonly { name: string; affiliation: AttendeeAffiliation }[],
): AttendeeAffiliation | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].name.trim().length > 0) return rows[i].affiliation;
  }
  return undefined;
}

/**
 * BULK ATTENDEE ENTRY (founder, 2026-08-12): "entering in names is such a
 * pain… allow me to copy and paste a csv list of people or a line broken
 * list of people with a way to easily delete rows, and even a way to
 * autofill based on the people database… even a way to start the list with
 * the team, and then remove who maybe wasn't there and add who was there."
 * The roster editor for one meal's attendee rows — every affordance this ask
 * named, layered onto the same `form.rows`/`form.setRow` the plain per-row
 * editor always used:
 *  - "Start with the team" — `form.startWithTeam`, from `attendeeSuggestions`.
 *  - a per-row ✕ delete — `form.removeAttendeeRow`.
 *  - "Paste a list" — a reveal-on-demand multiline field that runs
 *    `parseAttendeePaste` and appends via `form.appendAttendees`.
 *  - per-row name suggestion chips as you type — team members not already
 *    listed, prefix-matched, capped at 5.
 *
 * No portal/popover anywhere — a wrap row of small `Pressable` chips, same
 * language the affiliation radios in this file already use.
 *
 * BOTH bulk-add paths are capped at `namesMaxHeadcount`
 * (`form.startWithTeam`/`form.appendAttendees`, via
 * `attendeePaste.ts#capBulkAdditions`) so a big paste or a big team can never
 * push headcount past the threshold and flip the section away out from under
 * itself (FINDING 1, adversarial review 2026-08-13). When the cap bites,
 * `capNotice` says so in plain numbers rather than losing anyone silently.
 */

/** The `BulkAddResult` copy, shared by both bulk-add paths — one sentence
 *  saying exactly how many landed and why the rest didn't. `null` when
 *  nothing was left out — the caller renders no notice at all in that
 *  case. */
function bulkAddCapNotice(result: BulkAddResult): string | null {
  // Only the absurd hard cap drops anyone now (`HARD_BULK_ATTENDEE_CAP`) —
  // an ordinary over-threshold bulk add keeps every row for pruning and is
  // narrated by the persistent overflow banner instead, which derives from
  // live state and so can never disagree with what the rows actually show
  // (the founder-reported failure of the one-shot notice this replaces).
  if (result.added >= result.requested) return null;
  return `Added ${result.added} of ${result.requested} — a named list this long stops being usable. For a crowd that size, set the headcount and describe the group instead.`;
}

function AttendeeRosterEditor({
  form,
  transactionId,
}: {
  form: CodingFormState;
  transactionId: Id<"transactions">;
}) {
  const suggestions = useQuery(api.transactionCodings.attendeeSuggestions, {
    transactionId,
  });
  const team = suggestions ?? [];
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [capNotice, setCapNotice] = useState<string | null>(null);

  const allRowsBlank = form.rows.every((r) => r.name.trim().length === 0);
  const namedCount = form.rows.filter((r) => r.name.trim().length > 0).length;

  return (
    <View className="gap-2">
      {/* THE PRUNE-DOWN BANNER — derived from live state (never a one-shot
          notice, which is how the shipped version managed to say "Added 12"
          over visibly empty rows). Renders exactly while a bulk add has put
          more names on the form than the threshold, and disappears on its
          own the moment ✕-ing brings the count back down. */}
      {form.overflowPruning ? (
        <View className="flex-row items-start gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2">
          <Icon name="users" size={13} color={colors.accent} />
          <Text className="flex-1 text-2xs text-ink">
            <Text className="font-semibold">
              {namedCount} people named — names are only needed up to{" "}
              {form.namesMaxHeadcount}.
            </Text>{" "}
            ✕ whoever wasn&apos;t there and the list submits as names — or
            keep the headcount and describe the group below instead.
          </Text>
        </View>
      ) : null}
      {capNotice ? (
        <View className="flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2">
          <Icon name="alert-triangle" size={13} color={colors.muted} />
          <Text className="flex-1 text-2xs text-muted">{capNotice}</Text>
          <Pressable
            onPress={() => setCapNotice(null)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            className="active:opacity-70"
          >
            <Icon name="x" size={12} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

      {allRowsBlank && team.length > 0 ? (
        <Button
          title={`Start with the team (${team.length})`}
          variant="secondary"
          size="sm"
          icon="users"
          onPress={() => {
            const result = form.startWithTeam(team);
            setCapNotice(bulkAddCapNotice(result));
          }}
        />
      ) : null}

      <View className="gap-2">
        {form.rows.map((row, i) => (
          <View
            key={i}
            className="rounded-lg border border-border bg-sunken px-3 py-2"
          >
            <View className="flex-row items-center gap-2">
              <View className="flex-1">
                <TextField
                  value={row.name}
                  onChangeText={(name) => form.setRow(i, { name })}
                  placeholder={`Person ${i + 1}`}
                />
              </View>
              <Pressable
                onPress={() => form.removeAttendeeRow(i)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${row.name.trim() || `person ${i + 1}`}`}
                className="rounded-full p-1.5 active:opacity-70"
              >
                <Icon name="x" size={14} color={colors.muted} />
              </Pressable>
            </View>
            <NameSuggestionChips
              typed={row.name}
              index={i}
              rows={form.rows}
              team={team}
              onPick={(name) => form.setRow(i, { name })}
            />
            <RadioGroup
              accessibilityLabel={`Affiliation for person ${i + 1}`}
              horizontal
              className="mt-1.5 flex-row flex-wrap gap-1.5"
            >
              {ATTENDEE_AFFILIATIONS.map((a) => {
                const selected = row.affiliation === a;
                return (
                  <Radio
                    key={a}
                    checked={selected}
                    onSelect={() => form.setRow(i, { affiliation: a })}
                    accessibilityLabel={ATTENDEE_AFFILIATION_LABELS[a]}
                    className={`rounded-full border px-2 py-0.5 active:opacity-70 ${
                      selected ? "border-accent bg-accent/10" : "border-border"
                    }`}
                  >
                    <Text
                      className={`text-2xs ${selected ? "font-medium text-ink" : "text-muted"}`}
                    >
                      {ATTENDEE_AFFILIATION_LABELS[a]}
                    </Text>
                  </Radio>
                );
              })}
            </RadioGroup>
          </View>
        ))}
      </View>

      {pasteOpen ? (
        <View className="gap-1.5 rounded-md border border-border bg-sunken px-3 py-2">
          <TextField
            value={pasteText}
            onChangeText={setPasteText}
            placeholder={'One name per line, or "Name, affiliation" per line'}
            multiline
            numberOfLines={4}
          />
          <View className="flex-row gap-2">
            <Button
              title="Add these people"
              size="sm"
              disabled={pasteText.trim().length === 0}
              onPress={() => {
                const parsed = parseAttendeePaste(pasteText, {
                  existingNames: form.rows
                    .map((r) => r.name)
                    .filter((n) => n.trim().length > 0),
                  lastAffiliation: lastUsedAffiliation(form.rows),
                });
                const result = form.appendAttendees(parsed);
                setCapNotice(bulkAddCapNotice(result));
                setPasteText("");
                setPasteOpen(false);
              }}
            />
            <Button
              title="Cancel"
              size="sm"
              variant="secondary"
              onPress={() => {
                setPasteOpen(false);
                setPasteText("");
              }}
            />
          </View>
        </View>
      ) : (
        <Pressable
          onPress={() => setPasteOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Paste a list of people"
          className="flex-row items-center gap-1.5 self-start active:opacity-70"
        >
          <Icon name="clipboard" size={13} color={colors.accent} />
          <Text className="text-2xs font-semibold text-accent">Paste a list</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Suggestion chips beneath one row's name field — team members not already
 *  listed elsewhere on this form, whose name starts with what's typed here
 *  (case-insensitive), capped at 5. TRIGGERED BY TYPING, not focus: the
 *  shared `TextField` claims `onFocus`/`onBlur` itself for its border
 *  styling and would drop that behavior if a caller also passed its own
 *  (React's `{...spread}` ordering means the last one wins) — typing is a
 *  reliable, styling-safe signal that reads the same "as you go" way the ask
 *  wanted. Renders nothing once the row already spells a name out in full
 *  (nothing left to suggest) or once nothing typed yet (nothing to narrow
 *  down from — nobody wants all 40 team members on Day 1). */
function NameSuggestionChips({
  typed,
  index,
  rows,
  team,
  onPick,
}: {
  typed: string;
  index: number;
  rows: readonly { name: string; affiliation: AttendeeAffiliation }[];
  team: readonly { name: string; isTeamMember: boolean }[];
  onPick: (name: string) => void;
}) {
  const needle = typed.trim().toLowerCase();
  if (!needle) return null;

  const alreadyListedElsewhere = new Set(
    rows
      .filter((_, i) => i !== index)
      .map((r) => r.name.trim().toLowerCase())
      .filter((n) => n.length > 0),
  );
  const matches = team
    .filter((p) => {
      const lower = p.name.trim().toLowerCase();
      return (
        lower.startsWith(needle) &&
        lower !== needle &&
        !alreadyListedElsewhere.has(lower)
      );
    })
    .slice(0, 5);
  if (matches.length === 0) return null;

  return (
    <View className="mt-1.5 flex-row flex-wrap gap-1.5">
      {matches.map((p) => (
        <Pressable
          key={p.name}
          onPress={() => onPick(p.name)}
          accessibilityRole="button"
          accessibilityLabel={`Use ${p.name}`}
          className="rounded-full border border-border bg-raised px-2 py-0.5 active:opacity-70"
        >
          <Text className="text-2xs text-muted">{p.name}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Renders the missing-pieces list — the same "Still needed before you can
 *  submit" register both hosts have always used. `extra` prepends host-owned
 *  problems (the modal's documentation requirement) ahead of the shared
 *  field problems, matching the server's own throw order. */
export function CodingProblemsList({
  problems,
}: {
  problems: { code: string; message: string }[];
}) {
  if (problems.length === 0) return null;
  return (
    <View className="mt-4 gap-1.5 rounded-md border border-border bg-sunken px-3 py-2">
      <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
        Still needed before you can submit
      </Text>
      {problems.map((p) => (
        <View key={p.code} className="flex-row items-start gap-2">
          <Icon name="info" size={13} color={colors.muted} />
          <Text className="flex-1 text-2xs text-muted">{p.message}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * "This wasn't Public Worship's" — offered beneath the business purpose,
 * because that is where people say it when they have nowhere else to. Shared
 * by `TransactionCodingModal` and `FinishChargeSheetBody`'s inline flow so
 * the one-way flag reads and behaves identically from either surface.
 *
 * Two-step on purpose. Flagging is ONE-WAY (it creates the repayment record
 * and emails the payee), so it asks once before doing it, and it says what
 * happens next, because "I'll pay it back" is a commitment, not a checkbox.
 */
export function PersonalChargeEscape({
  alreadyFlagged,
  onFlag,
}: {
  alreadyFlagged: boolean;
  onFlag: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (alreadyFlagged) {
    return (
      <View className="mt-2 flex-row items-center gap-2">
        <Icon name="check-circle" size={13} color={colors.accent} />
        <Text className="flex-1 text-2xs text-muted">
          Flagged as a personal charge — it needs no coding. Pay it back from
          the Cards tab.
        </Text>
      </View>
    );
  }

  if (!confirming) {
    return (
      <View className="mt-2 flex-row flex-wrap items-baseline gap-x-1.5">
        <Text className="text-2xs text-muted">
          Wasn&apos;t this Public Worship&apos;s money?
        </Text>
        <Pressable
          onPress={() => setConfirming(true)}
          accessibilityRole="button"
          accessibilityLabel="This was a personal charge — I'll pay it back"
          className="active:opacity-70"
        >
          <Text className="text-2xs font-semibold text-accent underline">
            It was personal — I&apos;ll pay it back
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="mt-2 gap-2 rounded-md border border-border bg-sunken px-3 py-2.5">
      <Text className="text-2xs text-ink">
        <Text className="font-semibold">Flag this as a personal charge?</Text>{" "}
        It stops owing a coding, it stops counting as Public Worship&apos;s
        spending, and it moves to what you owe back — payable from the Cards
        tab. Don&apos;t explain a personal charge in the business purpose
        instead: that sentence publishes, and the charge would still be
        counted as ours.
      </Text>
      <View className="flex-row gap-2">
        <Button
          title="Yes, it was personal"
          size="sm"
          loading={busy}
          onPress={() => {
            setBusy(true);
            void (async () => {
              try {
                await onFlag();
              } finally {
                setBusy(false);
              }
            })();
          }}
        />
        <Button
          title="No, keep coding it"
          size="sm"
          variant="secondary"
          onPress={() => setConfirming(false)}
        />
      </View>
    </View>
  );
}
