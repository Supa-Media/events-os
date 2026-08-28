/**
 * MARKETING · Blog — every post the org has written, and the way to write one.
 *
 * A post used to be a markdown file in `apps/landing/src/content/blog/`, so
 * publishing the org's public writing was a pull request, a review and a
 * deploy — which meant the seat that owns the public voice could not use it
 * without a developer. Posts are rows now (`marketingBlog.ts`, and the
 * contract in `@events-os/shared/marketingBlog`); this is the index and
 * `BlogPostEditor` is the writing surface.
 *
 * ── Grouped by status, drafts first ─────────────────────────────────────────
 * Not one flat list sorted by date. The three statuses are three different
 * jobs — a draft is work in progress, a published post is a thing on the
 * internet, an archived one is a thing that used to be — and the group a
 * marketer opens this screen for is almost always the first. A single list
 * with a status chip makes "what am I in the middle of?" a scanning exercise.
 *
 * ── Sharing a draft ─────────────────────────────────────────────────────────
 * A draft's "Copy preview link" is the replacement for the landing repo's
 * shared password (which lived in a public `wrangler.jsonc`, covered every
 * draft at once, and could not be revoked for one post). The token is
 * per-post, so it is fetched on demand rather than listed: `listPosts` returns
 * summaries WITHOUT the token or the body on purpose, and pulling fifty
 * essays into the index so one row can build a URL would undo that. One press,
 * one `getPost`.
 *
 * Gated on `marketing.blog.edit` (`canEditBlog`). PUBLISHING is a separate
 * power and lives in the editor — see `BlogPostEditor.tsx`; the banner here
 * only names it, so an editor-only writer learns the shape of the desk before
 * they have written anything rather than at the moment they try to ship.
 */
import { useState } from "react";
import { View, Text } from "react-native";
import { useConvex, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  BLOG_POST_STATUS_LABELS,
  blogPostPath,
  blogPreviewPath,
  type BlogPostStatus,
  type BlogPostSummary,
} from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
  ToastView,
} from "../ui";
import { useActionRunner, type ActionRunner } from "../../lib/useActionToast";
import { publicSiteUrl } from "../event/ticketing/helpers";
import { copyToClipboard } from "../../lib/clipboard";

/** The backend's post id. Aliased once so the whole file speaks in one name
 *  and the cast at the call sites stays a cast, not a story. */
type PostId = Id<"blogPosts">;

/**
 * A row as `listPosts` returns it.
 *
 * `readingMinutes` comes from the SERVER, not from `readingMinutes(body)` here:
 * the estimate is a function of the body, and the summary contract omits the
 * body on purpose (listing fifty posts must not ship fifty essays). Optional
 * on this side so a card renders its date alone rather than a made-up number
 * if the field is ever absent.
 */
type PostRow = BlogPostSummary & { readingMinutes?: number | null };

/** Reading order: what needs work, then what is live, then what used to be. */
const STATUS_ORDER: BlogPostStatus[] = ["draft", "published", "archived"];

const STATUS_BLURBS: Record<BlogPostStatus, string> = {
  draft: "Only reachable through a preview link. Nothing here is public.",
  published: "Live on the site, in the RSS feed, and in the sitemap.",
  archived:
    "Taken down. The link still resolves to a page that says so — a link shared once is shared forever.",
};

const STATUS_TONES: Record<BlogPostStatus, "warn" | "success" | "neutral"> = {
  draft: "warn",
  published: "success",
  archived: "neutral",
};

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * A draft's shareable link, fetched on press.
 *
 * If the system clipboard rejects a copy, the URL is revealed as selectable
 * text instead of silently doing nothing. A "Copied!" that didn't copy is
 * worse than no button at all.
 */
function PreviewLinkAction({
  post,
  run,
}: {
  post: PostRow;
  run: ActionRunner["run"];
}) {
  const convex = useConvex();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function copyLink() {
    setBusy(true);
    await run(
      async () => {
        const full = await convex.query(api.marketingBlog.getPost, {
          postId: post.id as PostId,
        });
        if (!full) throw new Error("That post no longer exists.");
        const link = `${publicSiteUrl()}${blogPreviewPath(full.slug, full.previewToken)}`;
        if (!(await copyToClipboard(link))) setRevealed(link);
      },
      { errorTitle: "Couldn't build a preview link" },
    );
    setBusy(false);
  }

  return (
    <>
      <Button
        title="Copy preview link"
        size="sm"
        variant="ghost"
        icon="link"
        loading={busy}
        onPress={() => void copyLink()}
      />
      {revealed ? (
        <View className="mt-2 w-full flex-row items-center gap-2">
          <Text selectable className="flex-1 text-xs text-muted">
            {revealed}
          </Text>
          <CopyButton text={revealed} label />
        </View>
      ) : null}
    </>
  );
}

/** One post in the index. Deliberately not a link-shaped row: the actions
 *  differ by status (a draft has a preview link, a published post has a public
 *  one), and burying them behind a tap into the editor is what made sharing a
 *  draft a chore in the first place. */
function PostCard({
  post,
  onOpen,
  run,
}: {
  post: PostRow;
  onOpen: () => void;
  run: ActionRunner["run"];
}) {
  const publicUrl = `${publicSiteUrl()}${blogPostPath(post.slug)}`;
  const meta = [
    post.audience,
    post.author,
    post.publishedAt ? formatDate(post.publishedAt) : null,
    post.readingMinutes ? `${post.readingMinutes} min read` : null,
  ].filter(Boolean);

  return (
    <Card padding="md" className="mb-3">
      <View className="mb-1 flex-row items-start gap-2">
        <Text className="flex-1 text-base font-semibold text-ink">
          {post.title.trim() || "Untitled post"}
        </Text>
        <Badge
          label={BLOG_POST_STATUS_LABELS[post.status]}
          tone={STATUS_TONES[post.status]}
        />
      </View>
      {meta.length > 0 ? (
        <Text className="mb-1 text-xs text-faint">{meta.join(" · ")}</Text>
      ) : null}
      {post.description ? (
        <Text className="mb-2 text-sm text-muted" numberOfLines={2}>
          {post.description}
        </Text>
      ) : null}
      <View className="mt-1 flex-row flex-wrap items-center gap-2">
        <Button title="Edit" size="sm" variant="secondary" onPress={onOpen} />
        {post.status === "draft" ? (
          <PreviewLinkAction post={post} run={run} />
        ) : (
          <View className="flex-row items-center gap-2">
            <Text selectable className="text-xs text-muted">
              {blogPostPath(post.slug)}
            </Text>
            <CopyButton text={publicUrl} label />
          </View>
        )}
      </View>
    </Card>
  );
}

export function MarketingBlogView() {
  const router = useRouter();
  const access = useQuery(api.marketingSite.myMarketingAccess, {});
  const canEdit = access?.canEditBlog === true;
  const canPublish = access?.canPublishBlog === true;
  const posts = useQuery(api.marketingBlog.listPosts, canEdit ? {} : "skip");
  const { run, toast, dismiss } = useActionRunner();

  if (access === undefined) return <Screen loading />;
  if (!canEdit) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Blog access needed"
            message="Writing for the blog is the Marketing Director's desk. Ask them or the ED for access."
          />
        </Narrow>
      </Screen>
    );
  }
  if (posts === undefined) return <Screen loading />;

  const rows = posts as PostRow[];

  return (
    <Screen>
      <Narrow>
        <SectionHeader
          title="Blog"
          count={`${rows.length} post${rows.length === 1 ? "" : "s"}`}
          right={
            <Button
              title="New post"
              icon="plus"
              size="sm"
              onPress={() => router.push("/marketing/blog/new" as never)}
            />
          }
        />
        <Text className="mb-4 text-sm text-muted">
          Posts on publicworship.life/blog. Writing and saving is yours; a post
          stays private until somebody publishes it.
        </Text>

        {/* The publish split, said once BEFORE anyone writes 2,000 words —
            discovering it at the moment you try to ship is the version of this
            that feels like a broken button. */}
        {!canPublish ? (
          <Card padding="md" className="mb-4">
            <View className="mb-1 flex-row items-center gap-2">
              <Badge label="Draft access" tone="warn" icon="edit-3" />
            </View>
            <Text className="text-sm text-muted">
              You can write, edit and save any post here. Putting one on the
              public site is a separate call — send the preview link to the
              Marketing Director or the ED and ask them to publish it.
            </Text>
          </Card>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            icon="edit-3"
            title="Nothing written yet"
            message="Start a post — it stays a private draft until it's published, and you can share it with a preview link before then."
          />
        ) : null}

        {STATUS_ORDER.map((status) => {
          const group = rows.filter((p) => p.status === status);
          if (group.length === 0) return null;
          return (
            <View key={status}>
              <SectionHeader
                title={BLOG_POST_STATUS_LABELS[status]}
                count={group.length}
              />
              <Text className="mb-3 text-xs text-muted">
                {STATUS_BLURBS[status]}
              </Text>
              {group.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  run={run}
                  onOpen={() =>
                    router.push(`/marketing/blog/${post.id}` as never)
                  }
                />
              ))}
            </View>
          );
        })}
        <View className="h-10" />
      </Narrow>
      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}
