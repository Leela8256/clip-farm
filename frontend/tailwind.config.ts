import type { Config } from "tailwindcss";

/**
 * Theme mapped from the Clip Farm design tokens (app/design-tokens.css, the
 * --rr-* variables — source of truth). Colour names are stable across the
 * old dark system and the new bright studio look, so components only ever
 * reference semantic names (surface / line / ink / accent / ready / danger).
 */
const alpha = (token: string) => `rgb(from var(${token}) r g b / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: alpha("--rr-bg"),
          raised: alpha("--rr-surface-1"),
          overlay: alpha("--rr-surface-2"),
          hover: alpha("--rr-surface-3"),
        },
        line: {
          DEFAULT: "var(--rr-line)",
          strong: "var(--rr-line-strong)",
        },
        ink: {
          DEFAULT: alpha("--rr-text"),
          dim: alpha("--rr-text-2"),
          faint: alpha("--rr-text-3"),
          inverse: alpha("--rr-text-inverse"),
        },
        accent: {
          DEFAULT: alpha("--rr-accent"),
          dim: alpha("--rr-accent-hover"),
          hover: alpha("--rr-accent-hover"),
        },
        ready: alpha("--rr-ready"),
        processing: alpha("--rr-processing"),
        danger: alpha("--rr-danger"),
        cut: alpha("--rr-danger"),
        keep: alpha("--rr-ready"),
      },
      fontFamily: {
        display: ["Fraunces", "Iowan Old Style", "Georgia", "serif"],
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "monospace"],
      },
      borderRadius: {
        sm: "10px",
        md: "14px",
        lg: "20px",
        xl: "28px",
      },
      boxShadow: {
        "elev-1": "0 1px 0 rgba(255,255,255,0.6) inset, 0 10px 30px -18px rgba(22,19,15,0.35)",
        "elev-2": "0 1px 0 rgba(255,255,255,0.7) inset, 0 30px 70px -30px rgba(22,19,15,0.45)",
        "glow-accent": "0 0 0 1px var(--rr-accent-dim), 0 12px 40px -14px var(--rr-accent-glow)",
      },
    },
  },
  plugins: [],
};
export default config;
