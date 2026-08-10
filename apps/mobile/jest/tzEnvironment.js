/**
 * A test environment that runs a file as if the DEVICE were somewhere else.
 *
 * Timezone-sensitive code can only be honestly tested from more than one
 * timezone, and `process.env.TZ = "Asia/Tokyo"` inside a test does nothing:
 * Node caches the zone when the test context is created, so the assignment is
 * read back correctly and then ignored by every `Date` you construct. That is
 * worse than not testing it — the suite goes green while all three "devices"
 * are quietly the same one.
 *
 * Setting it in the environment's constructor lands BEFORE the context exists,
 * in the worker process, which is early enough to stick. Use it with a docblock
 * at the top of a test file:
 *
 *     /**
 *      * @jest-environment ./jest/tzEnvironment.js
 *      * @tz Asia/Tokyo
 *      *\/
 *
 * Defaults to UTC (not the machine's zone) so a file that asks for this
 * environment and forgets `@tz` is still deterministic. Tests that care should
 * assert `Intl.DateTimeFormat().resolvedOptions().timeZone` themselves, so a
 * typo'd pragma fails loudly instead of silently re-running the same device.
 */
const NodeEnvironment = require("jest-environment-node").TestEnvironment;

class TimeZoneEnvironment extends NodeEnvironment {
  constructor(config, context) {
    process.env.TZ = context?.docblockPragmas?.tz || "UTC";
    super(config, context);
  }
}

module.exports = TimeZoneEnvironment;
