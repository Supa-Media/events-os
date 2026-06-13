const { createMetroConfig } = require("@supa/metro");

module.exports = createMetroConfig({
  projectRoot: __dirname,
  sharedPackages: ["@events-os/shared"],
});
