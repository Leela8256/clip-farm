import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: "#0B0D10", raised: "#12151A", overlay: "#1A1E25" },
        line: { DEFAULT: "#232830", strong: "#2F3540" },
        ink: { DEFAULT: "#E8EAED", dim: "#9AA1AB", faint: "#5C636D" },
        accent: { DEFAULT: "#F4633A", dim: "#C24E2D" },
        cut: "#E24B4A",
        keep: "#1D9E75",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
