import { defineConfig } from 'tsup'

// Production build for gem-discord-bot. Compiles `src/gemma.ts` (and the
// modules it imports) to plain ESM JavaScript in `dist/`. `npm run start`
// keeps using `tsx` for dev — `npm run start:prod` runs the compiled output.
//
// Native modules (`better-sqlite3`, `sqlite-vss`) are kept as runtime
// imports — they're CJS shipped with .node binaries and don't bundle.
export default defineConfig({
  entry: ['src/gemma.ts'],
  format: ['esm'],
  outDir: 'dist',
  target: 'node22',
  platform: 'node',
  // Keep TS imports + .ts extensions resolvable in source; tsup rewrites them.
  shims: false,
  // Don't bundle anything from node_modules — let Node resolve at runtime.
  // Bundling discord.js/genai/etc. yields a 5MB+ file with no real upside,
  // and native modules (better-sqlite3, sqlite-vss) choke on bundling.
  // The default tsup behavior already externalizes deps + peerDeps, so we
  // don't need an explicit list.
  noExternal: [],
  // Generate sourcemaps so stack traces in production logs map back to .ts.
  sourcemap: true,
  clean: true,
  // Don't generate .d.ts — this isn't a library.
  dts: false,
})
