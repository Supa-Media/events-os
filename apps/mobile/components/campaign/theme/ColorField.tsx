/**
 * COLOR FIELD — the app's first colour picker, written as a GENERAL primitive.
 *
 * Before this, the only way to choose a colour anywhere in Chapter OS was
 * `SiteMapEditor`'s swatch row: a hardcoded list of six brand pastels, no
 * arbitrary values, no text entry, welded to the site-map's own
 * `optionColor()` helper. That is a palette PICKER, not a colour field, and
 * it can't express "our maroon is #891d1a".
 *
 * So this deliberately takes nothing from the campaign theme editor that
 * commissioned it — no `EmailTheme`, no token names, no email vocabulary. It
 * is a labelled control over one hex string, and the next screen that needs a
 * colour (a chapter's brand accent, an event's site-map beyond the six
 * pastels, a give-page style) should reach for it as-is. If it ever grows a
 * second consumer it belongs in `components/ui/` proper; it starts here
 * because "extract on second use" beats guessing at the general shape.
 *
 * ── Three ways in, on purpose ──────────────────────────────────────────────
 *  1. The SWATCH. On web it's the browser's own `<input type="color">` — a
 *     real eyedropper-and-wheel picker, free, and the same `createElement`
 *     idiom `app/(app)/event/new.tsx` uses for `<input type="date">`. On
 *     native (no colour-picker dependency ships with the app) tapping the
 *     swatch expands the suggestions instead.
 *  2. The HEX FIELD, because a designer working from a brand sheet has the
 *     value already and typing it is faster than hunting for it on a wheel.
 *     A leading `#` is optional — `891d1a` is accepted.
 *  3. SUGGESTIONS — a row of caller-supplied values. Not a generic rainbow:
 *     the useful suggestion is "the colours the rest of this system already
 *     uses".
 *
 * ── Why a local draft ──────────────────────────────────────────────────────
 * `onChange` only fires for a VALID hex. Half-typed input (`#8`, `#89`) is
 * held in local state instead of being pushed upstream, so a live preview
 * driven off this value doesn't strobe through nonsense colours on every
 * keystroke — and an invalid draft says so inline rather than silently
 * reverting.
 */
import { createElement, useEffect, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { isHexColor } from "@events-os/shared";
import { Icon } from "../../ui";
import { colors, radius } from "../../../lib/theme";

const SWATCH_SIZE = 34;

export function ColorField({
  label,
  value,
  onChange,
  help,
  suggestions = [],
}: {
  label: string;
  /** The current colour as `#rgb` / `#rrggbb`. */
  value: string;
  /** Called only with a VALID hex — never with a half-typed draft. */
  onChange: (hex: string) => void;
  help?: string;
  /** Values offered as one-tap swatches under the field. */
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState(value);
  const [expanded, setExpanded] = useState(false);

  // Re-sync when the value changes from OUTSIDE (a preset applied, a theme
  // switched, "start from the light values"). Without this the field would
  // keep showing whatever was last typed into it.
  useEffect(() => setDraft(value), [value]);

  const valid = isHexColor(draft);

  function handleText(next: string) {
    setDraft(next);
    const candidate = next.trim();
    if (isHexColor(candidate)) {
      onChange(candidate);
    } else if (isHexColor(`#${candidate}`)) {
      // Pasting from a brand sheet usually loses the leading #.
      onChange(`#${candidate}`);
    }
  }

  function commit(hex: string) {
    setDraft(hex);
    onChange(hex);
  }

  return (
    <View className="mb-3">
      <View className="mb-1.5 flex-row items-baseline gap-2">
        <Text className="text-sm font-semibold text-ink">{label}</Text>
        {help ? <Text className="flex-1 text-2xs text-faint">{help}</Text> : null}
      </View>

      <View className="flex-row items-center gap-2">
        <Swatch
          value={valid ? draft : value}
          onPickWeb={commit}
          onPressNative={() => setExpanded((e) => !e)}
          label={label}
        />
        <TextInput
          value={draft}
          onChangeText={handleText}
          placeholder="#891d1a"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={7}
          accessibilityLabel={`${label} hex value`}
          className={`flex-1 rounded-md border bg-raised px-3 py-2 text-base text-ink ${
            valid ? "border-border-strong" : "border-danger"
          }`}
        />
        {suggestions.length > 0 ? (
          <Pressable
            onPress={() => setExpanded((e) => !e)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`${expanded ? "Hide" : "Show"} suggested colours for ${label}`}
            accessibilityState={{ expanded }}
            className="rounded p-1.5 active:bg-sunken web:hover:bg-sunken"
          >
            <Icon name={expanded ? "chevron-up" : "chevron-down"} size={15} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>

      {!valid ? (
        <Text className="mt-1 text-2xs text-danger">
          Not a colour yet — use a hex value like #891d1a.
        </Text>
      ) : null}

      {expanded && suggestions.length > 0 ? (
        <View className="mt-2 flex-row flex-wrap items-center gap-1.5">
          {suggestions.map((hex) => (
            <Pressable
              key={hex}
              onPress={() => commit(hex)}
              accessibilityRole="button"
              accessibilityLabel={`Use ${hex}`}
              className="active:opacity-70"
            >
              {/* Concentric rings, the `SiteMapEditor` swatch idiom: the outer
                  ring carries the selected state so the colour itself is never
                  tinted or outlined by the selection. */}
              <View
                className="h-7 w-7 items-center justify-center rounded-pill"
                style={{
                  borderWidth: hex === draft ? 2 : 1,
                  borderColor: hex === draft ? colors.ink : colors.border,
                }}
              >
                <View
                  className="rounded-pill"
                  style={{ width: 18, height: 18, backgroundColor: hex }}
                />
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The colour chip: a real `<input type="color">` on web, a tappable chip on
 *  native (where the app ships no colour-picker dependency). */
function Swatch({
  value,
  onPickWeb,
  onPressNative,
  label,
}: {
  value: string;
  onPickWeb: (hex: string) => void;
  onPressNative: () => void;
  label: string;
}) {
  if (Platform.OS === "web") {
    return createElement("input", {
      type: "color",
      // `<input type="color">` only accepts the long form — `#abc` silently
      // resets it to black.
      value: toLongHex(value),
      "aria-label": `${label} colour`,
      onChange: (e: { target: { value: string } }) => onPickWeb(e.target.value),
      style: {
        width: SWATCH_SIZE,
        height: SWATCH_SIZE,
        padding: 2,
        border: `1px solid ${colors.borderStrong}`,
        borderRadius: radius.sm,
        background: colors.raised,
        cursor: "pointer",
      },
    });
  }
  return (
    <Pressable
      onPress={onPressNative}
      accessibilityRole="button"
      accessibilityLabel={`${label} colour swatch`}
      style={{
        width: SWATCH_SIZE,
        height: SWATCH_SIZE,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        backgroundColor: isHexColor(value) ? value : colors.raised,
      }}
    />
  );
}

/** `#abc` → `#aabbcc`; anything already long (or unparseable) is returned
 *  as-is, with a black fallback so the web input never receives garbage. */
export function toLongHex(hex: string): string {
  const h = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(h)) return h;
  if (/^#[0-9a-fA-F]{3}$/.test(h)) {
    return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  return "#000000";
}
