/**
 * MARKETING · Site — the homepage's words and its impact numbers.
 *
 * The screen the marketing team was missing. publicworship.life's hero copy
 * lived in `Hero.astro` and its impact numbers in `impact.yaml`, so changing
 * "Together, Let's Forge a Future of…" — or the "700,000+" that had not been
 * revised since it was true — meant a pull request. Both are rows now
 * (`apps/convex/marketingSite.ts`), the public page reads them live, and this
 * is where they get written.
 *
 * ── Why each field is its own save ──────────────────────────────────────────
 * Not a form with one Save at the bottom. A copy slot commits on blur, the
 * moment its value has actually changed. Two reasons: a page's words are edited
 * one at a time (someone reads the live site, spots one wrong sentence, fixes
 * it), and a single Save button over twelve fields is a Save button that
 * eventually writes eleven fields nobody looked at. The character counter turns
 * red before the layout bound rather than after the throw
 * (`SiteCopyKeyDef.maxLen`).
 *
 * Gated on `marketing.site.edit` (`requireSiteEdit`); a caller without it gets
 * the access-needed state rather than a read-only form, because there is
 * nothing on this screen worth reading that the public page does not show
 * better.
 */
import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  SITE_COPY_DEFS,
  SITE_COPY_KEYS,
  SITE_COPY_SECTIONS,
  SITE_STAT_LABEL_MAX,
  SITE_STAT_MAX_COUNT,
  SITE_STAT_SUBLABEL_MAX,
  SITE_STAT_VALUE_MAX,
  type SiteCopyKey,
  type SiteCopySection,
} from "@events-os/shared";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Narrow,
  Screen,
  SectionHeader,
  TextField,
  ToastView,
} from "../ui";
import { useActionRunner } from "../../lib/useActionToast";

const SECTION_TITLES: Record<SiteCopySection, string> = {
  hero: "Hero",
  links: "Important Links heading",
  impact: "Impact heading",
};

const SECTION_BLURBS: Record<SiteCopySection, string> = {
  hero: "The first thing anyone sees on publicworship.life.",
  links: "The heading above the link cards. The cards themselves are on the Links tab.",
  impact: "The heading above the three numbers below.",
};

/**
 * One editable copy slot.
 *
 * Local state while typing, committed on blur — so a slow save never fights the
 * keyboard, and a value that came back changed from the server (someone else
 * edited it) still lands, because the effect re-syncs whenever the committed
 * value moves.
 */
function CopyField({
  copyKey,
  value,
  onCommit,
}: {
  copyKey: SiteCopyKey;
  value: string;
  onCommit: (next: string) => void;
}) {
  const def = SITE_COPY_DEFS[copyKey];
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const over = draft.length > def.maxLen;
  return (
    <View className="mb-1">
      <TextField
        label={def.label}
        value={draft}
        onChangeText={setDraft}
        onBlur={() => {
          if (draft.trim() !== value.trim()) onCommit(draft);
        }}
        multiline={def.multiline}
        numberOfLines={def.multiline ? 3 : undefined}
      />
      <View className="mb-3 -mt-1 flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-xs text-muted">{def.help}</Text>
        <Text className={`text-xs ${over ? "text-danger" : "text-faint"}`}>
          {draft.length}/{def.maxLen}
        </Text>
      </View>
    </View>
  );
}

/** One impact card's three fields, saved together — unlike copy slots, a stat
 *  is only meaningful as a whole (a number with no label is not a card), so it
 *  gets one Save. */
function StatEditor({
  stat,
  onSave,
  onDelete,
}: {
  stat: { id: string; value: string; label: string; sublabel: string | null };
  onSave: (next: { value: string; label: string; sublabel: string }) => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(stat.value);
  const [label, setLabel] = useState(stat.label);
  const [sublabel, setSublabel] = useState(stat.sublabel ?? "");
  useEffect(() => {
    setValue(stat.value);
    setLabel(stat.label);
    setSublabel(stat.sublabel ?? "");
  }, [stat.value, stat.label, stat.sublabel]);

  const dirty =
    value !== stat.value ||
    label !== stat.label ||
    sublabel !== (stat.sublabel ?? "");

  return (
    <Card padding="md" className="mb-3">
      <TextField
        label="The number"
        value={value}
        onChangeText={setValue}
        maxLength={SITE_STAT_VALUE_MAX}
        hint="Written exactly as it should appear — “700,000+”, “15+”."
      />
      <TextField
        label="Label"
        value={label}
        onChangeText={setLabel}
        maxLength={SITE_STAT_LABEL_MAX}
      />
      <TextField
        label="Description"
        value={sublabel}
        onChangeText={setSublabel}
        maxLength={SITE_STAT_SUBLABEL_MAX}
        multiline
        numberOfLines={3}
      />
      <View className="mt-1 flex-row items-center gap-2">
        <Button
          title="Save"
          size="sm"
          disabled={!dirty}
          onPress={() => onSave({ value, label, sublabel })}
        />
        <Button title="Remove" size="sm" variant="ghost" onPress={onDelete} />
      </View>
    </Card>
  );
}

export function MarketingSiteView() {
  const access = useQuery(api.marketingSite.myMarketingAccess, {});
  const content = useQuery(
    api.marketingSite.siteContent,
    access?.canEditSite === true ? {} : "skip",
  );
  const setCopy = useMutation(api.marketingSite.setCopy);
  const upsertStat = useMutation(api.marketingSite.upsertStat);
  const deleteStat = useMutation(api.marketingSite.deleteStat);
  const { run, toast, dismiss } = useActionRunner();
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newSublabel, setNewSublabel] = useState("");

  if (access === undefined) return <Screen loading />;
  if (!access.canEditSite) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Site access needed"
            message="Editing the public site is the Marketing Director's desk. Ask them or the ED for access."
          />
        </Narrow>
      </Screen>
    );
  }
  if (content === undefined) return <Screen loading />;

  const atStatCap = content.stats.length >= SITE_STAT_MAX_COUNT;

  return (
    <Screen>
      <Narrow>
        <SectionHeader title="The homepage" />
        <Text className="mb-4 text-sm text-muted">
          Everything here is live on publicworship.life. Changes show up within
          about a minute — there's no deploy and nothing to publish.
        </Text>

        {SITE_COPY_SECTIONS.map((section) => (
          <View key={section} className="mb-6">
            <Text className="mb-1 text-sm font-semibold text-ink">
              {SECTION_TITLES[section]}
            </Text>
            <Text className="mb-3 text-xs text-muted">
              {SECTION_BLURBS[section]}
            </Text>
            {SITE_COPY_KEYS.filter(
              (k) => SITE_COPY_DEFS[k].section === section,
            ).map((key) => (
              <CopyField
                key={key}
                copyKey={key}
                value={content.copy[key]}
                onCommit={(next) =>
                  void run(() => setCopy({ key, value: next }), {
                    errorTitle: "Couldn't save that",
                  })
                }
              />
            ))}
          </View>
        ))}

        <SectionHeader
          title="Impact numbers"
          count={`${content.stats.length} card${content.stats.length === 1 ? "" : "s"}`}
        />
        <Text className="mb-3 text-sm text-muted">
          The “Transformative Impact” row. Clearing a field back to empty
          restores whatever the site shipped with.
        </Text>

        {content.stats.map((stat) => (
          <StatEditor
            key={stat.id}
            stat={stat}
            onSave={(next) =>
              void run(
                () =>
                  upsertStat({
                    statId: stat.id as Id<"siteStats">,
                    value: next.value,
                    label: next.label,
                    ...(next.sublabel ? { sublabel: next.sublabel } : {}),
                  }),
                { errorTitle: "Couldn't save that card" },
              )
            }
            onDelete={() =>
              void run(
                () => deleteStat({ statId: stat.id as Id<"siteStats"> }),
                { errorTitle: "Couldn't remove that card" },
              )
            }
          />
        ))}

        {adding ? (
          <Card padding="md" className="mb-3">
            <TextField
              label="The number"
              value={newValue}
              onChangeText={setNewValue}
              maxLength={SITE_STAT_VALUE_MAX}
            />
            <TextField
              label="Label"
              value={newLabel}
              onChangeText={setNewLabel}
              maxLength={SITE_STAT_LABEL_MAX}
            />
            <TextField
              label="Description"
              value={newSublabel}
              onChangeText={setNewSublabel}
              maxLength={SITE_STAT_SUBLABEL_MAX}
              multiline
              numberOfLines={3}
            />
            <View className="mt-1 flex-row items-center gap-2">
              <Button
                title="Add card"
                size="sm"
                disabled={!newValue.trim() || !newLabel.trim()}
                onPress={() =>
                  void run(
                    () =>
                      upsertStat({
                        value: newValue,
                        label: newLabel,
                        ...(newSublabel ? { sublabel: newSublabel } : {}),
                      }),
                    {
                      errorTitle: "Couldn't add that card",
                      onSuccess: () => {
                        setNewValue("");
                        setNewLabel("");
                        setNewSublabel("");
                        setAdding(false);
                      },
                    },
                  )
                }
              />
              <Button
                title="Cancel"
                size="sm"
                variant="ghost"
                onPress={() => setAdding(false)}
              />
            </View>
          </Card>
        ) : (
          <View className="mb-6 flex-row">
            <Button
              title="Add a card"
              icon="plus"
              size="sm"
              variant="secondary"
              disabled={atStatCap}
              onPress={() => setAdding(true)}
            />
          </View>
        )}
        {atStatCap ? (
          <Field hint={`The row holds at most ${SITE_STAT_MAX_COUNT} cards.`}>
            <View />
          </Field>
        ) : null}
      </Narrow>
      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}
