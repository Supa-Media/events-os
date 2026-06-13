/**
 * Tailwind / NativeWind theme for Events OS.
 *
 * Tokens here mirror `lib/theme.ts` (the runtime source of truth). Screens use
 * semantic class names — bg-surface / bg-raised / text-ink / text-muted /
 * border-border / bg-accent — plus the brand scale and pastels. Do not add
 * raw hex in screens; extend the palette here instead.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // surfaces
        surface: "#FDF6F6",
        raised: "#FFFFFF",
        sunken: "#FAEEE9",
        // text
        ink: "#210909",
        muted: "#7A5A5A",
        faint: "#A98C8C",
        // structure
        border: "#EFE0DC",
        "border-strong": "#E4CFCB",
        // brand accent + scale
        accent: {
          DEFAULT: "#D23B3A",
          hover: "#922424",
          soft: "#FBE8E8",
        },
        brand: {
          50: "#FBE8E8",
          100: "#F9DFDF",
          200: "#F2D2D2",
          300: "#F5D3D0",
          500: "#D23B3A",
          700: "#922424",
        },
        // status semantics
        success: { DEFAULT: "#2F7D5B", bg: "#EAF6F0", soft: "#A8D9C4" },
        warn: { DEFAULT: "#B4761A", bg: "#FBF1DE", soft: "#F5E5C7" },
        danger: { DEFAULT: "#D23B3A", bg: "#FBE8E8" },
        info: { DEFAULT: "#4A6BC0", bg: "#D6E5F2" },
        // pastels
        peach: "#F5E5C7",
        mint: "#A8D9C4",
        lavender: "#C9A8E0",
        sky: "#D6E5F2",
        "stat-purple": "#7004B8",
      },
      fontFamily: {
        // serif display + sans body — the publicworship signature
        display: ["Corben_700Bold"],
        "display-regular": ["Corben_400Regular"],
        body: ["DMSans_400Regular"],
        medium: ["DMSans_500Medium"],
        semibold: ["DMSans_600SemiBold"],
        bold: ["DMSans_700Bold"],
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "14px",
        xl: "20px",
        pill: "999px",
      },
      boxShadow: {
        // soft, warm depth — not heavy SaaS cards
        card: "0 1px 2px rgba(33, 9, 9, 0.04), 0 1px 3px rgba(33, 9, 9, 0.03)",
        raised: "0 4px 16px rgba(33, 9, 9, 0.07)",
        pop: "0 8px 28px rgba(33, 9, 9, 0.12)",
      },
      fontSize: {
        // tightened UI type scale
        "2xs": ["11px", { lineHeight: "14px" }],
        xs: ["12px", { lineHeight: "16px" }],
        sm: ["13px", { lineHeight: "18px" }],
        base: ["15px", { lineHeight: "22px" }],
        lg: ["17px", { lineHeight: "24px" }],
        xl: ["20px", { lineHeight: "26px" }],
        "2xl": ["24px", { lineHeight: "30px" }],
        "3xl": ["30px", { lineHeight: "36px" }],
      },
    },
  },
  plugins: [],
};
