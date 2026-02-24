#!/usr/bin/env node

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_URL =
  "https://help.disguise.one/designer/release-notes/release-notes";
const BASE_URL = "https://help.disguise.one";

// Fallback list of release page paths (r14–r32)
const FALLBACK_PATHS = Array.from({ length: 19 }, (_, i) => {
  const n = i + 14;
  return `/designer/release-notes/r${n}`;
});

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

function discoverReleaseLinks(html) {
  const links = [];
  const re = /href="(\/designer\/release-notes\/r\d+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!links.includes(m[1])) links.push(m[1]);
  }
  return links.length > 0 ? links : FALLBACK_PATHS;
}

function decodeEntities(s) {
  return s
    .replace(/&#x26;/g, "&").replace(/&amp;/g, "&")
    .replace(/&#x3C;/g, "<").replace(/&lt;/g, "<")
    .replace(/&#x3E;/g, ">").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Extract only top-level <li> contents from HTML, ignoring nested <li> inside sub-lists.
// Tracks <ul>/<ol> nesting depth so inner list items are included in their parent's content.
function extractTopLevelLis(html) {
  const items = [];
  const tagRe = /<(\/?)(?:ul|ol|li)(?:\s[^>]*)?\s*>/gi;
  let listDepth = 0; // depth of <ul>/<ol> nesting
  let liDepth = 0; // which listDepth the current top-level <li> opened at
  let capturing = false;
  let start = 0;

  let m;
  while ((m = tagRe.exec(html))) {
    const isClose = m[1] === "/";
    const tag = m[0].toLowerCase();

    if (!isClose && (tag.startsWith("<ul") || tag.startsWith("<ol"))) {
      listDepth++;
    } else if (isClose && (tag === "</ul>" || tag === "</ol>")) {
      listDepth--;
    } else if (!isClose && tag.startsWith("<li")) {
      if (listDepth === 1 && !capturing) {
        // Top-level <li> — start capturing after this tag
        capturing = true;
        liDepth = listDepth;
        start = m.index + m[0].length;
      }
    } else if (isClose && tag === "</li>") {
      if (capturing && listDepth === liDepth) {
        // Closing the top-level <li>
        items.push(html.slice(start, m.index));
        capturing = false;
      }
    }
  }
  return items;
}

function parseReleasePage(html, pagePath) {
  const entries = [];

  // Extract <main> content if present, otherwise use full HTML
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const content = mainMatch ? mainMatch[1] : html;

  // Derive fallback version from the page path (e.g. /designer/release-notes/r30 → r30)
  const pageVersionMatch = pagePath && pagePath.match(/(r\d+)/i);
  const pageVersion = pageVersionMatch ? pageVersionMatch[1] : "";

  let currentVersion = "";
  let currentCategory = "";
  let currentAnchor = "";

  // Split content by heading tags to process sequentially
  const parts = content.split(/(?=<h[23][^>]*>)/i);

  for (const part of parts) {
    // Check for h2 (version heading)
    const h2Match = part.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match) {
      const rawText = decodeEntities(h2Match[1].replace(/<[^>]+>/g, "")).trim();
      // Extract the id attribute directly from the h2 tag
      const idMatch = h2Match[0].match(/<h2[^>]*\bid="([^"]+)"/i);
      // Extract version like "r32.3.2" from "r32.3.2 - Hotfixes"
      const vMatch = rawText.match(/(r\d+(?:\.\d+)*)/i);
      if (vMatch) {
        currentVersion = vMatch[1];
        currentAnchor = idMatch ? idMatch[1] : "";
        currentCategory = ""; // reset category under new version
      } else {
        // h2 doesn't contain a version — treat it as a category heading
        // Use the page-level version as fallback
        if (!currentVersion && pageVersion) currentVersion = pageVersion;
        currentCategory = rawText;
      }
    }

    // Check for h3 (category heading)
    const h3Match = part.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (h3Match) {
      currentCategory = decodeEntities(h3Match[1].replace(/<[^>]+>/g, "")).trim();
    }

    // Extract top-level list items (skip nested <li> inside sub-lists)
    const topLevelLis = extractTopLevelLis(part);
    for (const raw of topLevelLis) {
      const text = decodeEntities(raw.replace(/<[^>]+>/g, "")).trim();
      if (!text) continue;

      // Extract DSOF ticket numbers
      const dsofMatches = text.match(/DSOF-\d+/g);
      const dsof = dsofMatches ? dsofMatches.join(", ") : "";

      // Description: remove DSOF references and clean up
      let description = text
        .replace(/DSOF-\d+/g, "")
        .replace(/^\s*[-–—:,.\s]+/, "")
        .replace(/\s*[-–—:,.\s]+$/, "")
        .trim();

      // If description is empty, use full text
      if (!description) description = text;

      entries.push({
        version: currentVersion,
        category: currentCategory,
        dsof,
        description,
        url: `${BASE_URL}${pagePath}${currentAnchor ? "#" + currentAnchor : ""}`,
      });
    }
  }

  return entries;
}

async function main() {
  console.log("Fetching release notes index...");
  let indexHtml;
  try {
    indexHtml = await fetchText(INDEX_URL);
  } catch (e) {
    console.warn(`Could not fetch index page: ${e.message}`);
    console.warn("Using fallback release page list.");
    indexHtml = "";
  }

  const paths = indexHtml ? discoverReleaseLinks(indexHtml) : FALLBACK_PATHS;
  console.log(`Found ${paths.length} release pages.`);

  const allEntries = [];

  const results = await Promise.allSettled(
    paths.map(async (path) => {
      const url = `${BASE_URL}${path}`;
      console.log(`  Fetching ${url}...`);
      const html = await fetchText(url);
      return { path, entries: parseReleasePage(html, path) };
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { path, entries } = result.value;
      console.log(`  ${path}: ${entries.length} entries`);
      allEntries.push(...entries);
    } else {
      console.warn(`  Failed: ${result.reason.message}`);
    }
  }

  console.log(`\nTotal entries: ${allEntries.length}`);

  const outDir = join(__dirname, "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "releases.json");
  writeFileSync(outPath, JSON.stringify(allEntries, null, 2));
  console.log(`Written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
