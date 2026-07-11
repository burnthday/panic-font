import crypto from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const sheetId = process.env.GOOGLE_SHEET_ID || "1EAJINzjyHFauVqHYLSYpmoJpNARg61ghCGDfOlb-D9s";
const bloggerFeedPath = process.env.BLOGGER_TAKEOUT_FEED || path.join(root, "data", "source", "blogger-feed.atom");
let archiveMediaByName = new Map();

const sheetRanges = {
  catalog: "'Overall Song Stats Sorted By Last Time Played'!A:H",
  currentTour: "'Current Tour Song Stats Sorted By Since Last Played'!A:H"
};

const config = {
  rotationSlpLimit: 200,
  addOnOriginals: ["SPARKS FLY"],
  addOnCovers: ["GODZILLA", "BLACK SABBATH", "THE HARDER THEY COME", "DEAD FLOWERS", "COMFORTABLY NUMB", "WAR PIGS"],
  addOnDates: {
    GODZILLA: "10/28/18",
    "BLACK SABBATH": "10/28/16",
    "THE HARDER THEY COME": "09/12/15",
    "DEAD FLOWERS": "12/29/15"
  },
  stripeAssets: ["marker-black.png", "marker-green.png", "marker-blue.png", "marker-red.png"]
};

async function main() {
  const [source, archiveEntries] = await Promise.all([loadSourceData(), loadBloggerArchive()]);
  const siteData = buildSiteData(source, archiveEntries);

  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await mkdir(path.join(dist, "data"), { recursive: true });

  await copyAssets();
  await writeBloggerArchive(archiveEntries);
  await writeFile(path.join(dist, "index.html"), renderHtml(siteData), "utf8");
  await writeFile(path.join(dist, "styles.css"), renderCss(), "utf8");
  await writeFile(path.join(dist, "data", "site-data.json"), JSON.stringify(siteData, null, 2), "utf8");
  await writeFile(path.join(dist, "_headers"), renderHeaders(), "utf8");
  await writeFile(path.join(dist, "_redirects"), renderRedirects(archiveEntries), "utf8");
  await writeFile(path.join(dist, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://burnthday.com/sitemap.xml\n", "utf8");
  await writeFile(path.join(dist, "sitemap.xml"), renderSitemap(siteData, archiveEntries), "utf8");

  console.log(`Built ${siteData.site.title}: ${siteData.boards.rotationOriginals.length} originals, ${siteData.boards.rotationCovers.length} covers, ${siteData.setlists.length} setlists, ${archiveEntries.length} archive pages.`);
}

async function loadSourceData() {
  const setlists = await loadSetlists();
  const spreadsheet = await loadSpreadsheetData(inferSetlistYear(setlists));
  return { ...spreadsheet, setlists };
}

async function loadSpreadsheetData(tourYear = 0) {
  const serviceAccount = parseServiceAccount();
  if (serviceAccount) {
    try {
      return await loadFromGoogleSheets(serviceAccount);
    } catch (error) {
      console.warn(`Google Sheets refresh failed, using CSV seed data. ${error.message}`);
    }
  }

  return loadFromSeedCsv(tourYear);
}

async function loadSetlists() {
  const explicitYear = process.env.TOUR_YEAR;
  const sourceDir = path.join(root, "data", "source");
  const candidates = [];

  if (explicitYear) candidates.push(path.join(sourceDir, `setlists-${explicitYear}.json`));

  try {
    const files = await readdir(sourceDir);
    candidates.push(
      ...files
        .filter((file) => /^setlists-\d{4}\.json$/.test(file))
        .sort((a, b) => b.localeCompare(a))
        .map((file) => path.join(sourceDir, file))
    );
  } catch {
    candidates.push(path.join(sourceDir, "setlists-2025.json"));
  }

  for (const filename of [...new Set(candidates)]) {
    try {
      const raw = await readFile(filename, "utf8");
      const payload = JSON.parse(raw);
      return attachLocalSetlistImages(payload, inferSetlistYear(payload));
    } catch {
      // Try the next setlist snapshot.
    }
  }

  return { title: "WIDESPREAD PANIC TOUR", sourceUrl: "", setlists: [], tourDates: [] };
}

async function attachLocalSetlistImages(payload, tourYear = 0) {
  const localDir = path.join(root, "assets", "setlists", String(tourYear || ""));
  let files = [];
  try {
    files = await readdir(localDir);
  } catch {
    return payload;
  }

  const byDate = new Map(files.map((file) => [path.parse(file).name, file]));
  for (const show of payload.setlists || []) {
    const file = byDate.get(show.isoDate);
    if (file) show.image = `/assets/setlists/${tourYear}/${file}`;
  }
  return payload;
}

async function loadBloggerArchive() {
  let raw = "";
  try {
    raw = await readFile(bloggerFeedPath, "utf8");
  } catch {
    return [];
  }

  archiveMediaByName = await loadArchiveMediaByName();
  const entries = [...raw.matchAll(/<entry\b[\s\S]*?<\/entry>/g)].map((match) => parseBloggerEntry(match[0]));
  const seenPaths = new Map();
  return entries
    .filter((entry) => entry.content || entry.title || entry.filename)
    .map((entry, index) => {
      const basePath = archivePathFor(entry, index);
      const count = seenPaths.get(basePath) || 0;
      seenPaths.set(basePath, count + 1);
      const pagePath = count ? withPathSuffix(basePath, count + 1) : basePath;
      return {
        ...entry,
        path: pagePath,
        title: entry.title || titleFromFilename(pagePath) || `Burnthday Archive ${index + 1}`,
        isReview: isReviewEntry(entry, pagePath)
      };
    })
    .sort((a, b) => (b.published || "").localeCompare(a.published || ""));
}

async function loadArchiveMediaByName() {
  const mediaDir = path.join(root, "assets", "archive-media");
  let files = [];
  try {
    files = await readdir(mediaDir);
  } catch {
    return new Map();
  }
  return new Map(
    files
      .filter((file) => /\.(png|jpe?g|gif|bmp)$/i.test(file))
      .map((file) => [file, `/assets/archive-media/${encodeURIComponent(file)}`])
  );
}

function parseBloggerEntry(xml) {
  const title = decodeXml(stripTags(readXmlTag(xml, "title"))).trim();
  const content = rewriteArchiveHtml(decodeXml(readXmlTag(xml, "content")));
  const published = decodeXml(stripTags(readXmlTag(xml, "published"))).trim();
  const updated = decodeXml(stripTags(readXmlTag(xml, "updated"))).trim();
  const filename = decodeXml(stripTags(readXmlTag(xml, "blogger:filename"))).trim();
  const metaDescription = decodeXml(stripTags(readXmlTag(xml, "blogger:metaDescription"))).trim();
  const categories = [...xml.matchAll(/<category\b[^>]*term=(["'])(.*?)\1/gi)].map((match) => decodeXml(match[2]).trim()).filter(Boolean);
  const links = [...xml.matchAll(/<link\b([^>]*)\/?>/gi)].map((match) => ({
    rel: readXmlAttr(match[1], "rel"),
    href: decodeXml(readXmlAttr(match[1], "href"))
  }));

  return {
    title,
    content,
    published,
    updated,
    filename,
    metaDescription,
    categories,
    sourceUrl: links.find((link) => link.rel === "alternate")?.href || ""
  };
}

function readXmlTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1] || "";
}

function readXmlAttr(attrs, attrName) {
  const match = attrs.match(new RegExp(`${attrName}=(["'])(.*?)\\1`, "i"));
  return match?.[2] || "";
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
}

function archivePathFor(entry, index) {
  const filename = clean(entry.filename);
  if (filename.startsWith("/")) return filename;
  if (filename) return `/${filename.replace(/^\/+/, "")}`;

  const year = (entry.published || entry.updated || "").slice(0, 4) || "archive";
  return `/archive/${year}/${slugify(entry.title || `entry-${index + 1}`)}.html`;
}

function withPathSuffix(pagePath, suffix) {
  return pagePath.replace(/\.html?$/i, `-${suffix}.html`);
}

function titleFromFilename(filename) {
  const leaf = clean(filename).split("/").filter(Boolean).at(-1) || "";
  return titleCase(leaf.replace(/\.html?$/i, "").replace(/[-_]+/g, " "));
}

function isReviewEntry(entry, pagePath) {
  return (
    /tour\s+in\s+review|tour\s+review|in\s+review/i.test(entry.title) ||
    /tour.*review|in-review/i.test(pagePath) ||
    entry.categories.some((category) => /tour in review/i.test(category))
  );
}

function rewriteArchiveHtml(html) {
  return String(html || "")
    .replace(/https?:\/\/[^"'<>\s)]+/gi, (url) => localArchiveMediaUrl(url) || url)
    .replace(/https?:\/\/(?:www\.)?burnthday\.com/gi, "")
    .replace(/https?:\/\/burnthday\.blogspot\.com/gi, "")
    .replace(/https?:\/\/burnthday\.github\.io\/panic-font\/([^"'<>\s)]+)/gi, "/assets/$1")
    .replace(/\?m=1/g, "");
}

function localArchiveMediaUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const filename = [...parts].reverse().find((part) => /\.(png|jpe?g|gif|bmp)$/i.test(part));
    return filename ? archiveMediaByName.get(filename) || "" : "";
  } catch {
    return "";
  }
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function slugify(value) {
  const slug = clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "entry";
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
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Google Sheets API returned ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const valueRanges = payload.valueRanges || [];
  return {
    label: "live Google Sheet",
    catalog: rowsToObjects(valueRanges[0]?.values || []),
    currentTour: rowsToObjects(stripTitleRow(valueRanges[1]?.values || []))
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

async function loadFromSeedCsv(tourYear = 0) {
  const catalogCsv = await readFile(path.join(root, "data", "source", "catalog.csv"), "utf8");
  const currentTourCsv = await readFirstExisting([
    tourYear ? path.join(root, "data", "source", `current-tour-${tourYear}.csv`) : "",
    path.join(root, "data", "source", "current-tour.csv")
  ]);

  return {
    label: "seed CSV snapshot",
    catalog: csvToObjects(catalogCsv),
    currentTour: csvToObjects(currentTourCsv)
  };
}

async function readFirstExisting(filenames) {
  let lastError = null;
  for (const filename of filenames.filter(Boolean)) {
    try {
      return await readFile(filename, "utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No readable source file found.");
}

function buildSiteData(source, archiveEntries = []) {
  const baseCatalog = source.catalog.map(normalizeCatalogRow).filter((row) => isPublicSongTitle(row.title));
  const rawCurrentTour = source.currentTour.map(normalizeCurrentTourRow).filter((row) => isPublicSongTitle(row.title));
  const setlists = [...(source.setlists.setlists || [])].sort((a, b) => b.isoDate.localeCompare(a.isoDate));
  const tourDates = [...(source.setlists.tourDates || [])].sort((a, b) => a.isoDate.localeCompare(b.isoDate));
  const setlistYear = inferSetlistYear(source.setlists);
  const latestYear = setlistYear || inferLatestYear(rawCurrentTour) || inferLatestYear(baseCatalog) || new Date().getFullYear();
  const currentTour = setlistYear ? rawCurrentTour.filter((row) => rowBelongsToYear(row, setlistYear)) : rawCurrentTour;
  const setlistStats = analyzeSetlists(setlists, baseCatalog, currentTour);
  const catalog = withSetlistOnlySongs(baseCatalog, setlistStats, currentTour);
  const currentTourByKey = new Map(currentTour.map((row) => [normalizeTitle(row.title), row]));
  const lastFourDates = newestUniqueDates(setlists, catalog, currentTour);
  const postedShowCount = setlists.length;

  const songs = catalog.map((row) => {
    const key = normalizeTitle(row.title);
    const sheetTour = currentTourByKey.get(key);
    const parsedTour = setlistStats.byKey.get(key);
    const tourCount = sheetTour ? sheetTour.total : parsedTour?.count || 0;
    const effectiveLastIso = maxIso([parseDateKey(row.last), parseDateKey(sheetTour?.last), parsedTour?.lastIso]);
    const lastDisplay = effectiveLastIso ? isoToShortDate(effectiveLastIso) : row.last;
    const playedThisTour = tourCount > 0;
    const stripeIndex = lastFourDates.indexOf(effectiveLastIso);
    const effectiveSlp = playedThisTour
      ? showsSinceLastPlayed(setlists, parsedTour?.lastIso || parseDateKey(sheetTour?.last))
      : row.slp + postedShowCount;

    return {
      ...row,
      key,
      tourCount,
      playedThisTour,
      effectiveSlp,
      effectiveLastIso,
      lastDisplay,
      stripeAsset: stripeIndex >= 0 ? config.stripeAssets[stripeIndex] : "",
      isAddOn: false
    };
  });

  const originals = songs.filter((row) => row.type === "Original");
  const covers = songs.filter((row) => row.type === "Cover");
  const postedDates = new Set(setlists.map((show) => show.isoDate));

  return {
    generatedAt: new Date().toISOString(),
    source: {
      label: source.label,
      sheetId,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`,
      setlistUrl: source.setlists.sourceUrl || ""
    },
    site: {
      name: "Burnthday",
      title: `Widespread Panic ${latestYear} Tour`,
      year: latestYear,
      deck: "The Widespread Panic Spread Sheet",
      latestShow: setlists[0] || null
    },
    rules: {
      rotationSlpLimit: config.rotationSlpLimit,
      purgatory: "Songs with one lifetime play stay in Purgatory. If played this tour, they stay marked black until the next tour reset.",
      shelf: "Shelf songs that return this tour stay marked black until the next tour reset."
    },
    totals: {
      catalogSongs: songs.length,
      currentTourSongs: songs.filter((row) => row.playedThisTour).length,
      currentTourPlays: sum(songs.map((row) => row.tourCount)),
      originals: originals.length,
      covers: covers.length,
      postedSetlists: setlists.length,
      tourDates: tourDates.length
    },
    boards: buildBoards(songs),
    tourDates: tourDates.map((date) => ({ ...date, isPosted: postedDates.has(date.isoDate) })),
    setlists,
    archive: {
      totalEntries: archiveEntries.length,
      reviewEntries: archiveEntries.filter((entry) => entry.isReview).length,
      latestEntries: archiveEntries.slice(0, 12).map(archiveSummary),
      latestReviews: archiveEntries.filter((entry) => entry.isReview).slice(0, 12).map(archiveSummary)
    },
    currentTour: songs.filter((row) => row.playedThisTour).sort((a, b) => b.tourCount - a.tourCount || byTitle(a, b)),
    catalog: songs
  };
}

function archiveSummary(entry) {
  return {
    title: entry.title,
    path: entry.path,
    published: entry.published,
    categories: entry.categories
  };
}

function buildBoards(songs) {
  const addOnOriginals = new Set(config.addOnOriginals);
  const addOnCovers = new Set(config.addOnCovers);
  const active = songs.filter((row) => row.effectiveSlp < config.rotationSlpLimit || row.playedThisTour);

  const rotationOriginals = withAddOns(
    active.filter((row) => row.type === "Original" && !addOnOriginals.has(row.title.toUpperCase())).sort(byTitle),
    songs,
    config.addOnOriginals
  );
  const rotationCovers = withAddOns(
    active.filter((row) => row.type === "Cover" && !addOnCovers.has(row.title.toUpperCase())).sort(byTitle),
    songs,
    config.addOnCovers
  );

  const shelfRows = songs.filter((row) => row.total > 1 && row.effectiveSlp >= config.rotationSlpLimit).sort((a, b) => b.effectiveSlp - a.effectiveSlp || byTitle(a, b));
  const purgatoryRows = songs.filter((row) => row.total === 1).sort(byTitle);

  return {
    rotationOriginals,
    rotationCovers,
    shelfOriginals: shelfRows.filter((row) => row.type === "Original"),
    shelfCovers: shelfRows.filter((row) => row.type === "Cover"),
    purgatoryOriginals: purgatoryRows.filter((row) => row.type === "Original"),
    purgatoryCovers: purgatoryRows.filter((row) => row.type === "Cover")
  };
}

function withSetlistOnlySongs(catalog, setlistStats, currentTour) {
  const knownKeys = new Set([...catalog, ...currentTour].map((row) => normalizeTitle(row.title)));
  const additions = [];

  for (const [key, stat] of setlistStats.byKey) {
    if (knownKeys.has(key) || !isPublicSongTitle(stat.title) || !stat.count) continue;

    additions.push({
      title: stat.title,
      first: isoToShortDate(stat.firstIso || stat.lastIso),
      last: isoToShortDate(stat.lastIso),
      total: stat.count,
      l100: stat.count,
      slp: 0,
      type: "Cover",
      isSetlistOnly: true
    });
    knownKeys.add(key);
  }

  return [...catalog, ...additions.sort(byTitle)];
}

function withAddOns(rows, allSongs, names) {
  const byKey = new Map(allSongs.map((row) => [row.title.toUpperCase(), row]));
  const addOns = names.map((name) => ({
    ...(byKey.get(name) || {
      title: titleCase(name),
      type: "",
      total: 0,
      slp: 0,
      effectiveSlp: 0,
      tourCount: 0,
      playedThisTour: false,
      lastDisplay: config.addOnDates[name] || ""
    }),
    isAddOn: true,
    addOnDate: config.addOnDates[name] || byKey.get(name)?.lastDisplay || ""
  }));
  return [...rows, ...addOns];
}

function analyzeSetlists(setlists, catalog, currentTour) {
  const known = new Map();
  for (const song of [...catalog, ...currentTour]) {
    const key = normalizeTitle(song.title);
    if (key && !known.has(key)) known.set(key, { key, title: song.title });
  }

  const byKey = new Map();
  for (const show of setlists) {
    for (const set of show.sets || []) {
      for (const song of splitSetSongs(set.songTitles || set.songs, known)) {
        const current = byKey.get(song.key) || { count: 0, firstIso: "", lastIso: "", title: song.title };
        current.count += 1;
        current.firstIso = minIso([current.firstIso, show.isoDate]);
        current.lastIso = maxIso([current.lastIso, show.isoDate]);
        byKey.set(song.key, current);
      }
    }
  }

  return { byKey };
}

function splitSetSongs(value, known) {
  const pieces = (Array.isArray(value) ? value : stripStageMarks(value).split(/\s*>\s*|\s*,\s*/))
    .map(stripStageMarks)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const found = [];

  for (let index = 0; index < pieces.length; ) {
    let match = null;
    let span = 0;

    for (let width = Math.min(4, pieces.length - index); width >= 1; width -= 1) {
      const candidate = pieces.slice(index, index + width).join(", ");
      const key = normalizeTitle(candidate);
      if (known.has(key)) {
        match = known.get(key);
        span = width;
        break;
      }
    }

    if (match) {
      found.push(match);
      index += span;
      continue;
    }

    const title = pieces[index];
    const key = normalizeTitle(title);
    if (key && !isIgnoredSetlistTitle(title)) found.push({ key, title });
    index += 1;
  }

  return found;
}

function stripStageMarks(value) {
  return String(value || "")
    .replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isIgnoredSetlistTitle(title) {
  return normalizeTitle(title) === "jam";
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

function csvToObjects(csv) {
  return rowsToObjects(parseCsv(csv));
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

  await copyDirectory(path.join(root, "assets"), path.join(dist, "assets"));
}

async function copyDirectory(sourceDir, targetDir) {
  let entries = [];
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch {
    return;
  }

  await mkdir(targetDir, { recursive: true });
  await Promise.all(entries.map(async (entry) => {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(source, target);
    } else if (entry.isFile()) {
      await copyFile(source, target);
    }
  }));
}

async function writeBloggerArchive(entries) {
  if (!entries.length) return;

  await Promise.all(entries.map((entry) => writeStaticPage(entry.path, renderArchivePage(entry))));
  await writeStaticPage("/archive/index.html", renderArchiveIndex(entries));
  await writeStaticPage("/pages/index.html", renderPagesIndex(entries.filter((entry) => entry.path.startsWith("/p/"))));
  await writeStaticPage("/tour-in-review/index.html", renderTourReviewIndex(entries.filter((entry) => entry.isReview)));
}

async function writeStaticPage(pagePath, html) {
  const relative = pagePath.replace(/^\/+/, "");
  const target = path.join(dist, relative);
  if (!target.startsWith(dist)) throw new Error(`Refusing to write outside dist: ${pagePath}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, html, "utf8");
}

function renderArchivePage(entry) {
  const title = `${entry.title} | Burnthday`;
  const description = entry.metaDescription || stripTags(entry.content).replace(/\s+/g, " ").trim().slice(0, 180);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main">
      <article class="archive-page">
        <header class="archive-title">
          <p>${escapeHtml(formatArchiveDate(entry.published))}</p>
          <h1>${escapeHtml(entry.title)}</h1>
          ${entry.categories.length ? `<div class="archive-tags">${entry.categories.map((category) => `<span>${escapeHtml(category)}</span>`).join("")}</div>` : ""}
        </header>
        <div class="archive-content">
          ${entry.content}
        </div>
      </article>
    </main>
    ${renderSiteFooter({ generatedAt: new Date().toISOString(), source: { label: "Blogger Takeout" } })}
  </body>
</html>
`;
}

function renderArchiveIndex(entries) {
  return renderArchiveListPage({
    title: "Burnthday Archive",
    deck: `${entries.length} preserved Blogger posts and pages from the Takeout export.`,
    entries
  });
}

function renderPagesIndex(entries) {
  return renderArchiveListPage({
    title: "Burnthday Pages",
    deck: `${entries.length} preserved Blogger pages from the Takeout export, including About, Song Origins, lyrics, downloads, and old live stream pages.`,
    entries: entries.sort((a, b) => a.title.localeCompare(b.title))
  });
}

function renderTourReviewIndex(entries) {
  return renderArchiveListPage({
    title: "Tour In Review",
    deck: `${entries.length} preserved Tour In Review pages and related review posts.`,
    entries
  });
}

function renderArchiveListPage({ title, deck, entries }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} | Burnthday</title>
    <meta name="description" content="${escapeAttr(deck)}">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main">
      <section class="archive-index">
        <header class="archive-title">
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(deck)}</p>
        </header>
        <ol class="archive-list">
          ${entries.map((entry) => `<li>
            <a href="${escapeAttr(publicPath(entry.path))}">${escapeHtml(entry.title)}</a>
            <span>${escapeHtml(formatArchiveDate(entry.published))}</span>
            ${entry.categories.length ? `<em>${escapeHtml(entry.categories.join(" / "))}</em>` : ""}
          </li>`).join("")}
        </ol>
      </section>
    </main>
    ${renderSiteFooter({ generatedAt: new Date().toISOString(), source: { label: "Blogger Takeout" } })}
  </body>
</html>
`;
}

function renderHtml(data) {
  const description = `Burnthday's Widespread Panic song list, ${data.site.year} tour setlists, shelf, and purgatory.`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(data.site.title)} by Burnthday</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta property="og:title" content="${escapeHtml(data.site.title)} by Burnthday">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://burnthday.com/">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}

    <main>
      ${renderLatestSetlist(data)}
      ${renderRotationBoard(data)}
      ${renderShelfBoard(data)}
      ${renderSetlists(data, { skipLatest: true })}
      ${renderTourDates(data)}
      ${renderCommunityLinks()}
      ${renderArchiveTeaser(data)}
    </main>

    ${renderSiteFooter(data)}

    <script>
      if (window.matchMedia("(max-width: 700px)").matches) {
        document.querySelectorAll(".primary-board .song-panel:not(:first-of-type), .shelf-board .song-panel, .purgatory-board .song-panel").forEach((panel) => panel.removeAttribute("open"));
      }
    </script>
  </body>
</html>
`;
}

function renderSiteHeader() {
  return `<header class="site-head">
  <a class="brand" href="/" aria-label="Burnthday">
    <img class="brand-logo" src="/assets/burnthday-logo.png" alt="Burnthday">
  </a>
  <nav class="jump-links" aria-label="Sections">
    <a href="/#latest-setlist">Latest Setlist</a>
    <a href="/#song-list">Song List</a>
    <a href="/#shelf">Shelf</a>
    <a href="/#purgatory">Purgatory</a>
    <a href="/#setlists">Setlists</a>
    <a href="/#tour-dates">Tour Dates</a>
    <a href="/tour-in-review/">Tour In Review</a>
    <a href="/p/widespread-panic-song-origins-and">Song Origins</a>
    <a href="/p/about">About</a>
    <a href="/pages/">Pages</a>
    <a href="/archive/">Archive</a>
  </nav>
</header>`;
}

function renderSiteFooter(data) {
  return `<footer class="site-foot">
  <span>Burnthday - unaffiliated with Widespread Panic.</span>
  <span>${escapeHtml(sourceLabel(data))}</span>
</footer>`;
}

function renderRotationBoard(data) {
  const latest = data.site.latestShow;
  return `<section class="laminate primary-board" id="song-list">
  ${renderPrimaryBoardHeader(data)}
  <nav class="sheet-jump" aria-label="Song list shortcuts">
    <a href="#rotation-originals">Originals</a>
    <a href="#rotation-covers">Covers</a>
    <a href="#shelf">Shelf</a>
    <a href="#purgatory">Purgatory</a>
    <a href="#setlists">Setlists</a>
    <a href="#tour-dates">Tour Dates</a>
  </nav>
  ${renderSongPanel("rotation-originals", "ORIGINALS", data.boards.rotationOriginals)}
  ${renderSongPanel("rotation-covers", "COVERS", data.boards.rotationCovers)}
  <div class="board-ledger" aria-label="Tour stats">
    ${renderStat(data.totals.currentTourSongs, "songs played")}
    ${renderStat(data.totals.currentTourPlays, "tour plays")}
    ${renderStat(data.totals.postedSetlists, "setlists posted")}
    ${renderStat(data.totals.tourDates, "tour dates")}
  </div>
</section>`;
}

function renderShelfBoard(data) {
  return `<section class="laminate shelf-board" id="shelf">
  ${renderBoardHeader("THE SHELF")}
  ${renderSongPanel("shelf-originals", "ORIGINALS", data.boards.shelfOriginals, { shelfMode: true, columns: 3 })}
  ${renderSongPanel("shelf-covers", "COVERS", data.boards.shelfCovers, { shelfMode: true, columns: 3 })}
</section>
<section class="laminate purgatory-board" id="purgatory">
  ${renderBoardHeader("PURGATORY")}
  ${renderSongPanel("purgatory-originals", "ORIGINALS", data.boards.purgatoryOriginals, { shelfMode: true, columns: 3 })}
  ${renderSongPanel("purgatory-covers", "COVERS", data.boards.purgatoryCovers, { shelfMode: true, columns: 3 })}
</section>`;
}

function renderBoardHeader(title, subtitle = "") {
  return `<div class="header-row">
    <div class="nums left">
      <img alt="1" class="marker-num" src="/assets/marker-1.png">
      <img alt="2" class="marker-num" src="/assets/marker-2.png">
    </div>
    <div class="board-title">
      <h1>${escapeHtml(title)}</h1>
      ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
    </div>
    <div class="nums right">
      <img alt="3" class="marker-num" src="/assets/marker-3.png">
      <img alt="4" class="marker-num" src="/assets/marker-4.png">
    </div>
  </div>`;
}

function renderPrimaryBoardHeader(data) {
  const latest = data.site.latestShow;
  const title = latest?.location || data.site.title;

  return `<div class="header-row primary-header">
    <div class="nums left">
      <img alt="1" class="marker-num" src="/assets/marker-1.png">
      <img alt="2" class="marker-num" src="/assets/marker-2.png">
    </div>
    <div class="board-title">
      <h1>${escapeHtml(`${title.toUpperCase()} I`)}</h1>
    </div>
    <div class="nums right">
      <img alt="3" class="marker-num" src="/assets/marker-3.png">
      <img alt="4" class="marker-num" src="/assets/marker-4.png">
    </div>
  </div>`;
}

function renderSongGrid(rows, options = {}) {
  const columnCount = options.columns || 4;
  const columns = splitStrict(rows, columnCount);
  return `<div class="songs grid${columnCount}">
    ${columns.map((column, index) => `<div class="col">${column.map((row) => renderSong(row, options)).join("")}${rows.length % columnCount === 0 && index < columnCount - 1 ? '<span class="rotation-song spacer">&nbsp;</span>' : ""}</div>`).join("")}
  </div>`;
}

function renderSongPanel(id, label, rows, options = {}) {
  return `<details class="song-panel" id="${escapeAttr(id)}" open>
    <summary><span>${escapeHtml(label)}</span><em>${rows.length}</em></summary>
    ${renderSongGrid(rows, options)}
  </details>`;
}

function renderSong(row, options = {}) {
  const stripeAsset = options.shelfMode && row.playedThisTour ? "marker-black.png" : row.stripeAsset;
  const dateText = options.shelfMode || row.isAddOn ? row.addOnDate || row.lastDisplay : "";
  const handClass = row.isAddOn ? " hand-addon" : "";
  const marker = stripeAsset ? `<span class="marker-mask"><img class="marker-img" src="/assets/${escapeAttr(stripeAsset)}" alt=""></span>` : "";
  const countValue = options.shelfMode ? row.total : row.tourCount;
  const count = countValue > 0 ? `<sup>${countValue}</sup>` : "";
  const date = dateText ? `<span class="date-sup">${escapeHtml(dateText)}</span>` : "";

  return `<span class="rotation-song"><span class="marker-wrap"><span class="marker-text${handClass}">${escapeHtml(row.title.toUpperCase())}</span>${marker}${count}${date}</span></span>`;
}

function renderLatestSetlist(data) {
  const latest = data.setlists[0];
  if (!latest) return "";

  return `<section class="latest-setlist" id="latest-setlist">
  <div class="section-heading">
    <h2>LATEST SETLIST</h2>
    <span>${escapeHtml(latest.date)} ${escapeHtml(latest.location)}</span>
  </div>
  ${renderFeaturedSetlist(latest)}
</section>`;
}

function renderSetlists(data, options = {}) {
  const setlists = options.skipLatest ? data.setlists.slice(1) : data.setlists;
  const postedLabel = options.skipLatest ? `${setlists.length} older posted` : `${data.totals.postedSetlists} posted`;
  return `<section class="setlist-section" id="setlists">
  <div class="section-heading">
    <h2>${escapeHtml(String(data.site.year))} SETLISTS</h2>
    <span>${escapeHtml(postedLabel)}</span>
  </div>
  <div class="setlist-grid">
    ${setlists.map(renderSetlistCard).join("")}
  </div>
</section>`;
}

function renderFeaturedSetlist(show) {
  return `<article class="setlist-feature">
    ${renderSetlistImage(show)}
    <div class="setlist-copy">
      ${renderSetlistText(show)}
    </div>
  </article>`;
}

function renderSetlistCard(show) {
  return `<article class="setlist-card">
    ${renderSetlistImage(show)}
    ${renderSetlistText(show)}
  </article>`;
}

function renderSetlistImage(show) {
  if (!show.image) return "";
  return `<figure class="setlist-image"><img src="${escapeAttr(show.image)}" alt="${escapeAttr(`${show.date} ${show.location}`)}"></figure>`;
}

function renderSetlistText(show) {
  return `<div class="setlist-text">
    <h3>${escapeHtml(show.date)} ${escapeHtml(show.location)}</h3>
    <p class="venue">${escapeHtml(show.venue)}</p>
    ${(show.sets || []).map((set) => `<p><strong>${escapeHtml(set.label)}:</strong> ${escapeHtml(set.songs)}</p>`).join("")}
    ${show.notes?.length ? `<ul class="notes">${show.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}
    ${(show.sourceUrl || show.streamUrl) ? `<p class="setlist-links">${show.sourceUrl ? `<a href="${escapeAttr(show.sourceUrl)}">Official Page</a>` : ""}${show.streamUrl ? `<a href="${escapeAttr(show.streamUrl)}">Stream</a>` : ""}</p>` : ""}
  </div>`;
}

function renderTourDates(data) {
  return `<section class="tour-date-section" id="tour-dates">
  <div class="section-heading">
    <h2>${escapeHtml(String(data.site.year))} TOUR DATES</h2>
    <span>${data.totals.tourDates} listed</span>
  </div>
  <ol class="tour-dates">
    ${data.tourDates.map((date) => `<li class="${date.isPosted ? "is-posted" : ""}"><span>${escapeHtml(date.date)}</span><strong>${escapeHtml(date.location)}</strong><em>${escapeHtml(date.venue)}</em></li>`).join("")}
  </ol>
</section>`;
}

function renderCommunityLinks() {
  return `<section class="community-links" aria-label="Community links">
  <a class="posse-link" href="https://www.facebook.com/HerringPosse">
    <img src="/assets/PosseFacebookBanner.png" alt="Jimmy Herring Has a Posse">
  </a>
  <span>Jimmy Herring Has a Posse</span>
</section>`;
}

function renderArchiveTeaser(data) {
  if (!data.archive?.totalEntries) return "";
  return `<section class="archive-teaser">
  <div class="section-heading">
    <h2>BURNTHDAY ARCHIVE</h2>
    <span>${data.archive.totalEntries} pages restored</span>
  </div>
  <div class="archive-teaser-grid">
    <div>
      <h3>Tour In Review</h3>
      <p>${data.archive.reviewEntries} preserved review pages and review-related posts from Blogger.</p>
      <a href="/tour-in-review/">Open Tour In Review</a>
    </div>
    <div>
      <h3>Full Archive</h3>
      <p>All Blogger entries from the Takeout export are available at their original paths.</p>
      <a href="/archive/">Open Archive</a>
    </div>
  </div>
</section>`;
}

function renderStat(value, label) {
  return `<div class="stat"><strong>${formatNumber(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderCss() {
  return `@font-face {
  font-family: "PanicHand";
  src: url("/assets/Panic-Hand.woff2") format("woff2");
  font-display: swap;
}

@font-face {
  font-family: "MilkRun";
  src: url("/assets/milkrun.woff2") format("woff2");
  font-display: swap;
}

:root {
  color-scheme: light;
  --paper: #fffdfa;
  --ink: #111111;
  --muted: #5f5a55;
  --line: rgba(0, 0, 0, 0.12);
  --red: #d4514f;
  --green: #2d7c52;
  --blue: #286e9e;
  --cream: #f7f1e8;
}

* {
  box-sizing: border-box;
}

html {
  background: var(--paper);
  overflow-x: clip;
}

body {
  margin: 0;
  min-width: 320px;
  color: var(--ink);
  background: var(--paper);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  overflow-x: clip;
}

a {
  color: inherit;
}

.site-head {
  width: min(1880px, calc(100% - 56px));
  margin: 24px auto 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.brand {
  display: inline-flex;
  align-items: center;
}

.brand-logo {
  width: 176px;
  height: auto;
  display: block;
}

.jump-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 15px;
}

.jump-links a {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 10px;
  text-decoration: none;
  background: #ffffff;
}

main {
  width: min(1880px, calc(100% - 56px));
  margin: 34px auto 56px;
}

.laminate {
  border: 9px solid rgba(0, 0, 0, 0.045);
  border-radius: 6px;
  padding: 42px 34px 34px;
  margin: 0 auto 34px;
  background: #ffffff;
  font-family: "MilkRun", system-ui, sans-serif;
}

.header-row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(0, auto) minmax(120px, 1fr);
  align-items: center;
  gap: 24px;
  margin-bottom: 36px;
  min-width: 0;
}

.nums {
  display: flex;
  gap: 12px;
}

.nums.left {
  justify-self: start;
}

.nums.right {
  justify-self: end;
}

.marker-num {
  width: clamp(52px, 4.5vw, 86px);
  height: clamp(60px, 5.2vw, 96px);
  object-fit: contain;
  display: block;
}

.board-title {
  text-align: center;
  min-width: 0;
  max-width: 100%;
}

.board-title h1 {
  margin: 0;
  color: var(--red);
  font-family: "PanicHand", sans-serif;
  font-size: clamp(64px, 6.2vw, 118px);
  line-height: 0.95;
  font-weight: 400;
  letter-spacing: 0;
  white-space: nowrap;
  max-width: 100%;
}

.board-title p {
  margin: 4px 0 0;
  color: var(--muted);
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 14px;
  letter-spacing: 0;
}

.board-ledger {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 26px 0 0;
  border-top: 1px solid var(--line);
  padding: 12px 0 0;
}

.stat {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.stat strong {
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 34px;
  line-height: 1;
  font-weight: 400;
  color: var(--ink);
}

.stat span {
  color: var(--muted);
  font-size: 12px;
  text-transform: uppercase;
}

.sheet-jump {
  display: none;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 10px;
}

.sheet-jump a {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 10px;
  text-decoration: none;
  background: #ffffff;
}

.song-panel {
  margin: 0;
}

.song-panel summary {
  min-height: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 12px;
  cursor: pointer;
  font-size: 20px;
  font-weight: 700;
  text-decoration: underline;
  list-style: none;
}

.song-panel summary::-webkit-details-marker {
  display: none;
}

.song-panel summary::after {
  content: "+";
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  text-decoration: none;
  display: none;
}

.song-panel[open] summary::after {
  content: "-";
}

.song-panel summary em {
  margin-left: auto;
  color: var(--muted);
  font-style: normal;
  font-weight: 400;
  text-decoration: none;
  display: none;
}

.songs.grid4 {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  column-gap: clamp(46px, 7vw, 144px);
}

.songs.grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  column-gap: clamp(34px, 6vw, 116px);
}

.songs .col {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.rotation-song {
  display: block;
  min-height: 27px;
  margin: 0 0 6px;
  font-size: clamp(19px, 1.25vw, 27px);
  text-transform: uppercase;
  line-height: 1.02;
  overflow-wrap: break-word;
}

.marker-wrap {
  position: relative;
  display: inline-block;
  max-width: 100%;
  line-height: 1;
}

.marker-text {
  position: relative;
  z-index: 1;
}

.marker-mask {
  position: absolute;
  left: -0.24em;
  right: -0.16em;
  top: 58%;
  height: 0.58em;
  transform: translateY(-50%);
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}

.marker-img {
  display: block;
  width: auto;
  height: 100%;
  min-width: calc(100% + 0.4em);
  max-width: none;
  opacity: 0.9;
  mix-blend-mode: multiply;
}

sup {
  font-size: 0.55em;
  vertical-align: super;
  line-height: 0;
  margin-left: 2px;
}

.date-sup {
  margin-left: 7px;
}

.hand-addon {
  font-family: "PanicHand", sans-serif;
  font-size: 16px;
  letter-spacing: 0;
  line-height: 1;
}

.spacer {
  visibility: hidden;
}

.latest-setlist,
.setlist-section,
.tour-date-section {
  width: min(1180px, 100%);
  margin: 36px auto;
}

.latest-setlist {
  margin-top: 0;
}

.latest-setlist .setlist-feature {
  margin-bottom: 0;
  border-color: rgba(0, 0, 0, 0.28);
}

.community-links {
  width: min(1180px, 100%);
  margin: 28px auto 36px;
  text-align: center;
  font-family: "MilkRun", system-ui, sans-serif;
}

.posse-link {
  display: inline-block;
  text-decoration: none;
}

.posse-link img {
  display: block;
  width: min(212px, 70vw);
  height: auto;
  margin: 0 auto 5px;
}

.community-links span {
  display: block;
  font-size: 12px;
}

.section-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 4px solid var(--ink);
  padding-bottom: 8px;
  margin-bottom: 16px;
}

.section-heading h2 {
  margin: 0;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 30px;
  line-height: 1;
  font-weight: 400;
  color: var(--ink);
  letter-spacing: 0;
}

.section-heading span {
  color: var(--muted);
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 15px;
}

.setlist-feature {
  display: grid;
  grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.1fr);
  gap: 18px;
  align-items: start;
  margin-bottom: 18px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #ffffff;
  padding: 14px;
}

.setlist-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.setlist-card {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #ffffff;
  padding: 12px;
}

.setlist-image {
  margin: 0 0 12px;
  background: var(--cream);
  border: 1px solid var(--line);
  border-radius: 4px;
  overflow: hidden;
}

.setlist-feature .setlist-image {
  margin: 0;
}

.setlist-image img {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 2;
  object-fit: cover;
}

.setlist-text {
  min-width: 0;
}

.setlist-text h3 {
  margin: 0;
  font-family: inherit;
  font-size: 16px;
  line-height: 1.25;
  font-weight: 700;
  color: var(--ink);
  letter-spacing: 0;
}

.setlist-text .venue {
  margin: 3px 0 10px;
  color: var(--muted);
  font-family: "MilkRun", system-ui, sans-serif;
}

.setlist-text p {
  margin: 8px 0;
  line-height: 1.35;
}

.setlist-text strong {
  color: var(--ink);
}

.notes {
  margin: 10px 0 0;
  padding-left: 19px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.35;
}

.setlist-links {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.setlist-links a {
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.tour-dates {
  list-style: none;
  padding: 0;
  margin: 0;
  columns: 2;
  column-gap: 24px;
}

.tour-dates li {
  break-inside: avoid;
  display: grid;
  grid-template-columns: 76px 120px 1fr;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
}

.tour-dates li span {
  font-family: "MilkRun", system-ui, sans-serif;
}

.tour-dates li strong {
  font-weight: 700;
}

.tour-dates li em {
  color: var(--muted);
  font-style: normal;
}

.tour-dates li.is-posted span {
  color: var(--green);
}

.archive-teaser {
  width: min(1180px, 100%);
  margin: 36px auto;
}

.archive-teaser-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.archive-teaser-grid > div {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 14px;
}

.archive-teaser h3 {
  margin: 0 0 8px;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 22px;
}

.archive-teaser p {
  margin: 0 0 10px;
  color: var(--muted);
  line-height: 1.4;
}

.archive-teaser a,
.archive-list a {
  color: var(--ink);
  font-weight: 700;
}

.archive-main {
  width: min(1180px, calc(100% - 32px));
  margin: 28px auto 56px;
}

.archive-page,
.archive-index {
  background: #ffffff;
  border: 7px solid rgba(0, 0, 0, 0.045);
  border-radius: 6px;
  padding: clamp(16px, 3vw, 32px);
}

.archive-title {
  margin-bottom: 18px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 12px;
}

.archive-title h1 {
  margin: 0;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: clamp(28px, 4vw, 48px);
  line-height: 1;
  font-weight: 400;
}

.archive-title p {
  margin: 0 0 8px;
  color: var(--muted);
}

.archive-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.archive-tags span {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 8px;
  color: var(--muted);
  font-size: 12px;
}

.archive-content {
  overflow-wrap: break-word;
}

.archive-content img,
.archive-content iframe,
.archive-content embed,
.archive-content object {
  max-width: 100%;
}

.archive-content img {
  height: auto;
}

.archive-content table {
  max-width: 100%;
}

.archive-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.archive-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 96px;
  gap: 8px 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}

.archive-list span,
.archive-list em {
  color: var(--muted);
  font-style: normal;
  font-size: 13px;
}

.archive-list em {
  grid-column: 1 / -1;
}

.site-foot {
  width: min(1880px, calc(100% - 56px));
  margin: 0 auto 36px;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 13px;
  border-top: 1px solid var(--line);
  padding-top: 14px;
}

@media (max-width: 900px) {
  .site-head,
  .section-heading,
  .site-foot {
    align-items: flex-start;
    flex-direction: column;
  }

  .header-row {
    grid-template-columns: 1fr;
  }

  .jump-links {
    width: 100%;
    justify-content: flex-start;
  }

  .nums.left,
  .nums.right {
    justify-self: center;
  }

  .board-title h1 {
    font-size: 46px;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .songs.grid4 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .songs.grid3 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .board-ledger,
  .setlist-feature,
  .setlist-grid,
  .archive-teaser-grid {
    grid-template-columns: 1fr;
  }

  .tour-dates {
    columns: 1;
  }
}

@media (max-width: 560px) {
  main,
  .site-head,
  .site-foot {
    width: min(calc(100% - 20px), 1180px);
  }

  .brand-logo {
    width: 148px;
  }

  .jump-links {
    font-size: 14px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .jump-links a {
    min-width: 0;
    justify-content: center;
  }

  .laminate {
    padding: 13px 12px 18px;
  }

  .board-title h1,
  .section-heading h2 {
    font-size: 32px;
  }

  .board-ledger {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .sheet-jump {
    display: flex;
    position: sticky;
    top: 0;
    z-index: 5;
    margin: 0 -4px 8px;
    padding: 8px 4px;
    background: rgba(255, 255, 255, 0.94);
    border-bottom: 1px solid var(--line);
  }

  .sheet-jump a {
    flex: 1 1 42%;
    justify-content: center;
  }

  .song-panel {
    border-bottom: 1px solid var(--line);
  }

  .song-panel summary {
    min-height: 44px;
    margin: 4px 0;
  }

  .song-panel summary::after,
  .song-panel summary em {
    display: inline;
  }

  .songs.grid4 {
    grid-template-columns: 1fr;
  }

  .songs.grid3 {
    grid-template-columns: 1fr;
  }

  .tour-dates li {
    grid-template-columns: 72px 1fr;
  }

  .tour-dates li em {
    grid-column: 2;
  }

  .archive-list li {
    grid-template-columns: 1fr;
  }
}
`;
}

function renderHeaders() {
  return `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/data/*
  Cache-Control: public, max-age=300
`;
}

function renderRedirects(archiveEntries = []) {
  const lines = [
    "/2025/02/widespread-panic-2025-tour.html / 301",
    "/2025/02/widespread-panic-2025-tour / 301",
    "/search /archive/ 301",
    "/search/* /archive/ 301",
    "/feeds/posts/default /archive/ 301",
    "/feeds/posts/default/* /archive/ 301",
    "/p/:slug.html /p/:slug 301",
    "/:year/:month/:slug.html /:year/:month/:slug 301",
    "/archive/:year/:slug.html /archive/:year/:slug 301"
  ];

  const seen = new Set(lines);
  for (const entry of archiveEntries) {
    if (!entry.sourceUrl) continue;
    try {
      const url = new URL(entry.sourceUrl);
      if (!/(^|\.)burnthday\.(com|blogspot\.com)$/i.test(url.hostname)) continue;
      const sourcePath = clean(url.pathname);
      const targetPath = publicPath(entry.path);
      if (!sourcePath || sourcePath === targetPath) continue;
      const rule = `${sourcePath} ${targetPath} 301`;
      if (!seen.has(rule)) {
        lines.push(rule);
        seen.add(rule);
      }
    } catch {
      // Ignore malformed legacy source URLs.
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderSitemap(data, archiveEntries = []) {
  const updated = data.generatedAt.slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://burnthday.com/</loc>
    <lastmod>${updated}</lastmod>
  </url>
  <url>
    <loc>https://burnthday.com/archive/</loc>
    <lastmod>${updated}</lastmod>
  </url>
  <url>
    <loc>https://burnthday.com/tour-in-review/</loc>
    <lastmod>${updated}</lastmod>
  </url>
  <url>
    <loc>https://burnthday.com/pages/</loc>
    <lastmod>${updated}</lastmod>
  </url>
  ${archiveEntries.map((entry) => `<url>
    <loc>https://burnthday.com${escapeHtml(publicPath(entry.path))}</loc>
    <lastmod>${(entry.updated || entry.published || updated).slice(0, 10)}</lastmod>
  </url>`).join("\n  ")}
</urlset>
`;
}

function publicPath(pagePath) {
  return String(pagePath || "/").replace(/\/index\.html$/i, "/").replace(/\.html?$/i, "");
}

function splitStrict(items, count) {
  const perColumn = Math.ceil(items.length / count);
  return Array.from({ length: count }, (_, index) => items.slice(index * perColumn, (index + 1) * perColumn));
}

function newestUniqueDates(setlists, catalog, currentTour) {
  const dates = new Set();
  for (const show of setlists) if (show.isoDate) dates.add(show.isoDate);
  for (const row of currentTour) {
    const parsed = parseDateKey(row.last);
    if (parsed) dates.add(parsed);
  }
  for (const row of catalog) {
    const parsed = parseDateKey(row.last);
    if (parsed) dates.add(parsed);
  }
  return [...dates].sort().reverse().slice(0, 4);
}

function showsSinceLastPlayed(setlists, lastIso) {
  if (!lastIso) return 0;
  return setlists.filter((show) => show.isoDate && show.isoDate > lastIso).length;
}

function parseDateKey(value) {
  const raw = clean(value);
  if (!raw || raw.startsWith("?")) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

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
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year.slice(2)}`;
}

function maxIso(values) {
  return values.filter(Boolean).sort().at(-1) || "";
}

function minIso(values) {
  return values.filter(Boolean).sort()[0] || "";
}

function inferSetlistYear(payload) {
  const setlists = payload?.setlists || [];
  const dates = [...setlists, ...(payload?.tourDates || [])]
    .map((show) => Number(String(show.isoDate || "").slice(0, 4)))
    .filter(Number.isFinite);
  return Math.max(0, ...dates);
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

function rowBelongsToYear(row, year) {
  return [row.first, row.last]
    .map(parseDateKey)
    .some((date) => Number(date.slice(0, 4)) === Number(year));
}

function normalizeTitle(title) {
  const normalized = clean(title)
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
    nobodysfault: "nobodysfaultbutmine"
  };
  return aliases[normalized] || normalized;
}

function titleCase(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
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

function sourceLabel(data) {
  return `Built ${new Date(data.generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} from ${data.source.label}.`;
}

function formatArchiveDate(value) {
  if (!value) return "Undated";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
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
  return escapeHtml(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
