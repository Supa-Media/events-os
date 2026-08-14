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
 * ── RESOLVING THE CHAPTER SLUG ───────────────────────────────────────────────
 * The slug is the one piece the app is not handed. `api.contractorPayments.get`
 * returns the token but not the payment's chapter slug, so this module resolves
 * it in two steps, and NEVER emits a guess:
 *
 *   1. If the payment record itself carries a `chapterSlug` (the one-line
 *      projection add in `get` that would make step 2 unnecessary — see
 *      `useContractLink`'s `chapterSlug` argument), that wins outright.
 *   2. Otherwise: derive a CANDIDATE from the active chapter desk's name with
 *      the same slugify the rest of the codebase uses, then VERIFY it against
 *      the real row via `api.contractorPayments.chapterForContract` — a public
 *      query that resolves slug → chapter. The candidate is used only when the
 *      chapter it resolves to IS the desk's own chapter. A slug that doesn't
 *      resolve, or resolves to a different chapter, yields NO link rather than
 *      a plausible-looking one that would 404 (or, worse, render this payment
 *      under another chapter's name).
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
    return unavailable(
      "Switch to your chapter's desk to copy the contractor's link — a central desk has no public page of its own.",
    );
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
