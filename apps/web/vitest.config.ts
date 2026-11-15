import { defineConfig } from 'vitest/config';

// Some tests plan a week or more twice; run beside the other packages' tests they can pass the default 5 s.
export default defineConfig({ test: { testTimeout: 30_000 } });
