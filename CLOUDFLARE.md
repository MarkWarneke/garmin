# Cloudflare and GitHub setup

The workflow `.github/workflows/cloudflare.yml` tests and builds on pull requests and pushes to `main`. After successful checks, pushes to `main` and manual workflow runs deploy the `garmin-cadence` Worker and HyperUI assets together.

The Worker relays Garmin requests. It has no D1, R2, or KV data bindings and does not persist training data or Garmin keys. The browser saves normalized history to a folder you explicitly select. The Garmin key remains in the browser session; its short-lived access token remains in page memory. Both pass through Cloudflare during syncing. Request-body logging and Workers observability are disabled in this configuration.

## 1. Cloudflare account and deployment token

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Open **Workers & Pages** and check your account's `workers.dev` subdomain. This app does not require a custom domain.
3. Copy your **Account ID** from the account dashboard.
4. Open **Account API tokens → Create Token**. Under permission policies, select **Edit Cloudflare Workers** and scope it to the account where you want this app deployed.
5. Copy the generated token directly into GitHub's secret form in the next step.

Use a Cloudflare API token, not your Global API Key and not your Garmin key. The deployment workflow never needs your Garmin credential.

Reference: [Cloudflare GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

## 2. GitHub Actions secrets

In [MarkWarneke/garmin → Settings → Secrets and variables → Actions](https://github.com/MarkWarneke/garmin/settings/secrets/actions), add these **repository secrets**:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The Cloudflare deployment token created above |
| `CLOUDFLARE_ACCOUNT_ID` | The destination Cloudflare account ID |

Do not add a Garmin key. Do not commit an API token, local snapshot, or `.dev.vars` file.

Run **Actions → Test and deploy to Cloudflare → Run workflow → main**, or push a commit to `main`.

The first deployment prints a URL of the form `https://garmin-cadence.<your-subdomain>.workers.dev`. Until the Access configuration below is supplied, the app deliberately returns `503 ACCESS_NOT_CONFIGURED`. That is a successful deployment awaiting private sign-in setup, not a Garmin authentication failure.

## 3. Protect the Worker with Cloudflare Access

1. In Cloudflare, open the deployed `garmin-cadence` Worker and enable **Cloudflare Access** for its production `workers.dev` hostname. Cover the entire hostname, including `/api/*` and static assets. Alternatively, use a custom domain with a self-hosted Access application covering the whole app.
2. In **Cloudflare Zero Trust → Access → Applications**, open that application and set an **Allow** policy containing only your email address. Select the sign-in method you want to use, such as a one-time PIN or your identity provider.
3. Copy the Access application's **Application Audience (AUD) Tag**.
4. Find your Zero Trust **team domain**, for example `my-team.cloudflareaccess.com`.

Reference: [Protecting workers.dev with Access](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev).

## 4. GitHub Actions variables

In the same GitHub settings area, choose the **Variables** tab and add these **repository variables**:

| Name | Example / source |
| --- | --- |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN` | `my-team.cloudflareaccess.com` — hostname only, without `https://` or a trailing slash |
| `CLOUDFLARE_ACCESS_AUD` | The Access application's Audience tag |

Run the workflow again. The deployment script applies these values as Worker variables named `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Configure them in GitHub so subsequent deployments retain them.

The Worker cryptographically validates the Access JWT signature, issuer, audience, and expiration before serving app code or handling Garmin requests. Headers claiming to be authenticated are insufficient on their own. Version preview URLs are disabled.

## 5. Open your local data

1. Open the deployed URL in Chrome or Edge and sign in.
2. Click **Choose data folder** and select the directory containing your existing `snapshot.json`. For the current Mac app, choose `/Users/mark/Documents/ChatGPT/training/data`. Choose an empty folder if starting fresh.
3. Saved history loads without a Garmin key. To fetch fresh data, click **Connect Garmin** and enter your Personal API key in the app.
4. In another browser, sign in and select the same directory. Permissions are per browser; the history itself is shared through the file.

Only a folder permission handle is remembered in IndexedDB. Training history is not copied into browser storage. A browser may ask for folder permission again after restarting. Use one active sync at a time; the app detects file changes before saving and refuses to overwrite a changed snapshot. Cloudflare can never directly access the chosen directory.

The hosted app does not need the Mac's local Node server. Codex and the optional local MCP adapter can still read the same saved JSON file. Coaching and plan generation remain deferred.

## Local checks for the hosted version

```sh
npm ci
npm test
npm run build
npm run check:cloudflare
npm run dev:cloudflare
```

The last command serves the Worker at `http://127.0.0.1:8790`. Its development authentication bypass only works for loopback hostnames. Setting that flag on an Internet deployment does not bypass Access. Synthetic tests do not contact Garmin or read your actual history.

The workflow installs Node 24 and uses pinned checkout/setup-node Action commits. Deployment credentials are available only in the deployment step; pull-request checks cannot deploy.
