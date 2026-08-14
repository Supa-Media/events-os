/**
 * THE CODING CHASE'S POWER — who may mail a cardholder about what they owe.
 *
 * One named resolver, one `require` half, and every call site uses the require
 * half (CLAUDE.md, "Gate it behind a power, even when it's open today"). It
 * exists because the chase is the only place in finance where the app SPEAKS TO
 * A HUMAN ON THE ORG'S BEHALF: a reconcile write is wrong on a screen two
 * people read, a mis-aimed chase is an email in somebody's inbox accusing them
 * of owing an account of money they may not have spent. That asymmetry is
 * exactly the kind of thing an org eventually wants to hand to one seat, and
 * the day it does, this file's body is the only thing that changes.
 *
 * ## What it decides today, and what it does NOT widen
 *
 * The floor is MANAGER, per book — byte for byte the branch structure
 * `cards.getManualNudgeTargets` carried inline before this file existed (which
 * was itself `finances.receiptChase`'s viewer-floor branch structure raised to
 * a manager floor, because chasing is a write). Nothing about who may chase
 * moves here: a bookkeeper still cannot, a chapter treasurer still cannot chase
 * central's or another chapter's book, and a central manager still can.
 *
 * The `scope`/`chapterId` pair is the SAME pair the grid reads its rows with,
 * and the resolved book is RETURNED rather than re-derived by the caller — a
 * gate that answers "yes" and then leaves the caller to work out which book it
 * said yes about is how a central desk ends up chasing its own chapter's
 * cardholders while looking at somebody else's book.
 *
 * Note what the manager rank is resolved AGAINST: the caller's OWN home chapter
 * (`requireCentralFinanceRole`/`requireFinanceManager` both take it), never the
 * peeked scope. A central grant is org-wide regardless of which chapterId it is
 * checked against, and `getFinanceRole` only finds a roster row in the chapter
 * passed in — same reasoning `listReconcile`'s own drill-down gate spells out.
 *
 * ## When it graduates
 *
 * The likeliest reason to restrict it further is separation of the desk from
 * the voice: an org that wants only the Treasurer (not every finance manager,
 * and not a central FM reaching in) to be the person cardholders hear from.
 * That day this graduates to a `finance.chase.send` string in
 * `SEAT_CAPABILITIES` (`packages/shared/src/powers.ts`): add the string, list
 * it on the seats that should carry it, and change THIS body. No call site
 * moves — `finances.getCodingChaseTargets` is the single entry point, and the
 * public action (`cards.sendCodingChase`) reaches the chase only through it.
 *
 * Same shape, same reasoning and same graduation note as
 * `lib/finance.ts#hasAllBooksReconcile` / `hasCrossBookAttribution`.
 */
import { financeRoleAtLeast } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  getFinanceRole,
  requireCentralFinanceRole,
  requireFinanceManager,
  type FinanceScope,
} from "./finance";

/** Which book a chase is aimed at, in the vocabulary the grid sends: absent =
 *  the caller's own chapter, `scope:"central"` = central's own book, a
 *  `chapterId` = that chapter's book (a central desk peeking at one). There is
 *  deliberately NO all-books form — see `requireCodingChase`. */
export interface CodingChaseScopeArgs {
  scope?: "central";
  chapterId?: Id<"chapters">;
}

/**
 * May the caller chase cardholders in this book? The predicate half — exported
 * beside the `require` half because a SURFACE may want to ask without throwing
 * (the grid hides the buttons it knows will be refused), while every call site
 * that actually sends goes through `requireCodingChase`.
 *
 * Reads exactly the ranks the require half asserts, so the button the grid
 * shows and the send the server permits cannot disagree.
 */
export async function hasCodingChase(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  args: CodingChaseScopeArgs,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, homeChapterId);
  const peeking =
    args.scope === "central" ||
    (args.chapterId != null && args.chapterId !== homeChapterId);
  if (peeking)
    return access.isCentral && financeRoleAtLeast(access.role, "manager");
  return financeRoleAtLeast(access.role, "manager");
}

/**
 * The `require` half — assert the caller may chase in this book, and RETURN the
 * book so the caller reads the same one the gate approved.
 *
 * ONE BOOK, ALWAYS. There is no all-books branch and adding one is a change to
 * a manager-gated write path, not a rendering decision: a merged queue's person
 * bands span several books, and a chase fired from there would mail whichever
 * book this function happened to pick while the reader was looking at
 * everyone's rows. The grid withholds the buttons and prints why instead.
 */
export async function requireCodingChase(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
  args: CodingChaseScopeArgs,
): Promise<FinanceScope> {
  if (args.scope === "central") {
    await requireCentralFinanceRole(ctx, homeChapterId, "manager");
    return "central";
  }
  if (args.chapterId != null && args.chapterId !== homeChapterId) {
    await requireCentralFinanceRole(ctx, homeChapterId, "manager");
    return args.chapterId;
  }
  await requireFinanceManager(ctx, homeChapterId);
  return args.chapterId ?? homeChapterId;
}
