/**
 * THE CONTRACTOR'S OWN LINK — `<site>/contract/<chapterSlug>?token=<token>`.
 *
 * This is the point of the contractor-payments feature, in the founder's own
 * words: "if I pre-do something, I'm able to copy the link and send it to the
 * contractor." So the string has to be exactly the one the server puts in the
 * agreement email — `apps/convex/contractorPayments.ts#contractUrl` — or the
 * app and the email would hand the same person two different URLs.
 *
 * The base comes from `publicSiteUrl()` (`components/event/ticketing/helpers.ts`),
 * the app's one resolver for "where do the PUBLIC pages live" (branded domain
 * in prod, `.convex.site` elsewhere, local port+1 in dev) — the same helper
 * `useLedgerPreview` uses to open a month's public page. It is deliberately NOT
 * `lib/appUrl.ts#webAppUrl`: that builds links into the AUTHENTICATED Expo app
 * under `/os`, and a contractor has no account and never sees that app.
 *
 * ── RESOLVING THE SLUG ───────────────────────────────────────────────────────
 * THE RECORD KNOWS. `api.contractorPayments.get` now projects `scopeSlug` — the
 * public slug of the scope that owns the payment, which for an org-level
 * agreement is the reserved `central` (`/contract/central`). Pass it and the
 * link is built directly, with no guessing and no verification round-trip.
 *
 * The fallback below survives ONLY for callers that don't have the record yet
 * (the composer, between creating an agreement and refetching it): derive a
 * CANDIDATE from the active chapter desk's name, then VERIFY it against the
 * real row via `api.contractorPayments.chapterForContract`. It is used only
 * when the chapter it resolves to IS the desk's own.
 *
 * WHAT THIS FIXED (founder, 2026-08-28: "it's like, switch to chapters desk to
 * copy contractors link, a central desk has no public page of his own. What
 * does that mean? Makes no sense."). It meant the slug was being derived from
 * whichever DESK you were sitting at rather than from the payment, so the copy
 * button died on any desk that wasn't the payment's own chapter — and at a
 * central desk it blamed a missing public page. Central has a public page now,
 * and either way the record is the thing that knows where its own page lives.
 *
 * A null link is a real outcome the callers must render honestly — a copy
 * button that copies a broken URL is worse than one that explains itself.
 */
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { useChapterContext } from "./ChapterContext";
// The pure URL half lives in its own module so it can be unit-tested without
// dragging Convex/React/react-native into a node-environment jest run.
// Re-exported here so existing importers of this module keep working.
import { slugifyChapterName, contractLinkFor } from "./contractLinkUrl";

export { slugifyChapterName, contractLinkFor };

/** Why there is no link to copy — rendered verbatim next to the (absent) copy
 *  button, because "nothing happened" is the one thing this affordance must
 *  never do. */
export type ContractLinkState =
  | { url: string; chapterSlug: string; reason: null }
  | { url: null; chapterSlug: null; reason: string };

/**
 * The contractor link for `token`, resolved against the caller's active chapter
 * desk. Returns `{ url: null, reason }` whenever it cannot be built with
 * certainty — see the module doc.
 *
 * `chapterSlug` is the payment's OWN slug when the caller has it (from the
 * backend projection); pass `undefined` to fall back to the verified-candidate
 * path.
 */
export function useContractLink(
  token: string | null | undefined,
  chapterSlug?: string | null,
): ContractLinkState {
  const { context, seats, loading } = useChapterContext();

  // The active desk's chapter, when there is one. A central desk has no
  // chapter of its own to slugify — but a payment always belongs to the
  // caller's roster chapter (`requireChapterId`), so a central-only caller is
  // exactly the case where guessing would be wrong.
  let chapterId: Id<"chapters"> | null = null;
  let chapterName: string | null = null;
  if (context?.kind === "peek") {
    chapterId = context.chapterId;
    chapterName = context.chapterName;
  } else if (context?.kind === "seat" && context.scope !== "central") {
    chapterId = context.scope;
    const seat = seats.find(
      (s) => s.scope === "chapter" && s.chapterId === context.scope,
    );
    chapterName = seat && seat.scope === "chapter" ? seat.chapterName : null;
  }

  const candidate =
    !chapterSlug && chapterName ? slugifyChapterName(chapterName) : null;

  // Hooks may not be conditional: always call, and skip when there's nothing
  // to verify (either the slug came from the record, or we have no candidate).
  const verified = useQuery(
    api.contractorPayments.chapterForContract,
    candidate ? { chapterSlug: candidate } : "skip",
  );

  const unavailable = (reason: string): ContractLinkState => ({
    url: null,
    chapterSlug: null,
    reason,
  });

  if (!token) {
    return unavailable(
      "This payment has no link yet — create the agreement first.",
    );
  }

  // The happy path once the backend hands the slug over with the record.
  if (chapterSlug) {
    const url = contractLinkFor(chapterSlug, token);
    return url
      ? { url, chapterSlug, reason: null }
      : unavailable("The public site address isn't configured for this build.");
  }

  if (loading) return unavailable("Working out this chapter's public address…");
  if (!candidate || !chapterId) {
    // Only reachable for a caller that has no record to read the slug off —
    // the composer, mid-create. With a record in hand the `chapterSlug` branch
    // above has already answered, central included.
    return unavailable("Working out this payment's public address…");
  }
  if (verified === undefined) {
    return unavailable("Working out this chapter's public address…");
  }
  if (!verified || verified.chapterId !== chapterId) {
    return unavailable(
      "This chapter has no public web address set, so the contractor's link can't be built here. The agreement email still carries it — ask an admin to set the chapter's slug.",
    );
  }

  const url = contractLinkFor(verified.slug ?? candidate, token);
  return url
    ? { url, chapterSlug: verified.slug ?? candidate, reason: null }
    : unavailable("The public site address isn't configured for this build.");
}
