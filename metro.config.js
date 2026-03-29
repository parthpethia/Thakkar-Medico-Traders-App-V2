const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.watchFolders = [__dirname];
config.resolver.blockList = [
  /.*\\tmpclaude-[^\\/]+-cwd[\\/].*/,
  /.*\\wp-membership-certificate[\\/].*/,
];

module.exports = config;
