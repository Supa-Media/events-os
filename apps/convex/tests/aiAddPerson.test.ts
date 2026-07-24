/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Person-centric audiences Phase 2 (specs/person-centric-audiences.md) —
 * `personEmails` write-through gap fix: `ai.ts#addPerson` (the AI
 * assistant's `add_person` tool) inserted a roster row with `email` but never
 * recorded it — the SAME kind of direct roster-add `people.ts#create`
 * already covers.
 */

describe("ai.addPerson", () => {
  test("records a 'roster' source write-through row when email is given", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const personId = (await t.mutation(internal.ai.addPerson, {
      chapterId: s.chapterId,
      name: "Ada Assistant-Added",
      email: "Ada@Example.com",
    })) as Id<"people">;

    const rows: Doc<"personEmails">[] = await run(s.t, (ctx) =>
      ctx.db.query("personEmails").withIndex("by_person", (q) => q.eq("personId", personId)).collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "ada@example.com", source: "roster", verified: true });
  });

  test("no-ops the ledger when no email is given (phone-only)", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const personId = (await t.mutation(internal.ai.addPerson, {
      chapterId: s.chapterId,
      name: "Phone Only",
      phone: "5551234567",
    })) as Id<"people">;

    const rows = await run(s.t, (ctx) =>
      ctx.db.query("personEmails").withIndex("by_person", (q) => q.eq("personId", personId)).collect(),
    );
    expect(rows).toHaveLength(0);
  });
});
