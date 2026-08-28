/**
 * MARKETING · Designs — the brand kit: what our colors are, and what to set
 * words in.
 *
 * The top of the Designs workstation, and the half that gets opened at 11pm.
 * The question a volunteer arrives with is never "show me the brand system", it
 * is "what red is our red" — and the shipped answer was a table of hex codes
 * with a pencil and a bin on every row. This file is the two browse surfaces
 * that replaced it: a wall of paint and a wall of specimens, each tile opening
 * into the viewer panel where everything is read and everything is edited.
 *
 * ── What actually changed ───────────────────────────────────────────────────
 *  Colors   the swatch is the content and the name is its caption. One press
 *            copies the hex, which is what people came for. (`SwatchWall`.)
 *  Faces     each card is set in the face it names — or says honestly that this
 *            device doesn't have it and offers the download, rather than
 *            showing Helvetica and calling it Barbra. (`SpecimenWall`, and
 *            `designs/fontSpecimen.shared.ts` for the rule.)
 *  Editing   left the browse surface entirely. No row now carries four icons.
 *
 * ── Read-only is the normal case, not the locked-out case ───────────────────
 * `library.canEdit` only decides whether the two "Add" buttons render and
 * whether the panel grows a form. Everyone signed in sees every swatch, every
 * specimen and every copy button; nobody gets a lock screen. That is the point
 * of the feature (`marketingDesigns.ts`: "Nobody should have to ask permission
 * to look right") — a brand kit behind a permission is a brand kit people work
 * around, which produces the exact inconsistency it exists to prevent.
 *
 * ── Faces are grouped, colors are not ──────────────────────────────────────
 * A color list is answered by scanning; a font list is answered by a question
 * ("what do I set a headline in?") that the role IS. So faces group under
 * `BRAND_FONT_ROLE_LABELS` and colors stay one ordered list — the order being
 * the team's own idea of primary-first, which is why it is reorderable at all
 * (from the panel now, not from the tile).
 */
import { Text, View } from "react-native";
import {
  BRAND_COLOR_MAX_COUNT,
  BRAND_FONT_MAX_COUNT,
  BRAND_FONT_ROLES,
  BRAND_FONT_ROLE_LABELS,
  type BrandColor,
  type BrandFont,
} from "@events-os/shared";
import { Button, Card, SectionHeader } from "../ui";
import { SwatchWall } from "./designs/SwatchWall";
import { SpecimenWall } from "./designs/SpecimenWall";

export function BrandColorsSection({
  palette,
  /** Every color in the kit, filtered or not — for the "n of m" count. */
  total,
  canEdit,
  onOpen,
  onNew,
}: {
  palette: BrandColor[];
  total: number;
  canEdit: boolean;
  onOpen: (color: BrandColor) => void;
  onNew: () => void;
}) {
  return (
    <View>
      <SectionHeader
        title="Colors"
        count={countLabel(palette.length, total)}
        right={
          canEdit ? (
            <Button
              title="Add color"
              icon="plus"
              size="sm"
              variant="secondary"
              disabled={total >= BRAND_COLOR_MAX_COUNT}
              onPress={onNew}
            />
          ) : undefined
        }
      />
      {palette.length === 0 ? (
        <Card padding="md">
          <Text className="text-sm text-muted">
            {total === 0
              ? canEdit
                ? "No colors yet. Add the ones we actually use — the red, the cream, the ink."
                : "The marketing team hasn't filled this in yet."
              : "No color here matches what you typed."}
          </Text>
        </Card>
      ) : (
        <>
          <SwatchWall palette={palette} onOpen={onOpen} />
          <Text className="mt-2 text-2xs text-faint">
            Press a swatch to copy its hex and open it.
          </Text>
        </>
      )}
    </View>
  );
}

export function BrandFontsSection({
  fonts,
  total,
  canEdit,
  onOpen,
  onNew,
}: {
  fonts: BrandFont[];
  total: number;
  canEdit: boolean;
  onOpen: (font: BrandFont) => void;
  onNew: () => void;
}) {
  const groups = BRAND_FONT_ROLES.map((role) => ({
    role,
    rows: fonts.filter((f) => f.role === role),
  })).filter((g) => g.rows.length > 0);

  return (
    <View>
      <SectionHeader
        title="Faces"
        count={countLabel(fonts.length, total)}
        right={
          canEdit ? (
            <Button
              title="Add face"
              icon="plus"
              size="sm"
              variant="secondary"
              disabled={total >= BRAND_FONT_MAX_COUNT}
              onPress={onNew}
            />
          ) : undefined
        }
      />
      {groups.length === 0 ? (
        <Card padding="md">
          <Text className="text-sm text-muted">
            {total === 0
              ? canEdit
                ? "No faces yet. Add what headlines and body text are set in."
                : "The marketing team hasn't filled this in yet."
              : "No face here matches what you typed."}
          </Text>
        </Card>
      ) : (
        <>
          {groups.map((group) => (
            <View key={group.role} className="mb-4">
              <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
                {BRAND_FONT_ROLE_LABELS[group.role]}
              </Text>
              <SpecimenWall fonts={group.rows} onOpen={onOpen} />
            </View>
          ))}
          <Text className="text-2xs text-faint">
            Each card is set in the face it names, where this device has it.
          </Text>
        </>
      )}
    </View>
  );
}

/** "4", or "2 of 4" while a search is narrowing the wall — so a filtered
 *  section never reads as a section that lost its rows. */
function countLabel(shown: number, total: number): string {
  return shown === total ? String(total) : `${shown} of ${total}`;
}
