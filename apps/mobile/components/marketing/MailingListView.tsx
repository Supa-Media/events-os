/**
 * MARKETING · Mailing list — who the org can reach, and who asked not to be.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * A view over `people` (`apps/convex/mailingList.ts`), NOT a separate list.
 * Familiar on purpose — it should read like the People tab — but the columns
 * answer a different question: not "who is on the team" but "can we actually
 * email or text this person, and did they say we could?"
 *
 * ── Two lists, not one with a filter ────────────────────────────────────────
 * Email and SMS are separate promises with separate ledgers, and someone can be
 * on one and off the other. The channel switch at the top is that distinction,
 * not a layout convenience.
 *
 * ── Why the excluded view exists ────────────────────────────────────────────
 * It would be easy to show only reachable people and call it the list. But the
 * request this desk was built for — "someone wants off the mailing list" — has
 * a mirror: "did we actually take them off?" A list whose edges are invisible
 * is a list you re-add people to. So the excluded view shows each person and
 * WHY, with opted-out (which this desk can lift) and unsubscribed-or-bounced
 * (which it never can) as two different words.
 *
 * ── Export ──────────────────────────────────────────────────────────────────
 * Needs `data.export` on top of list access, and only ever contains reachable
 * people — see `exportMailingList`. The query is not subscribed until the
 * button is pressed: a caller without `data.export` would otherwise trip its
 * refusal on every render of a screen they are perfectly entitled to use. On
 * press, the refusal reaches the error boundary with a sentence that names
 * exactly which half of the permission is missing.
 */
import { useState } from "react";
import { View, Text, Platform } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  MAILING_EXCLUSION_LABELS,
  type MailingChannel,
  type MailingExclusion,
} from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  Narrow,
  Pill,
  Screen,
  SectionHeader,
  TextField,
  ToastView,
  type BadgeTone,
} from "../ui";
import { useActionRunner } from "../../lib/useActionToast";
import { useGivingScope } from "../../lib/useGivingScope";

/** An exclusion's chip colour. `suppressed` is the one that reads as a hard
 *  stop, because it is the one this desk cannot undo. */
function exclusionTone(reason: MailingExclusion): BadgeTone {
  switch (reason) {
    case "suppressed":
      return "danger";
    case "opted_out":
      return "warn";
    case "no_address":
      return "neutral";
    case "inactive":
      return "neutral";
  }
}

const CHANNELS: { value: MailingChannel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "sms", label: "Text" },
];

/**
 * The public signup link, for the "copy a link people can sign up with" ask.
 *
 * Built from the app's own origin on web, and hardcoded to the production site
 * on native — the app runs at a different host than the marketing site, and a
 * link to `exp://…/subscribe` would be worse than useless. The path is the
 * whole point; the origin is the part that has to be right.
 */
const PUBLIC_SITE = "https://publicworship.life";
function signupLink(): string {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    // In production the OS and the site share a host through pw-router, so the
    // page really is at this origin. In local dev it points at the dev server,
    // which is also the right answer there.
    return `${window.location.origin}/subscribe`;
  }
  return `${PUBLIC_SITE}/subscribe`;
}

export function MailingListView() {
  const chapterId = useGivingScope();
  const access = useQuery(api.marketingSite.myMarketingAccess, {});
  const [channel, setChannel] = useState<MailingChannel>("email");
  const [view, setView] = useState<"subscribed" | "excluded">("subscribed");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  /** A non-error outcome that still needs saying — see `addToList`'s
   *  `onSuccess`. `useActionRunner` only surfaces failures, and this is not one. */
  const [notice, setNotice] = useState<string | null>(null);

  const canView = access?.canViewList === true;
  const list = useQuery(
    api.mailingList.listMailingList,
    canView
      ? {
          ...(chapterId ? { chapterId } : {}),
          channel,
          view,
          ...(search.trim() ? { search: search.trim() } : {}),
        }
      : "skip",
  );
  // Runs only when the caller asked for it — an export query that fires on
  // every render would throw for anyone without `data.export` and light up the
  // error boundary on a screen they are otherwise allowed to use.
  const [wantExport, setWantExport] = useState(false);
  const exported = useQuery(
    api.mailingList.exportMailingList,
    canView && wantExport
      ? { ...(chapterId ? { chapterId } : {}), channel }
      : "skip",
  );

  const addToList = useMutation(api.mailingList.addToList);
  const removeFromList = useMutation(api.mailingList.removeFromList);
  const restoreToList = useMutation(api.mailingList.restoreToList);
  const { run, toast, dismiss } = useActionRunner();

  if (access === undefined) return <Screen loading />;
  if (!canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Mailing list access needed"
            message="Ask the Marketing Director or the ED for access to the mailing list."
          />
        </Narrow>
      </Screen>
    );
  }

  const canEdit = access.canEditList && list?.canEdit !== false;

  return (
    <Screen>
      <Narrow>
        <SectionHeader
          title="Mailing list"
          count={
            list
              ? `${list.subscribed} reachable · ${list.excluded} not`
              : undefined
          }
        />
        <Text className="mb-3 text-sm text-muted">
          Everyone on the roster and every contact we've collected, with whether
          we can actually reach them. Bulk sending happens in Mailchimp — this
          is the list behind it.
        </Text>

        <View className="mb-3 flex-row items-center gap-2">
          {CHANNELS.map((c) => (
            <Pill
              key={c.value}
              label={c.label}
              selected={channel === c.value}
              onPress={() => setChannel(c.value)}
            />
          ))}
          <View className="flex-1" />
          <Pill
            label="On the list"
            selected={view === "subscribed"}
            onPress={() => setView("subscribed")}
          />
          <Pill
            label="Not reachable"
            selected={view === "excluded"}
            onPress={() => setView("excluded")}
          />
        </View>

        {/* The link that replaces the Google Form. Right at the top because
            handing it out is the fastest way this list grows. */}
        <Card padding="md" className="mb-3">
          <Text className="mb-1 text-sm font-semibold text-ink">
            Sign-up link
          </Text>
          <Text className="mb-2 text-xs text-muted">
            Share this instead of a Google Form — it writes straight into this
            list, with the person's consent and the date.
          </Text>
          <View className="flex-row items-center gap-2">
            <Text className="flex-1 text-xs text-faint" numberOfLines={1}>
              {signupLink()}
            </Text>
            <CopyButton text={signupLink()} />
          </View>
        </Card>

        <TextField
          value={search}
          onChangeText={setSearch}
          placeholder="Search by name or address"
          autoCapitalize="none"
        />

        <View className="mb-4 flex-row items-center gap-2">
          {canEdit ? (
            <Button
              title="Add someone"
              icon="plus"
              size="sm"
              variant="secondary"
              onPress={() => setAdding((v) => !v)}
            />
          ) : null}
          <Button
            title={wantExport ? "Refresh export" : "Export CSV"}
            size="sm"
            variant="ghost"
            onPress={() => setWantExport(true)}
          />
        </View>

        {adding ? (
          <Card padding="md" className="mb-4">
            <Text className="mb-2 text-sm font-semibold text-ink">
              Add to the list
            </Text>
            <Text className="mb-3 text-xs text-muted">
              Matched against everyone we already know, so adding a donor or a
              past guest updates that person rather than making a second one.
            </Text>
            <TextField label="Name" value={newName} onChangeText={setNewName} />
            <TextField
              label="Email"
              value={newEmail}
              onChangeText={setNewEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TextField
              label="Phone"
              value={newPhone}
              onChangeText={setNewPhone}
              keyboardType="phone-pad"
            />
            <View className="flex-row items-center gap-2">
              <Button
                title="Add"
                size="sm"
                disabled={
                  !newName.trim() || (!newEmail.trim() && !newPhone.trim()) || !chapterId
                }
                onPress={() =>
                  void run(
                    () =>
                      addToList({
                        chapterId: chapterId as Id<"chapters">,
                        name: newName,
                        ...(newEmail.trim() ? { email: newEmail } : {}),
                        ...(newPhone.trim() ? { phone: newPhone } : {}),
                      }),
                    {
                      errorTitle: "Couldn't add them",
                      onSuccess: (value) => {
                        setNewName("");
                        setNewEmail("");
                        setNewPhone("");
                        setAdding(false);
                        // The one outcome worth saying out loud: they are on
                        // the list AND they still will not receive anything,
                        // because they unsubscribed or their address bounced.
                        // Silence here would read as plain success, and the
                        // next question ("why didn't they get it?") would come
                        // weeks later with no way to answer it.
                        const res = value as { stillSuppressed?: boolean };
                        setNotice(
                          res?.stillSuppressed
                            ? "Added — but they previously unsubscribed or their address bounced, so we still can't mail them. They'll need to re-subscribe themselves."
                            : null,
                        );
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
            {!chapterId ? (
              <Text className="mt-2 text-xs text-muted">
                Pick a chapter from the header first — a person belongs to one.
              </Text>
            ) : null}
          </Card>
        ) : null}

        {notice ? (
          <Card padding="md" className="mb-4">
            <Text className="text-sm text-ink">{notice}</Text>
            <View className="mt-2 flex-row">
              <Button
                title="Got it"
                size="sm"
                variant="ghost"
                onPress={() => setNotice(null)}
              />
            </View>
          </Card>
        ) : null}

        {exported ? (
          <Card padding="md" className="mb-4">
            <View className="mb-2 flex-row items-center justify-between gap-2">
              <Text className="text-sm font-semibold text-ink">
                {exported.rows} row{exported.rows === 1 ? "" : "s"} ready
              </Text>
              <CopyButton text={exported.csv} />
            </View>
            <Text className="text-xs text-muted">
              Reachable people only — opted-out and unsubscribed addresses are
              never exported. Paste it into Mailchimp.
            </Text>
          </Card>
        ) : null}

        {list === undefined ? (
          <Screen loading />
        ) : list.rows.length === 0 ? (
          <EmptyState
            title={
              view === "subscribed" ? "Nobody reachable yet" : "Nobody excluded"
            }
            message={
              view === "subscribed"
                ? "Share the sign-up link above, or add someone by hand."
                : "Everyone we know about can be reached on this channel."
            }
          />
        ) : (
          <View className="gap-2">
            {list.rows.map((row) => (
              <Card key={row.personId} padding="md">
                <View className="flex-row items-center gap-2">
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                      {row.name}
                    </Text>
                    <Text className="text-xs text-faint" numberOfLines={1}>
                      {row.destination ?? "No address on file"}
                      {row.chapterName ? ` · ${row.chapterName}` : ""}
                    </Text>
                  </View>
                  {canEdit && row.exclusions.length === 0 ? (
                    <Button
                      title="Remove"
                      size="sm"
                      variant="ghost"
                      onPress={() =>
                        void run(
                          () =>
                            removeFromList({
                              personId: row.personId as Id<"people">,
                            }),
                          { errorTitle: "Couldn't remove them" },
                        )
                      }
                    />
                  ) : null}
                  {/* Only an OPT-OUT can be put back. A suppression came from
                      the person themselves or from a bounce, and offering a
                      button that cannot honor its label would be worse than
                      offering none. */}
                  {canEdit && row.exclusions.includes("opted_out") ? (
                    <Button
                      title="Put back"
                      size="sm"
                      variant="ghost"
                      onPress={() =>
                        void run(
                          () =>
                            restoreToList({
                              personId: row.personId as Id<"people">,
                            }),
                          { errorTitle: "Couldn't put them back" },
                        )
                      }
                    />
                  ) : null}
                </View>
                {row.exclusions.length > 0 ? (
                  <View className="mt-2 flex-row flex-wrap items-center gap-2">
                    {row.exclusions.map((reason) => (
                      <Badge
                        key={reason}
                        label={MAILING_EXCLUSION_LABELS[reason]}
                        tone={exclusionTone(reason)}
                      />
                    ))}
                  </View>
                ) : row.consentedAt ? (
                  <Text className="mt-1.5 text-xs text-faint">
                    Said yes {new Date(row.consentedAt).toLocaleDateString()}
                    {row.consentSource ? ` · ${row.consentSource}` : ""}
                  </Text>
                ) : null}
              </Card>
            ))}
            {list.truncated ? (
              <Text className="mt-2 text-xs text-muted">
                Showing the first {list.rows.length} of {list.matched}. Narrow it
                with the search box.
              </Text>
            ) : null}
          </View>
        )}
      </Narrow>
      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}
