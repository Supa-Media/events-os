/**
 * Finance role administration — grant / revoke the graded finance capability
 * (viewer < bookkeeper < manager) on a chapter's roster people.
 *
 * `listFinanceRoles`, `grantFinanceRole`, and `revokeFinanceRole` are all
 * implemented — trivial row list/insert/delete gated by a finance manager
 * (the finance-admin gate).
 */
import { query, mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import {
  FINANCE_ROLES,
  FINANCE_ROLE_SCOPES,
  FINANCE_ROLE_RANK,
  SPECIALIZED_ROLE_TITLES,
  type FinanceRole,
  type SpecializedRoleTitle,
} from "@events-os/shared";
import { Id } from "./_generated/dataModel";
import {
  getChapterIdOrNull,
  requireChapterId,
  requireUserId,
} from "./lib/context";
import {
  requireFinanceManager,
  requireFinanceCentral,
  isCentralEdOrFm,
  getFinanceRole,
} from "./lib/finance";
import { isSuperuser } from "./lib/superuser";
import { ROLLUP_SCAN_LIMIT } from "./finances";
import { listActiveChapters } from "./lib/chapters";

const roleValidator = v.union(...FINANCE_ROLES.map((r) => v.literal(r)));
const scopeValidator = v.union(...FINANCE_ROLE_SCOPES.map((s) => v.literal(s)));
const specializedTitleValidator = v.union(
  ...SPECIALIZED_ROLE_TITLES.map((t) => v.literal(t)),
);

/**
 * The caller's REAL finance seats (WP-0.2) — what the dashboard routes by,
 * replacing the fake "Preview as" role simulation.
 *
 * A seat is a desk the caller actually sits at:
 *  - `{scope:"central"}` — any `scope:"central"` grant (whichever chapterId the
 *    row is keyed on: `grantFinanceRole` keys it on the granting chapter, the
 *    specialized-roles bridge on the `"central"` sentinel), or the superuser
 *    allowlist (implicit central manager — the bootstrap path).
 *  - `{scope:"chapter"}` — one per chapter with a `scope:"chapter"` grant.
 *
 * Central first (the UI's default desk), then chapters by name. Placeholder
 * roster rows never count (mirrors `viewerPerson`). No grants → `[]` → member.
 *
 * ── THE CENTRAL ED/FM WIDENING (bug #2 follow-up to the ledger console/
 * prepare fix) ─────────────────────────────────────────────────────────────
 * A central `executive_director` seat carries `finance.central`/
 * `finance.approve`/`finance.accounts`/`finance.publish` but deliberately
 * NEVER `finance.manager` (see `SEAT_DEFS`), and its `legacyTitle` is a
 * LEADERSHIP-kind title — `assignSpecializedRoleImpl`'s finance-only bridge
 * (`bridgeFinanceManagerGrant`) never fires for it, unlike
 * `financial_manager`'s finance-kind title, which DOES bridge a real central
 * `financeRoles` manager grant on assignment. So a real ED seat produces
 * NEITHER a seat-derived graded role (this file reads only the stored
 * `financeRoles` table, not `lib/seats.ts#getSeatDerivedCapabilities`) NOR a
 * bridged stored grant — `centralRole` stays `null` and this query returned
 * `[]` for an ED even after `lib/publicLedgerAccess.ts`'s console/prepare
 * widening started letting that same ED into the console server-side.
 * `finances/_layout.tsx` branches on `seats.length === 0` BEFORE
 * `canViewAccounts`, so the ED landed on `MEMBER_TABS` — no Publish, no By
 * month, no Accounts tab — despite the server granting all of it.
 *
 * Fixed by unioning in a SYNTHESIZED central seat, gated on
 * `isCentralEdOrFm` — the exact resolver the console/prepare widening itself
 * uses (one source of truth; this file does not re-derive the ED/FM check).
 * Only fires when `centralRole` is STILL `null` after the real grants loop
 * above, so a real `financial_manager` assignment (which bridges its own
 * stored grant) is untouched and never double-counted.
 *
 * `role: "viewer"`, not `"manager"` — deliberately the HONEST floor, not the
 * seat's peak power. This seat carries no `finance.manager` CAPABILITY, and
 * every WRITE gate `lib/finance.ts#getFinanceRole` backs (reconcile writes,
 * `updateBudget`, the Reconcile grid's coding-chase `isManager` check,
 * `PersonalChargesView`'s own) is UNCHANGED by the console/prepare widening
 * — only `hasLedgerConsole`/`hasLedgerPrepare` were widened. Synthesizing
 * `"manager"` here would light up manager-only UI this caller cannot
 * actually use and get a 403 from on the write. `"viewer"` is exactly the
 * `chapter_director` seat's own precedent (seat-derived `finance.viewer`,
 * read-only) and is enough to satisfy the one thing this query is FOR: a
 * non-empty result puts the caller on `SEAT_TABS`, not `MEMBER_TABS`.
 * `canViewAccounts` (a separate query, already correct) still independently
 * governs the Accounts tab.
 *
 * `seats.myDeskChapters` already offers this ED a central desk (their real
 * `seatAssignments` row is enough for that query), so `ChapterContext`'s
 * `mergeDesks` was never broken — this fix brings `mySeats` into agreement
 * with what `myDeskChapters` already said, rather than changing what the
 * merged desk list shows.
 *
 * WP-1.1: each seat is additionally enriched with an optional `title` — the
 * caller's SPECIALIZED role (`executive_director` / `president` /
 * `finance_manager`) at that same scope, if any. This is display enrichment
 * ONLY (the client maps it to the org-chart label via `specializedRoleLabel`,
 * e.g. "Executive Director" / "Chapter Director" / "Treasurer") — it does not
 * change which seats exist or their `role` ladder value; a seat with no
 * specialized title just omits the field and the UI falls back to the plain
 * finance-role label ("Manager"/"Bookkeeper"/"Viewer").
 */
export const mySeats = query({
  args: {},
  returns: v.array(
    v.union(
      v.object({
        scope: v.literal("central"),
        role: roleValidator,
        title: v.optional(specializedTitleValidator),
      }),
      v.object({
        scope: v.literal("chapter"),
        chapterId: v.id("chapters"),
        chapterName: v.string(),
        role: roleValidator,
        title: v.optional(specializedTitleValidator),
      }),
    ),
  ),
  handler: async (ctx) => {
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const people = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const realPeople = people.filter((p) => p.isPlaceholder !== true);
    const grants = (
      await Promise.all(
        realPeople.map((p) =>
          ctx.db
            .query("financeRoles")
            .withIndex("by_person", (q) => q.eq("personId", p._id))
            .collect(),
        ),
      )
    ).flat();

    // Display-only enrichment: the caller's specialized-role title per scope
    // (keyed on "central" or a chapter id), so the UI can show "Executive
    // Director" / "Chapter Director" / "Treasurer" instead of a bare finance
    // ladder rank. Does not affect seat resolution above.
    const specializedTitles = (
      await Promise.all(
        realPeople.map((p) =>
          ctx.db
            .query("specializedRoles")
            .withIndex("by_person", (q) => q.eq("personId", p._id))
            .collect(),
        ),
      )
    ).flat();
    const titleByScopeKey = new Map<string, SpecializedRoleTitle>();
    for (const t of specializedTitles) {
      titleByScopeKey.set(String(t.scope), t.title);
    }

    const stronger = (a: FinanceRole, b: FinanceRole | null) =>
      b == null || FINANCE_ROLE_RANK[a] > FINANCE_ROLE_RANK[b];

    // Central seat: superuser short-circuit, else the strongest central grant.
    let centralRole: FinanceRole | null = (await isSuperuser(ctx))
      ? "manager"
      : null;
    for (const g of grants) {
      if (g.scope === "central" && stronger(g.role, centralRole)) {
        centralRole = g.role;
      }
    }
    // The widening (see module doc): a central ED/FM who produced neither a
    // seat-derived nor a bridged stored central grant still gets a desk —
    // gated on the SAME resolver `lib/publicLedgerAccess.ts`'s console/
    // prepare widening uses, so this can never drift ahead of or behind that
    // gate's own definition of "central ED or FM."
    if (centralRole == null && (await isCentralEdOrFm(ctx))) {
      centralRole = "viewer";
    }

    // Chapter seats: the strongest chapter-scoped grant per chapter.
    const chapterRoles = new Map<Id<"chapters">, FinanceRole>();
    for (const g of grants) {
      if (g.scope !== "chapter" || g.chapterId === "central") continue;
      if (stronger(g.role, chapterRoles.get(g.chapterId) ?? null)) {
        chapterRoles.set(g.chapterId, g.role);
      }
    }

    const chapterSeats = [];
    for (const [chapterId, role] of chapterRoles) {
      const chapter = await ctx.db.get(chapterId);
      if (!chapter) continue; // stale grant on a deleted chapter
      const title = titleByScopeKey.get(chapterId);
      chapterSeats.push({
        scope: "chapter" as const,
        chapterId,
        chapterName: chapter.name,
        role,
        ...(title !== undefined ? { title } : {}),
      });
    }
    chapterSeats.sort((a, b) => a.chapterName.localeCompare(b.chapterName));

    const centralTitle = titleByScopeKey.get("central");
    return [
      ...(centralRole != null
        ? [
            {
              scope: "central" as const,
              role: centralRole,
              ...(centralTitle !== undefined ? { title: centralTitle } : {}),
            },
          ]
        : []),
      ...chapterSeats,
    ];
  },
});

/**
 * WP-1.2: whether the caller may see the Accounts tab (+ the Cards tab's
 * Relay/legacy section) — CENTRAL `executive_director` or `finance_manager`
 * specialized-role holders only (or a superuser). Tighter than a plain
 * central-scope finance-manager grant (`stripeFinance.canConnectAccount`'s
 * gate): a chapter-scope manager, or even a central `financeRoles` grant with
 * no ED/FM title, gets `false` — see `lib/finance.ts#isCentralEdOrFm`.
 *
 * A signed-out caller gets `false` too, not a thrown error: `isCentralEdOrFm`
 * bottoms out in `requireUserId` (throws `NOT_AUTHENTICATED`), but this is a
 * visibility check the client polls to decide whether to render the Accounts
 * tab at all — it should degrade quietly like every other "can I see this"
 * query, not surface an auth error before the caller has even loaded.
 */
export const canViewAccounts = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    return isCentralEdOrFm(ctx);
  },
});

/** List every finance-role grant in the caller's chapter (manager only). */
export const listFinanceRoles = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("financeRoles"),
      personId: v.id("people"),
      role: roleValidator,
      scope: scopeValidator,
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceManager(ctx, chapterId);
    const grants = await ctx.db
      .query("financeRoles")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect();
    return grants.map((g) => ({
      id: g._id,
      personId: g.personId,
      role: g.role,
      scope: g.scope,
      createdAt: g.createdAt,
    }));
  },
});

/** Grant a person a finance role in the caller's chapter (manager only). */
export const grantFinanceRole = mutation({
  args: {
    personId: v.id("people"),
    role: roleValidator,
    scope: scopeValidator,
  },
  returns: v.id("financeRoles"),
  handler: async (ctx, { personId, role, scope }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    // Any finance manager may grant chapter-scoped roles, but conferring
    // CENTRAL (org-wide) reach requires the granter to already hold it — else a
    // plain chapter manager could self-escalate to the org roll-up.
    const access = await requireFinanceManager(ctx, chapterId);
    if (scope === "central") {
      await requireFinanceCentral(ctx, chapterId);
    }

    const person = await ctx.db.get(personId);
    if (!person || person.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That person isn't on your chapter's roster.",
      });
    }

    // Upsert: one grant per (chapter, person) so a re-grant CHANGES the role in
    // place instead of stacking rows (which the effective-role resolver would
    // otherwise have to reconcile).
    const existing = await ctx.db
      .query("financeRoles")
      .withIndex("by_chapter_and_person", (q) =>
        q.eq("chapterId", chapterId).eq("personId", personId),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        role,
        scope,
        grantedByPersonId: access.personId ?? undefined,
      });
      return existing._id;
    }

    return await ctx.db.insert("financeRoles", {
      chapterId,
      personId,
      role,
      scope,
      grantedByPersonId: access.personId ?? undefined,
      createdAt: Date.now(),
    });
  },
});

/** Revoke a finance-role grant (manager only). */
export const revokeFinanceRole = mutation({
  args: { roleId: v.id("financeRoles") },
  returns: v.null(),
  handler: async (ctx, { roleId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const grant = await ctx.db.get(roleId);
    if (!grant || grant.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That finance role grant isn't in your chapter.",
      });
    }
    await ctx.db.delete(roleId);
    return null;
  },
});

/**
 * Every chapter in the org — the "Peek" list on the app-wide context switcher
 * (WP-S). CENTRAL-seat holders only — mirrors `mySeats`' superuser-first
 * pattern (superuser short-circuits to central reach before ever looking at
 * a chapter), NOT `dashboardCentral`'s gate (which has no superuser
 * special-case and returns its early-empty purely off the caller having no
 * chapter of their own). Here: check `isSuperuser` first; only if that's
 * false do we fall back to resolving the caller's own chapter and checking
 * central reach through it. A caller with no central seat (superuser or
 * otherwise), or no chapter of their own to check reach through, gets `[]` —
 * a quiet "nothing to peek into", not a thrown error, since the client uses
 * this to decide whether to render the Peek section at all.
 *
 * This is a READ-ONLY listing (id + name); it grants no access by itself —
 * every screen that actually uses a peeked chapterId re-checks central reach
 * on its own scoped query (e.g. `finances.dashboardChapter`'s drill-down
 * gate), same as before this query existed.
 */
export const listChaptersForPeek = query({
  args: {},
  returns: v.array(v.object({ chapterId: v.id("chapters"), name: v.string() })),
  handler: async (ctx) => {
    let isCentral = await isSuperuser(ctx);
    if (!isCentral) {
      const chapterId = await getChapterIdOrNull(ctx);
      if (!chapterId) return [];
      const access = await getFinanceRole(ctx, chapterId as Id<"chapters">);
      isCentral = access.isCentral;
    }
    if (!isCentral) return [];

    const chapters = await listActiveChapters(ctx, ROLLUP_SCAN_LIMIT);
    return chapters
      .map((c) => ({ chapterId: c._id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
