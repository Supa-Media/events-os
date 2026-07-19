/**
 * AssetLinkPicker — modal combobox linking a supply row to a chapter Inventory
 * asset (docs/plans/inventory-supplies-unification.md §3). Modeled on
 * PersonPicker: search to choose an existing asset, or create one from the
 * typed name when nothing matches. Rows surface live availability so the
 * packer sees over-commitment before linking.
 */
import { useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  Image,
} from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "../../ui/Icon";
import { colors } from "../../../lib/theme";

type Asset = {
  _id: string;
  name: string;
  tags: string[];
  quantity: number;
  available: number;
  overbooked: boolean;
  outOfStock: boolean;
  consumable: boolean;
  photoUrl: string | null;
};

type Props = {
  visible: boolean;
  /** The supply row's title — prefills the search so the likely match (or the
   *  create row) is one tap away. */
  rowTitle: string;
  /** Currently linked asset, if any. */
  selectedId?: string | null;
  onPick: (assetId: string) => void;
  /** Create a new asset named `name` in Inventory and link it. */
  onCreate: (name: string) => void;
  /** Unlink (shown only when a link exists). */
  onClear?: () => void;
  onClose: () => void;
};

function availabilityLine(a: Asset): { text: string; alert: boolean } {
  if (a.consumable && a.outOfStock) return { text: "Out of stock", alert: true };
  if (a.overbooked) return { text: "Overbooked", alert: true };
  return { text: `${a.available}/${a.quantity} free`, alert: false };
}

export function AssetLinkPicker({
  visible,
  rowTitle,
  selectedId,
  onPick,
  onCreate,
  onClear,
  onClose,
}: Props) {
  const assets = useQuery(api.inventory.listAssets, visible ? {} : "skip") as
    | Asset[]
    | undefined;

  // Prefill with the row title on open (fresh links only — an already-linked
  // row opens unfiltered with its asset check-marked).
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (visible) setSearch(selectedId ? "" : rowTitle.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const q = search.trim().toLowerCase();
  const list = assets ?? [];
  const filtered = q
    ? list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.tags.some((t) => t.toLowerCase().includes(q)),
      )
    : list;
  const exactMatch = list.some((a) => a.name.trim().toLowerCase() === q);
  const canCreate = search.trim().length > 0 && !exactMatch;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="border-b border-border px-5 py-4">
            <View className="flex-row items-center justify-between">
              <Text className="font-display text-lg text-ink">
                Link inventory item
              </Text>
              <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>
            <Text className="mt-1 text-sm text-muted">
              Chapter Storage rows reserve their linked asset for this event.
            </Text>
          </View>

          <View className="border-b border-border px-5 py-3">
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search inventory, or type a new name…"
              placeholderTextColor={colors.faint}
              autoFocus
              className="rounded-md border border-border bg-raised px-3 py-2.5 text-base text-ink"
            />
          </View>

          <ScrollView className="max-h-96">
            {onClear && selectedId ? (
              <Row
                label="Unlink asset"
                muted
                icon="x-circle"
                onPress={onClear}
              />
            ) : null}

            {assets === undefined ? (
              <Text className="px-5 py-6 text-center text-base text-muted">
                Loading…
              </Text>
            ) : filtered.length === 0 && !canCreate ? (
              <Text className="px-5 py-6 text-center text-base text-muted">
                {list.length === 0
                  ? "Nothing in Inventory yet."
                  : "No matches."}
              </Text>
            ) : (
              filtered.map((a) => {
                const line = availabilityLine(a);
                return (
                  <Pressable
                    key={a._id}
                    onPress={() => onPick(a._id)}
                    className="flex-row items-center justify-between border-b border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
                  >
                    <View className="flex-1 flex-row items-center gap-3">
                      {a.photoUrl ? (
                        <Image
                          source={{ uri: a.photoUrl }}
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 6,
                            backgroundColor: colors.sunken,
                          }}
                        />
                      ) : (
                        <View className="h-8 w-8 items-center justify-center rounded-md bg-sunken">
                          <Icon name="box" size={15} color={colors.muted} />
                        </View>
                      )}
                      <View className="flex-1">
                        <Text
                          className={`text-base ${
                            a._id === selectedId
                              ? "font-semibold text-accent"
                              : "text-ink"
                          }`}
                          numberOfLines={1}
                        >
                          {a.name}
                        </Text>
                        <Text
                          className={`text-xs ${
                            line.alert ? "text-danger" : "text-muted"
                          }`}
                        >
                          {line.text}
                          {a.tags.length ? ` · ${a.tags.join(", ")}` : ""}
                        </Text>
                      </View>
                    </View>
                    {a._id === selectedId ? (
                      <Icon name="check" size={16} color={colors.accent} />
                    ) : null}
                  </Pressable>
                );
              })
            )}

            {canCreate ? (
              <Row
                label={`Create “${search.trim()}” in Inventory`}
                muted
                icon="plus"
                onPress={() => onCreate(search.trim())}
              />
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({
  label,
  muted,
  icon,
  onPress,
}: {
  label: string;
  muted?: boolean;
  icon: "x-circle" | "plus";
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 border-b border-border px-5 py-3 active:bg-sunken web:hover:bg-sunken"
    >
      <View className="h-7 w-7 items-center justify-center rounded-pill bg-sunken">
        <Icon name={icon} size={14} color={colors.muted} />
      </View>
      <Text className={`text-base ${muted ? "text-muted" : "text-ink"}`}>
        {label}
      </Text>
    </Pressable>
  );
}
