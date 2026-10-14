/**
 * THE PHONE'S BUNDLER
 *
 * The shared packages (core, field-client) are written for Node's ES module
 * rules, so a relative import names the file it will be once compiled:
 * `./url.js` for `url.ts`. Metro looks for exactly that name and gives up, so a
 * relative import ending in `.js` is tried again without it, which finds the
 * TypeScript source. Anything else resolves as Expo's own config says.
 */
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // Not a TypeScript file by that name: let the default say what is missing.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
