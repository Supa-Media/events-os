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
 * (`apps/mobile/app/(app)/giving/`), and the `giving.manage`/`giving.view`/
 * `nav.giving` capabilities in `packages/shared/src/seats.ts`.
 *
 * The public `/give` map and per-territory pages (`territories` +
 * `apps/convex/lib/givePage.ts`) are the live acquisition surface;
 * `dev-prospect-cities-and-map` teaches them as they now work under the
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
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Public Worship is moving every dollar of giving — one-time gifts, monthly backing, church and business partnerships — onto one home: the Giving desk. Before touching any of it, get the words right. They're precise on purpose, because the system (and your teammates) use them exactly this way.",
      },
      {
        kind: "bullets",
        items: [
          "**Donor** — any person or org that has ever given, once or a hundred times. Every donor gets a CRM record: identity, status, giving history.",
          "**Gift** — one dollar amount received, ever, with nothing of equal value given back — mission giving, not a purchase. It can arrive through any channel (Chapter OS/Stripe, cash, check, wire, Zelle, Venmo, imported Givebutter history, in-kind), and every gift is one row in the giving history.",
          "**Ticket buyer ≠ donor.** Someone who buys an event ticket gets something of equal value in return — a seat. That's a purchase, not a gift, so it never creates a donor or a gift record; it's tracked as a contact with purchase history instead. See \"Canonical import\" later in this course for why that line matters.",
          "**Backer** — a donor with an *active, recurring monthly pledge* to a specific city, at or above the $50/month floor. Backers are what the affordability tiers count — see the next course.",
          "**Sponsor / partner** — an organization-level relationship (a church, a business, or a foundation) attached to a sponsor package, not a one-time or per-month personal gift.",
          "**Prospect territory** — a place on the map raising backers toward opening a chapter. Under the hood it's already a real chapter, just an inactive one (a \"shadow chapter\") — so backers attach to it directly from day one, before it's officially live.",
        ],
      },
      {
        kind: "rule",
        title: "Missional giving, not a substitute for a tithe",
        text: "A backer's monthly gift funds the MISSION — the chapters, the events, the next city — not a local congregation's own budget. It's giving toward a specific work someone believes in, alongside whatever they already give at their own church, not instead of it. Never frame backing as \"your tithe, just routed here.\"",
      },
      {
        kind: "reveal",
        prompt:
          "A potential backer asks, \"Isn't this basically my tithe, just to Public Worship instead of my church?\" What do you tell them?",
        answer:
          "No — they're different gifts with different purposes. A tithe supports their home church's ongoing life and ministry; backing Public Worship funds a specific missional work (a chapter, an event series, the next city). The honest answer invites them to do both, not to swap one for the other.",
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
          "Donor is the broad CRM record — anyone who's ever given. Backer is the narrower, recurring-pledge subset that the affordability tiers actually count.",
      },
      {
        prompt: "What counts as one \"gift\" in the system, and what doesn't?",
        options: [
          "Only Stripe payments count",
          "Only recurring monthly pledges count",
          "Any mission giving with nothing given back — through any channel — counts; a ticket purchase does NOT, because the buyer got a seat in return",
          "Only donations made through an event page count",
        ],
        answerIndex: 2,
        explanation:
          "\"Gift\" is deliberately broad on CHANNEL (Chapter OS, cash, check, wire, Zelle, Venmo, Givebutter, in-kind) but narrow on KIND — nothing of equal value came back to the giver. A ticket sale fails that test on purpose.",
      },
      {
        prompt: "What is a \"prospect territory\"?",
        options: [
          "A chapter that's behind on its budget",
          "A place raising backers toward opening a chapter — backed by a real but inactive \"shadow chapter\" from day one",
          "A place Public Worship has decided never to launch",
          "Any place with at least one donor",
        ],
        answerIndex: 1,
        explanation:
          "A prospect territory maps 1:1 with a real chapter that simply isn't live yet — so backers scope to it directly, before it opens.",
      },
      {
        prompt: "How should you frame backing Public Worship to someone who already tithes at their own church?",
        options: [
          "As a replacement for their tithe — one gift instead of two",
          "As a separate, missional gift alongside whatever they already give at their own church",
          "Don't mention their church giving at all",
          "Tell them to reduce their tithe to afford backing",
        ],
        answerIndex: 1,
        explanation:
          "Backing funds a specific mission, not a congregation's operating life — the honest ask is \"in addition to,\" never \"instead of.\"",
      },
    ],
  },

  // ── 86 · Giving fundamentals: the donor CRM ─────────────────────────────
  {
    slug: "dev-donor-crm-basics",
    title: "The donor CRM: your desk",
    subtitle: "Prospect, active, lapsed — and where the story lives",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The Giving desk's Dashboard opens to your scope's numbers: lifetime giving, giving in the last 30 days, total donors, and how many have lapsed. Below that, your top donors by lifetime giving — the same ordering the relationship workflow runs on, on day one, with no extra setup.",
      },
      {
        kind: "table",
        headers: ["Status", "What it means"],
        rows: [
          ["Prospect", "No gift yet — giftCount is zero"],
          ["Active", "A gift landed within the last 90 days"],
          ["Lapsed", "Has given before, but not in the last 90 days — the reactivation queue"],
        ],
      },
      {
        kind: "rule",
        title: "Status is derived, never hand-set",
        text: "Nobody picks a donor's status from a dropdown. It's recomputed automatically every time a gift is recorded, from lastGiftAt — cross the 90-day line with no new gift, and a donor quietly becomes lapsed on its own.",
      },
      {
        kind: "tip",
        text: "**The giving desk isn't the only place a donor shows up.** A chapter-scope donor who's also on the roster gets a small \"giver\" mark right on the People tab — lifetime total, last-gift date — so anyone looking up a volunteer or team member can see the giving relationship without switching desks. Only donors who've actually GIVEN get the mark (giftCount > 0); a prospect with no gift yet, or a contact who only ever bought an event ticket, never shows one — ticket buyers aren't donors (see the import lesson later in this course).",
      },
      {
        kind: "reveal",
        prompt:
          "A donor's last gift landed 91 days ago. What does their CRM record show, and what should you do about it?",
        answer:
          "Lapsed. That's not a failure state to hide — it's the reactivation queue working as designed. Sort your donor list by status or lifetime giving, find them, and make a personal reach-out; that's the whole point of surfacing lapsed donors instead of letting them quietly fall off the radar.",
      },
    ],
    quiz: [
      {
        prompt: "What sets a donor's status to \"lapsed\"?",
        options: [
          "A staff member marks them lapsed manually",
          "No gift in the last 90 days — recomputed automatically from their last gift date",
          "They ask to be removed from the list",
          "A full calendar year with no gift",
        ],
        answerIndex: 1,
        explanation:
          "The 90-day window is the rule, and it's derived — nobody types a status into a donor's record.",
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
          "Lifetime-giving order is deliberate — it's the exact ordering the \"who are our top 5 donors\" relationship workflow needs, with zero extra setup.",
      },
      {
        prompt: "A donor who's given zero gifts so far shows what status?",
        options: ["Active", "Lapsed", "Prospect", "No status until their first gift"],
        answerIndex: 2,
        explanation:
          "Prospect means \"on our radar, hasn't given yet\" — the natural starting point before a first gift ever lands.",
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
          "Those four stats are the desk's at-a-glance read — everything else (top donors, full history) is one tap deeper.",
      },
    ],
  },

  // ── 87 · Donor stewardship: the relationship workflow ───────────────────
  {
    slug: "dev-relationship-workflow",
    title: "Owners, notes, and the top-donor list",
    subtitle: "Every donor gets a name attached — and a personal thank-you",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "A donor record isn't just a name and a total — it's identity, status, an owner, full gift history, any active pledge, sponsorship links, and notes, all on one detail screen. That's enough to actually run a relationship, not just log a transaction.",
      },
      {
        kind: "bullets",
        items: [
          "**Owner** — the relationship point person (a real roster person, not just \"whoever's logged in\"). Someone should be able to look at any donor and know who to call.",
          "**Notes** — the story: how you met, what they care about, what they said last time. This is what makes a \"personal thank-you\" actually personal instead of a form letter.",
          "**Gift history** — every gift, newest first, right on the same screen the owner and notes live on. No second tab, no separate spreadsheet.",
          "**Backing, if any** — an active pledge shows right on the donor's detail too, so you see the whole relationship — one-time gifts and recurring backing — in one place.",
        ],
      },
      {
        kind: "rule",
        title: "Sorted by lifetime, on purpose",
        text: "The donor list defaults to strongest-lifetime-first, not most-recent-first. A single major gift from years ago still puts someone at the top — because the relationship that produced it is worth protecting, not just the last transaction.",
      },
      {
        kind: "scenario",
        prompt:
          "A donor you've never spoken to just gave $2,000 out of nowhere. What's the right next move?",
        options: [
          {
            text: "Nothing — the gift is already recorded, that's the important part",
            feedback:
              "The gift landing is only half the job. A gift this size with no relationship behind it yet is exactly the case that needs an owner and a personal reach-out.",
          },
          {
            text: "Assign yourself (or someone) as owner, and send a genuine personal thank-you",
            correct: true,
            feedback:
              "Right — a first major gift is the start of a relationship, not the end of a transaction. Claim the owner field and make the thank-you real.",
          },
          {
            text: "Wait to see if they give again before doing anything",
            feedback:
              "Waiting risks the relationship going cold right when it's warmest. Reach out now, while the gift is fresh.",
          },
          {
            text: "Add them straight to the sponsorship pipeline",
            feedback:
              "Sponsorships are for organizations (church/business/foundation), not individual donors — this is a donor-relationship move, not a pipeline one.",
          },
        ],
      },
    ],
    quiz: [
      {
        prompt: "What does a donor's \"owner\" field represent?",
        options: [
          "Whoever created the donor record in the system",
          "The relationship point person for that donor — a real roster person others can ask",
          "The donor's own account holder",
          "The chapter that donor belongs to",
        ],
        answerIndex: 1,
        explanation:
          "Owner is about accountability for the RELATIONSHIP, not a system audit field — it answers \"who do I ask about this donor?\"",
      },
      {
        prompt: "Why does the donor list sort by lifetime giving instead of most-recent gift?",
        options: [
          "It's the only sort option available",
          "So a major donor from years ago still surfaces at the top — protecting the relationship, not just the latest transaction",
          "Recent gifts are hidden from the list entirely",
          "Lifetime sorting is faster to compute",
        ],
        answerIndex: 1,
        explanation:
          "The \"top donors\" ordering exists specifically for the relationship workflow — who matters most over time, not who gave most recently.",
      },
      {
        prompt: "Where do a donor's notes and gift history live?",
        options: [
          "In a separate spreadsheet the owner keeps privately",
          "On the same donor detail screen as identity, owner, and any active pledge",
          "Notes aren't supported yet",
          "Only central can see notes, never a chapter",
        ],
        answerIndex: 1,
        explanation:
          "Everything about one donor — who they are, who owns the relationship, what they've given, what they're backing, and the story behind it — sits on one screen.",
      },
    ],
  },

  // ── 88 · Donor stewardship: the canonical import ────────────────────────
  {
    slug: "dev-import-and-backfill",
    title: "The canonical import: preview, classify, commit",
    subtitle: "One paste, four row types, and the line between a donor and a ticket buyer",
    minutes: 5,
    blocks: [
      {
        kind: "p",
        text: "Real giving history doesn't start the day the Giving desk launches — people have been giving for years, mostly through Givebutter. Getting that history in is first-class, not an afterthought: ONE import flow now covers every bulk data-onboarding case, and manual gift entry (the \"they gave $500 by check in March\" case, recorded right on a donor's own detail screen) still covers the one-off backfill.",
      },
      {
        kind: "bullets",
        items: [
          "**gift** — mission giving. Match-or-creates a donor, then adds a gift to their history.",
          "**ticket** — a ticket buyer's history. NEVER a donor or a gift — match-or-creates a chapter contact and, when possible, links their purchase to the real event.",
          "**contact** — just a person to add to the roster, nothing financial attached.",
          "**recurring** — a monthly pledge that can't be auto-ported (its card lives on another platform) — the same \"awaiting re-signup\" shape the backer-model course covers, now reachable from any import file.",
        ],
      },
      {
        kind: "rule",
        title: "Why classification is the whole point",
        text: "Givebutter (and platforms like it) consolidate ticket sales and mission giving into ONE export — the bank only ever sees a lump payout, never the split. Import that naively as \"gifts\" and every ticket buyer inflates the donor CRM with someone who never actually gave anything. So every row is classified BEFORE anything is created: only a `gift` or `recurring` row ever creates a donor. A `ticket` row becomes a contact with purchase history — full stop.",
      },
      {
        kind: "p",
        text: "Every import is two steps, on purpose: PREVIEW first (read-only — nothing is written), then COMMIT. The preview shows a disposition for every row, plus a summary with the gift-row-count vs. ticket-row-count split. That split is the tell: if you meant to import mission gifts and the preview shows mostly ticket rows (or vice versa), the source file's rowType column is probably wrong — and you find out before a single donor record is touched, not after.",
      },
      {
        kind: "table",
        headers: ["Situation", "What the preview shows"],
        rows: [
          ["A brand-new gift with a transaction id", "new"],
          ["The same transaction id already imported", "duplicate — skipped automatically"],
          [
            "Same donor, same amount, within 24h of an existing gift, no transaction id",
            "suspected-duplicate — skipped unless you explicitly include it",
          ],
          ["A ticket buyer whose purchase matches a real event", "matched-order"],
          ["A ticket buyer with no matching event/order", "history-only — still just a contact"],
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You accidentally run the same import file through commit twice. What happens?",
        answer:
          "Nothing bad — a gift's transaction id (when present) is the hard dedup key, a recurring pledge dedupes the same way within its donor, and a contact/ticket row just re-matches the same person instead of creating a duplicate. The second run imports nothing new. That's why re-running a fresh export, or retrying after a partial failure, is always safe.",
      },
      {
        kind: "scenario",
        prompt:
          "You paste in a Givebutter export and the preview summary shows 40 ticket rows and only 3 gift rows — but you were expecting mostly mission gifts. What's the right move?",
        options: [
          {
            text: "Commit anyway — the numbers will sort themselves out",
            feedback:
              "The gift/ticket split exists precisely to catch this BEFORE commit. Committing blind risks importing the wrong thing as the wrong thing.",
          },
          {
            text: "Stop, check the source file's rowType column, and re-paste with it fixed before committing anything",
            correct: true,
            feedback:
              "Right — a lopsided split like this usually means the export's rows were misclassified (e.g. a ticket-sales file pasted in as if it were all giving). Preview is free; use it.",
          },
          {
            text: "Manually delete the 3 gift rows so only tickets import",
            feedback:
              "That throws away real data instead of fixing the actual problem — the rowType column upstream.",
          },
          {
            text: "Include the suspected duplicates to make the gift count look right",
            feedback:
              "Suspected-duplicates and a rowType mismatch are unrelated problems — that toggle doesn't fix a misclassified export.",
          },
        ],
      },
    ],
    quiz: [
      {
        prompt: "What determines whether an imported row creates a donor, or just a contact?",
        options: [
          "The dollar amount on the row",
          "Its rowType — only `gift` and `recurring` ever create a donor; `ticket` always becomes a contact, never a donor",
          "Whichever the importer guesses is more likely",
          "All rows create a donor by default",
        ],
        answerIndex: 1,
        explanation:
          "Classification, not amount or guesswork, is the rule — a ticket buyer got something of equal value back (a seat), so that row can never become a gift.",
      },
      {
        prompt: "What happens BEFORE any import can write data?",
        options: [
          "Nothing — commit runs immediately",
          "A read-only preview: a disposition per row, plus a summary with the gift/ticket row-count split",
          "An email confirmation to the donor",
          "A manual finance sign-off",
        ],
        answerIndex: 1,
        explanation:
          "Preview-then-commit is the whole safety model — the split in the summary is exactly what catches a misclassified export before it pollutes the CRM.",
      },
      {
        prompt: "A gift row has no transaction id, but matches an existing donor's amount and date within 24 hours. What's its disposition, and what happens on commit?",
        options: [
          "\"new\" — it always imports",
          "\"suspected-duplicate\" — skipped on commit unless explicitly included",
          "\"invalid\" — the row is rejected outright",
          "It's silently merged into the existing gift",
        ],
        answerIndex: 1,
        explanation:
          "Without a hard transaction id to trust, the 24-hour/same-amount heuristic flags a likely accidental double-entry for a human to confirm, rather than either blocking it forever or importing it blind.",
      },
      {
        prompt: "What does a `recurring` import row create?",
        options: [
          "An active Stripe subscription immediately",
          "A donor (match-or-create) plus a pledge in the same \"awaiting re-signup\" past_due state the backer-model course teaches — it does not count as a backer yet",
          "A one-time gift only",
          "Nothing — recurring rows aren't supported",
        ],
        answerIndex: 1,
        explanation:
          "Same honest shape as the dedicated recurring-cutover tool it replaced: the pledge is real, but it isn't collecting on our rails until the donor re-signs up.",
      },
    ],
  },

  // ── 89 · The backer model: the $50 floor and the ladder ─────────────────
  {
    slug: "dev-backer-floor-and-ladder",
    title: "The $50 floor, and the milestone ladder",
    subtitle: "What makes a donor a backer, and what backers unlock",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "A pledge can start as low as $20/month — but only a pledge at or above $50/month makes its donor a BACKER. Below that floor, they're a valued recurring donor; they just don't count toward a chapter's tier the way a full backer does.",
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
        text: "Those thresholds aren't hardcoded law — they live in an editable table the development director can adjust: relabel a rung, change its threshold, rewrite its commitment. If the table's ever empty, the system quietly falls back to the built-in defaults, so nothing ever breaks from an unconfigured ladder.",
      },
      {
        kind: "bullets",
        items: [
          "**Headcount, not dollars.** A chapter's tier is set by how many BACKERS it has, not how much money they collectively give — the same principle the finance side teaches for the operating model.",
          "**Public, once the map ships.** The ladder is meant to render as promises with visible progress on a city's own page: \"17 of 20 backers — 3 more unlocks monthly WWS.\" That page isn't live yet (see the last lesson in this course), but the ladder itself is real and editable today.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A donor pledges $20/month to a chapter. Do they count toward that chapter's backer milestones?",
        answer:
          "No — they're a real, valued donor with an active recurring pledge, but the backer count only includes pledges at or above the $50 floor. Their gift still shows up in giving history every month; it just doesn't move the chapter's tier.",
      },
    ],
    quiz: [
      {
        prompt: "What's the minimum monthly pledge amount that makes someone a BACKER?",
        options: ["$20", "$50", "$100", "There is no minimum"],
        answerIndex: 1,
        explanation:
          "$50/month is the floor — pledges below that are real recurring gifts, just not backer-count gifts.",
      },
      {
        prompt: "Who can edit the milestone ladder's thresholds and labels?",
        options: [
          "Nobody — the numbers are fixed in code forever",
          "The development director, at their discretion",
          "Any donor can vote on changes",
          "Only a superuser, and only once",
        ],
        answerIndex: 1,
        explanation:
          "The ladder is explicitly editable — a stated product requirement, not an oversight — so the development director can tune it as the mission's needs change.",
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
          "The fallback is deliberate insurance — an empty config table never takes down the affordability math finance relies on.",
      },
      {
        prompt: "What does a chapter's tier get set by?",
        options: [
          "Total dollars pledged per month",
          "Backer headcount — how many people, not how much money",
          "How many events the chapter has run",
          "How long the chapter has existed",
        ],
        answerIndex: 1,
        explanation:
          "Headcount, not dollars, drives the tier — consistent with the same principle taught on the finance side of the house.",
      },
    ],
  },

  // ── 90 · The backer model: lifecycle and self-serve billing ─────────────
  {
    slug: "dev-backer-lifecycle",
    title: "A backer's lifecycle: subscribe, pay, sometimes falter",
    subtitle: "incomplete → active → past_due → canceled, and who does what",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Backing runs on our own Stripe rails now, not Givebutter's — becoming a backer means a real recurring subscription, and every stage of its life is driven by Stripe events, not a person clicking buttons.",
      },
      {
        kind: "table",
        headers: ["Status", "What it means"],
        rows: [
          ["Incomplete", "Pledge created, checkout not finished yet"],
          ["Active", "Subscription is live and paying"],
          ["Past due", "A billing cycle's payment failed; Stripe is retrying automatically"],
          ["Canceled", "The subscription ended — by the donor, or Stripe giving up on retries"],
        ],
      },
      {
        kind: "rule",
        title: "Each paid cycle is a gift, automatically",
        text: "Every month a subscription successfully charges, one new row lands in that donor's giving history — recurring backing shows up in the CRM exactly like a one-time check, no manual entry required. A chapter's backer count recomputes the instant any pledge's status or amount changes, so it's always current.",
      },
      {
        kind: "tip",
        text: "**Self-serve, always.** A backer manages their own card, changes their pledge amount, or cancels through a Stripe billing-portal link — we never store card numbers or build our own card-management screen. If someone emails asking you to update their card, the answer is the portal link, not a request for their card number.",
      },
      {
        kind: "reveal",
        prompt:
          "A backer's card is declined on their monthly charge. What do you, on the development team, need to do?",
        answer:
          "Nothing, at first — Stripe Smart Retries handles the dunning automatically, and if a retry succeeds the pledge recovers to active on its own. If it never recovers and the subscription eventually gets canceled, the chapter's backer count updates itself the moment that happens. No manual chasing required.",
      },
    ],
    quiz: [
      {
        prompt: "What moves a pledge to \"past_due\"?",
        options: [
          "The Treasurer marking it manually",
          "A billing cycle's payment failing — Stripe's automatic retries then try to recover it",
          "The backer requesting a pause",
          "90 days with no activity",
        ],
        answerIndex: 1,
        explanation:
          "Past_due is a Stripe-driven state — a failed charge, not a person's decision.",
      },
      {
        prompt: "Who chases a backer's failed payment?",
        options: [
          "The chapter director calls them personally every time",
          "Nobody has to — Stripe Smart Retries handles the dunning automatically",
          "The Financial Manager sends a manual invoice",
          "Failed payments are simply written off",
        ],
        answerIndex: 1,
        explanation:
          "This mirrors the finance side's card-lock philosophy: the system does the routine chasing so people spend their attention on real relationships instead.",
      },
      {
        prompt: "How does a backer update their card or change their pledge amount?",
        options: [
          "They email their card number to the development team",
          "Through a self-serve Stripe billing-portal link — we never store card data or build our own UI for it",
          "They have to cancel and create a brand-new pledge",
          "Only a superuser can make that change",
        ],
        answerIndex: 1,
        explanation:
          "Self-serve via Stripe's own portal is the whole point — no card data ever touches our systems.",
      },
      {
        prompt: "When does a paid billing cycle show up in a donor's giving history?",
        options: [
          "Never — recurring giving isn't tracked as gifts",
          "Automatically — one gift row is written for every successful cycle, the moment it's paid",
          "Only if someone manually records it afterward",
          "Once a year, in a batch",
        ],
        answerIndex: 1,
        explanation:
          "Recurring giving is real giving history — it lands in the CRM the same way any other gift does, without anyone typing it in.",
      },
    ],
  },

  // ── 91 · The backer model: the Givebutter migration ─────────────────────
  {
    slug: "dev-givebutter-migration",
    title: "The Givebutter migration: history in, recurring gifts re-signed",
    subtitle: "Two very different imports for one-time history and monthly gifts",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Public Worship is exiting Givebutter entirely, and moving a monthly donor is genuinely harder than moving a one-time gift's history — their card lives inside Givebutter's own Stripe account, and there's no way to reach in and move it for them.",
      },
      {
        kind: "bullets",
        items: [
          "**One-time and past history** — the canonical import's `gift` rows bring in donors and their past gifts, exactly like the earlier lesson's preview-then-commit flow. Because a Givebutter export mixes ticket sales in with real giving, the SAME file's ticket-purchase rows import as `ticket` rows instead — contacts with purchase history, never donors, so the migration itself can't accidentally inflate the donor CRM.",
          "**Recurring donors** — the canonical import's `recurring` rows, but they CANNOT be auto-ported onto our billing. Each one needs a personal re-signup ask: send them their city's page, they subscribe fresh on our rails.",
        ],
      },
      {
        kind: "rule",
        title: "Imported recurring pledges start past_due, on purpose",
        text: "An imported Givebutter recurrence lands as a real pledge row, but its status is past_due from day one — honest, because it isn't actually collecting money on our rails yet. That also means it does NOT count toward the chapter's backer number until the donor genuinely re-subscribes; the count only reflects money actually flowing through our own billing.",
      },
      {
        kind: "scenario",
        prompt:
          "You open a donor's record and see \"Imported · awaiting re-signup\" next to their old $50/month pledge. What's the right move?",
        options: [
          {
            text: "Ignore it — the pledge is already in the system, so it's handled",
            feedback:
              "It's tracked, not handled. \"Imported · awaiting re-signup\" means this person hasn't actually resubscribed — their giving has quietly stopped until someone reaches out.",
          },
          {
            text: "Send them a personal message with a link to their city's page, asking them to re-subscribe",
            correct: true,
            feedback:
              "Right — this is a relationship touch, not a mass blast. A former monthly donor deserves a real, personal ask to come back onto our rails.",
          },
          {
            text: "Add a blast-audience segment and email every imported donor the same template",
            feedback:
              "The playbook is explicit that this is relationship work, not a blast — a personal re-signup ask, not a form email.",
          },
          {
            text: "Delete the row since it's not collecting money",
            feedback:
              "Never delete it — it's the honest record of a real relationship that just needs a re-signup, and it's what the cutover dashboard tracks progress against.",
          },
        ],
      },
    ],
    quiz: [
      {
        prompt: "Why can't a Givebutter recurring donor be automatically ported onto our own billing?",
        options: [
          "It's a policy choice, not a technical one",
          "Their card lives inside Givebutter's own Stripe account — there's no way to move card data that isn't ours",
          "Recurring donors aren't allowed to move platforms",
          "Only one-time donors are eligible for import",
        ],
        answerIndex: 1,
        explanation:
          "Card data is genuinely locked inside Givebutter's Stripe — the fix is a fresh, real subscription on our own rails, not a data migration.",
      },
      {
        prompt: "What status does an imported Givebutter recurring pledge start at?",
        options: ["Active", "Incomplete", "Past_due", "Canceled"],
        answerIndex: 2,
        explanation:
          "Past_due is the honest starting state — the relationship is real, but it isn't collecting on our rails yet.",
      },
      {
        prompt: "Does an imported recurring pledge count toward the chapter's backer number before the donor re-signs up?",
        options: [
          "Yes, immediately",
          "No — only pledges actually active on our own rails count toward backers",
          "Only if the amount was above $100",
          "Only central decides case by case",
        ],
        answerIndex: 1,
        explanation:
          "The backer count stays truthful to real, collecting pledges — an imported row waits until the donor genuinely resubscribes.",
      },
      {
        prompt: "What's the right way to ask an imported recurring donor to move over?",
        options: [
          "A single mass email blast to everyone imported",
          "A personal outreach with a link to their city's page — a relationship touch, not a blast",
          "No outreach — wait for them to notice on their own",
          "A phone call is required for every donor, no exceptions",
        ],
        answerIndex: 1,
        explanation:
          "This is explicitly framed as the development team's relationship workflow, not a mass communication — the same care as any other personal donor touch.",
      },
    ],
  },

  // ── 92 · Sponsorships: package tiers ─────────────────────────────────────
  {
    slug: "dev-sponsor-packages",
    title: "Sponsor packages: benefits we give, commitments we keep",
    subtitle: "Dev-director-authored tiers, not hardcoded prices",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "A sponsor package (\"LTN Gold\") is an editable tier the development director defines: a name, a tier rank, who it targets (church, business, or any), a price (one-time, monthly, or annual), and what it attaches to (a single event, a season, or a full year).",
      },
      {
        kind: "rule",
        title: "Every package lists two things, not one",
        text: "A package needs at least one BENEFIT (what the sponsor gets — logo on flyers, a joint social post, a Sunday-announcement mention) AND at least one COMMITMENT (what WE promise to deliver at that tier). A pitch built from a package is a real two-way agreement from the start, never just a price sheet.",
      },
      {
        kind: "bullets",
        items: [
          "**Editable rows, not constants.** Packages are authored and revised in-app, the same pattern as templated roles elsewhere — refined as real pitches teach the dev team what actually lands.",
          "**Deactivate, don't delete.** Retiring an old package keeps every existing sponsorship's reference to it intact — nothing that already signed on that tier breaks.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "The development director retires an old package after three churches already signed under it. What happens to those three agreements?",
        answer:
          "Nothing changes for them — deactivating a package hides it from new pitches but keeps existing sponsorships' reference to it valid. Their agreement, benefits, and commitments stay exactly as signed.",
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
          "Both lists are required so a package always reads as a real two-way deal — never a one-sided price list.",
      },
      {
        prompt: "Who authors and edits sponsor packages?",
        options: [
          "They're hardcoded and can never change",
          "The development director — packages are editable rows, refined as pitches teach what works",
          "Any chapter director for their own chapter",
          "A central committee vote",
        ],
        answerIndex: 1,
        explanation:
          "Packages are dev-director-authored config, meant to be revised as real-world pitches show what resonates.",
      },
      {
        prompt: "What happens when a package is deactivated?",
        options: [
          "Every sponsorship using it is automatically canceled",
          "It's hidden from new pitches but existing sponsorships keep their valid reference to it",
          "It's permanently deleted, including the history",
          "Nothing — deactivation has no real effect",
        ],
        answerIndex: 1,
        explanation:
          "Soft-deactivation protects history: an old tier can retire without breaking any agreement already built on it.",
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
          "A package's audience is church, business, or any — foundations can still hold a sponsorship agreement, just not as a package's targeted audience.",
      },
    ],
  },

  // ── 93 · Sponsorships: the pipeline ──────────────────────────────────────
  {
    slug: "dev-sponsorship-pipeline",
    title: "The pipeline: prospect to active partner",
    subtitle: "Five open stages, one auto-advance, and the OKR surface",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "A sponsorship is one organization — a church, a business, or a foundation, never an individual — matched to one package. That single agreement moves through a pipeline the dev team actually works: prospect, pitched, committed, active, with lapsed and declined as the closed outcomes.",
      },
      {
        kind: "table",
        headers: ["Stage", "Meaning"],
        rows: [
          ["Prospect", "On the radar, no pitch sent yet"],
          ["Pitched", "A package has been proposed"],
          ["Committed", "A verbal or written yes — not yet paying"],
          ["Active", "Actually paying — the partnership has truly started"],
          ["Lapsed / Declined", "Closed — didn't renew, or said no"],
        ],
      },
      {
        kind: "rule",
        title: "First dollar, not first handshake, moves committed to active",
        text: "A \"committed\" agreement automatically flips to \"active\" the moment its FIRST payment lands — a yes on paper becomes real the instant money actually arrives. Every other stage move (prospect → pitched, or closing an agreement out) is a deliberate choice someone makes, not an automatic side effect of a gift landing.",
      },
      {
        kind: "reveal",
        prompt:
          "A church still in \"prospect\" stage makes a surprise one-time gift before any formal pitch. Does that jump them straight to \"active\"?",
        answer:
          "No — the auto-advance only fires from \"committed.\" A stray gift from prospect or pitched needs someone to deliberately move the stage, so the real sales work (the pitch, the yes) never gets silently skipped over in the pipeline record.",
      },
    ],
    quiz: [
      {
        prompt: "What organization types can hold a sponsorship agreement?",
        options: [
          "Any donor, including individuals",
          "Church, business, or foundation — individuals are rejected",
          "Only churches",
          "Only businesses",
        ],
        answerIndex: 1,
        explanation:
          "Sponsorships are institutional by design — the write path explicitly rejects an individual donor.",
      },
      {
        prompt: "What automatically moves a \"committed\" agreement to \"active\"?",
        options: [
          "30 days passing with no change",
          "Its first payment actually landing",
          "The development director manually approving it",
          "The agreement's start date arriving",
        ],
        answerIndex: 1,
        explanation:
          "Money actually arriving is the real-world signal the partnership has started — not a promise, an actual gift.",
      },
      {
        prompt: "Is the sponsorship pipeline visible to a chapter-only Giving-desk user?",
        options: [
          "Yes, every chapter sees its own pipeline",
          "No — it's a central-lens desk; a chapter-only caller sees an access-needed state",
          "Only the chapter director sees it",
          "Only during launch week",
        ],
        answerIndex: 1,
        explanation:
          "Sponsorships are the dev team's central OKR surface — packages and the pipeline live at the org level, not per chapter.",
      },
      {
        prompt: "A prospect church sends a surprise gift before any formal pitch. What happens to their pipeline stage?",
        options: [
          "It jumps straight to active",
          "It stays put — the auto-advance only fires from \"committed\"; moving it needs a deliberate choice",
          "The gift is rejected until they're committed",
          "It resets back to prospect",
        ],
        answerIndex: 1,
        explanation:
          "Auto-advance is scoped narrowly on purpose, so the real pitch-and-commit work in the pipeline is never quietly skipped.",
      },
    ],
  },

  // ── 94 · Sponsorships: church partnerships ───────────────────────────────
  {
    slug: "dev-church-partnerships",
    title: "Church partnerships: two-sided, not transactional",
    subtitle: "Due diligence, a real relationship, and the lighter QR option",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "A church partnership isn't a transactional referral fee — it's meant to be a deep, ongoing relationship between Public Worship and a local congregation's leadership, built on genuine trust before it's built on a signed package.",
      },
      {
        kind: "bullets",
        items: [
          "**Due diligence, tracked honestly.** A church agreement carries notes on the relationship's foundation — things like a statement of beliefs, the pastor relationship, having actually visited a service — kept right on the agreement record.",
          "**A named owner and a next touchpoint.** Like a donor relationship, a sponsorship carries its own owner and a next-touchpoint date — a partnership stays alive because someone's actively tending it, not because a contract exists.",
        ],
      },
      {
        kind: "rule",
        title: "Not every church touch is a sponsorship",
        text: "A pastor offering a Sunday announcement plus a shareable QR code pointing to the chapter's page is NOT a sponsorship agreement — it's just their congregation reaching the backer page through an attributable link. Save the formal package + pipeline for a real institutional commitment; the lighter option needs no agreement record at all.",
      },
      {
        kind: "reveal",
        prompt:
          "A pastor says, \"We'll do a Sunday announcement and share a QR code, but we're not ready for a formal package.\" Is that a sponsorship?",
        answer:
          "No. That's the lighter, no-agreement option — their congregation reaches the city's backer page through a shareable, attributable link. Track the relationship as a note and a next touchpoint if you want to keep building toward a real partnership later, but don't force it into the pipeline before it's ready.",
      },
    ],
    quiz: [
      {
        prompt: "What does a church sponsorship's due-diligence field track?",
        options: [
          "Only the price they agreed to pay",
          "The relationship's foundation — things like a statement of beliefs, the pastor relationship, having visited a service",
          "The chapter's own budget",
          "Nothing — due diligence isn't tracked",
        ],
        answerIndex: 1,
        explanation:
          "Due diligence is about the trust behind the relationship, not the money — it's what makes a church partnership deliberate rather than transactional.",
      },
      {
        prompt: "A pastor offers a Sunday announcement and a QR code, with no formal package. What's the right classification?",
        options: [
          "A sponsorship at the lowest tier",
          "Not a sponsorship at all — a lighter, attributable-link option that needs no agreement record",
          "An automatic \"prospect\" pipeline entry",
          "It can't be tracked in the system",
        ],
        answerIndex: 1,
        explanation:
          "The QR/announcement option is deliberately outside the sponsorship pipeline — a real institutional partnership is a separate, deeper commitment.",
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
          "The owner + next-touchpoint fields exist precisely so a church relationship stays actively tended, not signed once and forgotten.",
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
        text: "Every backer's gift does double duty: 85% stays with their own chapter to run the mission locally, and a flat 15% moves — every month, as a real transfer — into central's City Launch Fund. That fund is what seeds the NEXT city when it's ready to launch.",
      },
      {
        kind: "rule",
        title: "The giving side of a story the Finance stream also teaches",
        text: "The mechanics — the flat 15% skim, the fund's balance, the launch grant it eventually pays — are covered in full in the Finance stream's \"Tiers, the covenant, and the skim\" lesson. Here, the point is what it means for backers: their monthly gift to one city is quietly helping the network open its next one, too.",
      },
      {
        kind: "bullets",
        items: [
          "**Transparency, by design.** Backers are meant to be able to see this story — where their 85% goes locally, and where their 15% goes network-wide — not just trust it happens behind the scenes.",
          "**A launch grant, one time.** The City Launch Fund's balance eventually pays a new chapter's one-time launch cost — equipment and the training trip — the moment that new city is ready.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A backer asks why their $50/month doesn't all stay with the chapter they actually attend. What do you tell them?",
        answer:
          "85% of it does — that's what runs their own chapter's mission day to day. The other 15% is a deliberate, flat contribution every chapter makes into the City Launch Fund, so the network can open its next city. Their gift funds both the place they know and the place that doesn't exist yet.",
      },
    ],
    quiz: [
      {
        prompt: "What percentage of a chapter's backer revenue moves to the City Launch Fund each month?",
        options: ["0%", "A flat 15%", "50%", "It varies by chapter"],
        answerIndex: 1,
        explanation:
          "Every chapter contributes the same flat 15%, regardless of size — the same rule the Finance stream teaches from the chapter's side.",
      },
      {
        prompt: "What does the City Launch Fund ultimately pay for?",
        options: [
          "Ongoing chapter operating costs",
          "A new city's one-time launch cost — equipment and the training trip",
          "Reimbursements to individual backers",
          "Marketing campaigns",
        ],
        answerIndex: 1,
        explanation:
          "It's a one-time seeding fund for the network's NEXT city, not a recurring operating budget.",
      },
      {
        prompt: "Why should a backer be able to see the 85/15 split, not just be told it exists?",
        options: [
          "It's a legal disclosure requirement",
          "Transparency is part of the giving relationship — donors can see what their giving actually unlocks, locally and network-wide",
          "It doesn't matter whether they see it",
          "Only central donors get to see the split",
        ],
        answerIndex: 1,
        explanation:
          "Showing the split (eventually on each city's own page) is the transparency principle this whole platform is built around.",
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
        text: "A prospect territory is a place — \"Columbus, OH\", \"Queens\" — that's raising backers toward opening a chapter. Here's the part that's easy to miss: a territory isn't a placeholder floating outside the system. The moment central adds one, a real chapter is created for it behind the scenes — an inactive \"shadow chapter\". Central or a development-director-level holder is who stands one up.",
      },
      {
        kind: "bullets",
        items: [
          "**Same milestone ladder, public.** A prospect territory's `/give/<slug>` page shows the exact same milestone ladder as a live chapter, framed as visible progress: \"17 of 20 backers — 3 more unlocks monthly Worship With Strangers in Columbus.\"",
          "**Shareable by design.** A backer campaign is meant to be forwarded — \"already 3 backers here, help get it to 20\" — with no donor's personal information ever exposed publicly.",
          "**Launch is a flip, not a move.** Because backers, donors, and gifts scope DIRECTLY to the (shadow) chapter from their very first pledge, launching a territory doesn't move anyone's money anywhere. It simply flips that chapter live and provisions its banking; the public page keeps showing the same backer count, now on an officially-open chapter.",
        ],
      },
      {
        kind: "rule",
        title: "Belief comes before the building",
        text: "A prospect territory exists precisely so people can back a place before it has staff, a venue, or a launch date. And because it's a real (if dormant) chapter from the start, every backer counts toward it from day one — the backer campaign IS the proof a place is ready, not a marketing afterthought once it already is.",
      },
      {
        kind: "tip",
        text: "**Live now: the public `/give` map.** The map plots every publicly-visible territory, and each `/give/<slug>` page carries the milestone ladder, a progress bar, and a become-a-backer form — preset $20 / $50 / $100 or a custom monthly amount — that starts a real Stripe subscription. A territory shows publicly only once an admin marks it visible, so central can stage one before announcing it. The map is aggregates-only: it never exposes a donor's name or contact details.",
      },
      {
        kind: "reveal",
        prompt:
          "A prospect territory's backer campaign hits its launch target. What actually happens to its backers?",
        answer:
          "Nothing moves — and that's the point. The territory was a real (inactive) chapter all along, and its backers, donors, and gifts were scoped to that chapter from their very first pledge. Launching just flips the chapter live and provisions its banking; the same backers are now its founding supporters on an officially-open chapter.",
      },
    ],
    quiz: [
      {
        prompt: "What is a \"prospect territory\"?",
        options: [
          "Any place with an existing, active chapter",
          "A place raising backers toward launch — created as a real but inactive \"shadow chapter\" from day one",
          "A place Public Worship has ruled out",
          "A backup location if a chapter closes",
        ],
        answerIndex: 1,
        explanation:
          "A prospect territory maps 1:1 with a real chapter that simply isn't live yet — so backers, donors, and gifts attach to it directly.",
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
          "Adding a territory to the map is a deliberate, gated move — not something any member triggers casually.",
      },
      {
        prompt: "Is the public `/give` map live today?",
        options: [
          "Yes — the map and each territory's `/give/<slug>` page, with a become-a-backer flow, are live",
          "No, it's still being built for a later release",
          "Only central users can see it",
          "It goes live only after a territory launches",
        ],
        answerIndex: 0,
        explanation:
          "The map, the per-territory pages, and the Stripe-backed become-a-backer flow all shipped — a territory shows publicly once an admin marks it visible.",
      },
      {
        prompt: "What happens to a prospect territory's backers the moment it launches into a live chapter?",
        options: [
          "Their pledges are canceled and they must re-subscribe",
          "Nothing moves — they were scoped to the chapter all along; launch just flips that chapter live and provisions its banking",
          "They stay attached to a separate prospect record forever",
          "They're deleted and nothing is tracked",
        ],
        answerIndex: 1,
        explanation:
          "A territory is a real chapter from creation, so backers scope directly to it — launch flips `isActive` and provisions banking, without re-scoping anyone.",
      },
    ],
  },
];

/** The Development stream's theme entry. */
export const DEVELOPMENT_THEME: Theme = {
  key: "development",
  title: "Development",
  subtitle:
    "Donors, backers, and sponsors — and how giving funds the next city.",
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
      "The vocabulary every development-desk holder needs — donor, gift, " +
      "backer, sponsor, prospect territory — and a tour of the donor CRM: " +
      "statuses, the 90-day lapse rule, and the top-donor dashboard.",
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
      "Running real relationships through the CRM: owners, notes, the " +
      "top-donor workflow, and getting giving history — old and new — " +
      "onto the record via CSV import and manual backfill.",
    icon: "users",
    moduleSlugs: ["dev-relationship-workflow", "dev-import-and-backfill"],
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
      "the prospect-to-active pipeline, and church partnership principles — " +
      "due diligence and real relationship over transactional referral.",
    icon: "briefcase",
    moduleSlugs: [
      "dev-sponsor-packages",
      "dev-sponsorship-pipeline",
      "dev-church-partnerships",
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
      "the prospect-territory/backer-campaign story and the live public `/give` " +
      "map — including what launch does (flip the shadow chapter live) and " +
      "doesn't (move anyone's money).",
    icon: "map",
    moduleSlugs: [
      "dev-city-launch-economics",
      "dev-prospect-cities-and-map",
    ],
  },
];
