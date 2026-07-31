/**
 * The `people` export builder — the headline of the whole data-export
 * feature. See `packages/shared/src/dataExport.ts`'s module doc for WHY this
 * is one wide row per person rather than a bundle of joined files, and
 * `./types.ts` for the ONE-`.paginate()`-per-`page()` rule this file follows.
 *
 * Walks `people` by `by_chapter` (the required index). Every per-row
 * enrichment below is either a point read (`ctx.db.get`) or a bounded,
 * INDEXED `.take()` — never a second `.paginate()`, never `.filter()`, never
 * an unbounded `.collect()`. Column groups come in via `bctx.sections`
 * (`PEOPLE_SECTIONS` in `@events-os/shared`); columns are emitted in that
 * fixed section order regardless of the `Set`'s iteration order, so
 * `columns()` and every `page()` call agree byte-for-byte on the header.
 *
 * ── DOCUMENTED CHOICES ──────────────────────────────────────────────────────
 *
 * `all_emails` shape: up to `EMAIL_SLOT_CAP` numbered slots
 * (`email_1`/`email_1_source`/`email_1_verified`, …), primary-first then by
 * `SOURCE_RANK` (trust order) then oldest-first, PLUS one semicolon-joined
 * `all_emails` column of every address for quick copy/paste. A person with
 * more than the cap's worth of emails (essentially never, in practice) only
 * loses the overflow from the numbered slots — the joined column still has
 * all of them, `PERSON_EMAILS_LIMIT` capping the underlying read.
 *
 * `giving_summary`'s donor lookup is a single indexed read per row via
 * `donors.by_person`, an index added with this feature. The first cut copied
 * `givingPlatform.ts#giverMarks`'s workaround for the missing index — scan the
 * chapter's donors once per page into an in-memory map — which both re-read up
 * to a thousand rows on every page and carried a SILENT CAP: a chapter past
 * the scan limit lost giving columns for the overflow with nothing in the file
 * saying so. Indexing the column was cheaper than living with either.
 *
 * `participation`'s "attended" column is named `events_checked_in_count` and
 * documented as ticketed-only on purpose (see that section's doc below) —
 * never called "attended", because a free-RSVP event has no check-in
 * mechanism at all and a column named "attended" that only ever measured
 * RSVPs would be a silent lie.
 *
 * `activeOnly` filter: drops `status === "inactive"` rows only.
 * `transitioning_in` / `transitioning_out` / `unavailable` are still "on the
 * roster, just not steady-state active" and stay in an active-only export.
 *
 * `admin`'s email-suppression check looks at every address this file already
 * has bounds for (`people.email`, `people.pwEmail`, and the `personEmails`
 * ledger up to `PERSON_EMAILS_LIMIT`) — not just the roster `email` field —
 * because the whole point of the column is "don't let someone export a list
 * and mail people who unsubscribed under a DIFFERENT address than their
 * primary one."
 */
import type {
  CsvColumn,
  CsvValue,
  ExportFilters,
} from "@events-os/shared";
import {
  centsToDollars,
  flattenAnswer,
  formAnswerColumnKey,
  formAnswerColumnLabel,
  isoDateOrBlank,
  isoOrBlank,
} from "@events-os/shared";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { resolveServiceLabels } from "../serviceCatalog";
import { SOURCE_RANK } from "../personEmails";
import type { ExportBuilder, ExportBuilderContext, ExportPage } from "./types";

// ── Bounds ───────────────────────────────────────────────────────────────────
// Every cap below mirrors the house pattern in `lib/audienceResolve.ts`
// (`RSVPS_PER_PERSON_LIMIT` et al): nobody has hundreds of emails, seats,
// lifetime RSVPs or form submissions, so a bounded `.take()` at these sizes
// is exhaustive in practice while still being a REAL cap, never `.collect()`.
const PERSON_EMAILS_LIMIT = 25;
const EMAIL_SLOT_CAP = 5;
const SEAT_ASSIGNMENTS_LIMIT = 20;
const RSVPS_PER_PERSON_LIMIT = 150;
const TICKET_ORDERS_PER_RSVP_LIMIT = 5;
const TICKETS_PER_ORDER_LIMIT = 20;
const ENGAGEMENTS_PER_PERSON_LIMIT = 300;
const ACADEMY_PROGRESS_PER_PERSON_LIMIT = 100;
const COURSE_COMPLETIONS_PER_PERSON_LIMIT = 50;
const FORM_SUBMISSIONS_PER_PERSON_LIMIT = 100;
const FORM_DEFINITIONS_PER_CHAPTER_LIMIT = 200;
const PLEDGES_PER_DONOR_LIMIT = 10;
/** A person should have at most one donor row per scope, but `donors` is
 *  partitioned by scope while `personId` is not — so the `by_person` index can
 *  legitimately return one row per book. Read a few and pick the one matching
 *  the scope being exported (see `donorForPerson`). */
const DONOR_ROWS_PER_PERSON_LIMIT = 8;
/** Bounded per-address suppression check — capped by how many distinct
 *  addresses a single person can have (`PERSON_EMAILS_LIMIT` + 2). */
const EMAIL_SUPPRESSION_LOOKUP_CAP = PERSON_EMAILS_LIMIT + 2;

/** Sentinel "question key" for the per-form submitted-at column — never a
 *  real `formDefinitions.questions[].key` (those come from the founder's
 *  source forms), so it can't collide. */
const FORM_SUBMITTED_SENTINEL = "__submitted_at__";

// ── contact ──────────────────────────────────────────────────────────────────

function contactColumnDefs(): CsvColumn[] {
  return [
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "location", label: "Location" },
    { key: "company", label: "Company" },
    { key: "social_link", label: "Social link" },
    { key: "pw_email", label: "PW email" },
  ];
}

function contactCells(person: Doc<"people">): Record<string, CsvValue> {
  return {
    email: person.email ?? "",
    phone: person.phone ?? "",
    location: person.location ?? "",
    company: person.company ?? "",
    social_link: person.socialLink ?? "",
    pw_email: person.pwEmail ?? "",
  };
}

// ── all_emails ───────────────────────────────────────────────────────────────

function sortPersonEmails(rows: Doc<"personEmails">[]): Doc<"personEmails">[] {
  return [...rows].sort((a, b) => {
    const aPrimary = a.isPrimary === true;
    const bPrimary = b.isPrimary === true;
    if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
    const rankDiff = SOURCE_RANK[b.source] - SOURCE_RANK[a.source];
    if (rankDiff !== 0) return rankDiff;
    return a.addedAt - b.addedAt;
  });
}

function allEmailsColumnDefs(): CsvColumn[] {
  const cols: CsvColumn[] = [];
  for (let i = 1; i <= EMAIL_SLOT_CAP; i++) {
    cols.push({ key: `email_${i}`, label: `Email ${i}` });
    cols.push({ key: `email_${i}_source`, label: `Email ${i} source` });
    cols.push({ key: `email_${i}_verified`, label: `Email ${i} verified` });
  }
  cols.push({ key: "all_emails", label: "All emails" });
  return cols;
}

function allEmailsCells(rows: Doc<"personEmails">[]): Record<string, CsvValue> {
  const sorted = sortPersonEmails(rows);
  const cells: Record<string, CsvValue> = {
    all_emails: sorted.map((r) => r.email).join("; "),
  };
  for (let i = 0; i < EMAIL_SLOT_CAP; i++) {
    const row = sorted[i];
    const n = i + 1;
    cells[`email_${n}`] = row ? row.email : "";
    cells[`email_${n}_source`] = row ? row.source : "";
    cells[`email_${n}_verified`] = row ? (row.verified ? "Yes" : "No") : "";
  }
  return cells;
}

// ── services_seats ───────────────────────────────────────────────────────────

function servicesSeatsColumnDefs(): CsvColumn[] {
  return [
    { key: "services", label: "Services" },
    { key: "roster_role", label: "Roster role" },
    { key: "seats", label: "Org-chart seats" },
    { key: "manager_name", label: "Manager" },
  ];
}

async function servicesSeatsCells(
  ctx: QueryCtx,
  person: Doc<"people">,
): Promise<Record<string, CsvValue>> {
  const services = await resolveServiceLabels(ctx, person.serviceIds);
  const assignments = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", person._id))
    .take(SEAT_ASSIGNMENTS_LIMIT);
  const seatTitles: string[] = [];
  for (const a of assignments) {
    const def = await ctx.db.get(a.seatDefId);
    if (def) seatTitles.push(def.title);
  }
  const manager = person.managerId ? await ctx.db.get(person.managerId) : null;
  return {
    services: services.join("; "),
    roster_role: person.role ?? "",
    seats: seatTitles.join("; "),
    manager_name: manager ? manager.name : "",
  };
}

// ── participation ────────────────────────────────────────────────────────────

function participationColumnDefs(): CsvColumn[] {
  return [
    { key: "rsvp_count", label: "RSVP count" },
    // Deliberately NOT "attended" — see module doc. Only a ticketed event has
    // a check-in mechanism at all, so this column is silent (not "0") for
    // anyone whose events were all free RSVPs.
    { key: "events_checked_in_count", label: "Events checked in (ticketed only)" },
    { key: "first_event_name", label: "First event" },
    { key: "first_event_date", label: "First event date" },
    { key: "last_event_name", label: "Last event" },
    { key: "last_event_date", label: "Last event date" },
    { key: "volunteer_engagement_count", label: "Volunteer engagements" },
  ];
}

async function participationCells(
  ctx: QueryCtx,
  person: Doc<"people">,
): Promise<Record<string, CsvValue>> {
  const rsvps = await ctx.db
    .query("rsvps")
    .withIndex("by_person", (q) => q.eq("personId", person._id))
    .take(RSVPS_PER_PERSON_LIMIT);
  const active = rsvps.filter((r) => r.archivedAt === undefined);

  let firstEvent: { name: string; date: number } | null = null;
  let lastEvent: { name: string; date: number } | null = null;
  const checkedInEventIds = new Set<Id<"events">>();

  for (const r of active) {
    const event = await ctx.db.get(r.eventId);
    if (event) {
      if (!firstEvent || event.eventDate < firstEvent.date) {
        firstEvent = { name: event.name, date: event.eventDate };
      }
      if (!lastEvent || event.eventDate > lastEvent.date) {
        lastEvent = { name: event.name, date: event.eventDate };
      }
    }
    // orderId -> ticketOrders.rsvpId -> tickets.orderId — the only path to
    // "did they actually show up" (attendance is not its own table).
    const orders = await ctx.db
      .query("ticketOrders")
      .withIndex("by_rsvp", (q) => q.eq("rsvpId", r._id))
      .take(TICKET_ORDERS_PER_RSVP_LIMIT);
    for (const order of orders) {
      const tickets = await ctx.db
        .query("tickets")
        .withIndex("by_order", (q) => q.eq("orderId", order._id))
        .take(TICKETS_PER_ORDER_LIMIT);
      if (tickets.some((t) => t.status === "checked_in")) {
        checkedInEventIds.add(r.eventId);
      }
    }
  }

  const engagements = await ctx.db
    .query("engagements")
    .withIndex("by_person", (q) => q.eq("personId", person._id))
    .take(ENGAGEMENTS_PER_PERSON_LIMIT);
  const volunteerCount = engagements.filter((e) => e.type === "volunteer").length;

  return {
    rsvp_count: active.length,
    events_checked_in_count: checkedInEventIds.size,
    first_event_name: firstEvent?.name ?? "",
    first_event_date: isoDateOrBlank(firstEvent?.date),
    last_event_name: lastEvent?.name ?? "",
    last_event_date: isoDateOrBlank(lastEvent?.date),
    volunteer_engagement_count: volunteerCount,
  };
}

// ── giving_summary ───────────────────────────────────────────────────────────

function givingSummaryColumnDefs(): CsvColumn[] {
  return [
    { key: "giving_lifetime_dollars", label: "Lifetime giving ($)" },
    { key: "giving_gift_count", label: "Gift count" },
    { key: "giving_first_gift_at", label: "First gift" },
    { key: "giving_last_gift_at", label: "Last gift" },
    { key: "giving_pledge_status", label: "Pledge status" },
  ];
}

/**
 * The donor row linked to ONE person, via `donors.by_person`.
 *
 * This used to be a per-page bounded scan of the whole chapter's donors
 * (mirroring `givingPlatform.ts#giverMarks`), because `donors` had no
 * `personId` index. That carried a silent cap — a chapter past the scan limit
 * lost giving columns for the overflow with nothing in the file to say so —
 * and re-read up to a thousand donor rows on EVERY page. `donors.by_person`
 * (added with this feature) makes it a single indexed lookup per exported row,
 * which removes the cap and the repeated scan together.
 *
 * `.take(1)` rather than `.unique()`: a person having two donor rows in one
 * scope is a data-hygiene problem, not a reason to fail someone's export.
 */
async function donorForPerson(
  ctx: QueryCtx,
  personId: Id<"people">,
  scope: Id<"chapters"> | "central",
): Promise<Doc<"donors"> | undefined> {
  const rows = await ctx.db
    .query("donors")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(DONOR_ROWS_PER_PERSON_LIMIT);
  // Scope-match, don't assume. `donors` is partitioned by `scope` while
  // `personId` is not, so the index alone can hand back a donor row belonging
  // to a DIFFERENT chapter (or to central) and its lifetime total would land
  // on this chapter's export. Today's write paths (`linkDonorToPerson`,
  // `mergeDonors`, `mergePeopleCore`) all refuse to create that mismatch, so
  // this is defense in depth rather than a live hole — but "export never
  // widens reach" should be enforced here, not inherited from an invariant
  // maintained three modules away. A seeded mismatch put another chapter's
  // $55,555 on a row during review; this is what stops it.
  return rows.find((d) => d.scope === scope);
}

async function pledgeStatusForDonor(ctx: QueryCtx, donorId: Id<"donors">): Promise<string> {
  const pledges = await ctx.db
    .query("pledges")
    .withIndex("by_donor", (q) => q.eq("donorId", donorId))
    .order("desc")
    .take(PLEDGES_PER_DONOR_LIMIT);
  if (pledges.length === 0) return "";
  const active = pledges.find((p) => p.status === "active");
  return (active ?? pledges[0]).status;
}

async function givingSummaryCells(
  ctx: QueryCtx,
  donor: Doc<"donors"> | undefined,
): Promise<Record<string, CsvValue>> {
  if (!donor) {
    return {
      giving_lifetime_dollars: "",
      giving_gift_count: "",
      giving_first_gift_at: "",
      giving_last_gift_at: "",
      giving_pledge_status: "",
    };
  }
  return {
    giving_lifetime_dollars: centsToDollars(donor.lifetimeCents),
    giving_gift_count: donor.giftCount,
    giving_first_gift_at: isoOrBlank(donor.firstGiftAt),
    giving_last_gift_at: isoOrBlank(donor.lastGiftAt),
    giving_pledge_status: await pledgeStatusForDonor(ctx, donor._id),
  };
}

// ── form_answers ─────────────────────────────────────────────────────────────

async function loadFormDefs(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"formDefinitions">[]> {
  return await ctx.db
    .query("formDefinitions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(FORM_DEFINITIONS_PER_CHAPTER_LIMIT);
}

function formAnswerColumnDefs(forms: Doc<"formDefinitions">[]): CsvColumn[] {
  const cols: CsvColumn[] = [];
  for (const form of forms) {
    for (const q of form.questions) {
      cols.push({
        key: formAnswerColumnKey(form.formKey, q.key),
        label: formAnswerColumnLabel(form.title, q.label),
      });
    }
    cols.push({
      key: formAnswerColumnKey(form.formKey, FORM_SUBMITTED_SENTINEL),
      label: formAnswerColumnLabel(form.title, "Submitted"),
    });
  }
  return cols;
}

/** Most-recent-submission-wins per form, for one person. */
async function formAnswerCells(
  ctx: QueryCtx,
  personId: Id<"people">,
  forms: Doc<"formDefinitions">[],
): Promise<Record<string, CsvValue>> {
  const subs = await ctx.db
    .query("formSubmissions")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(FORM_SUBMISSIONS_PER_PERSON_LIMIT);

  const latestByForm = new Map<string, Doc<"formSubmissions">>();
  for (const s of subs) {
    const cur = latestByForm.get(s.formKey);
    if (!cur || s.submittedAt > cur.submittedAt) latestByForm.set(s.formKey, s);
  }

  const cells: Record<string, CsvValue> = {};
  for (const form of forms) {
    const sub = latestByForm.get(form.formKey);
    for (const q of form.questions) {
      const key = formAnswerColumnKey(form.formKey, q.key);
      cells[key] = sub ? flattenAnswer(sub.answers[q.key]) : "";
    }
    const submittedKey = formAnswerColumnKey(form.formKey, FORM_SUBMITTED_SENTINEL);
    cells[submittedKey] = sub ? isoOrBlank(sub.submittedAt) : "";
  }
  return cells;
}

// ── academy ──────────────────────────────────────────────────────────────────

function academyColumnDefs(): CsvColumn[] {
  return [
    { key: "academy_lessons_completed", label: "Academy lessons completed" },
    { key: "academy_courses_earned", label: "Academy courses earned" },
    { key: "academy_last_activity", label: "Academy last activity" },
  ];
}

function maxDefined(...vals: (number | undefined)[]): number | undefined {
  let out: number | undefined;
  for (const v of vals) {
    if (v === undefined) continue;
    out = out === undefined ? v : Math.max(out, v);
  }
  return out;
}

async function academyCells(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<Record<string, CsvValue>> {
  const progress = await ctx.db
    .query("academyProgress")
    .withIndex("by_chapter_and_person", (q) =>
      q.eq("chapterId", chapterId).eq("personId", personId),
    )
    .take(ACADEMY_PROGRESS_PER_PERSON_LIMIT);
  const completions = await ctx.db
    .query("courseCompletions")
    .withIndex("by_chapter_and_person", (q) =>
      q.eq("chapterId", chapterId).eq("personId", personId),
    )
    .take(COURSE_COMPLETIONS_PER_PERSON_LIMIT);

  const lessonsCompleted = progress.filter((p) => p.passedAt !== undefined).length;
  let lastActivity: number | undefined;
  for (const p of progress) lastActivity = maxDefined(lastActivity, p.readAt, p.passedAt);
  for (const c of completions) lastActivity = maxDefined(lastActivity, c.earnedAt);

  return {
    academy_lessons_completed: lessonsCompleted,
    academy_courses_earned: completions.length,
    academy_last_activity: isoOrBlank(lastActivity),
  };
}

// ── admin ────────────────────────────────────────────────────────────────────

function adminColumnDefs(): CsvColumn[] {
  return [
    { key: "marketing_opt_out", label: "Marketing opt-out" },
    { key: "consent_source", label: "Consent source" },
    { key: "consent_at", label: "Consented at" },
    { key: "vetting_status", label: "Vetting status" },
    { key: "status", label: "Status" },
    { key: "persona", label: "Persona" },
    { key: "is_contact_only", label: "Contact-only" },
    { key: "created_at", label: "Created" },
    { key: "email_suppressed", label: "Email suppressed" },
    { key: "email_suppression_reasons", label: "Email suppression reasons" },
  ];
}

async function adminCells(
  ctx: QueryCtx,
  person: Doc<"people">,
  emailRows: Doc<"personEmails">[] | null,
): Promise<Record<string, CsvValue>> {
  const addresses = new Set<string>();
  if (person.email) addresses.add(person.email.toLowerCase());
  if (person.pwEmail) addresses.add(person.pwEmail.toLowerCase());
  for (const r of emailRows ?? []) addresses.add(r.email.toLowerCase());

  const reasons: string[] = [];
  let checked = 0;
  for (const addr of addresses) {
    if (checked >= EMAIL_SUPPRESSION_LOOKUP_CAP) break;
    checked++;
    const hit = await ctx.db
      .query("emailSuppressions")
      .withIndex("by_email", (q) => q.eq("email", addr))
      .take(1);
    if (hit[0]) reasons.push(`${addr}: ${hit[0].reason}`);
  }

  return {
    marketing_opt_out: person.marketingOptOut === true ? "Yes" : "No",
    consent_source: person.consentSource ?? "",
    consent_at: isoOrBlank(person.consentedAt),
    vetting_status: person.vettingStatus ?? "",
    status: person.status ?? "",
    persona: person.persona ?? "",
    is_contact_only: person.isContactOnly === true ? "Yes" : "No",
    created_at: isoOrBlank(person.createdAt),
    email_suppressed: reasons.length > 0 ? "Yes" : "No",
    email_suppression_reasons: reasons.join("; "),
  };
}

// ── filters ──────────────────────────────────────────────────────────────────

function passesFilters(person: Doc<"people">, filters: ExportFilters): boolean {
  if (filters.persona && person.persona !== filters.persona) return false;
  if (filters.rosterOnly === true && person.isContactOnly === true) return false;
  // "inactive" only — see module doc on why transitioning/unavailable stay in.
  if (filters.activeOnly === true && person.status === "inactive") return false;
  if (filters.from !== undefined && person.createdAt < filters.from) return false;
  if (filters.to !== undefined && person.createdAt > filters.to) return false;
  return true;
}

// ── builder ──────────────────────────────────────────────────────────────────

async function columns(ctx: QueryCtx, bctx: ExportBuilderContext): Promise<CsvColumn[]> {
  const cols: CsvColumn[] = [
    { key: "person_id", label: "Person ID" },
    { key: "name", label: "Name" },
  ];
  const sections = bctx.sections;
  // Fixed section order (mirrors `PEOPLE_SECTIONS`), regardless of the Set's
  // iteration order — this is what keeps `columns()` and every `page()` call
  // agreeing on the header.
  if (sections.has("contact")) cols.push(...contactColumnDefs());
  if (sections.has("all_emails")) cols.push(...allEmailsColumnDefs());
  if (sections.has("services_seats")) cols.push(...servicesSeatsColumnDefs());
  if (sections.has("participation")) cols.push(...participationColumnDefs());
  if (sections.has("giving_summary")) cols.push(...givingSummaryColumnDefs());
  if (sections.has("form_answers")) {
    const forms = bctx.chapterId ? await loadFormDefs(ctx, bctx.chapterId) : [];
    cols.push(...formAnswerColumnDefs(forms));
  }
  if (sections.has("academy")) cols.push(...academyColumnDefs());
  if (sections.has("admin")) cols.push(...adminColumnDefs());
  return cols;
}

async function page(
  ctx: QueryCtx,
  bctx: ExportBuilderContext,
  cursor: string | null,
  numItems: number,
): Promise<ExportPage> {
  if (!bctx.chapterId) return { rows: [], cursor: null, isDone: true };
  const chapterId = bctx.chapterId;

  const result = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .paginate({ numItems, cursor });

  const sections = bctx.sections;
  const wantsGiving = sections.has("giving_summary");
  const wantsForms = sections.has("form_answers");
  const forms = wantsForms ? await loadFormDefs(ctx, chapterId) : [];
  // Both `all_emails` and `admin` (suppression check) need the ledger — load
  // it once per row and share it, rather than querying it twice.
  const wantsEmailRows = sections.has("all_emails") || sections.has("admin");

  const rows: Record<string, CsvValue>[] = [];
  for (const person of result.page) {
    // Placeholders/sample people are never real people — see
    // `lib/peopleAggregate.ts#isCountedInAggregate`.
    if (person.isPlaceholder === true || person.isSamplePerson === true) continue;
    if (!passesFilters(person, bctx.filters)) continue;

    const row: Record<string, CsvValue> = {
      person_id: person._id,
      name: person.name,
    };

    if (sections.has("contact")) Object.assign(row, contactCells(person));

    let emailRows: Doc<"personEmails">[] | null = null;
    if (wantsEmailRows) {
      emailRows = await ctx.db
        .query("personEmails")
        .withIndex("by_person", (q) => q.eq("personId", person._id))
        .take(PERSON_EMAILS_LIMIT);
    }
    if (sections.has("all_emails")) Object.assign(row, allEmailsCells(emailRows ?? []));
    if (sections.has("services_seats")) {
      Object.assign(row, await servicesSeatsCells(ctx, person));
    }
    if (sections.has("participation")) {
      Object.assign(row, await participationCells(ctx, person));
    }
    if (sections.has("giving_summary")) {
      Object.assign(
        row,
        await givingSummaryCells(
          ctx,
          await donorForPerson(ctx, person._id, bctx.scope),
        ),
      );
    }
    if (sections.has("form_answers")) {
      Object.assign(row, await formAnswerCells(ctx, person._id, forms));
    }
    if (sections.has("academy")) {
      Object.assign(row, await academyCells(ctx, chapterId, person._id));
    }
    if (sections.has("admin")) {
      Object.assign(row, await adminCells(ctx, person, emailRows));
    }

    rows.push(row);
  }

  return {
    rows,
    cursor: result.isDone ? null : result.continueCursor,
    isDone: result.isDone,
  };
}

export const peopleBuilders: ExportBuilder[] = [
  {
    datasetId: "people",
    /**
     * DELIBERATELY FAR BELOW `EXPORT_PAGE_SIZE` (500) — see `types.ts`'s
     * `pageSize` doc.
     *
     * This builder's cost is per-PERSON, not per-row-read. A single person can
     * cost roughly: 25 emails + 20 seats + 150 RSVPs (each up to 5 ticket
     * orders, each up to 20 tickets) + 300 engagements + 100 form submissions
     * + 150 academy rows + 27 suppression lookups + 1 donor + 10 pledges. A
     * merely ACTIVE person — 20 RSVPs with a ticket each — costs ~80 reads;
     * the caps allow far more.
     *
     * Convex aborts a transaction at ~16k document reads. At 500 people/page
     * that ceiling is passed by an ordinary chapter, and passed enormously by
     * one with heavy ticketing — but ONLY on real data. Tests seeded with a
     * few people never approach it, so no suite would have caught this.
     *
     * 25 keeps the typical page near ~2k reads and the pathological page
     * inside the limit. Pages are cheap (one scheduled query each); a blown
     * transaction fails the whole export.
     */
    pageSize: 25,
    columns,
    page,
  },
];
