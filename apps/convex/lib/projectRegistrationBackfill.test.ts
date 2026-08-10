import { describe, expect, it } from "vitest";
import {
  REGISTRATION_CENTS,
  WBTW_CHAPTER_ID,
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
  chapterId: WBTW_CHAPTER_ID,
  name: "Worship Beyond the walls",
};

function world(over: Partial<BackfillWorld> = {}): BackfillWorld {
  return {
    project: goodProject,
    existingExternalRefs: new Set<string>(),
    personIdByEmail: new Map<string, string>(),
    emailByTxnId: new Map<string, string>(),
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
    const plan = planRegistrationBackfill(world());
    for (const row of plan.inserts) {
      expect(row.refundedAt).toBeUndefined();
    }
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
        emailByTxnId: new Map([["6680142853", "Dominique@Example.com "]]),
        personIdByEmail: new Map([["dominique@example.com", "person_dom"]]),
      }),
    );
    const dom = plan.inserts.find((r) => r.name === "Dominique Hyppolite");
    expect(dom?.personId).toBe("person_dom");
    // Normalised on the way in — a trailing space and a capital D must not
    // decide whether a payment reaches someone's record.
    expect(dom?.email).toBe("dominique@example.com");
    expect(plan.linkedPeople).toBe(1);
  });

  it("leaves the other five unlinked — a name match is never enough", () => {
    const plan = planRegistrationBackfill(
      world({
        emailByTxnId: new Map([["6680142853", "dominique@example.com"]]),
        personIdByEmail: new Map([
          ["dominique@example.com", "person_dom"],
          // A roster person who happens to share a registrant's NAME. The
          // whole point: this must not produce a link, because nobody
          // supplied that registrant's address.
          ["someone.else@example.com", "person_esosa"],
        ]),
      }),
    );
    expect(plan.linkedPeople).toBe(1);
    expect(
      plan.inserts.filter((r) => r.name !== "Dominique Hyppolite").every(
        (r) => r.personId === undefined,
      ),
    ).toBe(true);
  });

  it("a supplied email matching nobody is reported, not silently dropped", () => {
    const plan = planRegistrationBackfill(
      world({ emailByTxnId: new Map([["3267180644", "typo@exmaple.com"]]) }),
    );
    expect(plan.linkedPeople).toBe(0);
    expect(plan.emailsWithNoPerson).toEqual(["typo@exmaple.com"]);
    // The row still goes in — an unlinked registration is complete on its own.
    expect(plan.inserts).toHaveLength(6);
    expect(plan.problems).toEqual([]);
  });

  it("links nobody at all when no emails are supplied", () => {
    const plan = planRegistrationBackfill(world());
    expect(plan.linkedPeople).toBe(0);
    expect(plan.emailsWithNoPerson).toEqual([]);
    expect(plan.inserts.every((r) => r.personId === undefined)).toBe(true);
  });
});
