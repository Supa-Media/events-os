/**
 * Finance seed helper.
 *
 * Typed loosely (`ctx: any`) so this file doesn't depend on Convex's generated
 * types — it's pure helper code (like the other `lib/seed/*` builders), called
 * from the registered seed mutations in `seed.ts`.
 *
 * Gives a freshly-seeded chapter a usable finance starting point:
 *  - default funds ("General Fund" unrestricted, "Designated" designated),
 *  - a few finance teams (Development, Marketing, Operations),
 *  - and a `manager` finance role (scope "chapter") for the seeding admin, so
 *    local dev has finance access out of the box.
 *
 * The admin's finance role is granted to their roster `people` row (finance
 * actors are `people`, resolved via `people.userId`); a row is created if the
 * admin doesn't have one yet.
 */
import { Id } from "../../_generated/dataModel";

export interface SeededChapterFinance {
  generalFundId: Id<"funds">;
  designatedFundId: Id<"funds">;
  adminPersonId: Id<"people">;
}

/** Seed default funds, finance teams, and the admin's manager finance role. */
export async function seedChapterFinance(
  ctx: any,
  chapterId: Id<"chapters">,
  adminUserId: Id<"users">,
  now: number,
): Promise<SeededChapterFinance> {
  // ── Default funds ──────────────────────────────────────────────────────────
  const generalFundId = (await ctx.db.insert("funds", {
    chapterId,
    name: "General Fund",
    restriction: "unrestricted",
    sortOrder: 0,
    isActive: true,
    createdAt: now,
  })) as Id<"funds">;
  const designatedFundId = (await ctx.db.insert("funds", {
    chapterId,
    name: "Designated",
    restriction: "designated",
    sortOrder: 1,
    isActive: true,
    createdAt: now,
  })) as Id<"funds">;

  // ── Finance teams / departments ────────────────────────────────────────────
  const teamNames = ["Development", "Marketing", "Operations"];
  for (let i = 0; i < teamNames.length; i++) {
    await ctx.db.insert("financeTeams", {
      chapterId,
      name: teamNames[i],
      sortOrder: i,
      isActive: true,
      createdAt: now,
    });
  }

  // ── Admin's roster person + manager finance role ───────────────────────────
  // Finance access is resolved through `people` (people.userId → viewerPerson),
  // so the admin needs a non-placeholder roster row to gain finance access.
  const existing = await ctx.db
    .query("people")
    .withIndex("by_user", (q: any) => q.eq("userId", adminUserId))
    .collect();
  const adminPerson = existing.find(
    (p: any) => p.chapterId === chapterId && p.isPlaceholder !== true,
  );
  const adminPersonId: Id<"people"> =
    adminPerson?._id ??
    ((await ctx.db.insert("people", {
      chapterId,
      name: "Chapter Admin",
      userId: adminUserId,
      isTeamMember: true,
      status: "active",
      createdAt: now,
    })) as Id<"people">);

  await ctx.db.insert("financeRoles", {
    chapterId,
    personId: adminPersonId,
    role: "manager",
    scope: "chapter",
    grantedByPersonId: adminPersonId,
    createdAt: now,
  });

  return { generalFundId, designatedFundId, adminPersonId };
}
