# Calorie Counter

Offline-capable personal calorie counter with account sync. Built with Expo (React Native) — runs in the browser, on Android, and as a clickable macOS desktop app that launches the local web server.

## Features

- Daily food logging with servings and amounts; calorie plus protein/carb/fat totals for the day, ISO week, and calendar month
- USDA-provenanced food catalog (every row carries its `sourceRef`), plus user-defined custom foods
- Offline-first storage (IndexedDB on web, SQLite on native) with a Supabase sync engine: local changes queue, push/pull on sync, newest-update-wins conflicts, tombstones
- Health tab: weight/height measurements, BMI, and a daily-intake trend chart
- Activity tab: daily steps / active calories / active minutes, manual workout logging with heart-rate (Keytel 2005) or MET calorie estimates, a minimal profile (sex, birth year) powering those estimates, and net-energy (intake − burn) totals for the day, ISO week and calendar month plus a 30-day net trend. All entry is manual — no band API, no native modules.
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
- **Bonsai 4B 2-bit** (extractor/planner, default on): Qwen3 4B via `mlx_lm.server` on port 8082 (set `LLM_BONSAI_MODEL=prism-ml/Ternary-Bonsai-8B-mlx-2bit` for the 8B alternative). First start downloads ~1.1 GB from Hugging Face. Requires a Python ≥ 3.10 with mlx-lm installed (e.g. `python3 -m venv ~/.calorie-counter-mlx && ~/.calorie-counter-mlx/bin/pip install mlx mlx-lm`) — point the launcher at it with `LLM_PYTHON=~/.calorie-counter-mlx/bin/python` (default: `python3`).

Flow: the Log screen's **Quick add (local AI)** sends free-text meals to the pipeline — Bonsai extracts ingredients into a strict schema (Needle 2 is the grammar-safe fallback when Bonsai is off), the app matches them deterministically to the USDA catalog and computes calories/macros, and unmatched or under-specified dishes trigger targeted follow-up questions (max 3 rounds). Saving a dish as a custom food or recipe memory requires explicit confirmation; neither model ever writes to the database.

Environment (all optional): `LLM_ENABLED=0` disables the bridge; `LLM_BONSAI_ENABLED=0` keeps the tiny Needle parser without the large model; `LLM_PORT`, `LLM_BONSAI_PORT`, `LLM_PROXY_PORT` override the defaults 8080/8082/8090; `EXPO_PUBLIC_LLM_BASE_URL` overrides the URL the app fetches. The toggle in Settings persists per browser.

Standalone server control: `sh scripts/start-local-llm.sh` starts (or reuses) the servers and the proxy; it never kills an existing process.

## Project layout

- `app/` — expo-router screens: log, foods, history, activity, health, settings
- `src/domain/` — shared types and deterministic nutrition math (calories, macros, dates, workout burn estimates, energy balance)
- `src/db/` — storage adapters (IndexedDB / SQLite), repository, catalog seeding
- `src/sync/` — Supabase sync engine and migrations
- `src/local-ai/` — model contracts, bridge adapter, meal-parsing pipeline, draft validation, recipe memory
- `scripts/` — catalog build, desktop launcher + installer, local-model bridge (server lifecycle + CORS proxy), model benchmark fixture
- `data/foods.json` — USDA-provenanced catalog bundle

## Testing

- `npm test` (vitest): domain math, repository, sync, catalog, local-ai schema validation, the bridge adapter (against stub HTTP servers), draft→catalog mapping, deterministic per-100 g macro aggregation, and the activity/workout/energy paths (Keytel and MET estimates, one-row-per-day activity upsert, profile validation, calorie snapshots, net-energy aggregation)
- `sh scripts/desktop-launcher-smoke.sh`: deterministic launcher/bridge behavior checks on isolated test ports — server reuse, occupied-port errors, CORS proxy round-trips, and missing-binary failures
