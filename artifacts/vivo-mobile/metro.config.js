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

// Metro watches the whole repo root (for @workspace/* packages), which also pulls
// in transient tooling dirs like the repo-root `.cache/` where `uv` (Python pkg
// installs) writes short-lived temp dirs. Metro's file walker crashes the whole
// process with an uncaught ENOENT when such a dir is deleted mid-crawl. Exclude
// those churny/non-source dirs from the crawl+watch so a Python dependency install
// can never take the mobile bundler down.
config.resolver.blockList = /[\\/]\.(cache|git)[\\/].*/;

module.exports = config;
