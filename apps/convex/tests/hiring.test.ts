/**
 * The hiring pipeline: the public intake, the gates, and the three rules the
 * Academy's process depends on being enforced rather than remembered —
 * a placement needs two reviewers, a not-now needs a revisit date, and closing
 * a file is a director's act, not an associate's.
 *
 * Also pins the schema's inlined stage literals against `@events-os/shared`'s
 * `HIRING_STAGES`. Convex schemas inline their literals by convention, which
 * means the two lists can drift; this is the test that makes that a failure
 * instead of a bug report.
 */
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  CANDIDATE_SOURCE_IDS,
  HIRING_STAGES,
  MIN_REVIEWS_BEFORE_DECISION,
  REVIEW_KINDS,
  REVIEW_RECOMMENDATIONS,
  TRIAL_TRACK_IDS,
} from "@events-os/shared";
import {
  APPLICATION_RECOMMENDATIONS,
  APPLICATION_REVIEW_KINDS,
  APPLICATION_SOURCES,
  APPLICATION_STAGES,
  APPLICATION_TRIAL_TRACKS,
} from "../schema/hiring";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/** A complete, valid application body — the six answers the form requires. */
function applicationArgs(overrides: Record<string, unknown> = {}) {
  return {
    roleSlug: "people-director",
    roleTitle: "People Director",
    name: "Ada Rivera",
    email: "Ada@Example.com",
    phone: "555-0100",
    location: "Queens, NY",
    answers: {
      why: "I've watched this from the outside for a year and want in.",
      ownership: "I ran our church's volunteer onboarding end to end.",
      escalation: "Budget shortfall: three options, recommended the middle one.",
      capacity: "About 10 hours a week; my evenings are free.",
      covering: "Grace Fellowship, Astoria — I attend and give there.",
    },
    ...overrides,
  };
}

/** Seed a person for `userId` and put them on a CENTRAL seat carrying
 *  `capabilities`, which is how every hiring gate resolves reach. */
async function seedHiringSeat(
  s: ChapterSetup,
  capabilities: string[],
  opts: { slug?: string; userId?: Id<"users"> } = {},
): Promise<void> {
  const userId = opts.userId ?? s.userId;
  const now = Date.now();
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seat Holder",
      email: `seat-${opts.slug ?? "a"}@publicworship.life`,
      userId,
      createdAt: now,
    });
    const seatDefId = await ctx.db.insert("seatDefs", {
      slug: opts.slug ?? "test_people_seat",
      title: "Test People Seat",
      chart: "central",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("seatAssignments", {
      seatDefId,
      scope: "central",
      personId,
      createdAt: now,
    });
  });
}

async function submit(
  t: ReturnType<typeof newT>,
  overrides: Record<string, unknown> = {},
): Promise<Id<"jobApplications">> {
  await t.mutation(api.hiring.submitApplication, applicationArgs(overrides));
  const rows = await run(t, (ctx) => ctx.db.query("jobApplications").collect());
  return rows[rows.length - 1]._id;
}

describe("hiring — vocabulary stays in one piece", () => {
  test("the schema's inlined literals match the shared constants", () => {
    expect([...APPLICATION_STAGES]).toEqual([...HIRING_STAGES]);
    expect([...APPLICATION_SOURCES]).toEqual([...CANDIDATE_SOURCE_IDS]);
    expect([...APPLICATION_TRIAL_TRACKS]).toEqual([...TRIAL_TRACK_IDS]);
    expect([...APPLICATION_REVIEW_KINDS]).toEqual([...REVIEW_KINDS]);
    expect([...APPLICATION_RECOMMENDATIONS]).toEqual([...REVIEW_RECOMMENDATIONS]);
  });
});

describe("hiring — the public intake", () => {
  test("an application lands as `applied`, lowercased, on the public-call rung", async () => {
    const t = newT();
    const id = await submit(t);
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.stage).toBe("applied");
    expect(row?.email).toBe("ada@example.com");
    expect(row?.source).toBe("public_call");
    expect(row?.roleTitle).toBe("People Director");

    const events = await run(t, (ctx) =>
      ctx.db.query("applicationEvents").collect(),
    );
    expect(events.map((e) => e.type)).toEqual(["submitted"]);
  });

  test("a missing required answer is refused, by name", async () => {
    const t = newT();
    const args = applicationArgs();
    delete (args.answers as Record<string, string>).covering;
    await expect(
      t.mutation(api.hiring.submitApplication, args),
    ).rejects.toThrow(/home church/i);
  });

  test("an unknown answer key is refused rather than stored", async () => {
    const t = newT();
    const args = applicationArgs();
    (args.answers as Record<string, string>).salary_expectation = "$200k";
    await expect(
      t.mutation(api.hiring.submitApplication, args),
    ).rejects.toThrow(/salary_expectation/);
  });

  test("a junk email address is refused", async () => {
    const t = newT();
    await expect(
      t.mutation(api.hiring.submitApplication, applicationArgs({ email: "nope" })),
    ).rejects.toThrow(/doesn't look right/);
  });

  test("no role slug means the general-interest door, not a broken file", async () => {
    const t = newT();
    const args = applicationArgs();
    delete (args as Record<string, unknown>).roleSlug;
    delete (args as Record<string, unknown>).roleTitle;
    await t.mutation(api.hiring.submitApplication, args);
    const rows = await run(t, (ctx) => ctx.db.query("jobApplications").collect());
    expect(rows[0].roleSlug).toBe("general-interest");
    expect(rows[0].roleTitle).toBe("General interest");
  });

  test("a same-day re-submit updates the file instead of opening a second one", async () => {
    const t = newT();
    await submit(t);
    await submit(t, { phone: "555-0199" });
    const rows = await run(t, (ctx) => ctx.db.query("jobApplications").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe("555-0199");
  });

  test("the same person applying for a DIFFERENT role gets their own file", async () => {
    const t = newT();
    await submit(t);
    await submit(t, { roleSlug: "chapter-director", roleTitle: "Chapter Director" });
    const rows = await run(t, (ctx) => ctx.db.query("jobApplications").collect());
    expect(rows).toHaveLength(2);
  });
});

describe("hiring — the gates", () => {
  test("a member with no hiring seat cannot read the desk", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await submit(t);
    await expect(s.as.query(api.hiring.listApplications, {})).rejects.toThrow(
      /access to the hiring desk/,
    );
  });

  test("`hiring.view` reads but cannot move a file", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedHiringSeat(s, ["hiring.view"]);
    const id = await submit(t);

    const rows = await s.as.query(api.hiring.listApplications, {});
    expect(rows).toHaveLength(1);
    await expect(
      s.as.mutation(api.hiring.advanceStage, { applicationId: id, stage: "reviewing" }),
    ).rejects.toThrow(/run the hiring pipeline/);
  });

  test("`hiring.edit` runs the pipeline but cannot close a file", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedHiringSeat(s, ["hiring.edit"]);
    const id = await submit(t);

    await s.as.mutation(api.hiring.advanceStage, {
      applicationId: id,
      stage: "interview_heart",
    });
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.stage).toBe("interview_heart");

    await expect(
      s.as.mutation(api.hiring.recordDecision, {
        applicationId: id,
        outcome: "declined",
        reason: "Not enough hours.",
        sendMessage: false,
      }),
    ).rejects.toThrow(/Only a director/);
  });

  test("a stage move cannot smuggle a file into a closed stage", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedHiringSeat(s, ["hiring.edit"]);
    const id = await submit(t);
    await expect(
      s.as.mutation(api.hiring.advanceStage, { applicationId: id, stage: "declined" }),
    ).rejects.toThrow(/use place, not-now, or decline/i);
  });

  test("a chapter-scoped hiring seat reaches nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    await run(t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Chapter Person",
        email: "chapter@publicworship.life",
        userId: s.userId,
        createdAt: now,
      });
      const seatDefId = await ctx.db.insert("seatDefs", {
        slug: "chapter_hiring_seat",
        title: "Chapter Hiring Seat",
        chart: "chapter",
        parentSlug: "root",
        maxHolders: 1,
        duties: [],
        capabilities: ["hiring.approve"],
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId,
        scope: s.chapterId,
        personId,
        createdAt: now,
      });
    });
    const access = await s.as.query(api.hiring.myHiringAccess, {});
    expect(access).toEqual({ canView: false, canManage: false, canDecide: false });
  });
});

describe("hiring — the call", () => {
  test("placing someone takes two reviewers, not one", async () => {
    const t = newT();
    const director = await setupChapter(t);
    await seedHiringSeat(director, ["hiring.approve"], { slug: "director_seat" });
    const id = await submit(t);

    await director.as.mutation(api.hiring.submitReview, {
      applicationId: id,
      kind: "interview_heart",
      ratings: { character: 4, communication: 3 },
      recommendation: "advance",
    });
    await expect(
      director.as.mutation(api.hiring.recordDecision, {
        applicationId: id,
        outcome: "placed",
        reason: "Clear yes.",
        sendMessage: false,
      }),
    ).rejects.toThrow(new RegExp(`at least ${MIN_REVIEWS_BEFORE_DECISION} people`));

    // A second REVIEWER (not a second review from the same person) unblocks it.
    const secondUserId = await run(t, (ctx) =>
      ctx.db.insert("users", { email: "second@publicworship.life" }),
    );
    await seedHiringSeat(director, ["hiring.edit"], {
      slug: "associate_seat",
      userId: secondUserId,
    });
    const second = t.withIdentity({
      subject: `${secondUserId}|session`,
      issuer: "test",
    });
    await second.mutation(api.hiring.submitReview, {
      applicationId: id,
      kind: "trial_final",
      ratings: { character: 4, execution: 3 },
      recommendation: "advance",
    });
    await director.as.mutation(api.hiring.recordDecision, {
      applicationId: id,
      outcome: "placed",
      reason: "Clear yes.",
      sendMessage: false,
    });
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.stage).toBe("placed");
    expect(row?.decisionReason).toBe("Clear yes.");
  });

  test("filing twice for the same meeting replaces the card — it doesn't become two reviewers", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedHiringSeat(s, ["hiring.approve"]);
    const id = await submit(t);

    for (const rating of [2, 4]) {
      await s.as.mutation(api.hiring.submitReview, {
        applicationId: id,
        kind: "interview_heart",
        ratings: { character: rating },
        recommendation: "advance",
      });
    }
    const reviews = await run(t, (ctx) =>
      ctx.db.query("applicationReviews").collect(),
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0].ratings.character).toBe(4);
  });

  test("a not-now without a revisit date is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedHiringSeat(s, ["hiring.approve"]);
    const id = await submit(t);
    await expect(
      s.as.mutation(api.hiring.recordDecision, {
        applicationId: id,
        outcome: "not_now",
        reason: "Right person, wrong season.",
        sendMessage: false,
      }),
    ).rejects.toThrow(/come back to it/);

    await s.as.mutation(api.hiring.recordDecision, {
      applicationId: id,
      outcome: "not_now",
      reason: "Right person, wrong season.",
      revisitAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
      sendMessage: false,
    });
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.stage).toBe("not_now");
    expect(row?.revisitAt).toBeGreaterThan(Date.now());
  });

  test("a decline needs a recorded reason", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedHiringSeat(s, ["hiring.approve"]);
    const id = await submit(t);
    await expect(
      s.as.mutation(api.hiring.recordDecision, {
        applicationId: id,
        outcome: "declined",
        reason: "   ",
        sendMessage: false,
      }),
    ).rejects.toThrow(/reason is required/i);
  });

  test("re-opening a closed file clears the outcome that closed it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedHiringSeat(s, ["hiring.approve"]);
    const id = await submit(t);
    await s.as.mutation(api.hiring.recordDecision, {
      applicationId: id,
      outcome: "not_now",
      reason: "Wrong season.",
      revisitAt: Date.now() + 1000,
      sendMessage: false,
    });
    await s.as.mutation(api.hiring.advanceStage, {
      applicationId: id,
      stage: "reviewing",
      note: "They got back in touch.",
    });
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.stage).toBe("reviewing");
    expect(row?.outcome).toBeUndefined();
    expect(row?.revisitAt).toBeUndefined();
  });
});

describe("hiring — the trial", () => {
  test("starting a trial stores the dates the track promises", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedHiringSeat(s, ["hiring.edit"]);
    const id = await submit(t);
    const before = Date.now();
    await s.as.mutation(api.hiring.startTrial, {
      applicationId: id,
      track: "director",
      brief: "Interview six team members and draft the onboarding playbook.",
    });
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.stage).toBe("trial");
    expect(row?.trialTrack).toBe("director");
    const day = 24 * 60 * 60 * 1000;
    expect(row!.trialMidpointDueAt! - before).toBeGreaterThanOrEqual(30 * day - 1000);
    expect(row!.trialDecisionDueAt! - before).toBeGreaterThanOrEqual(60 * day - 1000);
  });
});

describe("hiring — the desk's numbers", () => {
  test("the summary counts what the desk is failing, not just what it holds", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedHiringSeat(s, ["hiring.edit"]);
    const fresh = await submit(t);
    const stale = await submit(t, {
      email: "old@example.com",
      roleSlug: "chapter-director",
    });
    // Age the second one past the response promise.
    await run(t, (ctx) =>
      ctx.db.patch(stale, {
        createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        stageChangedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      }),
    );
    await s.as.mutation(api.hiring.claimApplication, {
      applicationId: fresh,
      claim: true,
    });

    const summary = await s.as.query(api.hiring.pipelineSummary, {});
    expect(summary.open).toBe(2);
    expect(summary.pastPromise).toBe(1);
    expect(summary.unassigned).toBe(1);
    expect(summary.byStage.applied).toBe(2);
  });
});

describe("hiring — who gets told", () => {
  test("the new-application notice goes to central hiring-power holders, and nobody else", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Holds the power → gets told.
    await seedHiringSeat(s, ["hiring.approve"], { slug: "director_seat" });
    const otherUserId = await run(t, (ctx) =>
      ctx.db.insert("users", { email: "musician@publicworship.life" }),
    );
    // A central seat with no hiring power → not told. Granting the power is
    // the subscription; this is the half of that claim worth pinning.
    await seedHiringSeat(s, ["giving.view"], {
      slug: "music_seat",
      userId: otherUserId,
    });

    const id = await submit(t);
    const notice = await t.query(internal.hiring.getNewApplicationNotice, {
      applicationId: id,
    });
    expect(notice?.recipients).toEqual(["seat-director_seat@publicworship.life"]);
    expect(notice?.roleTitle).toBe("People Director");
    // The availability answer rides along — it is the org's stated hard gate.
    expect(notice?.capacity).toContain("10 hours a week");
  });

  test("no hiring seats yet means an empty recipient list, not a failure", async () => {
    const t = newT();
    const id = await submit(t);
    const notice = await t.query(internal.hiring.getNewApplicationNotice, {
      applicationId: id,
    });
    expect(notice?.recipients).toEqual([]);
  });
});
