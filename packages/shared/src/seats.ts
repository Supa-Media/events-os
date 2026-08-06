/**
 * Org-chart seat taxonomy for Chapter OS — the SEED TEMPLATE for a DB-backed
 * org chart, at both the central (org-wide) and chapter (per-chapter) level.
 *
 * THIS IS A TEMPLATE, NOT RUNTIME STATE. A later PR moves live seat
 * definitions into a `seatDefs` table (stamped from these constants when a
 * new org/chapter is created) and a `seatHolders` table tracks WHO actually
 * sits in a seat. These constants are the vocabulary two things share until
 * then: (1) what stamps a brand-new org/chapter's chart, and (2) the fixed
 * set of capability strings a seat can carry — nothing here is assignable or
 * mutable at runtime yet, and nothing in the app imports it yet.
 *
 * Mirrors `finance.ts`'s conventions: every enum is a readonly tuple with a
 * derived `as const` type; the Convex schema (when it exists) turns each into
 * a validator with `v.union(...TUPLE.map((s) => v.literal(s)))`. This module
 * stays Convex-free (no `convex/values` import) so it's usable from both the
 * backend and the Expo app.
 *
 * Taxonomy source: owner-approved org-chart flowchart (2026-07-16). Two
 * charts: CENTRAL (the org) and CHAPTER (one per chapter, cloned from this
 * template). Each chart has exactly one root seat; every other seat reports
 * up through `parentId` to that root. `chapter_directors` (central chart) is
 * `derived: true` — every chapter's `chapter_director` holder rolls up into
 * it automatically; it is never itself assigned a holder.
 */

// ── Charts ───────────────────────────────────────────────────────────────────
/** Which chart a seat def belongs to: the org-wide chart, or the per-chapter
 *  chart every chapter is stamped with. */
export const SEAT_CHARTS = ["central", "chapter"] as const;
export type SeatChart = (typeof SEAT_CHARTS)[number];

/** String sentinel for "no parent" (this seat IS the chart's root). This repo
 *  NEVER uses null/absent sentinels — see `CENTRAL` in `finance.ts` for the
 *  same pattern applied to scope. */
export const SEAT_ROOT = "root" as const;

/** Finite cap on how many holders a "*" (multi-holder) seat may have. Bounds
 *  reads of a seat's holder list — no seat is ever truly unbounded. `as const`
 *  so `typeof MULTI_HOLDER_CAP` is the literal `50`, letting `SeatDef.maxHolders`
 *  narrow to exactly the two valid values instead of `number`. */
export const MULTI_HOLDER_CAP = 50 as const;

// ── Capabilities ─────────────────────────────────────────────────────────────
/** The fixed vocabulary of capability strings a seat may carry. A capability
 *  gates a specific privileged action/surface (e.g. `nav.finances` shows the
 *  Finances tab; `org.editChart` allows editing the org chart itself). Most
 *  seats carry none — capabilities are the exception, stamped only on seats
 *  that need real authority, not every leadership title.
 *
 *  `finance.viewer` (owner decision, 2026-07-16 — see `chapter_director`'s
 *  def below): read-only reach onto a scope's finance surfaces (dashboard,
 *  reconcile grid, budgets) — the bottom rung of the graded ladder
 *  (`viewer` < `bookkeeper` < `manager`, `lib/finance.ts`). Distinct from
 *  `finance.manager`, which additionally derives WRITE rights. A seat
 *  carrying `finance.viewer` never gains record/reconcile-write or
 *  budget-edit access from that capability alone — see
 *  `apps/convex/lib/seats.ts`'s "Mapping rules" for how it derives into the
 *  graded ladder.
 *
 *  `giving.manage` / `giving.view` / `nav.giving` (F-6 P1 — the giving PRD §6):
 *  the development-desk analog of the finance trio. `giving.view` reads the
 *  donor CRM (dashboard, donor list + history); `giving.manage` additionally
 *  writes it (upsert donors, record/remove gifts, CSV import); `nav.giving`
 *  surfaces the desk in navigation (mirrors `nav.finances`). Resolved by
 *  `apps/convex/lib/givingAccess.ts` off `lib/seats.ts#getSeatDerivedGivingCapabilities`
 *  — a central holder sees every scope, a chapter `giving.view` seat sees only
 *  its own chapter.
 *
 *  `campaigns.design` / `campaigns.compose` / `campaigns.approve` (founder
 *  requirement, 2026-07-24 — two-party approval for mass email; the `design`
 *  rung added 2026-07-28): a NESTED ladder, weakest first, resolved by
 *  `apps/convex/lib/campaignsAccess.ts` and mirroring the giving trio's
 *  seat-derived, per-scope resolution shape (central-only in practice —
 *  campaigns has no chapter surface).
 *
 *  `campaigns.design` may open the Campaigns desk and own the SHARED DESIGN
 *  SYSTEM behind it — email themes (`emailThemes.ts`), saved templates
 *  (`campaignTemplates.ts`), and the reusable image library
 *  (`emailImages.ts`) — WITHOUT ever being able to compose, submit, approve,
 *  or send a campaign. It exists because the person who actually builds the
 *  newsletter is the Graphic Designer / Social Media Manager, and gating the
 *  desk on compose-or-above locked exactly those two seats out of the tools
 *  they own. Every one of those write paths edits something SHARED — an
 *  archived built-in template or a hard-deleted image blob affects everyone —
 *  so it is now a named power rather than a side effect of desk visibility.
 *
 *  `campaigns.compose` IMPLIES `campaigns.design` (a composer can obviously
 *  edit a template they're about to start from) and additionally may draft a
 *  campaign, submit it for approval, and send it once a DIFFERENT
 *  approval-power holder has approved it.
 *
 *  `campaigns.approve` IMPLIES `campaigns.compose` (and so `campaigns.design`
 *  too — an approver can always do everything a composer can) and
 *  additionally lets its holder be picked as a campaign's reviewer and decide
 *  (approve / deny / request changes) on one — but never on a campaign they
 *  themselves submitted, even for a single person holding the seat that
 *  grants it (the Executive Director included — see
 *  `apps/convex/campaigns.ts`'s state-machine doc for the separation-of-duties
 *  enforcement). Test-sends and transactional email are NOT gated by any of
 *  the three — only a real mass send is. */
export const SEAT_CAPABILITIES = [
  "finance.manager",
  "finance.viewer",
  "finance.central",
  "finance.accounts",
  "finance.approve",
  "finance.record",
  "nav.finances",
  "org.editChart",
  "giving.manage",
  "giving.view",
  "nav.giving",
  "campaigns.compose",
  "campaigns.approve",
  "campaigns.design",
  /** Bulk data extraction — running an export of a database to a spreadsheet
   *  (`apps/convex/lib/dataExportAccess.ts`). Deliberately its own power
   *  rather than an implication of any desk capability: being allowed to READ
   *  a grid on screen and being allowed to walk the whole table out of the
   *  building are different risks, and the second is the one that shows up in
   *  a breach. It never WIDENS reach — a holder still only exports datasets
   *  they could already see, so `data.export` + no `giving.view` yields a
   *  people file with no giving columns. Founder grant (2026-07-31): the four
   *  central directors + the FM + the Chapter Director (their own chapter). */
  "data.export",
  /** Door check-in at an event — scan/type a guest's ticket code and admit
   *  them (`apps/convex/lib/ticketingAccess.ts`). Deliberately narrower than
   *  general Tickets-tab admin access (`requireEvent`'s bare "any chapter
   *  member" gate every other ticketing admin action still uses): "who can
   *  admit guests at the door" is a real, asked-for restriction, granted
   *  EITHER by holding this capability at the event's chapter OR by being
   *  scheduled on that specific event's team (a `roleAssignments` row —
   *  the two paths are equally sufficient, see `requireCheckInAccess`'s
   *  doc). Default holders: `chapter_director`, `event_lead`,
   *  `event_organizers` (the natural home for door volunteers), and
   *  `production_coordinator`. */
  "events.checkin",
] as const;
export type SeatCapability = (typeof SEAT_CAPABILITIES)[number];

// ── Seat ids ─────────────────────────────────────────────────────────────────
export const SEAT_IDS = [
  // Central chart
  "executive_director",
  "financial_manager",
  "development_director",
  "partnership_associate",
  "fundraising_associate",
  "music_director",
  "a_and_r",
  "artists",
  "musicians",
  "songwriters",
  "marketing_director",
  "social_media_manager",
  "graphic_designer",
  "marketing_associate",
  "expansion_director",
  "chapter_directors",
  "recruiting_associate",
  "training_associate",
  // Chapter chart
  "chapter_director",
  "treasurer",
  "music_lead",
  "vocal_lead",
  "band_lead",
  "event_lead",
  "event_organizers",
  "production_coordinator",
  "marketing_lead",
] as const;
export type SeatId = (typeof SEAT_IDS)[number];

// ── Seat def shape ───────────────────────────────────────────────────────────
export interface SeatDef {
  id: SeatId;
  title: string;
  chart: SeatChart;
  /** The parent seat this reports to, or `SEAT_ROOT` if this IS the chart's
   *  root seat. Always another seat in the SAME chart. */
  parentId: SeatId | typeof SEAT_ROOT;
  /** 1 for a single-holder seat, or `MULTI_HOLDER_CAP` for a "*" seat. */
  maxHolders: 1 | typeof MULTI_HOLDER_CAP;
  /** Default template duties (owner edits per-org/chapter at runtime later).
   *  Populated for single-holder leadership seats; empty for associate/multi
   *  seats, which don't carry a fixed duty list in the template. */
  duties: readonly string[];
  capabilities: readonly SeatCapability[];
  /** Bridge to the legacy `specializedRoles.title` this seat corresponds to
   *  (see `SPECIALIZED_ROLE_TITLES` in `finance.ts`), where one exists. */
  legacyTitle?: "executive_director" | "president" | "finance_manager";
  /** True iff holders are COMPUTED (rolled up from another seat), never
   *  directly assigned. Only `chapter_directors` today. */
  derived?: true;
}

// ── Seat defs ────────────────────────────────────────────────────────────────
export const SEAT_DEFS: Record<SeatId, SeatDef> = {
  // ── Central chart ───────────────────────────────────────────────────────
  executive_director: {
    id: "executive_director",
    title: "Executive Director",
    chart: "central",
    parentId: SEAT_ROOT,
    maxHolders: 1,
    duties: [
      "Set org strategy & priorities",
      "Approve the central budget & big spends",
      "Represent the org externally",
    ],
    capabilities: [
      "finance.central",
      "finance.accounts",
      "finance.approve",
      "nav.finances",
      "org.editChart",
      // F-6 P1: the ED oversees the whole org's giving, including central's.
      "giving.manage",
      "giving.view",
      "nav.giving",
      // Founder requirement (2026-07-24): the ED can compose/send campaigns,
      // but every send still needs sign-off from a DIFFERENT approval-power
      // holder (e.g. the Marketing Director) — see `campaigns.approve`'s doc.
      // `campaigns.design` (2026-07-28) rides along because approve implies
      // compose implies design; it's listed explicitly so the seat chart —
      // not an implication rule buried in a resolver — stays the honest
      // answer to "who can edit a shared template/theme/image?".
      "campaigns.approve",
      "campaigns.compose",
      "campaigns.design",
      "data.export",
    ],
    legacyTitle: "executive_director",
  },
  financial_manager: {
    id: "financial_manager",
    title: "Financial Manager",
    chart: "central",
    parentId: "executive_director",
    maxHolders: 1,
    duties: [
      "Manage central accounts & bookkeeping",
      "Approve chapter reimbursements",
      "Close the books monthly",
    ],
    // Owner decision (2026-07-19, Seyi): the giving desk is now an assignable
    // per-role POWER (see `apps/convex/seats.ts#setSeatGivingPower`). The
    // Financial Manager is on the owner's default-access list — they oversee
    // central money and need central-lens READ of the donor CRM, so `giving.view`
    // + `nav.giving` (never `giving.manage` — record/edit/import stays the
    // Development Director / ED desk). The ED can toggle this off at runtime.
    capabilities: [
      "finance.manager",
      "finance.central",
      "finance.accounts",
      "finance.record",
      "nav.finances",
      "giving.view",
      "nav.giving",
      // Founder requirement (2026-07-24): the FM is one of the org's
      // valid campaign approvers alongside the ED and Marketing Director.
      // `campaigns.design` (2026-07-28) — approve implies it; listed
      // explicitly, same reason as the ED's.
      "campaigns.approve",
      "campaigns.compose",
      "campaigns.design",
      "data.export",
    ],
    legacyTitle: "finance_manager",
  },
  development_director: {
    id: "development_director",
    title: "Development Director",
    chart: "central",
    parentId: "executive_director",
    maxHolders: 1,
    duties: [
      "Own the fundraising strategy",
      "Steward major donors & partners",
      "Report on the funding pipeline",
    ],
    // F-6 P1 (giving PRD §6): the seat finally gets its powers — full donor
    // CRM read + write + config, plus the nav surface.
    // 2026-07-31: + data.export (founder grant) — the seat that runs the
    // funding pipeline is the one that needs donor/gift lists out of the app
    // for board reporting and mail-merge.
    capabilities: ["giving.manage", "giving.view", "nav.giving", "data.export"],
  },
  partnership_associate: {
    id: "partnership_associate",
    title: "Partnership Associate",
    chart: "central",
    parentId: "development_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    // F-6 P1: associates read the development desk (write is the director's).
    capabilities: ["giving.view", "nav.giving"],
  },
  fundraising_associate: {
    id: "fundraising_associate",
    title: "Fundraising Associate",
    chart: "central",
    parentId: "development_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    // F-6 P1: associates read the development desk (write is the director's).
    capabilities: ["giving.view", "nav.giving"],
  },
  music_director: {
    id: "music_director",
    title: "Music Director",
    chart: "central",
    parentId: "executive_director",
    maxHolders: 1,
    duties: [
      "Set the musical direction & standards",
      "Recruit & develop artists",
      "Approve new music/releases",
    ],
    capabilities: [],
  },
  a_and_r: {
    id: "a_and_r",
    title: "A&R",
    chart: "central",
    parentId: "music_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    capabilities: [],
  },
  artists: {
    id: "artists",
    title: "Artists",
    chart: "central",
    parentId: "music_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    capabilities: [],
  },
  musicians: {
    id: "musicians",
    title: "Musicians",
    chart: "central",
    parentId: "music_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    capabilities: [],
  },
  songwriters: {
    id: "songwriters",
    title: "Songwriters",
    chart: "central",
    parentId: "music_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    capabilities: [],
  },
  marketing_director: {
    id: "marketing_director",
    title: "Marketing Director",
    chart: "central",
    parentId: "executive_director",
    maxHolders: 1,
    duties: [
      "Own brand & messaging",
      "Plan marketing campaigns",
      "Oversee the content calendar",
    ],
    // Founder requirement (2026-07-24, verbatim): "ED approved by Marketing
    // Director" — named as a valid second party for two-party campaign
    // approval, so the Marketing Director gets full campaign power by
    // default (compose implied by approve, design implied by compose —
    // `campaigns.design` added 2026-07-28; the MD owns the brand, so the
    // design system is squarely their desk).
    // 2026-07-31: + data.export (founder grant, verbatim "Marketing director
    // as well") — the MD builds audiences, so they need the roster out as a
    // spreadsheet. Note they hold NO `giving.view`, so their people export
    // comes back without giving columns rather than failing (see
    // `lib/dataExportAccess.ts`).
    capabilities: [
      "campaigns.approve",
      "campaigns.compose",
      "campaigns.design",
      "data.export",
    ],
  },
  social_media_manager: {
    id: "social_media_manager",
    title: "Social Media Manager",
    chart: "central",
    parentId: "marketing_director",
    maxHolders: 1,
    duties: [
      "Run day-to-day social accounts",
      "Plan the content calendar",
      "Track engagement metrics",
    ],
    // 2026-07-28: `campaigns.design` — the Social Media Manager builds the
    // content the newsletter is made of and maintains the shared image
    // library, so they own themes/templates/images. Deliberately NOT
    // `campaigns.compose`: a mass send is still a two-party decision the
    // Marketing Director / ED / FM makes, and the ED can promote this seat
    // to Compose or Approve at runtime from the org chart
    // (`apps/convex/seats.ts#setSeatCampaignPower`).
    capabilities: ["campaigns.design"],
  },
  graphic_designer: {
    id: "graphic_designer",
    title: "Graphic Designer",
    chart: "central",
    parentId: "marketing_director",
    maxHolders: 1,
    duties: [
      "Produce brand & event graphics",
      "Keep visual assets on-brand",
      "Support marketing campaigns",
    ],
    // 2026-07-28: `campaigns.design` — this is the seat that ACTUALLY builds
    // the newsletter, and it held no campaign capability at all, so the
    // designer couldn't even open the Campaigns desk. Same rung (and same
    // deliberate absence of `campaigns.compose`) as the Social Media Manager
    // above.
    capabilities: ["campaigns.design"],
  },
  marketing_associate: {
    id: "marketing_associate",
    title: "Marketing Associate",
    chart: "central",
    parentId: "marketing_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    capabilities: [],
  },
  expansion_director: {
    id: "expansion_director",
    title: "Expansion Director",
    chart: "central",
    parentId: "executive_director",
    maxHolders: 1,
    duties: [
      "Identify & launch new chapters",
      "Support chapter directors",
      "Own the recruiting & training pipeline",
    ],
    // Owner decision (2026-07-19, Seyi): giving-desk access is an assignable
    // per-role POWER (see `apps/convex/seats.ts#setSeatGivingPower`). The
    // Expansion Director is on the owner's default-access list — they steward
    // the chapter/launch pipeline that giving funds, so they get central-lens
    // READ (`giving.view` + `nav.giving`), never `giving.manage`. Toggleable
    // by the ED at runtime.
    // 2026-07-31: + data.export (founder grant) — chapter launches run on
    // roster/pipeline lists pulled out per territory.
    capabilities: ["giving.view", "nav.giving", "data.export"],
  },
  chapter_directors: {
    id: "chapter_directors",
    title: "Chapter Directors",
    chart: "central",
    parentId: "expansion_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    capabilities: [],
    derived: true,
  },
  recruiting_associate: {
    id: "recruiting_associate",
    title: "Recruiting Associate",
    chart: "central",
    parentId: "expansion_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    capabilities: [],
  },
  training_associate: {
    id: "training_associate",
    title: "Training Associate",
    chart: "central",
    parentId: "expansion_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    capabilities: [],
  },

  // ── Chapter chart ───────────────────────────────────────────────────────
  chapter_director: {
    id: "chapter_director",
    title: "Chapter Director",
    chart: "chapter",
    parentId: SEAT_ROOT,
    maxHolders: 1,
    duties: [
      "Run the chapter day-to-day",
      "Own chapter budget approval",
      "Report up to central",
    ],
    // Owner decision (2026-07-16): "Chapter Director does have financial
    // powers, they approve budgets, they can also see spending... they
    // should see how the money is spent as well. But they still need to get
    // their things reconciled by their treasurer or financial manager." —
    // `finance.viewer` adds the SEE half (read-only reach: dashboard,
    // reconcile grid, budgets); `finance.approve` already covered the
    // approve half. Deliberately NOT `finance.manager` — that would also
    // derive record/reconcile-write, which stays the Treasurer's job.
    // F-6 P1 (giving PRD §6): the chapter director is "the seat that raises
    // money (backers)" — chapter-lens donor READ. Write/config stays central
    // (development director / ED), so this is `giving.view`, not `giving.manage`.
    capabilities: [
      "finance.approve",
      "finance.viewer",
      "nav.finances",
      "giving.view",
      "nav.giving",
      "data.export",
      // 2026-08-06: door check-in access for the QR scanner — the CD is one
      // of the "signed-in people we've given access to" by default.
      "events.checkin",
    ],
    legacyTitle: "president",
  },
  treasurer: {
    id: "treasurer",
    title: "Treasurer",
    chart: "chapter",
    parentId: "chapter_director",
    maxHolders: 1,
    duties: [
      "Record & reconcile chapter money",
      "Close the month",
      "Chase receipts",
    ],
    // F-6 P1: the treasurer sees their chapter's donors (chapter-lens read).
    capabilities: [
      "finance.manager",
      "finance.record",
      "nav.finances",
      "giving.view",
      "nav.giving",
    ],
    legacyTitle: "finance_manager",
  },
  music_lead: {
    id: "music_lead",
    title: "Music Lead",
    chart: "chapter",
    parentId: "chapter_director",
    maxHolders: 1,
    duties: [
      "Book & lead rehearsals",
      "Set the setlist",
      "Coordinate vocal & band leads",
    ],
    capabilities: [],
  },
  vocal_lead: {
    id: "vocal_lead",
    title: "Vocal Lead",
    chart: "chapter",
    parentId: "music_lead",
    maxHolders: 1,
    duties: ["Lead vocal rehearsals", "Assign vocal parts"],
    capabilities: [],
  },
  band_lead: {
    id: "band_lead",
    title: "Band Lead",
    chart: "chapter",
    parentId: "music_lead",
    maxHolders: 1,
    duties: ["Lead band rehearsals", "Manage instrument logistics"],
    capabilities: [],
  },
  event_lead: {
    id: "event_lead",
    title: "Event Lead",
    chart: "chapter",
    parentId: "chapter_director",
    maxHolders: 1,
    duties: [
      "Plan & run chapter events",
      "Coordinate volunteers",
      "Own the run-of-show",
    ],
    // 2026-08-06: door check-in access for the QR scanner.
    capabilities: ["events.checkin"],
  },
  event_organizers: {
    id: "event_organizers",
    title: "Event Organizers",
    chart: "chapter",
    parentId: "event_lead",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    // 2026-08-06: door check-in access — the natural home for door volunteers.
    capabilities: ["events.checkin"],
  },
  production_coordinator: {
    id: "production_coordinator",
    title: "Production Coordinator",
    chart: "chapter",
    parentId: "event_lead",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    // 2026-08-06: door check-in access for the QR scanner.
    capabilities: ["events.checkin"],
  },
  marketing_lead: {
    id: "marketing_lead",
    title: "Marketing Lead",
    chart: "chapter",
    parentId: "chapter_director",
    maxHolders: 1,
    duties: [
      "Promote chapter events locally",
      "Manage chapter social presence",
      "Coordinate flyers & signage",
    ],
    capabilities: [],
  },
};

// ── Chapter ↔ central rollup ─────────────────────────────────────────────────
/** Every chapter chart's root (`chapter_director`) rolls up into this CENTRAL
 *  seat's derived holder list (`chapter_directors`). Kept as a named constant
 *  (not a magic string) so the rollup wiring has one editable source. */
export const CHAPTER_ROLLUP_PARENT: SeatId = "expansion_director";

// ── Helpers ──────────────────────────────────────────────────────────────────
/** The direct children of `id` (seats whose `parentId === id`), same chart. */
export function seatChildren(id: SeatId): SeatId[] {
  return SEAT_IDS.filter((seatId) => SEAT_DEFS[seatId].parentId === id);
}

/** `id`'s ancestor chain, nearest first, walking `parentId` up to (but not
 *  including) the chart's `SEAT_ROOT`. These constants are acyclic today (see
 *  `seats.test.ts`), but defs move to a DB-editable `seatDefs` table in a
 *  later PR — a bad edit there could reintroduce a cycle, so this guards
 *  against an infinite loop by throwing on a revisit rather than trusting the
 *  data forever. */
export function seatAncestors(id: SeatId): SeatId[] {
  const ancestors: SeatId[] = [];
  const visited = new Set<SeatId>();
  let current: SeatId | typeof SEAT_ROOT = SEAT_DEFS[id].parentId;
  while (current !== SEAT_ROOT) {
    if (visited.has(current)) {
      throw new Error(
        `seatAncestors: cycle detected in seat parent chain at "${current}" (starting from "${id}")`,
      );
    }
    visited.add(current);
    ancestors.push(current);
    current = SEAT_DEFS[current].parentId;
  }
  return ancestors;
}

/** All seat defs belonging to a given chart. */
export function seatsForChart(chart: SeatChart): SeatDef[] {
  return SEAT_IDS.map((id) => SEAT_DEFS[id]).filter(
    (def) => def.chart === chart,
  );
}

/** True iff `def` is a "*" (multi-holder) seat. */
export function isMultiHolder(def: SeatDef): boolean {
  return def.maxHolders === MULTI_HOLDER_CAP;
}
