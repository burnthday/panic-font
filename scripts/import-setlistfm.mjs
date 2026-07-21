// Ingest Widespread Panic setlists from the setlist.fm REST API into a local
// cache the build joins against. setlist.fm is crowd-sourced but complete; the
// editorial source of truth stays the Google Sheet + Everyday Companion, so this
// cache only supplies raw performance rows (date, venue, ordered songs).
//
// Rate limit: 2 req/sec, 1440/day. This pulls Widespread Panic's setlists by
// artist, paginated (~20 shows/page), so a full backfill is ~150 calls — well
// under budget. Run it nightly and it stays cheap.
//
// The API key is a SECRET. It is read from SETLISTFM_API_KEY (env only) and is
// never written to disk or committed. Get one at https://api.setlist.fm/docs/.
//
// Usage:
//   SETLISTFM_API_KEY=xxxx node scripts/import-setlistfm.mjs
//   node scripts/import-setlistfm.mjs --fixture data/source/__fixtures__/setlistfm-sample.json
//
// Flags:
//   --artist   <name>   artist name to search (default "Widespread Panic")
//   --mbid     <id>     MusicBrainz artist id; when set, uses the artist endpoint
//   --out      <path>   cache output (default data/source/setlistfm-cache.json)
//   --max-pages <n>     stop after N pages (safety cap; default 400)
//   --delay    <ms>     ms between requests (default 550, ~1.8 req/sec)
//   --fixture  <path>   read a saved raw API response from disk instead of
//                       fetching — runs the exact same transform, no network

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const API_BASE = "https://api.setlist.fm/rest/1.0";

const args = parseArgs(process.argv.slice(2));
const artist = args.artist || "Widespread Panic";
const mbid = args.mbid || "";
const output = args.out || path.join(root, "data", "source", "setlistfm-cache.json");
const maxPages = Number(args["max-pages"]) || 400;
const delayMs = Number(args.delay) || 550;

async function main() {
  const rawPages = args.fixture ? await loadFixturePages(args.fixture) : await fetchAllPages();
  const shows = [];
  const seen = new Set();
  let artistMbid = mbid;

  for (const page of rawPages) {
    for (const setlist of page.setlist || []) {
      // Guard: search endpoint can surface other artists — keep exact matches only.
      if (!mbid && normalizeName(setlist.artist?.name) !== normalizeName(artist)) continue;
      if (setlist.id && seen.has(setlist.id)) continue;
      if (setlist.id) seen.add(setlist.id);
      if (!artistMbid && setlist.artist?.mbid) artistMbid = setlist.artist.mbid;
      const show = normalizeShow(setlist);
      if (show) shows.push(show);
    }
  }

  shows.sort((a, b) => b.date.localeCompare(a.date));
  const cache = {
    source: "setlist.fm",
    attribution: "https://www.setlist.fm/",
    artist,
    artistMbid,
    fetchedAt: new Date().toISOString(),
    showCount: shows.length,
    songPerformances: shows.reduce((sum, show) => sum + show.songs.length, 0),
    shows
  };

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  console.log(`Wrote ${shows.length} shows (${cache.songPerformances} song performances) to ${path.relative(root, output)}.`);
}

async function fetchAllPages() {
  const apiKey = process.env.SETLISTFM_API_KEY;
  if (!apiKey) {
    throw new Error("SETLISTFM_API_KEY is not set. Export it (never commit it) and re-run, or use --fixture to test the transform offline.");
  }
  const pages = [];
  let page = 1;
  let total = Infinity;
  while (page <= maxPages && (page - 1) * 20 < total) {
    const url = mbid
      ? `${API_BASE}/artist/${encodeURIComponent(mbid)}/setlists?p=${page}`
      : `${API_BASE}/search/setlists?artistName=${encodeURIComponent(artist)}&p=${page}`;
    const body = await fetchJson(url, apiKey);
    if (!body || !Array.isArray(body.setlist) || body.setlist.length === 0) break;
    pages.push(body);
    total = Number(body.total) || total;
    process.stdout.write(`\rFetched page ${page} (${pages.length * 20}/${total} shows)…`);
    page += 1;
    if ((page - 1) * 20 < total) await sleep(delayMs);
  }
  process.stdout.write("\n");
  return pages;
}

async function fetchJson(url, apiKey, attempt = 1) {
  try {
    const response = await fetch(url, {
      headers: { "x-api-key": apiKey, Accept: "application/json", "User-Agent": "burnthday.com setlist sync" }
    });
    if (response.status === 429 && attempt <= 4) {
      await sleep(delayMs * 2 ** attempt);
      return fetchJson(url, apiKey, attempt + 1);
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
    return response.json();
  } catch (error) {
    if (attempt <= 4) {
      await sleep(delayMs * 2 ** attempt);
      return fetchJson(url, apiKey, attempt + 1);
    }
    throw error;
  }
}

async function loadFixturePages(fixturePath) {
  const raw = JSON.parse(await readFile(path.resolve(root, fixturePath), "utf8"));
  return Array.isArray(raw) ? raw : [raw];
}

// Turn one setlist.fm setlist object into a flat, join-ready show record.
function normalizeShow(setlist) {
  const date = toIsoDate(setlist.eventDate);
  if (!date) return null;
  const city = setlist.venue?.city || {};
  const songs = [];
  const sets = setlist.sets?.set || [];
  for (const set of sets) {
    const label = set.name || (set.encore ? `Encore ${set.encore}` : "");
    for (const song of set.song || []) {
      if (!song?.name) continue;
      songs.push({
        name: song.name.trim(),
        set: label,
        encore: Boolean(set.encore),
        // setlist.fm marks a song as a cover with the ORIGINAL artist here.
        cover: song.cover?.name || "",
        guest: song.with?.name || "",
        tape: Boolean(song.tape)
      });
    }
  }
  return {
    id: setlist.id || "",
    date,
    venue: setlist.venue?.name || "",
    city: city.name || "",
    state: city.stateCode || city.state || "",
    country: city.country?.code || city.country?.name || "",
    tour: setlist.tour?.name || "",
    url: setlist.url || "",
    songs
  };
}

// setlist.fm dates are dd-MM-yyyy.
function toIsoDate(eventDate) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(eventDate || "").trim());
  if (!match) return "";
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
