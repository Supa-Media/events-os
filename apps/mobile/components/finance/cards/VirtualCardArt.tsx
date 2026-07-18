import { Text, View } from "react-native";
import { Icon } from "../../ui";

type Props = {
  /** Last-4 of the card. Placeholder dots in the shell (no cards issued yet). */
  last4?: string;
  holderName?: string;
  expLabel?: string;
  typeLabel?: string;
};

/**
 * The "Increase virtual" card art from the prototype (`.vcard`). Faithful to the
 * red-gradient look WITHOUT any native gradient dependency — a solid brand-red
 * base with two soft, semi-transparent overlay circles fake the diagonal sheen +
 * halo. Pure Views, web-safe, zero new modules. The "VISA" mark is static text
 * (Increase issues on the Visa network) — no logo asset, no new dependency.
 * Always shows the MASKED number — the full PAN only ever appears in
 * `RevealCardDetailsModal`'s auto-hiding, tap-to-copy reveal.
 */
export function VirtualCardArt({
  last4 = "••••",
  holderName = "CARDHOLDER",
  expLabel = "exp ••/••",
  typeLabel = "Increase virtual",
}: Props) {
  return (
    <View
      className="justify-between overflow-hidden rounded-lg bg-brand-700 p-5 shadow-raised"
      style={{ minHeight: 156 }}
    >
      {/* Halo + sheen overlays approximate the prototype's 135° red gradient. */}
      <View className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" />
      <View className="absolute -bottom-12 right-4 h-36 w-36 rounded-full bg-accent/50" />

      <View className="flex-row items-center justify-between">
        <Text className="text-2xs font-bold uppercase tracking-widest text-white/80">
          {typeLabel}
        </Text>
        <Icon name="credit-card" size={20} color="#FFFFFF" />
      </View>

      <View>
        <Text
          className="text-lg tracking-[0.2em] text-white"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          •••• •••• •••• {last4}
        </Text>
        <View className="mt-2 flex-row items-end justify-between">
          <View>
            <Text className="text-2xs uppercase tracking-wider text-white/85">
              {holderName}
            </Text>
            <Text className="text-2xs text-white/85">{expLabel}</Text>
          </View>
          {/* Network mark — italic wordmark, no logo asset. */}
          <Text className="text-base font-black italic text-white">VISA</Text>
        </View>
      </View>
    </View>
  );
}
