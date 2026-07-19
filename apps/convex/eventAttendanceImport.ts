/**
 * Event attendance import — bulk-onboard a guest list onto an event's public
 * page (the `rsvps` guest-identity rows), two-phase (preview → commit). This
 * is the ticketing/attendance sibling of `givingImport.ts`, and it is a
 * DIFFERENT thing on purpose:
 *
 *   - `givingImport.ts` feeds the Giving desk CRM — it match-or-creates
 *     `donors`, `gifts`, `pledges`, and roster `people`.
 *   - THIS importer feeds ONE event's guest list — it only ever touches
 *     `rsvps` rows for that event. It NEVER creates a donor, a gift, or a
 *     roster `people` record. An attendance row is a name on a door list,
 *     not a giving relationship.
 *
 * Why this exists: the real source data (Partiful guest exports, a hand-kept
 * payment spreadsheet, Givebutter ticket exports) is mostly NAME-ONLY — no
 * emails, no phones. `rsvps.email` was made optional so those name-only
 * guests are legal rows; every PUBLIC flow still requires a real email.
 *
 * Dedup cascade per row (first hit wins): email (indexed `by_event_email`) →
 * phone (digits-only compare) → normalized name — the last two against ONE
 * bounded `by_event` snapshot loaded once per batch (the documented bounded
 * read here). A snapshot row already claimed by an earlier row in the batch
 * is skipped, so two distinct source rows that share a name insert as two
 * distinct people, while a full re-run re-matches each row to its own prior
 * insert (zero deltas — idempotent).
 *
 * Commit batches in groups of `IMPORT_BATCH_SIZE` and self-reschedules the
 * remainder (the house pattern `givingImport.ts` established); it accumulates
 * the per-status counter deltas across the whole batch and applies them in
 * ONE `eventPages` patch (never `bumpRsvpCounters` per row).
 */
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/access";
import { requireEvent } from "./lib/context";
import { newGuestToken } from "./ticketing";
import { RSVP_STATUSES } from "./schema/ticketing";

// ── Constants ──────────────────────────────────────────────────────────────

/** Client pages preview + commit at this size (mirrors `givingImport.ts`). */
const MAX_IMPORT_ROWS = 500;

/** Rows per commit transaction before self-reschedule (house pattern). */
const IMPORT_BATCH_SIZE = 100;

/** Bounded, per-batch snapshot of an event's existing rsvps for phone/name
 *  dedup — the ONE documented bounded read here. Email dedup goes through the
 *  exact `by_event_email` index instead, so it stays correct past this bound;
 *  only name/phone fall back to this snapshot. */
const BY_EVENT_SNAPSHOT_LIMIT = 1000;

// ── Validators ─────────────────────────────────────────────────────────────

const statusValidator = v.union(...RSVP_STATUSES.map((s) => v.literal(s)));
type RsvpStatus = (typeof RSVP_STATUSES)[number];

/** The one canonical row shape every attendance parser (Partiful / spreadsheet
 *  / Givebutter) produces client-side before calling preview/commit. */
export const attendanceRowValidator = v.object({
  name: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  status: v.optional(statusValidator), // default "going"
  wasTicketHolder: v.optional(v.boolean()),
  respondedAt: v.optional(v.number()),
  note: v.optional(v.string()),
  plusOneOf: v.optional(v.string()),
});
export type AttendanceRow = Infer<typeof attendanceRowValidator>;

const dispositionValidator = v.union(
  v.literal("new"),
  v.literal("update"),
  v.literal("duplicate"),
  v.literal("invalid"),
);
type Disposition = Infer<typeof dispositionValidator>;

const matchedByValidator = v.union(
  v.literal("email"),
  v.literal("phone"),
  v.literal("name"),
);
type MatchedBy = Infer<typeof matchedByValidator>;

const previewRowValidator = v.object({
  index: v.number(),
  disposition: dispositionValidator,
  matchedBy: v.optional(matchedByValidator),
  reason: v.optional(v.string()),
});

const summaryValidator = v.object({
  totalRows: v.number(),
  newCount: v.number(),
  updateCount: v.number(),
  duplicateCount: v.number(),
  invalidCount: v.number(),
  // Normalized names that appear >1× among the rows that WOULD be inserted, or
  // that collide with more than one existing guest — a heads-up that name-only
  // dedup is ambiguous for these.
  nameCollisions: v.array(v.string()),
  // Resulting status distribution across rows that change something (new +
  // update); duplicates already sit at their status and aren't recounted.
  wouldBeGoing: v.number(),
  wouldBeMaybe: v.number(),
  wouldBeNotGoing: v.number(),
  // Rows with no usable email (name-only guests) among non-invalid rows —
  // these are unreachable by an email blast until SMS targeting lands.
  emaillessCount: v.number(),
});

const commitResultValidator = v.object({
  inserted: v.number(),
  updated: v.number(),
  skippedDuplicates: v.number(),
  skippedInvalid: v.number(),
  scheduledRemaining: v.number(),
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Digits-only phone key ("(555) 123-4567" → "5551234567"); "" when unusable. */
function digitsOnly(phone?: string): string {
  return (phone ?? "").replace(/\D/g, "");
}

/** Lowercase, strip non-letter/digit/space chars, collapse spaces, trim. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The note to store on insert: caller note + a "+1 of X" tag, or undefined. */
function buildNote(row: AttendanceRow): string | undefined {
  const parts: string[] = [];
  if (row.note?.trim()) parts.push(row.note.trim());
  if (row.plusOneOf?.trim()) parts.push(`+1 of ${row.plusOneOf.trim()}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Merge `addition` into `existing` idempotently (re-runs never re-append). */
function mergeNote(existing: string | undefined, addition: string | undefined): string | undefined {
  const base = existing?.trim();
  const add = addition?.trim();
  if (!add) return base || undefined;
  if (!base) return add;
  if (base.includes(add)) return base;
  return `${base} · ${add}`;
}

/** A row with no name AND no identity at all can't become a guest. */
function isInvalid(row: AttendanceRow): boolean {
  return row.name.trim() === "";
}

// ── Shared identity resolution (used by preview + commit) ────────────────────

/** Find the first snapshot row matching by phone (digits) then name, skipping
 *  any row already claimed by an earlier row in this batch. Email is resolved
 *  separately (indexed) by the callers. */
function matchSnapshot(
  snapshot: Doc<"rsvps">[],
  claimed: Set<Id<"rsvps">>,
  opts: { phone?: string; name: string },
): { match: Doc<"rsvps"> | null; via: Exclude<MatchedBy, "email"> | null } {
  const phoneKey = digitsOnly(opts.phone);
  if (phoneKey.length >= 10) {
    const hit = snapshot.find(
      (r) => !claimed.has(r._id) && digitsOnly(r.phone) === phoneKey,
    );
    if (hit) return { match: hit, via: "phone" };
  }
  const nameKey = normalizeName(opts.name);
  if (nameKey) {
    const hit = snapshot.find(
      (r) => !claimed.has(r._id) && normalizeName(r.name) === nameKey,
    );
    if (hit) return { match: hit, via: "name" };
  }
  return { match: null, via: null };
}

/** Load the event's page (needed for chapterId + counters), or throw NO_PAGE. */
export async function requireEventPage(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"eventPages">> {
  const page = await ctx.db
    .query("eventPages")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .unique();
  if (!page) {
    throw new ConvexError({
      code: "NO_PAGE",
      message: "Create the event's public page before importing a guest list.",
    });
  }
  return page;
}

// ═══════════════════════════════════════════════════════════════════════════
// PREVIEW — read-only; simulates the commit (incl. in-batch dedup), no writes.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify a bounded set of attendance rows against an event's existing
 * `rsvps` WITHOUT writing anything: the per-row disposition + summary a commit
 * WOULD produce (in-batch dedup simulated, incl. the reads-your-writes email
 * effect). Reused by the public `previewAttendanceImport` query and the
 * historical backfill's dry run, so a dry run predicts a commit exactly.
 */
export async function classifyAttendanceRows(
  ctx: QueryCtx,
  eventId: Id<"events">,
  rows: AttendanceRow[],
): Promise<{
  rows: Infer<typeof previewRowValidator>[];
  summary: Infer<typeof summaryValidator>;
}> {
  {
    const snapshot = await ctx.db
      .query("rsvps")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(BY_EVENT_SNAPSHOT_LIMIT);
    // Count how many existing guests share each normalized name — a name that
    // hits more than one is an ambiguous name-only match.
    const existingNameCounts = new Map<string, number>();
    for (const r of snapshot) {
      const k = normalizeName(r.name);
      if (k) existingNameCounts.set(k, (existingNameCounts.get(k) ?? 0) + 1);
    }

    const claimed = new Set<Id<"rsvps">>();
    // Simulate the reads-your-writes email dedup a real commit gets for free:
    // an email inserted by an earlier row in THIS batch → its current status.
    const simEmail = new Map<string, RsvpStatus>();

    const outRows: Infer<typeof previewRowValidator>[] = [];
    const collisions = new Set<string>();
    const newNameCounts = new Map<string, number>();
    let newCount = 0;
    let updateCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    let wouldBeGoing = 0;
    let wouldBeMaybe = 0;
    let wouldBeNotGoing = 0;
    let emaillessCount = 0;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (isInvalid(row)) {
        invalidCount++;
        outRows.push({ index, disposition: "invalid", reason: "Row has no name." });
        continue;
      }
      const target: RsvpStatus = row.status ?? "going";
      const email = normalizeEmail(row.email) ?? undefined;
      if (!email) emaillessCount++;

      // Resolve identity: email (indexed + in-batch sim) → phone/name (snapshot).
      let disposition: Disposition;
      let matchedBy: MatchedBy | undefined;
      let matchedStatus: RsvpStatus | null = null;

      if (email) {
        // Consult the in-batch sim FIRST — it holds the would-be status after
        // an earlier row in this batch touched this email, exactly as a real
        // commit's reads-your-writes index lookup would return the patched row.
        if (simEmail.has(email)) {
          matchedBy = "email";
          matchedStatus = simEmail.get(email)!;
        } else {
          const dbHit = await ctx.db
            .query("rsvps")
            .withIndex("by_event_email", (q) =>
              q.eq("eventId", eventId).eq("email", email),
            )
            .first();
          if (dbHit) {
            matchedBy = "email";
            matchedStatus = dbHit.status;
          }
        }
      }
      if (!matchedBy) {
        const { match, via } = matchSnapshot(snapshot, claimed, {
          phone: row.phone,
          name: row.name,
        });
        if (match && via) {
          matchedBy = via;
          matchedStatus = match.status;
          claimed.add(match._id);
          if (via === "name" && (existingNameCounts.get(normalizeName(row.name)) ?? 0) > 1) {
            collisions.add(normalizeName(row.name));
          }
        }
      }

      if (matchedBy) {
        if (matchedStatus === target) {
          disposition = "duplicate";
          duplicateCount++;
        } else {
          disposition = "update";
          updateCount++;
        }
        // Reflect the (would-be) new status for a later same-email row.
        if (matchedBy === "email") simEmail.set(email!, target);
      } else {
        disposition = "new";
        newCount++;
        if (email) simEmail.set(email, target);
        const nameKey = normalizeName(row.name);
        if (nameKey) newNameCounts.set(nameKey, (newNameCounts.get(nameKey) ?? 0) + 1);
      }

      if (disposition === "new" || disposition === "update") {
        if (target === "going") wouldBeGoing++;
        else if (target === "maybe") wouldBeMaybe++;
        else wouldBeNotGoing++;
      }
      outRows.push({ index, disposition, ...(matchedBy ? { matchedBy } : {}) });
    }

    for (const [name, count] of newNameCounts) {
      if (count > 1) collisions.add(name);
    }

    return {
      rows: outRows,
      summary: {
        totalRows: rows.length,
        newCount,
        updateCount,
        duplicateCount,
        invalidCount,
        nameCollisions: [...collisions].sort(),
        wouldBeGoing,
        wouldBeMaybe,
        wouldBeNotGoing,
        emaillessCount,
      },
    };
  }
}

export const previewAttendanceImport = query({
  args: { eventId: v.id("events"), rows: v.array(attendanceRowValidator) },
  returns: v.object({
    rows: v.array(previewRowValidator),
    summary: summaryValidator,
  }),
  handler: async (ctx, { eventId, rows }) => {
    await requireEvent(ctx, eventId);
    await requireEventPage(ctx, eventId);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `At most ${MAX_IMPORT_ROWS} rows per call.`,
      });
    }
    return await classifyAttendanceRows(ctx, eventId, rows);
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// COMMIT — real writes, batched + self-rescheduled.
// ═══════════════════════════════════════════════════════════════════════════

type CommitCounters = {
  inserted: number;
  updated: number;
  skippedDuplicates: number;
  skippedInvalid: number;
};

/** Per-status net counter delta accumulated across a whole batch. */
type StatusDelta = { going: number; maybe: number; not_going: number };

/**
 * Apply a bounded set of attendance rows to one event's `rsvps` in a SINGLE
 * transaction: the match/insert/update loop plus the whole-set counter delta
 * folded into ONE `eventPages` patch. Does NOT slice or self-reschedule — the
 * caller is responsible for keeping `rows` within a safe per-transaction size
 * (`commitBatch` slices to `IMPORT_BATCH_SIZE`; the historical backfill pages
 * with its own window). Reused verbatim by both so their write behavior — the
 * dedup cascade, the counter math, idempotency — is identical.
 */
export async function applyAttendanceRows(
  ctx: MutationCtx,
  eventId: Id<"events">,
  page: Doc<"eventPages">,
  rows: AttendanceRow[],
): Promise<CommitCounters> {
  const counters: CommitCounters = {
    inserted: 0,
    updated: 0,
    skippedDuplicates: 0,
    skippedInvalid: 0,
  };
  const delta: StatusDelta = { going: 0, maybe: 0, not_going: 0 };

  // ONE bounded snapshot per call for phone/name dedup. In-batch inserts are
  // NOT in this captured array, so two same-name rows both insert (distinct
  // people); a re-run's snapshot DOES contain the prior inserts, so each row
  // re-matches its own — zero deltas.
  const snapshot = await ctx.db
    .query("rsvps")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .take(BY_EVENT_SNAPSHOT_LIMIT);
  const claimed = new Set<Id<"rsvps">>();
  const now = Date.now();

  for (const row of rows) {
    if (isInvalid(row)) {
      counters.skippedInvalid++;
      continue;
    }
    const target: RsvpStatus = row.status ?? "going";
    const email = normalizeEmail(row.email) ?? undefined;

    // Resolve identity: email (indexed, reads-your-writes) → phone/name (snapshot).
    let match: Doc<"rsvps"> | null = null;
    if (email) {
      match = await ctx.db
        .query("rsvps")
        .withIndex("by_event_email", (q) =>
          q.eq("eventId", eventId).eq("email", email),
        )
        .first();
    }
    if (!match) {
      const found = matchSnapshot(snapshot, claimed, { phone: row.phone, name: row.name });
      if (found.match) {
        match = found.match;
        claimed.add(found.match._id);
      }
    }

    if (match) {
      if (match.status === target) {
        counters.skippedDuplicates++; // idempotent no-op
        continue;
      }
      // Different status → patch status/updatedAt + merged note. NEVER touch
      // token or downgrade emailVerified.
      delta[match.status] -= 1;
      delta[target] += 1;
      await ctx.db.patch(match._id, {
        status: target,
        updatedAt: now,
        ...(() => {
          const merged = mergeNote(match.note, buildNote(row));
          return merged !== undefined && merged !== match.note ? { note: merged } : {};
        })(),
      });
      counters.updated++;
      continue;
    }

    // New guest. Imported rows with an email are trusted as confirmed (true);
    // name-only rows get `undefined` (legacy = verified — they never receive a
    // verification code).
    const createdAt = row.respondedAt ?? now;
    const phone = row.phone?.trim() || undefined;
    const note = buildNote(row);
    await ctx.db.insert("rsvps", {
      eventId,
      chapterId: page.chapterId,
      name: row.name.trim() || "Guest",
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      status: target,
      token: newGuestToken(),
      source: row.wasTicketHolder ? "ticket" : "rsvp",
      ...(email ? { emailVerified: true as const } : {}),
      ...(note ? { note } : {}),
      createdAt,
      updatedAt: createdAt,
    });
    delta[target] += 1;
    counters.inserted++;
  }

  // ONE counter patch for the whole set (never per-row bumpRsvpCounters).
  if (delta.going !== 0 || delta.maybe !== 0 || delta.not_going !== 0) {
    const fresh = await ctx.db.get(page._id);
    if (fresh) {
      await ctx.db.patch(page._id, {
        goingCount: Math.max(0, fresh.goingCount + delta.going),
        maybeCount: Math.max(0, fresh.maybeCount + delta.maybe),
        notGoingCount: Math.max(0, fresh.notGoingCount + delta.not_going),
      });
    }
  }

  return counters;
}

/**
 * Commit ONE batch (≤ `IMPORT_BATCH_SIZE`) via `applyAttendanceRows`, then
 * self-schedule the remainder as `commitAttendanceImportRest` (the house
 * pattern `givingImport.ts` established). Shared by the gated public entry +
 * the internal continuation.
 */
async function commitBatch(
  ctx: MutationCtx,
  eventId: Id<"events">,
  page: Doc<"eventPages">,
  rows: AttendanceRow[],
): Promise<Infer<typeof commitResultValidator>> {
  const slice = rows.slice(0, IMPORT_BATCH_SIZE);
  const counters = await applyAttendanceRows(ctx, eventId, page, slice);

  const remaining = rows.slice(IMPORT_BATCH_SIZE);
  if (remaining.length > 0) {
    await ctx.scheduler.runAfter(
      0,
      internal.eventAttendanceImport.commitAttendanceImportRest,
      { eventId, rows: remaining },
    );
  }

  return {
    inserted: counters.inserted,
    updated: counters.updated,
    skippedDuplicates: counters.skippedDuplicates,
    skippedInvalid: counters.skippedInvalid,
    scheduledRemaining: remaining.length,
  };
}

/**
 * Commit a guest-list import (≤ `MAX_IMPORT_ROWS`; the client pages a larger
 * file into multiple calls). Ticketing-admin gated (`requireEvent`). Idempotent
 * on re-run. Returns only THIS batch's counts; the remainder continues via
 * `commitAttendanceImportRest`.
 */
export const commitAttendanceImport = mutation({
  args: { eventId: v.id("events"), rows: v.array(attendanceRowValidator) },
  returns: commitResultValidator,
  handler: async (ctx, { eventId, rows }) => {
    await requireEvent(ctx, eventId);
    const page = await requireEventPage(ctx, eventId);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `At most ${MAX_IMPORT_ROWS} rows per call.`,
      });
    }
    return await commitBatch(ctx, eventId, page, rows);
  },
});

/** Internal continuation of `commitAttendanceImport` (gated when scheduled). */
export const commitAttendanceImportRest = internalMutation({
  args: { eventId: v.id("events"), rows: v.array(attendanceRowValidator) },
  handler: async (ctx, { eventId, rows }) => {
    const page = await requireEventPage(ctx, eventId);
    await commitBatch(ctx, eventId, page, rows);
    return null;
  },
});
