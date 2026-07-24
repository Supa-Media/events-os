/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { reconcilePersonForUser, mergePersonInto } from "../lib/people";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Person-centric audiences Phase 2 (specs/person-centric-audiences.md) —
 * `personEmails` write-through gap fix for `lib/people.ts`'s login-time
 * roster reconciliation: `reconcilePersonForUser`'s fresh-insert branch and
 * its `claimFields`-driven patch both write `email`/`pwEmail` directly, and
 * `mergePersonInto`'s CARRY_SCALAR blank-fill does too — none of the three
 * used to touch `personEmails`, and `mergePersonInto` never re-pointed the
 * merged-away duplicate's own ledger rows either.
 */

async function seedPerson(
  s: ChapterSetup,
  fields: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId: s.chapterId, createdAt: Date.now(), ...fields }),
  );
}

async function personEmailsFor(s: ChapterSetup, personId: Id<"people">): Promise<Doc<"personEmails">[]> {
  return run(s.t, (ctx) =>
    ctx.db.query("personEmails").withIndex("by_person", (q) => q.eq("personId", personId)).collect(),
  );
}

describe("reconcilePersonForUser — fresh insert (no candidates)", () => {
  test("records write-through for the login email, converging roster+pw onto one 'pw' row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const freshUser = await run(s.t, (ctx) => ctx.db.insert("users", { email: "fresh@publicworship.life" }));

    const personId = await run(s.t, (ctx) =>
      reconcilePersonForUser(ctx, s.chapterId, freshUser, { name: "Fresh Person", email: "fresh@publicworship.life" }),
    );

    const rows = await personEmailsFor(s, personId);
    // Both people.email and people.pwEmail were set to the SAME login
    // address, so recordPersonEmail's upgrade-only rule converges the two
    // write-through calls onto ONE row labeled with the higher-trust source.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "fresh@publicworship.life", source: "pw", verified: true });
  });
});

describe("reconcilePersonForUser — claimFields patch (existing unlinked row)", () => {
  test("claiming an unlinked row by matching personal email records the NEW pwEmail (login address)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const loginUser = await run(s.t, (ctx) => ctx.db.insert("users", { email: "login@publicworship.life" }));
    // Imported before sign-in: the importer recorded their (future) login
    // address as the contact `email`, no `pwEmail` yet, no `userId` — the
    // exact shape `collectPersonRowsForUser` matches an unlinked row by.
    const personId = await seedPerson(s, { name: "Imported", email: "login@publicworship.life" });

    const claimedId = await run(s.t, (ctx) =>
      reconcilePersonForUser(ctx, s.chapterId, loginUser, {
        name: "Imported",
        email: "login@publicworship.life",
      }),
    );
    expect(claimedId).toBe(personId);

    const rows = await personEmailsFor(s, personId);
    // ONLY the new pwEmail write-through ran — `email` never appeared in
    // `patch` (claimFields never overwrites an existing personal address),
    // so this direct-insert-seeded person's personal email has no ledger row
    // of its own (that's a pre-existing gap the seed helper itself creates,
    // not something this reconcile call is responsible for).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "login@publicworship.life", source: "pw", verified: true });
  });
});

describe("mergePersonInto (via reconcilePersonForUser's multi-candidate merge)", () => {
  test("blank-fills email/pwEmail onto the survivor with write-through, and repoints the duplicate's ledger with no orphans", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const user = await run(s.t, (ctx) => ctx.db.insert("users", { email: "merge-user@publicworship.life" }));

    // Two rows for the SAME human: one already linked to the account (no
    // email yet), one unlinked import row matching by personal email — both
    // get picked up by `collectPersonRowsForUser` and merged.
    const linkedId = await seedPerson(s, { name: "Linked", userId: user });
    const importedId = await seedPerson(s, {
      name: "Imported Twin",
      email: "twin@example.com",
    });
    // The imported twin ALSO carries a personEmails row from a donor link —
    // this must be re-pointed onto the survivor, not orphaned on deletion.
    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId: importedId,
        email: "twin-donor@example.com",
        source: "donor",
        verified: true,
        addedAt: 500,
      }),
    );

    const survivorId = await run(s.t, (ctx) =>
      reconcilePersonForUser(ctx, s.chapterId, user, {
        name: "Linked",
        email: "twin@example.com", // matches the imported row's personal email
      }),
    );
    expect(survivorId).toBe(linkedId);

    // The imported duplicate is gone.
    expect(await run(s.t, (ctx) => ctx.db.get(importedId))).toBeNull();

    const rows = await personEmailsFor(s, survivorId);
    const emails = rows.map((r) => r.email).sort();
    expect(emails).toEqual(["twin-donor@example.com", "twin@example.com"]);
    // The blank-filled `email` (mergePersonInto's CARRY_SCALAR) was recorded
    // by the merge's own write-through (source "roster"), then reconcile's
    // OWN top-level claimFields patch also fires for the same address
    // (fresh.pwEmail was still blank post-merge, so login sets pwEmail too)
    // — `recordPersonEmail`'s upgrade-only rule converges the two calls onto
    // ONE row, relabeled to the higher-trust "pw" source rather than
    // duplicating. Exactly one row for the address either way.
    expect(rows.filter((r) => r.email === "twin@example.com")).toHaveLength(1);
    expect(rows.find((r) => r.email === "twin@example.com")).toMatchObject({
      source: "pw",
      verified: true,
    });
    // The duplicate's donor-sourced row was re-pointed, not orphaned.
    const donorRow = rows.find((r) => r.email === "twin-donor@example.com")!;
    expect(donorRow.personId).toBe(survivorId);

    // No row anywhere still references the deleted duplicate.
    const allRows = await run(s.t, (ctx) => ctx.db.query("personEmails").collect());
    expect(allRows.some((r) => r.personId === importedId)).toBe(false);
  });

  test("direct mergePersonInto call: collision on the SAME address keeps the more-trustworthy row and clears isPrimary on repoint", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const survivorId = await seedPerson(s, { name: "Survivor", email: "survivor@example.com" });
    const duplicateId = await seedPerson(s, { name: "Dup" });

    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId: survivorId,
        email: "collide@example.com",
        source: "rsvp",
        verified: false,
        addedAt: 100,
      }),
    );
    // The duplicate's row for the SAME address is MORE trustworthy (verified
    // roster) and also happens to be marked primary — it should win the
    // collision (replacing the survivor's weaker row) but still lose its
    // `isPrimary` flag on repoint.
    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId: duplicateId,
        email: "collide@example.com",
        source: "roster",
        verified: true,
        isPrimary: true,
        addedAt: 200,
      }),
    );

    await run(s.t, (ctx) => mergePersonInto(ctx, s.chapterId, survivorId, duplicateId));

    const rows = await personEmailsFor(s, survivorId);
    const collideRows = rows.filter((r) => r.email === "collide@example.com");
    expect(collideRows).toHaveLength(1);
    expect(collideRows[0]).toMatchObject({ source: "roster", verified: true });
    expect(collideRows[0].isPrimary).toBeUndefined();
    expect(rows.filter((r) => r.isPrimary === true)).toHaveLength(0);
  });
});
