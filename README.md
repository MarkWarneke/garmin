# Cadence

A personal Garmin training and recovery dashboard. Cadence downloads your activities, sleep, HRV, and daily health from the [Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/), shows them together, and helps you turn them into a training plan with ChatGPT or Claude.

Your training history stays in plain JSON files on your own computer. There is no account, no database, and nothing is sent to an AI assistant unless you copy it there yourself.

**Try it:** [garmin-cadence.warneke-mark.workers.dev](https://garmin-cadence.warneke-mark.workers.dev/) (Chrome or Edge, with your own Garmin Personal API key).

## How it works

Cadence runs in one of two modes. Both use the same UI and save the same files.

| | Hosted (Cloudflare Workers) | Local (Node.js) |
| --- | --- | --- |
| Where the app runs | Cloudflare serves the page; a small Worker relays Garmin requests | A Node server on your computer, bound to `127.0.0.1` |
| Where data is saved | A folder you choose in Chrome/Edge (File System Access API) | `data/` in the project, or `CADENCE_DATA_DIR` |
| What you need | Chrome or Edge | Node.js 24+ |

The data flow is the same in both modes:

1. **Your key stays in your browser.** The Garmin Personal API key is saved in the browser's `localStorage` for this site, so you enter it once. It is never written to a file or sent anywhere except Garmin. **Forget key** removes it. Anyone with access to your browser profile can use it, so forget it on shared computers.
2. **Cadence talks to Garmin.** The key is exchanged for a short-lived access token, then activities, daily summaries, sleep, and HRV are downloaded. In hosted mode, each request passes through the Worker because Garmin does not accept requests from web pages directly. The Worker forwards a fixed allowlist of Garmin operations, stores nothing, and has no database or request logging.
3. **Only normalized summaries are saved** to `snapshot.json`. No GPS routes, FIT files, account details, or credentials.
4. **Your athlete profile** (goal, FTP, availability, restrictions) is saved separately in `profile.json`, next to `snapshot.json`. A sync never touches it.
5. **You decide what an assistant sees.** The Training plan dialog builds a prompt you can read and edit before copying it.

### Syncing

The first sync downloads the selected range (90 days by default). Later syncs reuse saved history and download only what is missing:

- the days since the last sync, plus the last synced week again (late uploads and recalculated sleep),
- older days when you choose a longer range,
- date windows that failed last time, for that data type only.

**Data & connection → Re-fetch full history** reloads the whole range.

### What is downloaded

- **Activities:** sport, start time, duration, distance, elevation, calories, heart rate, Garmin training load and effects, average/normalized/max power, best 5 s, 1, 5, 20 and 60-minute power, intensity factor, cadence, VO2max, and time in each heart rate and power zone.
- **Daily health:** resting heart rate, steps, stress, Body Battery.
- **Sleep and HRV:** duration, stages, sleep score, overnight HRV and status.
- **Sync coverage** and per-request warnings.

Missing values stay `null`, never zero, and charts leave gaps. Ramp tests (activities named "…Ramp…") get an FTP estimate of 75% of the best one-minute power. An FTP you enter in your profile takes precedence.

## Run locally

Requires Node.js 24 or newer.

```sh
git clone https://github.com/MarkWarneke/garmin.git cadence
cd cadence
npm start
```

On macOS you can also double-click **Start Cadence.command**. Open <http://127.0.0.1:8787>, click **Connect Garmin**, and paste your [Personal API key](https://connect.garmin.com/app/settings/personalApiToken). Enter it only in that form, never in chat, source files, shell arguments, or `.env` files.

Keep the terminal open while using the app; Control-C stops it. Set `PORT` to use another port, and `CADENCE_DATA_DIR` to save data elsewhere. Data files are written atomically with mode `0600` in a `0700` directory. `data/` is ignored by Git.

## Get a training plan from ChatGPT or Claude

Open **Training plan → Create plan prompt**:

1. Fill in the short form: goal, event, FTP, heart rate, weight, availability, sports, equipment, and restrictions. Each field explains why it is needed. Leave anything blank and the assistant will ask.
2. Review the generated prompt and edit it if you like. Your answers and edits are saved to `profile.json`.
3. Copy it. Cadence adds your Garmin data for the selected range below the prompt.

**Include local snapshot link** is for the ChatGPT or Claude desktop app on the same computer with local file access allowed. It adds a `file://` link to the complete `snapshot.json` and `profile.json` (local mode), or names your selected folder (hosted mode, because browsers do not reveal full folder paths).

### Optional: MCP access for desktop assistants

A read-only MCP adapter lets ChatGPT desktop, Codex, or Claude desktop query the saved history and profile directly. It never receives your Garmin key and cannot trigger syncs. After `npm ci`, add a STDIO server in the client's MCP settings:

```text
Command: /absolute/path/to/node
Arguments: /absolute/path/to/cadence/src/mcp.mjs
```

Both paths are shown under **Data & connection** in the local app. Tools: `garmin_sync_status`, `garmin_training_overview`, `garmin_activities`, `garmin_health_trends`, and `athlete_profile`.

## Fork and run your own copy

1. **Fork** [MarkWarneke/garmin](https://github.com/MarkWarneke/garmin) on GitHub and clone your fork. Forks may be used and changed for any noncommercial purpose; see [License](#license).
2. **Install and test:**

   ```sh
   npm ci
   npm test
   ```

3. **Develop locally.** Run `npm run dev` (restarts the server on changes) and, in a second terminal, `npm run dev:css` (recompiles Tailwind). Refresh the browser to see changes. To try the hosted mode locally, run `npm run build` and then `npm run dev:cloudflare`, which serves the Worker at <http://127.0.0.1:8790>.
4. **Make it yours.** In `wrangler.json`, change `name` (it becomes `<name>.<your-subdomain>.workers.dev`). In `public/app.js`, point `REPOSITORY` to your fork. Update the "Try it" link above.
5. **Deploy** to your own Cloudflare account with the included GitHub Actions workflow. See [CLOUDFLARE.md](CLOUDFLARE.md). You need two repository secrets, no Garmin key, and no paid plan.

### Project layout

| Path | What it does |
| --- | --- |
| `public/` | The UI: `index.html`, `app.js`, compiled `styles.css` |
| `public/shared/` | Code shared by browser, Worker, and Node: Garmin client and sync (`garmin.mjs`), data model (`model.mjs`), profile and prompt (`profile.mjs`), snapshot links (`handoff.mjs`) |
| `public/folder-workspace.mjs` | Hosted mode: reads and writes the chosen local folder |
| `src/server.mjs`, `src/data.mjs` | Local mode: HTTP server and file storage |
| `src/worker.mjs` | Hosted mode: Cloudflare Worker that serves the UI and relays Garmin requests |
| `src/mcp.mjs` | Optional read-only MCP adapter |
| `styles/app.css` | Tailwind source; compiled to `public/styles.css`, which is checked in so `npm start` needs no build |
| `test/` | Node test runner suites with synthetic Garmin responses |

The UI uses plain JavaScript with [HyperUI](https://www.hyperui.dev/) patterns and Tailwind CSS 4, with no external scripts, fonts, or analytics. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Tests

```sh
npm test                    # unit and integration tests
npm run build               # compile CSS and prepare the Cloudflare assets
npm run check:cloudflare    # dry-run the Worker deployment
```

Tests use synthetic Garmin responses and temporary directories, and never contact a real Garmin account. They cover data shapes and missing values, pagination, incremental sync planning, partial failures, credential redaction, re-authentication, the local server's origin and request-token checks, file permissions, the Worker relay's restrictions, folder storage, the profile and prompt, and a real MCP client/server exchange. The local server tests need permission to bind a loopback port.

## Security notes

- The local server accepts only `127.0.0.1`/`localhost` Host and Origin headers and requires a per-process token for writes.
- The Worker accepts only same-origin requests, a fixed set of Garmin operations, bounded dates and page sizes, and never echoes Garmin error bodies.
- Garmin keys can be set to expire after 30, 90, or 180 days, or one year. Access tokens last at most 24 hours.
- Activity names from Garmin are treated as untrusted data in every prompt.
- A strict Content Security Policy allows only Cadence's own scripts, which limits what could read the saved key.

## License

Cadence is free to use, modify, and share for **noncommercial** purposes under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). That includes personal training, hobby projects, research, education, and use by charities and public institutions. Commercial use, such as selling it, offering it as a paid service, or using it inside a business, needs separate permission: [open an issue](https://github.com/MarkWarneke/garmin/issues) to ask. Keep the `Required Notice` line from `LICENSE.md` in copies and forks.

HyperUI-derived UI patterns remain under their MIT license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## References

[Garmin Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/) · [Authentication FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq) · [Swagger docs](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/) · [Official Python client](https://github.com/garmin/connect-personal-api-python) · [MCP setup for ChatGPT desktop and Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=desktop)
