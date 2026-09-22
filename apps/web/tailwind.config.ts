import type { Config } from "tailwindcss";
import preset from "@opentradesos/ui/tailwind";

/**
 * The app owns no colours of its own. Every token comes from the shared
 * preset, so the office app, the portal and the field app cannot drift.
 */
export default {
  presets: [preset as Config],
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
} satisfies Config;
