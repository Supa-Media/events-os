/**
 * THEMES — the designer's own tab, where campaign email branding lives.
 *
 * The body of `app/(app)/campaigns/themes.tsx`, split out the same way
 * `CampaignsListView` is split out of `campaigns/index.tsx`: the route file
 * keeps only the access gate, the view owns loading, selection, and
 * persistence.
 *
 * ── Why themes are a tab and not a setting on a campaign ───────────────────
 * `emailTheme.ts` is explicit that themes are THEME-LEVEL ONLY: blocks
 * inherit, nothing carries its own colour, so a rebrand is one edit rather
 * than fifty and a non-designer can't drift a single campaign off-brand.
 * That model only works if the designer has a place she can open any time —
 * not a panel buried inside whichever campaign happens to be in flight.
 *
 * ── One list, two kinds of row ─────────────────────────────────────────────
 * `emailThemes.listThemes` returns the org's SAVED themes and the built-in
 * PRESETS in a single flat list, each flagged `isPreset` with a null
 * `themeId`. This screen keeps them visually separate (they behave
 * differently) but never re-derives the presets from the shared package: the
 * backend is the one place that decides what the picker contains, and a
 * second source here would drift the moment a preset is added.
 *
 * Presets are read-only — they're what an org renders on before it has saved
 * anything, and `duplicateTheme` is the only door out of that. Copying a
 * preset is the main path to a custom theme, exactly how a designer works:
 * from a starting look, not from a blank palette.
 *
 * ── Saving is explicit ─────────────────────────────────────────────────────
 * The composer autosaves; this doesn't. A theme is org-wide and applies to
 * every campaign written after it, so "I was just trying colours" must not be
 * the same gesture as "ship this". The draft lives locally until Save, and
 * `validateEmailTheme` — the same write gate `emailThemes.ts` runs — is
 * checked here first so a bad value is named in the form instead of coming
 * back as a round-trip `INVALID_THEME`.
 *
 * Scope is `"central"` throughout, matching `CampaignsListView`: the whole
 * campaigns desk is central-only today and there is no scope picker to feed.
 */
import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import {
  DEFAULT_EMAIL_THEME,
  normalizeEmailTheme,
  validateEmailTheme,
  type EmailTheme,
} from "@events-os/shared";
import {
  Screen,
  Narrow,
  FULL_WIDTH,
  Badge,
  Button,
  Card,
  EmptyState,
  SectionHeader,
  ToastView,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { ThemeEditor } from "./ThemeEditor";

/** One row of the picker — a saved theme or a built-in preset. */
type ThemeView = FunctionReturnType<typeof api.emailThemes.listThemes>[number];

/** Every campaign surface in the app is org-wide today (see the module doc). */
const SCOPE = "central" as const;

/** What's currently open in the editor. Presets have no id, so the two cases
 *  can't collapse into one nullable id. */
type Selection =
  | { kind: "saved"; row: ThemeView }
  | { kind: "preset"; row: ThemeView }
  | null;

/**
 * Read a picker row as a complete `EmailTheme` for editing.
 *
 * `normalizeEmailTheme` is the contract's permissive READ edge: it takes the
 * flat token fields off the row and ignores everything else on it (`themeId`,
 * `isPreset`, `contrastWarnings`), filling any gap from the default rather
 * than throwing. A row written before a token existed still opens.
 *
 * `dark` is the one field it does NOT fill from the default — absence there is
 * meaningful ("this theme declares no dark intent") and is preserved as
 * absence, which is exactly what a form needs: the dark toggle reads off the
 * theme's own state instead of showing "overrides on" for a theme that has
 * none. This function used to restore the row's RAW `dark` over a
 * back-filled one to work around that fill; the fill is gone (see
 * `emailTheme.ts`'s "ABSENCE IS MEANINGFUL" note), and restoring the raw
 * value was itself a small hazard — an unnormalized override would be handed
 * straight back to `validateEmailTheme` on save and rejected as the
 * designer's typo.
 */
function themeOf(row: ThemeView): EmailTheme {
  return normalizeEmailTheme(row);
}

export function CampaignThemesView() {
  const themes = useQuery(api.emailThemes.listThemes, { scope: SCOPE });
  const updateTheme = useMutation(api.emailThemes.updateTheme);
  const setDefaultTheme = useMutation(api.emailThemes.setDefaultTheme);
  const archiveTheme = useMutation(api.emailThemes.archiveTheme);
  const duplicateTheme = useMutation(api.emailThemes.duplicateTheme);
  const { run, toast, dismiss } = useActionRunner();

  const [selection, setSelection] = useState<Selection>(null);
  const [draft, setDraft] = useState<EmailTheme | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function open(row: ThemeView) {
    setSelection(
      row.isPreset || row.themeId === null
        ? { kind: "preset", row }
        : { kind: "saved", row },
    );
    setDraft(themeOf(row));
    setSaveError(null);
  }

  function close() {
    setSelection(null);
    setDraft(null);
    setSaveError(null);
  }

  /** Copy a preset (or another saved theme) into an editable org theme.
   *  `duplicateTheme` takes EXACTLY one of the two sources. */
  async function duplicate(row: ThemeView) {
    await run(
      () =>
        duplicateTheme(
          row.themeId === null
            ? { scope: SCOPE, presetName: row.name }
            : { scope: SCOPE, sourceThemeId: row.themeId },
        ),
      { errorTitle: "Couldn't duplicate the theme" },
    );
    // The list is reactive, so the copy appears on its own; closing the
    // editor puts the designer back where she can see it named.
    close();
  }

  async function save() {
    if (!draft || selection?.kind !== "saved" || selection.row.themeId === null) return;
    // Run the SERVER's own gate locally first: a typo'd hex or an over-long
    // wordmark should be named in the form, not returned as a round trip.
    const validated = validateEmailTheme(draft);
    if (!validated.ok) {
      setSaveError(validated.error);
      return;
    }
    setSaveError(null);
    // Everything from the VALIDATED theme (normalized, trimmed).
    // `validateEmailTheme` returns `normalizeEmailTheme`'s output, which
    // preserves an ABSENT `dark` as absent (it no longer back-fills one from
    // the default theme), so turning the dark section off survives the round
    // trip — `dark` is pulled out of the spread only because it has to be
    // sent as an explicit `null`, below, rather than omitted.
    const { name, dark, ...tokens } = validated.theme;
    setSaving(true);
    try {
      await run(
        () =>
          updateTheme({
            themeId: selection.row.themeId as NonNullable<ThemeView["themeId"]>,
            name,
            ...tokens,
            // `null` is the CLEAR sentinel — `undefined` would mean "leave the
            // stored overrides alone", which is the opposite of what turning
            // the dark section off means.
            dark: dark ?? null,
          }),
        { errorTitle: "Couldn't save the theme" },
      );
    } finally {
      setSaving(false);
    }
  }

  if (themes === undefined) return <Screen loading />;

  const saved = themes.filter((t) => !t.isPreset);
  const presets = themes.filter((t) => t.isPreset);

  // ── Editor ───────────────────────────────────────────────────────────────
  if (selection && draft) {
    const isPreset = selection.kind === "preset";
    return (
      <Screen maxWidth={FULL_WIDTH}>
        <ToastView toast={toast} onDismiss={dismiss} />
        <View className="mb-4 flex-row flex-wrap items-center justify-between gap-3">
          <View className="flex-row items-center gap-2">
            <Text className="font-display text-lg text-ink" numberOfLines={1}>
              {draft.name}
            </Text>
            {isPreset ? <Badge label="Built-in" tone="neutral" /> : null}
          </View>
          <View className="flex-row items-center gap-2">
            <Button title="Back" variant="secondary" onPress={close} />
            {isPreset ? (
              <Button
                title="Duplicate to edit"
                icon="copy"
                onPress={() => void duplicate(selection.row)}
              />
            ) : (
              <Button
                title="Save theme"
                icon="check"
                loading={saving}
                onPress={() => void save()}
              />
            )}
          </View>
        </View>
        {saveError ? (
          <View className="mb-3 rounded-md border border-danger bg-danger-bg px-3 py-2">
            <Text className="text-xs text-ink">{saveError}</Text>
          </View>
        ) : null}
        {isPreset ? (
          <Text className="mb-3 text-xs text-muted">
            Built-in themes are what every org renders on before it saves one of
            its own, so they can&apos;t be edited in place. Duplicate this one to
            get a copy you own.
          </Text>
        ) : null}
        <ThemeEditor theme={draft} onChange={setDraft} readOnly={isPreset} />
      </Screen>
    );
  }

  // ── List ─────────────────────────────────────────────────────────────────
  return (
    <Screen>
      <ToastView toast={toast} onDismiss={dismiss} />
      <Narrow>
        <Text className="mb-1 font-display text-lg text-ink">Email themes</Text>
        <Text className="mb-4 text-sm text-muted">
          Every campaign email is painted from a theme — colours, fonts, corner
          radius, and the wordmark above the card. Edit one here and every
          campaign written afterwards follows.
        </Text>

        <SectionHeader
          title="Your themes"
          count={saved.length}
          right={
            <Button
              title="New theme"
              size="sm"
              icon="plus"
              onPress={() =>
                void run(
                  () =>
                    duplicateTheme({
                      scope: SCOPE,
                      presetName: DEFAULT_EMAIL_THEME.name,
                    }),
                  { errorTitle: "Couldn't create the theme" },
                )
              }
            />
          }
        />
        {saved.length === 0 ? (
          <EmptyState
            icon="droplet"
            title="No saved themes yet"
            message="Duplicate one of the built-in themes below to get an editable copy — that's the quickest way to your own brand."
          />
        ) : (
          <View className="gap-3">
            {saved.map((row) => (
              <ThemeRow
                key={row.themeId ?? row.name}
                row={row}
                onOpen={() => open(row)}
                actions={
                  <View className="flex-row flex-wrap items-center gap-2">
                    {!row.isDefault && row.themeId !== null ? (
                      <Button
                        title="Make default"
                        size="sm"
                        variant="secondary"
                        onPress={() =>
                          void run(
                            () => setDefaultTheme({ themeId: row.themeId! }),
                            { errorTitle: "Couldn't set the default theme" },
                          )
                        }
                      />
                    ) : null}
                    <Button
                      title="Duplicate"
                      size="sm"
                      variant="secondary"
                      onPress={() => void duplicate(row)}
                    />
                    <Button
                      title="Archive"
                      size="sm"
                      variant="ghost"
                      onPress={() =>
                        void run(() => archiveTheme({ themeId: row.themeId! }), {
                          errorTitle: "Couldn't archive the theme",
                        })
                      }
                    />
                  </View>
                }
              />
            ))}
          </View>
        )}

        <SectionHeader title="Built-in" count={presets.length} />
        <View className="gap-3">
          {presets.map((row) => (
            <ThemeRow
              key={`preset:${row.name}`}
              row={row}
              onOpen={() => open(row)}
              actions={
                <Button
                  title="Duplicate to edit"
                  size="sm"
                  variant="secondary"
                  icon="copy"
                  onPress={() => void duplicate(row)}
                />
              }
            />
          ))}
        </View>
      </Narrow>
    </Screen>
  );
}

/**
 * One theme in the list. The swatch strip IS the identity — a theme's name
 * ("Advent") means nothing next to seeing its actual accent, canvas, card,
 * and ink, so the row leads with the colours and the name follows.
 *
 * The contrast count rides along from `listThemes` (which measures both
 * schemes server-side) so a theme with legibility problems is visible before
 * you open it — advisory here exactly as it is in the editor.
 */
function ThemeRow({
  row,
  onOpen,
  actions,
}: {
  row: ThemeView;
  onOpen: () => void;
  actions: ReactNode;
}) {
  return (
    <Card onPress={onOpen}>
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <View className="flex-row items-center gap-3">
          <View className="flex-row">
            {[row.accent, row.canvas, row.surface, row.ink].map((hex, i) => (
              <View
                key={`${hex}-${i}`}
                style={{
                  width: 22,
                  height: 22,
                  backgroundColor: hex,
                  marginLeft: i === 0 ? 0 : -6,
                  borderRadius: 11,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              />
            ))}
          </View>
          <View>
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="text-base font-semibold text-ink">{row.name}</Text>
              {row.isDefault ? <Badge label="Default" tone="success" /> : null}
              {row.contrastWarnings.length > 0 ? (
                <Badge
                  label={`${row.contrastWarnings.length} legibility ${
                    row.contrastWarnings.length === 1 ? "warning" : "warnings"
                  }`}
                  tone="warn"
                />
              ) : null}
            </View>
            <Text className="text-xs text-muted">
              {row.wordmark || "No wordmark"} · {row.radius}px corners
              {row.dark ? " · dark mode set" : ""}
            </Text>
          </View>
        </View>
        {actions}
      </View>
    </Card>
  );
}
