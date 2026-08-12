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
/**
 * A seat's powers are the standardized vocabulary in `./powers.ts` — read that
 * module's doc for the grammar (`<domain>[.<area>].<action>`), the three
 * implication rules, and the scope model. `SEAT_CAPABILITIES` / `SeatCapability`
 * are the historical names for it, kept because they are threaded through the
 * Convex schema validator and a hundred call sites.
 *
 * WHAT A SEAT STORES IS THE MINIMAL SET. Capability lists below name only the
 * powers a seat is GRANTED, never the ones those grants imply — the ED carries
 * `email.campaigns.approve`, not also the compose and design rungs beneath it.
 * That inverts the pre-standardization convention, which listed every implied
 * rung explicitly so the chart stayed "the honest answer to who can do this"
 * in the absence of a real implication rule. There is one now
 * (`expandPowers`), and the seat panel renders the EXPANDED set, so the chart
 * is still the honest answer — it just isn't hand-maintained any more, and a
 * missed rung is no longer possible.
 *
 * Most seats carry nothing. Powers are stamped only on seats that need real
 * authority, not on every leadership title.
 */
export {
  POWERS as SEAT_CAPABILITIES,
  POWER_DEFS,
  POWER_ACTIONS,
  POWER_DOMAINS,
  POWER_AREAS,
} from "./powers";
export type { Power as SeatCapability } from "./powers";
import type { Power } from "./powers";

/* Historical note on the vocabulary this replaced (2026-08-12). The old list
 * had grown four incompatible shapes and two non-powers; the mapping lives in
 * `LEGACY_POWER_MIGRATION` and the reasoning in `powers.ts`'s module doc. The
 * prose that used to live here — the finance ladder's rungs, the giving trio,
 * the campaigns chain, the export and check-in carve-outs — is now on each
 * power's own `PowerDef`, next to the string it describes, rather than in one
 * comment that every new power had to be appended to. */

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
  capabilities: readonly Power[];
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
    // A CENTRAL seat, so every power here reaches central AND every chapter
    // (scope rule 2 — this is what the deleted `finance.central` used to say).
    // Deliberately NOT `finance.edit`: the ED approves and publishes, they
    // don't keep the books. That stays the Financial Manager's desk.
    capabilities: [
      "finance.accounts.view",
      "finance.budgets.approve",
      // The ED speaks for the org, so the ED may publish its books.
      "finance.ledger.publish",
      "org.chart.edit",
      // F-6 P1: the ED oversees the whole org's giving, including central's.
      "giving.edit",
      // Founder requirement (2026-07-24): the ED can compose/send campaigns,
      // but every send still needs sign-off from a DIFFERENT approval-power
      // holder (e.g. the Marketing Director). Approve implies compose implies
      // design — no longer listed out, since `expandPowers` derives them.
      "email.campaigns.approve",
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
    // `finance.edit` is the whole domain at CENTRAL scope, which is every
    // chapter's books too (scope rule 2) — it covers what used to take four
    // strings (`finance.manager` + `finance.central` + `finance.accounts` +
    // `finance.record`) and picks up `finance.cards.edit` by the wildcard rule.
    capabilities: [
      "finance.edit",
      // The FM closes the books monthly (see the duties above), so the FM
      // publishes them. Its own leaf — `finance.edit` never grants it.
      "finance.ledger.publish",
      "giving.view",
      // Founder requirement (2026-07-24): the FM is one of the org's
      // valid campaign approvers alongside the ED and Marketing Director.
      "email.campaigns.approve",
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
    capabilities: ["giving.edit", "data.export"],
  },
  partnership_associate: {
    id: "partnership_associate",
    title: "Partnership Associate",
    chart: "central",
    parentId: "development_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    // F-6 P1: associates read the development desk (write is the director's).
    capabilities: ["giving.view"],
  },
  fundraising_associate: {
    id: "fundraising_associate",
    title: "Fundraising Associate",
    chart: "central",
    parentId: "development_director",
    maxHolders: MULTI_HOLDER_CAP,
    duties: [],
    // F-6 P1: associates read the development desk (write is the director's).
    capabilities: ["giving.view"],
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
    capabilities: ["email.campaigns.approve", "data.export"],
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
    capabilities: ["email.assets.edit"],
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
    capabilities: ["email.assets.edit"],
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
    capabilities: ["giving.view", "data.export"],
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
    // A CHAPTER seat, so every power here reaches THIS chapter only (scope
    // rule 1). `finance.view` is read of the whole finance domain at that
    // scope — which is why it needs no carve-out for the org's bank accounts:
    // those live at central, where a chapter grant never reaches (scope rule 3).
    capabilities: [
      "finance.view",
      "finance.budgets.approve",
      // Publishes their OWN chapter's month. Pairs with the Treasurer
      // PREPARING it — the two seats are the two parties, which is exactly
      // why the Treasurer does not carry this one.
      "finance.ledger.publish",
      "giving.view",
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
    // `finance.edit` at CHAPTER scope: the whole finance domain for THIS
    // chapter and nothing beyond it. The org's bank accounts sit at central,
    // so the Treasurer never reaches them — stopped by scope, not by an
    // exception carved into the power (see `powers.ts`'s scope rules).
    capabilities: ["finance.edit", "giving.view"],
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
