// Bundles the CLI into a single self-contained ESM file so `baton-cloud` can be
// published to npm and installed with `npm i -g` without any of the private
// `@baton/*` workspace packages (or zod / the MCP SDK) needing to exist on the
// registry — esbuild inlines them all. Node built-ins stay external.
//
// The workspace deps resolve to their built `dist/` output, so this must run
// after `pnpm --filter baton-cloud... build` has compiled them.
import { rm } from 'node:fs/promises';

import { build } from 'esbuild';

// Wipe any prior output (including stale per-file `tsc` emit) so the published
// `dist/` contains only the single self-contained bundle.
await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // main.ts already carries a `#!/usr/bin/env node` shebang; esbuild preserves
  // the entry's shebang at the top of the bundle, so we must NOT add our own
  // banner (that produced a second, mid-file shebang → SyntaxError).
  // Some transitive deps (the MCP SDK) reference CommonJS globals; provide the
  // ESM shims esbuild needs when emitting a bundled module.
  define: { 'import.meta.vitest': 'undefined' },
  logLevel: 'info',
});
