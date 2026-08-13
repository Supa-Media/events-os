/**
 * THE BOOK'S VIEW MENU — the page's own title is the control.
 *
 * Founder, on the first attempt at this (a rail of chips under the tab bar):
 * "I don't love all these chips and stuff. Is there a better UI? Maybe drop
 * down, something else." They were right, and the reason is structural: a row
 * of pills sitting under a bar of pills is two rows of the same thing, which
 * is the exact complaint that started this work ("I'm not fine with two tabs
 * and then one of the tabs has three subtypes under it").
 *
 * So this adds NOTHING to the screen. The heading a page needs anyway becomes
 * the picker — "Needs attention ▾ · 12 charges" — and the menu behind it
 * carries the rest with a sentence each. Two consequences worth keeping:
 * the current view is stated in the largest type on the page, so a screenshot
 * says which slice it is (the same reasoning as `ScopeBadge`), and the menu
 * can grow to twenty entries without touching the layout.
 *
 * TWO KINDS OF ENTRY, deliberately not distinguished to the reader:
 *  - `filters` — a saved question about the SAME grid. Picking it re-filters
 *    in place; nothing navigates, nothing tears down into a spinner.
 *  - `href` — a destination that is genuinely a different screen (a month's
 *    worklist, the chase list grouped by cardholder, the publish console).
 *    These stay separate screens because they group or paginate differently,
 *    not because they're a different subject.
 * Both read as "where do I want to be looking", which is the only question
 * the person opening this menu is asking. Whether the answer is a filter or a
 * route is an implementation detail they should never have to hold.
 *
 * SCOPE IS THE CALLER'S JOB. Every `href` is built by the screen that already
 * resolved the desk, never here — a target page that resolves its own scope
 * is how two finance surfaces end up disagreeing about which book they're
 * showing (see `receipt-chase.tsx`'s own doc for the time that happened).
 */
import { Pressable, Text, View } from "react-native";
import { Icon, Popover, useAnchor } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ReconcileFilterKey } from "@events-os/shared";

export interface BookView {
  key: string;
  label: string;
  /** One line on what this view answers — the menu's whole job is that
   *  somebody who has never used it can pick correctly the first time. */
  detail: string;
  /** Re-filter the grid in place. Empty array = the unfiltered book. */
  filters?: readonly ReconcileFilterKey[];
  /** Or go somewhere. Built by the caller WITH scope already threaded. */
  href?: string;
  /** Live count, when the screen has a truthful one. Omitted rather than
   *  guessed — a number nobody can get to is the defect this area keeps
   *  fixing. */
  count?: number;
}

/** Which view the current filter selection IS, by exact set equality. A
 *  hand-rolled combination from the dropdowns below matches nothing, and
 *  falls back to `null` so the title says "Custom view" rather than claiming
 *  to be a saved one. */
export function activeView(
  views: readonly BookView[],
  filters: readonly ReconcileFilterKey[],
): BookView | null {
  return (
    views.find(
      (v) =>
        v.filters != null &&
        v.filters.length === filters.length &&
        v.filters.every((f) => filters.includes(f)),
    ) ?? null
  );
}

export function ViewMenu({
  views,
  active,
  subtitle,
  onPickFilters,
  onNavigate,
}: {
  views: readonly BookView[];
  active: BookView | null;
  /** Rendered beside the title — the screen's own count line. */
  subtitle?: string;
  onPickFilters: (filters: readonly ReconcileFilterKey[]) => void;
  onNavigate: (href: string) => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();

  return (
    <>
      <View className="flex-row items-center gap-3">
        <Pressable
          ref={ref}
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={`Current view: ${active?.label ?? "Custom view"}. Change view`}
          className="-ml-1 flex-row items-center gap-2 rounded-lg px-1 py-0.5 active:opacity-70 web:hover:bg-sunken"
        >
          <Text className="font-display text-2xl text-ink">
            {active?.label ?? "Custom view"}
          </Text>
          <View className="rounded-md border border-border-strong bg-raised px-1.5 py-1">
            <Icon name="chevron-down" size={13} color={colors.muted} />
          </View>
        </Pressable>
        {subtitle ? (
          <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
            {subtitle}
          </Text>
        ) : null}
      </View>

      <Popover visible={visible} onClose={close} anchor={anchor} width={330}>
        <View className="py-1">
          {views.map((v) => {
            const isActive = active?.key === v.key;
            return (
              <Pressable
                key={v.key}
                onPress={() => {
                  close();
                  if (v.href) onNavigate(v.href);
                  else onPickFilters(v.filters ?? []);
                }}
                accessibilityRole="menuitem"
                className={`px-3 py-2 active:opacity-70 web:hover:bg-sunken ${
                  isActive ? "bg-accent-soft" : ""
                }`}
              >
                <View className="flex-row items-baseline gap-2">
                  <Text
                    className={`flex-1 text-sm font-semibold ${
                      isActive ? "text-accent-hover" : "text-ink"
                    }`}
                  >
                    {v.label}
                  </Text>
                  {v.count != null ? (
                    <Text className="text-xs font-bold text-muted">{v.count}</Text>
                  ) : null}
                  {v.href ? (
                    <Icon name="arrow-up-right" size={12} color={colors.faint} />
                  ) : null}
                </View>
                <Text className="mt-0.5 text-2xs leading-4 text-muted">
                  {v.detail}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Popover>
    </>
  );
}
