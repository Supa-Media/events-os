/**
 * Shared test setup for the Convex backend characterization suite.
 *
 * `convex-test` needs the full module map of the deployment, gathered via
 * `import.meta.glob`. The glob is rooted at the convex dir (one level up from
 * `tests/`) so every registered function + `schema.ts` is discovered.
 *
 * `setupChapter(t)` inserts the minimal auth + tenancy rows that the app's
 * `requireUserId` / `requireChapterId` guards need: a framework `users` row, a
 * `chapters` row, and the `userChapters` membership that links them — then
 * returns an authenticated client (`as`) plus the ids. The user's email is on
 * the allowed `publicworship.life` domain so `requireAccess` passes.
 */
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register as registerAggregate } from "@convex-dev/aggregate/test";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// Glob every module so convex-test can resolve `api.*` / `internal.*`.
export const modules = import.meta.glob("../**/*.*s");

export type TestConvex = ReturnType<typeof convexTest>;

export function newT(): TestConvex {
  const t = convexTest(schema, modules);
  // `lib/peopleAggregate.ts`'s `peopleByPersona` — registered globally here
  // (not per-test) because `people.ts#create`/`update`/`remove` and every
  // other trigger-wrapped mutation across the app (engagements, role
  // assignments, rsvps, merges, imports, …) calls into this component the
  // moment ANY test exercises one of those mutations, not just the aggregate
  // feature's own tests. The name MUST match `convex.config.ts`'s
  // `app.use(aggregate, { name: "peopleByPersona" })`.
  registerAggregate(t, "peopleByPersona");
  return t;
}

/**
 * `t.run` typed with the app's generated `MutationCtx` so callbacks get the
 * schema-aware `ctx.db` (indexes, table names) instead of convex-test's generic
 * `AnyDataModel` ctx.
 */
export function run<T>(
  t: TestConvex,
  fn: (ctx: MutationCtx) => Promise<T>,
): Promise<T> {
  return t.run(fn as (ctx: unknown) => Promise<T>);
}

/**
 * Store a 1×1 blob in file storage and return its id. `ctx.storage.store` is a
 * convex-test affordance not on the generated `StorageWriter` type, so it's
 * accessed through a cast here.
 */
export function storeBlob(t: TestConvex): Promise<Id<"_storage">> {
  return run(t, (ctx) =>
    (ctx.storage as unknown as {
      store: (b: Blob) => Promise<Id<"_storage">>;
    }).store(new Blob(["x"], { type: "image/png" })),
  );
}

/**
 * Push `codingRequiredSinceMs` to the far future for this test database.
 *
 * The transaction-coding policy ARMS ITSELF on 2026-09-01
 * (`DEFAULT_CODING_REQUIRED_SINCE_MS` is the fallback when no
 * `financeSettings` row says otherwise), at which point
 * `setTransactionStatus(…, "reconciled")` starts refusing uncoded spend with
 * `CODING_REQUIRED`. Suites that reconcile `Date.now()`-posted fixtures but
 * are NOT about coding call this from their seed helpers so they don't
 * start failing on the policy date. Idempotent — safe to call once per
 * inserted transaction. Coding's own suite (`transactionCodings.test.ts`)
 * deliberately does NOT use this; it pins `postedAt` around the default
 * policy date instead.
 */
export async function disarmCodingPolicy(t: TestConvex): Promise<void> {
  const FAR_FUTURE = Date.UTC(2100, 0, 1);
  await run(t, async (ctx) => {
    const settings = await ctx.db.query("financeSettings").first();
    if (settings) {
      if (settings.codingRequiredSinceMs !== FAR_FUTURE) {
        await ctx.db.patch(settings._id, { codingRequiredSinceMs: FAR_FUTURE });
      }
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: Date.now(),
        codingRequiredSinceMs: FAR_FUTURE,
      });
    }
  });
}

export interface ChapterSetup {
  /** An authenticated client scoped to the seeded user. */
  as: ReturnType<TestConvex["withIdentity"]>;
  userId: Id<"users">;
  chapterId: Id<"chapters">;
  email: string;
  t: TestConvex;
}

/**
 * Seed one user + one chapter + the membership linking them, and return an
 * authenticated client. The auth subject is `${userId}|session` because
 * `@convex-dev/auth`'s `getAuthUserId` reads the userId from the part of the
 * JWT subject before the `|` divider.
 */
export async function setupChapter(
  t: TestConvex,
  opts: { email?: string; chapterName?: string } = {},
): Promise<ChapterSetup> {
  const email = opts.email ?? "leader@publicworship.life";
  const chapterName = opts.chapterName ?? "New York";
  const { userId, chapterId } = await run(t, async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const chapterId = await ctx.db.insert("chapters", {
      name: chapterName,
      isActive: true,
      createdAt: Date.now(),
    });
    await ctx.db.insert("userChapters", {
      userId,
      chapterId,
      role: "admin",
      isActive: true,
      joinedAt: Date.now(),
    });
    return { userId, chapterId };
  });
  const as = t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId, chapterId, email, t };
}

/**
 * An APPROVED recurring budget in `book`, and the id to hang a charge off.
 *
 * Exists because `transactionCodings.approve` refuses a charge that owes a
 * budget and hasn't got one (founder, 2026-09-02: "we shouldn't be letting
 * things go through without a budget" — `finances.needsBudget`). Every suite
 * that seeds a spend row and then approves its coding needs one, and a suite
 * about WHO MAY APPROVE should not each grow its own budget-shaped fixture and
 * its own idea of what makes a budget attributable.
 *
 * `approvalStatus: "approved"` is the load-bearing field —
 * `finances.isAttributableBudget` is what any attribution write checks. The
 * rest is the minimum a `budgets` row needs to validate.
 */
export async function seedApprovedBudget(
  t: TestConvex,
  book: Id<"chapters"> | "central",
  opts: { label?: string; year?: number } = {},
): Promise<Id<"budgets">> {
  return run(t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: book,
      amountCents: 500_000,
      label: opts.label ?? "Operating",
      type: "recurring",
      // No `refKind` — a recurring operating budget hangs off no event or
      // project (`BUDGET_REF_KINDS` is event/project only).
      cadence: "yearly",
      year: opts.year ?? 2026,
      approvalStatus: "approved",
      createdAt: Date.now(),
    }),
  );
}
