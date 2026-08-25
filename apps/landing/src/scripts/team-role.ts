/**
 * /team/role — one role's full detail, rendered client-side from the OS.
 *
 * Replaces the old static `[slug].astro`: slugs are minted in Convex and
 * unknown at build time, so there is no `[slug]` route to statically generate.
 * Instead a SINGLE static `/team/role` page reads `?slug=` from the query,
 * fetches `/api/team/roles` (same-origin, proxied to Convex by pw-router), and
 * renders the matching listing. Every section and the visual design are ported
 * one-for-one from the old page — the ONLY structural change is that the roles
 * arrive over the wire instead of from a markdown collection.
 *
 * The static shell (`role.astro`) carries the parts that don't depend on the
 * role — the "← All roles" link, the loading/error states, the static
 * HiringProcess, the 501(c)(3) tail — so those stay server-rendered and DRY;
 * this script fills the role-dependent DOM around them.
 */
import {
  RESPONSE_PROMISE_DAYS,
  TRIAL_TRACKS,
  roleAcceptsApplications,
  type PublicJobListing,
} from "@events-os/shared/src/hiring";
import { statusLabel, statusChipClass, applyPath } from "../lib/roles";

// The primary Button's classes (md size), hardcoded because these apply CTAs
// are built in JS and can't use the Astro <Button> component. Kept in sync
// with components/ui/Button.astro by hand — same pattern apply.astro uses for
// its submit button.
const APPLY_BTN_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-[10px] font-bold " +
  "leading-none transition-all duration-150 bg-red-500 text-white " +
  "hover:bg-red-600 active:bg-red-700 px-[22px] py-3.5 text-[0.95rem]";

/** HTML-escape a value interpolated into a template string. Listings are our
 *  own published content, but escaping is the cheap correct default. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A date the way the old page showed it — long US format, forced to UTC so a
 *  bare `YYYY-MM-DD` never slips a day across the reader's timezone. */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function show(el: Element | null): void {
  el?.classList.remove("hidden");
}
function hide(el: Element | null): void {
  el?.classList.add("hidden");
}

/** The role-dependent DOM (header through the closing prose), as one HTML
 *  string. Mirrors the section order of the old `[slug].astro` exactly — that
 *  order IS `ROLE_TEMPLATE_SECTIONS`, and it's the whole point of the template:
 *  two roles read the same way. */
function renderRole(d: PublicJobListing): string {
  const accepting = roleAcceptsApplications(d.status);
  const applyHref = applyPath(d);

  const facts: { label: string; value: string }[] = [
    { label: "Team", value: d.team },
    { label: "Reports to", value: d.reportsTo },
    { label: "Commitment", value: `${d.commitment} · ~${d.hoursPerWeek} hrs/week` },
    { label: "Where", value: d.location },
    ...(d.manages.length ? [{ label: "You'd lead", value: d.manages.join(" · ") }] : []),
    ...(d.worksWith.length ? [{ label: "Works with", value: d.worksWith.join(" · ") }] : []),
  ];

  const redBullets = (items: string[]): string =>
    items
      .map(
        (i) =>
          `<li class="flex gap-3 text-ink/85"><span class="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-500"></span><span class="leading-relaxed">${esc(i)}</span></li>`,
      )
      .join("");

  const factsHtml = facts
    .map(
      (f) =>
        `<div><dt class="text-xs font-bold uppercase tracking-wide text-ink/50">${esc(f.label)}</dt><dd class="mt-1 text-sm text-ink/85">${esc(f.value)}</dd></div>`,
    )
    .join("");

  const outcomesHtml = d.outcomes
    .map(
      (o) =>
        `<li class="rounded-xl border border-ink/10 bg-cream-soft p-5"><p class="font-display text-lg font-normal text-ink">${esc(o.outcome)}</p><p class="mt-2 text-sm leading-relaxed text-ink/75"><span class="font-semibold text-ink/60">Done when: </span>${esc(o.doneWhen)}</p></li>`,
    )
    .join("");

  const responsibilitiesHtml = d.responsibilities
    .map(
      (group) =>
        `<div><h3 class="font-display text-lg font-normal text-red-500">${esc(group.area)}</h3><ul class="mt-2 space-y-2">${group.items
          .map(
            (item) =>
              `<li class="flex gap-3 text-ink/85"><span class="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-ink/25"></span><span class="leading-relaxed">${esc(item)}</span></li>`,
          )
          .join("")}</ul></div>`,
    )
    .join("");

  const dotList = (items: string[]): string =>
    items.map((i) => `<li class="leading-relaxed">· ${esc(i)}</li>`).join("");

  const preferredHtml = d.preferred.length
    ? `<h3 class="mt-6 font-display text-lg font-normal text-ink">Helpful, not required</h3><ul class="mt-2 space-y-2">${d.preferred
        .map(
          (p) =>
            `<li class="flex gap-3 text-ink/75"><span class="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-ink/25"></span><span class="leading-relaxed">${esc(p)}</span></li>`,
        )
        .join("")}</ul>`
    : "";

  const growthHtml = d.growthPath
    ? `<section class="mt-12"><h2 class="font-display text-2xl font-normal text-ink">Where it can go</h2><p class="mt-3 max-w-prose leading-relaxed text-ink/80">${esc(d.growthPath)}</p></section>`
    : "";

  // The closing prose (old markdown body). Blank lines are paragraph breaks;
  // absent when the role has no coda.
  const bodyHtml = d.body?.trim()
    ? `<section class="prose-role mt-12 max-w-prose leading-relaxed text-ink/80">${d.body
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${esc(p)}</p>`)
        .join("")}</section>`
    : "";

  return `
    <header class="mt-6 flex flex-col items-start gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <span class="inline-flex items-center rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${statusChipClass(d.status)}">${esc(statusLabel(d.status))}</span>
        <span class="text-xs uppercase tracking-wide text-ink/55">${esc(d.team)}</span>
      </div>
      <h1 class="font-display font-normal leading-[1.08] text-3xl sm:text-[42px] md:text-[52px]">${esc(d.title)}</h1>
      <p class="max-w-prose text-lg leading-relaxed text-ink/80">${esc(d.summary)}</p>
      <div class="mt-2 flex flex-wrap items-center gap-3">
        <a href="${esc(applyHref)}" class="${APPLY_BTN_CLASS}">${accepting ? "Apply for this role →" : "Register your interest →"}</a>
        <span class="text-sm text-ink/60">${accepting ? `A person replies within ${RESPONSE_PROMISE_DAYS} days.` : "Not open yet — we'll come back to you when it is."}</span>
      </div>
    </header>

    <dl class="mt-10 grid gap-x-8 gap-y-4 rounded-2xl border border-ink/10 bg-cream-soft p-6 sm:grid-cols-2 sm:p-7">${factsHtml}</dl>

    <section class="mt-12">
      <h2 class="font-display text-2xl font-normal text-ink">Why this seat exists</h2>
      <p class="mt-3 max-w-prose leading-relaxed text-ink/80">${esc(d.whyThisSeatExists)}</p>
    </section>

    <section class="mt-12">
      <h2 class="font-display text-2xl font-normal text-ink">What you'd be accountable for</h2>
      <p class="mt-2 max-w-prose text-sm text-ink/65">Outcomes, not activities — and how we'd both know one actually landed.</p>
      <ul class="mt-5 space-y-4">${outcomesHtml}</ul>
    </section>

    <section class="mt-12">
      <h2 class="font-display text-2xl font-normal text-ink">What you'd get to decide</h2>
      <p class="mt-2 max-w-prose text-sm text-ink/65">Without asking. Handing someone a responsibility without the authority to go with it just hands it back.</p>
      <ul class="mt-4 space-y-2">${redBullets(d.authority)}</ul>
    </section>

    <section class="mt-12">
      <h2 class="font-display text-2xl font-normal text-ink">The work itself</h2>
      <div class="mt-5 space-y-7">${responsibilitiesHtml}</div>
    </section>

    <section class="mt-12 grid gap-6 sm:grid-cols-2">
      <div>
        <h2 class="font-display text-xl font-normal text-ink">The rhythms</h2>
        <ul class="mt-3 space-y-2 text-sm text-ink/80">${dotList(d.rhythms)}</ul>
      </div>
      <div>
        <h2 class="font-display text-xl font-normal text-ink">Your first 90 days</h2>
        <ul class="mt-3 space-y-2 text-sm text-ink/80">${dotList(d.firstNinetyDays)}</ul>
      </div>
    </section>

    <section class="mt-12">
      <h2 class="font-display text-2xl font-normal text-ink">Who this is for</h2>
      <ul class="mt-4 space-y-2">${redBullets(d.required)}</ul>
      ${preferredHtml}
    </section>

    <section class="mt-12 rounded-2xl border border-ink/10 bg-cream-soft p-6 sm:p-7">
      <h2 class="font-display text-xl font-normal text-ink">What this role is not</h2>
      <ul class="mt-3 space-y-2 text-sm text-ink/80">${dotList(d.notThisRole)}</ul>
    </section>

    <section class="mt-12">
      <h2 class="font-display text-2xl font-normal text-ink">How we'd know it's working</h2>
      <ul class="mt-4 space-y-2">${redBullets(d.successLooks)}</ul>
    </section>

    ${growthHtml}
    ${bodyHtml}`;
}

/** Fill the static tail (the track line, both apply CTAs' sibling, the posted
 *  footer) that lives in `role.astro` around the shared HiringProcess. */
function fillTail(d: PublicJobListing): void {
  const accepting = roleAcceptsApplications(d.status);
  const applyHref = applyPath(d);

  const trackEl = document.querySelector<HTMLElement>("[data-role-track]");
  const track = TRIAL_TRACKS.find((t) => t.id === d.trialTrack);
  if (trackEl && track) {
    trackEl.textContent =
      `This role's Empowerment Trial runs on the ${track.label.toLowerCase()} track: ` +
      `a check-in at ${track.midpointDays} days and a decision at ${track.decisionDays}.`;
  }

  const cta = document.querySelector<HTMLAnchorElement>("[data-role-apply-cta]");
  if (cta) {
    cta.href = applyHref;
    cta.className = APPLY_BTN_CLASS;
    cta.textContent = accepting ? `Apply for ${d.title} →` : "Register your interest →";
  }

  const posted = document.querySelector<HTMLElement>("[data-role-posted]");
  if (posted) {
    posted.textContent = `Posted ${formatDate(d.postedAt)}${
      d.updatedAt ? ` · updated ${formatDate(d.updatedAt)}` : ""
    }. `;
  }
}

async function hydrateRole(): Promise<void> {
  const loading = document.getElementById("role-loading");
  const errorEl = document.getElementById("role-error");
  const errorMsg = document.getElementById("role-error-msg");
  const content = document.getElementById("role-content");
  const dynamic = document.querySelector<HTMLElement>("[data-role-dynamic]");
  if (!content || !dynamic) return;

  const fail = (message: string): void => {
    hide(loading);
    hide(content);
    if (errorMsg) errorMsg.textContent = message;
    show(errorEl);
  };

  const slug = (new URLSearchParams(window.location.search).get("slug") ?? "").trim();
  if (!slug) {
    fail("No role was specified. Head back to see everything that's open.");
    return;
  }

  let roles: PublicJobListing[] = [];
  try {
    const res = await fetch("/api/team/roles", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { roles?: PublicJobListing[] };
    roles = Array.isArray(body.roles) ? body.roles : [];
  } catch {
    fail("We couldn't load this role right now. Try again in a moment.");
    return;
  }

  const role = roles.find((r) => r.slug === slug);
  if (!role) {
    // Published listings only ever include live roles — a missing slug most
    // often means the seat was filled and unpublished since the link was shared.
    fail("This role isn't listed right now — it may have been filled. See what else is open.");
    return;
  }

  dynamic.innerHTML = renderRole(role);
  fillTail(role);
  document.title = `${role.title} — Public Worship`;

  hide(loading);
  hide(errorEl);
  show(content);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", hydrateRole);
} else {
  void hydrateRole();
}

export {};
