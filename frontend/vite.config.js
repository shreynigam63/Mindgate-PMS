import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The commit this bundle was built from. Compared at runtime with the
// API's /health `build` (server/index.js) — see BuildWatch in App.jsx.
// null outside a git checkout, which turns the comparison off.
let build = null;
try {
  build = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
} catch { build = null; }

export default defineConfig({
  plugins: [react()],
  define: { __APP_BUILD__: JSON.stringify(build) },
  server: { proxy: { '/api': 'http://localhost:8080' } },
});
