import { internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { PROJECT_STATUS_LABELS } from "@events-os/shared";
import {
  academyCoursePreview,
  academyModulePreview,
  buildCardResponse,
  parseChapterOsTarget,
  type ChapterOsTarget,
  type LinkPreviewResponse,
} from "./lib/googleChatLinkPreview";
import { appUrl } from "./lib/siteUrl";

export const nativePreviewForUrl = internalQuery({
  args: {
    url: v.string(),
    userEmail: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { url, userEmail }): Promise<LinkPreviewResponse | null> => {
    const target = parseChapterOsTarget(url, process.env.APP_URL);
    if (!target) return null;
    const buttonUrl = appUrl(pathForTarget(target)) ?? url;

    if (target.kind === "project") {
      const id = ctx.db.normalizeId("projects", target.id);
      if (!id) return null;
      const project = await ctx.db.get(id);
      if (!project) return null;
      const [owner, chapter] = await Promise.all([
        project.ownerPersonId ? ctx.db.get(project.ownerPersonId) : null,
        ctx.db.get(project.chapterId),
      ]);
      return buildCardResponse({
        cardId: "chapter-os-project",
        title: project.name,
        subtitle: "Chapter OS - Project",
        body: project.purpose ?? null,
        fields: [
          { label: "Status", value: PROJECT_STATUS_LABELS[project.status] },
          { label: "Owner", value: owner?.name },
          { label: "Chapter", value: chapter?.name },
          { label: "Dates", value: projectDates(project) },
        ],
        buttonText: "Open in Chapter OS",
        buttonUrl,
      });
    }

    if (target.kind === "academyCourse") {
      const course = academyCoursePreview(target.slug);
      if (!course) return null;
      const progress = await courseProgressForEmail(ctx, userEmail, target.slug);
      return buildCardResponse({
        cardId: "chapter-os-academy-course",
        title: course.title,
        subtitle: "Chapter OS - Academy course",
        body: course.description,
        fields: [
          { label: "Level", value: titleCase(course.level) },
          {
            label: "Modules",
            value: `${course.moduleCount} total, ${course.requiredCount} required`,
          },
          { label: "Your progress", value: progress },
        ],
        buttonText: "Open course",
        buttonUrl,
      });
    }

    if (target.kind === "academyModule") {
      const section = academyModulePreview(target.slug);
      if (!section) return null;
      const progress = await moduleProgressForEmail(ctx, userEmail, target.slug);
      return buildCardResponse({
        cardId: "chapter-os-academy-module",
        title: section.title,
        subtitle: "Chapter OS - Academy module",
        body: section.description,
        fields: [
          { label: "Course", value: section.courseTitle },
          { label: "Length", value: `${section.minutes} min` },
          {
            label: "Type",
            value: section.isCapstone
              ? section.optional
                ? "Optional capstone"
                : "Capstone"
              : "Lesson",
          },
          { label: "Your progress", value: progress },
        ],
        buttonText: "Open module",
        buttonUrl,
      });
    }

    const id = ctx.db.normalizeId("people", target.id);
    if (!id) return null;
    const person = await ctx.db.get(id);
    if (!person) return null;
    const [chapter, reports, ownedProjects, ownedEvents, serviceNames] =
      await Promise.all([
        ctx.db.get(person.chapterId),
        ctx.db
          .query("people")
          .withIndex("by_manager", (q) => q.eq("managerId", person._id))
          .take(4),
        ctx.db
          .query("projects")
          .withIndex("by_owner", (q) => q.eq("ownerPersonId", person._id))
          .take(4),
        ctx.db
          .query("events")
          .withIndex("by_chapter_and_ownerPersonId", (q) =>
            q.eq("chapterId", person.chapterId).eq("ownerPersonId", person._id),
          )
          .take(4),
        serviceLabels(ctx, person),
      ]);
    return buildCardResponse({
      cardId: "chapter-os-person",
      title: person.name,
      subtitle: "Chapter OS - Team",
      fields: [
        { label: "Role", value: person.role ?? serviceNames },
        { label: "Chapter", value: chapter?.name },
        {
          label: "Related work",
          value: relatedWorkSummary(
            ownedProjects.length,
            ownedEvents.length,
            reports.length,
          ),
        },
      ],
      buttonText: "Open in Chapter OS",
      buttonUrl,
    });
  },
});

function pathForTarget(target: ChapterOsTarget): string {
  if (target.kind === "project") return `/project/${target.id}`;
  if (target.kind === "academyCourse") return `/academy/course/${target.slug}`;
  if (target.kind === "academyModule") return `/academy/${target.slug}`;
  return `/team/${target.id}`;
}

function projectDates(project: Doc<"projects">): string | null {
  const start = project.startDate ? shortDate(project.startDate) : null;
  const deadline = project.deadline ? shortDate(project.deadline) : null;
  if (start && deadline) return `${start} to ${deadline}`;
  if (deadline) return `Due ${deadline}`;
  if (start) return `Started ${start}`;
  return null;
}

function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function userAndPersonForEmail(
  ctx: QueryCtx,
  email: string | null,
): Promise<{ chapterId: Id<"chapters">; personId: Id<"people"> } | null> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  const users = await ctx.db.query("users").take(1000);
  const user = users.find((u) => u.email?.toLowerCase() === normalized);
  if (!user) return null;
  const membership = await ctx.db
    .query("userChapters")
    .withIndex("by_userId", (q) => q.eq("userId", user._id))
    .first();
  if (!membership) return null;
  const person = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect()
    .then((rows) =>
      rows.find(
        (p) => p.chapterId === membership.chapterId && p.isPlaceholder !== true,
      ),
    );
  if (!person) return null;
  return { chapterId: membership.chapterId, personId: person._id };
}

async function courseProgressForEmail(
  ctx: QueryCtx,
  email: string | null,
  courseSlug: string,
): Promise<string | null> {
  const actor = await userAndPersonForEmail(ctx, email);
  if (!actor) return null;
  const completion = await ctx.db
    .query("courseCompletions")
    .withIndex("by_chapter_and_person", (q) =>
      q.eq("chapterId", actor.chapterId).eq("personId", actor.personId),
    )
    .collect()
    .then((rows) => rows.find((row) => row.courseSlug === courseSlug));
  return completion
    ? `Earned ${shortDate(completion.earnedAt)}`
    : "Not earned yet";
}

async function moduleProgressForEmail(
  ctx: QueryCtx,
  email: string | null,
  sectionSlug: string,
): Promise<string | null> {
  const actor = await userAndPersonForEmail(ctx, email);
  if (!actor) return null;
  const row = await ctx.db
    .query("academyProgress")
    .withIndex("by_chapter_and_person", (q) =>
      q.eq("chapterId", actor.chapterId).eq("personId", actor.personId),
    )
    .collect()
    .then((rows) => rows.find((progress) => progress.sectionSlug === sectionSlug));
  if (!row) return "Not started";
  if (row.passedAt) return `Passed ${shortDate(row.passedAt)}`;
  if (row.readAt) return "Read, quiz not passed";
  return "Not started";
}

async function serviceLabels(
  ctx: QueryCtx,
  person: Doc<"people">,
): Promise<string | null> {
  const ids = person.serviceIds?.slice(0, 3) ?? [];
  if (ids.length === 0) return null;
  const labels: string[] = [];
  for (const id of ids) {
    const row = await ctx.db.get(id);
    if (!row) continue;
    if (row.parentId) {
      const parent = await ctx.db.get(row.parentId);
      labels.push(parent ? `${parent.name}: ${row.name}` : row.name);
    } else {
      labels.push(row.name);
    }
  }
  return labels.length ? labels.join(", ") : null;
}

function relatedWorkSummary(
  projectCount: number,
  eventCount: number,
  reportCount: number,
): string | null {
  const parts: string[] = [];
  if (projectCount) {
    parts.push(`${projectCount} owned project${projectCount === 1 ? "" : "s"}`);
  }
  if (eventCount) {
    parts.push(`${eventCount} owned event${eventCount === 1 ? "" : "s"}`);
  }
  if (reportCount) {
    parts.push(
      `${reportCount} direct report${reportCount === 1 ? "" : "s"}`,
    );
  }
  return parts.length ? parts.join(", ") : null;
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).replace(/_/g, " ");
}
