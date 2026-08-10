/**
 * FINANCES · MY TRANSACTIONS — now a redirect to `/finances/coding`.
 *
 * This screen was the cardholder's desk, and it was invisible: it appeared in
 * the tab bar only for members with NO finance seat, so anyone holding one
 * could reach it by URL and no other way. That's why the owner had never seen
 * it. Its content is now the first half of the Coding tab, alongside the
 * reviewer's queue — one screen, two audiences.
 *
 * A redirect rather than two screens (CLAUDE.md: remove, don't deprecate). It
 * has to exist because the path is already out in the world: every coding
 * reminder and every send-back email sent to date links to
 * `/finances/my-transactions?filter=uncoded`, and those inboxes don't get
 * rewritten. The query string is carried across so the deep link still lands
 * on the filtered list it promised. New emails point at `/finances/coding`.
 */
import { Redirect, useLocalSearchParams } from "expo-router";

export default function MyTransactionsRedirect() {
  const params = useLocalSearchParams<{ filter?: string }>();
  return (
    <Redirect
      href={
        params.filter
          ? `/finances/coding?filter=${encodeURIComponent(params.filter)}`
          : "/finances/coding"
      }
    />
  );
}
