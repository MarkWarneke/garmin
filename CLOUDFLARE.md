# Deploy to Cloudflare Workers

The workflow `.github/workflows/cloudflare.yml` tests and builds every pull request and push to `main`. Pushes to `main` and manual runs then deploy the Worker and UI together.

The deployed app is public and needs no sign-in. Each visitor uses their own Garmin Personal API key and their own local folder in Chrome or Edge. The Worker has no D1, R2, or KV bindings, stores no training data or keys, and has request logging and observability turned off. To keep the service available to everyone, Cloudflare's rate limiter counts relay requests per IP address (600 per minute) and `/mcp` requests per SHA-256 hash of the Garmin key (60 per minute); these counters expire within a minute and never contain the key itself. Static files are served by Cloudflare directly; only `/api/*` and `/mcp` run the Worker. Keys and Garmin responses pass through it only while a sync runs, or while an MCP client calls the optional `/mcp` endpoint, with `Cache-Control: no-store`. The Worker relays Garmin's complete responses, which can include start and end coordinates of outdoor activities, place names, the Garmin display name, and weight details; the browser removes them before saving. The `/mcp` endpoint removes them in the Worker before replying. See [How it works](README.md#how-it-works).

## 1. Create a Cloudflare API token

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/). A free account is enough.
2. Under **Workers & Pages**, note your `workers.dev` subdomain. No custom domain is needed.
3. Copy your **Account ID** from the account overview.
4. Open **Account API tokens → Create Token** and grant **Workers → Admin** for that account. Admin is needed for the first deployment, which creates the Worker; **Workers Editor** can only update an existing one.

Use an API token, never your Global API Key or a Garmin key. See [Cloudflare's GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

## 2. Add GitHub secrets and deploy

In your repository, open **Settings → Secrets and variables → Actions** and add:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

Then run **Actions → Test and deploy to Cloudflare → Run workflow**, or push to `main`. The app is published at `https://<name>.<your-subdomain>.workers.dev`, where `<name>` is the `name` in `wrangler.json`.

Each deployment appears under **Deployments** (the `production` environment) on the repository page, linked to the live URL. Secrets are only available to the deploy step, so pull requests cannot deploy. The workflow uses Node 24 and pinned action versions.

Do not put Cloudflare Access in front of the hostname. The app is meant to be public, and Access cannot be bypassed by application code.

## 3. Use the hosted app

1. Open the deployed URL in Chrome or Edge.
2. Click **Choose data folder** and pick an empty folder, or one that already contains a Cadence `snapshot.json`.
3. Saved history loads without a Garmin key. To fetch new data, click **Connect Garmin** and enter your key.
4. In another browser, choose the same folder to continue with the same history. Folder permission is granted per browser.

Only the folder handle is remembered, in IndexedDB; the data stays in the files. Before saving, the app checks that `snapshot.json` was not changed by another browser or the local app, and refuses to overwrite it if so. Cloudflare never has access to the folder.

## Check the hosted version locally

```sh
npm ci
npm test
npm run build
npm run check:cloudflare   # dry-run deployment
npm run dev:cloudflare     # serves the Worker at http://127.0.0.1:8790
```
