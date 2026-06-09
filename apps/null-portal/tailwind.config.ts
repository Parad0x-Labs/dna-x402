import type { Config } from "tailwindcss";

// Palette + type lifted from site/parad0x-null/index.html so the portal
// matches the public .null landing page exactly (dark "Web0" terminal vibe).
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0B0E13",
        bg2: "#0E1219",
        surf: "#12161F",
        surf2: "#161B26",
        line: "#222A37",
        line2: "#2C3545",
        ink: "#EFF3F8",
        dim: "#8A97A9",
        faint: "#5A6675",
        acc: "#2DD4A0",
        "acc-d": "#1FAE84",
        steel: "#7C93B5",
        danger: "#E05C5C",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SF Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        sans: [
          "ui-sans-serif",
          "-apple-system",
          "Segoe UI",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
      },
      borderRadius: {
        web0: "14px",
      },
      keyframes: {
        spin: { to: { transform: "rotate(360deg)" } },
        blink: { "50%": { opacity: "0" } },
      },
      animation: {
        "spin-slow": "spin 0.8s linear infinite",
        blink: "blink 1.1s steps(1) infinite",
      },
    },
  },
  plugins: [],
};

export default config;
