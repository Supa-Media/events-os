import { useMemo, useState } from "react";
import { View, Text, Pressable, TextInput, ScrollView } from "react-native";
import { useAction, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { AiCatalogModel } from "@events-os/shared";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";
import { errorMessage } from "./shared";

/**
 * Per-chat model + spend controls, docked in the assistant footer.
 *
 * Every chat picks its OWN model, falling back to the deployment default:
 *   - Any FREE model is open to everyone.
 *   - PAID models (and a per-chat spend cap) are super-admin only — the server
 *     enforces this in `setThreadModel` / `setThreadSpendLimit`; the UI just
 *     hides what a non-superuser can't use.
 *
 * The model list is the LIVE OpenRouter catalog (tool-calling models only),
 * fetched once when the picker opens. Collapsed by default so it stays out of
 * the way; expands to a searchable list + (for admins) a spend-limit editor.
 */
export function ChatModelSettings({
  threadId,
  settings,
}: {
  threadId: string | null;
  settings:
    | {
        model: string;
        isCustomModel: boolean;
        deploymentDefault: string;
        spendLimitUsd: number | null;
        spentUsd: number;
        overLimit: boolean;
        isSuperuser: boolean;
      }
    | undefined
    | null;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<AiCatalogModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [limitInput, setLimitInput] = useState("");

  const listModels = useAction(api.aiActions.listModels);
  const setThreadModel = useAction(api.aiActions.setThreadModel);
  const setThreadSpendLimit = useMutation(api.ai.setThreadSpendLimit);

  const isSuperuser = !!settings?.isSuperuser;

  // The friendly label for the chat's current model (from the catalog if we've
  // loaded it, else the raw slug).
  const currentLabel = useMemo(() => {
    if (!settings) return "";
    const hit = catalog?.find((m) => m.slug === settings.model);
    return hit?.label ?? settings.model;
  }, [catalog, settings]);

  async function loadCatalog() {
    if (catalog || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listModels({});
      setCatalog(res.models);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setLimitInput(settings?.spendLimitUsd != null ? String(settings.spendLimitUsd) : "");
      await loadCatalog();
    }
  }

  async function pick(slug: string | null) {
    if (!threadId) return;
    setError(null);
    setSaving(true);
    try {
      await setThreadModel({ threadId: threadId as any, slug });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveLimit(clear: boolean) {
    if (!threadId) return;
    setError(null);
    setSaving(true);
    try {
      const value = clear ? null : Number(limitInput);
      if (!clear && (!Number.isFinite(value) || (value as number) < 0)) {
        setError("Enter a dollar amount (0 or more).");
        return;
      }
      await setThreadSpendLimit({ threadId: threadId as any, limitUsd: value });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Models the caller may choose: free for everyone, paid only for admins. Keep
  // the current model visible even if it'd otherwise be filtered out. Cap the
  // rendered list so a 300-model catalog stays snappy.
  const visible = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    return catalog
      .filter((m) => isSuperuser || m.free)
      .filter(
        (m) =>
          !q ||
          m.label.toLowerCase().includes(q) ||
          m.slug.toLowerCase().includes(q),
      )
      .slice(0, 40);
  }, [catalog, query, isSuperuser]);

  if (!settings) {
    return (
      <Text className="pb-1 text-2xs text-faint">Model settings open with the chat.</Text>
    );
  }

  const spendLine =
    settings.spendLimitUsd != null
      ? `$${settings.spentUsd.toFixed(2)} / $${settings.spendLimitUsd.toFixed(2)}`
      : null;

  return (
    <View className="pb-1">
      {/* Collapsed summary row — tap to expand the picker. */}
      <Pressable
        onPress={toggle}
        className="flex-row items-center justify-between py-1 active:opacity-70"
      >
        <View className="flex-1 flex-row items-center gap-1">
          <Icon name="cpu" size={12} color={colors.muted} />
          <Text className="flex-1 text-2xs text-muted" numberOfLines={1}>
            {currentLabel}
            {settings.isCustomModel ? "" : " · default"}
          </Text>
        </View>
        {spendLine ? (
          <Text
            className={`mr-1 text-2xs ${settings.overLimit ? "text-danger" : "text-faint"}`}
          >
            {spendLine}
          </Text>
        ) : null}
        <Icon name={open ? "chevron-up" : "chevron-down"} size={14} color={colors.muted} />
      </Pressable>

      {open ? (
        <View className="gap-2 rounded-lg border border-border bg-surface p-2">
          {/* Search + reset-to-default */}
          <View className="flex-row items-center gap-2">
            <View className="flex-1 rounded-md border border-border bg-raised px-2 py-1.5">
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search models…"
                placeholderTextColor={colors.faint}
                className="text-xs text-ink"
                style={{ outlineWidth: 0 } as any}
              />
            </View>
            {settings.isCustomModel ? (
              <Pressable
                onPress={() => pick(null)}
                disabled={saving}
                className="active:opacity-70"
              >
                <Text className="text-2xs font-semibold text-accent">Use default</Text>
              </Pressable>
            ) : null}
          </View>

          {/* Model list */}
          {loading ? (
            <Text className="py-2 text-2xs text-faint">Loading models…</Text>
          ) : (
            <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled">
              {visible.map((m) => {
                const active = m.slug === settings.model;
                return (
                  <Pressable
                    key={m.slug}
                    onPress={() => pick(m.slug)}
                    disabled={saving || active}
                    className={`flex-row items-center gap-2 rounded-md px-2 py-1.5 active:opacity-70 ${
                      active ? "bg-raised" : ""
                    }`}
                  >
                    <View className="flex-1">
                      <Text className="text-xs text-ink" numberOfLines={1}>
                        {m.label}
                      </Text>
                      <Text className="text-2xs text-faint" numberOfLines={1}>
                        {m.free
                          ? "Free"
                          : `$${m.inputPerMTok.toFixed(2)}/$${m.outputPerMTok.toFixed(2)} per M`}
                        {m.reasoning ? " · reasoning" : ""}
                      </Text>
                    </View>
                    {active ? (
                      <Icon name="check" size={14} color={colors.accent} />
                    ) : !m.free ? (
                      <View className="rounded bg-border px-1.5 py-0.5">
                        <Text className="text-2xs font-semibold text-muted">PAID</Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
              {catalog && visible.length === 0 ? (
                <Text className="py-2 text-2xs text-faint">No matching models.</Text>
              ) : null}
            </ScrollView>
          )}

          {/* Spend cap — super admins only. */}
          {isSuperuser ? (
            <View className="gap-1 border-t border-border pt-2">
              <Text className="text-2xs font-semibold text-muted">
                Chat spend limit (USD)
              </Text>
              <View className="flex-row items-center gap-2">
                <View className="flex-1 flex-row items-center rounded-md border border-border bg-raised px-2">
                  <Text className="text-xs text-faint">$</Text>
                  <TextInput
                    value={limitInput}
                    onChangeText={setLimitInput}
                    placeholder="No limit"
                    placeholderTextColor={colors.faint}
                    keyboardType="decimal-pad"
                    className="flex-1 py-1.5 text-xs text-ink"
                    style={{ outlineWidth: 0 } as any}
                  />
                </View>
                <Pressable
                  onPress={() => saveLimit(false)}
                  disabled={saving}
                  className="rounded-md bg-accent px-2.5 py-1.5 active:opacity-80"
                >
                  <Text className="text-2xs font-semibold" style={{ color: colors.accentText }}>
                    Save
                  </Text>
                </Pressable>
                {settings.spendLimitUsd != null ? (
                  <Pressable
                    onPress={() => saveLimit(true)}
                    disabled={saving}
                    className="active:opacity-70"
                  >
                    <Text className="text-2xs text-muted">Clear</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text className="text-2xs text-faint">
                Spent ${settings.spentUsd.toFixed(2)} on this chat. Free models cost
                $0 — a limit only matters on paid models.
              </Text>
            </View>
          ) : null}

          {error ? <Text className="text-2xs text-danger">{error}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
