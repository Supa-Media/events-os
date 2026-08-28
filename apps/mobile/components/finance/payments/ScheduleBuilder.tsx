/**
 * FINANCES · PAYMENTS · The payment schedule, as an editable list.
 *
 * "Half now, half on delivery" — the composer half of contractor payment
 * schedules. The reader half is `ScheduleCard`, and the two deliberately do not
 * share a component: writing a plan and watching one pay out are different jobs
 * that happen to describe the same rows.
 *
 * VALIDATION IS THE SHARED RULE, NOT A LOCAL ONE. `contractorScheduleProblems`
 * from `@events-os/shared` is the same function `contractorInstallments.ts`
 * throws on, so the remainder counter below and the server's refusal can never
 * disagree about whether a plan adds up. That matters more here than on most
 * forms: the failure it prevents is a schedule that looks finished on screen
 * and under-pays somebody by the amount nobody noticed was missing.
 *
 * THE RUNNING REMAINDER IS THE WHOLE UI. Everything else is fields. A person
 * splitting $4,000 into a deposit and a balance should never have to do the
 * subtraction themselves, and the moment they do, they get it wrong on the
 * agreement rather than in a form that could have told them.
 */
import { Pressable, Text, View } from "react-native";
import {
  CONTRACTOR_INSTALLMENT_TRIGGERS,
  CONTRACTOR_INSTALLMENT_TRIGGER_LABELS,
  MAX_CONTRACTOR_INSTALLMENTS,
  contractorScheduleProblems,
  formatCents,
  type ContractorInstallmentDraft,
  type ContractorInstallmentTrigger,
} from "@events-os/shared";
import { Button, Field, Icon, Select, TextField } from "../../ui";
import { Calendar } from "../../ui/Calendar";
import { Popover } from "../../ui/Popover";
import { useAnchor } from "../../ui/useAnchor";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { parseDollars } from "../../event/ticketing/helpers";

/** One row while it is being typed. `amountText` stays a string for the same
 *  reason every money field in this app does — a half-typed "12." is not a
 *  number, and coercing it on each keystroke fights the person typing. */
export type InstallmentDraft = {
  label: string;
  amountText: string;
  trigger: ContractorInstallmentTrigger;
  dueDate?: number;
  milestoneNote: string;
};

export function emptyInstallment(
  trigger: ContractorInstallmentTrigger = "on_milestone",
): InstallmentDraft {
  return { label: "", amountText: "", trigger, milestoneNote: "" };
}

/**
 * The two-row schedule the founder described, pre-filled from the agreed total.
 *
 * Offered as the STARTING POINT rather than as a template picker because it is
 * overwhelmingly the shape people mean: a deposit and a balance. The odd cent
 * of an odd total goes to the FIRST payment, so the balance is the round number
 * — the one somebody is more likely to be checking against an invoice.
 */
export function halfNowHalfOnDelivery(
  agreedAmountCents: number,
): InstallmentDraft[] {
  const half = Math.floor(agreedAmountCents / 2);
  const first = agreedAmountCents - half;
  return [
    {
      label: "Deposit",
      amountText: (first / 100).toFixed(2),
      trigger: "on_signing",
      milestoneNote: "",
    },
    {
      label: "On delivery",
      amountText: (half / 100).toFixed(2),
      trigger: "on_milestone",
      milestoneNote: "the work is delivered",
    },
  ];
}

/** Drafts → the shape the mutation takes. `NaN` for an unparseable amount is
 *  deliberate: it fails the shared rule loudly rather than silently becoming a
 *  zero-dollar payment. */
export function toInstallmentArgs(
  rows: readonly InstallmentDraft[],
): ContractorInstallmentDraft[] {
  return rows.map((r) => ({
    label: r.label.trim(),
    amountCents: parseDollars(r.amountText) ?? NaN,
    trigger: r.trigger,
    ...(r.trigger === "on_date" && r.dueDate != null
      ? { dueDate: r.dueDate }
      : {}),
    ...(r.trigger === "on_milestone" && r.milestoneNote.trim()
      ? { milestoneNote: r.milestoneNote.trim() }
      : {}),
  }));
}

/** The first problem with this schedule, or null. The SHARED rule — see the
 *  module header for why this must not be re-implemented locally. */
export function scheduleProblem(
  rows: readonly InstallmentDraft[],
  agreedAmountCents: number | null,
): string | null {
  if (rows.length === 0) return null;
  if (agreedAmountCents == null) {
    return "Set the agreed amount first — the payments have to add up to it.";
  }
  const problems = contractorScheduleProblems(
    toInstallmentArgs(rows),
    agreedAmountCents,
  );
  return problems[0] ?? null;
}

export function ScheduleBuilder({
  rows,
  onChange,
  agreedAmountCents,
  disabled,
}: {
  rows: InstallmentDraft[];
  onChange: (next: InstallmentDraft[]) => void;
  /** The agreed total the schedule must sum to. `null` while the amount field
   *  is empty or unparseable — the builder still renders, but says so. */
  agreedAmountCents: number | null;
  /** True once part of the schedule has been paid: the plan behind money that
   *  already moved is not re-cuttable (`setSchedule` refuses it too). */
  disabled?: boolean;
}) {
  const scheduled = rows.reduce(
    (sum, r) => sum + (parseDollars(r.amountText) ?? 0),
    0,
  );
  const remaining =
    agreedAmountCents == null ? null : agreedAmountCents - scheduled;

  function patch(i: number, p: Partial<InstallmentDraft>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  }

  if (rows.length === 0) {
    return (
      <View className="mb-4 rounded-lg border border-border bg-sunken px-4 py-3.5">
        <Text className="text-sm font-semibold text-ink">
          Paid in one payment
        </Text>
        <Text className="mt-1 text-xs text-muted">
          The whole agreed amount goes out once, after a treasurer approves it.
          Split it up if you&apos;ve agreed a deposit, dated payments, or
          payment on delivery.
        </Text>
        {!disabled ? (
          <View className="mt-3 flex-row flex-wrap gap-2">
            <Button
              title="Half now, half on delivery"
              variant="secondary"
              size="sm"
              icon="git-branch"
              disabled={agreedAmountCents == null}
              onPress={() =>
                onChange(halfNowHalfOnDelivery(agreedAmountCents ?? 0))
              }
            />
            <Button
              title="Add a payment"
              variant="ghost"
              size="sm"
              icon="plus"
              onPress={() => onChange([emptyInstallment("on_signing")])}
            />
          </View>
        ) : null}
        {agreedAmountCents == null && !disabled ? (
          <Text className="mt-2 text-xs text-faint">
            Set the agreed amount first.
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View className="mb-4">
      {/* The running remainder — see the module header. */}
      <View className="mb-3 flex-row flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-sunken px-3 py-2.5">
        <Text className="text-xs text-muted">
          {rows.length} payment{rows.length === 1 ? "" : "s"} ·{" "}
          {formatCents(scheduled)} of{" "}
          {agreedAmountCents == null ? "—" : formatCents(agreedAmountCents)}{" "}
          scheduled
        </Text>
        {remaining != null && remaining !== 0 ? (
          <Text className="text-xs font-semibold text-warn">
            {remaining > 0
              ? `${formatCents(remaining)} left to schedule`
              : `${formatCents(-remaining)} over`}
          </Text>
        ) : remaining === 0 ? (
          <View className="flex-row items-center gap-1">
            <Icon name="check" size={12} color={colors.success} />
            <Text className="text-xs font-semibold text-success">Adds up</Text>
          </View>
        ) : null}
      </View>

      {rows.map((row, i) => (
        <InstallmentRow
          key={i}
          index={i}
          row={row}
          disabled={disabled}
          onPatch={(p) => patch(i, p)}
          onRemove={() => onChange(rows.filter((_, idx) => idx !== i))}
        />
      ))}

      {!disabled ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            title="Add a payment"
            variant="ghost"
            size="sm"
            icon="plus"
            disabled={rows.length >= MAX_CONTRACTOR_INSTALLMENTS}
            onPress={() => onChange([...rows, emptyInstallment()])}
          />
          <Button
            title="Back to one payment"
            variant="ghost"
            size="sm"
            icon="slash"
            onPress={() => onChange([])}
          />
        </View>
      ) : null}
    </View>
  );
}

function InstallmentRow({
  index,
  row,
  disabled,
  onPatch,
  onRemove,
}: {
  index: number;
  row: InstallmentDraft;
  disabled?: boolean;
  onPatch: (p: Partial<InstallmentDraft>) => void;
  onRemove: () => void;
}) {
  const dateAnchor = useAnchor();

  return (
    <View className="mb-2.5 rounded-lg border border-border bg-raised px-3 py-3">
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="text-xs font-semibold uppercase tracking-wide text-faint">
          Payment {index + 1}
        </Text>
        {!disabled ? (
          <Pressable
            onPress={onRemove}
            accessibilityRole="button"
            accessibilityLabel={`Remove payment ${index + 1}`}
            className="p-1"
          >
            <Icon name="x" size={14} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>

      <View className="flex-row flex-wrap gap-2">
        <View className="min-w-[160px] flex-1">
          <TextField
            label="What it's for"
            value={row.label}
            onChangeText={(label) => onPatch({ label })}
            placeholder="Deposit"
            editable={!disabled}
          />
        </View>
        <View className="min-w-[110px]">
          <TextField
            label="Amount"
            value={row.amountText}
            onChangeText={(amountText) => onPatch({ amountText })}
            placeholder="$0.00"
            inputMode="decimal"
            editable={!disabled}
          />
        </View>
      </View>

      {disabled ? (
        <Field label="When">
          <Text className="text-sm text-muted">
            {CONTRACTOR_INSTALLMENT_TRIGGER_LABELS[row.trigger]}
          </Text>
        </Field>
      ) : (
        <Select
          label="When"
          value={row.trigger}
          onChange={(t) =>
            onPatch({ trigger: t as ContractorInstallmentTrigger })
          }
          options={CONTRACTOR_INSTALLMENT_TRIGGERS.map((t) => ({
            value: t,
            label: CONTRACTOR_INSTALLMENT_TRIGGER_LABELS[t],
          }))}
        />
      )}

      {row.trigger === "on_date" ? (
        <Field label="Date">
          <Pressable
            ref={dateAnchor.ref}
            onPress={disabled ? undefined : dateAnchor.open}
            className="flex-row items-center justify-between rounded-md border border-border bg-input px-3 py-2.5"
          >
            <Text
              className={row.dueDate != null ? "text-sm text-ink" : "text-sm text-faint"}
            >
              {row.dueDate != null ? formatDate(row.dueDate) : "Pick a date"}
            </Text>
            <Icon name="calendar" size={14} color={colors.muted} />
          </Pressable>
          <Popover
            visible={dateAnchor.visible}
            onClose={dateAnchor.close}
            anchor={dateAnchor.anchor}
            width={288}
          >
            <Calendar
              selected={row.dueDate ?? null}
              seed={row.dueDate ?? Date.now()}
              onSelect={(dueDate) => {
                onPatch({ dueDate });
                dateAnchor.close();
              }}
            />
          </Popover>
        </Field>
      ) : null}

      {row.trigger === "on_milestone" ? (
        <TextField
          label="What has to happen"
          value={row.milestoneNote}
          onChangeText={(milestoneNote) => onPatch({ milestoneNote })}
          placeholder="the final mix is delivered"
          editable={!disabled}
          hint="A person decides when this is met — nothing here pays automatically."
        />
      ) : null}
    </View>
  );
}
