import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SpEngine } from './engine-api';

export interface LoadedEngine {
  engine: SpEngine;
  revision: string;
  path: string;
}

/** Default bundle location: <package>/dist/engine/sp-engine.cjs. */
export const defaultEnginePath = (): string => {
  // compiled: dist/src/engine/engine-loader.js → ../../engine/sp-engine.cjs
  const candidates = [
    resolve(__dirname, '..', '..', 'engine', 'sp-engine.cjs'),
    resolve(__dirname, '..', '..', 'dist', 'engine', 'sp-engine.cjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
};

/**
 * Loads the bundled state engine. Throws with a build hint when the bundle is
 * missing (run `npm --prefix packages/sqlite-server run build:engine`).
 */
export const loadEngine = (path: string = defaultEnginePath()): LoadedEngine => {
  if (!existsSync(path)) {
    throw new Error(
      `State engine bundle not found at ${path}. Build it with ` +
        '`npm --prefix packages/sqlite-server run build:engine`.',
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(path) as { createEngine: () => SpEngine };
  let revision = 'unknown';
  const meta = join(path, '..', 'engine-build.json');
  if (existsSync(meta)) {
    try {
      revision =
        (JSON.parse(readFileSync(meta, 'utf8')) as { gitRevision?: string })
          .gitRevision ?? revision;
    } catch {
      // keep unknown
    }
  }
  return { engine: mod.createEngine(), revision, path };
};
