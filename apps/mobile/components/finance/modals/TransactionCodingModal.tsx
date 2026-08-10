/**
 * TransactionCodingModal — authoring the substantiation record on a charge:
 * what it was, why it served the org's work, and who was involved. See
 * `docs/plans/transaction-coding.md`.
 *
 * NOTHING HERE IS PRE-FILLED (owner decision, 2026-08-08: no AI in coding).
 * The transaction's merchant/amount/date are DISPLAYED as context, and every
 * answer is typed by the human — a pre-filled purpose gets rubber-stamped; a
 * blank field with a good prompt gets answered, and the answer is the
 * author's own testimony, which is what an accountable plan needs.
 *
 * Validation is the shared `codingFieldProblems` — the same list the server
 * throws from — rendered in place, with submit disabled until it's empty. One
 * question at a time: pick "meal" and exactly the meal questions appear
 * (headcount, then one name row per head at/below the org threshold, or a
 * group description above it); travel/lodging ask for the route.
 *
 * THE RECEIPT IS ONE OF THOSE REQUIREMENTS NOW (owner decision, 2026-08-08:
 * "they should just upload the receipt when coding"). `submitCoding` refuses a
 * coding on a charge that can't prove itself (`DOCUMENTATION_REQUIRED`), so
 * the requirement is stated at the TOP of the editor, in the same "Still
 * needed before you can submit" register as every field problem, and the ways
 * out of it live in `documentationSlot` — attach, confirm a suggested receipt,
 * or say there is no receipt — all reachable without closing this editor.
 * Nobody may fill in three fields and only then be told no.
 *
 * Two more things every field owes its author, because this form is the only
 * training most people will ever read (phase 2, `docs/plans/transaction-coding.md`):
 *  - WHY, in one line, at the moment the rule applies — "the IRS requires who
 *    attended and their relationship to the org". The Academy lesson's job is
 *    depth; the form's job is the reminder.
 *  - WHAT PUBLISHES. The business purpose is written for the public and says
 *    so at the field; attendee names are internal forever and only the
 *    breakdown ("3 volunteers, 1 guest") is ever printed. Somebody typing a
 *    sentence into a public record is entitled to know that before they type
 *    it, not after it's published.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import {
  ATTENDEE_AFFILIATIONS,
  ATTENDEE_AFFILIATION_LABELS,
  EXPENSE_TYPES,
  EXPENSE_TYPE_LABELS,
  codingFieldProblems,
  formatCents,
  mealNamesRequired,
  type AttendeeAffiliation,
  type ExpenseType,
} from "@events-os/shared";
import { Button, Icon, Radio, RadioGroup, Select, TextField } from "../../ui";
import { colors } from "../../../lib/theme";

const TYPE_HINTS: Record<ExpenseType, string> = {
  general: "Supplies, equipment, software, fees — anything without special IRS fields.",
  travel: "Fares, gas, parking, tolls — asks where from and where to.",
  meal: "Food or drinks for people — asks who was there.",
  lodging: "Hotels and stays — asks for the route, and always needs an itemized receipt.",
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
 * plain hints beside the choices rather than a wall of policy.
 *
 * *"…things that relate to team meetings and stuff like that, that's operating
 * budgets. But if something's associated with an event, that should go into
 * the event budget. If something's equipment, not really associated with any
 * event but just general equipment, then that can go in our annual equipment
 * and upgrades budget."*
 *
 * Note what this is NOT: it doesn't filter the list, rank it, or pre-select
 * anything. Every budget the charge could legitimately land in is offered
 * (owner: "you should just show them all the budgets"), and per decision 5
 * nothing in coding infers an answer from the merchant or the text — a
 * pre-selection that quietly sticks is the rubber stamp that decision exists
 * to prevent. A hint is fine; a default is not.
 */
const BUDGET_GUIDANCE = [
  "Bought for a specific event? That event's budget.",
  "Team meeting, subscription, or general running cost? Operating.",
  "Equipment that isn't tied to one event? The annual equipment budget.",
];

/** The receipt requirement, worded as one of the missing pieces rather than as
 *  an error — it belongs in the same list as "say what this was for". Its code
 *  is the server's (`submitCoding` throws exactly this one). */
const DOCUMENTATION_PROBLEM = {
  code: "DOCUMENTATION_REQUIRED",
  message:
    "Attach the receipt for this charge — or, if there is no receipt, say why right here. A coding can't be submitted without one; proving it and explaining it are the same act.",
};

/**
 * "This wasn't Public Worship's" — offered beneath the business purpose,
 * because that is where people say it when they have nowhere else to.
 *
 * Two-step on purpose. Flagging is ONE-WAY (it creates the repayment record
 * and emails the payee), so it asks once before doing it — the same care the
 * sheet's own checkbox takes by only ever flagging ON. And it says what
 * happens next, because "I'll pay it back" is a commitment, not a checkbox.
 */
function PersonalChargeEscape({
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

export function TransactionCodingModal({
  merchantLine,
  amountCents,
  namesMaxHeadcount,
  minPurposeLength,
  hasDocumentation,
  documentationSlot,
  initial,
  initialBudgetId,
  reviewNote,
  personalCharge,
  submitLabel = "Submit for review",
  submitting,
  onConfirm,
  onCancel,
}: {
  /** Context line shown at the top — merchant + date, never editable here. */
  merchantLine: string;
  amountCents: number;
  namesMaxHeadcount: number;
  minPurposeLength: number;
  /** `getForTransaction().hasDocumentation` — a receipt, or a filed receipt
   *  exception (pending counts). False disables submit and puts the reason in
   *  the missing-pieces list, because the server would refuse anyway. */
  hasDocumentation: boolean;
  /** How to FIX that without leaving the editor — the host's
   *  `CodingDocumentation` (upload, confirm a suggested receipt, or file "there
   *  is no receipt"). A slot rather than the widget itself so this modal stays
   *  presentational and both hosts keep their own toast/error plumbing. */
  documentationSlot?: ReactNode;
  /** Present when revising after a send-back — the author's own prior words. */
  initial?: CodingFormValue | null;
  /** The budget the charge is already attributed to, if any — so re-opening
   *  the editor shows the current answer instead of an empty picker. */
  initialBudgetId?: string | null;
  /** The reviewer's send-back note, when this is a revision. Shown INSIDE the
   *  editor: "what would make this approvable" is useless one screen away from
   *  the fields it's about. */
  reviewNote?: string | null;
  /**
   * THE ESCAPE HATCH, next to the field people were escaping into.
   *
   * The personal-charge checkbox has always existed — under "Anything else
   * (optional)" on the sheet BEHIND this modal, which this modal covers while
   * the purpose is being typed. So the one moment a person realises "this
   * wasn't Public Worship's money" is the one moment they cannot see it, and
   * what they do instead is type the realisation into the business purpose:
   * *"Charged in error, ride from home to work"* — a personal charge that
   * publishes as org spend with no `isPersonal` flag and no repayment row.
   *
   * This is not a second flag. It calls the same `submitOwnCharge({
   * flagPersonal: true })` the checkbox always did; the only thing that
   * changes is that it is reachable from where the sentence is being written.
   * Nothing infers it — the spec forbids inference here, and rightly: a human
   * declares a charge personal, no heuristic reads their prose and guesses.
   *
   * Omitted by the reviewer-side host: a reviewer can't declare somebody
   * else's charge personal from the coding editor (that's the grid's
   * manager-gated "mark personal" action, which names who owes it).
   */
  personalCharge?: {
    /** Already flagged — show it settled rather than offering it twice. */
    alreadyFlagged: boolean;
    /** Flag it and leave; one-way, so the host confirms and closes. */
    onFlag: () => Promise<unknown>;
  };
  /** "Resubmit for review" when revising — a button that says the same thing
   *  on the first pass and the fourth hides which one you're on. */
  submitLabel?: string;
  submitting?: boolean;
  onConfirm: (value: CodingFormValue) => void;
  onCancel: () => void;
}) {
  const [expenseType, setExpenseType] = useState<ExpenseType | null>(
    initial?.expenseType ?? null,
  );
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

  const headcount = /^\d+$/.test(headcountRaw.trim())
    ? parseInt(headcountRaw.trim(), 10)
    : undefined;
  const namesMode =
    expenseType === "meal" && headcount != null && headcount >= 1
      ? mealNamesRequired(headcount, namesMaxHeadcount)
      : null;

  // One name row per head: the row COUNT comes from the headcount, so
  // "4 people means 4 names" is the form's shape, not an error message.
  const rows = useMemo(() => {
    if (namesMode !== true || headcount == null) return [];
    return Array.from(
      { length: Math.min(headcount, namesMaxHeadcount) },
      (_, i) => attendees[i] ?? { name: "", affiliation: "team" as const },
    );
  }, [namesMode, headcount, namesMaxHeadcount, attendees]);

  // Every budget this charge could land in. Member-visible by design — a
  // cardholder with no finance seat still has to be able to say which budget
  // their own spending came out of.
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
      ...chapterRecurring.map((r) => ({
        value: r.budgetId as string,
        label: r.label,
      })),
      ...(centralRecurring.length
        ? [{ value: "__g_central", label: "Operating · Central", header: true }]
        : []),
      ...centralRecurring.map((r) => ({
        value: r.budgetId as string,
        label: r.label,
      })),
    ];
  }, [budgetOptions]);

  const value: CodingFormValue | null =
    expenseType == null
      ? null
      : {
          expenseType,
          businessPurpose,
          ...(expenseType === "travel" || expenseType === "lodging"
            ? { travelFrom, travelTo }
            : {}),
          ...(expenseType === "meal" && headcount != null
            ? { headcount }
            : {}),
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
  // Show problems only for sections the author has actually reached — a form
  // that opens covered in red before anything was typed teaches people to
  // ignore red.
  const touched =
    businessPurpose.trim().length > 0 ||
    travelFrom.trim().length > 0 ||
    travelTo.trim().length > 0 ||
    headcountRaw.trim().length > 0 ||
    attendees.length > 0 ||
    groupDescription.trim().length > 0;

  // The missing receipt is the ONE problem shown before anything is touched:
  // it isn't a field somebody hasn't reached yet, it's a precondition they
  // need to know about while they still have the receipt in their hand.
  const missingDocumentation = hasDocumentation ? [] : [DOCUMENTATION_PROBLEM];
  const blocking = [...missingDocumentation, ...fieldProblems];
  const shown = [...missingDocumentation, ...(touched ? fieldProblems : [])];

  function setRow(
    index: number,
    patch: Partial<{ name: string; affiliation: AttendeeAffiliation }>,
  ) {
    setAttendees(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <View className="flex-1 pr-3">
              <Text className="font-display text-lg text-ink">
                Code this charge
              </Text>
              <Text className="text-2xs text-muted" numberOfLines={1}>
                {merchantLine} · {formatCents(Math.abs(amountCents))}
              </Text>
            </View>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[460px]">
            <View className="px-5 py-4">
              {reviewNote ? (
                <View className="mb-4 rounded-lg border border-danger/40 bg-danger-bg px-3 py-2.5">
                  <Text className="text-2xs font-semibold uppercase tracking-wide text-danger">
                    What the reviewer asked for
                  </Text>
                  <Text className="mt-0.5 text-sm text-ink">“{reviewNote}”</Text>
                </View>
              ) : null}

              {/* THE RECEIPT, FIRST AND IN HERE. Coding used to be step one
                  and the receipt step two, in that order, on a different
                  screen — which is exactly how somebody ended up typing a
                  complete substantiation record and then being refused. The
                  proof and the words go in together, so the proof is asked for
                  where the words are typed. */}
              {documentationSlot ? (
                <View
                  className={`mb-4 rounded-lg border px-3 py-2.5 ${
                    hasDocumentation
                      ? "border-border bg-sunken"
                      : "border-warn/40 bg-warn-bg"
                  }`}
                >
                  <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                    The receipt that proves it
                  </Text>
                  {documentationSlot}
                </View>
              ) : null}

              <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                What kind of expense?
              </Text>
              <Text className="mb-2 text-2xs text-muted">
                This only decides which questions you get asked — travel and
                meals carry extra elements the IRS names specifically. It
                isn&apos;t a category, and nothing picks it for you.
              </Text>
              <RadioGroup
                accessibilityLabel="What kind of expense?"
                className="mb-4 gap-2"
              >
                {EXPENSE_TYPES.map((t) => {
                  const selected = expenseType === t;
                  return (
                    <Radio
                      key={t}
                      checked={selected}
                      onSelect={() => setExpenseType(t)}
                      accessibilityLabel={EXPENSE_TYPE_LABELS[t]}
                      className={`rounded-lg border px-3 py-2.5 active:opacity-70 ${
                        selected
                          ? "border-accent bg-accent/5"
                          : "border-border bg-sunken"
                      }`}
                    >
                      <Text className="text-sm font-medium text-ink">
                        {EXPENSE_TYPE_LABELS[t]}
                      </Text>
                      <Text className="mt-0.5 text-2xs text-muted">
                        {TYPE_HINTS[t]}
                      </Text>
                    </Radio>
                  );
                })}
              </RadioGroup>

              {expenseType != null ? (
                <>
                  <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                    What was it for?
                  </Text>
                  <TextField
                    value={businessPurpose}
                    onChangeText={setBusinessPurpose}
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
                      <Text className="font-semibold text-ink">
                        This sentence publishes.
                      </Text>{" "}
                      Public Worship is making every transaction public, and
                      what you write here is what the ledger prints, word for
                      word — so write it for a stranger reading it next year.
                      &quot;Travel to NY to film the Eden event&quot;, not
                      &quot;bus to NY&quot;. In your own words, at least{" "}
                      {minPurposeLength} characters.
                    </Text>
                  </View>

                  {/* THE PII LINE, and it is not a duplicate of the one above.
                      "This publishes" tells you the sentence is public; it
                      doesn't tell you what to keep OUT of it, and the gap
                      between those two is where real production text ended up
                      reading "Travel with Michael Reid from all team meeting
                      in Manhattan to LIRR in Rosedale".

                      The hole is specific and worth naming rather than
                      moralising about: structured attendee names are
                      protected forever — they render internal-only and the
                      ledger prints the affiliation breakdown instead — but a
                      name typed into THIS box bypasses all of that. So the
                      copy's job is to point at the safe place to put it,
                      which is a few fields down. No blocking, and nothing
                      scans the text guessing at what looks like a name. */}
                  <View className="mt-1.5 flex-row items-start gap-2">
                    <Icon name="user-x" size={12} color={colors.muted} />
                    <Text className="flex-1 text-2xs text-muted">
                      <Text className="font-semibold text-ink">
                        Keep people out of it.
                      </Text>{" "}
                      No names, addresses, phone numbers or anything else that
                      identifies someone
                      {expenseType === "meal"
                        ? " — put who was there in the attendee list below, where names stay internal and only the breakdown (“5 volunteers, 3 community members”) is ever published."
                        : expenseType === "travel" || expenseType === "lodging"
                          ? " — the route publishes at city level, so “to LIRR in Rosedale” is fine and “to Michael’s place” is not."
                          : " — describe the work, not the person."}
                    </Text>
                  </View>

                  {/* THE ESCAPE HATCH, directly under the field it exists to
                      catch. Somebody about to type "charged in error" into a
                      business purpose is telling us this wasn't org spending;
                      this is the same personal-charge flag that has always
                      lived on the sheet behind this modal, put where that
                      sentence gets written. See the `personalCharge` prop. */}
                  {personalCharge ? (
                    <PersonalChargeEscape {...personalCharge} />
                  ) : null}

                  {/* WHICH BUDGET. Owner, 2026-08-09: "when coding, I hope
                      people can select budgets for things… you should just
                      show them all the budgets." Until this, nobody coding a
                      charge could say — the budget got set later, by somebody
                      who wasn't there.

                      Every attributable budget is offered, unranked and
                      unfiltered, with the mapping as hints beneath. Nothing is
                      pre-selected: per decision 5 no part of coding infers an
                      answer, and a default that quietly sticks is exactly the
                      rubber stamp that rule exists to prevent. "Not sure yet"
                      is a real option — a wrong budget is worse than an
                      unattributed one, and the row stays in Needs budget where
                      a bookkeeper will see it. */}
                  {budgetItems.length > 1 ? (
                    <View className="mt-4">
                      <Select
                        label="Which budget did this come out of?"
                        value={budgetId || ""}
                        options={budgetItems}
                        onChange={setBudgetId}
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
                          Not sure? Leave it — the finance team will set it, and
                          a guess is worse than a blank.
                        </Text>
                      </View>
                    </View>
                  ) : null}
                </>
              ) : null}

              {expenseType === "travel" || expenseType === "lodging" ? (
                <View className="mt-4">
                  <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                    {expenseType === "lodging" ? "Where?" : "Where from, where to?"}
                  </Text>
                  <View className="flex-row gap-2">
                    <View className="flex-1">
                      <TextField
                        value={travelFrom}
                        onChangeText={setTravelFrom}
                        placeholder="From — e.g. Boston"
                      />
                    </View>
                    <View className="flex-1">
                      <TextField
                        value={travelTo}
                        onChangeText={setTravelTo}
                        placeholder="To — e.g. New York"
                      />
                    </View>
                  </View>
                  <Text className="mt-1 text-2xs text-muted">
                    The IRS asks travel for a PLACE, not just a trip — where
                    from and where to. City level is enough, and the route
                    publishes at city level too.
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
                    value={headcountRaw}
                    onChangeText={setHeadcountRaw}
                    placeholder="e.g. 4"
                    keyboardType="number-pad"
                  />
                  <Text className="mt-1 text-2xs text-muted">
                    Everyone the meal was bought for, including you. The number
                    decides what comes next: {namesMaxHeadcount} or fewer and
                    we ask for names, more and a group description is enough.
                  </Text>
                  {namesMode === true ? (
                    <View className="mt-3">
                      <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                        Who was there?
                      </Text>
                      <Text className="mb-2 text-2xs text-muted">
                        The IRS requires who attended and their relationship to
                        the org — that&apos;s the business-relationship
                        element, and it&apos;s the one a receipt can never
                        carry.
                      </Text>
                      <View className="mb-2 flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2">
                        <Icon name="lock" size={13} color={colors.muted} />
                        <Text className="flex-1 text-2xs text-muted">
                          <Text className="font-semibold text-ink">
                            Names stay internal, forever.
                          </Text>{" "}
                          The public ledger prints the breakdown only —
                          &quot;3 volunteers, 1 guest&quot; — never who they
                          were. Some of the people you list didn&apos;t
                          consent to a public financial record, and some are
                          minors.
                        </Text>
                      </View>
                      <View className="gap-2">
                        {rows.map((row, i) => (
                          <View
                            key={i}
                            className="rounded-lg border border-border bg-sunken px-3 py-2"
                          >
                            <TextField
                              value={row.name}
                              onChangeText={(name) => setRow(i, { name })}
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
                                    onSelect={() => setRow(i, { affiliation: a })}
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
                  {namesMode === false ? (
                    <View className="mt-3">
                      <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                        Who was the group?
                      </Text>
                      <TextField
                        value={groupDescription}
                        onChangeText={setGroupDescription}
                        placeholder='e.g. Volunteers writing and producing the album'
                        multiline
                        numberOfLines={2}
                      />
                      <Text className="mt-1 text-2xs text-muted">
                        Over {namesMaxHeadcount} people a headcount and an
                        identifiable group is enough — no names needed. It has
                        to be identifiable, though: an auditor accepts
                        &quot;volunteers writing and producing the album&quot;
                        and rejects &quot;some people&quot;. This one
                        publishes.
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {/* THE MISSING PIECES, in place. Submit stays disabled until
                  this list is empty — the server throws the FIRST of these
                  same problems, so nothing gets rejected here that the form
                  could have said out loud first. */}
              {shown.length > 0 ? (
                <View className="mt-4 gap-1.5 rounded-md border border-border bg-sunken px-3 py-2">
                  <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
                    Still needed before you can submit
                  </Text>
                  {shown.map((p) => (
                    <View key={p.code} className="flex-row items-start gap-2">
                      <Icon name="info" size={13} color={colors.muted} />
                      <Text className="flex-1 text-2xs text-muted">
                        {p.message}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title={submitLabel}
              onPress={() => {
                if (value != null && blocking.length === 0) onConfirm(value);
              }}
              disabled={value == null || blocking.length > 0}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
