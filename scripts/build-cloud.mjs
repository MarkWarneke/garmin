import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve('dist/client');
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
// Explicit allowlist: user data, credentials, test fixtures, and Node-only files cannot enter the deployment.
for (const file of ['index.html', 'app.js', 'styles.css', 'favicon.svg', 'folder-workspace.mjs']) {
  await cp(resolve('public', file), resolve(directory, file));
}
await cp(resolve('public/shared'), resolve(directory, 'shared'), { recursive: true });
console.log('Built Cloudflare assets. Only app code and compiled CSS are included.');
