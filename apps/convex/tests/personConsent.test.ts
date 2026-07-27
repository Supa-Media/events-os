/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";

/**
 * Consent-vs-suppression compliance invariant (person-form-fields widening,
 * founder ask 2026-07-27): `people.consentedAt`/`consentSource` record an
 * AFFIRMATIVE "yes" — distinct from, and layered OVER, the address-level
 * opt-out ledgers (`emailSuppressions`/`smsOptOuts`/`marketingOptOut`).
 *
 * The one rule that must never break: recording consent must NEVER make a
 * suppressed address sendable again. `consentedAt` is not consulted anywhere
 * in send-eligibility logic (`lib/audienceResolve.ts`,
 * `lib/personEmails.ts#resolveSendAddress`) — this test asserts that
 * end-to-end through the same `previewAudience` path a real campaign send
 * uses, superuser-gated exactly like `tests/campaigns.test.ts`'s "people"
 * source suite.
 */
const SUPERUSER_EMAIL = "seyi@publicworship.life";

describe("consent never beats suppression", () => {
  test("a person with consentedAt set is still excluded when their email is suppressed", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });

    await run(s.t, async (ctx) => {
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Consented But Suppressed",
        email: "consented-suppressed@example.com",
        status: "active",
        // The affirmative "yes" — must NOT override the suppression below.
        consentedAt: Date.now(),
        consentSource: "Contact Information form import, 2026-07",
        createdAt: Date.now(),
      });
      await ctx.db.insert("emailSuppressions", {
        email: "consented-suppressed@example.com",
        reason: "unsubscribe",
        createdAt: Date.now(),
      });
      // A control row: consent recorded, NO suppression — must resolve fine,
      // proving the exclusion above is specifically about suppression, not
      // some accidental blanket effect of the new field's presence.
      await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Consented And Reachable",
        email: "consented-reachable@example.com",
        status: "active",
        consentedAt: Date.now(),
        consentSource: "Contact Information form import, 2026-07",
        createdAt: Date.now(),
      });
    });

    const preview = await s.as.query(api.audiences.previewAudience, {
      scope: "central",
      source: "people",
      filters: { chapterId: s.chapterId },
    });

    expect(preview.sample.map((r) => r.email)).toEqual([
      "consented-reachable@example.com",
    ]);
    expect(preview.count).toBe(1);
    expect(preview.excludedSuppressed).toBe(1);
  });
});
