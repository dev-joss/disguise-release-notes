# Disguise Release Notes

Searchable, filterable table of [disguise designer](https://disguise.one) release notes (r14 onwards).

**[View the site](https://dev-joss.github.io/disguise-release-notes/)**

## Disclaimer

This site is **unofficial** and scrapes release notes from help.disguise.one using fragile HTML parsing. Entries may be missing, miscategorised, or inaccurate. Always refer to the [official release notes](https://help.disguise.one/designer/release-notes/release-notes) as the source of truth.

It aims to be superfluous with information over missing or misrepresenting it, so there will be some entries that are not actually bug fixes or features, and some that are miscategorised.

Probably should be using AI to parse the release notes and categorise them.

## Usage

```sh
node scrape.mjs        # re-scrape and regenerate data/releases.json
npx serve .            # serve locally
```

No npm dependencies required -- the scraper uses only Node built-ins.
