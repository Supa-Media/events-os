/**
 * FINANCES · REIMBURSEMENTS · Per-line substantiation — the §274(d) questions
 * a reimbursement line has to answer, shared by the two in-app surfaces that
 * ask them: the submission form (`RequestForm.tsx`, one block per new line)
 * and the revision form (`ReviseForm.tsx`, one block per line a reviewer sent
 * back). The public token page renders the same questions in vanilla JS
 * (`apps/convex/lib/reimbursePage.ts`), and all three validate through the
 * SHARED `codingFieldProblems` — so no surface can hold a claimant to a
 * different standard than another, or than the server.
 *
 * ONE QUESTION AT A TIME, driven by the expense type: pick "meal" and you get
 * the meal questions, "travel" and you get a route. Nobody sees a blank
 * 20-field form. Attendee rows are RENDERED FROM THE HEADCOUNT (and only
 * at/below the org's names threshold), so "4 people means 4 names" is
 * structural rather than an error someone has to read and act on.
 *
 * NOTHING IS PRE-FILLED and nothing is AI-drafted (owner decision,
 * 2026-08-08): the substantiation is the spender's own testimony, which is
 * exactly what an accountable plan — and a public ledger — needs it to be.
 */
import { View, Text } from "react-native";
import {
  ATTENDEE_AFFILIATIONS,
  ATTENDEE_AFFILIATION_LABELS,
  EXPENSE_TYPES,
  EXPENSE_TYPE_LABELS,
  codingFieldProblems,
  type AttendeeAffiliation,
  type CodingProblem,
  type ExpenseType,
} from "@events-os/shared";
import { Select, TextField } from "../../ui";

/** One line's substantiation as the form holds it — headcount stays a raw
 *  string so a half-typed number isn't read as 0. */
export type LineCoding = {
  expenseType: ExpenseType;
  businessPurpose: string;
  travelFrom: string;
  travelTo: string;
  headcountText: string;
  attendees: { name: string; affiliation: AttendeeAffiliation }[];
  groupDescription: string;
};

export function emptyCoding(): LineCoding {
  return {
    expenseType: "general",
    businessPurpose: "",
    travelFrom: "",
    travelTo: "",
    headcountText: "",
    attendees: [],
    groupDescription: "",
  };
}

/** Rebuild the form state from a line already on record (the revise path). */
export function codingFromLine(line: {
  expenseType?: string | null;
  businessPurpose?: string | null;
  travelFrom?: string | null;
  travelTo?: string | null;
  headcount?: number | null;
  attendees?: { name: string; affiliation: string }[] | null;
  groupDescription?: string | null;
}): LineCoding {
  return {
    expenseType: (line.expenseType as ExpenseType | null) ?? "general",
    businessPurpose: line.businessPurpose ?? "",
    travelFrom: line.travelFrom ?? "",
    travelTo: line.travelTo ?? "",
    headcountText: line.headcount != null ? String(line.headcount) : "",
    attendees: (line.attendees ?? []).map((a) => ({
      name: a.name,
      affiliation: a.affiliation as AttendeeAffiliation,
    })),
    groupDescription: line.groupDescription ?? "",
  };
}

function headcountOf(coding: LineCoding): number | undefined {
  const n = Number(coding.headcountText);
  return coding.headcountText.trim() && Number.isFinite(n) ? n : undefined;
}

/** The exact argument shape the submit/resubmit mutations take — irrelevant
 *  fields dropped, so a line retyped from "travel" to "general" doesn't carry
 *  a stale route (the server drops them too; this just keeps the wire honest). */
export function codingArgs(coding: LineCoding) {
  const isTravelish =
    coding.expenseType === "travel" || coding.expenseType === "lodging";
  const isMeal = coding.expenseType === "meal";
  const headcount = headcountOf(coding);
  return {
    expenseType: coding.expenseType,
    businessPurpose: coding.businessPurpose.trim(),
    travelFrom: isTravelish ? coding.travelFrom.trim() : undefined,
    travelTo: isTravelish ? coding.travelTo.trim() : undefined,
    headcount: isMeal ? headcount : undefined,
    attendees:
      isMeal && coding.attendees.length > 0
        ? coding.attendees.map((a) => ({
            name: a.name.trim(),
            affiliation: a.affiliation,
          }))
        : undefined,
    groupDescription: isMeal
      ? coding.groupDescription.trim() || undefined
      : undefined,
  };
}

/** Every problem with this line's substantiation, in display order — the
 *  SHARED rules, the same list the server throws its first entry of. */
export function codingProblems(
  coding: LineCoding,
  namesMaxHeadcount: number,
): CodingProblem[] {
  const args = codingArgs(coding);
  return codingFieldProblems(
    {
      expenseType: args.expenseType,
      businessPurpose: args.businessPurpose,
      travelFrom: args.travelFrom,
      travelTo: args.travelTo,
      headcount: args.headcount,
      attendees: args.attendees,
      groupDescription: args.groupDescription,
    },
    namesMaxHeadcount,
  );
}

const EXPENSE_TYPE_OPTIONS = EXPENSE_TYPES.map((t) => ({
  value: t,
  label: EXPENSE_TYPE_LABELS[t],
}));

const AFFILIATION_OPTIONS = ATTENDEE_AFFILIATIONS.map((a) => ({
  value: a,
  label: ATTENDEE_AFFILIATION_LABELS[a],
}));

export function CodingFields({
  value,
  namesMaxHeadcount,
  minPurposeLength,
  onChange,
}: {
  value: LineCoding;
  namesMaxHeadcount: number;
  minPurposeLength: number;
  onChange: (patch: Partial<LineCoding>) => void;
}) {
  const isTravelish =
    value.expenseType === "travel" || value.expenseType === "lodging";
  const isMeal = value.expenseType === "meal";
  const headcount = headcountOf(value);
  // Names at/below the threshold, an identifiable group description above it
  // (owner decision, 2026-08-08: a HEADCOUNT threshold, not a dollar one — a
  // $40 pizza for 16 volunteers gets a headcount, a $400 dinner for 4 gets
  // four names).
  const namesMode =
    headcount != null &&
    Number.isInteger(headcount) &&
    headcount >= 1 &&
    headcount <= namesMaxHeadcount;

  /** Resize the attendee list to the headcount, carrying across whatever was
   *  already typed — raising the count must never wipe the names. */
  function setHeadcount(text: string) {
    const n = Number(text);
    const rows =
      text.trim() && Number.isInteger(n) && n >= 1 && n <= namesMaxHeadcount
        ? Array.from({ length: n }, (_, i) => ({
            name: value.attendees[i]?.name ?? "",
            affiliation: value.attendees[i]?.affiliation ?? "team",
          }))
        : [];
    onChange({ headcountText: text, attendees: rows });
  }

  function setAttendee(
    index: number,
    patch: Partial<{ name: string; affiliation: AttendeeAffiliation }>,
  ) {
    onChange({
      attendees: value.attendees.map((a, i) =>
        i === index ? { ...a, ...patch } : a,
      ),
    });
  }

  return (
    <View className="mt-2 border-t border-border pt-2">
      <Select
        label="What kind of expense?"
        hint="This decides what the IRS requires us to record — a route for travel, who was there for a meal."
        value={value.expenseType}
        options={EXPENSE_TYPE_OPTIONS}
        onChange={(v) => onChange({ expenseType: v as ExpenseType })}
      />

      <TextField
        label="Business purpose"
        hint={`At least ${minPurposeLength} characters — "Travel to NY to film the Eden event", not "bus to NY". This sentence appears on Public Worship's public ledger.`}
        value={value.businessPurpose}
        onChangeText={(v) => onChange({ businessPurpose: v })}
        placeholder="What was it, for which event or project, and why?"
        multiline
        numberOfLines={2}
      />

      {isTravelish ? (
        <View className="flex-row gap-3">
          <View className="flex-1">
            <TextField
              label="Traveled from"
              value={value.travelFrom}
              onChangeText={(v) => onChange({ travelFrom: v })}
              placeholder="City you left from"
            />
          </View>
          <View className="flex-1">
            <TextField
              label="Traveled to"
              hint="City level is enough."
              value={value.travelTo}
              onChangeText={(v) => onChange({ travelTo: v })}
              placeholder="City you traveled to"
            />
          </View>
        </View>
      ) : null}

      {isMeal ? (
        <>
          <TextField
            label="How many people ate?"
            value={value.headcountText}
            onChangeText={setHeadcount}
            keyboardType="number-pad"
            placeholder="e.g. 4"
          />
          {namesMode ? (
            <View>
              <Text className="mb-1 text-2xs text-faint">
                The IRS requires who was there and how they relate to the
                organization. Names stay internal — only the breakdown ("3
                volunteers, 1 contractor") is ever published.
              </Text>
              {value.attendees.map((attendee, i) => (
                <View key={i} className="mb-2 flex-row items-end gap-2">
                  <View className="flex-1">
                    <TextField
                      label={i === 0 ? "Who was there?" : undefined}
                      value={attendee.name}
                      onChangeText={(v) => setAttendee(i, { name: v })}
                      placeholder={`Name of person ${i + 1}`}
                    />
                  </View>
                  <View className="w-44">
                    <Select
                      label={i === 0 ? "Relationship" : undefined}
                      value={attendee.affiliation}
                      options={AFFILIATION_OPTIONS}
                      onChange={(v) =>
                        setAttendee(i, {
                          affiliation: (v || "team") as AttendeeAffiliation,
                        })
                      }
                    />
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <TextField
              label="Describe the group"
              hint={`Over ${namesMaxHeadcount} people, describe the group instead of listing everyone — it has to be identifiable ("volunteers writing and producing the album", not "some people").`}
              value={value.groupDescription}
              onChangeText={(v) => onChange({ groupDescription: v })}
              placeholder="e.g. volunteers writing and producing the album"
              multiline
              numberOfLines={2}
            />
          )}
        </>
      ) : null}
    </View>
  );
}
