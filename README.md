# Disguise Release Notes

Searchable, filterable table of [disguise designer](https://disguise.one) release notes (r14 onwards).

**[View the site](https://dev-joss.github.io/disguise-release-notes/)**

## Disclaimer

This site is **unofficial** and uses AI (via GitHub Models) to extract and categorise release notes from help.disguise.one. AI-extracted content may be inaccurate, missing, or miscategorised. Always refer to the [official release notes](https://help.disguise.one/designer/release-notes/release-notes) as the source of truth.

## Usage

```sh
# Requires AI_TOKEN environment variable (GitHub PAT with Models access)
node scrape.mjs                          # scrape all pages and extract with AI
node scrape.mjs --version r32            # scrape a specific major version
node scrape.mjs --version r32.2 --force  # re-extract a version, ignoring cache
node scrape.mjs --cache-only             # rebuild releases.json from AI cache
node scrape.mjs --fix-urls               # patch cached entries with anchor URLs
npx serve .                              # serve locally
```

### Dependencies

- [turndown](https://github.com/mixmark-io/turndown) — HTML to markdown conversion for cleaner AI input
