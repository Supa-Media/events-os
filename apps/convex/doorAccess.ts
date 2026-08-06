/**
 * Per-event door access for outside volunteers — the grant surface behind the
 * event page's "Door access" tool (api namespace `api.doorAccess.*`).
 *
 * A grant is an email on a `doorGrants` row (schema/ticketing.ts): the third
 * path of `lib/ticketingAccess.ts#requireCheckInAccess`, honored WITHOUT
 * chapter membership. Off-domain emails also get an `accessAllowlist` row
 * stamped `grantedVia: "door"` so the volunteer can use the existing guest
 * sign-in — the stamp is what stops `profiles.completeOnboarding` from
 * escalating them into a full chapter member, and what lets a door revoke
 * shut their sign-in off again without ever touching a general (superuser-
 * granted, un-stamped) guest row. Domain members need no allowlist entry, so
 * granting them never writes one.
 *
 * Management is gated by `requireDoorGrantManage` (today: any member of the
 * event's chapter; graduates to `events.door.manage` — see the resolver's
 * doc). Grant/revoke mirror `accessAllowlist.ts`'s upsert + soft-revoke +
 * notify-on-fresh-grant shape.
 */
import { internalAction, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  getUserEmail,
  isAllowedEmail,
  normalizeEmail,
  requireAccess,
} from "./lib/access";
import { requireDoorGrantManage } from "./lib/ticketingAccess";
import { sendEmail } from "./ticketingEmails";
import { emailButton, emailHeading, emailParagraph, emailShell } from "./lib/emailShell";
import { escapeHtml } from "./lib/html";
import { guestSignInUrl } from "./lib/siteUrl";

// ── Allowlist coupling ──────────────────────────────────────────────────────

/**
 * Make sure a door-granted OFF-DOMAIN email can sign in: insert a fresh
 * allowlist row stamped `grantedVia: "door"`, or re-activate a revoked one —
 * stamping it too, because a door grant must only ever confer door-level
 * access (re-activating an old general-guest row un-stamped would quietly
 * restore full onboarding rights). An ACTIVE row is left completely alone:
 * whoever granted it decided its level, and a door grant must not downgrade
 * a general guest to door-only.
 */
async function ensureDoorAllowlist(ctx: MutationCtx, email: string): Promise<void> {
  const existing = await ctx.db
    .query("accessAllowlist")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
  if (!existing) {
    await ctx.db.insert("accessAllowlist", {
      email,
      note: "Door access (granted from an event page)",
      isActive: true,
      createdAt: Date.now(),
      grantedVia: "door",
    });
    return;
  }
  if (existing.isActive === false) {
    await ctx.db.patch(existing._id, { isActive: true, grantedVia: "door" });
  }
}

/**
 * After a revoke: if `email` holds no other active door grant and its
 * allowlist row is door-stamped, shut sign-in off too (soft, like
 * `revokeGuest`). Un-stamped rows — general guests a superuser granted — are
 * NEVER touched by door revokes.
 */
async function cleanupDoorAllowlist(ctx: MutationCtx, email: string): Promise<void> {
  if (isAllowedEmail(email)) return;
  const grants = await ctx.db
    .query("doorGrants")
    .withIndex("by_email", (q) => q.eq("email", email))
    .collect();
  if (grants.some((g) => g.isActive !== false)) return;
  const row = await ctx.db
    .query("accessAllowlist")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
  if (row && row.grantedVia === "door" && row.isActive !== false) {
    await ctx.db.patch(row._id, { isActive: false });
  }
}

// ── Management (event page → "Door access") ─────────────────────────────────

/**
 * Grant `email` door check-in access for `eventId`. Upserts the grant
 * (re-activating a revoked row rather than duplicating), opens guest sign-in
 * for off-domain emails, and emails the volunteer when the grant is freshly
 * turned on (mirrors `accessAllowlist.grantAndNotify`'s newly-granted-only
 * send).
 */
export const grant = mutation({
  args: {
    eventId: v.id("events"),
    email: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const event = await requireDoorGrantManage(ctx, args.eventId);
    const email = normalizeEmail(args.email);
    if (!email || !email.includes("@")) {
      throw new ConvexError({
        code: "INVALID_EMAIL",
        message: "Enter the volunteer's email address.",
      });
    }

    const existing = await ctx.db
      .query("doorGrants")
      .withIndex("by_event_email", (q) =>
        q.eq("eventId", args.eventId).eq("email", email),
      )
      .first();

    let newlyGranted: boolean;
    if (existing) {
      newlyGranted = existing.isActive === false;
      await ctx.db.patch(existing._id, {
        isActive: true,
        ...(args.note !== undefined ? { note: args.note } : {}),
      });
    } else {
      newlyGranted = true;
      await ctx.db.insert("doorGrants", {
        eventId: args.eventId,
        chapterId: event.chapterId,
        email,
        note: args.note,
        isActive: true,
        createdAt: Date.now(),
      });
    }

    if (!isAllowedEmail(email)) await ensureDoorAllowlist(ctx, email);

    if (newlyGranted) {
      await ctx.scheduler.runAfter(0, internal.doorAccess.sendDoorGrantEmail, {
        email,
        eventName: event.name,
      });
    }
    return null;
  },
});

/** Soft-revoke one grant; shuts off door-stamped sign-in when it was the
 *  email's last active grant (see `cleanupDoorAllowlist`). */
export const revoke = mutation({
  args: { grantId: v.id("doorGrants") },
  handler: async (ctx, { grantId }) => {
    const grantRow = await ctx.db.get(grantId);
    if (!grantRow) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Grant not found." });
    }
    await requireDoorGrantManage(ctx, grantRow.eventId);
    await ctx.db.patch(grantId, { isActive: false });
    await cleanupDoorAllowlist(ctx, grantRow.email);
    return null;
  },
});

/** The event's grants, newest first — the "Door access" screen's list. */
export const listForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireDoorGrantManage(ctx, eventId);
    const grants = await ctx.db
      .query("doorGrants")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    return grants
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({
        _id: g._id,
        email: g.email,
        note: g.note ?? null,
        isActive: g.isActive !== false,
        createdAt: g.createdAt,
      }));
  },
});

// ── The volunteer's own surface (door mode) ─────────────────────────────────

/**
 * The signed-in caller's active door grants, joined to their events —
 * soonest first. Drives the door-mode event list. Membership-free on
 * purpose (`requireAccess` only): the caller typically has no chapter and
 * no `people` row.
 */
export const myDoorEvents = query({
  args: {},
  handler: async (ctx) => {
    await requireAccess(ctx);
    const email = normalizeEmail(await getUserEmail(ctx));
    if (!email) return [];

    const grants = await ctx.db
      .query("doorGrants")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();

    const events: {
      eventId: Id<"events">;
      name: string;
      eventDate: number;
      chapterName: string;
    }[] = [];
    for (const g of grants) {
      if (g.isActive === false) continue;
      const event = await ctx.db.get(g.eventId);
      if (!event) continue;
      const chapter = await ctx.db.get(g.chapterId);
      events.push({
        eventId: g.eventId,
        name: event.name,
        eventDate: event.eventDate,
        chapterName: chapter?.name ?? "",
      });
    }
    return events.sort((a, b) => a.eventDate - b.eventDate);
  },
});

// ── Notify ──────────────────────────────────────────────────────────────────

/** "You're on the door" — sent once per fresh grant. Mirrors
 *  `accessAllowlist.sendAccessGrantedEmail`'s shell + guest-sign-in copy;
 *  best-effort (no Resend key configured → logged skip). */
export const sendDoorGrantEmail = internalAction({
  args: { email: v.string(), eventName: v.string() },
  handler: async (ctx, { email, eventName }) => {
    const subject = `You're on the door for ${eventName}`;
    // KNOWN REPO TRAP (see cards.ts#notifyPersonalChargeFlagged): a
    // `link ? <a> : ""` pattern would silently ship a CTA-less email whenever
    // APP_URL is unset. Degrade LOUDLY instead — log so the gap is visible in
    // production, and always render SOME actionable text.
    const link = guestSignInUrl(email);
    if (!link) {
      console.error(
        "[doorAccess] sendDoorGrantEmail: APP_URL is unset — sending WITHOUT a guest-sign-in link",
        email,
      );
    }
    const signInHtml = link
      ? `${emailParagraph(
          `Tap below to sign in as a guest — we'll pre-fill your email (<b>${escapeHtml(email)}</b>).`,
        )}
      ${emailButton(link, "Sign in as a guest")}`
      : emailParagraph(
          `Open the app, choose <b>Sign in as a guest</b>, and enter this email address (<b>${escapeHtml(email)}</b>). We'll email you a one-time code each time you sign in — then just point the scanner at each guest's ticket.`,
        );
    const html = emailShell(`
      ${emailHeading("You're on the door 🎟️")}
      ${emailParagraph(
        `You've been given check-in access for <b>${escapeHtml(eventName)}</b> on <b>Chapter OS</b>.`,
      )}
      ${signInHtml}
      ${emailParagraph("See you at the door.", { size: 12, margin: "0" })}`);

    await sendEmail(ctx, { to: email, subject, html });
    return null;
  },
});
