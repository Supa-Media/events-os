/**
 * FINANCES · CHASE RECEIPTS — now a redirect into the Reconcile grid.
 *
 * ── WHAT THIS SCREEN WAS, AND WHY IT ISN'T ONE ANYMORE ───────────────────────
 * It was the FM's ready-made "who do I nudge" list: every charge still owed a
 * receipt, grouped by cardholder, with a "Send reminder" per group. The grid
 * absorbed that presentation first (Group by → Person puts a chase button on
 * each cardholder's own band — founder: "If the chase receipt is just grouped
 * by person, there's no need. I can see each person, and click a button in
 * their header"), which already left this page orphaned and reachable only by
 * URL. The coding chase finished the job.
 *
 * Four things this page had that the grid now has, each strictly better there:
 *
 *  - THE POPULATION. This page listed `isChaseable` — the union of "owes a
 *    document" and "owes its cardholder an account". The grid's State →
 *    **Owes a receipt or coding** is that same predicate, called from the same
 *    function, and it composes with every other filter instead of being a
 *    destination of its own.
 *  - THE BANDS. Group by → Person, with the same avatar, the same total and
 *    the same biggest-first ordering, on a grid that can also be searched,
 *    sorted, period-scoped and paged.
 *  - THE CHASE ITSELF. Now `cards.sendCodingChase`, which asks for the CODING
 *    (receipts included — `transactionCodings.submitCoding` refuses to submit
 *    without one) and respects the manager's filters, search and ROW SELECTION.
 *    That last part could never have worked here: this page had no selection to
 *    respect.
 *  - THE SCOPE. This page silently degraded `?scope=all` to the caller's own
 *    chapter for both the list AND the nudge, so a dual-hat FM looking at
 *    "everyone who owes a receipt" was in fact looking at, and reminding, one
 *    book. The grid renders the merged queue honestly and withholds the chase
 *    button there, saying why.
 *
 * A redirect rather than a plain deletion, and for exactly the reasons
 * `/finances/explain` got one: the path is out in the world. It was linked from
 * the Book menu, it is in mail and bookmarks, and both `?scope=` and
 * `?chapterId=` deep links are shareable. A 404 on any of those would be a
 * regression dressed as a cleanup.
 *
 * ── THE PARAMETER MAPPING ────────────────────────────────────────────────────
 * `?scope=` / `?chapterId=` are FORWARDED, not translated: this screen and the
 * grid already speak the same scope vocabulary (`central` / `all` as words,
 * with a chapter named separately in `chapterId`), which is why this redirect
 * can be a pass-through where `/finances/explain`'s had to translate a
 * single-book id. `?scope=all` is forwarded rather than degraded — see above.
 *
 * An absent or unrecognized param is DROPPED rather than guessed, landing on
 * the caller's own desk, which is what this screen did when handed the same
 * thing.
 */
import { Redirect, useLocalSearchParams } from "expo-router";

/** The three axes that ARE "chase receipts": the chase population, banded by
 *  person, biggest first. Spelled out here because a link has to name them in
 *  a URL — the grid's view menu (which used to set them from a dropdown) is
 *  gone, and these are the same three axes the retired menu entry set. */
const CHASE_VIEW_QUERY =
  "filters=needs_chasing&group=person&sort=amount&dir=desc";

export default function ReceiptChaseRedirect() {
  const params = useLocalSearchParams<{ scope?: string; chapterId?: string }>();
  const query = [CHASE_VIEW_QUERY];
  // Only the two words the grid actually accepts. Anything else is dropped
  // rather than passed through, so a stale link can't put an uninterpretable
  // scope on the grid and silently get the caller's own desk while claiming
  // otherwise.
  if (params.scope === "central" || params.scope === "all") {
    query.push(`scope=${params.scope}`);
  } else if (params.chapterId) {
    query.push(`chapterId=${encodeURIComponent(params.chapterId)}`);
  }
  return <Redirect href={`/finances/reconcile?${query.join("&")}`} />;
}
