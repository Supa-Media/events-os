/**
 * The `/team` pages' read layer over the `roles` content collection.
 *
 * Roles are markdown in this repo, not rows in a database (see the collection's
 * doc in `src/content/config.ts`). These helpers are the only place that knows
 * how they sort and which ones are still taking applications, so the index, a
 * role page, and the apply form can't disagree about what "open" means.
 */
import { getCollection, type CollectionEntry } from "astro:content";
import {
  ROLE_STATUS_LABELS,
  roleAcceptsApplications,
  type RoleStatus,
} from "@events-os/shared/src/hiring";
import { asset } from "./asset";

export type Role = CollectionEntry<"roles">;

/** Status display order on the index: what you can apply for, then what's
 *  coming, then what's been filled. */
const STATUS_ORDER: Record<RoleStatus, number> = {
  open: 0,
  filling: 1,
  not_open: 2,
  closed: 3,
};

/** Every role, sorted the way the index renders them: by status, then by the
 *  role's own `order`, then alphabetically so the list is stable. */
export async function getRoles(): Promise<Role[]> {
  const roles = await getCollection("roles");
  return roles.sort((a, b) => {
    const byStatus =
      STATUS_ORDER[a.data.status as RoleStatus] -
      STATUS_ORDER[b.data.status as RoleStatus];
    if (byStatus !== 0) return byStatus;
    if (a.data.order !== b.data.order) return a.data.order - b.data.order;
    return a.data.title.localeCompare(b.data.title);
  });
}

/** The ones actually taking applications right now. */
export function openRoles(roles: Role[]): Role[] {
  return roles.filter((r) => roleAcceptsApplications(r.data.status as RoleStatus));
}

/** Everything else — published so a candidate can see where the org is going,
 *  even when there's nothing to apply for yet. */
export function otherRoles(roles: Role[]): Role[] {
  return roles.filter(
    (r) => !roleAcceptsApplications(r.data.status as RoleStatus),
  );
}

export function rolePath(role: Role): string {
  return asset(`/team/${role.id}`);
}

/** The apply link for a role — carrying the slug and title so the form knows
 *  what it's an application FOR without a second lookup. A role that isn't
 *  taking applications sends people to the general-interest door instead. */
export function applyPath(role?: Role): string {
  if (!role || !roleAcceptsApplications(role.data.status as RoleStatus)) {
    return asset("/team/apply");
  }
  const params = new URLSearchParams({
    role: role.id,
    title: role.data.title,
  });
  return asset(`/team/apply?${params.toString()}`);
}

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
