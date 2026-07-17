import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const year = Number(args.year || process.env.TOUR_YEAR || new Date().getFullYear());
const playstatsUrl = args.playstatsUrl || "https://everydaycompanion.com/playstats/playstats.asp";
const setlistsInput = args.setlists || path.join(root, "data", "source", `setlists-${year}.json`);
const currentTourInput = args.currentTour || path.join(root, "data", "source", "current-tour.csv");
const output = args.out || path.join(root, "data", "source", "everyday-companion-prior-song-stats.json");
const basePlayedUrl = args.playedBase || "https://everydaycompanion.com/played/";
const concurrency = Math.max(1, Number(args.concurrency || 6));
const allowEcLag = Boolean(args.allowEcLag || process.env.ALLOW_EC_LAG === "1");

async function main() {
  const [playstatsHtml, setlists, currentTour] = await Promise.all([
    fetchText(playstatsUrl),
    readJson(setlistsInput),
    readCurrentTourRows(currentTourInput)
  ]);
  const playstats = parsePlaystats(playstatsHtml);
  const playstatsByKey = new Map(playstats.map((row) => [normalizeTitle(row.title), row]));
  const currentSongs = currentTourSongStats(setlists, currentTour, year);
  const importRows = [];
  const missing = [];
  const fetchedSongs = [];

  await mapLimit(currentSongs, concurrency, async (song) => {
    const { title } = song;
    const playstat = playstatsByKey.get(normalizeTitle(title));
    if (!playstat?.code) {
      missing.push({ title, reason: "No Everyday Companion played-page code found" });
      return;
    }

    const sourceUrl = `${basePlayedUrl}${encodeURIComponent(playstat.code)}.asp`;
    const html = await fetchText(sourceUrl);
    const history = parsePlayedHistory(html);
    fetchedSongs.push({ song, playstat, sourceUrl, history });
  });

  const ecLatestShowIso = fetchedSongs
    .flatMap(({ history }) => history.map((row) => row.isoDate).filter(Boolean))
    .sort()
    .at(-1) || "";

  for (const { song, playstat, sourceUrl, history } of fetchedSongs) {
    const { title } = song;
    const prior =
      priorStatsForYear(title, playstat.code, sourceUrl, history, year) ||
      (allowEcLag ? priorStatsFromLocalSetlists(title, playstat.code, sourceUrl, history, playstat, song, setlists, ecLatestShowIso) : null);
    if (prior) importRows.push(prior);
    else missing.push({ title, code: playstat.code, reason: `No ${year} play found on EC played page` });
  }

  importRows.sort((a, b) => a.title.localeCompare(b.title));
  missing.sort((a, b) => a.title.localeCompare(b.title));

  const payload = {
    source: "Everyday Companion played pages",
    sourceUrl: playstatsUrl,
    importedAt: new Date().toISOString(),
    tourYear: year,
    allowEcLag,
    ecLatestShowIso,
    generationRule: allowEcLag
      ? "For each current-tour song, prefer the first EC played-page row in the tour year. If EC has not posted that row, add the exact number of locally verified official shows after EC's latest posted show and before the song's first local tour play to EC's SLP baseline."
      : "For each current-tour song, use the first EC played-page row in the tour year. The row's # column is the LTP/SLP entering that play; previous row supplies LTP date; row index supplies totalBefore.",
    rows: importRows,
    missing
  };

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`Imported ${importRows.length} generated EC prior-song stat rows to ${path.relative(root, output)}.`);
  if (missing.length) {
    console.warn(`Missing ${missing.length} song(s): ${missing.map((row) => row.title).slice(0, 15).join(", ")}${missing.length > 15 ? `, +${missing.length - 15} more` : ""}`);
    if (args.requireAll) {
      throw new Error("EC prior-song stats import is incomplete.");
    }
  }
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function readCurrentTourRows(filename) {
  try {
    return csvToObjects(await readFile(filename, "utf8"));
  } catch {
    return [];
  }
}

function currentTourSongStats(setlists, currentTour, targetYear) {
  const songs = new Map();

  for (const show of setlists.setlists || []) {
    const songsThisShow = new Map();
    for (const set of show.sets || []) {
      for (const title of set.songTitles || splitSetSongs(set.songs)) {
        if (!isPublicSongTitle(title)) continue;
        songsThisShow.set(normalizeTitle(title), canonicalSongTitle(title));
      }
    }

    for (const [key, title] of songsThisShow) {
      const existing = songs.get(key) || {
        key,
        title,
        count: 0,
        firstIsoDate: "",
        lastIsoDate: ""
      };
      existing.count += 1;
      existing.firstIsoDate = minIso(existing.firstIsoDate, show.isoDate);
      existing.lastIsoDate = maxIso(existing.lastIsoDate, show.isoDate);
      songs.set(key, existing);
    }
  }

  for (const row of currentTour || []) {
    if (!rowBelongsToYear(row, targetYear)) continue;
    const title = canonicalSongTitle(row["Song Title"] || row.Title || row.Song);
    if (!isPublicSongTitle(title)) continue;

    const key = normalizeTitle(title);
    const existing = songs.get(key) || {
      key,
      title,
      count: 0,
      firstIsoDate: "",
      lastIsoDate: ""
    };
    existing.count = Math.max(existing.count, toNumber(row.Total));
    existing.firstIsoDate = minIso(existing.firstIsoDate, parseDateKey(row.First));
    existing.lastIsoDate = maxIso(existing.lastIsoDate, parseDateKey(row.Last));
    songs.set(key, existing);
  }

  return [...songs.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function rowBelongsToYear(row, targetYear) {
  return ["First", "Last", "Date"].some((field) => {
    const parsed = parseDateKey(row[field]);
    return parsed && Number(parsed.slice(0, 4)) === Number(targetYear);
  });
}

function splitSetSongs(value) {
  return String(value || "")
    .split(/\s*>\s*|\s*,\s*/)
    .map(cleanTitle)
    .filter(Boolean);
}

function parsePlaystats(html) {
  const rows = [];

  for (const rowMatch of String(html || "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cellHtml = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cellHtml.length !== 6) continue;

    const title = cleanText(cellHtml[0]);
    const total = toNumber(cleanText(cellHtml[3]));
    const code = playedCodeFromHtml(cellHtml[0]);
    if (!title || !total || !code) continue;

    rows.push({
      title,
      code,
      first: cleanText(cellHtml[1]),
      last: cleanText(cellHtml[2]),
      total,
      l100: toNumber(cleanText(cellHtml[4])),
      slp: toNumber(cleanText(cellHtml[5]))
    });
  }

  return rows;
}

function playedCodeFromHtml(value) {
  const match = String(value || "").match(/href=(["'])[^"']*\/played\/([^."']+)\.asp\1/i);
  return cleanTitle(match?.[2] || "").toUpperCase();
}

function parsePlayedHistory(html) {
  const rows = [];

  for (const rowMatch of String(html || "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cellHtml = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cellHtml.length < 4) continue;

    const date = cleanText(cellHtml[0]);
    if (!/^(?:\d{2}|\?\?)\/(?:\d{2}|\?\?)\/\d{2}$/.test(date)) continue;

    const showCode = setlistCodeFromHtml(cellHtml[0]);
    rows.push({
      date,
      isoDate: parseDateKey(date),
      showCode,
      ltp: toNumber(cleanText(cellHtml[1])),
      set: cleanText(cellHtml[2]),
      position: cleanText(cellHtml[3])
    });
  }

  return rows;
}

function setlistCodeFromHtml(value) {
  const match = String(value || "").match(/href=(["'])[^"']*\/setlists\/([^."']+)\.asp\1/i);
  return cleanTitle(match?.[2] || "");
}

function priorStatsForYear(title, code, sourceUrl, history, targetYear) {
  const firstTourIndex = history.findIndex((row) => Number(String(row.isoDate).slice(0, 4)) === Number(targetYear));
  if (firstTourIndex < 0) return null;

  const firstTourPlay = history[firstTourIndex];
  const priorPlay = history[firstTourIndex - 1] || null;
  const currentTourPlays = history.filter((row) => Number(String(row.isoDate).slice(0, 4)) === Number(targetYear));
  const lastCurrentPlay = currentTourPlays.at(-1) || firstTourPlay;

  return {
    title,
    code,
    sourceUrl,
    asOfShow: firstTourPlay.isoDate,
    asOfShowCode: firstTourPlay.showCode,
    ltpDate: priorPlay?.date || "",
    ltp: firstTourPlay.ltp,
    totalBefore: firstTourIndex,
    currentTourPlaysFromHistory: currentTourPlays.length,
    firstCurrentDate: firstTourPlay.date,
    lastCurrentDate: lastCurrentPlay.date,
    totalAtImport: history.length
  };
}

function priorStatsFromLocalSetlists(title, code, sourceUrl, history, playstat, localSong, setlists, ecLatestShowIso) {
  if (!localSong?.firstIsoDate) return null;

  const priorIndex = findLastIndex(history, (row) => row.isoDate && row.isoDate < localSong.firstIsoDate);
  const priorPlay = priorIndex >= 0 ? history[priorIndex] : null;
  const localBridgeShows = new Set(
    (setlists.setlists || [])
      .filter((show) => show.isoDate > ecLatestShowIso && show.isoDate < localSong.firstIsoDate)
      .map((show) => show.isoDate)
  ).size;

  return {
    title,
    code,
    sourceUrl,
    asOfShow: localSong.firstIsoDate,
    asOfShowCode: "",
    ltpDate: priorPlay?.date || playstat.last || "",
    ltp: playstat.slp + localBridgeShows,
    totalBefore: priorIndex >= 0 ? priorIndex + 1 : 0,
    currentTourPlaysFromHistory: 0,
    currentTourPlaysFromLocalSetlists: localSong.count,
    firstCurrentDate: isoToShortDate(localSong.firstIsoDate),
    lastCurrentDate: isoToShortDate(localSong.lastIsoDate || localSong.firstIsoDate),
    totalAtImport: history.length,
    ecLatestShowIso,
    localBridgeShows,
    sourceStatus: "ec-lag-verified-local-bridge"
  };
}

async function fetchText(url, attempt = 1) {
  const response = await fetch(url, {
    headers: { "user-agent": "Burnthday static-site EC data importer" }
  });

  if (!response.ok) {
    if (attempt < 3 && [403, 408, 429, 500, 502, 503, 504].includes(response.status)) {
      await wait(350 * attempt);
      return fetchText(url, attempt + 1);
    }
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvToObjects(csv) {
  return rowsToObjects(parseCsv(csv));
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const [headers, ...body] = rows;
  return body.map((row) => Object.fromEntries(headers.map((header, index) => [cleanTitle(header), row[index] ?? ""])));
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === "\"") {
      if (quoted && next === "\"") {
        value += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}

function normalizeTitle(title) {
  const normalized = cleanTitle(title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00d7/g, "x")
    .replace(/&/g, "and")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const aliases = {
    bowleggedwomanknockkneedman: "bowleggedwoman",
    conradthecaterpillar: "conrad",
    knockinaroundthezoo: "knockingroundthezoo",
    nobodysfault: "nobodysfaultbutmine",
    thismustbetheplacenavemelody: "thismustbetheplacenaivemelody",
    wrm: "wurm"
  };
  return aliases[normalized] || normalized;
}

function canonicalSongTitle(title) {
  const cleaned = cleanTitle(title);
  const aliases = {
    bowleggedwoman: "Bowlegged Woman",
    bowleggedwomanknockkneedman: "Bowlegged Woman"
  };
  return aliases[normalizeTitle(cleaned)] || cleaned;
}

function parseDateKey(value) {
  const raw = cleanTitle(value);
  if (!raw || raw.startsWith("?")) return "";

  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return "";
  const month = match[1].padStart(2, "0");
  const day = match[2].padStart(2, "0");
  const year =
    match[3].length === 2
      ? `${Number(match[3]) >= 70 ? "19" : "20"}${match[3]}`
      : match[3];
  return `${year}-${month}-${day}`;
}

function isoToShortDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  return `${match[2]}/${match[3]}/${match[1].slice(2)}`;
}

function minIso(left, right) {
  if (!left) return right || "";
  if (!right) return left;
  return right < left ? right : left;
}

function maxIso(left, right) {
  if (!left) return right || "";
  if (!right) return left;
  return right > left ? right : left;
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}

function isPublicSongTitle(title) {
  const value = cleanTitle(title);
  return Boolean(value) && !/^\?+$/.test(value) && !/^jam$/i.test(value) && !/\breprise$/i.test(value);
}

function cleanText(value) {
  return decodeHtml(stripTags(value)).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, "\"")
    .replace(/&#8221;/g, "\"")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function cleanTitle(value) {
  return String(value ?? "").trim();
}

function toNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--year") parsed.year = values[++index];
    else if (value === "--playstats-url") parsed.playstatsUrl = values[++index];
    else if (value === "--played-base") parsed.playedBase = values[++index];
    else if (value === "--setlists") parsed.setlists = values[++index];
    else if (value === "--current-tour") parsed.currentTour = values[++index];
    else if (value === "--out") parsed.out = values[++index];
    else if (value === "--concurrency") parsed.concurrency = values[++index];
    else if (value === "--require-all") parsed.requireAll = true;
    else if (value === "--allow-ec-lag") parsed.allowEcLag = true;
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
