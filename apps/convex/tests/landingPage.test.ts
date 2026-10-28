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
    expect(html).toContain(`<meta property="og:url" content="${SITE}/rsvp/summer-night">`);
    expect(html).toContain(`content="${SITE}/rsvp/summer-night/cover"`);
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

describe("renderLandingPage title font + links", () => {
  test("defaults the title to Corben when no font is set", () => {
    const html = renderLandingPage(samplePage() as never, SITE);
    expect(html).toContain(
      `<h1 class="title" style="font-family:'Corben',Georgia,serif;font-weight:700;`,
    );
  });

  test("applies the chosen title font", () => {
    const html = renderLandingPage(
      samplePage({ titleFont: "helvetica" }) as never,
      SITE,
    );
    expect(html).toContain("font-family:'Helvetica Neue',Helvetica,Arial,sans-serif");
    const sans = renderLandingPage(samplePage({ titleFont: "sans" }) as never, SITE);
    expect(sans).toContain("font-weight:800");
  });

  test("an unknown font id falls back to the default", () => {
    const html = renderLandingPage(
      samplePage({ titleFont: "comic-sans" }) as never,
      SITE,
    );
    expect(html).toContain("font-family:'Corben',Georgia,serif;font-weight:700");
  });

  test("renders link cards that open in a new tab", () => {
    const html = renderLandingPage(
      samplePage({
        links: [{ label: "Talent questionnaire", url: "https://forms.gle/abc" }],
      }) as never,
      SITE,
    );
    expect(html).toContain('href="https://forms.gle/abc" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("Talent questionnaire");
    expect(html).toContain('<div class="s">forms.gle</div>');
  });

  test("drops non-http links and escapes labels", () => {
    const html = renderLandingPage(
      samplePage({
        links: [
          { label: "bad", url: "javascript:alert(1)" },
          { label: "<b>x</b>", url: "https://example.org/a?b=1&c=2" },
        ],
      }) as never,
      SITE,
    );
    // (The raw value may still appear in the inline __INIT__ JSON, which is
    // data, never markup.)
    expect(html).not.toContain('href="javascript:');
    expect(html.match(/class="metacard linkcard"/g)).toHaveLength(1);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain('href="https://example.org/a?b=1&amp;c=2"');
  });

  test("turns web addresses in the description into links", () => {
    const html = renderLandingPage(
      samplePage({
        description:
          "Sign up at https://forms.gle/abc. Or see www.example.org/info, <b>bold</b>",
      }) as never,
      SITE,
    );
    expect(html).toContain(
      '<div class="about">Sign up at <a href="https://forms.gle/abc" target="_blank" rel="noopener noreferrer">https://forms.gle/abc</a>. Or see <a href="https://www.example.org/info" target="_blank" rel="noopener noreferrer">www.example.org/info</a>, &lt;b&gt;bold&lt;/b&gt;</div>',
    );
  });

  test("description links can't break out of the href", () => {
    const html = renderLandingPage(
      samplePage({ description: "x https://a.co/?q=\"onmouseover=alert(1) javascript:alert(2)" }) as never,
      SITE,
    );
    expect(html).toContain('<a href="https://a.co/?q=" target="_blank"');
    expect(html).not.toContain('href="javascript:');
  });

  test("no links section when there are none", () => {
    const html = renderLandingPage(samplePage() as never, SITE);
    expect(html).not.toContain('class="links"');
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
