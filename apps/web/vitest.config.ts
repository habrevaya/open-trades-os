import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * The `@/` alias comes from tsconfig, which vitest does not read. Without it
 * the suite fails to collect rather than failing an assertion, and a suite
 * that cannot load reports zero tests instead of a failure.
 */
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  /**
   * Next compiles JSX itself and tsconfig says `preserve`, which esbuild
   * would pass through untouched. Render tests need it compiled.
   */
  esbuild: { jsx: "automatic" },
  test: { include: ["test/**/*.test.ts", "test/**/*.test.tsx"] },
});
