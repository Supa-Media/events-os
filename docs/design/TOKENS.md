# Events OS — Design System (Phase 1)

The visual system marries **publicworship.life's warmth** (cream surfaces, dark
reddish "ink" text, a confident red accent, pastel secondaries, a Corben serif +
DM Sans pairing) with the **structure of a desktop work app** (persistent left
sidebar, dense-but-breathable tables, tasteful status pills, hairline borders +
soft shadows, hover/focus affordances).

`lib/theme.ts` is the **runtime source of truth**; its values are mirrored into
`tailwind.config.js` so screens style with NativeWind `className`s and never
hardcode hex. The few runtime-only values (icon tints, the readiness ring's
conic-gradient) import from `lib/theme.ts`.

## Color roles

| Class / token        | Hex       | Use                                   |
| -------------------- | --------- | ------------------------------------- |
| `surface`            | `#FDF6F6` | page background (cream)                |
| `raised`             | `#FFFFFF` | cards, tables, sidebar                 |
| `sunken`             | `#FAEEE9` | hover rows, subtle fills, header bands |
| `ink`                | `#210909` | primary text                          |
| `muted`              | `#7A5A5A` | secondary text (warm, not gray)        |
| `faint`              | `#A98C8C` | tertiary / placeholders                |
| `border`             | `#EFE0DC` | hairline borders                       |
| `border-strong`      | `#E4CFCB` | input / hovered borders                |
| `accent`             | `#D23B3A` | brand red (primary actions, active)    |
| `accent-hover`       | `#922424` | accent hover/pressed                   |
| `accent-soft`        | `#FBE8E8` | accent tint (active nav, badges)       |
| `brand.50…700`       | scale     | `#FBE8E8 → #D23B3A → #922424`          |

**Status semantics** (each has `DEFAULT` + `bg` tint):
`success #2F7D5B / #EAF6F0` · `warn #B4761A / #FBF1DE` · `danger #D23B3A / #FBE8E8`
· `info #4A6BC0 / #D6E5F2`.

**Pastel secondaries** (categories, avatars): `peach #F5E5C7` · `mint #A8D9C4` ·
`lavender #C9A8E0` · `sky #D6E5F2` · `stat-purple #7004B8`.

## Type scale

- **Display / headings** — `font-display` = `Corben_700Bold` (serif).
  Also `font-display-regular` = `Corben_400Regular`.
- **Body / UI** — `font-body` (`DMSans_400Regular`), `font-medium`,
  `font-semibold`, `font-bold` (DM Sans weights).
- Sizes: `2xs 11` · `xs 12` · `sm 13` · `base 15` · `lg 17` · `xl 20` ·
  `2xl 24` · `3xl 30` (each with a tuned line-height).

Fonts load via `@expo-google-fonts/corben` + `@expo-google-fonts/dm-sans` in
`app/_layout.tsx` (`useFonts`), gating render until ready.

## Spacing · radius · elevation

- **Radius**: `sm 6 · md 10 · lg 14 · xl 20 · pill 999`.
- **Shadow** (soft, warm — not heavy SaaS cards):
  `shadow-card` (resting), `shadow-raised` (hover lift), `shadow-pop` (modals).
- **Density**: tables use `px-4 py-3` rows with a `py-2.5` header band; cards use
  `p-4`/`p-5`; the content column is centered at `maxWidth` (1080–1180).

## UI kit (`components/ui`)

`Icon` (Feather line icons — no SVG native dep), `Button`
(primary/secondary/ghost/danger · hover+pressed+disabled), `Card`/Surface,
`Table`+`TableHeader`+`HeaderCell`+`Row`+`Cell`, `Badge` (status tones + pastels),
`Pill` (selectable), `Avatar` (deterministic pastel initials), `Readiness`
(`ReadinessRing` conic-gradient on web / `ReadinessBar` / `ReadinessBadge`),
`Field`/`TextField`/`Select`, `EmptyState`, `SectionHeader`, `PageHeader`
(serif title + actions), `SidebarNavItem`, `AppShell` (responsive sidebar ⇄
bottom nav), `PersonPicker`.

Every interactive element implements hover + focus/pressed via React state +
class swaps (react-native-web ignores function-style `Pressable` `style` for
layout, so we never use it).
