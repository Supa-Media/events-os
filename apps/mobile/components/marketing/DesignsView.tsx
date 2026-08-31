/**
 * MARKETING · Designs — the brand kit and the design library, as a WORKSTATION.
 *
 * The tab the marketing team asked for in as many words: "their own marketing
 * hub where they can edit and create and be creative." Before this, the brand
 * lived in a pinned Slack message and a Canva account — the hex codes were in
 * one person's head, the templates were findable only by asking, and a
 * volunteer making a flyer at 11pm guessed.
 *
 * ── What the page is ────────────────────────────────────────────────────────
 * Three sections down one canvas — Design files, then Colors and Faces — and
 * each one OWNS everything you do to it:
 *
 *  1. Design files are a grid of LIVE previews on web, with the folders that
 *     file them, the density toggle that shapes them, and the button that adds
 *     one, all inside that section. (`DesignGrid`, `FolderRail`)
 *  2. Colors are a wall of swatches with "Add color" on their own header.
 *     (`SwatchWall`, `BrandKitSection`)
 *  3. Faces are specimens set in themselves — or an honest "this device doesn't
 *     have it" plus the download — in one wrapping wall like the other two,
 *     with "Add face" on their own header. (`SpecimenWall`)
 *
 * ── The files come first ────────────────────────────────────────────────────
 * The brand kit led the page for as long as this tab has existed, and it was
 * the wrong lead: the kit is two rows of reference that barely change, while
 * the library is the thing that grows, the thing a search is aimed at, and the
 * thing somebody opened this tab to get. Founder's call, and the right one —
 * a volunteer at 11pm wants the flyer template, and the red is what they need
 * one scroll later, once they are making something.
 *
 * Editing lives in the viewer panel a tile opens, so no row anywhere carries a
 * pencil and a bin. (`Inspector`)
 *
 * ── Why the page toolbar is only a search box now ───────────────────────────
 * The first cut of the workstation put a page-wide toolbar at the top holding
 * search, the grid/list toggle, "New folder" and "Add design" — and hung the
 * folder rail off the left edge of the WHOLE page, level with the colors. So
 * every control for the design files sat between one and three screens above
 * the design files, and the folder list was a column that had nothing to do
 * with the two sections it stood beside. The founder's read: "the design files
 * and folders are disjointed from the actual controls to handle and add to
 * them and change them."
 *
 * The rule the page now follows is the obvious one: a control lives in the
 * section it acts on. What stayed at the top is the one thing that genuinely
 * acts on the whole page — the search box, which matches colors, faces and
 * files at once — plus a three-pill census that jumps to each section, which
 * is what the old rail's top group was for.
 *
 * ── Everyone can read it. That is the feature ───────────────────────────────
 * `marketingDesigns.library` is readable by anyone signed in and there is no
 * view power to hold. `canEdit` only decides whether the edit affordances
 * render; a volunteer with no marketing power at all gets the full library,
 * every copy button and every "Open in Canva" — no Add buttons, no folder
 * controls, and a viewer panel with no fields and no footer beyond a copy.
 * There is deliberately NO lock screen here, unlike `SiteView`: on that screen
 * there is nothing worth reading that the public page doesn't show better, and
 * on this one the reading IS the point.
 *
 * ── Filing, and the drag that isn't ─────────────────────────────────────────
 * The mockup files a design by dragging its tile onto a folder. This app is one
 * file serving phone, tablet and web, so filing is a picker in the viewer panel
 * instead — one press, identical everywhere, reachable by a screen reader, and
 * saving instantly through `moveDesignToFolder` (the narrow mutation, so a move
 * can never overwrite a title somebody edited in another tab). Same call
 * `LinksView` and the old brand kit made about drag-to-reorder, for the same
 * reason.
 *
 * ── Searching looks everywhere ──────────────────────────────────────────────
 * A query while standing in "Flyers" searches the whole library, colors and
 * faces included. Someone typing a filename is asking "where is this", and
 * answering "not on the shelf you happen to be standing on" is what makes
 * people re-upload a file they already have. `visibleDesigns` owns that rule
 * and a test pins it.
 */
import { useRef, useState } from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  ScrollView,
} from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  DESIGN_FOLDER_MAX_COUNT,
  DESIGN_MAX_COUNT,
  type BrandColor,
  type BrandFont,
  type DesignAsset,
  type DesignLibrary,
} from "@events-os/shared";
import {
  Button,
  Card,
  EmptyState,
  Icon,
  Screen,
  SectionHeader,
  ToastView,
  type IconName,
} from "../ui";
import { colors } from "../../lib/theme";
import { useActionRunner } from "../../lib/useActionToast";
import { BrandColorsSection, BrandFontsSection } from "./BrandKitSection";
import { FolderRail } from "./designs/FolderRail";
import { DesignGrid } from "./designs/DesignGrid";
import { ColorInspector } from "./designs/ColorInspector";
import { FontInspector } from "./designs/FontInspector";
import { DesignInspector } from "./designs/DesignInspector";
import { FolderInspector } from "./designs/FolderInspector";
import {
  SHELF_ALL,
  buildShelves,
  countLabel,
  isVirtualShelf,
  resolveShelf,
  shelfLabel,
  visibleColors,
  visibleDesigns,
  visibleFonts,
  type ShelfId,
} from "./designs/library.shared";

/** Below this the folder rail becomes a strip of chips above the grid. */
const FOLDER_COLUMN_MIN_WIDTH = 900;

/** What the viewer panel is showing. `id: null` = a new one of that thing. */
type Inspect =
  | { kind: "color"; id: string | null }
  | { kind: "font"; id: string | null }
  | { kind: "design"; id: string | null }
  | { kind: "folder"; id: string | null };

export function MarketingDesignsView() {
  // Typed through the shared contract rather than read off the generated API:
  // `DesignLibrary` is what the query is specified to return, and naming it
  // here means this screen breaks loudly at compile time if the wire shape
  // moves, instead of quietly rendering undefined fields.
  const library = useQuery(api.marketingDesigns.library, {}) as
    | DesignLibrary
    | undefined;

  const { run, toast, dismiss } = useActionRunner();
  const wide = useWindowDimensions().width >= FOLDER_COLUMN_MIN_WIDTH;

  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [shelf, setShelf] = useState<ShelfId>(SHELF_ALL);
  const [inspect, setInspect] = useState<Inspect | null>(null);
  /** A non-error outcome that still needs saying — today, where a deleted
   *  folder's designs went. `useActionRunner` only surfaces failures, and this
   *  is not one. Same pattern as `MailingListView`. */
  const [notice, setNotice] = useState<string | null>(null);

  // The census pills are a table of contents for one scrolling canvas, so they
  // need the offsets of the three sections. Same arrangement `project/[id]`
  // uses to jump to its money section: the scroller belongs to `Screen`, and
  // which offset to scroll to is something only this page knows. Each section
  // is a direct child of the page column, so its measured `y` is the offset.
  const scrollRef = useRef<ScrollView>(null);
  const sectionY = useRef<Record<string, number>>({});
  const measure = (key: string) => (event: {
    nativeEvent: { layout: { y: number } };
  }) => {
    sectionY.current[key] = event.nativeEvent.layout.y;
  };
  const jumpTo = (key: string) => {
    const y = sectionY.current[key];
    if (y === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
  };

  if (library === undefined) return <Screen loading />;

  const { colors: palette, fonts, folders, designs, canEdit } = library;

  const shelves = buildShelves(folders, designs);
  const activeShelf = resolveShelf(shelf, shelves);
  const shown = visibleDesigns(designs, folders, activeShelf, query);
  const searching = query.trim().length > 0;
  const activeFolder = isVirtualShelf(activeShelf)
    ? null
    : (folders.find((f) => f.id === activeShelf) ?? null);

  function openDesign(design: DesignAsset | null) {
    setInspect({ kind: "design", id: design?.id ?? null });
  }

  const permissionLine = canEdit
    ? "Anyone signed in can open the kit. You hold a marketing seat, so you can change it — everything editable lives in the panel a tile opens."
    : "Anyone signed in can open the kit. Changing it needs a marketing seat.";

  return (
    <Screen maxWidth={1240} scrollRef={scrollRef}>
      <Text className="mt-1 max-w-2xl text-sm leading-5 text-muted">
        Every design file, and the colors and faces they're made of — open to
        everyone in the org.
        {canEdit
          ? " You can edit all of it."
          : " Copy a hex or open a design; the marketing team keeps it up to date."}
      </Text>

      <SearchField query={query} setQuery={setQuery} />

      <KitCensus
        items={[
          { key: "files", label: "Design files", icon: "image", count: designs.length },
          { key: "colors", label: "Colors", icon: "droplet", count: palette.length },
          { key: "fonts", label: "Faces", icon: "type", count: fonts.length },
        ]}
        onJump={jumpTo}
      />

      {notice ? (
        <Card padding="md" className="mb-4">
          <Text className="text-sm text-ink">{notice}</Text>
          <View className="mt-2 flex-row">
            <Button
              title="Got it"
              size="sm"
              variant="ghost"
              onPress={() => setNotice(null)}
            />
          </View>
        </Card>
      ) : null}

      <View onLayout={measure("files")} className="mt-1">
        {/* Everything this section does to itself is on its own header: how
            dense the tiles are, and adding one. Folders are the rail beside the
            grid, carrying their own. */}
        <SectionHeader
          wrap
          title="Design files"
          count={countLabel(shown.length, designs.length)}
          right={
            <View className="flex-row items-center gap-2">
              <View className="flex-row rounded-pill bg-sunken p-0.5">
                <ViewToggle
                  label="Grid"
                  icon="grid"
                  active={view === "grid"}
                  onPress={() => setView("grid")}
                />
                <ViewToggle
                  label="List"
                  icon="list"
                  active={view === "list"}
                  onPress={() => setView("list")}
                />
              </View>
              {canEdit ? (
                <Button
                  title="Add design"
                  icon="plus"
                  size="sm"
                  disabled={designs.length >= DESIGN_MAX_COUNT}
                  onPress={() => openDesign(null)}
                />
              ) : null}
            </View>
          }
        />

        <View className={wide ? "flex-row items-start gap-6" : ""}>
          <FolderRail
            shelves={shelves}
            activeShelf={activeShelf}
            onSelect={setShelf}
            narrow={!wide}
            canEdit={canEdit}
            canAddFolder={folders.length < DESIGN_FOLDER_MAX_COUNT}
            onNewFolder={() => setInspect({ kind: "folder", id: null })}
            onOpenFolder={(folderId) =>
              setInspect({ kind: "folder", id: folderId })
            }
          />

          <View className="min-w-0 flex-1">
            <View className="mb-3 flex-row items-center gap-1.5">
              <Icon name="folder" size={13} color={colors.faint} />
              <Text className="text-xs text-faint">
                {searching
                  ? "Everything matching, across every shelf"
                  : activeShelf === SHELF_ALL
                    ? "Everything in the library"
                    : `Folders / ${shelfLabel(activeShelf, shelves)}`}
              </Text>
            </View>

            {shown.length > 0 ? (
              <DesignGrid
                designs={shown}
                palette={palette}
                view={view}
                onOpen={openDesign}
              />
            ) : (
              <ShelfEmptyState
                searching={searching}
                shelfName={shelfLabel(activeShelf, shelves)}
                everything={activeShelf === SHELF_ALL}
                canEdit={canEdit}
                onNewDesign={() => openDesign(null)}
              />
            )}
          </View>
        </View>
      </View>

      <View onLayout={measure("colors")}>
        <BrandColorsSection
          palette={visibleColors(palette, query)}
          total={palette.length}
          canEdit={canEdit}
          onOpen={(color: BrandColor) =>
            setInspect({ kind: "color", id: color.id })
          }
          onNew={() => setInspect({ kind: "color", id: null })}
        />
      </View>

      <View onLayout={measure("fonts")}>
        <BrandFontsSection
          fonts={visibleFonts(fonts, query)}
          total={fonts.length}
          canEdit={canEdit}
          onOpen={(font: BrandFont) => setInspect({ kind: "font", id: font.id })}
          onNew={() => setInspect({ kind: "font", id: null })}
        />
      </View>

      {/* One line, one place, both widths — the old rail said this on a desk
          and the page said it again under the grid on a phone. */}
      <Text className="mt-8 max-w-2xl border-t border-border pt-4 text-2xs leading-4 text-faint">
        {permissionLine}
      </Text>

      {inspect?.kind === "color" ? (
        <ColorInspector
          color={inspect.id ? (palette.find((c) => c.id === inspect.id) ?? null) : null}
          palette={palette}
          canEdit={canEdit}
          run={run}
          onClose={() => setInspect(null)}
        />
      ) : null}

      {inspect?.kind === "font" ? (
        <FontInspector
          font={inspect.id ? (fonts.find((f) => f.id === inspect.id) ?? null) : null}
          fonts={fonts}
          canEdit={canEdit}
          run={run}
          onClose={() => setInspect(null)}
        />
      ) : null}

      {inspect?.kind === "design" ? (
        <DesignInspector
          design={inspect.id ? (designs.find((d) => d.id === inspect.id) ?? null) : null}
          designs={designs}
          folders={folders}
          palette={palette}
          group={shown}
          // A design added while standing in a folder lands on that folder —
          // the shelf you are looking at is the answer to "where should this
          // go" often enough that asking again is friction.
          defaultFolderId={activeFolder?.id ?? ""}
          canEdit={canEdit}
          run={run}
          onClose={() => setInspect(null)}
        />
      ) : null}

      {inspect?.kind === "folder" && canEdit ? (
        <FolderInspector
          folder={inspect.id ? (folders.find((f) => f.id === inspect.id) ?? null) : null}
          folders={folders}
          designCount={
            inspect.id
              ? (shelves.find((s) => s.id === inspect.id)?.count ?? 0)
              : 0
          }
          run={run}
          onClose={() => setInspect(null)}
          onDeleted={(folderName, moved) => {
            setShelf(SHELF_ALL);
            if (moved > 0) {
              setNotice(
                `Deleted “${folderName}”. ${moved} design${moved === 1 ? "" : "s"} moved to Unfiled — nothing was thrown away.`,
              );
            }
          }}
        />
      ) : null}

      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}

// ── The two page-wide controls ───────────────────────────────────────────────

/**
 * The search box — the one control that genuinely acts on the whole page, so
 * the one control that stays at the top of it. It matches colors, faces and
 * files at once.
 *
 * Built here rather than with `TextField` because a labelled form row is the
 * wrong shape for a search slot — it would add a heading and 12px of margin to
 * a control whose whole job is to be a box you type into.
 */
function SearchField({
  query,
  setQuery,
}: {
  query: string;
  setQuery: (next: string) => void;
}) {
  return (
    <View className="mt-4 flex-row items-center gap-2 rounded-pill border border-border bg-raised px-3.5 py-2">
      <Icon name="search" size={14} color={colors.faint} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search the kit — colors, faces and files at once"
        placeholderTextColor={colors.faint}
        accessibilityLabel="Search the kit"
        className="flex-1 text-sm text-ink"
      />
      {query.length > 0 ? (
        <Pressable
          onPress={() => setQuery("")}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Clear the search"
        >
          <Icon name="x" size={14} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * What's in the kit, and a way down to it.
 *
 * Replaces the old left rail's "Brand kit" group, which was navigation printed
 * beside the section it pointed at. Three pills under the search box: each one
 * says how many of that thing exist — the census a person opening the tab
 * actually wants — and jumps to its section. The counts are of the WHOLE kit,
 * not of what a search left standing; each section header carries the "2 of 4"
 * when something is narrowing it.
 */
function KitCensus({
  items,
  onJump,
}: {
  items: { key: string; label: string; icon: IconName; count: number }[];
  onJump: (key: string) => void;
}) {
  return (
    <View className="mt-3 flex-row flex-wrap gap-2">
      {items.map((item) => (
        <Pressable
          key={item.key}
          onPress={() => onJump(item.key)}
          accessibilityRole="button"
          accessibilityLabel={`${item.count} ${item.label.toLowerCase()} — jump to them`}
          className="flex-row items-center gap-2 rounded-pill border border-border bg-raised px-3 py-1.5 web:hover:border-border-strong"
        >
          <Icon name={item.icon} size={13} color={colors.muted} />
          <Text className="text-sm text-muted">{item.label}</Text>
          <Text
            className="text-xs font-semibold text-ink"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {item.count}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function ViewToggle({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: "grid" | "list";
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label} view`}
      className={`flex-row items-center gap-1.5 rounded-pill px-3 py-1.5 ${
        active ? "bg-raised shadow-card" : ""
      }`}
    >
      <Icon name={icon} size={13} color={active ? colors.ink : colors.muted} />
      <Text className={`text-xs font-semibold ${active ? "text-ink" : "text-muted"}`}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The state an empty shelf is in — and the mockup's point about it: "Signage —
 * 0 files" was reporting a number nobody asked about. An empty shelf asks for
 * its first file instead, and only a caller who could actually add one is
 * offered the button.
 */
function ShelfEmptyState({
  searching,
  shelfName,
  everything,
  canEdit,
  onNewDesign,
}: {
  searching: boolean;
  shelfName: string;
  everything: boolean;
  canEdit: boolean;
  onNewDesign: () => void;
}) {
  if (searching) {
    return (
      <EmptyState
        icon="search"
        title="Nothing matches that"
        message="The search looks at every shelf, so this really is everything — try fewer words, or part of a link."
      />
    );
  }
  return (
    <EmptyState
      icon="image"
      title={everything ? "No design files yet" : `Nothing on ${shelfName} yet`}
      message={
        canEdit
          ? "Paste a Canva or Figma link and it lands here, previews right on its tile, and stays one tap from the editable file."
          : "The marketing team hasn't put anything here yet."
      }
      action={
        canEdit ? (
          <Button
            title="Add the first design"
            icon="plus"
            size="sm"
            onPress={onNewDesign}
          />
        ) : undefined
      }
    />
  );
}
