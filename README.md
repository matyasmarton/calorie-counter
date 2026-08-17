# Calorie Counter

Offline-capable personal calorie counter with account sync. Built with Expo (React Native) — runs in the browser, on Android, and as a clickable macOS desktop app that launches the local web server.

## Features

- Daily food logging with servings and amounts; calorie plus protein/carb/fat totals for the day, ISO week, and calendar month
- USDA-provenanced food catalog (every row carries its `sourceRef`), plus user-defined custom foods
- Offline-first storage (IndexedDB on web, SQLite on native) with a Supabase sync engine: local changes queue, push/pull on sync, newest-update-wins conflicts, tombstones
- Health tab: weight/height measurements, BMI, and a daily-intake trend chart
- JSON backup export/import (merge by UUID or explicit restore)
- Consent-gated localized recipe memory — save dishes like "lecsó" or "Mom's hamburger" for future searches
- Clickable macOS launcher: `npm run desktop:install` installs a "Calorie Counter" icon in `~/Applications` that starts or reuses the Expo web server (port 8081) and opens the app in the default browser
- Local-AI scaffolding under `src/local-ai/`: a model adapter contract, a Bonsai-coordinator → Needle-2-parser meal pipeline, and schema-only draft validation. No live runtime is wired into the app yet — the app is fully functional without any model, and no API keys are ever required.

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

## Project layout

- `app/` — expo-router screens: log, foods, history, health, settings
- `src/domain/` — shared types and deterministic nutrition math (calories, macros, dates)
- `src/db/` — storage adapters (IndexedDB / SQLite), repository, catalog seeding
- `src/sync/` — Supabase sync engine and migrations
- `src/local-ai/` — model contracts, meal-parsing pipeline, draft validation, recipe memory
- `scripts/` — catalog build, desktop launcher + installer, model benchmark fixture
- `data/foods.json` — USDA-provenanced catalog bundle

## Testing

- `npm test` (vitest): domain math, repository, sync, catalog, local-ai validation
- `sh scripts/desktop-launcher-smoke.sh`: deterministic launcher/bridge behavior checks on isolated test ports
