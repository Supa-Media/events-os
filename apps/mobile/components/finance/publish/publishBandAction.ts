/**
 * WHAT A MONTH BAND'S PUBLISH BUTTON DOES — and, since three surfaces now say
 * where a month is up to (the band, the console's month list, the in-place
 * modal's header), how that one sentence reads. Pure functions, no
 * `react-native` import, so they run directly under this package's jest config
 * (the same reason `gridView.ts` and `bookScope.ts` are shaped this way).
 *
 * ── THE DECISION THIS ENCODES ────────────────────────────────────────────────
 * Publishing is the one irreversible, public act in the app, and the console
 * (`/finances/publish`) is where its ceremony lives: the two-approver
 * handoff, the amendment reason a re-publish carries, the SNAPSHOT_TRUNCATED
 * refusal. The band used to ROUTE there for exactly that reason — the ceremony
 * is the act, not paperwork in front of it, and a one-tap Publish on a band
 * would have had to either drop it or reimplement it.
 *
 * It now does neither: the console's own month body is a component
 * (`PublishMonthBody`), and the band opens it in a modal. Same component, same
 * mutations, same server refusals — one implementation, two frames, exactly
 * the way a row's record is a side panel when wide and a modal otherwise
 * (`ReconcileList.tsx#openRecord`). So the founder publishes from the grid
 * ("preview and publish from the same page") without a second, thinner
 * publish path existing anywhere.
 *
 * TWO CASES STILL ROUTE, and both are about the band being unable to name its
 * own subject:
 *
 *  - THE MERGED ALL-BOOKS QUEUE (`scope === null`). A month band there spans
 *    several books, and there is no such thing as publishing "all books" as
 *    one month — `publicLedger`'s every entry point takes ONE book
 *    (`v.id("chapters") | "central"`). Opening the body in place would have to
 *    pick a book on the reader's behalf, which is the dead-number defect wired
 *    to the irreversible act. The console asks for the book explicitly, so
 *    that is where this case goes.
 *  - A BAND KEY THAT IS NOT A MONTH. Every `groupBy: "month"` band key is a
 *    `YYYY-MM`, so this is unreachable today; it is handled anyway because the
 *    in-place body would hand the bad key to `preview`/`publish`, which throw
 *    `BAD_PERIOD`. Routing degrades to the console's plain month list, which
 *    is the state that screen has always opened in.
 *  - A MONTH THE CONSOLE DIDN'T ANSWER ABOUT. `console_` returns a continuous
 *    calendar back to the book's earliest transaction, capped at 60 months, so
 *    a band older than the cap has no row to render a flow from. The console
 *    is the screen that owns the whole calendar, so it takes that case too —
 *    a button that opened an empty dialog would be worse than one that
 *    travels.
 */
import { parsePeriodKey, PUBLICATION_STATUS_LABELS } from "@events-os/shared";
import type { PublicationStatus } from "@events-os/shared";
import type { BadgeTone } from "../../ui";
import type { SingleBookScope } from "../bookScope";

export type PublishBandAction =
  /** Open the console's month body right here, over the grid. */
  | { kind: "in_place"; label: string; scope: SingleBookScope; periodKey: string }
  /** Hand off to `/finances/publish`, where a book is chosen explicitly. */
  | { kind: "console"; label: string; href: string };

/** "Amend" once a month is live, because that is the only thing left to do to
 *  it — there is no unpublish (see `publicLedger.ts#publish`). */
function bandLabel(status: PublicationStatus): string {
  return status === "published" ? "Amend" : "Publish";
}

/**
 * The console URL for one band. `scope` and `period` are both optional and
 * both omitted rather than sent empty: the console resolves a missing scope
 * to the caller's own desk (`resolveBookScope`) and a missing period to "no
 * month expanded", and an empty `?scope=` would be refused with a banner
 * naming a book nobody asked for.
 */
export function publishConsoleHref(args: {
  scope: SingleBookScope | null;
  periodKey: string;
}): string {
  const query: string[] = [];
  if (args.scope) query.push(`scope=${encodeURIComponent(args.scope)}`);
  if (parsePeriodKey(args.periodKey)) query.push(`period=${args.periodKey}`);
  return `/finances/publish${query.length ? `?${query.join("&")}` : ""}`;
}

export function publishBandAction(args: {
  /** The one book the grid is showing, or `null` for the merged all-books
   *  queue — see `reconcile.tsx#consoleScope`. */
  scope: SingleBookScope | null;
  periodKey: string;
  /** The console's own row for this month, or `null` when the console said
   *  nothing about it. A month with no PUBLICATION row is still a row here —
   *  `console_` synthesizes it as `draft`, which is the commonest month, not
   *  an error. */
  month: { status: PublicationStatus } | null;
}): PublishBandAction {
  const label = bandLabel(args.month?.status ?? "draft");
  if (!args.scope || !args.month || !parsePeriodKey(args.periodKey)) {
    return { kind: "console", label, href: publishConsoleHref(args) };
  }
  return {
    kind: "in_place",
    label,
    scope: args.scope,
    periodKey: args.periodKey,
  };
}

/**
 * How a month's publication state reads, wherever it is shown: the band, the
 * console's month list, and the in-place modal's header.
 *
 * A live month names its REVISION, because "Published" alone stops being the
 * whole truth the moment a correction goes out — revision 3 and revision 1 are
 * different statements about the same month, and the reader deciding whether
 * to amend needs to know which one is out there. Only `published` is green:
 * everything else is work in flight, and an amber "in review" that looked
 * settled would invite someone to assume a month was already public.
 */
export function publicationBadge(args: {
  status: PublicationStatus;
  liveRevision: number | null;
}): { label: string; tone: BadgeTone } {
  const label =
    args.status === "published" && args.liveRevision != null
      ? `Published · rev ${args.liveRevision}`
      : PUBLICATION_STATUS_LABELS[args.status];
  const tone: BadgeTone =
    args.status === "published"
      ? "success"
      : args.status === "changes_requested"
        ? "danger"
        : args.status === "in_review" || args.status === "amending"
          ? "warn"
          : "neutral";
  return { label, tone };
}
