#!/usr/bin/env -S npx tsx
// Starts the server. Configuration comes from the environment; nothing secret is stored or logged.
//   DAYTUNER_DB            the SQLite file (default state/daytuner.db)
//   DAYTUNER_HOST          the address to listen on (default 127.0.0.1: reachable only from this machine)
//   DAYTUNER_PORT          the port (default 8420)
//   DAYTUNER_ALLOW_WRITES  set to 1 to let this server write to Tunarr (default: read only)
//   DAYTUNER_UI_DIR        the built pages (default: apps/ui/dist, built with `pnpm --filter @daytuner/ui build`)
//   TUNARR_URL             the Tunarr address

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Store } from '@daytuner/store';
import { TunarrClient } from '@daytuner/tunarr-client';
import { createApp } from './app.js';
import { Jobs } from './jobs.js';
import { Scheduler } from './scheduler.js';

const env = process.env;
const dbPath = env['DAYTUNER_DB'] ?? 'state/daytuner.db';
const host = env['DAYTUNER_HOST'] ?? '127.0.0.1';
const port = Number(env['DAYTUNER_PORT'] ?? 8420);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('DAYTUNER_PORT must be a port number');
const writesEnabled = env['DAYTUNER_ALLOW_WRITES'] === '1';

mkdirSync(dirname(dbPath), { recursive: true });
const tunarr = env['TUNARR_URL'];
if (!tunarr) throw new Error('give the Tunarr address with TUNARR_URL');
const store = Store.open(dbPath);
const clock = { now: () => Date.now() };
const jobs = new Jobs(clock);
const writeClient = writesEnabled ? new TunarrClient(tunarr, undefined, true) : undefined;
const uiDir = env['DAYTUNER_UI_DIR'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
const app = createApp({ store, clock, jobs, ...(existsSync(uiDir) ? { uiDir } : {}), client: new TunarrClient(tunarr), ...(writeClient ? { writeClient } : {}) });
if (writeClient) {
  new Scheduler({ store, clock, jobs, writeClient, log: (m) => console.log(`scheduled run: ${m}`) }).start();
  console.log('The daily run is on: each channel is run at its own time (see its settings).');
}
serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  if (!existsSync(uiDir)) console.log('The pages are not built yet (pnpm --filter @daytuner/ui build): only the API is served.');
  console.log(`DayTuner listening on http://${info.address}:${info.port} (${writesEnabled ? 'may write to Tunarr' : 'read only'})`);
  if (host !== '127.0.0.1' && host !== 'localhost') console.log('Note: this server has no login. Only expose it to people who may change your lineups.');
});
