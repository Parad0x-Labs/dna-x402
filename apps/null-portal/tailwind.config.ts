import type { Config } from "tailwindcss";

// v4 "bold maximalism" palette + type. Old token names are remapped to the v4
// values so existing components shift palette automatically; new names (lime,
// magenta, cyan, violet, mint, paper) carry the loud accents.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // base / surfaces (remapped)
        bg: "#07060a",
        bg2: "#0c0a12",
        surf: "#100e16",
        surf2: "#16121f",
        line: "rgba(244,240,230,0.16)",
        line2: "rgba(244,240,230,0.30)",
        // text (remapped to paper)
        ink: "#f4f0e6",
        dim: "rgba(244,240,230,0.62)",
        faint: "rgba(244,240,230,0.40)",
        // primary accent (remapped to v4 mint)
        acc: "#3dffb0",
        "acc-d": "#2ee0a0",
        steel: "#7C93B5",
        danger: "#ff3d6e",
        // v4 loud accents
        lime: "#c6ff2e",
        magenta: "#ff2e7e",
        cyan: "#19e3ff",
        violet: "#6b4bff",
        mint: "#3dffb0",
        paper: "#f4f0e6",
        ink0: "#07060a",
      },
      fontFamily: {
        display: ["var(--font-display)", "Archivo", "system-ui", "sans-serif"],
        sans: ["var(--font-sans)", "Space Grotesk", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "Space Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        web0: "14px",
      },
      boxShadow: {
        // hard offset shadows — the v4 signature
        slab: "10px 10px 0 #6b4bff",
        "slab-sm": "6px 6px 0 #6b4bff",
        "slab-mag": "8px 8px 0 #ff2e7e",
      },
      keyframes: {
        spin: { to: { transform: "rotate(360deg)" } },
        blink: { "50%": { opacity: "0" } },
        pulsering: {
          "0%": { boxShadow: "0 0 0 0 rgba(61,255,176,0.55)" },
          "70%": { boxShadow: "0 0 0 12px rgba(61,255,176,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(61,255,176,0)" },
        },
        scrollx: { to: { transform: "translateX(-50%)" } },
      },
      animation: {
        "spin-slow": "spin 0.8s linear infinite",
        blink: "blink 1.1s steps(1) infinite",
        pulsering: "pulsering 2.4s ease-out infinite",
        marquee: "scrollx 26s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
