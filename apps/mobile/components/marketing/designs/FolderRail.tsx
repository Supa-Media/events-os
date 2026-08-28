/**
 * MARKETING · Designs — the filing cabinet you move through.
 *
 * The shipped tab printed every folder as a heading with "0 files" beside it
 * and scrolled you past all of them to reach anything. The rail inverts that:
 * one shelf is open at a time, tapping a folder filters the grid to it, and the
 * count beside a name is a signpost rather than a status report.
 *
 * ── Two shapes, one list ────────────────────────────────────────────────────
 * A 214px column beside the canvas on a desk; a horizontal strip of chips above
 * it on a phone, where a column would eat half the screen. Same shelves, same
 * order, same counts — only the direction changes.
 *
 * ── The brand-kit jumps ─────────────────────────────────────────────────────
 * Colors and Faces are on the same canvas rather than behind their own routes,
 * so the rail's top group scrolls to them (`Screen`'s `scrollRef` + the
 * section's measured offset — the pattern `project/[id]` uses for its money
 * section). One page, and the rail is a table of contents for it.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { Icon, type IconName } from "../../ui";
import { colors } from "../../../lib/theme";
import type { Shelf, ShelfId } from "./library.shared";

export function FolderRail({
  shelves,
  activeShelf,
  onSelect,
  jumps,
  narrow,
  footnote,
}: {
  shelves: Shelf[];
  activeShelf: ShelfId;
  onSelect: (shelfId: ShelfId) => void;
  /** The brand-kit table of contents — Colors, Faces, Files. Column only: the
   *  strip sits directly above the grid it filters, where a jump to a section
   *  three screens up would be a link out of the thing you are looking at. */
  jumps?: { key: string; label: string; icon: IconName; onPress: () => void }[];
  /** Lay out as a horizontal strip instead of a column. */
  narrow: boolean;
  /** The one line about who may edit. Column only — the caller says it
   *  somewhere else when the rail is a strip. */
  footnote?: string;
}) {
  if (narrow) {
    return (
      <View className="mb-4">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingRight: 8 }}
        >
          {shelves.map((shelf) => (
            <ShelfChip
              key={shelf.id}
              shelf={shelf}
              active={shelf.id === activeShelf}
              onPress={() => onSelect(shelf.id)}
            />
          ))}
        </ScrollView>
      </View>
    );
  }

  return (
    <View className="w-[214px] gap-5">
      <View className="gap-0.5">
        <RailEyebrow label="Brand kit" />
        {(jumps ?? []).map((jump) => (
          <Pressable
            key={jump.key}
            onPress={jump.onPress}
            accessibilityRole="button"
            className="flex-row items-center gap-2 rounded-md px-2.5 py-1.5 web:hover:bg-sunken"
          >
            <Icon name={jump.icon} size={14} color={colors.muted} />
            <Text className="text-sm text-muted">{jump.label}</Text>
          </Pressable>
        ))}
      </View>

      <View className="gap-0.5">
        <RailEyebrow label="Folders" />
        {shelves.map((shelf) => (
          <ShelfRow
            key={shelf.id}
            shelf={shelf}
            active={shelf.id === activeShelf}
            onPress={() => onSelect(shelf.id)}
          />
        ))}
      </View>

      {footnote ? (
        <Text className="border-t border-border px-2.5 pt-3 text-2xs leading-4 text-faint">
          {footnote}
        </Text>
      ) : null}
    </View>
  );
}

function RailEyebrow({ label }: { label: string }) {
  return (
    <Text className="px-2.5 pb-1.5 text-2xs font-bold uppercase tracking-wider text-faint">
      {label}
    </Text>
  );
}

function ShelfRow({
  shelf,
  active,
  onPress,
}: {
  shelf: Shelf;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${shelf.name}, ${shelf.count} ${shelf.count === 1 ? "file" : "files"}`}
      className={`flex-row items-center gap-2 rounded-md py-1.5 pr-2.5 ${
        shelf.depth === 1 ? "pl-6" : "pl-2.5"
      } ${active ? "bg-accent-soft" : "web:hover:bg-sunken"}`}
    >
      <Text
        className={`flex-1 text-sm ${active ? "font-semibold text-accent" : "text-muted"}`}
        numberOfLines={1}
      >
        {shelf.name}
      </Text>
      <Text
        className={`text-2xs ${active ? "text-accent" : "text-faint"}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {shelf.count}
      </Text>
    </Pressable>
  );
}

function ShelfChip({
  shelf,
  active,
  onPress,
}: {
  shelf: Shelf;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={`flex-row items-center gap-1.5 rounded-pill border px-3 py-1.5 ${
        active ? "border-accent bg-accent-soft" : "border-border bg-raised"
      }`}
    >
      <Text
        className={`text-sm ${active ? "font-semibold text-accent" : "text-muted"}`}
      >
        {shelf.depth === 1 ? `↳ ${shelf.name}` : shelf.name}
      </Text>
      <Text
        className={`text-2xs ${active ? "text-accent" : "text-faint"}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {shelf.count}
      </Text>
    </Pressable>
  );
}
