/**
 * VOLUNTEERS — the org's OTHER people pipeline.
 *
 * Public Worship is entirely volunteer-run, which makes "volunteer" a useless
 * word on its own: the Executive Director is a volunteer. The distinction that
 * actually matters, and the one this module names, is between two very
 * different commitments:
 *
 *   TEAM        A named seat on the org chart, with outcomes it is accountable
 *               for and decisions it owns. Applied for at `/team`, and filled
 *               through the five-step process in `hiring.ts` — interviews, a
 *               shared rubric, an Empowerment Trial, a director's call. Weeks
 *               of process, because the commitment is measured in years.
 *
 *   VOLUNTEER   Someone who shows up and helps at a gathering — setup, welcome,
 *               prayer, a camera. Signed up at `/serve`. No rubric, no trial,
 *               no seat. The whole pipeline is: they raise a hand, a human
 *               replies, they land on the roster, and they get invited to the
 *               next thing that needs them.
 *
 * Both belong to the People seat — one person answerable for how the whole org
 * gets its people — but running them the same way would be wrong in both
 * directions: a trial to hand out lanyards is absurd, and a hand-raise is not
 * enough to hand someone a chapter.
 *
 * The product already draws this line: `personaOf` reads `isTeamMember` off a
 * `people` row for team, and everyone else with a participation signal is a
 * volunteer. A signup here becomes a roster row with `isVolunteer` set (see
 * `apps/convex/volunteers.ts#addToRoster`), which is what makes them
 * invitable to an event's `engagements`.
 */

// ── The signup's short life ──────────────────────────────────────────────────

/**
 * Four stages, and that is the whole pipeline. Deliberately not a funnel:
 * nobody is being evaluated here. The only real question is whether a human
 * has replied and whether they are on the roster yet.
 */
export const VOLUNTEER_STAGES = [
  "new",
  "contacted",
  "rostered",
  "archived",
] as const;
export type VolunteerStage = (typeof VOLUNTEER_STAGES)[number];

export interface VolunteerStageDef {
  id: VolunteerStage;
  label: string;
  blurb: string;
  /** Terminal — stops counting against the reply promise. */
  closed: boolean;
}

export const VOLUNTEER_STAGE_DEFS: Record<VolunteerStage, VolunteerStageDef> = {
  new: {
    id: "new",
    label: "New",
    blurb: "They raised a hand. Nobody has replied yet.",
    closed: false,
  },
  contacted: {
    id: "contacted",
    label: "Reached out",
    blurb: "A human has been in touch — now get them onto the roster.",
    closed: false,
  },
  rostered: {
    id: "rostered",
    label: "On the roster",
    blurb:
      "They're a person in the CRM with their areas tagged, so they show up when an event needs those hands.",
    closed: true,
  },
  archived: {
    id: "archived",
    label: "Archived",
    blurb:
      "Not actionable — a duplicate, a mis-fire, or someone who told us the season changed. Kept, never deleted.",
    closed: true,
  },
};

export function isVolunteerStage(value: string): value is VolunteerStage {
  return (VOLUNTEER_STAGES as readonly string[]).includes(value);
}

export function isClosedVolunteerStage(stage: VolunteerStage): boolean {
  return VOLUNTEER_STAGE_DEFS[stage].closed;
}

// ── What we ask ──────────────────────────────────────────────────────────────

/**
 * The areas a volunteer can pick on the public form, and what each maps to in
 * the Service Catalog (`apps/convex/lib/serviceCatalog.ts`'s
 * `CANONICAL_SERVICE_CATALOG`, `"Name"` or `"Parent:Child"`).
 *
 * SHORT ON PURPOSE. The catalog has ~30 entries and goes down to vocal parts;
 * a public form with thirty checkboxes is a form nobody finishes. These eight
 * are the shapes a gathering actually needs, and the desk tags the specific
 * catalog service when it puts someone on the roster — which is also when a
 * human has had an actual conversation and knows which one is true.
 *
 * `serviceLabels` may be empty ("wherever you need me"): a willing pair of
 * hands with no stated specialty is a real and common answer, and pretending
 * otherwise would make the roster tags a lie.
 */
export const VOLUNTEER_AREAS = [
  {
    id: "setup",
    label: "Setup & breakdown",
    blurb: "Carrying, building, striking. The unglamorous backbone of a gathering.",
    serviceLabels: ["Setup & Breakdown"],
  },
  {
    id: "welcome",
    label: "Welcome & guest services",
    blurb: "First faces people meet. Greeting, directions, making room.",
    serviceLabels: ["Guest Services"],
  },
  {
    id: "prayer",
    label: "Prayer & evangelism",
    blurb: "Praying with strangers, and having the conversations that follow.",
    serviceLabels: ["Evangelism", "Prayer & Intercession"],
  },
  {
    id: "music",
    label: "Music & worship",
    blurb: "Singing or playing. We'll ask what you play when we talk.",
    serviceLabels: ["Worship Leading", "Vocals", "Instruments"],
  },
  {
    id: "media",
    label: "Photo, video & content",
    blurb: "Capturing what happens, and cutting it into something worth watching.",
    serviceLabels: ["Media", "Social Media:Content"],
  },
  {
    id: "design",
    label: "Design",
    blurb: "Graphics, flyers, the look of the thing.",
    serviceLabels: ["Graphic Design"],
  },
  {
    id: "logistics",
    label: "Logistics & transport",
    blurb: "Gear from A to B, permits, venues, the van.",
    serviceLabels: ["Logistics & Venue", "Driving & Transport"],
  },
  {
    id: "anywhere",
    label: "Wherever you need me",
    blurb: "Genuinely useful, and more common than you'd think.",
    serviceLabels: [],
  },
] as const;

export type VolunteerArea = (typeof VOLUNTEER_AREAS)[number]["id"];
export const VOLUNTEER_AREA_IDS: VolunteerArea[] = VOLUNTEER_AREAS.map((a) => a.id);

export function isVolunteerArea(value: string): value is VolunteerArea {
  return (VOLUNTEER_AREA_IDS as string[]).includes(value);
}

export function volunteerAreaDef(id: VolunteerArea) {
  const found = VOLUNTEER_AREAS.find((a) => a.id === id);
  if (!found) throw new Error(`Unknown volunteer area: ${id}`);
  return found;
}

/** Every Service Catalog label the picked areas imply, deduped. What
 *  `addToRoster` tags the new roster row with. */
export function serviceLabelsForAreas(areas: readonly string[]): string[] {
  const labels = new Set<string>();
  for (const area of areas) {
    if (!isVolunteerArea(area)) continue;
    for (const label of volunteerAreaDef(area).serviceLabels) labels.add(label);
  }
  return [...labels];
}

/** Field caps, enforced server-side (`volunteers.submitSignup`). The form is
 *  short by design — this is a hand-raise, not an application. */
export const VOLUNTEER_LIMITS = {
  name: 120,
  email: 200,
  phone: 40,
  location: 120,
  availability: 600,
  message: 1000,
  areas: 8,
} as const;

/** The same promise the team pipeline makes, for the same reason: a hand
 *  raised into silence is worse than no form at all. */
export const VOLUNTEER_REPLY_DAYS = 7;
