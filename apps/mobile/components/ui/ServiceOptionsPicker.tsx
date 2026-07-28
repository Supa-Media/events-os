/**
 * Service Catalog picker — the founder's ask (2026-07-27): "change it from a
 * freeform text to a dropdown that has to match the existing things, or you
 * have to add a new option, and you can edit existing options." Replaces the
 * old comma-separated free-text `people.services` editor (`SkillsCell` in
 * `app/(app)/(tabs)/people.tsx`) and `TargetingBuilder.tsx`'s free-text
 * "has service" condition — both now select from `serviceOptions.list`
 * instead of typing arbitrary strings.
 *
 * `mode="multi"` (a person's services — any number) toggles rows and needs an
 * explicit "Done"; `mode="single"` (one audience condition's `serviceId`)
 * commits and closes on the first tap, mirroring `PersonPicker`/`RolePicker`.
 * Both modes share the same list, search, inline "add new", and "Manage
 * services…" entry point — there is exactly one catalog, never a
 * single-vs-multi fork of the data.
 *
 * Anyone can add/browse today (`lib/servicesAccess.ts`'s "gate it behind a
 * power, even when it's open today" — the backend still enforces its own
 * gate regardless of what this UI shows).
 */
import { useMemo, useState } from "react";
import { Modal, View, Text, Pressable, ScrollView, TextInput } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon } from "./Icon";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { colors } from "../../lib/theme";
import { errorMessage } from "../../lib/errors";
import {
  flattenServiceCatalog,
  topLevelServiceOptions,
  type FlatServiceOption,
} from "../../lib/serviceCatalog";
import { ServiceCatalogManageModal } from "./ServiceCatalogManageModal";

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Currently chosen ids. `mode="single"` only ever holds 0 or 1. */
  selectedIds: Id<"serviceOptions">[];
  onChange: (ids: Id<"serviceOptions">[]) => void;
  /** "multi" (default): toggle any number, closed via "Done". "single":
   *  picking a row commits it and closes the picker immediately. */
  mode?: "multi" | "single";
  title?: string;
};

export function ServiceOptionsPicker({
  visible,
  onClose,
  selectedIds,
  onChange,
  mode = "multi",
  title = "Services",
}: Props) {
  const tree = useQuery(api.serviceOptions.list, visible ? { includeInactive: true } : "skip");
  const createOption = useMutation(api.serviceOptions.create);

  const [search, setSearch] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState<Id<"serviceOptions"> | "">("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const flat = useMemo(() => (tree ? flattenServiceCatalog(tree) : []), [tree]);
  const topLevel = useMemo(() => (tree ? topLevelServiceOptions(tree) : []), [tree]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const q = search.trim().toLowerCase();
  // Every ACTIVE row, plus any already-selected row even if it's since gone
  // inactive — a stale pick should stay visible (and deselectable) rather
  // than silently vanish from the list it was chosen from.
  const visibleRows = flat.filter(
    (o) => (o.isActive || selected.has(o._id)) && (!q || o.label.toLowerCase().includes(q)),
  );

  function toggle(id: Id<"serviceOptions">) {
    if (mode === "single") {
      onChange([id]);
      onClose();
      return;
    }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const id = await createOption({
        name,
        parentId: newParentId || undefined,
      });
      setNewName("");
      setNewParentId("");
      if (mode === "single") {
        onChange([id]);
        onClose();
      } else {
        onChange([...selected, id]);
      }
    } catch (err) {
      setCreateError(errorMessage(err, "Couldn't add that service."));
    } finally {
      setCreating(false);
    }
  }

  function handleClose() {
    setSearch("");
    setCreateError(null);
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable onPress={handleClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="border-b border-border px-5 py-4">
            <View className="flex-row items-center justify-between">
              <Text className="font-display text-lg text-ink">{title}</Text>
              <Pressable onPress={handleClose} hitSlop={8} className="rounded-md p-1">
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>
            <Text className="mt-1 text-xs text-muted">
              {mode === "single"
                ? 'Picking a group (e.g. "Vocals") matches everyone in every option under it, not just that exact one.'
                : "Choose everything that applies. Can't find it? Add one below."}
            </Text>
          </View>

          <View className="border-b border-border px-5 py-3">
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search services…"
              placeholderTextColor={colors.faint}
              className="rounded-md border border-border-strong bg-raised px-3 py-2 text-sm text-ink"
            />
          </View>

          <ScrollView className="max-h-72" keyboardShouldPersistTaps="handled">
            {tree === undefined ? (
              <Text className="px-5 py-6 text-center text-base text-muted">Loading…</Text>
            ) : visibleRows.length === 0 ? (
              <Text className="px-5 py-6 text-center text-base text-muted">No matches.</Text>
            ) : (
              visibleRows.map((row) => (
                <OptionRow
                  key={row._id}
                  option={row}
                  selected={selected.has(row._id)}
                  onPress={() => toggle(row._id)}
                />
              ))
            )}
          </ScrollView>

          {/* Add-new is always available, not tucked behind a toggle — the
              founder's spec treats it as a first-class alternative to
              picking an existing option, not an escape hatch. */}
          <View className="gap-2 border-t border-border px-5 py-3">
            <Text className="text-2xs font-bold uppercase tracking-wider text-faint">
              + New service
            </Text>
            <View className="flex-row items-center gap-2">
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="e.g. Tenor"
                placeholderTextColor={colors.faint}
                className="flex-1 rounded-md border border-border-strong bg-raised px-3 py-2 text-sm text-ink"
              />
              <Button
                title="Add"
                size="sm"
                onPress={() => void handleCreate()}
                loading={creating}
                disabled={!newName.trim()}
              />
            </View>
            {topLevel.length > 0 ? (
              <View className="flex-row flex-wrap items-center gap-1.5">
                <Text className="text-xs text-muted">Under:</Text>
                <ParentChip
                  label="Top-level"
                  selected={newParentId === ""}
                  onPress={() => setNewParentId("")}
                />
                {topLevel.map((p) => (
                  <ParentChip
                    key={p._id}
                    label={p.name}
                    selected={newParentId === p._id}
                    onPress={() => setNewParentId(p._id)}
                  />
                ))}
              </View>
            ) : null}
            {createError ? <Text className="text-xs text-danger">{createError}</Text> : null}
          </View>

          <View className="flex-row items-center justify-between border-t border-border px-5 py-3">
            <Pressable onPress={() => setManageOpen(true)}>
              <Text className="text-sm font-semibold text-accent">Manage services…</Text>
            </Pressable>
            {mode === "multi" ? (
              <Button title="Done" size="sm" onPress={handleClose} />
            ) : null}
          </View>
        </Pressable>
      </Pressable>

      <ServiceCatalogManageModal visible={manageOpen} onClose={() => setManageOpen(false)} />
    </Modal>
  );
}

function OptionRow({
  option,
  selected,
  onPress,
}: {
  option: FlatServiceOption;
  selected: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center justify-between border-b border-border px-5 py-2.5 ${
        option.parentId ? "pl-9" : ""
      } ${hovered ? "bg-sunken" : "bg-raised"}`}
    >
      <View className="flex-1 flex-row items-center gap-2">
        <Text
          className={`text-sm ${
            !option.isActive ? "text-faint" : selected ? "font-semibold text-accent" : "text-ink"
          }`}
          numberOfLines={1}
        >
          {option.label}
        </Text>
        {!option.isActive ? <Badge label="Inactive" tone="warn" /> : null}
      </View>
      {selected ? <Icon name="check" size={16} color={colors.accent} /> : null}
    </Pressable>
  );
}

function ParentChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-pill border px-2.5 py-1 ${
        selected ? "border-accent bg-accent-soft" : "border-border-strong bg-raised"
      }`}
    >
      <Text className={`text-xs ${selected ? "font-semibold text-accent" : "text-ink"}`}>
        {label}
      </Text>
    </Pressable>
  );
}
