/**
 * The contractor link's URL shape, and the slugify that feeds it — the two
 * pure pieces of `lib/contractLink.ts`.
 *
 * SPLIT OUT SO THEY ARE ACTUALLY TESTABLE. `contractLink.ts` claims these are
 * "testable without a Convex client", and that stopped being true the moment
 * the module grew a `useQuery` and a `useChapterContext` import: any test
 * touching it drags in Convex, React context, and (through nativewind)
 * react-native, none of which load in this package's node-environment jest
 * setup. The URL a contractor is sent is not something to leave uncovered on
 * a technicality about module layout, so the pure half lives here and the hook
 * imports it.
 *
 * `publicSiteUrl` is the one remaining dependency and is the app's single
 * resolver for "where do the PUBLIC pages live" — branded domain in prod,
 * `.convex.site` elsewhere. It is deliberately not `lib/appUrl.ts#webAppUrl`:
 * that builds links into the AUTHENTICATED app, and a contractor has no
 * account.
 */
import { publicSiteUrl } from "../components/event/ticketing/helpers";

/** URL slug from a chapter name: "New York" → "new-york". Mirrors
 *  `apps/convex/ticketing.ts#slugify`, which is how slugs are minted in this
 *  codebase; a mismatch here can only ever produce a candidate that FAILS the
 *  verification below, never a wrong link. */
export function slugifyChapterName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** The link itself, given both halves. Kept pure (and exported) so the URL
 *  shape has one definition and is testable without a Convex client. */
export function contractLinkFor(chapterSlug: string, token: string): string | null {
  const base = publicSiteUrl().replace(/\/+$/, "");
  if (!base || !chapterSlug || !token) return null;
  return `${base}/contract/${encodeURIComponent(chapterSlug)}?token=${encodeURIComponent(token)}`;
}
