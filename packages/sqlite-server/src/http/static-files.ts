import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { App, AppModule } from '../app';
import type { RequestContext } from './router';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

/**
 * Serves a built Super Productivity web app (e.g. `npm run buildFrontend:prodWeb`
 * output) from `root` for every GET that no API route matched. Unknown paths
 * without a file extension fall back to index.html (Angular routing).
 * Paths are resolved strictly inside `root` (no traversal, no dotfiles).
 */
export class StaticFilesModule implements AppModule {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    if (!existsSync(join(this.root, 'index.html'))) {
      throw new Error(`SP_WEB_ROOT ${this.root} does not contain index.html`);
    }
  }

  register(app: App): void {
    app.fallbackGet = (ctx) => this.serve(ctx);
  }

  private resolveFile(urlPath: string): string | undefined {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return undefined;
    }
    if (
      decoded.includes('\0') ||
      decoded.split('/').some((seg) => seg.startsWith('.') && seg !== '')
    ) {
      return undefined;
    }
    const candidate = resolve(this.root, `.${decoded}`);
    if (candidate !== this.root && !candidate.startsWith(this.root + sep))
      return undefined;
    try {
      const st = statSync(candidate);
      if (st.isFile()) return candidate;
      if (st.isDirectory() && existsSync(join(candidate, 'index.html')))
        return join(candidate, 'index.html');
    } catch {
      // not found
    }
    return undefined;
  }

  serve(ctx: RequestContext): boolean {
    if (ctx.path.startsWith('/api/')) return false;
    let file = this.resolveFile(ctx.path);
    if (!file) {
      if (extname(ctx.path) !== '') return false;
      file = join(this.root, 'index.html');
    }
    const ext = extname(file).toLowerCase();
    const isIndex =
      file.endsWith(`${sep}index.html`) ||
      ext === '.webmanifest' ||
      file.endsWith('ngsw.json');
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', MIME[ext.slice(1)] ?? 'application/octet-stream');
    // Hashed bundles are immutable; entry documents must revalidate.
    ctx.res.setHeader(
      'Cache-Control',
      isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
    );
    ctx.res.setHeader('Content-Length', String(statSync(file).size));
    if (ctx.method === 'HEAD') {
      ctx.res.end();
      return true;
    }
    createReadStream(file).pipe(ctx.res);
    return true;
  }
}
