/**
 * MARKETING · Designs — the brand kit and the design library, as a WORKSTATION.
 *
 * The tab the marketing team asked for in as many words: "their own marketing
 * hub where they can edit and create and be creative." Before this, the brand
 * lived in a pinned Slack message and a Canva account — the hex codes were in
 * one person's head, the templates were findable only by asking, and a
 * volunteer making a flyer at 11pm guessed.
 *
 * ── Why this screen was rebuilt ─────────────────────────────────────────────
 * The first cut answered all three questions and looked like a settings page
 * doing it: every element was a line of text with a pencil beside it. The
 * founder's read was exact — "what's the point of this page? it just looks like
 * an editor, but no viewer. I was expecting a work station where people can
 * view and edit elements here and folders and stuff." That is the right
 * complaint about the one room in the OS whose entire subject is what things
 * LOOK like. The approved redesign changes five things:
 *
 *  1. Colors are a wall of swatches, not a table of hexes. (`SwatchWall`)
 *  2. Faces are specimens set in themselves — or an honest "this device doesn't
 *     have it" plus the download. (`SpecimenWall`, `designs/fontSpecimen.shared`)
 *  3. Files are a grid of LIVE previews on web — every Canva/Figma tile
 *     renders its real embed, per the founder's later call ("just render the
 *     iframe for all of them"); stills and stored thumbnails remain the
 *     fallback and the native answer. (`DesignGrid`, `DesignInspector`)
 *  4. Folders are navigated from a rail rather than scrolled past, and an empty
 *     shelf asks for its first file instead of reporting a zero. (`FolderRail`)
 *  5. Editing moved into the viewer panel, so the browse surface stays a browse
 *     surface. No row anywhere carries a pencil and a bin. (`Inspector`)
 *
 * ── Everyone can read it. That is the feature ───────────────────────────────
 * `marketingDesigns.library` is readable by anyone signed in and there is no
 * view power to hold. `canEdit` only decides whether the edit affordances
 * render; a volunteer with no marketing power at all gets the full library,
 * every copy button and every "Open in Canva" — no toolbar Add buttons, no
 * folder settings, and a viewer panel with no fields and no footer beyond a
 * copy. There is deliberately NO lock screen here, unlike `SiteView`: on that
 * screen there is nothing worth reading that the public page doesn't show
 * better, and on this one the reading IS the point.
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
import { ComponentRef, useRef, useState } from "react";
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
  isVirtualShelf,
  resolveShelf,
  shelfLabel,
  visibleColors,
  visibleDesigns,
  visibleFonts,
  type ShelfId,
} from "./designs/library.shared";

/** Below this the rail becomes a strip of chips above the canvas. Matches the
 *  mockup's own breakpoint. */
const RAIL_MIN_WIDTH = 900;

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
  const wide = useWindowDimensions().width >= RAIL_MIN_WIDTH;

  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [shelf, setShelf] = useState<ShelfId>(SHELF_ALL);
  const [inspect, setInspect] = useState<Inspect | null>(null);
  /** A non-error outcome that still needs saying — today, where a deleted
   *  folder's designs went. `useActionRunner` only surfaces failures, and this
   *  is not one. Same pattern as `MailingListView`. */
  const [notice, setNotice] = useState<string | null>(null);

  // The rail is a table of contents for one scrolling canvas, so it needs the
  // offsets of the three sections. Same arrangement `project/[id]` uses to jump
  // to its money section: the scroller belongs to `Screen`, and which offset to
  // scroll to is something only this page knows.
  const scrollRef = useRef<ScrollView>(null);
  const shellY = useRef(0);
  const canvasY = useRef(0);
  const sectionY = useRef<Record<string, number>>({});
  const jumpTo = (key: string) => {
    const y = sectionY.current[key];
    if (y === undefined) return;
    scrollRef.current?.scrollTo({
      y: Math.max(0, shellY.current + canvasY.current + y - 12),
      animated: true,
    });
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

  return (
    <Screen maxWidth={1240} scrollRef={scrollRef}>
      <Text className="mt-1 max-w-2xl text-sm leading-5 text-muted">
        Our colors, our faces, and every design file — open to everyone in the
        org.
        {canEdit
          ? " You can edit all of it."
          : " Copy a hex or open a design; the marketing team keeps it up to date."}
      </Text>

      <Toolbar
        query={query}
        setQuery={setQuery}
        view={view}
        setView={setView}
        canEdit={canEdit}
        canAddFolder={folders.length < DESIGN_FOLDER_MAX_COUNT}
        canAddDesign={designs.length < DESIGN_MAX_COUNT}
        onNewFolder={() => setInspect({ kind: "folder", id: null })}
        onNewDesign={() => openDesign(null)}
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

      <View
        onLayout={(e) => {
          shellY.current = e.nativeEvent.layout.y;
        }}
        className={wide ? "flex-row items-start gap-6" : ""}
      >
        {/* On a desk the rail is a column beside the canvas. On a phone it
            becomes a strip of chips, and it moves DOWN to sit directly above
            the grid it filters — folder chips at the top of the page, above the
            colors, would be navigation for a section you can't see yet. */}
        {wide ? (
          <FolderRail
            shelves={shelves}
            activeShelf={activeShelf}
            onSelect={setShelf}
            narrow={false}
            jumps={[
              { key: "colors", label: "Colors", icon: "droplet", onPress: () => jumpTo("colors") },
              { key: "fonts", label: "Faces", icon: "type", onPress: () => jumpTo("fonts") },
              { key: "files", label: "Design files", icon: "image", onPress: () => jumpTo("files") },
            ]}
            footnote={
              canEdit
                ? "Anyone signed in can open the kit. You hold a marketing seat, so you can change it — everything editable lives in the panel a tile opens."
                : "Anyone signed in can open the kit. Changing it needs a marketing seat."
            }
          />
        ) : null}

        <View
          className="min-w-0 flex-1"
          onLayout={(e) => {
            canvasY.current = e.nativeEvent.layout.y;
          }}
        >
          <View
            onLayout={(e) => {
              sectionY.current.colors = e.nativeEvent.layout.y;
            }}
          >
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

          <View
            onLayout={(e) => {
              sectionY.current.fonts = e.nativeEvent.layout.y;
            }}
          >
            <BrandFontsSection
              fonts={visibleFonts(fonts, query)}
              total={fonts.length}
              canEdit={canEdit}
              onOpen={(font: BrandFont) =>
                setInspect({ kind: "font", id: font.id })
              }
              onNew={() => setInspect({ kind: "font", id: null })}
            />
          </View>

          <View
            onLayout={(e) => {
              sectionY.current.files = e.nativeEvent.layout.y;
            }}
          >
            <SectionHeader
              title="Design files"
              count={shown.length}
              right={
                canEdit && activeFolder ? (
                  <Button
                    title="Folder settings"
                    icon="settings"
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      setInspect({ kind: "folder", id: activeFolder.id })
                    }
                  />
                ) : undefined
              }
            />

            {wide ? null : (
              <FolderRail
                shelves={shelves}
                activeShelf={activeShelf}
                onSelect={setShelf}
                narrow
              />
            )}

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

            {/* The rail carries this line on a desk; on a phone the rail is a
                strip of chips with no room for it, so it lands here. Who may
                change the kit is worth saying on both. */}
            {wide ? null : (
              <Text className="mt-4 text-2xs leading-4 text-faint">
                {canEdit
                  ? "Anyone signed in can open the kit. You hold a marketing seat, so you can change it — everything editable lives in the panel a tile opens."
                  : "Anyone signed in can open the kit. Changing it needs a marketing seat."}
              </Text>
            )}
          </View>
        </View>
      </View>

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

// ── The toolbar ──────────────────────────────────────────────────────────────

/**
 * Search, density, and the two "add" affordances.
 *
 * The search box is built here rather than with `TextField` because a labelled
 * form row is the wrong shape in a toolbar — it would add a heading and 12px of
 * margin to a control whose whole job is to be a slot you type into.
 */
function Toolbar({
  query,
  setQuery,
  view,
  setView,
  canEdit,
  canAddFolder,
  canAddDesign,
  onNewFolder,
  onNewDesign,
}: {
  query: string;
  setQuery: (next: string) => void;
  view: "grid" | "list";
  setView: (next: "grid" | "list") => void;
  canEdit: boolean;
  canAddFolder: boolean;
  canAddDesign: boolean;
  onNewFolder: () => void;
  onNewDesign: () => void;
}) {
  return (
    <View className="mb-5 mt-4 flex-row flex-wrap items-center gap-2">
      <View className="min-w-[180px] flex-1 flex-row items-center gap-2 rounded-pill border border-border bg-raised px-3.5 py-2">
        <Icon name="search" size={14} color={colors.faint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search the kit"
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
        <>
          <Button
            title="New folder"
            icon="folder-plus"
            size="sm"
            variant="ghost"
            disabled={!canAddFolder}
            onPress={onNewFolder}
          />
          <Button
            title="Add design"
            icon="plus"
            size="sm"
            disabled={!canAddDesign}
            onPress={onNewDesign}
          />
        </>
      ) : null}
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
