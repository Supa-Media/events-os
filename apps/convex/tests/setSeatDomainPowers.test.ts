/**
 * `seats.setSeatDomainPowers` — the general power editor behind the org
 * chart's Powers section, and the one implementation the two named-rung
 * mutations (`setSeatGivingPower` / `setSeatCampaignPower`) now delegate to.
 *
 * Those two have their own suites covering the gate and the self-lockout guard
 * in depth (`givingPower.test.ts`, `campaignPower.test.ts`), and they exercise
 * this same body through the wrappers. What is tested HERE is what only the
 * general form can express: editing a domain that never had an editor, the
 * domain-scoping that stops one section's edit from touching another's powers,
 * and the refusal to accept a power from the wrong domain.
 */
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { expandPowers } from "@events-os/shared";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

async function seatSetup(opts: { email?: string } = {}): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, opts);
}

async function defBySlug(s: ChapterSetup, slug: string): Promise<Doc<"seatDefs">> {
  const def = await run(s.t, (ctx) =>
    ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

async function capsOf(s: ChapterSetup, slug: string): Promise<string[]> {
  return (await defBySlug(s, slug)).capabilities as string[];
}

/** A superuser caller — the bootstrap identity every power-editor suite uses. */
const SUPER = { email: "seyi@publicworship.life" };

describe("setSeatDomainPowers — domains that had no editor before", () => {
  test("grants a finance power to a seat that had none", async () => {
    const s = await seatSetup(SUPER);
    const lead = await defBySlug(s, "music_lead");
    expect(lead.capabilities).toEqual([]);

    const next = await s.as.mutation(api.seats.setSeatDomainPowers, {
      seatDefId: lead._id,
      domain: "finance",
      powers: ["finance.view"],
    });

    expect(next).toEqual(["finance.view"]);
    expect(await capsOf(s, "music_lead")).toEqual(["finance.view"]);
  });

  test("grants door check-in — an `events` power, previously template-only", async () => {
    const s = await seatSetup(SUPER);
    const lead = await defBySlug(s, "music_lead");

    const next = await s.as.mutation(api.seats.setSeatDomainPowers, {
      seatDefId: lead._id,
      domain: "events",
      powers: ["events.checkin"],
    });

    expect(next).toEqual(["events.checkin"]);
  });

  test("grants and revokes data export", async () => {
    const s = await seatSetup(SUPER);
    const lead = await defBySlug(s, "music_lead");

    await s.as.mutation(api.seats.setSeatDomainPowers, {
      seatDefId: lead._id,
      domain: "data",
      powers: ["data.export"],
    });
    expect(await capsOf(s, "music_lead")).toEqual(["data.export"]);

    const cleared = await s.as.mutation(api.seats.setSeatDomainPowers, {
      seatDefId: lead._id,
      domain: "data",
      powers: [],
    });
    expect(cleared).toEqual([]);
  });

  test("cards can be handed out without any other finance power", async () => {
    // The case the `cards` area exists for: broad card access that carries no
    // reach into the books.
    const s = await seatSetup(SUPER);
    const lead = await defBySlug(s, "music_lead");

    const next = await s.as.mutation(api.seats.setSeatDomainPowers, {
      seatDefId: lead._id,
      domain: "finance",
      powers: ["finance.cards.view"],
    });

    const granted = expandPowers(next);
    expect(granted.has("finance.cards.view")).toBe(true);
    expect(granted.has("finance.view")).toBe(false);
    expect(granted.has("finance.edit")).toBe(false);
    expect(granted.has("finance.accounts.view")).toBe(false);
  });
});

describe("setSeatDomainPowers — domain scoping", () => {
  test("replacing one domain preserves every other domain verbatim", async () => {
    const s = await seatSetup(SUPER);
    const fm = await defBySlug(s, "financial_manager");
    const before = fm.capabilities as string[];
    const nonGiving = before.filter((c) => !c.startsWith("giving."));

    const next = await s.as.mutation(api.seats.setSeatDomainPowers, {
      seatDefId: fm._id,
      domain: "giving",
      powers: [],
    });

    // Every non-giving power survived, in order; giving is gone.
    expect(next).toEqual(nonGiving);
    expect(next.some((c) => c.startsWith("giving."))).toBe(false);
  });

  test("an edit in one domain cannot strip a power in another by omission", async () => {
    const s = await seatSetup(SUPER);
    const fm = await defBySlug(s, "financial_manager");
    expect(fm.capabilities).toContain("data.export");

    await s.as.mutation(api.seats.setSeatDomainPowers, {
      seatDefId: fm._id,
      domain: "email",
      powers: [],
    });

    // `data.export` was never mentioned and is untouched — the property that
    // makes a per-section editor safe against a stale or partial client.
    expect(await capsOf(s, "financial_manager")).toContain("data.export");
  });

  test("rejects a power that does not belong to the named domain", async () => {
    const s = await seatSetup(SUPER);
    const lead = await defBySlug(s, "music_lead");

    await expect(
      s.as.mutation(api.seats.setSeatDomainPowers, {
        seatDefId: lead._id,
        domain: "giving",
        powers: ["finance.edit"],
      }),
    ).rejects.toThrow(/not a giving power/i);
  });

  test("de-duplicates a repeated power", async () => {
    const s = await seatSetup(SUPER);
    const lead = await defBySlug(s, "music_lead");

    const next = await s.as.mutation(api.seats.setSeatDomainPowers, {
      seatDefId: lead._id,
      domain: "finance",
      powers: ["finance.view", "finance.view"],
    });

    expect(next).toEqual(["finance.view"]);
  });
});

describe("setSeatDomainPowers — gate and guards", () => {
  test("rejects a caller with no org.chart.edit power", async () => {
    const s = await seatSetup({ email: "nobody@publicworship.life" });
    const lead = await defBySlug(s, "music_lead");

    await expect(
      s.as.mutation(api.seats.setSeatDomainPowers, {
        seatDefId: lead._id,
        domain: "finance",
        powers: ["finance.view"],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a derived seat", async () => {
    const s = await seatSetup(SUPER);
    const derived = await defBySlug(s, "chapter_directors");

    await expect(
      s.as.mutation(api.seats.setSeatDomainPowers, {
        seatDefId: derived._id,
        domain: "finance",
        powers: ["finance.view"],
      }),
    ).rejects.toThrow(/computed automatically/);
  });

  test("rejects an unknown seat", async () => {
    const s = await seatSetup(SUPER);
    const lead = await defBySlug(s, "music_lead");
    await run(s.t, (ctx) => ctx.db.delete(lead._id));

    await expect(
      s.as.mutation(api.seats.setSeatDomainPowers, {
        seatDefId: lead._id as Id<"seatDefs">,
        domain: "finance",
        powers: [],
      }),
    ).rejects.toThrow(/doesn't exist/);
  });
});

describe("setSeatDomainPowers — minimal storage", () => {
  test("stores only what was sent; implied powers come back derived, not written", async () => {
    const s = await seatSetup(SUPER);
    const lead = await defBySlug(s, "music_lead");

    const next = await s.as.mutation(api.seats.setSeatDomainPowers, {
      seatDefId: lead._id,
      domain: "email",
      powers: ["email.campaigns.approve"],
    });

    expect(next).toEqual(["email.campaigns.approve"]);
    // …but the seat really does hold the rungs beneath it.
    const granted = expandPowers(next);
    expect(granted.has("email.campaigns.edit")).toBe(true);
    expect(granted.has("email.assets.edit")).toBe(true);
  });
});
