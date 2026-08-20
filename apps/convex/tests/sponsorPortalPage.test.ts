import { describe, expect, test } from "vitest";
import {
  renderSponsorPortal,
  renderSponsorPortalNotFound,
  type SponsorPortalView,
} from "../lib/sponsorPortalPage";

/**
 * The portal's HTML, rendered.
 *
 * A server-rendered page has no type checker for its own output: a mismatched
 * tag, an unescaped value, or a section that silently renders empty all
 * typecheck fine and all reach a partner. These render the real function
 * against real view shapes and assert the three things that would actually
 * cost something — that partner-supplied and staff-supplied text is escaped,
 * that the pay panel cannot appear before a signature, and that the page says
 * out loud what the bank rail costs.
 */

const BASE: SponsorPortalView = {
  orgName: "Ignite",
  title: "Production Partner — Love Thy Neighbor",
  summary: "## What this is\n- A full production credit\n\nNothing is binding until we agree.",
  benefits: ["Named production credit"],
  commitments: ["A hosted gathering on your anniversary weekend"],
  terms: "The run of show is settled together, in writing, in advance.",
  termsVersion: 1,
  events: [{ name: "Love Thy Neighbor", eventDate: Date.UTC(2026, 8, 26, 12) }],
  contactName: "Tolu Adeyemi",
  documents: [],
  amountCents: 350_000,
  inKindCredits: [{ label: "Full production suite", amountCents: 250_000 }],
  balance: {
    committedCents: 350_000,
    inKindCents: 250_000,
    paidCents: 0,
    coveredCents: 250_000,
    balanceCents: 100_000,
    percentCovered: 71,
    settled: false,
  },
  pendingCents: 0,
  state: "awaiting_signature",
  rails: [{ rail: "ach", feeCents: 500, chargeCents: 100_500 }],
  signed: null,
  payments: [],
};

describe("renderSponsorPortal", () => {
  test("renders the proposal, the money, and a well-formed document", () => {
    const html = renderSponsorPortal(BASE, "tok_123");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain("Production Partner — Love Thy Neighbor");
    expect(html).toContain("Prepared for Ignite");
    expect(html).toContain("$3,500");
    expect(html).toContain("$1,000.00"); // remaining
    expect(html).toContain("Full production suite");
    // The free-form body's grammar became real markup, not literal "##".
    expect(html).toContain("<h2>What this is</h2>");
    expect(html).toContain("<li>A full production credit</li>");
    expect(html).not.toContain("## What this is");
  });

  test("escapes everything a human typed", () => {
    const html = renderSponsorPortal(
      {
        ...BASE,
        orgName: '<img src=x onerror="alert(1)">',
        title: "Ampersand & <b>bold</b>",
        summary: "<script>alert(2)</script>",
        terms: "<script>alert(3)</script>",
        benefits: ["<script>alert(4)</script>"],
      },
      "tok_123",
    );
    expect(html).not.toContain("<script>alert");
    // The img payload survives as TEXT (`onerror=` is not an escapable
    // character), so the assertion that matters is that no TAG was produced —
    // an escaped attribute name inside element content is inert.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Ampersand &amp; &lt;b&gt;bold&lt;/b&gt;");
  });

  test("hides the pay panel until the current terms are signed", () => {
    const html = renderSponsorPortal(BASE, "tok_123");
    expect(html).toContain('id="sign"');
    expect(html).not.toContain('id="pay"');
  });

  test("shows the pay panel — and what the bank rail costs — once signed", () => {
    const html = renderSponsorPortal(
      { ...BASE, state: "awaiting_payment", signed: { name: "Tolu Adeyemi", title: "Executive Pastor", at: Date.now() } },
      "tok_123",
    );
    expect(html).toContain('id="pay"');
    expect(html).not.toContain('id="sign"');
    expect(html).toContain("Bank transfer (ACH)");
    expect(html).toContain("$5.00");
    // A single-rail agreement explains itself rather than offering a radio of one.
    expect(html).toContain("capped at $5.00");
    expect(html).not.toContain('value="card"');
  });

  test("says a bank debit is clearing rather than showing the same balance again", () => {
    const html = renderSponsorPortal(
      {
        ...BASE,
        state: "payment_clearing",
        pendingCents: 100_500,
        signed: { name: "Tolu Adeyemi", title: null, at: Date.now() },
      },
      "tok_123",
    );
    expect(html).toContain("$1,005.00 is on its way");
    expect(html).toContain("no need to send it again");
  });

  test("thanks a settled partner instead of asking for money", () => {
    const html = renderSponsorPortal(
      {
        ...BASE,
        state: "settled",
        signed: { name: "Tolu Adeyemi", title: null, at: Date.now() },
        balance: { ...BASE.balance, paidCents: 100_000, coveredCents: 350_000, balanceCents: 0, percentCovered: 100, settled: true },
        payments: [{ amountCents: 100_000, receivedAt: Date.now(), method: "stripe" }],
      },
      "tok_123",
    );
    expect(html).toContain("Fully covered");
    expect(html).not.toContain('id="pay"');
    expect(html).toContain("Payments received");
  });

  test("degrades to an invoice note when no rail is on offer", () => {
    const html = renderSponsorPortal(
      { ...BASE, state: "awaiting_payment", rails: [], signed: { name: "T A", title: null, at: Date.now() } },
      "tok_123",
    );
    expect(html).toContain("We'll invoice you directly");
    // The button, not the string: the client script carries "Continue to
    // payment" as a re-label regardless of which panels rendered.
    expect(html).not.toContain('id="py-btn"');
  });

  test("the token reaches the script JSON-encoded, never pasted raw", () => {
    const html = renderSponsorPortal(BASE, 'tok"); alert(1); //');
    expect(html).toContain('var TOKEN="tok\\"); alert(1); //"');
  });

  test("names every gathering the partnership covers, high up the page", () => {
    const html = renderSponsorPortal(
      {
        ...BASE,
        events: [
          { name: "Worship with Strangers", eventDate: Date.UTC(2026, 8, 18, 12) },
          { name: "Love Thy Neighbor", eventDate: Date.UTC(2026, 8, 26, 12) },
        ],
      },
      "tok_123",
    );
    expect(html).toContain("What this partnership covers");
    expect(html).toContain("2 gatherings");
    expect(html).toContain("Worship with Strangers");
    expect(html).toContain("Sep 18, 2026");
    expect(html).toContain("Love Thy Neighbor");
    expect(html).toContain("Sep 26, 2026");
    // ABOVE the proposal body: "which days am I standing behind?" is the
    // second question a partner asks after "how much?", not a footnote.
    expect(html.indexOf("What this partnership covers")).toBeLessThan(
      html.indexOf("What you receive"),
    );
  });

  test("says one gathering in the singular", () => {
    const html = renderSponsorPortal(BASE, "tok_123");
    expect(html).toContain("1 gathering,");
  });

  test("shows no coverage heading when a season agreement covers no single date", () => {
    const html = renderSponsorPortal({ ...BASE, events: [] }, "tok_123");
    expect(html).not.toContain("What this partnership covers");
  });

  test("renders shared documents as real download links to the token route", () => {
    const html = renderSponsorPortal(
      {
        ...BASE,
        documents: [
          {
            label: "Production proposal — full suite",
            fileName: "ignite-production.pdf",
            contentType: "application/pdf",
            sizeBytes: 220_400,
            href: "/partner/tok_123/doc/doc_abc",
          },
        ],
      },
      "tok_123",
    );
    expect(html).toContain("Documents");
    expect(html).toContain("Production proposal — full suite");
    expect(html).toContain('href="/partner/tok_123/doc/doc_abc"');
    expect(html).toContain("ignite-production.pdf");
    expect(html).toContain("215 KB");
    expect(html).toContain('rel="noopener"');
  });

  test("no Documents heading when nothing is shared", () => {
    const html = renderSponsorPortal(BASE, "tok_123");
    expect(html).not.toContain(">Documents<");
  });

  test("escapes a document label and filename", () => {
    const html = renderSponsorPortal(
      {
        ...BASE,
        documents: [
          {
            label: "<script>alert(1)</script>",
            fileName: "<img src=x>.pdf",
            contentType: "application/pdf",
            sizeBytes: null,
            href: "/partner/tok/doc/x",
          },
        ],
      },
      "tok",
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the not-found page says the same thing for a guess and a revocation", () => {
    const html = renderSponsorPortalNotFound();
    expect(html).toContain("Nothing here");
    expect(html).toContain("isn't active");
    expect(html).not.toContain("revoked");
  });
});
