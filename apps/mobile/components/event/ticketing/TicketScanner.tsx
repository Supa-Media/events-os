/**
 * The door check-in camera screen: permission request → live QR scan →
 * result banner → "Scan next" — with a manual-entry fallback whenever
 * scanning isn't available (old native build, denied permission, unsupported
 * platform). Reuses `checkInTicket` — the exact same mutation and outcome
 * shape the manual-entry flow (`CheckInCard`/`ManualCheckInEntry`) already
 * uses, rendered through the same `CheckInResultBanner`.
 *
 * `expo-camera` is a GATED native dependency (see `lib/cameraScanning.ts`) —
 * this file never imports it directly, only through `loadCameraScanning()`.
 * Split into two components so the inner one only mounts (and only calls the
 * dynamically-loaded module's `useCameraPermissions` hook) once the module
 * has actually resolved — an early return in ONE component body based on a
 * value that can't change during that component's lifetime would otherwise
 * make the hook call look conditional.
 */
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Card } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";
import {
  loadCameraScanning,
  type BarcodeScanningResult,
  type CameraScanningModule,
} from "../../../lib/cameraScanning";
import { normalizeScannedCode, shouldProcessScan, type ScanLock } from "./ticketScan";
import { CheckInResultBanner, type CheckInOutcome } from "./CheckInResultBanner";
import { ManualCheckInEntry } from "./ManualCheckInEntry";

export function TicketScanner({
  eventId,
  run,
}: {
  eventId: Id<"events">;
  run: ActionRunner["run"];
}) {
  const camera = loadCameraScanning();
  const [outcome, setOutcome] = useState<CheckInOutcome | null>(null);

  if (!camera) {
    return (
      <Card>
        <Text className="mb-3 text-sm text-muted">
          Camera scanning isn't available on this device — enter the code instead.
        </Text>
        <ManualCheckInEntry eventId={eventId} run={run} onResult={setOutcome} />
        {outcome ? <CheckInResultBanner outcome={outcome} /> : null}
      </Card>
    );
  }

  return <CameraTicketScanner camera={camera} eventId={eventId} run={run} />;
}

function CameraTicketScanner({
  camera,
  eventId,
  run,
}: {
  camera: CameraScanningModule;
  eventId: Id<"events">;
  run: ActionRunner["run"];
}) {
  const { CameraView, useCameraPermissions } = camera;
  const [permission, requestPermission] = useCameraPermissions();
  const checkIn = useMutation(api.ticketing.checkInTicket);
  const [outcome, setOutcome] = useState<CheckInOutcome | null>(null);
  // A ref, not state — the lock must be read synchronously inside
  // `onBarcodeScanned`, which can fire many times before a re-render lands.
  const lockRef = useRef<ScanLock>(null);

  if (!permission) {
    return (
      <Card>
        <Text className="text-sm text-muted">Checking camera permission…</Text>
      </Card>
    );
  }

  if (!permission.granted) {
    if (permission.canAskAgain) {
      return (
        <Card>
          <Text className="mb-3 text-base font-semibold text-ink">
            Allow camera access to scan tickets
          </Text>
          <Button title="Allow camera" icon="camera" onPress={() => void requestPermission()} />
        </Card>
      );
    }
    return (
      <Card>
        <Text className="mb-3 text-sm text-muted">
          Camera access denied — enter the code instead.
        </Text>
        <ManualCheckInEntry eventId={eventId} run={run} onResult={setOutcome} />
        {outcome ? <CheckInResultBanner outcome={outcome} /> : null}
      </Card>
    );
  }

  async function handleBarcodeScanned(scan: BarcodeScanningResult) {
    const code = normalizeScannedCode(scan.data);
    const now = Date.now();
    if (!shouldProcessScan(lockRef.current, code, now)) return;
    lockRef.current = { code, at: now };
    const res = (await run(() => checkIn({ eventId, code }), {
      errorTitle: "Couldn't check in",
    })) as CheckInOutcome | undefined;
    if (res === undefined) return; // error already surfaced
    setOutcome(res);
  }

  return (
    <View>
      <View style={{ aspectRatio: 1, borderRadius: 12, overflow: "hidden" }}>
        <CameraView
          style={{ flex: 1 }}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={(scan) => void handleBarcodeScanned(scan)}
        />
      </View>
      {outcome ? (
        <Card className="mt-3">
          <CheckInResultBanner outcome={outcome} />
          <View className="mt-3">
            <Button
              title="Scan next ticket"
              icon="refresh-cw"
              variant="secondary"
              onPress={() => setOutcome(null)}
            />
          </View>
        </Card>
      ) : (
        <Text className="mt-3 text-center text-sm text-muted">
          Point the camera at a guest's ticket QR code.
        </Text>
      )}
    </View>
  );
}
