import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const required = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  console.error(`Missing GitHub Actions secrets: ${missing.join(', ')}. Add them in Settings → Secrets and variables → Actions, then rerun this workflow.`);
  process.exit(1);
}
const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
config.main = resolve(config.main);
config.assets.directory = resolve(config.assets.directory);
await mkdir('dist', { recursive: true });
const configFile = resolve('dist/wrangler.deploy.json');
await writeFile(configFile, JSON.stringify(config, null, 2));
const result = spawnSync(resolve('node_modules/.bin/wrangler'), ['deploy', '--config', configFile],
  { stdio: ['inherit', 'pipe', 'inherit'], env: process.env, encoding: 'utf8' });
process.stdout.write(result.stdout || '');
// GitHub Actions links the production environment to the URL Wrangler reports.
const url = result.status === 0 && result.stdout?.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
if (url && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `url=${url}\n`);
process.exit(result.status ?? 1);
