/**
 * MARKETING · Mailing list — who the org can reach, and who asked not to be.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * A view over `people` (`apps/convex/mailingList.ts`), NOT a separate list —
 * "every people is the superset, and the mailing list is the subset" (founder,
 * 2026-08-28). It is deliberately built as a DATABASE GRID out of the same
 * primitives the People roster uses, so the subset reads as the same object as
 * the superset, and a name in it opens the very same person's record. The
 * columns answer a different question from the roster's: not "who is on the
 * team" but "can we actually email or text this person, and did they say we
 * could?"
 *
 * It used to be a stack of cards, one per person — rejected in the same
 * conversation ("There's no reason why it should be these cards… should be
 * able to do box selection operations"). The grid itself lives in
 * `MailingListGrid.tsx`; the selection bar, its confirmation, and the CSV
 * panel in `MailingListBulkBar.tsx`. This file is the screen: scope, access,
 * the two axes (channel and view), search, add, export, and the mutations the
 * bulk bar fires.
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
 * (which it never can) as two different words, and "Put back" is offered on
 * exactly the first kind.
 *
 * ── Selection is scoped to what's on screen ─────────────────────────────────
 * Changing the channel, the view, or the search clears the selection. A
 * selection that survives a filter change is a promise you cannot see: "Remove
 * 12" would be acting on rows that scrolled out of the query, and the whole
 * point of the count in that button is that it is the truth.
 *
 * ── Export ──────────────────────────────────────────────────────────────────
 * Needs `data.export` on top of list access, and only ever contains reachable
 * people — see `exportMailingList`. The whole-channel query is not subscribed
 * until the button is pressed: a caller without `data.export` would otherwise
 * trip its refusal on every render of a screen they are perfectly entitled to
 * use. On press, the refusal reaches the error boundary with a sentence that
 * names exactly which half of the permission is missing.
 *
 * "Export N" over a selection is assembled HERE, from rows the client already
 * has, using the same shared `toCsv` (formula-injection guard included) and the
 * same column layout the server's export writes — so the two files paste into
 * Mailchimp identically. It is gated on `dataExports.myExportAccess`, the same
 * signal the People tab's Export button uses: the rows are already on screen so
 * this discloses nothing new, but offering an export door to someone the org
 * has decided cannot export would be a lie about the policy.
 */
import { useMemo, useState } from "react";
import { View, Text, Platform } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  toCsv,
  type MailingChannel,
  type MailingListRow,
} from "@events-os/shared";
import {
  Button,
  Card,
  EmptyState,
  FULL_WIDTH,
  Narrow,
  Pill,
  Screen,
  SectionHeader,
  TextField,
  ToastView,
} from "../ui";
import { useActionRunner } from "../../lib/useActionToast";
import { useGivingScope } from "../../lib/useGivingScope";
import { PersonPreviewModal } from "../people/PersonPreviewModal";
import {
  MailingListGrid,
  canPutBack,
  sortMailingRows,
  type MailingSort,
} from "./MailingListGrid";
import {
  MailingListBulkBar,
  MailingListCsvPanel,
  MailingListRemoveConfirm,
  MailingListSignupLink,
} from "./MailingListBulkBar";

const CHANNELS: { value: MailingChannel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "sms", label: "Text" },
];

/** How many rows the grid asks for. The backend's own default is 500 and its
 *  ceiling 2000; "Load the rest" below raises this once, rather than paginating
 *  — `listMailingList` resolves the whole channel in one pass anyway (it has to,
 *  to count), so a page cursor would buy nothing but a second code path. */
const PAGE_LIMIT = 500;
const FULL_LIMIT = 2000;

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

/** The selection CSV, in the SAME column layout `exportMailingList` writes, so
 *  a file exported from a selection and one exported from the whole channel are
 *  the same file shape. `Chapter` is blank on a single-chapter lens for the
 *  same reason the grid hides that column there: the backend only names a
 *  chapter on a row when the view spans more than one. */
function selectionCsv(rows: MailingListRow[], channel: MailingChannel): string {
  const header =
    channel === "email"
      ? ["Name", "Email", "Chapter", "Consented", "Consent source"]
      : ["Name", "Phone", "Chapter", "Consented", "Consent source"];
  return toCsv(
    header,
    rows.map((r) => [
      r.name,
      r.destination ?? "",
      r.chapterName ?? "",
      r.consentedAt ? new Date(r.consentedAt).toISOString().slice(0, 10) : "",
      r.consentSource ?? "",
    ]),
  );
}

export function MailingListView() {
  const chapterId = useGivingScope();
  const access = useQuery(api.marketingSite.myMarketingAccess, {});
  const [channel, setChannel] = useState<MailingChannel>("email");
  const [view, setView] = useState<"subscribed" | "excluded">("subscribed");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_LIMIT);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [sort, setSort] = useState<MailingSort>({ key: "name", dir: "asc" });
  /** Selected people, by `personId`. Local only — nothing persists, exactly
   *  like the People roster's own selection. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** Who a confirmed removal will act on. Non-null IS the dialog being open,
   *  so there is no way to open it without knowing the rows. */
  const [pendingRemoval, setPendingRemoval] = useState<MailingListRow[] | null>(
    null,
  );
  const [removing, setRemoving] = useState(false);
  /** The CSV assembled from a selection, held until dismissed. */
  const [selectionExport, setSelectionExport] = useState<{
    csv: string;
    rows: number;
  } | null>(null);
  /** Who the name-tap preview is showing. */
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(
    null,
  );
  /** A non-error outcome that still needs saying — see `addToList`'s
   *  `onSuccess` and the bulk results below. `useActionRunner` only surfaces
   *  failures, and none of these are one. */
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
          limit,
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
  // The org-wide "may this person take data out of the app at all" answer —
  // the same query the People roster gates its Export button on. Used here for
  // the selection export, which is assembled client-side and therefore has no
  // server call of its own to refuse it.
  const exportAccess = useQuery(api.dataExports.myExportAccess);

  const addToList = useMutation(api.mailingList.addToList);
  const removeMany = useMutation(api.mailingList.removeManyFromList);
  const restoreMany = useMutation(api.mailingList.restoreManyToList);
  const { run, toast, dismiss } = useActionRunner();

  const rows = useMemo(
    () => sortMailingRows(list?.rows ?? [], sort),
    [list?.rows, sort],
  );
  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.personId)),
    [rows, selected],
  );

  /** Any filter change invalidates the selection — see the module doc. */
  function resetSelection() {
    setSelected(new Set());
  }

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
  const canExport = exportAccess?.canExport === true;
  // The chapter column earns its place only when the rows genuinely span more
  // than one chapter — which the backend signals by naming a chapter on them.
  const showChapter = rows.some((r) => r.chapterName !== null);
  const allSelected =
    rows.length > 0 && rows.every((r) => selected.has(r.personId));

  const restorable = selectedRows.filter(canPutBack);
  const removable = selectedRows.filter((r) => !canPutBack(r));
  const exportable = selectedRows.filter((r) => r.exclusions.length === 0);

  function toggleAll() {
    setSelected((cur) => {
      if (rows.length > 0 && rows.every((r) => cur.has(r.personId))) {
        return new Set<string>();
      }
      return new Set(rows.map((r) => r.personId));
    });
  }

  function toggleOne(personId: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  /** Shift-click on web: add the whole span, never subtract. Range-deselect
   *  reads as data loss when you meant to extend, and the header checkbox
   *  already clears everything in one press. */
  function selectRange(personIds: string[]) {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of personIds) next.add(id);
      return next;
    });
  }

  async function confirmRemoval() {
    const targets = pendingRemoval ?? [];
    if (targets.length === 0) return;
    setRemoving(true);
    await run(
      () =>
        removeMany({
          personIds: targets.map((r) => r.personId as Id<"people">),
        }),
      {
        errorTitle:
          targets.length === 1 ? "Couldn't remove them" : "Couldn't remove them all",
        onSuccess: (value) => {
          // The bulk mutations are PARTIAL-SUCCESS by design: a row whose
          // person has left the roster, or sits in a chapter this caller can't
          // edit, is skipped rather than failing the other 199. Reporting only
          // `removed` would quietly turn "40 of your 42" into "42".
          const res = value as {
            removed: number;
            smsOptOutsRecorded: number;
            skipped: number;
          };
          setNotice(
            `Removed ${res.removed} from the list.` +
              (res.smsOptOutsRecorded > 0
                ? ` ${res.smsOptOutsRecorded} text opt-out${res.smsOptOutsRecorded === 1 ? "" : "s"} recorded, so nothing goes out to those numbers.`
                : "") +
              (res.skipped > 0
                ? ` ${res.skipped} skipped — they've left the roster, or they're in a chapter you can't edit.`
                : ""),
          );
          resetSelection();
        },
      },
    );
    setRemoving(false);
    setPendingRemoval(null);
  }

  /** Put back is not confirmed. It is the CORRECTION — the thing you reach for
   *  after a removal you didn't mean — and putting a dialog in front of the
   *  undo of a mistake is how you make the mistake stick. It also cannot
   *  over-promise: the result says how many are still unreachable for reasons
   *  this desk can't touch, and the notice repeats it. */
  function putBack(targets: MailingListRow[]) {
    if (targets.length === 0) return;
    void run(
      () =>
        restoreMany({
          personIds: targets.map((r) => r.personId as Id<"people">),
        }),
      {
        errorTitle: "Couldn't put them back",
        onSuccess: (value) => {
          const res = value as {
            restored: number;
            stillSuppressed: number;
            smsStillOptedOut: number;
            skipped: number;
          };
          const caveats: string[] = [];
          if (res.skipped > 0) {
            caveats.push(
              `${res.skipped} were skipped — they've left the roster, or they're in a chapter you can't edit`,
            );
          }
          if (res.stillSuppressed > 0) {
            caveats.push(
              `${res.stillSuppressed} previously unsubscribed or bounced, so we still can't email them — they'll need to re-subscribe themselves`,
            );
          }
          if (res.smsStillOptedOut > 0) {
            caveats.push(
              `${res.smsStillOptedOut} texted STOP to the carrier, which this desk can't undo`,
            );
          }
          setNotice(
            `Put ${res.restored} back on the list.` +
              (caveats.length > 0 ? ` But ${caveats.join(", and ")}.` : ""),
          );
          resetSelection();
        },
      },
    );
  }

  return (
    // FULL_WIDTH + <Narrow> around every reading section: the grid is allowed
    // to run the whole window and scroll into the empty space (the convention
    // `Screen`'s own doc describes and the People roster follows), while the
    // header, the add form and the notices stay at a readable column width.
    <Screen maxWidth={FULL_WIDTH}>
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
              onPress={() => {
                setChannel(c.value);
                resetSelection();
              }}
            />
          ))}
          <View className="flex-1" />
          <Pill
            label="On the list"
            selected={view === "subscribed"}
            onPress={() => {
              setView("subscribed");
              resetSelection();
            }}
          />
          <Pill
            label="Not reachable"
            selected={view === "excluded"}
            onPress={() => {
              setView("excluded");
              resetSelection();
            }}
          />
        </View>

        {/* The link that replaces the Google Form. Still first — handing it out
            is the fastest way this list grows — but a strip now, not a card:
            the grid is the screen, and a copy-once-a-month link had been taking
            a fold of it. */}
        <MailingListSignupLink url={signupLink()} />

        <TextField
          value={search}
          onChangeText={(t) => {
            setSearch(t);
            resetSelection();
          }}
          placeholder="Search by name or address"
          autoCapitalize="none"
        />

        <View className="mb-3 flex-row items-center gap-2">
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
            icon="download"
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
                disabled={!newName.trim() || (!newEmail.trim() && !newPhone.trim())}
                onPress={() =>
                  void run(
                    () =>
                      addToList({
                        // Omitted on the central lens — the backend falls back
                        // to the caller's own chapter rather than refusing.
                        ...(chapterId ? { chapterId } : {}),
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
                They'll join your own chapter's roster. Switch the chapter in the
                header first to file them somewhere else.
              </Text>
            ) : null}
          </Card>
        ) : null}

        {notice ? (
          <Card padding="md" className="mb-3">
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
          <MailingListCsvPanel
            title={channel === "email" ? "Email export" : "Text export"}
            rows={exported.rows}
            csv={exported.csv}
            note={
              exported.scanTruncated
                ? "Reachable people only — opted-out and unsubscribed addresses are never exported. We stopped scanning before the end of the roster, so this file is short of the full list."
                : "Reachable people only — opted-out and unsubscribed addresses are never exported. Paste it into Mailchimp."
            }
            onDismiss={() => setWantExport(false)}
          />
        ) : null}

        {selectionExport ? (
          <MailingListCsvPanel
            title="Selected"
            rows={selectionExport.rows}
            csv={selectionExport.csv}
            note="Only the reachable people in your selection — an export never carries an opt-out or a bounce across into a sending tool."
            onDismiss={() => setSelectionExport(null)}
          />
        ) : null}

        <MailingListBulkBar
          selectedCount={selected.size}
          removableCount={removable.length}
          restorableCount={restorable.length}
          exportableCount={exportable.length}
          canEdit={canEdit}
          canExport={canExport}
          onClear={resetSelection}
          onRemove={() => setPendingRemoval(removable)}
          onRestore={() => putBack(restorable)}
          onExport={() =>
            setSelectionExport({
              csv: selectionCsv(exportable, channel),
              rows: exportable.length,
            })
          }
        />
      </Narrow>

      {list === undefined ? (
        <Screen loading />
      ) : rows.length === 0 ? (
        <Narrow>
          <EmptyState
            title={
              search.trim()
                ? "Nobody matches that search"
                : view === "subscribed"
                  ? "Nobody reachable yet"
                  : "Nobody excluded"
            }
            message={
              search.trim()
                ? "Try a different name, address or number."
                : view === "subscribed"
                  ? "Share the sign-up link above, or add someone by hand."
                  : "Everyone we know about can be reached on this channel."
            }
          />
        </Narrow>
      ) : (
        <>
          <MailingListGrid
            rows={rows}
            channel={channel}
            showChapter={showChapter}
            canEdit={canEdit}
            selected={selected}
            allSelected={allSelected}
            sort={sort}
            onSortChange={setSort}
            onToggleAll={toggleAll}
            onToggleOne={toggleOne}
            onSelectRange={selectRange}
            onOpenPerson={(id, name) => setPreview({ id, name })}
            onRemoveOne={(row) => setPendingRemoval([row])}
            onRestoreOne={(row) => putBack([row])}
          />
          <Narrow>
            {list.truncated ? (
              <View className="mt-2 flex-row items-center gap-2">
                <Text className="text-xs text-muted">
                  Showing {rows.length} of {list.matched}.
                </Text>
                {limit < FULL_LIMIT ? (
                  <Button
                    title="Load the rest"
                    size="sm"
                    variant="ghost"
                    onPress={() => {
                      setLimit(FULL_LIMIT);
                      // The rows about to arrive were never part of what the
                      // selection meant.
                      resetSelection();
                    }}
                  />
                ) : (
                  <Text className="text-xs text-muted">
                    Narrow it with the search box.
                  </Text>
                )}
              </View>
            ) : null}
            {/* A DIFFERENT truncation from `truncated`: the backend stopped
                walking the roster, so the counts in the header are floors
                rather than totals. Saying nothing here would let a marketer
                read "412 reachable" as the whole org. */}
            {list.scanTruncated ? (
              <Text className="mt-2 text-xs text-warn">
                This chapter set is big enough that we stopped counting partway
                — the totals above are at least this many, not exactly this many.
              </Text>
            ) : null}
          </Narrow>
        </>
      )}

      <MailingListRemoveConfirm
        visible={pendingRemoval !== null}
        names={(pendingRemoval ?? []).map((r) => r.name || "Unnamed")}
        count={pendingRemoval?.length ?? 0}
        channel={channel}
        busy={removing}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={() => void confirmRemoval()}
      />

      <PersonPreviewModal
        personId={preview?.id ?? null}
        name={preview?.name ?? ""}
        onClose={() => setPreview(null)}
      />

      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}
