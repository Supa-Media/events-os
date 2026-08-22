/**
 * Turns the Add Person modal's raw form state into `people.create` args —
 * required-first-name validation, blank-field omission (an empty string sent
 * to the mutation would overwrite the schema's "unset" default with a
 * distinct-from-"—" blank, so a field left untouched must be OMITTED, not
 * sent empty), comma-list parsing, and numeric-rate parsing. No React, no
 * network — same "pure logic module" shape as `addPerson.logic.ts`.
 */
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { VettingStatus, RosterStatus } from "@events-os/shared";
import { composeName } from "@events-os/shared";
import { parseList } from "../../lib/format";

export type CreatePersonArgs = {
  name: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  serviceIds?: Id<"serviceOptions">[];
  vettingStatus?: VettingStatus;
  status?: RosterStatus;
  role?: string;
  gender?: "male" | "female" | "na";
  pocName?: string;
  projects?: string[];
  commsPreferences?: string[];
  pwEmail?: string;
  company?: string;
  usualRateUsd?: number;
  isTeamMember?: boolean;
  socialLink?: string;
  managerId?: Id<"people">;
  location?: string;
  referralSource?: string;
  isVolunteer?: boolean;
  marketingOptOut?: boolean;
  notes?: string;
};

export type AddPersonFormState = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: string;
  company: string;
  pwEmail: string;
  status: RosterStatus | null;
  vettingStatus: VettingStatus | null;
  gender: "male" | "female" | "na" | null;
  isTeamMember: boolean;
  serviceIds: Id<"serviceOptions">[];
  usualRateUsd: string;
  managerId: Id<"people"> | null;
  pocName: string;
  projects: string;
  commsPreferences: string;
  socialLink: string;
  location: string;
  referralSource: string;
  isVolunteer: boolean;
  marketingOptOut: boolean;
  notes: string;
};

export const EMPTY_ADD_PERSON_FORM: AddPersonFormState = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  role: "",
  company: "",
  pwEmail: "",
  status: null,
  vettingStatus: null,
  gender: null,
  isTeamMember: false,
  serviceIds: [],
  usualRateUsd: "",
  managerId: null,
  pocName: "",
  projects: "",
  commsPreferences: "",
  socialLink: "",
  location: "",
  referralSource: "",
  isVolunteer: false,
  marketingOptOut: false,
  notes: "",
};

/** `undefined` for a blank/whitespace-only string, otherwise the trimmed value. */
function trimmedOrUndefined(s: string): string | undefined {
  const trimmed = s.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build `people.create` args from the form, or an error when the one
 * required field (First name) is blank.
 */
export function buildAddPersonArgs(
  form: AddPersonFormState,
): { args: CreatePersonArgs; error?: undefined } | { args?: undefined; error: string } {
  const firstName = form.firstName.trim();
  if (!firstName) {
    return { error: "First name is required." };
  }
  const lastName = form.lastName.trim() || undefined;
  const name = composeName(firstName, lastName);

  const usualRateUsd = (() => {
    const trimmed = form.usualRateUsd.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  })();
  const projects = parseList(form.projects);
  const commsPreferences = parseList(form.commsPreferences);

  const args: CreatePersonArgs = {
    name,
    firstName,
    ...(lastName ? { lastName } : {}),
    email: trimmedOrUndefined(form.email),
    phone: trimmedOrUndefined(form.phone),
    role: trimmedOrUndefined(form.role),
    company: trimmedOrUndefined(form.company),
    pwEmail: trimmedOrUndefined(form.pwEmail),
    pocName: trimmedOrUndefined(form.pocName),
    socialLink: trimmedOrUndefined(form.socialLink),
    location: trimmedOrUndefined(form.location),
    referralSource: trimmedOrUndefined(form.referralSource),
    ...(usualRateUsd !== undefined ? { usualRateUsd } : {}),
    ...(projects.length > 0 ? { projects } : {}),
    ...(commsPreferences.length > 0 ? { commsPreferences } : {}),
    ...(form.status !== null ? { status: form.status } : {}),
    ...(form.vettingStatus !== null ? { vettingStatus: form.vettingStatus } : {}),
    ...(form.gender !== null ? { gender: form.gender } : {}),
    ...(form.managerId !== null ? { managerId: form.managerId } : {}),
    isTeamMember: form.isTeamMember,
    isVolunteer: form.isVolunteer,
    marketingOptOut: form.marketingOptOut,
    serviceIds: form.serviceIds,
  };
  // Strip every key whose value came back `undefined` from the optional-text
  // helpers above — the contract is OMISSION, not an `undefined`-valued key.
  for (const key of Object.keys(args) as (keyof CreatePersonArgs)[]) {
    if (args[key] === undefined) delete args[key];
  }
  return { args };
}
