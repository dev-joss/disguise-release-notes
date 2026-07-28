# Disguise Release Notes Aggregator

## Project Overview
Static site that aggregates disguise designer release notes (r14–r32) into a single searchable table. Uses AI (via GitHub Models) to extract and categorise changes from HTML release pages. AI-extracted content may be inaccurate — always refer to the official release notes.

## Architecture
- `scrape.mjs` — Node CLI script. Fetches release pages from `help.disguise.one`, converts HTML to markdown via turndown, sends to AI for structured extraction, outputs `data/releases.json`.
- `index.html` — Single static HTML file with inline CSS/JS. Loads `data/releases.json` via fetch. Provides search, sort, and filter UI.
- `data/releases.json` — Generated tree-structured file committed to repo. Schema: `[{ version, build, starter_build, released, url, changes: [{ dsof, category, description }] }]`.
- `data/.ai-cache.json` — AI response cache keyed by content hash. Committed to repo.
- `validate.mjs` — Node CLI script, no dependencies. Validates `data/releases.json` before the daily PR is allowed to auto-merge. Structural checks apply to every entry; stricter quality checks apply only to entries that are new or changed versus the base ref, because pre-r30 entries contain known junk (empty `build`, empty `released`, comma-joined `dsof`) that is grandfathered in.

## Commands
- `node scrape.mjs` — Scrape all release pages and extract with AI (requires `AI_TOKEN` env var)
- `node scrape.mjs --version r32` — Scrape a specific major version
- `node scrape.mjs --version r32.2 --force` — Re-extract a version, ignoring cache
- `node scrape.mjs --cache-only` — Rebuild releases.json from AI cache (no fetching or API calls)
- `node scrape.mjs --fix-urls` — Patch cached entries with correct anchor URLs
- `npx serve .` — Serve locally for testing (fetch requires HTTP, not file://)
- `node validate.mjs` — Validate `data/releases.json` against `origin/master`
- `node validate.mjs --no-base` — Structure/quality checks only, no comparison (note: fails on grandfathered legacy entries)

## CI
- `.github/workflows/update-releases.yml` — Daily scrape. Always opens/updates the rolling `auto/update-releases` PR, then auto-merges it only if validation passes, the diff is purely additive, and nothing outside `data/` changed. A failed validation leaves the PR open and fails the run.
- `.github/workflows/validate.yml` — Runs `validate.mjs` on human PRs. Its job is named `data-validation` to match the commit status the daily workflow posts, so one required check covers both paths.

## Conventions
- Use conventional commits (e.g., `feat:`, `fix:`, `chore:`)
- No framework for the frontend — plain HTML/CSS/JS
- turndown is the only npm dependency (HTML to markdown conversion)
