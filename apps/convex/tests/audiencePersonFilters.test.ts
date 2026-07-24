/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Person-centric audiences Phase 3 — the `person_filters` source
 * (specs/person-centric-audiences.md "Phase 3"): robust AND-combined filters
 * + hand-picked include/exclude lists, resolved via
 * `lib/audienceResolve.ts#resolvePersonFilters` and exposed through
 * `audiences.ts`'s `previewAudience`/`createAudience`/`updateAudience`/
 * `searchPeopleForAudience`.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

async function seedPerson(
  s: ChapterSetup,
  opts: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      status: "active",
      createdAt: Date.now(),
      ...opts,
    }),
  );
}

async function seedDonorForPerson(
  s: ChapterSetup,
  personId: Id<"people">,
  opts: {
    email: string;
    status: "prospect" | "active" | "lapsed";
    lifetimeCents?: number;
    giftCount?: number;
    lastGiftAt?: number;
    scope?: Id<"chapters"> | "central";
  },
): Promise<Id<"donors">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("donors", {
      scope: opts.scope ?? s.chapterId,
      kind: "individual",
      name: `Donor ${opts.email}`,
      email: opts.email,
      status: opts.status,
      lifetimeCents: opts.lifetimeCents ?? 0,
      giftCount: opts.giftCount ?? 0,
      lastGiftAt: opts.lastGiftAt,
      personId,
      createdAt: Date.now(),
    }),
  );
}

async function seedPledge(
  s: ChapterSetup,
  donorId: Id<"donors">,
  status: "incomplete" | "active" | "past_due" | "canceled" | "paused",
  scope?: Id<"chapters"> | "central",
): Promise<Id<"pledges">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("pledges", {
      donorId,
      scope: scope ?? s.chapterId,
      amountCents: 2000,
      status,
      origin: "stripe",
      createdAt: Date.now(),
    }),
  );
}

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Night",
      slug: `night-${now}-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Night",
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedRsvpForPerson(
  s: ChapterSetup,
  personId: Id<"people">,
  eventId: Id<"events">,
  opts: { status?: "going" | "maybe" | "not_going"; createdAt?: number } = {},
): Promise<Id<"rsvps">> {
  const now = opts.createdAt ?? Date.now();
  return run(s.t, (ctx) =>
    ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: "Guest",
      email: `guest-${personId}@example.com`,
      status: opts.status ?? "going",
      token: `tok-${personId}-${eventId}-${Math.random()}`,
      personId,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function seedSeat(
  s: ChapterSetup,
  personId: Id<"people">,
  opts: { scope?: Id<"chapters"> | "central" } = {},
): Promise<Id<"seatDefs">> {
  const seatDefId = await run(s.t, (ctx) =>
    ctx.db.insert("seatDefs", {
      slug: `test_seat_${personId}`,
      title: "Test Seat",
      chart: "chapter",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities: [],
      sortOrder: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId,
      scope: opts.scope ?? s.chapterId,
      personId,
      createdAt: Date.now(),
    }),
  );
  return seatDefId;
}

async function previewPersonFilters(
  s: ChapterSetup,
  args: {
    scope?: Id<"chapters"> | "central";
    filters?: Record<string, unknown>;
    includePersonIds?: Id<"people">[];
    excludePersonIds?: Id<"people">[];
  } = {},
) {
  return s.as.query(api.audiences.previewAudience, {
    scope: args.scope ?? s.chapterId,
    source: "person_filters",
    filters: args.filters ?? {},
    includePersonIds: args.includePersonIds,
    excludePersonIds: args.excludePersonIds,
  });
}

// ── filter matrix ────────────────────────────────────────────────────────

describe("person_filters — base pool semantics", () => {
  test("empty filters includes both roster and contacts (unlike legacy 'people'), excludes placeholder/inactive", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedPerson(s, { name: "Roster Member", email: "roster@example.com" });
    await seedPerson(s, {
      name: "Contact",
      email: "contact@example.com",
      isContactOnly: true,
    });
    await seedPerson(s, { name: "Placeholder", email: "ph@example.com", isPlaceholder: true });
    await seedPerson(s, { name: "Inactive", email: "inactive@example.com", status: "inactive" });

    const preview = await previewPersonFilters(s);
    expect(preview.count).toBe(2);
    expect(preview.sample.map((r) => r.email).sort()).toEqual([
      "contact@example.com",
      "roster@example.com",
    ]);
  });

  test("teamOnly excludes contacts; contactsOnly excludes roster", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedPerson(s, { name: "Roster Member", email: "roster@example.com" });
    await seedPerson(s, {
      name: "Contact",
      email: "contact@example.com",
      isContactOnly: true,
    });

    const teamOnly = await previewPersonFilters(s, { filters: { teamOnly: true } });
    expect(teamOnly.sample.map((r) => r.email)).toEqual(["roster@example.com"]);

    const contactsOnly = await previewPersonFilters(s, { filters: { contactsOnly: true } });
    expect(contactsOnly.sample.map((r) => r.email)).toEqual(["contact@example.com"]);
  });
});

describe("person_filters — giving criteria", () => {
  test("givingLifetimeMinCents/MaxCents AND-combine", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const low = await seedPerson(s, { name: "Low", email: "low@example.com" });
    const mid = await seedPerson(s, { name: "Mid", email: "mid@example.com" });
    const high = await seedPerson(s, { name: "High", email: "high@example.com" });
    await seedDonorForPerson(s, low, { email: "low-d@example.com", status: "active", lifetimeCents: 500 });
    await seedDonorForPerson(s, mid, { email: "mid-d@example.com", status: "active", lifetimeCents: 5000 });
    await seedDonorForPerson(s, high, {
      email: "high-d@example.com",
      status: "active",
      lifetimeCents: 50000,
    });

    const preview = await previewPersonFilters(s, {
      filters: { givingLifetimeMinCents: 1000, givingLifetimeMaxCents: 10000 },
    });
    expect(preview.sample.map((r) => r.email)).toEqual(["mid@example.com"]);
  });

  test("giftCountMin", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const one = await seedPerson(s, { name: "One", email: "one@example.com" });
    const three = await seedPerson(s, { name: "Three", email: "three@example.com" });
    await seedDonorForPerson(s, one, { email: "one-d@example.com", status: "active", giftCount: 1 });
    await seedDonorForPerson(s, three, { email: "three-d@example.com", status: "active", giftCount: 3 });

    const preview = await previewPersonFilters(s, { filters: { giftCountMin: 2 } });
    expect(preview.sample.map((r) => r.email)).toEqual(["three@example.com"]);
  });

  test("gaveWithinDays reads the donor row's lastGiftAt as a rolling window", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const recent = await seedPerson(s, { name: "Recent", email: "recent@example.com" });
    const stale = await seedPerson(s, { name: "Stale", email: "stale@example.com" });
    await seedDonorForPerson(s, recent, {
      email: "recent-d@example.com",
      status: "active",
      lastGiftAt: now - 5 * DAY,
    });
    await seedDonorForPerson(s, stale, {
      email: "stale-d@example.com",
      status: "active",
      lastGiftAt: now - 90 * DAY,
    });

    const preview = await previewPersonFilters(s, { filters: { gaveWithinDays: 30 } });
    expect(preview.sample.map((r) => r.email)).toEqual(["recent@example.com"]);
  });

  test("donorStatus filters on the linked donor's status", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const active = await seedPerson(s, { name: "Active", email: "active@example.com" });
    const lapsed = await seedPerson(s, { name: "Lapsed", email: "lapsed@example.com" });
    await seedDonorForPerson(s, active, { email: "active-d@example.com", status: "active" });
    await seedDonorForPerson(s, lapsed, { email: "lapsed-d@example.com", status: "lapsed" });

    const preview = await previewPersonFilters(s, { filters: { donorStatus: "active" } });
    expect(preview.sample.map((r) => r.email)).toEqual(["active@example.com"]);
  });

  test("backerStatus: 'active' requires a currently-active pledge; 'lapsed' requires a pledge on file with none active", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const activeBacker = await seedPerson(s, { name: "Active Backer", email: "ab@example.com" });
    const lapsedBacker = await seedPerson(s, { name: "Lapsed Backer", email: "lb@example.com" });
    const neverBacked = await seedPerson(s, { name: "Never", email: "never@example.com" });

    const activeDonor = await seedDonorForPerson(s, activeBacker, {
      email: "ab-d@example.com",
      status: "active",
    });
    await seedPledge(s, activeDonor, "active");

    const lapsedDonor = await seedDonorForPerson(s, lapsedBacker, {
      email: "lb-d@example.com",
      status: "active",
    });
    await seedPledge(s, lapsedDonor, "canceled");

    await seedDonorForPerson(s, neverBacked, { email: "never-d@example.com", status: "active" });

    const activePreview = await previewPersonFilters(s, { filters: { backerStatus: "active" } });
    expect(activePreview.sample.map((r) => r.email)).toEqual(["ab@example.com"]);

    const lapsedPreview = await previewPersonFilters(s, { filters: { backerStatus: "lapsed" } });
    expect(lapsedPreview.sample.map((r) => r.email)).toEqual(["lb@example.com"]);
  });
});

describe("person_filters — attendance criteria", () => {
  test("attendedEventId restricts to one event via rsvps.personId", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventA = await seedEvent(s);
    const eventB = await seedEvent(s);
    const wentToA = await seedPerson(s, { name: "Went to A", email: "a@example.com" });
    const wentToB = await seedPerson(s, { name: "Went to B", email: "b@example.com" });
    await seedRsvpForPerson(s, wentToA, eventA);
    await seedRsvpForPerson(s, wentToB, eventB);

    const preview = await previewPersonFilters(s, { filters: { attendedEventId: eventA } });
    expect(preview.sample.map((r) => r.email)).toEqual(["a@example.com"]);
  });

  test("attendedWithinDays is a rolling window off rsvps.createdAt", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const eventId = await seedEvent(s);
    const recent = await seedPerson(s, { name: "Recent", email: "recent-a@example.com" });
    const stale = await seedPerson(s, { name: "Stale", email: "stale-a@example.com" });
    await seedRsvpForPerson(s, recent, eventId, { createdAt: now - 2 * DAY });
    await seedRsvpForPerson(s, stale, eventId, { createdAt: now - 60 * DAY });

    const preview = await previewPersonFilters(s, { filters: { attendedWithinDays: 7 } });
    expect(preview.sample.map((r) => r.email)).toEqual(["recent-a@example.com"]);
  });

  test("rsvpStatus is an AND modifier on attendedEventId", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventId = await seedEvent(s);
    const going = await seedPerson(s, { name: "Going", email: "going@example.com" });
    const maybe = await seedPerson(s, { name: "Maybe", email: "maybe@example.com" });
    await seedRsvpForPerson(s, going, eventId, { status: "going" });
    await seedRsvpForPerson(s, maybe, eventId, { status: "maybe" });

    const preview = await previewPersonFilters(s, {
      filters: { attendedEventId: eventId, rsvpStatus: "going" },
    });
    expect(preview.sample.map((r) => r.email)).toEqual(["going@example.com"]);
  });
});

describe("person_filters — role and type criteria", () => {
  test("seatId matches any seatAssignments row for that seatDefId", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const holder = await seedPerson(s, { name: "Holder", email: "holder@example.com" });
    const other = await seedPerson(s, { name: "Other", email: "other@example.com" });
    const seatDefId = await seedSeat(s, holder);
    void other;

    const preview = await previewPersonFilters(s, { filters: { seatId: seatDefId } });
    expect(preview.sample.map((r) => r.email)).toEqual(["holder@example.com"]);
  });

  test("verifiedEmailOnly requires a personEmails row with verified:true, but never excludes a hand-pick", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const verified = await seedPerson(s, { name: "Verified", email: "verified@example.com" });
    const unverified = await seedPerson(s, { name: "Unverified", email: "unverified@example.com" });
    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId: verified,
        email: "verified@example.com",
        source: "manual",
        verified: true,
        addedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId: unverified,
        email: "unverified@example.com",
        source: "rsvp",
        verified: false,
        addedAt: Date.now(),
      }),
    );

    const filterOnly = await previewPersonFilters(s, { filters: { verifiedEmailOnly: true } });
    expect(filterOnly.sample.map((r) => r.email)).toEqual(["verified@example.com"]);

    // Hand-picking the unverified person bypasses the FILTER criterion — a
    // hand-pick is curation, not a filter match (see the resolver's doc).
    const withHandPick = await previewPersonFilters(s, {
      filters: { verifiedEmailOnly: true },
      includePersonIds: [unverified],
    });
    expect(withHandPick.sample.map((r) => r.email).sort()).toEqual([
      "unverified@example.com",
      "verified@example.com",
    ]);
  });

  test("AND-combo: teamOnly + donorStatus narrows to roster donors only", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const rosterDonor = await seedPerson(s, { name: "Roster Donor", email: "rd@example.com" });
    const contactDonor = await seedPerson(s, {
      name: "Contact Donor",
      email: "cd@example.com",
      isContactOnly: true,
    });
    await seedDonorForPerson(s, rosterDonor, { email: "rd-d@example.com", status: "active" });
    await seedDonorForPerson(s, contactDonor, { email: "cd-d@example.com", status: "active" });

    const preview = await previewPersonFilters(s, {
      filters: { teamOnly: true, donorStatus: "active" },
    });
    expect(preview.sample.map((r) => r.email)).toEqual(["rd@example.com"]);
  });
});

// ── hand-pick precedence + invariants ────────────────────────────────────

describe("person_filters — include/exclude precedence", () => {
  test("includePersonIds unions in regardless of filter match", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const matches = await seedPerson(s, { name: "Matches", email: "matches@example.com" });
    const handPicked = await seedPerson(s, { name: "Hand Picked", email: "handpicked@example.com" });
    await seedDonorForPerson(s, matches, { email: "matches-d@example.com", status: "active" });

    const preview = await previewPersonFilters(s, {
      filters: { donorStatus: "active" },
      includePersonIds: [handPicked],
    });
    expect(preview.sample.map((r) => r.email).sort()).toEqual([
      "handpicked@example.com",
      "matches@example.com",
    ]);
  });

  test("excludePersonIds always wins, even over a filter match AND a hand-pick", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const person = await seedPerson(s, { name: "Both", email: "both@example.com" });
    await seedDonorForPerson(s, person, { email: "both-d@example.com", status: "active" });

    const preview = await previewPersonFilters(s, {
      filters: { donorStatus: "active" },
      includePersonIds: [person],
      excludePersonIds: [person],
    });
    expect(preview.count).toBe(0);
  });

  test("INVARIANT: suppression overrides a hand-pick — a manual include is not consent", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const personId = await seedPerson(s, {
      name: "Suppressed Pick",
      email: "suppressed-pick@example.com",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("emailSuppressions", {
        email: "suppressed-pick@example.com",
        reason: "unsubscribe",
        createdAt: Date.now(),
      }),
    );

    const preview = await previewPersonFilters(s, { includePersonIds: [personId] });
    expect(preview.count).toBe(0);
    expect(preview.excludedSuppressed).toBe(1);
  });

  test("INVARIANT: marketingOptOut overrides a hand-pick — counted via excludedOptOut", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const personId = await seedPerson(s, {
      name: "Opted Out Pick",
      email: "opted-out-pick@example.com",
      marketingOptOut: true,
    });

    const preview = await previewPersonFilters(s, { includePersonIds: [personId] });
    expect(preview.count).toBe(0);
    expect(preview.excludedOptOut).toBe(1);
  });
});

// ── central-donor fallback ────────────────────────────────────────────────

describe("person_filters — central-donor fallback (spec §3.4)", () => {
  test("an unlinked central donor row is included and counted separately", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    // A linked chapter donor (normal path) + an unlinked central donor
    // (permanently unlinked by design — central has no roster to join).
    const linked = await seedPerson(s, { name: "Linked", email: "linked@example.com" });
    await seedDonorForPerson(s, linked, { email: "linked-d@example.com", status: "active" });
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "Unlinked Central Donor",
        email: "central-unlinked@example.com",
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );

    const preview = await previewPersonFilters(s, {
      scope: "central",
      filters: { donorStatus: "active" },
    });
    expect(preview.sample.map((r) => r.email).sort()).toEqual([
      "central-unlinked@example.com",
      "linked@example.com",
    ]);
    expect(preview.unlinkedCentralDonors).toBe(1);
  });

  test("the fallback does NOT apply for a chapter-scoped audience", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "Unlinked Central Donor",
        email: "central-unlinked-2@example.com",
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );

    const preview = await previewPersonFilters(s, {
      scope: s.chapterId,
      filters: { donorStatus: "active" },
    });
    expect(preview.count).toBe(0);
    expect(preview.unlinkedCentralDonors).toBe(0);
  });
});

// ── searchPeopleForAudience ──────────────────────────────────────────────

describe("searchPeopleForAudience", () => {
  test("access gated for non-privileged callers", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.query(api.audiences.searchPeopleForAudience, { search: "a" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("prefix-matches name/email across BOTH roster and contacts", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedPerson(s, { name: "Ann Roster", email: "ann.roster@example.com" });
    await seedPerson(s, { name: "Ann Contact", email: "ann.contact@example.com", isContactOnly: true });
    await seedPerson(s, { name: "Bob Other", email: "bob@example.com" });

    const byName = await s.as.query(api.audiences.searchPeopleForAudience, { search: "Ann" });
    expect(byName.map((r) => r.name).sort()).toEqual(["Ann Contact", "Ann Roster"]);
    expect(byName.find((r) => r.name === "Ann Contact")?.isContactOnly).toBe(true);

    const byEmail = await s.as.query(api.audiences.searchPeopleForAudience, {
      search: "bob@example",
    });
    expect(byEmail.map((r) => r.name)).toEqual(["Bob Other"]);
  });

  test("a blank search returns nothing", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedPerson(s, { name: "Ann", email: "ann@example.com" });
    const results = await s.as.query(api.audiences.searchPeopleForAudience, { search: "   " });
    expect(results).toEqual([]);
  });
});

// ── create/update guards ─────────────────────────────────────────────────

describe("createAudience/updateAudience — hand-pick guards", () => {
  test("rejects a personId appearing in both includePersonIds and excludePersonIds", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const personId = await seedPerson(s, { name: "P", email: "p@example.com" });
    await expect(
      s.as.mutation(api.audiences.createAudience, {
        scope: "central",
        name: "Conflicted",
        source: "person_filters",
        filters: {},
        includePersonIds: [personId],
        excludePersonIds: [personId],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("round-trips includePersonIds/excludePersonIds through create + update", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const included = await seedPerson(s, { name: "Included", email: "included@example.com" });
    const excluded = await seedPerson(s, { name: "Excluded", email: "excluded@example.com" });

    const audienceId = await s.as.mutation(api.audiences.createAudience, {
      scope: "central",
      name: "Hand-picked",
      source: "person_filters",
      filters: {},
      includePersonIds: [included],
    });
    let fetched = await s.as.query(api.audiences.getAudience, { audienceId });
    expect(fetched.includePersonIds).toEqual([included]);

    await s.as.mutation(api.audiences.updateAudience, {
      audienceId,
      excludePersonIds: [excluded],
    });
    fetched = await s.as.query(api.audiences.getAudience, { audienceId });
    expect(fetched.includePersonIds).toEqual([included]); // untouched
    expect(fetched.excludePersonIds).toEqual([excluded]);
  });
});

// ── preview/send consistency ─────────────────────────────────────────────

describe("person_filters — preview and send-time materialization agree", () => {
  test("previewAudience's count matches resolveAudienceForSend's recipient count for the same saved audience", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await seedPerson(s, { name: "A", email: "a-consistency@example.com" });
    await seedPerson(s, { name: "B", email: "b-consistency@example.com", isContactOnly: true });

    const audienceId = await s.as.mutation(api.audiences.createAudience, {
      scope: "central",
      name: "Everyone",
      source: "person_filters",
      filters: {},
    });

    const preview = await s.as.query(api.audiences.previewAudience, {
      scope: "central",
      source: "person_filters",
      filters: {},
    });
    const forSend = await t.query(internal.audiences.resolveAudienceForSend, { audienceId });

    expect(forSend?.recipients).toHaveLength(preview.count);
    expect(new Set(forSend?.recipients.map((r) => r.email))).toEqual(
      new Set(preview.sample.map((r) => r.email)),
    );
  });
});
