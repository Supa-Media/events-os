import { ConvexError } from "convex/values";
import {
  RSVP_PAGE_LINKS_MAX,
  RSVP_PAGE_LINK_LABEL_MAX,
  normalizeRsvpPageLinkUrl,
  rsvpPageLinkHost,
  type RsvpPageLink,
} from "@events-os/shared";

/**
 * Validate the organizer's link list for an RSVP page before it is stored.
 * Rows with neither a label nor a URL are dropped (an empty editor row); a URL
 * that isn't http(s) is rejected rather than silently dropped, so a typo
 * surfaces. A missing label falls back to the link's host.
 */
export function cleanPageLinks(links: RsvpPageLink[]): RsvpPageLink[] {
  const out: RsvpPageLink[] = [];
  for (const link of links) {
    const label = link.label.trim();
    const rawUrl = link.url.trim();
    if (!label && !rawUrl) continue;
    const url = normalizeRsvpPageLinkUrl(rawUrl);
    if (!url) {
      throw new ConvexError({
        code: "INVALID_LINK",
        message: `"${rawUrl || label}" isn't a web link. Use a full address like https://forms.gle/…`,
      });
    }
    if (label.length > RSVP_PAGE_LINK_LABEL_MAX) {
      throw new ConvexError({
        code: "INVALID_LINK",
        message: `Link labels can be at most ${RSVP_PAGE_LINK_LABEL_MAX} characters.`,
      });
    }
    out.push({ label: label || rsvpPageLinkHost(url), url });
  }
  if (out.length > RSVP_PAGE_LINKS_MAX) {
    throw new ConvexError({
      code: "INVALID_LINK",
      message: `A page can show at most ${RSVP_PAGE_LINKS_MAX} links.`,
    });
  }
  return out;
}
