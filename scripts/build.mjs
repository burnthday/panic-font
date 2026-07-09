import crypto from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const sheetId = process.env.GOOGLE_SHEET_ID || "1EAJINzjyHFauVqHYLSYpmoJpNARg61ghCGDfOlb-D9s";

const sheetRanges = {
  catalog: "'Overall Song Stats Sorted By Last Time Played'!A:H",
  currentTour: "'Current Tour Song Stats Sorted By Since Last Played'!A:H",
  rotationOriginals: "'Rotation - Originals'!A:A",
  rotationCovers: "'Rotation - Covers'!A:A",
  purgatory: "Purgatory!A:A",
  shelf: "'The Shelf'!A:A"
};

async function main() {
  const source = await loadSourceData();
  const siteData = buildSiteData(source);

  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await mkdir(path.join(dist, "data"), { recursive: true });

  await copyAssets();
  await writeFile(path.join(dist, "index.html"), renderHtml(siteData), "utf8");
  await writeFile(path.join(dist, "styles.css"), renderCss(), "utf8");
  await writeFile(path.join(dist, "app.js"), renderAppJs(), "utf8");
  await writeFile(path.join(dist, "data", "site-data.json"), JSON.stringify(siteData, null, 2), "utf8");
  await writeFile(path.join(dist, "_headers"), renderHeaders(), "utf8");
  await writeFile(path.join(dist, "_redirects"), "/* /index.html 200\n", "utf8");
  await writeFile(path.join(dist, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://burnthday.com/sitemap.xml\n", "utf8");
  await writeFile(path.join(dist, "sitemap.xml"), renderSitemap(), "utf8");

  console.log(`Built Burnthday from ${siteData.source.label}: ${siteData.totals.catalogSongs} catalog songs, ${siteData.totals.currentTourSongs} current-tour songs.`);
}

async function loadSourceData() {
  const serviceAccount = parseServiceAccount();
  if (serviceAccount) {
    try {
      return await loadFromGoogleSheets(serviceAccount);
    } catch (error) {
      console.warn(`Google Sheets refresh failed, using CSV seed data. ${error.message}`);
    }
  }

  return loadFromSeedCsv();
}

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!raw) return null;

  const trimmed = raw.trim();
  const json = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
  const parsed = JSON.parse(json);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
  }
  parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

async function loadFromGoogleSheets(serviceAccount) {
  const token = await getGoogleAccessToken(serviceAccount);
  const params = new URLSearchParams();
  for (const range of Object.values(sheetRanges)) params.append("ranges", range);
  params.set("majorDimension", "ROWS");

  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Google Sheets API returned ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const valueRanges = payload.valueRanges || [];
  const byKey = Object.fromEntries(Object.keys(sheetRanges).map((key, index) => [key, valueRanges[index]?.values || []]));

  return {
    label: "live Google Sheet",
    catalog: rowsToObjects(byKey.catalog),
    currentTour: rowsToObjects(stripTitleRow(byKey.currentTour)),
    rotationOriginals: listColumn(byKey.rotationOriginals),
    rotationCovers: listColumn(byKey.rotationCovers),
    purgatory: listColumn(byKey.purgatory),
    shelf: listColumn(byKey.shelf)
  };
}

async function getGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (!response.ok) {
    throw new Error(`Google token request returned ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!payload.access_token) throw new Error("Google token response did not include access_token.");
  return payload.access_token;
}

function base64Url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function loadFromSeedCsv() {
  const catalogCsv = await readFile(path.join(root, "data", "source", "catalog.csv"), "utf8");
  const currentTourCsv = await readFile(path.join(root, "data", "source", "current-tour.csv"), "utf8");

  return {
    label: "seed CSV snapshot",
    catalog: csvToObjects(catalogCsv),
    currentTour: csvToObjects(currentTourCsv),
    rotationOriginals: [],
    rotationCovers: [],
    purgatory: [],
    shelf: []
  };
}

function buildSiteData(source) {
  const catalog = source.catalog.map(normalizeCatalogRow).filter((row) => isPublicSongTitle(row.title));
  const currentTour = source.currentTour.map(normalizeCurrentTourRow).filter((row) => isPublicSongTitle(row.title));

  const originals = catalog.filter((row) => row.type === "Original");
  const covers = catalog.filter((row) => row.type === "Cover");

  const fallbackRotationOriginals = originals.filter((row) => row.slp > 3).sort(byTitle).map(formatSongChip);
  const fallbackRotationCovers = covers.filter((row) => row.slp > 3).sort(byTitle).map(formatSongChip);
  const fallbackPurgatory = catalog.filter((row) => row.total === 1).sort(byTitle).map(formatSongChip);
  const fallbackShelf = catalog
    .filter((row) => row.total > 1 && row.slp >= 100)
    .sort((a, b) => b.slp - a.slp || byTitle(a, b))
    .slice(0, 160)
    .map(formatSongChip);

  const latestTourYear = inferLatestYear(currentTour) || inferLatestYear(catalog) || new Date().getFullYear();

  return {
    generatedAt: new Date().toISOString(),
    source: {
      label: source.label,
      sheetId,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`
    },
    site: {
      name: "Burnthday",
      deck: "The Widespread Panic Spread Sheet",
      currentTourTitle: `Widespread Panic ${latestTourYear} Tour`
    },
    totals: {
      catalogSongs: catalog.length,
      currentTourSongs: currentTour.length,
      originals: originals.length,
      covers: covers.length,
      currentTourPlays: sum(currentTour.map((row) => row.total)),
      currentTourOriginals: currentTour.filter((row) => findCatalogType(catalog, row.title) === "Original").length,
      currentTourCovers: currentTour.filter((row) => findCatalogType(catalog, row.title) === "Cover").length
    },
    highlights: {
      mostPlayedThisTour: currentTour.slice().sort((a, b) => b.total - a.total || a.slp - b.slp).slice(0, 12),
      deepestShelf: catalog.slice().sort((a, b) => b.slp - a.slp || byTitle(a, b)).slice(0, 12),
      recentReturns: currentTour.slice().sort((a, b) => b.slp - a.slp || byTitle(a, b)).slice(0, 12)
    },
    rotation: {
      originals: source.rotationOriginals.length ? source.rotationOriginals : fallbackRotationOriginals,
      covers: source.rotationCovers.length ? source.rotationCovers : fallbackRotationCovers,
      purgatory: source.purgatory.length ? source.purgatory : fallbackPurgatory,
      shelf: source.shelf.length ? source.shelf : fallbackShelf
    },
    currentTour,
    catalog
  };
}

function normalizeCatalogRow(row) {
  const coverFlag = clean(row.Cover);
  const originalFlag = clean(row.Original);
  const type = clean(row.TYPE) || clean(row.Type) || (originalFlag ? "Original" : coverFlag ? "Cover" : "");

  return {
    title: clean(row["Song Title"] || row.Title || row.Song),
    first: clean(row.First),
    last: clean(row.Last),
    total: toNumber(row.Total),
    l100: toNumber(row.L100),
    slp: toNumber(row.SLP),
    type: type === "Original" ? "Original" : "Cover"
  };
}

function normalizeCurrentTourRow(row) {
  return {
    title: clean(row["Song Title"] || row.Title || row.Song),
    first: clean(row.First),
    last: clean(row.Last),
    total: toNumber(row.Total),
    slp: toNumber(row.SLP),
    type: clean(row.Original) ? "Original" : clean(row.Cover) ? "Cover" : ""
  };
}

function findCatalogType(catalog, title) {
  const needle = normalizeTitle(title);
  return catalog.find((row) => normalizeTitle(row.title) === needle)?.type || "";
}

function normalizeTitle(title) {
  return clean(title).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const [headers, ...body] = rows;
  return body.map((row) => Object.fromEntries(headers.map((header, index) => [clean(header), row[index] ?? ""])));
}

function stripTitleRow(rows) {
  if (rows.length > 1 && rows[0]?.length === 1 && rows[1]?.includes("Song Title")) {
    return rows.slice(1);
  }
  return rows;
}

function listColumn(rows) {
  return rows
    .map((row) => clean(row[0]))
    .filter(isPublicSongTitle)
    .filter((value) => !["Originals", "COVERS", "Purgatory", "The Shelf"].includes(value));
}

function csvToObjects(csv) {
  const rows = parseCsv(csv);
  return rowsToObjects(rows);
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

function formatSongChip(row) {
  const suffix = row.slp ? ` (${row.slp})` : "";
  return `${row.title}${suffix}`;
}

function inferLatestYear(rows) {
  const years = rows.flatMap((row) => [row.first, row.last]).map((date) => {
    const match = clean(date).match(/(\d{2,4})$/);
    if (!match) return 0;
    const year = Number(match[1]);
    return year < 100 ? 2000 + year : year;
  });
  return Math.max(0, ...years);
}

function byTitle(a, b) {
  return a.title.localeCompare(b.title);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function toNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

function clean(value) {
  return String(value ?? "").trim();
}

function isPublicSongTitle(title) {
  const value = clean(title);
  return Boolean(value) && !/^\?+$/.test(value);
}

async function copyAssets() {
  const entries = await readdir(root);
  await Promise.all(
    entries
      .filter((file) => /\.(woff2|png)$/i.test(file))
      .map(async (file) => {
        const source = path.join(root, file);
        if (!(await stat(source)).isFile()) return;
        await copyFile(source, path.join(dist, "assets", file));
      })
  );
}

function renderHtml(data) {
  const description = "Burnthday's Widespread Panic Spread Sheet: song rotation, tour stats, covers, originals, shelf, and purgatory.";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(data.site.currentTourTitle)} by Burnthday</title>
    <meta name="description" content="${description}">
    <meta property="og:title" content="${escapeHtml(data.site.currentTourTitle)} by Burnthday">
    <meta property="og:description" content="${description}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://burnthday.com/">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <main id="app">
      <section class="loading">
        <p>Loading Burnthday...</p>
      </section>
    </main>
    <script src="/app.js" type="module"></script>
  </body>
</html>
`;
}

function renderCss() {
  return `@font-face {
  font-family: "Panic Hand";
  src: url("/assets/Panic-Hand.woff2") format("woff2");
  font-display: swap;
}

@font-face {
  font-family: "Milkrun";
  src: url("/assets/milkrun.woff2") format("woff2");
  font-display: swap;
}

:root {
  color-scheme: light;
  --paper: #f7f3e8;
  --paper-strong: #fffaf0;
  --ink: #211c18;
  --muted: #6a6259;
  --line: #d7cdbf;
  --red: #bd2d2a;
  --green: #247a4b;
  --blue: #286e9e;
  --gold: #b98024;
  --shadow: 0 16px 48px rgba(32, 24, 16, 0.12);
}

* {
  box-sizing: border-box;
}

html {
  background: var(--paper);
}

body {
  margin: 0;
  min-width: 320px;
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background:
    linear-gradient(90deg, rgba(33, 28, 24, 0.045) 1px, transparent 1px) 0 0 / 36px 36px,
    linear-gradient(180deg, rgba(33, 28, 24, 0.035) 1px, transparent 1px) 0 0 / 100% 28px,
    var(--paper);
}

button,
input,
select {
  font: inherit;
}

.loading {
  min-height: 100vh;
  display: grid;
  place-items: center;
  color: var(--muted);
}

.site-shell {
  min-height: 100vh;
}

.hero {
  min-height: 76vh;
  display: grid;
  align-items: end;
  padding: 40px clamp(18px, 5vw, 72px) 28px;
  background:
    linear-gradient(180deg, rgba(247, 243, 232, 0.22), rgba(247, 243, 232, 0.94)),
    radial-gradient(circle at 22% 16%, rgba(189, 45, 42, 0.16), transparent 28%),
    radial-gradient(circle at 82% 20%, rgba(36, 122, 75, 0.15), transparent 30%),
    linear-gradient(135deg, #f1e4c6 0%, #f8f2e5 42%, #e7ddcf 100%);
  border-bottom: 1px solid var(--line);
}

.hero-inner {
  width: min(1180px, 100%);
  margin: 0 auto;
}

.brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: clamp(42px, 8vw, 92px);
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  color: var(--ink);
  text-decoration: none;
}

.marker {
  width: 60px;
  height: 68px;
  background: url("/assets/marker-1.png") center / contain no-repeat;
  flex: 0 0 auto;
}

.brand-type {
  font-family: "Milkrun", Georgia, serif;
  font-size: clamp(22px, 4vw, 38px);
  letter-spacing: 0;
  line-height: 1;
}

.source-pill {
  border: 1px solid rgba(33, 28, 24, 0.18);
  background: rgba(255, 250, 240, 0.72);
  border-radius: 999px;
  padding: 8px 12px;
  color: var(--muted);
  white-space: nowrap;
  font-size: 13px;
}

.hero h1 {
  margin: 0;
  max-width: 960px;
  font-family: "Panic Hand", Georgia, serif;
  font-size: clamp(56px, 12vw, 154px);
  line-height: 0.86;
  letter-spacing: 0;
  font-weight: 400;
}

.hero-deck {
  margin: 22px 0 0;
  max-width: 720px;
  color: #42382f;
  font-size: clamp(18px, 2.4vw, 28px);
  line-height: 1.28;
}

.hero-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: clamp(28px, 5vw, 56px);
}

.stat {
  padding: 14px 0;
  border-top: 4px solid var(--ink);
}

.stat:nth-child(2) {
  border-color: var(--red);
}

.stat:nth-child(3) {
  border-color: var(--green);
}

.stat:nth-child(4) {
  border-color: var(--blue);
}

.stat-value {
  display: block;
  font-family: "Milkrun", Georgia, serif;
  font-size: clamp(28px, 5vw, 54px);
  line-height: 1;
}

.stat-label {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 13px;
  text-transform: uppercase;
}

.content-band {
  padding: 24px clamp(18px, 5vw, 72px) 56px;
}

.content-inner {
  width: min(1180px, 100%);
  margin: 0 auto;
}

.toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: grid;
  grid-template-columns: 1fr minmax(220px, 360px);
  gap: 14px;
  align-items: center;
  padding: 14px 0;
  background: rgba(247, 243, 232, 0.94);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid rgba(215, 205, 191, 0.72);
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tab-button,
.filter-button {
  min-height: 38px;
  border: 1px solid rgba(33, 28, 24, 0.18);
  border-radius: 6px;
  background: var(--paper-strong);
  color: var(--ink);
  padding: 8px 12px;
  cursor: pointer;
}

.tab-button[aria-selected="true"],
.filter-button.is-active {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--paper-strong);
}

.search {
  width: 100%;
  min-height: 42px;
  border: 1px solid rgba(33, 28, 24, 0.2);
  border-radius: 6px;
  background: var(--paper-strong);
  color: var(--ink);
  padding: 10px 12px;
}

.section {
  padding: 38px 0 0;
}

.section[hidden] {
  display: none;
}

.section-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 12px;
}

.section-heading h2 {
  margin: 0;
  font-family: "Milkrun", Georgia, serif;
  font-size: clamp(26px, 4vw, 44px);
  line-height: 1;
  letter-spacing: 0;
}

.count {
  color: var(--muted);
  font-size: 14px;
  white-space: nowrap;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.feature {
  border-top: 8px solid var(--red);
  background: rgba(255, 250, 240, 0.72);
  box-shadow: var(--shadow);
  padding: 18px;
}

.feature:nth-child(2) {
  border-color: var(--green);
}

.feature:nth-child(3) {
  border-color: var(--blue);
}

.feature h3 {
  margin: 0 0 12px;
  font-size: 16px;
  text-transform: uppercase;
  color: var(--muted);
}

.feature ol {
  margin: 0;
  padding-left: 22px;
}

.feature li {
  margin: 7px 0;
}

.song-grid {
  column-width: 245px;
  column-gap: 26px;
}

.song-chip {
  display: block;
  break-inside: avoid;
  padding: 5px 0;
  border-bottom: 1px dotted rgba(33, 28, 24, 0.24);
  font-family: "Panic Hand", Georgia, serif;
  font-size: 24px;
  line-height: 1.05;
}

.song-chip mark {
  background: rgba(255, 213, 97, 0.65);
  color: inherit;
  padding: 0 2px;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  background: rgba(255, 250, 240, 0.72);
}

table {
  width: 100%;
  border-collapse: collapse;
  min-width: 720px;
}

th,
td {
  padding: 11px 12px;
  text-align: left;
  border-bottom: 1px solid rgba(215, 205, 191, 0.75);
}

th {
  position: sticky;
  top: 0;
  background: #efe4d1;
  z-index: 1;
  font-size: 12px;
  text-transform: uppercase;
  color: var(--muted);
}

td:first-child {
  font-weight: 700;
}

.footer {
  padding: 30px clamp(18px, 5vw, 72px) 48px;
  color: var(--muted);
  border-top: 1px solid var(--line);
}

.footer-inner {
  width: min(1180px, 100%);
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}

.footer a {
  color: var(--ink);
}

@media (max-width: 800px) {
  .hero {
    min-height: 72vh;
    padding-top: 22px;
  }

  .brand-row,
  .section-heading,
  .footer-inner {
    align-items: flex-start;
    flex-direction: column;
  }

  .source-pill {
    white-space: normal;
  }

  .hero-stats,
  .feature-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .toolbar {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .hero-stats,
  .feature-grid {
    grid-template-columns: 1fr;
  }

  .song-chip {
    font-size: 22px;
  }
}
`;
}

function renderAppJs() {
  return `const app = document.querySelector("#app");

const state = {
  data: null,
  tab: "rotation",
  query: "",
  catalogType: "all"
};

const numberFormatter = new Intl.NumberFormat("en-US");
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric"
});

init();

async function init() {
  const response = await fetch("/data/site-data.json", { cache: "no-store" });
  state.data = await response.json();
  render();
}

function render() {
  const data = state.data;
  app.innerHTML = \`
    <div class="site-shell">
      <header class="hero">
        <div class="hero-inner">
          <div class="brand-row">
            <a class="brand-mark" href="/" aria-label="Burnthday home">
              <span class="marker" aria-hidden="true"></span>
              <span class="brand-type">\${escapeHtml(data.site.name)}</span>
            </a>
            <span class="source-pill">\${escapeHtml(sourceLabel(data))}</span>
          </div>
          <h1>\${escapeHtml(data.site.currentTourTitle)}</h1>
          <p class="hero-deck">\${escapeHtml(data.site.deck)}</p>
          <div class="hero-stats">
            \${stat(data.totals.currentTourSongs, "tour songs")}
            \${stat(data.totals.currentTourPlays, "tour plays")}
            \${stat(data.totals.originals, "originals")}
            \${stat(data.totals.covers, "covers")}
          </div>
        </div>
      </header>

      <div class="content-band">
        <div class="content-inner">
          <div class="toolbar">
            <nav class="tabs" aria-label="Burnthday sections">
              \${tabButton("rotation", "Rotation")}
              \${tabButton("tour", "Tour Stats")}
              \${tabButton("catalog", "Full Catalog")}
              \${tabButton("shelf", "Shelf")}
            </nav>
            <input class="search" type="search" value="\${escapeAttr(state.query)}" placeholder="Search songs" aria-label="Search songs">
          </div>

          \${renderRotation(data)}
          \${renderTour(data)}
          \${renderCatalog(data)}
          \${renderShelf(data)}
        </div>
      </div>

      <footer class="footer">
        <div class="footer-inner">
          <span>Burnthday © \${new Date().getFullYear()} · Unaffiliated with Widespread Panic.</span>
          <a href="\${escapeAttr(data.source.sheetUrl)}">Source spreadsheet</a>
        </div>
      </footer>
    </div>
  \`;

  bindEvents();
}

function bindEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab;
      render();
    });
  });

  const search = document.querySelector(".search");
  search.addEventListener("input", (event) => {
    state.query = event.target.value;
    render();
    document.querySelector(".search").focus();
  });

  document.querySelectorAll(".filter-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.catalogType = button.dataset.type;
      render();
    });
  });
}

function renderRotation(data) {
  return \`
    <section class="section" \${state.tab === "rotation" ? "" : "hidden"}>
      <div class="feature-grid">
        \${featureList("Most Played", data.highlights.mostPlayedThisTour.map((song) => \`\${song.title} · \${song.total}\`))}
        \${featureList("Deep Shelf", data.highlights.deepestShelf.map((song) => \`\${song.title} · \${song.slp}\`))}
        \${featureList("Longest Wait This Tour", data.highlights.recentReturns.map((song) => \`\${song.title} · \${song.slp}\`))}
      </div>
      \${songSection("Originals", filteredList(data.rotation.originals), data.rotation.originals.length)}
      \${songSection("Covers", filteredList(data.rotation.covers), data.rotation.covers.length)}
    </section>
  \`;
}

function renderTour(data) {
  const rows = filterRows(data.currentTour);
  return \`
    <section class="section" \${state.tab === "tour" ? "" : "hidden"}>
      <div class="section-heading">
        <h2>Tour Stats</h2>
        <span class="count">\${rows.length} of \${data.currentTour.length}</span>
      </div>
      \${table(rows, ["title", "first", "last", "total", "slp"], ["Song", "First", "Last", "Total", "SLP"])}
    </section>
  \`;
}

function renderCatalog(data) {
  let rows = filterRows(data.catalog);
  if (state.catalogType !== "all") rows = rows.filter((row) => row.type === state.catalogType);
  return \`
    <section class="section" \${state.tab === "catalog" ? "" : "hidden"}>
      <div class="section-heading">
        <h2>Full Catalog</h2>
        <span class="count">\${rows.length} of \${data.catalog.length}</span>
      </div>
      <div class="filters">
        \${filterButton("all", "All")}
        \${filterButton("Original", "Originals")}
        \${filterButton("Cover", "Covers")}
      </div>
      \${table(rows, ["title", "type", "first", "last", "total", "l100", "slp"], ["Song", "Type", "First", "Last", "Total", "L100", "SLP"])}
    </section>
  \`;
}

function renderShelf(data) {
  return \`
    <section class="section" \${state.tab === "shelf" ? "" : "hidden"}>
      \${songSection("The Shelf", filteredList(data.rotation.shelf), data.rotation.shelf.length)}
      \${songSection("Purgatory", filteredList(data.rotation.purgatory), data.rotation.purgatory.length)}
    </section>
  \`;
}

function stat(value, label) {
  return \`<div class="stat"><span class="stat-value">\${numberFormatter.format(value)}</span><span class="stat-label">\${escapeHtml(label)}</span></div>\`;
}

function tabButton(tab, label) {
  return \`<button class="tab-button" type="button" data-tab="\${tab}" aria-selected="\${state.tab === tab}">\${escapeHtml(label)}</button>\`;
}

function filterButton(type, label) {
  return \`<button class="filter-button \${state.catalogType === type ? "is-active" : ""}" type="button" data-type="\${escapeAttr(type)}">\${escapeHtml(label)}</button>\`;
}

function featureList(title, songs) {
  return \`
    <article class="feature">
      <h3>\${escapeHtml(title)}</h3>
      <ol>
        \${songs.map((song) => \`<li>\${highlight(song)}</li>\`).join("")}
      </ol>
    </article>
  \`;
}

function songSection(title, songs, total) {
  return \`
    <div class="section-heading">
      <h2>\${escapeHtml(title)}</h2>
      <span class="count">\${songs.length} of \${total}</span>
    </div>
    <div class="song-grid">
      \${songs.map((song) => \`<span class="song-chip">\${highlight(song)}</span>\`).join("")}
    </div>
  \`;
}

function table(rows, keys, labels) {
  return \`
    <div class="table-wrap">
      <table>
        <thead><tr>\${labels.map((label) => \`<th>\${escapeHtml(label)}</th>\`).join("")}</tr></thead>
        <tbody>
          \${rows.map((row) => \`<tr>\${keys.map((key) => \`<td>\${highlight(String(row[key] ?? ""))}</td>\`).join("")}</tr>\`).join("")}
        </tbody>
      </table>
    </div>
  \`;
}

function filterRows(rows) {
  const query = normalize(state.query);
  if (!query) return rows;
  return rows.filter((row) => normalize(Object.values(row).join(" ")).includes(query));
}

function filteredList(values) {
  const query = normalize(state.query);
  if (!query) return values;
  return values.filter((value) => normalize(value).includes(query));
}

function highlight(value) {
  const escaped = escapeHtml(value);
  const query = state.query.trim();
  if (!query) return escaped;
  const safeQuery = query.replace(/[.*+?^\\$\\{\\}\\(\\)\\|\\[\\]\\\\]/g, "\\\\$&");
  return escaped.replace(new RegExp(safeQuery, "ig"), (match) => \`<mark>\${match}</mark>\`);
}

function normalize(value) {
  return String(value ?? "").toLowerCase();
}

function sourceLabel(data) {
  const generated = dateFormatter.format(new Date(data.generatedAt));
  return \`\${data.source.label} · refreshed \${generated}\`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/\\x60/g, "&#96;");
}
`;
}

function renderHeaders() {
  return `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: interest-cohort=()

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/data/*
  Cache-Control: public, max-age=300
`;
}

function renderSitemap() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://burnthday.com/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
