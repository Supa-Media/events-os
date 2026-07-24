/**
 * Snapshot of the Academy curriculum + course catalog, captured BEFORE the
 * academy.ts / academyCourses.ts monolith was split into per-stream files
 * (packages/shared/src/academy/**). Hardcoded literal values (not vitest
 * snapshots) so a silent behavior change during the split — a re-ordered
 * section, a moved course, a changed minutes/quiz count — fails loudly.
 *
 * This test passed UNCHANGED across the split itself. It was DELIBERATELY
 * updated since for: the Foundations stream prepended (7 sections, 2
 * courses); the `chapter-money-model` reshape (shared core course for
 * Treasurer + Chapter Director) — two sections appended
 * (finance-budget-lifecycle, finance-one-home-per-dollar), a new
 * `chapter-money-model` course inserted between finances-for-everyone and
 * treasurer, and `finance-tiers-and-skim` moved out of chapter-director's
 * moduleSlugs into it; the Music stream appended after Finances (9 sections,
 * 3 courses); the People & Leadership expansion of the Management stream's
 * section/course set; and the Marketing & Media stream appended after Music
 * (4 sections — `mktg-the-look`, `mktg-hit-record`, `mktg-shoot-to-timeline`,
 * `mktg-getting-access` — 2 courses; a caption-voice lesson and a
 * short-form-editing course were authored and then descoped before merge —
 * see `streams/marketing.ts`'s header comment); the July All-Team
 * Meeting fold into Foundations — two sections appended
 * (foundations-we-pray-before-we-plan onto Welcome to Public Worship,
 * foundations-owning-your-yes onto How we work), plus a rewritten
 * foundations-communication and an enriched foundations-showing-up (see
 * `streams/foundations.ts`'s header comment); the Finances-for-Everyone
 * owner review pass — no sections added/moved, but `finance-stewardship`,
 * `finance-card-and-receipts`, and `finance-reimbursements-and-flags` grew
 * (minutes + quizLength bumped) for the Public Worship card terminology
 * sweep, the donate-instead-of-personally-covering pattern, the absolute
 * receipt rule, and the code-verified reimbursement-approval/urgent-path
 * content (see `streams/finances.ts`'s header comment); and the "Leading a
 * project" course — five sections appended to the Works stream
 * (works-defining-a-project, works-planning-the-work,
 * works-the-project-budget, works-tracking-and-escalating,
 * works-finishing-well), with the new `leading-a-project` course inserted
 * between `projects` and `duties` in the Works course catalog; and the
 * Development stream (F-6, `docs/plans/giving-platform.md` §8) appended
 * after Marketing & Media — 12 sections (`dev-giving-vocabulary` through
 * `dev-prospect-cities-and-map`) across 5 new courses (`giving-fundamentals`,
 * `donor-stewardship`, `the-backer-model`, `sponsorships-and-partnerships`,
 * `the-city-launch-story`), plus a Finances-stream touch-up:
 * `finance-tiers-and-skim` gained one quiz question (now 5, was 4) teaching
 * that the backer count is derived from pledges, not manually entered (see
 * `streams/finances.ts`'s header comment). Total: 96 sections. Section slugs
 * and their order are otherwise untouched — any OTHER drift here is still a
 * real regression.
 *
 * The Gifts ledger PR then APPENDED one Development section,
 * `dev-gifts-ledger-and-audit` (4 min, 4-quiz), into the `donor-stewardship`
 * course after `dev-import-and-backfill` — teaching the chronological gifts
 * ledger, edit-with-audit-trail, cross-book moves, donor reassignment, and
 * manual merge (owner requests #1–#5). Total: 97 sections. That course now
 * carries three modules; nothing else moved.
 *
 * `dev-prospect-cities-and-map` had its COPY + quiz corrected once the public
 * `/give` map shipped (PR #275, giving-platform §5): the map/city pages are now
 * taught as live, and launch's non-automatic pledge re-scope is told honestly
 * (an open owner decision, PRD Appendix C#3). Its minutes and quiz-length were
 * unchanged then, so the snapshotted values stayed put.
 *
 * The Territories cutover (docs/plans/giving-territories.md) then RETITLED that
 * section — "Prospect cities…" → "Prospect territories: how a dot becomes a
 * chapter" (the ONLY title change below) — and rewrote its prose + quiz, plus
 * the `dev-giving-vocabulary` "prospect city" → "prospect territory" copy: a
 * territory now maps 1:1 with a real chapter ("shadow chapter"), backers scope
 * DIRECTLY to it, and launch is a flag-flip that moves no money (the old
 * central-held/owner-decision teaching is obsolete). Slug, minutes, quiz
 * lengths, and order are all unchanged, so only that one title moved here.
 *
 * Territories P6 (canonical import, docs/plans/giving-territories.md) then
 * RETITLED `dev-import-and-backfill` — "Backfilling history: CSV import and
 * manual entry" → "The canonical import: preview, classify, commit" — and
 * rewrote it end to end for the one preview-then-commit import that replaced
 * the Givebutter-only CSV/recurring importers: the four row types, the
 * gift-vs-ticket classification rule (a ticket buyer got a seat back, so
 * that row can never become a donor), the dedup/suspected-duplicate rules,
 * and the gift/ticket split that catches a misclassified export before
 * commit. Minutes 4→5, quiz length 3→4 (both bumped below); slug and course
 * placement are unchanged. `dev-giving-vocabulary`'s "Gift" bullet and its
 * quiz were also touched (added the ticket-buyer-isn't-a-donor distinction,
 * still 4 questions), `dev-donor-crm-basics` gained a tip about the People
 * tab's giver marks (P5, previously undocumented), and
 * `dev-givebutter-migration`'s import bullets now point at the canonical
 * import instead of the deleted CSV tool — none of those three change
 * title/minutes/quiz-length, so nothing else moved in the tables below.
 *
 * 2026-07-19 (owner decision, Seyi — giving desk as an assignable per-role
 * power): `dev-donor-crm-basics` gained a rule + one quiz question explaining
 * that Giving-desk access is a per-seat power (None/View/Manage) the ED assigns
 * from the org chart — quiz length 4→5 (bumped below); its minutes, title, and
 * placement are unchanged, so nothing else in the tables moved.
 *
 * Giving integrity tools (owner feedback, Seyi — delete-with-reason, gift
 * splits, paused backers): `dev-gifts-ledger-and-audit` gained a "Split" +
 * "Remove (with a required reason)" teaching and one quiz question on why a
 * removal asks why — quiz length 4→5 (bumped below). `dev-backer-lifecycle`
 * gained the manual PAUSED status (a paused pledge stays listed but doesn't
 * count, and is sticky against Stripe re-syncs) + a quiz question on pausing —
 * quiz length 4→5 (bumped below); its subtitle now names the manual pause but
 * its snapshotted title/minutes are unchanged. `dev-backer-floor-and-ladder`'s
 * reveal added paused as a second non-counting reason (prose only — no snapshot
 * change). No slugs, titles, minutes, or order moved beyond those two quiz bumps.
 *
 * Two-party campaign approval (founder requirement, 2026-07-24):
 * `dev-relationship-workflow` gained a rule ("A personal thank-you and a
 * campaign are different tools") + one quiz question, contrasting the
 * one-to-one donor relationship this lesson teaches with the one-to-many
 * Campaigns desk, and teaching that Compose/Approve is the same
 * per-role-power mechanism as Giving — even the ED needs a DIFFERENT chosen
 * reviewer's approval to send a campaign. Quiz length 3→4 (bumped below);
 * its minutes, title, and placement are unchanged. (`dev-donor-crm-basics`
 * was considered too — its Giving-power quiz is already at the 5-question
 * cap — so this landed one lesson over instead.)
 *
 * Supplies ⇄ Inventory unification (docs/plans/inventory-supplies-unification.md,
 * the linking UI shipping): `tab-supplies` was rewritten for the provenance
 * Source model, the auto-derived Status (packed → Have it; "Event X ·
 * Container" for cross-event holds; override + back-to-auto), and the
 * "Keep in inventory" promotion — two quiz questions swapped in (the rings
 * and battery questions retired; both are taught elsewhere), so quiz length
 * stays 5 and its title, minutes, and placement are unchanged. A NEW section
 * `keeping-inventory`
 * (4 min, 4-quiz) was inserted after it, teaching the chapter gear registry:
 * reservations as a byproduct of supply rows, computed availability,
 * consumables/low-stock, and what belongs in the registry. The
 * `logistics-lead` course gained the new module (its description finally
 * cashes the "gains a keeping-inventory module" promise). Total: 98 sections.
 *
 * Chase Receipts manual nudge (the in-app "Send reminder"/"Remind all"
 * buttons, `cards.sendReceiptNudge`): `finance-chasing-receipts` gained a
 * paragraph on the buttons (one click re-sends the same reminder email +
 * best-effort text, rate-limited to once per cardholder per day) and one quiz
 * question on when to use them instead of texting a cardholder off-app —
 * quiz length 3→4 (bumped below). Its title, minutes, and placement are
 * unchanged. No slugs, sections, or courses moved; total stays 98 sections.
 */
import { describe, expect, test } from "vitest";
import { ACADEMY_COURSES, ACADEMY_SECTIONS } from "./academy";

// Ordered section slugs (curriculum/unlock order).
const EXPECTED_SECTION_SLUGS: string[] = [
  "foundations-seeds-and-soil",
  "foundations-chapters-and-central",
  "foundations-the-work",
  "foundations-we-pray-before-we-plan",
  "foundations-communication",
  "foundations-showing-up",
  "foundations-where-things-live",
  "foundations-spending",
  "foundations-owning-your-yes",
  "what-is-events-os",
  "organizers-and-crew",
  "anatomy-of-an-event",
  "being-an-owner",
  "timing-and-offsets",
  "phase-rings",
  "tab-tasks",
  "tab-comms",
  "tab-run-of-show",
  "tab-crew-duties",
  "tab-supplies",
  "keeping-inventory",
  "tab-permits",
  "tab-debrief",
  "using-the-assistant",
  "capstone-join-an-event",
  "capstone-birthday-party",
  "capstone-worship-event",
  "capstone-comms-lead",
  "capstone-event-lead",
  "capstone-logistics-lead",
  "works-projects",
  "works-driving-a-project",
  "works-duties",
  "works-owning-a-duty",
  "works-defining-a-project",
  "works-planning-the-work",
  "works-the-project-budget",
  "works-tracking-and-escalating",
  "works-finishing-well",
  "mgmt-one-on-one",
  "mgmt-reviewing-the-work",
  "mgmt-caring-for-people",
  "mgmt-holding-the-line",
  "mgmt-the-org-tree",
  "mgmt-director-philosophy",
  "mgmt-ownership-not-babysitting",
  "mgmt-the-slas",
  "mgmt-the-repair-ritual",
  "mgmt-building-for-your-absence",
  "mgmt-empower-first",
  "mgmt-the-interview",
  "mgmt-the-trial",
  "mgmt-the-call",
  "mgmt-the-four-gates",
  "mgmt-frontline-no-final-yes",
  "finance-stewardship",
  "finance-card-and-receipts",
  "finance-reimbursements-and-flags",
  "finance-reconcile-grid",
  "finance-chasing-receipts",
  "finance-monthly-close",
  "finance-raise-vs-manage",
  "finance-approving-budgets",
  "finance-tiers-and-skim",
  "finance-cross-chapter-audit",
  "finance-receipt-escalation-queue",
  "finance-accounts-and-cards-admin",
  "finance-central-budgets",
  "finance-governance-and-seats",
  "finance-launch-grants-and-transfers",
  "finance-budget-lifecycle",
  "finance-one-home-per-dollar",
  "music-worship-is-a-sacrifice",
  "music-the-test",
  "music-four-shapes-of-praise",
  "music-the-five-drifts",
  "music-running-the-room",
  "music-submitting-a-song",
  "music-what-a-producer-does",
  "music-artist-is-a-brand",
  "music-the-economics-of-a-song",
  "mktg-the-look",
  "mktg-hit-record",
  "mktg-shoot-to-timeline",
  "mktg-getting-access",
  "dev-giving-vocabulary",
  "dev-donor-crm-basics",
  "dev-relationship-workflow",
  "dev-import-and-backfill",
  "dev-gifts-ledger-and-audit",
  "dev-backer-floor-and-ladder",
  "dev-backer-lifecycle",
  "dev-givebutter-migration",
  "dev-sponsor-packages",
  "dev-sponsorship-pipeline",
  "dev-church-partnerships",
  "dev-city-launch-economics",
  "dev-prospect-cities-and-map",
];

// Per-section fields that must not drift: title, minutes, quiz length,
// optional flag, capstone kind (null when not a capstone).
const EXPECTED_SECTIONS: {
  slug: string;
  title: string;
  minutes: number;
  quizLength: number;
  optional: boolean;
  capstoneKind: string | null;
}[] = [
  {
    slug: "foundations-seeds-and-soil",
    title: "Seeds & soil",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-chapters-and-central",
    title: "Chapters and central",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-the-work",
    title: "The work",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-we-pray-before-we-plan",
    title: "We pray before we plan",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-communication",
    title: "Communication",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-showing-up",
    title: "Showing up",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-where-things-live",
    title: "Where things live",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-spending",
    title: "Spending like it's not yours",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "foundations-owning-your-yes",
    title: "Owning your yes",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "what-is-events-os",
    title: "What Chapter OS is",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "organizers-and-crew",
    title: "Organizers and crew",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "anatomy-of-an-event",
    title: "Anatomy of an event",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "being-an-owner",
    title: "Being an owner",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "timing-and-offsets",
    title: "Timing that moves with the date",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "phase-rings",
    title: "The four rings",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-tasks",
    title: "Tasks",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-comms",
    title: "Comms Schedule",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-run-of-show",
    title: "Run of Show",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-crew-duties",
    title: "Crew Duties",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-supplies",
    title: "Supplies & Logistics",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "keeping-inventory",
    title: "Keeping inventory",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-permits",
    title: "Permits",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "tab-debrief",
    title: "Debrief",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "using-the-assistant",
    title: "Working with the assistant",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "capstone-join-an-event",
    title: "Capstone: join an event",
    minutes: 8,
    quizLength: 0,
    optional: false,
    capstoneKind: "join_event",
  },
  {
    slug: "capstone-birthday-party",
    title: "Capstone: plan a party from scratch",
    minutes: 10,
    quizLength: 0,
    optional: false,
    capstoneKind: "birthday_party",
  },
  {
    slug: "capstone-worship-event",
    title: "Bonus: plan a worship event",
    minutes: 12,
    quizLength: 0,
    optional: true,
    capstoneKind: "worship_event",
  },
  {
    slug: "capstone-comms-lead",
    title: "Capstone: run the comms",
    minutes: 12,
    quizLength: 0,
    optional: false,
    capstoneKind: "comms_lead",
  },
  {
    slug: "capstone-event-lead",
    title: "Capstone: run the plan",
    minutes: 12,
    quizLength: 0,
    optional: false,
    capstoneKind: "event_lead",
  },
  {
    slug: "capstone-logistics-lead",
    title: "Capstone: run the supplies",
    minutes: 10,
    quizLength: 0,
    optional: false,
    capstoneKind: "logistics_lead",
  },
  {
    slug: "works-projects",
    title: "Projects",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-driving-a-project",
    title: "Driving a project to done",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-duties",
    title: "Duties",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-owning-a-duty",
    title: "Owning a duty",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-defining-a-project",
    title: "Defining the project",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-planning-the-work",
    title: "Planning the work",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-the-project-budget",
    title: "Building the budget",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-tracking-and-escalating",
    title: "Tracking execution, escalating risks",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "works-finishing-well",
    title: "Completing and reviewing",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-one-on-one",
    title: "The 1:1: person first, then work",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-reviewing-the-work",
    title: "Reviewing the work",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-caring-for-people",
    title: "People are a renewable resource",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-holding-the-line",
    title: "Holding the line",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-org-tree",
    title: "The manager tree",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-director-philosophy",
    title: "Directing",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-ownership-not-babysitting",
    title: "Ownership, not babysitting",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-slas",
    title: "The SLAs",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-repair-ritual",
    title: "The repair ritual",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-building-for-your-absence",
    title: "Building for your absence",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-empower-first",
    title: "Empower first, appoint second",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-interview",
    title: "The interview",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-trial",
    title: "The trial",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-call",
    title: "The call",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-the-four-gates",
    title: "The four gates",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mgmt-frontline-no-final-yes",
    title: "Frontline no, final yes",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-stewardship",
    title: "Where the money comes from",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-card-and-receipts",
    title: "Your card and the 7-day rule",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-reimbursements-and-flags",
    title: "Reimbursement, and flagging a charge",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-reconcile-grid",
    title: "Running Reconcile",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-chasing-receipts",
    title: "Chasing receipts",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-monthly-close",
    title: "The monthly close",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-raise-vs-manage",
    title: "Raise vs. manage",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-approving-budgets",
    title: "Approving budgets",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-tiers-and-skim",
    title: "Tiers, the covenant, and the skim",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-cross-chapter-audit",
    title: "Auditing every chapter",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-receipt-escalation-queue",
    title: "The receipt escalation queue",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-accounts-and-cards-admin",
    title: "Accounts, cards, and the City Launch Fund",
    minutes: 3,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-central-budgets",
    title: "Central budgets",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-governance-and-seats",
    title: "Governance and seats",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-launch-grants-and-transfers",
    title: "Launch grants and the skim transfer",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-budget-lifecycle",
    title: "The budget lifecycle",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "finance-one-home-per-dollar",
    title: "One home per dollar",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-worship-is-a-sacrifice",
    title: "Worship is a sacrifice",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-the-test",
    title: "The test",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-four-shapes-of-praise",
    title: "Four shapes of praise",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-the-five-drifts",
    title: "The five drifts",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-running-the-room",
    title: "Running the room",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-submitting-a-song",
    title: "Submitting a song",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-what-a-producer-does",
    title: "What a producer does",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-artist-is-a-brand",
    title: "Artist = brand",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "music-the-economics-of-a-song",
    title: "The economics of a song",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mktg-the-look",
    title: "The look",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mktg-hit-record",
    title: "HIT RECORD",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mktg-shoot-to-timeline",
    title: "From shoot to timeline",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "mktg-getting-access",
    title: "Getting access",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-giving-vocabulary",
    title: "Donors, backers, sponsors: the words we use",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-donor-crm-basics",
    title: "The donor CRM: your desk",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-relationship-workflow",
    title: "Owners, notes, and the top-donor list",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-import-and-backfill",
    title: "The canonical import: preview, classify, commit",
    minutes: 5,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-gifts-ledger-and-audit",
    title: "The gifts ledger: see it, fix it, trace it",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-backer-floor-and-ladder",
    title: "The $50 floor, and the milestone ladder",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-backer-lifecycle",
    title: "A backer's lifecycle: subscribe, pay, sometimes falter",
    minutes: 4,
    quizLength: 5,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-givebutter-migration",
    title: "The Givebutter migration: history in, recurring gifts re-signed",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-sponsor-packages",
    title: "Sponsor packages: benefits we give, commitments we keep",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-sponsorship-pipeline",
    title: "The pipeline: prospect to active partner",
    minutes: 4,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-church-partnerships",
    title: "Church partnerships: two-sided, not transactional",
    minutes: 4,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-city-launch-economics",
    title: "The 85/15 split and the City Launch Fund",
    minutes: 3,
    quizLength: 3,
    optional: false,
    capstoneKind: null,
  },
  {
    slug: "dev-prospect-cities-and-map",
    title: "Prospect territories: how a dot becomes a chapter",
    minutes: 3,
    quizLength: 4,
    optional: false,
    capstoneKind: null,
  },
];

// Course catalog: slug + themeKey + ordered moduleSlugs.
const EXPECTED_COURSES: {
  slug: string;
  themeKey: string;
  moduleSlugs: string[];
}[] = [
  {
    slug: "welcome-to-public-worship",
    themeKey: "foundations",
    moduleSlugs: ["foundations-seeds-and-soil", "foundations-chapters-and-central", "foundations-the-work", "foundations-we-pray-before-we-plan"],
  },
  {
    slug: "how-we-work",
    themeKey: "foundations",
    moduleSlugs: ["foundations-communication", "foundations-showing-up", "foundations-where-things-live", "foundations-spending", "foundations-owning-your-yes"],
  },
  {
    slug: "chapter-os-fundamentals",
    themeKey: "events",
    moduleSlugs: ["what-is-events-os", "organizers-and-crew", "anatomy-of-an-event", "timing-and-offsets", "phase-rings", "tab-debrief", "using-the-assistant"],
  },
  {
    slug: "comms-lead",
    themeKey: "events",
    moduleSlugs: ["tab-crew-duties", "tab-comms", "capstone-comms-lead"],
  },
  {
    slug: "event-lead",
    themeKey: "events",
    moduleSlugs: ["tab-tasks", "tab-run-of-show", "tab-permits", "capstone-event-lead"],
  },
  {
    slug: "logistics-lead",
    themeKey: "events",
    moduleSlugs: ["tab-supplies", "keeping-inventory", "capstone-logistics-lead"],
  },
  {
    slug: "owning-an-event",
    themeKey: "events",
    moduleSlugs: ["being-an-owner", "capstone-join-an-event", "capstone-birthday-party", "capstone-worship-event"],
  },
  {
    slug: "projects",
    themeKey: "works",
    moduleSlugs: ["works-projects", "works-driving-a-project"],
  },
  {
    slug: "leading-a-project",
    themeKey: "works",
    moduleSlugs: [
      "works-defining-a-project",
      "works-planning-the-work",
      "works-the-project-budget",
      "works-tracking-and-escalating",
      "works-finishing-well",
    ],
  },
  {
    slug: "duties",
    themeKey: "works",
    moduleSlugs: ["works-duties", "works-owning-a-duty"],
  },
  {
    slug: "the-one-on-one",
    themeKey: "management",
    moduleSlugs: ["mgmt-one-on-one", "mgmt-reviewing-the-work"],
  },
  {
    slug: "care-and-accountability",
    themeKey: "management",
    moduleSlugs: ["mgmt-caring-for-people", "mgmt-holding-the-line"],
  },
  {
    slug: "directing",
    themeKey: "management",
    moduleSlugs: ["mgmt-the-org-tree", "mgmt-director-philosophy"],
  },
  {
    slug: "the-director-standard",
    themeKey: "management",
    moduleSlugs: [
      "mgmt-ownership-not-babysitting",
      "mgmt-the-slas",
      "mgmt-the-repair-ritual",
      "mgmt-building-for-your-absence",
    ],
  },
  {
    slug: "growing-the-team",
    themeKey: "management",
    moduleSlugs: [
      "mgmt-empower-first",
      "mgmt-the-interview",
      "mgmt-the-trial",
      "mgmt-the-call",
    ],
  },
  {
    slug: "partnerships",
    themeKey: "management",
    moduleSlugs: ["mgmt-the-four-gates", "mgmt-frontline-no-final-yes"],
  },
  {
    slug: "finances-for-everyone",
    themeKey: "finances",
    moduleSlugs: ["finance-stewardship", "finance-card-and-receipts", "finance-reimbursements-and-flags"],
  },
  {
    slug: "chapter-money-model",
    themeKey: "finances",
    moduleSlugs: ["finance-tiers-and-skim", "finance-budget-lifecycle", "finance-one-home-per-dollar"],
  },
  {
    slug: "treasurer",
    themeKey: "finances",
    moduleSlugs: ["finance-reconcile-grid", "finance-chasing-receipts", "finance-monthly-close"],
  },
  {
    slug: "chapter-director",
    themeKey: "finances",
    moduleSlugs: ["finance-raise-vs-manage", "finance-approving-budgets"],
  },
  {
    slug: "financial-manager",
    themeKey: "finances",
    moduleSlugs: ["finance-cross-chapter-audit", "finance-receipt-escalation-queue", "finance-accounts-and-cards-admin"],
  },
  {
    slug: "executive-director",
    themeKey: "finances",
    moduleSlugs: ["finance-central-budgets", "finance-governance-and-seats", "finance-launch-grants-and-transfers"],
  },
  {
    slug: "doxology-what-we-sing",
    themeKey: "music",
    moduleSlugs: ["music-worship-is-a-sacrifice", "music-the-test", "music-four-shapes-of-praise", "music-the-five-drifts", "music-running-the-room"],
  },
  {
    slug: "leading-worship",
    themeKey: "music",
    moduleSlugs: ["music-submitting-a-song"],
  },
  {
    slug: "producing-and-artistry",
    themeKey: "music",
    moduleSlugs: ["music-what-a-producer-does", "music-artist-is-a-brand", "music-the-economics-of-a-song"],
  },
  {
    slug: "brand-and-voice",
    themeKey: "marketing",
    moduleSlugs: ["mktg-the-look"],
  },
  {
    slug: "media-pipeline",
    themeKey: "marketing",
    moduleSlugs: ["mktg-hit-record", "mktg-shoot-to-timeline", "mktg-getting-access"],
  },
  {
    slug: "giving-fundamentals",
    themeKey: "development",
    moduleSlugs: ["dev-giving-vocabulary", "dev-donor-crm-basics"],
  },
  {
    slug: "donor-stewardship",
    themeKey: "development",
    moduleSlugs: [
      "dev-relationship-workflow",
      "dev-import-and-backfill",
      "dev-gifts-ledger-and-audit",
    ],
  },
  {
    slug: "the-backer-model",
    themeKey: "development",
    moduleSlugs: [
      "dev-backer-floor-and-ladder",
      "dev-backer-lifecycle",
      "dev-givebutter-migration",
    ],
  },
  {
    slug: "sponsorships-and-partnerships",
    themeKey: "development",
    moduleSlugs: [
      "dev-sponsor-packages",
      "dev-sponsorship-pipeline",
      "dev-church-partnerships",
    ],
  },
  {
    slug: "the-city-launch-story",
    themeKey: "development",
    moduleSlugs: ["dev-city-launch-economics", "dev-prospect-cities-and-map"],
  },
];

describe("Academy curriculum snapshot (pre/post per-stream split)", () => {
  test("section order is unchanged", () => {
    expect(ACADEMY_SECTIONS.map((s) => s.slug)).toEqual(EXPECTED_SECTION_SLUGS);
  });

  test("per-section title/minutes/quiz length/optional/capstone kind are unchanged", () => {
    const actual = ACADEMY_SECTIONS.map((s) => ({
      slug: s.slug,
      title: s.title,
      minutes: s.minutes,
      quizLength: s.quiz.length,
      optional: s.optional === true,
      capstoneKind: s.capstone?.kind ?? null,
    }));
    expect(actual).toEqual(EXPECTED_SECTIONS);
  });

  test("course catalog slugs/themeKeys/moduleSlugs are unchanged", () => {
    const actual = ACADEMY_COURSES.map((c) => ({
      slug: c.slug,
      themeKey: c.themeKey,
      moduleSlugs: c.moduleSlugs,
    }));
    expect(actual).toEqual(EXPECTED_COURSES);
  });
});
