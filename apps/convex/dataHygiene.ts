/**
 * Data Hygiene (Attendance C) — duplicate DETECTION + record MERGE for both the
 * `people` roster and the `donors` CRM. Merging records is the highest-blast-
 * radius data operation in the app (it re-points foreign keys across the whole
 * schema and deletes a row), so every write here is deliberate, bounded, and
 * audited.
 *
 * Two read queries surface likely duplicates (email / phone / name groups); two
 * mutations merge a chosen DUPLICATE into a SURVIVOR:
 *  - `mergePeople` re-points EVERY `v.id("people")` foreign key in the schema
 *    from the duplicate to the survivor, field-merges blanks, then deletes the
 *    duplicate. Refuses when both rows hold DIFFERENT real accounts (`userId`).
 *  - `mergeDonors` re-points `gifts`/`pledges`/`sponsorships`, RECOMPUTES the
 *    survivor's rollups from its actual gifts, and applies the paired
 *    `applyScopeDelta`s so the scope rollup nets EXACTLY (donorCount −1; the
 *    status buckets shift; scope lifetime/giftCount are unchanged because gifts
 *    only move donors, they aren't added or removed). Launch-pot flags on gifts
 *    (`countedInLaunchFund`) are donor-independent and left untouched.
 *
 * ── FULL `v.id("people")` RE-POINT INVENTORY (source: grep of `schema/`) ──────
 * Handled by `repointPersonRefs` below. "idx" = a person-column index drained to
 * completion; "scan" = a bounded documented read (`SCAN_CAP`) patched in memory.
 *   people.managerId ............ idx by_manager (skip survivor: no self-manage)
 *   engagements.personId ........ idx by_person
 *   roleAssignments.personId .... idx by_person
 *   checkIns.personId ........... idx by_person
 *   checkIns.managerPersonId .... scan by_chapter
 *   seatAssignments.personId .... idx by_person
 *   transactions.personId ....... idx by_person
 *   reimbursementRequests.personId ....... idx by_person
 *   reimbursementRequests.preApprovedByPersonId / reviewedByPersonId . scan by_chapter
 *   cards.cardholderPersonId .... idx by_cardholder
 *   cardRequests.personId ....... idx by_person
 *   cardRequests.decidedBy ...... scan by_chapter
 *   personalRepayments.payerPersonId ..... idx by_person
 *   financeRoles.personId ....... idx by_person
 *   financeRoles.grantedByPersonId ....... scan by_chapter (+central)
 *   specializedRoles.personId ... idx by_person
 *   projects.ownerPersonId ...... idx by_owner
 *   projectComments.authorPersonId ....... scan by_chapter
 *   projectUpdates.authorPersonId ........ scan by_chapter
 *   projectEmailTokens.personId .......... scan (global cap)
 *   seatProposals.proposedByPersonId ..... idx by_proposer
 *   seatProposals.subjectPersonId / decidedByPersonId . scan (global cap)
 *   events.ownerPersonId ........ idx by_chapter_and_ownerPersonId
 *   events.moduleReadiness[].markedBy .... scan by_chapter (nested array)
 *   eventItems.ownerPersonId .... scan by_chapter
 *   academyProgress.personId .... idx by_chapter_and_person
 *   courseCompletions.personId .. idx by_chapter_and_person
 *   aiUsageEvents.cardholderPersonId ..... scan by_chapter_and_time (+central)
 *   songs.createdBy ............. scan by_chapter
 *   docs.createdBy .............. scan by_chapter
 *   responsibilities.assigneePersonIds[] . scan by_chapter (id array)
 *   budgets.approvedByPersonId / submittedByPersonId .. scan by_chapter (+central)
 *   budgetApprovalLog.decidedByPersonId .. scan (global cap)
 *   approvals.actorPersonId ..... scan by_chapter
 *   approvalPolicy.updatedByPersonId ..... scan by_chapter
 *   payouts.payeePersonId ....... scan by_chapter
 *   reattributionAudit.actorPersonId / priorStates[].personId . scan (global cap)
 *   donors.personId / ownerPersonId ...... scan by_scope (chapter + central)
 *   sponsorships.ownerPersonId .. scan (global cap)
 *   seatStructureLog.editorPersonId ...... scan (global cap)
 *
 * A "scan" is bounded to `SCAN_CAP` rows per table — the same guardrail the rest
 * of the codebase uses (see `lib/org.ts`'s `SEAT_ASSIGNMENT_SCAN_LIMIT`). In
 * practice every one of these tables sits far below the cap for a single
 * chapter; the cap exists so a runaway table can never blow the merge
 * transaction's read budget. Indexed drains are complete (patched rows leave the
 * person-column index, so the next page returns only still-unmerged rows).
 */
import { query, mutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/access";
import { isChapterAdmin } from "./lib/org";
import { requireGivingManage, type GivingScope } from "./lib/givingAccess";
import { applyScopeDelta, deriveDonorStatus } from "./lib/givingDonors";

// ── Bounds ───────────────────────────────────────────────────────────────────
/** Rows read per indexed-drain page. Patched rows leave the person index, so
 *  the drain fully re-points regardless of how many rows reference the person. */
const DRAIN_PAGE = 200;
/** Safety ceiling on drain pages (100k rows) — a merge never legitimately hits
 *  this; it only guards against an accidental non-terminating loop. */
const MAX_DRAIN_PAGES = 500;
/** Bounded single-pass cap for tables with no person-column index. A chapter's
 *  rows in any one table sit far below this; documented per the module header. */
const SCAN_CAP = 2000;
/** Roster/donor read cap for the duplicate-detection queries (deliverable). */
const DEDUP_READ_CAP = 1000;

// ── Normalization (the grouping keys) ─────────────────────────────────────────
/** Digits-only phone key (formatting-insensitive: "(555) 123-4567" === "5551234567"). */
function normPhone(phone?: string | null): string {
  return (phone ?? "").replace(/\D/g, "");
}
/** Lowercase, strip symbols/punctuation, collapse whitespace, trim. */
function normName(name?: string | null): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function normEmailKey(email?: string | null): string {
  return normalizeEmail(email) ?? "";
}
/** The email's LOCAL-PART with Gmail-style noise stripped (dots + `+tag`), so
 *  `john.smith+pw@gmail` and `johnsmith@gmail` cluster. A cheap trivial-variant
 *  key for the `similar` group — NOT a real dedup key (different domains can
 *  share a local-part), so it's flagged lowest-confidence in the UI. */
function normEmailLocal(email?: string | null): string {
  const norm = normalizeEmail(email);
  if (!norm) return "";
  const local = norm.split("@")[0] ?? "";
  return local.replace(/\+.*/, "").replace(/\./g, "");
}
/** Token-sorted collapsed name ("John Smith" and "Smith, John" → "john smith")
 *  — clusters first/last-name-order variants for the `similar` group. */
function normNameSorted(name?: string | null): string {
  const n = normName(name);
  if (!n) return "";
  return n.split(" ").filter(Boolean).sort().join(" ");
}

// ═══════════════════════════════════════════════════════════════════════════
// DETECTION
// ═══════════════════════════════════════════════════════════════════════════

type MatchKind = "email" | "phone" | "name" | "similar";

/**
 * Group `items` into suspect duplicate sets: by normalized email first, then
 * digits-only phone, then normalized name (lower confidence), then — when
 * `keyOf` supplies them — a `similar` pass keyed by the Gmail-normalized email
 * local-part and the token-sorted name, which clusters trivial variants
 * ("john.smith@gmail" vs "johnsmith@yahoo", "Smith John" vs "John Smith") the
 * exact keys miss. A member set that already surfaced under a stronger key is
 * never repeated under a weaker one (dedup by sorted member-id signature), so
 * the `similar` pass only ever surfaces genuinely NEW clusters. Nothing fuzzy —
 * just two extra exact keys.
 */
function groupDuplicates<T extends { _id: string }>(
  items: T[],
  keyOf: (t: T) => {
    email: string;
    phone: string;
    name: string;
    emailLocal?: string;
    nameSorted?: string;
  },
): { matchKind: MatchKind; members: T[] }[] {
  const byEmail = new Map<string, T[]>();
  const byPhone = new Map<string, T[]>();
  const byName = new Map<string, T[]>();
  const byEmailLocal = new Map<string, T[]>();
  const byNameSorted = new Map<string, T[]>();
  const push = (m: Map<string, T[]>, key: string, it: T) => {
    if (!key) return;
    (m.get(key) ?? m.set(key, []).get(key)!).push(it);
  };
  for (const it of items) {
    const k = keyOf(it);
    push(byEmail, k.email, it);
    push(byPhone, k.phone, it);
    push(byName, k.name, it);
    push(byEmailLocal, k.emailLocal ?? "", it);
    push(byNameSorted, k.nameSorted ?? "", it);
  }
  const out: { matchKind: MatchKind; members: T[] }[] = [];
  const seen = new Set<string>(); // sorted member-id signature already emitted
  const sig = (members: T[]) =>
    members
      .map((m) => m._id)
      .sort()
      .join("|");
  const emit = (matchKind: MatchKind, groups: Map<string, T[]>) => {
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const s = sig(members);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({ matchKind, members });
    }
  };
  emit("email", byEmail); // strongest first
  emit("phone", byPhone);
  emit("name", byName); // lower confidence — flagged last
  emit("similar", byEmailLocal); // trivial variants — lowest confidence
  emit("similar", byNameSorted);
  return out;
}

/** The person fields surfaced to the merge UI's side-by-side comparison. */
function personCandidate(p: Doc<"people">) {
  return {
    _id: p._id,
    name: p.name,
    email: p.email ?? null,
    phone: p.phone ?? null,
    userId: p.userId ?? null,
    isTeamMember: p.isTeamMember === true,
    notes: p.notes ?? null,
    status: p.status ?? null,
    role: p.role ?? null,
    company: p.company ?? null,
    createdAt: p.createdAt,
  };
}

/**
 * Suspect duplicate roster rows for a chapter, grouped by email → phone → name.
 * Admin-gated (`isChapterAdmin`). Bounded roster read; placeholder + sample rows
 * never surface (they're not real people).
 */
export const listPeopleDuplicates = query({
  args: { chapterId: v.id("chapters") },
  handler: async (ctx, { chapterId }) => {
    if (!(await isChapterAdmin(ctx, chapterId))) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only chapter admins can review duplicates.",
      });
    }
    const roster = (
      await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(DEDUP_READ_CAP)
    ).filter((p) => p.isPlaceholder !== true && p.isSamplePerson !== true);

    const groups = groupDuplicates(roster, (p) => ({
      email: normEmailKey(p.email),
      phone: normPhone(p.phone),
      name: normName(p.name),
    }));
    return {
      groups: groups.map((g) => ({
        matchKind: g.matchKind,
        people: g.members.map(personCandidate),
      })),
    };
  },
});

/** The donor fields surfaced to the merge UI (lifetime/giftCount/status too). */
function donorCandidate(d: Doc<"donors">) {
  return {
    _id: d._id,
    name: d.name,
    email: d.email ?? null,
    phone: d.phone ?? null,
    status: d.status,
    lifetimeCents: d.lifetimeCents,
    giftCount: d.giftCount,
    personId: d.personId ?? null,
    ownerPersonId: d.ownerPersonId ?? null,
    userId: d.userId ?? null,
    createdAt: d.createdAt,
  };
}

/**
 * Suspect duplicate donor rows for a scope, grouped by email → phone → name.
 * Manage-gated (`requireGivingManage`). Bounded `by_scope` read.
 */
export const listDonorDuplicates = query({
  args: { scope: v.union(v.id("chapters"), v.literal("central")) },
  handler: async (ctx, { scope }) => {
    const typedScope = scope as GivingScope;
    await requireGivingManage(ctx, typedScope);
    const donors = await ctx.db
      .query("donors")
      .withIndex("by_scope", (q) => q.eq("scope", typedScope))
      .take(DEDUP_READ_CAP);

    const groups = groupDuplicates(donors, (d) => ({
      email: normEmailKey(d.email),
      phone: normPhone(d.phone),
      name: normName(d.name),
      // Cheap trivial-variant clustering (deliverable) — email local-part +
      // token-sorted name; surfaces variants the exact keys above miss.
      emailLocal: normEmailLocal(d.email),
      nameSorted: normNameSorted(d.name),
    }));
    return {
      groups: groups.map((g) => ({
        matchKind: g.matchKind,
        donors: g.members.map(donorCandidate),
      })),
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// RE-POINT PRIMITIVES (people merge)
// ═══════════════════════════════════════════════════════════════════════════

type Counts = Record<string, number>;
function bump(counts: Counts, table: string, n: number): void {
  if (n > 0) counts[table] = (counts[table] ?? 0) + n;
}

/**
 * Drain every row a person-column index points at, patching `field` → survivor.
 * Because the patch moves each row OUT of the `eq(field, dup)` index, the next
 * page returns only still-unmerged rows, so the loop fully re-points. `skipId`
 * (the survivor's own row, for the self-referential `people.by_manager`) is left
 * in place — a person may not become their own manager; the caller clears that
 * edge during field-merge.
 */
async function repointDrain(
  ctx: MutationCtx,
  counts: Counts,
  table: string,
  field: string,
  surv: Id<"people">,
  indexName: string,
  range: (q: any) => any,
  skipId?: Id<"people">,
): Promise<void> {
  let n = 0;
  for (let page = 0; page < MAX_DRAIN_PAGES; page++) {
    const rows: any[] = await (ctx.db.query(table as any) as any)
      .withIndex(indexName, range)
      .take(DRAIN_PAGE);
    if (rows.length === 0) break;
    let patched = 0;
    for (const r of rows) {
      if (skipId && r._id === skipId) continue;
      await ctx.db.patch(r._id, { [field]: surv } as any);
      n++;
      patched++;
    }
    if (patched === 0) break; // only skipped rows remain
    if (rows.length < DRAIN_PAGE) break;
  }
  bump(counts, table, n);
}

/** Patch any scalar person `fields` on pre-read `rows` that equal `dup`. */
async function repointScan(
  ctx: MutationCtx,
  counts: Counts,
  table: string,
  rows: any[],
  dup: Id<"people">,
  surv: Id<"people">,
  fields: string[],
): Promise<void> {
  let n = 0;
  for (const r of rows) {
    const patch: Record<string, unknown> = {};
    for (const f of fields) if (r[f] === dup) patch[f] = surv;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(r._id, patch as any);
      n++;
    }
  }
  bump(counts, table, n);
}

/**
 * Re-point EVERY `v.id("people")` reference from `dup` to `surv` (see the module
 * header for the full inventory). Returns a per-table count of rows touched.
 */
async function repointPersonRefs(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  dup: Id<"people">,
  surv: Id<"people">,
): Promise<Counts> {
  const counts: Counts = {};

  // ── Indexed drains (single person column) ──────────────────────────────────
  await repointDrain(ctx, counts, "engagements", "personId", surv, "by_person", (q) => q.eq("personId", dup));
  await repointDrain(ctx, counts, "roleAssignments", "personId", surv, "by_person", (q) => q.eq("personId", dup));
  await repointDrain(ctx, counts, "checkIns", "personId", surv, "by_person", (q) => q.eq("personId", dup));
  await repointDrain(ctx, counts, "seatAssignments", "personId", surv, "by_person", (q) => q.eq("personId", dup));
  await repointDrain(ctx, counts, "transactions", "personId", surv, "by_person", (q) => q.eq("personId", dup));
  await repointDrain(ctx, counts, "reimbursementRequests", "personId", surv, "by_person", (q) => q.eq("personId", dup));
  await repointDrain(ctx, counts, "cards", "cardholderPersonId", surv, "by_cardholder", (q) => q.eq("cardholderPersonId", dup));
  await repointDrain(ctx, counts, "cardRequests", "personId", surv, "by_person", (q) => q.eq("personId", dup));
  await repointDrain(ctx, counts, "personalRepayments", "payerPersonId", surv, "by_person", (q) => q.eq("payerPersonId", dup));
  await repointDrain(ctx, counts, "financeRoles", "personId", surv, "by_person", (q) => q.eq("personId", dup));
  await repointDrain(ctx, counts, "specializedRoles", "personId", surv, "by_person", (q) => q.eq("personId", dup));
  await repointDrain(ctx, counts, "projects", "ownerPersonId", surv, "by_owner", (q) => q.eq("ownerPersonId", dup));
  await repointDrain(ctx, counts, "seatProposals", "proposedByPersonId", surv, "by_proposer", (q) => q.eq("proposedByPersonId", dup));
  await repointDrain(ctx, counts, "events", "ownerPersonId", surv, "by_chapter_and_ownerPersonId", (q) => q.eq("chapterId", chapterId).eq("ownerPersonId", dup));
  await repointDrain(ctx, counts, "academyProgress", "personId", surv, "by_chapter_and_person", (q) => q.eq("chapterId", chapterId).eq("personId", dup));
  await repointDrain(ctx, counts, "courseCompletions", "personId", surv, "by_chapter_and_person", (q) => q.eq("chapterId", chapterId).eq("personId", dup));
  // Self-referential manager tree — never make the survivor its own manager.
  await repointDrain(ctx, counts, "people", "managerId", surv, "by_manager", (q) => q.eq("managerId", dup), surv);

  // ── Chapter-scoped scans (no person-column index) ──────────────────────────
  const byChapter = async (table: string) =>
    (await (ctx.db.query(table as any) as any)
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .take(SCAN_CAP)) as any[];

  await repointScan(ctx, counts, "docs", await byChapter("docs"), dup, surv, ["createdBy"]);
  await repointScan(ctx, counts, "songs", await byChapter("songs"), dup, surv, ["createdBy"]);
  await repointScan(ctx, counts, "eventItems", await byChapter("eventItems"), dup, surv, ["ownerPersonId"]);
  await repointScan(ctx, counts, "checkIns", await byChapter("checkIns"), dup, surv, ["managerPersonId"]);
  await repointScan(ctx, counts, "projectComments", await byChapter("projectComments"), dup, surv, ["authorPersonId"]);
  await repointScan(ctx, counts, "projectUpdates", await byChapter("projectUpdates"), dup, surv, ["authorPersonId"]);
  await repointScan(ctx, counts, "reimbursementRequests", await byChapter("reimbursementRequests"), dup, surv, ["preApprovedByPersonId", "reviewedByPersonId"]);
  await repointScan(ctx, counts, "cardRequests", await byChapter("cardRequests"), dup, surv, ["decidedBy"]);
  await repointScan(ctx, counts, "payouts", await byChapter("payouts"), dup, surv, ["payeePersonId"]);
  await repointScan(ctx, counts, "approvals", await byChapter("approvals"), dup, surv, ["actorPersonId"]);
  await repointScan(ctx, counts, "approvalPolicy", await byChapter("approvalPolicy"), dup, surv, ["updatedByPersonId"]);

  // Chapter-OR-central tables: scan the chapter's rows AND central's (a chapter
  // person can be an actor/cardholder on a central-scoped row too).
  const budgets = [...(await byChapter("budgets")), ...(await centralRows(ctx, "budgets"))];
  await repointScan(ctx, counts, "budgets", budgets, dup, surv, ["approvedByPersonId", "submittedByPersonId"]);
  const financeRolesRows = [...(await byChapter("financeRoles")), ...(await centralRows(ctx, "financeRoles"))];
  await repointScan(ctx, counts, "financeRoles", financeRolesRows, dup, surv, ["grantedByPersonId"]);
  const aiUsageRows = [
    ...((await (ctx.db.query("aiUsageEvents") as any).withIndex("by_chapter_and_time", (q: any) => q.eq("chapterId", chapterId)).take(SCAN_CAP)) as any[]),
    ...((await (ctx.db.query("aiUsageEvents") as any).withIndex("by_chapter_and_time", (q: any) => q.eq("chapterId", "central")).take(SCAN_CAP)) as any[]),
  ];
  await repointScan(ctx, counts, "aiUsageEvents", aiUsageRows, dup, surv, ["cardholderPersonId"]);

  // donors.personId / ownerPersonId — scan the chapter's donors and central's.
  const donorRows = [
    ...((await ctx.db.query("donors").withIndex("by_scope", (q) => q.eq("scope", chapterId)).take(SCAN_CAP)) as any[]),
    ...((await ctx.db.query("donors").withIndex("by_scope", (q) => q.eq("scope", "central")).take(SCAN_CAP)) as any[]),
  ];
  await repointScan(ctx, counts, "donors", donorRows, dup, surv, ["personId", "ownerPersonId"]);

  // ── Global bounded scans (no chapter + no person index) ────────────────────
  await repointScan(ctx, counts, "sponsorships", await globalRows(ctx, "sponsorships"), dup, surv, ["ownerPersonId"]);
  await repointScan(ctx, counts, "seatStructureLog", await globalRows(ctx, "seatStructureLog"), dup, surv, ["editorPersonId"]);
  await repointScan(ctx, counts, "seatProposals", await globalRows(ctx, "seatProposals"), dup, surv, ["subjectPersonId", "decidedByPersonId"]);
  await repointScan(ctx, counts, "budgetApprovalLog", await globalRows(ctx, "budgetApprovalLog"), dup, surv, ["decidedByPersonId"]);
  await repointScan(ctx, counts, "projectEmailTokens", await globalRows(ctx, "projectEmailTokens"), dup, surv, ["personId"]);

  // ── Array / nested-object references ───────────────────────────────────────
  // responsibilities.assigneePersonIds[] — replace dup with surv, dedup.
  {
    const rows = await byChapter("responsibilities");
    let n = 0;
    for (const r of rows) {
      const arr: Id<"people">[] | undefined = r.assigneePersonIds;
      if (arr && arr.includes(dup)) {
        const next = arr.filter((id) => id !== dup);
        if (!next.includes(surv)) next.push(surv);
        await ctx.db.patch(r._id, {
          assigneePersonIds: next.length > 0 ? next : undefined,
          updatedAt: Date.now(),
        } as any);
        n++;
      }
    }
    bump(counts, "responsibilities", n);
  }
  // events.moduleReadiness[].markedBy — nested object array on the event doc.
  {
    const rows = await byChapter("events");
    let n = 0;
    for (const e of rows as Doc<"events">[]) {
      if (!e.moduleReadiness?.some((m) => m.markedBy === dup)) continue;
      const next = e.moduleReadiness.map((m) =>
        m.markedBy === dup ? { ...m, markedBy: surv } : m,
      );
      await ctx.db.patch(e._id, { moduleReadiness: next });
      n++;
    }
    bump(counts, "events", n);
  }
  // reattributionAudit.actorPersonId + priorStates[].personId (global cap).
  {
    const rows = await globalRows(ctx, "reattributionAudit");
    let n = 0;
    for (const a of rows as Doc<"reattributionAudit">[]) {
      const patch: Record<string, unknown> = {};
      if (a.actorPersonId === dup) patch.actorPersonId = surv;
      if (a.priorStates?.some((ps) => ps.personId === dup)) {
        patch.priorStates = a.priorStates.map((ps) =>
          ps.personId === dup ? { ...ps, personId: surv } : ps,
        );
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(a._id, patch as any);
        n++;
      }
    }
    bump(counts, "reattributionAudit", n);
  }

  return counts;
}

/** Bounded read of a chapter-OR-central table's `"central"` rows via by_chapter. */
async function centralRows(ctx: MutationCtx, table: string): Promise<any[]> {
  return (await (ctx.db.query(table as any) as any)
    .withIndex("by_chapter", (q: any) => q.eq("chapterId", "central"))
    .take(SCAN_CAP)) as any[];
}

/** Bounded full-table read (for tables with neither a chapter nor person index). */
async function globalRows(ctx: MutationCtx, table: string): Promise<any[]> {
  return (await (ctx.db.query(table as any) as any).take(SCAN_CAP)) as any[];
}

// ═══════════════════════════════════════════════════════════════════════════
// MERGE PEOPLE
// ═══════════════════════════════════════════════════════════════════════════

/** Blank = undefined / null / "" (a whitespace-only string counts as blank). */
function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

export const mergePeople = mutation({
  args: {
    chapterId: v.id("chapters"),
    survivorId: v.id("people"),
    duplicateId: v.id("people"),
  },
  handler: async (ctx, { chapterId, survivorId, duplicateId }) => {
    if (!(await isChapterAdmin(ctx, chapterId))) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only chapter admins can merge people.",
      });
    }
    if (survivorId === duplicateId) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Survivor and duplicate must be different people.",
      });
    }
    const survivor = await ctx.db.get(survivorId);
    const duplicate = await ctx.db.get(duplicateId);
    if (!survivor || !duplicate) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Person not found." });
    }
    if (survivor.chapterId !== chapterId || duplicate.chapterId !== chapterId) {
      throw new ConvexError({
        code: "CROSS_CHAPTER",
        message: "Both people must belong to this chapter to merge.",
      });
    }
    // Two REAL accounts must never be silently collapsed — refuse the merge.
    if (survivor.userId && duplicate.userId && survivor.userId !== duplicate.userId) {
      throw new ConvexError({
        code: "USER_CONFLICT",
        message:
          "Both people are linked to different sign-in accounts. Resolve the accounts before merging.",
      });
    }

    // 1) Re-point every foreign key from the duplicate to the survivor.
    const repointed = await repointPersonRefs(ctx, chapterId, duplicateId, survivorId);

    // 2) Field-merge: survivor keeps its own values; blanks fill from duplicate.
    const now = Date.now();
    const patch: Record<string, unknown> = {};
    const fieldsFilled: string[] = [];
    const fillScalar = (field: keyof Doc<"people">) => {
      if (isBlank((survivor as any)[field]) && !isBlank((duplicate as any)[field])) {
        patch[field] = (duplicate as any)[field];
        fieldsFilled.push(field as string);
      }
    };
    for (const f of [
      "email",
      "phone",
      "image",
      "role",
      "company",
      "pwEmail",
      "socialLink",
      "pocName",
      "usualRateUsd",
      "gender",
      "vettingStatus",
      "status",
    ] as (keyof Doc<"people">)[]) {
      fillScalar(f);
    }
    const fillArray = (field: keyof Doc<"people">) => {
      const sv = (survivor as any)[field] as unknown[] | undefined;
      const dv = (duplicate as any)[field] as unknown[] | undefined;
      if ((!sv || sv.length === 0) && dv && dv.length > 0) {
        patch[field] = dv;
        fieldsFilled.push(field as string);
      }
    };
    for (const f of ["services", "projects", "commsPreferences"] as (keyof Doc<"people">)[]) {
      fillArray(f);
    }
    // isTeamMember is a capability — OR the two (either being team keeps team).
    if (survivor.isTeamMember !== true && duplicate.isTeamMember === true) {
      patch.isTeamMember = true;
      fieldsFilled.push("isTeamMember");
    }
    // Adopt the duplicate's account when the survivor has none (conflict already
    // refused above).
    if (!survivor.userId && duplicate.userId) {
      patch.userId = duplicate.userId;
      fieldsFilled.push("userId");
    }
    // Notes: keep both, plus an audit line naming the merge.
    const auditLine = `[merged from ${duplicate.name}, ${new Date(now).toISOString()}]`;
    patch.notes = [survivor.notes?.trim(), duplicate.notes?.trim(), auditLine]
      .filter((s): s is string => Boolean(s))
      .join("\n");
    fieldsFilled.push("notes");
    // managerId: adopt the duplicate's if the survivor has none, but never let
    // the survivor end up managed by itself or by the (now-deleted) duplicate.
    let managerId = survivor.managerId;
    if (managerId === undefined && duplicate.managerId) managerId = duplicate.managerId;
    if (managerId === survivorId || managerId === duplicateId) managerId = undefined;
    if (managerId !== survivor.managerId) {
      patch.managerId = managerId;
      if (managerId !== undefined) fieldsFilled.push("managerId");
    }

    await ctx.db.patch(survivorId, patch);

    // 3) Delete the now-merged duplicate row.
    await ctx.db.delete(duplicateId);

    return { repointed, fieldsFilled };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// MERGE DONORS
// ═══════════════════════════════════════════════════════════════════════════

/** Drain a donor-column index (`gifts`/`pledges`/`sponsorships` by_donor). */
async function repointDonorDrain(
  ctx: MutationCtx,
  counts: Counts,
  table: "gifts" | "pledges" | "sponsorships",
  dup: Id<"donors">,
  surv: Id<"donors">,
): Promise<void> {
  let n = 0;
  for (let page = 0; page < MAX_DRAIN_PAGES; page++) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_donor", (q) => q.eq("donorId", dup))
      .take(DRAIN_PAGE);
    if (rows.length === 0) break;
    for (const r of rows) await ctx.db.patch(r._id, { donorId: surv });
    n += rows.length;
    if (rows.length < DRAIN_PAGE) break;
  }
  bump(counts, table, n);
}

export const mergeDonors = mutation({
  args: {
    scope: v.union(v.id("chapters"), v.literal("central")),
    survivorId: v.id("donors"),
    duplicateId: v.id("donors"),
  },
  handler: async (ctx, { scope, survivorId, duplicateId }) => {
    const typedScope = scope as GivingScope;
    await requireGivingManage(ctx, typedScope);
    if (survivorId === duplicateId) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Survivor and duplicate must be different donors.",
      });
    }
    const survivor = await ctx.db.get(survivorId);
    const duplicate = await ctx.db.get(duplicateId);
    if (!survivor || !duplicate) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    if (survivor.scope !== typedScope || duplicate.scope !== typedScope) {
      throw new ConvexError({
        code: "CROSS_SCOPE",
        message: "Both donors must belong to this scope to merge.",
      });
    }

    // 1) Re-point every gift / pledge / sponsorship to the survivor. Gift
    //    launch-pot flags (`countedInLaunchFund`) are donor-independent and are
    //    NOT touched — only `donorId` moves.
    const repointed: Counts = {};
    await repointDonorDrain(ctx, repointed, "gifts", duplicateId, survivorId);
    await repointDonorDrain(ctx, repointed, "pledges", duplicateId, survivorId);
    await repointDonorDrain(ctx, repointed, "sponsorships", duplicateId, survivorId);

    // 2) RECOMPUTE the survivor's rollups from its ACTUAL gifts (now including
    //    the duplicate's), fully drained via pagination.
    let lifetimeCents = 0;
    let giftCount = 0;
    let firstGiftAt: number | undefined;
    let lastGiftAt: number | undefined;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_DRAIN_PAGES; page++) {
      const res = await ctx.db
        .query("gifts")
        .withIndex("by_donor", (q) => q.eq("donorId", survivorId))
        .paginate({ numItems: DRAIN_PAGE, cursor });
      for (const g of res.page) {
        lifetimeCents += g.amountCents;
        giftCount += 1;
        firstGiftAt = firstGiftAt === undefined ? g.receivedAt : Math.min(firstGiftAt, g.receivedAt);
        lastGiftAt = lastGiftAt === undefined ? g.receivedAt : Math.max(lastGiftAt, g.receivedAt);
      }
      if (res.isDone) break;
      cursor = res.continueCursor;
    }
    const survivorOldStatus = survivor.status;
    const newStatus = deriveDonorStatus(giftCount, lastGiftAt, Date.now());

    // 3) Contact field-merge (survivor keeps its own; blanks fill from duplicate;
    //    survivor keeps its `personId`, adopting the duplicate's only if unlinked).
    const now = Date.now();
    const donorPatch: Record<string, unknown> = {
      lifetimeCents,
      giftCount,
      lastGiftAt,
      firstGiftAt,
      status: newStatus,
    };
    const fieldsFilled: string[] = [];
    const fill = (field: keyof Doc<"donors">) => {
      if (isBlank((survivor as any)[field]) && !isBlank((duplicate as any)[field])) {
        donorPatch[field] = (duplicate as any)[field];
        fieldsFilled.push(field as string);
      }
    };
    (["email", "phone", "ownerPersonId", "source", "userId", "personId"] as (keyof Doc<"donors">)[]).forEach(fill);
    const auditLine = `[merged from ${duplicate.name}, ${new Date(now).toISOString()}]`;
    donorPatch.notes = [survivor.notes?.trim(), duplicate.notes?.trim(), auditLine]
      .filter((s): s is string => Boolean(s))
      .join("\n");
    fieldsFilled.push("notes");

    await ctx.db.patch(survivorId, donorPatch);

    // 4) Scope rollup neutrality. Gifts only MOVED donors, so the scope's
    //    lifetimeCents/giftCount are unchanged — pass neither. Net effect:
    //    donorCount −1 (duplicate gone) and the per-status buckets shift exactly
    //    (survivor old→new, duplicate's bucket removed).
    await applyScopeDelta(ctx, typedScope, {
      statusFrom: survivorOldStatus,
      statusTo: newStatus,
    });
    await applyScopeDelta(ctx, typedScope, {
      donorDelta: -1,
      statusFrom: duplicate.status,
    });

    // 5) Delete the now-merged duplicate donor.
    await ctx.db.delete(duplicateId);

    return { repointed, fieldsFilled };
  },
});
