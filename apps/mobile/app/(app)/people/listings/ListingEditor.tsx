/**
 * The job-listing form, shared by create (`new.tsx`) and edit (`[id].tsx`).
 *
 * It carries the whole role — the same field set the old markdown front-matter
 * had, so nothing a role page renders is unreachable from the OS. The shape is
 * deliberately forgiving: a recruiter can save a half-written draft and come
 * back, because completeness is only enforced at PUBLISH (`setListingPublished`
 * on the backend), never at save. String-list sections are edited one-per-line
 * — the same convention the package composer uses — and the two structured
 * sections (accountabilities, and the work by area) get small repeaters.
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import { ROLE_STATUSES, ROLE_STATUS_LABELS } from "@events-os/shared";
import { Button, Card, Icon, TextField, Select } from "../../../../components/ui";

type Listing = Doc<"jobListings">;

/** One `\n`-joined string ⇄ a clean array. The backend trims and drops blanks
 *  again (`cleanList`), so a trailing newline here is harmless. */
const toLines = (arr: readonly string[]): string => arr.join("\n");
const fromLines = (s: string): string[] =>
  s.split("\n").map((l) => l.trim()).filter(Boolean);

const STATUS_OPTIONS = ROLE_STATUSES.map((s) => ({
  value: s,
  label: ROLE_STATUS_LABELS[s],
}));
const TRACK_OPTIONS = [
  { value: "team_member", label: "Team member (shorter trial)" },
  { value: "director", label: "Director (longer trial)" },
];

export function ListingEditor({
  existing,
  onSaved,
}: {
  existing?: Listing | null;
  onSaved: (id: Id<"jobListings">) => void;
}) {
  const upsert = useMutation(api.listings.upsertListing);

  // ── simple fields ──
  const [title, setTitle] = useState(existing?.title ?? "");
  const [team, setTeam] = useState(existing?.team ?? "");
  const [location, setLocation] = useState(existing?.location ?? "");
  const [hours, setHours] = useState(
    existing?.hoursPerWeek ? String(existing.hoursPerWeek) : "",
  );
  const [reportsTo, setReportsTo] = useState(existing?.reportsTo ?? "");
  const [commitment, setCommitment] = useState(
    existing?.commitment ?? "Volunteer",
  );
  const [status, setStatus] = useState<string>(existing?.status ?? "not_open");
  const [track, setTrack] = useState<string>(
    existing?.trialTrack ?? "team_member",
  );
  const [seatId, setSeatId] = useState(existing?.seatId ?? "");
  const [order, setOrder] = useState(
    existing?.order != null ? String(existing.order) : "100",
  );

  // ── prose ──
  const [summary, setSummary] = useState(existing?.summary ?? "");
  const [why, setWhy] = useState(existing?.whyThisSeatExists ?? "");
  const [growthPath, setGrowthPath] = useState(existing?.growthPath ?? "");
  const [body, setBody] = useState(existing?.body ?? "");

  // ── one-per-line lists ──
  const [worksWith, setWorksWith] = useState(toLines(existing?.worksWith ?? []));
  const [manages, setManages] = useState(toLines(existing?.manages ?? []));
  const [authority, setAuthority] = useState(toLines(existing?.authority ?? []));
  const [rhythms, setRhythms] = useState(toLines(existing?.rhythms ?? []));
  const [firstNinety, setFirstNinety] = useState(
    toLines(existing?.firstNinetyDays ?? []),
  );
  const [required, setRequired] = useState(toLines(existing?.required ?? []));
  const [preferred, setPreferred] = useState(toLines(existing?.preferred ?? []));
  const [notThis, setNotThis] = useState(toLines(existing?.notThisRole ?? []));
  const [successLooks, setSuccessLooks] = useState(
    toLines(existing?.successLooks ?? []),
  );

  // ── structured repeaters ──
  const [outcomes, setOutcomes] = useState<
    { outcome: string; doneWhen: string }[]
  >(existing?.outcomes ?? []);
  const [responsibilities, setResponsibilities] = useState<
    { area: string; items: string }[]
  >(
    (existing?.responsibilities ?? []).map((r) => ({
      area: r.area,
      items: toLines(r.items),
    })),
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Give the listing a title to start.");
      return;
    }
    setSaving(true);
    try {
      const id = await upsert({
        ...(existing ? { listingId: existing._id } : {}),
        title: trimmedTitle,
        team,
        location,
        hoursPerWeek: Number.parseInt(hours, 10) || 0,
        reportsTo,
        commitment,
        status: status as (typeof ROLE_STATUSES)[number],
        trialTrack: track as "team_member" | "director",
        seatId: seatId.trim() || null,
        order: Number.parseInt(order, 10) || 100,
        summary,
        whyThisSeatExists: why,
        growthPath: growthPath.trim() || null,
        body: body.trim() || null,
        worksWith: fromLines(worksWith),
        manages: fromLines(manages),
        authority: fromLines(authority),
        rhythms: fromLines(rhythms),
        firstNinetyDays: fromLines(firstNinety),
        required: fromLines(required),
        preferred: fromLines(preferred),
        notThisRole: fromLines(notThis),
        successLooks: fromLines(successLooks),
        outcomes: outcomes
          .map((o) => ({
            outcome: o.outcome.trim(),
            doneWhen: o.doneWhen.trim(),
          }))
          .filter((o) => o.outcome || o.doneWhen),
        responsibilities: responsibilities
          .map((r) => ({ area: r.area.trim(), items: fromLines(r.items) }))
          .filter((r) => r.area && r.items.length > 0),
      });
      onSaved(id);
    } catch (e) {
      setError(
        (e as { data?: { message?: string } })?.data?.message ??
          "Couldn't save — check your access and try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="gap-3">
      <Card padding="md">
        <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          The basics
        </Text>
        <TextField
          label="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="People Director"
        />
        <TextField
          label="Team"
          value={team}
          onChangeText={setTeam}
          placeholder="People"
        />
        <TextField
          label="Location"
          value={location}
          onChangeText={setLocation}
          placeholder="Remote, or NYC-based preferred"
        />
        <TextField
          label="Hours per week"
          value={hours}
          onChangeText={setHours}
          placeholder="10"
          keyboardType="number-pad"
        />
        <TextField
          label="Reports to"
          value={reportsTo}
          onChangeText={setReportsTo}
          placeholder="Executive Director"
        />
        <TextField
          label="Commitment"
          value={commitment}
          onChangeText={setCommitment}
          placeholder="Volunteer"
        />
        <Select
          label="Status"
          value={status}
          options={STATUS_OPTIONS}
          onChange={setStatus}
        />
        <Select
          label="Trial track"
          value={track}
          options={TRACK_OPTIONS}
          onChange={setTrack}
        />
        <TextField
          label="Seat id (optional)"
          hint="The seat in the org chart this fills, if any."
          value={seatId}
          onChangeText={setSeatId}
          placeholder="expansion_director"
        />
        <TextField
          label="Sort order"
          hint="Lower shows first on /team."
          value={order}
          onChangeText={setOrder}
          keyboardType="number-pad"
        />
      </Card>

      <Card padding="md">
        <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          The pitch
        </Text>
        <TextField
          label="The short version"
          value={summary}
          onChangeText={setSummary}
          placeholder="What this seat is, in two or three sentences."
          multiline
        />
        <TextField
          label="Why this seat exists"
          value={why}
          onChangeText={setWhy}
          placeholder="The problem it solves for the org."
          multiline
        />
      </Card>

      <Card padding="md">
        <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
          What you'd be accountable for
        </Text>
        <Text className="mb-2 text-xs text-muted">
          Each outcome pairs with its definition of done — an accountability
          with no "done when" comes straight back.
        </Text>
        {outcomes.map((o, i) => (
          <View key={i} className="mb-3 rounded-md border border-border p-3">
            <TextField
              label={`Outcome ${i + 1}`}
              value={o.outcome}
              onChangeText={(t) =>
                setOutcomes((prev) =>
                  prev.map((x, j) => (j === i ? { ...x, outcome: t } : x)),
                )
              }
              placeholder="One pipeline everyone passes through"
              multiline
            />
            <TextField
              label="Done when"
              value={o.doneWhen}
              onChangeText={(t) =>
                setOutcomes((prev) =>
                  prev.map((x, j) => (j === i ? { ...x, doneWhen: t } : x)),
                )
              }
              placeholder="Someone can apply, be interviewed, and get an answer without the ED."
              multiline
            />
            <RemoveRow
              onPress={() =>
                setOutcomes((prev) => prev.filter((_, j) => j !== i))
              }
              label="Remove outcome"
            />
          </View>
        ))}
        <AddRow
          label="Add an outcome"
          onPress={() =>
            setOutcomes((prev) => [...prev, { outcome: "", doneWhen: "" }])
          }
        />
      </Card>

      <Card padding="md">
        <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          What you'd get to decide
        </Text>
        <TextField
          label="Authority (one per line)"
          value={authority}
          onChangeText={setAuthority}
          placeholder={"Say no to a candidate\nSet the interview standard"}
          multiline
        />
      </Card>

      <Card padding="md">
        <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
          The work itself
        </Text>
        <Text className="mb-2 text-xs text-muted">
          Group the work by area; list the items under each, one per line.
        </Text>
        {responsibilities.map((r, i) => (
          <View key={i} className="mb-3 rounded-md border border-border p-3">
            <TextField
              label={`Area ${i + 1}`}
              value={r.area}
              onChangeText={(t) =>
                setResponsibilities((prev) =>
                  prev.map((x, j) => (j === i ? { ...x, area: t } : x)),
                )
              }
              placeholder="Recruiting and talent"
            />
            <TextField
              label="Items (one per line)"
              value={r.items}
              onChangeText={(t) =>
                setResponsibilities((prev) =>
                  prev.map((x, j) => (j === i ? { ...x, items: t } : x)),
                )
              }
              placeholder={"Own both pipelines\nBuild the interview system"}
              multiline
            />
            <RemoveRow
              onPress={() =>
                setResponsibilities((prev) => prev.filter((_, j) => j !== i))
              }
              label="Remove area"
            />
          </View>
        ))}
        <AddRow
          label="Add an area"
          onPress={() =>
            setResponsibilities((prev) => [...prev, { area: "", items: "" }])
          }
        />
      </Card>

      <Card padding="md">
        <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Rhythms and the first 90 days
        </Text>
        <TextField
          label="Rhythms (one per line)"
          value={rhythms}
          onChangeText={setRhythms}
          placeholder={"Weekly 1:1 with the ED\nWeekly pass through the pipeline"}
          multiline
        />
        <TextField
          label="First 90 days (one per line)"
          value={firstNinety}
          onChangeText={setFirstNinety}
          placeholder={"Interview the current team\nTake the pipeline off the ED's desk"}
          multiline
        />
      </Card>

      <Card padding="md">
        <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Who this is for
        </Text>
        <TextField
          label="Required (one per line)"
          value={required}
          onChangeText={setRequired}
          placeholder={"Rooted in a local church\nGood with people"}
          multiline
        />
        <TextField
          label="Preferred (one per line)"
          value={preferred}
          onChangeText={setPreferred}
          placeholder={"Experience developing people\nStarted something new before"}
          multiline
        />
      </Card>

      <Card padding="md">
        <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Boundaries and success
        </Text>
        <TextField
          label="What this role is NOT (one per line)"
          value={notThis}
          onChangeText={setNotThis}
          placeholder={"Not HR administration\nNot the manager of every volunteer"}
          multiline
        />
        <TextField
          label="What success looks like (one per line)"
          value={successLooks}
          onChangeText={setSuccessLooks}
          placeholder={"The org grows without the ED carrying every conversation"}
          multiline
        />
      </Card>

      <Card padding="md">
        <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Relationships & extras
        </Text>
        <TextField
          label="Works with (one per line)"
          value={worksWith}
          onChangeText={setWorksWith}
          placeholder={"Functional Directors\nChapter Directors"}
          multiline
        />
        <TextField
          label="Manages (one per line)"
          value={manages}
          onChangeText={setManages}
          placeholder={"Chapter Directors\nThe People team as it grows"}
          multiline
        />
        <TextField
          label="Where it can go (optional)"
          value={growthPath}
          onChangeText={setGrowthPath}
          placeholder="How this seat can grow over time."
          multiline
        />
        <TextField
          label="Closing words (optional)"
          hint="Free prose shown at the bottom of the role page. Blank lines are paragraph breaks."
          value={body}
          onChangeText={setBody}
          placeholder="Anything you'd want a candidate to read last."
          multiline
        />
      </Card>

      {error ? <Text className="text-sm text-danger">{error}</Text> : null}
      <Button
        title={existing ? "Save changes" : "Create listing"}
        onPress={save}
        loading={saving}
      />
    </View>
  );
}

function AddRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-1.5 self-start rounded-md border border-border-strong px-3 py-2"
    >
      <Icon name="plus" size={15} />
      <Text className="text-sm font-medium text-ink">{label}</Text>
    </Pressable>
  );
}

function RemoveRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="mt-1 flex-row items-center gap-1.5 self-start">
      <Icon name="trash-2" size={14} color="#b91c1c" />
      <Text className="text-xs font-medium text-danger">{label}</Text>
    </Pressable>
  );
}
