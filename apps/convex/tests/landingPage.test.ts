import { describe, expect, test } from "vitest";
import {
  renderIcs,
  renderLandingPage,
  renderNotFound,
  renderTicketPage,
} from "../lib/landingPage";

/**
 * Public-page renderers. These produce the HTML/ICS served to unauthenticated
 * visitors, so they guard two things: link-preview correctness (OG tags) and
 * HTML-escaping of attacker-controllable strings (event name, tagline, guest
 * names) — a regression here is an XSS hole. Also pins the markup/styles/client
 * split so a future edit can't silently drop the stylesheet or client script.
 */

const SITE = "https://example.convex.site";

function samplePage(overrides: Record<string, unknown> = {}) {
  return {
    slug: "summer-night",
    eventName: "Summer Worship Night",
    startDate: Date.UTC(2026, 6, 27, 23, 5),
    endDate: null,
    tagline: "Golden hour on the pier",
    description: "Bring a friend.",
    hostName: "Public Worship",
    venueName: "Pier 17",
    address: null,
    addressLocked: true,
    hasCover: true,
    rsvpEnabled: true,
    ticketsEnabled: true,
    capacity: 150,
    counts: { going: 7, maybe: 3, ticketsSold: 12 },
    guests: [{ name: "Ada Lovelace", status: "going" }],
    ticketTypes: [
      {
        id: "tt1",
        name: "General",
        description: null,
        priceCents: 1500,
        currency: "usd",
        maxPerOrder: 4,
        onSale: true,
        lowRemaining: null,
      },
    ],
    viewer: null,
    activityLocked: true,
    activity: null,
    ...overrides,
  };
}

describe("renderLandingPage", () => {
  test("emits OG + Twitter tags with the cover image for link previews", () => {
    const html = renderLandingPage(samplePage() as never, SITE);
    expect(html).toContain('<meta property="og:title" content="Summer Worship Night">');
    expect(html).toContain(`<meta property="og:url" content="${SITE}/e/summer-night">`);
    expect(html).toContain(`content="${SITE}/e/summer-night/cover"`);
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  test("keeps the split-out stylesheet and client script inlined", () => {
    const html = renderLandingPage(samplePage() as never, SITE);
    expect(html).toContain("--accent:#D23B3A"); // from landingPageStyles
    expect(html).toContain("/api/tickets/rsvp"); // from landingPageClient
    expect(html).toContain("window.__INIT__=");
  });

  test("HTML-escapes attacker-controllable text (no XSS via event name)", () => {
    const html = renderLandingPage(
      samplePage({ eventName: '<script>alert(1)</script>' }) as never,
      SITE,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("falls back to a summary card when there is no cover", () => {
    const html = renderLandingPage(samplePage({ hasCover: false }) as never, SITE);
    expect(html).toContain('name="twitter:card" content="summary"');
    expect(html).not.toContain("/cover");
  });
});

describe("renderTicketPage & renderNotFound", () => {
  test("ticket page shows the code and embeds a QR script", () => {
    const html = renderTicketPage(
      {
        code: "PW-8FK2-QW9T",
        status: "valid",
        attendeeName: "Ada Lovelace",
        ticketTypeName: "General",
        eventName: "Summer Worship Night",
        startDate: Date.UTC(2026, 6, 27, 23, 5),
        venueName: "Pier 17",
        slug: "summer-night",
        hasCover: true,
      },
      SITE,
    );
    expect(html).toContain("PW-8FK2-QW9T");
    expect(html).toContain("qrcode");
    expect(html).toContain('name="robots" content="noindex"');
  });

  test("not-found page renders without throwing", () => {
    expect(renderNotFound()).toContain("Nothing here yet");
  });
});

describe("renderIcs", () => {
  test("produces a valid VEVENT with escaped fields", () => {
    const ics = renderIcs({
      slug: "summer-night",
      eventName: "Summer; Night, 2026",
      startDate: Date.UTC(2026, 6, 27, 23, 5),
      endDate: null,
      venueName: "Pier 17",
      address: "89 South St",
      description: null,
      siteUrl: SITE,
    });
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("SUMMARY:Summer\\; Night\\, 2026");
    expect(ics).toContain("DTSTART:20260727T230500Z");
  });
});
