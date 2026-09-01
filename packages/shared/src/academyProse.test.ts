/**
 * The Academy's PROSE BUDGET — a house style the tests can hold.
 *
 * The curriculum drifted long: at the time this file was added, 116 sections
 * carried 55,755 words of body prose, 17% of its sentences ran over 30 words,
 * and the worst single section (`finance-reconcile-grid`) was 3,353 words —
 * a 16-minute read declaring itself a 5-minute one. Nobody wrote that on
 * purpose. It accreted, because every individual addition was defensible and
 * nothing measured the total.
 *
 * So the budget is measured here rather than asked for in a style guide:
 *
 *  - **3 paragraphs.** `p` blocks only. `rule`/`story`/`tip` cards are
 *    designed treatments, not paragraphs, and are budgeted separately.
 *  - **6 prose blocks** of any kind, so a section can't dodge the paragraph
 *    cap by turning paragraphs into rule cards.
 *  - **350 words** of body prose, which is roughly a 2-minute read.
 *  - **30 words per sentence.** This is the "be more direct" half. A sentence
 *    over 30 words is nearly always two sentences and a comma splice.
 *  - **40 words per table cell.** A table is for scanning. `reconcile-grid`
 *    had a 166-word cell, which is a paragraph wearing a table's clothes.
 *
 * GRANDFATHERED holds the sections that predate the budget. It may only ever
 * SHRINK — the second test fails if a listed section is now compliant, so
 * fixing a section forces its removal from the list, and the list is the
 * honest running count of what's left. New sections get no such grace.
 *
 * Same shape as `apps/mobile/__tests__/nativeDepsBaseline.test.js`'s
 * BASELINE_CORE: a frozen list of known exceptions that a guardrail refuses to
 * let grow.
 */
import { describe, expect, test } from "vitest";
import { ACADEMY_SECTIONS } from "./academy";
import type { AcademyBlock, AcademySection } from "./academy/types";

export const PROSE_BUDGET = {
  maxParagraphs: 3,
  maxProseBlocks: 6,
  maxBodyWords: 350,
  maxSentenceWords: 30,
  maxTableCellWords: 40,
} as const;

/** Block kinds whose text the reader reads as prose. */
const PROSE_KINDS = ["p", "story", "rule", "tip", "bullets", "heading", "reveal"];

/**
 * Sections written before the budget existed. MAY ONLY SHRINK — never add a
 * slug here. See the header.
 */
const GRANDFATHERED: ReadonlySet<string> = new Set([
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
  "anatomy-of-an-event",
  "being-an-owner",
  "timing-and-offsets",
  "phase-rings",
  "tab-tasks",
  "tab-crew-duties",
  "tab-supplies",
  "keeping-inventory",
  "tab-permits",
  "capstone-join-an-event",
  "capstone-birthday-party",
  "capstone-comms-lead",
  "capstone-event-lead",
  "capstone-logistics-lead",
  "works-driving-a-project",
  "works-duties",
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
  "mgmt-the-front-door",
  "mgmt-the-interview",
  "mgmt-the-trial",
  "mgmt-the-call",
  "mgmt-the-four-gates",
  "mgmt-frontline-no-final-yes",
  "finance-stewardship",
  "finance-three-tracks",
  "finance-card-and-receipts",
  "finance-receipt-exceptions",
  "finance-contractor-tax-and-privacy",
  "finance-transfers-and-payouts",
  "finance-chasing-receipts",
  "finance-publishing-the-books",
  "finance-approving-budgets",
  "finance-tiers-and-skim",
  "finance-cross-chapter-audit",
  "finance-accounts-and-cards-admin",
  "finance-budget-lifecycle",
  "music-worship-is-a-sacrifice",
  "music-the-test",
  "music-four-shapes-of-praise",
  "music-the-five-drifts",
  "music-submitting-a-song",
  "music-what-a-producer-does",
  "music-artist-is-a-brand",
  "music-the-economics-of-a-song",
  "music-inviting-a-collaborator",
  "music-greenlight-and-the-demo",
  "music-three-lanes",
  "music-the-four-paths",
  "music-what-your-role-receives",
  "mktg-the-look",
  "mktg-hit-record",
  "mktg-shoot-to-timeline",
  "mktg-getting-access",
  "mktg-the-desk",
  "mktg-the-library-and-the-blog",
  "dev-giving-vocabulary",
  "dev-donor-crm-basics",
  "dev-relationship-workflow",
  "dev-import-and-backfill",
  "dev-gifts-ledger-and-audit",
  "dev-public-gift-wall",
  "dev-backer-floor-and-ladder",
  "dev-backer-lifecycle",
  "dev-backer-portal",
  "dev-givebutter-migration",
  "dev-sponsor-packages",
  "dev-sponsorship-pipeline",
  "dev-church-partnerships",
  "dev-partner-portal",
  "dev-city-launch-economics",
  "dev-prospect-cities-and-map",
]);

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Every reader-facing prose string in a block (quiz text is budgeted separately). */
function proseStrings(b: AcademyBlock): string[] {
  switch (b.kind) {
    case "p":
    case "tip":
    case "heading":
      return [b.text];
    case "story":
    case "rule":
      return [b.title, b.text];
    case "bullets":
      return b.items;
    case "reveal":
      return [b.prompt, b.answer];
    default:
      return [];
  }
}

/** Sentence split good enough to catch a runaway — a bad split only ever shortens. */
const sentencesOf = (t: string) =>
  t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);

export function measureSection(s: AcademySection) {
  const texts = s.blocks.flatMap(proseStrings);
  const cells = s.blocks.flatMap((b) => (b.kind === "table" ? b.rows.flat() : []));
  return {
    paragraphs: s.blocks.filter((b) => b.kind === "p").length,
    proseBlocks: s.blocks.filter((b) => PROSE_KINDS.includes(b.kind)).length,
    bodyWords: texts.reduce((n, t) => n + wordCount(t), 0),
    longestSentence: Math.max(0, ...texts.flatMap(sentencesOf).map(wordCount)),
    longestTableCell: Math.max(0, ...cells.map(wordCount)),
  };
}

/** The budget violations of one section, as readable strings. */
export function budgetViolations(s: AcademySection): string[] {
  const m = measureSection(s);
  const out: string[] = [];
  if (m.paragraphs > PROSE_BUDGET.maxParagraphs)
    out.push(`${m.paragraphs} paragraphs (max ${PROSE_BUDGET.maxParagraphs})`);
  if (m.proseBlocks > PROSE_BUDGET.maxProseBlocks)
    out.push(`${m.proseBlocks} prose blocks (max ${PROSE_BUDGET.maxProseBlocks})`);
  if (m.bodyWords > PROSE_BUDGET.maxBodyWords)
    out.push(`${m.bodyWords} body words (max ${PROSE_BUDGET.maxBodyWords})`);
  if (m.longestSentence > PROSE_BUDGET.maxSentenceWords)
    out.push(`a ${m.longestSentence}-word sentence (max ${PROSE_BUDGET.maxSentenceWords})`);
  if (m.longestTableCell > PROSE_BUDGET.maxTableCellWords)
    out.push(`a ${m.longestTableCell}-word table cell (max ${PROSE_BUDGET.maxTableCellWords})`);
  return out;
}

describe("Academy prose budget", () => {
  test("every section not grandfathered is within budget", () => {
    const offenders = ACADEMY_SECTIONS.filter((s) => !GRANDFATHERED.has(s.slug))
      .map((s) => ({ slug: s.slug, violations: budgetViolations(s) }))
      .filter((r) => r.violations.length > 0)
      .map((r) => `${r.slug}: ${r.violations.join("; ")}`);
    expect(offenders).toEqual([]);
  });

  test("GRANDFATHERED only lists sections that are still over budget", () => {
    // Forces the list to shrink as sections are rewritten: a section that now
    // fits the budget must come off the list, which is what makes the list a
    // trustworthy count of the work remaining.
    const fixed = [...GRANDFATHERED].filter((slug) => {
      const section = ACADEMY_SECTIONS.find((s) => s.slug === slug);
      return section && budgetViolations(section).length === 0;
    });
    expect(fixed).toEqual([]);
  });

  test("GRANDFATHERED has no slugs that left the curriculum", () => {
    const slugs = new Set(ACADEMY_SECTIONS.map((s) => s.slug));
    expect([...GRANDFATHERED].filter((g) => !slugs.has(g))).toEqual([]);
  });
});
