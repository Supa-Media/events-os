/**
 * The `/team` pages' shared view helpers over a `PublicJobListing`.
 *
 * Roles no longer live as markdown in this repo — they're rows in Convex
 * (`jobListings`), fetched at RUNTIME from `GET /api/team/roles` by the client
 * scripts (`scripts/team-roles.ts`, `scripts/team-role.ts`). The landing build
 * has no Convex URL, so there is nothing to read at build time; these helpers
 * are therefore pure and framework-free (no `astro:content`) so the browser
 * bundle can import them. They are the ONE place that knows how a role's status
 * maps to a label, a chip colour, and the two URLs it links to — so the index
 * card, the detail page, and the apply form can't disagree.
 */
import {
  ROLE_STATUS_LABELS,
  roleAcceptsApplications,
  type PublicJobListing,
  type RoleStatus,
} from "@events-os/shared/src/hiring";
import { asset } from "./asset";

/** The role shape both `/team` pages render — the OS wire contract. */
export type Role = PublicJobListing;

export function statusLabel(status: string): string {
  return ROLE_STATUS_LABELS[status as RoleStatus] ?? status;
}

/** Tailwind classes for a status chip. Open is the only one that gets the
 *  brand red — the rest read as information, not invitation. */
export function statusChipClass(status: string): string {
  switch (status as RoleStatus) {
    case "open":
      return "bg-red-500 text-white";
    case "filling":
      return "bg-pink-softer text-ink border border-pink-soft";
    default:
      return "bg-ink/5 text-ink/70";
  }
}

/** The detail page for a role. A query param rather than a path segment
 *  because slugs are minted in the OS and unknown at build time, so there is
 *  no static `[slug]` route to generate — one static `/team/role` page reads
 *  `?slug=` at runtime instead. */
export function rolePath(slug: string): string {
  return asset(`/team/role?slug=${encodeURIComponent(slug)}`);
}

/** The apply link for a role — carrying the slug and title so the form knows
 *  what it's an application FOR without a second lookup. A role that isn't
 *  taking applications sends people to the general-interest door instead. */
export function applyPath(
  role?: Pick<PublicJobListing, "slug" | "title" | "status">,
): string {
  if (!role || !roleAcceptsApplications(role.status)) {
    return asset("/team/apply");
  }
  const params = new URLSearchParams({ role: role.slug, title: role.title });
  return asset(`/team/apply?${params.toString()}`);
}
