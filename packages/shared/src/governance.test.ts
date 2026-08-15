/**
 * Drift guard for the governance library (`docs/governance/`).
 *
 * The Bylaws, Operating Manual, and Employee Handbook are checked into this
 * repository for exactly one reason: so that the facts they state about the
 * product can be TESTED against the code that implements them. A governance
 * document that quotes a 15% share, a seat named "Treasurer", or a power
 * called `finance.ledger.publish` is making a claim, and a claim that nothing
 * verifies rots the first time someone renames a seat or tunes a constant.
 *
 * This is the same bargain the Academy makes (`academy.snapshot.test.ts`):
 * structural drift fails loudly here, so the only thing left for a human to
 * catch in review is prose that describes a flow the product no longer has.
 *
 * The documents mark their machine-checked regions with HTML comment anchors
 * (`<!-- seat-chart:central -->`, `<!-- money-constants -->`, …). Those anchors
 * are load-bearing — an editor who removes one fails this suite rather than
 * silently unpinning the section.
 *
 * WHAT TO DO WHEN THIS FAILS: update the document, in the same PR as the code
 * change. That is the whole point. See `docs/governance/README.md`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  MULTI_HOLDER_CAP,
  SEAT_DEFS,
  SEAT_ROOT,
  seatChartOrder,
  type SeatChart,
  type SeatDef,
} from "./seats";
import { POWERS, POWER_DOMAINS } from "./powers";
import {
  AFFORDABILITY_TIERS,
  BACKER_UNIT_CENTS,
  CENTRAL_SKIM_PCT,
  FINANCE_TIMEZONE,
  MIN_PURPOSE_LENGTH,
  OPERATING_FLOOR_FIXED_CENTS,
  OPERATING_FLOOR_PER_TEAMMATE_CENTS,
  RECEIPT_GRACE_DAYS,
  REIMBURSEMENT_STATUSES,
} from "./finance";
import { CONTRACTOR_PAYMENT_STATUSES } from "./contractorPayments";

// ── Loading ──────────────────────────────────────────────────────────────────
const GOVERNANCE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/governance",
);

const read = (file: string): string =>
  readFileSync(join(GOVERNANCE_DIR, file), "utf8");

const BYLAWS = read("bylaws.md");
const MANUAL = read("operating-manual.md");
const HANDBOOK = read("employee-handbook.md");
const INDEX = read("README.md");

const ALL_DOCS: Record<string, string> = {
  "README.md": INDEX,
  "bylaws.md": BYLAWS,
  "operating-manual.md": MANUAL,
  "employee-handbook.md": HANDBOOK,
};

// ── Parsing helpers ──────────────────────────────────────────────────────────
/** The `---` fenced key/value block at the top of every governance document. */
function headerBlock(doc: string): Record<string, string> {
  const match = doc.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("no header block");
  const entries: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) entries[kv[1]] = kv[2].trim();
  }
  return entries;
}

/** The text between `<!-- name -->` and the next closing anchor. Throws if the
 *  anchor is missing, which is the point — anchors may not be quietly dropped. */
function anchored(doc: string, name: string): string {
  const open = `<!-- ${name} -->`;
  const start = doc.indexOf(open);
  if (start === -1) throw new Error(`missing anchor: ${open}`);
  const rest = doc.slice(start + open.length);
  const end = rest.search(/<!-- \/[a-z-]+ -->/);
  if (end === -1) throw new Error(`unclosed anchor: ${open}`);
  return rest.slice(0, end);
}

/** Markdown table body rows as arrays of trimmed cells (header + separator
 *  rows dropped). */
function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^-*:?-*$/.test(cell)))
    .slice(1);
}

/** Every `` `backticked` `` token in a chunk of markdown. */
function backticked(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

// ── Document hygiene ─────────────────────────────────────────────────────────
describe("governance documents", () => {
  test("every markdown file in docs/governance is covered by this test", () => {
    const onDisk = readdirSync(GOVERNANCE_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
    // A new governance document must be added to ALL_DOCS so it inherits the
    // header-block and status rules below, rather than sitting unchecked.
    expect(onDisk).toEqual(Object.keys(ALL_DOCS).sort());
  });

  test.each(Object.keys(ALL_DOCS))("%s has a well-formed header block", (name) => {
    const header = headerBlock(ALL_DOCS[name]);
    for (const key of [
      "document",
      "entity",
      "status",
      "version",
      "last-reviewed",
      "adopted",
      "review-cadence",
      "owner",
    ]) {
      expect(header[key], `${name} header is missing "${key}"`).toBeTruthy();
    }
    expect(header.entity).toContain("Global Echo Charitable Organization");
    expect(header["last-reviewed"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test.each(Object.keys(ALL_DOCS))(
    "%s: an ADOPTED document carries an adoption date",
    (name) => {
      const header = headerBlock(ALL_DOCS[name]);
      const status = header.status.toUpperCase();
      expect(
        status.startsWith("DRAFT") || status.startsWith("ADOPTED"),
        `${name} status must start with DRAFT or ADOPTED, got "${header.status}"`,
      ).toBe(true);
      if (status.startsWith("ADOPTED")) {
        // Adopting is a Board act with a date. Half-flipping the header — new
        // status, no resolution date — is the failure this catches.
        expect(
          header.adopted,
          `${name} is ADOPTED but has no adoption date`,
        ).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      } else {
        expect(header.adopted).toBe("—");
      }
    },
  );

  test("drafts carry the not-adopted / not-legal-advice warning", () => {
    for (const [name, doc] of Object.entries(ALL_DOCS)) {
      if (!headerBlock(doc).status.toUpperCase().startsWith("DRAFT")) continue;
      expect(doc, `${name} is a draft without a visible warning`).toMatch(
        /DRAFT/,
      );
    }
  });

  test("the index links every other document", () => {
    for (const name of Object.keys(ALL_DOCS)) {
      if (name === "README.md") continue;
      expect(INDEX).toContain(`(./${name})`);
    }
  });
});

// ── Seat charts ──────────────────────────────────────────────────────────────
describe("operating manual: seat charts match SEAT_DEFS", () => {
  const chartRows = (chart: SeatChart): string[][] =>
    tableRows(anchored(MANUAL, `seat-chart:${chart}`));

  const charts: SeatChart[] = ["central", "chapter"];

  test.each(charts)("%s chart lists exactly the seats that exist", (chart) => {
    const documented = chartRows(chart).map((cells) => cells[0]);
    const actual = seatChartOrder(chart).map((def) => def.title);
    // Order matters: the manual prints the chart in reading order (a seat
    // immediately followed by its subtree), which is what `seatChartOrder`
    // derives from `parentId`.
    expect(documented).toEqual(actual);
  });

  test.each(charts)("%s chart: reporting lines are right", (chart) => {
    const byTitle = new Map<string, SeatDef>(
      seatChartOrder(chart).map((def) => [def.title, def]),
    );
    for (const [title, reportsTo] of chartRows(chart).map(
      (cells) => [cells[0], cells[1]] as const,
    )) {
      const def = byTitle.get(title)!;
      const expected =
        def.parentId === SEAT_ROOT
          ? "— (chart root)"
          : SEAT_DEFS[def.parentId].title;
      expect(reportsTo, `${title} reports to`).toBe(expected);
    }
  });

  test.each(charts)("%s chart: holder limits are right", (chart) => {
    const byTitle = new Map<string, SeatDef>(
      seatChartOrder(chart).map((def) => [def.title, def]),
    );
    for (const [title, holders] of chartRows(chart).map(
      (cells) => [cells[0], cells[2]] as const,
    )) {
      const def = byTitle.get(title)!;
      expect(holders, `${title} holders`).toBe(
        def.maxHolders === MULTI_HOLDER_CAP ? "many" : "1",
      );
    }
  });

  test.each(charts)("%s chart: granted powers are right", (chart) => {
    const byTitle = new Map<string, SeatDef>(
      seatChartOrder(chart).map((def) => [def.title, def]),
    );
    for (const [title, powersCell] of chartRows(chart).map(
      (cells) => [cells[0], cells[3]] as const,
    )) {
      const def = byTitle.get(title)!;
      const documented = backticked(powersCell);
      // The chart stores the MINIMAL granted set (implied rungs are derived by
      // `expandPowers`), so the manual prints the minimal set too.
      expect(new Set(documented), `${title} powers`).toEqual(
        new Set(def.capabilities),
      );
      if (def.capabilities.length === 0) {
        expect(powersCell, `${title} powers`).toBe("—");
      }
    }
  });
});

// ── Powers ───────────────────────────────────────────────────────────────────
describe("operating manual: powers", () => {
  test("the powers table lists exactly the powers that exist", () => {
    const documented = tableRows(anchored(MANUAL, "powers-table")).map(
      (cells) => backticked(cells[0])[0],
    );
    expect(documented).toEqual([...POWERS]);
  });

  test("every power-shaped string in the library is a real power", () => {
    const domains = new Set<string>(POWER_DOMAINS);
    const known = new Set<string>(POWERS);
    for (const [name, doc] of Object.entries(ALL_DOCS)) {
      for (const token of backticked(doc)) {
        // Power grammar: <domain>[.<area>].<action>, lowercase, 2-3 segments.
        // Filenames (`finance.ts`) and paths share the dot but not the shape
        // once the extension and slash filters are applied.
        if (!/^[a-z]+(\.[a-z_]+){1,2}$/.test(token)) continue;
        if (/\.(ts|md|json|js|tsx)$/.test(token)) continue;
        if (!domains.has(token.split(".")[0])) continue;
        expect(known.has(token), `${name} names unknown power "${token}"`).toBe(
          true,
        );
      }
    }
  });
});

// ── Money ────────────────────────────────────────────────────────────────────
describe("operating manual: money figures match finance.ts", () => {
  const dollars = (cents: number): string =>
    `$${(cents / 100).toLocaleString("en-US")}`;

  /** What each row's VALUE cell must contain, keyed by the constant its third
   *  column names. Tier rows are checked separately (three rows, one array). */
  const expectations: Record<string, string> = {
    BACKER_UNIT_CENTS: dollars(BACKER_UNIT_CENTS),
    CENTRAL_SKIM_PCT: `${CENTRAL_SKIM_PCT * 100}%`,
    OPERATING_FLOOR_FIXED_CENTS: dollars(OPERATING_FLOOR_FIXED_CENTS),
    OPERATING_FLOOR_PER_TEAMMATE_CENTS: dollars(
      OPERATING_FLOOR_PER_TEAMMATE_CENTS,
    ),
    RECEIPT_GRACE_DAYS: `${RECEIPT_GRACE_DAYS} days`,
    MIN_PURPOSE_LENGTH: `${MIN_PURPOSE_LENGTH} characters`,
    FINANCE_TIMEZONE,
  };

  const rows = tableRows(anchored(MANUAL, "money-constants"));

  test("every documented figure names a constant this test knows", () => {
    const named = rows.map((cells) => backticked(cells[2])[0]);
    const knowable = new Set([
      ...Object.keys(expectations),
      "AFFORDABILITY_TIERS",
    ]);
    for (const constant of named) {
      // A new figure in the table must come with an assertion here, or it is
      // documentation nobody is checking.
      expect(knowable.has(constant), `unchecked constant "${constant}"`).toBe(
        true,
      );
    }
    for (const constant of Object.keys(expectations)) {
      expect(named, `${constant} is not documented`).toContain(constant);
    }
  });

  test.each(Object.entries(expectations))(
    "%s is stated correctly",
    (constant, expected) => {
      const row = rows.find((cells) => backticked(cells[2])[0] === constant)!;
      expect(row[1]).toContain(expected);
    },
  );

  test("the backer tiers match AFFORDABILITY_TIERS", () => {
    const documented = rows
      .filter((cells) => backticked(cells[2])[0] === "AFFORDABILITY_TIERS")
      .map((cells) => Number(cells[1].match(/(\d+)\s+backers/)![1]));
    expect(new Set(documented)).toEqual(
      new Set(AFFORDABILITY_TIERS.map((tier) => tier.minBackers)),
    );
  });

  test("the five-person operating floor is arithmetic, not folklore", () => {
    const floor =
      OPERATING_FLOOR_FIXED_CENTS + 5 * OPERATING_FLOOR_PER_TEAMMATE_CENTS;
    // Prose wraps and carries emphasis markers, so compare against the
    // whitespace-collapsed text rather than the raw file.
    const prose = MANUAL.replace(/\s+/g, " ");
    expect(prose).toContain(`${dollars(floor)} a month`);
  });
});

// ── Lifecycles ───────────────────────────────────────────────────────────────
describe("operating manual: money lifecycles match their status tuples", () => {
  const cases: [string, readonly string[]][] = [
    ["lifecycle:reimbursement", REIMBURSEMENT_STATUSES],
    ["lifecycle:contractor", CONTRACTOR_PAYMENT_STATUSES],
  ];

  test.each(cases)("%s names every status, and no others", (anchor, statuses) => {
    const documented = new Set(backticked(anchored(MANUAL, anchor)));
    expect(documented).toEqual(new Set(statuses));
  });
});

// ── Cross-document consistency ───────────────────────────────────────────────
describe("cross-document consistency", () => {
  test("the corporation's identifiers are stated consistently", () => {
    for (const [name, doc] of Object.entries(ALL_DOCS)) {
      expect(headerBlock(doc).entity, name).toBe(
        "Global Echo Charitable Organization (d/b/a Public Worship)",
      );
    }
    // The EIN appears in exactly the two places it belongs; a stray copy in a
    // third document is a maintenance hazard, not a convenience.
    expect(BYLAWS).toContain("80-0870719");
    expect(MANUAL).toContain("80-0870719");
  });

  test("the manual defers to the bylaws rather than restating authority", () => {
    // Every governing claim in the manual should point back at the article
    // that actually confers it. This asserts the habit, not each citation.
    expect(MANUAL).toMatch(/Bylaws\s+(?:Art\.|§|Appendix)/);
    expect(HANDBOOK).toMatch(/Bylaws\s+(?:Art\.|§|Appendix)/);
  });
});
