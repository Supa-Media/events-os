/**
 * MARKETING · Designs — the brand kit and the design library, as a WORKSTATION.
 *
 * The tab the marketing team asked for in as many words: "their own marketing
 * hub where they can edit and create and be creative." Before this, the brand
 * lived in a pinned Slack message and a Canva account — the hex codes were in
 * one person's head, the templates were findable only by asking, and a
 * volunteer making a flyer at 11pm guessed.
 *
 * ── THE FOLDER IS THE PRIMITIVE ─────────────────────────────────────────────
 * This screen used to be three fixed sections: Colors, Faces, Design files,
 * each a different kind of thing with its own rules. It is now ONE idea. A
 * folder holds anything — a color, a face, a Canva link — and a folder can be
 * PINNED, which gives it its own section on the page.
 *
 * So "Colors" is not a section any more; it is a pinned folder that happens to
 * hold four colors, and migration `0085` made it that way so the tab looks
 * unchanged while everything about it became movable. The payoff is the thing
 * that was impossible before: a folder called "Easter 2026" holding the red it
 * uses, the face its posters are set in, and the posters — one place, one
 * concept, no special cases.
 *
 * Membership is many-to-many (`@events-os/shared` argues why): the red is in
 * Colors AND in Easter at once, and removing it from the event does nothing to
 * the palette.
 *
 * ── What is on the page, in order ───────────────────────────────────────────
 *  1. The search box — the one control that acts on everything, so the one
 *     control that stays at the top.
 *  2. THE LIBRARY — the folder rail, and the contents of whichever folder is
 *     selected, drawn by `FolderBody`. Design files lead inside it, which is
 *     the founder's call and holds at every level because the body owns it.
 *  3. Every pinned folder, as its own section (`FolderSection`) — the same
 *     renderer, so a pinned folder and a selected one are the same thing drawn
 *     twice, never two different layouts.
 *
 * The library sits ABOVE the pinned sections deliberately: it is the working
 * surface, and pinning is what saves you from navigating to a folder you want
 * to see every day. Colors and Faces landing one scroll down is the same call
 * the founder made when the kit led the page — "put Design files on the top".
 *
 * ── A folder of an event's photos and clips is just a folder ────────────────
 * "Is there a way we can create a library where we can upload multiple images/
 * vid content ex: WWS or Field Day" — the marketing lead, and the answer is the
 * Upload button on every folder's own header. It drops a batch of files
 * straight into that folder as ordinary designs (`addUploads`), so an event's
 * media is searched, filed, pinned and reordered by everything this tab already
 * does, instead of being a second kind of thing with its own rules.
 *
 * ── Every control lives in the section it acts on ───────────────────────────
 * The library's density toggle and its Add menu are on the library's header;
 * the folders and their New/settings controls are in the rail beside the grid;
 * a pinned folder's Add and settings are on that folder's own header. The page
 * toolbar is a search box and nothing else. That rule is what fixed the first
 * cut of this screen, and the folder model has to keep it or it re-breaks it.
 *
 * ── Everyone can read it. That is the feature ───────────────────────────────
 * `marketingDesigns.library` is readable by anyone signed in and there is no
 * view power to hold. `canEdit` only decides whether the edit affordances
 * render; a volunteer with no marketing power at all gets the full library,
 * every copy button and every "Open in Canva" — no Add menus, no folder
 * controls, and a viewer panel with no fields and no footer beyond a copy.
 *
 * ── Searching looks everywhere ──────────────────────────────────────────────
 * A query while standing in "Flyers" searches the whole library, colors and
 * faces included, and narrows the pinned sections too. Someone typing a
 * filename is asking "where is this", and answering "not on the shelf you
 * happen to be standing on" is what makes people re-upload a file they already
 * have. `shelfContents` owns that rule and a test pins it.
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
  BRAND_COLOR_MAX_COUNT,
  BRAND_FONT_MAX_COUNT,
  DESIGN_FOLDER_MAX_COUNT,
  DESIGN_MAX_COUNT,
  type BrandColor,
  type BrandFont,
  type DesignAsset,
  type DesignLibrary,
  type FolderItemKind,
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
import { FolderRail } from "./designs/FolderRail";
import { FolderBody } from "./designs/FolderBody";
import { FolderSection } from "./designs/FolderSection";
import { AddItemMenu } from "./designs/AddItemMenu";
import { UploadFilesButton } from "./designs/UploadFilesButton";
import { ColorInspector } from "./designs/ColorInspector";
import { FontInspector } from "./designs/FontInspector";
import { DesignInspector } from "./designs/DesignInspector";
import { FolderInspector } from "./designs/FolderInspector";
import {
  SHELF_ALL,
  buildShelves,
  countLabel,
  folderContents,
  isVirtualShelf,
  itemCount,
  pinnedFolders,
  resolveShelf,
  shelfContents,
  shelfLabel,
  unpinnedItems,
  type ShelfId,
} from "./designs/library.shared";
import { liveEmbedIds } from "./designs/DesignGrid";

/** Below this the folder rail becomes a strip of chips above the contents. */
const FOLDER_COLUMN_MIN_WIDTH = 900;

/**
 * What the viewer panel is showing. `id: null` = a new one of that thing, and
 * `seedFolders` is the folder it was added FROM — the shelf you are standing on
 * is the answer to "where should this go" often enough that asking again is
 * friction.
 */
type Inspect =
  | { kind: "color"; id: string | null; seedFolders?: string[] }
  | { kind: "font"; id: string | null; seedFolders?: string[] }
  | { kind: "design"; id: string | null; seedFolders?: string[] }
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
  /** A non-error outcome that still needs saying — today, what happened to the
   *  contents of a deleted folder. `useActionRunner` only surfaces failures,
   *  and this is not one. Same pattern as `MailingListView`. */
  const [notice, setNotice] = useState<string | null>(null);

  const scrollRef = useRef<ScrollView>(null);

  if (library === undefined) return <Screen loading />;

  const { colors: palette, fonts, folders, designs, canEdit } = library;
  const all = { colors: palette, fonts, designs };

  const shelves = buildShelves(folders, all);
  const activeShelf = resolveShelf(shelf, shelves);
  const searching = query.trim().length > 0;
  const activeFolder = isVirtualShelf(activeShelf)
    ? null
    : (folders.find((f) => f.id === activeShelf) ?? null);

  // The pinned sections are the landing view's other half, so they show while
  // you are standing on "Everything" and step aside the moment you ask for
  // something specific: a folder's own contents, or a search. Leaving them up
  // would answer one question with the same cards three times.
  const landing = activeShelf === SHELF_ALL && !searching;
  const sections = landing
    ? pinnedFolders(folders).map((folder) => ({
        folder,
        items: folderContents(all, folders, folder.id, query),
      }))
    : [];

  // On the landing view the library shows what no pinned section is already
  // showing, so the palette is drawn once on the page rather than twice.
  const browsing = landing ? unpinnedItems(all, folders) : all;
  const shown = shelfContents(browsing, folders, activeShelf, query);
  const shelfTotal = landing
    ? itemCount(browsing)
    : searching
      ? // A search escapes the shelf (`shelfContents`), so the total it is a
        // fraction OF is the whole library, not the folder you happened to be
        // standing in — otherwise a match count reads "5 of 1".
        itemCount(all)
      : (shelves.find((s) => s.id === activeShelf)?.count ?? itemCount(all));

  // ONE live-embed budget for the page, not one per section. `GRID_EMBED_MAX`
  // exists to stop the tab mounting hundreds of authenticated frames in one
  // DOM, and a cap applied per section would multiply by the number of pinned
  // folders. Ordered the way the page draws them, so the frames that load are
  // the ones nearest the top.
  const live = liveEmbedIds([
    ...shown.designs,
    ...sections.flatMap((section) => section.items.designs),
  ]);

  /** Kinds that can't take another row anywhere in the library. The Add menu
   *  drops them rather than offering a press the backend will refuse. */
  const full: FolderItemKind[] = [
    ...(palette.length >= BRAND_COLOR_MAX_COUNT ? (["color"] as const) : []),
    ...(fonts.length >= BRAND_FONT_MAX_COUNT ? (["font"] as const) : []),
    ...(designs.length >= DESIGN_MAX_COUNT ? (["design"] as const) : []),
  ];

  /** How many more designs the library can hold — what a bulk upload is
   *  allowed to add in one press, and why the button can say "Library full"
   *  instead of collecting files the mutation would refuse. */
  const room = Math.max(0, DESIGN_MAX_COUNT - designs.length);

  /** Say what a batch upload did. A toast only surfaces failures, and "twelve
   *  photos landed in Field Day" is the confirmation somebody who just watched
   *  a progress counter is owed. */
  function uploaded(count: number, folderName: string | null) {
    setNotice(
      `Added ${count} file${count === 1 ? "" : "s"}${folderName ? ` to “${folderName}”` : " — they're Unfiled until you file them"}.`,
    );
  }

  /** Open a blank inspector of `kind`, pre-filed into `folderId` when there is
   *  one to inherit. */
  function addTo(kind: FolderItemKind, folderId: string | null) {
    const seedFolders = folderId ? [folderId] : [];
    setInspect(
      kind === "color"
        ? { kind: "color", id: null, seedFolders }
        : kind === "font"
          ? { kind: "font", id: null, seedFolders }
          : { kind: "design", id: null, seedFolders },
    );
  }

  const openColor = (color: BrandColor) =>
    setInspect({ kind: "color", id: color.id });
  const openFont = (font: BrandFont) =>
    setInspect({ kind: "font", id: font.id });
  const openDesign = (design: DesignAsset) =>
    setInspect({ kind: "design", id: design.id });

  const permissionLine = canEdit
    ? "Anyone signed in can open the kit. You hold a marketing seat, so you can change it — everything editable lives in the panel a tile opens."
    : "Anyone signed in can open the kit. Changing it needs a marketing seat.";

  return (
    <Screen maxWidth={1240} scrollRef={scrollRef}>
      <Text className="mt-1 max-w-2xl text-sm leading-5 text-muted">
        Every design file, and the colors and faces they&apos;re made of — open
        to everyone in the org.
        {canEdit
          ? " Anything can go in a folder, and a folder can have its own section."
          : " Copy a hex or open a design; the marketing team keeps it up to date."}
      </Text>

      <SearchField query={query} setQuery={setQuery} />

      {notice ? (
        <Card padding="md" className="mb-4 mt-4">
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

      {/* ── The library ──────────────────────────────────────────────────── */}
      <SectionHeader
        wrap
        title="Library"
        count={countLabel(itemCount(shown), shelfTotal)}
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
              <>
                <UploadFilesButton
                  folderId={activeFolder?.id ?? null}
                  room={room}
                  run={run}
                  onUploaded={(count) => uploaded(count, activeFolder?.name ?? null)}
                />
                <AddItemMenu
                  onAdd={(kind) => addTo(kind, activeFolder?.id ?? null)}
                  full={full}
                />
              </>
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
                ? "Everything matching, across every folder"
                : activeShelf !== SHELF_ALL
                  ? `Folders / ${shelfLabel(activeShelf, shelves)}`
                  : sections.length > 0
                    ? "Everything that isn't in a pinned section below"
                    : "Everything in the library"}
            </Text>
          </View>

          <FolderBody
            items={shown}
            palette={palette}
            view={view}
            live={live}
            onOpenColor={openColor}
            onOpenFont={openFont}
            onOpenDesign={openDesign}
            empty={
              <ShelfEmptyState
                searching={searching}
                shelfName={shelfLabel(activeShelf, shelves)}
                everything={activeShelf === SHELF_ALL}
                canEdit={canEdit}
                onAdd={() => addTo("design", activeFolder?.id ?? null)}
              />
            }
          />
        </View>
      </View>

      {/* ── Pinned folders, each its own section ─────────────────────────── */}
      {sections.map(({ folder, items }) => (
        <FolderSection
          key={folder.id}
          folder={folder}
          items={items}
          // The shelf count, not `folder.itemCount`: a pinned parent folder
          // draws its children's things too, so the total has to be of the set
          // actually on screen or the label reads "5 of 3".
          total={shelves.find((s) => s.id === folder.id)?.count ?? folder.itemCount}
          palette={palette}
          view={view}
          live={live}
          canEdit={canEdit}
          full={full}
          room={room}
          run={run}
          onUploaded={(count) => uploaded(count, folder.name)}
          onAdd={(kind) => addTo(kind, folder.id)}
          onOpenFolder={() => setInspect({ kind: "folder", id: folder.id })}
          onOpenColor={openColor}
          onOpenFont={openFont}
          onOpenDesign={openDesign}
        />
      ))}

      {/* One line, one place, both widths. */}
      <Text className="mt-8 max-w-2xl border-t border-border pt-4 text-2xs leading-4 text-faint">
        {permissionLine}
      </Text>

      {inspect?.kind === "color" ? (
        <ColorInspector
          color={inspect.id ? (palette.find((c) => c.id === inspect.id) ?? null) : null}
          palette={palette}
          folders={folders}
          seedFolderIds={inspect.seedFolders ?? []}
          canEdit={canEdit}
          run={run}
          onClose={() => setInspect(null)}
        />
      ) : null}

      {inspect?.kind === "font" ? (
        <FontInspector
          font={inspect.id ? (fonts.find((f) => f.id === inspect.id) ?? null) : null}
          fonts={fonts}
          folders={folders}
          seedFolderIds={inspect.seedFolders ?? []}
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
          group={shown.designs}
          seedFolderIds={inspect.seedFolders ?? []}
          canEdit={canEdit}
          run={run}
          onClose={() => setInspect(null)}
        />
      ) : null}

      {inspect?.kind === "folder" && canEdit ? (
        <FolderInspector
          folder={inspect.id ? (folders.find((f) => f.id === inspect.id) ?? null) : null}
          folders={folders}
          itemCount={
            inspect.id
              ? (shelves.find((s) => s.id === inspect.id)?.count ?? 0)
              : 0
          }
          run={run}
          onClose={() => setInspect(null)}
          onDeleted={(folderName, released) => {
            setShelf(SHELF_ALL);
            if (released > 0) {
              setNotice(
                `Deleted “${folderName}”. ${released} thing${released === 1 ? "" : "s"} left it — nothing was thrown away, and anything that was only in there is now Unfiled.`,
              );
            }
          }}
        />
      ) : null}

      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}

// ── The one page-wide control ────────────────────────────────────────────────

/**
 * The search box — the one control that genuinely acts on the whole page, so
 * the one control that stays at the top of it. It matches colors, faces and
 * files at once, in every folder.
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
 * The state an empty shelf is in — and the point about it: "Signage — 0 files"
 * was reporting a number nobody asked about. An empty shelf asks for its first
 * thing instead, and only a caller who could actually add one is offered the
 * button.
 */
function ShelfEmptyState({
  searching,
  shelfName,
  everything,
  canEdit,
  onAdd,
}: {
  searching: boolean;
  shelfName: string;
  everything: boolean;
  canEdit: boolean;
  onAdd: () => void;
}) {
  if (searching) {
    return (
      <EmptyState
        icon="search"
        title="Nothing matches that"
        message="The search looks in every folder, so this really is everything — try fewer words, or part of a link."
      />
    );
  }
  return (
    <EmptyState
      icon="image"
      title={everything ? "Nothing in the library yet" : `Nothing in ${shelfName} yet`}
      message={
        canEdit
          ? "Paste a Canva or Figma link and it lands here, previews right on its tile, and stays one tap from the editable file. Or press Upload and drop a whole event's photos and clips in at once."
          : "The marketing team hasn't put anything here yet."
      }
      action={
        canEdit ? (
          <Button
            title="Add the first design"
            icon="plus"
            size="sm"
            onPress={onAdd}
          />
        ) : undefined
      }
    />
  );
}
