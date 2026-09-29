/**
 * Add seat — the modal behind the "+" under a seat box, shown to anyone who
 * can edit the chart (superuser or `org.chart.edit`; the backend's
 * `seatStructure.addSeat` enforces it). Name, how many people it seats, and
 * its powers, chosen in the same `PowersPicker` every other surface uses.
 *
 * Everything else this file used to hold — the "Edit structure" banner, the
 * inline rename, the Edit seat modal with its flat checkbox list of every
 * power, and the flat Move list — was replaced by the seat panel's tabs
 * (`SeatDetailPanel`), where each of those now happens in place.
 *
 * Duties are NOT set here — `seatDefs.duties` is a seeded template list
 * superseded by Work → Duties (`responsibilities.ts`); a new seat starts with
 * none, and its Duties tab is where they're added.
 *
 * Failures surface the backend's `ConvexError` message VERBATIM
 * (`alertError`) — they're written for the person seeing them.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { MULTI_HOLDER_CAP, powerLabel, type Power } from "@events-os/shared";
import { Button } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { OrgModal } from "./OrgModal";
import { PowersPicker } from "./PowersPicker";

export function AddSeatModal({
  visible,
  chart,
  parentSlug,
  parentTitle,
  onClose,
}: {
  visible: boolean;
  chart: "central" | "chapter" | null;
  parentSlug: string | null;
  parentTitle: string | null;
  onClose: () => void;
}) {
  const addSeat = useMutation(api.seatStructure.addSeat);
  const [title, setTitle] = useState("");
  const [several, setSeveral] = useState(false);
  const [powers, setPowers] = useState<Power[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setTitle("");
      setSeveral(false);
      setPowers([]);
    }
  }, [visible]);

  async function submit() {
    if (!chart || !parentSlug || !title.trim()) return;
    setSubmitting(true);
    try {
      await addSeat({
        chart,
        parentSlug,
        title: title.trim(),
        maxHolders: several ? MULTI_HOLDER_CAP : 1,
        duties: [],
        capabilities: powers,
      });
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (!visible || !parentSlug || !chart) return null;

  return (
    <>
      <OrgModal
        visible={visible && !pickerOpen}
        title={`Add a seat under ${parentTitle}`}
        subtitle={chart === "chapter" ? "Added to every chapter's chart." : undefined}
        onClose={onClose}
        footer={
          <>
            <Button title="Cancel" variant="ghost" onPress={onClose} />
            <Button
              title="Add seat"
              onPress={() => void submit()}
              disabled={!title.trim()}
              loading={submitting}
            />
          </>
        }
      >
        <View className="gap-5 px-5 py-4">
          <View className="gap-1.5">
            <Text className="text-sm font-semibold text-ink">Name</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Volunteer Coordinator"
              placeholderTextColor={colors.faint}
              autoFocus
              className="rounded-md border border-border-strong bg-raised px-3 py-2.5 text-base text-ink"
            />
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-semibold text-ink">Seat size</Text>
            <View className="flex-row overflow-hidden rounded-md border border-border-strong">
              {[
                { value: false, label: "One person" },
                { value: true, label: "Several people" },
              ].map((o, i) => {
                const on = several === o.value;
                return (
                  <Pressable
                    key={o.label}
                    onPress={() => setSeveral(o.value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    className={`flex-1 items-center py-2 ${i > 0 ? "border-l border-border-strong" : ""} ${
                      on ? "bg-accent-soft" : "bg-raised"
                    }`}
                  >
                    <Text className={`text-sm ${on ? "font-semibold text-accent" : "text-muted"}`}>
                      {o.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {several ? (
              <Text className="text-xs text-faint">
                Up to {MULTI_HOLDER_CAP} people{chart === "chapter" ? " per chapter" : ""}.
              </Text>
            ) : null}
          </View>

          <View className="gap-1.5">
            <Text className="text-sm font-semibold text-ink">Powers</Text>
            <Text className="text-sm text-muted">
              {powers.length === 0 ? "None yet. Standard member access." : powers.map(powerLabel).join(", ")}
            </Text>
            <Button
              title={powers.length ? "Change powers" : "Choose powers"}
              variant="secondary"
              size="sm"
              icon="shield"
              onPress={() => setPickerOpen(true)}
              className="self-start"
            />
          </View>
        </View>
      </OrgModal>

      <PowersPicker
        visible={pickerOpen}
        seatTitle={title.trim() || "the new seat"}
        chart={chart}
        initial={powers}
        onSave={(next) => setPowers(next)}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}
