/**
 * THEMES — the designer's own tab, where campaign email branding lives.
 *
 * ── Why this is a top-level tab and not a setting on a campaign ────────────
 * `emailTheme.ts` is explicit that themes are THEME-LEVEL ONLY: blocks
 * inherit, nothing carries its own colour, so a rebrand is one edit rather
 * than fifty and a non-designer can't drift a single campaign off-brand.
 * That model only works if the designer has a place she can open any time —
 * not a panel buried inside whichever campaign happens to be in flight.
 *
 * ── The two lists ──────────────────────────────────────────────────────────
 * Built-in PRESETS (`EMAIL_THEME_PRESETS`, shipped in shared) are read-only:
 * they're the reference the app renders against when an org has saved
 * nothing, and letting them be edited in place would mean an org could break
 * its own fallback. "Duplicate" is the door — copying a preset is the main
 * path to a custom theme, exactly as a designer works from a starting look
 * rather than from a blank palette.
 *
 * SAVED themes are the org's own, and one of them is the default every new
 * campaign resolves against.
 *
 * ── Saving is explicit ─────────────────────────────────────────────────────
 * The composer autosaves; this doesn't. A theme is org-wide and applies to
 * every campaign written after it, so "I was just trying colours" must not be
 * the same gesture as "ship this". The draft lives locally until Save, and
 * `validateEmailTheme` — the same write gate the server uses — is run first
 * so a bad value is named here instead of coming back as a round-trip error.
 *
 * ⚠ BACKEND: `apps/convex/emailThemes.ts` is being written concurrently.
 * This screen is coded against `listThemes` / `createTheme` / `updateTheme` /
 * `setDefaultTheme` / `archiveTheme` / `duplicateTheme`, with the row shape
 * declared in `SavedThemeRow` below. `themeOf` deliberately reads the row
 * through `normalizeEmailTheme` (the contract's permissive READ edge), so it
 * copes whether the row nests its tokens under `theme` or stores them flat.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  DEFAULT_EMAIL_THEME,
  EMAIL_THEME_PRESETS,
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
} from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { ThemeEditor } from "../../../components/campaign/theme/ThemeEditor";

/** One row of `api.emailThemes.listThemes` — see the ⚠ note above. */
type SavedThemeRow = {
  _id: string;
  name: string;
  isDefault?: boolean;
  /** Present when the backend nests the tokens; absent when it stores them
   *  flat on the row. `themeOf` handles both. */
  theme?: unknown;
};

/** What's currently open in the editor. */
type Selection =
  | { kind: "saved"; id: string }
  | { kind: "preset"; name: string }
  | null;

/** Read a stored row as a complete `EmailTheme`, filling any gap from the
 *  default. Total by construction — a malformed row renders on-brand rather
 *  than crashing the screen. */
function themeOf(row: SavedThemeRow): EmailTheme {
  return normalizeEmailTheme(row.theme ?? row);
}

export default function CampaignThemesScreen() {
  const access = useQuery(api.audiences.myCampaignsAccess, {});

  if (access === undefined) return <Screen loading />;
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Campaigns is available to org leadership"
            message="Ask a central Executive Director, Financial Manager, or Marketing Director to grant you campaign compose or approve power."
          />
        </Narrow>
      </Screen>
    );
  }
  return <CampaignThemesBody />;
}

function CampaignThemesBody() {
  const saved = useQuery(api.emailThemes.listThemes, {}) as
    | SavedThemeRow[]
    | undefined;
  const createTheme = useMutation(api.emailThemes.createTheme);
  const updateTheme = useMutation(api.emailThemes.updateTheme);
  const setDefaultTheme = useMutation(api.emailThemes.setDefaultTheme);
  const archiveTheme = useMutation(api.emailThemes.archiveTheme);
  const duplicateTheme = useMutation(api.emailThemes.duplicateTheme);
  const { run, toast, dismiss } = useActionRunner();

  const [selection, setSelection] = useState<Selection>(null);
  const [draft, setDraft] = useState<EmailTheme | null>(null);
  const [saving, setSaving] = useState(false);

  function openSaved(row: SavedThemeRow) {
    setSelection({ kind: "saved", id: row._id });
    setDraft(themeOf(row));
  }

  function openPreset(preset: EmailTheme) {
    setSelection({ kind: "preset", name: preset.name });
    setDraft(preset);
  }

  function close() {
    setSelection(null);
    setDraft(null);
  }

  /** Copy a built-in preset into an editable org theme, then open it. This is
   *  the main path to a custom theme. */
  async function duplicatePreset(preset: EmailTheme) {
    const copy: EmailTheme = { ...preset, name: `${preset.name} (copy)` };
    const id = await run(() => createTheme({ theme: copy }), {
      errorTitle: "Couldn't create the theme",
    });
    if (typeof id === "string") {
      setSelection({ kind: "saved", id });
      setDraft(copy);
    }
  }

  async function save() {
    if (!draft || selection?.kind !== "saved") return;
    // Run the SERVER's own gate locally first: a typo'd hex or an over-long
    // wordmark should be named in the form, not returned as a round trip.
    const validated = validateEmailTheme(draft);
    if (!validated.ok) {
      await run(() => Promise.reject(new Error(validated.error)), {
        errorTitle: "This theme can't be saved yet",
      });
      return;
    }
    setSaving(true);
    try {
      await run(() => updateTheme({ themeId: selection.id, theme: validated.theme }), {
        errorTitle: "Couldn't save the theme",
      });
    } finally {
      setSaving(false);
    }
  }

  if (saved === undefined) return <Screen loading />;

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
                onPress={() => void duplicatePreset(draft)}
              />
            ) : (
              <Button title="Save theme" icon="check" loading={saving} onPress={() => void save()} />
            )}
          </View>
        </View>
        {isPreset ? (
          <Text className="mb-3 text-xs text-muted">
            Built-in themes are the fallback every org renders on, so they
            can&apos;t be edited in place. Duplicate this one to get a copy you
            own.
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
              onPress={() => void duplicatePreset(DEFAULT_EMAIL_THEME)}
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
                key={row._id}
                theme={themeOf(row)}
                isDefault={row.isDefault === true}
                onOpen={() => openSaved(row)}
                actions={
                  <View className="flex-row flex-wrap items-center gap-2">
                    {row.isDefault !== true ? (
                      <Button
                        title="Make default"
                        size="sm"
                        variant="secondary"
                        onPress={() =>
                          void run(() => setDefaultTheme({ themeId: row._id }), {
                            errorTitle: "Couldn't set the default theme",
                          })
                        }
                      />
                    ) : null}
                    <Button
                      title="Duplicate"
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        void run(() => duplicateTheme({ themeId: row._id }), {
                          errorTitle: "Couldn't duplicate the theme",
                        })
                      }
                    />
                    <Button
                      title="Archive"
                      size="sm"
                      variant="ghost"
                      onPress={() =>
                        void run(() => archiveTheme({ themeId: row._id }), {
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

        <SectionHeader title="Built-in" count={EMAIL_THEME_PRESETS.length} />
        <View className="gap-3">
          {EMAIL_THEME_PRESETS.map((preset) => (
            <ThemeRow
              key={preset.name}
              theme={preset}
              onOpen={() => openPreset(preset)}
              actions={
                <Button
                  title="Duplicate to edit"
                  size="sm"
                  variant="secondary"
                  icon="copy"
                  onPress={() => void duplicatePreset(preset)}
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
 * ("Advent") means nothing next to seeing its actual accent, canvas, and
 * card, so the row leads with the colours and the name follows.
 */
function ThemeRow({
  theme,
  isDefault = false,
  onOpen,
  actions,
}: {
  theme: EmailTheme;
  isDefault?: boolean;
  onOpen: () => void;
  actions: React.ReactNode;
}) {
  return (
    <Card onPress={onOpen}>
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <View className="flex-row items-center gap-3">
          <View className="flex-row">
            {[theme.accent, theme.canvas, theme.surface, theme.ink].map((hex, i) => (
              <View
                key={`${hex}-${i}`}
                style={{
                  width: 22,
                  height: 22,
                  backgroundColor: hex,
                  marginLeft: i === 0 ? 0 : -6,
                  borderRadius: 11,
                  borderWidth: 1,
                  borderColor: "#00000014",
                }}
              />
            ))}
          </View>
          <View>
            <View className="flex-row items-center gap-2">
              <Text className="text-base font-semibold text-ink">{theme.name}</Text>
              {isDefault ? <Badge label="Default" tone="success" /> : null}
            </View>
            <Text className="text-xs text-muted">
              {theme.wordmark || "No wordmark"} · {theme.radius}px corners
            </Text>
          </View>
        </View>
        {actions}
      </View>
    </Card>
  );
}
