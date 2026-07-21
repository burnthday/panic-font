// verify-ec-links.mjs — build data/source/ec-links.json, the verified map of
// Widespread Panic song -> Everyday Companion lyrics/tune page deep links.
//
// WHERE TO RUN THIS
// -----------------
// Everyday Companion must be reachable over the network. The build sandbox /
// PR-review environment has NO outbound web, so DO NOT run it there — it will
// simply fail to fetch. Run it locally or in a CI job that has internet access,
// commit the resulting data/source/ec-links.json, and the song "Learn It" block
// in scripts/build.mjs will automatically upgrade every matching Everyday
// Companion chip from the generic homepage to the exact deep link. No build code
// change is needed when the file lands.
//
//   npm run verify:ec-links            # fetch + write data/source/ec-links.json
//   npm run verify:ec-links -- --dry-run   # fetch + print, write nothing
//   npm run verify:ec-links -- --url https://everydaycompanion.com/asp/wsp_song_info.asp
//
// Output shape (a flat map keyed by the SAME normalizeTitle() key the catalog
// and build.mjs use, so lookups line up exactly):
//   { "climbtosafety": "https://everydaycompanion.com/spreadsheet/histories/CLIMB.asp", ... }
//
// Do NOT commit a hand-written / fake ec-links.json — an absent file is the
// correct default, and the block falls back to http://everydaycompanion.com/.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const EC_ORIGIN = "https://everydaycompanion.com";
// Everyday Companion's master "Song Information Index". It rebuilt in 2026: the
// old /asp/tunelist.asp is gone, and per-song pages now live at
// /spreadsheet/histories/<CODE>.asp. This index lays out one table row per song
// — the first cell is the plain-title, a later cell holds the "History" deep
// link — which is exactly the (title, per-song URL) pairing we need.
const DEFAULT_INDEX_URLS = [`${EC_ORIGIN}/asp/wsp_song_info.asp`];

const args = parseArgs(process.argv.slice(2));
const indexUrls = args.urls.length ? args.urls : DEFAULT_INDEX_URLS;
const output = args.out || path.join(root, "data", "source", "ec-links.json");

async function main() {
  const links = {};
  let seen = 0;

  for (const indexUrl of indexUrls) {
    const html = await fetchText(indexUrl);
    for (const { title, href } of parseSongLinks(html, indexUrl)) {
      seen += 1;
      const key = normalizeTitle(title);
      if (!key) continue;
      // First verified URL wins; the index is alphabetical so this is stable.
      if (!links[key]) links[key] = href;
    }
  }

  const keys = Object.keys(links).sort();
  const ordered = {};
  for (const key of keys) ordered[key] = links[key];

  if (!keys.length) {
    throw new Error(
      `No Everyday Companion song links parsed from ${indexUrls.join(", ")}. ` +
        `The page markup may have changed — inspect parseSongLinks().`
    );
  }

  if (args.dryRun) {
    console.log(`[dry-run] parsed ${seen} song rows -> ${keys.length} unique song keys. Nothing written.`);
    for (const key of keys.slice(0, 12)) console.log(`  ${key}  ->  ${ordered[key]}`);
    if (keys.length > 12) console.log(`  … +${keys.length - 12} more`);
    return;
  }

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  console.log(`Wrote ${keys.length} verified Everyday Companion links to ${path.relative(root, output)}.`);
}

// Pull (title, absoluteUrl) pairs from Everyday Companion's Song Information
// Index. Each song is one table row: the first <td> is the plain-text title,
// and a later <td> holds <a href="../spreadsheet/histories/<CODE>.asp">History</a>
// — the per-song page. Anchor text there is the literal word "History", not the
// title, so we can't key off the anchor; we split on row boundaries and pair the
// row's first-cell title with its history href.
function parseSongLinks(html, baseUrl) {
  const out = [];
  const rows = String(html || "").split(/<tr\b/i);
  for (const row of rows) {
    const history = row.match(/href=["']([^"']*\/spreadsheet\/histories\/[^"']+\.asp)["']/i);
    if (!history) continue;
    const firstCell = row.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
    if (!firstCell) continue;
    const title = cleanText(firstCell[1]);
    if (!title) continue;
    out.push({ title, href: absolutize(history[1], baseUrl) });
  }
  return out;
}

function absolutize(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    if (href.startsWith("/")) return `${EC_ORIGIN}${href}`;
    return `${EC_ORIGIN}/asp/${href.replace(/^\.?\//, "")}`;
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "Burnthday static-site EC link verifier" }
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  return response.text();
}

function cleanText(value) {
  return decodeHtml(stripTags(value)).replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// ---------------------------------------------------------------------------
// Title normalization — kept byte-for-byte in sync with scripts/build.mjs so the
// keys written here match the catalog's song.key exactly. If build.mjs changes
// normalizeTitleBase() or the alias map, mirror the change here.
// ---------------------------------------------------------------------------
const NORMALIZED_TITLE_ALIASES = {
  bowleggedwomanknockkneedman: "bowleggedwoman",
  conradthecaterpillar: "conrad",
  fixintodieblues: "fixintodie",
  goodmorningschoolgirl: "goodmorninglittleschoolgirl",
  heroesdavidbowie: "heroesdb",
  imjustanoldchunkofcoalbutimgonnabeadiamondsomeday: "chunkofcoal",
  jamaisvutheworldhaschanged: "jamaisvu",
  juncopartnerworthlessman: "juncopartner",
  knockinaroundthezoo: "knockingroundthezoo",
  knockinroundthezoo: "knockingroundthezoo",
  nobodysfault: "nobodysfaultbutmine",
  runnindownadream: "runningdownadream",
  seethatmygraveiskeptclean: "onekindfavor",
  shecaughtthekatyandleftmeamuletoride: "shecaughtthekaty",
  theheathen: "heathen",
  thelowsparkofhighheeledboys: "lowsparkofhighheeledboys",
  thismustbetheplacenavemelody: "thismustbetheplacenaivemelody",
  wrm: "wurm"
};

function normalizeTitleBase(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/×/g, "x")
    .replace(/&/g, "and")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeTitle(title) {
  const normalized = normalizeTitleBase(title);
  return NORMALIZED_TITLE_ALIASES[normalized] || normalized;
}

function parseArgs(values) {
  const parsed = { urls: [], dryRun: false, out: "" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--dry-run") parsed.dryRun = true;
    else if (value === "--url") parsed.urls.push(values[++index]);
    else if (value === "--out") parsed.out = values[++index];
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
