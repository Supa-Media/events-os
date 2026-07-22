/**
 * The Design phase — "shape the page guests will see". Opens with a live guest
 * preview, then a short checklist of collapsible setup cards (cover & story,
 * location, RSVP & guests, tickets, giving) with one open at a time. This is the
 * old flat PageSetupCard, reorganized so the phase reads as a preview + a
 * five-item checklist instead of ~15 stacked inputs.
 *
 * Editing model is unchanged from before: text fields buffer locally and commit
 * on the single "Save page" button; switches and the visibility pills save
 * immediately.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useAction, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import { Button, Pill, TextField, Field, LocationAutocomplete } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";
import { CoverPhotoPicker } from "./CoverPhotoPicker";
import { ToggleRow } from "./ToggleRow";
import { SetupCard } from "./SetupCard";
import { EventPagePreview } from "./EventPagePreview";
import { TicketTypesCard } from "./TicketTypesCard";
import { GivebutterSyncCard } from "./GivebutterSyncCard";
import { parseDollars } from "./helpers";

type CardKey = "autofill" | "cover" | "location" | "rsvp" | "tickets" | "giving";

type Props = {
  eventId: Id<"events">;
  page: Doc<"eventPages">;
  coverUrl: string | null;
  ticketTypes: Doc<"ticketTypes">[];
  run: ActionRunner["run"];
  eventName: string;
  dateLabel: string | null;
};

export function DesignPhase({
  eventId,
  page,
  coverUrl,
  ticketTypes,
  run,
  eventName,
  dateLabel,
}: Props) {
  const updatePage = useMutation(api.ticketing.updatePage);
  const autofillEventPage = useAction(api.aiActions.autofillEventPage);

  // Local edit buffers, seeded from the server row once.
  const [tagline, setTagline] = useState(page.tagline ?? "");
  const [description, setDescription] = useState(page.description ?? "");
  const [venueName, setVenueName] = useState(page.venueName ?? "");
  const [address, setAddress] = useState(page.address ?? "");
  const [givingPrompt, setGivingPrompt] = useState(page.givingPrompt ?? "");
  const [capacity, setCapacity] = useState(
    page.capacity != null ? String(page.capacity) : "",
  );
  const [goalInput, setGoalInput] = useState(
    page.goalCents != null ? String(page.goalCents / 100) : "",
  );
  const [saving, setSaving] = useState(false);
  const [openCard, setOpenCard] = useState<CardKey | null>("cover");

  // "Fill page with AI": nothing to type — the action gathers the event's own
  // plan (tasks, comms, run of show…) server-side and drafts the copy from it.
  const [autofilling, setAutofilling] = useState(false);

  const patchPage = (patch: Parameters<typeof updatePage>[0]["patch"]) =>
    run(() => updatePage({ pageId: page._id, patch }), {
      errorTitle: "Couldn't update page",
    });

  function toggle(card: CardKey) {
    setOpenCard((cur) => (cur === card ? null : card));
  }

  async function handleSave() {
    const capTrimmed = capacity.trim();
    const capParsed =
      capTrimmed === "" ? null : Math.max(0, Math.floor(Number(capTrimmed)));
    const goalTrimmed = goalInput.trim();
    const goalParsed = goalTrimmed === "" ? null : parseDollars(goalTrimmed);
    setSaving(true);
    await patchPage({
      tagline: tagline.trim(),
      description: description.trim(),
      venueName: venueName.trim(),
      address: address.trim(),
      givingPrompt: givingPrompt.trim() || null,
      ...(capParsed === null || !Number.isNaN(capParsed)
        ? { capacity: capParsed }
        : {}),
      // Blank clears the goal; an unparsable non-blank value is left alone
      // (skipped) so a typo doesn't silently wipe an existing goal.
      ...(goalTrimmed === "" || goalParsed !== null
        ? { goalCents: goalParsed }
        : {}),
    });
    setSaving(false);
  }

  /**
   * One action call drafts tagline/description/givingPrompt from the event's
   * own plan, then merges into the LOCAL edit buffers only — nothing is saved
   * until "Save page", so the existing buffer-until-save flow is the review step.
   */
  async function handleAutofill() {
    setAutofilling(true);
    const result = await run(
      () => autofillEventPage({ eventId, pageId: page._id }),
      { errorTitle: "Couldn't fill the page" },
    );
    setAutofilling(false);
    if (!result) return;
    if (result.fields.tagline !== undefined) setTagline(result.fields.tagline);
    if (result.fields.description !== undefined)
      setDescription(result.fields.description);
    if (result.fields.givingPrompt !== undefined)
      setGivingPrompt(result.fields.givingPrompt);
    // Open "Cover & story" so the drafted copy is visible without another tap.
    setOpenCard("cover");
  }

  const rsvpOn = page.rsvpEnabled !== false;
  const ticketsOn = page.ticketsEnabled === true;
  const givingOn = page.givingEnabled === true;

  return (
    <View>
      {/* The thesis of this phase: you're shaping a page. */}
      <EventPagePreview
        name={eventName}
        tagline={tagline}
        venue={venueName}
        dateLabel={dateLabel}
        coverUrl={coverUrl}
      />

      <View className="gap-2.5">
        {/* Fill page with AI — the event's own plan (tasks, comms, run of
            show…) is the context; the draft lands in the same local buffers
            and "Save page" stays the commit gate. */}
        <SetupCard
          icon="sparkles"
          title="Fill page with AI"
          status={{ label: "Optional", tone: "opt" }}
          open={openCard === "autofill"}
          onToggleOpen={() => toggle("autofill")}
        >
          <Text className="mb-2 text-xs text-muted">
            Drafts the tagline, description & giving prompt from this event's
            plan — tasks, comms, run of show, and more.
          </Text>
          <View className="flex-row justify-end">
            <Button
              title="Fill page with AI"
              icon="sparkles"
              loading={autofilling}
              onPress={() => void handleAutofill()}
            />
          </View>
        </SetupCard>

        {/* Cover & story */}
        <SetupCard
          icon="image"
          title="Cover & story"
          status={
            tagline.trim()
              ? { label: "Set", tone: "done" }
              : { label: "Add a tagline", tone: "opt" }
          }
          open={openCard === "cover"}
          onToggleOpen={() => toggle("cover")}
        >
          <CoverPhotoPicker page={page} coverUrl={coverUrl} run={run} />
          <TextField
            label="Tagline"
            value={tagline}
            onChangeText={setTagline}
            placeholder="One line that sells the night"
          />
          <TextField
            label="Description"
            value={description}
            onChangeText={setDescription}
            placeholder="What should guests expect?"
            multiline
            numberOfLines={4}
            style={{ minHeight: 96, textAlignVertical: "top" }}
          />
        </SetupCard>

        {/* Location */}
        <SetupCard
          icon="map-pin"
          title="Location"
          status={
            venueName.trim()
              ? { label: "Set", tone: "done" }
              : { label: "Add a venue", tone: "opt" }
          }
          open={openCard === "location"}
          onToggleOpen={() => toggle("location")}
        >
          <TextField
            label="Venue name"
            value={venueName}
            onChangeText={setVenueName}
            placeholder="The Chapel"
          />
          {/* Google Places autocomplete — buffers like the other fields and
              commits on "Save page"; picking a suggestion fills the full
              address via onChangeText/onSelect. */}
          <LocationAutocomplete
            label="Address"
            value={address}
            onChangeText={setAddress}
            onSelect={setAddress}
            placeholder="123 Main St, Austin TX"
          />
          <Field label="Who sees the address">
            <View className="flex-row gap-2">
              <Pill
                label="Everyone"
                selected={page.addressVisibility === "public"}
                onPress={() => void patchPage({ addressVisibility: "public" })}
              />
              <Pill
                label="Only after RSVP"
                selected={page.addressVisibility === "after_rsvp"}
                onPress={() => void patchPage({ addressVisibility: "after_rsvp" })}
              />
            </View>
          </Field>
        </SetupCard>

        {/* RSVP & guests */}
        <SetupCard
          icon="users"
          title="RSVP & guests"
          status={
            rsvpOn
              ? { label: "RSVPs on", tone: "done" }
              : { label: "RSVPs off", tone: "opt" }
          }
          open={openCard === "rsvp"}
          onToggleOpen={() => toggle("rsvp")}
        >
          {!rsvpOn ? (
            <Text className="mb-2 text-xs text-muted">
              RSVPs are off — this reads as a ticket/event page instead of an
              RSVP page. Ticket buyers get in without RSVPing first.
            </Text>
          ) : null}
          <ToggleRow
            label="Let guests RSVP"
            hint={
              rsvpOn
                ? "Going / maybe / can't go."
                : "Off — turn on if you also want a Going/Maybe/Can't go headcount."
            }
            value={rsvpOn}
            onToggle={(next) => void patchPage({ rsvpEnabled: next })}
          />
          <ToggleRow
            label="Show the guest list"
            hint="Guests can see who's coming."
            value={page.showGuestList !== false}
            onToggle={(next) => void patchPage({ showGuestList: next })}
          />
          <ToggleRow
            label="Lock activity until RSVP"
            hint="Comments and the feed unlock after guests RSVP."
            value={page.activityRestricted !== false}
            onToggle={(next) => void patchPage({ activityRestricted: next })}
          />
          <View className="mt-3">
            <TextField
              label="Cap the guest list"
              value={capacity}
              onChangeText={setCapacity}
              placeholder="Unlimited"
              keyboardType="numeric"
              hint="Optional — 'going' RSVPs stop at this number."
            />
          </View>
        </SetupCard>

        {/* Sell tickets — opt-in */}
        <SetupCard
          icon="tag"
          title="Sell tickets"
          status={
            ticketsOn
              ? { label: "On", tone: "done" }
              : { label: "Off", tone: "off" }
          }
          open={openCard === "tickets"}
          onToggleOpen={() => toggle("tickets")}
          toggle={{
            value: ticketsOn,
            onToggle: (next) => {
              void patchPage({ ticketsEnabled: next });
              if (next) setOpenCard("tickets");
            },
          }}
        >
          <TicketTypesCard
            eventId={eventId}
            page={page}
            ticketTypes={ticketTypes}
            run={run}
            hideMasterToggle
            bare
          />
          {/* Import tickets sold on a Givebutter campaign (poll-only sync). */}
          <GivebutterSyncCard eventId={eventId} page={page} run={run} />
        </SetupCard>

        {/* Accept donations — opt-in */}
        <SetupCard
          icon="heart"
          title="Accept donations"
          status={
            givingOn
              ? { label: "On", tone: "done" }
              : { label: "Off", tone: "off" }
          }
          open={openCard === "giving"}
          onToggleOpen={() => toggle("giving")}
          toggle={{
            value: givingOn,
            onToggle: (next) => {
              void patchPage({ givingEnabled: next });
              if (next) setOpenCard("giving");
            },
          }}
        >
          <TextField
            label="Giving prompt"
            value={givingPrompt}
            onChangeText={setGivingPrompt}
            placeholder="Help us keep worship free for everyone."
            hint="Shown above the donation buttons. Saved with the button below."
            multiline
            numberOfLines={2}
            style={{ minHeight: 60, textAlignVertical: "top" }}
          />
          <TextField
            label="Fundraising goal"
            value={goalInput}
            onChangeText={setGoalInput}
            placeholder="No goal set"
            keyboardType="decimal-pad"
            hint="Optional — shows a $raised / $goal progress bar on the page and the live pulse. Blank clears it. Saved with the button below."
          />
        </SetupCard>
      </View>

      <View className="mt-4 flex-row justify-end">
        <Button
          title="Save page"
          icon="check"
          loading={saving}
          onPress={() => void handleSave()}
        />
      </View>
    </View>
  );
}
