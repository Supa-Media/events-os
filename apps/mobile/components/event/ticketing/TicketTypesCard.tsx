/**
 * Ticket types — the "Sell tickets" master toggle, tier rows (price, sold,
 * active state) with inline expand-to-edit, and an inline add form. Prices
 * are entered in dollars and stored as integer cents.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Button, Card, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";
import { ToggleRow } from "./ToggleRow";
import { TicketTypeForm } from "./TicketTypeForm";
import { confirmAction, formatPrice } from "./helpers";

type TicketType = Doc<"ticketTypes">;

type Props = {
  eventId: Id<"events">;
  page: Doc<"eventPages">;
  ticketTypes: TicketType[];
  run: ActionRunner["run"];
};

export function TicketTypesCard({ eventId, page, ticketTypes, run }: Props) {
  const updatePage = useMutation(api.ticketing.updatePage);
  const createTicketType = useMutation(api.ticketing.createTicketType);
  const updateTicketType = useMutation(api.ticketing.updateTicketType);
  const deleteTicketType = useMutation(api.ticketing.deleteTicketType);

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function handleDelete(tt: TicketType) {
    confirmAction({
      title: "Remove ticket type?",
      message:
        tt.soldCount > 0
          ? `${tt.soldCount} sold — "${tt.name}" will be deactivated to keep history.`
          : `"${tt.name}" will be deleted.`,
      confirmLabel: "Remove",
      onConfirm: () =>
        void run(() => deleteTicketType({ ticketTypeId: tt._id }), {
          errorTitle: "Couldn't remove ticket type",
        }),
      destructive: true,
    });
  }

  return (
    <Card>
      <ToggleRow
        label="Sell tickets on the page"
        hint="Show the ticket tiers below on the public page."
        value={page.ticketsEnabled === true}
        onToggle={(next) =>
          void run(
            () => updatePage({ pageId: page._id, patch: { ticketsEnabled: next } }),
            { errorTitle: "Couldn't update page" },
          )
        }
      />

      {ticketTypes.length === 0 && !adding ? (
        <Text className="py-3 text-base text-muted">
          No ticket types yet — add one to start selling.
        </Text>
      ) : null}

      {ticketTypes.map((tt) => (
        <View key={tt._id} className="border-t border-border py-3">
          <View className="flex-row items-center gap-3">
            <View className="flex-1">
              <Text className="text-base font-semibold text-ink">{tt.name}</Text>
              <Text className="mt-0.5 text-sm text-muted">
                {formatPrice(tt.priceCents)} ·{" "}
                {tt.capacity != null
                  ? `${tt.soldCount}/${tt.capacity} sold`
                  : `${tt.soldCount} sold`}
              </Text>
            </View>
            <Badge
              label={tt.isActive ? "Active" : "Off"}
              tone={tt.isActive ? "success" : "neutral"}
            />
            <Pressable
              onPress={() => setEditingId(editingId === tt._id ? null : tt._id)}
              hitSlop={6}
              accessibilityLabel={`Edit ${tt.name}`}
              className="active:opacity-70"
            >
              <Icon
                name={editingId === tt._id ? "chevron-up" : "edit-2"}
                size={15}
                color={colors.muted}
              />
            </Pressable>
            <Pressable
              onPress={() => handleDelete(tt)}
              hitSlop={6}
              accessibilityLabel={`Remove ${tt.name}`}
              className="active:opacity-70"
            >
              <Icon name="x" size={15} color={colors.muted} />
            </Pressable>
          </View>
          {editingId === tt._id ? (
            <TicketTypeForm
              initial={tt}
              submitLabel="Save changes"
              onSubmit={async (values) => {
                const ok = await run(
                  () =>
                    updateTicketType({
                      ticketTypeId: tt._id,
                      patch: {
                        name: values.name,
                        priceCents: values.priceCents,
                        description: values.description?.trim() || null,
                        capacity: values.capacity,
                        maxPerOrder: values.maxPerOrder,
                      },
                    }),
                  { errorTitle: "Couldn't save ticket type" },
                );
                if (ok !== undefined) setEditingId(null);
              }}
            />
          ) : null}
        </View>
      ))}

      {adding ? (
        <View className="border-t border-border py-3">
          <Text className="mb-2 text-sm font-semibold text-ink">
            New ticket type
          </Text>
          <TicketTypeForm
            submitLabel="Add ticket type"
            onSubmit={async (values) => {
              const ok = await run(
                () =>
                  createTicketType({
                    eventId,
                    name: values.name,
                    priceCents: values.priceCents,
                    description: values.description?.trim() || undefined,
                    capacity: values.capacity ?? undefined,
                    maxPerOrder: values.maxPerOrder ?? undefined,
                  }),
                { errorTitle: "Couldn't add ticket type" },
              );
              if (ok !== undefined) setAdding(false);
            }}
          />
        </View>
      ) : (
        <View className="mt-2 flex-row">
          <Button
            title="Add ticket type"
            icon="plus"
            variant="secondary"
            size="sm"
            onPress={() => setAdding(true)}
          />
        </View>
      )}
    </Card>
  );
}
