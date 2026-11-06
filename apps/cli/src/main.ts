#!/usr/bin/env -S npx tsx
import { runCli } from './cli.js';

runCli(process.argv.slice(2), {
  clock: { now: () => Date.now() },
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  env: process.env,
}).then((code) => process.exit(code));
