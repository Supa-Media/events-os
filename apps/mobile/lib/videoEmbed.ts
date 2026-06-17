/**
 * Video embed helpers — turn a shared video URL (YouTube, Vimeo, Loom) into an
 * embeddable player URL so the public briefing can inline it instead of just
 * linking out. Returns null for anything we can't confidently embed, so callers
 * fall back to a plain "Watch video" link.
 *
 * Pure string math — no React, no platform APIs — so it's easy to unit-test.
 */

/** True when `host` is exactly `base` or a subdomain of it (not a lookalike). */
function hostIs(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

/** Pull the YouTube video id from the common watch / short / embed URL shapes. */
function youTubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, "");
  if (host === "youtu.be") return u.pathname.slice(1) || null;
  if (hostIs(host, "youtube.com")) {
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(embed|shorts)\/([^/?]+)/);
    if (m) return m[2] ?? null;
  }
  return null;
}

/**
 * Resolve a video URL to an embeddable player URL, or null when we don't have a
 * known embed shape. Supports YouTube, Vimeo, and Loom — the providers the
 * How-To picker is most likely to receive.
 */
export function videoEmbedUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");

  const yt = youTubeId(u);
  if (yt) return `https://www.youtube.com/embed/${yt}`;

  if (hostIs(host, "vimeo.com")) {
    const id = u.pathname.split("/").filter(Boolean)[0];
    if (id && /^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
  }

  if (hostIs(host, "loom.com")) {
    const m = u.pathname.match(/\/(share|embed)\/([^/?]+)/);
    if (m) return `https://www.loom.com/embed/${m[2]}`;
  }

  return null;
}
