import { describe, expect, it, jest } from "@jest/globals";

// `contractorHelpers.ts` is deliberately react-native-free, but it imports the
// generated Convex `api` for its row types, and the module graph behind
// `lib/format` is dependency-free. Nothing here needs a mock for its own sake —
// this one exists for the same reason `helpers.test.ts` carries it: the
// ticketing helpers import `react-native` at module scope, which is unloadable
// in this node-environment jest setup, and anything that reaches them
// transitively would take the whole suite down with it.
jest.mock("../../event/ticketing/helpers", () => ({
  publicSiteUrl: () => "https://publicworship.life",
  parseDollars: (s: string): number | null => {
    const t = s.trim().replace(/^\$/, "");
    if (t === "") return null;
    const n = Number(t);
    return Number.isNaN(n) || n < 0 ? null : Math.round(n * 100);
  },
}));

import {
  NEVER_PREFILLED,
  contractorIdentityPatch,
  descriptionProblems,
  filterContractors,
  forgetOutcomeMessage,
  lastPaidLine,
  matchesContractorQuery,
  onFileShortLine,
  onFileSummary,
  sortContractors,
  taxClassificationLabel,
  taxClassificationMissing,
  taxClassificationOptions,
  usualRateHint,
} from "./contractorHelpers";
import {
  CONTRACTOR_SERVICE_DESCRIPTION_MIN,
  CONTRACTOR_TAX_CLASSIFICATIONS,
} from "@events-os/shared";

/**
 * The pure logic behind "it's this person again".
 *
 * Mobile's CI gate is jest, not `tsc`, so anything not asserted here is
 * effectively unverified. Three things earn the trouble:
 *
 *  - THE PREFILL'S BLAST RADIUS. Identity autofills; the amount, the service
 *    description and the service date must not. A regression there is not a
 *    cosmetic bug — it is an amount nobody decided, or a sentence published
 *    verbatim and permanently that nobody wrote for this piece of work. So the
 *    patch's key set is asserted exactly, not sampled.
 *  - THE DESCRIPTION FLOOR. It is the fix for a payment that used to pass
 *    composition, acceptance AND approval and then fail at the Pay button.
 *  - THE FORGET COPY. It is the one irreversible action on this surface, and
 *    the whole point is that it says what it did NOT do.
 */

// NOON, not midnight. `formatDate` renders in the DEVICE's timezone — correct
// for a user-facing date — so a midnight-UTC fixture reads as the previous day
// on any runner west of UTC, and the suite goes green or red depending on where
// it happens to run. Noon is the convention the rest of the codebase stores
// these dates at, for this exact reason.
const DOC_W9 = {
  kind: "w9" as const,
  uploadedAt: Date.UTC(2026, 2, 14, 12),
  signedAt: Date.UTC(2026, 2, 14, 12),
  isCurrent: true,
  problem: null,
};

const DOC_LAPSED_W8 = {
  kind: "w8ben" as const,
  uploadedAt: Date.UTC(2021, 5, 1, 12),
  signedAt: Date.UTC(2021, 5, 1, 12),
  isCurrent: false,
  problem: "This W-8BEN expired at the end of 2024.",
};

describe("the prefill fills identity and nothing else", () => {
  const onFile = {
    name: "Dana Reyes",
    email: "dana@example.com",
    phone: "(555) 555-5555",
  };

  it("returns exactly the three identity fields", () => {
    expect(contractorIdentityPatch(onFile)).toEqual({
      payeeName: "Dana Reyes",
      payeeEmail: "dana@example.com",
      payeePhone: "(555) 555-5555",
    });
  });

  it("never returns a field that carries this job's terms", () => {
    // THE test. If a future edit adds `amountText` to the patch — even
    // "helpfully", even behind a flag — this fails before it can ship.
    const keys = Object.keys(contractorIdentityPatch(onFile));
    for (const forbidden of NEVER_PREFILLED) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys.sort()).toEqual(["payeeEmail", "payeeName", "payeePhone"]);
  });

  it("clears a field the new pick has nothing for", () => {
    // An omitted key would leave the PREVIOUS contractor's phone sitting in the
    // form under this contractor's name.
    expect(
      contractorIdentityPatch({ name: "Sam", email: undefined, phone: undefined }),
    ).toEqual({ payeeName: "Sam", payeeEmail: "", payeePhone: "" });
  });
});

describe("the usual rate is a hint, not a value", () => {
  it("offers a whole-dollar rate the way money is spoken", () => {
    expect(usualRateHint(500)).toEqual({
      label: "Usually $500 — use this?",
      amountText: "500.00",
    });
  });

  it("keeps the cents when the rate has them", () => {
    expect(usualRateHint(212.5)).toEqual({
      label: "Usually $212.50 — use this?",
      amountText: "212.50",
    });
  });

  it("produces an amountText the app's one parser reads back exactly", () => {
    // The hint is only safe if pressing it yields the same cents the field
    // would have produced by hand.
    for (const usd of [500, 212.5, 75.25, 1200, 0.99]) {
      const hint = usualRateHint(usd)!;
      expect(Math.round(parseFloat(hint.amountText) * 100)).toBe(
        Math.round(usd * 100),
      );
    }
  });

  it("declines to suggest anything it can't stand behind", () => {
    expect(usualRateHint(undefined)).toBeNull();
    expect(usualRateHint(0)).toBeNull();
    expect(usualRateHint(-100)).toBeNull();
    expect(usualRateHint(Number.NaN)).toBeNull();
    expect(usualRateHint(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("what's on file, as reassurance", () => {
  it("promises the re-ask is avoided when the form and the bank are good", () => {
    const s = onFileSummary({
      hasBankOnFile: true,
      bankAccountLast4: "6789",
      taxDocument: DOC_W9,
    });
    expect(s.taxLine).toBe("W-9 on file since Mar 14, 2026");
    expect(s.bankLine).toBe("account ending 6789");
    expect(s.sentence).toContain("won't be asked again");
    expect(s.reaskProblem).toBeNull();
  });

  it("surfaces the server's own sentence when the form has lapsed", () => {
    const s = onFileSummary({ hasBankOnFile: false, taxDocument: DOC_LAPSED_W8 });
    expect(s.reaskProblem).toBe(DOC_LAPSED_W8.problem);
    // The promise is NOT made — they will be asked for a new form.
    expect(s.sentence).not.toContain("won't be asked again");
    expect(s.taxLine).toBe("W-8BEN on file, but not usable");
  });

  it("still promises the bank half when only the form lapsed", () => {
    const s = onFileSummary({
      hasBankOnFile: true,
      bankAccountLast4: "6789",
      taxDocument: DOC_LAPSED_W8,
    });
    expect(s.sentence).toContain("account ending 6789");
    expect(s.sentence).toContain("won't be asked again");
    expect(s.reaskProblem).toBe(DOC_LAPSED_W8.problem);
  });

  it("says nothing rather than something empty when we hold nothing", () => {
    const s = onFileSummary({ hasBankOnFile: false, taxDocument: null });
    expect(s.sentence).toBeNull();
    expect(s.reaskProblem).toBeNull();
    expect(onFileShortLine({ hasBankOnFile: false, taxDocument: null })).toBe(
      "Nothing on file yet",
    );
  });

  it("names a bank it can't show the last four of", () => {
    const s = onFileSummary({ hasBankOnFile: true, taxDocument: null });
    expect(s.bankLine).toBe("bank details on file");
  });

  it("never claims a payment date it doesn't have", () => {
    expect(lastPaidLine(undefined)).toBe("Not paid through the app yet");
    expect(lastPaidLine(Date.UTC(2026, 2, 14, 12))).toContain("Last paid");
  });
});

describe("tax classification", () => {
  it("shows `unknown` as a fact, never as an error", () => {
    expect(taxClassificationLabel("unknown")).toBe("Not recorded");
    expect(taxClassificationLabel(undefined)).toBe("Not recorded");
    // A value from a newer backend must not print a raw enum at a treasurer.
    expect(taxClassificationLabel("some_future_kind")).toBe("Not recorded");
  });

  it("labels every classification the shared tuple defines", () => {
    for (const c of CONTRACTOR_TAX_CLASSIFICATIONS) {
      expect(taxClassificationLabel(c).length).toBeGreaterThan(0);
    }
    expect(taxClassificationOptions().map((o) => o.value)).toEqual([
      ...CONTRACTOR_TAX_CLASSIFICATIONS,
    ]);
  });

  it("treats only the unanswered cases as missing", () => {
    expect(taxClassificationMissing("unknown")).toBe(true);
    expect(taxClassificationMissing(undefined)).toBe(true);
    expect(taxClassificationMissing("s_corporation")).toBe(false);
    expect(taxClassificationMissing("other")).toBe(false);
  });
});

describe("finding someone on the roster", () => {
  const rows = [
    { name: "Zoe Adams", email: "zoe@example.com", lastPaidAt: 100 },
    { name: "Ari Blake", email: "ari@example.com", businessName: "Blake Sound" },
    { name: "Casey Diaz", email: "casey@example.com", lastPaidAt: 900 },
  ];

  it("puts the most recently paid first and the never-paid last", () => {
    expect(sortContractors(rows).map((r) => r.name)).toEqual([
      "Casey Diaz",
      "Zoe Adams",
      "Ari Blake",
    ]);
  });

  it("does not mutate the list it was given", () => {
    const before = rows.map((r) => r.name);
    sortContractors(rows);
    expect(rows.map((r) => r.name)).toEqual(before);
  });

  it("matches the three things a staffer actually remembers", () => {
    expect(matchesContractorQuery(rows[1], "blake sound")).toBe(true);
    expect(matchesContractorQuery(rows[1], "ARI")).toBe(true);
    expect(matchesContractorQuery(rows[1], "ari@exa")).toBe(true);
    expect(matchesContractorQuery(rows[1], "zoe")).toBe(false);
  });

  it("shows everyone before anything is typed", () => {
    expect(matchesContractorQuery(rows[0], "   ")).toBe(true);
    expect(filterContractors(rows, "")).toHaveLength(3);
    expect(filterContractors(rows, "cas").map((r) => r.name)).toEqual([
      "Casey Diaz",
    ]);
  });
});

describe("forgetting a contractor says what it did NOT do", () => {
  it("names the kept forms rather than reporting a clean erase", () => {
    const msg = forgetOutcomeMessage({
      bankDetailsCleared: true,
      documentsDeleted: 0,
      documentsKept: 2,
    });
    expect(msg).toContain("Bank details deleted.");
    expect(msg).toContain("2 tax forms kept");
    expect(msg).toContain("retention window");
  });

  it("pluralises a single kept form", () => {
    const msg = forgetOutcomeMessage({
      bankDetailsCleared: true,
      documentsDeleted: 0,
      documentsKept: 1,
    });
    expect(msg).toContain("1 tax form kept");
    expect(msg).toContain("hold it for");
  });

  it("reports a real deletion as a deletion", () => {
    const msg = forgetOutcomeMessage({
      bankDetailsCleared: true,
      documentsDeleted: 1,
      documentsKept: 0,
    });
    expect(msg).toContain("1 tax form deleted.");
    expect(msg).not.toContain("kept");
  });

  it("is honest when there was nothing to forget", () => {
    const msg = forgetOutcomeMessage({
      bankDetailsCleared: false,
      documentsDeleted: 0,
      documentsKept: 0,
    });
    expect(msg).toBe(
      "There were no bank details to delete. There were no tax forms on file.",
    );
  });
});

describe("the service description's floor", () => {
  it("asks a plain question of an empty field", () => {
    // "at least 20 characters" is a strange thing to say to someone who hasn't
    // started typing.
    expect(descriptionProblems("")).toEqual([
      "Say what the work was — this appears on the public ledger.",
    ]);
    expect(descriptionProblems("   ")).toHaveLength(1);
  });

  it("refuses what the payout would later refuse", () => {
    // The bug this closes: "mix" used to pass composition, acceptance and
    // approval, then fail at the Pay button.
    expect(descriptionProblems("mix")).toHaveLength(1);
    expect(descriptionProblems("mix")[0]).toContain(
      String(CONTRACTOR_SERVICE_DESCRIPTION_MIN),
    );
    const justUnder = "x".repeat(CONTRACTOR_SERVICE_DESCRIPTION_MIN - 1);
    expect(descriptionProblems(justUnder)).toHaveLength(1);
  });

  it("accepts a description at exactly the floor", () => {
    expect(
      descriptionProblems("x".repeat(CONTRACTOR_SERVICE_DESCRIPTION_MIN)),
    ).toEqual([]);
    expect(
      descriptionProblems("Sound engineering for the March worship night"),
    ).toEqual([]);
  });

  it("counts the trimmed length, not the whitespace", () => {
    const padded = `   ${"x".repeat(CONTRACTOR_SERVICE_DESCRIPTION_MIN - 2)}   `;
    expect(descriptionProblems(padded)).toHaveLength(1);
  });

  it("tells a leak what to do about it, not just what it saw", () => {
    const problems = descriptionProblems(
      "Sound engineering, invoice to dana@example.com please",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("email address");
    expect(problems[0]).toContain("published publicly");
  });

  it("does not append the reword sentence to a length problem", () => {
    expect(descriptionProblems("mix")[0]).not.toContain("published publicly");
  });
});
