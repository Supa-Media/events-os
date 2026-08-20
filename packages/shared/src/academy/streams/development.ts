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
 * too, not just giving ones. The founder grant (2026-07-31) that turns on
 * the `data.export` capability lands SIX seats (`SEAT_CAPABILITIES` in
 * `packages/shared/src/seats.ts`), but only one of those six —
 * `development_director` — has a role path that ever reaches this stream, so
 * its lesson does NOT live here. It lives as `foundations-data-export` in
 * `streams/foundations.ts`'s "how-we-work" course instead: the one course
 * every one of the six role paths (`packages/shared/src/academyPaths.ts`)
 * actually shares, alongside `welcome-to-public-worship` and
 * `finances-for-everyone`.
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
          "**Prospect territory** — a place on the map raising backers toward opening a chapter. Under the hood it's already a real chapter, just an inactive one (a \"shadow chapter\") — so backers attach to it directly from day one, before it's officially live. **\"Territory\" is an inside word:** in public we call it a CITY (see the rule below).",
        ],
      },
      {
        kind: "rule",
        title: "In public it's a city, never a territory",
        text: "The desk, the schema, and this Academy say *territory*, because that's what the record is: a place with a slug, a map dot, and a shadow chapter behind it. The public never sees that word. Everything a donor reads — the giving page's \"Back a city\", the city cards, the emails, the ask you make out loud — says **city**. Nobody outside knows what a territory is, and a supporter who has to learn our filing vocabulary before they can give is a supporter we made work for it.",
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
          "Only donations made through an RSVP page count",
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
      {
        prompt: "You're writing the copy for a public post asking people to support Columbus. Which word do you use for Columbus?",
        options: [
          "\"Territory\" — it's the precise term, so it's the honest one",
          "\"City\" — territory is our internal word for the record; the public ask always says city",
          "\"Shadow chapter,\" so nobody thinks it's already open",
          "Either — the two are used interchangeably in public",
        ],
        answerIndex: 1,
        explanation:
          "Precision inside, plain language outside. \"Territory\" names the record (slug, map dot, shadow chapter) and belongs on the desk; every public surface — \"Back a city\", the city cards, your ask — says CITY.",
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
        text: "The Giving desk's Dashboard opens to what your reach covers. A chapter viewer (a chapter director or treasurer) sees their own chapter's numbers: lifetime giving, giving in the last 30 days, total donors, and how many have lapsed — then their top donors by lifetime giving, the same ordering the relationship workflow runs on, on day one, with no extra setup.",
      },
      {
        kind: "p",
        text: "A central holder (a development director or the ED) instead opens to the org-wide FLEET: those same rollups summed across every chapter, a \"needs your attention\" rail (chapters with lapsed donors to reactivate, and chapters whose backers sit below their territory goal), and a card for Central's own book plus one per chapter. Tapping a card drops the whole desk into that chapter so you can work it, then step back out to the fleet. On the Donors list, a central holder also gets a scope dropdown — All chapters, Central, or any single chapter — where \"All chapters\" browses every scope's donors in one lifetime-sorted list, each row tagged with its chapter. A chapter viewer never sees the fleet or the scope dropdown; they stay on their own chapter.",
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
        text: "**The giving desk isn't the only place a donor shows up.** A chapter-scope donor who's also on the roster gets a small mark right on the People tab — a heart for a giver, plus a building icon if they're also an active backer — so anyone looking up a volunteer or team member can see the giving relationship without switching desks. The roster deliberately shows icons only, never a dollar amount; tap the mark to jump to the donor's giving-desk record for the actual numbers. Only donors who've actually GIVEN get the mark (giftCount > 0); a prospect with no gift yet, or a contact who only ever bought an event ticket, never shows one — ticket buyers aren't donors (see the import lesson later in this course). A donor with NO existing roster match still gets a minimal roster row auto-created to carry the link — but that row is a CONTACT, not a volunteer, so it's findable under the People tab's \"Contacts\" filter, not on the Team segment the tab opens to by default (the People tab lists everyone; Team/Volunteers/Vendors/Guests/Contacts are just filters over that one list). The heart still only ever shows on a REAL person (a volunteer, vendor, or team member) or under that Contacts filter — never invented on someone who never actually engaged.",
      },
      {
        kind: "tip",
        text: "**A wrong donor↔person link is fixable, not permanent.** A merge, a bad auto-match, or an import can leave a donor pointing at the wrong roster person (or nobody at all). From the donor's own detail screen, staff with Giving-desk Manage power can \"Link to person\" (search the roster), or — once linked — \"Change\" to re-point it or \"Unlink\" to clear it. A central donor is CRM-only and never links to a chapter roster person at all, so that control only shows up on a chapter-scope donor.",
      },
      {
        kind: "rule",
        title: "Who can open the Giving desk is a per-role power",
        text: "Access to the Giving desk isn't wired to a job title in code — it's a POWER the Executive Director assigns to a seat, right from the org chart. Each seat can be set to None, View (see donors, history, and dashboards), or Manage (also record gifts, edit donors, and import). Out of the box the Development Director and Executive Director can Manage; the Development associates (Partnership & Fundraising), the Financial Manager and Expansion Director (central), and the Chapter Director and Treasurer (their own chapter) can View. The ED can retune any seat at any time — so if you can't see the desk and think you should, that's an org-chart power to grant, not a bug.",
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
      {
        prompt: "Who decides which roles can open the Giving desk?",
        options: [
          "It's hardcoded to the Development Director and can never change",
          "The Executive Director — giving access is a per-seat power (None / View / Manage) assigned from the org chart",
          "Every signed-in member can always see it",
          "Only a superuser, by editing the database directly",
        ],
        answerIndex: 1,
        explanation:
          "Giving access is an assignable power on each org-chart seat, not a fixed title — the ED sets a seat to None, View, or Manage and can change it at any time.",
      },
    ],
  },

  // ── 87 · Donor stewardship: the relationship workflow ───────────────────
  {
    slug: "dev-relationship-workflow",
    title: "Owners, notes, and the top-donor list",
    subtitle: "Every donor gets a name attached — and a personal thank-you",
    minutes: 6,
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
      {
        kind: "rule",
        title: "Bulk email goes out through Mailchimp",
        text: "**Read this before the lessons that follow.** Public Worship's newsletters and announcements are SENT FROM MAILCHIMP, not from this app. The in-app Emails desk still exists and everything below still describes it accurately — but it is parked, hidden from the sidebar, and nobody should start a new send there. We moved because of what surrounds the tool rather than the tool itself: design pasted in from Canva keeps its formatting, opens and clicks are actually tracked, and there is a whole ecosystem of templates and signup forms we were never going to build. What THIS app does now is keep Mailchimp's list honest — every night it pushes the roster onto the Mailchimp audience, tagged with chapter, backer standing, and role so you can segment over there. Two things follow, and they matter: an unsubscribe in Mailchimp flows straight back here and silences EVERY other email too, including event blasts; and a person who is marked marketing-opted-out here, or whose address is on the suppression list, never reaches Mailchimp in the first place. The consent rules you learn below are still the real rules — they are just enforced on the way OUT the door now.",
      },
      {
        kind: "rule",
        title: "The approval habit survives the tool change",
        text: "Mailchimp will happily let one person write a mass email and press send. This app would not — it required a SECOND person's sign-off, a reviewer chosen by name who could never be the writer, even when the writer was the Executive Director. That rule was never really about the software; it was about what it costs the org when something goes to a few hundred people with the wrong number, the wrong tone, or the wrong name in it. **It still applies.** Before anything goes out of Mailchimp, a second Compose/Approve holder reads it — the same separation of duties that governs reimbursements, budgets, and card spend. The difference is that nothing enforces it for you any more, which makes it a discipline rather than a gate. If you find yourself about to send something nobody else has read, that is the moment the rule exists for.",
      },
      {
        kind: "rule",
        title: "A personal thank-you and a bulk email are different tools",
        text: "Notes and a personal thank-you are ONE-TO-ONE — you, this donor, this relationship. A bulk email (the Emails desk) is ONE-TO-MANY — one write-up, a segment of many. Because one email reaches a lot of people at once, it always needs a SECOND person's sign-off before it sends: the writer picks a reviewer from a dropdown of Compose/Approve-holders (never themselves), and that reviewer alone can approve it, request changes, or reject it — even when the writer is the Executive Director. Emails-desk access is a per-role power the ED assigns from the org chart, the same mechanism as the Giving-desk power above, and it comes in three rungs: **Design** opens the desk and owns the shared look — the saved templates every email starts from, plus the image library — but can never send; **Compose** adds drafting, submitting, and sending once approved; **Approve** adds being someone else's reviewer. Each rung includes the ones below it. Out of the box the ED, Financial Manager, and Marketing Director hold Approve, and the Graphic Designer and Social Media Manager hold Design — the people who actually build the newsletter own the templates that shape it, without anyone gaining the power to send on their own.",
      },
      {
        kind: "rule",
        title: "A segment is rule groups, exclusions, and hand-picks — and it's always live",
        text: "An email's SEGMENT is built from RULE GROUPS of plain-sentence conditions. (Segment is the industry word — the same thing Mailchimp and Klaviyo call one, so what you learn here transfers.) Someone gets the email if they match ANY one rule group; inside a group, every line must be true (\"Donor · is · a donor\" and also \"Events · has never been to · any event\"). Saying who's OUT is just as easy as who's in — every line can flip to its negative (\"is not\", \"has never been to\"), so \"all donors who have never been to an event\" is one rule group, exactly as you'd say it out loud. Want to widen the segment instead? Add another rule group — \"or anyone who gave $100+\" is a second group, not a rewrite of the first. EXCLUSIONS sit below the rule groups: anyone matching one is removed no matter what, even someone you hand-picked into the include list (an explicit exclusion always beats a manual include). Two exclusions are either/or, the same way rule groups are — matching either one leaves you out. Hand-picks still work both ways — search a person to always include or always exclude them. Segments are LIVE — someone who starts matching a rule group tomorrow (a new donor crosses a giving threshold, a guest RSVPs) is included automatically the next time the segment is used, and someone who starts matching an exclusion is dropped automatically too. A plain-English recap above the builder reads your segment back to you as a sentence, each group card shows its own live count, and the \"Check a person\" box explains any individual line by line — every condition gets a ✓ or ✗, then the final answer. One thing hand-picking can NEVER do, on either side: override consent. If a person has unsubscribed (their address is suppressed) or opted out of marketing, they're excluded even if you explicitly added them to the include list — the preview always shows exactly who was dropped and why.",
      },
      {
        kind: "rule",
        title: "You build the email in the document itself",
        text: "The composer is the DOCUMENT, not a form beside one. Subject line and Preview text sit inline at the very top of the page — the first two things you see, not a settings panel you have to go find. Click into any text and keep typing right where it'll actually sit; select something and a FLOATING TOOLBAR appears right above your selection, offering exactly what applies to what you picked and nothing else. Between any two blocks, a `+` in the left-hand gutter inserts a new one where you're pointing; the same gutter is what you drag to reorder a block up or down the page. Next to the document sits the PREVIEW, the same email rendered the way a real mail app will render it. On a wide screen you keep both in view: the document is where you edit, the preview is the honest answer about what a person opening this in Gmail will see.",
      },
      {
        kind: "rule",
        title: "Start from the template, don't restyle from scratch",
        text: "There's no Themes tab anymore — Emails → Themes is gone, and so is the idea of one shared brand file every block quietly inherited from. Styling now lives PER-ELEMENT, right on the document, Google-Docs style: select a block and its toolbar can genuinely offer colour, same as size or alignment. That's real freedom, and it means the old promise — \"no single email can drift off-brand\" — isn't enforced by the tool anymore. What still protects the brand is a habit, not a lock: START FROM A TEMPLATE instead of a blank page. A template is nothing but a saved email with the styling already right, so duplicating one carries its look with it automatically. When the brand moves — a new accent colour, a new season — you fix it in the TEMPLATES people start from (the built-in newsletter, or one you saved yourself), not by hunting down every email that might get reused. Build every send from a blank page and the brand is only as consistent as whoever built it that day; start from the template and the look comes along for free.",
      },
      {
        kind: "rule",
        title: "Editing lives in the browser — the preview is the truth everywhere else",
        text: "Editing an email is WEB-ONLY, on purpose, not a gap waiting to be closed. Open the same email on a phone and the document itself is READ-ONLY — Subject line and Preview text are the only fields still genuinely editable from a phone, because they're the one thing worth fixing on the go. If a send has to go out and nobody's at a laptop, it waits. What a phone (or the preview pane on the web) IS good for is checking the real thing: dark mode gets a deliberate, automatic background-and-text swap applied to every send, so a recipient reading at night isn't staring down a blinding white card, and a narrow screen is exactly where a layout problem would show up before it ships. The preview is the same honest render either way — footer and all: the unsubscribe link and the org's postal address get injected there at send time, which is why a raw draft in the editor never quite looks \"done\" until you check it in the preview.",
      },
      {
        kind: "reveal",
        prompt:
          "The person who designs the monthly newsletter is away, and this month's issue has to go out Friday. Nobody left is a designer. What now?",
        answer:
          "Start from the TEMPLATE. A template is nothing more than a saved email, and Public Worship's monthly newsletter ships as a built-in one — layout and styling already right. Creating a new email, pick it under \"Start from\": that's a DUPLICATE, a fresh copy with no live link back to the original, so touching it later can't alter the template. Replace the copy and submit it for approval like any other email. Templates exist exactly so a send isn't hostage to one person's calendar: the design decisions were made once, by the designer, and everyone else fills in the words. (Two-party approval still applies — a template is a head start, not a shortcut past the reviewer.) The templates themselves live on **Emails → Templates**, and they're the DESIGNER's to keep sharp: \"New template\" starts a fresh one from a blank page, \"Edit design\" opens any of them in the same document editor an email uses — same click-to-edit, same floating toolbar. Liked how this month's issue turned out? \"Save as template\" from inside any email keeps a copy of it as next month's starting point. That work needs design power, not compose: the person who owns the look never has to be the person who owns a send.",
      },
      {
        kind: "tip",
        text: "**Two more things that save real time.** An email can ask a QUESTION inline — add a poll to the document, type the options straight onto it, and the recipient taps one right in the email and lands on a short confirm page (tapping is not voting; the confirm page is what records it, so a mail scanner prefetching links can't stuff the ballot). It's one vote per recipient, and re-voting CHANGES their answer rather than adding a second one — so the totals are people, not taps. And inserting an image gives you two doors in: upload a new one, or pick from the IMAGE LIBRARY — your reusable illustrations and logos — instead of re-uploading the same graphic into every email.",
      },
      {
        kind: "tip",
        text: "**You can start a segment straight from the People tab.** Check off a handful of people in the roster grid, then \"Email selected\" (visible only to a Compose/Approve holder) drops you into a brand-new segment draft with exactly those people already hand-picked. Nothing sends yet — it's a shortcut past the search-and-add step, not a bypass of the review-and-approve flow above, and every suppression/opt-out rule still applies to a hand-pick that arrives this way, same as one you picked by hand.",
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
        prompt:
          "Someone clicks unsubscribe in a Mailchimp newsletter. What happens to the event blast going out next week?",
        options: [
          "Nothing — Mailchimp and the app keep separate lists",
          "They're dropped from it too — a Mailchimp unsubscribe writes to the app's suppression list, which every send here reads",
          "They're dropped only if an admin manually copies the unsubscribe over",
          "The blast is blocked entirely until someone reviews the unsubscribe",
        ],
        answerIndex: 1,
        explanation:
          "The pull-back is the whole point of the integration: an unsubscribe in Mailchimp lands in the same deployment-wide suppression ledger that event blasts, campaigns, and every other send already consult. One 'stop' means stop everywhere — if it didn't, the app would be the one ignoring a person who asked to be left alone.",
      },
      {
        prompt: "The Executive Director writes a mass email. Who can approve it before it sends?",
        options: [
          "The ED themselves — they hold Compose/Approve power",
          "A DIFFERENT person the ED picks as reviewer (e.g. the Marketing Director) — never themselves",
          "Nobody — the ED can never send a mass email",
          "Any signed-in member, automatically",
        ],
        answerIndex: 1,
        explanation:
          "Two-party approval means an email always needs a DIFFERENT Compose/Approve-holder's sign-off, chosen at submit time — even the ED's own sends need someone else's approval.",
      },
      {
        prompt:
          "You hand-pick someone into an email's segment, but they've unsubscribed from everything we send. What happens?",
        options: [
          "They're excluded — a hand-pick is not consent, suppression always wins",
          "They're included — hand-picking always overrides suppression",
          "The email can't be saved until you remove them",
          "They receive the email, but marked as a bounce afterward",
        ],
        answerIndex: 0,
        explanation:
          "Suppression (and a person's own marketing opt-out) beats BOTH filters and hand-picks — explicitly adding someone to the include list is curation, not consent, and the segment preview shows exactly who was dropped and why.",
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
        kind: "p",
        text: "Don't confuse this with the EVENT attendance import (on an event's public page under Grow → Import attendance). That one only builds a single event's guest list and NEVER creates a donor — it's where a name-only Partiful/spreadsheet/Givebutter guest export lands. Each row it writes also best-effort links to a `people` row exactly like a public RSVP does (match an existing person by email/phone/name, or — only when the row carries an email or phone — spawn a minimal CONTACT row so a repeat guest links to the same person next time); a name-only row simply stays unlinked, same as any other guest with nothing to match on. This canonical import is the money-and-CRM path; the attendance import is the door-list path.",
      },
      {
        kind: "p",
        text: "You usually don't even have to build rowType columns yourself — the paste box recognizes Givebutter's TRANSACTIONS export and asks you to map each campaign to gift / ticket / skip, then classifies every row for you. The full MAILING LIST comes in somewhere else, on purpose: People → Import (the button next to Duplicates) takes a Givebutter CONTACTS export — every row becomes a contact under the People tab's Contacts filter, first and last names kept as Givebutter had them, existing people matched by email, phone, or exact name (never duplicated), and no donors or money history created from it, ever. That split is deliberate: the Giving import is the money path and needs giving access; the People import is roster work and doesn't. Either way, contacts import reachable, and anyone who unsubscribes from a Public Worship email is honored by our own suppression list from then on, no matter what the source platform said.",
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
        kind: "rule",
        title: "Keep the data clean: dedupe first, and no name-only rows",
        text: "Two guardrails keep imports from polluting the roster and CRM. First: a contact or ticket row with NO email AND NO phone creates nothing — it's reported as \"no-identifier\" in the preview, because a name-only record is a guest, not a roster person (names collide constantly and a nameless row can never be safely matched later). Second: before you re-run an import against records that already exist, clean up known duplicates. Merging (People → Duplicates, and the Giving desk's donor duplicates) re-points every reference onto one survivor and recomputes the donor's giving totals, so a later import matches the one real record instead of spawning a second. Dedupe first, then re-import.",
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
      {
        prompt: "An import row for a person has a name but no email and no phone. What happens?",
        options: [
          "A roster contact is created from the name alone",
          "Nothing is created — it's reported as \"no-identifier\", because a name-only record is a guest, not a roster person",
          "The whole import is rejected",
          "It's imported as a donor instead",
        ],
        answerIndex: 1,
        explanation:
          "A row needs an email OR a phone to create a roster person — names collide constantly and a nameless row could never be safely deduped or contacted later. Clean up known duplicates (People → Duplicates, or the donor duplicates tool) before re-running an import, so it matches the one real record instead of spawning another.",
      },
    ],
  },

  // ── 88.5 · Donor stewardship: the gifts ledger, editing & merge ─────────
  {
    slug: "dev-gifts-ledger-and-audit",
    title: "The gifts ledger: see it, fix it, trace it",
    subtitle: "Every gift as it lands — edit, move books, merge, all on the record",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The Gifts tab is the chronological feed of every gift in your book, newest first — the view for watching donations come in AND for cleaning up history. A central holder can switch it to \"All chapters\" to see every book's gifts in one feed, each row tagged with the book it belongs to. A quick search box filters the loaded rows by donor, note, or source.",
      },
      {
        kind: "bullets",
        items: [
          "**Add gift** — record a manual or external gift the rails never saw: a wire to the org's account, a Zelle or Cash App gift, something bought on behalf of the org. Past dates, the full source list, and receipts are all supported; a central manager also picks which book it belongs to.",
          "**Edit** — fix an amount, date, source, or note straight from the ledger. The donor's lifetime total and the book's rollups always re-derive to the exact truth — nobody ever hand-edits a total.",
          "**Reassign donor** — move a single gift onto the right donor in the same book (the small \"this gift landed on the wrong person\" fix).",
          "**Move book** — a central manager can move a WHOLE gift between books (central ↔ chapter, chapter ↔ chapter). The gift's donor is matched-or-created in the destination book, and BOTH books' totals net exactly — no money is invented or lost.",
          "**Split** — a central manager can split ONE gift into two or more parts across books (central ↔ chapter): the parts must sum to exactly the original amount, and each part becomes its own gift for the same donor in its book (person-linked for a chapter, keeping the date, source, and receipts). His real case: one wire split between Central and New York, so each book shows its true share while the underlying-transaction story survives in the notes and audit.",
          "**Remove** — delete a gift that shouldn't be there (an $820 \"donation\" that was really a ticket-sale payout; a stray ticket purchase). Removing has EFFECTS — it reverses the donor's and the book's totals — so the desk MAKES YOU say why first, and keeps a snapshot of the deleted gift on the record.",
        ],
      },
      {
        kind: "rule",
        title: "Every change leaves a breadcrumb — and removing one asks why",
        text: "Every add, edit, reassignment, book-move, and split writes an audit line on that gift — who did it, when, exactly what changed (old → new), and a \"why\" (optional on an edit, REQUIRED on a removal). A removal is special: because the row disappears, its breadcrumb carries a self-contained snapshot — donor, amount, date, book, source — so the trail stays readable even after the gift is gone. And a gift whose money is owned by its SOURCE — an event donation, a Stripe billing cycle, a matched bank credit — is protected: its amount, date, source, and book can't be edited, moved, or split here, only its note and receipts.",
      },
      {
        kind: "reveal",
        prompt:
          "You spot the same donor twice in one chapter — once as \"Jon Smith,\" once as \"Jonathan Smith\" — each with real gifts. What's the clean fix, and what if instead it were just one gift sitting on the wrong donor?",
        answer:
          "For two duplicate donors: merge them. From Donors → Duplicates, take an auto-detected group OR use \"Pick two to merge\" to choose the two records yourself — the survivor keeps everything, every gift/pledge/sponsorship moves onto it, and its lifetime total is recomputed from the combined gifts. For a single misfiled gift, don't merge the donors — just reassign that one gift to the right donor from the ledger.",
      },
    ],
    quiz: [
      {
        prompt: "What is the Gifts tab?",
        options: [
          "A place to configure Stripe billing",
          "A chronological, newest-first feed of every gift in the book — and, for a central holder, every book at once with each row tagged",
          "The same thing as the donor list, sorted by lifetime",
          "A list of only the gifts you personally recorded",
        ],
        answerIndex: 1,
        explanation:
          "It's the \"watch the donations come in\" feed — and the desk you live in during cleanup, because edit / reassign / move / add all hang off it.",
      },
      {
        prompt: "You edit a gift's amount from $50 to $80. What happens to the donor's lifetime total and the book's rollups?",
        options: [
          "You must also edit the donor's lifetime by hand to match",
          "They re-derive to the exact truth automatically — a rollup is never hand-edited",
          "Nothing — rollups only update on brand-new gifts",
          "The old gift is deleted and a new one created, churning the history",
        ],
        answerIndex: 1,
        explanation:
          "Money integrity is the whole point: the edit moves the donor total and the scope rollup by exactly the delta, once each, and the audit records $50.00 → $80.00.",
      },
      {
        prompt: "What does every add, edit, reassignment, or book-move to a gift leave behind?",
        options: [
          "Nothing — changes are silent",
          "An audit breadcrumb: who changed it, when, what changed old → new, and an optional why",
          "An email to the donor",
          "A pending approval a director must sign off",
        ],
        answerIndex: 1,
        explanation:
          "The audit trail is the \"breadcrumb trail showing I updated this\" — open any gift to read its full change history.",
      },
      {
        prompt: "Who can move a gift from one book to another, and what happens to the two books' totals?",
        options: [
          "Anyone with view access; the totals are left for finance to reconcile later",
          "A central manager; the donor is matched-or-created in the destination and both books' totals net exactly",
          "Only a superuser, and the gift's amount resets to zero",
          "Nobody — a gift can never change books",
        ],
        answerIndex: 1,
        explanation:
          "Moving a gift across books is a central-manage action; the source book loses exactly the gift, the destination gains exactly it, and its donor exists in the new book (matched or created, person-linked for a chapter). Splitting is the same power finer-grained: the parts must sum to exactly the original, so no money is invented or lost.",
      },
      {
        prompt: "Why does removing a gift make you type a reason first?",
        options: [
          "It doesn't — a gift is deleted the instant you tap Remove",
          "Because removing reverses the donor's and the book's totals — it has effects — so the reason and a snapshot of the deleted gift are kept on the record",
          "To email the donor an apology automatically",
          "Only superusers are ever allowed to remove a gift",
        ],
        answerIndex: 1,
        explanation:
          "Real removals matter (an $820 payout mistaken for a gift, a stray ticket purchase). The required \"why\" plus a self-contained snapshot — donor, amount, date, book, source — keeps the trail readable after the gift itself is gone.",
      },
    ],
  },

  // ── 88b · The public gift wall: what a giver's gift says out loud ────────
  {
    slug: "dev-public-gift-wall",
    title: "The public gift wall: anonymous by default",
    subtitle: "Consent gates the name, never the gift — and how a takedown works",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The last lesson was the PRIVATE record of a gift. This one is its public echo. Every giving page carries a **wall** — the gifts that have actually landed, newest first — and the single most important thing to know about it is that a gift appears there whether or not the giver told us anything about themselves. The wall is not a curated highlight reel of the people who volunteered a name. It's the giving, shown.",
      },
      {
        kind: "rule",
        title: "Consent gates ATTRIBUTION, never EXISTENCE",
        text: "Every gift given through a give page gets a row. The default row is anonymous — **\"A gift to New York · $50\"** — and that's what the overwhelming majority of rows look like. A **display name** and a **message** render only where the giver explicitly said yes to showing them. So \"did they consent?\" is never the question \"does this gift appear?\"; it is only ever the question \"does their NAME appear?\" Get that backwards and you'll tell a donor something false about a page they can go read. (What the wall is NOT: every gift the org receives. A check handed to you at an event, a wire, an import — you enter those at the giving desk, and they move the live total without leaving a row underneath it. The wall is the giving page's own feed; **the books at `/finances` are the complete record**, and the wall's footer says exactly that. Don't promise a desk-entered gift will show up on the wall.)",
      },
      {
        kind: "bullets",
        items: [
          "**Settled only.** A row means money genuinely arrived. An abandoned checkout never reaches the wall, and a payment that fails or is later returned takes its row back off — the wall's whole credibility is that you can't post to it without paying.",
          "**Central gifts are on it too**, tagged as central operations rather than a city. Giving to the org as a whole is giving, and hiding it would make the wall quietly misrepresent where support actually goes.",
          "**Coarse time, and nothing else.** \"Two days ago,\" never a timestamp. No payment method, no email, no reference number, no exact ordering. The row is an amount, a destination, a rough when — plus a name and message where consented.",
          "**A very small city doesn't get named.** Where a place has barely any lifetime giving, one gift plus a city name is close to naming the person, so the destination label is suppressed rather than printed.",
          "**The total is live.** Give, refresh, and the number has moved. That's deliberate and it is NOT the same promise as the books: \"published month by month\" describes `/finances`, which is frozen and reviewed. Never use the books' language about the wall's counter, or the wall's immediacy about the books.",
        ],
      },
      {
        kind: "rule",
        title: "A city page can be found by search — so the promise has to match the copy",
        text: "City pages are indexed. That raises the stakes on attribution: agreeing to be *shown* on a page is not the same as agreeing to be *findable by name, beside what you gave, forever*. So the consent copy now says plainly that the page is public and can be found by search — and only consents captured under THAT wording put a name on an indexed page. People who consented under the older, quieter wording keep the promise they were actually made: their gifts still appear, still count, **anonymously**. If someone asks why their name isn't showing when they remember ticking the box, that's the answer, and it's the right answer.",
      },
      {
        kind: "tip",
        text: "**In the app · Giving → Wall.** Every entry, any status, newest first, each one saying which page it appears on, whether consent was recorded, and — if it's already down — who took it down and when. **Take down** and **Restore** are central `giving.manage` actions. This screen exists for one reason: before it, the only way to answer a donor who wrote in asking to come off the wall was to ask a developer to run something, and \"I'll file a ticket\" is not a reply you give someone about their own name.",
      },
      {
        kind: "reveal",
        prompt:
          "A donor emails: \"I've just seen my name and my $500 on your website. Please take it off.\" What do you do, and what happens to the gift?",
        answer:
          "Take the row down from Giving → Wall — it's a central `giving.manage` action, and it's logged with your name and the time. Then say so back to them in a sentence. What you have NOT done is touch the gift: their giving history, their lifetime total, the book's rollups, and the receipt all stand exactly as they were. You removed the public echo, not the money — which is also why the city's total on the page doesn't drop when you do it; that number is summed from the book's rollups, not counted from the rows on screen. Two things not to do: don't remove the gift from the ledger (that's an accounting act to solve a publishing problem, and it will show up in a reconcile), and don't promise them it can never happen again without checking what they actually agreed to — read the recorded consent on the row first.",
      },
    ],
    quiz: [
      {
        prompt: "Someone gives $50 to New York and doesn't fill in a name or tick anything. What appears on the public wall?",
        options: [
          "Nothing — the wall only shows givers who opted in",
          "An anonymous row: a $50 gift to New York, no name and no message",
          "Their name from the donor CRM, with the amount",
          "The gift, but visible only to signed-in staff",
        ],
        answerIndex: 1,
        explanation:
          "Every gift given through the page gets a row, and the default row is anonymous. The wall shows that giving; consent only decides whether a name is attached to it.",
      },
      {
        prompt: "What does a giver's consent actually control?",
        options: [
          "Whether their gift appears on the wall at all",
          "Whether their name and message appear beside it — the gift and its amount are on the wall either way",
          "Whether the gift counts toward the city's total",
          "Whether we're allowed to email them again",
        ],
        answerIndex: 1,
        explanation:
          "Consent gates attribution, never existence. \"Did they consent?\" answers \"does their NAME show?\" and nothing else.",
      },
      {
        prompt: "A donor writes in asking to come off the wall. What's the move, and what happens to their gift?",
        options: [
          "Ask a developer to delete the row",
          "Take it down from Giving → Wall — central `giving.manage`, logged — and leave the gift, the lifetime total, and the book's rollups untouched",
          "Remove the gift from the ledger so there's nothing left to publish",
          "Nothing can be done — a published row is permanent",
        ],
        answerIndex: 1,
        explanation:
          "The takedown is a staff action on the public echo only. Deleting the gift would be solving a publishing problem with an accounting act — and the page's total wouldn't move either way, since it's summed from the book's rollups rather than the rows on screen.",
      },
      {
        prompt: "Why do some gifts whose givers DID agree to be shown still render anonymously on a city page?",
        options: [
          "A bug in the wall",
          "They agreed under older copy that never said the page could be found by search — only consent captured under the newer, explicit wording carries a name onto an indexed page",
          "Their gifts are too old to display",
          "Their names couldn't be verified",
        ],
        answerIndex: 1,
        explanation:
          "Agreeing to be shown isn't agreeing to be findable by name forever. Those givers keep the promise they were actually made: they appear, they count, anonymously.",
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
        text: "A pledge can start as low as $20/month — but only a pledge at or above $50/month makes its donor a BACKER. Below that floor, they're a valued recurring giver; they just don't count toward a chapter's tier the way a full backer does.",
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
          "**Public — and it IS the program list.** Every rung renders on that city's own `/give/<slug>` page as a promise with visible progress: \"17 of 20 backers — 3 more unlocks monthly WWS.\" Each rung also carries its own description of the thing it unlocks, because the page has no separate list of programs any more — the ladder absorbed it. So a threshold and the thing it buys are never read apart from each other, and a rung whose blurb is wrong is a rung whose promise is wrong.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A donor pledges $20/month to a chapter. Do they count toward that chapter's backer milestones?",
        answer:
          "No — they're a real, valued donor with an active recurring pledge, but the backer count only includes pledges at or above the $50 floor. Their gift still shows up in giving history every month; it just doesn't move the chapter's tier. (There's a second way a pledge can be non-counting: a PAUSED pledge — see the next lesson — stays in the backers list but is left out of the count until it resumes.)",
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
      {
        prompt: "A notification rule tells the team about gifts of $500 and up. Someone starts a $50/month pledge. Does the team hear about it?",
        options: [
          "No — $50 is well under the $500 threshold",
          "Yes — a signup is judged by its ANNUAL value ($600), because a backer is a big gift arriving twelve payments at a time",
          "Only if someone on the desk records it manually",
          "Only in the weekly digest, never right away",
        ],
        answerIndex: 1,
        explanation:
          "Judging a signup by the monthly charge would let the most consequential event on the giving desk slip under every threshold the team actually sets, while a one-off $500 cheque rang the bell. The notification prints both figures — $50/month and $600 a year — so nobody mistakes the annual number for money in the bank.",
      },
    ],
  },

  // ── 90 · The backer model: lifecycle and self-serve billing ─────────────
  {
    slug: "dev-backer-lifecycle",
    title: "A backer's lifecycle: subscribe, pay, sometimes falter",
    subtitle: "incomplete → active → past_due → canceled (+ a manual pause), and who does what",
    minutes: 5,
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
          ["Paused", "A MANUAL hold the desk sets — the pledge stays in the backers list (history preserved) but is left OUT of the count until it's resumed"],
        ],
      },
      {
        kind: "rule",
        title: "Each paid cycle is a gift, automatically",
        text: "Every month a subscription successfully charges, one new row lands in that donor's giving history — recurring backing shows up in the CRM exactly like a one-time check, no manual entry required. A chapter's backer count recomputes the instant any pledge's status or amount changes, so it's always current — and a paused pledge simply stops counting until it resumes.",
      },
      {
        kind: "rule",
        title: "The moment someone becomes a backer, two emails go out",
        text: "Becoming a backer is the biggest single thing anyone does on the giving side, and the system treats it that way. **The backer gets a welcome** — a real thank-you naming what monthly giving makes possible and promising to keep them in the loop — instead of the routine monthly receipt on that first cycle. (Every cycle AFTER the first gets the ordinary receipt; a welcome that arrives monthly stops being a welcome.) **The giving desk gets a notification**, through the same notification rules that announce gifts. Both fire exactly once per backer, whichever Stripe event lands first — so a redelivered webhook can never thank somebody twice.",
      },
      {
        kind: "rule",
        title: "A new backer counts as a BIG gift — at their annual value",
        text: "A notification rule's dollar threshold judges a signup by what they've committed over a year, not by the monthly charge. A $50/month backer is a $600 decision, so they clear a \"$500 and up\" rule that their $50 first cycle never would. That's deliberate: without it, the most consequential event on the giving desk would slip under every threshold the team actually sets while a one-off $500 cheque rang the bell. The emails always print BOTH figures — the monthly amount and the annual one — and new backers are reported in the daily/weekly digest as their own section, deliberately NOT added into the money total, because a commitment is a promise and the total is what actually arrived.",
      },
      {
        kind: "tip",
        text: "**Vocabulary matters here, and the emails hold it.** A pledge under the $50 backer floor produces the same warm welcome, but it says \"monthly giver\", not \"backer\" — because that person doesn't appear in the chapter's public backer count or move its milestone ladder. Never tell a $10/month giver they're a backer of a city; it's a promise about a page they're not on.",
      },
      {
        kind: "rule",
        title: "Pause is manual; the rest is Stripe",
        text: "Every status EXCEPT paused is driven by Stripe (checkout, successful charges, failed charges, cancellation). Paused is the one the development desk sets by hand — for a backer who asks to take a break — and it's deliberately \"sticky\": a routine Stripe re-sync won't quietly flip a paused pledge back to active, so a manual pause never fights the billing cycle. A paused pledge doesn't count toward the chapter's tier, but it never leaves the backers list — the relationship and its whole timeline are preserved. The desk can also correct a pledge's \"Since\" date or delete a pledge outright; each of those, like a pause or resume, is written to the pledge's history with who did it and why.",
      },
      {
        kind: "tip",
        text: "**Self-serve, always.** A backer manages their own card, changes their pledge amount, or cancels through a Stripe billing-portal link — we never store card numbers or build our own card-management screen. If someone emails asking you to update their card, the answer is the portal link, not a request for their card number.",
      },
      {
        kind: "reveal",
        prompt:
          "A new backer's first monthly cycle is paid. What lands in their inbox — the welcome, the standard receipt, or both?",
        answer:
          "The welcome, and only the welcome. It carries the first cycle's details (amount, that the first month is in, how to change it) precisely so it can stand in for the receipt exactly once. Two emails in the same minute about the same $50 — one saying \"this matters enormously\", one saying \"your monthly gift came through\" — is how a thank-you gets read as an auto-reply. Every cycle after the first gets the ordinary receipt.",
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
          "Past_due is a Stripe-driven state — a failed charge, not a person's decision. Pausing IS a real action, but it's a separate manual state (\"paused\"), not past_due.",
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
      {
        prompt: "A backer asks to take a break, so you PAUSE their pledge. What happens to the chapter's backer count and the backers list?",
        options: [
          "The pledge is deleted and vanishes from the list",
          "The count drops by one (paused pledges don't count), but the pledge stays in the backers list with its full history",
          "Nothing changes until Stripe cancels the subscription",
          "The count is unaffected — paused pledges still count as backers",
        ],
        answerIndex: 1,
        explanation:
          "Paused is a manual hold: it removes the backer from the count immediately, but the pledge — and its whole paused/resumed timeline — stays on the record. Resume it and the count goes back up. (Because a pause is local, the desk should still cancel in Stripe if they want to stop the card from being charged.)",
      },
    ],
  },

  // ── 91 · The backer portal: what a backer can see ───────────────────────
  {
    slug: "dev-backer-portal",
    title: "The backer portal: their own page",
    subtitle: "What a backer signs into, what they can change, and what we show them about us",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Backers have their own page now — `publicworship.life/backer`. They sign in with their email and a six-digit code (no password, no account in the OS), and land on their own record: what they give monthly, their whole giving history, and where their city stands.",
      },
      {
        kind: "rule",
        title: "Signing in proves an email, and that's all it is",
        text: "There's no backer account and no password. Enter an email, get a code, and that code mints a session that lasts a month. It follows that a donor with NO email on file — a desk-entered cash or check giver — can't use the portal at all, because we have no way to prove they're them. The page also never confirms whether an address is on file: an email we know and one we've never seen get the identical answer, so nobody can use it to fish for who gives to us.",
      },
      {
        kind: "rule",
        title: "They can change their card and their amount themselves",
        text: "Updating a card and stopping a monthly gift both happen on Stripe's own page — we never see card numbers. The AMOUNT is ours, on purpose: Stripe's page can't hold a minimum, and someone already giving $50 a month or more can't drop below $50 through the portal, because that would silently take them out of their city's backer count and move its milestone ladder backwards. Going below the backer floor, or stopping altogether, is a conversation — the page points them at the stop button and at us.",
      },
      {
        kind: "rule",
        title: "A declined card now tells the backer, not just us",
        text: "When a monthly charge fails, the backer gets one warm email: nothing has been cancelled, the bank will be tried again, here's the button to update your card. Before this the status flipped silently — the chapter's public backer count dropped, its ladder moved backwards, and the person whose card it was heard nothing until the cancellation. Stripe still does the retrying; we do the telling.",
      },
      {
        kind: "tip",
        text: "**Your own record is always yours.** Anyone who has ever given — backer or not — can sign in and see their own giving history and manage their own monthly gift. What's BACKER-ONLY is what we show about the ORG: the city's ladder, what's coming up, the books. That line is the whole design.",
      },
      {
        kind: "reveal",
        prompt:
          "A backer emails asking you to lower their monthly gift from $50 to $20. What do you tell them?",
        answer:
          "That they can change it themselves on their page — but the page will hold them at $50 or more, because that's the line where they stop counting as a backer of their city. If $20 is genuinely what works right now, that's a real and welcome thing: they can stop the $50 and start again at the amount they want, or reply and we'll do it. Never make somebody feel caught by the rule — it exists so nobody drops out of a city's count by accident, not to trap them.",
      },
    ],
    quiz: [
      {
        prompt: "How does a backer sign into their portal?",
        options: [
          "With a Chapter OS account we create for them",
          "With their email and a six-digit code we send them — no password, no OS account",
          "With a permanent link we email once",
          "They can't sign in; the desk sends them a PDF",
        ],
        answerIndex: 1,
        explanation:
          "A code proves the email, and the session it mints can be revoked. A permanent link was rejected deliberately: a forwarded or archived email would become standing access to somebody's whole giving history.",
      },
      {
        prompt: "A backer giving $50/month tries to change their amount to $25. What happens?",
        options: [
          "It goes through — any amount is allowed",
          "The page refuses, because dropping below $50 would take them out of their city's backer count — and it points them at stopping instead",
          "It silently cancels their backing",
          "Only a superuser can change a pledge amount",
        ],
        answerIndex: 1,
        explanation:
          "The rule is a ratchet, not a cage: it only holds people who are already backers, and stopping altogether is one button away with no minimum at all. Someone already giving under $50 can move freely.",
      },
      {
        prompt: "Which part of the portal is backer-only?",
        options: [
          "All of it — non-backers can't sign in",
          "Their own giving history",
          "What we show about the ORG — the city's ladder, what's coming up, the books. Anyone who has given can always see their OWN record",
          "Nothing is restricted",
        ],
        answerIndex: 2,
        explanation:
          "Telling a $20/month giver they're not important enough to see their own receipts would be the most alienating thing the page could do. The backer-only half is what we disclose about ourselves.",
      },
      {
        prompt: "A backer's card is declined. What does the backer receive?",
        options: [
          "Nothing — the status just changes internally",
          "One warm email saying nothing has been cancelled, the bank will be retried, and here's how to update the card",
          "A weekly invoice until they pay",
          "A cancellation notice",
        ],
        answerIndex: 1,
        explanation:
          "A failed card is far more often an expiry or a bank being cautious than a decision, so the email assumes the best. The silence it replaced was the actual bug: the chapter's public count dropped while the backer heard nothing.",
      },
    ],
  },

  // ── 92 · The backer model: the Givebutter migration ─────────────────────
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

  // ── 93 · Sponsorships: package tiers ─────────────────────────────────────
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

  // ── 94b · Sponsorships: the partner portal ───────────────────────────────
  {
    slug: "dev-partner-portal",
    title: "The partner portal: one page they read, sign, and pay",
    subtitle: "A custom proposal, the gatherings it covers, and a digital signature",
    minutes: 5,
    blocks: [
      {
        kind: "p",
        text: "A package tier is a price list. A real partnership is a negotiation — a $3,500 production spot with its own terms, its own extras, and sometimes production work donated instead of cash. So every agreement can carry its OWN proposal: a title, a free-form body in your words, its own list of what they receive and what we deliver, and its own terms. Leave a field blank and it falls back to the package tier; fill it in and this partner sees your version.",
      },
      {
        kind: "p",
        text: "Then you create a portal link and send it. One page, no login: they read what was agreed, sign it by typing their name, and pay the balance — all in the same place.",
      },
      {
        kind: "rule",
        title: "Editing what they signed un-signs it",
        text: "Changing the amount, the terms, the benefits, the commitments, the summary, or the title bumps the agreement's version and CLEARS the partner's signature — they'll be asked to sign again. That is deliberate: a signature has to be against terms somebody actually read. Editing the contact details, the payment rails, or an in-kind credit does NOT clear it — giving a partner credit must never force them to re-sign.",
      },
      {
        kind: "rule",
        title: "Big partnerships pay by bank transfer, and that's a money decision",
        text: "Stripe's bank-transfer (ACH) fee is 0.8% CAPPED AT $5, whatever the amount. A card is about 2.9% + 30¢ with no cap — $101.80 on a $3,500 spot against $5.00. So a new agreement offers bank transfer alone; you can add card on a small spot where four days of clearing time costs more than the fee, and above $1,000 the system won't let you.",
      },
      {
        kind: "bullets",
        items: [
          "**In-kind credit reduces what they owe; it isn't money that arrived.** A production proposal valued at our own budget lines — never their rate card — is listed line by line on their page and counts against the spot like cash. Recording it as an in-kind GIFT in the ledger is a separate, deliberate act; doing both counts the same donation twice.",
          "**One agreement can cover several gatherings.** Tick every event this partnership stands behind — Ignite stands behind Love Thy Neighbor on the 26th AND the hosted Worship with Strangers on the 18th — and the partner sees each one by name and date near the top of their page. Changing which events are covered is a change to what they agreed to, so it clears the signature like any other term. A season or full-year agreement covers no single date, and that is fine.",
          "**Attach the paperwork.** Any document behind the deal — the agreed production proposal when a partner is covering production themselves, a signed side letter — attaches as a PDF (or a photo/scan). It stays internal to the desk until you deliberately show it on the partner's page, so a draft or an internal note never leaks. A shared document is the evidence behind an in-kind credit, and attaching one never touches a signature.",
          "**The link is stable.** Pressing \"Copy link\" twice gives you the same URL, so the one you emailed keeps working. Revoking kills it; the next one you create is a fresh address.",
          "**A bank transfer takes about four business days.** Until it clears, the portal shows it as clearing and the balance is unchanged — no gift is recorded for money that hasn't moved, and the partner can't accidentally pay twice.",
          "**Nothing internal reaches their page.** Due-diligence notes, the pipeline stage, the owner, and every other agreement are invisible on the portal by construction.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A partner signed, then you notice the amount should have been $3,500 rather than $3,000. You fix it. What happens?",
        answer:
          "The agreement moves to version 2 and their signature is cleared — the desk shows \"needs re-signing\" with what they originally signed, and their portal asks them to sign the corrected terms. That's the right outcome: you would otherwise be holding a signature for a number nobody agreed to.",
      },
    ],
    quiz: [
      {
        prompt: "You edit an agreement's terms after the partner signed. What happens to the signature?",
        options: [
          "It carries over — the terms are just a note",
          "It's cleared, and the partner is asked to sign the new version",
          "The agreement is deleted",
          "Nothing changes until the next payment",
        ],
        answerIndex: 1,
        explanation:
          "A signature is against a specific version of the terms. Editing a signed term bumps the version and clears the signature, so we never hold a signature for terms nobody read.",
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
          "On a $3,500 spot a card costs about $101.80 and a bank transfer costs $5.00. That difference is a free event's worth of production, so the rail is a stored setting, not a preference.",
      },
      {
        prompt: "A partner's team donates production work you value at $2,500 against a $3,500 spot. What do you do?",
        options: [
          "Record it as an in-kind gift AND add an in-kind credit",
          "Add an in-kind credit line — it reduces what they still owe to $1,000",
          "Lower the agreement amount to $1,000",
          "Nothing can be recorded until they pay cash",
        ],
        answerIndex: 1,
        explanation:
          "The credit reduces the balance and is listed on their page line by line. Lowering the amount would lose what the partnership is actually worth, and doing both a credit and a gift would count the same donation twice.",
      },
      {
        prompt: "What can a partner do with the portal link they were sent?",
        options: [
          "Read, sign, and pay that one agreement — nothing else",
          "See every sponsorship the org holds",
          "Edit the terms before signing",
          "Open the donor CRM",
        ],
        answerIndex: 0,
        explanation:
          "The link opens exactly one agreement and authorizes exactly two acts: signing it and paying it. It cannot read our notes, change a term, or reach any other record.",
      },
      {
        prompt: "You press \"Copy link\" a second time on an agreement you already sent. What do you get?",
        options: [
          "A new link, and the old one stops working",
          "The same link — the one you already emailed keeps working",
          "An error",
          "A link that expires in 24 hours",
        ],
        answerIndex: 1,
        explanation:
          "Minting is idempotent on purpose. Issuing a fresh token on every press would silently break the URL you sent five minutes ago, with no way for either side to know why. Revoking is the one act that kills a link.",
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
          "**Transparency, by design — and it's published, not just promised.** Backers can read the whole money model on its own page, **`/give/how-it-works`**: the monthly operating lines, the 20/30/50 ladder, the launch budget, and this 85/15 split. Then they can check it against the actual books at **`/finances`**, month by month. Two different jobs, deliberately two different pages — the model is an explanation, the books are the evidence — and neither one lives on the giving page itself any more.",
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
        prompt: "Where can a backer go to read the 85/15 split for themselves?",
        options: [
          "Nowhere — it's an internal number staff explain verbally",
          "`/give/how-it-works`, which lays out the whole money model, with the published books at `/finances` as the check on it",
          "On the giving page's hero, above the ask",
          "Only inside the app, once they're signed in",
        ],
        answerIndex: 1,
        explanation:
          "The money model has its own page — `/give/how-it-works` — and the books that prove it live at `/finances`. Both are linked from the giving pages, but neither is ON them: the ask and the accounting are separate reads, on purpose.",
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
          "**Shareable by design — and findable.** A backer campaign is meant to be forwarded — \"already 3 backers here, help get it to 20\" — and a city page is a genuinely PUBLIC page a search engine can index, not an unlisted link you only reach if someone sends it to you. What it says about any individual giver is governed by the wall's consent rule (see \"The public gift wall\" in Donor Stewardship): a gift's existence and amount, never a donor's CRM record or contact details, and a name or message only where that giver explicitly said yes.",
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
        text: "**Live now: the public `/give` pages.** The org-wide `/give` page leads with BACKING A CITY — a card per city with its live backer count and next milestone — and keeps giving once one tap away, with the giver choosing central operations or a named city. The map is still there, further down, doing the job it's actually good at: \"here's where we're going.\" Each `/give/<slug>` page carries that city's milestone ladder, a progress bar, its gift wall, its fundraisers, and a become-a-backer form — preset $50 / $100 / $200 or a custom monthly amount — that starts a real Stripe subscription. A territory shows publicly only once an admin marks it visible, so central can stage one before announcing it. Nothing on either page exposes a donor's contact details or their CRM record.",
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
      "top-donor workflow, getting giving history — old and new — onto " +
      "the record via CSV import and manual backfill, the gifts ledger's " +
      "own edit/audit/merge trail, and the public gift wall that gift " +
      "history echoes onto — anonymous by default, consent gating only the " +
      "name, with a staff takedown that never touches the money.",
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
