/**
 * Central (org-wide) reach — the app's one "sees everything" authz concept.
 *
 * This is the SAME primitive `finances.dashboardChapter`'s central drill-down
 * and `financeRoles.listChaptersForPeek`'s Peek list use:
 * `getFinanceRole(ctx, ownChapterId).isCentral` — true for a superuser, a
 * plain `financeRoles` grant with `scope: "central"`, or (via the specialized-
 * role bridge) a central `executive_director` / `president` / `finance_manager`
 * title. It lives in `lib/finance.ts` for historical reasons (finance was the
 * first feature to need an org-wide tier), but it is NOT finance-specific —
 * Events/Projects peek (WP-S follow-up) reuses it as-is rather than inventing
 * a second central-reach concept.
 *
 * Always check through the CALLER'S OWN chapter, never the target chapter
 * being peeked into — mirrors `dashboardChapter`'s gate exactly (a central
 * grant is scope-wide regardless of which chapterId it's checked against, but
 * the underlying `viewerPerson` lookup only finds a roster row in the chapter
 * passed in).
 */
export { requireFinanceCentral as requireCentralReach } from "./finance";
