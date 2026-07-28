/**
 * THEME EDITOR — the form + live preview for one `EmailTheme`.
 *
 * Split out of `app/(app)/campaigns/themes.tsx` so the screen owns only
 * loading/selection/persistence and this owns the editing surface, the same
 * division `CampaignsListView` has from `campaigns/index.tsx`.
 *
 * ── Layout ─────────────────────────────────────────────────────────────────
 * Form on the left, live preview on the right, stacking below a breakpoint —
 * the composer's own arrangement (`campaign/[id]/design.tsx`), and for the
 * same reason: every control here is only meaningful against what it does to
 * the email, so the email has to stay on screen while you turn the knobs.
 *
 * ── Nothing here blocks ────────────────────────────────────────────────────
 * Contrast warnings are ADVISORY. `emailThemeContrastWarnings` is explicit
 * that legibility is a judgement the designer owns and a hard block would
 * just teach her to fight the tool — so failures are surfaced with the
 * measured ratio, the required ratio, and WHICH scheme failed (a theme can
 * be perfectly legible in light and unreadable in dark; that's the exact
 * failure mode she reported), and then she ships whatever she wants.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import {
  emailThemeContrastWarnings,
  renderCampaignEmail,
  resolveDarkTheme,
  type EmailTheme,
  type EmailThemeTokens,
} from "@events-os/shared";
import { Card, Field, Select, TextField } from "../../ui";
import EmailHtmlPreview from "../../email/EmailHtmlPreview";
import { ColorField } from "./ColorField";
import { LevelToggle } from "../designer/DesignerControls";
import {
  COLOR_TOKEN_GROUPS,
  darkFromLight,
  fontOptionsFor,
  forceDarkEmailPreview,
  suggestedSwatches,
  themeSampleDocument,
  trackingOptionsFor,
  type ColorTokenKey,
} from "../../../lib/emailThemeEditor";

/** Below this width the preview stacks under the form (composer's value). */
const SPLIT_BREAKPOINT = 960;

/** Radius values offered as one taps, plus the ± step for everything between.
 *  0 / 8 / 16 / 24 are the four the presets actually use. */
const RADIUS_PRESETS = [0, 8, 12, 16, 24] as const;
const RADIUS_STEP = 2;
const RADIUS_MAX = 40;

/** Sample recipient the preview renders against — never sent anywhere. */
const PREVIEW_RECIPIENT = { name: "Ada Lovelace", email: "ada@example.com" };

export function ThemeEditor({
  theme,
  onChange,
  readOnly = false,
}: {
  theme: EmailTheme;
  onChange: (next: EmailTheme) => void;
  /** Built-in presets are shown, not edited — every control goes inert and
   *  the screen offers "Duplicate" as the way to make one editable. */
  readOnly?: boolean;
}) {
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_BREAKPOINT;
  const [scheme, setScheme] = useState<"light" | "dark">("light");

  const set = <K extends keyof EmailTheme>(key: K, value: EmailTheme[K]) => {
    if (!readOnly) onChange({ ...theme, [key]: value });
  };

  const setDark = (key: ColorTokenKey, value: string) => {
    if (readOnly) return;
    onChange({ ...theme, dark: { ...(theme.dark ?? {}), [key]: value } });
  };

  const warnings = useMemo(() => emailThemeContrastWarnings(theme), [theme]);

  const previewHtml = useMemo(() => {
    const html = renderCampaignEmail(themeSampleDocument(theme), {
      recipient: PREVIEW_RECIPIENT,
      unsubscribeUrl: "#",
    });
    return scheme === "dark"
      ? forceDarkEmailPreview(html, resolveDarkTheme(theme).canvas)
      : html;
  }, [theme, scheme]);

  const form = (
    <View className={split ? "flex-1" : undefined}>
      <Card>
        <TextField
          label="Theme name"
          value={theme.name}
          onChangeText={(name) => set("name", name)}
          placeholder="e.g. Advent 2026"
          editable={!readOnly}
        />
        <TextField
          label="Wordmark"
          value={theme.wordmark}
          onChangeText={(wordmark) => set("wordmark", wordmark)}
          placeholder="PUBLIC WORSHIP"
          hint="The small all-caps strip above the card. Leave empty for none."
          editable={!readOnly}
        />
      </Card>

      <SectionLabel>Colours</SectionLabel>
      {COLOR_TOKEN_GROUPS.map((group) => (
        <Card key={group.title}>
          <GroupHeading title={group.title} help={group.help} />
          {group.tokens.map((token) => (
            <ColorField
              key={token.key}
              label={token.label}
              help={token.help}
              value={theme[token.key]}
              onChange={(hex) => set(token.key, hex)}
              suggestions={suggestedSwatches(token.key)}
            />
          ))}
        </Card>
      ))}

      <SectionLabel>Type &amp; shape</SectionLabel>
      <Card>
        <Select
          label="Heading font"
          value={theme.headingFont}
          options={fontOptionsFor(theme.headingFont)}
          onChange={(headingFont) => set("headingFont", headingFont)}
          hint="Email clients can't be relied on to fetch a webfont — each option is a full stack that degrades to something close."
        />
        <Select
          label="Body font"
          value={theme.bodyFont}
          options={fontOptionsFor(theme.bodyFont)}
          onChange={(bodyFont) => set("bodyFont", bodyFont)}
        />
        {/* Letter-spacing is a closed list, not a text field: the value is
            interpolated straight into a style attribute, the write gate
            rejects anything that isn't a bare number-plus-unit, and what's
            being chosen is a look rather than a CSS value. */}
        <Select
          label="Heading letter-spacing"
          value={theme.headingTracking}
          options={trackingOptionsFor(theme.headingTracking)}
          onChange={(headingTracking) => set("headingTracking", headingTracking)}
          hint="The newsletter sets its headings TIGHT — a copy of the palette at default spacing still doesn't look like the brand."
        />
        <Select
          label="Body letter-spacing"
          value={theme.bodyTracking}
          options={trackingOptionsFor(theme.bodyTracking)}
          onChange={(bodyTracking) => set("bodyTracking", bodyTracking)}
        />
        <Field label="Corner radius" hint={`${theme.radius}px`}>
          <View className="flex-row flex-wrap items-center gap-2">
            <LevelToggle
              label="−"
              active={false}
              disabled={readOnly || theme.radius <= 0}
              onPress={() => set("radius", Math.max(0, theme.radius - RADIUS_STEP))}
            />
            <Text className="w-12 text-center text-base text-ink">{theme.radius}</Text>
            <LevelToggle
              label="+"
              active={false}
              disabled={readOnly || theme.radius >= RADIUS_MAX}
              onPress={() => set("radius", Math.min(RADIUS_MAX, theme.radius + RADIUS_STEP))}
            />
            <View className="w-2" />
            {RADIUS_PRESETS.map((r) => (
              <LevelToggle
                key={r}
                label={r === 0 ? "Square" : `${r}`}
                active={theme.radius === r}
                disabled={readOnly}
                onPress={() => set("radius", r)}
              />
            ))}
          </View>
        </Field>
      </Card>

      <SectionLabel>Dark mode</SectionLabel>
      <DarkModeSection
        theme={theme}
        readOnly={readOnly}
        onSetDark={setDark}
        onEnable={() => set("dark", darkFromLight(theme))}
        onDisable={() => set("dark", undefined)}
        onPreviewDark={() => setScheme("dark")}
      />

      <SectionLabel>Legibility</SectionLabel>
      <ContrastWarnings warnings={warnings} />
    </View>
  );

  const preview = (
    <View className={split ? "ml-4 w-[380px]" : "mt-6"}>
      <View className="mb-2 flex-row items-center justify-between gap-2">
        <Text className="text-xs font-bold uppercase tracking-wider text-faint">
          Live preview
        </Text>
        <View className="flex-row gap-1.5">
          <LevelToggle
            label="Light"
            active={scheme === "light"}
            onPress={() => setScheme("light")}
          />
          <LevelToggle
            label="Dark"
            active={scheme === "dark"}
            onPress={() => setScheme("dark")}
          />
        </View>
      </View>
      <EmailHtmlPreview html={previewHtml} height={split ? 620 : 420} />
      <Text className="mt-2 text-2xs text-faint">
        {scheme === "dark"
          ? "The email's own dark-mode rules, forced on — this is what a recipient whose phone is in dark mode sees."
          : "What a recipient in light mode sees."}
      </Text>
    </View>
  );

  return split ? (
    <View className="flex-row">
      {form}
      {preview}
    </View>
  ) : (
    <View>
      {form}
      {preview}
    </View>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text className="mb-2 mt-5 text-xs font-bold uppercase tracking-wider text-muted">
      {children}
    </Text>
  );
}

/** The header on one group of colour fields — what part of the email the
 *  swatches below it paint. */
function GroupHeading({ title, help }: { title: string; help?: string }) {
  return (
    <View className="mb-2.5">
      <Text className="text-2xs font-bold uppercase tracking-wider text-faint">
        {title}
      </Text>
      {help ? <Text className="mt-0.5 text-2xs text-faint">{help}</Text> : null}
    </View>
  );
}

/**
 * The `dark` sub-editor.
 *
 * Hidden behind a toggle because `dark` is OPTIONAL and a theme with no dark
 * intent renders identically in both schemes — which is the correct meaning
 * of "no override", not an omission to nag about. Turning it on seeds every
 * token from the LIGHT values (see `darkFromLight`) rather than guessing an
 * inversion, so the designer starts from something recognisable and moves
 * the three or four tokens that actually need to move.
 */
function DarkModeSection({
  theme,
  readOnly,
  onSetDark,
  onEnable,
  onDisable,
  onPreviewDark,
}: {
  theme: EmailTheme;
  readOnly: boolean;
  onSetDark: (key: ColorTokenKey, value: string) => void;
  onEnable: () => void;
  onDisable: () => void;
  onPreviewDark: () => void;
}) {
  const enabled = theme.dark !== undefined;
  const resolved: EmailThemeTokens = resolveDarkTheme(theme);

  return (
    <Card>
      <View className="mb-3 flex-row flex-wrap items-center gap-2">
        <LevelToggle
          label={enabled ? "Dark overrides on" : "Dark overrides off"}
          active={enabled}
          disabled={readOnly}
          onPress={enabled ? onDisable : onEnable}
        />
        {enabled ? (
          <Pressable
            onPress={onPreviewDark}
            accessibilityRole="button"
            className="rounded-md px-2 py-1 active:bg-sunken web:hover:bg-sunken"
          >
            <Text className="text-xs font-semibold text-accent">Preview in dark →</Text>
          </Pressable>
        ) : null}
      </View>

      {!enabled ? (
        <Text className="text-xs text-muted">
          This theme renders the same in dark mode as in light. That&apos;s fine
          for a theme that already reads well on a dark screen — turn overrides
          on to move the colours that don&apos;t.
        </Text>
      ) : (
        <View>
          <View className="mb-3 flex-row flex-wrap items-center gap-2">
            <LevelToggle
              label="Start from the light values"
              active={false}
              disabled={readOnly}
              onPress={onEnable}
            />
          </View>
          {/* Grouped exactly like the light side, and covering exactly the
              same tokens — a dark editor missing a token is how a theme ends
              up with a cream card that stays cream on a black screen. */}
          {COLOR_TOKEN_GROUPS.map((group) => (
            <View key={group.title}>
              <GroupHeading title={group.title} />
              {group.tokens.map((token) => (
                <ColorField
                  key={token.key}
                  label={token.label}
                  help={token.help}
                  value={resolved[token.key]}
                  onChange={(hex) => onSetDark(token.key, hex)}
                  suggestions={suggestedSwatches(token.key)}
                />
              ))}
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

/**
 * The contrast report. An explicit all-clear when there's nothing to say —
 * silence would be indistinguishable from "the check didn't run".
 *
 * Split by SCHEME rather than listed flat. The token set grew to twelve and
 * the checked pairs with it, so a theme mid-edit can easily show eight or ten
 * of these; as one flat list every row repeated "· light mode"/"· dark mode"
 * and the shape of the problem ("it's fine in light, it's the dark overrides
 * that are wrong" — the exact failure the dark editor exists for) was
 * something the designer had to reconstruct by reading every line. A count
 * per scheme says it at a glance.
 */
function ContrastWarnings({
  warnings,
}: {
  warnings: ReturnType<typeof emailThemeContrastWarnings>;
}) {
  if (warnings.length === 0) {
    return (
      <Card>
        <Text className="text-xs text-success">
          Every text/background pair clears WCAG AA in both light and dark.
        </Text>
      </Card>
    );
  }
  const light = warnings.filter((w) => w.scheme === "light");
  const dark = warnings.filter((w) => w.scheme === "dark");

  return (
    <Card>
      <Text className="mb-3 text-xs text-muted">
        {warnings.length === 1 ? "One pair falls" : `${warnings.length} pairs fall`} below
        WCAG AA. You can still save and send — this is a judgement call, not a
        gate — but each one is text somebody will struggle to read.
      </Text>
      <ContrastScheme title="Light mode" warnings={light} />
      <ContrastScheme title="Dark mode" warnings={dark} />
    </Card>
  );
}

/** One scheme's failures. Renders nothing at all when that scheme is clean —
 *  an empty "Dark mode" heading would read as a section that failed to load,
 *  and the clean half is exactly the half that needs no attention. */
function ContrastScheme({
  title,
  warnings,
}: {
  title: string;
  warnings: ReturnType<typeof emailThemeContrastWarnings>;
}) {
  if (warnings.length === 0) return null;
  return (
    <View className="mb-1">
      <Text className="mb-1.5 text-2xs font-bold uppercase tracking-wider text-faint">
        {title} · {warnings.length}
      </Text>
      {warnings.map((w) => (
        <View
          key={w.id}
          className="mb-2 rounded-md border border-warn-soft bg-warn-bg px-2.5 py-2"
        >
          <Text className="text-xs font-semibold text-ink">{w.label}</Text>
          <Text className="text-2xs text-muted">
            {w.ratio.toFixed(2)}:1 — needs at least {w.required}:1
          </Text>
        </View>
      ))}
    </View>
  );
}
