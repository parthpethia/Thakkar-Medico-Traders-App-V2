const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.watchFolders = [__dirname];
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : []),
  /.*\\tmpclaude-[^\\/]+-cwd[\\/].*/,
  /.*\\wp-membership-certificate[\\/].*/,
  // Windows Metro watcher often crashes on nested package installs (e.g. expo-sharing).
  /\\node_modules\\expo-sharing\\node_modules\\.*$/,
  /\\node_modules\\[^\\]+\\node_modules\\@expo\\config-plugins\\.*$/,
  // Native project folders inside packages are not part of the JS graph; skip on Windows watch.
  /\\node_modules\\[^\\]+\\android\\.*$/,
  /\\node_modules\\[^\\]+\\ios\\.*$/,
];

module.exports = config;
