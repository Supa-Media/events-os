import { describe, expect, it } from "vitest";
import {
  REGISTRATION_CENTS,
  WBTW_BOOK_SCOPE,
  WBTW_PROJECT_HOME_CHAPTER_ID,
  WBTW_PROJECT_ID,
  WBTW_REGISTRATIONS,
  externalRefFor,
  planRegistrationBackfill,
  type BackfillWorld,
} from "./projectRegistrationBackfill";

/**
 * The Worship Beyond The Walls backfill's DECISIONS, tested without a
 * deployment. The mutation's ids are production ids that convex-test cannot
 * mint, so the end-to-end path is covered in `tests/registrations.test.ts` by
 * its refusal to write; this file covers what it would write when the
 * preconditions really do hold.
 *
 * All amounts in cents.
 */

const goodProject = {
  id: WBTW_PROJECT_ID,
  chapterId: WBTW_PROJECT_HOME_CHAPTER_ID,
  name: "Worship Beyond the walls",
};

/**
 * INVENTED registrant identities, positionally matched to the fixture's six
 * transaction ids. The real names and addresses are supplied at run time and
 * deliberately never enter this repo — three of these rows are refunded
 * scholarships, and "this named person received a scholarship" is financial-need
 * information about a real individual. See the module header.
 */
const FAKE_NAMES = [
  "Ada Placeholder",
  "Bo Placeholder",
  "Cy Placeholder",
  "Dee Placeholder",
  "Eli Placeholder",
  "Fay Placeholder",
];

function registrants(
  emailFor: (txnId: string, i: number) => string | undefined = () => undefined,
): Map<string, { name: string; email?: string }> {
  return new Map(
    WBTW_REGISTRATIONS.map((r, i) => {
      const email = emailFor(r.givebutterTxnId, i);
      return [
        r.givebutterTxnId,
        { name: FAKE_NAMES[i], ...(email ? { email } : {}) },
      ] as const;
    }),
  );
}

function world(over: Partial<BackfillWorld> = {}): BackfillWorld {
  return {
    project: goodProject,
    existingExternalRefs: new Set<string>(),
    personIdByEmail: new Map<string, string>(),
    registrantByTxnId: registrants(),
    ...over,
  };
}

describe("the fixture itself", () => {
  it("is the six $50 places Givebutter collected: $300.00 gross, $150.00 kept", () => {
    expect(WBTW_REGISTRATIONS).toHaveLength(6);
    expect(REGISTRATION_CENTS).toBe(5_000);
    const paid = WBTW_REGISTRATIONS.filter((r) => r.status === "paid");
    const refunded = WBTW_REGISTRATIONS.filter((r) => r.status === "refunded");
    expect(paid).toHaveLength(3);
    expect(refunded).toHaveLength(3);
    expect(WBTW_REGISTRATIONS.length * REGISTRATION_CENTS).toBe(30_000);
    expect(paid.length * REGISTRATION_CENTS).toBe(15_000);
    // Every refund was a scholarship — that is what the project page will say.
    expect(refunded.every((r) => r.refundReason === "scholarship")).toBe(true);
  });

  it("keys every row on a distinct Givebutter transaction id", () => {
    const refs = WBTW_REGISTRATIONS.map((r) => externalRefFor(r.givebutterTxnId));
    expect(new Set(refs).size).toBe(6);
    expect(refs).toContain("gb:txn:4284185383");
  });

  it("dates are UTC midnights, so a date-only source can't drift a day", () => {
    for (const r of WBTW_REGISTRATIONS) {
      expect(new Date(r.registeredAt).toISOString()).toMatch(
        /^2026-01-(26|29)T00:00:00\.000Z$/,
      );
    }
  });

  it("none of these transactions is in any seed fixture", () => {
    // The load-bearing fact behind the module header's roster note: all six
    // registrants ALREADY have `people` + `personEmails` rows in production,
    // and it was NOT these registrations that created them — none of these ids
    // is seeded anywhere. Whatever put them on the roster was keyed on the
    // PERSON, not on this money. Pinned here because the header's explanation
    // has been wrong twice, and this is the part of it that is checkable.
    const seeded = [
      // Every Givebutter txn id that DOES appear in `lib/seed/historical/`
      // for one of these people — all of them other events entirely.
      "3216256522", // a Field Day ticket
      "5204639557", // a Pop The Balloon ticket
      "7228719083", // an ordinary donation
    ];
    for (const r of WBTW_REGISTRATIONS) {
      expect(seeded).not.toContain(r.givebutterTxnId);
    }
  });

  it("carries NO personal data — only opaque transaction ids", () => {
    // The privacy invariant, enforced rather than trusted. Names and emails are
    // run-time arguments; a fixture row must expose nothing that identifies a
    // human, and least of all beside the word "scholarship".
    for (const r of WBTW_REGISTRATIONS) {
      expect(Object.keys(r).sort()).toEqual(
        r.refundReason
          ? ["givebutterTxnId", "refundReason", "registeredAt", "status"]
          : ["givebutterTxnId", "registeredAt", "status"],
      );
      expect(r.givebutterTxnId).toMatch(/^\d{10}$/);
    }
    // And nothing that looks like a name or an address anywhere in the fixture.
    expect(JSON.stringify(WBTW_REGISTRATIONS)).not.toMatch(/@|[A-Z][a-z]+ [A-Z][a-z]+/);
  });

  /**
   * THE ATTRIBUTION THE OWNER ASKED FOR, pinned on its own because it is the
   * one fact here that a reader would otherwise infer from two constants that
   * look interchangeable and emphatically are not.
   *
   * The project ROW is New York's — `projects.chapterId` has no central union
   * and never moves. The MONEY is central's: "Worship Beyond the Walls was not
   * a New York thing, it was a central thing" (owner, 2026-08-10). Collapse
   * these two into one constant and the six rows land on New York's book, New
   * York's book value rises $150.00, and `settleChapterBalances` wires it
   * $150.00 it did not earn on the next morning run.
   */
  it("books to central, not to the chapter the project row lives on", () => {
    expect(WBTW_BOOK_SCOPE).toBe("central");
    expect(WBTW_BOOK_SCOPE as string).not.toBe(WBTW_PROJECT_HOME_CHAPTER_ID);
  });
});

describe("a clean dry run", () => {
  it("plans all six, and books exactly $150.00 of revenue", () => {
    const plan = planRegistrationBackfill(world());
    expect(plan.problems).toEqual([]);
    expect(plan.inserts).toHaveLength(6);
    expect(plan.alreadyPresent).toEqual([]);
    expect(plan.grossCents).toBe(30_000);
    expect(plan.paidCents).toBe(15_000);
    expect(plan.linkedPeople).toBe(0);
  });

  it("produces exactly the numbers the module header tells the operator to check", () => {
    // THE STOP-RULE, as a test, so the header and the code can't drift apart.
    // An earlier draft of that header told the operator to halt unless
    // `rosterMatches` was 2 — a number that was both wrong (it is 6) and not a
    // money signal at all, so following it would have stopped a correct run.
    // These four ARE the money invariants; roster matching is not among them.
    const plan = planRegistrationBackfill(world());
    expect(plan.alreadyPresent).toHaveLength(0); // first run: nothing recorded yet
    expect(plan.paidCents).toBe(15_000); // revenueAddedCents
    expect(plan.grossCents).toBe(30_000);
    expect(-plan.paidCents).toBe(-15_000); // gapMovementCents, sign included
    expect(plan.problems).toEqual([]);
  });

  it("a row already present is the double-count signal, not an error", () => {
    // `alreadyPresent > 0` on a FIRST run means something else already imported
    // these transactions — the one outcome that should stop the operator dead,
    // because booking them again is exactly the double-count this table exists
    // to prevent. On a RE-run it is the idempotency check passing.
    const done = new Set([externalRefFor("4284185383")]);
    const plan = planRegistrationBackfill(world({ existingExternalRefs: done }));
    expect(plan.alreadyPresent).toEqual(["gb:txn:4284185383"]);
    expect(plan.problems).toEqual([]); // reported as a count, never as a throw
    expect(plan.inserts).toHaveLength(5);
  });

  it("moves the org-wide gap DOWN by $150.00 — the sign is the whole point", () => {
    // `differenceCents = located − books` (`lib/reconciliationGap.ts`). The
    // $150.00 of cash arrived in Givebutter payout KKJ3TQ months ago and is
    // already inside `located`; only `books` was short. Adding the revenue
    // raises books, so the SIGNED gap falls by exactly that much — from
    // `cash_exceeds_books +$150.00` to balanced. Getting this backwards is the
    // easy mistake, and it is the mistake that would send someone hunting for
    // a $300.00 discrepancy that never existed.
    const plan = planRegistrationBackfill(world());
    const gapMovementCents = -plan.paidCents;
    expect(gapMovementCents).toBe(-15_000);
    expect(15_000 + gapMovementCents).toBe(0);
  });

  it("never fabricates a refund date the source didn't have", () => {
    // `PlannedRegistration` has no `refundedAt` field AT ALL — the export gave
    // the refunds a status but no date, so there is nothing to copy and the
    // type makes copying impossible rather than merely unlikely. The schema
    // documents the column as "when known", explicitly NOT an iff-refunded
    // invariant, so a refunded row without one is honest and not malformed.
    const plan = planRegistrationBackfill(world());
    for (const row of plan.inserts) {
      expect(Object.keys(row)).not.toContain("refundedAt");
    }
    expect(plan.inserts.filter((r) => r.status === "refunded")).toHaveLength(3);
  });

  it("carries the scholarship reason onto every refunded row", () => {
    const plan = planRegistrationBackfill(world());
    const refunded = plan.inserts.filter((r) => r.status === "refunded");
    expect(refunded).toHaveLength(3);
    expect(refunded.every((r) => r.refundReason === "scholarship")).toBe(true);
    // …and never onto a paid one.
    expect(
      plan.inserts.filter((r) => r.status === "paid").every((r) => !r.refundReason),
    ).toBe(true);
  });
});

describe("idempotency", () => {
  it("a second run over its own output inserts nothing", () => {
    const first = planRegistrationBackfill(world());
    const applied = new Set(first.inserts.map((r) => r.externalRef));
    const second = planRegistrationBackfill(
      world({ existingExternalRefs: applied }),
    );
    expect(second.inserts).toEqual([]);
    expect(second.alreadyPresent).toHaveLength(6);
    expect(second.problems).toEqual([]);
    // Nothing new goes in, so nothing new moves the books. `grossCents` still
    // reports the cohort's face value — it describes the fixture, not the write.
    expect(second.paidCents).toBe(15_000);
  });

  it("a half-applied run finishes the job and no more", () => {
    const done = new Set([externalRefFor("4284185383"), externalRefFor("8784708028")]);
    const plan = planRegistrationBackfill(world({ existingExternalRefs: done }));
    expect(plan.inserts).toHaveLength(4);
    expect(plan.alreadyPresent).toHaveLength(2);
    expect(plan.inserts.some((r) => r.externalRef === "gb:txn:4284185383")).toBe(
      false,
    );
  });
});

describe("preconditions — it SKIPS rather than writing", () => {
  it("refuses when the project isn't there", () => {
    const plan = planRegistrationBackfill(world({ project: null }));
    expect(plan.inserts).toEqual([]);
    expect(plan.problems).toEqual([
      `project ${WBTW_PROJECT_ID} not found in this deployment — SKIPPED`,
    ]);
  });

  it("refuses when the project belongs to another chapter", () => {
    const plan = planRegistrationBackfill(
      world({ project: { ...goodProject, chapterId: "someotherchapterid" } }),
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.problems[0]).toContain("belongs to chapter someotherchapterid");
    expect(plan.problems[0]).toContain("SKIPPED");
  });

  it("refuses when the project isn't the class this fixture describes", () => {
    const plan = planRegistrationBackfill(
      world({ project: { ...goodProject, name: "Field Day" } }),
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.problems[0]).toContain('is named "Field Day"');
  });

  it("reports EVERY mismatch, not just the first", () => {
    const plan = planRegistrationBackfill(
      world({ project: { id: WBTW_PROJECT_ID, chapterId: "elsewhere", name: "Nope" } }),
    );
    expect(plan.problems).toHaveLength(2);
  });
});

describe("person linking is by EMAIL, never by name", () => {
  it("links the rows whose supplied email is on the roster", () => {
    const plan = planRegistrationBackfill(
      world({
        registrantByTxnId: registrants((txnId) =>
          txnId === "6680142853" ? "Cy.Placeholder@Example.com " : undefined,
        ),
        personIdByEmail: new Map([["cy.placeholder@example.com", "person_c"]]),
      }),
    );
    const linked = plan.inserts.find((r) => r.externalRef === "gb:txn:6680142853");
    expect(linked?.personId).toBe("person_c");
    // Normalised on the way in — a trailing space and a capital C must not
    // decide whether a payment reaches someone's record.
    expect(linked?.email).toBe("cy.placeholder@example.com");
    expect(plan.linkedPeople).toBe(1);
  });

  it("leaves the other five unlinked — a name match is never enough", () => {
    const plan = planRegistrationBackfill(
      world({
        registrantByTxnId: registrants((txnId) =>
          txnId === "6680142853" ? "cy.placeholder@example.com" : undefined,
        ),
        personIdByEmail: new Map([
          ["cy.placeholder@example.com", "person_c"],
          // A roster person who happens to share a registrant's NAME. The whole
          // point: this must not produce a link, because nobody supplied that
          // registrant's address.
          ["someone.else@example.com", "person_f"],
        ]),
      }),
    );
    expect(plan.linkedPeople).toBe(1);
    expect(
      plan.inserts
        .filter((r) => r.externalRef !== "gb:txn:6680142853")
        .every((r) => r.personId === undefined),
    ).toBe(true);
  });

  it("a supplied email matching nobody still records the row", () => {
    const plan = planRegistrationBackfill(
      world({
        registrantByTxnId: registrants((txnId) =>
          txnId === "3267180644" ? "typo@exmaple.com" : undefined,
        ),
      }),
    );
    expect(plan.linkedPeople).toBe(0);
    // An unlinked registration is complete on its own — never a problem.
    expect(plan.inserts).toHaveLength(6);
    expect(plan.problems).toEqual([]);
    expect(
      plan.inserts.find((r) => r.externalRef === "gb:txn:3267180644")?.email,
    ).toBe("typo@exmaple.com");
  });

  it("links nobody at all when no emails are supplied", () => {
    const plan = planRegistrationBackfill(world());
    expect(plan.linkedPeople).toBe(0);
    expect(plan.inserts.every((r) => r.personId === undefined)).toBe(true);
    expect(plan.inserts.every((r) => r.email === undefined)).toBe(true);
  });
});

describe("a missing registrant name is a precondition failure", () => {
  it("SKIPS, by transaction id, rather than inventing a name", () => {
    const partial = registrants();
    partial.delete("8784708028");
    const plan = planRegistrationBackfill(world({ registrantByTxnId: partial }));
    expect(plan.inserts).toEqual([]);
    expect(plan.problems).toEqual([
      "no registrant name supplied for gb:txn:8784708028 — SKIPPED",
    ]);
  });

  it("a blank name counts as missing", () => {
    const blank = registrants();
    blank.set("4284185383", { name: "   " });
    const plan = planRegistrationBackfill(world({ registrantByTxnId: blank }));
    expect(plan.inserts).toEqual([]);
    expect(plan.problems).toHaveLength(1);
  });

  it("reports EVERY missing name, so one run names all the gaps", () => {
    const plan = planRegistrationBackfill(
      world({ registrantByTxnId: new Map() }),
    );
    expect(plan.problems).toHaveLength(6);
    expect(plan.inserts).toEqual([]);
  });

  it("names a person on every row it does plan", () => {
    const plan = planRegistrationBackfill(world());
    expect(plan.inserts.every((r) => r.name.trim().length > 0)).toBe(true);
  });
});
