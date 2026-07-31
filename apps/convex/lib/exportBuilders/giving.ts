/**
 * Export builders for the Giving datasets: `donors`, `gifts`, `pledges`.
 *
 * All three tables key on `scope` (a chapter id, or `"central"`) — never
 * `chapterId` — so every builder here paginates its `by_scope*` index with
 * `bctx.scope` directly (both datasets declare `supportsCentral: true`, so
 * `bctx.scope` legitimately arrives as `"central"`).
 *
 * See `./types.ts` for the one-`.paginate()`-per-`page()` rule this follows.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { centsToDollars, isoOrBlank, type CsvColumn, type CsvValue } from "@events-os/shared";
import type { ExportBuilder, ExportBuilderContext, ExportPage } from "./types";

/** Batch-resolve a set of `people` ids to display names, deduped, via `.get`
 *  (indexed by primary key — bounded to the distinct ids on one page). */
async function namesFor(
  ctx: QueryCtx,
  ids: Iterable<Id<"people"> | undefined>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of new Set([...ids].filter((id): id is Id<"people"> => !!id))) {
    const person = await ctx.db.get(id);
    if (person) names.set(id, person.name);
  }
  return names;
}

// ── donors ───────────────────────────────────────────────────────────────────

const DONOR_COLUMNS: CsvColumn[] = [
  { key: "donor_id", label: "Donor ID" },
  { key: "name", label: "Donor name" },
  { key: "person_id", label: "Linked person ID" },
  { key: "person_name", label: "Linked person name" },
  { key: "owner_person_id", label: "Owner ID" },
  { key: "owner_name", label: "Owner name" },
  { key: "kind", label: "Kind" },
  { key: "status", label: "Status" },
  { key: "source", label: "Source" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "lifetime_dollars", label: "Lifetime giving ($)" },
  { key: "gift_count", label: "Gift count" },
  { key: "first_gift_at", label: "First gift" },
  { key: "last_gift_at", label: "Last gift" },
  { key: "address_line1", label: "Address line 1" },
  { key: "address_line2", label: "Address line 2" },
  { key: "address_city", label: "City" },
  { key: "address_state", label: "State" },
  { key: "address_postal_code", label: "Postal code" },
  { key: "address_country", label: "Country" },
  { key: "scope", label: "Scope" },
  { key: "created_at", label: "Created" },
];

function donorMatchesFilters(d: Doc<"donors">, bctx: ExportBuilderContext): boolean {
  // `activeOnly` (declared filter): the donor is currently giving, i.e. not a
  // never-given prospect or a 90-day-lapsed one. Donors have no "archived"
  // flag of their own — `status` is the closest analog to the generic
  // "drop archived/inactive" contract, so activeOnly keeps `status: "active"`
  // only.
  if (bctx.filters.activeOnly && d.status !== "active") return false;
  // `dateRange` (declared filter): no `receivedAt`-equivalent on a donor row,
  // so this windows the donor's own `createdAt`.
  if (bctx.filters.from !== undefined && d.createdAt < bctx.filters.from) {
    return false;
  }
  if (bctx.filters.to !== undefined && d.createdAt > bctx.filters.to) {
    return false;
  }
  return true;
}

function donorRow(
  d: Doc<"donors">,
  personNames: Map<string, string>,
  ownerNames: Map<string, string>,
): Record<string, CsvValue> {
  return {
    donor_id: d._id,
    name: d.name,
    person_id: d.personId ?? "",
    person_name: d.personId ? (personNames.get(d.personId) ?? "") : "",
    owner_person_id: d.ownerPersonId ?? "",
    owner_name: d.ownerPersonId ? (ownerNames.get(d.ownerPersonId) ?? "") : "",
    kind: d.kind,
    status: d.status,
    source: d.source ?? "",
    email: d.email ?? "",
    phone: d.phone ?? "",
    lifetime_dollars: centsToDollars(d.lifetimeCents),
    gift_count: d.giftCount,
    first_gift_at: isoOrBlank(d.firstGiftAt),
    last_gift_at: isoOrBlank(d.lastGiftAt),
    address_line1: d.address?.line1 ?? "",
    address_line2: d.address?.line2 ?? "",
    address_city: d.address?.city ?? "",
    address_state: d.address?.state ?? "",
    address_postal_code: d.address?.postalCode ?? "",
    address_country: d.address?.country ?? "",
    scope: String(d.scope),
    created_at: isoOrBlank(d.createdAt),
  };
}

const donorsBuilder: ExportBuilder = {
  datasetId: "donors",
  async columns(): Promise<CsvColumn[]> {
    return DONOR_COLUMNS;
  },
  async page(
    ctx: QueryCtx,
    bctx: ExportBuilderContext,
    cursor: string | null,
    numItems: number,
  ): Promise<ExportPage> {
    const result = await ctx.db
      .query("donors")
      .withIndex("by_scope", (q) => q.eq("scope", bctx.scope))
      .paginate({ numItems, cursor });

    const kept = result.page.filter((d) => donorMatchesFilters(d, bctx));
    const personNames = await namesFor(ctx, kept.map((d) => d.personId));
    const ownerNames = await namesFor(ctx, kept.map((d) => d.ownerPersonId));

    return {
      rows: kept.map((d) => donorRow(d, personNames, ownerNames)),
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
};

// ── gifts ────────────────────────────────────────────────────────────────────

const GIFT_COLUMNS: CsvColumn[] = [
  { key: "gift_id", label: "Gift ID" },
  { key: "donor_id", label: "Donor ID" },
  { key: "donor_name", label: "Donor name" },
  { key: "person_id", label: "Linked person ID" },
  { key: "amount_dollars", label: "Amount ($)" },
  { key: "method", label: "Method" },
  { key: "received_at", label: "Received" },
  { key: "event_id", label: "Event ID" },
  { key: "event_name", label: "Event name" },
  { key: "pledge_id", label: "Pledge ID" },
  { key: "sponsorship_id", label: "Sponsorship ID" },
  { key: "transaction_id", label: "Transaction ID" },
  { key: "note", label: "Note" },
  { key: "external_ref", label: "External ref" },
  { key: "scope", label: "Scope" },
];

function giftRow(
  g: Doc<"gifts">,
  donorNames: Map<string, string>,
  donorPersonIds: Map<string, string>,
  eventNames: Map<string, string>,
): Record<string, CsvValue> {
  const personId = donorPersonIds.get(g.donorId) ?? "";
  return {
    gift_id: g._id,
    donor_id: g.donorId,
    donor_name: donorNames.get(g.donorId) ?? "",
    person_id: personId,
    amount_dollars: centsToDollars(g.amountCents),
    method: g.method,
    received_at: isoOrBlank(g.receivedAt),
    event_id: g.eventId ?? "",
    event_name: g.eventId ? (eventNames.get(g.eventId) ?? "") : "",
    pledge_id: g.pledgeId ?? "",
    sponsorship_id: g.sponsorshipId ?? "",
    transaction_id: g.transactionId ?? "",
    note: g.note ?? "",
    external_ref: g.externalRef ?? "",
    scope: String(g.scope),
  };
}

const giftsBuilder: ExportBuilder = {
  datasetId: "gifts",
  async columns(): Promise<CsvColumn[]> {
    return GIFT_COLUMNS;
  },
  async page(
    ctx: QueryCtx,
    bctx: ExportBuilderContext,
    cursor: string | null,
    numItems: number,
  ): Promise<ExportPage> {
    // dateRange on `receivedAt`, honoured AT THE INDEX (`by_scope_and_received`)
    // rather than scanned-and-discarded — see the module doc.
    const { from, to } = bctx.filters;
    const result = await ctx.db
      .query("gifts")
      .withIndex("by_scope_and_received", (q) => {
        const withScope = q.eq("scope", bctx.scope);
        const withFrom = from !== undefined ? withScope.gte("receivedAt", from) : withScope;
        return to !== undefined ? withFrom.lte("receivedAt", to) : withFrom;
      })
      .paginate({ numItems, cursor });

    const gifts = result.page;
    const donorIds = [...new Set(gifts.map((g) => g.donorId))];
    const donorNames = new Map<string, string>();
    const donorPersonIds = new Map<string, string>();
    for (const id of donorIds) {
      const donor = await ctx.db.get(id);
      if (donor) {
        donorNames.set(id, donor.name);
        if (donor.personId) donorPersonIds.set(id, donor.personId);
      }
    }

    const eventIds = [
      ...new Set(gifts.map((g) => g.eventId).filter((id): id is Id<"events"> => !!id)),
    ];
    const eventNames = new Map<string, string>();
    for (const id of eventIds) {
      const event = await ctx.db.get(id);
      if (event) eventNames.set(id, event.name);
    }

    return {
      rows: gifts.map((g) => giftRow(g, donorNames, donorPersonIds, eventNames)),
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
};

// ── pledges ──────────────────────────────────────────────────────────────────

const PLEDGE_COLUMNS: CsvColumn[] = [
  { key: "pledge_id", label: "Pledge ID" },
  { key: "donor_id", label: "Donor ID" },
  { key: "donor_name", label: "Donor name" },
  { key: "person_id", label: "Linked person ID" },
  { key: "amount_dollars", label: "Amount ($)" },
  { key: "status", label: "Status" },
  { key: "origin", label: "Origin" },
  { key: "started_at", label: "Started" },
  { key: "canceled_at", label: "Canceled" },
  { key: "current_period_end", label: "Current period end" },
  { key: "scope", label: "Scope" },
  { key: "created_at", label: "Created" },
];

function pledgeRow(
  p: Doc<"pledges">,
  donorNames: Map<string, string>,
  donorPersonIds: Map<string, string>,
): Record<string, CsvValue> {
  return {
    pledge_id: p._id,
    donor_id: p.donorId,
    donor_name: donorNames.get(p.donorId) ?? "",
    person_id: donorPersonIds.get(p.donorId) ?? "",
    amount_dollars: centsToDollars(p.amountCents),
    status: p.status,
    origin: p.origin,
    started_at: isoOrBlank(p.startedAt),
    canceled_at: isoOrBlank(p.canceledAt),
    current_period_end: isoOrBlank(p.currentPeriodEnd),
    scope: String(p.scope),
    created_at: isoOrBlank(p.createdAt),
  };
}

const pledgesBuilder: ExportBuilder = {
  datasetId: "pledges",
  async columns(): Promise<CsvColumn[]> {
    return PLEDGE_COLUMNS;
  },
  async page(
    ctx: QueryCtx,
    bctx: ExportBuilderContext,
    cursor: string | null,
    numItems: number,
  ): Promise<ExportPage> {
    // No status pinned — walk every status at this scope via the leading
    // (scope) segment of `by_scope_and_status` (same partial-index usage as
    // `givingPledges.listPledges`).
    const result = await ctx.db
      .query("pledges")
      .withIndex("by_scope_and_status", (q) => q.eq("scope", bctx.scope))
      .paginate({ numItems, cursor });

    // `activeOnly` (declared filter): pledges have a real `"canceled"` status
    // literal — drop those, matching the generic "archived/inactive/cancelled"
    // contract exactly rather than by analogy.
    const kept = bctx.filters.activeOnly
      ? result.page.filter((p) => p.status !== "canceled")
      : result.page;

    const donorIds = [...new Set(kept.map((p) => p.donorId))];
    const donorNames = new Map<string, string>();
    const donorPersonIds = new Map<string, string>();
    for (const id of donorIds) {
      const donor = await ctx.db.get(id);
      if (donor) {
        donorNames.set(id, donor.name);
        if (donor.personId) donorPersonIds.set(id, donor.personId);
      }
    }

    return {
      rows: kept.map((p) => pledgeRow(p, donorNames, donorPersonIds)),
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
};

export const givingBuilders: ExportBuilder[] = [donorsBuilder, giftsBuilder, pledgesBuilder];
