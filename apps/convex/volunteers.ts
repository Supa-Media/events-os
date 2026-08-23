/**
 * VOLUNTEERS — the People desk's light pipeline.
 *
 * `/serve` posts here (`POST /api/volunteer/signup`); the desk triages what
 * lands. Everything about this file is deliberately smaller than
 * `hiring.ts`: no rubric, no trial, no reviewers, no decision gate. Somebody
 * offered to help carry speakers, and the only questions that matter are
 * whether a human replied and whether they're on the roster yet. See
 * `@events-os/shared`'s `volunteers.ts` for why the two pipelines are
 * deliberately not one pipeline with a flag.
 *
 * The one substantial act here is `addToRoster`: turning a signup into a real
 * `people` row, tagged with the Service Catalog services the areas they
 * picked imply. Until that happens nothing touches the roster — same rule the
 * application intake follows, and for the same reason (every roster count in
 * the app would otherwise drift toward "everyone who ever clicked a button").
 *
 * Gated on the SAME powers as the team pipeline (`lib/hiringAccess.ts`): one
 * seat is answerable for how the whole org gets its people.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
// Trigger-wrapped builder for `addToRoster`, which INSERTS a `people` row —
// see `lib/peopleAggregate.ts`'s module doc for why a raw `mutation` would
// silently desync the persona aggregate.
import { mutation as peopleMutation } from "./lib/peopleAggregate";
import {
  VOLUNTEER_AREAS,
  VOLUNTEER_LIMITS,
  VOLUNTEER_REPLY_DAYS,
  isVolunteerArea,
  isClosedVolunteerStage,
  serviceLabelsForAreas,
  type VolunteerStage,
} from "@events-os/shared";
import { VOLUNTEER_SIGNUP_STAGES } from "./schema/volunteers";
import { requireHiringManage, requireHiringView } from "./lib/hiringAccess";
import { requireChapterId, requireUserId } from "./lib/context";
import { ensureOrgWideServiceCatalog } from "./lib/serviceCatalog";

const stageValidator = v.union(
  ...VOLUNTEER_SIGNUP_STAGES.map((s) => v.literal(s)),
);

/** Generous bound on the inbox. Volunteer signups arrive in tens per event
 *  season, nowhere near this. */
const SIGNUP_LIST_LIMIT = 500;
/** One person's own signup history — a handful of rows at most. */
const SIGNUP_HISTORY_LIMIT = 25;
/** A repeat signup inside this window is the same hand, raised twice. */
const DUPLICATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function trimmedOrUndefined(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

function capped(
  value: string | undefined,
  { field, label, max }: { field: string; label: string; max: number },
): string | undefined {
  const trimmed = trimmedOrUndefined(value);
  if (trimmed && trimmed.length > max) {
    throw new ConvexError({
      code: `INVALID_${field.toUpperCase()}`,
      message: `${label} must be ${max} characters or fewer.`,
    });
  }
  return trimmed;
}

// ── PUBLIC (no auth) ─────────────────────────────────────────────────────────

/**
 * PUBLIC entry point for `/serve`'s signup form.
 *
 * Asks for almost nothing on purpose — a name, a way to reply, and roughly
 * what they'd like to help with. Every extra required field on a form like
 * this costs real volunteers, and none of the answers we'd gain are ones a
 * two-minute conversation wouldn't produce better.
 *
 * A repeat signup from the same email inside `DUPLICATE_WINDOW_MS` updates the
 * existing row rather than opening a second one — unless that row has already
 * been rostered, in which case the new one is a genuinely new offer (the
 * season changed, they can help with something else now) and gets its own row.
 */
export const submitSignup = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    location: v.optional(v.string()),
    // Loose `v.array(v.string())`, narrowed in the handler so an unknown area
    // gets a friendly message instead of Convex's generic validation failure.
    areas: v.array(v.string()),
    availability: v.optional(v.string()),
    message: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();

    const name = trimmedOrUndefined(args.name);
    if (!name) {
      throw new ConvexError({
        code: "MISSING_NAME",
        message: "Your name is required.",
      });
    }
    if (name.length > VOLUNTEER_LIMITS.name) {
      throw new ConvexError({
        code: "INVALID_NAME",
        message: `Your name must be ${VOLUNTEER_LIMITS.name} characters or fewer.`,
      });
    }

    const email = trimmedOrUndefined(args.email)?.toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ConvexError({
        code: "INVALID_EMAIL",
        message: "We need an email address we can actually reply to.",
      });
    }
    if (email.length > VOLUNTEER_LIMITS.email) {
      throw new ConvexError({
        code: "INVALID_EMAIL",
        message: `Email must be ${VOLUNTEER_LIMITS.email} characters or fewer.`,
      });
    }

    const phone = capped(args.phone, {
      field: "phone",
      label: "Phone",
      max: VOLUNTEER_LIMITS.phone,
    });
    const location = capped(args.location, {
      field: "location",
      label: "Location",
      max: VOLUNTEER_LIMITS.location,
    });
    const availability = capped(args.availability, {
      field: "availability",
      label: "When you're free",
      max: VOLUNTEER_LIMITS.availability,
    });
    const message = capped(args.message, {
      field: "message",
      label: "Your message",
      max: VOLUNTEER_LIMITS.message,
    });

    for (const area of args.areas) {
      if (!isVolunteerArea(area)) {
        throw new ConvexError({
          code: "UNKNOWN_AREA",
          message: `We don't have an area called "${area}".`,
        });
      }
    }
    const areas = [...new Set(args.areas)];
    if (areas.length === 0) {
      throw new ConvexError({
        code: "MISSING_AREAS",
        message:
          "Pick at least one thing you'd like to help with — \"wherever you need me\" counts.",
      });
    }
    if (areas.length > VOLUNTEER_LIMITS.areas) {
      throw new ConvexError({
        code: "TOO_MANY_AREAS",
        message: "That's more areas than we have.",
      });
    }

    const history = await ctx.db
      .query("volunteerSignups")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(SIGNUP_HISTORY_LIMIT);
    const open = history.find(
      (row) =>
        !isClosedVolunteerStage(row.stage as VolunteerStage) &&
        now - row.createdAt < DUPLICATE_WINDOW_MS,
    );
    if (open) {
      await ctx.db.patch(open._id, {
        name,
        areas,
        ...(phone ? { phone } : {}),
        ...(location ? { location } : {}),
        ...(availability ? { availability } : {}),
        ...(message ? { message } : {}),
        updatedAt: now,
      });
      return null;
    }

    await ctx.db.insert("volunteerSignups", {
      name,
      email,
      ...(phone ? { phone } : {}),
      ...(location ? { location } : {}),
      areas,
      ...(availability ? { availability } : {}),
      ...(message ? { message } : {}),
      stage: "new",
      stageChangedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

// ── Desk reads ───────────────────────────────────────────────────────────────

const signupRowValidator = v.object({
  _id: v.id("volunteerSignups"),
  name: v.string(),
  email: v.string(),
  phone: v.union(v.string(), v.null()),
  location: v.union(v.string(), v.null()),
  areas: v.array(v.string()),
  availability: v.union(v.string(), v.null()),
  message: v.union(v.string(), v.null()),
  stage: stageValidator,
  stageChangedAt: v.number(),
  personId: v.union(v.id("people"), v.null()),
  createdAt: v.number(),
});

function signupRow(row: Doc<"volunteerSignups">) {
  return {
    _id: row._id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? null,
    location: row.location ?? null,
    areas: row.areas,
    availability: row.availability ?? null,
    message: row.message ?? null,
    stage: row.stage,
    stageChangedAt: row.stageChangedAt,
    personId: row.personId ?? null,
    createdAt: row.createdAt,
  };
}

/** The inbox. Open signups by default, newest first. */
export const listSignups = query({
  args: {
    stage: v.optional(stageValidator),
    includeClosed: v.optional(v.boolean()),
  },
  returns: v.array(signupRowValidator),
  handler: async (ctx, { stage, includeClosed }) => {
    await requireHiringView(ctx);
    const rows = stage
      ? await ctx.db
          .query("volunteerSignups")
          .withIndex("by_stage", (q) => q.eq("stage", stage))
          .take(SIGNUP_LIST_LIMIT)
      : await ctx.db
          .query("volunteerSignups")
          .withIndex("by_createdAt")
          .order("desc")
          .take(SIGNUP_LIST_LIMIT);

    return rows
      .filter((row) =>
        includeClosed || stage
          ? true
          : !isClosedVolunteerStage(row.stage as VolunteerStage),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(signupRow);
  },
});

/** Header numbers: how many are waiting, and how many nobody has answered
 *  inside the promise. Same shape of question the team pipeline asks. */
export const signupSummary = query({
  args: {},
  returns: v.object({
    open: v.number(),
    unanswered: v.number(),
    pastPromise: v.number(),
    rostered: v.number(),
    replyDays: v.number(),
  }),
  handler: async (ctx) => {
    await requireHiringView(ctx);
    const now = Date.now();
    const rows = await ctx.db
      .query("volunteerSignups")
      .withIndex("by_createdAt")
      .order("desc")
      .take(SIGNUP_LIST_LIMIT);

    let open = 0;
    let unanswered = 0;
    let pastPromise = 0;
    let rostered = 0;
    for (const row of rows) {
      if (row.stage === "rostered") rostered += 1;
      if (isClosedVolunteerStage(row.stage as VolunteerStage)) continue;
      open += 1;
      if (row.stage === "new") {
        unanswered += 1;
        if (now - row.createdAt > VOLUNTEER_REPLY_DAYS * 24 * 60 * 60 * 1000) {
          pastPromise += 1;
        }
      }
    }
    return {
      open,
      unanswered,
      pastPromise,
      rostered,
      replyDays: VOLUNTEER_REPLY_DAYS,
    };
  },
});

// ── Desk writes ──────────────────────────────────────────────────────────────

async function loadSignup(
  ctx: MutationCtx,
  signupId: Id<"volunteerSignups">,
): Promise<Doc<"volunteerSignups">> {
  const row = await ctx.db.get(signupId);
  if (!row) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "That signup no longer exists.",
    });
  }
  return row;
}

/**
 * Move a signup's stage by hand. `rostered` is deliberately NOT settable here
 * — it means a real roster row exists, and only `addToRoster` can make that
 * true. Letting the desk mark it by hand would turn the one stage that has a
 * verifiable meaning into a label.
 */
export const setStage = mutation({
  args: { signupId: v.id("volunteerSignups"), stage: stageValidator },
  returns: v.null(),
  handler: async (ctx, { signupId, stage }) => {
    await requireHiringManage(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const row = await loadSignup(ctx, signupId);
    if (stage === "rostered") {
      throw new ConvexError({
        code: "USE_ADD_TO_ROSTER",
        message:
          "\"On the roster\" means a real person record exists — use Add to roster so one gets made.",
      });
    }
    if (row.stage === stage) return null;
    const now = Date.now();
    await ctx.db.patch(signupId, {
      stage,
      stageChangedAt: now,
      handledBy: userId,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Turn a signup into a person on the roster: `isVolunteer`, tagged with the
 * Service Catalog services their picked areas imply, in the caller's chapter.
 *
 * Idempotent-ish by design: a signup already linked to a person is refused
 * rather than creating a second row, and an existing roster row with the same
 * email is REUSED (flipped to `isVolunteer`, its service tags merged) instead
 * of duplicated — the most common real case is someone who already came to an
 * event as a guest.
 */
export const addToRoster = peopleMutation({
  args: { signupId: v.id("volunteerSignups") },
  returns: v.id("people"),
  handler: async (ctx, { signupId }) => {
    await requireHiringManage(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const row = await loadSignup(ctx, signupId);

    if (row.personId) {
      throw new ConvexError({
        code: "ALREADY_ROSTERED",
        message: "This person is already on the roster.",
      });
    }

    // The catalog is org-wide and seeded on demand; this resolves the labels
    // their areas imply to real `serviceOptions` ids, creating the catalog if
    // this deployment has never had one.
    const { labelToId } = await ensureOrgWideServiceCatalog(ctx);
    // PARENT ids only, deliberately un-expanded. A bare parent means "yes,
    // unspecified" in this schema, which is exactly what we know: someone
    // ticked "Music & worship", not "alto". Expanding to every child would
    // tag them as singing four vocal parts and playing six instruments, and a
    // roster tag that isn't true is worse than no tag.
    const serviceIds: Id<"serviceOptions">[] = [];
    for (const label of serviceLabelsForAreas(row.areas)) {
      const id = labelToId.get(label.toLowerCase());
      if (id) serviceIds.push(id);
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .filter((q) => q.eq(q.field("email"), row.email))
      .first();

    let personId: Id<"people">;
    if (existing) {
      const merged = [
        ...new Set([...(existing.serviceIds ?? []), ...serviceIds].map(String)),
      ] as Id<"serviceOptions">[];
      await ctx.db.patch(existing._id, {
        isVolunteer: true,
        // A contact-only row that just became a real volunteer stops being
        // contact-only — otherwise they stay hidden from every roster
        // surface, which is the one place the desk now needs to see them.
        isContactOnly: false,
        serviceIds: merged,
        ...(row.phone && !existing.phone ? { phone: row.phone } : {}),
        ...(row.location && !existing.location ? { location: row.location } : {}),
      });
      personId = existing._id;
    } else {
      personId = await ctx.db.insert("people", {
        chapterId,
        name: row.name,
        email: row.email,
        ...(row.phone ? { phone: row.phone } : {}),
        ...(row.location ? { location: row.location } : {}),
        isVolunteer: true,
        // Unvetted on purpose: a signup is a hand raised, not a background
        // check. Vetting is a human act on the People tab.
        vettingStatus: "unvetted",
        status: "active",
        ...(serviceIds.length ? { serviceIds } : {}),
        ...(row.availability || row.message
          ? {
              notes: [
                row.availability ? `Availability: ${row.availability}` : null,
                row.message,
              ]
                .filter(Boolean)
                .join("\n\n"),
            }
          : {}),
        referralSource: "Volunteer signup (/serve)",
        createdAt: now,
      });
    }

    await ctx.db.patch(signupId, {
      stage: "rostered",
      stageChangedAt: now,
      personId,
      chapterId,
      handledBy: userId,
      updatedAt: now,
    });
    return personId;
  },
});

/** The public form's area list, resolved server-side so a future edit to the
 *  areas doesn't need a landing-site rebuild to reach the desk's filters. */
export const areaCatalog = query({
  args: {},
  returns: v.array(v.object({ id: v.string(), label: v.string() })),
  handler: async (ctx: QueryCtx) => {
    await requireHiringView(ctx);
    return VOLUNTEER_AREAS.map((a) => ({ id: a.id, label: a.label }));
  },
});
