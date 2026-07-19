/**
 * useGivingScope — derives the Giving desk's chapter lens from the app-wide
 * `ChapterContext`, the SAME derivation `finances/index.tsx`'s `DashboardBody`
 * does for `finances.dashboardChapter`'s optional, central-gated `chapterId`
 * (see that file's `chapterId` const, and `ChapterContext`'s own module doc's
 * "SCOPE" section).
 *
 * Every Giving screen passes this into
 * `api.givingPlatform.myGivingAccess({ chapterId })` so donor/gift data
 * follows the app's chapter switcher instead of a superuser/central holder
 * ALWAYS getting `scope: "central"` (the "No donors yet" bug — central's book
 * can be empty while the switched-to chapter's isn't; `myGivingAccess` used
 * to hard-pick the central lens whenever the caller had central reach,
 * ignoring `ChapterContext` entirely).
 *
 *  - `{kind:"peek", chapterId}` — a central holder read-only browsing a
 *    chapter they don't hold a desk in — that chapter.
 *  - `{kind:"seat", scope}` with a chapter scope — that chapter.
 *  - `{kind:"seat", scope:"central"}`, or no context yet (loading, or the
 *    caller has no finance/giving desk at all) — `undefined`, so
 *    `myGivingAccess` falls back to its pre-existing default: central for a
 *    central holder, else the caller's own chapter.
 */
import type { Id } from "@events-os/convex/_generated/dataModel";
import { useChapterContext } from "./ChapterContext";

export function useGivingScope(): Id<"chapters"> | undefined {
  const { context } = useChapterContext();
  if (context?.kind === "peek") return context.chapterId;
  if (context?.kind === "seat" && context.scope !== "central") {
    return context.scope;
  }
  return undefined;
}
