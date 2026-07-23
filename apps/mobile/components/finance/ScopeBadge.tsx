/**
 * SCOPE BADGE — an always-visible "which money are you looking at" chip for
 * the finance surfaces (founder directive: finance scope must be unmistakable
 * on sight, e.g. in a screenshot with no other chrome visible).
 *
 * The shell's `ContextPill`/`PeekBanner` (`components/ui/AppShell.tsx`) already
 * name the active desk, but neither is guaranteed to survive a tight crop of
 * just the finance content area: the pill is a small corner control, and the
 * peek banner only renders while peeking. This chip renders INSIDE the
 * finance layout's content column instead (see `finances/_layout.tsx`), so
 * every finance tab — not just the Dashboard — carries it, in one of three
 * plainly distinct `Badge` tones (reusing the app's existing status-chip
 * primitive — `components/ui/Badge.tsx` — rather than inventing a new
 * visual language) so the three "whose money is this" states can never be
 * confused for one another:
 *
 *   - Central (own desk)  — `info` tone,    "Central — all chapters"
 *   - Chapter (own desk)  — `success` tone, "{Chapter} — chapter finances"
 *   - Peek (read-only)    — `warn` tone,    "{Chapter} — chapter finances
 *                             (read-only peek)" — the same tone the shell's
 *                             own `PeekBanner` uses for "you're not at your
 *                             own desk," so the two stay visually consistent.
 *
 * Self-contained (reads `useChapterContext()` directly) so it drops straight
 * into the finance `_layout` with no props threaded — mirrors
 * `SandboxModeBanner`'s drop-in convention. Renders `null` while the context
 * is still loading or for a no-seat caller (`context === null`) — the same
 * caller never reaches a finance screen that would render this (see
 * `finances/index.tsx`'s no-seat redirect), so this is defensive, not a real
 * branch in practice.
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import { Badge } from "../ui";
import { useChapterContext } from "../../lib/ChapterContext";

export function ScopeBadge() {
  const { context, chapterSeats } = useChapterContext();

  if (!context) return null;

  if (context.kind === "peek") {
    return (
      <Wrap>
        <Badge
          tone="warn"
          icon="eye"
          label={`${context.chapterName} — chapter finances (read-only peek)`}
        />
      </Wrap>
    );
  }

  if (context.scope === "central") {
    return (
      <Wrap>
        <Badge tone="info" icon="layers" label="Central — all chapters" />
      </Wrap>
    );
  }

  // A chapter seat — `context.scope` is the chapter id; `chapterSeats` (the
  // caller's own chapter desks) carries the display name.
  const chapterName =
    chapterSeats.find((s) => s.chapterId === context.scope)?.chapterName ?? "Chapter";
  return (
    <Wrap>
      <Badge tone="success" icon="home" label={`${chapterName} — chapter finances`} />
    </Wrap>
  );
}

// A bordered frame around `Badge`'s default chip (this is the ONE identity
// mark meant to survive a tight screenshot crop, not a passing status tag
// sitting next to other content) — the border/spacing give it standalone
// presence while every color/tone decision still comes from `Badge` itself.
function Wrap({ children }: { children: ReactNode }) {
  return (
    <View className="mb-3 flex-row self-start rounded-md border border-border bg-raised p-1">
      {children}
    </View>
  );
}

export default ScopeBadge;
