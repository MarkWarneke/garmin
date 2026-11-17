import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { securityHeaders } from '../src/worker.mjs';
const directory = resolve('dist/client');
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
// Explicit allowlist: user data, credentials, test fixtures, and Node-only files cannot enter the deployment.
for (const file of ['index.html', 'app.js', 'styles.css', 'favicon.svg', 'folder-workspace.mjs']) {
  await cp(resolve('public', file), resolve(directory, file));
}
await cp(resolve('public/shared'), resolve(directory, 'shared'), { recursive: true });
// Static files are served without running the Worker, so they get its security headers from this file.
// no-cache lets browsers revalidate unchanged files instead of downloading them again.
const rules = Object.entries({ 'Cache-Control': 'no-cache', ...securityHeaders }).map(([name, value]) => `  ${name}: ${value}`);
await writeFile(resolve(directory, '_headers'), ['/*', ...rules, ''].join('\n'));
console.log('Built Cloudflare assets. Only app code and compiled CSS are included.');
