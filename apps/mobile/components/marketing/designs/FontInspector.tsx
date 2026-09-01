/**
 * MARKETING · Designs — one face, opened.
 *
 * The specimen again, larger, plus the two things the wall can't fit: the note
 * about what the face is for, and the download link for the device that doesn't
 * have it — which is the ONLY useful thing an unavailable face can offer, and
 * so is the first thing shown in that case rather than the last.
 *
 * The preview goes through the same `SpecimenSample` the wall uses, against the
 * same probe, so the panel and the tile can never disagree about whether a face
 * is showable.
 *
 * The folder checklist at the bottom is the same one every item type gets: a
 * face lives in "Faces", and in the event folder whose posters are set in it.
 * See `ColorInspector` for why an existing row files on the tick rather than on
 * Save.
 */
import { useState } from "react";
import { Linking, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  BRAND_FONT_NAME_MAX,
  BRAND_FONT_NOTES_MAX,
  BRAND_FONT_ROLES,
  BRAND_FONT_ROLE_LABELS,
  type BrandFont,
  type BrandFontRole,
  type DesignFolder,
} from "@events-os/shared";
import { Button, Select, TextField } from "../../ui";
import { FolderChecklist } from "./FolderChecklist";
import type { ActionRunner } from "../../../lib/useActionToast";
import { Inspector, ReorderControls } from "./Inspector";
import { asId, neighbourFor, swappedIds } from "./ids";
import { hasFontFamily } from "./fontProbe";
import { resolveSpecimen } from "./fontSpecimen.shared";
import { SpecimenSample } from "./Specimen";

const ROLE_OPTIONS = BRAND_FONT_ROLES.map((role) => ({
  value: role,
  label: BRAND_FONT_ROLE_LABELS[role],
}));

const EMPTY = {
  name: "",
  role: "headline" as BrandFontRole,
  sourceUrl: "",
  notes: "",
};

export function FontInspector({
  font,
  fonts,
  folders,
  seedFolderIds,
  canEdit,
  run,
  onClose,
}: {
  font: BrandFont | null;
  /** Every face — reordering sends the whole flat list. */
  fonts: BrandFont[];
  /** Every folder, for the filing checklist. */
  folders: DesignFolder[];
  /** Folders a NEW face starts in — the one it was added from. */
  seedFolderIds: string[];
  canEdit: boolean;
  run: ActionRunner["run"];
  onClose: () => void;
}) {
  const upsertFont = useMutation(api.marketingDesigns.upsertFont);
  const deleteFont = useMutation(api.marketingDesigns.deleteFont);
  const reorderFonts = useMutation(api.marketingDesigns.reorderFonts);
  const setItemFolders = useMutation(api.marketingDesigns.setItemFolders);

  const [draft, setDraft] = useState(
    font
      ? {
          name: font.name,
          role: font.role,
          sourceUrl: font.sourceUrl ?? "",
          notes: font.notes ?? "",
        }
      : EMPTY,
  );

  const [folderIds, setFolderIds] = useState<string[]>(
    font ? font.folderIds : seedFolderIds,
  );

  /** A new face files on save; an existing one files on the tick. */
  function file(next: string[]) {
    setFolderIds(next);
    if (!font) return;
    void run(
      () =>
        setItemFolders({
          kind: "font",
          itemId: font.id,
          folderIds: next.map(asId),
        }),
      { errorTitle: "Couldn't file that face" },
    );
  }

  // Follows the NAME being typed, so adding a face tells you immediately
  // whether this device can show it — which is the moment the "where to get
  // it" link stops being optional.
  const specimen = resolveSpecimen(draft.name || (font?.name ?? ""), hasFontFamily);
  const shownName = draft.name.trim() || font?.name || "";

  function save() {
    void run(
      () =>
        upsertFont({
          ...(font ? { fontId: asId(font.id) } : {}),
          name: draft.name.trim(),
          role: draft.role,
          ...(draft.sourceUrl.trim() ? { sourceUrl: draft.sourceUrl.trim() } : {}),
          ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
          // Create only — see `ColorInspector`'s note.
          ...(font ? {} : { folderIds: folderIds.map(asId) }),
        }),
      { errorTitle: "Couldn't save that face", onSuccess: onClose },
    );
  }

  function move(delta: 1 | -1) {
    if (!font) return;
    const other = neighbourFor(fonts, font.id, delta);
    if (!other) return;
    void run(
      () =>
        reorderFonts({
          fontIds: swappedIds(fonts, font.id, other.id).map(asId),
        }),
      { errorTitle: "Couldn't reorder" },
    );
  }

  const index = font ? fonts.findIndex((f) => f.id === font.id) : -1;
  const source = font?.sourceUrl ?? null;

  return (
    <Inspector
      title={font ? font.name : "New face"}
      subtitle={font ? BRAND_FONT_ROLE_LABELS[font.role] : "A face the org sets words in"}
      onClose={onClose}
      footer={
        canEdit ? (
          <>
            <Button
              title={font ? "Save" : "Add face"}
              size="sm"
              disabled={!draft.name.trim()}
              onPress={save}
            />
            {font ? (
              <Button
                title="Remove"
                size="sm"
                variant="ghost"
                onPress={() =>
                  void run(() => deleteFont({ fontId: asId(font.id) }), {
                    errorTitle: "Couldn't delete that face",
                    onSuccess: onClose,
                  })
                }
              />
            ) : null}
          </>
        ) : undefined
      }
    >
      {shownName ? (
        <View className="mb-4 rounded-lg border border-border bg-sunken px-4 py-5">
          <SpecimenSample specimen={specimen} name={shownName} scale={1.35} />
        </View>
      ) : null}

      {source ? (
        <View className="mb-4 flex-row items-center gap-3">
          <Button
            title="Get the file"
            icon="external-link"
            size="sm"
            variant="secondary"
            onPress={() => void Linking.openURL(source)}
          />
          {specimen.status === "unavailable" ? (
            <Text className="flex-1 text-xs text-muted">
              Install it and this card starts showing the real thing.
            </Text>
          ) : null}
        </View>
      ) : specimen.status === "unavailable" ? (
        <Text className="mb-4 text-xs text-muted">
          No download link on this face yet — ask marketing where the file
          lives, and add it here so the next person doesn&apos;t have to.
        </Text>
      ) : null}

      {!canEdit && font?.notes ? (
        <Text className="text-base leading-6 text-muted">{font.notes}</Text>
      ) : null}

      {canEdit ? (
        <>
          {font && index >= 0 ? (
            <ReorderControls
              label={font.name}
              onEarlier={() => move(-1)}
              onLater={() => move(1)}
              earlierDisabled={index === 0}
              laterDisabled={index === fonts.length - 1}
            />
          ) : null}
          <TextField
            label="Typeface"
            value={draft.name}
            onChangeText={(name) => setDraft({ ...draft, name })}
            maxLength={BRAND_FONT_NAME_MAX}
            hint="The face's real name, as you'd search for it — the preview above is set in it, when this device has it."
          />
          <Select
            label="Used for"
            value={draft.role}
            options={ROLE_OPTIONS}
            onChange={(role) => setDraft({ ...draft, role: role as BrandFontRole })}
            hint="The list is fixed so the kit keeps sorting — three people writing “headings”, “Headings” and “titles” is how it stops."
          />
          <TextField
            label="Where to get it"
            value={draft.sourceUrl}
            onChangeText={(sourceUrl) => setDraft({ ...draft, sourceUrl })}
            autoCapitalize="none"
            hint="A download or Google Fonts link. Empty is honest; a dead link is not."
          />
          <TextField
            label="Notes"
            value={draft.notes}
            onChangeText={(notes) => setDraft({ ...draft, notes })}
            maxLength={BRAND_FONT_NOTES_MAX}
            multiline
            numberOfLines={3}
            hint="Anything to know before using it — weights we own, tracking, what not to do with it."
          />
          <FolderChecklist
            folders={folders}
            value={folderIds}
            onChange={file}
            hint="Faces, and any event or campaign folder whose work is set in it."
          />
        </>
      ) : null}
    </Inspector>
  );
}
