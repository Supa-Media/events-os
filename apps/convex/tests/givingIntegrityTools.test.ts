/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Doc, Id } from "../_generated/dataModel";
import { BACKER_UNIT_CENTS } from "@events-os/shared";

/**
 * Giving integrity tools (owner feedback) — delete-with-reason, gift splits,
 * donor↔person link repair + field-edit audit, and the backer lifecycle
 * (paused/started-at/delete/history). Money stays integer cents; every rollup
 * recomputes EXACTLY from actuals; every human write leaves an audit breadcrumb.
 */

async function seatDevDirector(s: ChapterSetup): Promise<void> {
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", "development_director"))
      .unique();
    if (!def) throw new Error("development_director not seeded");
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope: "central",
      personId,
      createdAt: Date.now(),
    });
  });
}

async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatDevDirector(s);
  return s;
}

/** An authenticated caller with NO giving seat anywhere. */
async function outsider(s: ChapterSetup) {
  const uid = await run(s.t, (ctx) =>
    ctx.db.insert("users", { email: "outsider@publicworship.life" }),
  );
  return s.t.withIdentity({ subject: `${uid}|session`, issuer: "test" });
}

const donorRow = (s: ChapterSetup, id: Id<"donors">) =>
  run(s.t, (ctx) => ctx.db.get(id)) as Promise<Doc<"donors"> | null>;
const giftRow = (s: ChapterSetup, id: Id<"gifts">) =>
  run(s.t, (ctx) => ctx.db.get(id)) as Promise<Doc<"gifts"> | null>;

async function scopeRollup(s: ChapterSetup, scope: Id<"chapters"> | "central") {
  return run(s.t, (ctx) =>
    ctx.db
      .query("givingScopeRollups")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .unique(),
  );
}
async function chapterBackerCount(s: ChapterSetup): Promise<number> {
  const c = (await run(s.t, (ctx) => ctx.db.get(s.chapterId))) as Doc<"chapters">;
  return c.backerCount ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// #1 — delete gift requires a "why" + snapshot audit
// ═══════════════════════════════════════════════════════════════════════════

describe("removeGift requires a reason", () => {
  async function seedGift(s: ChapterSetup) {
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Wire Donor",
      email: "wire@x.com",
    })) as Id<"donors">;
    const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 82000,
      method: "givebutter",
    })) as Id<"gifts">;
    return { donorId, giftId };
  }

  test("rejects a blank why", async () => {
    const s = await devDirectorSetup();
    const { giftId } = await seedGift(s);
    await expect(
      s.as.mutation(api.givingPlatform.removeGift, { giftId, why: "   " }),
    ).rejects.toThrow(/why/i);
    // Gift still present (nothing removed).
    expect(await giftRow(s, giftId)).not.toBeNull();
  });

  test("removes, reverses rollups, and writes a deleted snapshot breadcrumb", async () => {
    const s = await devDirectorSetup();
    const { donorId, giftId } = await seedGift(s);
    expect((await scopeRollup(s, "central"))?.lifetimeCents).toBe(82000);

    await s.as.mutation(api.givingPlatform.removeGift, {
      giftId,
      why: "Actually a PTB ticket-sale payout, not a gift",
    });

    expect(await giftRow(s, giftId)).toBeNull();
    expect((await scopeRollup(s, "central"))?.lifetimeCents).toBe(0);
    expect((await donorRow(s, donorId))?.lifetimeCents).toBe(0);

    // A self-contained snapshot survives on the book-level trail (by_scope).
    const audit = await run(s.t, (ctx) =>
      ctx.db
        .query("giftAudit")
        .withIndex("by_scope_and_at", (q) => q.eq("scope", "central"))
        .order("desc")
        .first(),
    );
    expect(audit?.action).toBe("deleted");
    expect(audit?.note).toMatch(/PTB ticket-sale/);
    const fields = (audit?.changes ?? []).map((c) => c.field);
    expect(fields).toEqual(
      expect.arrayContaining(["Donor", "Amount", "Date", "Book", "Source"]),
    );
    expect(audit?.changes?.find((c) => c.field === "Amount")?.to).toBe("$820.00");
    expect(audit?.changes?.find((c) => c.field === "Donor")?.to).toBe("Wire Donor");
  });

  test("gating: a non-manager cannot remove", async () => {
    const s = await devDirectorSetup();
    const { giftId } = await seedGift(s);
    const out = await outsider(s);
    await expect(
      out.mutation(api.givingPlatform.removeGift, { giftId, why: "nope" }),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #2 — split a gift across books
// ═══════════════════════════════════════════════════════════════════════════

describe("splitGift", () => {
  async function seedWire(s: ChapterSetup) {
    return (await s.as.mutation(api.givingPlatform.addGift, {
      scope: "central",
      name: "Seyi",
      email: "seyi@x.com",
      amountCents: 100000,
      method: "wire",
      note: "Founder wire",
    })) as { giftId: Id<"gifts">; donorId: Id<"donors"> };
  }

  test("rejects fewer than two parts", async () => {
    const s = await devDirectorSetup();
    const { giftId } = await seedWire(s);
    await expect(
      s.as.mutation(api.givingPlatform.splitGift, {
        giftId,
        parts: [{ scope: "central", amountCents: 100000 }],
        why: "x",
      }),
    ).rejects.toThrow(/at least two/i);
  });

  test("rejects parts that don't sum to the original", async () => {
    const s = await devDirectorSetup();
    const { giftId } = await seedWire(s);
    await expect(
      s.as.mutation(api.givingPlatform.splitGift, {
        giftId,
        parts: [
          { scope: "central", amountCents: 60000 },
          { scope: s.chapterId, amountCents: 30000 },
        ],
        why: "x",
      }),
    ).rejects.toThrow(/sum to exactly/i);
  });

  test("splits central↔chapter with EXACT rollups + audit trail", async () => {
    const s = await devDirectorSetup();
    const { giftId } = await seedWire(s);
    expect((await scopeRollup(s, "central"))?.lifetimeCents).toBe(100000);

    const { childGiftIds } = (await s.as.mutation(api.givingPlatform.splitGift, {
      giftId,
      parts: [
        { scope: "central", amountCents: 70000 },
        { scope: s.chapterId, amountCents: 30000 },
      ],
      why: "Split founder wire between Central and New York",
    })) as { childGiftIds: Id<"gifts">[] };

    // Original gone; two children with the split note suffix.
    expect(await giftRow(s, giftId)).toBeNull();
    expect(childGiftIds).toHaveLength(2);

    // Rollups net EXACTLY: central 100k → 70k, NY 0 → 30k. Sum preserved.
    expect((await scopeRollup(s, "central"))?.lifetimeCents).toBe(70000);
    expect((await scopeRollup(s, s.chapterId))?.lifetimeCents).toBe(30000);
    expect((await scopeRollup(s, "central"))?.giftCount).toBe(1);
    expect((await scopeRollup(s, s.chapterId))?.giftCount).toBe(1);

    const children = await Promise.all(childGiftIds.map((id) => giftRow(s, id)));
    expect(children.map((c) => c?.amountCents).sort()).toEqual([30000, 70000]);
    for (const c of children) {
      expect(c?.method).toBe("wire");
      expect(c?.note).toMatch(/Founder wire \(split \d\/2\)/);
    }

    // The NY child's donor is person-linked (chapter roster).
    const nyChild = children.find((c) => c?.scope === s.chapterId)!;
    const nyDonor = await donorRow(s, nyChild.donorId);
    expect(nyDonor?.personId).toBeDefined();

    // "split" breadcrumb survives on the original's book trail; each child has a
    // "createdBySplit" breadcrumb.
    const splitAudit = await run(s.t, (ctx) =>
      ctx.db
        .query("giftAudit")
        .withIndex("by_scope_and_at", (q) => q.eq("scope", "central"))
        .order("desc")
        .collect(),
    );
    expect(splitAudit.some((a) => a.action === "split")).toBe(true);
    const childAudit = await run(s.t, (ctx) =>
      ctx.db
        .query("giftAudit")
        .withIndex("by_gift", (q) => q.eq("giftId", childGiftIds[0]))
        .first(),
    );
    expect(childAudit?.action).toBe("createdBySplit");
    expect(childAudit?.note).toMatch(/Split founder wire/);
  });

  test("blocks a system-written gift (event donation)", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Sys",
      email: "sys@x.com",
    })) as Id<"donors">;
    // Simulate a system gift by stamping a donationId directly.
    const giftId = await run(s.t, (ctx) =>
      ctx.db.insert("gifts", {
        donorId,
        scope: "central",
        amountCents: 5000,
        currency: "usd",
        receivedAt: Date.now(),
        method: "stripe",
        stripeInvoiceId: "in_test_123",
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.givingPlatform.splitGift, {
        giftId,
        parts: [
          { scope: "central", amountCents: 2000 },
          { scope: s.chapterId, amountCents: 3000 },
        ],
        why: "x",
      }),
    ).rejects.toThrow(/owned by its source/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #3 — donor↔person link repair + mergeDonors regression
// ═══════════════════════════════════════════════════════════════════════════

describe("setDonorPerson", () => {
  test("links a chapter donor to a roster person + audits", async () => {
    const s = await devDirectorSetup();
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Roster Seyi",
        email: "roster@x.com",
        createdAt: Date.now(),
      }),
    );
    // A chapter donor deliberately unlinked (direct insert).
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Unlinked Donor",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    await s.as.mutation(api.givingPlatform.setDonorPerson, {
      donorId,
      personId,
      why: "repair after merge",
    });
    expect((await donorRow(s, donorId))?.personId).toBe(personId);

    const audit = await s.as.query(api.givingPlatform.listDonorAudit, { donorId });
    expect(audit[0].action).toBe("linkedPerson");
    expect(audit[0].note).toBe("repair after merge");
  });

  test("unlink clears the link + audits", async () => {
    const s = await devDirectorSetup();
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "P", createdAt: Date.now() }),
    );
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "D",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        personId,
        createdAt: Date.now(),
      }),
    );
    await s.as.mutation(api.givingPlatform.setDonorPerson, { donorId, personId: null });
    expect((await donorRow(s, donorId))?.personId).toBeUndefined();
    const audit = await s.as.query(api.givingPlatform.listDonorAudit, { donorId });
    expect(audit[0].action).toBe("unlinkedPerson");
  });

  test("refuses linking a central donor, and a cross-chapter person", async () => {
    const s = await devDirectorSetup();
    const centralDonor = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "C",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    const person = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "P", createdAt: Date.now() }),
    );
    await expect(
      s.as.mutation(api.givingPlatform.setDonorPerson, {
        donorId: centralDonor,
        personId: person,
      }),
    ).rejects.toThrow(/CRM-only|central/i);

    // Cross-chapter: a person from ANOTHER chapter.
    const otherChapter = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "LA", isActive: true, createdAt: Date.now() }),
    );
    const otherPerson = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: otherChapter, name: "Q", createdAt: Date.now() }),
    );
    const chapterDonor = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "D",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.givingPlatform.setDonorPerson, {
        donorId: chapterDonor,
        personId: otherPerson,
      }),
    ).rejects.toThrow(/own roster/i);
  });
});

describe("mergeDonors preserves the person link (regression)", () => {
  test("survivor UNLINKED + duplicate LINKED → survivor adopts the link", async () => {
    const s = await devDirectorSetup();
    const scope = s.chapterId;
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: scope, name: "Real", email: "real@x.com", createdAt: Date.now() }),
    );
    const survivorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", { scope, kind: "individual", name: "Manual", status: "prospect", lifetimeCents: 0, giftCount: 0, createdAt: Date.now() }),
    );
    const duplicateId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", { scope, kind: "individual", name: "Auto", email: "real@x.com", status: "prospect", lifetimeCents: 0, giftCount: 0, personId, createdAt: Date.now() }),
    );
    await s.as.mutation(api.dataHygiene.mergeDonors, { scope, survivorId, duplicateId });
    expect((await donorRow(s, survivorId))?.personId).toBe(personId);
  });

  test("both LINKED → survivor keeps its own link", async () => {
    const s = await devDirectorSetup();
    const scope = s.chapterId;
    const p1 = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: scope, name: "P1", email: "p1@x.com", createdAt: Date.now() }),
    );
    const p2 = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: scope, name: "P2", email: "p2@x.com", createdAt: Date.now() }),
    );
    const survivorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", { scope, kind: "individual", name: "S", email: "p1@x.com", status: "prospect", lifetimeCents: 0, giftCount: 0, personId: p1, createdAt: Date.now() }),
    );
    const duplicateId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", { scope, kind: "individual", name: "D", email: "p2@x.com", status: "prospect", lifetimeCents: 0, giftCount: 0, personId: p2, createdAt: Date.now() }),
    );
    await s.as.mutation(api.dataHygiene.mergeDonors, { scope, survivorId, duplicateId });
    expect((await donorRow(s, survivorId))?.personId).toBe(p1);
  });

  test("both UNLINKED but a roster match exists → survivor re-links after merge", async () => {
    const s = await devDirectorSetup();
    const scope = s.chapterId;
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: scope, name: "Match", email: "match@x.com", createdAt: Date.now() }),
    );
    // Survivor has the matching email but was never linked; duplicate name-only.
    const survivorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", { scope, kind: "individual", name: "Match", email: "match@x.com", status: "prospect", lifetimeCents: 0, giftCount: 0, createdAt: Date.now() }),
    );
    const duplicateId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", { scope, kind: "individual", name: "Match", status: "prospect", lifetimeCents: 0, giftCount: 0, createdAt: Date.now() }),
    );
    await s.as.mutation(api.dataHygiene.mergeDonors, { scope, survivorId, duplicateId });
    expect((await donorRow(s, survivorId))?.personId).toBe(personId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #4 — donor + person field-edit audit; listDonors exposes the link
// ═══════════════════════════════════════════════════════════════════════════

describe("field-edit audit", () => {
  test("upsertDonor edit writes a donorAudit row for name/email/phone", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Old Name",
      email: "old@x.com",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      donorId,
      name: "New Name",
      email: "new@x.com",
      phone: "555-1212",
      why: "fixed the typo",
    });
    const audit = await s.as.query(api.givingPlatform.listDonorAudit, { donorId });
    const edited = audit.find((a) => a.action === "edited");
    expect(edited).toBeDefined();
    expect(edited!.note).toBe("fixed the typo");
    const fields = edited!.changes.map((c) => c.field).sort();
    expect(fields).toEqual(["Email", "Name", "Phone"]);
    expect(edited!.changes.find((c) => c.field === "Name")).toMatchObject({
      from: "Old Name",
      to: "New Name",
    });
  });

  test("people.update writes a personAudit row only when contact fields change", async () => {
    const s = await devDirectorSetup();
    const personId = (await s.as.mutation(api.people.create, {
      name: "Person One",
      email: "one@x.com",
    })) as Id<"people">;
    // A non-contact edit writes nothing.
    await s.as.mutation(api.people.update, { personId, role: "Usher" });
    let trail = await s.as.query(api.people.listPersonAudit, { personId });
    expect(trail).toHaveLength(0);
    // A contact edit does.
    await s.as.mutation(api.people.update, {
      personId,
      email: "two@x.com",
      why: "new address",
    });
    trail = await s.as.query(api.people.listPersonAudit, { personId });
    expect(trail).toHaveLength(1);
    expect(trail[0].changes[0]).toMatchObject({
      field: "Email",
      from: "one@x.com",
      to: "two@x.com",
    });
    expect(trail[0].note).toBe("new address");
  });

  test("listDonors exposes personId + linkedPersonName", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Linked Giver",
      email: "linked@x.com",
    })) as Id<"donors">;
    const rows = await s.as.query(api.givingPlatform.listDonors, {
      scope: s.chapterId,
    });
    const row = rows.find((r) => r._id === donorId)!;
    expect(row.personId).toBeDefined();
    expect(row.linkedPersonName).toBe("Linked Giver");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #5 — backer lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("backer lifecycle", () => {
  async function seedActiveBacker(s: ChapterSetup) {
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Backer",
      email: "backer@x.com",
    })) as Id<"donors">;
    const pledgeId = await run(s.t, (ctx) =>
      ctx.db.insert("pledges", {
        donorId,
        scope: s.chapterId,
        amountCents: BACKER_UNIT_CENTS,
        status: "active",
        origin: "stripe",
        createdAt: Date.now(),
      }),
    );
    // Prime the derived count from this active pledge.
    await run(s.t, (ctx) =>
      ctx.db.patch(s.chapterId, { backerCount: 1, backerCountUpdatedAt: Date.now() }),
    );
    return { donorId, pledgeId };
  }

  test("pause excludes from backerCount + isBacker but keeps the pledge listed", async () => {
    const s = await devDirectorSetup();
    const { donorId, pledgeId } = await seedActiveBacker(s);
    expect(await chapterBackerCount(s)).toBe(1);

    await s.as.mutation(api.givingPledges.setPledgeStatus, {
      pledgeId,
      status: "paused",
      why: "backer asked to pause",
    });

    // Not counted.
    expect(await chapterBackerCount(s)).toBe(0);
    // isBacker false now.
    const marks = await s.as.query(api.givingPlatform.giverMarks, {
      chapterId: s.chapterId,
    });
    // (donor has no gift, so it may not appear in giverMarks; assert via pledge)
    void marks;
    // Still in the backers list (history preserved).
    const list = await s.as.query(api.givingPledges.listPledges, {
      scope: s.chapterId,
    });
    expect(list.some((p) => p._id === pledgeId && p.status === "paused")).toBe(true);
    void donorId;

    // Resume restores the count.
    await s.as.mutation(api.givingPledges.setPledgeStatus, {
      pledgeId,
      status: "active",
    });
    expect(await chapterBackerCount(s)).toBe(1);
  });

  test("paused giver's isBacker is false", async () => {
    const s = await devDirectorSetup();
    const { donorId, pledgeId } = await seedActiveBacker(s);
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 1000,
      method: "cash",
    });
    let marks = await s.as.query(api.givingPlatform.giverMarks, {
      chapterId: s.chapterId,
    });
    expect(marks.find((m) => m.donorId === donorId)?.isBacker).toBe(true);
    await s.as.mutation(api.givingPledges.setPledgeStatus, { pledgeId, status: "paused" });
    marks = await s.as.query(api.givingPlatform.giverMarks, {
      chapterId: s.chapterId,
    });
    expect(marks.find((m) => m.donorId === donorId)?.isBacker).toBe(false);
  });

  test("invalid transitions are refused", async () => {
    const s = await devDirectorSetup();
    const { pledgeId } = await seedActiveBacker(s);
    // Resume an already-active pledge is a no-op (returns null, no throw)…
    await s.as.mutation(api.givingPledges.setPledgeStatus, { pledgeId, status: "active" });
    // …but resuming a canceled pledge is refused.
    await run(s.t, (ctx) => ctx.db.patch(pledgeId, { status: "canceled" }));
    await expect(
      s.as.mutation(api.givingPledges.setPledgeStatus, { pledgeId, status: "active" }),
    ).rejects.toThrow(/paused pledge can be resumed/i);
  });

  test("editPledgeStartedAt requires a why and writes a startedAt event", async () => {
    const s = await devDirectorSetup();
    const { pledgeId } = await seedActiveBacker(s);
    await expect(
      s.as.mutation(api.givingPledges.editPledgeStartedAt, {
        pledgeId,
        startedAt: 1000,
        why: "",
      }),
    ).rejects.toThrow(/why/i);
    const when = new Date("2025-01-15").getTime();
    await s.as.mutation(api.givingPledges.editPledgeStartedAt, {
      pledgeId,
      startedAt: when,
      why: "his Since data was wrong",
    });
    const pledge = (await run(s.t, (ctx) => ctx.db.get(pledgeId))) as Doc<"pledges">;
    expect(pledge.startedAt).toBe(when);
    const history = await s.as.query(api.givingPledges.pledgeHistory, { pledgeId });
    expect(history.some((e) => e.kind === "startedAt")).toBe(true);
  });

  test("deletePledge requires a why, snapshots, and drops the count", async () => {
    const s = await devDirectorSetup();
    const { pledgeId } = await seedActiveBacker(s);
    await expect(
      s.as.mutation(api.givingPledges.deletePledge, { pledgeId, why: " " }),
    ).rejects.toThrow(/why/i);
    await s.as.mutation(api.givingPledges.deletePledge, {
      pledgeId,
      why: "duplicate pledge",
    });
    expect(await run(s.t, (ctx) => ctx.db.get(pledgeId))).toBeNull();
    expect(await chapterBackerCount(s)).toBe(0);
  });

  test("pledgeHistory records manual AND system transitions", async () => {
    const s = await devDirectorSetup();
    const { pledgeId } = await seedActiveBacker(s);

    // Manual pause (actor = the desk user).
    await s.as.mutation(api.givingPledges.setPledgeStatus, { pledgeId, status: "paused" });
    // A system cancel via the webhook path (link a subscription id first).
    await run(s.t, (ctx) => ctx.db.patch(pledgeId, { stripeSubscriptionId: "sub_x" }));
    await run(s.t, (ctx) =>
      ctx.runMutation(api.givingPledges.cancelPledgeSubscription, {
        subscriptionId: "sub_x",
      }),
    );

    const history = await s.as.query(api.givingPledges.pledgeHistory, { pledgeId });
    const kinds = history.map((e) => `${e.kind}:${e.to}:${e.actor}`);
    // Newest-first: system cancel (actor "System"), then the manual pause.
    expect(history.some((e) => e.to === "Paused" && e.actor !== "System")).toBe(true);
    expect(history.some((e) => e.to === "Canceled" && e.actor === "System")).toBe(true);
    void kinds;
  });

  test("a manual pause is not clobbered by a benign subscription.updated (Stripe)", async () => {
    const s = await devDirectorSetup();
    const { pledgeId } = await seedActiveBacker(s);
    await run(s.t, (ctx) => ctx.db.patch(pledgeId, { stripeSubscriptionId: "sub_y" }));
    await s.as.mutation(api.givingPledges.setPledgeStatus, { pledgeId, status: "paused" });

    // Stripe says the subscription is still active — must NOT resume the pause.
    await run(s.t, (ctx) =>
      ctx.runMutation(api.givingPledges.syncPledgeSubscription, {
        subscriptionId: "sub_y",
        stripeStatus: "active",
      }),
    );
    expect(
      ((await run(s.t, (ctx) => ctx.db.get(pledgeId))) as Doc<"pledges">).status,
    ).toBe("paused");
    expect(await chapterBackerCount(s)).toBe(0);

    // But a genuine Stripe cancel DOES override the pause.
    await run(s.t, (ctx) =>
      ctx.runMutation(api.givingPledges.syncPledgeSubscription, {
        subscriptionId: "sub_y",
        stripeStatus: "canceled",
      }),
    );
    expect(
      ((await run(s.t, (ctx) => ctx.db.get(pledgeId))) as Doc<"pledges">).status,
    ).toBe("canceled");
  });

  test("gating: a non-manager cannot pause", async () => {
    const s = await devDirectorSetup();
    const { pledgeId } = await seedActiveBacker(s);
    const out = await outsider(s);
    await expect(
      out.mutation(api.givingPledges.setPledgeStatus, { pledgeId, status: "paused" }),
    ).rejects.toThrow();
  });
});
