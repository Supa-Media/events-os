/**
 * The homepage's OS-managed content, fetched live.
 *
 * ── Why this is hydration and not a build-time read ─────────────────────────
 * Same constraint `lib/roles.ts` documents: the landing build has no Convex
 * URL, so there is nothing to read at build time. Content comes from a
 * same-origin `fetch('/api/site/home')` that pw-router proxies to Convex.
 *
 * ── Why the page still ships real words ─────────────────────────────────────
 * And here it differs from `/team`, deliberately. A job listing that arrives a
 * beat late leaves an empty list, which is fine. An empty `<h1>` above the fold
 * is not: it is a blank hero for anyone on a slow connection, nothing at all
 * for a crawler, and nothing at all with JS off.
 *
 * So the homepage server-renders its content from the SAME defaults the OS was
 * seeded with — `SITE_COPY_DEFS[...].defaultValue` for copy (imported, not
 * retyped, so there is one source), `impact.yaml` and `links.yaml` for the
 * cards — and this module patches over that markup once the live content
 * arrives. In the ordinary case the two agree and nothing visibly changes; when
 * the desk has edited something, the edit lands within a frame of the fetch.
 *
 * The YAML files are therefore FALLBACK, not source of truth. Editing them
 * changes what an unreachable-backend visitor sees and nothing else; the OS
 * wins the moment it answers. Their headers say so.
 */
import type {
  PublicSiteContent,
  PublicSiteEventCard,
  PublicSiteLink,
  SiteCopyKey,
} from "@events-os/shared/src/marketing";
import { asset } from "./asset";

export type { PublicSiteContent, PublicSiteEventCard, PublicSiteLink };

/** Where the homepage's content comes from. Same-origin; pw-router proxies
 *  `/api/*` to Convex. */
const CONTENT_ENDPOINT = "/api/site/home";

/**
 * Fetch the live content, or `null` if the backend is unreachable.
 *
 * Never throws and never rejects: every caller's correct behavior on failure is
 * "leave the server-rendered page alone", and making that a `null` rather than
 * an exception means no caller can forget to.
 */
export async function fetchSiteContent(): Promise<PublicSiteContent | null> {
  try {
    const res = await fetch(CONTENT_ENDPOINT, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as PublicSiteContent;
    // A malformed payload is treated exactly like an unreachable one. The
    // shapes below are the three the renderers index into.
    if (!body || typeof body !== "object") return null;
    if (!body.copy || !Array.isArray(body.links) || !Array.isArray(body.stats)) {
      return null;
    }
    if (!Array.isArray(body.events)) body.events = [];
    return body;
  } catch {
    return null;
  }
}

/**
 * Replace an element's text, but only when it actually differs.
 *
 * The "only when it differs" is the whole point: in the common case the OS
 * agrees with what was built into the page, and writing the same string back
 * would still invalidate layout and could visibly reflow a hero mid-animation.
 * Compares trimmed, because the server-rendered markup carries the indentation
 * of the template it came from.
 */
export function setText(el: Element | null, value: string | undefined): void {
  if (!el || value === undefined) return;
  if ((el.textContent ?? "").trim() === value.trim()) return;
  el.textContent = value;
}

/** Apply every copy slot the page marks with `data-copy-key`. One pass over the
 *  document, so a slot added to a template needs no change here. */
export function applyCopy(copy: Record<SiteCopyKey, string>): void {
  document.querySelectorAll<HTMLElement>("[data-copy-key]").forEach((el) => {
    const key = el.dataset.copyKey as SiteCopyKey | undefined;
    if (key && key in copy) setText(el, copy[key]);
  });
}

// ── Card rendering ───────────────────────────────────────────────────────────

/** `LinkCard.astro`'s outer classes, so a runtime card is indistinguishable
 *  from a built one. Kept as one string rather than sprinkled through the
 *  builder for the same reason the component keeps it on one element. */
const CARD_CLASS =
  "group relative block w-full min-h-[150px] cursor-pointer appearance-none " +
  "overflow-hidden rounded-2xl bg-pink-softer transition-transform hover:-translate-y-0.5";

/** A URL is external — and so gets `target="_blank"` — when it leaves this
 *  site. Mirrors `LinkCard.astro`'s own test. */
function isExternal(url: string): boolean {
  return /^https?:|^mailto:|^tel:/.test(url);
}

/**
 * Build one Important Links card from OS data — the runtime port of
 * `LinkCard.astro`.
 *
 * Assembled with `createElement` and `textContent` throughout, never
 * `innerHTML`. The values are written by a trusted seat, but a card's title is
 * still a string that reached this function over the network, and "trusted
 * source" is a reason to keep an escape hatch closed rather than a reason to
 * open one.
 */
export function buildLinkCard(link: PublicSiteLink): HTMLElement {
  const isCopy = Boolean(link.copy);
  const el = document.createElement(isCopy ? "button" : "a");
  el.className = CARD_CLASS;
  el.setAttribute("aria-label", link.title);

  if (isCopy) {
    (el as HTMLButtonElement).type = "button";
    el.setAttribute("data-copy", link.copy as string);
  } else if (link.url) {
    (el as HTMLAnchorElement).href = link.url.startsWith("/")
      ? asset(link.url)
      : link.url;
    if (isExternal(link.url)) {
      (el as HTMLAnchorElement).target = "_blank";
      (el as HTMLAnchorElement).rel = "noopener noreferrer";
    }
  }

  if (link.bgImage) {
    // Poster card: full-bleed cover, no text overlay — the component's bgImage
    // branch renders nothing else, and neither does this.
    const img = document.createElement("img");
    img.src = link.bgImage.startsWith("/") ? asset(link.bgImage) : link.bgImage;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.className = "absolute inset-0 h-full w-full object-cover";
    el.appendChild(img);
    return el;
  }

  const layoutClass =
    link.align === "topLeft"
      ? "items-start text-left p-8 sm:p-10"
      : "items-center justify-center text-center p-8 sm:p-12";
  const inner = document.createElement("div");
  inner.className = `relative z-[1] flex h-full flex-col gap-1 ${layoutClass}`;

  if (link.thumbnail) {
    const img = document.createElement("img");
    img.src = link.thumbnail.startsWith("/")
      ? asset(link.thumbnail)
      : link.thumbnail;
    img.alt = link.title;
    img.loading = "lazy";
    img.className = "max-h-10 sm:max-h-12 w-auto object-contain";
    inner.appendChild(img);
  } else {
    const h3 = document.createElement("h3");
    h3.className = "font-display text-xl sm:text-2xl text-link-blue";
    h3.textContent = link.title;
    inner.appendChild(h3);
  }
  if (link.subtitle) {
    const p = document.createElement("p");
    p.className = "text-sm sm:text-base text-link-blue";
    p.textContent = link.subtitle;
    inner.appendChild(p);
  }
  if (link.cta) {
    const p = document.createElement("p");
    p.className = "text-sm text-link-blue";
    p.setAttribute("data-cta", "");
    p.textContent = link.cta;
    inner.appendChild(p);
  }
  el.appendChild(inner);
  return el;
}

/** A live event card. Unchanged from what `ImportantLinks.astro` built inline
 *  before the OS started choosing which events appear — only the SELECTION
 *  moved. */
export function buildEventCard(ev: PublicSiteEventCard): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = asset(ev.href);
  a.className = CARD_CLASS;
  a.setAttribute("aria-label", ev.title);

  if (ev.coverUrl) {
    const img = document.createElement("img");
    img.src = asset(ev.coverUrl);
    img.alt = ev.title;
    img.loading = "lazy";
    img.decoding = "async";
    img.className = "absolute inset-0 h-full w-full object-cover";
    // Honor the host's chosen crop focal point so this card frames the cover
    // the same way the event's own page does.
    img.style.objectPosition = `${ev.coverFocalX}% ${ev.coverFocalY}%`;
    a.appendChild(img);
    return a;
  }

  const inner = document.createElement("div");
  inner.className =
    "relative z-[1] flex h-full flex-col items-center justify-center gap-1 " +
    "text-center p-8 sm:p-12";
  const h3 = document.createElement("h3");
  h3.className = "font-display text-xl sm:text-2xl text-link-blue";
  h3.textContent = ev.title;
  inner.appendChild(h3);
  const when = formatEventDate(ev.startDate);
  if (when) {
    const p = document.createElement("p");
    p.className = "text-sm sm:text-base text-link-blue";
    p.textContent = when;
    inner.appendChild(p);
  }
  a.appendChild(inner);
  return a;
}

/** "Sat, Aug 30" in the visitor's own locale. Empty string on anything
 *  unformattable, so a bad timestamp costs a line rather than the card. */
export function formatEventDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/** One impact card — the runtime port of `StatCard.astro`. */
export function buildStatCard(stat: {
  value: string;
  label: string;
  sublabel: string | null;
}): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className =
    "flex flex-col items-center text-center sm:items-start sm:text-left";

  const value = document.createElement("span");
  value.className =
    "font-display text-4xl sm:text-[44px] font-normal leading-[1.08] text-red-500";
  value.textContent = stat.value;
  wrap.appendChild(value);

  const label = document.createElement("span");
  label.className = "mt-2 font-body text-base font-normal text-ink";
  label.textContent = stat.label;
  wrap.appendChild(label);

  if (stat.sublabel) {
    const sub = document.createElement("span");
    sub.className = "mt-1 text-sm text-ink/65";
    sub.textContent = stat.sublabel;
    wrap.appendChild(sub);
  }
  return wrap;
}

/**
 * Wrap a runtime-built card in the scroll-animation shell the built ones have.
 *
 * These mount after `scroll-animate.ts`'s IntersectionObserver has already
 * taken its census, so it never sees them — the flag is set here instead, next
 * frame so the fade-up transition still plays. `prefers-reduced-motion` skips
 * straight to visible rather than animating.
 */
export function animateIn(child: HTMLElement, delayIndex: number): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-animate", "fade-up");
  wrapper.style.setProperty("--delay", `${delayIndex * 60}ms`);
  wrapper.appendChild(child);

  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    wrapper.setAttribute("data-animate-in", "true");
  } else {
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        wrapper.setAttribute("data-animate-in", "true"),
      ),
    );
  }
  return wrapper;
}
