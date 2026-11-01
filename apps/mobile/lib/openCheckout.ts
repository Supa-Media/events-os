/**
 * Send the payer to a hosted payment page (Stripe Checkout) we just created.
 *
 * On web this is a SAME-TAB navigation, never `Linking.openURL`. On web,
 * react-native-web's `Linking.openURL` is `window.open(url, "_blank")`, and a
 * checkout URL only exists after an `await` on the server. By then the tap's
 * user activation is gone, so mobile Safari (and other strict popup blockers)
 * drops the new tab without any error. The checkout session is created, but
 * the payer sees nothing happen. That was the "Pay 2 by card does nothing"
 * report from 2026-10-31.
 *
 * A same-tab navigation is not a popup, so nothing can block it. It is also
 * what Checkout expects: its success/cancel URLs bring the payer back to this
 * app.
 *
 * On native, `Linking.openURL` hands off to the browser, and a failure there
 * rejects, so callers should surface it rather than `void` it.
 */
import { Linking, Platform } from "react-native";

export async function openCheckoutUrl(url: string): Promise<void> {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.location.assign(url);
    return;
  }
  await Linking.openURL(url);
}
