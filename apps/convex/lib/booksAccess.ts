/**
 * WHO MAY READ THE BOOKS — the org's own ledger, read-only.
 *
 * Founder decision (2026-08-30, verbatim): "they can see the ledger too. They
 * can see the full thing because ... it's publicly set anyways, um, but they
 * just can't edit." Every team member reads this organization's money; editing
 * it stays the Treasurer's and the Financial Manager's desk.
 *
 * ── WHY THIS IS ITS OWN RESOLVER, AND NOT A NEW FLOOR ON THE LADDER ──────────
 *
 * The obvious implementation is to make `lib/finance.ts#getFinanceRole` derive
 * `"viewer"` from chapter membership, so a member passes every
 * `requireFinanceRole(..., "viewer")` in the app. That was the plan until the
 * call sites were counted: ~50 gates sit at the viewer rank, and they are not
 * one surface. They include the Increase/Stripe payout rails
 * (`increasePayouts.ts`, `stripeFinance.ts`), bank-account reads
 * (`increaseAccounts.ts`), processor fee detail, the donor-adjacent
 * `givingCandidates.ts` and `territories.ts` lookups, and event
 * `registrationsAccess.ts`. Lowering the floor opens ALL of them at once and
 * leaves each carve-out to be remembered — an opt-OUT design, where the
 * failure mode is silent over-disclosure of somebody's bank rail or a donor's
 * name because a resolver wasn't on the list.
 *
 * So the reading power is its own named thing, granted per surface. Opening a
 * screen to the team is an explicit edit to that screen's gate; anything not
 * named here keeps exactly the reach it had. The failure mode inverts: a
 * surface we forgot stays CLOSED, and a member reports a lock icon instead of
 * a stranger reading the payout rails.
 *
 * ── WHAT IT IS TODAY, AND WHAT IT GRADUATES TO ──────────────────────────────
 *
 * Today the answer is "anyone on this chapter's roster, plus anyone holding
 * real finance reach" — so the body is a membership check, per the repo's "gate
 * it behind a power, even when it's open today" rule. It is deliberately the
 * SAME membership `finances.ts#budgetsGlance` has always used (the prior owner
 * decision that every team member sees spend-vs-cap without a `financeRoles`
 * grant); this widens WHICH read surfaces that population reaches, not who the
 * population is.
 *
 * When the org wants the books narrowed again — the likeliest reason being a
 * chapter that grows past the point where everyone knows everyone — this
 * graduates to a `finance.books.read` string in `SEAT_CAPABILITIES`: add it,
 * list it on the seats that should carry it, and change THIS body. No call site
 * moves.
 *
 * ── WHAT STAYED NARROW, AND WHY IT NEEDED NO CODE ───────────────────────────
 *
 * Because this is opt-in, the surfaces the org decided to keep narrow needed no
 * guard written against them — they simply were not changed, and still sit on
 * `requireFinanceRole`/`requireFinanceCentral` as they did before:
 *
 *  - CONTRACTOR PAYMENTS (`lib/contractorPaymentsAccess.ts`) — a person's
 *    livelihood. The public ledger deliberately never names a contractor payee,
 *    and that is a one-way door: names can be published later, never unpublished.
 *  - THE PUBLISH CONSOLE (`lib/publicLedgerAccess.ts`) — a working surface over
 *    unpublished drafts and preview tokens. A member reads a published month on
 *    the public page like anyone else.
 *  - ATTENDEE NAMES on coded transactions (`requireCodingNamesView`) —
 *    internal to finance forever (decided 2026-08-08). The ledger line a member
 *    reads carries headcount and affiliation mix instead, exactly as the public
 *    line does.
 *  - PERSONAL CHARGES across the roster (`cards.listPersonalRepayments`) — who
 *    owes the org for a mis-swipe is a debt between one person and the
 *    organization, not a line of the books. A member sees their OWN through
 *    `myPersonalRepayments`.
 *  - The ACCOUNTS tab (ED + FM only), the RECEIPTS desk, SALES, and every
 *    write path — all unchanged.
 *
 * READS ONLY, and never at central. Every write stays on the graded ladder
 * (`requireFinanceRole(..., "bookkeeper"|"manager")`), untouched by this file.
 * A membership read is scoped to the caller's OWN chapter: central's books are
 * reachable only through central authority, exactly as before.
 */
import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { getFinanceRole } from "./finance";

/** The caller's resolved right to READ a chapter's books. */
export interface BooksReadAccess {
  /** Their roster person id, or null (a superuser with no roster row). */
  personId: Id<"people"> | null;
  /**
   * True when this read is carried by MEMBERSHIP ALONE — no `financeRoles`
   * grant, no finance seat. Such a caller may never be offered a write
   * affordance, and surfaces that stay narrow (the publish console, contractor
   * payments, attendee names) refuse on exactly this flag.
   */
  viaMembership: boolean;
}

/**
 * The caller's books-read access at `chapterId`, or `null` if they have none.
 * The non-throwing half, private until a caller needs to ask without throwing.
 */
async function getBooksRead(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<BooksReadAccess | null> {
  const access = await getFinanceRole(ctx, chapterId);
  // Real finance reach (a stored grant, a seat, or the superuser bootstrap)
  // reads the books as it always has.
  if (access.role != null || access.isCentral) {
    return { personId: access.personId, viaMembership: false };
  }
  // Otherwise: membership itself. `getFinanceRole` resolves `personId` through
  // `viewerPerson`, which already excludes placeholder roster rows, so an
  // event-scoped stand-in never reads the books.
  if (access.personId != null) {
    return { personId: access.personId, viaMembership: true };
  }
  return null;
}

/**
 * Assert the caller may read `chapterId`'s books, returning their resolved
 * access. The single gate every team-visible finance READ calls.
 */
export async function requireBooksRead(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<BooksReadAccess> {
  const access = await getBooksRead(ctx, chapterId);
  if (!access) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Reading this chapter's books needs a roster profile in it.",
    });
  }
  return access;
}
