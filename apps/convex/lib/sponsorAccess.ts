/**
 * PARTNER-PORTAL AUTHORIZATION — who may compose a partnership proposal, hand
 * out the link that opens it, and see what came back.
 *
 * Every one of these resolves TODAY to the central giving gate
 * (`requireGivingView` / `requireGivingManage(ctx, "central")`), which is
 * exactly what `sponsorships.ts` already checks inline. So why a file?
 *
 * Because of the standing rule in CLAUDE.md — "gate it behind a power, even
 * when it's open today". Composing a proposal a partner signs and minting a URL
 * that settles $3,500 are not the same act as editing a donor's mailing
 * address, even though one seat happens to carry both today. The day a
 * development director wants a partnership associate who can DRAFT a proposal
 * but not SEND it, the change is this file's four function bodies, not the
 * twenty call sites that would otherwise each have grown their own seat check.
 *
 * ── HOW THIS GRADUATES ──────────────────────────────────────────────────────
 * When the split is actually wanted:
 *   1. add `giving.partners.compose` / `giving.partners.send` to `POWERS`
 *      (`packages/shared/src/powers.ts`), with the implication
 *      `send ⇒ compose`;
 *   2. list them on the seats that should carry them (`SEAT_DEFS` —
 *      development_director gets send, partnership_associate gets compose);
 *   3. change the two bodies below to ask for those powers instead of
 *      `giving.manage`.
 * The seat chart stays the honest answer to "who can do this?", and no call
 * site moves. Precedent: `lib/campaignsAccess.ts`, `lib/givingAccess.ts`.
 *
 * ── SEPARATION OF DUTIES, NOTED NOT ENFORCED ────────────────────────────────
 * The partner signs; we never sign on their behalf. There is deliberately NO
 * staff-side "mark as signed" path anywhere in `sponsorPortal.ts` — a
 * signature that a staffer could type is not a signature. That is the
 * separation of duties this domain has, and it is enforced by the absence of a
 * mutation rather than by a check, which is the strongest way to enforce it.
 */
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import {
  GivingAccess,
  canManageGivingScope,
  canViewGivingScope,
  requireGivingManage,
  requireGivingView,
} from "./givingAccess";

/**
 * Sponsorship agreements are CENTRAL-LENS ONLY (see
 * `schema/sponsorships.ts`'s "central lens only" note). Named here so the day
 * chapter-owned partnerships exist, the scope becomes a parameter in one file
 * rather than a literal in twenty.
 */
const PARTNER_SCOPE: Id<"chapters"> | "central" = "central";

/** May the caller READ partnership agreements and their portal state? */
export function hasPartnershipView(access: GivingAccess): boolean {
  // → `giving.partners.view` when the split lands. Today: central giving read.
  return canViewGivingScope(access, PARTNER_SCOPE);
}

/** May the caller WRITE a proposal — its amount, terms, benefits, credits? */
export function hasPartnershipCompose(access: GivingAccess): boolean {
  // → `giving.partners.compose` when the split lands.
  return canManageGivingScope(access, PARTNER_SCOPE);
}

/**
 * May the caller ISSUE or REVOKE a portal link?
 *
 * Deliberately its OWN predicate even though its body is identical to
 * `hasPartnershipCompose` today: handing a partner a URL that takes their money
 * is the act most likely to want a narrower seat later, and the whole point of
 * this file is that narrowing it costs one line here.
 */
export function hasPartnershipSend(access: GivingAccess): boolean {
  // → `giving.partners.send` when the split lands.
  return canManageGivingScope(access, PARTNER_SCOPE);
}

/** Assert READ of the partnership desk, else throw the giving gate's refusal. */
export async function requirePartnershipView(
  ctx: QueryCtx,
): Promise<GivingAccess> {
  return await requireGivingView(ctx, PARTNER_SCOPE);
}

/** Assert authority to WRITE a proposal, else throw. */
export async function requirePartnershipCompose(
  ctx: QueryCtx,
): Promise<GivingAccess> {
  return await requireGivingManage(ctx, PARTNER_SCOPE);
}

/** Assert authority to ISSUE / REVOKE a portal link, else throw. */
export async function requirePartnershipSend(
  ctx: QueryCtx,
): Promise<GivingAccess> {
  return await requireGivingManage(ctx, PARTNER_SCOPE);
}
