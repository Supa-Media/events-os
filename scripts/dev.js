#!/usr/bin/env node

const { createDevServer } = require("@supa/dev");

createDevServer({ cwd: process.cwd(), args: process.argv.slice(2) });
