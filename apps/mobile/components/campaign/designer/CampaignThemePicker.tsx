/**
 * RESTYLE THIS CAMPAIGN — the composer's theme picker.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `campaigns.setCampaignTheme` has been fully implemented (and tested) since
 * themes shipped, with no client caller at all: a campaign's theme was stamped
 * ONCE at creation from the scope default, and nothing in the app could ever
 * change it again. A designer who fixed the brand accent on the Themes tab
 * could not apply the fix to the draft already open in front of her — the only
 * way out was to start the campaign again, and there is no delete either.
 *
 * ── Why the COMPOSER and not the campaign record ───────────────────────────
 * A theme is a purely visual choice, and this is the one screen in the app
 * that shows what it does: the live preview beside the block stack repaints
 * the moment a theme lands, so picking is a look-and-decide gesture rather
 * than a guess. The record card next door has no preview and is already the
 * densest surface on the desk (name, subject, preview text, segment, reach,
 * sender). It also keeps the whole "what does this email look like?" job on
 * one screen, which is the same argument `CampaignThemesView` makes for
 * keeping theme AUTHORING on its own tab.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * `"central"`, matching every other campaigns surface (`CampaignsListView`) —
 * this desk has no chapter picker to feed one. `setCampaignTheme` re-checks
 * that a saved theme's scope matches the campaign's and rejects a mismatch,
 * so this is a convenience, not the guard.
 *
 * Offered only while the campaign is editable (`draft`/`changes_requested`);
 * the server enforces the same window via `assertEditable`, since restyling a
 * campaign under review would mean a reviewer approved one email and a
 * different-looking one went out.
 *
 * ── Also the TEMPLATE picker ───────────────────────────────────────────────
 * `DocumentComposer` renders this for whatever document it's editing, so the
 * same control restyles a saved template through
 * `campaignTemplates.setTemplateTheme`. The name stays `CampaignThemePicker`
 * because the thing it picks is a campaign THEME (`emailThemes`), and a
 * template's theme is the same value in the same place — `doc.theme`.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Icon } from "../../ui";
import { colors } from "../../../lib/theme";

/** Every campaign surface in the app is org-wide today. */
const SCOPE = "central" as const;

type ThemeRow = FunctionReturnType<typeof api.emailThemes.listThemes>[number];

/** Exactly one of the two, as `setCampaignTheme` demands. */
export type ThemeChoice =
  | { themeId: Id<"emailThemes">; presetName?: undefined }
  | { presetName: string; themeId?: undefined };

export function CampaignThemePicker({
  currentThemeName,
  onApply,
}: {
  /** `doc.theme?.name` — the label the document currently carries. Themes are
   *  stored on the document by VALUE (there's no id on `EmailTheme`), so the
   *  name is the only handle the picker has for "this is the one you're on".
   *  A saved theme sharing a preset's name will highlight both; the row's own
   *  Built-in badge is what tells them apart. */
  currentThemeName: string | undefined;
  /** Applies the choice (the caller owns the mutation, because it also has to
   *  fold the result back into the composer's local undo history — see
   *  `DocumentComposer#applyTheme`, and the screen-level `applyTheme` in
   *  `campaign/[id]/design.tsx` / `campaign-template/[id].tsx` that resolves
   *  the theme the server actually wrote). Resolves true when it landed. */
  onApply: (choice: ThemeChoice) => Promise<boolean>;
}) {
  const themes = useQuery(api.emailThemes.listThemes, { scope: SCOPE });
  const [open, setOpen] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);

  async function pick(row: ThemeRow) {
    if (busyName !== null) return;
    setBusyName(row.name);
    try {
      const applied = await onApply(
        row.themeId !== null ? { themeId: row.themeId } : { presetName: row.name },
      );
      if (applied) setOpen(false);
    } finally {
      setBusyName(null);
    }
  }

  return (
    <View className="rounded-lg border border-border bg-raised p-3">
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center gap-2"
      >
        <Icon name={open ? "chevron-up" : "chevron-down"} size={14} color={colors.muted} />
        <View className="flex-1">
          <Text className="text-xs font-bold uppercase tracking-wider text-faint">Theme</Text>
          <Text className="mt-0.5 text-sm text-ink">
            {currentThemeName ?? "Default"}
          </Text>
        </View>
        <Text className="text-xs font-semibold text-accent">{open ? "Close" : "Change"}</Text>
      </Pressable>

      {open ? (
        <View className="mt-3 gap-2">
          {themes === undefined ? (
            <Text className="text-xs text-faint">Loading themes…</Text>
          ) : themes.length === 0 ? (
            <Text className="text-xs text-muted">No themes yet — the Themes tab makes them.</Text>
          ) : (
            themes.map((row) => (
              <ThemeRowButton
                key={`${row.isPreset ? "preset" : "saved"}:${row.themeId ?? row.name}`}
                row={row}
                current={row.name === currentThemeName}
                busy={busyName === row.name}
                disabled={busyName !== null && busyName !== row.name}
                onPress={() => void pick(row)}
              />
            ))
          )}
          <Text className="text-2xs text-faint">
            Restyling repaints every block — colours, fonts and corners all come
            from the theme, so nothing you have written changes.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** One theme: its palette as three swatches, its name, and what kind it is. */
function ThemeRowButton({
  row,
  current,
  busy,
  disabled,
  onPress,
}: {
  row: ThemeRow;
  current: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Use the ${row.name} theme`}
      accessibilityState={{ selected: current, disabled }}
      className={`flex-row items-center gap-3 rounded-md border px-3 py-2 ${
        current ? "border-accent bg-accent-soft" : "border-border bg-surface"
      } ${disabled ? "opacity-40" : "active:bg-sunken web:hover:bg-sunken"}`}
    >
      <View className="flex-row">
        {[row.accent, row.cream, row.contrast].map((hex, i) => (
          <View
            key={hex + i}
            className="h-5 w-5 rounded-full border border-border"
            style={{ backgroundColor: hex, marginLeft: i === 0 ? 0 : -6 }}
          />
        ))}
      </View>
      <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
        {row.name}
      </Text>
      {busy ? <Text className="text-2xs text-muted">Applying…</Text> : null}
      {current ? <Badge label="In use" tone="success" /> : null}
      {row.isDefault ? <Badge label="Default" tone="neutral" /> : null}
      {row.isPreset ? <Badge label="Built-in" tone="neutral" /> : null}
    </Pressable>
  );
}
