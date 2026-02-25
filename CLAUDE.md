# Disguise Release Notes Aggregator

## Project Overview
Static site that aggregates disguise designer release notes (r14–r32) into a single searchable table. Uses AI (via GitHub Models) to extract and categorise changes from HTML release pages. AI-extracted content may be inaccurate — always refer to the official release notes.

## Architecture
- `scrape.mjs` — Node CLI script. Fetches release pages from `help.disguise.one`, converts HTML to markdown via turndown, sends to AI for structured extraction, outputs `data/releases.json`.
- `index.html` — Single static HTML file with inline CSS/JS. Loads `data/releases.json` via fetch. Provides search, sort, and filter UI.
- `data/releases.json` — Generated tree-structured file committed to repo. Schema: `[{ version, build, starter_build, released, url, changes: [{ dsof, category, description }] }]`.
- `data/.ai-cache.json` — AI response cache keyed by content hash. Committed to repo.

## Commands
- `node scrape.mjs` — Scrape all release pages and extract with AI (requires `AI_TOKEN` env var)
- `node scrape.mjs --version r32` — Scrape a specific major version
- `node scrape.mjs --version r32.2 --force` — Re-extract a version, ignoring cache
- `node scrape.mjs --cache-only` — Rebuild releases.json from AI cache (no fetching or API calls)
- `node scrape.mjs --fix-urls` — Patch cached entries with correct anchor URLs
- `npx serve .` — Serve locally for testing (fetch requires HTTP, not file://)

## Conventions
- Use conventional commits (e.g., `feat:`, `fix:`, `chore:`)
- No framework for the frontend — plain HTML/CSS/JS
- turndown is the only npm dependency (HTML to markdown conversion)
