#!/usr/bin/env -S npx tsx
// Starts the server. Configuration comes from the environment; nothing secret is stored or logged.
//   DAYTUNER_DB            the SQLite file (default state/daytuner.db)
//   DAYTUNER_HOST          the address to listen on (default 127.0.0.1: reachable only from this machine)
//   DAYTUNER_PORT          the port (default 8420)
//   DAYTUNER_ALLOW_WRITES  set to 1 to let this server write to Tunarr (default: read only)
//   TUNARR_URL             the Tunarr address

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { Store } from '@daytuner/store';
import { createApp } from './app.js';

const env = process.env;
const dbPath = env['DAYTUNER_DB'] ?? 'state/daytuner.db';
const host = env['DAYTUNER_HOST'] ?? '127.0.0.1';
const port = Number(env['DAYTUNER_PORT'] ?? 8420);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('DAYTUNER_PORT must be a port number');
const writesEnabled = env['DAYTUNER_ALLOW_WRITES'] === '1';

mkdirSync(dirname(dbPath), { recursive: true });
const app = createApp({ store: Store.open(dbPath), clock: { now: () => Date.now() }, writesEnabled });
serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`DayTuner listening on http://${info.address}:${info.port} (${writesEnabled ? 'may write to Tunarr' : 'read only'})`);
  if (host !== '127.0.0.1' && host !== 'localhost') console.log('Note: this server has no login. Only expose it to people who may change your lineups.');
});
