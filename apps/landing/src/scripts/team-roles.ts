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
 */
import {
  roleAcceptsApplications,
  type PublicJobListing,
} from "@events-os/shared/src/hiring";
import { statusLabel, statusChipClass, rolePath } from "../lib/roles";

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
      <a href="${esc(href)}" class="mt-5 inline-flex items-center gap-1 text-sm font-bold text-red-500 hover:underline underline-offset-4">
        Read the full role →
      </a>
    </article>`;
  return li;
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

  if (open.length > 0) {
    for (const role of open) openList.appendChild(buildCard(role));
    show(openList);
  } else {
    show(openNone);
  }

  if (upcoming.length > 0) {
    for (const role of upcoming) upcomingList.appendChild(buildCard(role));
    show(upcomingSection);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", hydrateRoles);
} else {
  void hydrateRoles();
}

export {};
