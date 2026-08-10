/**
 * GIVING · Notifications — the standing instructions that say who hears about
 * money coming in, for which book, over what amount, and how often.
 *
 * The shape is `packages.tsx`'s, because it is the same shape: gate → list →
 * INLINE create/edit form (never a modal) → soft deactivate/reactivate. Rules
 * are read/write here and nowhere else.
 *
 * ── THERE IS NO "RECORD A GIFT" BUTTON HERE, DELIBERATELY ───────────────────
 * Gifts arrive through the ledger (`lib/givingDonors.ts#recordGiftForDonor` —
 * the desk's own entry screens, the public `/give` form, ticket add-ons,
 * imports). This screen only ever says who gets TOLD. A "send me a test gift"
 * affordance would write a real row into a real book to prove an email works,
 * and a fake gift in the giving ledger is worse than an unverified rule.
 *
 * ── EDIT AFFORDANCES COME OFF EACH ROW, NOT OFF THE CALLER ──────────────────
 * `listRules` returns rules from every book the caller can SEE, each carrying
 * its own `canManage`. Nothing here is gated on a single screen-level flag;
 * every row asks itself. Since the gate became giving VIEW (2026-08-10 — see
 * `givingNotifications.ts#canManageRuleScope`) a caller who can see a rule can
 * also work it, so `canManage` is true on every row today; the row still asks,
 * because that is what keeps re-narrowing the gate a one-function change.
 *
 * The book picker asks the SAME question, via `ruleScopeChoices` — the list and
 * the picker disagreeing is how this screen once offered Edit on a row while
 * refusing to offer any book to create one in.
 *
 * Deactivation, never deletion: a rule that mailed a team for six months is a
 * record of who was told what. Inactive rules stay listed, and reactivatable.
 */
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { EASTERN_TIME_ZONE } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  OptionTag,
  Screen,
  SectionHeader,
  Select,
  TextField,
} from "../../../components/ui";
import { ToggleRow } from "../../../components/event/ticketing/ToggleRow";
import {
  CADENCE_OPTIONS,
  DEFAULT_SEND_HOUR_LOCAL,
  DEFAULT_SEND_WEEKDAY,
  HOUR_OPTIONS,
  MAX_RULE_RECIPIENTS,
  WEEKDAY_OPTIONS,
  addRecipients,
  buildSaveArgs,
  cadenceLabel,
  centsToDollarsInput,
  deliveryLabel,
  removeRecipient,
  ruleScopeChoices,
  scheduleSummary,
  thresholdLabel,
  type RuleCadence,
  type RuleScope,
  type ScopeChoice,
} from "../../../components/giving/notificationRules";
import { alertError, errorMessage } from "../../../lib/errors";
import { formatDateTimeInZone } from "../../../lib/format";
import { colors } from "../../../lib/theme";
import { useGivingScope } from "../../../lib/useGivingScope";

type Rule = FunctionReturnType<
  typeof api.givingNotifications.listRules
>[number];

function formatSentAt(ts: number): string {
  return formatDateTimeInZone(ts, EASTERN_TIME_ZONE);
}

export default function GivingNotificationsScreen() {
  // The app's chapter lens — same derivation every Giving screen uses.
  const chapterId = useGivingScope();
  const access = useQuery(api.givingPlatform.myGivingAccess, { chapterId });

  if (access === undefined) return <Screen loading />;
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Giving desk access needed"
            message="Notification rules are managed by the people who steward the giving books."
          />
        </Narrow>
      </Screen>
    );
  }
  return <NotificationsBody />;
}

function NotificationsBody() {
  const rules = useQuery(api.givingNotifications.listRules, {});
  // The books the caller may point a rule at. Same source the Gifts and Donors
  // book pickers use — every option in it is a book the caller can VIEW, which
  // is exactly what a rule needs. `ruleScopeChoices` holds the reasoning and
  // the tests.
  const scopeOpts = useQuery(api.givingPlatform.givingScopeOptions, {});
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<Rule["_id"] | null>(null);

  const ruleScopes: ScopeChoice[] = ruleScopeChoices(scopeOpts);
  const canCreate = ruleScopes.length > 0;

  // BOTH queries, deliberately. Rendering on `rules` alone meant the "New rule"
  // button was absent for the first frame and then appeared — and worse, a
  // form opened in that window had an empty book picker.
  if (rules === undefined || scopeOpts === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const active = rules.filter((r) => r.isActive).length;

  return (
    <Screen>
      <Narrow>
        <Text className="mb-3 text-sm font-semibold text-muted">
          Who hears about money coming in
        </Text>

        {canCreate ? (
          <View className="mb-4">
            <Button
              title={showNew ? "Cancel" : "New rule"}
              icon={showNew ? undefined : "plus"}
              variant={showNew ? "secondary" : "primary"}
              onPress={() => {
                setEditingId(null);
                setShowNew((v) => !v);
              }}
            />
            {showNew ? (
              <View className="mt-3">
                <RuleForm
                  scopeOptions={ruleScopes}
                  onDone={() => setShowNew(false)}
                />
              </View>
            ) : null}
          </View>
        ) : null}

        <SectionHeader
          title="Rules"
          count={
            rules.length === 0 ? 0 : `${active} of ${rules.length} sending`
          }
        />
        {rules.length === 0 ? (
          <EmptyState
            icon="bell"
            title="Nobody is being told yet"
            message={
              canCreate
                ? "Add a rule and the people you name will hear when gifts come in — as each one arrives, or as a daily or weekly digest."
                : "No notification rules have been set up for the books you can see."
            }
          />
        ) : (
          <View className="gap-2">
            {rules.map((rule) =>
              editingId === rule._id ? (
                <RuleForm
                  key={rule._id}
                  existing={rule}
                  scopeOptions={ruleScopes}
                  onDone={() => setEditingId(null)}
                />
              ) : (
                <RuleRow
                  key={rule._id}
                  rule={rule}
                  onEdit={() => {
                    setShowNew(false);
                    setEditingId(rule._id);
                  }}
                />
              ),
            )}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}

function RuleRow({ rule, onEdit }: { rule: Rule; onEdit: () => void }) {
  const setRuleActive = useMutation(api.givingNotifications.setRuleActive);

  async function toggle(next: boolean) {
    try {
      await setRuleActive({ ruleId: rule._id, isActive: next });
    } catch (e) {
      // Fire-and-forget switch: a server refusal would otherwise be a silent
      // no-op with the row snapping back for no stated reason.
      alertError(e);
    }
  }

  return (
    <Card padding="md">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-base font-semibold text-ink">
              {rule.name}
            </Text>
            <Badge
              label={cadenceLabel(rule.cadence)}
              tone={rule.cadence === "immediate" ? "accent" : "info"}
            />
            {!rule.isActive ? <Badge label="Paused" tone="warn" /> : null}
          </View>
          <Text className="mt-0.5 text-xs text-muted">
            {rule.scopeLabel} · {thresholdLabel(rule.minAmountCents)} ·{" "}
            {scheduleSummary(rule)}
          </Text>
          <Text className="mt-1.5 text-xs text-ink" numberOfLines={2}>
            To {rule.recipients.join(", ")}
          </Text>
          <Text className="mt-0.5 text-xs text-faint">
            {deliveryLabel(rule, formatSentAt)}
          </Text>
        </View>
        {rule.canManage ? (
          <Button title="Edit" variant="ghost" size="sm" onPress={onEdit} />
        ) : null}
      </View>
      {rule.canManage ? (
        <View className="mt-2 border-t border-border pt-1">
          <ToggleRow
            label={rule.isActive ? "Sending" : "Paused"}
            hint={
              rule.isActive
                ? "Turn it off to stop the emails without losing the rule."
                : "No emails go out. Turning it back on reports from there on, not the backlog it missed."
            }
            value={rule.isActive}
            onToggle={toggle}
          />
        </View>
      ) : null}
    </Card>
  );
}

function RuleForm({
  existing,
  scopeOptions,
  onDone,
}: {
  existing?: Rule;
  scopeOptions: ScopeChoice[];
  onDone: () => void;
}) {
  const saveRule = useMutation(api.givingNotifications.saveRule);

  const [name, setName] = useState(existing?.name ?? "");
  const [recipients, setRecipients] = useState<string[]>(
    existing ? [...existing.recipients] : [],
  );
  const [recipientDraft, setRecipientDraft] = useState("");
  const [cadence, setCadence] = useState<RuleCadence>(
    existing?.cadence ?? "immediate",
  );
  const [minAmount, setMinAmount] = useState(
    centsToDollarsInput(existing?.minAmountCents),
  );
  const [scope, setScope] = useState<RuleScope | null>(
    // An existing rule keeps its own book even when the caller's picker doesn't
    // offer it — `canManage` was true for them to get here, and silently
    // re-pointing a rule at another book on save would be the worst possible
    // reading of an edit.
    existing?.scope ?? (scopeOptions.length === 1 ? (scopeOptions[0].value as RuleScope) : null),
  );
  const [sendHour, setSendHour] = useState(
    String(existing?.sendHourLocal ?? DEFAULT_SEND_HOUR_LOCAL),
  );
  const [sendWeekday, setSendWeekday] = useState(
    String(existing?.sendWeekday ?? DEFAULT_SEND_WEEKDAY),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // An edited rule's own book always appears in its picker, even if it isn't
  // one of the caller's manageable options (a superuser lens change, a seat
  // that moved) — otherwise the Select would render blank against a value it
  // holds perfectly well.
  const bookOptions =
    existing && !scopeOptions.some((o) => o.value === existing.scope)
      ? [{ value: existing.scope as string, label: existing.scopeLabel }, ...scopeOptions]
      : scopeOptions;

  function addFromDraft() {
    const result = addRecipients(recipients, recipientDraft);
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setRecipients(result.recipients);
    setRecipientDraft("");
  }

  async function submit() {
    setError(null);
    // An address still sitting in the input is one the user typed and meant —
    // making them press Add before Save is how a rule ends up mailing one
    // person fewer than its author believes.
    let pending = recipients;
    if (recipientDraft.trim().length > 0) {
      const result = addRecipients(recipients, recipientDraft);
      if (result.error) {
        setError(result.error);
        return;
      }
      pending = result.recipients;
      setRecipients(pending);
      setRecipientDraft("");
    }

    const built = buildSaveArgs({
      name,
      recipients: pending,
      cadence,
      minAmount,
      scope,
      sendHour,
      sendWeekday,
    });
    if (built.args === null) {
      setError(built.error);
      return;
    }

    setSaving(true);
    try {
      await saveRule({ ruleId: existing?._id, ...built.args });
      onDone();
    } catch (e) {
      // The server is the authority — its written refusal ("A rule may send to
      // at most 20 addresses", "That chapter doesn't exist") is always more
      // useful than a guess made here.
      setError(errorMessage(e, "Couldn't save that rule."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="Big gifts to Shay + AJ"
      />

      <View className="mb-3">
        <Text className="mb-1.5 text-sm font-semibold text-ink">Send to</Text>
        {recipients.length > 0 ? (
          <View className="mb-2 flex-row flex-wrap gap-1.5">
            {recipients.map((email) => (
              <OptionTag
                key={email}
                label={email}
                size="md"
                onRemove={() => setRecipients(removeRecipient(recipients, email))}
              />
            ))}
          </View>
        ) : null}
        <View className="flex-row items-start gap-2">
          <View className="flex-1">
            <TextField
              value={recipientDraft}
              onChangeText={setRecipientDraft}
              onSubmitEditing={addFromDraft}
              placeholder="name@publicworship.life"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              returnKeyType="done"
            />
          </View>
          <Button
            title="Add"
            variant="secondary"
            onPress={addFromDraft}
            disabled={recipientDraft.trim().length === 0}
          />
        </View>
        <Text className="text-xs text-muted">
          Paste a whole list if you have one — commas, semicolons, and spaces
          all split. Up to {MAX_RULE_RECIPIENTS} addresses.
        </Text>
      </View>

      <Select
        label="How often"
        value={cadence}
        options={CADENCE_OPTIONS}
        onChange={(v) => setCadence(v as RuleCadence)}
      />
      <TextField
        label="Only gifts of at least (USD)"
        hint="Leave blank to hear about every gift. A gift of exactly this amount counts."
        value={minAmount}
        onChangeText={setMinAmount}
        keyboardType="decimal-pad"
        placeholder="500"
      />
      <Select
        label="Which book"
        value={scope}
        options={bookOptions}
        onChange={(v) => setScope(v as RuleScope)}
        placeholder="Choose a book…"
      />
      {cadence !== "immediate" ? (
        <Select
          label="Send at"
          hint="The org's clock — Eastern Time."
          value={sendHour}
          options={HOUR_OPTIONS}
          onChange={setSendHour}
        />
      ) : null}
      {cadence === "weekly" ? (
        <Select
          label="Send on"
          value={sendWeekday}
          options={WEEKDAY_OPTIONS}
          onChange={setSendWeekday}
        />
      ) : null}

      {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
      <View className="flex-row gap-2">
        <Button
          title={existing ? "Save changes" : "Create rule"}
          onPress={submit}
          loading={saving}
        />
        <Button title="Cancel" variant="secondary" onPress={onDone} />
      </View>
    </Card>
  );
}
