/**
 * "Reports to" — choose which seat this one sits under, from a searchable
 * TREE of the same chart rather than the flat alphabetical list the old Move
 * modal showed. Indentation says where the seat will land; the seat's own
 * branch is listed but disabled with the reason (moving a seat under one of
 * its own reports is a loop `seatStructure.reparentSeat` would refuse), so the
 * editor never picks something that can only fail.
 */
import { useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Icon } from "../ui";
import { colors } from "../../lib/theme";
import { alertError } from "../../lib/errors";
import { confirmAction } from "../../lib/confirmAction";
import { OrgModal, SearchBox } from "./OrgModal";
import { seatOutline, subtreeSlugs, type SeatNode } from "./treeUtils";

export function ReportsToPicker({
  visible,
  seat,
  chartSeats,
  onClose,
}: {
  visible: boolean;
  seat: SeatNode;
  /** Every seat in the same chart as `seat`. */
  chartSeats: readonly SeatNode[];
  onClose: () => void;
}) {
  const reparent = useMutation(api.seatStructure.reparentSeat);
  const [query, setQuery] = useState("");
  const outline = useMemo(() => seatOutline(chartSeats), [chartSeats]);
  const ownBranch = useMemo(
    () => subtreeSlugs([...chartSeats], seat.slug),
    [chartSeats, seat.slug],
  );
  const q = query.trim().toLowerCase();

  function choose(target: SeatNode) {
    confirmAction({
      title: `Move ${seat.title}?`,
      message: `${seat.title} will report to ${target.title}. Everyone under it moves along with it.`,
      confirmLabel: "Move",
      onConfirm: () =>
        void (async () => {
          try {
            await reparent({ slug: seat.slug, newParentSlug: target.slug });
            onClose();
          } catch (err) {
            alertError(err);
          }
        })(),
    });
  }

  return (
    <OrgModal
      visible={visible}
      title={`${seat.title} reports to…`}
      onClose={onClose}
      header={<SearchBox value={query} onChangeText={setQuery} placeholder="Search seats" />}
    >
      {outline
        .filter(({ seat: s }) => !q || s.title.toLowerCase().includes(q))
        .map(({ seat: s, depth }) => {
          const current = s.slug === seat.parentSlug;
          const blocked = ownBranch.has(s.slug);
          const reason = s.slug === seat.slug ? "this seat" : blocked ? "reports to this seat" : null;
          return (
            <Pressable
              key={s.slug}
              disabled={blocked || current}
              onPress={() => choose(s)}
              style={{ paddingLeft: 20 + (q ? 0 : depth * 16) }}
              className={`flex-row items-center justify-between gap-2 border-t border-border py-2.5 pr-5 ${
                current ? "bg-accent-soft" : "active:bg-sunken web:hover:bg-sunken"
              }`}
            >
              <Text
                className={`flex-1 text-sm ${
                  current ? "font-semibold text-accent" : blocked ? "text-faint" : "text-ink"
                }`}
                numberOfLines={1}
              >
                {s.title}
              </Text>
              {current ? (
                <Text className="text-xs text-accent">current</Text>
              ) : reason ? (
                <Text className="text-xs text-faint">{reason}</Text>
              ) : (
                <Icon name="chevron-right" size={15} color={colors.faint} />
              )}
            </Pressable>
          );
        })}
    </OrgModal>
  );
}
