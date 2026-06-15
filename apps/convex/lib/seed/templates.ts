/**
 * Seed template data + the chapter/roles/templates builder.
 *
 * Holds the large seed-data literals (per-module item rows) and
 * `buildChapterRolesAndTemplates`, the bulk builder shared by `seedDemoData`
 * and `ensureChapters`. Pure helper code (`ctx: any`); not a registered
 * function.
 */
import { Id } from "../../_generated/dataModel";
import {
  DEFAULT_ROLES,
  LIGHTWEIGHT_ROLE_KEYS,
  GRID_CORE_MODULE_KEYS,
} from "@events-os/shared";
import { toSlug, seedTemplateRoles } from "../templates";
import {
  addTemplateItems,
  seedTemplateCols,
  type ItemRow,
} from "./helpers";

/** Seed item rows for the new modules, shared between seedDemoData and backfillNewModules. */
export const PERMIT_ROWS: ItemRow[] = [
  { title: "Maria Hernandez Park Permit", offsetDays: -3, status: "approved", fields: { notes: "Park permit — holder must attend." } },
  { title: "Sound Permit", offsetDays: -3, status: "submitted", fields: { notes: "Amplified-sound permit via precinct officer ~3 days prior." } },
];

// Granular EXPECTATIONS — multiple per team, each tagged to a team value from
// VOLUNTEER_TEAM_OPTIONS. Distilled from eden.md §6 (per-team task lists) and the
// run-of-show setup notes. Columns are title / team / details (no status column).
export const VOLUNTEER_ROWS: ItemRow[] = [
  // 💐 Flower Team
  { title: "Set up flower tables, vases, and linens", fields: { team: "flower", details: "Dress the tables with linens, fill vases, and arrange flowers before guests arrive." } },
  { title: "Lay out blankets + stones seating area", fields: { team: "flower", details: "Set the garden-picnic vibe: blankets and stones for guests to settle on." } },
  // 🍅 Food/Bev Team
  { title: "Set up the grazing table", fields: { team: "food_bev", details: "Arrange charcuterie, plates, napkins, and utensils on the grazing table." } },
  { title: "Keep food + drinks stocked through the event", fields: { team: "food_bev", details: "Monitor levels, refill as needed, and keep the area clean." } },
  // 👋 Welcome Team
  { title: "Greet and direct guests on arrival", fields: { team: "welcome", details: "Welcome people in, point them to food/seating, and keep the entrance flowing." } },
  { title: "Hand out connect cards", fields: { team: "welcome", details: "Offer connect cards to new guests and answer questions." } },
  { title: "Run the merch + QR / donations table", fields: { team: "welcome", details: "Staff the small merch table, take Square payments, share the donations QR." } },
  // 🙏 Prayer Team
  { title: "Hold the prayer station", fields: { team: "prayer", details: "Set up the prayer sign + spot and be available throughout the event." } },
  { title: "Pray with anyone who comes forward", fields: { team: "prayer", details: "Listen and pray one-on-one with guests who want prayer." } },
  // 📷 Content Team
  { title: "Capture photos + video clips throughout the day", fields: { team: "content", details: "Grab candid moments, worship, and setup for recap content." } },
  { title: "Get key b-roll for the recap reel", fields: { team: "content", details: "Wide shots, crowd, and the gospel moment for the post-event clip." } },
];

export const RETRO_ROWS: ItemRow[] = [
  { title: "What went well?", status: "open" },
];

/**
 * Bootstrap a chapter's roles + default templates (the "group types"): the 4
 * editable default roles and the three event types — Eden (full), Love Thy
 * Neighbor (derived from Eden), and Worship With Strangers (lightweight). Shared
 * by `seedDemoData` and `ensureChapters` so both produce identical content.
 *
 * Creates NO people, membership, or sample events. Returns the created ids the
 * caller needs to attach a sample event/roster.
 */
export async function buildChapterRolesAndTemplates(
  ctx: any,
  chapterId: Id<"chapters">,
  createdBy: Id<"users">,
  now: number,
): Promise<{
  edenId: Id<"eventTypes">;
  ltnId: Id<"eventTypes">;
  wwsId: Id<"eventTypes">;
}> {
  // ── Eden template (full) ───────────────────────────────────────────────────
  const edenId = (await ctx.db.insert("eventTypes", {
    chapterId,
    name: "Eden",
    slug: toSlug("Eden"),
    description:
      "Full-scale flagship gathering: worship, message, ministry, and community activity.",
    // Eden runs every grid core module — nothing disabled (site_map stays on).
    disabledCoreModules: [],
    version: 1,
    isArchived: false,
    createdBy,
    createdAt: now,
    updatedAt: now,
  })) as Id<"eventTypes">;

  // Eden owns the 4 default roles. Item rows resolve their role KEY to these ids.
  const edenRoleByKey = await seedTemplateRoles(ctx, edenId, DEFAULT_ROLES);

  for (const m of GRID_CORE_MODULE_KEYS) {
    await seedTemplateCols(ctx, edenId, m);
  }

  await addTemplateItems(ctx, edenId, "planning_doc", [
    { title: "Draft planning doc + budget", offsetDays: -21, role: "event_lead", fields: { details: "Spin up the doc, set the budget, line up the meeting cadence." } },
    { title: "Confirm venue + file permits", offsetDays: -21, role: "event_lead", fields: { details: "Lock the park, file the sound permit, identify a weather backup." } },
    { title: "Reach out to music team for worship leaders + band", offsetDays: -14, role: "comms_lead", fields: { details: "Confirm 1–2 worship leaders + instrumentalists; send the song bank." } },
    { title: "Open volunteer sign-ups + brief", offsetDays: -14, role: "comms_lead" },
    { title: "Flyer + social push", offsetDays: -7, role: "comms_lead" },
    { title: "Confirm production / AV plan", offsetDays: -7, role: "production_lead", fields: { details: "Sound setup + power plan; contract videographer/photographer." } },
    { title: "Confirm supplies + packing checklist", offsetDays: -3, role: "logistics_lead" },
    { title: "Charge batteries + pack gear (night before)", offsetDays: -1, role: "logistics_lead" },
    { title: "Day-of setup + soundcheck", offsetDays: 0, role: "production_lead" },
    { title: "Retro + capture learnings", offsetDays: 2, role: "event_lead" },
  ], edenRoleByKey);

  await addTemplateItems(ctx, edenId, "supplies", [
    { title: "2 x Shure SM58 Mics", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", qty: 2, notes: "With WWS audio kit" } },
    { title: "Mixer", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", qty: 1 } },
    { title: "4 x XLR Cabling", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", qty: 4 } },
    { title: "1 x ALTO 600W Speaker", status: "pull_from_storage", fields: { source: "storage", container: "on_its_own", qty: 1 } },
    { title: "1 x Charged 200W Battery", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", qty: 1, notes: "Needs charging the night before" } },
    { title: "100 x Red Napkins", status: "need_to_buy", fields: { source: "buy_in_store", container: "cooler", qty: 100 } },
    { title: "Charcuterie supplies", status: "need_to_order", fields: { source: "order_online", container: "cooler" } },
  ], edenRoleByKey);

  await addTemplateItems(ctx, edenId, "comms", [
    { title: "Reach out to marketing for flyer", offsetDays: -14, role: "comms_lead", fields: { channel: ["team_slack"], audience: ["leaders"], notes: "Hey [marketing], we're hosting Eden on [date] — can you create a flyer?" } },
    { title: "Ensure intro thread created", offsetDays: -13, role: "comms_lead", fields: { channel: ["team_slack"], audience: ["leaders"] } },
    { title: "Announce event on socials", offsetDays: -7, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"] } },
    { title: "Send a reminder to be on time", offsetDays: -3, role: "comms_lead", fields: { channel: ["imessage_group", "team_slack"], audience: ["leaders", "musicians"] } },
    { title: "Location + how to find us (day-of)", offsetDays: 0, role: "comms_lead", fields: { channel: ["ig_stories", "imessage_group"], audience: ["attendees", "general_public"] } },
    { title: "Post recap content", offsetDays: 3, role: "comms_lead", fields: { channel: ["ig_post"], audience: ["general_public"], notes: "Marketing decides exact timing — record what landed." } },
  ], edenRoleByKey);

  await addTemplateItems(ctx, edenId, "run_of_show", [
    { title: "Load-in / Setup", offsetMinutes: -120, role: "logistics_lead" },
    { title: "Soundcheck", offsetMinutes: -75, role: "production_lead" },
    { title: "Volunteer huddle + prayer", offsetMinutes: -30, role: "event_lead" },
    { title: "Doors / soft start", offsetMinutes: 0, role: "event_lead" },
    { title: "Worship set", offsetMinutes: 15, role: "production_lead" },
    { title: "Message / Scripture", offsetMinutes: 45, role: "event_lead" },
    { title: "Prayer / Ministry", offsetMinutes: 70, role: "event_lead" },
    { title: "Community activity", offsetMinutes: 90, role: "comms_lead" },
    { title: "Closing / Gospel + next steps", offsetMinutes: 115, role: "event_lead", fields: { notes: "Give the Gospel: we're all sinners; Jesus came and died for us so all who believe in Him are saved. Invite to connect + follow socials." } },
    { title: "Strike / Load-out", offsetMinutes: 130, role: "logistics_lead" },
  ], edenRoleByKey);

  await addTemplateItems(ctx, edenId, "permits", PERMIT_ROWS, edenRoleByKey);
  await addTemplateItems(ctx, edenId, "volunteer_expectations", VOLUNTEER_ROWS, edenRoleByKey);
  await addTemplateItems(ctx, edenId, "retro", RETRO_ROWS, edenRoleByKey);

  // ── Love Thy Neighbor (derived from Eden — same structure) ─────────────────
  const ltnId = (await ctx.db.insert("eventTypes", {
    chapterId,
    name: "Love Thy Neighbor",
    slug: toSlug("Love Thy Neighbor"),
    description:
      "Annual neighbor-facing outreach — same structure as Eden, derived from it.",
    deriveFromEventTypeId: edenId,
    disabledCoreModules: [],
    version: 1,
    isArchived: false,
    createdBy,
    createdAt: now,
    updatedAt: now,
  })) as Id<"eventTypes">;
  // Clone Eden's roles, columns + items so LTN starts structurally aligned.
  // Item roleIds are remapped from Eden's role ids to LTN's own copies.
  const edenRoles = await ctx.db
    .query("templateRoles")
    .withIndex("by_template", (q: any) => q.eq("eventTypeId", edenId))
    .collect();
  const ltnRoleIdMap = new Map<string, Id<"templateRoles">>();
  for (const r of edenRoles) {
    const { _id, _creationTime, eventTypeId: _e, ...rest } = r as any;
    const newId = (await ctx.db.insert("templateRoles", {
      eventTypeId: ltnId,
      ...rest,
    })) as Id<"templateRoles">;
    ltnRoleIdMap.set(String(_id), newId);
  }
  const edenCols = await ctx.db
    .query("templateColumns")
    .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", edenId))
    .collect();
  for (const c of edenCols) {
    const { _id, _creationTime, eventTypeId: _e, ...rest } = c as any;
    await ctx.db.insert("templateColumns", { eventTypeId: ltnId, ...rest });
  }
  const edenItems = await ctx.db
    .query("templateItems")
    .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", edenId))
    .collect();
  for (const it of edenItems) {
    const { _id, _creationTime, eventTypeId: _e, ...rest } = it as any;
    await ctx.db.insert("templateItems", {
      eventTypeId: ltnId,
      ...rest,
      roleId: rest.roleId ? ltnRoleIdMap.get(String(rest.roleId)) : undefined,
    });
  }

  // ── Worship With Strangers (lightweight; trimmed supplies columns) ─────────
  const wwsId = (await ctx.db.insert("eventTypes", {
    chapterId,
    name: "Worship With Strangers",
    slug: toSlug("Worship With Strangers"),
    description:
      "Lightweight pop-up worship — a ~10% scaled-down variant of Eden, run by a 2–3 person team. The most important, most repeatable event.",
    deriveFromEventTypeId: edenId,
    // WWS is lightweight: it skips volunteer_expectations (and keeps the rest +
    // site_map on, matching its prior trimmed module set).
    disabledCoreModules: ["volunteer_expectations"],
    version: 1,
    isArchived: false,
    createdBy,
    createdAt: now,
    updatedAt: now,
  })) as Id<"eventTypes">;

  // WWS owns only the 3 lightweight roles.
  const wwsRoleSeeds = DEFAULT_ROLES.filter((r) =>
    LIGHTWEIGHT_ROLE_KEYS.includes(r.key),
  );
  const wwsRoleByKey = await seedTemplateRoles(ctx, wwsId, wwsRoleSeeds);

  await seedTemplateCols(ctx, wwsId, "planning_doc");
  // WWS trims supplies down to what the team actually tracks (per the convo).
  await seedTemplateCols(ctx, wwsId, "supplies", ["qty", "owner", "role"]);
  await seedTemplateCols(ctx, wwsId, "comms");
  await seedTemplateCols(ctx, wwsId, "run_of_show");
  await seedTemplateCols(ctx, wwsId, "permits");
  await seedTemplateCols(ctx, wwsId, "retro");

  await addTemplateItems(ctx, wwsId, "planning_doc", [
    { title: "Update event date + create thread", offsetDays: -14, role: "event_lead", fields: { details: "Update the event date; start the WWS thread tagging owners." } },
    { title: "Highlight in monthly team meeting", offsetDays: -13, role: "event_lead", fields: { details: "Where it's happening this month + who's leading." } },
    { title: "Scout + confirm location", offsetDays: -12, role: "event_lead", fields: { details: "Identify a public spot + a weather/permitting backup; visit in person if possible (optional)." } },
    { title: "Check permits + public-space rules", offsetDays: -12, role: "event_lead" },
    { title: "Reach out to music leader to confirm worship leaders + band", offsetDays: -11, role: "comms_lead", fields: { details: "1–2 worship leaders + instrumentalists (keyboard and/or guitar, cajon optional). Put names + numbers in notes. Send the song bank." } },
    { title: "Announce event on socials", offsetDays: -7, role: "comms_lead" },
    { title: "Get all items from storage", offsetDays: -1, role: "logistics_lead", fields: { details: "Items live in the black/green luggage — just open and confirm everything's there." } },
    { title: "Make sure battery is charged", offsetDays: -1, role: "logistics_lead", fields: { details: "After bringing the battery out of storage, someone takes it home to charge — there's no charger in storage." } },
    { title: "Assign someone to set up sound day-of", offsetDays: 0, role: "event_lead" },
    { title: "Bring water for worship leaders + band", offsetDays: 0, role: "logistics_lead", fields: { cost: 20 } },
    { title: "Order food for worship leaders + volunteers", offsetDays: 0, role: "comms_lead", fields: { details: "~$20/person.", cost: 80 } },
    { title: "Hire videographer for clips", offsetDays: -10, role: "comms_lead", fields: { details: "iPhone footage is fine; ~$150 if hiring.", cost: 150 } },
  ], wwsRoleByKey);

  await addTemplateItems(ctx, wwsId, "supplies", [
    { title: "2 x Shure SM58 Mics", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", notes: "With WWS audio kit" } },
    { title: "Mixer", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage" } },
    { title: "4 x XLR Cabling", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage" } },
    { title: "1 x ALTO 600W Speaker", status: "pull_from_storage", fields: { source: "storage", container: "on_its_own" } },
    { title: "1 x Charged 200W Battery", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage", notes: "Charge the night before" } },
    { title: "Battery Charger", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage" } },
    { title: "2 x QR Code Signs", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage" } },
    { title: "Small table", status: "pull_from_storage", fields: { source: "storage", container: "green_luggage" } },
  ], wwsRoleByKey);

  await addTemplateItems(ctx, wwsId, "comms", [
    { title: "Reach out to marketing for flyer", offsetDays: -14, role: "comms_lead", fields: { channel: ["team_slack"], audience: ["leaders"] } },
    { title: "Ensure intro thread created for WWS", offsetDays: -13, role: "comms_lead", fields: { channel: ["team_slack"], audience: ["leaders"], notes: "New thread: \"WWS [date] @Owner1, @Owner2\"" } },
    { title: "Announce event on socials", offsetDays: -7, role: "comms_lead", fields: { channel: ["ig_post", "ig_stories"], audience: ["general_public"] } },
    { title: "Reminder to be on time for leaders + musicians", offsetDays: -3, role: "comms_lead", fields: { channel: ["imessage_group", "team_slack"], audience: ["leaders", "musicians"], notes: "Friendly reminder WWS is at [location] [time] — show up ready to help set up." } },
    { title: "Day-before reminder with call time", offsetDays: -1, role: "comms_lead", fields: { channel: ["imessage_group"], audience: ["musicians"] } },
    { title: "Location + how to find us (day-of)", offsetDays: 0, role: "comms_lead", fields: { channel: ["ig_stories", "imessage_group"], audience: ["attendees", "general_public"], notes: "Pin the exact meet spot, what to look for, start time." } },
    { title: "Post a clip from the day", offsetDays: 3, role: "comms_lead", fields: { channel: ["ig_post"], audience: ["general_public"] } },
  ], wwsRoleByKey);

  await addTemplateItems(ctx, wwsId, "run_of_show", [
    { title: "Load-in / Setup", offsetMinutes: -60, role: "logistics_lead", fields: { notes: "Connect keyboard + recorder, then mics. Busking setup." } },
    { title: "Soundcheck", offsetMinutes: -30, role: "event_lead", fields: { notes: "Track playback, mic check levels." } },
    { title: "Team huddle + prayer", offsetMinutes: -10, role: "event_lead", fields: { notes: "Encouragement, have fun, worship boldly." } },
    { title: "Worship set", offsetMinutes: 0, role: "event_lead", fields: { notes: "Spontaneous worship — no set list." } },
    { title: "Closing / Gospel + next steps", offsetMinutes: 40, role: "event_lead", fields: { notes: "Give the Gospel: we're all sinners; Jesus came and died for us so all who believe in Him are saved. Invite to connect + follow socials." } },
    { title: "Strike / Load-out", offsetMinutes: 55, role: "logistics_lead" },
  ], wwsRoleByKey);

  await addTemplateItems(ctx, wwsId, "permits", [
    { title: "Public-space / sound permit", offsetDays: -3, status: "to_apply", fields: { notes: "Check the park's amplified-sound rules; apply if required." } },
  ], wwsRoleByKey);

  return { edenId, ltnId, wwsId };
}
