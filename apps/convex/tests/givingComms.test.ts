import { afterEach, describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import { donorFacingAchFailureReason } from "../givingComms";
import type { Id } from "../_generated/dataModel";

/**
 * Donor-facing ACH comms (`givingComms.ts`).
 *
 * The three entry points are a fixed seam with the ACH lifecycle work, so the
 * behaviours worth pinning are: they no-op rather than throw whenever a
 * precondition is missing (a webhook must not fail because an email couldn't
 * be composed), they only mention the public giving wall to a donor who
 * actually opted into it, they never leak a raw bank reason code, and a
 * failure takes any wall entry down with it.
 */

const STRIPE_SESSION = "cs_test_ach_1";

function okResendResponse(): unknown {
  return { ok: true, status: 200, text: async () => "{}" };
}

/** A Stripe Checkout Session as `GET /v1/checkout/sessions/<id>` returns it —
 *  only the fields `loadGiveSessionContext` reads. */
function stripeSession(metadata: Record<string, string>, amountCents = 5000) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: STRIPE_SESSION,
      amount_total: amountCents,
      customer_email: "sam@example.com",
      metadata,
    }),
    text: async () => "{}",
  };
}

/**
 * Route `fetch` by host: Stripe reads return `session`, Resend sends are
 * captured. Returns the captured Resend bodies so a test can assert on the
 * subject and the rendered HTML.
 */
function installFetch(session: unknown | null): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (
    url: string,
    init?: { body?: string },
  ): Promise<unknown> => {
    if (String(url).includes("api.stripe.com")) {
      return session ?? { ok: false, status: 404, text: async () => "missing" };
    }
    if (String(url).includes("api.resend.com")) {
      sent.push(init?.body ? JSON.parse(init.body) : {});
      return okResendResponse();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return sent;
}

async function makeDonor(
  t: ReturnType<typeof newT>,
  scope: Id<"chapters">,
): Promise<Id<"donors">> {
  return run(t, (ctx) =>
    ctx.db.insert("donors", {
      scope,
      kind: "individual",
      name: "Sam Kowalski",
      email: "sam@example.com",
      status: "prospect",
      lifetimeCents: 0,
      giftCount: 0,
      createdAt: Date.now(),
    }),
  );
}

describe("donorFacingAchFailureReason", () => {
  test("maps the codes we know to plain sentences", () => {
    expect(donorFacingAchFailureReason("insufficient_funds")).toBe(
      "There wasn't enough in the account when the transfer ran.",
    );
    expect(donorFacingAchFailureReason("account_closed")).toBe(
      "The account the transfer came from is closed.",
    );
    expect(donorFacingAchFailureReason("debit_not_authorized")).toBe(
      "The bank didn't have authorization for this debit.",
    );
  });

  test("never leaks a raw ACH return code", () => {
    for (const raw of ["R01", "R07", "R29", "something_new_from_stripe"]) {
      const out = donorFacingAchFailureReason(raw);
      expect(out).toBe("The bank couldn't complete the transfer.");
      expect(out).not.toContain(raw);
    }
  });

  test("handles a missing reason", () => {
    expect(donorFacingAchFailureReason(undefined)).toBe(
      "The bank couldn't complete the transfer.",
    );
    expect(donorFacingAchFailureReason("")).toBe(
      "The bank couldn't complete the transfer.",
    );
  });
});

describe("givingComms ACH emails", () => {
  const realFetch = globalThis.fetch;
  const realStripe = process.env.STRIPE_SECRET_KEY;
  const realResend = process.env.RESEND_API_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = realStripe;
    if (realResend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = realResend;
  });

  async function arrange(showOnWall: boolean) {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.RESEND_API_KEY = "re_test_x";
    const t = newT();
    const s = await setupChapter(t);
    const donorId = await makeDonor(t, s.chapterId);
    const sent = installFetch(
      stripeSession({
        giveDonation: "1",
        giveDonorId: String(donorId),
        giveScope: String(s.chapterId),
        giveShowOnWall: showOnWall ? "1" : "0",
      }),
    );
    return { t, s, sent };
  }

  test("onAchSubmitted sets the 2–4 business day expectation", async () => {
    const { t, sent } = await arrange(false);
    await t.action(internal.givingComms.onAchSubmitted, {
      sessionId: STRIPE_SESSION,
    });
    expect(sent).toHaveLength(1);
    expect(String(sent[0].subject)).toContain("is on its way");
    expect(String(sent[0].to)).toContain("sam@example.com");
    expect(String(sent[0].html)).toContain("2–4 business days");
    expect(String(sent[0].html)).toContain("$50");
  });

  test("onAchSubmitted mentions the wall only when the donor opted in", async () => {
    const optedOut = await arrange(false);
    await optedOut.t.action(internal.givingComms.onAchSubmitted, {
      sessionId: STRIPE_SESSION,
    });
    expect(String(optedOut.sent[0].html)).not.toContain("giving wall");

    const optedIn = await arrange(true);
    await optedIn.t.action(internal.givingComms.onAchSubmitted, {
      sessionId: STRIPE_SESSION,
    });
    const html = String(optedIn.sent[0].html);
    expect(html).toContain("public giving wall");
    expect(html).toContain("won't appear there until the transfer clears");
  });

  test("onAchSettled says it cleared", async () => {
    const { t, sent } = await arrange(false);
    await t.action(internal.givingComms.onAchSettled, {
      sessionId: STRIPE_SESSION,
    });
    expect(String(sent[0].subject)).toContain("cleared");
    expect(String(sent[0].html)).toContain("nothing else to do");
  });

  test("onAchFailed explains it kindly, links a retry, and leaks no code", async () => {
    const { t, sent } = await arrange(false);
    await t.action(internal.givingComms.onAchFailed, {
      sessionId: STRIPE_SESSION,
      reason: "R01",
    });
    const html = String(sent[0].html);
    expect(String(sent[0].subject)).toContain("didn't go through");
    // Matched without the apostrophe: the reason goes through `escapeHtml`,
    // so "couldn't" is `couldn&#39;t` in the source and renders correctly.
    expect(html).toContain("complete the transfer.");
    expect(html).not.toContain("R01");
    expect(html).toContain("Try again");
    expect(html).toContain("/give");
    expect(html).toContain("You haven't been charged");
  });

  test("onAchFailed takes the wall entry down", async () => {
    const { t, s, sent } = await arrange(true);
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: `give:${STRIPE_SESSION}`,
      consent: true,
      scope: s.chapterId,
      kind: "gift",
      amountCents: 5000,
      displayName: "Sam K.",
    });
    await t.mutation(internal.givingActivity.markActivityVisible, {
      refKey: `give:${STRIPE_SESSION}`,
      amountCents: 5000,
    });

    await t.action(internal.givingComms.onAchFailed, {
      sessionId: STRIPE_SESSION,
      reason: "insufficient_funds",
    });

    const row = await run(t, (ctx) =>
      ctx.db
        .query("givingActivity")
        .withIndex("by_refKey", (q) => q.eq("refKey", `give:${STRIPE_SESSION}`))
        .unique(),
    );
    expect(row?.status).toBe("hidden");
    expect(String(sent[0].html)).toContain(
      "taken your entry off the public giving wall",
    );
  });

  /**
   * The webhook that fires on a bank refusal (`async_payment_failed`) carries
   * the Session, and a Session doesn't say why. Without the expansion below,
   * every real ACH failure email fell through to the generic sentence and the
   * whole reason table above was unreachable in production.
   */
  test("onAchFailed asks Stripe WHY when the caller didn't say", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.RESEND_API_KEY = "re_test_x";
    const t = newT();
    const s = await setupChapter(t);
    const donorId = await makeDonor(t, s.chapterId);
    const metadata = {
      giveDonation: "1",
      giveDonorId: String(donorId),
      giveScope: String(s.chapterId),
    };
    const sent: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (
      url: string,
      init?: { body?: string },
    ): Promise<unknown> => {
      if (String(url).includes("api.resend.com")) {
        sent.push(init?.body ? JSON.parse(init.body) : {});
        return okResendResponse();
      }
      // Only the expanded read carries the PaymentIntent; the plain read is
      // the one `loadGiveSessionContext` makes.
      const expanded = String(url).includes("expand");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: STRIPE_SESSION,
          amount_total: 5000,
          customer_email: "sam@example.com",
          metadata,
          ...(expanded
            ? {
                payment_intent: {
                  last_payment_error: { code: "insufficient_funds" },
                },
              }
            : {}),
        }),
        text: async () => "{}",
      };
    }) as unknown as typeof fetch;

    await t.action(internal.givingComms.onAchFailed, {
      sessionId: STRIPE_SESSION,
    });

    const html = String(sent[0].html);
    expect(html).toContain("enough in the account");
    expect(html).not.toContain("insufficient_funds");
  });

  test("onAchFailed still sends the generic sentence when Stripe won't say", async () => {
    // `installFetch`'s session carries no `payment_intent` at all — the
    // lookup must degrade to the generic line, never to no email.
    const { t, sent } = await arrange(false);
    await t.action(internal.givingComms.onAchFailed, {
      sessionId: STRIPE_SESSION,
    });
    expect(String(sent[0].html)).toContain("complete the transfer.");
  });

  test("all three no-op quietly when the session can't be read", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.RESEND_API_KEY = "re_test_x";
    const t = newT();
    await setupChapter(t);
    const sent = installFetch(null); // Stripe 404s

    for (const fn of [
      internal.givingComms.onAchSubmitted,
      internal.givingComms.onAchSettled,
      internal.givingComms.onAchFailed,
    ]) {
      await expect(
        t.action(fn, { sessionId: "cs_gone" }),
      ).resolves.not.toThrow();
    }
    expect(sent).toHaveLength(0);
  });

  test("no-ops on a session that isn't one of our give donations", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.RESEND_API_KEY = "re_test_x";
    const t = newT();
    await setupChapter(t);
    const sent = installFetch(stripeSession({ ticketOrder: "1" }));
    await t.action(internal.givingComms.onAchSubmitted, {
      sessionId: STRIPE_SESSION,
    });
    expect(sent).toHaveLength(0);
  });

  test("no-ops when Stripe isn't configured at all", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.RESEND_API_KEY = "re_test_x";
    const t = newT();
    await setupChapter(t);
    const sent = installFetch(stripeSession({ giveDonation: "1" }));
    await expect(
      t.action(internal.givingComms.onAchSubmitted, {
        sessionId: STRIPE_SESSION,
      }),
    ).resolves.not.toThrow();
    expect(sent).toHaveLength(0);
  });
});
