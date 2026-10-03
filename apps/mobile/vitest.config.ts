import { defineConfig } from "vitest/config";

/**
 * Only the logic that does not need a phone. Screens, the camera, SQLite and
 * the background task are React Native modules that cannot load in Node, so
 * anything worth testing is kept out of them: in packages/field-client, which
 * has its own suite, and in src/lib here.
 */
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
