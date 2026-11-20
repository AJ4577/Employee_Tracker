// Lets the app import ../../packages/shared (TypeScript source) without publishing it.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.join(repoRoot, "packages/shared")];
config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules"), path.join(repoRoot, "node_modules")];
config.resolver.extraNodeModules = { "@kisanroute/shared": path.join(repoRoot, "packages/shared/src") };
module.exports = config;
