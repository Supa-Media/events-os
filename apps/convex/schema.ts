import { defineSchema } from "convex/server";
import { supaAuthTables, supaNotificationTables } from "@supa-media/convex/schema";

import { chapters, userProfiles, userChapters } from "./schema/chapters";
import { guestAllowlist } from "./schema/guests";
import { templateRoles, eventRoles } from "./schema/roles";
import { templateModules, eventModules } from "./schema/modules";
import { eventTypes, templateColumns, templateItems } from "./schema/templates";
import {
  events,
  eventColumns,
  eventItems,
  roleAssignments,
} from "./schema/events";
import { people, engagements, templatePeople } from "./schema/people";
import { songs, setlistEntries, songRequests } from "./schema/songs";
import { docs } from "./schema/docs";
import { siteMarkers, siteShapes, siteMapPlacements } from "./schema/siteMap";
import {
  aiRuns,
  aiChanges,
  aiThreads,
  aiMessages,
  aiUsage,
  aiSettings,
} from "./schema/ai";

/**
 * Database schema for Events OS.
 *
 * Framework base tables: auth (`users` + @convex-dev/auth), multi-tenant by
 * `chapter` (`chapters` + `userChapters`), and push notifications.
 *
 * App tables use a UNIFIED ITEMS model. Every planning surface — planning doc,
 * supplies, comms, run-of-show — is a "module": a list of items rendered through
 * a configurable column set.
 *
 *   Roles            → roles (editable per chapter)
 *   Event Type/Template → eventTypes (+ templateColumns, templateItems)
 *   Event            → events (+ eventColumns, eventItems, roleAssignments)
 *   Person/Volunteer → people
 *
 * Templates are extensible (authors add/hide/reorder columns + items). Events
 * clone the template's columns AND items at creation, so they're insulated from
 * later template edits and stay locked-but-editable. The fields the backend
 * computes on (title, offset, status, role, owner, due date) are promoted to
 * typed columns on each item; everything else lives in the `fields` bag.
 *
 * Chapter scoping is on every app table from day one (multi-city is V3).
 *
 * Table definitions are grouped per domain under `schema/`; this file is the
 * thin composition root that assembles them into a single schema.
 */
const schema = defineSchema({
  ...supaAuthTables,
  ...supaNotificationTables,

  // Chapters (tenants) + user profile/membership.
  chapters,
  userProfiles,
  userChapters,

  // Guest allowlist (non-domain emails granted access, seeded from Convex).
  guestAllowlist,

  // Roles (template-owned + event-owned).
  templateRoles,
  eventRoles,

  // Custom modules (template-owned + event-owned). Core modules are constants.
  templateModules,
  eventModules,

  // Templates (event types + their columns/items).
  eventTypes,
  templateColumns,
  templateItems,

  // Events (instances + their columns/items + role assignments).
  events,
  eventColumns,
  eventItems,
  roleAssignments,

  // People (roster) + engagements + template placeholder crew.
  people,
  engagements,
  templatePeople,

  // Songs (chapter library) + per-event setlists + public song requests.
  songs,
  setlistEntries,
  songRequests,

  // Docs (the standalone targets behind How-To cells).
  docs,

  // Site map (markers, shapes, placements).
  siteMarkers,
  siteShapes,
  siteMapPlacements,

  // AI (runs, changes, threads, messages, usage, settings).
  aiRuns,
  aiChanges,
  aiThreads,
  aiMessages,
  aiUsage,
  aiSettings,
});

export default schema;
