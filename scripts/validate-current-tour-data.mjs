import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const siteDataPath = path.resolve(root, args.siteData || "dist/data/site-data.json");
const setlistsPath = path.resolve(root, args.setlists || "data/source/setlists-2026.json");
const priorStatsPath = path.resolve(root, args.priorStats || "data/source/everyday-companion-prior-song-stats.json");
const maxListed = Number(args.maxListed || 25);

async function main() {
  const [siteData, setlists, priorStats] = await Promise.all([
    readJson(siteDataPath),
    readJson(setlistsPath),
    readJson(priorStatsPath)
  ]);

  const setlistCounts = countSetlistSongs(setlists);
  const siteRows = Array.isArray(siteData.catalog) ? siteData.catalog.filter((row) => isPublicSongTitle(row.title)) : [];
  const playedSiteRows = siteRows.filter((row) => row.playedThisTour);
  const siteByKey = new Map(siteRows.map((row) => [row.key || normalizeTitle(row.title), row]));
  const priorRows = Array.isArray(priorStats.rows) ? priorStats.rows.filter((row) => isPublicSongTitle(row.title)) : [];
  const priorByKey = new Map(priorRows.map((row) => [normalizeTitle(row.title), row]));
  const missingSiteRows = [];
  const countMismatches = [];
  const missingPriorRows = [];

  for (const [key, count] of setlistCounts.entries()) {
    const siteRow = siteByKey.get(key);
    if (!siteRow) {
      missingSiteRows.push({ key, count });
      continue;
    }
    if (toNumber(siteRow.tourCount) !== count) {
      countMismatches.push({ title: siteRow.title, actual: toNumber(siteRow.tourCount), expected: count });
    }
    if (!priorByKey.has(key)) {
      missingPriorRows.push({ title: siteRow.title, key });
    }
  }

  for (const row of playedSiteRows) {
    const key = row.key || normalizeTitle(row.title);
    const expected = setlistCounts.get(key) || 0;
    if (expected !== toNumber(row.tourCount)) {
      countMismatches.push({ title: row.title, actual: toNumber(row.tourCount), expected });
    }
  }

  const totalSetlistPlays = [...setlistCounts.values()].reduce((sum, count) => sum + count, 0);
  const totalMismatches = [];
  compareTotal(totalMismatches, "currentTourSongs", siteData.totals?.currentTourSongs, setlistCounts.size);
  compareTotal(totalMismatches, "currentTourPlays", siteData.totals?.currentTourPlays, totalSetlistPlays);

  const priorMissing = Array.isArray(priorStats.missing) ? priorStats.missing : [];
  printSummary({
    setlistSongs: setlistCounts.size,
    setlistPlays: totalSetlistPlays,
    siteSongs: siteData.totals?.currentTourSongs,
    sitePlays: siteData.totals?.currentTourPlays,
    priorRows: priorRows.length,
    priorMissing: priorMissing.length,
    missingSiteRows,
    countMismatches: dedupeByTitle(countMismatches),
    missingPriorRows,
    totalMismatches
  });

  if (
    missingSiteRows.length ||
    countMismatches.length ||
    missingPriorRows.length ||
    totalMismatches.length ||
    priorMissing.length
  ) {
    process.exitCode = 1;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function countSetlistSongs(setlists) {
  const counts = new Map();

  for (const show of setlists.setlists || []) {
    const songsThisShow = new Set();
    for (const set of show.sets || []) {
      for (const title of set.songTitles || []) {
        if (isPublicSongTitle(title)) songsThisShow.add(normalizeTitle(title));
      }
    }
    for (const key of songsThisShow) counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

function compareTotal(mismatches, field, actual, expected) {
  if (toNumber(actual) !== expected) {
    mismatches.push({ field, actual: toNumber(actual), expected });
  }
}

function printSummary({
  setlistSongs,
  setlistPlays,
  siteSongs,
  sitePlays,
  priorRows,
  priorMissing,
  missingSiteRows,
  countMismatches,
  missingPriorRows,
  totalMismatches
}) {
  console.log("Current tour data validation");
  console.log(`  Raw setlist unique songs: ${setlistSongs}`);
  console.log(`  Raw setlist per-show plays: ${setlistPlays}`);
  console.log(`  Site current-tour songs: ${toNumber(siteSongs)}`);
  console.log(`  Site current-tour plays: ${toNumber(sitePlays)}`);
  console.log(`  Generated prior-stat rows: ${priorRows}`);
  console.log(`  Generated prior-stat missing rows: ${priorMissing}`);
  console.log(`  Count mismatches: ${countMismatches.length}`);
  console.log(`  Site-missing songs: ${missingSiteRows.length}`);
  console.log(`  Prior-stat-missing songs: ${missingPriorRows.length}`);

  if (totalMismatches.length) {
    printRows("Total mismatches", totalMismatches.map((row) => ({
      title: row.field,
      detail: `site=${row.actual} raw=${row.expected}`
    })));
  }
  if (countMismatches.length) {
    printRows("Song count mismatches", countMismatches.map((row) => ({
      title: row.title,
      detail: `site=${row.actual} raw=${row.expected}`
    })));
  }
  if (missingSiteRows.length) {
    printRows("Site-missing songs", missingSiteRows.map((row) => ({ title: row.key, detail: `raw=${row.count}` })));
  }
  if (missingPriorRows.length) {
    printRows("Prior-stat-missing songs", missingPriorRows.map((row) => ({ title: row.title, detail: row.key })));
  }
}

function printRows(label, rows) {
  console.log(`\n${label}:`);
  for (const row of rows.slice(0, maxListed)) {
    console.log(`  - ${row.title} (${row.detail})`);
  }
  if (rows.length > maxListed) {
    console.log(`  ... ${rows.length - maxListed} more`);
  }
}

function dedupeByTitle(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.title}:${row.actual}:${row.expected}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTitle(title) {
  const normalized = clean(title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00d7/g, "x")
    .replace(/�/g, "")
    .replace(/&/g, "and")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const aliases = {
    bowleggedwomanknockkneedman: "bowleggedwoman",
    conradthecaterpillar: "conrad",
    jamaisvutheworldhaschanged: "jamaisvu",
    knockinaroundthezoo: "knockingroundthezoo",
    nobodysfault: "nobodysfaultbutmine",
    thismustbetheplacenavemelody: "thismustbetheplacenaivemelody",
    wrm: "wurm"
  };
  return aliases[normalized] || normalized;
}

function isPublicSongTitle(title) {
  const value = clean(title);
  return Boolean(value) && !/^\?+$/.test(value) && !/^jam$/i.test(value) && !/\breprise$/i.test(value);
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--site-data") parsed.siteData = values[++index];
    else if (value === "--setlists") parsed.setlists = values[++index];
    else if (value === "--prior-stats") parsed.priorStats = values[++index];
    else if (value === "--max-listed") parsed.maxListed = values[++index];
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
