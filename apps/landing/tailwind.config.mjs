/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Reddish-dark text color used by the source site (#210909).
        ink: "#210909",
        // Body background — warm off-white. Source uses #FDF6F6.
        cream: "#FDF6F6",
        "cream-soft": "#FAEEE9",
        red: {
          DEFAULT: "#D23B3A",
          50: "#FBE8E8",
          100: "#F7CECE",
          200: "#EFA0A0",
          300: "#E47373",
          400: "#DA5454",
          // Source accent color (rgb(210,59,58)).
          500: "#D23B3A",
          600: "#B62F2F",
          // Used for "Statement of Beliefs" link (rgb(201,59,58)).
          accentDark: "#C93B3A",
          700: "#922424",
        },
        pink: {
          // Mission / accent-light-2 card bg (rgb(242,210,210)).
          soft: "#F2D2D2",
          // Eyebrow chip + Important Links + accent-light-1 (rgb(249,223,223)).
          softer: "#F9DFDF",
          // "Why Public" card / accent-light-red (rgb(245,211,208)).
          band: "#F5D3D0",
        },
        // Vision card / light-orange (rgb(245,229,199)).
        peach: "#F5E5C7",
        mint: "#A8D9C4",
        lavender: "#C9A8E0",
        sky: "#D6E5F2",
        "link-blue": "#4A6BC0",
        "stat-purple": "#7004B8",
        "stat-orange": "#B87C04",
      },
      fontFamily: {
        display: ["'Corben'", "Georgia", "serif"],
        body: ["'DM Sans'", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      maxWidth: {
        content: "72rem",
        prose: "42rem",
      },
      boxShadow: {
        soft: "0 6px 24px -8px rgba(26,26,26,0.08)",
      },
      borderRadius: {
        pill: "9999px",
      },
    },
  },
  plugins: [],
};
