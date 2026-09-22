import type { Config } from "tailwindcss";
import { colors, radius } from "./index";

/**
 * One preset consumed by every app, so the office app, the customer portal and
 * the marketing site cannot drift apart. Adding a colour here is a design
 * decision; adding one in an app is a bug.
 */
export const preset: Partial<Config> = {
  theme: {
    extend: {
      colors: {
        ink: { 900: colors.ink900, 700: colors.ink700, 500: colors.ink500 },
        steel: { 400: colors.steel400, 300: colors.steel300, 200: colors.steel200, 100: colors.steel100 },
        canvas: { DEFAULT: colors.canvas, raised: colors.canvasRaised },
        blue: { 100: colors.blue100, 300: colors.blue300, 600: colors.blue600, 700: colors.blue700 },
        red: { 600: colors.red600, tint: colors.redTint },
        amber: { 700: colors.amber700, tint: colors.amberTint },
        green: { 700: colors.green700, tint: colors.greenTint },
        purple: { 700: colors.purple700, tint: colors.purpleTint },
      },
      fontFamily: {
        sans: ["var(--font-plex-sans)", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["var(--font-plex-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        xs: ["0.75rem", { lineHeight: "1.4", letterSpacing: "0.01em" }],
        sm: ["0.875rem", { lineHeight: "1.45" }],
        base: ["1rem", { lineHeight: "1.55" }],
        lg: ["1.125rem", { lineHeight: "1.5", letterSpacing: "-0.005em" }],
        xl: ["1.375rem", { lineHeight: "1.35", letterSpacing: "-0.01em" }],
        "2xl": ["1.75rem", { lineHeight: "1.25", letterSpacing: "-0.015em" }],
        "3xl": ["2.5rem", { lineHeight: "1.15", letterSpacing: "-0.02em" }],
      },
      fontWeight: { normal: "400", medium: "500", semibold: "600" },
      borderRadius: {
        none: "0", sm: `${radius.sm}px`, DEFAULT: `${radius.base}px`,
        md: `${radius.md}px`, full: "9999px",
      },
      boxShadow: {
        sm: "0 1px 2px rgba(16,21,26,0.04)",
        md: "0 2px 8px rgba(16,21,26,0.06), 0 1px 2px rgba(16,21,26,0.04)",
      },
      transitionDuration: { DEFAULT: "100ms" },
    },
  },
};

export default preset;
