/**
 * SupplyLinkBanner — bulk on-ramp for pre-bridge supply rows.
 *
 * Rows created before the Inventory link shipped (or via templates) can carry a
 * storage Source with no linked asset, so they never reserve gear. When such
 * rows exist, an amber banner surfaces above the supplies grid with a Review
 * modal: each row gets an exact-name match suggestion from the registry and
 * per-row Link / Create / Skip actions, plus one-tap "Link all matched".
 * Executes the same per-row mutations as the Source cell — no bulk endpoint.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { isInventoryBackedSource } from "@events-os/shared";
import { colors } from "../../../lib/theme";
import { Icon } from "../../ui/Icon";

export function SupplyLinkBanner({ eventId }: { eventId: string }) {
  const data = useQuery(api.items.listForEventModule, {
    eventId: eventId as any,
    module: "supplies",
  });
  const [open, setOpen] = useState(false);
  // Rows dismissed for this visit (not persisted — the banner is a nudge, and
  // reappearing on next load is the point for rows that stay unlinked).
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const assets = useQuery(api.inventory.listAssets, open ? {} : "skip");
  const linkAsset = useMutation(api.items.linkSupplyToAsset);
  const createAsset = useMutation(api.items.createAssetFromSupply);
  // A single flag gates every action chip and the "Link all matched" footer —
  // per-row busy ids let other rows' chips stay tappable mid-loop, which can
  // double-submit a mutation while "Link all matched" is running.
  const [busy, setBusy] = useState(false);
  const loading = open && assets === undefined;

  const unlinked = (data?.items ?? []).filter(
    (it: any) =>
      isInventoryBackedSource(it.fields?.source) && !it.fields?.linkedAssetId,
  );
  const visible = unlinked.filter((it: any) => !skipped.has(it._id));
  if (visible.length === 0) return null;

  const suggestionFor = (title: string) =>
    (assets ?? []).find(
      (a: any) => a.name.trim().toLowerCase() === title.trim().toLowerCase(),
    );
  // While assets are still loading, nothing counts as matched — otherwise
  // every row would flash "No matching asset" before the query resolves.
  const matched = loading
    ? []
    : visible.filter((it: any) => suggestionFor(it.title));

  const doLink = async (itemId: string, assetId: string) => {
    setBusy(true);
    try {
      await linkAsset({ itemId: itemId as any, assetId: assetId as any });
    } finally {
      setBusy(false);
    }
  };
  const doCreate = async (itemId: string) => {
    setBusy(true);
    try {
      await createAsset({ itemId: itemId as any });
    } finally {
      setBusy(false);
    }
  };
  const linkAllMatched = async () => {
    setBusy(true);
    try {
      for (const it of matched) {
        const match = suggestionFor(it.title);
        if (match) {
          await linkAsset({ itemId: it._id as any, assetId: match._id as any });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <View
        className="mb-2 flex-row items-center justify-between gap-3 rounded-lg border px-3 py-2"
        style={{ backgroundColor: colors.warnBg, borderColor: colors.warn }}
      >
        <View className="flex-1 flex-row items-center gap-2">
          <Icon name="link" size={14} color={colors.warn} />
          <Text className="flex-1 text-sm" style={{ color: colors.warn }}>
            {visible.length === 1
              ? "1 storage row isn't linked to Inventory"
              : `${visible.length} storage rows aren't linked to Inventory`}
          </Text>
        </View>
        <Pressable
          onPress={() => setOpen(true)}
          className="rounded-pill border px-3 py-1 active:opacity-70"
          style={{ borderColor: colors.warn }}
        >
          <Text className="text-xs font-semibold" style={{ color: colors.warn }}>
            Review
          </Text>
        </Pressable>
      </View>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          onPress={() => setOpen(false)}
          className="flex-1 items-center justify-center bg-ink/30 p-6"
        >
          <Pressable
            onPress={() => {}}
            className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
          >
            <View className="border-b border-border px-5 py-4">
              <View className="flex-row items-center justify-between">
                <Text className="font-display text-lg text-ink">
                  Link storage rows to Inventory
                </Text>
                <Pressable
                  onPress={() => setOpen(false)}
                  hitSlop={8}
                  className="rounded-md p-1"
                >
                  <Icon name="x" size={18} color={colors.muted} />
                </Pressable>
              </View>
              <Text className="mt-1 text-sm text-muted">
                Linked rows reserve their asset for this event, so other events
                see the claim.
              </Text>
            </View>

            <ScrollView className="max-h-96">
              {visible.map((it: any) => {
                const match = loading ? undefined : suggestionFor(it.title);
                return (
                  <View
                    key={it._id}
                    className="flex-row items-center justify-between gap-3 border-b border-border px-5 py-3"
                  >
                    <View className="flex-1">
                      <Text className="text-base text-ink" numberOfLines={1}>
                        {it.title || "Untitled row"}
                      </Text>
                      <Text className="text-xs text-muted" numberOfLines={1}>
                        {loading
                          ? "Checking Inventory…"
                          : match
                            ? `Match: ${match.name} · ${match.available}/${match.quantity} free`
                            : "No matching asset — create one from this row"}
                      </Text>
                    </View>
                    <View className="flex-row items-center gap-2">
                      {match ? (
                        <ActionChip
                          label="Link"
                          accent
                          disabled={busy}
                          onPress={() => void doLink(it._id, match._id)}
                        />
                      ) : (
                        <ActionChip
                          label="Create"
                          accent
                          disabled={busy || loading}
                          onPress={() => void doCreate(it._id)}
                        />
                      )}
                      <ActionChip
                        label="Skip"
                        disabled={busy}
                        onPress={() =>
                          setSkipped((prev) => new Set(prev).add(it._id))
                        }
                      />
                    </View>
                  </View>
                );
              })}
            </ScrollView>

            {matched.length > 1 ? (
              <Pressable
                onPress={() => void linkAllMatched()}
                disabled={busy}
                className="flex-row items-center justify-center gap-2 border-t border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
              >
                <Icon name="link" size={14} color={colors.accent} />
                <Text className="text-sm font-semibold text-accent">
                  Link all {matched.length} matched
                </Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function ActionChip({
  label,
  accent,
  disabled,
  onPress,
}: {
  label: string;
  accent?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={`rounded-pill border px-2.5 py-1 active:opacity-70 ${
        disabled ? "opacity-40" : ""
      } ${accent ? "border-accent" : "border-border"}`}
    >
      <Text
        className={`text-xs font-semibold ${accent ? "text-accent" : "text-muted"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
