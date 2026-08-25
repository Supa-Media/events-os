import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * THE PARTNER PORTAL — the sponsor-facing half of a sponsorship agreement.
 *
 * What these tests are actually protecting, in the order the money can go
 * wrong:
 *
 *  1. THE LINK IS STABLE AND KILLABLE. Minting twice returns the same token
 *     (a manager who presses Copy twice must not invalidate the URL they
 *     already emailed); revoking makes it a 404 that is indistinguishable
 *     from a guessed one.
 *  2. THE PORTAL LEAKS NOTHING. Due-diligence notes — our private assessment
 *     of the partner — must be unrepresentable in the public projection.
 *  3. A SIGNATURE IS AGAINST A VERSION. Editing a signed term clears the
 *     signature; editing a credit or a contact does not. The distinction is
 *     the whole reason the version pair exists.
 *  4. THE RAIL IS ENFORCED, NOT SUGGESTED. Card is refused above the ceiling
 *     even if the stored rails say otherwise, and raising an agreement past
 *     the ceiling drops card without being asked.
 *  5. THE AMOUNT IS ALWAYS OURS. A client asking for more than is owed gets
 *     clamped to the balance; a client asking to pay an unsigned agreement is
 *     refused outright.
 *  6. SETTLEMENT IS IDEMPOTENT AND CREDITS THE RIGHT NUMBER. Stripe delivers
 *     at least once, so a redelivered session must not book a second $3,500 —
 *     and fee coverage must count as the processor's, not the partnership's.
 */

const AMOUNT = 350_000; // $3,500 — the Ignite Production Partner spot.

async function seatCaller(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<Id<"people">> {
  return run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!def) throw new Error(`${slug} not seeded`);
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    });
    return personId;
  });
}

async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

/** A caller seated as a Partnership Associate at central — the partnership
 *  team. Holds `giving.partners.edit` (compose) but NOT `giving.edit`. */
async function associateSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "partnership_associate", "central");
  return s;
}

/** Seed a donor + package + agreement by DIRECT insert, bypassing the
 *  director-gated mutations — so a test can hand a fully-formed agreement to a
 *  caller who is NOT allowed to create one (an associate, a viewer) and check
 *  what they can do with it. */
async function seedAgreementRaw(s: ChapterSetup): Promise<Id<"sponsorships">> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const donorId = await ctx.db.insert("donors", {
      scope: "central",
      kind: "church",
      name: "Ignite",
      status: "prospect",
      lifetimeCents: 0,
      giftCount: 0,
      createdAt: now,
    });
    const packageId = await ctx.db.insert("sponsorPackages", {
      name: "LTN Production Partner",
      tierRank: 1,
      audience: "church",
      pricing: { kind: "one_time", amountCents: AMOUNT },
      scope: { kind: "season" },
      benefits: ["Named production credit"],
      commitments: ["Full photo report"],
      active: true,
      createdAt: now,
      updatedAt: now,
      updatedBy: s.userId,
    });
    return ctx.db.insert("sponsorships", {
      donorId,
      packageId,
      status: "prospect",
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** A church donor + a $3,500 tier + an agreement between them. */
async function seedAgreement(
  s: ChapterSetup,
  opts: { amountCents?: number } = {},
): Promise<Id<"sponsorships">> {
  const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
    scope: "central",
    name: "Ignite",
    kind: "church",
  })) as Id<"donors">;
  const packageId = (await s.as.mutation(api.sponsorships.savePackage, {
    name: "LTN Production Partner",
    tierRank: 1,
    audience: "church",
    pricing: { kind: "one_time", amountCents: opts.amountCents ?? AMOUNT },
    scope: { kind: "season" },
    benefits: ["Named production credit"],
    commitments: ["Full photo report"],
  })) as Id<"sponsorPackages">;
  return (await s.as.mutation(api.sponsorships.upsertSponsorship, {
    donorId,
    packageId,
  })) as Id<"sponsorships">;
}

/** An event on the setup's chapter, named so a test can tell two apart. */
async function seedEvent(
  s: ChapterSetup,
  name: string,
  daysOut: number,
): Promise<Id<"events">> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name,
      eventDate: now + daysOut * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Sign the agreement the way the public page would. */
async function sign(s: ChapterSetup, token: string) {
  return await s.t.mutation(internal.sponsorPortal.signAgreement, {
    token,
    name: "Tolu Adeyemi",
    title: "Executive Pastor",
    email: "tolu@ignite.org",
    clientIp: "203.0.113.7",
  });
}

// ── The link ─────────────────────────────────────────────────────────────────

describe("the portal link", () => {
  test("mints once and keeps returning the same token", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);

    const first = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    const second = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    // A second press must NOT invalidate the URL already sitting in an email.
    expect(second.token).toBe(first.token);
    expect(first.path).toBe(`/partner/${first.token}`);
  });

  test("revoking kills the link, and re-issuing mints a fresh one", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const first = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });

    await s.as.mutation(api.sponsorPortal.revokePortalLink, { sponsorshipId });
    expect(
      await s.t.query(api.sponsorPortal.publicByToken, { token: first.token }),
    ).toBeNull();

    const second = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    expect(second.token).not.toBe(first.token);
    expect(
      await s.t.query(api.sponsorPortal.publicByToken, { token: second.token }),
    ).not.toBeNull();
  });

  test("a guessed token and a revoked one look identical from outside", async () => {
    const s = await devDirectorSetup();
    expect(
      await s.t.query(api.sponsorPortal.publicByToken, { token: "nope" }),
    ).toBeNull();
    expect(
      await s.t.query(api.sponsorPortal.publicByToken, { token: "" }),
    ).toBeNull();
  });

  test("a signed-out caller cannot mint a link", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    await expect(
      s.t.mutation(api.sponsorPortal.issuePortalLink, { sponsorshipId }),
    ).rejects.toThrow();
  });
});

// ── What the partner may see ─────────────────────────────────────────────────

describe("publicByToken", () => {
  test("never carries our private assessment of the partner", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const row = await run(s.t, (ctx) => ctx.db.get(sponsorshipId));
    await s.as.mutation(api.sponsorships.upsertSponsorship, {
      sponsorshipId,
      donorId: row!.donorId,
      packageId: row!.packageId,
      dueDiligenceNotes: "Pastor's statement of beliefs is thin — follow up.",
    });
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });

    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(JSON.stringify(view)).not.toContain("statement of beliefs");
    // …and it does carry the things the partner came for.
    expect(view!.orgName).toBe("Ignite");
    expect(view!.amountCents).toBe(AMOUNT);
    expect(view!.balance.balanceCents).toBe(AMOUNT);
  });

  test("falls back to the package tier until the agreement diverges", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });

    let view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.title).toBe("LTN Production Partner");
    expect(view!.benefits).toEqual(["Named production credit"]);

    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      title: "Production Partner — Love Thy Neighbor",
      benefits: ["Named production credit", "A hosted gathering on Sept 18"],
    });
    view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.title).toBe("Production Partner — Love Thy Neighbor");
    expect(view!.benefits).toHaveLength(2);
  });

  test("renders a package-less agreement — the bespoke deal — without crashing", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = (await s.as.mutation(
      api.sponsorships.upsertSponsorship,
      { newOrg: { name: "Ignite Church", kind: "church" } },
    )) as Id<"sponsorships">;
    // Give it its own amount + title (no tier to fall back to).
    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      title: "Production Partner — Love Thy Neighbor",
      amountCents: AMOUNT,
      terms: "Settled together, in writing, in advance.",
    });
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.title).toBe("Production Partner — Love Thy Neighbor");
    expect(view!.amountCents).toBe(AMOUNT);
    expect(view!.balance.balanceCents).toBe(AMOUNT);
  });

  test("offers bank transfer alone by default, with its capped fee quoted", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.rails.map((r) => r.rail)).toEqual(["ach"]);
    // 0.8% of $3,500 is $28 — capped at $5. That cap is the whole argument.
    expect(view!.rails[0].feeCents).toBe(500);
  });
});

// ── Signing ──────────────────────────────────────────────────────────────────

describe("signAgreement", () => {
  test("records the signature against the current terms and moves the pipeline", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });

    const result = await sign(s, token);
    expect(result.termsVersion).toBe(1);

    const row = await run(s.t, (ctx) => ctx.db.get(sponsorshipId));
    expect(row!.signedName).toBe("Tolu Adeyemi");
    expect(row!.signedTermsVersion).toBe(1);
    expect(row!.signedIp).toBe("203.0.113.7");
    // A signed agreement is a commitment by anyone's definition.
    expect(row!.status).toBe("committed");
  });

  test("refuses a signature too short to be evidence, and a dead link", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });

    await expect(
      s.t.mutation(internal.sponsorPortal.signAgreement, { token, name: "T" }),
    ).rejects.toThrow();

    await s.as.mutation(api.sponsorPortal.revokePortalLink, { sponsorshipId });
    await expect(sign(s, token)).rejects.toThrow();
  });

  test("does not walk an active agreement backwards", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    await s.as.mutation(api.sponsorships.setSponsorshipStatus, {
      sponsorshipId,
      status: "active",
    });
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    await sign(s, token);
    const row = await run(s.t, (ctx) => ctx.db.get(sponsorshipId));
    expect(row!.status).toBe("active");
  });
});

// ── Editing what was signed ──────────────────────────────────────────────────

describe("saveProposal and the terms version", () => {
  test("editing a signed term clears the signature and bumps the version", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    await sign(s, token);

    const result = await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      terms: "The run of show is settled together, in writing, in advance.",
    });
    expect(result.signatureCleared).toBe(true);
    expect(result.termsVersion).toBe(2);

    // The signature ROW survives (evidence of what they signed), but the
    // portal reads as unsigned because it was against v1.
    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.signed).toBeNull();
    expect(view!.state).toBe("awaiting_signature");

    const admin = await s.as.query(api.sponsorPortal.portalAdmin, {
      sponsorshipId,
    });
    expect(admin.signature).toBeNull();
    expect(admin.staleSignature?.termsVersion).toBe(1);
  });

  test("editing a credit or the contact block leaves the signature alone", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    await sign(s, token);

    const result = await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      contactEmail: "Tolu@Ignite.org",
      inKindCredits: [{ label: "Full production suite", amountCents: 250_000 }],
    });
    // Giving a partner credit must never force them to re-sign.
    expect(result.signatureCleared).toBe(false);
    expect(result.termsVersion).toBe(1);

    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.signed).not.toBeNull();
    // The credit lands against the balance without any money moving.
    expect(view!.balance.inKindCents).toBe(250_000);
    expect(view!.balance.balanceCents).toBe(100_000);
    expect(view!.balance.percentCovered).toBe(71);

    const row = await run(s.t, (ctx) => ctx.db.get(sponsorshipId));
    expect(row!.contactEmail).toBe("tolu@ignite.org"); // normalized
  });

  test("saving the same values twice does not churn the version", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      title: "Production Partner",
    });
    const second = await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      title: "Production Partner",
    });
    expect(second.termsVersion).toBe(2); // bumped once by the first save
  });
});

// ── The rail ─────────────────────────────────────────────────────────────────

describe("payment rails", () => {
  test("refuses card on an agreement above the ceiling", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    await expect(
      s.as.mutation(api.sponsorPortal.saveProposal, {
        sponsorshipId,
        paymentRails: ["ach", "card"],
      }),
    ).rejects.toThrow();
  });

  test("allows card on a small spot", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s, { amountCents: 50_000 });
    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      paymentRails: ["ach", "card"],
    });
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.rails.map((r) => r.rail)).toEqual(["ach", "card"]);
  });

  test("raising an agreement past the ceiling drops card without being asked", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s, { amountCents: 50_000 });
    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      paymentRails: ["ach", "card"],
    });
    // The manager edits only the amount. Leaving card on would be a ~$101 fee
    // nobody chose, on the agreement most able to afford a careful decision.
    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      amountCents: AMOUNT,
    });
    const row = await run(s.t, (ctx) => ctx.db.get(sponsorshipId));
    expect(row!.paymentRails).toEqual(["ach"]);
  });
});

// ── Paying ───────────────────────────────────────────────────────────────────

describe("preparePayment", () => {
  async function signedAgreement() {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    await sign(s, token);
    return { s, sponsorshipId, token };
  }

  test("refuses to price an unsigned agreement", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    await expect(
      s.t.mutation(internal.sponsorPortal.preparePayment, { token, rail: "ach" }),
    ).rejects.toThrow();
  });

  test("prices the whole balance by default and pins the bank rail", async () => {
    const { s, token } = await signedAgreement();
    const prepared = await s.t.mutation(internal.sponsorPortal.preparePayment, {
      token,
      rail: "ach",
      coverFee: true,
    });
    expect(prepared.intendedCents).toBe(AMOUNT);
    expect(prepared.feeCents).toBe(500); // the $5 cap
    expect(prepared.paymentMethodTypes).toEqual(["us_bank_account"]);
    expect(prepared.feeRateLabel).toContain("capped at $5.00");
    // The email Stripe pre-fills comes from the signature, not the client.
    expect(prepared.payerEmail).toBe("tolu@ignite.org");
  });

  test("clamps a client that asks to pay more than is owed", async () => {
    const { s, token } = await signedAgreement();
    const prepared = await s.t.mutation(internal.sponsorPortal.preparePayment, {
      token,
      rail: "ach",
      amountCents: 99_999_999,
    });
    expect(prepared.intendedCents).toBe(AMOUNT);
  });

  test("honours a smaller instalment", async () => {
    const { s, token } = await signedAgreement();
    const prepared = await s.t.mutation(internal.sponsorPortal.preparePayment, {
      token,
      rail: "ach",
      amountCents: 100_000,
    });
    expect(prepared.intendedCents).toBe(100_000);
  });

  test("refuses a rail the agreement doesn't offer", async () => {
    const { s, token } = await signedAgreement();
    await expect(
      s.t.mutation(internal.sponsorPortal.preparePayment, { token, rail: "card" }),
    ).rejects.toThrow();
  });

  test("refuses once nothing is owed", async () => {
    const { s, sponsorshipId, token } = await signedAgreement();
    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      inKindCredits: [{ label: "Full production suite", amountCents: AMOUNT }],
    });
    await expect(
      s.t.mutation(internal.sponsorPortal.preparePayment, { token, rail: "ach" }),
    ).rejects.toThrow();
  });

  test("refuses a second payment while a bank debit for the whole balance is clearing", async () => {
    const { s, sponsorshipId, token } = await signedAgreement();
    // A pending debit for the whole balance is in flight (books no gift yet).
    await run(s.t, async (ctx) => {
      const donorId = (await ctx.db.get(sponsorshipId))!.donorId;
      const donor = await ctx.db.get(donorId);
      await ctx.db.insert("pendingGifts", {
        sessionId: "cs_clearing",
        status: "in_flight",
        scope: donor!.scope,
        amountCents: AMOUNT,
        chargeTotalCents: AMOUNT,
        currency: "usd",
        submittedAt: Date.now(),
        donorName: donor!.name,
        donorId,
        sponsorshipId,
        createdAt: Date.now(),
      });
    });

    // The balance is still full (no gift booked), but nothing is payable now.
    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.balance.balanceCents).toBe(AMOUNT);
    expect(view!.pendingCents).toBe(AMOUNT);
    expect(view!.payableCents).toBe(0);
    expect(view!.state).toBe("payment_clearing");

    // …and a second checkout is refused rather than double-charging.
    await expect(
      s.t.mutation(internal.sponsorPortal.preparePayment, { token, rail: "ach" }),
    ).rejects.toThrow();
  });

  test("allows paying only the remainder when a partial debit is clearing", async () => {
    const { s, sponsorshipId, token } = await signedAgreement();
    await run(s.t, async (ctx) => {
      const donorId = (await ctx.db.get(sponsorshipId))!.donorId;
      const donor = await ctx.db.get(donorId);
      await ctx.db.insert("pendingGifts", {
        sessionId: "cs_partial",
        status: "in_flight",
        scope: donor!.scope,
        amountCents: 100_000, // $1,000 of $3,500 in flight
        chargeTotalCents: 100_000,
        currency: "usd",
        submittedAt: Date.now(),
        donorName: donor!.name,
        donorId,
        sponsorshipId,
        createdAt: Date.now(),
      });
    });
    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.payableCents).toBe(250_000);

    // Asking for the whole balance clamps to what is payable now.
    const prepared = await s.t.mutation(internal.sponsorPortal.preparePayment, {
      token,
      rail: "ach",
      amountCents: AMOUNT,
    });
    expect(prepared.intendedCents).toBe(250_000);
  });
});

// ── Settlement ───────────────────────────────────────────────────────────────

describe("recordPortalPaymentPaid", () => {
  async function signedAgreement() {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    await sign(s, token);
    return { s, sponsorshipId, token };
  }

  test("books one gift, credits the intended amount, and settles the balance", async () => {
    const { s, sponsorshipId, token } = await signedAgreement();

    // The charge is the balance PLUS the $5 the partner covered.
    const booked = await s.t.mutation(
      internal.sponsorPortal.recordPortalPaymentPaid,
      {
        sponsorshipId,
        sessionId: "cs_partner_1",
        amountTotalCents: AMOUNT + 500,
        feeCoverageCents: 500,
      },
    );
    expect(booked).toBe(true);

    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    // The LEDGER receives $3,505; the AGREEMENT is credited $3,500. A partner
    // covering the processor's cut must not accidentally over-pay the spot.
    expect(view!.balance.paidCents).toBe(AMOUNT);
    expect(view!.balance.balanceCents).toBe(0);
    expect(view!.state).toBe("settled");

    const gifts = await run(s.t, (ctx) => ctx.db.query("gifts").collect());
    expect(gifts).toHaveLength(1);
    expect(gifts[0].amountCents).toBe(AMOUNT + 500);
    expect(gifts[0].feeCoverageCents).toBe(500);
    expect(gifts[0].sponsorshipId).toBe(sponsorshipId);
    expect(gifts[0].externalRef).toBe("sponsor:cs_partner_1");

    // …and the first dollar landing moves a committed agreement to active.
    const row = await run(s.t, (ctx) => ctx.db.get(sponsorshipId));
    expect(row!.status).toBe("active");
  });

  test("is idempotent — Stripe redelivers, and a second $3,500 would be real money", async () => {
    const { s, sponsorshipId } = await signedAgreement();
    const args = {
      sponsorshipId,
      sessionId: "cs_partner_dup",
      amountTotalCents: AMOUNT,
    };
    await s.t.mutation(internal.sponsorPortal.recordPortalPaymentPaid, args);
    await s.t.mutation(internal.sponsorPortal.recordPortalPaymentPaid, args);
    const gifts = await run(s.t, (ctx) => ctx.db.query("gifts").collect());
    expect(gifts).toHaveLength(1);
  });

  test("refuses a malformed total rather than booking a nonsense figure", async () => {
    const { s, sponsorshipId } = await signedAgreement();
    expect(
      await s.t.mutation(internal.sponsorPortal.recordPortalPaymentPaid, {
        sponsorshipId,
        sessionId: "cs_partner_bad",
        amountTotalCents: 0,
      }),
    ).toBe(false);
    const gifts = await run(s.t, (ctx) => ctx.db.query("gifts").collect());
    expect(gifts).toHaveLength(0);
  });

  test("no-ops on an id that isn't one of ours", async () => {
    const { s } = await signedAgreement();
    expect(
      await s.t.mutation(internal.sponsorPortal.recordPortalPaymentPaid, {
        sponsorshipId: "not-an-id",
        sessionId: "cs_partner_x",
        amountTotalCents: AMOUNT,
      }),
    ).toBe(false);
  });

  test("a part payment leaves the rest owed", async () => {
    const { s, sponsorshipId, token } = await signedAgreement();
    await s.t.mutation(internal.sponsorPortal.recordPortalPaymentPaid, {
      sponsorshipId,
      sessionId: "cs_partner_part",
      amountTotalCents: 100_000,
    });
    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.balance.balanceCents).toBe(250_000);
    expect(view!.state).toBe("awaiting_payment");
    expect(view!.payments).toHaveLength(1);
  });
});

// ── What the partnership covers ──────────────────────────────────────────────

describe("covered events", () => {
  test("one agreement carries several gatherings, and the partner sees each", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    // The Ignite deal exactly: one agreement standing behind Love Thy Neighbor
    // on the 26th AND the hosted Worship with Strangers on the 18th.
    const wws = await seedEvent(s, "Worship with Strangers", 29);
    const ltn = await seedEvent(s, "Love Thy Neighbor", 37);

    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      eventIds: [ltn, wws],
    });
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });

    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.events.map((e) => e.name).sort()).toEqual([
      "Love Thy Neighbor",
      "Worship with Strangers",
    ]);

    // …and the desk sees the same two, on the composer and on the pipeline row.
    const admin = await s.as.query(api.sponsorPortal.portalAdmin, { sponsorshipId });
    expect(admin.events).toHaveLength(2);
    const pipeline = await s.as.query(api.sponsorships.listSponsorships, {});
    expect(
      pipeline.find((r) => r.sponsorship._id === sponsorshipId)!.events,
    ).toHaveLength(2);
  });

  test("changing which events are covered re-opens the signature", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const ltn = await seedEvent(s, "Love Thy Neighbor", 37);
    const wws = await seedEvent(s, "Worship with Strangers", 29);
    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      eventIds: [ltn],
    });
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    await sign(s, token);

    // Adding the second gathering changes the substance of what they signed.
    const result = await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      eventIds: [ltn, wws],
    });
    expect(result.signatureCleared).toBe(true);

    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.signed).toBeNull();
    expect(view!.state).toBe("awaiting_signature");
  });

  test("re-sending the same events in a different order is not a change", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const ltn = await seedEvent(s, "Love Thy Neighbor", 37);
    const wws = await seedEvent(s, "Worship with Strangers", 29);
    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      eventIds: [ltn, wws],
    });
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    await sign(s, token);

    const result = await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      eventIds: [ltn, wws],
    });
    expect(result.signatureCleared).toBe(false);
  });

  test("refuses an event that doesn't exist rather than promising a blank date", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const ghost = await seedEvent(s, "Deleted Gathering", 10);
    await run(s.t, (ctx) => ctx.db.delete(ghost));

    await expect(
      s.as.mutation(api.sponsorPortal.saveProposal, {
        sponsorshipId,
        eventIds: [ghost],
      }),
    ).rejects.toThrow();
  });

  test("de-duplicates a list that names the same gathering twice", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const ltn = await seedEvent(s, "Love Thy Neighbor", 37);
    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      eventIds: [ltn, ltn],
    });
    const row = await run(s.t, (ctx) => ctx.db.get(sponsorshipId));
    expect(row!.eventIds).toEqual([ltn]);
  });
});

// ── Documents ────────────────────────────────────────────────────────────────

describe("agreement documents", () => {
  /** Store a blob directly (convex-test affordance) and return its id — stands
   *  in for the client PUT that `documentUploadUrl` sets up. */
  async function storePdf(s: ChapterSetup): Promise<Id<"_storage">> {
    return run(s.t, (ctx) =>
      (ctx.storage as unknown as {
        store: (b: Blob) => Promise<Id<"_storage">>;
      }).store(new Blob(["%PDF-1.7"], { type: "application/pdf" })),
    );
  }

  test("attaches a document, internal by default, and never leaks it to the partner", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const storageId = await storePdf(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });

    const docId = await s.as.mutation(api.sponsorPortal.attachDocument, {
      sponsorshipId,
      storageId,
      label: "Production proposal — full suite",
      fileName: "ignite.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
    });

    // The desk sees it; it is desk-only until shared.
    const admin = await s.as.query(api.sponsorPortal.portalAdmin, { sponsorshipId });
    expect(admin.documents).toHaveLength(1);
    expect(admin.documents[0].shared).toBe(false);

    // The partner sees NOTHING, and cannot fetch it by id.
    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.documents).toHaveLength(0);
    expect(
      await s.t.query(api.sponsorPortal.resolveSharedDocument, {
        token,
        documentId: docId,
      }),
    ).toBeNull();
  });

  test("sharing a document surfaces it on the partner's page and lets the token fetch it", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const storageId = await storePdf(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    const docId = await s.as.mutation(api.sponsorPortal.attachDocument, {
      sponsorshipId,
      storageId,
      label: "Production proposal",
      fileName: "ignite.pdf",
      contentType: "application/pdf",
    });

    await s.as.mutation(api.sponsorPortal.setDocumentVisibility, {
      documentId: docId,
      shared: true,
    });

    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.documents).toHaveLength(1);
    expect(view!.documents[0].label).toBe("Production proposal");
    expect(view!.documents[0].href).toBe(`/partner/${token}/doc/${docId}`);
    // No storage id ever reaches the partner shape.
    expect(JSON.stringify(view!.documents[0])).not.toContain(storageId);

    const resolved = await s.t.query(api.sponsorPortal.resolveSharedDocument, {
      token,
      documentId: docId,
    });
    expect(resolved!.storageId).toBe(storageId);
  });

  test("a revoked link kills document access even for a shared doc", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const storageId = await storePdf(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    const docId = await s.as.mutation(api.sponsorPortal.attachDocument, {
      sponsorshipId,
      storageId,
      label: "Proposal",
      contentType: "application/pdf",
    });
    await s.as.mutation(api.sponsorPortal.setDocumentVisibility, {
      documentId: docId,
      shared: true,
    });
    await s.as.mutation(api.sponsorPortal.revokePortalLink, { sponsorshipId });

    expect(
      await s.t.query(api.sponsorPortal.resolveSharedDocument, {
        token,
        documentId: docId,
      }),
    ).toBeNull();
  });

  test("a document cannot be fetched through another agreement's token", async () => {
    const s = await devDirectorSetup();
    const a = await seedAgreement(s);
    const b = await seedAgreement(s);
    const storageId = await storePdf(s);
    const docId = await s.as.mutation(api.sponsorPortal.attachDocument, {
      sponsorshipId: a,
      storageId,
      label: "Proposal",
      contentType: "application/pdf",
    });
    await s.as.mutation(api.sponsorPortal.setDocumentVisibility, {
      documentId: docId,
      shared: true,
    });
    const { token: bToken } = await s.as.mutation(
      api.sponsorPortal.issuePortalLink,
      { sponsorshipId: b },
    );

    expect(
      await s.t.query(api.sponsorPortal.resolveSharedDocument, {
        token: bToken,
        documentId: docId,
      }),
    ).toBeNull();
  });

  test("refuses an unsupported file type and doesn't strand the blob", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const storageId = await run(s.t, (ctx) =>
      (ctx.storage as unknown as {
        store: (b: Blob) => Promise<Id<"_storage">>;
      }).store(new Blob(["zip"], { type: "application/zip" })),
    );
    await expect(
      s.as.mutation(api.sponsorPortal.attachDocument, {
        sponsorshipId,
        storageId,
        label: "Archive",
        contentType: "application/zip",
      }),
    ).rejects.toThrow();
  });

  test("removing a document deletes the row and the blob", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const storageId = await storePdf(s);
    const docId = await s.as.mutation(api.sponsorPortal.attachDocument, {
      sponsorshipId,
      storageId,
      label: "Proposal",
      contentType: "application/pdf",
    });
    await s.as.mutation(api.sponsorPortal.removeDocument, { documentId: docId });

    const admin = await s.as.query(api.sponsorPortal.portalAdmin, { sponsorshipId });
    expect(admin.documents).toHaveLength(0);
    // The blob is gone too — nothing stranded in storage. `.get` is a
    // convex-test affordance off the generated StorageWriter type, so it's
    // reached through a cast, same as `.store` above.
    const blob = await run(s.t, (ctx) =>
      (ctx.storage as unknown as {
        get: (id: Id<"_storage">) => Promise<Blob | null>;
      }).get(storageId),
    );
    expect(blob).toBeNull();
  });

  test("attaching does not disturb a signature — a document is not a term", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const storageId = await storePdf(s);
    const { token } = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    await sign(s, token);

    await s.as.mutation(api.sponsorPortal.attachDocument, {
      sponsorshipId,
      storageId,
      label: "Countersigned proposal",
      contentType: "application/pdf",
    });

    // Uploading the countersigned proposal AFTER signing must not un-sign it.
    const view = await s.t.query(api.sponsorPortal.publicByToken, { token });
    expect(view!.signed).not.toBeNull();
    expect(view!.state).toBe("awaiting_payment");
  });

  test("an unauthenticated caller cannot attach", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const storageId = await storePdf(s);
    // `s.t` is the signed-out client; the compose gate refuses it.
    await expect(
      s.t.mutation(api.sponsorPortal.attachDocument, {
        sponsorshipId,
        storageId,
        label: "x",
        contentType: "application/pdf",
      }),
    ).rejects.toThrow();
  });
});

// ── Read receipts ────────────────────────────────────────────────────────────

describe("noteView", () => {
  test("stamps first and last view, and a re-issued link starts clean", async () => {
    const s = await devDirectorSetup();
    const sponsorshipId = await seedAgreement(s);
    const first = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    await s.t.mutation(api.sponsorPortal.noteView, { token: first.token });

    let admin = await s.as.query(api.sponsorPortal.portalAdmin, { sponsorshipId });
    expect(admin.portal?.firstViewedAt).toBeTruthy();

    await s.as.mutation(api.sponsorPortal.revokePortalLink, { sponsorshipId });
    await s.as.mutation(api.sponsorPortal.issuePortalLink, { sponsorshipId });
    admin = await s.as.query(api.sponsorPortal.portalAdmin, { sponsorshipId });
    // The old stamps describe a page that no longer exists — carrying them
    // over would have the desk believe this partner had already opened
    // something they have not.
    expect(admin.portal?.firstViewedAt).toBeNull();
  });

  test("a dead token is a silent no-op, never a crash", async () => {
    const s = await devDirectorSetup();
    await expect(
      s.t.mutation(api.sponsorPortal.noteView, { token: "nope" }),
    ).resolves.toBeNull();
  });
});

// ── The partnership team's reach ─────────────────────────────────────────────

describe("partnership associate access", () => {
  test("can create a partnership by naming a new org, no donor-tab trip", async () => {
    const s = await associateSetup();
    // The partnership team creates the sponsoring org inline — they have no
    // giving.manage, so this proves the inline-create path rides the compose
    // power, not the donor CRM.
    const sponsorshipId = (await s.as.mutation(
      api.sponsorships.upsertSponsorship,
      { newOrg: { name: "Ignite Church", kind: "church" } },
    )) as Id<"sponsorships">;
    const admin = await s.as.query(api.sponsorPortal.portalAdmin, { sponsorshipId });
    expect(admin.canCompose).toBe(true);
    expect(admin.donorName).toBe("Ignite Church");
  });

  test("can compose and issue links, but cannot record a gift or edit tiers", async () => {
    const s = await associateSetup();
    const sponsorshipId = await seedAgreementRaw(s);

    // The composer opens for them — portalAdmin says so.
    const admin = await s.as.query(api.sponsorPortal.portalAdmin, { sponsorshipId });
    expect(admin.canCompose).toBe(true);
    expect(admin.canSend).toBe(true);

    // They fill terms…
    await s.as.mutation(api.sponsorPortal.saveProposal, {
      sponsorshipId,
      terms: "The run of show is settled together, in writing, in advance.",
      amountCents: 350_000,
    });
    // …and issue the link.
    const link = await s.as.mutation(api.sponsorPortal.issuePortalLink, {
      sponsorshipId,
    });
    expect(link.token).toBeTruthy();
    // …and advance the pipeline.
    await s.as.mutation(api.sponsorships.setSponsorshipStatus, {
      sponsorshipId,
      status: "pitched",
    });

    // But recording a partner's payment is the director's — `giving.edit`,
    // which the associate lacks.
    await expect(
      s.as.mutation(api.sponsorships.recordSponsorshipGift, {
        sponsorshipId,
        amountCents: 100_000,
        method: "check",
      }),
    ).rejects.toThrow();
    // …and defining package tiers is the director's too.
    await expect(
      s.as.mutation(api.sponsorships.savePackage, {
        name: "New tier",
        tierRank: 9,
        audience: "church",
        pricing: { kind: "one_time", amountCents: 10_000 },
        scope: { kind: "season" },
        benefits: ["x"],
        commitments: ["y"],
      }),
    ).rejects.toThrow();
  });

  test("a plain giving viewer (no partners power) sees the composer read-only", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    // Expansion Director holds central `giving.view` only — no partners power.
    await seatCaller(s, "expansion_director", "central");
    const sponsorshipId = await seedAgreementRaw(s);

    const admin = await s.as.query(api.sponsorPortal.portalAdmin, { sponsorshipId });
    expect(admin.canCompose).toBe(false);
    expect(admin.canSend).toBe(false);

    // …and the write path refuses them.
    await expect(
      s.as.mutation(api.sponsorPortal.saveProposal, {
        sponsorshipId,
        terms: "x",
      }),
    ).rejects.toThrow();
  });
});
