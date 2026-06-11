// Metro config aware of the pnpm monorepo so EAS Build (and local Metro) resolve
// workspace packages (e.g. @workspace/api-client-react) and hoisted deps at the
// repo root, not just this artifact's own node_modules.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
