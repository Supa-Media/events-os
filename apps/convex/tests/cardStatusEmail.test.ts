import { describe, expect, test } from "vitest";
import {
  buildCardStatusEmail,
  linkPathFor,
  statusAfter,
  type CardStatusEmailInput,
} from "../lib/cardStatusEmail";

const base: Omit<CardStatusEmailInput, "event"> = {
  cardholderName: "Ada",
  last4: "4242",
  link: "https://app.example/x",
};

describe("buildCardStatusEmail", () => {
  test("manager lock says 'your local treasurer', never a name", () => {
    const { subject, html } = buildCardStatusEmail({ ...base, event: "locked_manager" });
    expect(subject).toBe("Your Public Worship card has been locked");
    expect(html).toContain(
      "Hi Ada, your local treasurer locked your Public Worship card ending in 4242.",
    );
    expect(html).toContain("talk to your local treasurer.");
    expect(html).toContain("https://app.example/x");
    const noLast4 = buildCardStatusEmail({ ...base, event: "locked_manager", last4: null });
    expect(noLast4.html).toContain("your local treasurer locked your Public Worship card.");
  });

  test("receipt lock says the receipt unlocks it", () => {
    const { subject, html } = buildCardStatusEmail({ ...base, event: "locked_receipt" });
    expect(subject).toBe("Your card is locked until you add a receipt");
    expect(html).toContain("7 days without a receipt");
    expect(html).toContain("unlocks on its own");
  });

  test("unlock emails say the card works again", () => {
    expect(buildCardStatusEmail({ ...base, event: "unlocked_manager" }).html).toContain(
      "your local treasurer unlocked your Public Worship card ending in 4242. You can use it again.",
    );
    expect(buildCardStatusEmail({ ...base, event: "unlocked_receipt" }).html).toContain(
      "Your Public Worship card ending in 4242 is unlocked",
    );
  });

  test("cancel says it's permanent", () => {
    const { subject, html } = buildCardStatusEmail({ ...base, event: "canceled" });
    expect(subject).toBe("Your Public Worship card has been canceled");
    expect(html).toContain("your local treasurer canceled your Public Worship card ending in 4242");
    expect(html).toContain("It can't be used again");
  });

  test("escapes the cardholder's name and degrades without a link", () => {
    const { html } = buildCardStatusEmail({
      ...base,
      event: "locked_receipt",
      cardholderName: "<b>Ada</b>",
      link: null,
    });
    expect(html).not.toContain("<b>Ada</b>");
    expect(html).toContain("Open the app to add the receipt.");
  });

  test("status + link per event", () => {
    expect(statusAfter("locked_receipt")).toBe("locked");
    expect(statusAfter("unlocked_manager")).toBe("active");
    expect(statusAfter("canceled")).toBe("canceled");
    expect(linkPathFor("locked_receipt")).toBe("/code?filter=uncoded");
    expect(linkPathFor("canceled")).toBe("/finances/cards");
  });
});
