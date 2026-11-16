import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
config.vars = { ACCESS_TEAM_DOMAIN: process.env.ACCESS_TEAM_DOMAIN || '', ACCESS_AUD: process.env.ACCESS_AUD || '' };
await mkdir('dist', { recursive: true });
const configFile = resolve('dist/wrangler.deploy.json');
await writeFile(configFile, JSON.stringify(config, null, 2));
if (!config.vars.ACCESS_TEAM_DOMAIN || !config.vars.ACCESS_AUD) {
  console.log('Cloudflare Access is not configured yet. This deployment will deny all app requests until the Access variables are set.');
}
const result = spawnSync(resolve('node_modules/.bin/wrangler'), ['deploy', '--config', configFile], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
