/**
 * DASH-2/3 bar-click teardown fix (no-dead-numbers — tester complaint: "the
 * bar chart just refreshes the page"). Clicking a spend-by-month bar
 * re-subscribes `dashboardChapter`/`dashboardCentral`/`spendByMonth` with a
 * new `{year, month, period}` — Convex's `useQuery` returns `undefined`
 * while that new subscription resolves, and `finances/index.tsx`'s
 * `ChapterSection`/`CentralSection` used to treat ANY `undefined` as "still
 * loading" and return a full-screen `LoadingBlock`, unmounting the whole
 * dashboard (budget tables, attention rail, "Where it went" — everything)
 * for every period click, not just the first load.
 *
 * `usePreviousDefined` holds the last non-`undefined` result across that gap
 * so the dashboard keeps rendering the PREVIOUS period's figures (visibly
 * stale via the returned `loading` flag, which the caller renders as a small
 * in-place "Updating…" affordance) until the new period resolves, instead of
 * tearing down.
 *
 * `resetKey` clears the held value when it changes — e.g. the chapterId a
 * central viewer is peeking into. Without that, switching to a genuinely
 * DIFFERENT chapter while this same component instance stays mounted could
 * flash the previous chapter's figures under the new chapter's heading. A
 * period change alone (the bug this hook fixes) never changes `resetKey`, so
 * the held value survives exactly the cases it should.
 */
import { useRef } from "react";

export function usePreviousDefined<T>(
  value: T | undefined,
  resetKey?: unknown,
): { data: T | undefined; loading: boolean } {
  const lastValueRef = useRef<T | undefined>(undefined);
  const lastKeyRef = useRef<unknown>(resetKey);

  // Mutating refs during render is safe here (no scheduling side effect) —
  // the classic "derive + remember across a prop change" pattern, same
  // shape as React's own documented `getDerivedStateFromProps` replacement.
  if (lastKeyRef.current !== resetKey) {
    lastKeyRef.current = resetKey;
    lastValueRef.current = undefined;
  }
  if (value !== undefined) {
    lastValueRef.current = value;
  }

  return { data: lastValueRef.current, loading: value === undefined };
}
