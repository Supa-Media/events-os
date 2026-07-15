import { defineSchema } from "convex/server";
import { supaAuthTables, supaNotificationTables } from "@supa-media/convex/schema";

import { chapters, userProfiles, userChapters } from "./schema/chapters";
import { accessAllowlist } from "./schema/accessAllowlist";
import { templateRoles, eventRoles } from "./schema/roles";
import { templateModules, eventModules } from "./schema/modules";
import { eventTypes, templateColumns, templateItems } from "./schema/templates";
import {
  events,
  eventColumns,
  eventItems,
  roleAssignments,
} from "./schema/events";
import { people, engagements, templatePeople } from "./schema/people";
import {
  projects,
  projectComments,
  projectUpdates,
  projectEmailTokens,
} from "./schema/projects";
import { responsibilities, checkIns } from "./schema/responsibilities";
import { songs, setlistEntries, songRequests } from "./schema/songs";
import {
  eventPages,
  ticketTypes,
  rsvps,
  rsvpEmailCodes,
  ticketOrders,
  tickets,
  donations,
  eventComments,
  pageReactions,
  blasts,
} from "./schema/ticketing";
import { budgetLineItems } from "./schema/budget";
import {
  funds,
  budgetCategories,
  financeTeams,
  budgets,
  transactions,
  reimbursementRequests,
  reimbursementLineItems,
  cards,
  personalRepayments,
  payouts,
  increaseAccounts,
  legacyAccounts,
  cardAuthorizations,
  approvalPolicy,
  approvals,
  financeRoles,
  webhookEvents,
  financeSettings,
} from "./schema/finances";
import { assets, assetReservations } from "./schema/inventory";
import { docs } from "./schema/docs";
import { siteMarkers, siteShapes, siteMapPlacements } from "./schema/siteMap";
import {
  aiRuns,
  aiChanges,
  aiThreads,
  aiMessages,
  aiUsage,
  aiSettings,
} from "./schema/ai";
import { academyProgress, courseCompletions } from "./schema/academy";
import { schemaMigrations } from "./schema/migrations";

/**
 * Database schema for Chapter OS.
 *
 * Framework base tables: auth (`users` + @convex-dev/auth), multi-tenant by
 * `chapter` (`chapters` + `userChapters`), and push notifications.
 *
 * App tables use a UNIFIED ITEMS model. Every planning surface — planning doc,
 * supplies, comms, run-of-show — is a "module": a list of items rendered through
 * a configurable column set.
 *
 *   Roles            → roles (editable per chapter)
 *   Event Type/Template → eventTypes (+ templateColumns, templateItems)
 *   Event            → events (+ eventColumns, eventItems, roleAssignments)
 *   Person/Volunteer → people
 *
 * Templates are extensible (authors add/hide/reorder columns + items). Events
 * clone the template's columns AND items at creation, so they're insulated from
 * later template edits and stay locked-but-editable. The fields the backend
 * computes on (title, offset, status, role, owner, due date) are promoted to
 * typed columns on each item; everything else lives in the `fields` bag.
 *
 * Chapter scoping is on every app table from day one (multi-city is V3).
 *
 * Table definitions are grouped per domain under `schema/`; this file is the
 * thin composition root that assembles them into a single schema.
 */
const schema = defineSchema({
  ...supaAuthTables,
  ...supaNotificationTables,

  // Chapters (tenants) + user profile/membership.
  chapters,
  userProfiles,
  userChapters,

  // Access allowlist — non-domain emails granted access (seeded from Convex).
  // Chapter-OS successor to the retired `guestAllowlist` table, which was copied
  // over by `copyGuestAllowlist`, drained by `purgeGuestAllowlist`, and dropped
  // from the schema in Deploy C. New grants/revokes and all reads target this.
  accessAllowlist,

  // Roles (template-owned + event-owned).
  templateRoles,
  eventRoles,

  // Custom modules (template-owned + event-owned). Core modules are constants.
  templateModules,
  eventModules,

  // Templates (event types + their columns/items).
  //
  // ⚠️ STORAGE-LEGACY NAME — DO NOT RENAME. The Chapter-OS vocabulary calls
  // these "Templates" and the API module is `templates.ts` (`api.templates.*`),
  // but the SCHEMA TABLE KEY stays `eventTypes` and every `eventTypeId` foreign
  // key keeps its name. Convex cannot rename a table in place; a copy-migration
  // would rewrite ~390 references and invalidate client-cached ids for zero user
  // benefit. So the table name is intentionally frozen as legacy storage.
  eventTypes,
  templateColumns,
  templateItems,

  // Events (instances + their columns/items + role assignments).
  events,
  eventColumns,
  eventItems,
  roleAssignments,

  // People (roster) + engagements + template placeholder crew.
  people,
  engagements,
  templatePeople,

  // Projects (nestable units of work, owned by people, optionally event-backed)
  // + their running comment history + email-action capability tokens.
  projects,
  projectComments,
  projectUpdates,
  projectEmailTokens,

  // Responsibilities (recurring duties, fanned out by role) + 1:1 check-ins.
  responsibilities,
  checkIns,

  // Songs (chapter library) + per-event setlists + public song requests.
  songs,
  setlistEntries,
  songRequests,

  // Ticketing (public landing pages, RSVPs, Stripe orders, comments, blasts).
  eventPages,
  ticketTypes,
  rsvps,
  rsvpEmailCodes,
  ticketOrders,
  tickets,
  donations,
  eventComments,
  pageReactions,
  blasts,

  // Budget (per-line budget for an event — planned/actual/receipt per line).
  // Coexists with the coarse `events.budget` headline (see docs/plans/budget.md).
  budgetLineItems,

  // Finance — the native money layer (Increase + Stripe FC) that replaces
  // KleerCard / Bill.com. Funds/categories/teams organize money; `budgets`
  // allocate it (scope × cadence); `transactions` is the ONLY actual-spend
  // record; reimbursements/cards/payouts move it; roles gate it. All money is
  // integer cents, chapter-scoped (see docs/plans/finance.md + schema/finances.ts).
  funds,
  budgetCategories,
  financeTeams,
  budgets,
  transactions,
  reimbursementRequests,
  reimbursementLineItems,
  cards,
  personalRepayments,
  payouts,
  increaseAccounts,
  legacyAccounts,
  cardAuthorizations,
  approvalPolicy,
  approvals,
  financeRoles,
  webhookEvents,
  financeSettings,

  // Inventory (M5.5) — chapter-owned asset registry + per-event reservations.
  // The first chapter-level typed entity; events RESERVE from the registry and
  // overbooking is computed from live reservations (see docs/plans/inventory.md).
  assets,
  assetReservations,

  // Docs (the standalone targets behind How-To cells).
  docs,

  // Site map (markers, shapes, placements).
  siteMarkers,
  siteShapes,
  siteMapPlacements,

  // AI (runs, changes, threads, messages, usage, settings).
  aiRuns,
  aiChanges,
  aiThreads,
  aiMessages,
  aiUsage,
  aiSettings,

  // Academy (per-person curriculum progress + earned course badges).
  academyProgress,
  courseCompletions,

  // Migration ledger (which data migrations have run on this deployment).
  schemaMigrations,
});

export default schema;
