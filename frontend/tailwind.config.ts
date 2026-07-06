import type { Config } from "tailwindcss";

/**
 * Theme mapped from the rocketride-podcasts design system tokens
 * (app/design-tokens.css, the --rr-* variables — source of truth).
 *
 * The existing Tailwind color names (surface / line / ink / accent / cut /
 * keep) are preserved so components don't need class renames; only the token
 * *values* change to the new dark-cinematic periwinkle system. New semantic
 * names (ready / processing / danger, and the display font) are added for
 * status hues and the Space Grotesk display face.
 */
/**
 * Wrap a --rr-* token in relative-color syntax so Tailwind's opacity
 * modifiers (e.g. `bg-accent/30`) work against a CSS-variable color. The
 * `<alpha-value>` placeholder is substituted by Tailwind at build time; the
 * `rgb(from …)` is resolved by the browser. Next 16 targets modern browsers
 * that support relative color syntax.
 */
const alpha = (token: string) => `rgb(from var(${token}) r g b / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: alpha("--rr-bg"), // #08080A
          raised: alpha("--rr-surface-1"), // #0E0E11 — panels/cards
          overlay: alpha("--rr-surface-2"), // #16161A — raised cards/inputs
          hover: alpha("--rr-surface-3"), // #1F1F24 — hover/active rows
        },
        line: {
          DEFAULT: "var(--rr-line)", // rgba(255,255,255,.08) — already alpha
          strong: "var(--rr-line-strong)", // rgba(255,255,255,.16)
        },
        ink: {
          DEFAULT: alpha("--rr-text"), // #F4F4F6
          dim: alpha("--rr-text-2"), // #A6A6AE
          faint: alpha("--rr-text-3"), // #6E6E77
          inverse: alpha("--rr-text-inverse"), // #08080A — on light buttons
        },
        accent: {
          DEFAULT: alpha("--rr-accent"), // #6E8BFF periwinkle
          dim: alpha("--rr-accent-hover"), // #869DFF (was orange-dim; now hover tint)
          hover: alpha("--rr-accent-hover"),
        },
        // Semantic status hues (share L/C, vary hue only)
        ready: alpha("--rr-ready"), // #4FBF8F
        processing: alpha("--rr-processing"), // #E0A34D
        danger: alpha("--rr-danger"), // #E0625B
        // Back-compat aliases so existing components keep working:
        cut: alpha("--rr-danger"), // removed regions / failures
        keep: alpha("--rr-ready"), // broadcast-ready / success
      },
      fontFamily: {
        display: ["Space Grotesk", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ["Manrope", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SF Mono", "monospace"],
      },
      borderRadius: {
        sm: "8px",
        md: "12px",
        lg: "16px",
        xl: "22px",
      },
      boxShadow: {
        "elev-1": "0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px -16px rgba(0,0,0,0.8)",
        "elev-2": "0 1px 0 rgba(255,255,255,0.05) inset, 0 24px 60px -30px rgba(0,0,0,0.9)",
        "glow-accent": "0 0 0 1px var(--rr-accent-dim), 0 8px 40px -12px var(--rr-accent-glow)",
      },
    },
  },
  plugins: [],
};
export default config;
