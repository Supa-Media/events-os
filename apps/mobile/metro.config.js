const { createMetroConfig } = require("@supa-media/metro");

module.exports = createMetroConfig({
  projectRoot: __dirname,
  sharedPackages: ["@events-os/shared"],
});
