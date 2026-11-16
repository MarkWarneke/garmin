# Cadence

A Garmin activity and health dashboard built with **HyperUI application components and Tailwind CSS**. Run it locally on your Mac or deploy the UI and API relay together to **Cloudflare Workers**. Training history stays in local JSON files in both modes. Neither requires an MCP server or an OpenAI API key.

For GitHub Actions deployment, follow [CLOUDFLARE.md](CLOUDFLARE.md). The hosted app is public and requires no Cloudflare sign-in. Each visitor uses Chrome/Edge to select their own local folder and enters their own Garmin Personal API key. Garmin credentials and data pass through the Worker during syncing, with no cloud database configured.

The current version sets up data access and visualization. Training goals, the coaching agent, and personalized plan generation are deferred. The training calendar is an empty workspace, not a generated plan.

## Start

Requires Node.js 24 or newer. Double-click **Start Cadence.command**, or run:

```sh
cd /Users/mark/Documents/ChatGPT/training
npm start
```

Open **http://127.0.0.1:8787** and click **Connect Garmin**. Enter your Personal API key in that local form. Do not put it in chat, source files, shell arguments, or an `.env` file.

The first sync fetches the selected history range (90 days by default). Refreshing the page syncs again while the session key is available. Later syncs re-fetch the latest week to capture late uploads and recent corrections. **Data & connection → Re-fetch full history** refreshes the whole selected range.

Keep the terminal open. Control-C stops the server. Set `PORT` if 8787 is occupied. Use the same hostname and port each time; browser session storage is scoped to the origin and tab.

## What is downloaded

- Activity summaries: sport, local/UTC start, duration, distance, heart rate, elevation, calories, training load and effects where Garmin supplies them.
- Daily health summaries: resting heart rate, steps, Garmin stress, and Body Battery.
- Sleep duration, sleep stages, sleep score, and overnight HRV where recorded.
- Sync coverage and per-source errors, including unavailable datasets.

Missing and Garmin negative sentinel values remain `null`, not zero. Charts leave gaps for missing measurements. Latest readings show their measurement date. A successful API request with no records does not imply that a metric was measured. Today's data may be incomplete.

Garmin can also return an empty successful response for periods with no measurements, especially older HRV history. Cadence treats that as no recorded data. Nonempty malformed JSON still produces a sync warning.

No raw FIT files, routes, profile details, or Garmin credentials are stored. Activity records are updated by ID; deleting an activity in Garmin does not automatically remove an older cached record here. Full re-fetch updates existing records and retrieves missing ones.

## Credential and data storage

The **personal key** is stored in this tab's `sessionStorage`, so page refreshes retain it. It is never written by the backend to disk. The browser normally discards it when the tab closes, although browser session restore can preserve session storage. **Forget key** explicitly removes the key from the tab. The app falls back to page memory if session storage is blocked.

Garmin keys can be configured to expire after 30, 90, or 180 days, or one year. Garmin access tokens last at most 24 hours. The backend generates a token at the beginning of each sync; it keeps the key and token only in memory for that request and clears references afterward.

Downloaded history is stored as normalized JSON in `data/snapshot.json` (directory mode `0700`, file mode `0600`), with atomic replacement. It remains on this Mac between browser sessions. `data/` is ignored by Git. To use another data directory, set `CADENCE_DATA_DIR` for the app and any optional MCP client.

The HTTP server binds only to `127.0.0.1`, rejects foreign Host/Origin headers, and requires a per-process request token for syncing. The UI loads no external scripts, fonts, or analytics. Garmin response bodies are not echoed into error messages.

Each sync obtains the current local request token, so restarting the server does not require re-entering the Garmin key. If the server is stopped, the UI points you to `Start Cadence.command` before retrying.

## Use with ChatGPT and Codex

**No MCP required:**

- In **Data & connection** or **Training plan**, choose **Create plan prompt**. A short form asks for your goal, FTP, heart rate, weight, availability, sports, equipment, and restrictions; each field says why it is needed. The prompt is shown and editable before you copy it with your Garmin data for the selected range. Answers and any prompt edits are saved to `profile.json` next to `snapshot.json`. Nothing is automatically sent to an assistant.
- Enable **Include local snapshot link** to add a `file:///` link to the complete saved snapshot and profile. This only works with the ChatGPT or Claude desktop app on the same computer, with local file access allowed. Synced activities include power, normalized power, best 1/5/20/60-minute power, and heart rate and power time in zones; ramp tests yield an FTP estimate (75% of best one-minute power).
- The local server fills in the snapshot path. In the hosted app, enter the full path to `snapshot.json` in your selected folder; browsers do not reveal the full directory path. The checkbox and path are remembered in this tab's session. Choosing or disconnecting a folder clears the entered path. This feature adds a local link without uploading the file.
- In Codex, ask it to read `/Users/mark/Documents/ChatGPT/training/data/snapshot.json`. The dashboard also provides a copyable prompt.

**Optional direct desktop tools:**

An optional read-only MCP adapter lets ChatGPT desktop and Codex query saved data directly. It is independent of the dashboard and never receives your Garmin key. Install dependencies once with `npm ci` if they are missing. Add a STDIO MCP server in the desktop app's MCP settings:

```text
Command: the absolute Node executable shown under Data & connection
Arguments: /Users/mark/Documents/ChatGPT/training/src/mcp.mjs
```

Save and restart the client. The tools are `garmin_sync_status`, `garmin_training_overview`, `garmin_activities`, and `garmin_health_trends`. They read local snapshots; they cannot trigger Garmin syncs, write plans, or change Garmin data. The MCP client does not require the dashboard process to be running to read saved history. Enabling these tools shares the requested history with the client when you use them.

Alternatively, this configuration can be merged into a trusted project's Codex configuration. It is a sample; this repository does not change your installed MCP settings:

```toml
[mcp_servers.cadence]
command = "/absolute/path/to/node"
args = ["/Users/mark/Documents/ChatGPT/training/src/mcp.mjs"]
```

## Development and validation

The dashboard uses HTML and browser JavaScript, with HyperUI application patterns for navigation, stats, tables, forms, badges, and dialogs. Tailwind CSS 4.3 compiles `styles/app.css` to `public/styles.css` locally. There is no CDN or browser-side Tailwind runtime. The compiled CSS is checked in so the dashboard can start directly without a build. See `THIRD_PARTY_NOTICES.md` for HyperUI attribution and its MIT license.

The local server uses Node built-ins. Shared Garmin and data-model modules also run in the browser for the hosted version. Its public Worker relays a fixed allowlist of Garmin operations using only the credential supplied with each request. It restricts browser origins, query sizes, dates and pagination; it has no saved user sessions or history endpoint. The optional MCP adapter uses the official MCP SDK and Zod. `npm run dev` watches local backend files. Run `npm run dev:css` in a second terminal while editing the UI, then refresh the browser. `npm run build` compiles CSS and prepares a source-only allowlisted Cloudflare asset directory.

```sh
npm ci
npm run build
npm test
```

Tests use synthetic Garmin responses and temporary data directories. They cover documented DTO shapes, units and nulls, pagination, incremental sync, partial failures, credential redaction, retry/reauthentication, local HTTP restrictions, persistence permissions, export filtering, and a real MCP stdio client/server exchange. Local HTTP tests need permission to bind a loopback port in restricted environments. No test contacts a live Garmin account.

API endpoints and DTOs were checked against Garmin's published Personal API Swagger schema and [official Python client](https://github.com/garmin/connect-personal-api-python) on 2026-11-16. The token endpoint returns a raw token with `Accept: */*`; data endpoints return JSON. A real account sync still requires entering your key in the local UI.

References: [Garmin Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/), [Garmin authentication FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq), [Garmin Swagger docs](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/), [ChatGPT desktop and Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=desktop).
