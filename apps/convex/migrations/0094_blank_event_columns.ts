import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { internal } from "../_generated/api";
import { BLANK_TEMPLATE_SLUG, ensureBlankEventColumns } from "../lib/templates";

/** Repair existing scratch events without changing their tasks or layouts.
 * One bounded page per transaction; continuations are safe to replay. */
export async function runBlankEventColumnsPage(
  ctx: MutationCtx,
  cursor: string | null,
  pageSize = 25,
): Promise<{ added: number; isDone: boolean }> {
  const page = await ctx.db.query("events").paginate({ numItems: pageSize, cursor });
  let added = 0;
  for (const event of page.page) {
    const template = await ctx.db.get(event.eventTypeId);
    if (template?.isBlank || template?.slug === BLANK_TEMPLATE_SLUG) {
      added += await ensureBlankEventColumns(ctx, event);
    }
  }
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.migrations.continueBlankEventColumns, {
      cursor: page.continueCursor,
    });
  }
  return { added, isDone: page.isDone };
}

export const blankEventColumns: Migration = {
  name: "0094_blank_event_columns",
  run: (ctx) => runBlankEventColumnsPage(ctx, null),
};
