/**
 * MARKETING · Designs — one color, opened.
 *
 * A big field of the paint itself (the swatch on the wall is 164px; a color
 * being judged deserves the panel's full width), the hex in one tap, the note
 * about where it's used — and, for a holder, the fields to change all three.
 *
 * The read-only case is not a degraded one: a volunteer gets the paint, the
 * code, the copy button and the sentence, and no footer at all. That is the
 * whole point of the kit being ungated.
 *
 * ── Filing, since a color can be in folders now ─────────────────────────────
 * The checklist below the fields is where a color joins "Colors", "Easter
 * 2026", or both — the same control the face and the design inspectors use. For
 * a color that already exists it saves on every tick through `setItemFolders`,
 * without waiting for Save: filing is not an edit to the row's text, and making
 * somebody press Save to move a swatch is how a form overwrites a name a
 * colleague changed in another tab.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  BRAND_COLOR_NAME_MAX,
  BRAND_COLOR_USAGE_MAX,
  isBrandHex,
  normalizeBrandHex,
  type BrandColor,
  type DesignFolder,
} from "@events-os/shared";
import { Button, CopyButton, TextField } from "../../ui";
import { FolderChecklist } from "./FolderChecklist";
import type { ActionRunner } from "../../../lib/useActionToast";
import { Inspector, ReorderControls } from "./Inspector";
import { asId, neighbourFor, swappedIds } from "./ids";
import { readableInkOn } from "./library.shared";

const EMPTY = { name: "", hex: "", usage: "" };

export function ColorInspector({
  color,
  palette,
  folders,
  seedFolderIds,
  canEdit,
  run,
  onClose,
}: {
  /** The color being looked at, or null when this is a new one. */
  color: BrandColor | null;
  /** The whole palette — reordering sends the entire list. */
  palette: BrandColor[];
  /** Every folder, for the filing checklist. */
  folders: DesignFolder[];
  /** Folders a NEW color starts in — the one it was added from. */
  seedFolderIds: string[];
  canEdit: boolean;
  run: ActionRunner["run"];
  onClose: () => void;
}) {
  const upsertColor = useMutation(api.marketingDesigns.upsertColor);
  const deleteColor = useMutation(api.marketingDesigns.deleteColor);
  const reorderColors = useMutation(api.marketingDesigns.reorderColors);
  const setItemFolders = useMutation(api.marketingDesigns.setItemFolders);

  const [draft, setDraft] = useState(
    color
      ? { name: color.name, hex: color.hex, usage: color.usage ?? "" }
      : EMPTY,
  );
  const [folderIds, setFolderIds] = useState<string[]>(
    color ? color.folderIds : seedFolderIds,
  );

  /** A new color files on save; an existing one files on the tick. */
  function file(next: string[]) {
    setFolderIds(next);
    if (!color) return;
    void run(
      () =>
        setItemFolders({
          kind: "color",
          itemId: color.id,
          folderIds: next.map(asId),
        }),
      { errorTitle: "Couldn't file that color" },
    );
  }

  // The hex is checked with the shared `isBrandHex` as you type rather than on
  // save: the rule (`#rgb` or `#rrggbb`, nothing else) is unusual enough that
  // "rgb(137,29,26)" is a thing people genuinely try, and finding out after a
  // round trip is how a form teaches you to distrust it.
  const hexOk = isBrandHex(draft.hex);
  // The panel's big field of paint follows what is being TYPED once it's a real
  // color, so a hex is judged before it's saved rather than after.
  const shown = hexOk ? normalizeBrandHex(draft.hex) : (color?.hex ?? null);

  function save() {
    void run(
      () =>
        upsertColor({
          ...(color ? { colorId: asId(color.id) } : {}),
          name: draft.name.trim(),
          hex: normalizeBrandHex(draft.hex),
          // Optional free text is sent only when it has something in it; the
          // backend treats a scalar it wasn't sent as cleared, so omitting an
          // emptied box is what clears it.
          ...(draft.usage.trim() ? { usage: draft.usage.trim() } : {}),
          // Only on CREATE: an existing color's folders are already saved,
          // tick by tick, and resending them here would let a stale panel
          // undo a filing somebody made while it was open.
          ...(color ? {} : { folderIds: folderIds.map(asId) }),
        }),
      { errorTitle: "Couldn't save that color", onSuccess: onClose },
    );
  }

  function move(delta: 1 | -1) {
    if (!color) return;
    const other = neighbourFor(palette, color.id, delta);
    if (!other) return;
    void run(
      () =>
        reorderColors({
          colorIds: swappedIds(palette, color.id, other.id).map(asId),
        }),
      { errorTitle: "Couldn't reorder" },
    );
  }

  const index = color ? palette.findIndex((c) => c.id === color.id) : -1;

  return (
    <Inspector
      title={color ? color.name : "New color"}
      subtitle={color ? "Brand color" : "A color the whole org will use"}
      onClose={onClose}
      footer={
        canEdit ? (
          <>
            <Button
              title={color ? "Save" : "Add color"}
              size="sm"
              disabled={!draft.name.trim() || !hexOk}
              onPress={save}
            />
            {color ? (
              <Button
                title="Remove"
                size="sm"
                variant="ghost"
                onPress={() =>
                  void run(() => deleteColor({ colorId: asId(color.id) }), {
                    errorTitle: "Couldn't delete that color",
                    onSuccess: onClose,
                  })
                }
              />
            ) : null}
          </>
        ) : undefined
      }
    >
      {shown ? (
        <View
          className="mb-4 h-32 w-full items-start justify-end rounded-lg border border-border p-3"
          style={{ backgroundColor: shown }}
        >
          <Text
            className="text-sm font-semibold"
            style={{ color: readableInkOn(shown), fontVariant: ["tabular-nums"] }}
          >
            {shown}
          </Text>
        </View>
      ) : null}

      {color ? (
        <View className="mb-4 flex-row items-center gap-3">
          <CopyButton text={color.hex} label />
          <Text className="flex-1 text-xs text-muted">
            The whole reason someone opened this tab.
          </Text>
        </View>
      ) : null}

      {!canEdit && color?.usage ? (
        <Text className="text-base leading-6 text-muted">{color.usage}</Text>
      ) : null}

      {canEdit ? (
        <>
          {color && index >= 0 ? (
            <ReorderControls
              label={color.name}
              onEarlier={() => move(-1)}
              onLater={() => move(1)}
              earlierDisabled={index === 0}
              laterDisabled={index === palette.length - 1}
            />
          ) : null}
          <TextField
            label="Name"
            value={draft.name}
            onChangeText={(name) => setDraft({ ...draft, name })}
            maxLength={BRAND_COLOR_NAME_MAX}
            hint="What the team calls it — “PW Red”."
          />
          <TextField
            label="Hex"
            value={draft.hex}
            onChangeText={(hex) => setDraft({ ...draft, hex })}
            autoCapitalize="none"
            maxLength={7}
            placeholder="#891d1a"
            hint="A hex code only — #891d1a or #891. Not rgb() and not a color name, so two people typing our red get the same bytes."
          />
          {draft.hex.trim() && !hexOk ? (
            <Text className="mb-3 text-xs text-danger">
              That isn&apos;t a hex code. It needs to look like #891d1a.
            </Text>
          ) : null}
          <TextField
            label="Where it's used"
            value={draft.usage}
            onChangeText={(usage) => setDraft({ ...draft, usage })}
            maxLength={BRAND_COLOR_USAGE_MAX}
            multiline
            numberOfLines={3}
            hint="The half people actually need — “headlines and the donate button”."
          />
          <FolderChecklist
            folders={folders}
            value={folderIds}
            onChange={file}
            hint="A color can be in as many as it belongs in — the palette, and every event that uses it."
          />
        </>
      ) : null}
    </Inspector>
  );
}
