/**
 * Stub for `expo/virtual/env`, which babel-preset-expo injects into any app
 * module that reads an `EXPO_PUBLIC_*` variable. The real module is untransformed
 * ESM in node_modules, so it can't load under this pure-node jest config; mapping
 * it here lets colocated unit tests exercise env-reading utils (e.g. helpers.ts's
 * publicSiteUrl / eventPageUrl) by reading straight from process.env.
 */
module.exports = { env: process.env };
