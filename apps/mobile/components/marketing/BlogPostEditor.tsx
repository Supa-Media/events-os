/**
 * MARKETING · Blog — one post: write it, save it, and (separately) publish it.
 *
 * The long-form half of the desk. `BlogView` is the index; this is where the
 * writing happens, for both a brand-new post and an existing one — one form,
 * because they are the same fields and a second copy of them is a second place
 * to forget a bound.
 *
 * ── NOT LOSING SOMEBODY'S WRITING ───────────────────────────────────────────
 * The worst bug this screen could have is a save that fails and takes 2,000
 * words with it. Three decisions, together, make that impossible:
 *
 *   1. The form owns ONE local `draft` object, seeded from the server copy at
 *      mount and never re-seeded while the screen is open. `useQuery` is live,
 *      so an effect that re-synced on every server change would overwrite the
 *      writer's paragraph the moment anyone touched the row. (The trade-off is
 *      real and deliberate: a concurrent edit by someone else is NOT pulled in
 *      — reopening the post is how you see it. Losing a keystroke someone
 *      typed is worse than showing a stale copy of one they didn't.)
 *   2. A failed save changes NOTHING. `run(...)` surfaces the error and
 *      returns; the draft is untouched, so the fix is "press Save again", not
 *      "retype it". Only `onSuccess` moves the saved baseline.
 *   3. The baseline moves to the SNAPSHOT that was sent, not to whatever the
 *      draft holds when the promise resolves — so words typed during a slow
 *      save stay marked unsaved instead of being quietly counted as saved.
 *
 * An explicit "Unsaved changes" marker sits next to every Save button, and the
 * publish action refuses to run while it is showing (see `PublishCard`):
 * publishing publishes what was SAVED, and a button that puts a stale version
 * on the internet while the good one sits in the box is a trap.
 *
 * ── The publish split ───────────────────────────────────────────────────────
 * `marketing.blog.edit` writes; `marketing.blog.publish` ships. A writer with
 * only the first gets the full editor and NO publish button — not a disabled
 * one, not one that throws — plus a line naming who to ask. A power you can
 * see but not use is a better experience than a power that lies, and both are
 * worse than being told plainly whose call it is.
 *
 * ── Archive, not delete ─────────────────────────────────────────────────────
 * A published post is taken down with Archive: the URL keeps resolving, to a
 * page that says the post was taken down. Delete is offered only for a post
 * that was never public. `deletePost` refuses a published one anyway — this
 * is the half that teaches it instead of letting someone find out by error.
 */
import { useState } from "react";
import { ActivityIndicator, Image, Platform, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import {
  BLOG_AUDIENCE_MAX,
  BLOG_AUTHOR_MAX,
  BLOG_BODY_MAX,
  BLOG_DEFAULT_AUTHOR,
  BLOG_DESCRIPTION_MAX,
  BLOG_POST_STATUS_LABELS,
  BLOG_SLUG_RULE,
  BLOG_SUBTITLE_MAX,
  BLOG_TAGS_MAX_COUNT,
  BLOG_TAG_MAX,
  BLOG_TITLE_MAX,
  blogPostPath,
  blogPreviewPath,
  blogSlugFromTitle,
  readingMinutes,
  type BlogPost,
  type BlogPostStatus,
} from "@events-os/shared";
import {
  BackLink,
  Badge,
  Button,
  Card,
  CheckboxRow,
  CopyButton,
  EmptyState,
  Narrow,
  OptionTag,
  Screen,
  SectionHeader,
  TextField,
  ToastView,
} from "../ui";
import { MarkdownEditor } from "../markdown";
import { useActionRunner, type ActionRunner } from "../../lib/useActionToast";
import { confirmAction } from "../../lib/confirmAction";
import { publicSiteUrl } from "../event/ticketing/helpers";

/** The backend's post id — aliased once, see `BlogView.tsx`. */
type PostId = Id<"blogPosts">;

/** What `getPost` returns: the summary fields, the body, and the one thing
 *  the index deliberately doesn't carry. */
type FullPost = BlogPost & { previewToken: string };

const STATUS_TONES: Record<BlogPostStatus, "warn" | "success" | "neutral"> = {
  draft: "warn",
  published: "success",
  archived: "neutral",
};

/**
 * A blank post's fields.
 *
 * The hero image is THREE-STATE, the rule `LinksView.tsx`'s `EMPTY_DRAFT`
 * writes down and the reason its first cut deleted an image on a rename:
 *
 *   `heroPending` set   a file uploaded this session, saved with the post
 *   `heroCleared` true  remove whatever the post has
 *   neither             leave it alone
 *
 * The form never learns the bytes behind a saved hero, so "not sent" has to
 * mean KEEP; `upsertPost`'s `heroStorage` / `clearHero` pair is the backend
 * half of the same rule.
 */
const EMPTY_DRAFT = {
  title: "",
  description: "",
  subtitle: "",
  audience: "",
  author: BLOG_DEFAULT_AUTHOR,
  body: "",
  tags: [] as string[],
  reactionsEnabled: true,
  heroPending: null as string | null,
  heroCleared: false,
};

type Draft = typeof EMPTY_DRAFT;

function draftFrom(post: FullPost): Draft {
  return {
    title: post.title,
    description: post.description,
    subtitle: post.subtitle ?? "",
    audience: post.audience ?? "",
    author: post.author,
    body: post.body,
    tags: post.tags,
    reactionsEnabled: post.reactionsEnabled,
    heroPending: null,
    heroCleared: false,
  };
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * A text field with a live counter that turns red BEFORE the bound rather than
 * after the throw — `SiteView.tsx`'s `CopyField` pattern.
 *
 * No `maxLength`: a hard cap silently swallows the tail of a pasted headline,
 * and a writer who can't see the characters they lost can't fix them. The
 * counter warns, the count goes red, and Save refuses while it's over — so the
 * text is always in front of the person who has to shorten it.
 */
function CountedField({
  label,
  value,
  onChangeText,
  max,
  hint,
  multiline,
  numberOfLines,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  max: number;
  hint?: string;
  multiline?: boolean;
  numberOfLines?: number;
  placeholder?: string;
}) {
  const over = value.length > max;
  // 90% is the "you're nearly there" line — early enough to steer a sentence,
  // late enough that a normal title never sees it.
  const near = !over && value.length >= Math.floor(max * 0.9);
  return (
    <View className="mb-1">
      <TextField
        label={label}
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        numberOfLines={numberOfLines}
        placeholder={placeholder}
      />
      <View className="mb-3 -mt-1 flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-xs text-muted">{hint ?? ""}</Text>
        <Text
          className={`text-xs ${over || near ? "text-danger" : "text-faint"}`}
        >
          {value.length}/{max}
        </Text>
      </View>
    </View>
  );
}

/**
 * The hero image slot.
 *
 * Same deferred-upload flow as `CardImagePicker` (upload now, hand the
 * `storageId` to the form, save it with the post — a picker that saved on its
 * own would give one post two save paths), through
 * `marketingBlog.generateHeroUploadUrl` so the desk's uploads carry the desk's
 * power rather than "any signed-in user".
 *
 * It is a copy of that flow rather than a call to it because `CardImagePicker`
 * bakes in `marketingSite.generateLinkImageUploadUrl` and the Important-Links
 * wording, and it belongs to the Links change, not this one. The honest fix
 * when someone next touches it is a `generateUploadUrl` prop and one shared
 * picker; this file is the second caller that proves the prop is worth adding.
 */
function HeroImagePicker({
  current,
  pending,
  onPicked,
  onCleared,
  run,
}: {
  /** What the post shows today, or null. */
  current: string | null;
  /** A storage id chosen this session but not yet saved. */
  pending: string | null;
  onPicked: (storageId: string) => void;
  onCleared: () => void;
  run: ActionRunner["run"];
}) {
  const generateUploadUrl = useMutation(api.marketingBlog.generateHeroUploadUrl);
  const [uploading, setUploading] = useState(false);

  async function uploadBlob(blob: Blob, contentType: string) {
    setUploading(true);
    try {
      await run(
        async () => {
          const uploadUrl = await generateUploadUrl();
          const res = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: blob,
          });
          const { storageId } = await res.json();
          onPicked(storageId as string);
        },
        { errorTitle: "Couldn't upload that image" },
      );
    } finally {
      setUploading(false);
    }
  }

  function pickWeb() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void uploadBlob(file, file.type || "image/jpeg");
    };
    input.click();
  }

  async function pickNative() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    await uploadBlob(blob, asset.mimeType || blob.type || "image/jpeg");
  }

  const has = Boolean(pending || current);
  return (
    <View className="mb-3">
      <Text className="mb-1 text-sm font-semibold text-ink">Hero image</Text>
      <Text className="mb-2 text-xs text-muted">
        Sits above the title, and is the picture that shows when the post is
        shared on social. Wide crops read best.
      </Text>
      <View className="flex-row items-center gap-3">
        {/* A just-uploaded image has no servable URL yet (the post hasn't been
            saved), so it's labelled rather than rendered as a broken frame. */}
        {pending ? (
          <View className="h-14 w-20 items-center justify-center rounded-md border border-border bg-surface">
            <Text className="text-[10px] text-muted">New</Text>
          </View>
        ) : current ? (
          <Image
            source={{ uri: current }}
            className="h-14 w-20 rounded-md border border-border"
            resizeMode="cover"
          />
        ) : null}
        {uploading ? <ActivityIndicator size="small" /> : null}
        <Button
          title={has ? "Replace" : "Upload"}
          size="sm"
          variant="secondary"
          disabled={uploading}
          onPress={() => {
            if (Platform.OS === "web") pickWeb();
            else void pickNative();
          }}
        />
        {has ? (
          <Button title="Remove" size="sm" variant="ghost" onPress={onCleared} />
        ) : null}
      </View>
      {pending ? (
        <Text className="mt-1.5 text-xs text-muted">
          Uploaded — save the post to attach it.
        </Text>
      ) : null}
    </View>
  );
}

/** Tags as add/remove chips. A free-text box that splits on commas would let
 *  "faith, worship" become one tag with a space in it; one press, one tag. */
function TagEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
}) {
  const [entry, setEntry] = useState("");
  const cleaned = entry.trim().slice(0, BLOG_TAG_MAX);
  const full = tags.length >= BLOG_TAGS_MAX_COUNT;
  const duplicate = tags.some((t) => t.toLowerCase() === cleaned.toLowerCase());

  function add() {
    if (!cleaned || full || duplicate) return;
    onChange([...tags, cleaned]);
    setEntry("");
  }

  return (
    <View className="mb-3">
      <Text className="mb-1.5 text-sm font-semibold text-ink">Tags</Text>
      {tags.length > 0 ? (
        <View className="mb-2 flex-row flex-wrap gap-2">
          {tags.map((tag) => (
            <OptionTag
              key={tag}
              label={tag}
              size="md"
              onRemove={() => onChange(tags.filter((t) => t !== tag))}
            />
          ))}
        </View>
      ) : null}
      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <TextField
            value={entry}
            onChangeText={setEntry}
            // The heading above is the group's label, not this box's — without
            // this the input announces as an unnamed text field.
            accessibilityLabel="New tag"
            maxLength={BLOG_TAG_MAX}
            placeholder={full ? "That's the lot" : "Add a tag…"}
            autoCapitalize="none"
            onSubmitEditing={add}
            editable={!full}
          />
        </View>
        <View className="mb-3">
          <Button
            title="Add"
            size="sm"
            variant="secondary"
            disabled={!cleaned || full || duplicate}
            onPress={add}
          />
        </View>
      </View>
      <Text className="-mt-1 text-xs text-muted">
        {full
          ? `A post carries at most ${BLOG_TAGS_MAX_COUNT} tags.`
          : duplicate && cleaned
            ? "That tag is already on the post."
            : `${tags.length}/${BLOG_TAGS_MAX_COUNT} — how readers find related posts.`}
      </Text>
    </View>
  );
}

/**
 * Status, the public/preview links, and the one action that puts words on the
 * internet under the org's name.
 *
 * Publishing is a CONFIRM, never a tap. Every other control on this screen is
 * reversible by typing something else; this one is a broadcast.
 */
function PublishCard({
  post,
  canPublish,
  dirty,
  run,
}: {
  post: FullPost;
  canPublish: boolean;
  dirty: boolean;
  run: ActionRunner["run"];
}) {
  const setPostStatus = useMutation(api.marketingBlog.setPostStatus);
  const rotateToken = useMutation(api.marketingBlog.rotatePreviewToken);
  const postId = post.id as PostId;

  const previewUrl = `${publicSiteUrl()}${blogPreviewPath(post.slug, post.previewToken)}`;
  const publicUrl = `${publicSiteUrl()}${blogPostPath(post.slug)}`;

  function move(status: BlogPostStatus, title: string, message: string) {
    confirmAction({
      title,
      message,
      confirmLabel: title,
      destructive: status !== "published",
      onConfirm: () =>
        void run(() => setPostStatus({ postId, status }), {
          errorTitle: "Couldn't change the post's status",
        }),
    });
  }

  return (
    <Card padding="md" className="mb-3">
      <View className="mb-2 flex-row items-center gap-2">
        <Badge
          label={BLOG_POST_STATUS_LABELS[post.status]}
          tone={STATUS_TONES[post.status]}
        />
        {post.publishedAt ? (
          <Text className="text-xs text-faint">
            First published {formatDate(post.publishedAt)}
          </Text>
        ) : null}
      </View>

      {/* The link block. A draft's preview link is how it reaches an editor
          before it is public — per-post and revocable, unlike the shared
          password it replaces. Both are shown selectable as well as copyable,
          because `copyToClipboard` reports failure on native rather than
          pretending. */}
      <View className="mb-3">
        <Text className="mb-1 text-xs font-semibold text-ink">
          {post.status === "published" ? "Public link" : "Preview link"}
        </Text>
        <View className="flex-row items-center gap-2">
          <Text selectable className="flex-1 text-xs text-muted">
            {post.status === "published" ? publicUrl : previewUrl}
          </Text>
          <CopyButton
            text={post.status === "published" ? publicUrl : previewUrl}
            label
          />
        </View>
        {post.status !== "published" ? (
          <View className="mt-2 flex-row">
            <Button
              title="Reset preview link"
              size="sm"
              variant="ghost"
              onPress={() =>
                confirmAction({
                  title: "Reset preview link",
                  message:
                    "Anyone holding the old link stops being able to read this draft. You'll need to send the new one.",
                  confirmLabel: "Reset it",
                  destructive: true,
                  onConfirm: () =>
                    void run(() => rotateToken({ postId }), {
                      errorTitle: "Couldn't reset the link",
                    }),
                })
              }
            />
          </View>
        ) : null}
      </View>

      {!canPublish ? (
        // No button at all. A disabled control invites a hunt for the missing
        // tick-box; a sentence naming the person ends the question.
        <Text className="text-sm text-muted">
          Publishing this is the Marketing Director's call. Send them (or the
          ED) the preview link above when it's ready — everything you write and
          save here is kept exactly as you leave it.
        </Text>
      ) : dirty ? (
        <Text className="text-sm text-warn">
          Save your changes first — publishing puts the SAVED version on the
          site, not what's in the box.
        </Text>
      ) : post.status === "published" ? (
        <View>
          <Text className="mb-2 text-sm text-muted">
            Live on the site, in the RSS feed and in the sitemap. Taking it down
            leaves the link working — it resolves to a page saying the post was
            taken down, because a link shared once is shared forever.
          </Text>
          <View className="flex-row">
            <Button
              title="Archive (take it down)"
              size="sm"
              variant="secondary"
              icon="archive"
              onPress={() =>
                move(
                  "archived",
                  "Take this post down",
                  "It comes off the blog index, the feed and the sitemap. The link keeps working and says the post was taken down. You can publish it again later.",
                )
              }
            />
          </View>
        </View>
      ) : (
        <View>
          <Text className="mb-2 text-sm text-muted">
            {post.status === "archived"
              ? "Taken down. Publishing again puts it back in the index and the feed."
              : "Publishing puts this on the public internet under the org's name, and into the RSS feed."}
          </Text>
          <View className="flex-row">
            <Button
              title={
                post.status === "archived" ? "Publish again" : "Publish to the site"
              }
              size="sm"
              icon="globe"
              onPress={() =>
                move(
                  "published",
                  post.status === "archived" ? "Publish again" : "Publish",
                  `“${post.title.trim() || "Untitled post"}” goes public at ${blogPostPath(post.slug)}, and into the RSS feed. Ready?`,
                )
              }
            />
          </View>
        </View>
      )}
    </Card>
  );
}

/** Delete, and the reason it isn't offered for a published post. */
function DangerZone({
  post,
  run,
}: {
  post: FullPost;
  run: ActionRunner["run"];
}) {
  const router = useRouter();
  const deletePost = useMutation(api.marketingBlog.deletePost);

  if (post.status === "published") {
    return (
      <Text className="mb-10 text-xs text-muted">
        A published post can't be deleted — use Archive above. Deleting it would
        404 every link anyone has shared, which is why the backend refuses it
        too.
      </Text>
    );
  }
  return (
    <View className="mb-10 flex-row">
      <Button
        title="Delete post"
        size="sm"
        variant="danger"
        icon="trash-2"
        onPress={() =>
          confirmAction({
            title: "Delete this post",
            // An archived post WAS public once. The backend allows deleting it
            // (a second, deliberate decision), so this is the only place that
            // can say what it costs: the link stops resolving.
            message:
              post.status === "archived"
                ? "This post was public once, so its link is out there — deleting it makes that link 404, which archiving was avoiding. The writing goes with it."
                : "This post was never public, so deleting it breaks nothing — but the writing is gone for good.",
            confirmLabel: "Delete",
            destructive: true,
            onConfirm: () =>
              void run(() => deletePost({ postId: post.id as PostId }), {
                errorTitle: "Couldn't delete that post",
                onSuccess: () => router.replace("/marketing/blog" as never),
              }),
          })
        }
      />
    </View>
  );
}

/**
 * The form itself — the same fields for a new post and an existing one,
 * because they are the same post at different ages.
 *
 * Its state is seeded ONCE, at mount, from `existing` (see the module doc's
 * rule 1 for why there is no re-syncing effect). The screen mounts it under a
 * key that identifies the post, so one post's form is never reused for
 * another — and that key deliberately does not move when a new post is
 * created, which is the whole reason creating doesn't navigate.
 */
function PostForm({
  existing,
  canPublish,
  onCreated,
}: {
  existing: FullPost | null;
  canPublish: boolean;
  /** Hands the new post's id up so the screen can start loading the row —
   *  see the screen's `createdId` for why this isn't a navigation. */
  onCreated: (postId: string) => void;
}) {
  const upsertPost = useMutation(api.marketingBlog.upsertPost);
  const { run, toast, dismiss } = useActionRunner();

  const seed = existing ? draftFrom(existing) : EMPTY_DRAFT;
  const [draft, setDraft] = useState<Draft>(seed);
  /** The last state that is known to be on the server. Everything the Save
   *  button says about "unsaved" is this compared with `draft`. */
  const [baseline, setBaseline] = useState<Draft>(seed);
  const [saving, setSaving] = useState(false);
  /**
   * The row this form writes to. Starts as the post we opened; set by the
   * first successful create, BEFORE the freshly-created row has finished
   * loading back into `existing`. Without it, a second Save pressed in that
   * window would create a second post instead of updating the first.
   */
  const [savedId, setSavedId] = useState<string | null>(existing?.id ?? null);
  const targetId = existing?.id ?? savedId;

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const slug = existing?.slug ?? blogSlugFromTitle(draft.title);

  // Bounds are checked here as well as on the backend so the counter and the
  // Save button agree; the message names the field rather than making someone
  // hunt for the red number.
  const tooLong =
    draft.title.length > BLOG_TITLE_MAX
      ? "the title"
      : draft.description.length > BLOG_DESCRIPTION_MAX
        ? "the description"
        : draft.subtitle.length > BLOG_SUBTITLE_MAX
          ? "the standfirst"
          : draft.audience.length > BLOG_AUDIENCE_MAX
            ? "the audience line"
            : draft.author.length > BLOG_AUTHOR_MAX
              ? "the author"
              : draft.body.length > BLOG_BODY_MAX
                ? "the post itself"
                : null;
  const blocker = !draft.title.trim()
    ? "Give the post a title — the web address is built from it."
    : !slug
      ? `That title has nothing usable in a web address (${BLOG_SLUG_RULE}) — add some letters or numbers.`
      : tooLong
        ? `Shorten ${tooLong} before saving.`
        : null;

  function save() {
    if (blocker) return;
    // Snapshot: the baseline moves to what was SENT, so anything typed during
    // the save stays marked unsaved instead of being counted as written.
    const sent = draft;
    setSaving(true);
    void run(
      () =>
        upsertPost({
          ...(targetId ? { postId: targetId as PostId } : {}),
          title: sent.title.trim(),
          description: sent.description.trim(),
          // Subtitle and audience are sent even when empty: emptying one is a
          // real edit ("drop the standfirst"), and omitting it would be
          // indistinguishable from not touching it. The hero, which the form
          // genuinely cannot resend, is the one field that uses omit-means-keep
          // — hence its explicit `clearHero`.
          subtitle: sent.subtitle.trim(),
          audience: sent.audience.trim(),
          // Author is the exception: blank means "use the house default"
          // (`BLOG_DEFAULT_AUTHOR`), which is the backend's to apply.
          ...(sent.author.trim() ? { author: sent.author.trim() } : {}),
          body: sent.body,
          tags: sent.tags,
          reactionsEnabled: sent.reactionsEnabled,
          ...(sent.heroPending
            ? { heroStorage: sent.heroPending as Id<"_storage"> }
            : {}),
          ...(sent.heroCleared ? { clearHero: true } : {}),
        }),
      {
        errorTitle: "Couldn't save this post",
        onSuccess: (value) => {
          // The staged-image flags that were SENT have been consumed. Cleared
          // against the snapshot rather than blindly, so an image picked while
          // this save was in flight is still staged for the next one — the
          // same rule as the text: nothing typed after the snapshot is thrown
          // away or counted as saved.
          setDraft((d) => ({
            ...d,
            heroPending:
              d.heroPending === sent.heroPending ? null : d.heroPending,
            heroCleared:
              d.heroCleared === sent.heroCleared ? false : d.heroCleared,
          }));
          setBaseline({ ...sent, heroPending: null, heroCleared: false });
          // A brand-new post now has an id. Every later save addresses that
          // row, and the screen starts loading it so the publish controls and
          // the preview link appear.
          if (!targetId && typeof value === "string") {
            setSavedId(value);
            onCreated(value);
          }
        },
      },
    ).finally(() => setSaving(false));
  }

  const minutes = readingMinutes(draft.body);

  const saveRow = (
    <View className="flex-row items-center gap-3">
      <Button
        title={targetId ? "Save" : "Create post"}
        size="sm"
        loading={saving}
        disabled={Boolean(blocker) || (!dirty && Boolean(targetId))}
        onPress={save}
      />
      {dirty ? (
        <Badge label="Unsaved changes" tone="warn" icon="edit-3" />
      ) : targetId ? (
        <Text className="text-xs text-faint">Saved</Text>
      ) : null}
    </View>
  );

  return (
    <Screen>
      <Narrow>
        <BackLink fallback="/marketing/blog" label="All posts" />
        <SectionHeader
          title={targetId ? "Edit post" : "New post"}
          right={saveRow}
        />
        {blocker ? (
          <Text className="mb-3 text-xs text-danger">{blocker}</Text>
        ) : null}

        <Card padding="md" className="mb-3">
          <CountedField
            label="Title"
            value={draft.title}
            onChangeText={(title) => setDraft({ ...draft, title })}
            max={BLOG_TITLE_MAX}
            hint={
              existing
                ? `Web address: ${blogPostPath(slug)} — fixed, so old links keep working.`
                : slug
                  ? `Web address will be ${blogPostPath(slug)}, and it's fixed once published.`
                  : undefined
            }
          />
          <CountedField
            label="Description"
            value={draft.description}
            onChangeText={(description) => setDraft({ ...draft, description })}
            max={BLOG_DESCRIPTION_MAX}
            multiline
            numberOfLines={3}
            hint="Used word-for-word as the search-engine and social summary — write a sentence, not keywords."
          />
          <CountedField
            label="Standfirst"
            value={draft.subtitle}
            onChangeText={(subtitle) => setDraft({ ...draft, subtitle })}
            max={BLOG_SUBTITLE_MAX}
            multiline
            numberOfLines={2}
            hint="The italic line under the title. Optional."
          />
          <CountedField
            label="Who it's for"
            value={draft.audience}
            onChangeText={(audience) => setDraft({ ...draft, audience })}
            max={BLOG_AUDIENCE_MAX}
            placeholder="Worship leaders"
            hint="Shown above the title. Naming the room is the difference between a reader leaning in and bouncing."
          />
          <CountedField
            label="Author"
            value={draft.author}
            onChangeText={(author) => setDraft({ ...draft, author })}
            max={BLOG_AUTHOR_MAX}
            hint={`Leave blank for “${BLOG_DEFAULT_AUTHOR}”.`}
          />
          <TagEditor
            tags={draft.tags}
            onChange={(tags) => setDraft({ ...draft, tags })}
          />
          <HeroImagePicker
            current={draft.heroCleared ? null : (existing?.heroImageUrl ?? null)}
            pending={draft.heroPending}
            onPicked={(id) =>
              setDraft({ ...draft, heroPending: id, heroCleared: false })
            }
            onCleared={() =>
              setDraft({ ...draft, heroPending: null, heroCleared: true })
            }
            run={run}
          />
          <CheckboxRow
            checked={draft.reactionsEnabled}
            onPress={() =>
              setDraft({ ...draft, reactionsEnabled: !draft.reactionsEnabled })
            }
            label="Let readers react with emoji"
          />
        </Card>

        <Card padding="md" className="mb-3">
          <View className="mb-2 flex-row items-center justify-between gap-2">
            <Text className="text-sm font-semibold text-ink">The post</Text>
            <Text className="text-xs text-faint">
              {minutes} min read
              {draft.body.length > BLOG_BODY_MAX ? " · too long to save" : ""}
            </Text>
          </View>
          {/*
            The app's existing Markdown editor (CodeMirror 6 live preview,
            platform-split web/WebView) — the same surface the How-To docs are
            written in, so the one place in the org where people write long
            prose behaves the same way twice.

            `uploadImage` is deliberately NOT wired: it must resolve to a
            servable URL for the `![](url)` it inserts, and the blog's upload
            power (`generateHeroUploadUrl`) hands back an upload URL only —
            there is no "public URL for this storage id" in the blog API. An
            embed pointing at a URL that 404s in the published post is worse
            than no embed, so inline images wait for that endpoint; the hero
            above covers the picture most posts need.
          */}
          <MarkdownEditor
            value={draft.body}
            onChange={(body) => setDraft({ ...draft, body })}
            placeholder="Write the post in Markdown…"
            minHeight={520}
          />
        </Card>

        <View className="mb-4">{saveRow}</View>

        {existing ? (
          <>
            <PublishCard
              post={existing}
              canPublish={canPublish}
              dirty={dirty}
              run={run}
            />
            <DangerZone post={existing} run={run} />
          </>
        ) : (
          <Text className="mb-10 text-xs text-muted">
            {targetId
              ? "Saved as a private draft — its preview link and publishing controls are loading."
              : "Create the post first — it saves as a private draft, and the preview link and publishing controls appear once it exists."}
          </Text>
        )}
      </Narrow>
      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}

/**
 * The screen: access gate, load, then the form.
 *
 * The gate lives here rather than in the route for the same reason
 * `SiteView.tsx` gives — there is no read-only mode worth falling back to, so
 * the view resolves `canEditBlog` itself instead of the route resolving it and
 * handing down a flag nothing branches on.
 */
export function MarketingBlogPostEditor({ postId }: { postId: string | null }) {
  const access = useQuery(api.marketingSite.myMarketingAccess, {});
  const canEdit = access?.canEditBlog === true;
  /**
   * The id of a post created on this screen — held here rather than pushed
   * into the URL.
   *
   * `router.replace("/marketing/blog/<id>")` is the tidier-looking move and it
   * is the one this screen must NOT make: replacing the route entry mounts a
   * fresh component, which discards whatever the writer typed while the create
   * was in flight. Everything the real URL would buy (the row's publish
   * controls, its preview link, its hero) is bought by loading the row instead,
   * and reopening the post from the index lands on the proper URL. The address
   * bar reading `/new` for the rest of the session is the smaller cost.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const openId = postId ?? createdId;
  const post = useQuery(
    api.marketingBlog.getPost,
    canEdit && openId ? { postId: openId as PostId } : "skip",
  );

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
  // Gated on the ROUTE's id, not `openId`: once a post has been created here
  // the form is already mounted and holding someone's words, and swapping it
  // for a spinner while the new row loads would unmount it.
  if (postId && post === undefined) return <Screen loading />;
  if (postId && post === null) {
    return (
      <Screen>
        <Narrow>
          <BackLink fallback="/marketing/blog" label="All posts" />
          <EmptyState
            title="Post not found"
            message="It may have been deleted."
          />
        </Narrow>
      </Screen>
    );
  }

  return (
    <PostForm
      // Seeding the draft once at mount is only safe if React never reuses one
      // post's form for another. The key guarantees it, and it deliberately
      // does NOT change when a new post is created (`postId` is the route's,
      // and creating doesn't navigate) — that is what keeps the writing.
      key={postId ?? "new"}
      existing={(post as FullPost | null | undefined) ?? null}
      canPublish={access.canPublishBlog === true}
      onCreated={setCreatedId}
    />
  );
}
