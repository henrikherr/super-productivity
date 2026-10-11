import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Projection tests run the REAL app reducers through the engine bundle.
 * Build it once if it is missing or older than the entry file.
 */
export default (): void => {
  const pkg = resolve(__dirname, '..');
  const bundle = join(pkg, 'dist', 'engine', 'sp-engine.cjs');
  const entry = join(pkg, 'engine', 'entry.ts');
  if (!existsSync(bundle) || statSync(bundle).mtimeMs < statSync(entry).mtimeMs) {
    execFileSync(process.execPath, [join(pkg, 'scripts', 'build-engine.js')], {
      stdio: 'inherit',
    });
  }
};
