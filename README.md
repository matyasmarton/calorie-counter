# Calorie Counter

Offline-capable personal calorie counter with account sync. Built with Expo (React Native) — runs in the browser, on Android, and as a clickable macOS desktop app that launches the local web server.

## Features

- Daily food logging with servings and amounts; calorie plus protein/carb/fat totals for the day, ISO week, and calendar month
- USDA-provenanced food catalog (every row carries its `sourceRef`), plus user-defined custom foods
- Offline-first storage (IndexedDB on web, SQLite on native) with a Supabase sync engine: local changes queue, push/pull on sync, newest-update-wins conflicts, tombstones
- Health tab: weight/height measurements, BMI, and a daily-intake trend chart
- Activity tab: daily steps / active calories / active minutes, manual workout logging with heart-rate (Keytel 2005) or MET calorie estimates (MET values from the 2024 Adult Compendium of Physical Activities, cited per type in `src/domain/workouts.ts`), a minimal profile (sex, birth year) powering those estimates, and net-energy (intake − burn) totals for the day, ISO week and calendar month plus a 30-day net trend. All entry is manual — no band API, no native modules.
- JSON backup export/import (merge by UUID or explicit restore)
- Consent-gated localized recipe memory — save dishes like "lecsó" or "Mom's hamburger" for future searches
- Clickable macOS launcher: `npm run desktop:install` installs a "Calorie Counter" icon in `~/Applications` that starts or reuses the Expo web server (port 8081) and opens the app in the default browser
- Local AI, fully on-device with no API keys: Bonsai Qwen3-4B (via MLX) extracts meal ingredients into a strict schema, with Cactus Needle 2 (45M, grammar-constrained) as the tiny fallback parser. Quick add parses free-text meals, drives targeted follow-ups for localized dishes (lecsó, menemen, bibimbap), and — with explicit consent — saves dishes as custom foods with deterministic macros and recipe memory. The app works fully without any model.

## Quickstart

```sh
npm install
npm run web        # open http://localhost:8081
```

- `npm run android` — Android emulator/device (uses the SQLite adapter; web uses IndexedDB)
- `npm test` — vitest suite
- `npm run typecheck` — TypeScript check
- `npm run export:web` — static web export to `dist/`

## Desktop launcher (macOS)

```sh
npm run desktop:install
```

Installs `~/Applications/Calorie Counter.app`. Clicking the icon starts (or reuses) the Expo web server on port 8081 and opens `http://localhost:8081/log` in the default browser. The bundle is script-backed and embeds the repository path — if the repo moves, update the fixed path in `desktop/Calorie Counter.app/Contents/MacOS/Calorie Counter` and rerun the install.

## Local AI (on-device models, no API keys)

The desktop launcher also starts a local model bridge: a tiny CORS proxy (`scripts/local-llm-proxy.mjs`) in front of the model servers. Everything runs on `127.0.0.1`; nothing leaves the machine.

- **Cactus Needle 2** (parser, always): a 45M-parameter model baked into a self-contained 14.6 MB binary (`scripts/start-local-llm.sh` downloads and ad-hoc signs it on first run). Serves `POST /complete` on port 8080 with grammar-constrained, confidence-scored tool calls.
- **Bonsai 4B 2-bit** (extractor/planner, default on): Qwen3 4B served on port 8082 (set `LLM_BONSAI_MODEL=prism-ml/Ternary-Bonsai-8B-mlx-1bit` for the 8B alternative). The launcher picks a runtime automatically (`LLM_BONSAI_RUNNER=auto`): `mlx_lm.server` when the Python interpreter has mlx-lm, otherwise [oMLX](https://github.com/jundot/omlx) when it is installed. `mlx_lm.server` needs a Python ≥ 3.10 with mlx-lm (e.g. `python3 -m venv ~/.calorie-counter-mlx && ~/.calorie-counter-mlx/bin/pip install mlx mlx-lm`, then `LLM_PYTHON=~/.calorie-counter-mlx/bin/python`); oMLX needs nothing beyond itself, and already scans both `~/.omlx/models` and the Hugging Face cache. First start downloads ~1.1 GB from Hugging Face.

Model management lives in the bridge, because a browser cannot run a command or see a filesystem path. Settings → Local AI lists which models are on disk and where they came from, and offers per-model **Download** (running `MODEL_DOWNLOAD_CMD` when set, otherwise a built-in Hugging Face downloader) and **Use** (restarting the Bonsai backend on another model, or on a folder you paste in). The proxy only ever stops a server it started itself — it reads the PID files this script writes and confirms with `lsof` before signalling, and refuses with `port occupant is not bridge-managed` when the port belongs to someone else.

Flow: the Log screen's **Quick add (local AI)** sends free-text meals to the pipeline — Bonsai extracts ingredients into a strict schema (Needle 2 is the grammar-safe fallback when Bonsai is off), the app matches them deterministically to the USDA catalog and computes calories/macros, and unmatched or under-specified dishes trigger targeted follow-up questions (max 3 rounds). Saving a dish as a custom food or recipe memory requires explicit confirmation; neither model ever writes to the database.

Environment (all optional): `LLM_ENABLED=0` disables the bridge; `LLM_BONSAI_ENABLED=0` keeps the tiny Needle parser without the large model; `LLM_PORT`, `LLM_BONSAI_PORT`, `LLM_PROXY_PORT` override the defaults 8080/8082/8090; `LLM_BONSAI_RUNNER` forces `mlx_lm` or `omlx`; `LLM_BONSAI_API_KEY` sets the token the proxy sends to the Bonsai backend (default: the key oMLX already stores in `~/.omlx/settings.json`); `OMLX_BIN` and `OMLX_LIBRARY_DIR` locate the oMLX CLI (default `~/.omlx/bin/omlx`) and its model library (default `~/.omlx/models`); `MODEL_DOWNLOAD_CMD` overrides the download command with `{ID}`, `{REPO}` and `{DEST}` substituted; `EXPO_PUBLIC_LLM_BASE_URL` overrides the URL the app fetches; `EXPO_PUBLIC_LLM_BONSAI_MODEL=bonsai-8b-1bit` tells the app which Bonsai it is serving. The toggle in Settings persists per browser.

Standalone server control: `sh scripts/start-local-llm.sh` starts (or reuses) the servers and the proxy; it never kills an existing process. `LLM_DOWNLOAD_ONLY=1` fetches the needle binary without starting anything.

## Project layout

- `app/` — expo-router screens: log, foods, history, activity, health, settings
- `src/domain/` — shared types and deterministic nutrition math (calories, macros, dates, workout burn estimates, energy balance)
- `src/db/` — storage adapters (IndexedDB / SQLite), repository, catalog seeding
- `src/sync/` — Supabase sync engine and migrations
- `src/local-ai/` — model contracts, bridge adapter, meal-parsing pipeline, draft validation, recipe memory
- `scripts/` — catalog build, desktop launcher + installer, local-model bridge (server lifecycle + CORS proxy), model benchmark fixture
- `data/foods.json` — USDA-provenanced catalog bundle

## Testing

- `npm test` (vitest): domain math, repository, sync, catalog, local-ai schema validation, the bridge adapter (against stub HTTP servers), the bridge proxy's own routes (spawned for real against stub backends, a temp model library and a fake oMLX), draft→catalog mapping, deterministic per-100 g macro aggregation, and the activity/workout/energy paths (Keytel and MET estimates, one-row-per-day activity upsert, profile validation, calorie snapshots, net-energy aggregation)
- `sh scripts/desktop-launcher-smoke.sh`: deterministic launcher/bridge behavior checks on isolated test ports — server reuse, occupied-port errors, CORS proxy round-trips, model inventory and download routes, and missing-binary failures
- `npm run verify:transfer`: end-to-end device-transfer check against two genuinely separate IndexedDB stores — persistence across an app restart, isolation of the second device, the JSON backup path, the sync path (against an in-memory stand-in for Supabase) and deletion propagation. Prints a PASS/FAIL report and exits non-zero on failure.
