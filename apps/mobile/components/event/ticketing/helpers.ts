/**
 * Shared helpers for the admin Tickets tab — money formatting, the public
 * site URL, and the cross-platform confirm dialog (Alert on native, DOM
 * confirm on web — mirrors event/[id].tsx's confirmDelete).
 */
import { Alert, Platform } from "react-native";

/**
 * Base URL of the public event pages (served from Convex http routes).
 * EXPO_PUBLIC_SITE_URL (custom domain, e.g. https://rsvp.publicworship.life)
 * wins when set. Otherwise derived from the Convex URL: cloud deployments
 * swap `.convex.cloud` → `.convex.site`; a local backend serves http routes
 * on the next port up (3210 → 3211).
 */
export function publicSiteUrl(): string {
  const custom = (process.env.EXPO_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
  if (custom) return custom;
  const url = (process.env.EXPO_PUBLIC_CONVEX_URL ?? "").replace(/\/+$/, "");
  if (url.includes(".convex.cloud")) {
    return url.replace(".convex.cloud", ".convex.site");
  }
  const withPort = url.match(/^(.*):(\d+)$/);
  if (withPort) return `${withPort[1]}:${Number(withPort[2]) + 1}`;
  return url;
}

/**
 * Absolute URL of an event's public page on the branded domain (or the Convex
 * fallback). The path segment is `/event/`; the old `/e/` prefix is kept as an
 * alias server-side for backward compatibility with already-shared links.
 */
export function eventPageUrl(slug: string): string {
  return `${publicSiteUrl()}/event/${slug}`;
}

/** Integer cents → "$12" / "$12.50". */
export function formatMoney(cents: number): string {
  const dollars = cents / 100;
  return cents % 100 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Ticket price label — free tiers read "Free" instead of "$0". */
export function formatPrice(cents: number): string {
  return cents === 0 ? "Free" : formatMoney(cents);
}

/** Dollar input ("12", "$12.50") → integer cents, or null when unparsable. */
export function parseDollars(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Cross-platform confirm: window.confirm on web, Alert.alert on native. */
export function confirmAction({
  title,
  message,
  confirmLabel,
  onConfirm,
  destructive = false,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
}): void {
  if (Platform.OS === "web") {
    if (
      typeof window !== "undefined" &&
      window.confirm(`${title}\n\n${message}`)
    ) {
      onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: confirmLabel,
      style: destructive ? "destructive" : "default",
      onPress: onConfirm,
    },
  ]);
}
