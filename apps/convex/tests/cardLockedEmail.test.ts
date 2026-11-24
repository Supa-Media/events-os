import { describe, expect, test } from "vitest";
import { buildCardLockedEmail } from "../lib/cardLockedEmail";

describe("buildCardLockedEmail", () => {
  test("manager lock names who locked it and who can unlock it", () => {
    const { subject, html } = buildCardLockedEmail({
      reason: "manager",
      cardholderName: "Ada",
      last4: "4242",
      lockedByName: "Manny",
      link: "https://app.example/finances/cards",
    });
    expect(subject).toBe("Your Public Worship card has been locked");
    expect(html).toContain("Manny locked your Public Worship card ending in 4242");
    expect(html).toContain("Only a finance manager can unlock it");
    expect(html).toContain("https://app.example/finances/cards");
  });

  test("manager lock without a known locker falls back to 'A finance manager'", () => {
    const { html } = buildCardLockedEmail({
      reason: "manager",
      cardholderName: "Ada",
      last4: null,
      lockedByName: null,
      link: null,
    });
    expect(html).toContain("A finance manager locked your Public Worship card.");
    expect(html).toContain("talk to your finance manager");
  });

  test("receipt lock says the receipt unlocks it and links to coding", () => {
    const { subject, html } = buildCardLockedEmail({
      reason: "receipt",
      cardholderName: "Ada",
      last4: "4242",
      lockedByName: null,
      link: "https://app.example/code?filter=uncoded",
    });
    expect(subject).toBe("Your card is locked until you add a receipt");
    expect(html).toContain("7 days without a receipt");
    expect(html).toContain("unlocks on its own");
    expect(html).toContain("https://app.example/code?filter=uncoded");
  });

  test("escapes the cardholder's name", () => {
    const { html } = buildCardLockedEmail({
      reason: "receipt",
      cardholderName: "<b>Ada</b>",
      last4: null,
      lockedByName: null,
      link: null,
    });
    expect(html).not.toContain("<b>Ada</b>");
    expect(html).toContain("Open the app to add the receipt.");
  });
});
