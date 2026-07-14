import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const siteDataPath = path.resolve(root, args.siteData || "dist/data/site-data.json");
const playstatsPath = path.resolve(root, args.playstats || "data/source/everyday-companion-playstats.json");
const maxListed = Number(args.maxListed || 25);

async function main() {
  const [siteData, playstats] = await Promise.all([readJson(siteDataPath), readJson(playstatsPath)]);
  const siteRows = (Array.isArray(siteData.catalog) ? siteData.catalog : []).filter((row) => isPublicSongTitle(row.title));
  const ecRows = (Array.isArray(playstats.rows) ? playstats.rows : []).filter((row) => isPublicSongTitle(row.title));

  if (!siteRows.length) throw new Error(`No catalog rows found in ${path.relative(root, siteDataPath)}.`);
  if (!ecRows.length) throw new Error(`No Everyday Companion rows found in ${path.relative(root, playstatsPath)}.`);

  const ecByKey = indexRows(ecRows, "Everyday Companion");
  const siteByKey = indexRows(siteRows, "site catalog");
  const mismatches = [];
  const unmatchedSite = [];
  const matchedKeys = new Set();

  for (const row of siteRows) {
    const key = normalizeTitle(row.title);
    const ec = ecByKey.rows.get(key);
    if (!ec) {
      unmatchedSite.push(row);
      continue;
    }

    matchedKeys.add(key);
    compareField(mismatches, row, ec, "first");
    compareField(mismatches, row, ec, "last");
    compareNumber(mismatches, row, ec, "total");
    compareNumber(mismatches, row, ec, "l100");
    compareNumber(mismatches, row, ec, "slp");
  }

  const unmatchedEc = ecRows.filter((row) => !siteByKey.rows.has(normalizeTitle(row.title)));

  printSummary({
    siteRows,
    ecRows,
    matched: matchedKeys.size,
    mismatches,
    unmatchedSite,
    unmatchedEc,
    duplicateSite: siteByKey.duplicates,
    duplicateEc: ecByKey.duplicates
  });

  if (siteByKey.duplicates.length || ecByKey.duplicates.length || mismatches.length || unmatchedSite.length || unmatchedEc.length) {
    process.exitCode = 1;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function indexRows(rows, label) {
  const indexed = new Map();
  const duplicates = [];

  for (const row of rows) {
    const key = normalizeTitle(row.title);
    if (!key) continue;
    if (indexed.has(key)) {
      duplicates.push({ key, first: indexed.get(key), second: row, label });
      continue;
    }
    indexed.set(key, row);
  }

  return { rows: indexed, duplicates };
}

function compareField(mismatches, site, ec, field) {
  const actual = clean(site[field]);
  const expected = clean(ec[field]);
  if (actual !== expected) {
    mismatches.push({ title: site.title, field, actual, expected });
  }
}

function compareNumber(mismatches, site, ec, field) {
  const actual = toNumber(site[field]);
  const expected = toNumber(ec[field]);
  if (actual !== expected) {
    mismatches.push({ title: site.title, field, actual, expected });
  }
}

function printSummary({ siteRows, ecRows, matched, mismatches, unmatchedSite, unmatchedEc, duplicateSite, duplicateEc }) {
  console.log(`Everyday Companion validation`);
  console.log(`  Site catalog rows: ${siteRows.length}`);
  console.log(`  EC playstats rows: ${ecRows.length}`);
  console.log(`  Matched titles: ${matched}`);
  console.log(`  Mismatched fields: ${mismatches.length}`);
  console.log(`  Site-only titles: ${unmatchedSite.length}`);
  console.log(`  EC-only titles: ${unmatchedEc.length}`);

  if (duplicateSite.length) {
    printRows("Duplicate normalized site titles", duplicateSite.map((item) => ({
      title: `${item.first.title} / ${item.second.title}`,
      detail: item.key
    })));
  }

  if (duplicateEc.length) {
    printRows("Duplicate normalized EC titles", duplicateEc.map((item) => ({
      title: `${item.first.title} / ${item.second.title}`,
      detail: item.key
    })));
  }

  if (mismatches.length) {
    printRows("Mismatches", mismatches.map((item) => ({
      title: item.title,
      detail: `${item.field}: site=${JSON.stringify(item.actual)} ec=${JSON.stringify(item.expected)}`
    })));
  }

  if (unmatchedSite.length) {
    printRows("Site-only titles", unmatchedSite.map((row) => ({
      title: row.title,
      detail: `total=${toNumber(row.total)} last=${clean(row.last)}`
    })));
  }

  if (unmatchedEc.length) {
    printRows("EC-only titles", unmatchedEc.map((row) => ({
      title: row.title,
      detail: `total=${toNumber(row.total)} last=${clean(row.last)}`
    })));
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
    else if (value === "--playstats") parsed.playstats = values[++index];
    else if (value === "--max-listed") parsed.maxListed = values[++index];
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
