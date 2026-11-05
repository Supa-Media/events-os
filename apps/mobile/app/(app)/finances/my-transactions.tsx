/**
 * FINANCES · MY TRANSACTIONS — your own card charges, inside Finances.
 *
 * Founder, 2026-11-05: "there is also no finances -> my transaction tab, but
 * it should probably exist." The chase text told people to open a tab that
 * wasn't there. This renders the same `MyCharges` list `/code` shows (one
 * form, see `CodePage`'s doc), so a cardholder already in the app finds it
 * under Finances. `/code` stays the link we send, since it needs no app chrome.
 *
 * `?filter=uncoded` from older reminder emails still works: `MyCharges` reads
 * it itself.
 */
import { MyCharges } from "../../../components/finance/code/CodePage";

export default function MyTransactionsScreen() {
  return <MyCharges />;
}
