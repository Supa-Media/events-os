/**
 * MARKETING · Designs — the brand kit: what our colors are, and what to set
 * words in.
 *
 * The top half of the Designs tab, and the half that gets opened at 11pm. The
 * question a volunteer arrives with is never "show me the brand system", it is
 * "what red is our red" — so the whole section is built around getting a hex
 * onto the clipboard in one tap, with a real swatch beside it so you can tell
 * at a glance you grabbed the right one.
 *
 * ── Read-only is the normal case, not the locked-out case ───────────────────
 * `library.canEdit` only decides whether the edit affordances render. Everyone
 * signed in sees the colors, the fonts and the copy buttons; nobody gets a lock
 * screen. That is the point of the feature (`marketingDesigns.ts`: "Nobody
 * should have to ask permission to look right") — a brand kit behind a
 * permission is a brand kit people work around, which produces the exact
 * inconsistency it exists to prevent.
 *
 * ── Fonts are grouped, colors are not ───────────────────────────────────────
 * A color list is answered by scanning; a font list is answered by a question
 * ("what do I set a headline in?") that the role IS. So fonts group under
 * `BRAND_FONT_ROLE_LABELS` and colors stay one ordered list — the order being
 * the team's own idea of primary-first, which is why it's reorderable at all.
 *
 * ── Reordering ──────────────────────────────────────────────────────────────
 * Up/down buttons, not drag, for the reason `LinksView` writes down: one file
 * serves phone, web and tablet, and a drag that works on all three is a
 * gesture-handler dependency plus a pile of platform branches for a list twelve
 * rows long. Each press sends the WHOLE new order, which cannot leave two rows
 * claiming one slot.
 */
import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  BRAND_COLOR_MAX_COUNT,
  BRAND_COLOR_NAME_MAX,
  BRAND_COLOR_USAGE_MAX,
  BRAND_FONT_MAX_COUNT,
  BRAND_FONT_NAME_MAX,
  BRAND_FONT_NOTES_MAX,
  BRAND_FONT_ROLES,
  BRAND_FONT_ROLE_LABELS,
  isBrandHex,
  normalizeBrandHex,
  type BrandColor,
  type BrandFont,
  type BrandFontRole,
} from "@events-os/shared";
import {
  Button,
  Card,
  CopyButton,
  Icon,
  SectionHeader,
  Select,
  TextField,
} from "../ui";
import { colors } from "../../lib/theme";
import type { ActionRunner } from "../../lib/useActionToast";

// ── Shared with DesignsView ──────────────────────────────────────────────────
// The three helpers below are used by both halves of this tab. They live here,
// exported, rather than in a fourth file: `DesignsView` already imports this
// section, so the dependency is one-way and a module holding two helpers and a
// six-line component would be more files than it is worth.

/**
 * A row id handed back to a mutation exactly as it arrived.
 *
 * This screen never constructs an id — it reads one off a library row and
 * returns the same string. Casting through `never` (assignable to any
 * parameter type) satisfies the generated `Id<"…">` argument types without four
 * Convex table names being spelled out in the UI layer, where they would be
 * wrong the first time the backend renamed one.
 */
export const asId = (id: string) => id as never;

/**
 * The full id order with two rows swapped, for a `reorder*` mutation.
 *
 * Takes the whole list even when the visible group is a subset (fonts render
 * grouped by role, designs grouped by folder): the mutation replaces the entire
 * order, so a partial list would silently renumber everything it omitted.
 */
export function swappedIds<T extends { id: string }>(
  all: T[],
  aId: string,
  bId: string,
): string[] {
  const ids = all.map((row) => row.id);
  const i = ids.indexOf(aId);
  const j = ids.indexOf(bId);
  if (i < 0 || j < 0) return ids;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return ids;
}

/** The up/down pair. Disabled at the ends rather than hidden, so the row's
 *  controls don't shuffle sideways as you move something to the top. */
export function MoveButtons({
  onUp,
  onDown,
  upDisabled,
  downDisabled,
}: {
  onUp: () => void;
  onDown: () => void;
  upDisabled: boolean;
  downDisabled: boolean;
}) {
  return (
    <>
      <Pressable
        onPress={onUp}
        disabled={upDisabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="Move up"
      >
        <Icon
          name="chevron-up"
          size={18}
          color={upDisabled ? colors.faint : colors.ink}
        />
      </Pressable>
      <Pressable
        onPress={onDown}
        disabled={downDisabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="Move down"
      >
        <Icon
          name="chevron-down"
          size={18}
          color={downDisabled ? colors.faint : colors.ink}
        />
      </Pressable>
    </>
  );
}

/** A small destructive/edit affordance for a dense row, where a text `Button`
 *  would take more width than the content it sits beside. */
function RowAction({
  icon,
  label,
  tone,
  onPress,
}: {
  icon: "edit-2" | "trash-2";
  label: string;
  tone?: "danger";
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon
        name={icon}
        size={16}
        color={tone === "danger" ? colors.danger : colors.muted}
      />
    </Pressable>
  );
}

// ── Colors ───────────────────────────────────────────────────────────────────

const EMPTY_COLOR = { name: "", hex: "", usage: "" };
type ColorDraft = typeof EMPTY_COLOR;

/**
 * One color's form — the same fields for a new color and an existing one,
 * because they are the same fields and a second copy is a second place to
 * forget a bound.
 *
 * The hex is checked with the shared `isBrandHex` as you type rather than on
 * save: the rule (`#rgb` or `#rrggbb`, nothing else) is unusual enough that
 * "rgb(137,29,26)" is a thing people genuinely try, and finding out after a
 * round trip is how a form teaches you to distrust it.
 */
function ColorEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  saveLabel,
}: {
  draft: ColorDraft;
  setDraft: (next: ColorDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
}) {
  const hexOk = isBrandHex(draft.hex);
  return (
    <View>
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
        hint="The half people actually need — “headlines and the donate button”."
      />
      <View className="flex-row items-center gap-2">
        <Button
          title={saveLabel}
          size="sm"
          disabled={!draft.name.trim() || !hexOk}
          onPress={onSave}
        />
        <Button title="Cancel" size="sm" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}

// ── Fonts ────────────────────────────────────────────────────────────────────

const EMPTY_FONT = {
  name: "",
  role: "headline" as BrandFontRole,
  sourceUrl: "",
  notes: "",
};
type FontDraft = typeof EMPTY_FONT;

const ROLE_OPTIONS = BRAND_FONT_ROLES.map((role) => ({
  value: role,
  label: BRAND_FONT_ROLE_LABELS[role],
}));

function FontEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  saveLabel,
}: {
  draft: FontDraft;
  setDraft: (next: FontDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
}) {
  return (
    <View>
      <TextField
        label="Typeface"
        value={draft.name}
        onChangeText={(name) => setDraft({ ...draft, name })}
        maxLength={BRAND_FONT_NAME_MAX}
        hint="The face's real name, as you'd search for it."
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
        hint="A download or Google Fonts link, if it isn't already on everyone's machine."
      />
      <TextField
        label="Notes"
        value={draft.notes}
        onChangeText={(notes) => setDraft({ ...draft, notes })}
        maxLength={BRAND_FONT_NOTES_MAX}
        hint="Anything to know before using it — weights we own, tracking, what not to do with it."
      />
      <View className="flex-row items-center gap-2">
        <Button
          title={saveLabel}
          size="sm"
          disabled={!draft.name.trim()}
          onPress={onSave}
        />
        <Button title="Cancel" size="sm" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}

/** "Get it" — a separate component so the non-null `url` survives into the
 *  press handler as a parameter rather than as a cast on a nullable field. */
function FontSourceButton({ url }: { url: string }) {
  return (
    <Button
      title="Get it"
      icon="external-link"
      size="sm"
      variant="ghost"
      onPress={() => void Linking.openURL(url)}
    />
  );
}

// ── The section ──────────────────────────────────────────────────────────────

export function BrandKitSection({
  colors: palette,
  fonts,
  canEdit,
  run,
}: {
  colors: BrandColor[];
  fonts: BrandFont[];
  canEdit: boolean;
  run: ActionRunner["run"];
}) {
  const upsertColor = useMutation(api.marketingDesigns.upsertColor);
  const deleteColor = useMutation(api.marketingDesigns.deleteColor);
  const reorderColors = useMutation(api.marketingDesigns.reorderColors);
  const upsertFont = useMutation(api.marketingDesigns.upsertFont);
  const deleteFont = useMutation(api.marketingDesigns.deleteFont);
  const reorderFonts = useMutation(api.marketingDesigns.reorderFonts);

  const [editingColor, setEditingColor] = useState<string | null>(null);
  const [colorDraft, setColorDraft] = useState<ColorDraft>(EMPTY_COLOR);
  const [newColor, setNewColor] = useState<ColorDraft | null>(null);

  const [editingFont, setEditingFont] = useState<string | null>(null);
  const [fontDraft, setFontDraft] = useState<FontDraft>(EMPTY_FONT);
  const [newFont, setNewFont] = useState<FontDraft | null>(null);

  /**
   * Optional free text is sent only when it has something in it, and left off
   * entirely when it doesn't — the same shape `LinksView` uses. The backend
   * treats a scalar it wasn't sent as cleared (which is why `upsertDesign`
   * needs explicit `clearImage` flags for the storage fields and nothing else),
   * so omitting an emptied box is what clears it.
   */
  function saveColor(colorId: string | null, d: ColorDraft) {
    void run(
      () =>
        upsertColor({
          ...(colorId ? { colorId: asId(colorId) } : {}),
          name: d.name.trim(),
          hex: normalizeBrandHex(d.hex),
          ...(d.usage.trim() ? { usage: d.usage.trim() } : {}),
        }),
      {
        errorTitle: "Couldn't save that color",
        onSuccess: () => {
          setEditingColor(null);
          setNewColor(null);
        },
      },
    );
  }

  function saveFont(fontId: string | null, d: FontDraft) {
    void run(
      () =>
        upsertFont({
          ...(fontId ? { fontId: asId(fontId) } : {}),
          name: d.name.trim(),
          role: d.role,
          ...(d.sourceUrl.trim() ? { sourceUrl: d.sourceUrl.trim() } : {}),
          ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
        }),
      {
        errorTitle: "Couldn't save that font",
        onSuccess: () => {
          setEditingFont(null);
          setNewFont(null);
        },
      },
    );
  }

  function moveColor(index: number, delta: number) {
    const other = palette[index + delta];
    if (!other) return;
    void run(
      () =>
        reorderColors({
          colorIds: swappedIds(palette, palette[index].id, other.id).map(asId),
        }),
      { errorTitle: "Couldn't reorder" },
    );
  }

  /** Fonts move within their role group, but the order sent is the whole flat
   *  list with those two rows swapped — the group is a view, not the order. */
  function moveFont(group: BrandFont[], index: number, delta: number) {
    const other = group[index + delta];
    if (!other) return;
    void run(
      () =>
        reorderFonts({
          fontIds: swappedIds(fonts, group[index].id, other.id).map(asId),
        }),
      { errorTitle: "Couldn't reorder" },
    );
  }

  const fontGroups = BRAND_FONT_ROLES.map((role) => ({
    role,
    rows: fonts.filter((f) => f.role === role),
  })).filter((g) => g.rows.length > 0);

  return (
    <View>
      <SectionHeader
        title="Brand colors"
        count={palette.length}
        right={
          canEdit && !newColor ? (
            <Button
              title="New color"
              icon="plus"
              size="sm"
              variant="secondary"
              disabled={palette.length >= BRAND_COLOR_MAX_COUNT}
              onPress={() => setNewColor(EMPTY_COLOR)}
            />
          ) : undefined
        }
      />

      {palette.length === 0 ? (
        <Card padding="md" className="mb-3">
          <Text className="text-sm text-muted">
            No colors yet.{" "}
            {canEdit
              ? "Add the ones we actually use — the red, the cream, the ink."
              : "The marketing team hasn't filled this in yet."}
          </Text>
        </Card>
      ) : (
        <Card padding="none" className="mb-3">
          {palette.map((color, index) => (
            <View
              key={color.id}
              className={index > 0 ? "border-t border-border" : ""}
            >
              {editingColor === color.id ? (
                <View className="px-4 py-3">
                  <ColorEditor
                    draft={colorDraft}
                    setDraft={setColorDraft}
                    saveLabel="Save"
                    onSave={() => saveColor(color.id, colorDraft)}
                    onCancel={() => setEditingColor(null)}
                  />
                </View>
              ) : (
                <View className="flex-row items-center gap-3 px-4 py-3">
                  {/* The one place a raw hex belongs in a screen: it is the
                      data, not a design token. */}
                  <View
                    className="h-9 w-9 rounded-md border border-border"
                    style={{ backgroundColor: color.hex }}
                  />
                  <View className="flex-1">
                    <Text
                      className="text-sm font-semibold text-ink"
                      numberOfLines={1}
                    >
                      {color.name}
                    </Text>
                    {color.usage ? (
                      <Text className="text-xs text-muted" numberOfLines={2}>
                        {color.usage}
                      </Text>
                    ) : null}
                  </View>
                  <Text
                    className="text-xs font-semibold text-muted"
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {color.hex}
                  </Text>
                  {/* The whole reason someone opened this tab. */}
                  <CopyButton text={color.hex} label />
                  {canEdit ? (
                    <>
                      <MoveButtons
                        onUp={() => moveColor(index, -1)}
                        onDown={() => moveColor(index, 1)}
                        upDisabled={index === 0}
                        downDisabled={index === palette.length - 1}
                      />
                      <RowAction
                        icon="edit-2"
                        label={`Edit ${color.name}`}
                        onPress={() => {
                          setColorDraft({
                            name: color.name,
                            hex: color.hex,
                            usage: color.usage ?? "",
                          });
                          setEditingColor(color.id);
                        }}
                      />
                      <RowAction
                        icon="trash-2"
                        label={`Delete ${color.name}`}
                        tone="danger"
                        onPress={() =>
                          void run(
                            () => deleteColor({ colorId: asId(color.id) }),
                            { errorTitle: "Couldn't delete that color" },
                          )
                        }
                      />
                    </>
                  ) : null}
                </View>
              )}
            </View>
          ))}
        </Card>
      )}

      {newColor ? (
        <Card padding="md" className="mb-3">
          <Text className="mb-3 text-sm font-semibold text-ink">New color</Text>
          <ColorEditor
            draft={newColor}
            setDraft={setNewColor}
            saveLabel="Add color"
            onSave={() => saveColor(null, newColor)}
            onCancel={() => setNewColor(null)}
          />
        </Card>
      ) : null}

      <SectionHeader
        title="Fonts"
        count={fonts.length}
        right={
          canEdit && !newFont ? (
            <Button
              title="New font"
              icon="plus"
              size="sm"
              variant="secondary"
              disabled={fonts.length >= BRAND_FONT_MAX_COUNT}
              onPress={() => setNewFont(EMPTY_FONT)}
            />
          ) : undefined
        }
      />

      {fontGroups.length === 0 ? (
        <Card padding="md" className="mb-3">
          <Text className="text-sm text-muted">
            No fonts yet.{" "}
            {canEdit
              ? "Add what headlines and body text are set in."
              : "The marketing team hasn't filled this in yet."}
          </Text>
        </Card>
      ) : (
        fontGroups.map((group) => (
          <View key={group.role} className="mb-3">
            <Text className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted">
              {BRAND_FONT_ROLE_LABELS[group.role]}
            </Text>
            <Card padding="none">
              {group.rows.map((font, index) => (
                <View
                  key={font.id}
                  className={index > 0 ? "border-t border-border" : ""}
                >
                  {editingFont === font.id ? (
                    <View className="px-4 py-3">
                      <FontEditor
                        draft={fontDraft}
                        setDraft={setFontDraft}
                        saveLabel="Save"
                        onSave={() => saveFont(font.id, fontDraft)}
                        onCancel={() => setEditingFont(null)}
                      />
                    </View>
                  ) : (
                    <View className="flex-row items-center gap-3 px-4 py-3">
                      <View className="flex-1">
                        <Text
                          className="text-sm font-semibold text-ink"
                          numberOfLines={1}
                        >
                          {font.name}
                        </Text>
                        {font.notes ? (
                          <Text className="text-xs text-muted" numberOfLines={2}>
                            {font.notes}
                          </Text>
                        ) : null}
                      </View>
                      {font.sourceUrl ? (
                        <FontSourceButton url={font.sourceUrl} />
                      ) : null}
                      {canEdit ? (
                        <>
                          <MoveButtons
                            onUp={() => moveFont(group.rows, index, -1)}
                            onDown={() => moveFont(group.rows, index, 1)}
                            upDisabled={index === 0}
                            downDisabled={index === group.rows.length - 1}
                          />
                          <RowAction
                            icon="edit-2"
                            label={`Edit ${font.name}`}
                            onPress={() => {
                              setFontDraft({
                                name: font.name,
                                role: font.role,
                                sourceUrl: font.sourceUrl ?? "",
                                notes: font.notes ?? "",
                              });
                              setEditingFont(font.id);
                            }}
                          />
                          <RowAction
                            icon="trash-2"
                            label={`Delete ${font.name}`}
                            tone="danger"
                            onPress={() =>
                              void run(
                                () => deleteFont({ fontId: asId(font.id) }),
                                { errorTitle: "Couldn't delete that font" },
                              )
                            }
                          />
                        </>
                      ) : null}
                    </View>
                  )}
                </View>
              ))}
            </Card>
          </View>
        ))
      )}

      {newFont ? (
        <Card padding="md" className="mb-3">
          <Text className="mb-3 text-sm font-semibold text-ink">New font</Text>
          <FontEditor
            draft={newFont}
            setDraft={setNewFont}
            saveLabel="Add font"
            onSave={() => saveFont(null, newFont)}
            onCancel={() => setNewFont(null)}
          />
        </Card>
      ) : null}
    </View>
  );
}
