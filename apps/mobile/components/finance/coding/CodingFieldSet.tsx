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
 * NOTHING HERE IS PRE-FILLED (owner decision, 2026-08-08: no AI in coding).
 * Every answer is typed by the human — the derivation above decides which
 * QUESTIONS appear, never what fills them in.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
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
  lodging: "An overnight stay — asks for the route, and always needs an itemized receipt.",
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
  groupDescription: string;
  setGroupDescription: (s: string) => void;
  budgetId: string;
  setBudgetId: (s: string) => void;
  headcount: number | undefined;
  namesMode: boolean | null;
  /** `null` while `expenseType` is unset — nothing to submit yet. */
  value: CodingFormValue | null;
  fieldProblems: CodingProblem[];
  /** Has the person touched ANY field yet — gates whether problems show (a
   *  form covered in red before anything was typed teaches people to ignore
   *  red). */
  touched: boolean;
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

  const rows = useMemo(() => {
    if (namesMode !== true || headcount == null) return [];
    return Array.from(
      { length: Math.min(headcount, namesMaxHeadcount) },
      (_, i) => attendees[i] ?? { name: "", affiliation: "team" as const },
    );
  }, [namesMode, headcount, namesMaxHeadcount, attendees]);

  function setRow(
    index: number,
    patch: Partial<{ name: string; affiliation: AttendeeAffiliation }>,
  ) {
    setAttendees(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  const value: CodingFormValue | null =
    expenseType == null
      ? null
      : {
          expenseType,
          businessPurpose,
          ...(expenseType === "travel" || expenseType === "lodging"
            ? { travelFrom, travelTo }
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
  const touched =
    businessPurpose.trim().length > 0 ||
    travelFrom.trim().length > 0 ||
    travelTo.trim().length > 0 ||
    headcountRaw.trim().length > 0 ||
    attendees.length > 0 ||
    groupDescription.trim().length > 0;

  return {
    expenseType,
    setExpenseType: (t) => setChip((s) => overrideExpenseType(s, t)),
    businessPurpose,
    setBusinessPurpose,
    travelFrom,
    setTravelFrom,
    travelTo,
    setTravelTo,
    headcountRaw,
    setHeadcountRaw,
    attendees,
    rows,
    setRow,
    groupDescription,
    setGroupDescription,
    budgetId,
    setBudgetId,
    headcount,
    namesMode,
    value,
    fieldProblems,
    touched,
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
      <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
        What kind of expense?
      </Text>
      <Text className="mb-2 text-2xs text-muted">{followLine}</Text>
      <RadioGroup
        accessibilityLabel="What kind of expense?"
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
}: {
  form: CodingFormState;
  minPurposeLength: number;
  /** The personal-charge escape hatch, rendered right under the purpose field
   *  — see `TransactionCodingModal`'s original doc on why it lives there.
   *  Omitted by hosts with no such affordance (e.g. a reviewer coding on
   *  someone else's behalf). */
  personalChargeSlot?: ReactNode;
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
        <Text className="flex-1 text-2xs text-muted">
          <Text className="font-semibold text-ink">This sentence publishes.</Text>{" "}
          Public Worship is making every transaction public, and what you write
          here is what the ledger prints, word for word — so write it for a
          stranger reading it next year. &quot;Travel to NY to film the Eden
          event&quot;, not &quot;bus to NY&quot;. In your own words, at least{" "}
          {minPurposeLength} characters.
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
            : expenseType === "travel" || expenseType === "lodging"
              ? " — the route publishes at city level, so “to LIRR in Rosedale” is fine and “to Michael’s place” is not."
              : " — describe the work, not the person."}
        </Text>
      </View>

      {personalChargeSlot}

      {budgetItems.length > 1 ? (
        <View className="mt-4">
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
            {expenseType === "lodging" ? "Where?" : "Where from, where to?"}
          </Text>
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
          <Text className="mt-1 text-2xs text-muted">
            The IRS asks travel for a PLACE, not just a trip — where from and
            where to. City level is enough, and the route publishes at city
            level too.
            {expenseType === "lodging"
              ? " Lodging always needs an itemized receipt, at any amount — a bank line won't do."
              : ""}
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
          {form.namesMode === true ? (
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
              <View className="gap-2">
                {form.rows.map((row, i) => (
                  <View
                    key={i}
                    className="rounded-lg border border-border bg-sunken px-3 py-2"
                  >
                    <TextField
                      value={row.name}
                      onChangeText={(name) => form.setRow(i, { name })}
                      placeholder={`Person ${i + 1}`}
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
                              selected
                                ? "border-accent bg-accent/10"
                                : "border-border"
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
