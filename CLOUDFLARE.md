# Cloudflare and GitHub setup

The workflow `.github/workflows/cloudflare.yml` tests and builds on pull requests and pushes to `main`. After successful checks, pushes to `main` and manual workflow runs deploy the `garmin-cadence` Worker and HyperUI assets together.

The hosted app is public. Visitors do not need a Cloudflare account or sign-in. Each visitor provides their own Garmin Personal API key and selects their own local data folder in Chrome or Edge.

The Worker relays Garmin requests. It has no D1, R2, or KV data bindings and does not persist training data or Garmin keys. The browser saves normalized history to the selected folder. The Garmin key remains in the browser session; its short-lived access token remains in page memory. Both pass through Cloudflare during syncing. Request-body logging and Workers observability are disabled in this configuration. Responses use `Cache-Control: no-store`; credentials and responses are handled separately for each request.

## 1. Cloudflare account and deployment token

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Open **Workers & Pages** and check your account's `workers.dev` subdomain. This app does not require a custom domain.
3. Copy your **Account ID** from the account dashboard.
4. Open **Account API tokens → Create Token**. Add **Workers → Admin** for the account where you want the app deployed. Admin allows the first deployment to create the Worker; Workers Editor can update and deploy an existing Worker but cannot create one. The legacy **Workers Scripts → Edit** permission also includes Worker creation.
5. Copy the generated token directly into GitHub's secret form in the next step.

Use a Cloudflare API token, not your Global API Key and not your Garmin key. The deployment workflow never needs a Garmin credential.

Reference: [Cloudflare GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

## 2. GitHub Actions secrets and deployment

In [MarkWarneke/garmin → Settings → Secrets and variables → Actions](https://github.com/MarkWarneke/garmin/settings/secrets/actions), add these **repository secrets**:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The Cloudflare deployment token created above |
| `CLOUDFLARE_ACCOUNT_ID` | The destination Cloudflare account ID |

Do not add a Garmin key. Do not commit an API token, local snapshot, or `.dev.vars` file. No Cloudflare Access variables, team domain, or AUD tag are needed.

Run **Actions → Test and deploy to Cloudflare → Run workflow → main**, or push a commit to `main`.

The deployment prints a URL of the form `https://garmin-cadence.<your-subdomain>.workers.dev`. The current deployment is [garmin-cadence.warneke-mark.workers.dev](https://garmin-cadence.warneke-mark.workers.dev/).

Do not enable Cloudflare Access protection for this public hostname. If an Access application was previously created for it, remove that hostname's Access protection in the Cloudflare dashboard as well; application code cannot bypass an Access policy at Cloudflare's edge.

## 3. Use a local data folder

1. Open the deployed URL in Chrome or Edge.
2. Click **Choose data folder**. Select an empty folder for a new workspace, or a directory containing an existing Cadence `snapshot.json` to resume saved history. For the current local Mac app, that folder is `/Users/mark/Documents/ChatGPT/training/data`.
3. Saved history loads without a Garmin key. To fetch fresh data, click **Connect Garmin** and enter your own Personal API key in the app.
4. In another browser, open the same URL and select the same directory. Permissions are per browser; the history itself is shared through the file.

Each person should use a folder for their own Garmin history. The public site does not publish that folder or provide access to another visitor's data. Only a directory permission handle is remembered in IndexedDB. Training history is not copied into browser storage. A browser may ask for folder permission again after restarting. Use one active sync at a time; the app detects file changes before saving and refuses to overwrite a changed snapshot. Cloudflare cannot directly access the selected directory.

The hosted app does not need a local Node server. Codex and the optional local MCP adapter can still read the same saved JSON file. Coaching and plan generation remain deferred.

## Local checks for the hosted version

```sh
npm ci
npm test
npm run build
npm run check:cloudflare
npm run dev:cloudflare
```

The last command serves the public Worker at `http://127.0.0.1:8790`. Synthetic tests cover unauthenticated app access, required Garmin credentials, visitor isolation, relay restrictions, and local folder persistence. They do not contact Garmin or read actual history.

The workflow installs Node 24 and uses pinned checkout/setup-node Action commits. Deployment credentials are available only in the deployment step; pull-request checks cannot deploy.
