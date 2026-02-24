#!/usr/bin/env node

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_URL =
  "https://help.disguise.one/designer/release-notes/release-notes";
const BASE_URL = "https://help.disguise.one";

const AI_API_URL = "https://models.github.ai/inference/chat/completions";
const AI_MODEL = "openai/gpt-4o-mini";
const AI_TOKEN = process.env.AI_TOKEN;
const NO_AI = process.argv.includes("--no-ai");
const USE_AI = !NO_AI && !!AI_TOKEN;

if (!AI_TOKEN && !NO_AI) {
  console.warn("Warning: AI_TOKEN not set. Falling back to regex parser.");
  console.warn("Set AI_TOKEN to a GitHub PAT or use --no-ai to silence this warning.\n");
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

// Rate limiter: max 15 RPM → 1 request per 4s
let lastAiCall = 0;
async function rateLimitDelay() {
  const elapsed = Date.now() - lastAiCall;
  const wait = Math.max(0, 4000 - elapsed);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAiCall = Date.now();
}

const AI_JSON_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dsof: { type: "string", description: "Comma-separated DSOF-XXXXX numbers, or empty string if none" },
          description: { type: "string", description: "Concise description of the change" },
        },
        required: ["dsof", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

// Strip non-semantic HTML tags, attributes, and prose paragraphs to reduce token usage
function simplifyHtml(html) {
  return html
    .replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, "")  // remove paragraphs (intros, workarounds, doc links)
    .replace(/<\/?(a|span|strong|em|b|i|code|div|br|img)\b[^>]*>/gi, "")
    .replace(/\s+(class|style|id|data-[\w-]+)="[^"]*"/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractWithAI(sectionHtml, version, category) {
  const simplified = simplifyHtml(sectionHtml);
  const key = cacheKey(simplified);
  if (aiCache[key]) {
    console.log(`    [cache hit] ${version} / ${category}`);
    return aiCache[key];
  }

  await rateLimitDelay();
  console.log(`    [AI] ${version} / ${category}`);

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
          content: `Extract release note entries from this HTML. Each top-level list item is one entry. Nested sub-items belong to their parent. Return DSOF-XXXXX numbers exactly as written (comma-separated), or empty string if none.\n\n${simplified}`,
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
  const entries = parsed.entries || [];

  // Cache and persist
  aiCache[key] = entries;
  saveCacheSync();

  return entries;
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

function extractWithRegex(sectionContent, currentVersion, currentCategory, sectionUrl, entries) {
  const topBlockRe = /<(ul|ol|p)(?:\s[^>]*)?\s*>/gi;
  let topMatch;
  while ((topMatch = topBlockRe.exec(sectionContent))) {
    const blockTag = topMatch[1].toLowerCase();
    const blockStart = topMatch.index;

    if (blockTag === "p") {
      const closeIdx = sectionContent.indexOf("</p>", topMatch.index + topMatch[0].length);
      if (closeIdx === -1) continue;
      const inner = sectionContent.slice(topMatch.index + topMatch[0].length, closeIdx);
      topBlockRe.lastIndex = closeIdx + 4;

      const pText = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
      if (pText && entries.length > 0) {
        const lastEntry = entries[entries.length - 1];
        if (lastEntry.version === currentVersion && lastEntry.category === currentCategory) {
          lastEntry.description += "\n" + pText;
        }
      }
      continue;
    }

    // <ul> or <ol> — find matching close tag respecting nesting
    let depth = 1;
    const closeRe = new RegExp(`<(/?)${blockTag}(?:\\s[^>]*)?>`, "gi");
    closeRe.lastIndex = topMatch.index + topMatch[0].length;
    let closeMatch;
    while ((closeMatch = closeRe.exec(sectionContent))) {
      if (closeMatch[1] === "/") depth--;
      else depth++;
      if (depth === 0) break;
    }
    if (!closeMatch || depth !== 0) continue;
    const blockHtml = sectionContent.slice(blockStart, closeMatch.index + closeMatch[0].length);
    topBlockRe.lastIndex = closeMatch.index + closeMatch[0].length;

    const topLevelLis = extractTopLevelLis(blockHtml);
    for (const raw of topLevelLis) {
      const text = decodeEntities(raw.replace(/<[^>]+>/g, "")).trim();
      if (!text) continue;

      const dsofMatches = text.match(/DSOF-\d+/g);
      const dsof = dsofMatches ? dsofMatches.join(", ") : "";

      let description = text
        .replace(/DSOF-\d+/g, "")
        .replace(/^\s*[-–—:,.&/\s]+/, "")
        .replace(/\s*[-–—:,.&/\s]+$/, "")
        .trim();

      if (!description) description = text;

      entries.push({
        version: currentVersion,
        category: currentCategory,
        dsof,
        description,
        url: sectionUrl,
      });
    }
  }
}

async function parseReleasePage(html, pagePath) {
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

    const sectionContent = part.replace(/<h[23][^>]*>[\s\S]*?<\/h[23]>/i, "");
    const sectionUrl = `${BASE_URL}${pagePath}${currentAnchor ? "#" + currentAnchor : ""}`;

    // Skip sections with no list content (e.g. version header metadata)
    const hasListContent = /<(ul|ol|li)[\s>]/i.test(sectionContent);

    // --- AI extraction path ---
    if (USE_AI && currentVersion && hasListContent) {
      try {
        const aiEntries = await extractWithAI(sectionContent, currentVersion, currentCategory);
        for (const e of aiEntries) {
          if (!e.description) continue;
          entries.push({
            version: currentVersion,
            category: currentCategory,
            dsof: e.dsof || "",
            description: e.description,
            url: sectionUrl,
          });
        }
      } catch (err) {
        console.warn(`    [AI fallback] ${currentVersion} / ${currentCategory}: ${err.message}`);
        // Fall through to regex extraction below
        extractWithRegex(sectionContent, currentVersion, currentCategory, sectionUrl, entries);
      }
      continue;
    }

    // --- Regex extraction path (fallback) ---
    extractWithRegex(sectionContent, currentVersion, currentCategory, sectionUrl, entries);
  }

  if (!USE_AI) {
    // Merge orphan entries (no DSOF) into their nearest preceding DSOF sibling
    const merged = [];
    for (const entry of entries) {
      if (entry.dsof || merged.length === 0) {
        merged.push(entry);
      } else {
        let parent = null;
        for (let i = merged.length - 1; i >= 0; i--) {
          if (merged[i].dsof && merged[i].version === entry.version && merged[i].category === entry.category) {
            parent = merged[i];
            break;
          }
        }
        if (parent) {
          parent.description += "\n" + entry.description;
        } else {
          merged.push(entry);
        }
      }
    }
    return merged;
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

  if (USE_AI) {
    // Sequential processing — AI calls are rate-limited
    for (const path of paths) {
      const url = `${BASE_URL}${path}`;
      console.log(`  Fetching ${url}...`);
      try {
        const html = await fetchText(url);
        const entries = await parseReleasePage(html, path);
        console.log(`  ${path}: ${entries.length} entries`);
        allEntries.push(...entries);
      } catch (err) {
        console.warn(`  Failed: ${err.message}`);
      }
    }
  } else {
    // Parallel fetching — regex parsing is instant
    const results = await Promise.allSettled(
      paths.map(async (path) => {
        const url = `${BASE_URL}${path}`;
        console.log(`  Fetching ${url}...`);
        const html = await fetchText(url);
        return { path, entries: await parseReleasePage(html, path) };
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
