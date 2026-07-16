/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * WP-2.2 — Bulk reattribution + audit trail (the split's execution tool).
 *
 * Pins the audited behavior of the tools that execute the retroactive split:
 *  - `reassignTransactions` moves a batch across the central boundary, clearing
 *    every chapter-scoped attribution per the documented per-field rules, and
 *    writing ONE `reattributionAudit` row;
 *  - central power is gated (central reach + the bookkeeper WRITE rank — a
 *    chapter manager and a central VIEWER are both blocked);
 *  - money (amount/flow) is never touched;
 *  - `suggestSplitAssignments` buckets a chapter's history per the playbook
 *    rules (event-linked → chapter, music-project → central) — suggestions only;
 *  - `transferProjectScope` moves a project's budgets + txns atomically + audits.
 *
 * A superuser (`seyi@publicworship.life`) is an implicit CENTRAL manager.
 */

const SUPER = "seyi@publicworship.life";

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function asCentralViewer(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "viewer",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

async function seedFund(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name = "General Fund",
): Promise<Id<"funds">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId,
      name,
      restriction: "unrestricted",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

async function seedCategory(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  fundId: Id<"funds">,
): Promise<Id<"budgetCategories">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      chapterId,
      fundId,
      name: "Supplies",
      kind: "category",
      createdAt: Date.now(),
    }),
  );
}

async function seedProject(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId,
      name,
      status: "in_progress",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedEvent(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Gathering",
      slug: "gathering",
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Sunday",
      eventDate: Date.now(),
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedTeam(
  s: ChapterSetup,
  chapterId: Id<"chapters"> | undefined,
): Promise<Id<"financeTeams">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("financeTeams", {
      ...(chapterId ? { chapterId } : {}),
      name: "Ops",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

async function seedPerson(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId, name: "Cardholder", createdAt: Date.now() }),
  );
}

async function seedBudget(
  s: ChapterSetup,
  chapterId: Id<"chapters"> | "central",
  extra: Record<string, unknown> = {},
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId,
      amountCents: 100000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      createdAt: Date.now(),
      ...extra,
    }),
  );
}

async function seedCard(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  cardholderPersonId: Id<"people">,
): Promise<Id<"cards">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId,
      cardholderPersonId,
      type: "virtual",
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  chapterId: Id<"chapters"> | "central",
  fields: Record<string, unknown> = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now(),
      status: "categorized",
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

// ── reassignTransactions: per-field clearing rules ───────────────────────────

describe("reassignTransactions: chapter → central clears chapter-scoped links", () => {
  test("clears fund/category/team/person + a source-chapter budget; leaves the legacy project/event FK untouched; keeps amount/flow", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    await seedSelfPerson(s);

    const fundId = await seedFund(s, s.chapterId);
    const categoryId = await seedCategory(s, s.chapterId, fundId);
    const projectId = await seedProject(s, s.chapterId, "Outreach");
    const eventId = await seedEvent(s, s.chapterId);
    const teamId = await seedTeam(s, s.chapterId);
    const personId = await seedPerson(s, s.chapterId);
    const chapterBudget = await seedBudget(s, s.chapterId);

    const txnId = await seedTxn(s, s.chapterId, {
      amountCents: 7777,
      flow: "outflow",
      fundId,
      categoryId,
      projectId,
      eventId,
      teamId,
      personId,
      budgetId: chapterBudget,
    });

    const res = await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [txnId],
      target: "central",
    });
    expect(res.updated).toBe(1);

    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.chapterId).toBe("central");
    expect(txn?.fundId).toBeUndefined();
    expect(txn?.categoryId).toBeUndefined();
    expect(txn?.teamId).toBeUndefined();
    expect(txn?.personId).toBeUndefined();
    // A source-chapter budget doesn't belong to central → cleared.
    expect(txn?.budgetId).toBeUndefined();
    // WP-U (one home per dollar): the legacy `projectId`/`eventId` FKs are
    // vestigial now — `budgetId` is the only real attribution — so a
    // reassignment NEVER touches them, leaving whatever value was already
    // there (no more FK clearing).
    expect(txn?.projectId).toBe(projectId);
    expect(txn?.eventId).toBe(eventId);
    // Money is UNCHANGED — reassignment only moves WHERE it belongs.
    expect(txn?.amountCents).toBe(7777);
    expect(txn?.flow).toBe("outflow");
  });

  test("KEEPS a central-owned budget when the txn moves to central", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const centralBudget = await seedBudget(s, "central");
    const txnId = await seedTxn(s, s.chapterId, { budgetId: centralBudget });

    await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [txnId],
      target: "central",
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.chapterId).toBe("central");
    expect(txn?.budgetId).toBe(centralBudget);
  });
});

describe("reassignTransactions: central → chapter assigns the General Fund", () => {
  test("a central txn moved to a chapter picks up that chapter's General Fund", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const boston = await makeChapter(s, "Boston");
    const bostonGeneral = await seedFund(s, boston, "General Fund");

    const txnId = await seedTxn(s, "central", {});
    await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [txnId],
      target: boston,
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.chapterId).toBe(boston);
    expect(txn?.fundId).toBe(bostonGeneral);
  });

  test("keeps a target-chapter budget, clears a source-chapter budget (→ chapter)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const boston = await makeChapter(s, "Boston");
    const bostonBudget = await seedBudget(s, boston);
    const nyBudget = await seedBudget(s, s.chapterId);

    const keepsId = await seedTxn(s, s.chapterId, { budgetId: bostonBudget });
    const clearsId = await seedTxn(s, s.chapterId, { budgetId: nyBudget });

    await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [keepsId, clearsId],
      target: boston,
    });
    const keeps = await run(t, (ctx) => ctx.db.get(keepsId));
    const clears = await run(t, (ctx) => ctx.db.get(clearsId));
    expect(keeps?.budgetId).toBe(bostonBudget); // Boston owns it → kept
    expect(clears?.budgetId).toBeUndefined(); // NY budget → cleared
  });
});

// ── Card-charge cardholder fallback survives reassignment ────────────────────

describe("reassignTransactions: card-charge cardholder still resolvable after moving to central", () => {
  test("cardId is retained, personId is cleared, cardholder still resolves in listReconcile", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const holder = await seedPerson(s, s.chapterId);
    const cardId = await seedCard(s, s.chapterId, holder);
    // A card charge: no explicit personId — the cardholder is resolved via
    // the card, exactly like `resolveCardholder` in listReconcile.
    const txnId = await seedTxn(s, s.chapterId, { cardId });

    await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [txnId],
      target: "central",
    });

    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.chapterId).toBe("central");
    expect(txn?.cardId).toBe(cardId); // provenance untouched
    expect(txn?.personId).toBeUndefined(); // chapter-scoped person link cleared

    const reconcile = await s.as.query(api.finances.listReconcile, { scope: "central" });
    const row = reconcile.rows.find((r) => r.id === txnId);
    expect(row?.cardholder?.personId).toBe(holder);
    expect(row?.cardholder?.name).toBe("Cardholder");
  });
});

// ── Audit trail ──────────────────────────────────────────────────────────────

describe("reassignTransactions: audit trail", () => {
  test("writes ONE audit row with the right count + from→to summary + actor", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    await seedSelfPerson(s);
    const a = await seedTxn(s, s.chapterId, {});
    const b = await seedTxn(s, s.chapterId, {});
    const c = await seedTxn(s, s.chapterId, {});

    const res = await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [a, b, c],
      target: "central",
      note: "split day",
    });

    const rows = await run(t, (ctx) => ctx.db.query("reattributionAudit").collect());
    expect(rows.length).toBe(1);
    expect(rows[0]._id).toBe(res.auditId);
    expect(rows[0].kind).toBe("bulk_reassign");
    expect(rows[0].transactionIds.length).toBe(3);
    expect(rows[0].target).toBe("central");
    expect(rows[0].summary).toBe("New York (3) → Central");
    expect(rows[0].note).toBe("split day");

    // The central-gated read query surfaces it with a resolved actor + count.
    const audit = await s.as.query(api.finances.listReattributionAudit, {});
    expect(audit.length).toBe(1);
    expect(audit[0].txnCount).toBe(3);
    expect(audit[0].actorName).toBe("Caller");
  });

  test("de-duplicates a doubled selection before counting", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const a = await seedTxn(s, s.chapterId, {});
    const res = await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [a, a, a],
      target: "central",
    });
    expect(res.updated).toBe(1);
    const rows = await run(t, (ctx) => ctx.db.query("reattributionAudit").collect());
    expect(rows[0].transactionIds.length).toBe(1);
  });

  test("snapshots each txn's exact pre-move attribution into priorStates", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const fundId = await seedFund(s, s.chapterId);
    const categoryId = await seedCategory(s, s.chapterId, fundId);
    const projectId = await seedProject(s, s.chapterId, "Outreach");
    const chapterBudget = await seedBudget(s, s.chapterId);

    const txnId = await seedTxn(s, s.chapterId, {
      fundId,
      categoryId,
      projectId,
      budgetId: chapterBudget,
    });

    const res = await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [txnId],
      target: "central",
    });

    const rows = await run(t, (ctx) => ctx.db.query("reattributionAudit").collect());
    expect(rows[0].priorStates.length).toBe(1);
    const prior = rows[0].priorStates[0];
    expect(prior.transactionId).toBe(txnId);
    // The snapshot is what it was BEFORE the move — not what the patch left it as.
    expect(prior.chapterId).toBe(s.chapterId);
    expect(prior.fundId).toBe(fundId);
    expect(prior.categoryId).toBe(categoryId);
    expect(prior.projectId).toBe(projectId);
    expect(prior.budgetId).toBe(chapterBudget);

    // Meanwhile the live txn has fund/category/budget cleared by the forward
    // move — but `projectId` (vestigial, WP-U) is left untouched.
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.fundId).toBeUndefined();
    expect(txn?.categoryId).toBeUndefined();
    expect(txn?.projectId).toBe(projectId);
    expect(txn?.budgetId).toBeUndefined();
    expect(res.auditId).toBe(rows[0]._id);
  });

  test("mixed-source-scope batch: a same-scope selection is skipped, not counted as a move", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const chapterTxn = await seedTxn(s, s.chapterId, {});
    const alreadyCentralTxn = await seedTxn(s, "central", {});

    const res = await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [chapterTxn, alreadyCentralTxn],
      target: "central",
    });
    expect(res.updated).toBe(1);
    expect(res.skippedSameScope).toBe(1);

    const rows = await run(t, (ctx) => ctx.db.query("reattributionAudit").collect());
    expect(rows.length).toBe(1);
    // Only the real move is in the audit trail — the no-op never crossed a
    // boundary, so counting it would misrepresent what actually happened.
    expect(rows[0].transactionIds).toEqual([chapterTxn]);
    expect(rows[0].transactionIds).not.toContain(alreadyCentralTxn);
    expect(rows[0].priorStates.length).toBe(1);
    expect(rows[0].summary).toBe("New York (1) → Central");
  });
});

// ── restoreReattribution (true undo) ─────────────────────────────────────────

describe("restoreReattribution: full round-trip", () => {
  test("restores chapterId + every cleared attribution back to its exact prior state", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const fundId = await seedFund(s, s.chapterId);
    const categoryId = await seedCategory(s, s.chapterId, fundId);
    const projectId = await seedProject(s, s.chapterId, "Outreach");
    const eventId = await seedEvent(s, s.chapterId);
    const teamId = await seedTeam(s, s.chapterId);
    const personId = await seedPerson(s, s.chapterId);
    const chapterBudget = await seedBudget(s, s.chapterId);

    const txnId = await seedTxn(s, s.chapterId, {
      fundId,
      categoryId,
      projectId,
      eventId,
      teamId,
      personId,
      budgetId: chapterBudget,
    });

    const { auditId } = await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [txnId],
      target: "central",
    });

    // Forward move landed as expected — every CHAPTER-SCOPED link cleared
    // (fund/category/team/person/budget); `projectId`/`eventId` (vestigial,
    // WP-U) are left untouched by the move.
    const moved = await run(t, (ctx) => ctx.db.get(txnId));
    expect(moved?.chapterId).toBe("central");
    expect(moved?.fundId).toBeUndefined();
    expect(moved?.categoryId).toBeUndefined();
    expect(moved?.teamId).toBeUndefined();
    expect(moved?.personId).toBeUndefined();
    expect(moved?.budgetId).toBeUndefined();
    expect(moved?.projectId).toBe(projectId);
    expect(moved?.eventId).toBe(eventId);

    // internalMutation — invoked directly, exactly like the run-convex-function
    // ops path (no client-facing caller exists for it).
    const result = await s.t.mutation(internal.finances.restoreReattribution, { auditId });
    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(0);

    const restored = await run(t, (ctx) => ctx.db.get(txnId));
    expect(restored?.chapterId).toBe(s.chapterId);
    expect(restored?.fundId).toBe(fundId);
    expect(restored?.categoryId).toBe(categoryId);
    expect(restored?.projectId).toBe(projectId);
    expect(restored?.eventId).toBe(eventId);
    expect(restored?.teamId).toBe(teamId);
    expect(restored?.personId).toBe(personId);
    expect(restored?.budgetId).toBe(chapterBudget);
  });

  test("skips (doesn't error on) a txn deleted since the original move", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const txnId = await seedTxn(s, s.chapterId, {});

    const { auditId } = await s.as.mutation(api.finances.reassignTransactions, {
      transactionIds: [txnId],
      target: "central",
    });
    await run(t, (ctx) => ctx.db.delete(txnId));

    const result = await s.t.mutation(internal.finances.restoreReattribution, { auditId });
    expect(result.restored).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

// ── Authz negatives (central power + write rank) ─────────────────────────────

describe("reassignTransactions: authz", () => {
  test("a chapter manager is FORBIDDEN (crossing the boundary is a central power)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const txnId = await seedTxn(s, s.chapterId, {});

    let caught: unknown;
    try {
      await s.as.mutation(api.finances.reassignTransactions, {
        transactionIds: [txnId],
        target: "central",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
    // Nothing moved.
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.chapterId).toBe(s.chapterId);
  });

  test("a central VIEWER is FORBIDDEN (write rank enforced, not just reach)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralViewer(s);
    const txnId = await seedTxn(s, s.chapterId, {});

    let caught: unknown;
    try {
      await s.as.mutation(api.finances.reassignTransactions, {
        transactionIds: [txnId],
        target: "central",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
  });

  test("empty selection and over-cap batch are rejected", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const one = await seedTxn(s, s.chapterId, {});

    await expect(
      s.as.mutation(api.finances.reassignTransactions, {
        transactionIds: [],
        target: "central",
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // 201 ids (a repeated real id) trips the cap BEFORE de-dup.
    const overCap = Array.from({ length: 201 }, () => one);
    let caught: unknown;
    try {
      await s.as.mutation(api.finances.reassignTransactions, {
        transactionIds: overCap,
        target: "central",
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("BATCH_TOO_LARGE");
  });
});

// ── suggestSplitAssignments (rules bucket; suggestions only) ──────────────────

describe("suggestSplitAssignments: playbook buckets", () => {
  test("event-linked → chapter, music-project → central, merchant → central, else unassigned", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });

    const music = await seedProject(s, s.chapterId, "Music Recording");
    const outreach = await seedProject(s, s.chapterId, "Outreach");
    const eventId = await seedEvent(s, s.chapterId);

    // WP-U (one home per dollar): the split heuristic reads a txn's BUDGET ref
    // (refKind/scopeRefId) — attribute via `budgetId`, not the legacy
    // `eventId`/`projectId` FKs directly.
    const eventBudget = await seedBudget(s, s.chapterId, {
      type: "one_time",
      refKind: "event",
      scopeRefId: eventId,
    });
    const musicBudget = await seedBudget(s, s.chapterId, {
      type: "one_time",
      refKind: "project",
      scopeRefId: music,
    });
    const outreachBudget = await seedBudget(s, s.chapterId, {
      type: "one_time",
      refKind: "project",
      scopeRefId: outreach,
    });

    const eventTxn = await seedTxn(s, s.chapterId, { budgetId: eventBudget });
    const musicTxn = await seedTxn(s, s.chapterId, { budgetId: musicBudget });
    const outreachTxn = await seedTxn(s, s.chapterId, { budgetId: outreachBudget });
    const merchantTxn = await seedTxn(s, s.chapterId, { merchantName: "Expansion Conference LLC" });
    const plainTxn = await seedTxn(s, s.chapterId, { merchantName: "Corner Deli" });

    const res = await s.as.query(api.finances.suggestSplitAssignments, {
      chapterId: s.chapterId,
    });

    const ids = (rows: { id: Id<"transactions"> }[]) => rows.map((r) => r.id);
    expect(ids(res.chapter)).toContain(eventTxn);
    expect(ids(res.chapter)).toContain(outreachTxn);
    expect(ids(res.central)).toContain(musicTxn);
    expect(ids(res.central)).toContain(merchantTxn);
    expect(ids(res.unassigned)).toContain(plainTxn);
    expect(res.counts).toEqual({ central: 2, chapter: 2, unassigned: 1 });

    // Project override list: music suggested central, outreach suggested chapter.
    const musicRow = res.projects.find((p) => p.id === music);
    const outreachRow = res.projects.find((p) => p.id === outreach);
    expect(musicRow?.suggested).toBe("central");
    expect(musicRow?.txnCount).toBe(1);
    expect(outreachRow?.suggested).toBe("chapter");
  });

  test("a chapter manager cannot run the suggestions (central-gated)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    let caught: unknown;
    try {
      await s.as.query(api.finances.suggestSplitAssignments, { chapterId: s.chapterId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
  });
});

// ── transferProjectScope (budgets + txns atomically, audited) ─────────────────

describe("transferProjectScope", () => {
  test("moves the project's budgets + the budget's linked txns to central, and audits (WP-U: discovery is budget-first, not by the txn's legacy projectId FK)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    await seedSelfPerson(s);

    const project = await seedProject(s, s.chapterId, "Music Recording");
    const fundId = await seedFund(s, s.chapterId);
    const projectBudget = await seedBudget(s, s.chapterId, {
      type: "one_time",
      refKind: "project",
      scopeRefId: project,
      fundId,
    });
    // WP-U: `transferProjectScope` now finds linked transactions via the
    // BUDGET's `by_budget` index — `budgetId` is what moves them, not the
    // legacy `projectId` FK (carried here too, to prove it's inert/untouched).
    const t1 = await seedTxn(s, s.chapterId, {
      budgetId: projectBudget,
      projectId: project,
      fundId,
    });
    const t2 = await seedTxn(s, s.chapterId, {
      budgetId: projectBudget,
      projectId: project,
      fundId,
    });
    // An unrelated chapter budget + txn that must NOT move.
    const otherBudget = await seedBudget(s, s.chapterId);
    const otherTxn = await seedTxn(s, s.chapterId, {});

    const res = await s.as.mutation(api.finances.transferProjectScope, {
      projectId: project,
      target: "central",
    });
    expect(res.budgetsMoved).toBe(1);
    expect(res.txnsMoved).toBe(2);
    expect(res.projectScopeDeferred).toBe(true);

    const b = await run(t, (ctx) => ctx.db.get(projectBudget));
    expect(b?.chapterId).toBe("central");
    expect(b?.fundId).toBeUndefined(); // central budgets carry no fund

    for (const id of [t1, t2]) {
      const txn = await run(t, (ctx) => ctx.db.get(id));
      expect(txn?.chapterId).toBe("central");
      expect(txn?.budgetId).toBe(projectBudget); // the real link — followed the budget
      expect(txn?.projectId).toBe(project); // legacy FK left untouched (vestigial)
      expect(txn?.fundId).toBeUndefined(); // other chapter-scoped links cleared
    }

    // Untouched siblings.
    expect((await run(t, (ctx) => ctx.db.get(otherBudget)))?.chapterId).toBe(s.chapterId);
    expect((await run(t, (ctx) => ctx.db.get(otherTxn)))?.chapterId).toBe(s.chapterId);

    // The project ROW itself stays chapter-scoped (project-table scoping deferred).
    expect((await run(t, (ctx) => ctx.db.get(project)))?.chapterId).toBe(s.chapterId);

    // One project_transfer audit row.
    const rows = await run(t, (ctx) => ctx.db.query("reattributionAudit").collect());
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("project_transfer");
    expect(rows[0].projectId).toBe(project);
    expect(rows[0].budgetsMoved).toBe(1);
    expect(rows[0].transactionIds.length).toBe(2);
    expect(rows[0].target).toBe("central");
  });

  test("a chapter manager cannot transfer a project (central-gated)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const project = await seedProject(s, s.chapterId, "Music");

    let caught: unknown;
    try {
      await s.as.mutation(api.finances.transferProjectScope, {
        projectId: project,
        target: "central",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
  });

  test("clears categoryId on the transferred budget's WP-3.1 budgetLines, keeps description/plannedCents", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    await seedSelfPerson(s);

    const project = await seedProject(s, s.chapterId, "Music Recording");
    const fundId = await seedFund(s, s.chapterId);
    const categoryId = await seedCategory(s, s.chapterId, fundId);
    const projectBudget = await seedBudget(s, s.chapterId, {
      type: "one_time",
      refKind: "project",
      scopeRefId: project,
      fundId,
      categoryId,
    });
    const lineWithCategory = await run(t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId: projectBudget,
        description: "Studio time",
        categoryId,
        plannedCents: 40000,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );
    const lineWithoutCategory = await run(t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId: projectBudget,
        description: "Mastering",
        plannedCents: 10000,
        sortOrder: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );

    const res = await s.as.mutation(api.finances.transferProjectScope, {
      projectId: project,
      target: "central",
    });
    expect(res.budgetsMoved).toBe(1);

    const line1 = await run(t, (ctx) => ctx.db.get(lineWithCategory));
    expect(line1?.categoryId).toBeUndefined(); // stale chapter-scoped ref cleared
    expect(line1?.description).toBe("Studio time"); // plan content survives
    expect(line1?.plannedCents).toBe(40000);

    const line2 = await run(t, (ctx) => ctx.db.get(lineWithoutCategory));
    expect(line2?.categoryId).toBeUndefined(); // already uncategorized, still fine
    expect(line2?.description).toBe("Mastering");
    expect(line2?.plannedCents).toBe(10000);
  });

  test("reverse round-trip: forward to central then back to the chapter — budgets AND txns both come home, nothing stranded", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    await seedSelfPerson(s);

    const project = await seedProject(s, s.chapterId, "Music Recording");
    const fundId = await seedFund(s, s.chapterId);
    const projectBudget = await seedBudget(s, s.chapterId, {
      type: "one_time",
      refKind: "project",
      scopeRefId: project,
      fundId,
    });
    // WP-U: linked via `budgetId` (the real link) — `projectId` is carried too
    // to prove it's inert.
    const t1 = await seedTxn(s, s.chapterId, {
      budgetId: projectBudget,
      projectId: project,
      fundId,
    });
    const t2 = await seedTxn(s, s.chapterId, {
      budgetId: projectBudget,
      projectId: project,
      fundId,
    });

    // Forward: chapter → central.
    const forward = await s.as.mutation(api.finances.transferProjectScope, {
      projectId: project,
      target: "central",
    });
    expect(forward.budgetsMoved).toBe(1);
    expect(forward.txnsMoved).toBe(2);
    expect((await run(t, (ctx) => ctx.db.get(projectBudget)))?.chapterId).toBe("central");

    // Reverse: central → back to the chapter. Budget discovery is by_ref
    // (refKind + scopeRefId), NOT by the project's (unchanged) home chapter —
    // so this finds the budget at central, not at the chapter it never
    // actually moved away from on the project row. Linked-txn discovery is
    // budget-first too (`by_budget` on the just-found budget), so the reverse
    // leg finds these same two txns via the SAME budget, now at central.
    const reverse = await s.as.mutation(api.finances.transferProjectScope, {
      projectId: project,
      target: s.chapterId,
    });
    expect(reverse.budgetsMoved).toBe(1); // NOT 0 — the budget isn't stranded
    expect(reverse.txnsMoved).toBe(2);

    const b = await run(t, (ctx) => ctx.db.get(projectBudget));
    expect(b?.chapterId).toBe(s.chapterId);
    expect(b?.fundId).toBe(fundId); // the chapter's default fund re-assigned

    for (const id of [t1, t2]) {
      const txn = await run(t, (ctx) => ctx.db.get(id));
      expect(txn?.chapterId).toBe(s.chapterId);
      expect(txn?.budgetId).toBe(projectBudget);
      expect(txn?.projectId).toBe(project);
    }

    // Two audit rows now — one per leg of the round trip.
    const rows = await run(t, (ctx) => ctx.db.query("reattributionAudit").collect());
    expect(rows.length).toBe(2);
  });
});

// ── reassignTargets (bulk-bar picker source) ─────────────────────────────────

describe("reassignTargets", () => {
  test("central caller gets the active chapters, alphabetized", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    await makeChapter(s, "Boston");

    const targets = await s.as.query(api.finances.reassignTargets, {});
    const names = targets.map((c) => c.name);
    expect(names).toContain("New York");
    expect(names).toContain("Boston");
    expect(names).toEqual([...names].sort());
  });

  test("a chapter manager is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    let caught: unknown;
    try {
      await s.as.query(api.finances.reassignTargets, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
  });
});
