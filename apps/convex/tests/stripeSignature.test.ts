import { describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { verifyStripeSignature } from "../stripe";

/**
 * Stripe webhook signature verification — the security gate on /stripe/webhook.
 * A forged or stale signature must never fulfill an order, so these are the
 * highest-value regression tests in the payment path.
 */

const SECRET = "whsec_testsecret";

/** Produce a valid `Stripe-Signature` header for a payload at time `t` (seconds). */
function signedHeader(payload: string, secret: string, tSeconds: number): string {
  const v1 = createHmac("sha256", secret)
    .update(`${tSeconds}.${payload}`)
    .digest("hex");
  return `t=${tSeconds},v1=${v1}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("verifyStripeSignature", () => {
  test("accepts a correctly signed, recent payload", async () => {
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    const header = signedHeader(payload, SECRET, nowSeconds());
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(true);
  });

  test("rejects a payload tampered after signing", async () => {
    const original = JSON.stringify({ id: "cs_real" });
    const header = signedHeader(original, SECRET, nowSeconds());
    const forged = JSON.stringify({ id: "cs_attacker" });
    expect(await verifyStripeSignature(forged, header, SECRET)).toBe(false);
  });

  test("rejects a signature made with the wrong secret", async () => {
    const payload = JSON.stringify({ id: "cs_real" });
    const header = signedHeader(payload, "whsec_wrong", nowSeconds());
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(false);
  });

  test("rejects a stale timestamp beyond the 5-minute tolerance", async () => {
    const payload = JSON.stringify({ id: "cs_real" });
    const header = signedHeader(payload, SECRET, nowSeconds() - 600);
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(false);
  });

  test("rejects a missing signature header", async () => {
    expect(await verifyStripeSignature("{}", null, SECRET)).toBe(false);
  });

  test("rejects a malformed header with no v1 scheme", async () => {
    expect(
      await verifyStripeSignature("{}", `t=${nowSeconds()}`, SECRET),
    ).toBe(false);
  });
});
