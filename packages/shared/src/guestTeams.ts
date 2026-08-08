/**
 * Guest teams — the color palette and the balancing rule behind "split the
 * people who walk through the door into N even teams."
 *
 * Deliberately NOT field-day-specific: the same primitive covers small groups
 * at a retreat, discussion tables at a conference, or van assignments on an
 * outreach. An event turns it on, picks how many teams it wants, and every
 * admitted guest gets one at the moment they're checked in.
 *
 * These are NOT the crew teams in `volunteer_expectations`' `team` column
 * (staff, assigned in advance from the Crew tab). These are attendee teams,
 * assigned at the door. Two different concepts that share an English word —
 * keep the code names distinct so nobody wires them together later.
 *
 * The palette is separate from `optionColor.ts`'s select-option colors because
 * the two are solving different problems: those are pale chip backgrounds for
 * dense grid tags, these are saturated blocks a volunteer reads at arm's
 * length in daylight and matches against a physical wristband.
 */

/** One team color: the wristband hue plus the two ways the app renders it. */
export interface TeamColor {
  /** Stable key stored on the `guestTeams` row. */
  key: string;
  /** Default team name — the color word, since teams are usually called by it. */
  label: string;
  /** Saturated fill for the door's full-width confirmation panel. */
  solid: string;
  /** Text/iconography drawn ON `solid` (dark for the light hues). */
  onSolid: string;
  /** Pale fill for an inline chip in a list row. */
  chipBg: string;
  /** Text drawn on `chipBg`. */
  chipText: string;
}

/**
 * The 20 available team colors, in assignment order.
 *
 * Order is load-bearing: an event asking for N teams gets the FIRST N, so the
 * list is sorted by how unmistakable the colors are from each other. The first
 * ten are the maximally-distinct set and are what a typical event uses; 11–20
 * are necessarily tighter (there are only so many hues that survive being
 * printed on a wristband and named out loud), so an event that really needs 20
 * distinct-looking teams should expect to lean on the names as much as the
 * colors.
 */
export const TEAM_COLORS: readonly TeamColor[] = [
  { key: "red", label: "Red", solid: "#DC2626", onSolid: "#FFFFFF", chipBg: "#FEE2E2", chipText: "#991B1B" },
  { key: "blue", label: "Blue", solid: "#2563EB", onSolid: "#FFFFFF", chipBg: "#DBEAFE", chipText: "#1E40AF" },
  { key: "green", label: "Green", solid: "#16A34A", onSolid: "#FFFFFF", chipBg: "#DCFCE7", chipText: "#166534" },
  { key: "yellow", label: "Yellow", solid: "#FACC15", onSolid: "#1F2937", chipBg: "#FEF9C3", chipText: "#854D0E" },
  { key: "purple", label: "Purple", solid: "#7C3AED", onSolid: "#FFFFFF", chipBg: "#EDE9FE", chipText: "#5B21B6" },
  { key: "orange", label: "Orange", solid: "#EA580C", onSolid: "#FFFFFF", chipBg: "#FFEDD5", chipText: "#9A3412" },
  { key: "teal", label: "Teal", solid: "#0D9488", onSolid: "#FFFFFF", chipBg: "#CCFBF1", chipText: "#115E59" },
  { key: "pink", label: "Pink", solid: "#DB2777", onSolid: "#FFFFFF", chipBg: "#FCE7F3", chipText: "#9D174D" },
  { key: "navy", label: "Navy", solid: "#1E3A8A", onSolid: "#FFFFFF", chipBg: "#DDE3F5", chipText: "#1E3A8A" },
  { key: "lime", label: "Lime", solid: "#84CC16", onSolid: "#1F2937", chipBg: "#ECFCCB", chipText: "#4D7C0F" },
  { key: "cyan", label: "Cyan", solid: "#0891B2", onSolid: "#FFFFFF", chipBg: "#CFFAFE", chipText: "#155E75" },
  { key: "magenta", label: "Magenta", solid: "#C026D3", onSolid: "#FFFFFF", chipBg: "#FAE8FF", chipText: "#86198F" },
  { key: "crimson", label: "Crimson", solid: "#9F1239", onSolid: "#FFFFFF", chipBg: "#FFE4E6", chipText: "#9F1239" },
  { key: "forest", label: "Forest", solid: "#166534", onSolid: "#FFFFFF", chipBg: "#D1FAE5", chipText: "#166534" },
  { key: "sky", label: "Sky", solid: "#38BDF8", onSolid: "#0C4A6E", chipBg: "#E0F2FE", chipText: "#075985" },
  { key: "violet", label: "Violet", solid: "#4C1D95", onSolid: "#FFFFFF", chipBg: "#E9D5FF", chipText: "#4C1D95" },
  { key: "brown", label: "Brown", solid: "#78350F", onSolid: "#FFFFFF", chipBg: "#F0E2D4", chipText: "#78350F" },
  { key: "gold", label: "Gold", solid: "#CA8A04", onSolid: "#FFFFFF", chipBg: "#FEF3C7", chipText: "#92400E" },
  { key: "slate", label: "Slate", solid: "#475569", onSolid: "#FFFFFF", chipBg: "#E2E8F0", chipText: "#334155" },
  { key: "black", label: "Black", solid: "#111827", onSolid: "#FFFFFF", chipBg: "#E5E7EB", chipText: "#111827" },
];

/** Hard ceiling on teams per event — the palette length. */
export const MAX_GUEST_TEAMS = TEAM_COLORS.length;

/** What an event gets when it first switches teams on. */
export const DEFAULT_GUEST_TEAM_COUNT = 10;

/** Neutral fallback for a color key that isn't in the palette (renamed/legacy
 *  rows), so a bad key degrades to a readable gray chip instead of blank. */
const FALLBACK: TeamColor = {
  key: "unknown",
  label: "Team",
  solid: "#6B7280",
  onSolid: "#FFFFFF",
  chipBg: "#E5E7EB",
  chipText: "#374151",
};

/** Resolve a stored color key to its render values (never throws). */
export function teamColor(key: string | null | undefined): TeamColor {
  if (!key) return FALLBACK;
  return TEAM_COLORS.find((c) => c.key === key) ?? FALLBACK;
}

/** The color key for the Nth team (0-based), wrapping if N ever exceeds the
 *  palette — callers are bounded by `MAX_GUEST_TEAMS`, this is belt-and-braces. */
export function teamColorKeyAt(index: number): string {
  return TEAM_COLORS[index % TEAM_COLORS.length].key;
}

/** The default name for the Nth team (0-based) — its color word. */
export function defaultTeamNameAt(index: number): string {
  return TEAM_COLORS[index % TEAM_COLORS.length].label;
}

/** Clamp a requested team count into `0..MAX_GUEST_TEAMS` (0 = none). */
export function clampTeamCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(MAX_GUEST_TEAMS, Math.floor(count)));
}

/** The shape `pickTeamIndex` balances over — anything carrying a running count. */
export interface TeamLoad {
  assignedCount: number;
}

/**
 * A small deterministic string hash (FNV-1a, 32-bit). Used only to break ties
 * between equally-empty teams — never for anything security-bearing.
 */
export function hashCode(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Pick which team the next arrival joins: **the least loaded one**.
 *
 * This is the whole balancing rule, and it's chosen because of what it
 * guarantees rather than because it's clever — after every single check-in the
 * biggest and smallest team differ by at most one person, all day, without any
 * rebalancing pass and without knowing the final headcount in advance. That
 * last part is why assignment happens at the door instead of at purchase: no
 * -shows can't skew teams that were never handed out.
 *
 * Two consequences worth knowing:
 *
 *  - Consecutive arrivals never land on the same team (once someone joins,
 *    that team is no longer among the least loaded), so the two tickets on one
 *    order are split by construction — no special case needed.
 *  - A manual move (`guestTeams.setTicketTeam`) leaves a team one over/under;
 *    the next few arrivals absorb it automatically. The rule is self-healing,
 *    which is why there's no rebalance button anywhere.
 *
 * Ties are broken by hashing `seed` (the ticket code) rather than by taking
 * the first least-loaded team, so the sequence doesn't degrade into a visible
 * "first guest is always Red, second is always Blue" pattern that people at
 * the door notice and read as rigged.
 *
 * Returns an index into `teams`, or -1 when there are no teams to pick from.
 */
export function pickTeamIndex(teams: readonly TeamLoad[], seed: string): number {
  if (teams.length === 0) return -1;
  let min = Infinity;
  for (const t of teams) if (t.assignedCount < min) min = t.assignedCount;
  const candidates: number[] = [];
  teams.forEach((t, i) => {
    if (t.assignedCount === min) candidates.push(i);
  });
  return candidates[hashCode(seed) % candidates.length];
}
