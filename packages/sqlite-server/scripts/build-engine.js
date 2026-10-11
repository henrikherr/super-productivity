#!/usr/bin/env node
/**
 * Bundles engine/entry.ts (the app's reducers, op conversion, migrations and
 * archive handling) into dist/engine/sp-engine.cjs for the Node server.
 *
 * Run from anywhere: `npm --prefix packages/sqlite-server run build:engine`.
 * The bundle must be rebuilt whenever app state logic changes (ADR-8: server
 * and clients must come from the same source revision).
 */
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const outfile = path.join(pkgRoot, 'dist', 'engine', 'sp-engine.cjs');

const gitRevision = (() => {
  try {
    return require('node:child_process')
      .execSync('git rev-parse --short HEAD', {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
})();

const main = async () => {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const result = await esbuild.build({
    entryPoints: [path.join(pkgRoot, 'engine', 'entry.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // The app's tsconfig provides decorators + @sp/* path aliases (sources).
    tsconfig: path.join(repoRoot, 'src', 'tsconfig.app.json'),
    inject: [path.join(pkgRoot, 'engine', 'node-shims.js')],
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    define: { ngDevMode: 'false' },
    banner: {
      js: `/* Super Productivity server engine — built from app sources @ ${gitRevision}. Do not edit. */`,
    },
  });
  fs.writeFileSync(
    path.join(pkgRoot, 'dist', 'engine', 'engine-build.json'),
    JSON.stringify({ gitRevision, builtAt: new Date().toISOString() }, null, 2),
  );
  const bytes = fs.statSync(outfile).size;
  console.log(
    `engine bundle: ${path.relative(repoRoot, outfile)} (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
  );
  if (result.warnings.length) console.log(`${result.warnings.length} warning(s)`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
