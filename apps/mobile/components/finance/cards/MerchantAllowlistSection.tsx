/**
 * MerchantAllowlistSection — the chapter's merchant allow-list for card
 * authorizations (manager). Allowed merchant-NAME substrings + 4-digit MCC
 * category codes, plus the enforcement toggle: when ON and the list is
 * non-empty, real-time authorizations at any merchant matching NO entry are
 * declined ("merchant not on allow-list" in the authorization log); OFF (or
 * empty) changes nothing. Backed by `api.cards.getMerchantPolicy` /
 * `api.cards.setMerchantPolicy` (FM-gated server-side); every change saves
 * immediately (the lock/unlock pattern — no draft state to lose). Collapsed by
 * default, mirroring `RelayCardsSection`'s "rarely touched once set up" toggle.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, Icon, SectionHeader, TextField, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";

export function MerchantAllowlistSection() {
  const [expanded, setExpanded] = useState(false);

  return (
    <View>
      <SectionHeader
        title="Merchant allow-list"
        right={
          <Button
            title={expanded ? "Hide" : "Show"}
            variant="secondary"
            size="sm"
            icon={expanded ? "chevron-up" : "chevron-down"}
            onPress={() => setExpanded((e) => !e)}
          />
        }
      />
      {expanded ? <MerchantAllowlistBody /> : null}
    </View>
  );
}

function MerchantAllowlistBody() {
  const policy = useQuery(api.cards.getMerchantPolicy, {});
  const setPolicy = useMutation(api.cards.setMerchantPolicy);
  const { run, toast, dismiss } = useActionRunner();

  const [nameInput, setNameInput] = useState("");
  const [mccInput, setMccInput] = useState("");

  const loading = policy === undefined;
  const entryCount = policy
    ? policy.allowedMerchantNames.length + policy.allowedMerchantCategories.length
    : 0;

  // Every change saves the FULL policy immediately (one row per chapter
  // server-side); the current query value is the base each patch applies to.
  function save(next: {
    enforced?: boolean;
    names?: string[];
    categories?: string[];
  }) {
    if (!policy) return;
    return run(
      () =>
        setPolicy({
          enforced: next.enforced ?? policy.enforced,
          allowedMerchantNames: next.names ?? policy.allowedMerchantNames,
          allowedMerchantCategories:
            next.categories ?? policy.allowedMerchantCategories,
        }),
      { errorTitle: "Couldn't update allow-list" },
    );
  }

  function addName() {
    const name = nameInput.trim();
    if (!name || !policy) return;
    setNameInput("");
    void save({ names: [...policy.allowedMerchantNames, name] });
  }

  function addMcc() {
    const code = mccInput.trim();
    if (!code || !policy) return;
    // Mirror the server's 4-digit MCC gate locally so the finance manager gets
    // the friendly explanation before a round-trip.
    if (!/^\d{4}$/.test(code)) {
      run(
        () =>
          Promise.reject(
            new Error(
              "Category codes are 4 digits (e.g. 5411 for grocery stores).",
            ),
          ),
        { errorTitle: "Invalid category code" },
      );
      return;
    }
    setMccInput("");
    void save({ categories: [...policy.allowedMerchantCategories, code] });
  }

  return (
    <View>
      <Text className="mb-3 text-sm text-muted">
        Only merchants matching an allowed name (or category code) can charge
        the chapter's cards while enforcement is on. Everything else is
        declined on the spot and logged.
      </Text>

      {/* Enforcement toggle — the CardControlsModal checkbox pattern. */}
      <Pressable
        onPress={() => void save({ enforced: !(policy?.enforced ?? false) })}
        disabled={loading}
        className="mb-1 flex-row items-center gap-2"
      >
        <View
          className={`h-5 w-5 items-center justify-center rounded border ${
            policy?.enforced
              ? "border-accent bg-accent"
              : "border-border-strong bg-raised"
          }`}
        >
          {policy?.enforced ? (
            <Icon name="check" size={13} color="#FFFFFF" />
          ) : null}
        </View>
        <Text className="text-sm font-semibold text-ink">
          Enforce the allow-list
        </Text>
      </Pressable>
      <Text className="mb-3 text-xs text-muted">
        {policy?.enforced
          ? entryCount > 0
            ? "On — charges at merchants not on the list are declined."
            : "On, but the list is empty — nothing is blocked until you add an entry."
          : "Off — all merchants are allowed (the cards' own caps still apply)."}
      </Text>

      {/* Allowed merchant names. */}
      <EntryChips
        entries={policy?.allowedMerchantNames ?? []}
        emptyLabel="No merchant names yet."
        onRemove={(entry) =>
          void save({
            names: (policy?.allowedMerchantNames ?? []).filter(
              (n) => n !== entry,
            ),
          })
        }
      />
      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <TextField
            label="Allowed merchant name"
            value={nameInput}
            onChangeText={setNameInput}
            placeholder="e.g. Costco"
            hint="Matches anywhere in the charge's merchant name, any casing."
            onSubmitEditing={addName}
          />
        </View>
        <View className="mb-3">
          <Button
            title="Add"
            icon="plus"
            size="sm"
            variant="secondary"
            onPress={addName}
          />
        </View>
      </View>

      {/* Allowed category codes (MCCs). */}
      <EntryChips
        entries={policy?.allowedMerchantCategories ?? []}
        emptyLabel="No category codes yet."
        onRemove={(entry) =>
          void save({
            categories: (policy?.allowedMerchantCategories ?? []).filter(
              (c) => c !== entry,
            ),
          })
        }
      />
      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <TextField
            label="Allowed category code (MCC)"
            value={mccInput}
            onChangeText={setMccInput}
            keyboardType="number-pad"
            placeholder="e.g. 5411"
            hint="The card network's 4-digit merchant category, e.g. 5411 = grocery stores."
            onSubmitEditing={addMcc}
          />
        </View>
        <View className="mb-3">
          <Button
            title="Add"
            icon="plus"
            size="sm"
            variant="secondary"
            onPress={addMcc}
          />
        </View>
      </View>

      <ToastView toast={toast} onDismiss={dismiss} />
    </View>
  );
}

/** The saved entries as removable chips (× to delete — the Relay unlink
 *  pattern), or a quiet placeholder line while the group is empty. */
function EntryChips({
  entries,
  emptyLabel,
  onRemove,
}: {
  entries: string[];
  emptyLabel: string;
  onRemove: (entry: string) => void;
}) {
  if (entries.length === 0) {
    return <Text className="mb-2 text-xs text-faint">{emptyLabel}</Text>;
  }
  return (
    <View className="mb-2 flex-row flex-wrap gap-2">
      {entries.map((entry) => (
        <View
          key={entry}
          className="flex-row items-center gap-1 rounded-full border border-border bg-raised py-1 pl-3 pr-1.5"
        >
          <Text className="text-xs font-semibold text-ink">{entry}</Text>
          <Pressable
            onPress={() => onRemove(entry)}
            hitSlop={6}
            accessibilityLabel={`Remove ${entry}`}
            className="rounded-full p-0.5 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name="x" size={12} color={colors.muted} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}
