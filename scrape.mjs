#!/usr/bin/env node

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import TurndownService from "turndown";

const __dirname = dirname(fileURLToPath(import.meta.url));

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
turndown.addRule("remove-anchor-links", {
  filter: node =>
    node.nodeName === "A" &&
    (node.getAttribute("class") || "").includes("sl-anchor-link"),
  replacement: () => "",
});
turndown.addRule("remove-sr-only", {
  filter: node =>
    node.nodeName === "SPAN" &&
    (node.getAttribute("class") || "").includes("sr-only"),
  replacement: () => "",
});
turndown.addRule("remove-images", {
  filter: "img",
  replacement: () => "",
});
turndown.addRule("unwrap-links", {
  filter: "a",
  replacement: (content) => content,
});
const INDEX_URL =
  "https://help.disguise.one/designer/release-notes/release-notes";
const BASE_URL = "https://help.disguise.one";

const AI_API_URL = "https://models.github.ai/inference/chat/completions";
const AI_MODEL = "openai/gpt-4o-mini";
const AI_TOKEN = process.env.AI_TOKEN;
const FORCE = process.argv.includes("--force");
const CACHE_ONLY = process.argv.includes("--cache-only");
const FIX_URLS = process.argv.includes("--fix-urls");
const ONLY_VERSION = (() => {
  const idx = process.argv.findIndex(a => a === "--version" || a === "--only");
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1].toLowerCase() : null;
})();

if (!AI_TOKEN && !CACHE_ONLY && !FIX_URLS) {
  console.error("Error: AI_TOKEN not set. Set AI_TOKEN to a GitHub PAT or use --cache-only.");
  process.exit(1);
}

// Match version against --version filter (exact or prefix match)
function matchesVersion(version) {
  if (!ONLY_VERSION) return true;
  const v = version.toLowerCase();
  return v === ONLY_VERSION || v.startsWith(ONLY_VERSION + ".");
}

// --- AI cache ---
const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), "data", ".ai-cache.json");
let aiCache = {};
if (existsSync(CACHE_PATH)) {
  try { aiCache = JSON.parse(readFileSync(CACHE_PATH, "utf-8")); } catch { aiCache = {}; }
}
function saveCacheSync() {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(aiCache, null, 2));
}
function cacheKey(html) {
  return createHash("sha256").update(html).digest("hex");
}

// Rate limiter: ~10 RPM → 1 request per 6s (GitHub Models allows 15 RPM)
let lastAiCall = 0;
async function rateLimitDelay() {
  const elapsed = Date.now() - lastAiCall;
  const wait = Math.max(0, 1000 - elapsed);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAiCall = Date.now();
}

const AI_JSON_SCHEMA = {
  type: "object",
  properties: {
    build: { type: "string", description: "The Full/Pro build number (e.g. '234682'), or empty string if not listed" },
    starter_build: { type: "string", description: "The Starter build number (e.g. '234683'), or empty string if not listed" },
    released: { type: "string", description: "The release date as written (e.g. 'December 10th 2025'), or empty string if not listed" },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", description: "The category/section heading this entry falls under (e.g. 'Bug Fixes', 'New Features'), or empty string if none" },
          dsof: { type: "string", description: "Comma-separated DSOF-XXXXX numbers, or empty string if none" },
          description: { type: "string", description: "Concise description of the change" },
        },
        required: ["category", "dsof", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["build", "starter_build", "released", "entries"],
  additionalProperties: false,
};

// Convert HTML to markdown for cleaner AI input and debug output
function htmlToMarkdown(html) {
  return turndown.turndown(html)
    .replace(/^#{4,}\s+Download\b.*$/gm, "")  // remove download headings
    .replace(/^\s*_(?!.*(?:build|released)[:\s])[^_\n]+_\s*$/gmi, "")  // remove standalone italic lines (image captions) but keep metadata
    .replace(/\n{3,}/g, "\n\n")     // collapse extra blank lines
    .trim();
}

async function extractWithAI(versionHtml, version, url) {
  const markdown = htmlToMarkdown(versionHtml);
  const key = cacheKey(markdown);
  if (aiCache[key] && !FORCE) {
    console.log(`    [cache hit] ${version}`);
    return aiCache[key];
  }

  await rateLimitDelay();
  console.log(`    [AI] ${version}`);

  const res = await fetch(AI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_TOKEN}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: "user",
          content: `Extract changes from these release notes.\n\nFirst, extract the build metadata: the Full/Pro build number, Starter build number (if available), and release date.\n\nThen extract each individual change. Changes may be listed as bullet points under category headings (e.g. "Bug Fixes", "New Features", "Improvements"). Some changes have explicit DSOF ticket numbers (e.g. DSOF-12345), others are described in prose (e.g. new feature descriptions). Extract all of them. If there are no changes listed, return an empty entries array — do NOT invent or hallucinate changes.\n\nFor each change:\n- category: the section heading it falls under. If there is no explicit heading, infer an appropriate category (e.g. "New Features", "Bug Fixes", "Improvements", "Changes")\n- dsof: DSOF-XXXXX numbers exactly as written (comma-separated), or empty string if none\n- description: if the change has a DSOF number, copy the description verbatim from the source. Otherwise, write a concise description.\n\n${markdown}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "release_entries", strict: true, schema: AI_JSON_SCHEMA },
      },
      temperature: 0,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI returned empty content");

  const parsed = JSON.parse(content);

  // Cache and persist (include version and url for easier inspection)
  aiCache[key] = { version, url, ...parsed };
  saveCacheSync();

  return { ...parsed, url };
}

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

async function parseReleasePage(html, pagePath, debugDir = null) {
  const entries = [];

  // Extract <main> content if present, otherwise use full HTML
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const content = mainMatch ? mainMatch[1] : html;

  // Derive fallback version from the page path (e.g. /designer/release-notes/r30 → r30)
  const pageVersionMatch = pagePath && pagePath.match(/(r\d+)/i);
  const pageVersion = pageVersionMatch ? pageVersionMatch[1] : "";

  let currentVersion = "";
  let currentAnchor = "";

  // Split content by heading tags to process sequentially
  const parts = content.split(/(?=<h[23][^>]*>)/i);

  // First pass: group parts by version
  const versionSections = []; // { version, anchor, html }
  let currentSection = null;

  for (const part of parts) {
    // Check for h2 (version heading)
    const h2Match = part.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match) {
      const rawText = decodeEntities(h2Match[1].replace(/<[^>]+>/g, "")).trim();
      const idMatch = h2Match[0].match(/<h2[^>]*\bid="([^"]+)"/i);
      const vMatch = rawText.match(/(r\d+(?:\.\d+)*)/i);
      if (vMatch) {
        currentVersion = vMatch[1];
        currentAnchor = idMatch ? idMatch[1] : "";
        currentSection = { version: currentVersion, anchor: currentAnchor, html: "" };
        versionSections.push(currentSection);
      } else {
        if (!currentVersion && pageVersion) currentVersion = pageVersion;
      }
    }

    if (currentSection) {
      currentSection.html += part;
    } else if (currentVersion) {
      currentSection = { version: currentVersion, anchor: currentAnchor, html: part };
      versionSections.push(currentSection);
    }
  }

  // Debug: write markdown per version to data/debug/
  if (debugDir) {
    for (const sec of versionSections) {
      const filePath = join(debugDir, `${sec.version}.md`);
      writeFileSync(filePath, htmlToMarkdown(sec.html));
    }
  }

  // Filter to specific version when --version is used
  const sections = ONLY_VERSION
    ? versionSections.filter(s => matchesVersion(s.version))
    : versionSections;

  // AI extraction: one call per version
  for (const sec of sections) {
    if (!sec.html) continue;
    const sectionUrl = `${BASE_URL}${pagePath}${sec.anchor ? "#" + sec.anchor : ""}`;
    try {
      const aiResult = await extractWithAI(sec.html, sec.version, sectionUrl);
      const { build, starter_build, released, entries: aiEntries } = aiResult;
      for (const e of aiEntries) {
        if (!e.description) continue;
        entries.push({
          version: sec.version,
          category: e.category || "",
          dsof: e.dsof || "",
          description: e.description,
          build: build || "",
          starter_build: starter_build || "",
          released: released || "",
          url: sectionUrl,
        });
      }
    } catch (err) {
      console.warn(`    [AI error] ${sec.version}: ${err.message}`);
    }
  }

  return entries;
}

// Reshape flat entries into tree: { version, build, starter_build, released, url, changes[] }
function buildTree(flatEntries) {
  const map = new Map();
  for (const e of flatEntries) {
    if (!map.has(e.version)) {
      map.set(e.version, {
        version: e.version,
        build: e.build || "",
        starter_build: e.starter_build || "",
        released: e.released || "",
        url: e.url || "",
        changes: [],
      });
    }
    const ver = map.get(e.version);
    ver.changes.push({
      dsof: e.dsof || "",
      category: e.category || "",
      description: e.description,
    });
  }
  return [...map.values()];
}

// Build releases.json from AI cache only (no fetching)
function buildFromCache() {
  const allEntries = [];
  for (const [, cached] of Object.entries(aiCache)) {
    if (!cached.version || !cached.entries) continue;
    if (!matchesVersion(cached.version)) continue;
    const { version, build, starter_build, released, entries: cEntries } = cached;
    const majorMatch = version.match(/^(r\d+)/i);
    const url = cached.url || (majorMatch ? `${BASE_URL}/designer/release-notes/${majorMatch[1]}` : "");
    for (const e of cEntries) {
      if (!e.description) continue;
      allEntries.push({
        version,
        category: e.category || "",
        dsof: e.dsof || "",
        description: e.description,
        build: build || "",
        starter_build: starter_build || "",
        released: released || "",
        url: url || "",
      });
    }
  }
  return allEntries;
}

// Fetch all pages and patch cached entries with correct anchor URLs
async function fixCacheUrls() {
  console.log("Fetching pages to fix cached URLs...");
  let indexHtml;
  try { indexHtml = await fetchText(INDEX_URL); } catch { indexHtml = ""; }
  const paths = indexHtml ? discoverReleaseLinks(indexHtml) : FALLBACK_PATHS;

  // Build version → full URL map from h2 ids
  const versionUrlMap = {};
  for (const path of paths) {
    const url = `${BASE_URL}${path}`;
    console.log(`  Fetching ${url}...`);
    try {
      const html = await fetchText(url);
      const re = /<h2\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gi;
      let m;
      while ((m = re.exec(html))) {
        const anchor = m[1];
        const text = m[2].replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, " ").trim();
        const vMatch = text.match(/(r\d+(?:\.\d+)*)/i);
        if (vMatch) {
          versionUrlMap[vMatch[1].toLowerCase()] = `${url}#${anchor}`;
        }
      }
    } catch (err) {
      console.warn(`  Failed: ${err.message}`);
    }
  }

  // Patch cache entries
  let patched = 0;
  for (const [key, cached] of Object.entries(aiCache)) {
    if (!cached.version) continue;
    const newUrl = versionUrlMap[cached.version.toLowerCase()];
    if (newUrl && cached.url !== newUrl) {
      aiCache[key].url = newUrl;
      patched++;
    }
  }
  saveCacheSync();
  console.log(`\nPatched ${patched} cache entries with anchor URLs.`);
}

async function main() {
  if (FIX_URLS) {
    await fixCacheUrls();
    return;
  }

  const allEntries = [];
  const debugDir = join(__dirname, "data", "debug");
  mkdirSync(debugDir, { recursive: true });

  if (CACHE_ONLY) {
    console.log("Building from AI cache...");
    allEntries.push(...buildFromCache());
  } else {
    console.log("Fetching release notes index...");
    let indexHtml;
    try {
      indexHtml = await fetchText(INDEX_URL);
    } catch (e) {
      console.warn(`Could not fetch index page: ${e.message}`);
      console.warn("Using fallback release page list.");
      indexHtml = "";
    }

    let paths = indexHtml ? discoverReleaseLinks(indexHtml) : FALLBACK_PATHS;

    // Filter to specific release page when --version is used
    if (ONLY_VERSION) {
      const majorMatch = ONLY_VERSION.match(/^(r\d+)/i);
      if (majorMatch) {
        const major = majorMatch[1].toLowerCase();
        paths = paths.filter(p => p.toLowerCase().endsWith(`/${major}`));
      }
      if (paths.length === 0) {
        console.error(`No release page found for version ${ONLY_VERSION}`);
        process.exit(1);
      }
    }

    console.log(`Found ${paths.length} release page(s).`);

    for (const path of paths) {
      const url = `${BASE_URL}${path}`;
      console.log(`  Fetching ${url}...`);
      try {
        const html = await fetchText(url);
        const entries = await parseReleasePage(html, path, debugDir);
        console.log(`  ${path}: ${entries.length} entries`);
        allEntries.push(...entries);
      } catch (err) {
        console.warn(`  Failed: ${err.message}`);
      }
    }
  }

  const outDir = join(__dirname, "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "releases.json");

  // When targeting a specific version, merge into existing releases.json
  if (ONLY_VERSION && existsSync(outPath)) {
    let existing = [];
    try { existing = JSON.parse(readFileSync(outPath, "utf-8")); } catch {}
    const filtered = existing.filter(v => !matchesVersion(v.version));
    filtered.push(...buildTree(allEntries));
    writeFileSync(outPath, JSON.stringify(filtered, null, 2));
    console.log(`\nReplaced ${ONLY_VERSION} entries (${allEntries.length} changes) in ${outPath}`);
  } else {
    const tree = buildTree(allEntries);
    writeFileSync(outPath, JSON.stringify(tree, null, 2));
    console.log(`\nTotal: ${tree.length} versions, ${allEntries.length} changes`);
    console.log(`Written to ${outPath}`);
  }

  console.log(`Debug markdown written to ${debugDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
