/**
 * The /team index's role lists, filled live from the OS.
 *
 * Job listings live in Convex now, not as markdown in this repo, so the index
 * can't render them at build time — the landing build has no Convex URL. Same
 * shape as `ImportantLinks.astro`'s live-events hydration: a static shell with
 * empty containers, augmented at runtime by a same-origin `fetch('/api/...')`
 * that pw-router proxies to Convex. All-or-nothing: if the fetch fails (e.g.
 * `astro dev` with no backend, or a network blip) the page keeps the
 * server-rendered fallback line pointing at the general-interest door, exactly
 * as it degrades with JS off.
 *
 * The endpoint returns only PUBLISHED roles, already sorted in display order
 * (open, filling, not_open, closed), so this script never sorts — it only
 * splits on whether a role is still taking applications.
 *
 * The All / NYC / DMV chips above the lists filter both of them by
 * `listingRegions` (read from each role's location line). The choice rides in
 * `?region=` so a filtered page can be shared.
 */
import {
  LISTING_REGIONS,
  LISTING_REGION_LABELS,
  listingRegions,
  roleAcceptsApplications,
  type ListingRegion,
  type PublicJobListing,
} from "@events-os/shared/src/hiring";
import {
  statusLabel,
  statusChipClass,
  rolePath,
  applyPath,
} from "../lib/roles";

/** Port of `RoleCard.astro`: enough of a seat to self-select out of, and no
 *  more — the status chip, the hours, and who it reports to are the three
 *  facts that decide whether to keep reading, so they're on the card. Built in
 *  JS because the cards arrive at runtime; the markup mirrors the old
 *  component one-for-one. */
function buildCard(role: PublicJobListing): HTMLLIElement {
  const li = document.createElement("li");
  const href = rolePath(role.slug);
  // Trusted source (our own published listings), but escaping via textContent
  // rather than innerHTML is the cheap correct default for any interpolated
  // string — done here by assembling with createElement.
  li.innerHTML = `
    <article class="rounded-2xl border border-ink/12 bg-cream-soft p-6 transition-all hover:border-red-500 hover:shadow-soft sm:p-7">
      <div class="flex flex-wrap items-center gap-3">
        <span class="inline-flex items-center rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${statusChipClass(role.status)}">${esc(statusLabel(role.status))}</span>
        <span class="text-xs uppercase tracking-wide text-ink/55">${esc(role.team)}</span>
      </div>
      <h3 class="mt-3 font-display text-2xl font-normal leading-tight">
        <a href="${esc(href)}" class="hover:text-red-500">${esc(role.title)}</a>
      </h3>
      <p class="mt-3 max-w-prose text-base leading-relaxed text-ink/80">${esc(role.summary)}</p>
      <dl class="mt-5 grid gap-x-6 gap-y-2 text-sm text-ink/70 sm:grid-cols-2">
        <div class="flex gap-2">
          <dt class="font-semibold text-ink/60">Reports to</dt>
          <dd>${esc(role.reportsTo)}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="font-semibold text-ink/60">Time</dt>
          <dd>~${esc(String(role.hoursPerWeek))} hrs/week · ${esc(role.commitment)}</dd>
        </div>
        <div class="flex gap-2 sm:col-span-2">
          <dt class="font-semibold text-ink/60">Where</dt>
          <dd>${esc(role.location)}</dd>
        </div>
      </dl>
      <div class="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        ${applyButton(role)}
        <a href="${esc(href)}" class="inline-flex items-center gap-1 text-sm font-bold text-red-500 hover:underline underline-offset-4">
          Read the full role →
        </a>
      </div>
    </article>`;
  return li;
}

/** The card's Apply button, straight to this role's application. Only seats
 *  taking applications get one — a not-open seat has nothing to apply to, and
 *  `applyPath` would quietly send it to the general pool instead. */
function applyButton(role: PublicJobListing): string {
  if (!roleAcceptsApplications(role.status)) return "";
  return `<a href="${esc(applyPath(role))}" class="inline-flex items-center justify-center rounded-[10px] bg-red-500 px-5 py-3 text-sm font-bold leading-none text-white transition-all duration-150 hover:bg-red-600 active:bg-red-700">
          Apply for this seat
        </a>`;
}

/** Minimal HTML-escape for values interpolated into the card template. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function show(el: Element | null): void {
  el?.classList.remove("hidden");
}
function hide(el: Element | null): void {
  el?.classList.add("hidden");
}

type RegionFilter = ListingRegion | "all";

/** `?region=` on load, if it names a real region; otherwise All. */
function initialFilter(): RegionFilter {
  const raw = new URLSearchParams(window.location.search).get("region");
  return LISTING_REGIONS.find((r) => r === raw?.toLowerCase()) ?? "all";
}

/** Each card remembers its regions so the chips can toggle it in place. */
function tagRegions(li: HTMLLIElement, role: PublicJobListing): HTMLLIElement {
  li.dataset.regions = listingRegions(role.location).join(" ");
  return li;
}

/** Show the cards in `filter`, and the empty/section states that follow. */
function applyFilter(filter: RegionFilter): void {
  const openList = document.getElementById("team-open-roles");
  const openNone = document.getElementById("team-open-none");
  const regionNone = document.getElementById("team-open-region-none");
  const upcomingSection = document.getElementById("team-upcoming-section");
  const upcomingList = document.getElementById("team-upcoming-roles");

  const visibleIn = (list: HTMLElement | null): number => {
    let count = 0;
    for (const li of Array.from(list?.children ?? []) as HTMLElement[]) {
      const match =
        filter === "all" || (li.dataset.regions ?? "").split(" ").includes(filter);
      li.classList.toggle("hidden", !match);
      if (match) count += 1;
    }
    return count;
  };

  const totalOpen = openList?.children.length ?? 0;
  const shownOpen = visibleIn(openList);
  // The general "nothing open" copy is for an empty board; a board that only
  // has seats in the other city gets its own line.
  if (totalOpen > 0) {
    openList?.classList.toggle("hidden", shownOpen === 0);
    if (regionNone) {
      regionNone.classList.toggle("hidden", shownOpen > 0);
      const label = regionNone.querySelector("[data-region-label]");
      if (label && filter !== "all") label.textContent = LISTING_REGION_LABELS[filter];
    }
  } else {
    show(openNone);
  }

  if ((upcomingList?.children.length ?? 0) > 0) {
    upcomingSection?.classList.toggle("hidden", visibleIn(upcomingList) === 0);
  }

  for (const chip of Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-region-chip]"),
  )) {
    const on = chip.dataset.regionChip === filter;
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("bg-ink", on);
    chip.classList.toggle("text-cream", on);
    chip.classList.toggle("border-ink", on);
    chip.classList.toggle("bg-cream-soft", !on);
    chip.classList.toggle("text-ink/75", !on);
  }
}

function setFilter(filter: RegionFilter): void {
  applyFilter(filter);
  const url = new URL(window.location.href);
  if (filter === "all") url.searchParams.delete("region");
  else url.searchParams.set("region", filter);
  history.replaceState(null, "", url);
}

async function hydrateRoles(): Promise<void> {
  const openList = document.getElementById("team-open-roles");
  const openNone = document.getElementById("team-open-none");
  const fallback = document.getElementById("team-roles-fallback");
  const upcomingSection = document.getElementById("team-upcoming-section");
  const upcomingList = document.getElementById("team-upcoming-roles");
  if (!openList || !upcomingList) return;

  let roles: PublicJobListing[] = [];
  try {
    const res = await fetch("/api/team/roles", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return; // Leave the fallback line + apply-door link in place.
    const body = (await res.json()) as { roles?: PublicJobListing[] };
    roles = Array.isArray(body.roles) ? body.roles : [];
  } catch {
    return; // No backend reachable (e.g. local dev) — keep the fallback.
  }

  // The fetch resolved, so the pre-JS/error fallback is no longer the truth —
  // swap it for the real state (a filled list, or the "nothing open" copy).
  hide(fallback);

  const open = roles.filter((r) => roleAcceptsApplications(r.status));
  const upcoming = roles.filter((r) => !roleAcceptsApplications(r.status));

  for (const role of open) openList.appendChild(tagRegions(buildCard(role), role));
  for (const role of upcoming) {
    upcomingList.appendChild(tagRegions(buildCard(role), role));
  }

  // Chips only once there are seats to filter.
  const chips = document.getElementById("team-region-chips");
  if (chips && roles.length > 0) {
    chips.addEventListener("click", (event) => {
      const chip = (event.target as Element).closest<HTMLButtonElement>(
        "[data-region-chip]",
      );
      if (chip) setFilter(chip.dataset.regionChip as RegionFilter);
    });
    show(chips);
  }

  applyFilter(initialFilter());
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", hydrateRoles);
} else {
  void hydrateRoles();
}

export {};
