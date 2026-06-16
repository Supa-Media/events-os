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
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// Glob every module so convex-test can resolve `api.*` / `internal.*`.
export const modules = import.meta.glob("../**/*.*s");

export type TestConvex = ReturnType<typeof convexTest>;

export function newT(): TestConvex {
  return convexTest(schema, modules);
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
