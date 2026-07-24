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
import { Badge, Button, Card, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";
import { ToggleRow } from "./ToggleRow";
import { TicketTypeForm } from "./TicketTypeForm";
import { confirmAction, formatPrice, parseDollars } from "./helpers";

type TicketType = Doc<"ticketTypes">;

type Props = {
  eventId: Id<"events">;
  page: Doc<"eventPages">;
  ticketTypes: TicketType[];
  run: ActionRunner["run"];
  /** Hide the "Sell tickets" master toggle — used when the enclosing card
   *  (the Design phase setup checklist) already carries that switch in its
   *  header. Tier rows and the add form still render. */
  hideMasterToggle?: boolean;
  /** Render bare (no Card wrapper) — for embedding inside another surface. */
  bare?: boolean;
};

export function TicketTypesCard({
  eventId,
  page,
  ticketTypes,
  run,
  hideMasterToggle = false,
  bare = false,
}: Props) {
  const updatePage = useMutation(api.ticketing.updatePage);
  const createTicketType = useMutation(api.ticketing.createTicketType);
  const updateTicketType = useMutation(api.ticketing.updateTicketType);
  const deleteTicketType = useMutation(api.ticketing.deleteTicketType);
  const setTicketTypeSellable = useMutation(api.ticketing.setTicketTypeSellable);

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // A Givebutter mirror tier being promoted to natively sellable — shows the
  // inline price-confirm row instead of the edit form.
  const [promotingId, setPromotingId] = useState<string | null>(null);

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

  const body = (
    <>
      {hideMasterToggle ? null : (
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
      )}

      {ticketTypes.length === 0 && !adding ? (
        <Text className="py-3 text-base text-muted">
          No ticket types yet — add one to start selling.
        </Text>
      ) : null}

      {ticketTypes.map((tt) => {
        // A synced Givebutter mirror tier (created isActive:false so it can't
        // be bought natively) reads "Off" if we don't distinguish it — that
        // looks like a deliberately-deactivated tier, which it isn't. Give it
        // its own badge + a path to unify it with native sales.
        const isGivebutterMirror =
          !tt.isActive && tt.externalProvider === "givebutter";
        return (
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
                label={tt.isActive ? "Active" : isGivebutterMirror ? "Givebutter" : "Off"}
                tone={tt.isActive ? "success" : isGivebutterMirror ? "info" : "neutral"}
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

            {isGivebutterMirror ? (
              <View className="mt-2">
                <Text className="text-xs text-muted">
                  Synced from Givebutter — not sellable on this page yet.
                  Promoting it unifies native + Givebutter sales onto one
                  tier, so sold counts stop splitting across two rows.
                </Text>
                {promotingId === tt._id ? (
                  <PromoteRow
                    tt={tt}
                    onSubmit={async (priceCents) => {
                      const ok = await run(
                        () =>
                          setTicketTypeSellable({
                            ticketTypeId: tt._id,
                            priceCents,
                          }),
                        { errorTitle: "Couldn't make sellable" },
                      );
                      if (ok !== undefined) setPromotingId(null);
                    }}
                    onCancel={() => setPromotingId(null)}
                  />
                ) : (
                  <View className="mt-2 flex-row">
                    <Button
                      title="Make sellable"
                      icon="tag"
                      variant="secondary"
                      size="sm"
                      onPress={() => setPromotingId(tt._id)}
                    />
                  </View>
                )}
              </View>
            ) : null}

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
        );
      })}

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
    </>
  );

  return bare ? body : <Card>{body}</Card>;
}

/** Inline "confirm/adjust the sell price" row shown while promoting a
 *  Givebutter mirror tier — defaults to the tier's current price. */
function PromoteRow({
  tt,
  onSubmit,
  onCancel,
}: {
  tt: TicketType;
  onSubmit: (priceCents: number) => Promise<void>;
  onCancel: () => void;
}) {
  const [price, setPrice] = useState((tt.priceCents / 100).toString());
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm() {
    const priceCents = price.trim() === "" ? 0 : parseDollars(price);
    if (priceCents === null) return; // unparsable — leave the row open
    setSubmitting(true);
    await onSubmit(priceCents);
    setSubmitting(false);
  }

  return (
    <View className="mt-3">
      <TextField
        label="Sell price"
        value={price}
        onChangeText={setPrice}
        placeholder="0 = free"
        keyboardType="decimal-pad"
        hint="Confirm or adjust what this tier sells for going forward."
      />
      <View className="flex-row justify-end gap-2">
        <Button
          title="Cancel"
          variant="secondary"
          size="sm"
          onPress={onCancel}
        />
        <Button
          title="Make sellable"
          icon="check"
          size="sm"
          loading={submitting}
          onPress={() => void handleConfirm()}
        />
      </View>
    </View>
  );
}
