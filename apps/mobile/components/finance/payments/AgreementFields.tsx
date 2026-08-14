/**
 * FINANCES · PAYMENTS · The agreement's terms, as an editable fieldset.
 *
 * Shared by the two surfaces that write terms, so they cannot drift:
 *   · `/finances/payments/new` — composing a pre-filled agreement
 *     (`createAgreement`), the founder's primary flow.
 *   · the detail screen's "Edit terms" panel (`updateTerms`), where changing
 *     an AGREED term after acceptance voids that acceptance.
 *
 * Validation runs the SHARED rules the server throws on — `contractorAmountProblems`
 * and `publicTextProblems` from `@events-os/shared` — so nobody learns about a
 * $0 amount or a phone number in the description from a round-trip. The server
 * still checks; this just means it never has to say no.
 *
 * The "For" picker is one `Select` standing in for three mutually-exclusive
 * optional ids (event / project / budget), decoded back into
 * `eventId`/`projectId`/`budgetId` at submit — the client-side mirror of the
 * backend's own `assertSingleAttribution` rule. Same encoding as the
 * reimbursement request form's picker (`reimbursements/RequestForm.tsx`);
 * deliberately its own copy here because the two decode into different
 * mutations' args (and this one has to be able to say "none" explicitly, which
 * `updateTerms` spells `clearAttribution`).
 */
import { Pressable, Text, View } from "react-native";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  BUDGET_CADENCE_LABELS,
  CONTRACTOR_SERVICE_DESCRIPTION_MAX,
  contractorAmountProblems,
  publicTextProblems,
} from "@events-os/shared";
import { Field, Icon, Select, TextField } from "../../ui";
import { Calendar } from "../../ui/Calendar";
import { Popover } from "../../ui/Popover";
import { useAnchor } from "../../ui/useAnchor";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { parseDollars } from "../../event/ticketing/helpers";
import { centsToAmountText } from "./helpers";

export type NewRequestOptions = FunctionReturnType<
  typeof api.reimbursements.newRequestOptions
>;
export type ForOptions = NewRequestOptions["forOptions"];
export type CategoryOptions = FunctionReturnType<
  typeof api.finances.myChargeCategories
>;

/** The in-progress terms. Money and dates stay in their raw input shapes
 *  (`amountText`, a nullable timestamp) so a half-typed field is never
 *  silently coerced into a number somebody didn't mean. */
export type AgreementDraft = {
  payeeName: string;
  payeeEmail: string;
  payeePhone: string;
  serviceDescription: string;
  /** `null` = not set. Optional on the backend too. */
  serviceDate: number | null;
  amountText: string;
  agreementNotes: string;
  /** `""` | `event:<id>` | `project:<id>` | `budget:<id>`. */
  forValue: string;
  /** `""` = no category. */
  categoryId: string;
};

export function emptyDraft(): AgreementDraft {
  return {
    payeeName: "",
    payeeEmail: "",
    payeePhone: "",
    serviceDescription: "",
    serviceDate: null,
    amountText: "",
    agreementNotes: "",
    forValue: "",
    categoryId: "",
  };
}

/** Seed the editor from a payment that already exists (the detail screen's
 *  "Edit terms"). Coding collapses back into the one `forValue` encoding. */
export function draftFromPayment(payment: {
  payeeName: string;
  payeeEmail?: string;
  payeePhone?: string;
  serviceDescription: string;
  serviceDate?: number;
  agreedAmountCents: number;
  agreementNotes?: string;
  eventId?: Id<"events">;
  projectId?: Id<"projects">;
  budgetId?: Id<"budgets">;
  categoryId?: Id<"budgetCategories">;
}): AgreementDraft {
  return {
    payeeName: payment.payeeName,
    payeeEmail: payment.payeeEmail ?? "",
    payeePhone: payment.payeePhone ?? "",
    serviceDescription: payment.serviceDescription,
    serviceDate: payment.serviceDate ?? null,
    amountText: centsToAmountText(payment.agreedAmountCents),
    agreementNotes: payment.agreementNotes ?? "",
    forValue: payment.eventId
      ? `event:${payment.eventId}`
      : payment.projectId
        ? `project:${payment.projectId}`
        : payment.budgetId
          ? `budget:${payment.budgetId}`
          : "",
    categoryId: payment.categoryId ?? "",
  };
}

/** Dollars typed by a human → integer cents, via the app's ONE parser
 *  (`Math.round(dollars * 100)`). `null` when the field is blank or garbage —
 *  never 0, which would look like a deliberate free engagement. */
export function draftAmountCents(draft: AgreementDraft): number | null {
  return parseDollars(draft.amountText);
}

/** The three mutually-exclusive attribution ids, decoded from `forValue`. */
export function decodeForValue(value: string): {
  eventId?: Id<"events">;
  projectId?: Id<"projects">;
  budgetId?: Id<"budgets">;
} {
  if (value.startsWith("event:")) return { eventId: value.slice(6) as Id<"events"> };
  if (value.startsWith("project:")) {
    return { projectId: value.slice(8) as Id<"projects"> };
  }
  if (value.startsWith("budget:")) {
    return { budgetId: value.slice(7) as Id<"budgets"> };
  }
  return {};
}

/**
 * Everything wrong with the draft, in the order a person would fix it — the
 * first is what the form shows. Runs the shared server rules so the two agree
 * by construction.
 */
export function draftProblems(draft: AgreementDraft): string[] {
  const problems: string[] = [];
  if (draft.payeeName.trim().length < 2) problems.push("Who is being paid?");
  const description = draft.serviceDescription.trim();
  if (description.length < 3) {
    problems.push("Say what the work was — this appears on the public ledger.");
  } else {
    for (const p of publicTextProblems(description)) {
      problems.push(
        `${p} This description is published publicly, so please reword it without personal details.`,
      );
    }
  }
  const cents = draftAmountCents(draft);
  if (cents == null) problems.push("Enter an amount.");
  else problems.push(...contractorAmountProblems(cents));
  return problems;
}

/** Options for the "What's this for?" picker, grouped like the reimbursement
 *  form's. "None" is a real, pickable option — an agreement can legitimately
 *  be composed before anyone knows which budget carries it (approval is where
 *  that stops being acceptable, see `NOT_CODED`). */
export function buildForOptions(options: ForOptions | undefined) {
  const items: { value: string; label: string; header?: boolean }[] = [
    { value: "", label: "None" },
  ];
  if (!options) return items;
  if (options.events.length > 0) {
    items.push({ value: "__grp_events", label: "Events", header: true });
    for (const e of options.events) {
      items.push({ value: `event:${e.id}`, label: e.label });
    }
  }
  if (options.projects.length > 0) {
    items.push({ value: "__grp_projects", label: "Projects", header: true });
    for (const p of options.projects) {
      items.push({ value: `project:${p.id}`, label: p.label });
    }
  }
  if (options.budgets.length > 0) {
    items.push({ value: "__grp_budgets", label: "Budgets", header: true });
    for (const b of options.budgets) {
      items.push({
        value: `budget:${b.id}`,
        label: `${b.label} · ${BUDGET_CADENCE_LABELS[b.cadence]}`,
      });
    }
  }
  return items;
}

export function buildCategoryOptions(categories: CategoryOptions | undefined) {
  return [
    { value: "", label: "No category" },
    ...(categories ?? []).map((c) => ({ value: c.id as string, label: c.name })),
  ];
}

type Props = {
  value: AgreementDraft;
  onChange: (patch: Partial<AgreementDraft>) => void;
  forOptions: ForOptions | undefined;
  categories: CategoryOptions | undefined;
  /** `edit` drops the fields `updateTerms` can't accept (the phone) and warns
   *  about the three AGREED terms that void an acceptance when changed. */
  mode: "create" | "edit";
  /** True when someone has already signed — drives the void warning. */
  accepted?: boolean;
};

export function AgreementFields({
  value,
  onChange,
  forOptions,
  categories,
  mode,
  accepted = false,
}: Props) {
  return (
    <>
      <View className="flex-row flex-wrap gap-3">
        <View className="min-w-[220px] flex-1">
          <TextField
            label="Who are we paying?"
            value={value.payeeName}
            onChangeText={(v) => onChange({ payeeName: v })}
            placeholder="First and last name"
          />
        </View>
        <View className="min-w-[220px] flex-1">
          <TextField
            label="Their email"
            hint="Optional — with one, sending emails them the link too."
            value={value.payeeEmail}
            onChangeText={(v) => onChange({ payeeEmail: v })}
            keyboardType="email-address"
            autoCapitalize="none"
            placeholder="them@example.com"
          />
        </View>
        {mode === "create" ? (
          <View className="min-w-[160px] flex-1">
            <TextField
              label="Their phone"
              hint="Optional."
              value={value.payeePhone}
              onChangeText={(v) => onChange({ payeePhone: v })}
              keyboardType="phone-pad"
              placeholder="(555) 555-5555"
            />
          </View>
        ) : null}
      </View>

      <TextField
        label="What is the work?"
        hint="Published on the public ledger, word for word — see the preview below."
        value={value.serviceDescription}
        onChangeText={(v) =>
          onChange({
            serviceDescription: v.slice(0, CONTRACTOR_SERVICE_DESCRIPTION_MAX),
          })
        }
        placeholder="e.g. Sound engineering for the March worship night"
        multiline
        numberOfLines={3}
      />

      <View className="flex-row flex-wrap gap-3">
        <View className="min-w-[180px] flex-1">
          <TextField
            label="Amount"
            hint="What we're agreeing to pay, in dollars."
            value={value.amountText}
            onChangeText={(v) => onChange({ amountText: v })}
            keyboardType="decimal-pad"
            placeholder="$0.00"
          />
        </View>
        <View className="min-w-[180px] flex-1">
          <Field
            label="Service date"
            hint="Optional — when the work happened (or will)."
          >
            <ServiceDateCell
              value={value.serviceDate}
              onChange={(ms) => onChange({ serviceDate: ms })}
            />
          </Field>
        </View>
      </View>

      {accepted ? (
        <View className="mb-3 flex-row items-start gap-2 rounded-md bg-warn-bg px-3 py-2.5">
          <Icon name="alert-triangle" size={14} color={colors.warn} />
          <Text className="flex-1 text-xs text-warn">
            They&apos;ve already accepted these terms. Changing the work, the
            amount, or the service date will VOID their acceptance and ask them
            to sign again. Changing the coding or your private notes won&apos;t.
          </Text>
        </View>
      ) : null}

      <Select
        label="What's this for?"
        hint="An event, a project, or one of the chapter's recurring budgets. It can't be approved until this is set."
        value={value.forValue}
        options={buildForOptions(forOptions)}
        onChange={(v) => onChange({ forValue: v })}
        placeholder="None"
        searchable
      />

      <Select
        label="Category"
        hint="Optional — the budget category this spend belongs to."
        value={value.categoryId}
        options={buildCategoryOptions(categories)}
        onChange={(v) => onChange({ categoryId: v })}
        placeholder="No category"
      />

      <TextField
        label="Notes for the file"
        hint="Private to the finance team — never shown to the contractor or published."
        value={value.agreementNotes}
        onChangeText={(v) => onChange({ agreementNotes: v })}
        placeholder="Anything the reviewer should know…"
        multiline
        numberOfLines={2}
      />
    </>
  );
}

/** The optional service date — the same Calendar/Popover day-pick idiom the
 *  reimbursement form's `PlannedDateCell` uses, nullable, with an inline
 *  clear so "no date" stays reachable after one is picked. */
function ServiceDateCell({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (ms: number | null) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();

  return (
    <>
      <Pressable
        ref={ref}
        onPress={open}
        className="flex-row items-center gap-1.5 rounded-md border border-border-strong bg-raised px-3 py-2.5 active:opacity-80"
      >
        <Icon name="calendar" size={14} color={colors.muted} />
        <Text
          className={value != null ? "flex-1 text-base text-ink" : "flex-1 text-base text-faint"}
        >
          {value != null ? formatDate(value) : "Pick a date (optional)"}
        </Text>
        {value != null ? (
          <Pressable
            onPress={() => onChange(null)}
            hitSlop={6}
            accessibilityLabel="Clear the service date"
          >
            <Icon name="x" size={14} color={colors.muted} />
          </Pressable>
        ) : null}
      </Pressable>

      <Popover visible={visible} onClose={close} anchor={anchor} width={288}>
        <Calendar
          selected={value}
          seed={value ?? Date.now()}
          onSelect={(dayMs) => {
            onChange(dayMs);
            close();
          }}
        />
      </Popover>
    </>
  );
}
