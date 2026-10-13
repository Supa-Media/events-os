/**
 * The Development stream (F-6) — the org's fundraising desk: the donor CRM,
 * the recurring-backer model, sponsorships & partnerships, and the
 * city-launch economics backer giving actually funds. Also the Development
 * theme + its five courses.
 *
 * Authored from the SHIPPED giving platform (`docs/plans/giving-platform.md`
 * is the design doc; the code is the source of truth where the two differ):
 * `apps/convex/givingPlatform.ts` + `schema/givingPlatform.ts` (donors, gifts,
 * the prospect/active/lapsed CRM), `apps/convex/givingPledges.ts` (recurring
 * pledges on our own Stripe rails, the derived backer count), `backerMilestones.ts`
 * (the editable ladder), `sponsorships.ts` + `schema/sponsorships.ts` (package
 * tiers + the agreement pipeline), the giving desk UI
 * (`apps/mobile/app/(app)/giving/`), and the `giving.view`/`giving.edit`
 * powers in `packages/shared/src/powers.ts`.
 *
 * The public `/give` pages (`territories` + `apps/convex/lib/givePage.ts`) are
 * the live acquisition surface; `dev-prospect-cities-and-map` teaches them as
 * recomposed by docs/plans/give-redesign-v3.md — backing a CITY is the hero,
 * giving once (central or a named city) is one tap away, the map is demoted to
 * "where we're going", the money model moved off to `/give/how-it-works` (the
 * books stay at `/finances`), and the program descriptions were merged into the
 * milestone ladder's rungs. Public copy says CITY; "territory" is an internal
 * word, taught as such in `dev-giving-vocabulary`. The public gift wall gets
 * its own lesson, `dev-public-gift-wall`, because its rule is a privacy rule
 * staff get asked about out loud: EVERY settled gift gets a row, anonymous by
 * default, and consent gates only the name/message attribution — never the
 * row's existence (v3 D6/D7/D10 + `apps/convex/givingActivity.ts` and the
 * `/giving/wall` moderation screen). It teaches them under the
 * Territories model (docs/plans/giving-territories.md): a territory maps 1:1
 * with a real chapter, so a prospect territory is a "shadow chapter" (a real,
 * inactive `chapters` row) from the moment it's created. Backers, donors, and
 * gifts scope DIRECTLY to that chapter — the old "backers stay central-held
 * until launch" model is GONE. Launch is a flag-flip (`chapters.isActive:
 * true`) that provisions banking; nobody's money moves. Likewise, a higher
 * "church backer" pledge unit (PRD Appendix C#1, ~$200–500/mo) is an open owner
 * decision, not shipped — `BACKER_UNIT_CENTS` is a single $50 floor today, so
 * this stream teaches that one floor, not a church-specific tier that doesn't
 * exist in the schema.
 *
 * The data-export feature (`packages/shared/src/dataExport.ts`,
 * `apps/convex/dataExports.ts`, `apps/mobile/app/(app)/exports.tsx`) is
 * general-purpose — it exports People, Events, Work, and Finance datasets
 * too, not just giving ones — and it has NO Academy lesson anywhere as of
 * 2026-09-01. One lived briefly in `streams/foundations.ts` as
 * `foundations-data-export`; it was removed because it rode the shared
 * `how-we-work` course onto every teammate's path to teach a power only six
 * director-level seats hold. Do not add it back to this stream on that
 * account: `development_director` is one of the six, but a lesson here would
 * reach only that one. Scope any replacement to the seats themselves.
 *
 * Owned exclusively by this file for content authoring — do not add
 * Development sections or courses anywhere else. See `../index` for how this
 * assembles into the full curriculum/catalog.
 */

import type {
  AcademySection,
  Course,
  Theme,
} from "../types";

/** The Development-stream sections, in curriculum order. */
export const DEVELOPMENT_SECTIONS: Omit<AcademySection, "order">[] = [
  // ══ Development (F-6) ═══════════════════════════════════════════════════

  // ── 85 · Giving fundamentals: the vocabulary ────────────────────────────
  {
    slug: "dev-giving-vocabulary",
    title: "Donors, backers, sponsors: the words we use",
    subtitle: "One CRM, a few kinds of giving, one mission",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Public Worship is moving all giving (one-time gifts, monthly backing, church and business partnerships) onto the Giving desk. The system and your teammates use these words exactly, so learn them first.",
      },
      {
        kind: "bullets",
        items: [
          "**Donor**: any person or org that has ever given, once or many times. Every donor gets a CRM record with identity, status, and giving history.",
          "**Gift**: one amount received with nothing of equal value given back. It can arrive through any channel (Chapter OS/Stripe, cash, check, wire, Zelle, Venmo, imported Givebutter history, in-kind).",
          "**A ticket buyer is not a donor.** A ticket buys a seat, so it's a purchase: no donor, no gift, just a contact with purchase history.",
          "**Backer**: a donor with an active recurring monthly pledge to a specific city, at or above the $50/month floor. The affordability tiers count backers (next course).",
          "**Sponsor / partner**: an organization (church, business, or foundation) attached to a sponsor package, not a personal gift.",
          "**Prospect territory**: a place raising backers toward opening a chapter. It is already a real but inactive chapter (a \"shadow chapter\"), so backers attach to it from day one.",
        ],
      },
      {
        kind: "rule",
        title: "In public it's a city, never a territory",
        text: "The desk, the schema, and this Academy say *territory*: a record with a slug, a map dot, and a shadow chapter. Donors never see that word. Everything they read or hear (\"Back a city\", the city cards, emails, your ask) says **city**.",
      },
      {
        kind: "rule",
        title: "Missional giving, not a substitute for a tithe",
        text: "A backer's monthly gift funds the mission (chapters, events, the next city), not a congregation's budget. It sits alongside what they give at their own church, never instead of it. Never frame backing as \"your tithe, just routed here.\"",
      },
      {
        kind: "reveal",
        prompt:
          "A potential backer asks, \"Isn't this basically my tithe, just to Public Worship instead of my church?\" What do you tell them?",
        answer:
          "No. A tithe supports their home church's life and ministry. Backing funds a specific missional work: a chapter, an event series, the next city. Invite them to do both, not to swap one for the other.",
      },
    ],
    quiz: [
      {
        prompt: "What's the difference between a \"donor\" and a \"backer\"?",
        options: [
          "They're the same thing, just different names",
          "Every backer is a donor, but a donor only becomes a backer once they have an active recurring pledge at or above the $50/month floor",
          "A backer only gives once; a donor gives repeatedly",
          "A backer is always an organization; a donor is always a person",
        ],
        answerIndex: 1,
        explanation:
          "Donor is the broad CRM record: anyone who has ever given. Backer is the recurring-pledge subset the affordability tiers count.",
      },
      {
        prompt: "What counts as one \"gift\" in the system, and what doesn't?",
        options: [
          "Only Stripe payments count",
          "Only recurring monthly pledges count",
          "Any mission giving with nothing given back, through any channel, counts; a ticket purchase does not, because the buyer got a seat in return",
          "Only donations made through an RSVP page count",
        ],
        answerIndex: 2,
        explanation:
          "\"Gift\" is broad on channel (Chapter OS, cash, check, wire, Zelle, Venmo, Givebutter, in-kind) but narrow on kind: nothing of equal value came back. A ticket sale fails that test.",
      },
      {
        prompt: "What is a \"prospect territory\"?",
        options: [
          "A chapter that's behind on its budget",
          "A place raising backers toward opening a chapter, backed by a real but inactive \"shadow chapter\" from day one",
          "A place Public Worship has decided never to launch",
          "Any place with at least one donor",
        ],
        answerIndex: 1,
        explanation:
          "A prospect territory maps 1:1 to a real chapter that isn't live yet, so backers attach to it before it opens.",
      },
      {
        prompt: "How should you frame backing Public Worship to someone who already tithes at their own church?",
        options: [
          "As a replacement for their tithe: one gift instead of two",
          "As a separate, missional gift alongside whatever they already give at their own church",
          "Don't mention their church giving at all",
          "Tell them to reduce their tithe to afford backing",
        ],
        answerIndex: 1,
        explanation:
          "Backing funds a specific mission, not a congregation's operating budget. The ask is \"in addition to,\" never \"instead of.\"",
      },
      {
        prompt: "You're writing the copy for a public post asking people to support Columbus. Which word do you use for Columbus?",
        options: [
          "\"Territory\": it's the precise term, so it's the honest one",
          "\"City\": territory is our internal word for the record; the public ask always says city",
          "\"Shadow chapter,\" so nobody thinks it's already open",
          "Either; the two are used interchangeably in public",
        ],
        answerIndex: 1,
        explanation:
          "\"Territory\" names the record (slug, map dot, shadow chapter) and stays on the desk. Every public surface (\"Back a city\", the city cards, your ask) says city.",
      },
    ],
  },

  // ── 86 · Giving fundamentals: the donor CRM ─────────────────────────────
  {
    slug: "dev-donor-crm-basics",
    title: "The donor CRM: your desk",
    subtitle: "Prospect, active, lapsed, and where the story lives",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The Giving desk's Dashboard opens to what your reach covers. A chapter viewer (chapter director or treasurer) sees four numbers for their chapter: lifetime giving, last-30-days giving, total donors, and lapsed donors. Below them sit the top donors by lifetime giving.",
      },
      {
        kind: "p",
        text: "A central holder (development director or ED) opens to the org-wide fleet: summed rollups, a card for Central and each chapter, and a \"needs your attention\" rail. The rail flags chapters with lapsed donors or backers below their territory goal. Tap a card to work that chapter, then step back out. The Donors list adds a scope dropdown: All chapters (one lifetime-sorted list, rows tagged), Central, or one chapter. Chapter viewers see neither.",
      },
      {
        kind: "table",
        headers: ["Status", "What it means"],
        rows: [
          ["Prospect", "No gift yet (giftCount is zero)"],
          ["Active", "A gift landed within the last 90 days"],
          ["Lapsed", "Has given before, but not in the last 90 days: the reactivation queue"],
        ],
      },
      {
        kind: "rule",
        title: "Status is derived, never hand-set",
        text: "Nobody picks a status from a dropdown. It's recomputed from lastGiftAt each time a gift is recorded. Go 90 days without a gift and a donor becomes lapsed.",
      },
      {
        kind: "tip",
        text: "**Donors show on the People tab too.** A chapter donor who has given (giftCount > 0) gets a heart, plus a building icon if they're an active backer. Icons only, never amounts; tap one for the giving record. A donor with no roster match gets a minimal contact row under the Contacts filter, not the default Team segment. Fix a wrong link from the donor screen with \"Link to person\", \"Change\", or \"Unlink\" (Manage power). Central donors are CRM-only and never link to a roster person.",
      },
      {
        kind: "rule",
        title: "Who can open the Giving desk is a per-role power",
        text: "The Executive Director assigns giving access per seat, in its Powers tab. Choose See donors & giving (donors, history, dashboards), Manage donors & gifts (also record gifts, edit donors, import), or neither. By default the Development Director and ED Manage. The Development associates (Partnership & Fundraising), Financial Manager, and Expansion Director View central; the Chapter Director and Treasurer View their own chapter. Can't see the desk? Ask for the power.",
      },
      {
        kind: "reveal",
        prompt:
          "A donor's last gift landed 91 days ago. What does their CRM record show, and what should you do about it?",
        answer:
          "Lapsed: the reactivation queue at work. Find them and make a personal reach-out.",
      },
    ],
    quiz: [
      {
        prompt: "What sets a donor's status to \"lapsed\"?",
        options: [
          "A staff member marks them lapsed manually",
          "No gift in the last 90 days, recomputed automatically from their last gift date",
          "They ask to be removed from the list",
          "A full calendar year with no gift",
        ],
        answerIndex: 1,
        explanation:
          "The 90-day window is the rule, and it's derived. Nobody types a status into a donor's record.",
      },
      {
        prompt: "What does the Dashboard's \"top donors\" list show?",
        options: [
          "The most recent gifts, newest first",
          "Donors ordered by lifetime giving, highest first",
          "A random sample for variety",
          "Only backers, never one-time donors",
        ],
        answerIndex: 1,
        explanation:
          "Lifetime order is deliberate: it's the ordering the \"who are our top 5 donors\" relationship workflow needs.",
      },
      {
        prompt: "A donor who's given zero gifts so far shows what status?",
        options: ["Active", "Lapsed", "Prospect", "No status until their first gift"],
        answerIndex: 2,
        explanation:
          "Prospect means \"on our radar, hasn't given yet\": the starting point before a first gift.",
      },
      {
        prompt: "What four rollup numbers does the Dashboard show at the top?",
        options: [
          "Lifetime giving, last 30 days, donor count, lapsed count",
          "Only lifetime giving",
          "This month's budget vs. actual",
          "A list of every gift ever given",
        ],
        answerIndex: 0,
        explanation:
          "Those four stats are the at-a-glance read. Top donors and full history are one tap deeper.",
      },
      {
        prompt: "Who decides which roles can open the Giving desk?",
        options: [
          "It's hardcoded to the Development Director and can never change",
          "The Executive Director: giving access is a per-seat power (see, or manage) assigned from the org chart",
          "Every signed-in member can always see it",
          "Only a superuser, by editing the database directly",
        ],
        answerIndex: 1,
        explanation:
          "Giving access is a power on each org-chart seat, not a fixed title. The ED gives a seat see or manage access, or neither, and can change it any time.",
      },
    ],
  },

  // ── 87 · Donor stewardship: the relationship workflow ───────────────────
  {
    slug: "dev-relationship-workflow",
    title: "Owners, notes, and the top-donor list",
    subtitle: "Every donor gets an owner and a personal thank-you",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "A donor's detail screen holds identity, status, an owner, gift history (newest first), any active pledge, sponsorship links, and notes. The **owner** is the relationship point person, a real roster person others can ask. **Notes** hold the story (how you met, what they care about, what they said last time) that makes a thank-you personal.",
      },
      {
        kind: "rule",
        title: "Sorted by lifetime, on purpose",
        text: "The donor list puts the highest lifetime giving first. A major gift from years ago still puts someone at the top, because that relationship is worth protecting.",
      },
      {
        kind: "scenario",
        prompt:
          "A donor you've never spoken to just gave $2,000 out of nowhere. What's the right next move?",
        options: [
          {
            text: "Nothing. The gift is already recorded, and that's the important part",
            feedback:
              "Recording the gift is half the job. A gift this size with no relationship behind it needs an owner and a personal reach-out.",
          },
          {
            text: "Assign yourself (or someone) as owner, and send a genuine personal thank-you",
            correct: true,
            feedback:
              "Right. A first major gift starts a relationship. Claim the owner field and make the thank-you real.",
          },
          {
            text: "Wait to see if they give again before doing anything",
            feedback:
              "Waiting lets the relationship go cold when it's warmest. Reach out while the gift is fresh.",
          },
          {
            text: "Add them straight to the sponsorship pipeline",
            feedback:
              "Sponsorships are for organizations (church, business, foundation), not individual donors.",
          },
        ],
      },
      {
        kind: "rule",
        title: "Bulk email goes out through Mailchimp",
        text: "Newsletters and announcements go out from Mailchimp. The in-app Emails desk is parked and hidden; don't start sends there. Each night the app pushes the roster to the Mailchimp audience, tagged with chapter, backer standing, and role. A Mailchimp unsubscribe flows back and silences every other email, event blasts included. People opted out of marketing here, or on the suppression list, never reach Mailchimp.",
      },
      {
        kind: "rule",
        title: "The approval habit survives the tool change",
        text: "A bulk email reaches many people, so a second person reads it first. The Emails desk enforced this: the writer chose a reviewer from the Compose/Approve holders, never themselves, even the Executive Director. Mailchimp doesn't, so it's a habit now. Another Compose/Approve holder reads every Mailchimp send, the same separation of duties as reimbursements, budgets, and card spend.",
      },
      {
        kind: "rule",
        title: "Emails-desk power comes in three rungs",
        text: "The ED assigns it per seat. **Design** owns templates and the image library but never sends. **Compose** adds drafting, submitting, and sending once approved. **Approve** adds reviewing others' emails. Each rung includes those below. Defaults: the ED, Financial Manager, and Marketing Director hold Approve; the Graphic Designer and Social Media Manager hold Design.",
      },
      {
        kind: "rule",
        title: "A segment is rule groups, exclusions, and hand-picks",
        text: "A person is in if every line of any one rule group is true. Lines can be negated (\"has never been to\"); another group widens the segment. Exclusions remove anyone they match, even a hand-pick. Segments are live, re-checked on each use. Hand-picks never override consent: unsubscribed (suppressed) and marketing-opted-out people are always dropped, and the preview shows who and why.",
      },
    ],
    quiz: [
      {
        prompt: "What does a donor's \"owner\" field represent?",
        options: [
          "Whoever created the donor record in the system",
          "The relationship point person for that donor: a real roster person others can ask",
          "The donor's own account holder",
          "The chapter that donor belongs to",
        ],
        answerIndex: 1,
        explanation:
          "Owner is accountability for the relationship, not an audit field. It answers \"who do I ask about this donor?\"",
      },
      {
        prompt: "Why does the donor list sort by lifetime giving instead of most-recent gift?",
        options: [
          "It's the only sort option available",
          "So a major donor from years ago still surfaces at the top, protecting the relationship rather than the latest transaction",
          "Recent gifts are hidden from the list entirely",
          "Lifetime sorting is faster to compute",
        ],
        answerIndex: 1,
        explanation:
          "The \"top donors\" ordering serves the relationship workflow: who matters most over time, not who gave most recently.",
      },
      {
        prompt:
          "Someone clicks unsubscribe in a Mailchimp newsletter. What happens to the event blast going out next week?",
        options: [
          "Nothing; Mailchimp and the app keep separate lists",
          "They're dropped from it too: a Mailchimp unsubscribe writes to the app's suppression list, which every send here reads",
          "They're dropped only if an admin manually copies the unsubscribe over",
          "The blast is blocked entirely until someone reviews the unsubscribe",
        ],
        answerIndex: 1,
        explanation:
          "A Mailchimp unsubscribe lands in the same deployment-wide suppression ledger that event blasts, campaigns, and every other send read. One 'stop' means stop everywhere.",
      },
      {
        prompt: "The Executive Director writes a mass email. Who can approve it before it sends?",
        options: [
          "The ED themselves, since they hold Compose/Approve power",
          "A DIFFERENT person the ED picks as reviewer (e.g. the Marketing Director), never themselves",
          "Nobody; the ED can never send a mass email",
          "Any signed-in member, automatically",
        ],
        answerIndex: 1,
        explanation:
          "Two-party approval means every email needs a different Compose/Approve holder's sign-off. The ED's own sends need someone else's approval too.",
      },
      {
        prompt:
          "You hand-pick someone into an email's segment, but they've unsubscribed from everything we send. What happens?",
        options: [
          "They're excluded: a hand-pick is not consent, and suppression always wins",
          "They're included, because hand-picking always overrides suppression",
          "The email can't be saved until you remove them",
          "They receive the email, but marked as a bounce afterward",
        ],
        answerIndex: 0,
        explanation:
          "Suppression and a person's marketing opt-out beat both rules and hand-picks. Adding someone to the include list is curation, not consent, and the preview shows who was dropped and why.",
      },
    ],
  },

  // ── 88 · Donor stewardship: the canonical import ────────────────────────
  {
    slug: "dev-import-and-backfill",
    title: "The canonical import: preview, classify, commit",
    subtitle: "One paste, four row types, and the line between a donor and a ticket buyer",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Most giving history lives in Givebutter. One import flow covers every bulk onboarding case; manual gift entry on a donor's detail screen covers one-offs. The paste box recognizes a Givebutter TRANSACTIONS export and asks you to map each campaign to gift, ticket, or skip. Each row then has a rowType:",
      },
      {
        kind: "bullets",
        items: [
          "**gift**: mission giving. Matches or creates a donor, then adds a gift.",
          "**ticket**: a ticket buyer's history, never a donor or gift. Matches or creates a chapter contact, linked to the real event when possible.",
          "**contact**: a roster person with nothing financial attached.",
          "**recurring**: a monthly pledge whose card lives on another platform, so it can't be auto-ported. It lands \"awaiting re-signup\" (see the backer-model course).",
        ],
      },
      {
        kind: "rule",
        title: "Why classification is the whole point",
        text: "Givebutter mixes ticket sales and mission giving in one export. Imported naively, every ticket buyer becomes a fake donor, so only `gift` and `recurring` rows create donors. Every import is PREVIEW (read-only: each row's disposition, plus the gift vs. ticket row count), then COMMIT. A lopsided split means a wrong rowType column, caught before any donor is touched.",
      },
      {
        kind: "table",
        headers: ["Situation", "What the preview shows"],
        rows: [
          ["A brand-new gift with a transaction id", "new"],
          ["The same transaction id already imported", "duplicate (skipped automatically)"],
          [
            "Same donor, same amount, within 24h of an existing gift, no transaction id",
            "suspected-duplicate (skipped unless you explicitly include it)",
          ],
          ["A ticket buyer whose purchase matches a real event", "matched-order"],
          ["A ticket buyer with no matching event/order", "history-only (still just a contact)"],
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You accidentally run the same import file through commit twice. What happens?",
        answer:
          "Nothing bad. Gifts dedupe on transaction id (when present), recurring pledges within their donor, and contact or ticket rows re-match the same person. Retrying is safe.",
      },
      {
        kind: "rule",
        title: "Keep the data clean: dedupe first, and no name-only rows",
        text: "A contact or ticket row with no email and no phone creates nothing (\"no-identifier\" in the preview). Names collide, so it's a guest, not a roster person. Before re-running an import, merge known duplicates (People → Duplicates, or the donor duplicates). Merging re-points everything onto one survivor and recomputes totals.",
      },
      {
        kind: "p",
        text: "Two imports stay separate. People → Import takes a Givebutter CONTACTS export: every row becomes a contact (matched by email, phone, or exact name), never a donor, and it needs no giving access. An event's Grow → Import attendance only builds that event's guest list, never a donor. Imported contacts start reachable; later unsubscribes are honored by our suppression list.",
      },
      {
        kind: "scenario",
        prompt:
          "You paste in a Givebutter export and the preview summary shows 40 ticket rows and only 3 gift rows, but you were expecting mostly mission gifts. What's the right move?",
        options: [
          {
            text: "Commit anyway; the numbers will sort themselves out",
            feedback:
              "The gift/ticket split exists to catch this before commit. Committing blind imports the wrong thing as the wrong thing.",
          },
          {
            text: "Stop, check the source file's rowType column, and re-paste with it fixed before committing anything",
            correct: true,
            feedback:
              "Right. A split like this usually means misclassified rows (a ticket-sales file pasted in as giving). Preview is free; use it.",
          },
          {
            text: "Manually delete the 3 gift rows so only tickets import",
            feedback:
              "That throws away real data instead of fixing the rowType column upstream.",
          },
          {
            text: "Include the suspected duplicates to make the gift count look right",
            feedback:
              "Suspected duplicates and a rowType mismatch are unrelated. That toggle doesn't fix a misclassified export.",
          },
        ],
      },
    ],
    quiz: [
      {
        prompt: "What determines whether an imported row creates a donor, or just a contact?",
        options: [
          "The dollar amount on the row",
          "Its rowType: only `gift` and `recurring` ever create a donor; `ticket` always becomes a contact, never a donor",
          "Whichever the importer guesses is more likely",
          "All rows create a donor by default",
        ],
        answerIndex: 1,
        explanation:
          "Classification is the rule, not amount or guesswork. A ticket buyer got something of equal value back (a seat), so that row can never become a gift.",
      },
      {
        prompt: "What happens BEFORE any import can write data?",
        options: [
          "Nothing; commit runs immediately",
          "A read-only preview: a disposition per row, plus a summary with the gift/ticket row-count split",
          "An email confirmation to the donor",
          "A manual finance sign-off",
        ],
        answerIndex: 1,
        explanation:
          "Preview-then-commit is the safety model. The split in the summary catches a misclassified export before it pollutes the CRM.",
      },
      {
        prompt: "A gift row has no transaction id, but matches an existing donor's amount and date within 24 hours. What's its disposition, and what happens on commit?",
        options: [
          "\"new\": it always imports",
          "\"suspected-duplicate\": skipped on commit unless explicitly included",
          "\"invalid\": the row is rejected outright",
          "It's silently merged into the existing gift",
        ],
        answerIndex: 1,
        explanation:
          "With no transaction id to trust, the same-amount, 24-hour check flags a likely double entry for a person to confirm instead of blocking it or importing it blind.",
      },
      {
        prompt: "What does a `recurring` import row create?",
        options: [
          "An active Stripe subscription immediately",
          "A donor (match-or-create) plus a pledge in the same \"awaiting re-signup\" past_due state the backer-model course teaches; it does not count as a backer yet",
          "A one-time gift only",
          "Nothing; recurring rows aren't supported",
        ],
        answerIndex: 1,
        explanation:
          "The pledge is real, but it isn't collecting on our rails until the donor re-signs up.",
      },
      {
        prompt: "An import row for a person has a name but no email and no phone. What happens?",
        options: [
          "A roster contact is created from the name alone",
          "Nothing is created. It's reported as \"no-identifier\", because a name-only record is a guest, not a roster person",
          "The whole import is rejected",
          "It's imported as a donor instead",
        ],
        answerIndex: 1,
        explanation:
          "A row needs an email or a phone to create a roster person, because names collide. Merge known duplicates (People → Duplicates, or the donor duplicates tool) before re-running an import, so it matches the one real record.",
      },
    ],
  },

  // ── 88.5 · Donor stewardship: the gifts ledger, editing & merge ─────────
  {
    slug: "dev-gifts-ledger-and-audit",
    title: "The gifts ledger: see it, fix it, trace it",
    subtitle: "Every gift as it lands: edit, move books, merge, all on the record",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The Gifts tab lists every gift in your book, newest first, for watching donations arrive and cleaning up history. Central holders can switch to \"All chapters\", each row tagged by book. Search filters by donor, note, or source.",
      },
      {
        kind: "bullets",
        items: [
          "**Add gift**: record a gift the rails never saw (a wire, Zelle, Cash App, a purchase for the org), with past dates, any source, and receipts. A central manager also picks the book.",
          "**Edit**: fix an amount, date, source, or note. Donor lifetime totals and book rollups re-derive; nobody hand-edits a total.",
          "**Reassign donor**: move one gift to the right donor in the same book.",
          "**Move book**: a central manager moves a whole gift between books (central or chapter). Its donor is matched or created in the destination, and both books' totals net exactly.",
          "**Split**: a central manager splits one gift across books, e.g. one wire between Central and New York. Parts must sum to the original; each becomes a gift for the same donor in its book, keeping date, source, and receipts.",
          "**Remove**: delete a gift that shouldn't exist (an $820 \"donation\" that was a ticket-sale payout, a stray ticket purchase). It reverses the donor's and book's totals, so the desk asks why first.",
        ],
      },
      {
        kind: "rule",
        title: "Every change leaves a breadcrumb, and removing one asks why",
        text: "Every add, edit, reassignment, book move, and split writes an audit line: who, when, old and new values, and a why (optional on edits, required on removals). A removal keeps a snapshot (donor, amount, date, book, source), so the trail outlives the gift. Gifts whose money their source owns (event donations, Stripe billing cycles, matched bank credits) are protected: only note and receipts can change.",
      },
      {
        kind: "reveal",
        prompt:
          "One chapter has \"Jon Smith\" and \"Jonathan Smith\", each with real gifts. What's the fix? And what if it were one gift on the wrong donor?",
        answer:
          "Merge the two donors from Donors → Duplicates: take an auto-detected group, or use \"Pick two to merge\". The survivor gets every gift, pledge, and sponsorship, and its lifetime total is recomputed. For one misfiled gift, don't merge; reassign that gift from the ledger.",
      },
    ],
    quiz: [
      {
        prompt: "What is the Gifts tab?",
        options: [
          "A place to configure Stripe billing",
          "A newest-first feed of every gift in the book, or for a central holder, every book at once with each row tagged",
          "The same thing as the donor list, sorted by lifetime",
          "A list of only the gifts you personally recorded",
        ],
        answerIndex: 1,
        explanation:
          "It's the feed for watching donations arrive, and where cleanup happens: edit, reassign, move, and add all start there.",
      },
      {
        prompt: "You edit a gift's amount from $50 to $80. What happens to the donor's lifetime total and the book's rollups?",
        options: [
          "You must also edit the donor's lifetime by hand to match",
          "They re-derive automatically; a rollup is never hand-edited",
          "Nothing; rollups only update on brand-new gifts",
          "The old gift is deleted and a new one created, churning the history",
        ],
        answerIndex: 1,
        explanation:
          "The edit moves the donor total and the book rollup by exactly the difference, once each, and the audit records $50.00 to $80.00.",
      },
      {
        prompt: "What does every add, edit, reassignment, or book-move to a gift leave behind?",
        options: [
          "Nothing; changes are silent",
          "An audit breadcrumb: who changed it, when, the old and new values, and an optional why",
          "An email to the donor",
          "A pending approval a director must sign off",
        ],
        answerIndex: 1,
        explanation:
          "Open any gift to read its full change history.",
      },
      {
        prompt: "Who can move a gift from one book to another, and what happens to the two books' totals?",
        options: [
          "Anyone with view access; the totals are left for finance to reconcile later",
          "A central manager; the donor is matched-or-created in the destination and both books' totals net exactly",
          "Only a superuser, and the gift's amount resets to zero",
          "Nobody; a gift can never change books",
        ],
        answerIndex: 1,
        explanation:
          "Moving a gift across books is a central-manage action. The source book loses exactly the gift, the destination gains it, and its donor is matched or created there. Splitting uses the same power, and the parts must sum to the original.",
      },
      {
        prompt: "Why does removing a gift make you type a reason first?",
        options: [
          "It doesn't; a gift is deleted the instant you tap Remove",
          "Because removing reverses the donor's and the book's totals, so the reason and a snapshot of the deleted gift are kept on the record",
          "To email the donor an apology automatically",
          "Only superusers are ever allowed to remove a gift",
        ],
        answerIndex: 1,
        explanation:
          "Removals are real (an $820 payout mistaken for a gift, a stray ticket purchase). The required why and a snapshot (donor, amount, date, book, source) keep the trail readable after the gift is gone.",
      },
    ],
  },

  // ── 88b · The public gift wall: what a giver's gift says out loud ────────
  {
    slug: "dev-public-gift-wall",
    title: "The public gift wall: anonymous by default",
    subtitle: "Consent gates the name, never the gift, and how a takedown works",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every giving page carries a **wall**: the gifts that have landed, newest first. A gift appears there whether or not the giver told us anything.",
      },
      {
        kind: "rule",
        title: "Consent gates ATTRIBUTION, never EXISTENCE",
        text: "Every gift given through a give page gets a row, anonymous by default: **\"A gift to New York · $50\"**. A name and message show only where the giver said yes. Consent decides whether the NAME appears, never whether the gift does. Desk-entered gifts (a check, a wire, an import) move the live total but get no row. **The books at `/finances` are the complete record**.",
      },
      {
        kind: "bullets",
        items: [
          "**Settled only.** Abandoned checkouts never appear; a failed or returned payment loses its row.",
          "**Central gifts appear too**, tagged as central operations.",
          "**Coarse time only**: \"two days ago\", never a timestamp, and no payment method, email, reference number, or exact order.",
          "**Tiny cities go unnamed.** With barely any lifetime giving, one gift plus a city name could identify the giver, so the label is suppressed.",
          "**The total is live**: give, refresh, and it moves. The books at `/finances` are frozen, reviewed, and published month by month.",
        ],
      },
      {
        kind: "rule",
        title: "A city page can be found by search, so the promise has to match the copy",
        text: "City pages are indexed. Being shown isn't being findable by name forever, so only consent under the current copy (public and searchable) puts a name on an indexed page. Earlier consenters still appear and count, anonymously.",
      },
      {
        kind: "tip",
        text: "**In the app · Giving → Wall.** Every entry, newest first: its page, whether consent was recorded, and any takedown (who, when). **Take down** and **Restore** are central `giving.manage` actions.",
      },
      {
        kind: "reveal",
        prompt:
          "A donor emails: \"I've just seen my name and my $500 on your website. Please take it off.\" What do you do, and what happens to the gift?",
        answer:
          "Take the row down from Giving → Wall (central `giving.manage`, logged with your name and time) and tell them. The gift, lifetime total, book rollups, and receipt are untouched. The city total doesn't drop, because it sums the book's rollups, not the rows. Don't delete the gift from the ledger. Read the recorded consent before promising anything.",
      },
    ],
    quiz: [
      {
        prompt: "Someone gives $50 to New York and doesn't fill in a name or tick anything. What appears on the public wall?",
        options: [
          "Nothing; the wall only shows givers who opted in",
          "An anonymous row: a $50 gift to New York, no name and no message",
          "Their name from the donor CRM, with the amount",
          "The gift, but visible only to signed-in staff",
        ],
        answerIndex: 1,
        explanation:
          "Every gift given through the page gets a row, anonymous by default. Consent only decides whether a name is attached.",
      },
      {
        prompt: "What does a giver's consent control?",
        options: [
          "Whether their gift appears on the wall at all",
          "Whether their name and message appear beside it; the gift and its amount are on the wall either way",
          "Whether the gift counts toward the city's total",
          "Whether we're allowed to email them again",
        ],
        answerIndex: 1,
        explanation:
          "Consent gates attribution, never existence. It answers \"does their name show?\" and nothing else.",
      },
      {
        prompt: "A donor writes in asking to come off the wall. What's the move, and what happens to their gift?",
        options: [
          "Ask a developer to delete the row",
          "Take it down from Giving → Wall (central `giving.manage`, logged) and leave the gift, the lifetime total, and the book's rollups untouched",
          "Remove the gift from the ledger so there's nothing left to publish",
          "Nothing can be done; a published row is permanent",
        ],
        answerIndex: 1,
        explanation:
          "The takedown touches only the public row. Deleting the gift would solve a publishing problem with an accounting act, and the page total wouldn't move anyway: it's summed from the book's rollups, not the rows.",
      },
      {
        prompt: "Why do some gifts whose givers DID agree to be shown still render anonymously on a city page?",
        options: [
          "A bug in the wall",
          "They agreed under older copy that never said the page could be found by search; only consent under the newer wording puts a name on an indexed page",
          "Their gifts are too old to display",
          "Their names couldn't be verified",
        ],
        answerIndex: 1,
        explanation:
          "Agreeing to be shown isn't agreeing to be findable by name forever. Those givers keep the promise they were made: they appear and count, anonymously.",
      },
    ],
  },

  // ── 89 · The backer model: the $50 floor and the ladder ─────────────────
  {
    slug: "dev-backer-floor-and-ladder",
    title: "The $50 floor, and the milestone ladder",
    subtitle: "What makes a donor a backer, and what backers unlock",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "A pledge can start at $20/month, but only $50/month or more makes its donor a BACKER. Below that floor they're a valued recurring giver who doesn't count toward a chapter's tier.",
      },
      {
        kind: "table",
        headers: ["Backers", "Unlocks"],
        rows: [
          ["20", "Worship With Strangers (WWS), monthly"],
          ["30", "+ Eden"],
          ["50", "+ Love Thy Neighbor (LTN)"],
        ],
      },
      {
        kind: "rule",
        title: "The ladder is a promise, editable at the development director's discretion",
        text: "The thresholds live in an editable table, not in code. The development director can relabel a rung, change its threshold, or rewrite its commitment. If the table is empty, the system falls back to the built-in defaults, so nothing breaks.",
      },
      {
        kind: "bullets",
        items: [
          "**Headcount, not dollars.** A chapter's tier depends on how many backers it has, not how much they give. The finance side teaches the same principle for the operating model.",
          "**Public, and it is the program list.** Every rung shows on the city's `/give/<slug>` page with progress, like \"17 of 20 backers — 3 more unlocks monthly WWS\". Each rung describes what it unlocks, because the page has no separate program list. A wrong blurb is a wrong promise.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A donor pledges $20/month to a chapter. Do they count toward that chapter's backer milestones?",
        answer:
          "No. They're a valued donor with an active pledge, but the backer count only includes pledges at or above the $50 floor. Their gift still lands in giving history each month; it just doesn't move the tier. A PAUSED pledge (next lesson) also stays in the backers list but leaves the count until it resumes.",
      },
    ],
    quiz: [
      {
        prompt: "What's the minimum monthly pledge amount that makes someone a BACKER?",
        options: ["$20", "$50", "$100", "There is no minimum"],
        answerIndex: 1,
        explanation:
          "$50/month is the floor. Pledges below it are real recurring gifts that don't count as backers.",
      },
      {
        prompt: "Who can edit the milestone ladder's thresholds and labels?",
        options: [
          "Nobody; the numbers are fixed in code forever",
          "The development director, at their discretion",
          "Any donor can vote on changes",
          "Only a superuser, and only once",
        ],
        answerIndex: 1,
        explanation:
          "The ladder is editable by design, so the development director can tune it as the mission's needs change.",
      },
      {
        prompt: "What happens to the affordability model if the editable ladder table is empty?",
        options: [
          "The finance dashboard breaks",
          "It silently falls back to the built-in default tiers (20/30/50), so nothing breaks from an unconfigured ladder",
          "Every chapter is treated as tier zero",
          "The app refuses to load",
        ],
        answerIndex: 1,
        explanation:
          "The fallback is deliberate: an empty table never breaks the affordability math finance relies on.",
      },
      {
        prompt: "What does a chapter's tier get set by?",
        options: [
          "Total dollars pledged per month",
          "Backer headcount: how many people, not how much money",
          "How many events the chapter has run",
          "How long the chapter has existed",
        ],
        answerIndex: 1,
        explanation:
          "Headcount, not dollars, drives the tier, the same principle the finance side teaches.",
      },
      {
        prompt: "A notification rule tells the team about gifts of $500 and up. Someone starts a $50/month pledge. Does the team hear about it?",
        options: [
          "No; $50 is well under the $500 threshold",
          "Yes. A signup is judged by its ANNUAL value ($600), because a backer is a big gift arriving twelve payments at a time",
          "Only if someone on the desk records it manually",
          "Only in the weekly digest, never right away",
        ],
        answerIndex: 1,
        explanation:
          "Judged by the monthly charge, a new backer would slip under every threshold while a one-off $500 cheque rang the bell. The notification prints both figures ($50/month and $600 a year), so nobody mistakes the annual number for money in the bank.",
      },
    ],
  },

  // ── 90 · The backer model: lifecycle and self-serve billing ─────────────
  {
    slug: "dev-backer-lifecycle",
    title: "A backer's lifecycle: subscribe, pay, sometimes falter",
    subtitle: "incomplete → active → past_due → canceled (+ a manual pause), and who does what",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Backing runs on our own Stripe rails, not Givebutter's. A backer has a real recurring subscription, and Stripe events drive every status except paused. Backers change their card, amount, or cancel through a Stripe billing-portal link; we never store card numbers. Asked to update a card? Send the portal link.",
      },
      {
        kind: "table",
        headers: ["Status", "What it means"],
        rows: [
          ["Incomplete", "Pledge created, checkout not finished yet"],
          ["Active", "Subscription is live and paying"],
          ["Past due", "A billing cycle's payment failed; Stripe is retrying automatically"],
          ["Canceled", "The subscription ended, by the donor or by Stripe giving up on retries"],
          ["Paused", "A MANUAL hold the desk sets. The pledge stays in the backers list (history preserved) but is left OUT of the count until it's resumed"],
        ],
      },
      {
        kind: "rule",
        title: "Each paid cycle is a gift, automatically",
        text: "Each month a subscription charges, one gift row lands in the donor's giving history, with no manual entry. A chapter's backer count recomputes the instant any pledge's status or amount changes.",
      },
      {
        kind: "rule",
        title: "The moment someone becomes a backer, two emails go out",
        text: "**The backer gets a welcome** naming what monthly giving makes possible. It replaces the first cycle's receipt; later cycles get the ordinary receipt. **The giving desk gets a notification** through the gift notification rules. Each fires once per backer, whichever Stripe event lands first, so a redelivered webhook never thanks anyone twice. Under the $50 floor the welcome says \"monthly giver\", not \"backer\", because that person isn't in the public backer count.",
      },
      {
        kind: "rule",
        title: "A new backer counts as a BIG gift, at their annual value",
        text: "Notification thresholds judge a signup by its yearly commitment. A $50/month backer is a $600 decision, so they clear a \"$500 and up\" rule their first $50 charge wouldn't. The emails print both figures. Digests list new backers in their own section, outside the money total, because a commitment isn't money that arrived.",
      },
      {
        kind: "rule",
        title: "Pause is manual; the rest is Stripe",
        text: "The desk sets paused by hand when a backer asks for a break. It's sticky: a Stripe re-sync won't flip it back to active. A paused pledge leaves the tier count but stays in the backers list with its timeline. The desk can also correct a pledge's \"Since\" date or delete it. Each change is logged with who and why.",
      },
      {
        kind: "reveal",
        prompt:
          "A backer's card is declined on their monthly charge. What do you, on the development team, need to do?",
        answer:
          "Nothing at first. Stripe Smart Retries handle the dunning, and a successful retry returns the pledge to active. If the subscription is eventually canceled, the backer count updates itself.",
      },
    ],
    quiz: [
      {
        prompt: "What moves a pledge to \"past_due\"?",
        options: [
          "The Treasurer marking it manually",
          "A billing cycle's payment failing; Stripe's automatic retries then try to recover it",
          "The backer requesting a pause",
          "90 days with no activity",
        ],
        answerIndex: 1,
        explanation:
          "Past_due is Stripe-driven: a failed charge, not a person's decision. Pausing is a separate manual state (\"paused\").",
      },
      {
        prompt: "Who chases a backer's failed payment?",
        options: [
          "The chapter director calls them personally every time",
          "Nobody has to; Stripe Smart Retries handles the dunning automatically",
          "The Financial Manager sends a manual invoice",
          "Failed payments are written off",
        ],
        answerIndex: 1,
        explanation:
          "Like the finance side's card locks, the system does the routine chasing so people can spend their time on relationships.",
      },
      {
        prompt: "How does a backer update their card or change their pledge amount?",
        options: [
          "They email their card number to the development team",
          "Through a self-serve Stripe billing-portal link; we never store card data or build our own UI for it",
          "They have to cancel and create a brand-new pledge",
          "Only a superuser can make that change",
        ],
        answerIndex: 1,
        explanation:
          "Stripe's portal means no card data ever touches our systems.",
      },
      {
        prompt: "When does a paid billing cycle show up in a donor's giving history?",
        options: [
          "Never; recurring giving isn't tracked as gifts",
          "Automatically: one gift row is written for every successful cycle, the moment it's paid",
          "Only if someone manually records it afterward",
          "Once a year, in a batch",
        ],
        answerIndex: 1,
        explanation:
          "Recurring giving lands in the CRM like any other gift, without anyone typing it in.",
      },
      {
        prompt: "A backer asks to take a break, so you PAUSE their pledge. What happens to the chapter's backer count and the backers list?",
        options: [
          "The pledge is deleted and vanishes from the list",
          "The count drops by one (paused pledges don't count), but the pledge stays in the backers list with its full history",
          "Nothing changes until Stripe cancels the subscription",
          "The count is unaffected; paused pledges still count as backers",
        ],
        answerIndex: 1,
        explanation:
          "A pause removes the backer from the count immediately, but the pledge and its paused/resumed timeline stay on the record. Resume it and the count goes back up. (A pause is local, so cancel in Stripe to stop the card being charged.)",
      },
    ],
  },

  // ── 91 · The backer portal: what a backer can see ───────────────────────
  {
    slug: "dev-backer-portal",
    title: "The backer portal: their own page",
    subtitle: "What a backer signs into, what they can change, and what we show them about us",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Backers have their own page at `publicworship.life/backer`. They sign in with their email and a six-digit code (no password, no OS account) and see their monthly gift, their giving history, and where their city stands.",
      },
      {
        kind: "rule",
        title: "Signing in proves an email, and that's all it is",
        text: "Enter an email, get a code, and the code starts a session that lasts a month. A donor with no email on file (a desk-entered cash or check giver) can't use the portal. The page never confirms whether an address is on file: known and unknown emails get the same answer, so nobody can fish for who gives.",
      },
      {
        kind: "rule",
        title: "They can change their card and their amount themselves",
        text: "Card updates and stopping a gift happen on Stripe's page; we never see card numbers. The AMOUNT is ours, because Stripe's page can't hold a minimum. Someone giving $50 a month or more can't drop below $50 in the portal, since that would silently remove them from their city's backer count. For anything lower, the page points them to the stop button and to us.",
      },
      {
        kind: "rule",
        title: "A declined card now tells the backer",
        text: "When a monthly charge fails, the backer gets one warm email: nothing is cancelled, the bank will be retried, and here's the button to update the card. Before, the status changed silently while the chapter's public count dropped. Stripe retries; we tell the backer.",
      },
      {
        kind: "tip",
        text: "**Your own record is always yours.** Anyone who has given, backer or not, can sign in to see their history and manage their monthly gift. Only what we show about the ORG (the city's ladder, what's coming up, the books) is backer-only.",
      },
      {
        kind: "reveal",
        prompt:
          "A backer emails asking you to lower their monthly gift from $50 to $20. What do you tell them?",
        answer:
          "They can change it on their page, but it holds them at $50 or more, the line where they stop counting as a backer of their city. If $20 is what works, welcome it: they can stop the $50 and start again at $20, or reply and we'll do it. The rule stops accidental drops.",
      },
    ],
    quiz: [
      {
        prompt: "How does a backer sign into their portal?",
        options: [
          "With a Chapter OS account we create for them",
          "With their email and a six-digit code we send them: no password, no OS account",
          "With a permanent link we email once",
          "They can't sign in; the desk sends them a PDF",
        ],
        answerIndex: 1,
        explanation:
          "A code proves the email, and the session can be revoked. A permanent link was rejected because a forwarded or archived email would become standing access to someone's giving history.",
      },
      {
        prompt: "A backer giving $50/month tries to change their amount to $25. What happens?",
        options: [
          "It goes through; any amount is allowed",
          "The page refuses, because dropping below $50 would take them out of their city's backer count, and points them at stopping instead",
          "It silently cancels their backing",
          "Only a superuser can change a pledge amount",
        ],
        answerIndex: 1,
        explanation:
          "The rule only holds people who are already backers, and stopping is one button away. Someone already giving under $50 can change their amount freely.",
      },
      {
        prompt: "Which part of the portal is backer-only?",
        options: [
          "All of it; non-backers can't sign in",
          "Their own giving history",
          "What we show about the ORG: the city's ladder, what's coming up, the books. Anyone who has given can always see their OWN record",
          "Nothing is restricted",
        ],
        answerIndex: 2,
        explanation:
          "Every giver sees their own receipts. The backer-only half is what we disclose about ourselves.",
      },
      {
        prompt: "A backer's card is declined. What does the backer receive?",
        options: [
          "Nothing; the status just changes internally",
          "One warm email saying nothing has been cancelled, the bank will be retried, and here's how to update the card",
          "A weekly invoice until they pay",
          "A cancellation notice",
        ],
        answerIndex: 1,
        explanation:
          "A failed card is usually an expiry or a cautious bank, not a decision, so the email assumes the best. Before it, the public count dropped while the backer heard nothing.",
      },
    ],
  },

  // ── 92 · The backer model: the Givebutter migration ─────────────────────
  {
    slug: "dev-givebutter-migration",
    title: "The Givebutter migration: history in, recurring gifts re-signed",
    subtitle: "Two very different imports for one-time history and monthly gifts",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Public Worship is leaving Givebutter. Moving a monthly donor is harder than moving one-time history, because their card lives in Givebutter's own Stripe account and we can't move it.",
      },
      {
        kind: "bullets",
        items: [
          "**One-time and past history**: the canonical import's `gift` rows bring in donors and past gifts through preview-then-commit. The same file's ticket rows import as `ticket` rows (contacts with purchase history, never donors), so the migration can't inflate the donor CRM.",
          "**Recurring donors**: `recurring` rows, which can't be auto-ported onto our billing. Each needs a personal re-signup ask: send their city's page, and they subscribe fresh on our rails.",
        ],
      },
      {
        kind: "rule",
        title: "Imported recurring pledges start past_due, on purpose",
        text: "An imported Givebutter recurrence lands as a real pledge with status past_due, because it isn't collecting on our rails yet. It doesn't count toward the chapter's backer number until the donor re-subscribes.",
      },
      {
        kind: "scenario",
        prompt:
          "You open a donor's record and see \"Imported · awaiting re-signup\" next to their old $50/month pledge. What's the right move?",
        options: [
          {
            text: "Ignore it. The pledge is already in the system, so it's handled",
            feedback:
              "It's tracked, not handled. \"Imported · awaiting re-signup\" means this person hasn't resubscribed, so their giving has stopped until someone reaches out.",
          },
          {
            text: "Send them a personal message with a link to their city's page, asking them to re-subscribe",
            correct: true,
            feedback:
              "Right. A former monthly donor gets a personal ask to come back onto our rails, not a mass blast.",
          },
          {
            text: "Add a blast-audience segment and email every imported donor the same template",
            feedback:
              "This is relationship work: a personal re-signup ask, not a form email.",
          },
          {
            text: "Delete the row since it's not collecting money",
            feedback:
              "Never delete it. It's the record of a real relationship that needs a re-signup, and the cutover dashboard tracks progress against it.",
          },
        ],
      },
    ],
    quiz: [
      {
        prompt: "Why can't a Givebutter recurring donor be automatically ported onto our own billing?",
        options: [
          "It's a policy choice, not a technical one",
          "Their card lives inside Givebutter's own Stripe account, and we can't move card data that isn't ours",
          "Recurring donors aren't allowed to move platforms",
          "Only one-time donors are eligible for import",
        ],
        answerIndex: 1,
        explanation:
          "Card data is locked inside Givebutter's Stripe. The fix is a fresh subscription on our own rails, not a data migration.",
      },
      {
        prompt: "What status does an imported Givebutter recurring pledge start at?",
        options: ["Active", "Incomplete", "Past_due", "Canceled"],
        answerIndex: 2,
        explanation:
          "Past_due is the honest starting state: the relationship is real, but it isn't collecting on our rails yet.",
      },
      {
        prompt: "Does an imported recurring pledge count toward the chapter's backer number before the donor re-signs up?",
        options: [
          "Yes, immediately",
          "No; only pledges active on our own rails count toward backers",
          "Only if the amount was above $100",
          "Only central decides case by case",
        ],
        answerIndex: 1,
        explanation:
          "The backer count only reflects collecting pledges. An imported row waits until the donor resubscribes.",
      },
      {
        prompt: "What's the right way to ask an imported recurring donor to move over?",
        options: [
          "A single mass email blast to everyone imported",
          "A personal outreach with a link to their city's page, not a blast",
          "No outreach; wait for them to notice on their own",
          "A phone call is required for every donor, no exceptions",
        ],
        answerIndex: 1,
        explanation:
          "This is relationship work, not a mass email: the same care as any personal donor touch.",
      },
    ],
  },

  // ── 93 · Sponsorships: package tiers ─────────────────────────────────────
  {
    slug: "dev-sponsor-packages",
    title: "Sponsor packages: benefits we give, commitments we keep",
    subtitle: "Dev-director-authored tiers, not hardcoded prices",
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "A sponsor package (\"LTN Gold\") is an editable tier the development director defines. It has a name, a tier rank, an audience (church, business, or any), a price (one-time, monthly, or annual), and a scope (one event, a season, or a full year).",
      },
      {
        kind: "rule",
        title: "Every package lists two things, not one",
        text: "A package needs at least one BENEFIT: what the sponsor gets (logo on flyers, a joint social post, a Sunday-announcement mention). It also needs at least one COMMITMENT: what we deliver at that tier. A pitch built from it is a two-way agreement, not a price sheet.",
      },
      {
        kind: "bullets",
        items: [
          "**Editable rows, not constants.** Packages are written and revised in-app as real pitches show what lands.",
          "**Deactivate, don't delete.** Retiring a package keeps every existing sponsorship's reference to it intact.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "The development director retires an old package after three churches already signed under it. What happens to those three agreements?",
        answer:
          "Nothing changes for them. Deactivating hides the package from new pitches, but existing sponsorships keep their reference. Their agreement, benefits, and commitments stay as signed.",
      },
    ],
    quiz: [
      {
        prompt: "What two things does every sponsor package require, at minimum one each?",
        options: [
          "A start date and an end date",
          "Benefits (what the sponsor gets) and commitments (what we deliver)",
          "A logo file and a contract PDF",
          "A tier name and nothing else",
        ],
        answerIndex: 1,
        explanation:
          "Both lists are required so a package is always a two-way deal, never a price list.",
      },
      {
        prompt: "Who authors and edits sponsor packages?",
        options: [
          "They're hardcoded and can never change",
          "The development director; packages are editable rows, refined as pitches show what works",
          "Any chapter director for their own chapter",
          "A central committee vote",
        ],
        answerIndex: 1,
        explanation:
          "The development director writes packages and revises them as real pitches show what lands.",
      },
      {
        prompt: "What happens when a package is deactivated?",
        options: [
          "Every sponsorship using it is automatically canceled",
          "It's hidden from new pitches but existing sponsorships keep their valid reference to it",
          "It's permanently deleted, including the history",
          "Nothing; deactivation has no real effect",
        ],
        answerIndex: 1,
        explanation:
          "Deactivation protects history: an old tier retires without breaking any agreement built on it.",
      },
      {
        prompt: "Which audiences can a package target?",
        options: [
          "Church, business, or any",
          "Only churches",
          "Only businesses and foundations",
          "Individuals only",
        ],
        answerIndex: 0,
        explanation:
          "A package targets church, business, or any. Foundations can still hold a sponsorship agreement, just not as a package's target audience.",
      },
    ],
  },

  // ── 93 · Sponsorships: the pipeline ──────────────────────────────────────
  {
    slug: "dev-sponsorship-pipeline",
    title: "The pipeline: prospect to active partner",
    subtitle: "Five open stages, one auto-advance, and the OKR surface",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "A sponsorship is one organization (church, business, or foundation, never an individual). Create it by naming the organization on the Sponsorships tab; no donor list needed. A package tier is optional: start from a saved tier, or leave it blank and write bespoke amount and terms on the agreement. Each agreement moves through prospect, pitched, committed, and active, with lapsed and declined as the closed outcomes. The pipeline is a central desk; a chapter-only user sees an access-needed state.",
      },
      {
        kind: "table",
        headers: ["Stage", "Meaning"],
        rows: [
          ["Prospect", "On the radar, no pitch sent yet"],
          ["Pitched", "A package has been proposed"],
          ["Committed", "A verbal or written yes, not yet paying"],
          ["Active", "Paying: the partnership has started"],
          ["Lapsed / Declined", "Closed: didn't renew, or said no"],
        ],
      },
      {
        kind: "rule",
        title: "First dollar, not first handshake, moves committed to active",
        text: "A committed agreement flips to active the moment its first payment lands. Every other stage move (prospect to pitched, or closing an agreement) is a deliberate choice, not a side effect of a gift.",
      },
      {
        kind: "reveal",
        prompt:
          "A church still in \"prospect\" stage makes a surprise one-time gift before any formal pitch. Does that jump them straight to \"active\"?",
        answer:
          "No. Auto-advance only fires from committed. A gift at prospect or pitched needs someone to move the stage, so the pitch and the yes are never skipped in the record.",
      },
    ],
    quiz: [
      {
        prompt: "What organization types can hold a sponsorship agreement?",
        options: [
          "Any donor, including individuals",
          "Church, business, or foundation; individuals are rejected",
          "Only churches",
          "Only businesses",
        ],
        answerIndex: 1,
        explanation:
          "Sponsorships are institutional by design, and the system rejects an individual donor.",
      },
      {
        prompt: "What automatically moves a \"committed\" agreement to \"active\"?",
        options: [
          "30 days passing with no change",
          "Its first payment landing",
          "The development director manually approving it",
          "The agreement's start date arriving",
        ],
        answerIndex: 1,
        explanation:
          "Money arriving, not a promise, is the signal the partnership has started.",
      },
      {
        prompt: "Is the sponsorship pipeline visible to a chapter-only Giving-desk user?",
        options: [
          "Yes, every chapter sees its own pipeline",
          "No. It's a central desk; a chapter-only user sees an access-needed state",
          "Only the chapter director sees it",
          "Only during launch week",
        ],
        answerIndex: 1,
        explanation:
          "Packages and the pipeline live at the org level, not per chapter: they're the dev team's central OKR desk.",
      },
      {
        prompt: "A prospect church sends a surprise gift before any formal pitch. What happens to their pipeline stage?",
        options: [
          "It jumps straight to active",
          "It stays put. Auto-advance only fires from \"committed\"; moving it needs a deliberate choice",
          "The gift is rejected until they're committed",
          "It resets back to prospect",
        ],
        answerIndex: 1,
        explanation:
          "Auto-advance is narrow on purpose, so the pitch-and-commit work is never skipped.",
      },
    ],
  },

  // ── 94 · Sponsorships: church partnerships ───────────────────────────────
  {
    slug: "dev-church-partnerships",
    title: "Church partnerships: two-sided, not transactional",
    subtitle: "Due diligence, a real relationship, and the lighter QR option",
    minutes: 2,
    blocks: [
      {
        kind: "p",
        text: "A church partnership is an ongoing relationship with a congregation's leadership, not a referral fee. Trust comes before a signed package.",
      },
      {
        kind: "bullets",
        items: [
          "**Due diligence, tracked.** A church agreement holds notes on the relationship's foundation, such as a statement of beliefs, the pastor relationship, and having visited a service.",
          "**A named owner and a next touchpoint.** Like a donor, a sponsorship has an owner and a next-touchpoint date, so someone keeps tending it.",
        ],
      },
      {
        kind: "rule",
        title: "Not every church touch is a sponsorship",
        text: "A pastor offering a Sunday announcement and a shareable QR code to the chapter's page is not a sponsorship. Their congregation reaches the backer page through an attributable link, and no agreement record is needed. Save the package and pipeline for a real institutional commitment.",
      },
      {
        kind: "reveal",
        prompt:
          "A pastor says, \"We'll do a Sunday announcement and share a QR code, but we're not ready for a formal package.\" Is that a sponsorship?",
        answer:
          "No. It's the lighter, no-agreement option: their congregation reaches the city's backer page through an attributable link. Note the relationship and a next touchpoint if you want to build toward a partnership, but keep it out of the pipeline until it's ready.",
      },
    ],
    quiz: [
      {
        prompt: "What does a church sponsorship's due-diligence field track?",
        options: [
          "Only the price they agreed to pay",
          "The relationship's foundation, such as a statement of beliefs, the pastor relationship, having visited a service",
          "The chapter's own budget",
          "Nothing; due diligence isn't tracked",
        ],
        answerIndex: 1,
        explanation:
          "Due diligence tracks the trust behind the relationship, not the money.",
      },
      {
        prompt: "A pastor offers a Sunday announcement and a QR code, with no formal package. What's the right classification?",
        options: [
          "A sponsorship at the lowest tier",
          "Not a sponsorship at all: a lighter, attributable-link option that needs no agreement record",
          "An automatic \"prospect\" pipeline entry",
          "It can't be tracked in the system",
        ],
        answerIndex: 1,
        explanation:
          "The QR and announcement option sits outside the pipeline. An institutional partnership is a separate, deeper commitment.",
      },
      {
        prompt: "Why does a church partnership favor deep relationship over transactional referral?",
        options: [
          "Because churches never pay for anything",
          "Because the partnership is meant to be genuine and ongoing, not a one-off fee-for-mention arrangement",
          "It's a legal requirement",
          "Because churches can't hold sponsorship agreements",
        ],
        answerIndex: 1,
        explanation:
          "The owner and next-touchpoint fields exist so a church relationship stays tended, not signed once and forgotten.",
      },
    ],
  },

  // ── 94b · Sponsorships: the partner portal ───────────────────────────────
  {
    slug: "dev-partner-portal",
    title: "The partner portal: one page they read, sign, and pay",
    subtitle: "A custom proposal, the gatherings it covers, and a digital signature",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Real partnerships are negotiated, so each agreement can carry its own proposal (title, body, what they receive, what we deliver, terms). Blank fields fall back to the package tier.",
      },
      {
        kind: "p",
        text: "Then send a portal link. On one page, with no login, they read the agreement, sign by typing their name, and pay the balance.",
      },
      {
        kind: "rule",
        title: "Editing what they signed un-signs it",
        text: "Changing the amount, terms, benefits, commitments, summary, title, or covered events bumps the version and CLEARS the signature. Editing contacts, payment rails, or an in-kind credit doesn't.",
      },
      {
        kind: "rule",
        title: "Big partnerships pay by bank transfer, and that's a money decision",
        text: "Stripe's bank-transfer (ACH) fee is 0.8% CAPPED AT $5; a card is about 2.9% + 30¢, uncapped. On a $3,500 spot that's $5.00 against $101.80. New agreements offer bank transfer only. You can add card on a small spot, never above $1,000.",
      },
      {
        kind: "bullets",
        items: [
          "**In-kind credit lowers what they owe; it isn't money in.** Value it at our own budget lines, never their rate card; it's listed on their page and counts like cash. Recording an in-kind gift too counts it twice.",
          "**One agreement can cover several events.** Tick each; the partner sees each by name and date.",
          "**Attach paperwork** as a PDF, photo, or scan. It stays internal until you show it on their page, and attaching never touches a signature.",
          "**Who can do this.** Partnership and Fundraising Associates and the Development Director hold `giving.partners.edit`: fill in agreements, send links. Gifts, donor edits, imports, and recording a partner's payment stay with the director.",
          "**The link is stable.** \"Copy link\" twice gives the same URL. Revoking kills it; the next link is a new address.",
          "**Bank transfers take about four business days.** Until then the portal shows clearing, the balance holds, no gift is recorded, and they can't pay twice.",
          "**Nothing internal reaches their page**: no due-diligence notes, pipeline stage, owner, or other agreements.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A partner signed, then you fix the amount from $3,000 to $3,500. What happens?",
        answer:
          "It moves to version 2 and the signature clears. The desk shows \"needs re-signing\"; their portal asks them to sign the corrected terms.",
      },
    ],
    quiz: [
      {
        prompt: "You edit an agreement's terms after the partner signed. What happens to the signature?",
        options: [
          "It carries over; the terms are just a note",
          "It's cleared, and the partner is asked to sign the new version",
          "The agreement is deleted",
          "Nothing changes until the next payment",
        ],
        answerIndex: 1,
        explanation:
          "A signature is against one version of the terms. Editing a signed term bumps the version and clears the signature, so we never hold a signature for terms nobody read.",
      },
      {
        prompt: "Why do large partnerships pay by bank transfer rather than card?",
        options: [
          "Cards aren't accepted anywhere in the app",
          "The bank-transfer fee is capped at $5, where a card takes about 3% with no cap",
          "Bank transfers clear faster",
          "It's a legal requirement for churches",
        ],
        answerIndex: 1,
        explanation:
          "On a $3,500 spot a card costs about $101.80 and a bank transfer $5.00. That difference pays for a free event's production, so the rail is a stored setting.",
      },
      {
        prompt: "A partner's team donates production work you value at $2,500 against a $3,500 spot. What do you do?",
        options: [
          "Record it as an in-kind gift AND add an in-kind credit",
          "Add an in-kind credit line; it reduces what they still owe to $1,000",
          "Lower the agreement amount to $1,000",
          "Nothing can be recorded until they pay cash",
        ],
        answerIndex: 1,
        explanation:
          "The credit reduces the balance and shows on their page line by line. Lowering the amount would lose what the partnership is worth, and a credit plus a gift counts the donation twice.",
      },
      {
        prompt: "What can a partner do with the portal link they were sent?",
        options: [
          "Read, sign, and pay that one agreement, nothing else",
          "See every sponsorship the org holds",
          "Edit the terms before signing",
          "Open the donor CRM",
        ],
        answerIndex: 0,
        explanation:
          "The link opens one agreement and allows two acts: signing and paying. It can't read our notes, change a term, or reach any other record.",
      },
      {
        prompt: "You press \"Copy link\" a second time on an agreement you already sent. What do you get?",
        options: [
          "A new link, and the old one stops working",
          "The same link; the one you already emailed keeps working",
          "An error",
          "A link that expires in 24 hours",
        ],
        answerIndex: 1,
        explanation:
          "A fresh link on every press would silently break the URL you sent five minutes ago. Revoking is the only way to kill a link.",
      },
    ],
  },

  // ── 95 · The city-launch story: the economics ────────────────────────────
  {
    slug: "dev-city-launch-economics",
    title: "The 85/15 split and the City Launch Fund",
    subtitle: "How today's chapters fund tomorrow's cities",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every backer's gift does two jobs. 85% stays with their own chapter to run the mission locally. A flat 15% moves each month, as a real transfer, into central's City Launch Fund, which seeds the next city.",
      },
      {
        kind: "rule",
        title: "The giving side of a story the Finance stream also teaches",
        text: "The Finance stream's \"Tiers, the covenant, and the skim\" lesson covers the mechanics: the flat 15% skim, the fund's balance, and the launch grant. Here the point is what it means for backers: a gift to one city also helps open the next.",
      },
      {
        kind: "bullets",
        items: [
          "**Published.** `/give/how-it-works` lays out the money model: the monthly operating lines, the 20/30/50 ladder, the launch budget, and the 85/15 split. The books at `/finances` show the actuals month by month. The model explains; the books are the evidence. Neither sits on the giving page itself.",
          "**A one-time launch grant.** The fund pays a new chapter's one-time launch cost (equipment and the training trip) when that city is ready.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A backer asks why their $50/month doesn't all stay with the chapter they attend. What do you tell them?",
        answer:
          "85% does, and it runs their chapter day to day. The other 15% is a flat contribution every chapter makes to the City Launch Fund, so the network can open its next city. Their gift funds the place they know and the place that doesn't exist yet.",
      },
    ],
    quiz: [
      {
        prompt: "What percentage of a chapter's backer revenue moves to the City Launch Fund each month?",
        options: ["0%", "A flat 15%", "50%", "It varies by chapter"],
        answerIndex: 1,
        explanation:
          "Every chapter contributes the same flat 15%, whatever its size. The Finance stream teaches the same rule from the chapter's side.",
      },
      {
        prompt: "What does the City Launch Fund ultimately pay for?",
        options: [
          "Ongoing chapter operating costs",
          "A new city's one-time launch cost: equipment and the training trip",
          "Reimbursements to individual backers",
          "Marketing campaigns",
        ],
        answerIndex: 1,
        explanation:
          "It's a one-time seed fund for the next city, not an operating budget.",
      },
      {
        prompt: "Where can a backer go to read the 85/15 split for themselves?",
        options: [
          "Nowhere; it's an internal number staff explain verbally",
          "`/give/how-it-works`, which lays out the whole money model, with the published books at `/finances` as the check on it",
          "On the giving page's hero, above the ask",
          "Only inside the app, once they're signed in",
        ],
        answerIndex: 1,
        explanation:
          "The money model has its own page, `/give/how-it-works`, and the books that prove it live at `/finances`. The giving pages link to both but hold neither.",
      },
    ],
  },

  // ── 96 · The launch story: prospect territories and the map (concept) ────
  {
    slug: "dev-prospect-cities-and-map",
    title: "Prospect territories: how a dot becomes a chapter",
    subtitle: "Backer campaigns, milestone promises, and the live public map",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "A prospect territory is a place (\"Columbus, OH\", \"Queens\") raising backers toward opening a chapter. When central adds one, a real but inactive \"shadow chapter\" is created behind it. Central or a development-director-level holder stands one up.",
      },
      {
        kind: "bullets",
        items: [
          "**Same ladder, public.** Its `/give/<slug>` page shows a live chapter's milestone ladder, with progress like \"17 of 20 backers — 3 more unlocks monthly Worship With Strangers in Columbus\".",
          "**Shareable and findable.** Backer campaigns are meant to be forwarded, and city pages are public pages that search engines index. What they show about a giver follows the wall's consent rule (see \"The public gift wall\" in Donor Stewardship). That means a gift and its amount, a name or message only with consent, and never a CRM record or contact details.",
          "**Launch is a flip, not a move.** Backers, donors, and gifts belong to the shadow chapter from the first pledge. Launch flips that chapter live and provisions its banking; no money moves.",
        ],
      },
      {
        kind: "rule",
        title: "Belief comes before the building",
        text: "A prospect territory lets people back a place before it has staff, a venue, or a launch date. Every backer counts from day one, so the backer campaign is the proof a place is ready.",
      },
      {
        kind: "tip",
        text: "**Live now: the public `/give` pages.** `/give` leads with backing a city: a card per city with its live backer count and next milestone. Giving once stays one tap away, to central operations or a named city. The map sits further down, showing where we're going. Each `/give/<slug>` page has the ladder, a progress bar, its gift wall, its fundraisers, and a become-a-backer form. The form ($50 / $100 / $200 or a custom monthly amount) starts a real Stripe subscription. A territory shows publicly only once an admin marks it visible. Neither page exposes a donor's contact details or CRM record.",
      },
      {
        kind: "reveal",
        prompt:
          "A prospect territory's backer campaign hits its launch target. What happens to its backers?",
        answer:
          "Nothing moves. Its backers, donors, and gifts belonged to that chapter from the first pledge. Launch flips the chapter live and provisions its banking, and the same backers become its founding supporters.",
      },
    ],
    quiz: [
      {
        prompt: "What is a \"prospect territory\"?",
        options: [
          "Any place with an existing, active chapter",
          "A place raising backers toward launch, created as a real but inactive \"shadow chapter\" from day one",
          "A place Public Worship has ruled out",
          "A backup location if a chapter closes",
        ],
        answerIndex: 1,
        explanation:
          "A prospect territory maps 1:1 to a real chapter that isn't live yet, so backers, donors, and gifts attach to it directly.",
      },
      {
        prompt: "Who typically stands up a new prospect territory?",
        options: [
          "Any signed-in member",
          "Central or a development-director-level holder",
          "The place itself, automatically",
          "A random lottery",
        ],
        answerIndex: 1,
        explanation:
          "Adding a territory is a deliberate, gated move, not something any member can do.",
      },
      {
        prompt: "Is the public `/give` map live today?",
        options: [
          "Yes. The map and each territory's `/give/<slug>` page, with a become-a-backer flow, are live",
          "No, it's still being built for a later release",
          "Only central users can see it",
          "It goes live only after a territory launches",
        ],
        answerIndex: 0,
        explanation:
          "The map, the territory pages, and the Stripe become-a-backer flow all shipped. A territory shows publicly once an admin marks it visible.",
      },
      {
        prompt: "What happens to a prospect territory's backers the moment it launches into a live chapter?",
        options: [
          "Their pledges are canceled and they must re-subscribe",
          "Nothing moves. They were scoped to the chapter all along; launch flips that chapter live and provisions its banking",
          "They stay attached to a separate prospect record forever",
          "They're deleted and nothing is tracked",
        ],
        answerIndex: 1,
        explanation:
          "A territory is a real chapter from creation, so backers scope directly to it. Launch flips `isActive` and provisions banking without re-scoping anyone.",
      },
    ],
  },
];

/** The Development stream's theme entry. */
export const DEVELOPMENT_THEME: Theme = {
  key: "development",
  title: "Development",
  subtitle:
    "Donors, backers, and sponsors, and how giving funds the next city.",
};

/**
 * The Development stream's courses, in catalog order. Five courses: the
 * shared vocabulary + CRM basics everyone on the desk needs, donor
 * stewardship (the relationship craft), the backer model (the recurring
 * rails + the Givebutter cutover), sponsorships & partnerships (the
 * institutional-giving desk), and the city-launch story (the economics
 * backer giving funds, plus the prospect-territory story and the live public
 * `/give` map — per this stream's header comment).
 */
export const DEVELOPMENT_COURSES: Course[] = [
  {
    slug: "giving-fundamentals",
    themeKey: "development",
    title: "Giving Fundamentals",
    level: "beginner",
    audience: "team",
    description:
      "The words every development-desk holder needs (donor, gift, backer, " +
      "sponsor, prospect territory) and a tour of the donor CRM: statuses, " +
      "the 90-day lapse rule, and the top-donor dashboard.",
    icon: "gift",
    moduleSlugs: ["dev-giving-vocabulary", "dev-donor-crm-basics"],
  },
  {
    slug: "donor-stewardship",
    themeKey: "development",
    title: "Donor Stewardship",
    level: "leader",
    audience: "role",
    description:
      "Running donor relationships in the CRM: owners, notes, the top-donor " +
      "list, importing old giving history, the gifts ledger's edit, audit, " +
      "and merge trail, and the public gift wall (anonymous by default, " +
      "consent gating only the name).",
    icon: "users",
    moduleSlugs: [
      "dev-relationship-workflow",
      "dev-import-and-backfill",
      "dev-gifts-ledger-and-audit",
      "dev-public-gift-wall",
    ],
  },
  {
    slug: "the-backer-model",
    themeKey: "development",
    title: "The Backer Model",
    level: "intermediate",
    audience: "team",
    description:
      "The $50 floor and the editable milestone ladder, a backer's " +
      "Stripe-driven lifecycle and self-serve billing, and the Givebutter " +
      "migration's two-part cutover.",
    icon: "trending-up",
    moduleSlugs: [
      "dev-backer-floor-and-ladder",
      "dev-backer-lifecycle",
      "dev-backer-portal",
      "dev-givebutter-migration",
    ],
  },
  {
    slug: "sponsorships-and-partnerships",
    themeKey: "development",
    title: "Sponsorships & Partnerships",
    level: "leader",
    audience: "role",
    description:
      "The institutional-giving desk: dev-director-authored package tiers, " +
      "the prospect-to-active pipeline, church partnership principles, and " +
      "the partner portal a sponsor reads, signs, and pays on.",
    icon: "briefcase",
    moduleSlugs: [
      "dev-sponsor-packages",
      "dev-sponsorship-pipeline",
      "dev-church-partnerships",
      "dev-partner-portal",
    ],
  },
  {
    slug: "the-city-launch-story",
    themeKey: "development",
    title: "The City-Launch Story",
    level: "intermediate",
    audience: "team",
    description:
      "The 85/15 split and the City Launch Fund from the giving side, plus " +
      "prospect territories, backer campaigns, and the live public `/give` " +
      "pages, including what launch does (flips the shadow chapter live) and " +
      "doesn't do (move anyone's money).",
    icon: "map",
    moduleSlugs: [
      "dev-city-launch-economics",
      "dev-prospect-cities-and-map",
    ],
  },
];
