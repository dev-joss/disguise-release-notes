# Disguise Release Notes Aggregator

## Project Overview
Static site that aggregates disguise designer release notes (r14–r32) into a single searchable table. Two parts: a Node.js scraper and a zero-dependency static HTML page.

## Architecture
- `scrape.mjs` — Node CLI script (no npm dependencies, uses built-in `fetch`). Fetches all release pages from `help.disguise.one`, parses HTML, outputs `data/releases.json`.
- `index.html` — Single static HTML file with inline CSS/JS. Loads `data/releases.json` via fetch. Provides search, sort, and filter UI.
- `data/releases.json` — Generated file committed to repo. Re-generate with `node scrape.mjs`.

## Commands
- `node scrape.mjs` — Re-scrape all release pages and regenerate `data/releases.json`
- `npx serve .` — Serve locally for testing (fetch requires HTTP, not file://)

## Conventions
- Use conventional commits (e.g., `feat:`, `fix:`, `chore:`)
- No npm dependencies — keep scraper using only Node built-ins
- No framework for the frontend — plain HTML/CSS/JS
