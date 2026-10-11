import type { App, AppModule } from '../app';

const INFO_PAGE = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Super Productivity Server</title>
</head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5">
<h1>Super Productivity – SQLite-Server</h1>
<p>Zugangstoken werden auf dem Server per CLI erzeugt und nur einmal angezeigt:</p>
<pre style="background:#eee;padding:.75rem;overflow:auto">node dist/src/cli.js token issue &lt;email&gt; sync &lt;geraet&gt;</pre>
<p>Den Token in der App unter <em>Einstellungen → Sync → SuperSync → Access Token</em> einfügen.
Server-URL ist diese Adresse; Verschlüsselungspasswort wie in der Schlüsseldatei des Servers.</p>
</body>
</html>`;

/**
 * Landing page when no web app is served: the app's SuperSync "Get token"
 * button opens the server URL, so explain where tokens come from.
 */
export class InfoPageModule implements AppModule {
  register(app: App): void {
    app.router.add('GET', '/', (ctx) => {
      ctx.res.statusCode = 200;
      ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
      ctx.res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      ctx.res.end(INFO_PAGE);
    });
  }
}
