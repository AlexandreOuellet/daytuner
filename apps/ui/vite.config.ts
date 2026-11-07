import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// `pnpm --filter @daytuner/ui dev` serves the app and forwards /api to a running DayTuner server.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { proxy: { '/api': process.env['DAYTUNER_API'] ?? 'http://127.0.0.1:8420' } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', globals: false },
});
