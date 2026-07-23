/**
 * The Finances stream (WP-5.1) — where the money comes from, how it's
 * tracked, and who signs off on it. Also the Finances theme + its six
 * courses: five role courses (Finances for Everyone / Treasurer / Chapter
 * Director / Financial Manager / Executive Director) plus the shared
 * `chapter-money-model` core course (tiers + skim, the budget lifecycle,
 * one-home-per-dollar attribution) that Treasurer and Chapter Director both
 * build on — see `docs/plans/finance-v2-split-prd.md` §Phase 5.
 *
 * Owned exclusively by this file for content authoring — do not add Finances
 * sections or courses anywhere else. See `../index` for how this assembles
 * into the full curriculum/catalog.
 *
 * F-6 touch-up (giving-platform PRD §8): `finance-tiers-and-skim` no longer
 * lets "backer count" stand as an unexplained given — it now teaches WHERE
 * the number comes from (derived live from active pledges on the Giving
 * page, a manual override surviving only as a Givebutter-migration
 * fallback), with a new quiz question checking that reading. The
 * `finance-stewardship` quiz's "future Giving page" aside was also
 * corrected — the Giving page is shipped, not future. Every other Finances
 * teaching in this file is unchanged; see `streams/development.ts` for the
 * full backer-model lesson this touch-up points to.
 *
 * Auto-ACH + submission-email touch-up (reimbursement flow shipped three
 * changes at once): `finance-reimbursements-and-flags` now teaches that
 * approval itself fires the ACH payout automatically (no separate manual
 * send step), and that submitting a request already emails every finance
 * approver in the chapter — the old "there's no notification, call your
 * Treasurer" tip was rewritten so the direct nudge is framed as making an
 * already-notified approver move faster, not as the only signal that
 * exists. `finance-monthly-close`'s "queue triaged" bullet got one clause
 * noting the email is a nudge, not a substitute for clearing the queue.
 * No quiz answers changed truth value — none of the existing questions
 * asserted "no notification" or "manual payout" as fact. Titles, minutes,
 * and quiz lengths are unchanged, so the snapshot test needed no updates.
 *
 * Review fix: `finance-reimbursements-and-flags`'s auto-ACH line now notes
 * the manual-payout fallback for a chapter whose Increase account isn't set
 * up yet, so it no longer reads as an unconditional guarantee. No titles,
 * minutes, or quiz content changed.
 */

import type {
  AcademySection,
  Course,
  Theme,
} from "../types";

/** The Finances-stream sections, in curriculum order. */
export const FINANCES_SECTIONS: Omit<AcademySection, "order">[] = [
  // ══ Finances (WP-5.1) ════════════════════════════════════════════════════
  // Five role courses (Finances for Everyone / Treasurer / Chapter Director /
  // Financial Manager / Executive Director), authored from the shipped
  // finance surface (Reconcile, the 7-day receipt auto-lock, reimbursements,
  // seats, explicit-only budget attribution, central budgets, the budget
  // approval workflow — WP-3.2) — see `docs/plans/finance-v2-split-prd.md`
  // §Phase 5. Where a lesson teaches a workflow that isn't built yet
  // (automated skim/launch-grant transfers — Phase 4), a `tip` block says so
  // plainly; the doctrine is real even where the button isn't yet. Content
  // authoring depth here is WP-5.1's "concise starter content" — full depth
  // is WP-5.2.

  // ── 31 · Finances for everyone: stewardship ────────────────────────────────
  {
    slug: "finance-stewardship",
    title: "Where the money comes from",
    subtitle: "Backers, the card, and spending like it's not yours",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Public Worship runs on backers — people who commit real dollars every month because they believe in the mission, not customers buying a product. Every dollar on your card started as someone's monthly gift. That's not guilt-tripping; it's the frame that should sit behind every purchase decision you make.",
      },
      {
        kind: "bullets",
        items: [
          "**A backer gives monthly, not once.** The floor is $50/month — a real, recurring commitment, not a one-time donation.",
          "**Backer count, not backer dollars, drives the model.** Headcount sets the tier a chapter operates at (see the Treasurer and Chapter Director courses) — a chapter grows by adding backers, not by asking existing ones for more.",
          "**The card exists so you don't front cash.** You spend on the mission's behalf; the app tracks it so nobody — including you — has to remember what you're owed.",
          "**Reach for the Public Worship card first.** For any Public Worship expense, always try the Public Worship card before reimbursing yourself or covering it another way — it's the cleanest record and the default path, not a last resort.",
        ],
      },
      {
        kind: "rule",
        title: "Spend like a steward, not an owner",
        text: "The money isn't the chapter's to spend however feels right in the moment — it's backers' trust, converted to dollars, for a specific mission. Before a purchase: would you be comfortable a backer saw the receipt?",
      },
      {
        kind: "reveal",
        prompt:
          "You're at the hardware store buying event supplies and spot a discounted item you personally want, same trip. Put it on the Public Worship card?",
        answer:
          "No — even a great deal. The card is for mission spending only; personal items go on your own card, full stop. If a personal charge lands on the Public Worship card by accident, flag it immediately (the next lesson) rather than hoping nobody notices.",
      },
      {
        kind: "rule",
        title: "Want to cover something personally? Donate it, don't spend it.",
        text: '"I\'ll just cover the meal myself" feels generous, but it quietly takes the expense off the books — Public Worship never sees it, your Treasurer can\'t track it, and a handful of these a year adds up to real spending nobody can account for. The steward\'s move is the SAME generosity, routed correctly: make a donation to Public Worship, then let Public Worship pay the expense on the Public Worship card. Same dollars out of your pocket, same mission funded — but now it\'s a clean, trackable record instead of an invisible one. And unlike a silent personal cover, your gift may be deductible depending on applicable tax rules and the nature of the contribution.',
      },
      {
        kind: "reveal",
        prompt:
          "Your team is $40 short for the after-event meal. You're tempted to just pay it yourself so nobody has to deal with reimbursement. What's the better move?",
        answer:
          "Donate the $40 to Public Worship, then let Public Worship pay for the meal on the Public Worship card. Same generosity, same $40 out of your pocket — but now it's a real, trackable gift instead of an invisible personal favor, and it may be deductible depending on applicable tax rules and the nature of the contribution.",
      },
    ],
    quiz: [
      {
        prompt: "What actually grows a chapter's operating budget, per the model?",
        options: [
          "Asking current backers to give more each month",
          "Adding more backers — headcount, not total dollars, is the unit the system tracks",
          "Running more events",
          "Cutting operating costs",
        ],
        answerIndex: 1,
        explanation:
          "Tiers and the operating formula key off backer COUNT. A chapter scales by growing its base of backers, not by squeezing more out of the ones it has.",
      },
      {
        prompt: "What is the $50/month backer floor?",
        options: [
          "A one-time donation minimum",
          "The recurring monthly commitment that makes someone a backer",
          "A price for merchandise",
          "A chapter's total monthly budget",
        ],
        answerIndex: 1,
        explanation:
          "A backer gives every month, not once — $50/month is the floor for that ongoing commitment (above-and-beyond giving, donor stewardship, and sponsorships live on the Giving page — see the Development stream).",
      },
      {
        prompt: "Why track backers by count instead of total dollars raised?",
        options: [
          "Dollars are hard to add up",
          "Headcount is the unit the tier table and operating formula are built on — a stable base of people, not a lump sum, sustains a chapter",
          "It's a legal requirement",
          "Donations aren't recorded individually",
        ],
        answerIndex: 1,
        explanation:
          "Every constant in the model — tiers, the operating formula — is keyed on backer headcount. That's deliberate: people who keep giving matter more than any single big gift.",
      },
      {
        prompt: "You see a discounted personal item while buying event supplies. What's the rule?",
        options: [
          "Buy it on the Public Worship card — it was a good deal",
          "Never put personal purchases on the card; flag it immediately if one lands there by accident",
          "Only buy it if it's under $20",
          "Ask your Treasurer first, then buy it either way",
        ],
        answerIndex: 1,
        explanation:
          "The card is mission-only, no exceptions for good deals. An accidental personal charge gets flagged right away, not left for someone else to find later.",
      },
      {
        prompt:
          "A teammate wants to personally cover a $40 team meal instead of dealing with reimbursement. What's the steward's move?",
        options: [
          "Let them quietly cover it — it saves everyone the reimbursement paperwork",
          "Tell them personal generosity toward the team isn't allowed at all",
          "Have them donate the $40 to Public Worship, then let Public Worship pay for the meal on the Public Worship card",
          "Have them put it on their own card and expense it later as a personal gift",
        ],
        answerIndex: 2,
        explanation:
          "Same generosity, routed correctly: a donation plus the Public Worship card keeps the expense on the books instead of turning into one more untrackable personal favor — and it may be deductible depending on applicable tax rules and the nature of the contribution.",
      },
    ],
  },

  // ── 32 · Finances for everyone: card + 7-day rule ──────────────────────────
  {
    slug: "finance-card-and-receipts",
    title: "Your card and the 7-day rule",
    subtitle: "Spend, then close the loop before the grace window ends",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Every charge on your Public Worship card needs a receipt attached in the app — not for bureaucracy, but so your Treasurer can close the books without chasing you down a month later. You have **7 days** from the charge to upload one.",
      },
      {
        kind: "rule",
        title: "No receipt, no coverage — every expense, any amount",
        text: "This is absolute: every Public Worship expense needs a receipt, or a clear photo of one — a $5 card swipe and a $1,000 reimbursement claim follow the exact same rule. There's no purchase too small to bother with and no method that's exempt. If you can't produce a receipt or a clear photo of one, you may be PERSONALLY RESPONSIBLE for the charge: a card purchase can end up flagged as a personal charge you owe back, and a reimbursement claim with no receipt can simply be denied. The receipt isn't paperwork for its own sake — it's what keeps an expense being Public Worship's instead of quietly becoming yours.",
      },
      {
        kind: "table",
        headers: ["Day", "What happens"],
        rows: [
          ["Day of charge", "Charge appears in My Transactions, receipt missing"],
          ["Day 1–3", "A reminder nudges you if the receipt still isn't attached"],
          ["Day 3+", "The reminder escalates — now a flagged charge, visible to your Treasurer"],
          ["Day 7", "No receipt yet → your card **locks automatically**. Uploading the receipt unlocks it immediately."],
        ],
      },
      {
        kind: "rule",
        title: "The lock is a self-service problem",
        text: "Nobody has to ask permission to fix it: the moment you upload the missing receipt, the auto-lock lifts on its own. The rule exists so the Treasurer's monthly close is never blocked on a receipt nobody remembers.",
      },
      {
        kind: "try_status",
        title: "A charge waiting on a receipt",
        options: [
          { value: "none", label: "No receipt yet", color: "gray" },
          { value: "flagged", label: "Reminder sent", color: "amber" },
          { value: "uploaded", label: "Receipt uploaded", color: "green" },
        ],
        terminal: "uploaded",
        caption:
          "Uploading the receipt is the only move that matters — it clears the reminder and the lock, whichever stage you're at.",
      },
    ],
    quiz: [
      {
        prompt: "How long do you have to attach a receipt before your card locks?",
        options: ["24 hours", "7 days", "30 days", "There's no deadline"],
        answerIndex: 1,
        explanation:
          "A charge whose receipt is still missing after 7 days locks the card automatically — the grace window is a week, not a day and not a month.",
      },
      {
        prompt: "Your card auto-locked for a missing receipt from last week. How do you unlock it?",
        options: [
          "Call the Financial Manager",
          "Upload the receipt — the lock lifts automatically, no review needed",
          "Wait for the next reimbursement cycle",
          "You can't; a new card is issued",
        ],
        answerIndex: 1,
        explanation:
          "The unlock is self-service and instant: uploading the missing receipt clears the auto-lock the moment it lands, at any stage.",
      },
      {
        prompt: "Why does the app lock the card instead of just sending more reminders forever?",
        options: [
          "To punish cardholders",
          "An unresolved missing receipt would otherwise block the Treasurer's monthly close — the lock is what finally forces the loop closed",
          "The bank requires it",
          "It's a random security measure",
        ],
        answerIndex: 1,
        explanation:
          "The lock protects the close, not the cardholder's behavior for its own sake — an open loop at month-end is exactly what the Treasurer course teaches you to avoid.",
      },
      {
        prompt: "Where do you see and manage your own card's charges?",
        options: [
          "My Transactions",
          "The central dashboard",
          "The Reconcile grid",
          "You can't see your own charges",
        ],
        answerIndex: 0,
        explanation:
          "My Transactions is your mini-reconcile — attach receipts, add a category and a short note on who and why, and flag charges on your own transactions, all without needing a finance seat. What you add pre-fills the finance team's review.",
      },
      {
        prompt:
          "A $6 supply run and a $940 reimbursement claim both show up with no receipt. Which one actually needs a receipt to keep you from being personally on the hook?",
        options: [
          "Only the $940 one — small charges are exempt",
          "Neither — receipts are only for reimbursements, not card charges",
          "Both — the receipt rule doesn't scale with the dollar amount or the method",
          "Only the card charge — reimbursements are covered automatically once approved",
        ],
        answerIndex: 2,
        explanation:
          "The rule is absolute: a receipt (or a clear photo of one) is required no matter the amount or the method. Skip it on either one and you risk being personally responsible — a card charge can be flagged personal, a reimbursement claim can simply be denied.",
      },
    ],
  },

  // ── 33 · Finances for everyone: reimbursements + flags ─────────────────────
  {
    slug: "finance-reimbursements-and-flags",
    title: "Reimbursement, and flagging a charge",
    subtitle: "Two directions: what you're owed, what you owe",
    minutes: 5,
    blocks: [
      {
        kind: "p",
        text: "Two situations, two flows. You paid out of pocket for something mission-related? Submit a reimbursement request. A personal charge landed on your Public Worship card by mistake? Flag it — that starts you owing the money back, not the other way around.",
      },
      {
        kind: "bullets",
        items: [
          "**Reimbursement — Public Worship owes you:** submit the request in-app with a short note on WHY it was needed, a transaction date on every line, and a receipt for every line — none of that is optional, the app blocks submission until all three are there. Your full bank details (routing + account, not just a last-4) are captured up front too, so the moment someone approves it, the ACH payout fires automatically from the chapter's Increase account — no one has to separately go send it (unless that account isn't set up yet for the chapter, in which case the Treasurer pays it manually instead). It then moves through submitted → approved → paying → paid. Someone else — never you — has to approve it.",
          "**Personal-charge flag — you owe Public Worship:** flag your own charge as personal on My Transactions, or a manager flags it for you. It opens an owed balance, tracked the same way, just pointed the other direction.",
          "**Both directions live in one place:** the Reimbursements tab shows \"Public Worship owes you\" and \"you owe Public Worship\" side by side, so nothing nets out silently.",
          "**Don't recognize a charge at all?** That's different from a personal charge you remember making — flagging it \"personal\" says YOU made it. If a charge on the Public Worship card is a genuine mystery, freeze the card yourself right away (instant, self-serve, reversible), then tell your Treasurer or the Financial Manager immediately so they can look into it. Don't guess by flagging an unrecognized charge as personal.",
        ],
      },
      {
        kind: "rule",
        title: "Approver ≠ you, always",
        text: "Separation of duties means the person who submits a reimbursement is never the person who approves it — even a Treasurer can't approve their own request. It's the same rule for everyone, including the Executive Director. In practice, your chapter's Treasurer approves most requests; if the Treasurer is the one requesting, it's the central Financial Manager who approves instead — their reach covers every chapter, which is exactly the failsafe for \"the approver and the requester would otherwise be the same person.\"",
      },
      {
        kind: "tip",
        text: "**Something time-sensitive?** There's no in-app \"urgent\" flag or fast lane — a request sits in the same queue whether it's due in an hour or next month. Submitting already emails every approver who could act on it — your chapter's Treasurer(s) and the central Financial Manager(s) — so nobody has to be checking the queue on faith. If it's genuinely urgent, that email is your baseline, not your whole plan: also reach your Treasurer (or the Financial Manager, if they're the one who'd have to approve it) directly — a call or a text — and ask them to check the queue now. A direct nudge to the person who can actually approve it is what turns \"they'll see it eventually\" into \"they saw it today.\"",
      },
      {
        kind: "try_status",
        title: "A reimbursement request",
        options: [
          { value: "submitted", label: "Submitted", color: "gray" },
          { value: "approved", label: "Approved", color: "amber" },
          { value: "paid", label: "Paid", color: "green" },
        ],
        terminal: "paid",
        caption:
          "Rejected and canceled exist too — those land in your History, not stuck in the middle.",
      },
      {
        kind: "scenario",
        prompt:
          "You're at the store buying event supplies. The Public Worship card is declined — or you realize you left it at home. What's the move?",
        options: [
          {
            text: "Buy it on your own card and quietly let it go — it's not worth the paperwork",
            feedback:
              "That's the exact pattern this system exists to avoid: a small personal cover that never gets tracked. Submit a reimbursement request instead.",
          },
          {
            text: "Pay with your own card, then submit a reimbursement request for it",
            correct: true,
            feedback:
              "Right. Paying out of pocket happens — the fix is tracking it, not hiding it. Submit the reimbursement with your receipt, the transaction date, and why it was needed, and it moves through the normal approve → paid flow.",
          },
          {
            text: "Skip the purchase entirely and try again another day",
            feedback:
              "Sometimes that's fine, but if the team genuinely needs the supplies now, pay and request reimbursement — don't stall the event over a card hiccup.",
          },
          {
            text: "Ask a teammate to \"just cover it\" as a personal favor and move on",
            feedback:
              "Same problem, just handed to someone else — an untracked personal favor instead of a tracked reimbursement.",
          },
        ],
      },
      {
        kind: "scenario",
        prompt:
          "A teammate says, \"Don't worry about the reimbursement, I'll just cover the team dinner myself.\" What's actually the better move?",
        options: [
          {
            text: "Let them — it's generous, and it saves everyone the reimbursement paperwork",
            feedback:
              "Generous, yes — but it takes the expense off the books entirely. A dozen of these a year and nobody can say what the team actually spent.",
          },
          {
            text: "Have them donate the cost to Public Worship, then let Public Worship pay for the dinner on the Public Worship card",
            correct: true,
            feedback:
              "Same generosity, routed correctly: a real, trackable gift instead of an invisible personal favor — and it may be deductible depending on applicable tax rules and the nature of the contribution.",
          },
          {
            text: "Tell them personal generosity toward the team isn't allowed",
            feedback:
              "The generosity is welcome — it just needs to go through a donation, not a silent personal cover.",
          },
          {
            text: "Have them submit a reimbursement made out to a charity instead",
            feedback:
              "That's not how it works — the clean path is a straightforward donation to Public Worship, which then pays the actual expense.",
          },
        ],
      },
    ],
    quiz: [
      {
        prompt: "You paid for event supplies with your own card. What do you do?",
        options: [
          "Submit a reimbursement request with the line items, a receipt and date on each, and why it was needed",
          "Nothing — it evens out eventually",
          "Ask your Treasurer to send you cash directly",
          "Put it on your Public Worship card retroactively",
        ],
        answerIndex: 0,
        explanation:
          "A reimbursement request is the front door for out-of-pocket mission spending — every line needs its own receipt and transaction date, and the request itself needs a short note on why, or it won't submit. That's how \"Public Worship owes you\" gets tracked to paid.",
      },
      {
        prompt: "A personal charge accidentally hit your Public Worship card. What's true?",
        options: [
          "It's fine, the card is shared",
          "Nothing happens automatically",
          "Only a manager can notice this, never you",
          "Flag it — that opens an amount YOU owe Public Worship, tracked until repaid",
        ],
        answerIndex: 3,
        explanation:
          "Flagging is available on your OWN transactions, not just to managers — catching your own mistake early is the fastest way to clear it.",
      },
      {
        prompt: "Your chapter's Treasurer submits a reimbursement request for their own out-of-pocket purchase. Who can approve it?",
        options: [
          "The Treasurer — they hold the seat that normally approves these",
          "The Chapter Director — chapter finance items are theirs to sign off on",
          "The central Financial Manager — SoD blocks the Treasurer from approving their own request, and the FM's central-scope grant reaches every chapter",
          "The Executive Director, automatically, since they outrank the Treasurer",
        ],
        answerIndex: 2,
        explanation:
          "Approver ≠ requester is identity-based — even a Treasurer can't approve their own request. A Chapter Director's finance access doesn't reach reimbursement approval, so the Financial Manager — whose grant covers every chapter — is the real failsafe.",
      },
      {
        prompt: "You spot a charge on the Public Worship card you genuinely don't recognize. What's the right move?",
        options: [
          "Flag it as a personal charge so it's tracked as an owed balance",
          "Freeze the card yourself right away, then tell your Treasurer or the Financial Manager immediately",
          "Wait to see if it happens again before doing anything",
          "Ignore it — the 7-day receipt rule will catch it automatically",
        ],
        answerIndex: 1,
        explanation:
          "Flagging \"personal\" says you made the charge — wrong move for a genuine mystery. Freezing your own card is instant and self-serve, and looping in your Treasurer or the Financial Manager gets it actually investigated.",
      },
      {
        prompt: "Where do you see both directions — what you're owed and what you owe — at once?",
        options: [
          "The Reimbursements tab, side by side",
          "Two different apps",
          "Only in a spreadsheet the Treasurer keeps",
          "You have to ask the Financial Manager",
        ],
        answerIndex: 0,
        explanation:
          "Both directions render together on the same screen — nothing you owe quietly offsets something you're owed without you seeing it.",
      },
    ],
  },

  // ── 34 · Treasurer: the Reconcile grid ─────────────────────────────────────
  {
    slug: "finance-reconcile-grid",
    title: "Running Reconcile",
    subtitle: "Your home screen: code every charge, explicitly",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Reconcile is the Treasurer's spreadsheet-style home: every chapter charge as a row, Category and Budget editable inline, receipts uploaded inline. Nothing here is guessed — a charge only counts against a budget when YOU explicitly link it. There is no automatic matching that quietly assigns spend to the nearest budget.",
      },
      {
        kind: "table",
        headers: ["Filter", "What it catches"],
        rows: [
          ["All", "Every charge, unfiltered"],
          ["Needs budget", "Categorized but not linked to a budget yet"],
          ["Missing receipt", "No receipt uploaded"],
          ["Uncategorized", "No category assigned at all"],
          ["Ready", "Receipt + category + budget all present"],
        ],
      },
      {
        kind: "rule",
        title: "Unattributed is loud on purpose",
        text: "A charge with no explicit budget link doesn't get absorbed into whichever budget looks closest — it shows up as Unattributed on the dashboard, in plain sight, with a one-tap path back into this exact filtered view. Loud and wrong beats quiet and wrong.",
      },
      {
        kind: "try_status",
        title: "One charge, coded",
        options: [
          { value: "unreviewed", label: "Unreviewed", color: "gray" },
          { value: "categorized", label: "Categorized", color: "amber" },
          { value: "reconciled", label: "Reconciled", color: "green" },
        ],
        terminal: "reconciled",
        caption:
          "Excluded is the fourth real status — for charges (like a transfer) that should never count as spend at all.",
      },
    ],
    quiz: [
      {
        prompt: "How does a charge get counted against a budget?",
        options: [
          "The system matches it automatically by category",
          "You explicitly link it to that budget in Reconcile — nothing is derived or guessed",
          "Any charge in the same month as the budget counts",
          "The Chapter Director assigns it",
        ],
        answerIndex: 1,
        explanation:
          "Explicit-only attribution is the whole point: budgets only ever count transactions someone deliberately linked, never inferred matches.",
      },
      {
        prompt: "What does \"Unattributed\" mean on the dashboard?",
        options: [
          "A bug",
          "Spend with no explicit budget link — shown loudly on purpose instead of being silently absorbed somewhere",
          "Money that left the account without a transaction record",
          "Funds waiting on a bank sync",
        ],
        answerIndex: 1,
        explanation:
          "Unattributed is a first-class, visible bucket with a one-tap path into the exact filtered Reconcile view — it's designed to be noticed, not hidden.",
      },
      {
        prompt: "Which Reconcile filter shows charges with no category assigned at all?",
        options: ["Needs budget", "Missing receipt", "Uncategorized", "Ready"],
        answerIndex: 2,
        explanation:
          "Uncategorized is earlier in the pipeline than Needs budget — a charge needs a category before it can be linked to a budget.",
      },
      {
        prompt: "You select 20 charges at once in Reconcile. What can you do?",
        options: [
          "Nothing — only one row at a time can change",
          "Bulk-set their Category, Budget, or mark them Reconciled",
          "Only delete them",
          "Export them to email",
        ],
        answerIndex: 1,
        explanation:
          "Multi-select drives a bulk bar for exactly the actions that make a real month's worth of charges manageable in minutes, not hours.",
      },
    ],
  },

  // ── 35 · Treasurer: chasing receipts ───────────────────────────────────────
  {
    slug: "finance-chasing-receipts",
    title: "Chasing receipts",
    subtitle: "The reminder timeline, and why the lock is your friend",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Cardholders get automatic reminders — you don't have to personally nag every teammate about every charge. Your job is to watch the queue, not manufacture it: escalating cases surface on their own, and the Cards tab shows exactly which cards are approaching the day-7 auto-lock.",
      },
      {
        kind: "bullets",
        items: [
          "**Day 1–3:** a soft reminder goes to the cardholder.",
          "**Day 3+:** the reminder escalates — visible to you as a flagged charge.",
          "**Day 7:** the card locks automatically if the receipt still isn't there. Uploading a receipt at ANY point clears the whole chain, including an already-locked card.",
        ],
      },
      {
        kind: "rule",
        title: "You chase the exceptions, not everyone",
        text: "Most receipts show up before the reminders even matter. Reconcile's Missing receipt filter is your actual worklist — a handful of stragglers each month, not the whole roster.",
      },
      {
        kind: "reveal",
        prompt:
          "A cardholder's card auto-locked three days ago for a missing receipt. They just uploaded it. What do you, the Treasurer, need to do?",
        answer:
          "Nothing — the unlock is automatic the moment the receipt lands. Your job was already done: the reminder timeline and the auto-lock did the chasing for you.",
      },
    ],
    quiz: [
      {
        prompt: "What triggers a card's automatic lock?",
        options: [
          "The Treasurer manually locking it",
          "A charge whose receipt is still missing after 7 days",
          "Reaching a monthly spending cap",
          "Any charge over $500",
        ],
        answerIndex: 1,
        explanation:
          "The day-7 auto-lock is purely about a missing receipt, not spend amount or anyone's manual action.",
      },
      {
        prompt: "A card auto-locked for a missing receipt. Who needs to unlock it?",
        options: [
          "The Financial Manager, by hand",
          "Nobody — uploading the missing receipt unlocks it automatically",
          "The Executive Director",
          "It stays locked until next month",
        ],
        answerIndex: 1,
        explanation:
          "The unlock path is identical to preventing the lock in the first place: upload the receipt and it clears, no review step.",
      },
      {
        prompt: "What's the Treasurer's actual daily worklist for receipts?",
        options: [
          "Personally message every cardholder every day",
          "The Missing receipt filter in Reconcile — the handful of stragglers, not the whole roster",
          "A shared spreadsheet outside the app",
          "There isn't one; it's fully automatic",
        ],
        answerIndex: 1,
        explanation:
          "The reminder timeline handles the routine cases; the filter is where you spend your actual attention.",
      },
    ],
  },

  // ── 36 · Treasurer: the monthly close ──────────────────────────────────────
  {
    slug: "finance-monthly-close",
    title: "The monthly close",
    subtitle: "Everything true in under 30 minutes",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The whole Treasurer job compresses into one target: close the month in under 30 minutes. That's only possible because the work was done continuously — Reconcile kept current, receipts chased as they came due — not saved up for month-end.",
      },
      {
        kind: "rule",
        title: "Close is a check, not a marathon",
        text: "If close is taking hours, the real problem happened three weeks earlier: charges piled up uncategorized, receipts went unchased, budgets went unlinked. A clean close is proof the month was run well, not a task in itself.",
      },
      {
        kind: "bullets",
        items: [
          "**Reconcile at Ready:** every charge has a receipt, a category, and a budget link — the Ready filter's count climbs toward all of them.",
          "**Reimbursement queue triaged:** nothing sitting unreviewed that's actually yours to act on — the submission email is a nudge, not a substitute for actually clearing the queue.",
          "**Report up:** the central Financial Manager should be able to open your chapter's numbers and trust them without a conversation — that trust IS the north-star metric this whole system is built around.",
        ],
      },
      {
        kind: "try_ready",
        criteria: [
          "Every charge has a receipt or an explicit personal-charge flag",
          "Every charge is categorized and linked to a budget",
          "The reimbursement queue has nothing waiting on you",
          "Unattributed spend is at zero or explained",
        ],
      },
    ],
    quiz: [
      {
        prompt: "What's the Treasurer's monthly-close target?",
        options: [
          "Under 30 minutes",
          "A full business day",
          "One week",
          "There's no target, just \"eventually\"",
        ],
        answerIndex: 0,
        explanation:
          "Under 30 minutes is the north-star target — and it's only reachable if the month was reconciled continuously, not all at once.",
      },
      {
        prompt: "Why would a close take hours instead of minutes?",
        options: [
          "The app is slow",
          "The real work — reconciling, chasing receipts — didn't happen continuously during the month",
          "There are too many backers",
          "Central hasn't approved the budget yet",
        ],
        answerIndex: 1,
        explanation:
          "A long close is a symptom, not the disease — it means Reconcile and receipt-chasing were deferred instead of done as the month went.",
      },
      {
        prompt: "Who should be able to trust your chapter's numbers without asking you anything?",
        options: [
          "Only you",
          "The central Financial Manager",
          "Every backer individually",
          "Nobody needs to — the numbers are internal",
        ],
        answerIndex: 1,
        explanation:
          "The FM trusting every chapter's numbers without asking is the system's stated north-star metric, right alongside the 30-minute close.",
      },
    ],
  },

  // ── 37 · Chapter Director: raise vs. manage ────────────────────────────────
  {
    slug: "finance-raise-vs-manage",
    title: "Raise vs. manage",
    subtitle: "Three people, three jobs, on purpose",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The playbook splits money into three separate jobs, held by three different humans: the Chapter Director **raises** it (backers), the Treasurer **records** it (Reconcile, receipts, budgets), and the central Financial Manager **oversees** it (audit, cross-chapter trust). As Chapter Director, your finance job is raising and approving — not bookkeeping.",
      },
      {
        kind: "table",
        headers: ["Job", "Who", "What it is NOT"],
        rows: [
          ["Raise", "Chapter Director", "Recording transactions — that's the Treasurer's job"],
          ["Record", "Treasurer", "Fundraising — a Treasurer never fundraises"],
          ["Oversee", "Central Financial Manager", "Day-to-day approval — the FM audits, doesn't run your chapter"],
        ],
      },
      {
        kind: "rule",
        title: "Separation of duties is identity-based, not a courtesy",
        text: "The system enforces approver ≠ requester by the actual person, not by job title — even if you personally hold two seats, you can't approve something you yourself submitted. It's the same protection everywhere in the app, not a special rule just for you.",
      },
      {
        kind: "reveal",
        prompt:
          "As Chapter Director, can you also do the Treasurer's Reconcile work if they're on vacation?",
        answer:
          "You could technically cover the gap, but the playbook's raise/record/oversee split exists precisely so no one person controls all three jobs long-term. Cover a gap; don't make dual-hatting your chapter's normal state — it's a transition condition, not a design.",
      },
    ],
    quiz: [
      {
        prompt: "In the raise/record/oversee split, what does the Chapter Director do?",
        options: [
          "Records every transaction",
          "Raises money (backers) and approves chapter budgets",
          "Audits every other chapter",
          "Issues cards",
        ],
        answerIndex: 1,
        explanation:
          "Raising and approving are the Director's two jobs — recording is the Treasurer's, and cross-chapter audit is the FM's.",
      },
      {
        prompt: "Why does a Treasurer never fundraise?",
        options: [
          "It's against the law",
          "The three jobs are deliberately separated so no one role controls raising, recording, AND approving money",
          "Treasurers dislike fundraising",
          "There's no reason, it's just convention",
        ],
        answerIndex: 1,
        explanation:
          "The three-party separation is the mandated structure the playbook uses to keep any single person from controlling the whole money loop.",
      },
      {
        prompt: "How does the system enforce \"approver ≠ requester\"?",
        options: [
          "By job title only",
          "By the actual person's identity — even a dual-hat holder can't approve their own submission",
          "It doesn't enforce it; it's just a guideline",
          "Only for reimbursements, not budgets",
        ],
        answerIndex: 1,
        explanation:
          "SoD is identity-based (personId + auth email), not role-based, and it applies everywhere approvals happen — reimbursements and budgets alike.",
      },
    ],
  },

  // ── 38 · Chapter Director: approving budgets ───────────────────────────────
  {
    slug: "finance-approving-budgets",
    title: "Approving budgets",
    subtitle: "The 85% principle — submit, approve, and why raising the cap isn't automatic",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Within your chapter's 85% (what's left after the skim to central), you approve freely — the playbook's rule is mission/vision confines, not central sign-off. Central's role is auditing your numbers after the fact, not gating your spending before it.",
      },
      {
        kind: "rule",
        title: "The 85% principle",
        text: "Inside your chapter's own operating money, the Chapter Director approves budgets that fit the chapter's mission and vision — full stop. Central never pre-approves a chapter budget; the Financial Manager's oversight is audit, not a gate.",
      },
      {
        kind: "bullets",
        items: [
          "**How it works:** whoever plans a budget taps **Submit for approval** right on its card. It then shows **Awaiting approval** to anyone who can act on it — tap **Approve** or **Request changes** (with a reason) straight from that same card.",
          "**Who approves what:** a chapter budget is approved by you (the Chapter Director); your Treasurer can also approve one if you were the one who submitted it — separation of duties always picks whoever ISN'T the requester, even a dual-hat holder acting on their own submission.",
          "**Central budgets are the mirror image:** approved by the Executive Director, or the Financial Manager if the ED submitted it.",
          "**Over the approved cap:** spending past what a budget allows raises a loud warning right on the card — it doesn't block the card yet.",
        ],
      },
      {
        kind: "tip",
        text: "**Increasing an approved budget kicks it back to Draft — but nobody's told.** Bump the amount on a budget that's already Approved, and it drops straight back to Draft the moment you save the higher number — NOT Awaiting approval, and NOT auto-submitted. The OLD approved amount keeps working as the spending cap the whole time, so nothing silently expands — but the increase itself sits invisible to every approver until YOU deliberately tap Submit for approval again. Skip that tap and the raise is never reviewed, and no approver is ever notified. Decreasing a budget, or reshuffling its line items, never triggers any of this.",
      },
      {
        kind: "reveal",
        prompt:
          "Your Treasurer submits a budget they wrote for their own project. Can they approve it themselves?",
        answer:
          "No — separation of duties applies to budgets exactly like reimbursements: whoever submits can never be the one who approves, even a Treasurer on their own project. It routes to you, the Chapter Director, instead.",
      },
    ],
    quiz: [
      {
        prompt: "Within a chapter's 85%, who approves how the money gets spent?",
        options: [
          "Central has to sign off on everything first",
          "The Chapter Director, freely, within mission/vision — central doesn't pre-approve chapter budgets",
          "Nobody — it's unrestricted",
          "The Treasurer alone",
        ],
        answerIndex: 1,
        explanation:
          "The 85% principle is explicit: chapters approve freely within their own money; central's control is audit, not a gate.",
      },
      {
        prompt: "What is central's role in a chapter's budget, per the 85% principle?",
        options: [
          "Approving every line item",
          "Auditing after the fact — oversight, not a gate",
          "Setting the chapter's spending limit line by line",
          "Central has no visibility at all",
        ],
        answerIndex: 1,
        explanation:
          "The Financial Manager's cross-chapter audit is oversight after the money moves, not pre-approval before it does.",
      },
      {
        prompt: "You bump an APPROVED budget's amount from $2,000 to $3,000. What happens?",
        options: [
          "Nothing — the higher amount is available immediately",
          "It drops back to Draft — NOT auto-submitted; the old $2,000 stays the spending cap, and the increase won't be reviewed until you send it for approval again",
          "The budget is deleted and a new one is created",
          "Only a Financial Manager can ever raise a budget's amount",
        ],
        answerIndex: 1,
        explanation:
          "An increase past the approved cap flips the budget back to Draft, not Awaiting approval — it's fully editable and invisible to approvers until you deliberately submit it again. The old approved amount keeps enforcing the cap the whole time it sits unsent. Decreases and line reshuffles never trigger any of this.",
      },
    ],
  },

  // ── 39 · Tiers, the covenant, and the skim ─────────────────────────────────
  // Moved OUT of the Chapter Director course into the shared
  // `chapter-money-model` course (Treasurer + Chapter Director both build on
  // it) — see `FINANCES_COURSES` below. The section itself, its slug, and its
  // curriculum position are unchanged; only its course membership moved.
  {
    slug: "finance-tiers-and-skim",
    title: "Tiers, the covenant, and the skim",
    subtitle: "What backer count buys you, and what goes back to central",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "A chapter's backer count — headcount, never dollars — sets its tier, and every tier unlocks more of the mission. This is the covenant: chapters commit to raising; central commits to what the tiers promise.",
      },
      {
        kind: "table",
        headers: ["Backers", "Tier unlocks"],
        rows: [
          ["20", "Worship With Strangers (WWS) — the baseline program"],
          ["30", "+ Eden"],
          ["50", "+ LTN"],
        ],
      },
      {
        kind: "p",
        text: "The chapter operating formula is $570 fixed + $20 per teammate, plus a conference sinking fund per funded seat (~$275÷12 for a driving city, ~$500÷12 for a flight). For a 5-person team that floor lands around $670/month — film, food, transport, storage, software, the ordinary costs of running the mission.",
      },
      {
        kind: "rule",
        title: "The skim funds the next city",
        text: "Every month, a flat **15%** of chapter revenue moves — as a real transfer, not a budget line — from the chapter's account to central's City Launch Fund. That fund is what pays a new city's ~$7,800–8,300 launch cost (equipment + the training trip) when it's ready to start.",
      },
      {
        kind: "tip",
        text: "**Where the backer number itself comes from:** it's reported straight from the Giving page now, not typed in by hand. Every ACTIVE pledge at or above the $50 floor recomputes the count automatically the moment a backer subscribes, misses a payment, or cancels (see the Development stream's backer-model course for the full lifecycle). A manual override still exists, but only as a fallback during the Givebutter migration window — once a chapter's pledges are current, nobody hand-types this number again.",
      },
      {
        kind: "reveal",
        prompt:
          "Your chapter crosses 31 backers this month. What tier are you in, and does the extra backer above 30 change your skim rate?",
        answer:
          "You're at the 30-backer tier (+Eden unlocked) until you reach 50. The skim rate stays a flat 15% regardless of tier — more backers means more revenue, and 15% of more is more, but the percentage itself doesn't change.",
      },
    ],
    quiz: [
      {
        prompt: "What sets a chapter's tier?",
        options: [
          "Total dollars raised in a year",
          "Backer headcount — the 20/30/50 thresholds",
          "How many events the chapter runs",
          "How long the chapter has existed",
        ],
        answerIndex: 1,
        explanation:
          "Tiers are keyed on backer count, exactly like every other constant in the model — headcount, never dollars.",
      },
      {
        prompt: "What percentage of chapter revenue moves to central each month?",
        options: [
          "A flat 15%, as a real transfer to the City Launch Fund",
          "0% — chapters keep everything",
          "50%",
          "It varies by chapter size",
        ],
        answerIndex: 0,
        explanation:
          "The skim is flat 15% for every chapter, modeled as an actual transfer, not just a number on a report.",
      },
      {
        prompt: "What does the City Launch Fund pay for?",
        options: [
          "Chapter operating expenses",
          "A new city's one-time launch cost — equipment and the training trip",
          "Reimbursements",
          "Backer refunds",
        ],
        answerIndex: 1,
        explanation:
          "The fund exists specifically to seed the NEXT city — every chapter's skim is an investment in the network growing.",
      },
      {
        prompt: "Does reaching a higher backer tier change the skim percentage?",
        options: [
          "Yes, higher tiers pay a higher percentage",
          "No — the skim stays a flat 15% regardless of tier; more backers just means more total revenue",
          "Yes, it drops as chapters grow",
          "The skim only starts after 50 backers",
        ],
        answerIndex: 1,
        explanation:
          "The percentage is constant; only the base it's applied to grows as a chapter adds backers.",
      },
      {
        prompt: "Where does a chapter's backer count actually come from today?",
        options: [
          "The Treasurer types it in by hand every month",
          "It's recomputed automatically from active $50+ pledges on the Giving page — a manual override only survives as a Givebutter-migration fallback",
          "Central emails it to the chapter once a quarter",
          "It's calculated once a year during budgeting season",
        ],
        answerIndex: 1,
        explanation:
          "The count is derived, live, from real pledge activity — the old manual-entry seam only sticks around as a fallback while chapters finish moving off Givebutter.",
      },
    ],
  },

  // ── 40 · Financial Manager: cross-chapter audit ────────────────────────────
  {
    slug: "finance-cross-chapter-audit",
    title: "Auditing every chapter",
    subtitle: "The central rollup, drill-down, and the trust you're building",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "As Financial Manager, your dashboard opens to the central view: every chapter as a row in one rollup, each with its month's spend against its budget. Tap a chapter and you're inside its own dashboard — the same view its Treasurer sees — so you can verify, not just skim a summary number.",
      },
      {
        kind: "bullets",
        items: [
          "**By-chapter rollup:** every chapter, plus Central itself as its own row — spend, budget, and status side by side.",
          "**Drill-down:** open any chapter and see exactly what its Treasurer sees, real numbers, not a redacted export.",
          "**By-tag rollup:** an org-wide breakdown tappable into the contributing budgets across chapters.",
        ],
      },
      {
        kind: "rule",
        title: "Trust, not permission",
        text: "You're not a gate a chapter's spending waits behind — you're the person who can look at any chapter's numbers at any time and vouch for them. The north-star metric for this whole system is exactly that: you trust every chapter's numbers without having to ask anyone.",
      },
      {
        kind: "reveal",
        prompt:
          "A chapter's dashboard shows a large Unattributed balance this month. What's your move as Financial Manager?",
        answer:
          "Drill into that chapter's Reconcile — the same one-tap path its Treasurer has — and see what's sitting unlinked. It's a conversation starter with the Treasurer, not a punishment: Unattributed being visible at all is the system working; ignoring it would be the failure.",
      },
    ],
    quiz: [
      {
        prompt: "What does the central rollup show?",
        options: [
          "Only central's own budgets",
          "Every chapter as a row — spend vs budget — plus Central's own row",
          "A single combined number with no chapter breakdown",
          "Nothing until a chapter submits a report",
        ],
        answerIndex: 1,
        explanation:
          "The rollup is per-chapter, side by side, with Central appearing as a row exactly like every chapter — nothing is pre-aggregated away.",
      },
      {
        prompt: "When you drill into a chapter from the central view, what do you see?",
        options: [
          "A summary PDF",
          "The exact same dashboard that chapter's own Treasurer sees",
          "Nothing — drill-down is view-only metadata",
          "Only that chapter's card list",
        ],
        answerIndex: 1,
        explanation:
          "Drill-down re-checks your central reach and then shows the chapter's real dashboard — the FM's audit tool IS the chapter's own view.",
      },
      {
        prompt: "What's the FM's actual relationship to a chapter's spending?",
        options: [
          "A gate every purchase must pass first",
          "An auditor who can verify any chapter's numbers at any time — oversight, not pre-approval",
          "No relationship — chapters are fully independent",
          "The FM personally approves every transaction",
        ],
        answerIndex: 1,
        explanation:
          "The FM audits and can escalate receipt-chasing, but chapter budgets are approved by the Chapter Director, not pre-cleared by the FM.",
      },
    ],
  },

  // ── 41 · Financial Manager: the receipt escalation queue ───────────────────
  {
    slug: "finance-receipt-escalation-queue",
    title: "The receipt escalation queue",
    subtitle: "Watching for cards nearing the day-7 lock, chapter-wide",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "The same receipt timeline every cardholder lives under — reminder, escalation, day-7 auto-lock — rolls up to you across every chapter. The Cards view's escalation queue is where you see which cards are closest to locking, before it happens.",
      },
      {
        kind: "table",
        headers: ["Stage", "What it means for you"],
        rows: [
          ["Flagged (day 1–3)", "Still routine — the cardholder likely hasn't noticed yet"],
          ["Escalated (day 3+)", "Worth a nudge if it's a repeat pattern for that person"],
          ["Locked (day 7)", "Automatic — no action needed from you; it lifts the moment a receipt lands"],
        ],
      },
      {
        kind: "rule",
        title: "You watch patterns, not individual charges",
        text: "One missing receipt is normal life. The same cardholder hitting escalation every month is the thing worth a real conversation — the queue is there so you notice the pattern, not so you personally chase every stray charge.",
      },
      {
        kind: "try_status",
        title: "A charge moving through the timeline",
        options: [
          { value: "active", label: "Active, no issue", color: "gray" },
          { value: "flagged", label: "Flagged", color: "amber" },
          { value: "escalated", label: "Escalated", color: "amber" },
          { value: "cleared", label: "Receipt uploaded — cleared", color: "green" },
        ],
        terminal: "cleared",
        caption:
          "Notice the card never needs YOU to unlock it — a receipt landing at any stage clears the whole chain.",
      },
    ],
    quiz: [
      {
        prompt: "What does the FM's escalation queue surface?",
        options: [
          "Every single charge in the system",
          "Cards approaching or past the day-7 receipt auto-lock, across all chapters",
          "Only locked cards",
          "Budget approval requests",
        ],
        answerIndex: 1,
        explanation:
          "The queue is scoped to the receipt timeline specifically — the FM's cross-chapter view of the exact same mechanic every member lives under.",
      },
      {
        prompt: "A cardholder hits \"escalated\" once this month. What's the right response?",
        options: [
          "Lock their card personally right away",
          "Nothing unusual — one instance is normal; a repeating pattern for the same person is what's worth a conversation",
          "Report them to the Executive Director",
          "Cancel their card",
        ],
        answerIndex: 1,
        explanation:
          "The queue exists to catch PATTERNS across months, not to turn a single late receipt into an incident.",
      },
      {
        prompt: "Who unlocks a card that hit the day-7 auto-lock?",
        options: [
          "The Financial Manager, manually, each time",
          "Nobody has to — uploading the missing receipt unlocks it automatically",
          "It requires an Increase support ticket",
          "It stays locked for 30 days regardless",
        ],
        answerIndex: 1,
        explanation:
          "The unlock mechanic is identical for every seat — receipt lands, lock lifts, no manual review anywhere in the chain.",
      },
    ],
  },

  // ── 42 · Financial Manager: accounts, cards, and the City Launch Fund ──────
  {
    slug: "finance-accounts-and-cards-admin",
    title: "Accounts, cards, and the City Launch Fund",
    subtitle: "The ED/FM-only administration surface",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every chapter — and central itself — has its own Increase account, provisioned automatically. Central's own account is where the City Launch Fund balance actually lives. The Accounts tab that shows all of this is visible ONLY to Executive Director and Financial Manager seats; chapters never see it, they just have a working card program.",
      },
      {
        kind: "bullets",
        items: [
          "**Accounts tab:** a quiet status/audit view — account health, not a place chapters configure anything.",
          "**Card lifecycle you administer today:** you (or the Treasurer) issue a card directly to a cardholder, and you lock or unlock any card in your scope whenever it needs to go dark or come back — the same `lockCard`/`unlockCard` mechanism the day-7 receipt auto-lock itself runs on.",
          "**A compromised card is a phone call, not a click:** a cardholder who suspects fraud contacts their Treasurer (chapter) or you (central) right away — there's no self-serve freeze yet, so a manager lock is what protects them, the moment they reach out.",
        ],
      },
      {
        kind: "rule",
        title: "Opaque by design",
        text: "The accounts layer became fully automatic and opaque on purpose — no one pastes in an Increase account ID anymore, no chapter picks a bank account from a dropdown. Your visibility into it is a deliberate exception for exactly two seats: ED and FM.",
      },
      {
        kind: "tip",
        text: "**Three new card-lifecycle features are now live (WP-C.1):** A cardholder can self-serve freeze their own card instantly (suspected foul play) — it's instant and reversible by them alone. An FM or Treasurer can permanently cancel/close a card (a member who had one canceled can request a replacement). And any member can request a card (one open request at a time); you approve it (which issues the card) or deny it. The old direct-issuance flow still works as a manager shortcut.",
      },
      {
        kind: "tip",
        text: "**Card prerequisite (org-wide, optional):** central finance can require a member to finish a specific finance Academy course before a card is issued — set it in the Accounts screen's *Receipt & card policy* section. It's OFF by default. When it's set, requesting a card still works; the gate is at ISSUANCE, so a member can request, finish the course, then be approved. In the cards admin an untrained cardholder reads **Needs training**, so you can see at a glance who's ready. (If the configured course doesn't exist, the gate stays off rather than blocking everyone.)",
      },
      {
        kind: "reveal",
        prompt:
          "A member emails asking you to freeze their card because their phone was stolen. What do you tell them?",
        answer:
          "The cardholder freezes it themselves instantly — they don't need to wait for a manager. It's self-serve and reversible by them alone. Tell them to freeze it now in their card settings, then loop in their Treasurer or you for next steps (for example, if they need to request a replacement card). The self-serve freeze is fastest protection; they can act before they even finish emailing you.",
      },
    ],
    quiz: [
      {
        prompt: "Who can see the Accounts tab?",
        options: [
          "Every finance seat",
          "Only Executive Director and Financial Manager seats",
          "Every chapter member",
          "Only the account's original creator",
        ],
        answerIndex: 1,
        explanation:
          "Accounts visibility is tighter than general finance-seat access — ED and FM only, chapters never see it.",
      },
      {
        prompt: "Where does the City Launch Fund's balance actually live?",
        options: [
          "A spreadsheet central maintains manually",
          "Central's own Increase account — central has an account just like every chapter",
          "Split evenly across all chapter accounts",
          "It's a virtual number with no real account",
        ],
        answerIndex: 1,
        explanation:
          "Central is provisioned its own real account (WP-1.2), and that account is the City Launch Fund's actual home.",
      },
      {
        prompt: "A cardholder suspects their card was compromised. What's the shipped response today?",
        options: [
          "They freeze it themselves instantly, self-serve",
          "They contact their Treasurer or Financial Manager immediately, who locks it with the manager lock/unlock mechanism",
          "They wait for the day-7 receipt auto-lock to catch it",
          "They open an Increase support ticket",
        ],
        answerIndex: 0,
        explanation:
          "The cardholder freezes it themselves instantly — it's self-serve and reversible by them alone. That's the fastest real protection. They should also tell their Treasurer or FM, but the freeze action doesn't need to wait for a manager to respond.",
      },
      {
        prompt: "Are self-serve freeze, card cancel/close, and a member request-a-card flow live today?",
        options: [
          "Yes, all three are live",
          "Not yet — they're near-term (WP-C.1) additions; the only shipped control today is a manager's lock/unlock",
          "Only cancel/close is live",
          "Only self-serve freeze is live",
        ],
        answerIndex: 0,
        explanation:
          "All three shipped together in WP-C.1: a cardholder can self-serve freeze/unfreeze their own card instantly (reversible), an FM or Treasurer can permanently cancel/close a card, and any member can submit a card request (with at most one open request at a time) for you to approve or deny.",
      },
      {
        prompt:
          "Central finance has set a required Academy course before a card can be issued. A member who hasn't finished it requests a card. What happens?",
        options: [
          "Their request is blocked — they can't even submit it until they finish",
          "The request goes through; you just can't issue/approve the card until they complete the course, and they show as 'Needs training' until then",
          "The card is issued anyway — the requirement only applies to direct issuance",
          "Their existing card is locked until they finish",
        ],
        answerIndex: 1,
        explanation:
          "The prerequisite gates ISSUANCE, not the request. A member can request now, finish the course, and then be approved — and the cards admin flags an untrained cardholder as 'Needs training' so you can see who's ready. The requirement is off by default and set on the Accounts screen.",
      },
    ],
  },

  // ── 43 · Executive Director: central budgets ───────────────────────────────
  {
    slug: "finance-central-budgets",
    title: "Central budgets",
    subtitle: "Central's own money, planned the same way a chapter's is",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Central isn't a bookkeeping abstraction — it has its own budgets, its own line, and its own row in every rollup, using the exact same budget machinery every chapter uses. A central budget's chapter field is literally the string \"central\", not a null or a special case bolted onto the side.",
      },
      {
        kind: "bullets",
        items: [
          "**New budget, central scope:** created the same way a chapter budget is, just scoped to central instead of a chapter.",
          "**Central's rollup row:** sits alongside every chapter in the by-chapter view, with the identical drill-down behavior.",
          "**What lives here:** central operating costs, the City Launch Fund balance, and — as launch grants come online — the money that seeds new cities.",
        ],
      },
      {
        kind: "rule",
        title: "One system, one set of rules",
        text: "Central spending follows the same invariants as chapter spending: actuals come only from explicitly-linked transactions, an over-cap budget gets a loud warning, and approval follows the mirror-image of a chapter's SoD — you approve central budgets, and the Financial Manager approves if you were the one who submitted it.",
      },
      {
        kind: "reveal",
        prompt:
          "Why does central use the exact same budget tables and rules as a chapter, instead of its own separate system?",
        answer:
          "Because \"central\" is just another scope in the same model (a sentinel string, not a parallel structure) — every rule, report, and rollup that works for a chapter works for central automatically, with nothing built twice.",
      },
    ],
    quiz: [
      {
        prompt: "How is a central budget represented in the system?",
        options: [
          "A completely separate table from chapter budgets",
          "The same budget structure, scoped with the sentinel value \"central\" instead of a chapter",
          "A null chapterId",
          "A spreadsheet outside the app",
        ],
        answerIndex: 1,
        explanation:
          "Central is a string sentinel, never null — the deliberate pattern this codebase uses everywhere central needs to be its own scope.",
      },
      {
        prompt: "Where does central appear in the by-chapter rollup?",
        options: [
          "It doesn't — central is invisible there",
          "As its own row, with the same drill-down every chapter gets",
          "Only as a footnote at the bottom",
          "Central has a separate dashboard with no rollup at all",
        ],
        answerIndex: 1,
        explanation:
          "Central gets a real row in the rollup, not special-cased out of it — the whole point of treating it as a scope, not an exception.",
      },
      {
        prompt: "Who approves a central budget you didn't personally submit?",
        options: [
          "You, the Executive Director",
          "Only the Treasurer",
          "No one — central budgets don't need approval",
          "Every chapter director votes",
        ],
        answerIndex: 0,
        explanation:
          "Central budget approval mirrors a chapter's: the ED approves, and SoD only reroutes to the FM if the ED was the one who submitted it.",
      },
    ],
  },

  // ── 44 · Executive Director: governance and seats ──────────────────────────
  {
    slug: "finance-governance-and-seats",
    title: "Governance and seats",
    subtitle: "One seat, one holder — and the honest seat switcher",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Seats get assigned from the **Org Chart** tab: a superuser can assign a holder directly, and anyone else proposes a change for the seat's holder (or the seat above it) to confirm — a two-party handoff, not a unilateral edit. Executive Director and Financial Manager sit at central; Chapter Director and Treasurer sit per chapter. Each is one holder per seat — assigning a new Executive Director replaces the old one, it doesn't add a second. Editing the chart's STRUCTURE itself (adding, moving, or removing seats) is separate and narrower: only the Executive Director or a superuser can do that.",
      },
      {
        kind: "table",
        headers: ["Seat", "Scope", "In UI copy"],
        rows: [
          ["Executive Director", "Central only", "Executive Director"],
          ["Financial Manager", "Central or chapter", "Financial Manager (central) / Treasurer (chapter)"],
          ["Chapter Director", "Chapter only", "Chapter Director"],
        ],
      },
      {
        kind: "p",
        text: "Today, some people genuinely hold two real seats at once — you might be Executive Director AND a Chapter Director. That's not a bug or a special permission: if you hold seats at both central and a chapter, you get an honest **seat switcher** (\"which desk are you at?\") that lists exactly your real seats. Someone with one seat never sees a switcher at all.",
      },
      {
        kind: "rule",
        title: "Dual-hatting is a phase, not a design",
        text: "The playbook's end state has no one holding both a central and a chapter seat — dual-hatting exists only because a city is small early on. As chapters grow their own leadership, the seat switcher naturally has less and less to switch between.",
      },
      {
        kind: "reveal",
        prompt:
          "You're seated as both Executive Director and a Chapter Director. The finance dashboard opens — what decides which view you land on?",
        answer:
          "Your seat switcher lets you pick which desk you're at; the dashboard then shows exactly that seat's real view. There's no \"preview\" mode pretending to be a seat you don't hold — only your genuine seats, listed honestly.",
      },
    ],
    quiz: [
      {
        prompt: "How many holders can one seat (e.g. Executive Director) have at once?",
        options: [
          "Unlimited",
          "One — assigning a new holder replaces the old one",
          "Two, for redundancy",
          "It depends on chapter size",
        ],
        answerIndex: 1,
        explanation:
          "Seats are one-holder slots per (scope, title) — a new assignment replaces, it never stacks.",
      },
      {
        prompt: "Who sees a seat switcher in the finance dashboard?",
        options: [
          "Everyone, always",
          "Only someone who genuinely holds seats at both central and a chapter",
          "Only the Executive Director",
          "Nobody — switchers were removed entirely",
        ],
        answerIndex: 1,
        explanation:
          "Single-seat holders never see a switcher — it exists purely for the real, transition-period case of holding two real seats.",
      },
      {
        prompt: "What does the playbook say about dual-hatting long-term?",
        options: [
          "It's the permanent design",
          "It's a transition state that should empty out as chapters mature — no one holds both a central and chapter seat at steady state",
          "It should apply to every leader",
          "It only applies to Treasurers",
        ],
        answerIndex: 1,
        explanation:
          "The playbook explicitly calls for no dual-hatting across central and chapter once a city is established — today's overlap is a startup condition.",
      },
    ],
  },

  // ── 45 · Executive Director: launch grants + the skim transfer ─────────────
  {
    slug: "finance-launch-grants-and-transfers",
    title: "Launch grants and the skim transfer",
    subtitle: "What's live today, and what's coming with Phase 4",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Two money flows tie the whole network together: the 15% skim moving UP from every chapter into the City Launch Fund, and a one-time launch grant moving DOWN from central to seed a brand-new city. The fund itself is real today — it's central's own account. Moving money automatically along both directions is coming next.",
      },
      {
        kind: "table",
        headers: ["Flow", "Direction", "What it funds"],
        rows: [
          ["The skim", "Chapter → Central, monthly", "The City Launch Fund"],
          ["Launch grant", "Central → new chapter, one-time", "Equipment (~$4,300) + the training trip (~$3,500–4,000)"],
        ],
      },
      {
        kind: "rule",
        title: "The fund exists; the pipe doesn't, yet",
        text: "The City Launch Fund's balance is a real number in a real central account you can see today. What's still ahead: the skim transfer running itself every month, and a launch grant that stamps a new chapter's launch budget automatically the day it's approved.",
      },
      {
        kind: "tip",
        text: "**Coming soon:** both flows will be modeled as `transfer` rows once built (Phase 4 of the finance roadmap) — excluded from category/budget spend like any transfer, so they never distort a chapter's or central's real operating numbers. Until then, treat the skim and launch grants as manual moves you track, not automated ones the app runs for you.",
      },
      {
        kind: "reveal",
        prompt:
          "A brand-new city is ready to launch. Where does its ~$7,800–8,300 in equipment and training-trip funding come from?",
        answer:
          "The City Launch Fund — the pool every existing chapter has been feeding with its monthly 15% skim. The fund's balance is real and visible today; the one-time transfer that hands it to the new chapter is the part still being built.",
      },
    ],
    quiz: [
      {
        prompt: "What does the City Launch Fund pay for?",
        options: [
          "Ongoing chapter operating costs",
          "A new city's one-time launch cost — equipment and training trip",
          "Reimbursements to individual members",
          "Central's own salaries",
        ],
        answerIndex: 1,
        explanation:
          "The fund's entire purpose is seeding the next city's launch — a one-time cost, not recurring operations.",
      },
      {
        prompt: "Is the monthly skim transfer automated today?",
        options: [
          "Yes, fully automatic",
          "The fund's balance is real today; automating the transfer itself is a coming addition",
          "It was automated then removed",
          "It only runs once a year",
        ],
        answerIndex: 1,
        explanation:
          "Central's account and the fund balance are live now (WP-1.2); the automatic monthly transfer is Phase 4 work, still ahead.",
      },
      {
        prompt: "Why will skim and launch-grant transfers be modeled as `flow:\"transfer\"` rows once built?",
        options: [
          "So they count double toward budgets",
          "So they're excluded from category/budget spend, like any money movement that isn't a mission purchase",
          "It's a legal requirement",
          "So central pays less tax",
        ],
        answerIndex: 1,
        explanation:
          "Transfers are excluded from category/budget spend everywhere in this system — the skim and launch grants are money MOVEMENTS, not purchases, and must never distort actuals.",
      },
    ],
  },

  // ── 46 · Chapter money model: the budget lifecycle ─────────────────────────
  // New (chapter-money-model course). Submitter's-eye view of draft → send for
  // review → approve/request-changes, generic across chapter and central scope
  // — the CD-specific "85% principle" framing stays in `finance-approving-
  // budgets`, owned by the Chapter Director course. Authored from the shipped
  // workflow: `apps/convex/finances.ts` (`submitBudgetForApproval`,
  // `approveBudget`, `requestBudgetChanges`, `BUDGET_APPROVAL_STATUSES` in
  // `@events-os/shared`'s `finance.ts`) + the on-card actions in
  // `BudgetApprovalActions.tsx` / `BudgetCreateModal.tsx` ("Send for review",
  // "Request changes"). The temporary superuser self-approval bypass
  // (WP-wave4 item 8, an owner-only solo-backfill exception) is deliberately
  // left out — it's not part of the rule this audience needs.
  {
    slug: "finance-budget-lifecycle",
    title: "The budget lifecycle",
    subtitle: "Draft, send for review, approve — never by the person who sent it",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "An event or project doesn't automatically get a budget — plenty are pure work-tracking, no dollars involved. A budget only exists once real money enters the picture: type a planned amount in when you create it and a Draft budget is created right then, or tap **Add budget** on the event or project's own page later, once there's actually something to plan. Either way, nothing is approved yet — a budget is a plan until someone deliberately moves it forward.",
      },
      {
        kind: "bullets",
        items: [
          "**Draft** — the amount and line items are yours to edit freely. Nobody outside your own head has weighed in yet, and nothing you type here spends anything.",
          "**Send for review** — a deliberate tap, never an autosave. The moment you send it, the budget is Awaiting approval and visible to whoever can act on it.",
          "**Approve or Request changes** — the approver either clears it (Approved) or kicks it back with a reason (Changes requested), which reopens it for editing and a fresh send.",
          "**Who approves what** — a chapter budget's approver is its Treasurer or Chapter Director; a central budget's is the Executive Director or Financial Manager.",
        ],
      },
      {
        kind: "rule",
        title: "Approver ≠ submitter, no exceptions",
        text: "Separation of duties means whoever sends a budget for review can never be the one who approves it — the same identity-based rule that governs reimbursements, applied to budgets.",
      },
      {
        kind: "tip",
        text: "**Raising the cap sends it back to Draft — but nobody's told.** Bump an APPROVED budget's amount and it drops straight back to Draft the moment you save the higher number — NOT Awaiting approval, and NOT auto-submitted. The OLD approved figure keeps working as the real spending cap the whole time, so nothing silently expands — but the increase itself is invisible to every approver until YOU deliberately hit Send for review again. Skip that tap and the raise is never reviewed, and no approver is ever notified. Decreasing an amount, or reshuffling its line items, never triggers any of this.",
      },
      {
        kind: "reveal",
        prompt:
          "A charge lands against an event whose budget is still sitting in Draft. Can anyone attribute it there right now?",
        answer:
          "No — only an APPROVED budget can take a charge. The transaction waits in Needs Budget, patiently, until the budget's owner sends it for review and someone approves it. Attribution and approval move together on purpose — see the next lesson.",
      },
    ],
    quiz: [
      {
        prompt:
          "An event is created with no dollar amount entered. What's true about its budget right now?",
        options: [
          "It's sitting in Draft at $0, waiting for someone to send it for review",
          "It's Awaiting approval automatically",
          "There's no budget row at all yet — most events need none; one appears once a real amount is entered or someone taps Add budget",
          "It's Approved automatically at $0",
        ],
        answerIndex: 2,
        explanation:
          "A budget only exists once real money enters the picture. No amount at creation means no budget row yet, not a hidden Draft one — the moment a real amount is entered or Add budget is tapped, THAT budget is born a Draft.",
      },
      {
        prompt: "What moves a budget out of Draft and into review?",
        options: [
          "It happens automatically after 24 hours",
          "A deliberate \"Send for review\" tap — nothing routes to an approver until you choose to send it",
          "The first charge attributed to it",
          "The Financial Manager pulls it into review",
        ],
        answerIndex: 1,
        explanation:
          "Send for review is an explicit action, not a side effect — a budget can sit in Draft indefinitely with zero consequence.",
      },
      {
        prompt: "Who can approve a budget you just submitted?",
        options: [
          "Anyone with approval authority for that scope — except you",
          "You can, if you also hold the approver's seat",
          "Whoever is fastest to open the app",
          "Nobody — a submitter's own budget is stuck forever",
        ],
        answerIndex: 0,
        explanation:
          "Approver ≠ submitter is about identity, not title — the same person can never wear both hats on one decision.",
      },
      {
        prompt: "You raise an APPROVED budget's cap from $2,000 to $3,000. It drops back to Draft — not automatically resubmitted. What actually limits spending until someone sends it for review again and it's approved?",
        options: [
          "The new $3,000 — available immediately",
          "The old $2,000 — still the live spending cap until it's sent for review again and approved",
          "Spending is blocked entirely until the increase clears",
          "Whichever amount the last charge used",
        ],
        answerIndex: 1,
        explanation:
          "The increase flips the budget back to Draft, not Awaiting approval — it sits fully editable and invisible to approvers until someone deliberately sends it again. The OLD approved amount keeps enforcing the cap the whole time, so spending power never silently jumps — but skip that resend and the raise is never reviewed at all, and no approver is ever notified.",
      },
    ],
  },

  // ── 47 · Chapter money model: one home per dollar ──────────────────────────
  // New (chapter-money-model course). Explicit-only attribution, the "For"
  // picker, and the chapter/central split. Authored from the CURRENT shipped
  // rule (`apps/convex/finances.ts#isAttributableBudget`, WP-wave4 item 5,
  // owner decision 2026-07-17): only an APPROVED budget is attributable, and
  // the picker's old "summon a $0 budget on pick" behavior was retired
  // alongside it — a not-yet-approved or absent budget's spend now surfaces
  // in the "Needs Budget" bucket instead, resolved by sending that budget for
  // review (previous lesson), not by picking it into existence.
  {
    slug: "finance-one-home-per-dollar",
    title: "One home per dollar",
    subtitle: "Explicit links only — nothing rides in silently",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Attribution in this system is explicit-only, everywhere: a transaction counts toward a budget the moment a person — or an accepted AI suggestion — deliberately links it there. Nothing is coded automatically; no charge quietly lands on the nearest-looking budget just because the dates or amounts happen to line up.",
      },
      {
        kind: "bullets",
        items: [
          "**Unattributed is the honest name for \"not yet claimed.\"** Every charge without an explicit link sits in the Needs Budget bucket, in plain sight on the dashboard — a number the whole chapter works to drive to zero, never one to quietly bury.",
          "**Only an approved budget can take a charge.** The \"For\" picker — grouped Events / Projects / Recurring — only ever offers budgets that have actually cleared review (the budget lifecycle, previous lesson). A Draft or Awaiting-approval budget can't receive a link yet, on purpose.",
          "**An AI suggestion is a suggestion, not a link.** The assistant can propose a likely match for a charge, but nothing attributes until a person taps to accept it — same explicit-only rule, just with a head start.",
        ],
      },
      {
        kind: "rule",
        title: "Every dollar belongs to a chapter or to central — never both",
        text: "A budget's level is a real chapter, or the literal \"central\" scope — never null, never a mix of the two. A chapter's own dashboard never surfaces central's money alongside its own, and central's rollup never quietly absorbs a chapter's.",
      },
      {
        kind: "reveal",
        prompt:
          "You're logging a charge for a brand-new event that doesn't have an approved budget yet. What happens in the \"For\" picker?",
        answer:
          "Nothing — that event's budget won't appear in the picker at all until it clears review. The charge sits in Needs Budget in the meantime; open the event's own page, use Add budget (or its existing Draft), and send it for review. Once it's approved, the same charge attributes cleanly.",
      },
    ],
    quiz: [
      {
        prompt: "How does a transaction end up counted toward a budget?",
        options: [
          "The system infers the closest match automatically",
          "A person — or an accepted AI suggestion — explicitly links it; nothing is inferred automatically",
          "Any charge in the same category counts by default",
          "The Treasurer assigns it at month-end",
        ],
        answerIndex: 1,
        explanation:
          "Explicit-only attribution means a link only exists because a human made it real — even an AI's suggestion needs a tap to count.",
      },
      {
        prompt: "What does the Needs Budget bucket mean?",
        options: [
          "A bug in the sync",
          "Spend with no explicit, approved-budget link yet — shown loudly on purpose, not silently absorbed",
          "Money that left the account without a transaction record",
          "Charges waiting on a bank sync",
        ],
        answerIndex: 1,
        explanation:
          "Needs Budget is a first-class, visible bucket — designed to be noticed and driven to zero, not hidden.",
      },
      {
        prompt: "Why won't the \"For\" picker offer a budget that's still Draft or Awaiting approval?",
        options: [
          "It's a display bug",
          "Only an approved budget is attributable — attribution and approval move together on purpose",
          "Draft budgets are picker-only, approved budgets are hidden",
          "The picker shows every budget regardless of status",
        ],
        answerIndex: 1,
        explanation:
          "The picker and the write-side attribution check share one gate: a budget has to clear review before a charge can call it home.",
      },
      {
        prompt: "Can a chapter's dashboard show central's money mixed in with its own?",
        options: [
          "Yes, they roll up together automatically",
          "No — every dollar belongs to exactly one level, chapter or central, never both",
          "Only if the Financial Manager enables it",
          "Only for the skim transfer",
        ],
        answerIndex: 1,
        explanation:
          "Chapter and central are separate homes for every dollar — a chapter's view never quietly includes central's money, or vice versa.",
      },
    ],
  },
];

/** The Finances stream's theme entry. */
export const FINANCES_THEME: Theme = {
  key: "finances",
  title: "Finances",
  subtitle:
    "Where the money comes from, how it's tracked, and who signs off on it.",
};

/**
 * The Finances stream's courses, in catalog order. Six courses now: five
 * role courses (most-to-least everyone) plus the shared `chapter-money-model`
 * core course between Finances-for-Everyone and Treasurer — the org
 * principle: a role path is a playlist of shared courses, and Chapter
 * Director + Treasurer (later FM/ED — role-path wiring lands separately)
 * both start from the exact same foundation instead of re-teaching it.
 * Every role course ends with a hands-on capstone in other streams (founder
 * 2026-07-14) — finance capstones need a dedicated training-sandbox
 * mechanic that doesn't exist yet, so these are lesson-only for now; a
 * capstone module can be appended later (module slugs stay stable, so it's
 * a pure addition, not a reshape).
 */
export const FINANCES_COURSES: Course[] = [
  {
    slug: "finances-for-everyone",
    themeKey: "finances",
    title: "Finances for Everyone",
    level: "beginner",
    audience: "team",
    description:
      "What every member needs: where the money comes from, using your " +
      "card + the 7-day receipt rule, and both directions of reimbursement. " +
      "Gains a 'getting your budget approved' module once budget approval " +
      "(Phase 3) ships.",
    icon: "dollar-sign",
    moduleSlugs: [
      "finance-stewardship",
      "finance-card-and-receipts",
      "finance-reimbursements-and-flags",
    ],
  },
  {
    slug: "chapter-money-model",
    themeKey: "finances",
    title: "The chapter money model",
    level: "intermediate",
    audience: "team",
    description:
      "The shared foundation every finance leader builds on: what backer " +
      "tiers unlock and where the skim goes, how a budget moves from draft " +
      "to a real spending cap, and why every dollar has exactly one home. " +
      "Treasurer and Chapter Director both start here.",
    icon: "layers",
    moduleSlugs: [
      "finance-tiers-and-skim",
      "finance-budget-lifecycle",
      "finance-one-home-per-dollar",
    ],
  },
  {
    slug: "treasurer",
    themeKey: "finances",
    title: "Treasurer",
    level: "intermediate",
    audience: "role",
    description:
      "The chapter Treasurer's remit: running Reconcile, chasing receipts, " +
      "and closing the month in under 30 minutes.",
    icon: "check-square",
    moduleSlugs: [
      "finance-reconcile-grid",
      "finance-chasing-receipts",
      "finance-monthly-close",
    ],
  },
  {
    slug: "chapter-director",
    themeKey: "finances",
    title: "Chapter Director",
    level: "leader",
    audience: "role",
    description:
      "Raise-vs-manage separation and approving budgets under the 85% " +
      "principle. Builds on the chapter money model course's tiers, skim, " +
      "and budget-lifecycle foundation.",
    icon: "shield",
    moduleSlugs: [
      "finance-raise-vs-manage",
      "finance-approving-budgets",
    ],
  },
  {
    slug: "financial-manager",
    themeKey: "finances",
    title: "Financial Manager",
    level: "leader",
    audience: "role",
    description:
      "The central Financial Manager's remit: auditing every chapter, " +
      "watching the receipt escalation queue, and administering accounts + cards.",
    icon: "bar-chart-2",
    moduleSlugs: [
      "finance-cross-chapter-audit",
      "finance-receipt-escalation-queue",
      "finance-accounts-and-cards-admin",
    ],
  },
  {
    slug: "executive-director",
    themeKey: "finances",
    title: "Executive Director",
    level: "leader",
    audience: "role",
    description:
      "Central budgets, governance + seat assignment, and the launch " +
      "grants + skim transfer that grow the network to its next city.",
    icon: "award",
    moduleSlugs: [
      "finance-central-budgets",
      "finance-governance-and-seats",
      "finance-launch-grants-and-transfers",
    ],
  },
];
