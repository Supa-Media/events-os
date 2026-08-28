/**
 * The homepage's live-content controller.
 *
 * ONE fetch, three sections: the hero and section headings (`data-copy-key`
 * slots), the impact numbers, and the Important Links grid. They were three
 * separate concerns until the Marketing desk made them one document
 * (`GET /api/site/home`), and fetching it three times would have been three
 * chances to paint half an update.
 *
 * Read `lib/siteContent.ts` first — it explains why this is a patch over
 * server-rendered markup rather than a fill of empty shells, which is the
 * decision everything here follows from.
 *
 * DEGRADES TO THE BUILT PAGE, ALWAYS. No backend (`astro dev` with nothing
 * running), a network blip, a malformed payload: `fetchSiteContent` returns
 * null and this does nothing at all. The visitor sees the page as built, which
 * is a complete page.
 */
import {
  animateIn,
  applyCopy,
  buildEventCard,
  buildLinkCard,
  buildStatCard,
  fetchSiteContent,
} from "../lib/siteContent";
import type { PublicSiteContent } from "../lib/siteContent";

/**
 * Rebuild the Important Links grid from the live content.
 *
 * A full replace rather than a diff. The grid is a handful of cards with no
 * state to preserve — no focus worth keeping, no scroll position inside it, no
 * inputs — and a diff would be more code standing between the desk and what it
 * just published. The one thing that IS preserved is the entrance stagger:
 * cards are wrapped in the same `data-animate` shell at the same 60ms cadence,
 * counted across the whole grid so the events sitting in the middle do not
 * reset it.
 */
function renderLinks(content: PublicSiteContent): void {
  const grid = document.getElementById("pw-links-grid");
  if (!grid) return;
  // Nothing published at all — leave the built cards rather than blanking the
  // section. An empty grid is far more likely to be a half-seeded deployment
  // than a deliberate "show no links".
  if (content.links.length === 0) return;

  const frag = document.createDocumentFragment();
  let delayIndex = 0;
  for (const link of content.links) {
    if (link.kind === "events") {
      for (const ev of content.events) {
        frag.appendChild(animateIn(buildEventCard(ev), delayIndex++));
      }
      continue;
    }
    frag.appendChild(animateIn(buildLinkCard(link), delayIndex++));
  }
  grid.replaceChildren(frag);
  wireCopyButtons(grid);
}

/** Impact cards. Same full-replace reasoning as the links grid. */
function renderStats(content: PublicSiteContent): void {
  const grid = document.getElementById("pw-impact-grid");
  if (!grid || content.stats.length === 0) return;

  const frag = document.createDocumentFragment();
  content.stats.forEach((stat, i) => {
    frag.appendChild(animateIn(buildStatCard(stat), i));
  });
  grid.replaceChildren(frag);
}

/**
 * Re-attach click-to-copy to freshly built cards.
 *
 * `LinkCard.astro` ships its own listener, bound once at load over the cards
 * that existed then — so a runtime-built Zelle card would look identical and do
 * nothing. Scoped to the container rather than the document so this never
 * double-binds a card the component already claimed.
 */
function wireCopyButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy");
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Older Safari and any non-secure context: the clipboard API is absent
        // or refuses. The hidden-textarea fallback is what the component uses.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      const cta = btn.querySelector("[data-cta]");
      if (cta) {
        const prev = cta.textContent;
        cta.textContent = "Copied!";
        setTimeout(() => {
          cta.textContent = prev;
        }, 1500);
      }
    });
  });
}

async function hydrate(): Promise<void> {
  const content = await fetchSiteContent();
  if (!content) return;
  applyCopy(content.copy);
  renderStats(content);
  renderLinks(content);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void hydrate());
} else {
  void hydrate();
}
