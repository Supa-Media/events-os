import { MarketingSiteView } from "../../../components/marketing/SiteView";

/** SITE tab — the homepage's copy and its impact numbers. Body in
 *  `components/marketing/SiteView.tsx`, which also carries the access gate:
 *  unlike Giving's tabs there is no read-only mode to fall back to, so the
 *  view resolves `canEditSite` itself rather than the route resolving it and
 *  then handing down a flag nothing branches on. */
export default function MarketingSiteScreen() {
  return <MarketingSiteView />;
}
