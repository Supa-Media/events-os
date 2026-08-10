import { defineSchema } from "convex/server";
import { supaAuthTables, supaNotificationTables } from "@supa-media/convex/schema";

import { chapters, userProfiles, userChapters } from "./schema/chapters";
import { accessAllowlist } from "./schema/accessAllowlist";
import { backerMilestones } from "./schema/backerMilestones";
import { templateRoles, eventRoles } from "./schema/roles";
import { templateModules, eventModules } from "./schema/modules";
import { eventTypes, templateColumns, templateItems } from "./schema/templates";
import {
  events,
  eventColumns,
  eventItems,
  roleAssignments,
} from "./schema/events";
import {
  people,
  engagements,
  templatePeople,
  personAudit,
  personEmails,
} from "./schema/people";
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
  rsvpPhoneCodes,
  ticketOrders,
  tickets,
  guestTeams,
  donations,
  eventComments,
  pageReactions,
  blasts,
  blastRecipients,
  doorGrants,
  sales,
} from "./schema/ticketing";
import {
  funds,
  budgetCategories,
  financeTeams,
  budgets,
  budgetApprovalLog,
  budgetTags,
  budgetTagLinks,
  budgetLines,
  transactions,
  processorFeeEntries,
  processorFeeSchedule,
  reimbursementRequests,
  reimbursementLineItems,
  cards,
  cardRequests,
  personalRepayments,
  payouts,
  increaseAccounts,
  legacyAccounts,
  financeStripeCustomers,
  cardAuthorizations,
  cardMerchantPolicy,
  approvalPolicy,
  approvals,
  reattributionAudit,
  financeAuditLog,
  financeRoles,
  specializedRoles,
  webhookEvents,
  reimbursementSubmitAttempts,
  cardDetailsRevealAttempts,
  receiptNudgeAttempts,
  financeSettings,
  stripePayouts,
  reconciliationRuns,
  reconciliationFlags,
  inboundReceipts,
  receiptReplyBatches,
  receipts,
  receiptLinks,
  receiptExceptions,
  transactionCodings,
  receiptSweepState,
} from "./schema/finances";
import {
  donors,
  donorIdentities,
  gifts,
  giftAudit,
  giftReversals,
  donorAudit,
  givingScopeRollups,
  pledges,
  pledgeEvents,
  dismissedGiftCandidates,
  givebutterConvertedDonations,
} from "./schema/givingPlatform";
import { sponsorPackages, sponsorships } from "./schema/sponsorships";
import { territories } from "./schema/territories";
import { givingInterest } from "./schema/givingInterest";
import { givingNotificationRules } from "./schema/givingNotifications";
import { givingActivity } from "./schema/givingActivity";
import { seatDefs, seatAssignments } from "./schema/seats";
import { seatStructureLog } from "./schema/seatStructureLog";
import { seatProposals } from "./schema/seatProposals";
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
import { integrationSettings } from "./schema/integrationSettings";
import { googleChatChannels } from "./schema/googleChatChannels";
import { smsOptOuts } from "./schema/smsOptOuts";
import { smsUsageEvents } from "./schema/smsUsage";
import {
  audiences,
  campaigns,
  campaignApprovalLog,
  campaignPollVotes,
  campaignRecipients,
  campaignTemplates,
  emailImages,
  emailSuppressions,
  emailSuppressionAudit,
  emailReplies,
  emailThemes,
} from "./schema/campaigns";
import { serviceOptions } from "./schema/services";
import { formSubmissions, formDefinitions } from "./schema/forms";
import { identityDecisions } from "./schema/identity";
import { exportJobs } from "./schema/dataExports";

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
  // Person contact-field edit audit (name/email/phone) — narration only.
  personAudit,
  // Person-centric audiences Phase 2 (specs/person-centric-audiences.md) —
  // every known email address for a person, with provenance/verification for
  // deterministic send-address resolution (`lib/personEmails.ts`). See
  // `schema/people.ts`'s module doc.
  personEmails,

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
  rsvpPhoneCodes,
  ticketOrders,
  tickets,
  // Door-assigned attendee teams (see schema/ticketing.ts) — distinct from the
  // crew teams that live as select options on the volunteer_expectations grid.
  guestTeams,
  doorGrants,
  sales,
  donations,
  eventComments,
  pageReactions,
  blasts,
  // Per-address record of an EMAIL blast, minted so each recipient's
  // announcement can carry its OWN working unsubscribe link/header (bulk mail
  // legally needs one). Resolves through the same /unsubscribe/<token> route
  // campaign recipients do — see schema/ticketing.ts's doc for why it's a
  // table rather than a derived token.
  blastRecipients,

  // Finance — the native money layer (Increase + Stripe FC) that replaces
  // KleerCard / Bill.com. Funds/categories/teams organize money; `budgets`
  // allocate it (scope × cadence); `transactions` is the ONLY actual-spend
  // record; reimbursements/cards/payouts move it; roles gate it. All money is
  // integer cents, chapter-scoped (see docs/plans/finance.md + schema/finances.ts).
  funds,
  budgetCategories,
  financeTeams,
  budgets,
  budgetApprovalLog,
  budgetTags,
  budgetTagLinks,
  budgetLines,
  transactions,
  // The per-ledger-entry evidence behind each monthly processor-fee rollup row
  // (`processorFees.ts`) — a rollup nobody can inspect is a number taken on
  // faith. See `schema/finances.ts`'s doc on this table.
  processorFeeEntries,
  // What each payment rail COSTS — an optional per-rail override of the rate
  // published in `@events-os/shared#DEFAULT_FEE_SCHEDULE`, so a pricing change
  // doesn't need a deploy. Prediction only; never used to book a fee.
  processorFeeSchedule,
  reimbursementRequests,
  reimbursementLineItems,
  cards,
  // WP-C.1: card requests (member request → FM/Treasurer approve/deny).
  cardRequests,
  personalRepayments,
  payouts,
  increaseAccounts,
  legacyAccounts,
  // Stripe Customer cache — the required `account_holder` for FC sessions.
  financeStripeCustomers,
  cardAuthorizations,
  // Chapter merchant allow-list for real-time card-authorization decisions.
  cardMerchantPolicy,
  approvalPolicy,
  approvals,
  // Append-only ledger of bulk reattribution / project-transfer operations (the
  // retroactive-split audit trail, WP-2.2). Org-level: keyed on the destination.
  reattributionAudit,
  // Append-only field-change trail (excluding a transaction, recoding it,
  // attaching/detaching a receipt, a personal flag, a note edit, a manual
  // entry, a budget amount edit/delete) — distinct from the three tables
  // above (see `schema/finances.ts`'s own doc comment on this table).
  financeAuditLog,
  financeRoles,
  // Leadership + finance titles at central/chapter scope (super-admin managed,
  // scope-local separation of duties; finance_manager bridges to a finance role).
  specializedRoles,
  webhookEvents,
  // Anonymous public reimbursement submit rate limiter (deployment-wide).
  reimbursementSubmitAttempts,
  // WP-C.3: rate limiter for the HOLDER-ONLY card-details reveal (add-to-wallet).
  cardDetailsRevealAttempts,
  // Rate limiter for the FM-only manual Chase Receipts "Send reminder"/
  // "Remind all" nudge — at most one per cardholder per 24h.
  receiptNudgeAttempts,
  financeSettings,
  // Morning reconciliation engine: detected Stripe payouts + per-book
  // allocation records, the run audit trail, and FM audit flags.
  stripePayouts,
  reconciliationRuns,
  reconciliationFlags,
  // Inbound email → OCR → reconcile pipeline (receipt backfill). See receiptInbox.ts.
  inboundReceipts,
  // Debounce batches for the courtesy reply an emailed receipt earns its
  // sender — one digest per address per window, not one email per receipt.
  receiptReplyBatches,
  // First-class receipt DOCUMENTS + their many-to-many links to transactions.
  // `receipts` is the source of truth a receipt is; `transactions.receiptStorageId`
  // stays a denormalized cache. Written only through lib/receiptLinks.ts.
  receipts,
  receiptLinks,
  // The documentation of record when no receipt can be produced — an attested,
  // approved substitute, NOT a "missing" marker. Written only through
  // lib/receiptExceptions.ts, which also owns the denormalized
  // `transactions.approvedReceiptExceptionId` pointer. See
  // `docs/plans/receipt-exceptions.md`.
  receiptExceptions,
  // The structured, human-authored substantiation record per transaction
  // (travel route, meal attendees, business purpose) with its own review
  // lifecycle. Written only through lib/transactionCoding.ts, which also owns
  // the denormalized `transactions.codingState`. See
  // `docs/plans/transaction-coding.md`.
  transactionCodings,
  // Per-chapter "is a failed-extraction retry sweep running" marker — see
  // `schema/finances.ts`'s doc + `receipts.ts#retryFailedExtractions`.
  receiptSweepState,

  // Backer milestone ladder (giving-platform PRD §3) — dev-director-editable
  // "N backers → chapter commits to X" rungs. Global-only for now; seeded
  // from + falls back to `AFFORDABILITY_TIERS` (`@events-os/shared`). See
  // `schema/backerMilestones.ts` + `backerMilestones.ts`.
  backerMilestones,

  // Giving Platform (F-6, P1) — the development team's donor CRM: `donors`
  // (chapter/central-scoped relationship records) + `gifts` (giving history,
  // dual-written from event `donations`) + per-scope rollups for the dashboard.
  // Money is integer cents; `transactions` stays the only actuals ledger (see
  // docs/plans/giving-platform.md §1 + schema/givingPlatform.ts).
  donors,
  // Cross-chapter donor IDENTITY layer (donor-identity, 2026-07): the ONE
  // underlying person behind the scope-partitioned `donors` rows. ADDITIVE —
  // groups rows by normalized email (else phone/name) and carries a `scopes`
  // list of the books that person is part of, without collapsing rows or
  // touching per-scope money rollups. See schema/givingPlatform.ts +
  // lib/donorIdentity.ts.
  donorIdentities,
  gifts,
  // Gifts ledger: the human-edit audit breadcrumb trail (per-gift, newest-first
  // via by_gift). Written by the desk mutations, never affects a money rollup.
  giftAudit,
  // The tombstone for a gift that was booked and then PULLED BACK OUT — an ACH
  // debit the bank returned after it settled (up to 60 days later), or a card
  // chargeback. Unlike giftAudit this one is written by a WEBHOOK, has no human
  // actor, and carries a full snapshot: `removeGiftRow` is the only correct way
  // to un-wind the rollups but it deletes, and a deleted row explains nothing.
  // The snapshot is also the undo, for a dispute that later closes as won.
  // See givingReversals.ts + schema/givingPlatform.ts.
  giftReversals,
  // Giving integrity tools (owner feedback #4): the donor-record edit + person-
  // link audit trail (per-donor, newest-first via by_donor). Same narration-only
  // role as giftAudit — never touches a money rollup.
  donorAudit,
  givingScopeRollups,
  // P2 recurring rails — `pledges` (Stripe-subscription-backed monthly backing);
  // paid cycles write `gifts` rows (`pledgeId` set). Derives `chapters.backerCount`
  // (see givingPledges.ts + docs/plans/giving-platform.md §2).
  pledges,
  // Giving integrity tools (owner feedback #5d): the pledge lifecycle history —
  // one immutable event per status transition (manual AND system/billing) and
  // per manual field edit, so a backer's paused/resumed/failed timeline is legible.
  pledgeEvents,
  // Territories P7 (bank-credit gift matching, docs/plans/giving-territories.md
  // §D10) — dismissal ledger for `candidateExternalGifts` (see
  // `schema/givingPlatform.ts` for the shape; `gifts.transactionId` +
  // `by_transaction` carry the confirm-side link).
  dismissedGiftCandidates,
  // The tombstone that keeps a RECLASSIFIED Givebutter donation from being
  // re-inserted by the next sync run. `applyGivebutterDonations` dedups on
  // `gifts.by_externalRef`, so removing a gift makes that lookup miss and the
  // donation lands twice; this table is the durable "seen, and deliberately
  // recorded elsewhere" record it consults instead. See
  // schema/givingPlatform.ts for the full reasoning.
  givebutterConvertedDonations,

  // "Tell me when money comes in" — standing instructions pairing a set of
  // email addresses with a book, an amount floor, and a frequency (immediate /
  // daily / weekly). Read by `givingNotifications.ts` (the immediate send,
  // scheduled from `recordGiftForDonor`) and `givingNotificationDigests.ts`
  // (the hourly digest sweep). See schema/givingNotifications.ts +
  // docs/plans/giving-notifications.md.
  givingNotificationRules,

  // Sponsorships & partnerships (F-6, P4) — dev-director-authored sponsor
  // package tiers (`sponsorPackages`) + the agreement pipeline that tracks an
  // org donor from prospect through an active partnership (`sponsorships`).
  // Central lens only; a sponsorship's actual payments are ordinary `gifts`
  // rows with `sponsorshipId` set (see schema/sponsorships.ts + sponsorships.ts).
  sponsorPackages,
  sponsorships,

  // Territories (giving-territories addendum) — a territory maps 1:1 with a
  // real chapter (a "shadow chapter" while prospect); prospect pledges/donors/
  // gifts scope DIRECTLY to that chapter, and launch is `chapters.isActive:
  // true`. Backer count is ALWAYS read from the linked chapter — no counter
  // here. Supersedes `cityCampaigns` (see schema/territories.ts + territories.ts
  // + docs/plans/giving-territories.md).
  territories,

  // Interest capture + suggest-a-space (giving-territories addendum, the
  // `/give` redesign) — lead capture (no payment rail) from the public `/give`
  // page's "want this in my city" / volunteer / join team / fund / suggest-a-
  // space CTAs, triaged centrally. See schema/givingInterest.ts +
  // givingInterest.ts.
  givingInterest,

  // Public per-territory activity wall (the `/give` redesign) — recurring
  // backers + one-time givers who opted to share a message/display name; every
  // row required a real Stripe payment (spam deterrent), flipped visible on
  // settle. See schema/givingActivity.ts + givingActivity.ts.
  givingActivity,

  // Org chart (seats) — a tree of seats shared by the central chart + every
  // chapter's identical chapter chart; occupancy is per-scope (see
  // schema/seats.ts). Seed-only for now: assignment mutations land in a
  // later PR.
  seatDefs,
  seatAssignments,
  // Structure-editing audit log (`seatStructure.ts`'s addSeat/renameSeat/
  // updateSeat/reparentSeat/removeSeat) — distinct from occupancy above.
  seatStructureLog,
  // Two-party seat-change proposals (schema/seatProposals.ts) — a seat holder
  // proposes filling/vacating a seat strictly below their own; a holder above
  // the proposer approves. See seatProposals.ts for the write mutations.
  seatProposals,

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

  // Integration settings (Attendance E) — deployment-wide singleton for
  // third-party API credentials configured in-app by a superuser (today: the
  // Givebutter API key). See schema/integrationSettings.ts +
  // integrationSettings.ts.
  integrationSettings,

  // Google Chat channels — deployment-wide named-space list (name + write-only
  // webhook URL) behind the Comms Schedule's in-app "Send" button. See
  // schema/googleChatChannels.ts + googleChatChannels.ts + commsSend.ts.
  googleChatChannels,

  // SMS opt-outs (Attendance F) — deployment-wide STOP/START ledger, a
  // defense-in-depth mirror of Twilio's own Advanced Opt-Out. See
  // schema/smsOptOuts.ts + smsOptOuts.ts + the `/twilio/webhook` route.
  smsOptOuts,
  // SMS usage/cost ledger (Attendance F) — one row per send attempt (blast or
  // verification code). See
  // schema/smsUsage.ts + smsUsage.ts.
  smsUsageEvents,

  // Email campaigns — the in-app newsletter/announcement composer (central-
  // only). `audiences` are saved recipient definitions; `campaigns` are the
  // composed sends against one; `campaignRecipients` is the per-address
  // delivery ledger; `emailSuppressions` is the deployment-wide do-not-email
  // list (unsubscribe/bounce/complaint); `emailReplies` mirrors inbound mail
  // matched back to a campaign. See schema/campaigns.ts + audiences.ts +
  // campaigns.ts + emailSuppressions.ts + the /unsubscribe and /resend/webhook
  // routes in http.ts.
  audiences,
  campaigns,
  // Two-party campaign approval (founder requirement, 2026-07-24) — the
  // permanent decision history alongside `campaigns`' own last-decision-only
  // fields. See schema/campaigns.ts's module doc + campaigns.ts's
  // state-machine doc.
  campaignApprovalLog,
  campaignRecipients,
  emailSuppressions,
  // Append-only "who un-suppressed this address, and why" trail — the two
  // ADMIN suppression mutations only. See schema/campaigns.ts's doc.
  emailSuppressionAudit,
  emailReplies,
  // The composer's design surface: `emailThemes` are the org's saved, editable
  // token sets (the built-in presets stay in code — see
  // @events-os/shared's EMAIL_THEME_PRESETS); `campaignTemplates` are saved
  // starting documents; `emailImages` is the reusable illustration library;
  // `campaignPollVotes` is one row per (recipient, poll block), written by the
  // public `/poll/` route. See schema/campaigns.ts's doc for each +
  // emailThemes.ts / campaignTemplates.ts / emailImages.ts / campaignPolls.ts.
  emailThemes,
  campaignTemplates,
  emailImages,
  campaignPollVotes,

  // Service Catalog — the managed dropdown behind `people.serviceIds` (see
  // schema/services.ts's module doc). One level of parent/child nesting,
  // soft-delete only; `serviceOptions.ts` owns every write.
  serviceOptions,

  // Form Submissions (PW Forms consolidation) — one table for every Google
  // Form response, person-scoped (`personId` set) or event-scoped
  // (`eventId` set, anonymous surveys). `formDefinitions` holds each form's
  // ordered question list. See schema/forms.ts's module doc +
  // lib/formCatalog.ts (the 6-form catalog) + formSubmissions.ts (reads +
  // the internal import write path).
  formSubmissions,
  formDefinitions,

  // Guest Identity review (Partiful name-only RSVP resolution) — the
  // append-only decision ledger behind the human review queue's
  // suppression/resurfacing logic. See schema/identity.ts's module doc +
  // identity.ts (queries/mutations) + migrations/0050_link_rsvp_identifiers.ts
  // (the automated auto-link half).
  identityDecisions,

  // Data Export — one row per "give me this database as a spreadsheet"
  // request. Doubles as the extraction AUDIT TRAIL: expiry purges the stored
  // files but NEVER the row, so "who took what, when" outlives the bytes. See
  // schema/dataExports.ts's module doc + lib/dataExportAccess.ts (the
  // `data.export` gate) + dataExports.ts (job lifecycle + paginated runner).
  exportJobs,
});

export default schema;
