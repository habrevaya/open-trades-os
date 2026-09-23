/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,

  /**
   * A self contained server directory, for the container image.
   *
   * Without it the image has to carry the whole pnpm store to run, which for
   * this workspace is most of a gigabyte of node_modules that the server
   * never touches at runtime. Next traces what is actually reachable and
   * copies that.
   */
  output: "standalone",

  /**
   * Traced from the repository root, not from apps/web.
   *
   * The workspace packages live above this directory and are symlinked into
   * it, and without this Next traces only what it can see below the app and
   * the standalone output is missing @opentradesos/* entirely. The failure is
   * a container that builds cleanly and cannot start.
   */
  outputFileTracingRoot: require("node:path").join(__dirname, "../.."),

  // Workspace packages ship TypeScript source rather than a build step, so the
  // app compiles them itself.
  transpilePackages: ["@opentradesos/ui", "@opentradesos/api", "@opentradesos/core", "@opentradesos/db"],

  webpack: (config) => {
    /**
     * Those packages are ESM and therefore import with explicit `.js`
     * extensions, which is what Node requires and what lets them run under
     * vitest and tsx unbundled. Webpack resolves that literally and cannot
     * find `./access/index.js` next to `./access/index.ts`.
     *
     * extensionAlias is the documented fix: it tells the resolver that a `.js`
     * specifier may be satisfied by the TypeScript source. Keeping the `.js`
     * in the source is correct, so the alias belongs here rather than a
     * rewrite of every import.
     */
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};
