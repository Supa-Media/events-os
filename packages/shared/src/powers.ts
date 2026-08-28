/**
 * POWERS — the org's single, standardized permission vocabulary.
 *
 * A "power" is one named thing a person may do. Seats grant powers
 * (`SEAT_DEFS[seatId].capabilities` in `./seats.ts`); a domain resolver in
 * `apps/convex/lib/<domain>Access.ts` reads them. Nothing checks a seat id
 * inline — see the repo's "Gate It Behind a Power" rule.
 *
 * This module exists because the vocabulary drifted. Powers had accumulated in
 * four incompatible shapes at once: role NOUNS (`finance.manager`,
 * `finance.viewer`), bare resources with no verb (`finance.accounts`), a
 * camelCase verb-first id (`org.editChart`), and a whole pseudo-domain that was
 * really a UI flag (`nav.finances`, `nav.giving`). Two of them
 * (`finance.central`, `finance.record`) weren't powers at all. There was no
 * grammar, so every new power was a fresh guess, and no implication rule, so
 * every seat had to list every rung explicitly and a missed one was invisible.
 *
 * ── The grammar ─────────────────────────────────────────────────────────────
 *
 *     <domain>[.<area>].<action>
 *
 * Lowercase, dot-separated, two or three segments, and the ACTION IS ALWAYS
 * LAST. `finance.view`, `finance.budgets.approve`, `org.chart.edit`. Never
 * `org.editChart`, never a role noun like `finance.manager`, never a bare
 * resource like `finance.accounts`.
 *
 * ── The implication rules ───────────────────────────────────────────────────
 *
 * Holding one power can grant others. `expandPowers` applies three rules to
 * fixpoint, and every gate in the app reads the EXPANDED set:
 *
 *   1. WILDCARD — a two-segment `<domain>.<action>` grants that action on
 *      every declared area of the domain. `finance.edit` grants
 *      `finance.cards.edit` and `finance.budgets.edit`. This is the point of
 *      the grammar: "I have finance.edit" means all of finance, so a new area
 *      is automatically covered for whoever already had the whole domain.
 *   2. LADDER — `edit` grants `view` at the same prefix, and the
 *      separation-of-duties actions (`approve`, `publish`, `send`) grant
 *      `view` at their prefix too (you cannot decide on what you cannot see).
 *      `edit` deliberately does NOT grant `approve`: the whole point of an
 *      approval is that someone other than the author performs it.
 *   3. EXPLICIT — a def may list extra `implies` edges for chains the grammar
 *      can't express, e.g. composing an email implies owning the templates
 *      you compose from (a CROSS-AREA edge).
 *
 * ── Areas are earned, not reserved ──────────────────────────────────────────
 *
 * DO NOT add an area speculatively. An area exists only when someone should
 * hold PART of a domain without the whole. Finance has four that earn it
 * (`accounts`, `cards`, `budgets`, `ledger`) and several that don't —
 * reconciling, coding, receipts and sales have no separate holder anywhere in
 * the org, so they are simply `finance.view` / `finance.edit`. A speculative
 * area is not free: it is another string every seat's grant list has to be
 * re-decided against, and another thing to get wrong.
 *
 * ── Scope: the second axis ──────────────────────────────────────────────────
 *
 * A power is never held in the abstract. Every grant is a (power, scope) PAIR,
 * the scope coming from the `seatAssignments` row that granted it — either the
 * `"central"` sentinel or one chapter's id. Three rules, and they are uniform
 * across every domain (they did NOT used to be — finance carried an explicit
 * `finance.central` capability to say what giving and campaigns already got
 * from their scope; that capability is gone):
 *
 *   1. A power held at a CHAPTER scope reaches that chapter only.
 *   2. A power held at CENTRAL scope reaches central AND every chapter.
 *   3. Resources are scoped too, so a central-only resource is simply not
 *      present at a chapter scope.
 *
 * Rule 3 is what makes the wildcard rule safe, and it is worth stating plainly
 * because it replaced a carve-out that was about to be bolted on here. A
 * chapter Treasurer holds `finance.edit`, which wildcard-expands to
 * `finance.accounts.view` — but AT THEIR OWN CHAPTER, and there are no
 * chapter-level bank accounts. The org's accounts live at central, which the
 * Treasurer's chapter-scoped grant never reaches. The Treasurer is stopped by
 * scope, not by a special case, so `finance.edit` gets to mean exactly what it
 * says without an exception list.
 *
 * ── Navigation is derived, never granted ────────────────────────────────────
 *
 * There is no `nav.*` power. A desk's tab is visible iff the viewer holds ANY
 * power in that desk's domain (`navDomains`). The old `nav.finances` /
 * `nav.giving` were carried by exactly the seats that already held a real
 * power in the domain, so this is behavior-identical — it just removes a
 * second thing to remember to grant, and with it the failure mode where a seat
 * has a power but no way to reach the screen that uses it.
 */

// ── Actions ──────────────────────────────────────────────────────────────────
/** The closed verb vocabulary. A power's LAST segment is always one of these.
 *  Adding a verb here is a deliberate act — prefer reusing one. */
export const POWER_ACTIONS = [
  /** Read the thing. */
  "view",
  /** Create, update, delete the thing. Grants `view`. */
  "edit",
  /** Decide on something someone ELSE submitted. Never granted by `edit` —
   *  that separation is the reason the action exists. */
  "approve",
  /** Make something visible OUTSIDE the org, where it can't be un-seen. */
  "publish",
  /** Transmit to people outside the org (mass mail). */
  "send",
  /** Walk a whole dataset out of the building as a file. */
  "export",
  /** Admit a guest at an event door. */
  "checkin",
] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

/** Actions that grant `view` at their own prefix (rule 2). `edit` is here for
 *  the obvious reason; the SoD verbs are here because deciding on, publishing,
 *  or mailing something you cannot read is not a coherent grant. */
const VIEW_GRANTING_ACTIONS: readonly PowerAction[] = [
  "edit",
  "approve",
  "publish",
  "send",
];

// ── Domains ──────────────────────────────────────────────────────────────────
/** The top-level groupings. One domain per "desk" a person thinks in terms of. */
export const POWER_DOMAINS = [
  /** The books: transactions, reconciling, coding, receipts, sales, budgets. */
  "finance",
  /** The donor CRM (the development desk). */
  "giving",
  /** The Emails desk. Named `email` — the surface has been called Emails in
   *  the UI since 2026-07; the power strings said `campaigns.*` only because
   *  they were persisted and nobody wanted a migration. There is a migration
   *  now, so the wart is gone. */
  "email",
  /** Events and the door. */
  "events",
  /** Getting the right people in: the careers page's applications, the
   *  interview rubric, the Empowerment Trial, and the call at the end. The
   *  People desk — one funnel for the whole org, so it is CENTRAL only. */
  "hiring",
  /** The public face: the website's own copy and link cards, and the mailing
   *  and SMS lists the org can reach. Named `marketing` rather than `site`
   *  because the desk is a FUNCTION's home (the Marketing seat's), not one
   *  surface — the list lives here for the same reason the copy does. */
  "marketing",
  /** The org itself: the chart, the seats. */
  "org",
  /** Bulk extraction, across every dataset. */
  "data",
] as const;
export type PowerDomain = (typeof POWER_DOMAINS)[number];

// ── The registry ─────────────────────────────────────────────────────────────
/** One power's definition. `label` is what a HUMAN sees on the org chart —
 *  every power has one, which is why a raw id can no longer leak into the UI
 *  (the old `CAPABILITY_LABELS` was a partial map with a raw-id fallback, so
 *  `data.export` rendered as "data.export" on the seat panel). */
export interface PowerDef {
  id: Power;
  domain: PowerDomain;
  /** The sub-resource, for three-segment powers. Absent = domain-wide. */
  area?: string;
  action: PowerAction;
  /** Plain-language gloss shown as a "Powers" chip. Sentence case, no period. */
  label: string;
  /** One line on what it actually allows, shown as chip help text. */
  description: string;
  /** Extra grants the grammar can't derive (rule 3). Transitive. */
  implies?: readonly Power[];
  /**
   * WHERE THE RESOURCE LIVES, when it doesn't live everywhere. `"central"`
   * means the thing this power acts on exists only at the org level, so the
   * power is meaningless at a chapter scope.
   *
   * This exists because of scope rule 3, and it is what keeps the wildcard rule
   * from LYING. A chapter Treasurer's `finance.edit` expands to
   * `finance.accounts.view`, and that expansion is harmless at the gate — the
   * org's accounts are central, and `isCentralEdOrFm` reads the central scope
   * specifically, so the Treasurer is refused. But the org chart renders the
   * expanded set, and without this field it would print "Open the Accounts tab"
   * on a seat that cannot open it. Being safe and reading honestly are
   * different properties; this field is how the second one is kept.
   */
  scope?: "central";
}

/**
 * Every power in the org, grouped by domain.
 *
 * KEEP THIS LIST SHORT. Before adding one, ask the two questions this module's
 * doc asks: does someone need to hold this WITHOUT the rest of its domain, and
 * is it a real action rather than a scope or a UI flag? If the answer to
 * either is no, the power belongs in an existing string.
 */
export const POWERS = [
  // ── finance ───────────────────────────────────────────────────────────────
  "finance.view",
  "finance.edit",
  "finance.accounts.view",
  "finance.cards.view",
  "finance.cards.edit",
  "finance.budgets.approve",
  "finance.ledger.publish",
  // ── giving ────────────────────────────────────────────────────────────────
  "giving.view",
  "giving.edit",
  "giving.partners.edit",
  // ── email ─────────────────────────────────────────────────────────────────
  "email.assets.edit",
  "email.campaigns.edit",
  "email.campaigns.approve",
  // ── events ────────────────────────────────────────────────────────────────
  "events.checkin",
  // ── hiring ────────────────────────────────────────────────────────────────
  "hiring.view",
  "hiring.edit",
  "hiring.approve",
  // ── marketing ─────────────────────────────────────────────────────────────
  "marketing.site.edit",
  "marketing.designs.edit",
  "marketing.blog.edit",
  "marketing.blog.publish",
  "marketing.list.view",
  "marketing.list.edit",
  // ── org ───────────────────────────────────────────────────────────────────
  "org.chart.edit",
  // ── data ──────────────────────────────────────────────────────────────────
  "data.export",
] as const;
export type Power = (typeof POWERS)[number];

export const POWER_DEFS: Record<Power, PowerDef> = {
  // ── finance ───────────────────────────────────────────────────────────────
  "finance.view": {
    id: "finance.view",
    domain: "finance",
    action: "view",
    label: "See the books",
    description:
      "Read this scope's money: dashboard, transactions, reconcile grid, budgets.",
  },
  "finance.edit": {
    id: "finance.edit",
    domain: "finance",
    action: "edit",
    label: "Manage the books",
    description:
      "Record and reconcile money, code transactions, chase receipts, edit budgets.",
  },
  /** The org's bank accounts and the Relay/Increase console. Its own area
   *  because ONE person's finance reach genuinely stops short of it: the
   *  Financial Manager manages central's books AND its accounts, while a
   *  chapter Treasurer manages their chapter's books and has no accounts to
   *  reach at all. Scope does most of that work (rule 3 above) — the area
   *  exists so a future central seat can read the books without the bank. */
  "finance.accounts.view": {
    id: "finance.accounts.view",
    domain: "finance",
    area: "accounts",
    action: "view",
    label: "Open the Accounts tab",
    description: "See the org's bank accounts, balances, and transfers.",
    // The org banks centrally; there are no chapter-level bank accounts.
    scope: "central",
  },
  /** Cards are their own area on purpose, and it is the clearest example of
   *  why areas are earned: card access is the one finance power the org wants
   *  to hand out BROADLY (a team member who buys things needs their card)
   *  while every other finance power stays narrow. Splitting it out means that
   *  grant costs one string on the seats that need it, and rides along for
   *  free on anyone who already holds `finance.edit`. */
  "finance.cards.view": {
    id: "finance.cards.view",
    domain: "finance",
    area: "cards",
    action: "view",
    label: "See cards",
    description: "See the org's cards and their spending.",
  },
  "finance.cards.edit": {
    id: "finance.cards.edit",
    domain: "finance",
    area: "cards",
    action: "edit",
    label: "Manage cards",
    description: "Issue, freeze, and set limits on cards.",
  },
  "finance.budgets.approve": {
    id: "finance.budgets.approve",
    domain: "finance",
    area: "budgets",
    action: "approve",
    label: "Approve budgets",
    description:
      "Decide on a submitted budget — never one you submitted yourself.",
  },
  /** The PUBLIC ledger, not the internal books. Deliberately its own leaf that
   *  `finance.edit` does not grant: every other finance power acts on the
   *  org's own records, where a mistake is caught at the next close. This one
   *  puts a number in front of the whole city, and a published number can only
   *  be amended in public. */
  "finance.ledger.publish": {
    id: "finance.ledger.publish",
    domain: "finance",
    area: "ledger",
    action: "publish",
    label: "Publish the public ledger",
    description:
      "Approve a month's statement and publish it to the public finances page.",
  },

  // ── giving ────────────────────────────────────────────────────────────────
  "giving.view": {
    id: "giving.view",
    domain: "giving",
    action: "view",
    label: "See donors & giving",
    description: "Read the donor CRM: dashboard, donor list, gift history.",
  },
  "giving.edit": {
    id: "giving.edit",
    domain: "giving",
    action: "edit",
    label: "Manage donors & gifts",
    description: "Add and edit donors, record and remove gifts, import CSVs.",
  },
  /**
   * Compose partnership agreements — their terms, proposal, covered events,
   * in-kind credits, documents — and issue the portal link a sponsor signs and
   * pays on. Its OWN area, deliberately: the partnership team (a Partnership or
   * Fundraising Associate) drafts and runs an agreement WITHOUT the rest of the
   * giving desk — they never record a gift, edit a donor, or import a CSV,
   * which stay `giving.edit`. The Development Director carries it for free: a
   * central `giving.edit` holder grants it by the wildcard rule (managing the
   * desk includes composing its partnerships), so the chart stays honest
   * without a hand-maintained edge. Same posture as `campaigns.compose` — a
   * seat-grantable rung that a whole-domain manager already implies.
   *
   * `scope: "central"` because partnerships are a central-lens surface; the
   * field keeps a chapter seat's expanded set from printing a power it can't
   * use at the gate (see the `scope` doc on `PowerDef`).
   */
  "giving.partners.edit": {
    id: "giving.partners.edit",
    domain: "giving",
    area: "partners",
    action: "edit",
    label: "Compose partnerships",
    description:
      "Draft a sponsor's agreement — terms, events, credits, documents — and issue their portal link.",
    scope: "central",
  },

  // ── email ─────────────────────────────────────────────────────────────────
  "email.assets.edit": {
    id: "email.assets.edit",
    domain: "email",
    area: "assets",
    action: "edit",
    label: "Edit email themes, templates & images",
    description:
      "Own the shared design system — themes, saved templates, the image library. Never sends.",
  },
  /** Composing implies owning the design system: you cannot sensibly draft
   *  from a template you may not edit. A CROSS-AREA edge, so it has to be
   *  explicit — the wildcard rule only ever moves within one domain's areas. */
  "email.campaigns.edit": {
    id: "email.campaigns.edit",
    domain: "email",
    area: "campaigns",
    action: "edit",
    label: "Write and send emails",
    description:
      "Draft a campaign, submit it for approval, and send it once someone else approves.",
    implies: ["email.assets.edit"],
  },
  "email.campaigns.approve": {
    id: "email.campaigns.approve",
    domain: "email",
    area: "campaigns",
    action: "approve",
    label: "Approve emails before they send",
    description:
      "Review and decide on others' emails — never your own; a different approver is always required.",
    implies: ["email.campaigns.edit"],
  },

  // ── events ────────────────────────────────────────────────────────────────
  "events.checkin": {
    id: "events.checkin",
    domain: "events",
    action: "checkin",
    label: "Check guests in at the door",
    description: "Scan or type a guest's ticket code and admit them.",
  },

  // ── hiring ────────────────────────────────────────────────────────────────
  /** The People desk. Deliberately three rungs, and the third is the whole
   *  reason this is a domain rather than a `people.*` area: the Academy's
   *  pipeline ends with "the Director decides," so the person who RUNS a
   *  candidate through screening and interviews must be able to do that
   *  without also being able to close the file. A recruiting associate holds
   *  `hiring.edit`; only the People Director and the ED hold the call.
   *
   *  Central-scope only (`scope: "central"` on all three): the org runs ONE
   *  funnel with one standard — "one pipeline, one standard, someone who can
   *  say yes, no, why, or not now" — even for a role that will sit in a
   *  chapter. If a chapter ever runs its own intake, that is a new area here,
   *  not a widening of these. */
  "hiring.view": {
    id: "hiring.view",
    domain: "hiring",
    action: "view",
    label: "See the hiring pipeline",
    description:
      "Read applications, interview rubrics, and trial reviews on the Hiring desk.",
    scope: "central",
  },
  "hiring.edit": {
    id: "hiring.edit",
    domain: "hiring",
    action: "edit",
    label: "Run the hiring pipeline",
    description:
      "Move candidates through the stages, file rubric reviews, and start an Empowerment Trial.",
    scope: "central",
  },
  "hiring.approve": {
    id: "hiring.approve",
    domain: "hiring",
    action: "approve",
    label: "Make the call on a candidate",
    description:
      "Close a candidate's file — place, not-now, or decline — and send the outcome message.",
    /** The one who decides also runs the pipeline (rule 3, a same-domain edge
     *  the ladder rule deliberately won't derive). This is NOT the campaigns
     *  case: there, approving is a check on someone else's send, so the
     *  approver is a different person by design. Here the Director owns the
     *  funnel end to end and the split exists to keep an ASSOCIATE from
     *  closing files — not to keep the Director out of the pipeline. */
    implies: ["hiring.edit"],
    scope: "central",
  },

  // ── marketing ─────────────────────────────────────────────────────────────
  /**
   * The homepage's own words and cards. `edit` rather than a separate
   * `publish` rung, deliberately, and it is worth saying why given
   * `finance.ledger.publish` right above went the other way: a published
   * NUMBER is a claim about money that can only be amended in public, so it
   * earns a second party. A headline is a sentence, changed the moment someone
   * notices it is wrong, by the seat whose whole job is the public voice.
   * Gating it twice would just mean the words go stale — which is the failure
   * this desk exists to fix.
   *
   * A card can still be saved unpublished (`siteLinks.published`) — that is a
   * DRAFT, the same split `jobListings` uses, not a second authority.
   */
  "marketing.site.edit": {
    id: "marketing.site.edit",
    domain: "marketing",
    area: "site",
    action: "edit",
    label: "Edit the public site",
    description:
      "Change the homepage's copy, impact numbers, and Important Links cards — live, with no deploy.",
    // publicworship.life is the ORG's site. A chapter has no homepage of its
    // own to edit, so a chapter-scoped grant would reach nothing.
    scope: "central",
  },
  /**
   * The brand kit and the design library — the colors, the fonts, and the
   * Canva/Figma files the team makes everything out of.
   *
   * ── There is no `marketing.designs.view`, on purpose ────────────────────────
   * The library is READABLE BY THE WHOLE TEAM, ungated, and that is the feature
   * rather than an oversight. The Academy's own brand lesson puts it best:
   * "Nobody should have to ask permission to look right." A chapter volunteer
   * making a flyer at 11pm needs the hex code and the logo file, and a brand
   * kit behind a permission is a brand kit people work around — which is
   * exactly the inconsistency it exists to prevent. So the gate is on CHANGING
   * the kit, where a wrong answer propagates, not on reading it.
   *
   * Distinct from `email.assets.edit`, which is the same idea for the parked
   * Emails desk: that one owns email themes and the newsletter's image
   * library, is scoped to a surface the org no longer sends from, and reusing
   * it here would tie a live feature to a mothballed domain.
   */
  "marketing.designs.edit": {
    id: "marketing.designs.edit",
    domain: "marketing",
    area: "designs",
    action: "edit",
    label: "Manage the brand kit",
    description:
      "Add and organize brand colors, fonts, and design files. Everyone can see them; this changes them.",
    // One brand. A chapter that invented its own colors would defeat the point.
    scope: "central",
  },
  /**
   * Write a post for the public blog. NOT publish it — see below.
   */
  "marketing.blog.edit": {
    id: "marketing.blog.edit",
    domain: "marketing",
    area: "blog",
    action: "edit",
    label: "Write blog posts",
    description:
      "Draft, edit, and revise posts for the public blog. Publishing is separate.",
    scope: "central",
  },
  /**
   * Put a post on the internet under the organization's name.
   *
   * SPLIT FROM `edit`, and worth defending because the sibling power
   * `marketing.site.edit` deliberately went the other way. A headline is a
   * sentence that the seat which owns the public voice should be able to
   * correct the moment it is noticed. A blog post is a long-form argument
   * published under the Corporation's name, about what it believes — the kind
   * of thing that gets quoted back years later and cannot be un-said by an
   * edit. Its closest relative in this vocabulary is `finance.ledger.publish`,
   * not `marketing.site.edit`.
   *
   * The workflow this gates ALREADY EXISTS: the landing repo's `draft: true`
   * builds a post to a password-gated URL specifically so a work in progress
   * can be shared with an editor before it is public. This is that convention,
   * turned from a habit into a rule.
   */
  "marketing.blog.publish": {
    id: "marketing.blog.publish",
    domain: "marketing",
    area: "blog",
    action: "publish",
    label: "Publish blog posts",
    description:
      "Put a post on the public blog — and take one down. A published post is quotable forever.",
    /**
     * The one who decides also writes (rule 3, a same-domain edge the ladder
     * rule will not derive). Exactly `hiring.approve`'s case and for exactly
     * its reason: the split exists so an ASSOCIATE cannot put a post on the
     * internet, not so the Director cannot save a draft.
     *
     * THIS WAS A REAL BUG, caught in review before it shipped. The ladder rule
     * grants `view` at a power's own prefix, so `marketing.blog.publish`
     * expanded to `marketing.blog.publish` and a nonexistent
     * `marketing.blog.view` — and nothing else. Since `seats.ts` grants the ED
     * and the Marketing Director this power ALONE (minimal storage: you write
     * down only what isn't implied), those two seats could publish a post they
     * could not save. Every comment around it asserted the opposite, which is
     * why it read as correct.
     *
     * The lesson generalizes: `approve`/`publish` never imply `edit`. If a
     * seat is meant to hold both, either the edge is declared here or both
     * strings go on the seat.
     */
    implies: ["marketing.blog.edit"],
    scope: "central",
  },
  /**
   * The mailing and SMS lists. Its own AREA rather than riding on
   * `email.campaigns.*`, because the two came apart in practice: bulk email
   * moved to Mailchimp (`docs/plans/email-desk-parked.md`) and the Emails desk
   * is parked, but the org still keeps a list — who is on it, who asked off it,
   * who to export for a Mailchimp import. Owning the LIST and SENDING to it are
   * now genuinely different jobs held by different people.
   *
   * EXPORTING the list is deliberately NOT here: walking a whole contact set
   * out of the building as a file is what `data.export` already means, and
   * `requireMailingListExport` (`apps/convex/lib/marketingAccess.ts`) asks for
   * both. A fourth string would have said the same thing twice.
   */
  "marketing.list.view": {
    id: "marketing.list.view",
    domain: "marketing",
    area: "list",
    action: "view",
    label: "See the mailing list",
    description:
      "Read who is on the email and SMS lists, and who has opted out.",
  },
  "marketing.list.edit": {
    id: "marketing.list.edit",
    domain: "marketing",
    area: "list",
    action: "edit",
    label: "Manage the mailing list",
    description:
      "Add someone to the list, and take someone off it when they ask.",
  },

  // ── org ───────────────────────────────────────────────────────────────────
  "org.chart.edit": {
    id: "org.chart.edit",
    domain: "org",
    area: "chart",
    action: "edit",
    label: "Edit the org chart",
    description: "Add, move, rename, and re-power seats on the org chart.",
  },

  // ── data ──────────────────────────────────────────────────────────────────
  /** Never WIDENS reach — a holder still only exports datasets they could
   *  already see, so `data.export` without `giving.view` yields a people file
   *  with no giving columns. It is separate from every desk power because
   *  reading a grid on screen and walking the whole table out of the building
   *  are different risks, and the second is the one that shows up in a breach.
   *  Which is also why it grants no `view`: it is not in
   *  `VIEW_GRANTING_ACTIONS`. */
  "data.export": {
    id: "data.export",
    domain: "data",
    action: "export",
    label: "Export data to a spreadsheet",
    description:
      "Run a bulk export of a dataset you can already see. Never widens what you can see.",
  },
};

// ── Derived indexes ──────────────────────────────────────────────────────────
/** The declared areas of each domain, derived from the registry so the
 *  wildcard rule can never disagree with the list of powers that exist. */
export const POWER_AREAS: Record<PowerDomain, string[]> = POWER_DOMAINS.reduce(
  (acc, domain) => {
    acc[domain] = [
      ...new Set(
        POWERS.map((p) => POWER_DEFS[p]).filter(
          (d) => d.domain === domain && d.area !== undefined,
        ).map((d) => d.area as string),
      ),
    ];
    return acc;
  },
  {} as Record<PowerDomain, string[]>,
);

const POWER_SET: ReadonlySet<string> = new Set<string>(POWERS);

/** True iff `id` is a power this org actually declares. */
export function isPower(id: string): id is Power {
  return POWER_SET.has(id);
}

/** The domain a power belongs to. */
export function domainOf(power: Power): PowerDomain {
  return POWER_DEFS[power].domain;
}

/** The plain-language label for a power. Total over `Power`, so — unlike the
 *  partial map this replaced — a raw id can never reach the UI. */
export function powerLabel(power: Power): string {
  return POWER_DEFS[power].label;
}

/** The one-line explanation shown under a power's chip. */
export function powerDescription(power: Power): string {
  return POWER_DEFS[power].description;
}

// ── Implication ──────────────────────────────────────────────────────────────
/**
 * Everything `granted` actually grants, applying the three implication rules
 * to fixpoint. THIS is the set every gate must ask, never the raw stored
 * array — a seat carrying only `finance.edit` really does grant
 * `finance.cards.edit`, and a gate reading the raw array would miss it.
 *
 * Unknown strings are dropped rather than thrown on: a `seatDefs` row is
 * runtime-editable data, and a stale power left by an old client must fail
 * CLOSED (granting nothing) instead of taking down every gate that expands it.
 *
 * Cheap enough to call per-gate (the registry is ~16 entries and a person
 * holds a handful of powers), so no caching — a cache here would be a
 * correctness hazard the moment the chart is edited.
 */
export function expandPowers(granted: Iterable<string>): Set<Power> {
  const out = new Set<Power>();
  const queue: Power[] = [];

  for (const g of granted) {
    if (isPower(g) && !out.has(g)) {
      out.add(g);
      queue.push(g);
    }
  }

  while (queue.length > 0) {
    const power = queue.pop() as Power;
    const def = POWER_DEFS[power];

    const add = (next: string) => {
      if (isPower(next) && !out.has(next)) {
        out.add(next);
        queue.push(next);
      }
    };

    // Rule 1 — wildcard: a domain-wide power grants its action on every
    // declared area of that domain.
    if (def.area === undefined) {
      for (const area of POWER_AREAS[def.domain]) {
        add(`${def.domain}.${area}.${def.action}`);
      }
    }

    // Rule 2 — ladder: edit/approve/publish/send grant view at the same prefix.
    if (VIEW_GRANTING_ACTIONS.includes(def.action)) {
      const prefix =
        def.area === undefined ? def.domain : `${def.domain}.${def.area}`;
      add(`${prefix}.view`);
    }

    // Rule 3 — explicit cross-area edges declared on the def.
    for (const implied of def.implies ?? []) add(implied);
  }

  return out;
}

/**
 * True iff `held` (a RAW stored power array) grants `needed`. The one question
 * every gate asks. Expands first, so callers never have to remember to.
 */
export function grantsPower(held: Iterable<string>, needed: Power): boolean {
  return expandPowers(held).has(needed);
}

/**
 * The powers `held` grants THAT MEAN SOMETHING at `chart`'s scope — the
 * expanded set minus anything whose resource only exists centrally.
 *
 * Every surface that SHOWS a person their powers should use this rather than
 * `expandPowers`, because the two answer different questions: `expandPowers`
 * says what the rules grant, and this says what the holder can actually do
 * from where they sit. For a central seat they are identical.
 */
export function powersAtScope(
  held: Iterable<string>,
  chart: "central" | "chapter",
): Power[] {
  const all = [...expandPowers(held)];
  if (chart === "central") return all;
  return all.filter((p) => POWER_DEFS[p].scope !== "central");
}

/** True iff `held` grants ANY power in `domain` — the navigation rule. A
 *  desk's tab is visible exactly when its holder can do something there, which
 *  is why there is no `nav.*` power to forget to grant. */
export function grantsAnyInDomain(
  held: Iterable<string>,
  domain: PowerDomain,
): boolean {
  for (const p of expandPowers(held)) {
    if (POWER_DEFS[p].domain === domain) return true;
  }
  return false;
}

// ── Presentation: how a domain's powers are edited ───────────────────────────
/**
 * A domain's human name and how its powers should be OFFERED in an editor.
 *
 * Some domains are a LADDER — each rung strictly stronger than the last, so
 * exactly one is held and a segmented "None / View / Manage" control is the
 * honest UI. Others are a SET of independent powers, where a checklist is.
 * Getting this wrong is not cosmetic: rendering a ladder as checkboxes invites
 * an editor to tick `approve` without `edit` and wonder why nothing changed
 * (the implication rules would grant `edit` anyway), while rendering a set as a
 * ladder makes powers look mutually exclusive when they aren't.
 *
 * Declared here rather than in the app so the two editors that exist today —
 * and any surface added later — can't disagree about which shape a domain is.
 */
export interface PowerDomainDef {
  id: PowerDomain;
  /** Section heading in the editor. */
  label: string;
  /** One line under the heading. */
  description: string;
  /**
   * For a ladder domain: the rungs, WEAKEST FIRST, each naming the single
   * power it stores. "None" is implicit and always offered first. Absent for a
   * set domain, whose powers are offered independently.
   */
  ladder?: readonly { value: string; label: string; power: Power }[];
}

export const POWER_DOMAIN_DEFS: Record<PowerDomain, PowerDomainDef> = {
  finance: {
    id: "finance",
    label: "Finance",
    description:
      "The books, budgets, cards, and the public ledger. Approving and publishing are separate from editing on purpose.",
  },
  giving: {
    id: "giving",
    label: "Giving desk",
    description: "The donor CRM.",
    ladder: [
      { value: "view", label: "View", power: "giving.view" },
      { value: "manage", label: "Manage", power: "giving.edit" },
    ],
  },
  email: {
    id: "email",
    label: "Emails desk",
    description:
      "Design owns themes and templates but never sends. Compose can send once someone else approves. Approve decides on others' emails, never their own.",
    ladder: [
      { value: "design", label: "Design", power: "email.assets.edit" },
      { value: "compose", label: "Compose", power: "email.campaigns.edit" },
      { value: "approve", label: "Approve", power: "email.campaigns.approve" },
    ],
  },
  events: {
    id: "events",
    label: "Events",
    description: "Running events and the door.",
  },
  hiring: {
    id: "hiring",
    label: "Hiring desk",
    description:
      "The candidate funnel. Running the pipeline and making the call are separate rungs on purpose — the Academy's five-step process ends with the Director deciding, not with whoever screened the application.",
    ladder: [
      { value: "view", label: "View", power: "hiring.view" },
      { value: "run", label: "Run the pipeline", power: "hiring.edit" },
      { value: "decide", label: "Make the call", power: "hiring.approve" },
    ],
  },
  marketing: {
    id: "marketing",
    label: "Marketing desk",
    description:
      "The public homepage's words and cards, and the mailing and SMS lists. A SET, not a ladder: the person who makes the card art has no reason to see the roster, and the person who keeps the list has no reason to touch the homepage.",
  },
  org: {
    id: "org",
    label: "Organization",
    description: "The org chart itself.",
  },
  data: {
    id: "data",
    label: "Data",
    description: "Bulk extraction. Never widens what a person can already see.",
  },
};

/** The powers belonging to `domain`, in registry order. */
export function powersInDomain(domain: PowerDomain): Power[] {
  return POWERS.filter((p) => POWER_DEFS[p].domain === domain);
}

/**
 * Which rung of a LADDER domain `held` currently sits on — the strongest rung
 * whose power is granted, or `"none"`. Reads the EXPANDED set, so a row storing
 * only the top rung still resolves to that rung rather than falling through.
 */
export function ladderRungOf(
  held: Iterable<string>,
  domain: PowerDomain,
): string {
  const ladder = POWER_DOMAIN_DEFS[domain].ladder;
  if (!ladder) return "none";
  const powers = expandPowers(held);
  for (let i = ladder.length - 1; i >= 0; i--) {
    if (powers.has(ladder[i].power)) return ladder[i].value;
  }
  return "none";
}

// ── Migration from the pre-standardization vocabulary ────────────────────────
/**
 * Old capability string → its replacement, or `null` where the old string was
 * not a power at all and is deleted outright. Consumed by
 * `apps/convex/migrations/0062_standardize_powers.ts` to rewrite persisted
 * `seatDefs.capabilities` arrays, and pinned by `powers.test.ts` so the
 * mapping and the registry can't drift apart.
 *
 * The three deletions are the interesting half of this table:
 *
 *  - `finance.central` was a SCOPE wearing a power's clothes — "this seat sees
 *    every chapter's money". That is now what holding a finance power at
 *    central scope MEANS (scope rule 2), uniformly with giving and campaigns,
 *    which never needed such a string. Both seats that carried it are central
 *    seats holding finance powers, so their reach is unchanged.
 *  - `finance.record` was granted to two seats and read by NOTHING — the
 *    record-side separation-of-duties it looks like it enforces is actually
 *    derived from `legacyTitle`. Both holders also hold what is now
 *    `finance.edit`, which covers recording and reconciling, so folding it in
 *    changes no one's access.
 *  - `nav.finances` / `nav.giving` are derived now (see `grantsAnyInDomain`).
 *    Every seat that carried one already holds a real power in that domain, so
 *    every tab that was visible stays visible.
 */
export const LEGACY_POWER_MIGRATION: Record<string, Power | null> = {
  "finance.viewer": "finance.view",
  "finance.manager": "finance.edit",
  "finance.accounts": "finance.accounts.view",
  "finance.approve": "finance.budgets.approve",
  "finance.publish": "finance.ledger.publish",
  "finance.record": null,
  "finance.central": null,
  "nav.finances": null,
  "nav.giving": null,
  "giving.view": "giving.view",
  "giving.manage": "giving.edit",
  "campaigns.design": "email.assets.edit",
  "campaigns.compose": "email.campaigns.edit",
  "campaigns.approve": "email.campaigns.approve",
  "events.checkin": "events.checkin",
  "org.editChart": "org.chart.edit",
  "data.export": "data.export",
};

/** Rewrite one stored capabilities array into the standardized vocabulary,
 *  dropping deleted strings and de-duplicating. Order-stable so a migrated
 *  row's chips read in the same order they did before. */
export function migrateLegacyPowers(stored: readonly string[]): Power[] {
  const out: Power[] = [];
  for (const s of stored) {
    const mapped = isPower(s) ? s : LEGACY_POWER_MIGRATION[s];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}
