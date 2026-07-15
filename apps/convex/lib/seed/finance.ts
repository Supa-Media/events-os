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

/**
 * The out-of-the-box use-case categories every chapter gets under its General
 * Fund, so transactions can be coded to a use-case (and the AI coder has options
 * to suggest) from day one. Editable per chapter afterward — these are just
 * defaults. Kept in insertion order; each becomes a `budgetCategories` row with
 * `kind: "category"`.
 */
export const DEFAULT_EXPENSE_CATEGORIES = [
  "Food & Meals",
  "Transportation",
  "Travel & Lodging",
  "Software & Subscriptions",
  "Supplies",
  "Equipment",
  "Office & Admin",
  "Marketing & Advertising",
  "Professional Services",
  "Facilities & Rent",
  "Utilities",
  "Bank & Fees",
  "Other",
] as const;

// A generous bound on a single chapter's categories (they number in the dozens);
// mirrors the reads elsewhere in the finance layer.
const CATEGORY_SCAN_LIMIT = 5000;

/**
 * Insert the {@link DEFAULT_EXPENSE_CATEGORIES} under `fundId` (the chapter's
 * General Fund) as `kind: "category"` rows. Idempotent: any name already present
 * in the chapter is skipped, so re-runs (and partially-seeded chapters) are safe.
 * Returns the number of categories inserted.
 */
export async function insertDefaultExpenseCategories(
  ctx: any,
  chapterId: Id<"chapters">,
  fundId: Id<"funds">,
  now: number,
): Promise<number> {
  const existing = await ctx.db
    .query("budgetCategories")
    .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
    .take(CATEGORY_SCAN_LIMIT);
  const existingNames = new Set<string>(existing.map((c: any) => c.name));
  let sortOrder = existing.length;
  let inserted = 0;
  for (const name of DEFAULT_EXPENSE_CATEGORIES) {
    if (existingNames.has(name)) continue;
    await ctx.db.insert("budgetCategories", {
      chapterId,
      fundId,
      name,
      kind: "category",
      sortOrder: sortOrder++,
      isActive: true,
      createdAt: now,
    });
    inserted++;
  }
  return inserted;
}

/**
 * The default funds every chapter gets: a "General Fund" (unrestricted, general
 * operating) that budgets/categories nest under, and a "Designated" fund
 * (earmarked money). Kept in insertion order; `sortOrder` follows the array.
 */
export const DEFAULT_FUNDS: ReadonlyArray<{
  name: string;
  restriction: "unrestricted" | "designated";
}> = [
  { name: "General Fund", restriction: "unrestricted" },
  { name: "Designated", restriction: "designated" },
] as const;

/**
 * Ensure the chapter's {@link DEFAULT_FUNDS} exist. Idempotent + chapter-scoped:
 * a fund whose name already exists is skipped, so this is safe to call on a
 * partially-seeded chapter or to re-run. Newly-created funds are appended after
 * any existing ones by `sortOrder`. Returns the number of funds inserted.
 *
 * Runs BEFORE category seeding so a chapter created before the finance seed
 * (zero funds — blocks category seeding, which needs a General Fund) gets its
 * funds + categories in one shot.
 */
export async function ensureDefaultFunds(
  ctx: any,
  chapterId: Id<"chapters">,
  now: number,
): Promise<number> {
  const existing = await ctx.db
    .query("funds")
    .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
    .take(CATEGORY_SCAN_LIMIT);
  const existingNames = new Set<string>(existing.map((f: any) => f.name));
  let sortOrder = existing.length;
  let inserted = 0;
  for (const fund of DEFAULT_FUNDS) {
    if (existingNames.has(fund.name)) continue;
    await ctx.db.insert("funds", {
      chapterId,
      name: fund.name,
      restriction: fund.restriction,
      sortOrder: sortOrder++,
      isActive: true,
      createdAt: now,
    });
    inserted++;
  }
  return inserted;
}

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

  // ── Default expense categories (under the General Fund) ─────────────────────
  // Gives a fresh chapter usable use-case categories so transactions can be
  // coded (and the AI coder can suggest) out of the box.
  await insertDefaultExpenseCategories(ctx, chapterId, generalFundId, now);

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
