/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,

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
