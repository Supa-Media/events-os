/**
 * INVENTORY — the chapter's gear registry, rendered through the SAME database
 * grid as an event's Supplies & Logistics (EditableGrid in the dedicated
 * "chapter" mode, backed by the `assets` table). Columns are fixed
 * (`INVENTORY_COLUMNS`): item name, tags, quantity, a read-only availability
 * summary, consumable/condition/acquired selects, a photo cell and notes. Above
 * the grid a tags filter pill bar narrows the rows; a docked, chapter-scoped AI
 * assistant squeezes the content when open.
 *
 * Gated admin-or-lead in the nav (logistics-lead domain) AND in-screen here, so
 * a member/volunteer who deep-links lands on a friendly restricted state rather
 * than the registry. Reservations against these assets happen per-event from the
 * event's Gear tool.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  EmptyState,
  FULL_WIDTH,
  Narrow,
  Pill,
  Screen,
} from "../../components/ui";
import { EditableGrid } from "../../components/grid/EditableGrid";
import { InventoryAssistantPanel } from "../../components/ai/InventoryAssistantPanel";

export default function InventoryScreen() {
  const org = useQuery(api.org.nav);
  // A second subscription to the grid payload (Convex dedupes with the grid's
  // own) — it drives the tags pill bar + the id set passed to `filterItemIds`.
  const grid = useQuery(api.inventory.listAssetsGrid, {});

  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  // Stable reference so the tag/filter memos below only recompute when the grid
  // payload actually changes (not on every render).
  const items = useMemo(() => grid?.items ?? [], [grid]);

  // Distinct tag vocabulary across every asset, for the filter pill bar.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      for (const t of (it.fields?.tags as string[] | undefined) ?? []) set.add(t);
    }
    return [...set].sort();
  }, [items]);

  // The rows whose tags intersect the current selection (null = "All").
  const filterItemIds = useMemo(() => {
    if (selectedTags.size === 0) return null;
    const ids = new Set<string>();
    for (const it of items) {
      const tags = (it.fields?.tags as string[] | undefined) ?? [];
      if (tags.some((t) => selectedTags.has(t))) ids.add(it._id);
    }
    return ids;
  }, [items, selectedTags]);

  function toggleTag(tag: string) {
    setSelectedTags((cur) => {
      const next = new Set(cur);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  // In-screen guard: the registry is the logistics-lead domain (admin or lead).
  const tier = org?.tier;
  if (org !== undefined && tier !== "admin" && tier !== "lead") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Inventory is restricted"
            message="Only chapter admins and leads can manage the gear registry."
          />
        </Narrow>
      </Screen>
    );
  }

  if (org === undefined || grid === undefined) return <Screen loading />;

  return (
    <View className="flex-1 flex-row">
      <View className="flex-1">
        <Screen maxWidth={FULL_WIDTH}>
          <Narrow>
            <View className="mb-1 flex-row items-center gap-2">
              <Text className="font-display text-2xl text-ink">Inventory</Text>
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                Registry ({items.length})
              </Text>
            </View>
            <Text className="mb-3 text-sm text-muted">
              Your chapter's gear. Events reserve from here — two overlapping
              events can't both claim the one battery. Reserve gear from an
              event's Gear tool.
            </Text>

            {/* Tags filter pill bar */}
            {allTags.length > 0 ? (
              <View className="mb-3 flex-row flex-wrap items-center gap-2">
                <Pill
                  label="All"
                  selected={selectedTags.size === 0}
                  onPress={() => setSelectedTags(new Set())}
                />
                {allTags.map((t) => (
                  <Pill
                    key={t}
                    label={t}
                    selected={selectedTags.has(t)}
                    onPress={() => toggleTag(t)}
                  />
                ))}
              </View>
            ) : null}
          </Narrow>

          {/* The database grid — full width, chapter mode. */}
          <EditableGrid
            mode="chapter"
            parentId="chapter"
            module={"inventory" as any}
            roles={[]}
            addLabel="Add asset"
            filterItemIds={filterItemIds}
          />
        </Screen>
      </View>

      {/* In-flow assistant panel — squeezes the content left when open. */}
      <InventoryAssistantPanel />
    </View>
  );
}
