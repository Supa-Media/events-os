const { createMetroConfig } = require("@supa-media/metro");

// `withNativeWind: true` makes the @supa-media/metro factory wrap the config
// with nativewind/metro using `input: "./global.css"`.
module.exports = createMetroConfig({
  projectRoot: __dirname,
  sharedPackages: ["@events-os/shared"],
  withNativeWind: true,
});
