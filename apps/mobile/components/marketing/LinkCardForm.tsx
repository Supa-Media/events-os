/**
 * The Important Links card form — two fields by default.
 *
 * The founder on the version this replaces: "the UI to add a new card is very
 * clunky. It's so big, so many fields. It's fine having this many fields, but
 * it can just be more compact. And it could be clear what's optional, because
 * right now it's not clear what's optional." That form put six inputs, an
 * alignment picker, two image pickers and a checkbox on screen at once, all
 * weighted the same, for a job whose common case is "put the new Instagram
 * handle on the page".
 *
 * Three changes, and the third is the one that removes an error rather than a
 * scroll:
 *
 * 1. PROGRESSIVE DISCLOSURE. Open state is a title, one destination field and
 *    the button. Subtitle, small line, both images, text position and
 *    show-on-site live behind "More options". Nothing was removed — the extras
 *    are one tap away, and an EDIT of a card that already uses any of them
 *    opens with them expanded (see `moreOpenInitially`), because collapsing a
 *    field with content in it hides the thing the marketer came to change.
 *
 * 2. OPTIONAL IS MARKED, in the app's own convention — "(optional)" appended to
 *    the label, as `Note (optional)` does in a dozen screens — rather than a
 *    new asterisk-means-required dialect invented for this one form. The
 *    convention is applied to fields you FILL; `Text position` and `Show on the
 *    site` carry no suffix because they always have a value and "(optional)"
 *    would be a lie about a setting. The disclosure says the whole section is
 *    optional, and the line above the first field says what the two required
 *    ones are, in words.
 *
 * 3. LINK-OR-COPY IS ONE DECISION. `upsertLink` refuses a card carrying both,
 *    because `LinkCard.astro` turns any card with `copy` into a button and the
 *    link beside it would silently never fire. The old form expressed that as
 *    two adjacent text fields and an error message underneath — a rule you
 *    learn by breaking it. It is a radio pair now: one question, one answer,
 *    one field. The rejected alternative was to keep both fields and clear the
 *    other on typing, which is the same illegal state plus a field that erases
 *    itself while you look at it.
 *
 * The draft's shape is here rather than in the screen because the draft is the
 * form's contract: `mode` only means anything next to the radio that sets it,
 * and `cardFieldsFrom` — the mapping back to mutation args — is the other half
 * of the same rule.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  isAllowedSiteLinkUrl,
  SITE_LINK_ALIGNS,
  SITE_LINK_COPY_MAX,
  SITE_LINK_CTA_MAX,
  SITE_LINK_SUBTITLE_MAX,
  SITE_LINK_TITLE_MAX,
  SITE_LINK_URL_MAX,
  type SiteLinkAlign,
} from "@events-os/shared";
import {
  Button,
  CheckboxRow,
  Field,
  Icon,
  Radio,
  RadioGroup,
  Select,
  TextField,
} from "../ui";
import { colors } from "../../lib/theme";
import { CardImagePicker } from "./CardImagePicker";
import type { LinkRow } from "./LinkCardTile";
import type { ActionRunner } from "../../lib/useActionToast";

/** What tapping the card does. The site has exactly these two behaviors. */
type CardMode = "link" | "copy";

const MODES: { value: CardMode; label: string; icon: "external-link" | "copy" }[] =
  [
    { value: "link", label: "Opens a link", icon: "external-link" },
    { value: "copy", label: "Copies text", icon: "copy" },
  ];

const ALIGN_OPTIONS = SITE_LINK_ALIGNS.map((a) => ({
  value: a,
  label: a === "center" ? "Centered" : "Top left",
}));

/** A blank card's fields, so "New card" and "Cancel" both have one shape to
 *  reset to. */
export const EMPTY_DRAFT = {
  title: "",
  /**
   * The answer to the one destination question. `url` and `copy` both stay in
   * the draft while typing — switching modes and switching back should not eat
   * what you typed — but only the field this names is ever SENT, so the state
   * the backend refuses cannot be reached from here.
   */
  mode: "link" as CardMode,
  url: "",
  copy: "",
  subtitle: "",
  cta: "",
  align: "center" as SiteLinkAlign,
  /**
   * New cards go up. Somebody who filled in a title and a link and pressed
   * "Add card" meant "put this on the page"; the old default left it off,
   * hidden behind a checkbox that is now inside a disclosure, which is how a
   * desk ends up looking empty after somebody has used it. The row's own
   * Hide button is the undo, and it is one tap on the row that just appeared.
   */
  published: true,
  /**
   * IMAGES ARE THREE-STATE, not two, and flattening them is how the first cut
   * of this screen deleted the Instagram logo on a rename.
   *
   *   `pending` set     a file uploaded in this session, to be saved with the card
   *   `cleared` true    remove whatever the card has
   *   neither           leave it alone
   *
   * The third state is the one that needs a name: the form does not know a
   * seeded card's `/links/…` path or an upload's bytes, so "not sent" has to
   * mean KEEP. The backend applies the same rule (`upsertLink`'s
   * keep-if-not-resent), and this is its other half.
   */
  thumbnailPending: null as string | null,
  thumbnailCleared: false,
  bgPending: null as string | null,
  bgCleared: false,
};

export type LinkDraft = typeof EMPTY_DRAFT;

export function draftFrom(row: LinkRow): LinkDraft {
  return {
    ...EMPTY_DRAFT,
    title: row.title,
    // A stored card can only carry one of the two — the mutation refuses the
    // other case — so the stored copy text IS the answer to the question.
    mode: row.copy ? "copy" : "link",
    url: row.url ?? "",
    copy: row.copy ?? "",
    subtitle: row.subtitle ?? "",
    cta: row.cta ?? "",
    align: row.align,
    published: row.published,
  };
}

/** The card fields `upsertLink` takes, minus `linkId`. Spelled out rather than
 *  inferred so a spread that quietly stops matching the mutation's args is a
 *  compile error here and not a runtime throw on save. */
export type CardFields = {
  title: string;
  subtitle?: string;
  url?: string;
  copy?: string;
  cta?: string;
  align: SiteLinkAlign;
  published: boolean;
  thumbnailStorage?: Id<"_storage">;
  clearThumbnail?: boolean;
  bgImageStorage?: Id<"_storage">;
  clearBgImage?: boolean;
};

/**
 * Draft → mutation args.
 *
 * The mode filter is load-bearing on an EDIT as well as a create: `upsertLink`
 * rebuilds the row from exactly what it is sent, so omitting `url` is what
 * clears it — which is precisely what "this card copies text now" has to mean.
 */
export function cardFieldsFrom(d: LinkDraft): CardFields {
  return {
    title: d.title,
    ...(d.subtitle ? { subtitle: d.subtitle } : {}),
    ...(d.mode === "link" && d.url.trim() ? { url: d.url } : {}),
    ...(d.mode === "copy" && d.copy.trim() ? { copy: d.copy } : {}),
    ...(d.cta ? { cta: d.cta } : {}),
    align: d.align,
    published: d.published,
    // Omitted unless the marketer actually did something to the image — see
    // `EMPTY_DRAFT`'s three-state note.
    ...(d.thumbnailPending
      ? { thumbnailStorage: d.thumbnailPending as Id<"_storage"> }
      : {}),
    ...(d.thumbnailCleared ? { clearThumbnail: true } : {}),
    ...(d.bgPending ? { bgImageStorage: d.bgPending as Id<"_storage"> } : {}),
    ...(d.bgCleared ? { clearBgImage: true } : {}),
  };
}

/** Whether this draft already uses anything the disclosure hides. Drives the
 *  edit-opens-expanded rule; see the module doc. */
function moreOpenInitially(draft: LinkDraft, row?: LinkRow): boolean {
  return Boolean(
    draft.subtitle ||
      draft.cta ||
      draft.align !== "center" ||
      row?.thumbnail ||
      row?.bgImage,
  );
}

/** The card editor — used for both an existing card and a new one, because
 *  they are the same fields and a second copy of them is a second place to
 *  forget a bound. */
export function LinkCardForm({
  draft,
  setDraft,
  onSave,
  onCancel,
  saveLabel,
  row,
  run,
}: {
  draft: LinkDraft;
  setDraft: (next: LinkDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
  /** The card being edited, for its current images. Absent when creating. */
  row?: LinkRow;
  run: ActionRunner["run"];
}) {
  const [moreOpen, setMoreOpen] = useState(() => moreOpenInitially(draft, row));

  const linkMode = draft.mode === "link";
  const destination = linkMode ? draft.url : draft.copy;
  // Said here rather than discovered as a toast after saving. `isAllowedSiteLinkUrl`
  // is the same predicate the mutation enforces, so the two cannot drift on
  // what counts as a usable address.
  const urlUnusable =
    linkMode && draft.url.trim() !== "" && !isAllowedSiteLinkUrl(draft.url);
  const usable =
    Boolean(draft.title.trim()) && Boolean(destination.trim()) && !urlUnusable;

  return (
    <View>
      <Text className="mb-3 text-xs text-muted">
        A card needs a title and somewhere to go. Everything else is optional.
      </Text>

      <TextField
        label="Title"
        value={draft.title}
        onChangeText={(title) => setDraft({ ...draft, title })}
        maxLength={SITE_LINK_TITLE_MAX}
        placeholder="Instagram"
        hint="Shown on the card unless it has a logo."
      />

      <Field label="What tapping it does">
        <RadioGroup
          accessibilityLabel="What tapping this card does"
          horizontal
          className="flex-row gap-2"
        >
          {MODES.map((m) => {
            const selected = draft.mode === m.value;
            return (
              <Radio
                key={m.value}
                checked={selected}
                onSelect={() => setDraft({ ...draft, mode: m.value })}
                accessibilityLabel={m.label}
                className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-md border px-3 py-2 active:opacity-70 ${
                  selected ? "border-accent bg-accent/5" : "border-border bg-sunken"
                }`}
              >
                <Icon
                  name={m.icon}
                  size={13}
                  color={selected ? colors.accent : colors.muted}
                />
                <Text
                  className={`text-sm font-semibold ${
                    selected ? "text-accent" : "text-muted"
                  }`}
                >
                  {m.label}
                </Text>
              </Radio>
            );
          })}
        </RadioGroup>
      </Field>

      {linkMode ? (
        <TextField
          label="Link"
          value={draft.url}
          onChangeText={(url) => setDraft({ ...draft, url })}
          maxLength={SITE_LINK_URL_MAX}
          autoCapitalize="none"
          placeholder="https://instagram.com/…"
          hint="A full https:// address, or a path on our own site like /give."
        />
      ) : (
        <TextField
          label="Text to copy"
          value={draft.copy}
          onChangeText={(copy) => setDraft({ ...draft, copy })}
          maxLength={SITE_LINK_COPY_MAX}
          autoCapitalize="none"
          placeholder="give@publicworship.life"
          hint="Tapping the card copies this to the clipboard — the Zelle card works this way."
        />
      )}
      {urlUnusable ? (
        <Text className="-mt-1 mb-3 text-xs text-danger">
          The site can't use that address. Try a full https:// link, an email or
          phone link, or a path on our site like /give.
        </Text>
      ) : null}

      <Pressable
        onPress={() => setMoreOpen((o) => !o)}
        accessibilityRole="button"
        className="mb-3 flex-row items-center gap-1.5 py-1"
      >
        <Icon
          name={moreOpen ? "chevron-up" : "chevron-down"}
          size={14}
          color={colors.accent}
        />
        <Text className="text-sm font-semibold text-accent">
          {moreOpen ? "Fewer options" : "More options"}
        </Text>
        {moreOpen ? null : (
          <Text className="flex-1 text-xs text-muted" numberOfLines={1}>
            Subtitle, images, position — all optional.
          </Text>
        )}
      </Pressable>

      {moreOpen ? (
        <View>
          <TextField
            label="Subtitle (optional)"
            value={draft.subtitle}
            onChangeText={(subtitle) => setDraft({ ...draft, subtitle })}
            maxLength={SITE_LINK_SUBTITLE_MAX}
          />
          <TextField
            label="Small line (optional)"
            value={draft.cta}
            onChangeText={(cta) => setDraft({ ...draft, cta })}
            maxLength={SITE_LINK_CTA_MAX}
            hint="Sits under the subtitle — “(Click to Copy)”."
          />
          <CardImagePicker
            kind="thumbnail"
            current={draft.thumbnailCleared ? null : (row?.thumbnail ?? null)}
            pending={draft.thumbnailPending}
            onPicked={(id) =>
              setDraft({
                ...draft,
                thumbnailPending: id,
                thumbnailCleared: false,
              })
            }
            onCleared={() =>
              setDraft({
                ...draft,
                thumbnailPending: null,
                thumbnailCleared: true,
              })
            }
            run={run}
          />
          <CardImagePicker
            kind="background"
            current={draft.bgCleared ? null : (row?.bgImage ?? null)}
            pending={draft.bgPending}
            onPicked={(id) =>
              setDraft({ ...draft, bgPending: id, bgCleared: false })
            }
            onCleared={() =>
              setDraft({ ...draft, bgPending: null, bgCleared: true })
            }
            run={run}
          />
          <Select
            label="Text position"
            value={draft.align}
            options={ALIGN_OPTIONS}
            onChange={(align) =>
              setDraft({ ...draft, align: align as SiteLinkAlign })
            }
          />
          <CheckboxRow
            checked={draft.published}
            onPress={() => setDraft({ ...draft, published: !draft.published })}
            label="Show on the site"
          />
        </View>
      ) : null}

      <View className="flex-row items-center gap-2">
        <Button title={saveLabel} size="sm" disabled={!usable} onPress={onSave} />
        <Button title="Cancel" size="sm" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}
