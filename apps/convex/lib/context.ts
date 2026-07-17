/**
 * Request context helpers for Chapter OS.
 *
 * Typed loosely (`ctx: any`) so this file doesn't depend on Convex's generated
 * types — it's pure helper code, not a registered function. Every app function
 * resolves the caller's chapter through `requireChapterId` so chapter scoping
 * is enforced in one place.
 */
import { requireAuthId } from "@supa-media/convex/auth";
import { ConvexError } from "convex/values";
import { requireAccess } from "./access";
import { Doc, Id, TableNames } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

export {
  ALLOWED_EMAIL_DOMAIN,
  isAllowedEmail,
  isGuestAllowed,
  hasAccess,
  getUserEmail,
  requireAccess,
} from "./access";

/** The authenticated user's id (throws if signed out). */
export async function requireUserId(ctx: any): Promise<string> {
  return await requireAuthId(ctx);
}

/**
 * The chapter the caller belongs to (MVP: their first/only membership).
 * Multi-chapter switching is V3; until then a user has exactly one chapter.
 *
 * TODO(latent, #143): `financeRoles.mySeats` is genuinely multi-chapter aware
 * — it scans every `people` row for the caller's userId, so a person with
 * finance grants in more than one chapter sees a seat for each. But every
 * home-chapter-derived mutation (via `requireChapterId` here, then
 * `getFinanceRole`/`viewerPerson` in `lib/finance.ts` / `lib/org.ts`, which
 * only look up the `people` row matching THAT ONE chapterId) can only ever
 * act in the FIRST membership's chapter. A genuinely multi-chapter person's
 * non-home seats would show up in `mySeats` but be functionally unreachable
 * through those mutations. Today this is latent — one `people` row per user
 * is the norm — but would silently strand a real multi-roster user.
 */
export async function requireChapterId(ctx: any): Promise<string> {
  await requireAccess(ctx);
  const userId = await requireAuthId(ctx);
  const membership = await ctx.db
    .query("userChapters")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .first();
  if (!membership) {
    throw new ConvexError({
      code: "NO_CHAPTER",
      message: "You don't belong to a chapter yet.",
    });
  }
  return membership.chapterId as string;
}

/**
 * The caller's chapter, or null if they don't belong to one yet. Auth is still
 * required. Use in READ queries so a brand-new user (pre-seed / pre-onboarding)
 * gets empty results instead of a thrown error that crashes the screen.
 */
export async function getChapterIdOrNull(ctx: any): Promise<string | null> {
  await requireAccess(ctx);
  const userId = await requireAuthId(ctx);
  const membership = await ctx.db
    .query("userChapters")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .first();
  return membership ? (membership.chapterId as string) : null;
}

/** Assert a document exists and belongs to the caller's chapter. */
export async function requireInChapter(
  ctx: any,
  chapterId: string,
  doc: { chapterId?: string } | null,
  label = "Record",
): Promise<void> {
  if (!doc || doc.chapterId !== chapterId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: `${label} not found in your chapter.`,
    });
  }
}

/**
 * Load a chapter-scoped document by id, asserting it exists AND belongs to the
 * caller's chapter, then return it fully typed. Collapses the ~50×-repeated
 * preamble of `requireChapterId` → `ctx.db.get(id)` → `requireInChapter` into a
 * single call. Throws a `ConvexError` (not a plain `Error`) so clients can
 * recover instead of dead-ending in the root error boundary.
 *
 * Pass `label` for a friendlier "<label> not found in your chapter." message.
 */
export async function requireOwned<T extends TableNames>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
  label = "Record",
): Promise<Doc<T>> {
  const chapterId = await requireChapterId(ctx);
  const doc = await ctx.db.get(id);
  await requireInChapter(ctx, chapterId, doc as { chapterId?: string } | null, label);
  return doc as Doc<T>;
}

/** Load an event by id, asserting it belongs to the caller's chapter. */
export async function requireEvent(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"events">> {
  return requireOwned(ctx, "events", eventId, "Event");
}

/** Load an event type (template) by id, asserting it belongs to the caller's chapter. */
export async function requireEventType(
  ctx: QueryCtx,
  templateId: Id<"eventTypes">,
): Promise<Doc<"eventTypes">> {
  return requireOwned(ctx, "eventTypes", templateId, "Event type");
}

/**
 * Assert a template is user-managed — neither a platform template (Academy
 * training) nor the chapter's synthesized ad-hoc "Blank event" template (see
 * `getOrCreateBlankTemplate`). Both are owned/seeded by the platform, not the
 * user: a platform template must stay exactly what the Academy authored, and
 * the Blank template must stay PERMANENTLY EMPTY (zero roles/items/columns/
 * modules) — that emptiness is the entire mechanism behind "no pre-filled
 * tasks or roles" on an ad-hoc event. Any content-mutation entry point that
 * writes onto a template (add/update/delete/reorder a role, column, item,
 * module, or placeholder-crew row) must call this — or `requireManagedEventType`
 * below — before writing, or a user could silently pollute either template
 * through direct API calls (the UI never offers them as edit targets, but the
 * mutations themselves don't stop a client from trying).
 */
export function assertTemplateManaged(eventType: Doc<"eventTypes">): void {
  if (eventType.isPlatform === true) {
    throw new ConvexError({
      code: "PLATFORM_TEMPLATE",
      message: "This template is managed by the platform and can't be changed.",
    });
  }
  if (eventType.isBlank === true) {
    throw new ConvexError({
      code: "BLANK_TEMPLATE",
      message: "The Blank event template is managed automatically and can't be changed.",
    });
  }
}

/**
 * `requireEventType` + `assertTemplateManaged` in one call — the standard
 * guard for every template-CONTENT write (as opposed to `requireEventType`
 * alone, which still fits template-metadata reads and the templating engine's
 * own internal clone-FROM-a-template reads, which must keep working on the
 * Blank template).
 */
export async function requireManagedEventType(
  ctx: QueryCtx,
  templateId: Id<"eventTypes">,
): Promise<Doc<"eventTypes">> {
  const eventType = await requireEventType(ctx, templateId);
  assertTemplateManaged(eventType);
  return eventType;
}
