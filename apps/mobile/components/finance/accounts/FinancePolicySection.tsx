/**
 * "Receipt & card policy" — the two org-wide finance levers central finance
 * (Kansi) owns, backed by `api.financeSettings.getFinancePolicy` /
 * `setFinancePolicy` (central ED/FM gated server-side; this whole Accounts
 * screen is already `canViewAccounts` = `isCentralEdOrFm` gated, so the section
 * only ever renders for someone allowed to set it):
 *
 *  1. **No-receipt deadline** — after N days a card charge still missing its
 *     receipt auto-converts to a personal repayment (the cardholder owes it
 *     back). OFF by default; nothing converts until a number is set here. The
 *     daily `cards.autoConvertOverdueReceipts` sweep enforces it.
 *  2. **Card prerequisite course** — the Academy course a member must complete
 *     before a card can be issued/activated. "No prerequisite" by default.
 *
 * Both save immediately (the lock/unlock idiom used elsewhere on this screen —
 * no draft state to lose); the deadline uses an explicit Save because it's a
 * typed number, not a toggle.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { ACADEMY_COURSES, getAcademyCourse } from "@events-os/shared";
import { Button, Select, TextField, ToastView } from "../../ui";
import { useActionRunner } from "../../../lib/useActionToast";

// Keep the picker to the finance track — the card prerequisite is a finance
// competency, and listing all ~30 courses would bury the relevant ones. Any
// finance course (including Kansi's future card-and-receipts course) shows up.
const FINANCE_COURSE_OPTIONS = ACADEMY_COURSES.filter((c) =>
  c.slug.startsWith("finance-"),
).map((c) => ({ value: c.slug, label: c.title }));

const NONE_VALUE = "__none__";

export function FinancePolicySection() {
  const policy = useQuery(api.financeSettings.getFinancePolicy);
  const setPolicy = useMutation(api.financeSettings.setFinancePolicy);
  const { run, toast, dismiss } = useActionRunner();

  const [daysInput, setDaysInput] = useState<string>("");

  const loading = policy === undefined;
  const currentDays = policy?.noReceiptAutoConvertDays ?? null;
  const currentCourse = policy?.cardPrerequisiteCourseSlug ?? null;

  function saveDeadline() {
    const raw = daysInput.trim();
    const days = Number(raw);
    if (!raw || !Number.isInteger(days) || days < 1 || days > 365) {
      void run(
        () =>
          Promise.reject(
            new Error("Enter a whole number of days between 1 and 365."),
          ),
        { errorTitle: "Invalid deadline" },
      );
      return;
    }
    void run(() => setPolicy({ noReceiptAutoConvertDays: days }), {
      errorTitle: "Couldn't set the deadline",
      onSuccess: () => setDaysInput(""),
    });
  }

  function clearDeadline() {
    void run(() => setPolicy({ noReceiptAutoConvertDays: null }), {
      errorTitle: "Couldn't turn off auto-conversion",
    });
  }

  function chooseCourse(value: string) {
    const slug = value === NONE_VALUE ? null : value;
    void run(() => setPolicy({ cardPrerequisiteCourseSlug: slug }), {
      errorTitle: "Couldn't set the prerequisite",
    });
  }

  // A configured course that no longer exists in the catalog can't be
  // completed, so the gate treats it as OFF (fail-open) — warn here so the
  // misconfiguration is visible rather than silently ungating every card.
  const configuredCourseMissing =
    currentCourse != null && getAcademyCourse(currentCourse) == null;

  return (
    <View>
      <Text className="mb-4 text-sm text-muted">
        Org-wide rules for card receipts and who may hold a card.
      </Text>

      {/* ── No-receipt deadline ─────────────────────────────────────────── */}
      <View className="mb-6">
        <Text className="mb-1 font-display text-base text-ink">
          No-receipt deadline
        </Text>
        <Text className="mb-3 text-sm text-muted">
          {currentDays == null
            ? "Off — charges never auto-convert. Set a number of days and a charge still missing its receipt past that point becomes a personal repayment the cardholder owes back."
            : `On — a card charge still missing its receipt after ${currentDays} day${currentDays === 1 ? "" : "s"} auto-converts to a personal repayment.`}
        </Text>
        <View className="flex-row items-end gap-2">
          <View className="flex-1">
            <TextField
              label="Days until a charge converts"
              keyboardType="number-pad"
              value={daysInput}
              onChangeText={setDaysInput}
              placeholder={currentDays != null ? String(currentDays) : "e.g. 14"}
              editable={!loading}
              suffix="days"
            />
          </View>
          <Button
            title="Save"
            onPress={saveDeadline}
            disabled={loading || daysInput.trim().length === 0}
          />
        </View>
        {currentDays != null ? (
          <View className="mt-2">
            <Button
              title="Turn off auto-conversion"
              variant="secondary"
              size="sm"
              onPress={clearDeadline}
              disabled={loading}
            />
          </View>
        ) : null}
      </View>

      {/* ── Card prerequisite course ────────────────────────────────────── */}
      <View>
        <Text className="mb-1 font-display text-base text-ink">
          Card prerequisite course
        </Text>
        <Text className="mb-3 text-sm text-muted">
          Members must finish this Academy course before a card can be issued or
          activated. Leave as “No prerequisite” to allow cards with no training
          gate.
        </Text>
        <Select
          label="Required course"
          value={currentCourse ?? NONE_VALUE}
          onChange={chooseCourse}
          options={[
            { value: NONE_VALUE, label: "No prerequisite" },
            ...FINANCE_COURSE_OPTIONS,
          ]}
        />
        {configuredCourseMissing ? (
          <Text className="mt-2 text-sm text-danger">
            The configured course “{currentCourse}” isn’t in the catalog, so the
            gate is inactive. Pick a listed course or remove the prerequisite.
          </Text>
        ) : null}
      </View>

      <ToastView toast={toast} onDismiss={dismiss} />
    </View>
  );
}
