/**
 * Transaction-coding authorization — who may author a coding, who may decide
 * on one, and who may see meal-attendee NAMES.
 *
 * Mirrors `lib/receiptExceptionAccess.ts` exactly, because the powers are the
 * same separation-of-duties pair (see `docs/plans/transaction-coding.md`):
 *
 *  - SUBMIT (`requireSubmitCoding`) — author "this is what the spend was, and
 *    who was involved". Open today to the transaction's OWN person (the
 *    cardholder coding their own charge is the entire phase-2 flow, and it
 *    must not need a finance grant — `finances.attachReceipt`'s own-txn
 *    carve-out) or to bookkeeper+ on any row in scope. Graduates to a
 *    `finance.coding.submit` capability if it ever needs narrowing.
 *
 *  - REVIEW (`requireReviewCoding`) — decide. FOUR seats may approve a coding,
 *    and the reach of each is deliberate (owner, 2026-08-09) — see that
 *    function's doc for the matrix and how each arm is derived. No own-txn
 *    carve-out by construction, and `transactionCodings.approve` additionally
 *    refuses a reviewer deciding a coding THEY authored (every coding is
 *    somebody's testimony; the second name is the point). Graduates to
 *    `finance.coding.review`.
 *
 *  - REVISE UNDER REVIEW (`requireReviseUnderReview`) — FIX the record instead
 *    of bouncing it. Founder, 2026-09-02, on the review record: *"got to make
 *    sure the treasurer/financial manager can edit details like the budget
 *    category… allow them to edit any other details they want instead of
 *    sending back and forth."* Today it is exactly the DECIDING power, and
 *    deliberately so — correcting which budget a charge lands in is the
 *    reviewer's own bookkeeping judgment, not the cardholder's, so whoever may
 *    approve may correct on the way. Graduates to `finance.coding.revise` the
 *    day the org wants a seat that decides without amending (or amends without
 *    deciding). Separation of duties rides along at the CALL SITE, exactly as
 *    it does for `setPublicPurpose` — see that mutation's doc.
 *
 *  - VIEW (`requireViewCoding`) — read the record. Either of the two above:
 *    whoever may author on the row, OR whoever may decide it. The review arm
 *    is what lets a central reviewer READ a coding in a book they don't
 *    author in — without it an FM could approve a New York charge from the
 *    Coding tab's list but be unable to open the row and read what they were
 *    approving.
 *
 *  - NAMES (`hasCodingNamesView`) — see attendee names. Names are
 *    internal-only forever (owner decision, 2026-08-08): the public ledger
 *    renders the affiliation breakdown, never a name. Internally, whoever may
 *    author on the row (its own person, bookkeeper+) OR decide it may read
 *    what's on it; everyone else gets the redacted projection. The reviewer
 *    arm is not a widening for its own sake: "who was there and how do they
 *    relate to the org" is the §274(d) element the reviewer is being asked to
 *    weigh, so redacting it from them would leave them approving a claim they
 *    cannot read. Graduates to `finance.coding.viewNames` the day a seat needs
 *    it carried or stripped separately.
 *
 * Every refusal throws `ConvexError({ code, message })` so the app's
 * AuthErrorBoundary can surface it.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { CENTRAL, expandPowers, financeRoleAtLeast } from "@events-os/shared";
import {
  getFinanceRole,
  requireFinanceCentral,
  type FinanceScope,
} from "./finance";
import { getSeatDerivedCapabilities, holdsApprovalSeatAt } from "./seats";
import { requireChapterId } from "./context";
import { ownChargeActor } from "./ownChargeAccess";
import { isSuperuser } from "./superuser";

/**
 * May this caller decide (approve / send back / redact) a coding THEY
 * THEMSELVES authored?
 *
 * Normally never — separation of duties is absolute across all four review
 * seats (`transactionCodings.approve` compares the decider against
 * `codedByPersonId`). This is the ONE relaxation, and it is the same
 * solo-operator relaxation `budgets.approvalParty` documents: while the owner
 * is a one-person finance team, a SUPERUSER may self-decide, and every
 * approval that takes this path is recorded as `approvalParty: "single"` so
 * it stays re-reviewable when the org grows past one person (owner,
 * 2026-08-11: "as super admin, I need the ability to just approve my own
 * coding things").
 *
 * A named resolver rather than an inline `isSuperuser` at the call sites, per
 * the house rule: when this graduates to a real capability (or is retired),
 * it is one body to change.
 */
export async function maySelfDecideCoding(ctx: QueryCtx): Promise<boolean> {
  return isSuperuser(ctx);
}

/** The resolved right to act on one transaction's coding. */
export interface TransactionCodingAccess {
  txn: Doc<"transactions">;
  scope: FinanceScope;
  /** The caller's roster person id at this scope. `null` for a superuser with
   *  no roster row (the same supported path as the exception gates). */
  actorPersonId: Id<"people"> | null;
}

/** `NOT_FOUND` — used wherever a caller has no business knowing the row
 *  exists at all (a book they cannot see), so a refusal never doubles as an
 *  existence oracle. */
function notFound(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "NOT_FOUND",
    message: "Transaction not found in your chapter.",
  });
}

/** Scope+role resolution for the AUTHORING gate: the row's own person, or
 *  bookkeeper+ in the row's own book. Authoring is otherwise chapter-local —
 *  a coding is the spender's testimony, and nobody writes one in a book they
 *  don't stand in. (The REVIEW gate below deliberately reaches further; see
 *  its doc.)
 *
 *  THE OWN-CHARGE ARM REACHES CENTRAL, and only it does. A chapter member
 *  whose card draws on central's Increase account spends into the CENTRAL
 *  book (`increaseCardSync.ts` — "your card determines whose account paid"),
 *  so their charge is a central row with their `personId` on it. It is listed
 *  to them as their own (`finances.personTransactions`), it is chased as
 *  their own (`lib/codingReminders.ts`), and until this arm existed it was the
 *  one charge they could not code: the central branch below required
 *  bookkeeper rank of everyone, on the premise that "central issues no cards,
 *  so a central row has no cardholder to be". See `lib/ownChargeAccess.ts`. */
async function resolveAuthor(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<TransactionCodingAccess> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const txn = (await ctx.db.get(transactionId)) as Doc<"transactions"> | null;
  if (!txn) throw notFound();

  const forbidden = () =>
    new ConvexError({
      code: "FORBIDDEN",
      message:
        "Only the transaction's own person or a bookkeeper can code this transaction.",
    });

  // ASKED FIRST, IN BOTH BOOKS. Ownership is the cheaper and the broader
  // answer here (a cardholder needs no grant at all), and asking it before
  // the role ladder is what keeps the central branch below from refusing the
  // spender their own row.
  const ownerPersonId = await ownChargeActor(ctx, txn, homeChapterId);

  if (txn.chapterId === CENTRAL) {
    if (ownerPersonId != null) {
      return { txn, scope: CENTRAL, actorPersonId: ownerPersonId };
    }
    // Everyone ELSE on a central row is the central desk: central-owned money
    // that nobody spent on a card is central-desk territory, exactly as
    // before (same as the exception gates).
    const access = await requireFinanceCentral(ctx, homeChapterId);
    if (!financeRoleAtLeast(access.role, "bookkeeper")) throw forbidden();
    return { txn, scope: CENTRAL, actorPersonId: access.personId };
  }

  const access = await getFinanceRole(ctx, homeChapterId);
  if (txn.chapterId !== homeChapterId) throw notFound();
  if (ownerPersonId == null && !financeRoleAtLeast(access.role, "bookkeeper")) {
    throw forbidden();
  }
  return { txn, scope: txn.chapterId, actorPersonId: access.personId };
}

/** True iff the caller may AUTHOR/EDIT the coding on this transaction.
 *  Read-only probe for the UI (the mutation still calls the `require` form). */
export async function hasSubmitCoding(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  try {
    await requireSubmitCoding(ctx, transactionId);
    return true;
  } catch {
    return false;
  }
}

/** Assert the caller may AUTHOR/EDIT the coding on this transaction. */
export async function requireSubmitCoding(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<TransactionCodingAccess> {
  return resolveAuthor(ctx, transactionId);
}

/** True iff the caller may DECIDE on this transaction's coding. Read-only
 *  probe for the UI (the mutation still calls the `require` form). */
export async function hasReviewCoding(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  try {
    await requireReviewCoding(ctx, transactionId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Assert the caller may DECIDE (approve / send back) the coding on this
 * transaction, else throw.
 *
 * ## The four approval seats, and why each reaches as far as it does
 *
 * Owner, 2026-08-09 — four seats may approve a coding, never their own:
 *
 * | seat                  | chapter codings   | central codings |
 * | --------------------- | ----------------- | --------------- |
 * | `executive_director`  | ANY chapter       | yes             |
 * | `financial_manager`   | ANY chapter       | yes             |
 * | `chapter_director`    | THEIR OWN only    | no              |
 * | `treasurer`           | THEIR OWN only    | no              |
 *
 * Three of those four could approve nothing before this gate was written,
 * for two unrelated reasons, and the fix needs both halves:
 *
 *  1. **No graded role.** `executive_director` and `chapter_director` carry
 *     `finance.approve` but deliberately NOT `finance.manager` (see
 *     `SEAT_DEFS`), so `getSeatDerivedCapabilities` derives no rank for them
 *     and the old `financeRoleAtLeast(access.role, "manager")` test could
 *     never pass. This is the identical gap #209 and WP-wave4 closed for
 *     BUDGET approval by reading the capability directly at the gate
 *     (`lib/seats.ts#holdsApprovalSeatAt`,
 *     `lib/finance.ts#requireCentralFinanceRoleOrEdSeat`) — the same
 *     additive, narrowly-scoped reader is wired here rather than folded into
 *     the graded ladder, because approve-side SoD is a different axis than
 *     manager/bookkeeper/viewer.
 *  2. **No cross-book reach.** The gate derived its scope from the caller's
 *     ACTIVE chapter and refused anything else outright, so "any chapter"
 *     was not sayable for the Financial Manager even though their seat
 *     carries `finance.central`.
 *
 * ## Containment is now DELIBERATE, not incidental
 *
 * Read fix (2) carefully: the old blanket `txn.chapterId !== homeChapterId →
 * NOT_FOUND` was the ONLY thing keeping a Treasurer inside their own chapter.
 * It applied to everybody, so it contained the Treasurer by accident while
 * also containing the FM by mistake. Removing it to free the FM would have
 * silently handed every Treasurer the whole org.
 *
 * So the chapter-local arm below states the restriction itself:
 * `target === homeChapterId`, and it is unreachable for a central target at
 * all. A Treasurer or Chapter Director now fails to reach another chapter
 * because THIS FUNCTION SAYS SO, not because of a lookup that happens to
 * come first. `codingApprovalRoles.test.ts` pins every cell of the matrix
 * above, including the four that must stay refusals.
 *
 * Separation of duties is enforced one layer up, in
 * `transactionCodings.approve` — it is absolute, applies to all four seats,
 * and is untouched by any of this.
 */
export async function requireReviewCoding(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<TransactionCodingAccess> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const txn = (await ctx.db.get(transactionId)) as Doc<"transactions"> | null;
  if (!txn) throw notFound();

  const access = await getFinanceRole(ctx, homeChapterId);
  const target: FinanceScope =
    txn.chapterId === CENTRAL ? CENTRAL : (txn.chapterId as Id<"chapters">);
  const granted = (): TransactionCodingAccess => ({
    txn,
    scope: target,
    actorPersonId: access.personId,
  });

  // ── ORG-WIDE ARM — every book, central included. ─────────────────────────
  // A stored central `financeRoles` manager grant (what a `finance_manager`
  // TITLE bridges via `bridgeFinanceManagerGrant`), and superusers, whom
  // `getFinanceRole` already short-circuits to exactly this shape.
  if (access.isCentral && financeRoleAtLeast(access.role, "manager")) {
    return granted();
  }
  if (access.personId != null) {
    // The SEAT-ALONE paths. Both read the central chart directly rather than
    // going through `getFinanceRole(...).role`, and they have to: that value
    // is the caller's rank AT THEIR HOME CHAPTER, and neither of these seats
    // sits there. `financial_manager` derives `finance.manager` at the
    // `"central"` scope key, so a holder with no bridged stored grant reads
    // as rank `null` at their own chapter — which is precisely the state a
    // seat assigned without its write-through leaves them in. B10's promise
    // is that the org chart alone is sufficient, so the chart is what's read.
    const seatCaps = await getSeatDerivedCapabilities(ctx, access.personId);
    if (seatCaps[CENTRAL]?.financeRole === "manager") return granted();
    // `executive_director` — a CENTRAL seat carrying `finance.approve` and no
    // graded rank at any scope. Same reader `requireCentralFinanceRoleOrEdSeat`
    // uses for the central budget surface. A Chapter Director's seat is scoped
    // to their own chapter and never to `"central"`, so this cannot widen one.
    if (await holdsApprovalSeatAt(ctx, access.personId, CENTRAL)) {
      return granted();
    }
  }

  // ── CHAPTER-LOCAL ARM — their OWN chapter, and never central. ────────────
  // Deliberately guarded on `target === homeChapterId` (see the doc above:
  // this is the containment that used to be a side effect).
  if (target !== CENTRAL && target === homeChapterId) {
    // `treasurer` — finance.manager at their chapter, no central reach.
    if (financeRoleAtLeast(access.role, "manager")) return granted();
    // `chapter_director` — finance.approve at their chapter, rank "viewer".
    if (
      access.personId != null &&
      (await holdsApprovalSeatAt(ctx, access.personId, homeChapterId))
    ) {
      return granted();
    }
  }

  // A book this caller has no reach into shouldn't confirm the row exists.
  if (target !== CENTRAL && target !== homeChapterId) throw notFound();
  throw new ConvexError({
    code: "FORBIDDEN",
    message:
      "Approving a coding needs the Treasurer, Chapter Director, Financial Manager, or Executive Director seat.",
  });
}

/**
 * Assert the caller may CORRECT a submitted coding's attribution and
 * structured facts from the review record — the treasurer's/FM's "fix it here
 * rather than send it back" power.
 *
 * ## Why it is its own name when its body is one line
 *
 * The house rule (CLAUDE.md, "Gate It Behind a Power, Even When It's Open
 * Today"): a capability that might one day need narrowing gets a named
 * resolver from the start, so adding the real gate is one body to change
 * rather than every call site. Amending somebody else's record is exactly
 * such a capability — "may decide" and "may amend" are the same answer today
 * and are not obviously the same answer forever. A Chapter Director approving
 * their book's codings is a plausible seat to hold the first and not the
 * second, and if that day comes this function's body becomes a capability
 * read and nothing else moves.
 *
 * ## Why the body is the DECIDING power and not the AUTHORING one
 *
 * `requireSubmitCoding` is chapter-local by construction — it asks whether you
 * may write testimony in this book. That is the wrong question here: a central
 * Financial Manager may decide a New York coding and cannot author one, so
 * gating the correction on authorship would leave the exact person the founder
 * named unable to set the budget on the exact row they are approving. Whoever
 * may decide may correct.
 *
 * Note what this does NOT reach, in either direction: `businessPurpose` (the
 * author's own testimony — see `transactionCodings.reviseUnderReview`), and an
 * already-APPROVED coding (reopening one is `requestChanges`, an audited
 * decision of its own).
 */
export async function requireReviseUnderReview(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<TransactionCodingAccess> {
  return requireReviewCoding(ctx, transactionId);
}

/** True iff the caller may correct a submitted coding from the review record.
 *  Read-only probe for the UI (the mutation still calls the `require` form) —
 *  it answers AUTHORITY only, so a caller who holds it may still be refused by
 *  separation of duties on their own coding, exactly as `hasReviewCoding` is. */
export async function hasReviseUnderReview(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  try {
    await requireReviseUnderReview(ctx, transactionId);
    return true;
  } catch {
    return false;
  }
}

/** How far this caller's REVIEW authority reaches — the answer the Coding
 *  tab's queue needs before it reads a single row. */
export interface CodingReviewReach {
  /** Every book, central included — the ED / FM arm. */
  orgWide: boolean;
  /** True iff they may decide their OWN chapter's codings — the Treasurer /
   *  Chapter Director arm. Always true when `orgWide` is, since the org-wide
   *  arm subsumes it. */
  ownChapter: boolean;
  homeChapterId: Id<"chapters">;
  /** Their roster person id at their home chapter, or `null` (superuser with
   *  no roster row) — the SoD comparand for every row in the queue. */
  actorPersonId: Id<"people"> | null;
}

/**
 * The REVERSE of `requireReviewCoding` — "which books may this caller decide
 * in", rather than "may they decide THIS row". The queue needs it because it
 * reads by book: asking the per-row gate first and then fetching would mean
 * fetching every book's codings to find out which ones to fetch.
 *
 * Deliberately expressed as the SAME TWO ARMS the gate uses, in the same
 * order, so the two cannot drift into disagreeing about who may approve what.
 * (`lib/finance.ts#listChapterFinanceManagerPersonIds` is the same idea for
 * the manager ladder — a reverse lookup living next to its forward gate.)
 */
export async function codingReviewReach(
  ctx: QueryCtx,
): Promise<CodingReviewReach> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const access = await getFinanceRole(ctx, homeChapterId);
  const base = { homeChapterId, actorPersonId: access.personId };

  if (access.isCentral && financeRoleAtLeast(access.role, "manager")) {
    return { ...base, orgWide: true, ownChapter: true };
  }
  if (access.personId != null) {
    const seatCaps = await getSeatDerivedCapabilities(ctx, access.personId);
    if (
      seatCaps[CENTRAL]?.financeRole === "manager" ||
      (await holdsApprovalSeatAt(ctx, access.personId, CENTRAL))
    ) {
      return { ...base, orgWide: true, ownChapter: true };
    }
  }

  const ownChapter =
    financeRoleAtLeast(access.role, "manager") ||
    (access.personId != null &&
      (await holdsApprovalSeatAt(ctx, access.personId, homeChapterId)));
  return { ...base, orgWide: false, ownChapter };
}

/** Bound on the reviewer-enumeration scans below. Mirrors
 *  `lib/finance.ts#FINANCE_ROLE_SCAN_LIMIT`'s reasoning: a book's approval
 *  seats number in the single digits, never near this. */
const REVIEWER_SCAN_LIMIT = 5000;

/**
 * Everyone who may DECIDE codings in `book` — the recipient set for "codings
 * are waiting on you".
 *
 * The other reverse lookup (`codingReviewReach` answers it for ONE caller;
 * this answers it for a book), and it exists because
 * `lib/finance.ts#listChapterFinanceManagerPersonIds` is the wrong set now.
 * That function enumerates `finance.manager` holders, which was the whole
 * reviewer population when reviewing meant manager rank. Two of the four
 * approval seats — `executive_director` and `chapter_director` — carry
 * `finance.approve` and NOT `finance.manager`, so mailing that set would
 * quietly skip the very people this change just gave the power to.
 *
 * The arms mirror `requireReviewCoding`'s, in the same order:
 *  - stored `financeRoles` manager grants at the book, or at `"central"`
 *  - seats carrying `finance.manager` at the book, or at `"central"`
 *  - seats carrying `finance.approve` at `"central"` (the ED — org-wide)
 *  - seats carrying `finance.approve` at the BOOK, when the book is a real
 *    chapter (the Chapter Director — their own book only, which is why this
 *    arm is skipped for central)
 */
export async function listCodingReviewerPersonIds(
  ctx: QueryCtx,
  book: FinanceScope,
): Promise<Set<Id<"people">>> {
  const personIds = new Set<Id<"people">>();

  for (const scope of [book, CENTRAL] as FinanceScope[]) {
    const grants = await ctx.db
      .query("financeRoles")
      .withIndex("by_chapter", (q) => q.eq("chapterId", scope))
      .take(REVIEWER_SCAN_LIMIT);
    for (const g of grants) {
      // A chapter-scoped manager grant only reviews its own book; a central
      // one reviews everywhere. Both are satisfied by scoping the read.
      if (g.role === "manager") personIds.add(g.personId);
    }

    const assignments = await ctx.db
      .query("seatAssignments")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .take(REVIEWER_SCAN_LIMIT);
    for (const a of assignments) {
      const def = await ctx.db.get(a.seatDefId);
      // Rolled-up/computed seats are never real occupancy — the same
      // belt-and-braces skip `holdsApprovalSeatAt` makes.
      if (!def || def.derived) continue;
      const powers = expandPowers(def.capabilities);
      if (powers.has("finance.edit")) {
        personIds.add(a.personId);
        continue;
      }
      if (!powers.has("finance.budgets.approve")) continue;
      // `finance.approve` at CENTRAL reaches every book (the ED). At a real
      // chapter it reaches only that chapter (the CD) — and since `scope` is
      // either `book` or `"central"` here, that's already true by
      // construction. Stated rather than implied, because getting it wrong
      // would mail one chapter's director about another chapter's queue.
      if (scope === CENTRAL || scope === book) personIds.add(a.personId);
    }
  }
  return personIds;
}

/**
 * Assert the caller may READ this transaction's coding — either because they
 * may author it, or because they may decide it.
 *
 * The review arm is load-bearing, not belt-and-braces. Authoring is
 * chapter-local by construction (`resolveAuthor`), so gating the read on the
 * author's bar alone would leave a Financial Manager able to approve a New
 * York coding from the Coding tab's queue and unable to OPEN it — approving
 * a record they were refused sight of. Whoever may decide may read.
 */
export async function requireViewCoding(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<TransactionCodingAccess> {
  try {
    return await resolveAuthor(ctx, transactionId);
  } catch (authorRefusal) {
    try {
      return await requireReviewCoding(ctx, transactionId);
    } catch {
      // Surface the AUTHOR-side refusal: it's the one that describes the
      // common case (a cardholder or bookkeeper on the wrong row), and it
      // keeps `NOT_FOUND`-vs-`FORBIDDEN` reading the same as it always has.
      throw authorRefusal;
    }
  }
}

/** True iff the caller may see this coding's attendee NAMES (vs. the redacted
 *  affiliation-breakdown projection). Same bar as READING the record: the
 *  row's own person, bookkeeper+ in scope, or whoever may decide it — "who
 *  was there and how do they relate to the org" is precisely the element a
 *  reviewer is being asked to weigh. Names NEVER publish regardless — this
 *  gates internal reads only. */
export async function hasCodingNamesView(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  try {
    await requireViewCoding(ctx, transactionId);
    return true;
  } catch {
    return false;
  }
}
