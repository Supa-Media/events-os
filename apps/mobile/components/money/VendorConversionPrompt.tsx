/**
 * The Money-page grid's guided item→vendor conversion prompt (PR4.5a follow-
 * up): picking "Vendor…" in an item row's Type cell does NOT convert
 * silently — it opens this "Who's the vendor?" step, reusing the same
 * `PersonPicker` combobox (pick existing / create new) `CrewSections.tsx`
 * uses for adding vendors, with a one-line cost preview so the user knows
 * what they're about to turn into a paid engagement. Cancel (closing the
 * picker without choosing anyone) makes no change — `items.convertItemToVendor`
 * is only called once a person is resolved.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { PersonPicker } from "../ui/PersonPicker";
import { alertError, alertInfo } from "../../lib/errors";

export function VendorConversionPrompt({
  visible,
  itemId,
  itemLabel,
  plannedCents,
  onClose,
}: {
  visible: boolean;
  itemId: Id<"eventItems">;
  itemLabel: string;
  plannedCents: number;
  onClose: () => void;
}) {
  const convertToVendor = useMutation(api.items.convertItemToVendor);
  const createPerson = useMutation(api.people.create);
  const [converting, setConverting] = useState(false);

  async function convert(personId: Id<"people">) {
    setConverting(true);
    try {
      const result = await convertToVendor({ itemId, personId });
      // PR #232's contract: a missing item echoes back `engagementId: null`
      // rather than throwing — NOT a success. Someone else likely already
      // converted/removed it; say so instead of quietly closing as if it worked.
      if (result.engagementId === null) {
        alertInfo(
          `"${itemLabel}" was already removed or converted — refresh to see the latest.`,
        );
      }
      onClose();
    } catch (err) {
      // MULTI_COST_CONVERSION (and any other ConvexError) surfaces its own
      // readable message via alertError's ConvexError unwrap.
      alertError(err);
    } finally {
      setConverting(false);
    }
  }

  async function handlePick(personId: string) {
    if (converting) return;
    await convert(personId as Id<"people">);
  }

  async function handleCreate(name: string) {
    if (converting) return;
    setConverting(true);
    try {
      const personId = await createPerson({ name });
      setConverting(false);
      await convert(personId);
    } catch (err) {
      setConverting(false);
      alertError(err);
    }
  }

  return (
    <PersonPicker
      visible={visible}
      title="Who's the vendor?"
      subtitle={`${itemLabel} · ${formatCents(plannedCents)} → becomes a paid vendor engagement`}
      onPick={(id) => void handlePick(id)}
      onCreate={(name) => void handleCreate(name)}
      onClose={onClose}
    />
  );
}
