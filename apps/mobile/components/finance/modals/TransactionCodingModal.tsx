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
 */
import { useMemo, useState } from "react";
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
import { Button, Icon, TextField } from "../../ui";
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
}

export function TransactionCodingModal({
  merchantLine,
  amountCents,
  namesMaxHeadcount,
  minPurposeLength,
  initial,
  submitting,
  onConfirm,
  onCancel,
}: {
  /** Context line shown at the top — merchant + date, never editable here. */
  merchantLine: string;
  amountCents: number;
  namesMaxHeadcount: number;
  minPurposeLength: number;
  /** Present when revising after a send-back — the author's own prior words. */
  initial?: CodingFormValue | null;
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
        };

  const problems =
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
              <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                What kind of expense?
              </Text>
              <View className="mb-4 gap-2">
                {EXPENSE_TYPES.map((t) => {
                  const selected = expenseType === t;
                  return (
                    <Pressable
                      key={t}
                      onPress={() => setExpenseType(t)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
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
                    </Pressable>
                  );
                })}
              </View>

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
                  <Text className="mt-1 text-2xs text-muted">
                    In your own words, at least {minPurposeLength} characters.
                    This description will appear on Public Worship&apos;s
                    public ledger — &quot;travel to NY to film Eden
                    event&quot;, not &quot;bus to NY&quot;.
                  </Text>
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
                    City level is enough — the IRS travel elements are amount,
                    date, place, and purpose.
                    {expenseType === "lodging"
                      ? " Lodging always needs an itemized receipt, at any amount."
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
                  {namesMode === true ? (
                    <View className="mt-3">
                      <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                        Who was there?
                      </Text>
                      <Text className="mb-2 text-2xs text-muted">
                        The IRS requires who attended and how they relate to
                        the org. Names stay internal — only the breakdown
                        (&quot;3 volunteers, 1 guest&quot;) is ever published.
                      </Text>
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
                            <View className="mt-1.5 flex-row flex-wrap gap-1.5">
                              {ATTENDEE_AFFILIATIONS.map((a) => {
                                const selected = row.affiliation === a;
                                return (
                                  <Pressable
                                    key={a}
                                    onPress={() => setRow(i, { affiliation: a })}
                                    accessibilityRole="radio"
                                    accessibilityState={{ selected }}
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
                                  </Pressable>
                                );
                              })}
                            </View>
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
                        identifiable group is enough — no names needed.
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {touched && problems.length > 0 ? (
                <View className="mt-4 gap-1.5 rounded-md border border-border bg-sunken px-3 py-2">
                  {problems.map((p) => (
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
              title="Submit for review"
              onPress={() => {
                if (value != null && problems.length === 0) onConfirm(value);
              }}
              disabled={value == null || problems.length > 0}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
