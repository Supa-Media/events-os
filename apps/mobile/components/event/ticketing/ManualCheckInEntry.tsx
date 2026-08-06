/**
 * The manual ticket-code entry field + "Check in" button — extracted from
 * `CheckInCard` so `TicketScanner` can render the EXACT same fallback UI
 * when the camera isn't available (old native build, denied permission,
 * unsupported platform), without duplicating the field/button JSX. Owns its
 * own `code`/`busy` state; reports each result up via `onResult` so the
 * caller decides how to render the outcome (`CheckInResultBanner`).
 */
import { useState } from "react";
import { View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, TextField } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";
import type { CheckInOutcome } from "./CheckInResultBanner";

export function ManualCheckInEntry({
  eventId,
  run,
  onResult,
  trailing,
}: {
  eventId: Id<"events">;
  run: ActionRunner["run"];
  onResult: (outcome: CheckInOutcome) => void;
  /** Extra control(s) rendered in the same row as "Check in" (e.g. CheckInCard's
   *  "Scan QR code" button) — kept as a slot so this component owns no
   *  navigation concerns of its own. */
  trailing?: React.ReactNode;
}) {
  const checkIn = useMutation(api.ticketing.checkInTicket);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleCheckIn() {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    const res = (await run(() => checkIn({ eventId, code: trimmed }), {
      errorTitle: "Couldn't check in",
    })) as CheckInOutcome | undefined;
    setBusy(false);
    if (res === undefined) return; // error already surfaced
    onResult(res);
    if (res.result === "ok") setCode("");
  }

  return (
    <>
      <TextField
        label="Ticket code"
        value={code}
        onChangeText={(t) => setCode(t.toUpperCase())}
        placeholder="PW-XXXX-XXXX"
        autoCapitalize="characters"
        autoCorrect={false}
        onSubmitEditing={() => void handleCheckIn()}
      />
      <View className="flex-row items-center gap-3">
        <Button
          title="Check in"
          icon="check-circle"
          loading={busy}
          disabled={code.trim() === ""}
          onPress={() => void handleCheckIn()}
        />
        {trailing}
      </View>
    </>
  );
}
