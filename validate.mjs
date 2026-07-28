#!/usr/bin/env node
// Validates data/releases.json before it is allowed to auto-merge.
//
//   node validate.mjs                    # compare against origin/master
//   node validate.mjs --base origin/main # compare against another ref
//   node validate.mjs --no-base          # structure/quality only, no comparison
//
// Exit 0 = safe. Exit 1 = something is wrong, a human should look.
//
// Structural rules apply to every entry. Quality rules apply only to entries
// that are new or changed versus the base ref — older releases were scraped
// before the extraction prompt settled and contain known junk (empty builds,
// empty release dates, comma-joined DSOF lists), which is grandfathered in.

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

const argv = process.argv.slice(2);
const NO_BASE = argv.includes("--no-base");
const BASE_REF = (() => {
  const i = argv.indexOf("--base");
  return i !== -1 ? argv[i + 1] : "origin/master";
})();

const RELEASE_KEYS = ["version", "build", "starter_build", "released", "url", "changes"];
const CHANGE_KEYS = ["dsof", "category", "description"];

const VERSION_RE = /^r\d+(?:\.\d+)*$/;
const DSOF_RE = /^DSOF-\d+(?:\s*,\s*DSOF-\d+)*$/;
const URL_PREFIX = "https://help.disguise.one/";
// Phrases that mean the model answered instead of extracting.
const REFUSAL_RE = /\b(as an AI|I'm sorry|I am sorry|I cannot|I can't help|unable to (?:extract|determine)|no (?:changes|information) (?:were|was) (?:found|provided))\b/i;

const MAX_NEW_VERSIONS = 25;

const errors = [];
const notes = [];
const fail = (msg) => errors.push(msg);

// Declared up front because report() can be called from any early exit below.
let base = null;
let additive = true;
let addedVersions = [];
let modifiedVersions = [];

// ---------------------------------------------------------------- load files

function loadJson(path, label) {
  if (!existsSync(path)) {
    fail(`${label}: file is missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    fail(`${label}: invalid JSON — ${err.message}`);
    return null;
  }
}

const releases = loadJson(join(DATA_DIR, "releases.json"), "data/releases.json");
const cache = loadJson(join(DATA_DIR, ".ai-cache.json"), "data/.ai-cache.json");

if (cache !== null && (typeof cache !== "object" || Array.isArray(cache))) {
  fail("data/.ai-cache.json: expected an object keyed by content hash");
}

if (!Array.isArray(releases) || releases.length === 0) {
  if (releases !== null) fail("data/releases.json: expected a non-empty array");
  report();
}

// ------------------------------------------------------- structural: all rows

const seenVersions = new Set();

for (const [i, rel] of releases.entries()) {
  const at = `releases[${i}]`;
  if (typeof rel !== "object" || rel === null || Array.isArray(rel)) {
    fail(`${at}: expected an object`);
    continue;
  }
  const id = typeof rel.version === "string" ? rel.version : at;

  for (const k of RELEASE_KEYS) {
    if (!(k in rel)) fail(`${id}: missing required key "${k}"`);
  }
  for (const k of Object.keys(rel)) {
    if (!RELEASE_KEYS.includes(k)) fail(`${id}: unexpected key "${k}" — schema changed?`);
  }

  if (typeof rel.version !== "string" || !VERSION_RE.test(rel.version)) {
    fail(`${id}: version is not of the form rNN[.N...]`);
  } else if (seenVersions.has(rel.version)) {
    fail(`${id}: duplicate version entry`);
  } else {
    seenVersions.add(rel.version);
  }

  for (const k of ["build", "starter_build", "released"]) {
    if (typeof rel[k] !== "string") fail(`${id}: ${k} must be a string`);
  }

  if (typeof rel.url !== "string" || !rel.url.startsWith(URL_PREFIX)) {
    fail(`${id}: url must start with ${URL_PREFIX}`);
  }

  if (!Array.isArray(rel.changes)) {
    fail(`${id}: changes must be an array`);
    continue;
  }

  for (const [j, ch] of rel.changes.entries()) {
    const cat = `${id} change[${j}]`;
    if (typeof ch !== "object" || ch === null || Array.isArray(ch)) {
      fail(`${cat}: expected an object`);
      continue;
    }
    for (const k of CHANGE_KEYS) {
      if (typeof ch[k] !== "string") fail(`${cat}: ${k} must be a string`);
    }
    for (const k of Object.keys(ch)) {
      if (!CHANGE_KEYS.includes(k)) fail(`${cat}: unexpected key "${k}" — schema changed?`);
    }
  }
}

// -------------------------------------------------------------- base snapshot

function gitShow(ref, path) {
  return execFileSync("git", ["show", `${ref}:${path}`], {
    cwd: __dirname,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

if (!NO_BASE) {
  try {
    base = JSON.parse(gitShow(BASE_REF, "data/releases.json"));
    if (!Array.isArray(base)) throw new Error("base releases.json is not an array");
  } catch (err) {
    fail(`could not read data/releases.json at ${BASE_REF} — ${String(err.message).trim()}`);
    base = null;
    report();
  }
}

const canon = (v) => JSON.stringify(v, RELEASE_KEYS.concat(CHANGE_KEYS));
const baseByVersion = new Map((base ?? []).map((r) => [r.version, r]));

// Which entries are the model's newest output, and therefore held to the
// stricter quality bar? Everything, if we have nothing to compare against.
const touched = base
  ? releases.filter((r) => {
      const prev = baseByVersion.get(r.version);
      return !prev || canon(prev) !== canon(r);
    })
  : releases.slice();

addedVersions = touched.filter((r) => !baseByVersion.has(r.version)).map((r) => r.version);
modifiedVersions = touched.filter((r) => baseByVersion.has(r.version)).map((r) => r.version);

// ------------------------------------------------------ quality: touched rows

function parseReleaseDate(s) {
  // "May 20th 2026" -> Date
  const cleaned = s.replace(/(\d+)(st|nd|rd|th)\b/i, "$1");
  const t = Date.parse(cleaned);
  return Number.isNaN(t) ? null : new Date(t);
}

const now = Date.now();
const DAY = 86400000;

for (const rel of touched) {
  const id = rel.version;
  if (typeof id !== "string") continue; // already reported structurally

  if (!Array.isArray(rel.changes) || rel.changes.length === 0) {
    fail(`${id}: new/changed release has no changes — likely a failed extraction`);
  }

  if (!/^\d+$/.test(rel.build)) {
    fail(`${id}: build "${rel.build}" is not a number`);
  }

  const d = rel.released ? parseReleaseDate(rel.released) : null;
  if (!d) {
    fail(`${id}: released "${rel.released}" is empty or unparseable`);
  } else if (d.getTime() > now + 2 * DAY) {
    fail(`${id}: released "${rel.released}" is in the future`);
  } else if (d.getFullYear() < 2015) {
    fail(`${id}: released "${rel.released}" predates disguise designer`);
  }

  const seenDsof = new Set();
  for (const [j, ch] of (rel.changes ?? []).entries()) {
    const at = `${id} change[${j}]`;
    if (typeof ch?.description !== "string") continue; // already reported

    if (ch.dsof !== "") {
      if (!DSOF_RE.test(ch.dsof)) fail(`${at}: dsof "${ch.dsof}" is not a DSOF reference`);
      else if (seenDsof.has(ch.dsof)) fail(`${at}: duplicate dsof "${ch.dsof}" within this release`);
      else seenDsof.add(ch.dsof);
    }

    const cat = ch.category;
    if (!cat.trim()) fail(`${at}: category is empty`);
    else if (cat.length > 60) fail(`${at}: category is ${cat.length} chars — looks like prose, not a heading`);
    else if (/[\n\r]/.test(cat)) fail(`${at}: category contains a newline`);

    const desc = ch.description;
    if (desc.trim().length < 10) fail(`${at}: description is too short to be meaningful`);
    else if (desc.length > 1500) fail(`${at}: description is ${desc.length} chars — likely a run-on extraction`);
    if (desc !== desc.trim()) fail(`${at}: description has leading/trailing whitespace`);
    if (/^[[{]|^```/.test(desc.trim())) fail(`${at}: description looks like raw JSON or a code fence`);
    if (REFUSAL_RE.test(desc)) fail(`${at}: description reads as a model refusal, not a change`);

    // The UI renders inline markdown, so unbalanced delimiters render wrong.
    if ((desc.match(/`/g) ?? []).length % 2 !== 0) fail(`${at}: unbalanced backtick in description`);
    if ((desc.match(/\*\*/g) ?? []).length % 2 !== 0) fail(`${at}: unbalanced ** in description`);
  }
}

// ------------------------------------------------------- regression vs base

if (base) {
  const missing = [...baseByVersion.keys()].filter((v) => !seenVersions.has(v));
  if (missing.length) {
    fail(`${missing.length} release(s) present on ${BASE_REF} were dropped: ${missing.slice(0, 10).join(", ")}`);
  }

  const count = (rs) => rs.reduce((n, r) => n + (r.changes?.length ?? 0), 0);
  const before = count(base);
  const after = count(releases);
  if (after < before) {
    fail(`total change count fell from ${before} to ${after}`);
  }

  if (addedVersions.length > MAX_NEW_VERSIONS) {
    fail(`${addedVersions.length} new versions in one run (limit ${MAX_NEW_VERSIONS}) — looks like a re-scrape, not an update`);
  }

  additive = modifiedVersions.length === 0;
  notes.push(`base ${BASE_REF}: ${before} changes across ${base.length} releases`);
  notes.push(`head: ${after} changes across ${releases.length} releases`);
  notes.push(`added: ${addedVersions.length ? addedVersions.join(", ") : "none"}`);
  notes.push(`modified: ${modifiedVersions.length ? modifiedVersions.join(", ") : "none"}`);
}

// ----------------------------------------------------------- frontend contract

const indexPath = join(__dirname, "index.html");
if (existsSync(indexPath) && !readFileSync(indexPath, "utf-8").includes("data/releases.json")) {
  fail("index.html no longer fetches data/releases.json");
}

report();

// ------------------------------------------------------------------- reporting

function report() {
  for (const n of notes) console.log(n);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `valid=${errors.length === 0}\n` +
        `additive=${errors.length === 0 && additive}\n` +
        `added=${addedVersions?.join(",") ?? ""}\n`
    );
  }

  if (errors.length) {
    console.error(`\n${errors.length} validation error(s):`);
    for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
    if (errors.length > 50) console.error(`  ... and ${errors.length - 50} more`);
    process.exit(1);
  }

  console.log(
    `\nOK — ${releases.length} releases validated.` +
      (base ? ` Diff is ${additive ? "purely additive" : "NOT purely additive"}.` : "")
  );
  process.exit(0);
}
