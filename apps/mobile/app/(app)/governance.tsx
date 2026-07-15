/**
 * GOVERNANCE — super-admin management of specialized leadership + finance roles.
 *
 * A grid of SCOPES × SLOTS. Each scope (the org "central" level + every chapter)
 * has two slots: a LEADERSHIP slot (Executive Director for central, President for
 * a chapter) and a FINANCE MANAGER slot. One holder per (scope, title) slot; a
 * super-admin assigns the holder via the shared PersonPicker or removes them.
 *
 * Separation of duties is enforced server-side (scope-local: one person can't be
 * both leadership AND finance in the same scope). On any assign failure — most
 * notably `SOD_VIOLATION` — the ConvexError message is surfaced INLINE under the
 * offending slot rather than in a global toast, so it reads against the cell it
 * belongs to.
 *
 * Super-admin gated end-to-end: every backend function calls `requireSuperuser`,
 * and this screen redirects non-superusers away (mirrors guest-access.tsx).
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { Redirect } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  SPECIALIZED_ROLE_META,
  type SpecializedRoleTitle,
} from "@events-os/shared";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
} from "../../components/ui";
import { PersonPicker } from "../../components/ui/PersonPicker";
import { errorMessage } from "../../lib/errors";

/** A scope is the org level ("central") or a specific chapter id. */
type Scope = Id<"chapters"> | "central";

/** A slot = one assignable (scope, title) cell in the grid. */
type Slot = { scope: Scope; title: SpecializedRoleTitle };

/** Stable key for a slot, used for the per-cell inline-error map + picker id. */
function slotKey(scope: Scope, title: SpecializedRoleTitle): string {
  return `${scope}:${title}`;
}

export default function GovernanceScreen() {
  const me = useQuery(api.profiles.me);
  const gate = me?.isSuperuser ? {} : "skip";
  const chapters = useQuery(api.profiles.listChapters, gate);
  const roles = useQuery(api.specializedRoles.listSpecializedRoles, gate);

  const assign = useMutation(api.specializedRoles.assignSpecializedRole);
  const remove = useMutation(api.specializedRoles.removeSpecializedRole);

  // The slot whose PersonPicker is open (null = closed).
  const [pickerSlot, setPickerSlot] = useState<Slot | null>(null);
  // Per-slot inline error message (keyed by slotKey), e.g. an SoD violation.
  const [errors, setErrors] = useState<Record<string, string>>(() => ({}));

  // Redirect non-superusers away — the whole surface is super-admin only. Wait
  // for `me` to resolve first so we don't bounce during the initial load.
  if (me !== undefined && !me?.isSuperuser) {
    return <Redirect href="/" />;
  }
  if (me === undefined || chapters === undefined || roles === undefined) {
    return <Screen loading />;
  }

  /** The current holder of a slot, if any. */
  const holderOf = (scope: Scope, title: SpecializedRoleTitle) =>
    roles.find((r) => r.scope === scope && r.title === title) ?? null;

  const setSlotError = (key: string, message: string | null) =>
    setErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[key];
      else next[key] = message;
      return next;
    });

  const handlePick = async (personId: string) => {
    if (!pickerSlot) return;
    const { scope, title } = pickerSlot;
    const key = slotKey(scope, title);
    setPickerSlot(null);
    try {
      await assign({ personId: personId as Id<"people">, scope, title });
      setSlotError(key, null);
    } catch (err) {
      setSlotError(key, errorMessage(err));
    }
  };

  const handleRemove = async (
    scope: Scope,
    title: SpecializedRoleTitle,
    roleId: Id<"specializedRoles">,
  ) => {
    const key = slotKey(scope, title);
    try {
      await remove({ roleId });
      setSlotError(key, null);
    } catch (err) {
      setSlotError(key, errorMessage(err));
    }
  };

  // Rows: Central first, then every chapter. Central's leadership slot is the
  // Executive Director; a chapter's is the President. Both carry a Finance
  // Manager slot.
  const rows: { scope: Scope; name: string; leadership: SpecializedRoleTitle }[] =
    [
      { scope: "central", name: "Central (org)", leadership: "executive_director" },
      ...chapters.map((c) => ({
        scope: c._id as Scope,
        name: c.name,
        leadership: "president" as SpecializedRoleTitle,
      })),
    ];

  return (
    <Screen>
      <Narrow>
        <Text className="mb-1 font-display text-2xl text-ink">Governance</Text>
        <Text className="mb-4 text-sm text-muted">
          Assign leadership and finance roles at the org (central) level and for
          each chapter. One person holds each slot; a person can&apos;t hold both
          a leadership and a finance role in the same scope.
        </Text>

        <View className="mb-4 flex-row items-center gap-2">
          <Badge label="Super-admin only" tone="lavender" icon="lock" />
        </View>

        {rows.map((row) => (
          <View key={String(row.scope)} className="mb-4">
            <SectionHeader title={row.name} />
            <Card>
              <View className="gap-3">
                <SlotRow
                  slotLabel={SPECIALIZED_ROLE_META[row.leadership].label}
                  kindLabel="Leadership"
                  holder={holderOf(row.scope, row.leadership)}
                  error={errors[slotKey(row.scope, row.leadership)] ?? null}
                  onAssign={() =>
                    setPickerSlot({ scope: row.scope, title: row.leadership })
                  }
                  onRemove={(roleId) =>
                    void handleRemove(row.scope, row.leadership, roleId)
                  }
                />
                <View className="h-px bg-border" />
                <SlotRow
                  slotLabel={SPECIALIZED_ROLE_META.finance_manager.label}
                  kindLabel="Finance"
                  holder={holderOf(row.scope, "finance_manager")}
                  error={errors[slotKey(row.scope, "finance_manager")] ?? null}
                  onAssign={() =>
                    setPickerSlot({ scope: row.scope, title: "finance_manager" })
                  }
                  onRemove={(roleId) =>
                    void handleRemove(row.scope, "finance_manager", roleId)
                  }
                />
              </View>
            </Card>
          </View>
        ))}

        {chapters.length === 0 ? (
          <EmptyState
            icon="users"
            title="No chapters yet"
            message="Chapter leadership slots appear here once chapters exist. You can still assign central (org) roles above."
          />
        ) : null}
      </Narrow>

      {/* One shared PersonPicker, targeted at the open slot. */}
      <PersonPicker
        visible={pickerSlot !== null}
        title={
          pickerSlot
            ? `Assign ${SPECIALIZED_ROLE_META[pickerSlot.title].label}`
            : "Assign role"
        }
        onPick={(personId) => void handlePick(personId)}
        onClose={() => setPickerSlot(null)}
      />
    </Screen>
  );
}

/** One slot within a scope card: label + holder (or Assign), with inline error. */
function SlotRow({
  slotLabel,
  kindLabel,
  holder,
  error,
  onAssign,
  onRemove,
}: {
  slotLabel: string;
  kindLabel: string;
  holder:
    | {
        id: Id<"specializedRoles">;
        personName: string;
        personImageUrl: string | null;
      }
    | null;
  error: string | null;
  onAssign: () => void;
  onRemove: (roleId: Id<"specializedRoles">) => void;
}) {
  return (
    <View>
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1">
          <Text className="font-display text-base text-ink">{slotLabel}</Text>
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {kindLabel}
          </Text>
        </View>

        {holder ? (
          <View className="flex-row items-center gap-2">
            <Avatar
              name={holder.personName}
              size={28}
              uri={holder.personImageUrl}
            />
            <Text className="text-sm text-ink" numberOfLines={1}>
              {holder.personName}
            </Text>
            <Button
              title="Remove"
              variant="ghost"
              size="sm"
              icon="user-x"
              onPress={() => onRemove(holder.id)}
            />
          </View>
        ) : (
          <Button
            title="Assign"
            variant="secondary"
            size="sm"
            icon="user-plus"
            onPress={onAssign}
          />
        )}
      </View>

      {error ? (
        <View className="mt-2">
          <Text className="text-sm text-danger">{error}</Text>
        </View>
      ) : null}
    </View>
  );
}
