import { MarketingDesignsView } from "../../../components/marketing/DesignsView";

/** DESIGNS tab — the brand kit (colors, fonts) and the design library. Body in
 *  `components/marketing/DesignsView.tsx`. Unlike the other tabs there is no
 *  gate to put here or there: the library is readable by anyone signed in, and
 *  the view renders read-only for a caller the backend says can't edit. */
export default function MarketingDesignsScreen() {
  return <MarketingDesignsView />;
}
