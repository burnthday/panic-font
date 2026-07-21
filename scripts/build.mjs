import crypto from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const sheetId = process.env.GOOGLE_SHEET_ID || "1EAJINzjyHFauVqHYLSYpmoJpNARg61ghCGDfOlb-D9s";
const bloggerFeedPath = process.env.BLOGGER_TAKEOUT_FEED || path.join(root, "data", "source", "blogger-feed.atom");
const analyticsMeasurementId = "G-R74CMVLLK1";
let archiveMediaByName = new Map();

const sheetRanges = {
  catalog: "'Overall Song Stats Sorted By Last Time Played'!A:H",
  currentTour: "'Current Tour Song Stats Sorted By Since Last Played'!A:H"
};

const config = {
  rotationSlpLimit: 200,
  shelfWatchWindow: 50,
  shelfWatchLimit: 6,
  typeOverrides: {
    "ASTRONOMY DOMINE JAM": "Cover",
    "BLACK HOLE SUN": "Cover",
    "BLACK-EYED PEAS JAM": "Cover",
    "BIG CHIEF JAM": "Cover",
    "CLAIR DE LUNE": "Cover",
    "DOWN IN A HOLE": "Cover",
    "DRAGONAUT JAM": "Cover",
    "JACK STRAW": "Cover",
    "JOHN'S OTHER JAM": "Cover",
    "LITTLE LILLY JAM": "Original",
    "PLAY A TRAIN SONG": "Cover",
    "SET THE CONTROLS FOR THE HEART OF THE SUN JAM": "Cover",
    "SPACE IS THE PLACE JAM": "Cover",
    "THE OTHER ONE JAM": "Cover",
    "TIME IS FREE JAM": "Cover",
    "TIME WAITS JAM": "Original",
    "TRACTOR JAM": "Original",
    "WAR PIGS": "Cover",
    "WE'RE ALL MAD HERE": "Cover",
    "WHITE RABBIT": "Cover",
    "WHO ARE YOU": "Cover",
    "YOU'RE LOST LITTLE GIRL": "Cover"
  },
  stripeAssets: ["marker-black.png", "marker-green.png", "marker-blue.png", "marker-red.png"]
};

const primaryNavItems = [
  ["Home", "/"],
  ["Rumors", "/rumors/"],
  ["Lyrics & Chords", "/lyrics-chords/"],
  ["Song Origins", "/song-origins/"],
  ["Tour In Review", "/tour-in-review/"],
  ["The Shelf", "/shelf/"],
  ["About", "/about/"]
];

const footerNavItems = [
  ["Song List", "/"],
  ["The Shelf", "/shelf/"],
  ["Tour In Review", "/tour-in-review/"],
  ["Song Origins", "/song-origins/"],
  ["Lyrics & Chords", "/lyrics-chords/"],
  ["Rumors", "/rumors/"],
  ["About", "/about/"],
  ["Privacy", "/privacy/"]
];

const legacyCoreRoutes = new Map([
  ["/p/rumors", "/rumors/"],
  ["/p/widespread-panic-dirty-side-down-lyrics", "/lyrics-chords/"],
  ["/p/widespread-panic-song-origins-and", "/song-origins/"],
  ["/p/burnthdays-widespread-panic-tours-in", "/tour-in-review/"],
  ["/p/theshelf", "/shelf/"],
  ["/p/about", "/about/"],
  ["/p/privacy", "/privacy/"]
]);

async function main() {
  const [source, archiveEntries, songOrigins] = await Promise.all([loadSourceData(), loadBloggerArchive(), loadSongOrigins()]);
  const siteData = buildSiteData(source, archiveEntries, songOrigins);
  warnForClassificationGaps(siteData);

  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await mkdir(path.join(dist, "data"), { recursive: true });

  await copyAssets();
  await writeBloggerArchive(archiveEntries, siteData);
  await writeModernArchivePages(archiveEntries, siteData);
  await writeSongOrigins(songOrigins);
  await writeShelfInfoPage(siteData, archiveEntries);
  await writeRumorsPage(siteData, archiveEntries);
  await writePrivacyPage(siteData);
  const generatedTourReviews = await writeGeneratedTourReviewPages(siteData);
  await writeTourReviewHub(siteData, archiveEntries, generatedTourReviews);
  await writeFile(path.join(dist, "index.html"), finalizeHtml(renderHtml(siteData)), "utf8");
  await writeStaticPage("/404.html", renderNotFoundPage(siteData));
  await writeFile(path.join(dist, "styles.css"), renderCss(), "utf8");
  await writeFile(path.join(dist, "stagelight.css"), renderStagelightCss(), "utf8");
  await writeFile(path.join(dist, "data", "site-data.json"), JSON.stringify(siteData, null, 2), "utf8");
  await writeFile(path.join(dist, "data", "freshness.json"), JSON.stringify(buildFreshnessReport(siteData, archiveEntries, songOrigins, generatedTourReviews), null, 2), "utf8");
  await writeFile(path.join(dist, "_headers"), renderHeaders(), "utf8");
  await writeFile(path.join(dist, "_redirects"), renderRedirects(archiveEntries, generatedTourReviews), "utf8");
  await writeFile(path.join(dist, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://burnthday.com/sitemap.xml\n", "utf8");
  await writeFile(path.join(dist, "sitemap.xml"), renderSitemap(siteData, archiveEntries, songOrigins, generatedTourReviews), "utf8");

  console.log(`Built ${siteData.site.title}: ${siteData.boards.rotationOriginals.length} originals, ${siteData.boards.rotationCovers.length} covers, ${siteData.setlists.length} setlists, ${archiveEntries.length} archive pages, ${songOrigins.length} song origins.`);
}

function warnForClassificationGaps(siteData) {
  const rows = siteData.boards?.needsClassification || [];
  if (!rows.length) return;

  const sample = rows.slice(0, 12).map((row) => row.title).join(", ");
  const suffix = rows.length > 12 ? `, +${rows.length - 12} more` : "";
  console.warn(`Needs original/cover classification (${rows.length}): ${sample}${suffix}`);
}

async function loadSourceData() {
  const setlists = await loadSetlists();
  const [spreadsheet, playstats, priorSongStats, venuePreviews] = await Promise.all([
    loadSpreadsheetData(inferSetlistYear(setlists)),
    loadPlaystats(),
    loadPriorSongStats(),
    loadVenuePreviews()
  ]);
  return { ...spreadsheet, setlists, playstats, priorSongStats, venuePreviews };
}

async function loadVenuePreviews() {
  try {
    return JSON.parse(await readFile(path.join(root, "data", "source", "venue-previews.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
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
  for (const collection of [payload.setlists, payload.tourDates]) {
    for (const show of collection || []) {
      const file = byDate.get(show.isoDate);
      if (file) show.image = `/assets/setlists/${tourYear}/${file}`;
    }
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
  const prepared = entries
    .filter((entry) => entry.type !== "COMMENT")
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
    .filter((entry) => entry.path !== "/p/widespread-panic-song-origins-and.html");
  const titleCounts = new Map();
  for (const entry of prepared) {
    const key = clean(entry.title).toLowerCase();
    titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
  }
  return prepared
    .map((entry) => ({
      ...entry,
      hasDuplicateTitle: (titleCounts.get(clean(entry.title).toLowerCase()) || 0) > 1
    }))
    .sort((a, b) => (b.published || "").localeCompare(a.published || ""));
}

async function loadPlaystats() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "everyday-companion-playstats.json"), "utf8");
    const payload = JSON.parse(raw);
    return {
      source: payload.source || "Everyday Companion",
      sourceUrl: payload.sourceUrl || "",
      importedAt: payload.importedAt || "",
      rows: payload.rows || []
    };
  } catch {
    return { source: "", sourceUrl: "", importedAt: "", rows: [] };
  }
}

async function loadPriorSongStats() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "everyday-companion-prior-song-stats.json"), "utf8");
    const payload = JSON.parse(raw);
    const rows = payload.rows || [];
    const bridgeRows = rows.filter((row) => row.sourceStatus === "ec-lag-verified-local-bridge").length;
    const unverifiedLagRows = rows.filter((row) => row.sourceStatus && row.sourceStatus !== "ec-lag-verified-local-bridge").length;
    return {
      source: payload.source || "Everyday Companion Song Stats",
      sourceUrl: payload.sourceUrl || "",
      importedAt: payload.importedAt || "",
      tourYear: payload.tourYear || "",
      allowEcLag: Boolean(payload.allowEcLag),
      missing: payload.missing || [],
      rows,
      bridgeRows,
      unverifiedLagRows
    };
  } catch {
    return { source: "", sourceUrl: "", importedAt: "", rows: [] };
  }
}

async function loadSongOrigins() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "song-origins.json"), "utf8");
    const payload = JSON.parse(raw);
    return (payload.origins || []).filter((origin) => origin.title && origin.slug);
  } catch {
    return [];
  }
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
  const type = decodeXml(stripTags(readXmlTag(xml, "blogger:type"))).trim().toUpperCase();
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
    type,
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
  return scrubBlockedExternalLinks(html)
    .replace(/\bJamais Vu\s*\(The World Has Changed\)/gi, "Jamais Vu")
    .replace(/https?:\/\/[^"'<>\s)]+/gi, (url) => localArchiveMediaUrl(url) || url)
    .replace(/https?:\/\/(?:www\.)?burnthday\.com/gi, "")
    .replace(/https?:\/\/burnthday\.blogspot\.com/gi, "")
    .replace(/https?:\/\/burnthday\.github\.io\/panic-font\/([^"'<>\s)]+)/gi, "/assets/$1")
    .replace(/\?m=1/g, "");
}

function scrubBlockedExternalLinks(html) {
  return scrubBlockedExternalText(stripBlockedExternalUrls(String(html || "")
    .replace(/<a\b([^>]*\bhref=(["'])(.*?)\2[^>]*)>([\s\S]*?)<\/a>/gi, (match, _attrs, _quote, href, label) => {
      return isBlockedExternalUrl(href) ? stripTags(label) : match;
    })));
}

function stripBlockedExternalUrls(value) {
  return String(value || "")
    .replace(/(?:https?:\/\/)?(?:www\.)?panicstream\.(?:com|net)\/[^\s"'<>),]+/gi, "")
    .replace(/https?:\/\/[^\s"'<>),]+/gi, (url) => {
      return isBlockedExternalUrl(url) ? "" : url;
    });
}

function scrubBlockedExternalText(value) {
  return String(value || "").replace(/\b@?PanicStream(?:\.(?:com|net))?\b/gi, "");
}

function isBlockedExternalUrl(url) {
  const value = decodeXml(String(url || ""));
  const decoded = safeDecodeURIComponent(value);
  return /panicstream(?:\.(?:com|net))?/i.test(value) || /panicstream(?:\.(?:com|net))?/i.test(decoded);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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

function buildSiteData(source, archiveEntries = [], songOrigins = []) {
  const rawPlaystats = (source.playstats?.rows || []).map(normalizePlaystatRow).filter((row) => isPublicSongTitle(row.title));
  const playstatsByKey = new Map(rawPlaystats.map((row) => [normalizeTitle(row.title), row]));
  const priorSongStatsByKey = new Map(
    (source.priorSongStats?.rows || [])
      .map(normalizePriorSongStatRow)
      .filter((row) => isPublicSongTitle(row.title))
      .map((row) => [normalizeTitle(row.title), row])
  );
  const hasPlaystats = rawPlaystats.length > 0;
  const hasPriorSongStats = priorSongStatsByKey.size > 0;
  const baseCatalog = source.catalog
    .map(normalizeCatalogRow)
    .filter((row) => isPublicSongTitle(row.title))
    .map((row) => mergePlaystats(row, playstatsByKey.get(normalizeTitle(row.title))));
  const rawCurrentTour = source.currentTour.map(normalizeCurrentTourRow).filter((row) => isPublicSongTitle(row.title));
  let setlists = [...(source.setlists.setlists || [])].sort((a, b) => b.isoDate.localeCompare(a.isoDate));
  const tourDates = [...(source.setlists.tourDates || [])].sort((a, b) => a.isoDate.localeCompare(b.isoDate));
  const setlistYear = inferSetlistYear(source.setlists);
  const latestYear = setlistYear || inferLatestYear(rawCurrentTour) || inferLatestYear(baseCatalog) || new Date().getFullYear();
  const currentTour = setlistYear ? rawCurrentTour.filter((row) => rowBelongsToYear(row, setlistYear)) : rawCurrentTour;
  const setlistStats = analyzeSetlists(setlists, baseCatalog, currentTour);
  const nickSetlistStats = analyzeSetlists(setlists.filter(isNickJohnsonShow), baseCatalog, currentTour);
  const catalog = withPlaystatsOnlySongs(withSetlistOnlySongs(baseCatalog, setlistStats, currentTour, playstatsByKey), rawPlaystats);
  const currentTourByKey = new Map(currentTour.map((row) => [normalizeTitle(row.title), row]));
  const lastFourDates = newestUniqueDates(setlists, catalog, currentTour);
  const postedShowCount = setlists.length;
  const playstatsAsOfIso = maxIso(rawPlaystats.map((row) => parseDateKey(row.last)));
  const showsAfterPlaystats = setlists.filter((show) => show.isoDate > playstatsAsOfIso).length;
  const boardShow = pickBoardShow(tourDates, setlists);
  let latestShow = setlists[0] || null;
  const todayIso = currentDateIso("America/Los_Angeles");
  const previewStartIso = boardShow?.isoDate ? shiftIsoDate(boardShow.isoDate, -1) : "";
  const isShowDayPreview = Boolean(
    boardShow?.isoDate &&
    previewStartIso <= todayIso &&
    (!latestShow?.isoDate || boardShow.isoDate > latestShow.isoDate)
  );
  const latestRunDates = latestShow ? tourStopDates(tourDates, latestShow) : [];
  const previewMetadata = source.venuePreviews?.[venuePreviewKey(boardShow)] || {};
  const tourImages = setlists.map((show) => show.image).filter(Boolean);
  const previewFallbackImage = deterministicItem(tourImages, boardShow?.isoDate) || "";
  const previewImage = previewMetadata.firstVisit ? previewMetadata.image || previewFallbackImage : previewFallbackImage;
  let featuredShow = isShowDayPreview
    ? { ...boardShow, image: boardShow.image || previewImage, sets: blankSetlist(), notes: [] }
    : latestShow;

  const songs = catalog.map((row) => {
    const key = normalizeTitle(row.title);
    const sheetTour = currentTourByKey.get(key);
    const parsedTour = setlistStats.byKey.get(key);
    const parsedNick = nickSetlistStats.byKey.get(key);
    const priorSongStats = priorSongStatsByKey.get(key);
    const tourCount = sheetTour ? sheetTour.total : parsedTour?.count || 0;
    const nickCount = parsedNick?.count || 0;
    const inferredPreTourTotal = Math.max(0, row.total - tourCount);
    const seedTotal = priorSongStats ? priorSongStats.totalBefore : tourCount > 0 ? inferredPreTourTotal : row.seedTotal;
    const seedSlp = priorSongStats ? priorSongStats.ltp : row.seedSlp;
    const seedLast = priorSongStats?.ltpDate || row.seedLast;
    const effectiveLastIso = maxIso([parseDateKey(row.last), parseDateKey(sheetTour?.last), parsedTour?.lastIso]);
    const lastDisplay = effectiveLastIso ? isoToShortDate(effectiveLastIso) : row.last;
    const playedThisTour = tourCount > 0;
    const stripeIndex = lastFourDates.indexOf(effectiveLastIso);
    const lastForSlp = parsedTour?.lastIso || parseDateKey(sheetTour?.last) || parseDateKey(row.last);
    const effectiveSlp = playedThisTour
      ? showsSinceLastPlayed(setlists, lastForSlp)
      : hasPlaystats
        ? row.slp + showsAfterPlaystats
        : row.slp + postedShowCount;

    return {
      ...row,
      key,
      seedTotal,
      seedSlp,
      seedLast,
      tourFirstIso: parsedTour?.firstIso || parseDateKey(sheetTour?.first),
      tourCount,
      nickCount,
      playedThisTour,
      playedWithNick: nickCount > 0,
      playedFromShelf: playedThisTour && seedTotal > 1 && seedSlp >= config.rotationSlpLimit,
      playedFromPurgatory: playedThisTour && seedTotal === 1,
      effectiveSlp,
      effectiveLastIso,
      lastDisplay,
      stripeAsset: stripeIndex >= 0 ? config.stripeAssets[stripeIndex] : "",
      isAddOn: false
    };
  });

  const songsByKey = new Map(songs.map((song) => [song.key, song]));
  setlists = setlists.map((show) => addGeneratedBustoutNotes(show, songsByKey));
  latestShow = setlists[0] || null;
  featuredShow = isShowDayPreview
    ? { ...boardShow, image: boardShow.image || previewImage, sets: blankSetlist(), notes: [] }
    : latestShow;

  const originals = songs.filter((row) => row.type === "Original");
  const covers = songs.filter((row) => row.type === "Cover");
  const postedDates = new Set(setlists.map((show) => show.isoDate));

  return {
    generatedAt: new Date().toISOString(),
    source: {
      label: hasPlaystats ? `${source.label} + ${source.playstats.source || "Everyday Companion"} playstats` : source.label,
      sheetId,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`,
      setlistUrl: source.setlists.sourceUrl || "",
      playstatsUrl: source.playstats?.sourceUrl || "",
      priorSongStatsUrl: hasPriorSongStats ? source.priorSongStats?.sourceUrl || "" : "",
      priorSongStatsImportedAt: hasPriorSongStats ? source.priorSongStats?.importedAt || "" : "",
      priorSongStatsAllowEcLag: Boolean(source.priorSongStats?.allowEcLag),
      priorSongStatsMissing: Array.isArray(source.priorSongStats?.missing) ? source.priorSongStats.missing.length : 0,
      priorSongStatsBridgeRows: source.priorSongStats?.bridgeRows || 0,
      priorSongStatsUnverifiedLagRows: source.priorSongStats?.unverifiedLagRows || 0,
      playstatsAsOfIso,
      showsAfterPlaystats
    },
    site: {
      name: "Burnthday",
      title: `Widespread Panic ${latestYear} Tour`,
      year: latestYear,
      deck: "The Widespread Panic Spread Sheet",
      boardShow,
      markerLegend: buildMarkerLegend(lastFourDates, setlists, tourDates),
      latestShow,
      featuredShow,
      featuredRunDates: latestRunDates,
      isShowDayPreview
    },
    rules: {
      rotationSlpLimit: config.rotationSlpLimit,
      shelfWatchWindow: config.shelfWatchWindow,
      shelfWatchLimit: config.shelfWatchLimit,
      purgatory: "Songs with one lifetime play stay in Purgatory. If played this tour, they stay marked black until the next tour reset.",
      shelf: "Shelf songs that return this tour stay marked black until the next tour reset.",
      shelfWatch: `Shelf Watch shows up to ${config.shelfWatchLimit} unplayed songs within ${config.shelfWatchWindow} shows of the ${config.rotationSlpLimit}-show Shelf cutoff.`,
      woodshed: "The Woodshed contains songs on the current sheet that have not been played with Nick Johnson on guitar."
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
    songOrigins: {
      totalEntries: songOrigins.length,
      completeEntries: songOrigins.filter((origin) => origin.text).length,
      entries: songOrigins.map(songOriginSummary)
    },
    currentTour: songs.filter((row) => row.playedThisTour).sort((a, b) => b.tourCount - a.tourCount || byTitle(a, b)),
    catalog: songs
  };
}

function addGeneratedBustoutNotes(show, songsByKey) {
  const existingNotes = show.notes || [];
  const generatedNotes = [];
  const seen = new Set();

  for (const set of show.sets || []) {
    for (const title of set.songTitles || splitDisplaySetSongs(set.songs)) {
      const key = normalizeTitle(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const song = songsByKey.get(key);
      if (!song || song.tourFirstIso !== show.isoDate || song.seedSlp < 50 || !song.seedLast) continue;
      if (existingNotes.some((note) => /\blast\b/i.test(note) && normalizeTitle(note).includes(key))) continue;
      generatedNotes.push(`Last '${song.title}' - ${song.seedLast}, ${song.seedSlp} shows`);
    }
  }

  return generatedNotes.length ? { ...show, notes: [...existingNotes, ...generatedNotes] } : show;
}

function buildFreshnessReport(data, archiveEntries = [], songOrigins = [], generatedReviews = []) {
  const latestShow = data.site.latestShow || null;
  const boardShow = data.site.boardShow || null;
  const featuredShow = data.site.featuredShow || latestShow;
  const priorStatsStrict = Boolean(data.source.priorSongStatsUrl) && !data.source.priorSongStatsAllowEcLag && data.source.priorSongStatsMissing === 0;
  const priorStatsPublishSafe = Boolean(data.source.priorSongStatsUrl) && data.source.priorSongStatsMissing === 0 && data.source.priorSongStatsUnverifiedLagRows === 0;

  return {
    generatedAt: data.generatedAt,
    site: {
      title: data.site.title,
      year: data.site.year,
      boardShow: boardShow ? showFreshnessSummary(boardShow) : null,
      featuredShow: featuredShow ? showFreshnessSummary(featuredShow) : null,
      isShowDayPreview: Boolean(data.site.isShowDayPreview),
      latestSetlist: latestShow ? showFreshnessSummary(latestShow) : null,
      markerLegend: data.site.markerLegend
    },
    totals: data.totals,
    sources: data.source,
    integrity: {
      strictPriorStats: priorStatsStrict,
      publishSafePriorStats: priorStatsPublishSafe,
      publicPlaystatsSource: Boolean(data.source.playstatsUrl),
      publicSetlistSource: Boolean(data.source.setlistUrl),
      ecLagBridgeRows: data.source.priorSongStatsBridgeRows,
      noUnverifiedEcLagRowsInPublishData: data.source.priorSongStatsUnverifiedLagRows === 0,
      priorStatsMissingRows: data.source.priorSongStatsMissing,
      currentTourSongs: data.totals.currentTourSongs,
      currentTourPlays: data.totals.currentTourPlays,
      postedSetlists: data.totals.postedSetlists,
      archivePages: archiveEntries.length,
      generatedTourReviews: generatedReviews.length,
      songOriginPages: songOrigins.length
    },
    commands: {
      localQa: "npm run qa",
      postShowLocal: "npm run postshow",
      automaticPublishRefresh: "npm run refresh:automatic",
      strictReconcile: "npm run refresh:strict"
    }
  };
}

function showFreshnessSummary(show) {
  return {
    date: show.date || "",
    isoDate: show.isoDate || "",
    venue: show.venue || "",
    city: show.city || "",
    state: show.state || "",
    location: show.location || "",
    runLabel: show.runLabel || "",
    sourceUrl: show.sourceUrl || ""
  };
}

function songOriginSummary(origin) {
  return {
    title: origin.title,
    slug: origin.slug,
    image: origin.image || "",
    sourceUrl: origin.sourceUrl || ""
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

function buildMarkerLegend(dates, setlists, tourDates) {
  const sortedTourDates = [...tourDates].filter((show) => show.isoDate).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
  const colorNames = ["Black", "Green", "Blue", "Red"];

  return dates.map((isoDate, index) => {
    const show = setlists.find((entry) => entry.isoDate === isoDate) || tourDates.find((entry) => entry.isoDate === isoDate);
    const run = show ? tourRunInfo(sortedTourDates, show) : { number: 1, length: 1 };
    const location = show?.location ? `${show.location}${run.length > 1 ? ` ${romanNumeral(run.number)}` : ""}` : "";
    const label = [isoToShortDate(isoDate), location].filter(Boolean).join(" ");
    return {
      color: colorNames[index] || `Marker ${index + 1}`,
      asset: config.stripeAssets[index],
      isoDate,
      label
    };
  }).filter((item) => item.asset && item.isoDate);
}

function buildBoards(songs) {
  const active = songs.filter((row) => row.effectiveSlp < config.rotationSlpLimit || row.playedThisTour);
  const bustoutRows = songs.filter((row) => row.playedFromShelf || row.playedFromPurgatory).sort(byTitle);
  const bustoutKeys = new Set(bustoutRows.map((row) => row.key));

  const rotationOriginals = withAddOns(
    active.filter((row) => row.type === "Original" && !bustoutKeys.has(row.key)).sort(byTitle),
    bustoutRows.filter((row) => row.type === "Original")
  );
  const rotationCovers = withAddOns(
    active.filter((row) => row.type === "Cover" && !bustoutKeys.has(row.key)).sort(byTitle),
    bustoutRows.filter((row) => row.type === "Cover")
  );

  const shelfRows = songs.filter((row) => row.total > 1 && (row.effectiveSlp >= config.rotationSlpLimit || row.playedFromShelf)).sort(byTitle);
  const purgatoryRows = songs.filter((row) => row.total === 1 || row.playedFromPurgatory).sort(byTitle);
  const woodshedRows = active.filter((row) => row.total > 1 && !row.playedWithNick).sort(byTitle);
  const shelfWatch = songs
    .filter((row) => row.total > 1
      && !row.playedThisTour
      && row.effectiveSlp >= config.rotationSlpLimit - config.shelfWatchWindow
      && row.effectiveSlp < config.rotationSlpLimit)
    .sort((left, right) => right.effectiveSlp - left.effectiveSlp || byTitle(left, right))
    .slice(0, config.shelfWatchLimit);
  const needsClassification = songs.filter((row) => row.type === "Unclassified").sort(byTitle);

  return {
    rotationOriginals,
    rotationCovers,
    shelfOriginals: shelfRows.filter((row) => row.type === "Original"),
    shelfCovers: shelfRows.filter((row) => row.type === "Cover"),
    purgatoryOriginals: purgatoryRows.filter((row) => row.type === "Original"),
    purgatoryCovers: purgatoryRows.filter((row) => row.type === "Cover"),
    shelfWatch,
    woodshedOriginals: woodshedRows.filter((row) => row.type === "Original"),
    woodshedCovers: woodshedRows.filter((row) => row.type === "Cover"),
    needsClassification
  };
}

function withSetlistOnlySongs(catalog, setlistStats, currentTour, playstatsByKey = new Map()) {
  const knownKeys = new Set([...catalog, ...currentTour].map((row) => normalizeTitle(row.title)));
  const additions = [];

  for (const [key, stat] of setlistStats.byKey) {
    if (knownKeys.has(key) || !isPublicSongTitle(stat.title) || !stat.count) continue;

    const lifetime = playstatsByKey.get(key);
    additions.push({
      title: stat.title,
      first: lifetime?.first || isoToShortDate(stat.firstIso || stat.lastIso),
      last: lifetime?.last || isoToShortDate(stat.lastIso),
      total: lifetime?.total || stat.count,
      l100: lifetime?.l100 || stat.count,
      slp: lifetime?.slp || 0,
      seedTotal: lifetime?.total || stat.count,
      seedSlp: lifetime?.slp || 0,
      seedLast: lifetime?.last || isoToShortDate(stat.lastIso),
      type: configuredTypeForTitle(stat.title) || "Unclassified",
      isSetlistOnly: true
    });
    knownKeys.add(key);
  }

  return [...catalog, ...additions.sort(byTitle)];
}

function withPlaystatsOnlySongs(catalog, playstatsRows) {
  const knownKeys = new Set(catalog.map((row) => normalizeTitle(row.title)));
  const additions = [];

  for (const lifetime of playstatsRows) {
    const key = normalizeTitle(lifetime.title);
    if (knownKeys.has(key) || !isPublicSongTitle(lifetime.title)) continue;

    additions.push({
      title: lifetime.title,
      first: lifetime.first,
      last: lifetime.last,
      total: lifetime.total,
      l100: lifetime.l100,
      slp: lifetime.slp,
      seedTotal: lifetime.total,
      seedSlp: lifetime.slp,
      seedLast: lifetime.last,
      type: configuredTypeForTitle(lifetime.title) || "Unclassified",
      isPlaystatsOnly: true
    });
    knownKeys.add(key);
  }

  return [...catalog, ...additions.sort(byTitle)];
}

function withAddOns(rows, addOnRows) {
  const addOns = addOnRows.map((row) => ({
    ...row,
    isAddOn: true,
    addOnDate: displayDate(row.lastDisplay || row.seedLast)
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
    const showSongsByKey = new Map();

    for (const set of show.sets || []) {
      for (const song of splitSetSongs(set.songTitles || set.songs, known)) {
        if (!showSongsByKey.has(song.key)) showSongsByKey.set(song.key, song);
      }
    }

    for (const song of showSongsByKey.values()) {
      const current = byKey.get(song.key) || { count: 0, firstIso: "", lastIso: "", title: song.title };
      current.count += 1;
      current.firstIso = minIso([current.firstIso, show.isoDate]);
      current.lastIso = maxIso([current.lastIso, show.isoDate]);
      byKey.set(song.key, current);
    }
  }

  return { byKey };
}

function isNickJohnsonShow(show) {
  return (show.notes || []).some((note) => /\bnick johnson\b/i.test(note) && /\bguitar\b/i.test(note));
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
  const title = clean(row["Song Title"] || row.Title || row.Song);
  const type = clean(row.TYPE) || clean(row.Type) || (originalFlag ? "Original" : coverFlag ? "Cover" : "");
  const configuredType = configuredTypeForTitle(title);
  const total = toNumber(row.Total);
  const slp = toNumber(row.SLP);

  return {
    title,
    first: clean(row.First),
    last: clean(row.Last),
    total,
    l100: toNumber(row.L100),
    slp,
    seedTotal: total,
    seedSlp: slp,
    seedLast: clean(row.Last),
    type: configuredType || (type === "Original" ? "Original" : type === "Cover" ? "Cover" : "Unclassified")
  };
}

function normalizeCurrentTourRow(row) {
  const title = clean(row["Song Title"] || row.Title || row.Song);
  const configuredType = configuredTypeForTitle(title);

  return {
    title,
    first: clean(row.First),
    last: clean(row.Last),
    total: toNumber(row.Total),
    slp: toNumber(row.SLP),
    type: configuredType || (clean(row.Original) ? "Original" : clean(row.Cover) ? "Cover" : "Unclassified")
  };
}

function normalizePlaystatRow(row) {
  return {
    title: clean(row.title || row["Song Title"] || row.Title || row.Song),
    first: clean(row.first || row.First),
    last: clean(row.last || row.Last),
    total: toNumber(row.total || row.Total),
    l100: toNumber(row.l100 || row.L100),
    slp: toNumber(row.slp || row.SLP)
  };
}

function normalizePriorSongStatRow(row) {
  return {
    title: clean(row.title || row["Song Title"] || row.Title || row.Song),
    ltpDate: clean(row.ltpDate || row["LTP Date"]),
    ltp: toNumber(row.ltp || row.LTP),
    totalBefore: toNumber(row.totalBefore || row["Total Before"] || row["#/Ever"])
  };
}

function mergePlaystats(row, playstats) {
  if (!playstats) return row;
  return {
    ...row,
    first: playstats.first || row.first,
    last: playstats.last || row.last,
    total: playstats.total || row.total,
    l100: playstats.l100,
    slp: playstats.slp
  };
}

function configuredTypeForTitle(title) {
  const key = clean(title).toUpperCase();
  if (config.typeOverrides[key]) return config.typeOverrides[key];
  return "";
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
  const fontSources = [
    ["geist", "geist-latin-wght-normal.woff2"],
    ["bricolage-grotesque", "bricolage-grotesque-latin-wght-normal.woff2"],
    ["geist-mono", "geist-mono-latin-wght-normal.woff2"]
  ];
  await Promise.all(fontSources.map(([pkg, file]) => copyFile(
    path.join(root, "node_modules", "@fontsource-variable", pkg, "files", file),
    path.join(dist, "assets", file)
  )));
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

async function writeBloggerArchive(entries, data) {
  if (!entries.length) return;

  await Promise.all(entries.map((entry) => writeStaticPage(entry.path, renderArchivePage(entry, data))));
  await writeStaticPage("/archive/index.html", renderArchiveIndex(entries, data));
  await writeStaticPage("/pages/index.html", renderPagesIndex(entries.filter((entry) => entry.path.startsWith("/p/")), data));
}

async function writeModernArchivePages(entries, data) {
  const pages = [
    {
      legacyPath: "/p/about.html",
      path: "/about/index.html",
      seoTitle: "About Burnthday | Widespread Panic Fan Site",
      pageGraphic: "Alex-1_zps04c65eda.png"
    },
    {
      legacyPath: "/p/widespread-panic-dirty-side-down-lyrics.html",
      path: "/lyrics-chords/index.html",
      seoTitle: "Widespread Panic Lyrics & Chords | Burnthday",
      pageGraphic: "houserguitar.png"
    }
  ];
  for (const page of pages) {
    const entry = entries.find((candidate) => candidate.path === page.legacyPath);
    if (!entry) continue;
    await writeStaticPage(page.path, renderArchivePage({ ...entry, ...page }, data));
  }
}

async function writeSongOrigins(origins) {
  if (!origins.length) return;

  await writeStaticPage("/song-origins/index.html", renderSongOriginsIndex(origins, {
    canonicalPath: "/song-origins/"
  }));
  await Promise.all(origins.map((origin) => writeStaticPage(`/song-origins/${origin.slug}/index.html`, renderSongOriginPage(origin, origins))));
}

async function writeStaticPage(pagePath, html) {
  const relative = pagePath.replace(/^\/+/, "");
  const target = path.join(dist, relative);
  if (!target.startsWith(dist)) throw new Error(`Refusing to write outside dist: ${pagePath}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, finalizeHtml(html), "utf8");
}

function finalizeHtml(html) {
  const value = normalizeMetaDescriptionHtml(rewriteLegacyCoreLinks(String(html || "")));
  if (!/<\/head>/i.test(value) || /name="robots" content="noindex"/i.test(value)) return value;
  return value.replace(/<\/head>/i, `${renderSocialMeta(value)}${renderAnalyticsHead()}\n  </head>`);
}

function rewriteLegacyCoreLinks(html) {
  let value = html;
  for (const [source, target] of legacyCoreRoutes) {
    const variants = [
      `https://www.burnthday.com${source}.html`,
      `http://www.burnthday.com${source}.html`,
      `https://burnthday.com${source}.html`,
      `http://burnthday.com${source}.html`,
      `${source}.html`,
      `https://www.burnthday.com${source}`,
      `http://www.burnthday.com${source}`,
      `https://burnthday.com${source}`,
      `http://burnthday.com${source}`,
      source
    ];
    for (const variant of variants) value = value.split(variant).join(target);
  }
  return value;
}

function normalizeMetaDescriptionHtml(html) {
  const title = decodeXml(stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "Burnthday"))
    .replace(/\s*\|\s*Burnthday\s*$/i, "");
  return html.replace(/<meta name="description" content="([^"]*)">/i, (_match, description) => {
    const text = decodeXml(description) || `${title} from Burnthday.`;
    return `<meta name="description" content="${escapeAttr(fitMetaText(text, 155))}">`;
  });
}

function renderSocialMeta(html) {
  if (/property="og:title"/i.test(html)) return "";
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "Burnthday";
  const description = html.match(/<meta name="description" content="([^"]*)">/i)?.[1] || "";
  const canonical = html.match(/<link rel="canonical" href="([^"]*)">/i)?.[1] || "";
  if (!canonical) return "";
  const type = /<article\b/i.test(html) ? "article" : "website";
  return `<meta property="og:type" content="${type}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${canonical}">
    <meta property="og:image" content="https://burnthday.com/assets/social-card.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:site_name" content="Burnthday">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="https://burnthday.com/assets/social-card.png">
    `;
}

function renderAnalyticsHead() {
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${analyticsMeasurementId}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', '${analyticsMeasurementId}');
    </script>`;
}

function renderNotFoundPage(data) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Page Not Found | Burnthday</title>
    <meta name="description" content="That Burnthday page could not be found.">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main">
      <article class="archive-page">
        <header class="archive-title"><p>404</p><h1>Page Not Found</h1></header>
        <p>The page may have moved when Burnthday left Blogger.</p>
        <p><a href="/">Current Song List</a> <span>|</span> <a href="/archive/">Burnthday Archive</a></p>
      </article>
    </main>
    ${renderSiteFooter(data)}
  </body>
</html>`;
}

async function writeShelfInfoPage(data, entries) {
  const oldShelfEntry = entries.find((entry) => entry.path === "/p/theshelf.html");
  await writeStaticPage("/shelf/index.html", renderShelfInfoPage(data, oldShelfEntry));
}

async function writeRumorsPage(data, entries) {
  const oldRumorsEntry = entries.find((entry) => entry.path === "/p/rumors.html");
  await writeStaticPage("/rumors/index.html", renderRumorsPage(data, oldRumorsEntry));
}

async function writePrivacyPage(data) {
  await writeStaticPage("/privacy/index.html", renderPrivacyPage(data));
}

function renderPrivacyPage(data) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Privacy | Burnthday</title>
    <meta name="description" content="How Burnthday uses analytics and handles visitor information.">
    <link rel="canonical" href="https://burnthday.com/privacy/">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main">
      <article class="archive-page privacy-page">
        <header class="archive-title">
          <p>Last updated July 18, 2026</p>
          <h1>Privacy</h1>
        </header>
        <div class="archive-content">
          <p>Burnthday is an independent Widespread Panic fan site. You do not need an account, and the site does not ask for your name, email address, or payment information.</p>
          <h2>Analytics</h2>
          <p>Burnthday uses Google Analytics 4 to understand which pages people visit, how they found the site, and how the site performs on different devices. Google Analytics may use cookies and collect information such as browser and device details, approximate location, referring pages, and interactions with the site. Burnthday uses this information in aggregate to maintain and improve the site.</p>
          <p>Burnthday does not sell personal information. You can learn how Google handles information in the <a href="https://policies.google.com/privacy">Google Privacy Policy</a> and install the <a href="https://tools.google.com/dlpage/gaoptout">Google Analytics opt-out browser add-on</a>.</p>
          <h2>External Links</h2>
          <p>The site links to Widespread Panic, Nugs.net, Facebook, Instagram, X, YouTube, and other independent sources. Those sites have their own privacy practices, and Burnthday does not control them.</p>
          <h2>Questions</h2>
          <p>Questions about this page can be sent through <a href="https://www.facebook.com/burnthday">Burnthday on Facebook</a> or <a href="https://www.instagram.com/burnthday/">Burnthday on Instagram</a>.</p>
        </div>
      </article>
    </main>
    ${renderSiteFooter(data)}
  </body>
</html>`;
}

async function writeGeneratedTourReviewPages(data) {
  const reviews = [];
  const review2025 = await buildGeneratedTourReview(2025, data);
  if (review2025) {
    await writeStaticPage(review2025.path, renderGeneratedTourReviewPage(review2025, data));
    reviews.push({
      year: review2025.year,
      title: review2025.title,
      path: review2025.path,
      published: `${review2025.year}-12-31`,
      summary: `${review2025.totals.setlists} setlists, ${review2025.totals.uniqueSongs} songs, ${review2025.totals.tourPlays} song plays`
    });
  }
  return reviews;
}

async function writeTourReviewHub(data, entries, generatedReviews = []) {
  const oldEntry = entries.find((entry) => entry.path === "/p/burnthdays-widespread-panic-tours-in.html");
  await writeStaticPage("/tour-in-review/index.html", renderTourReviewHubPage(data, oldEntry, generatedReviews));
}

async function buildGeneratedTourReview(year, data) {
  let payload;
  try {
    payload = JSON.parse(await readFile(path.join(root, "data", "source", `setlists-${year}.json`), "utf8"));
  } catch {
    return null;
  }

  const setlists = [...(payload.setlists || [])].filter((show) => show.isoDate).sort((a, b) => b.isoDate.localeCompare(a.isoDate));
  if (!setlists.length) return null;

  const catalogByKey = new Map((data.catalog || []).map((row) => [normalizeTitle(row.title), row]));
  const statsByKey = analyzeTourSongs(setlists, data.catalog || []);
  const recentDates = [...new Set(setlists.map((show) => show.isoDate))].slice(0, 4);
  const rows = [...statsByKey.values()].map((row) => {
    const catalogRow = catalogByKey.get(row.key);
    const type = catalogRow?.type || configuredTypeForTitle(row.title) || "Unclassified";
    const stripeIndex = recentDates.indexOf(row.lastIso);
    return {
      ...catalogRow,
      ...row,
      title: catalogRow?.title || row.title,
      type,
      tourCount: row.count,
      total: catalogRow?.total || row.count,
      lastDisplay: isoToShortDate(row.lastIso),
      stripeAsset: stripeIndex >= 0 ? config.stripeAssets[stripeIndex] : "",
      isAddOn: false
    };
  }).sort(byTitle);

  const originals = rows.filter((row) => row.type === "Original").sort(byTitle);
  const covers = rows.filter((row) => row.type === "Cover").sort(byTitle);
  const other = rows.filter((row) => row.type !== "Original" && row.type !== "Cover").sort(byTitle);
  const tourPlays = sum(rows.map((row) => row.count));
  const topSongs = [...rows].sort((a, b) => b.count - a.count || byTitle(a, b)).slice(0, 12);
  const oneTimers = rows.filter((row) => row.count === 1).sort(byTitle);

  return {
    year,
    title: `Widespread Panic ${year} Tour In Review`,
    path: `/${year}/12/widespread-panic-${year}-tour-in-review.html`,
    sourceUrl: payload.sourceUrl || "",
    setlists,
    tourDates: payload.tourDates || [],
    boards: {
      originals,
      covers,
      other
    },
    totals: {
      setlists: setlists.length,
      tourDates: (payload.tourDates || []).length,
      uniqueSongs: rows.length,
      tourPlays,
      originals: originals.length,
      covers: covers.length,
      other: other.length,
      oneTimers: oneTimers.length
    },
    topSongs,
    oneTimers
  };
}

function analyzeTourSongs(setlists, catalog) {
  const known = new Map();
  for (const song of catalog) {
    const key = normalizeTitle(song.title);
    if (key && !known.has(key)) known.set(key, { key, title: song.title });
  }

  const byKey = new Map();
  for (const show of [...setlists].sort((a, b) => a.isoDate.localeCompare(b.isoDate))) {
    const showSongsByKey = new Map();
    for (const set of show.sets || []) {
      for (const song of splitSetSongs(set.songTitles || set.songs, known)) {
        if (!showSongsByKey.has(song.key)) showSongsByKey.set(song.key, song);
      }
    }

    for (const song of showSongsByKey.values()) {
      const current = byKey.get(song.key) || { key: song.key, title: song.title, count: 0, firstIso: show.isoDate, lastIso: show.isoDate };
      current.count += 1;
      current.firstIso = minIso([current.firstIso, show.isoDate]);
      current.lastIso = maxIso([current.lastIso, show.isoDate]);
      byKey.set(song.key, current);
    }
  }

  return byKey;
}

function renderArchivePage(entry, data) {
  const datedTitle = entry.hasDuplicateTitle ? `${entry.title} - ${formatArchiveDate(entry.published)}` : entry.title;
  const title = fitMetaText(entry.seoTitle || `${datedTitle} | Burnthday`, 68);
  const description = archiveMetaDescription(entry);
  const content = repairArchiveAlbumArtwork(removeFirstArchiveGraphic(entry.content, entry.pageGraphic), entry.path);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com${escapeAttr(publicPath(entry.path))}">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main">
      <article class="archive-page">
        ${entry.pageGraphic
          ? renderPageGraphicTitle(entry.title, entry.pageGraphic)
          : `<header class="archive-title">
            <p>${escapeHtml(formatArchiveDate(entry.published))}</p>
            <h1>${escapeHtml(entry.title)}</h1>
            ${entry.categories.length ? `<div class="archive-tags">${entry.categories.map((category) => `<span>${escapeHtml(category)}</span>`).join("")}</div>` : ""}
          </header>`}
        <div class="archive-content">
          ${content}
        </div>
      </article>
    </main>
    ${renderSiteFooter(data || { generatedAt: new Date().toISOString(), source: { label: "Blogger Takeout" } })}
  </body>
</html>
`;
}

function renderPageGraphicTitle(title, filename) {
  return `<header class="page-graphic-title">
    <img src="/assets/archive-media/${encodeURIComponent(filename)}" alt="" decoding="async">
    <h1>${escapeHtml(title)}</h1>
  </header>`;
}

function removeFirstArchiveGraphic(content, filename) {
  if (!filename) return content;
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(content || "")
    .replace(new RegExp(`<img\\b[^>]*(?:${escaped}|${encodeURIComponent(filename)})[^>]*>`, "i"), "")
    .replace(/<div\b[^>]*>\s*<\/div>/gi, "");
}

function repairArchiveAlbumArtwork(content, pagePath) {
  const value = String(content || "");
  if (/dirty-side-down-album-lyrics\.html$/i.test(pagePath)) {
    return value.replace(/src=(['"])[^'"]*Widespread-Panic-Dirty-Side-Down\.jpg[^'"]*\1/i, 'src="/assets/archive-media/dirty-side-down-cover.jpg"');
  }
  if (/earth-to-america-album-lyrics\.html$/i.test(pagePath)) {
    return value.replace(/src=(['"])[^'"]*album-earth-to-america\.jpg[^'"]*\1/i, 'src="/assets/archive-media/earth-to-america-cover.jpg"');
  }
  if (/free-somehow-album-lyrics\.html$/i.test(pagePath)) {
    return value.replace(/src=(['"])data:image\/png;base64,[^'"]*\1/i, 'src="/assets/archive-media/free-somehow-cover.jpg"');
  }
  return value;
}

function archiveMetaDescription(entry) {
  const content = String(entry.content || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const text = clean(entry.metaDescription) || decodeXml(stripTags(content)).replace(/\s+/g, " ").trim()
    || `${entry.title} from Burnthday's Widespread Panic archive.`;
  return fitMetaText(text, 155);
}

function fitMetaText(value, maxLength) {
  const text = clean(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength - 3);
  const boundary = clipped.lastIndexOf(" ");
  const end = boundary > maxLength * 0.7 ? boundary : clipped.length;
  return `${clipped.slice(0, end).replace(/[\s,;:.-]+$/, "")}...`;
}

function renderShelfInfoPage(data, oldShelfEntry) {
  const year = data.site.year;
  const newShelfRows = data.catalog
    .filter((row) => row.total > 1 && !row.playedThisTour && row.seedSlp < data.rules.rotationSlpLimit && row.effectiveSlp >= data.rules.rotationSlpLimit)
    .sort(byTitle);
  const newShelfOriginals = newShelfRows.filter((row) => row.type === "Original");
  const newShelfCovers = newShelfRows.filter((row) => row.type === "Cover");
  const description = `Burnthday's Widespread Panic Shelf and Purgatory notes for the ${year} tour.`;
  const historicalContent = removeFirstArchiveGraphic(oldShelfEntry?.content || "", "shelf.png");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic Shelf &amp; Purgatory | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com/shelf/">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main">
      <article class="archive-page shelf-info-page">
        ${renderPageGraphicTitle("The Shelf", "shelf.png")}
        <section class="shelf-current-update">
          <h2>Spring ${escapeHtml(String(year))} New Additions To The Shelf</h2>
          ${renderShelfAdditionList("Originals", newShelfOriginals)}
          ${renderShelfAdditionList("Covers", newShelfCovers)}
        </section>
        ${historicalContent ? `<section class="legacy-shelf-notes"><h2>Previous Shelf Updates</h2><div class="archive-content">${historicalContent}</div></section>` : ""}
      </article>
    </main>
    ${renderSiteFooter(data)}
  </body>
</html>
`;
}

function renderShelfAdditionList(title, rows) {
  return `<div class="shelf-addition-group">
    <h3>${escapeHtml(title)}</h3>
    ${rows.length ? `<ul>${rows.map((row) => `<li>${escapeHtml(row.title)}</li>`).join("")}</ul>` : "<p>None.</p>"}
  </div>`;
}

function renderRumorsPage(data, oldRumorsEntry) {
  const description = oldRumorsEntry?.metaDescription || "Burnthday Widespread Panic rumors.";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic Tour Rumors | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com/rumors/">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main">
      <article class="archive-page rumors-page">
        ${renderPageGraphicTitle("Rumors", "crystalball.png")}
        <div class="archive-content">${removeFirstArchiveGraphic(oldRumorsEntry?.content || "", "crystalball.png")}</div>
      </article>
    </main>
    ${renderSiteFooter(data)}
  </body>
</html>
`;
}

function renderMovementList(title, rows, emptyText) {
  return `<div class="movement-block">
    <h3>${escapeHtml(title)}</h3>
    ${rows.length ? `<ul class="movement-list">${rows.map(renderMovementRow).join("")}</ul>` : `<p>${escapeHtml(emptyText)}</p>`}
  </div>`;
}

function renderMovementRow(row) {
  const source = row.playedFromShelf ? `last played ${row.seedLast}, ${row.seedSlp} shows` : `one-timer last played ${row.seedLast || "before this tour"}`;
  return `<li>
    <strong>${escapeHtml(row.title)}</strong><sup>${escapeHtml(String(row.tourCount))}</sup>
    <span>${escapeHtml(source)}. Most recent: ${escapeHtml(row.lastDisplay)}.</span>
  </li>`;
}

function renderTourReviewHubPage(data, oldEntry, generatedReviews = []) {
  const description = "Burnthday's preserved and updated Widespread Panic Tour In Review pages.";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic Tour In Review | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com/tour-in-review/">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main">
      <article class="archive-page tour-review-hub">
        ${renderPageGraphicTitle("Tour In Review", "BTD-1_zps89a85566.png")}
        ${generatedReviews.length ? `<section class="archive-content current-review-link">
          ${generatedReviews.map((review) => `<div><b>${escapeHtml(String(review.year || 2025))}:</b><br><br><a href="${escapeAttr(publicPath(review.path))}">${escapeHtml(String(review.year || 2025))} Tour</a></div>`).join("")}
        </section>` : ""}
        ${oldEntry?.content ? `<div class="archive-content">${removeFirstArchiveGraphic(oldEntry.content, "BTD-1_zps89a85566.png")}</div>` : ""}
      </article>
    </main>
    ${renderSiteFooter(data)}
  </body>
</html>
`;
}

function renderGeneratedTourReviewPage(review, data) {
  const description = `${review.title}: ${review.totals.setlists} setlists, ${review.totals.uniqueSongs} songs, and ${review.totals.tourPlays} song plays.`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(review.title)} | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com${escapeAttr(publicPath(review.path))}">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="tour-review-main">
      <section class="laminate primary-board tour-review-sheet" id="song-list">
        ${renderBoardHeader(`${review.year} TOUR`)}
        ${renderSongPanel(`review-${review.year}-originals`, "ORIGINALS", review.boards.originals)}
        ${renderSongPanel(`review-${review.year}-covers`, "COVERS", review.boards.covers)}
        ${review.boards.other.length ? renderSongPanel(`review-${review.year}-other`, "NEEDS SORTING", review.boards.other) : ""}
      </section>

      <section class="setlist-section" id="setlists">
        <div class="section-heading">
          <h2>${escapeHtml(String(review.year))} SETLISTS</h2>
          <span>${escapeHtml(String(review.totals.setlists))} posted</span>
        </div>
        <div class="setlist-grid">
          ${review.setlists.map((show) => renderSetlistCard(show, { lazy: true })).join("")}
        </div>
      </section>
    </main>
    ${renderSiteFooter(data)}
    <script>
      ${renderFitScriptBody()}
    </script>
  </body>
</html>
`;
}

function renderSongOriginsIndex(origins, options = {}) {
  const canonicalPath = options.canonicalPath || "/song-origins/";
  const description = "Widespread Panic song origins, histories, notes, and Burnthday picks.";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic Song Origins | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com${escapeAttr(canonicalPath)}">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main origins-main">
      <section class="archive-index origin-index">
        <header class="origin-hero">
          <img class="origin-fish" src="/assets/archive-media/SongOriginsOriginalWSPfish.png" alt="">
          <div>
            <h1>Widespread Panic Song Origins</h1>
            <span>${origins.length} researched stories about how Widespread Panic songs were written, where they came from, and the people behind them, with play history and Burnthday's picks.</span>
          </div>
        </header>
        <div class="origin-grid">
          ${origins.map(renderSongOriginCard).join("")}
        </div>
      </section>
    </main>
    ${renderSiteFooter({ generatedAt: new Date().toISOString(), source: { label: "Song Origins archive" } })}
  </body>
</html>
`;
}

function renderSongOriginCard(origin) {
  return `<a class="origin-card" href="/song-origins/${escapeAttr(origin.slug)}/">
    ${origin.image ? `<img src="${escapeAttr(origin.image)}" alt="${escapeAttr(`${origin.title} song origin`)}" loading="lazy" decoding="async">` : ""}
    <span>Song Origins</span>
    <strong>${escapeHtml(origin.title)}</strong>
  </a>`;
}

function renderSongOriginPage(origin, origins) {
  const description = clean(origin.text).slice(0, 180) || `Burnthday Song Origins: ${origin.title}`;
  const currentIndex = origins.findIndex((item) => item.slug === origin.slug);
  const previous = origins[currentIndex - 1] || null;
  const next = origins[currentIndex + 1] || null;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(origin.title)} Song Origin | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com/song-origins/${escapeAttr(origin.slug)}/">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["Song Origins", "https://burnthday.com/song-origins/"],
      [origin.title, `https://burnthday.com/song-origins/${origin.slug}/`]
    ])}</script>
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main origins-main">
      <article class="archive-page origin-page">
        <nav class="origin-back"><a href="/song-origins/">Song Origins</a></nav>
        <header class="archive-title origin-title">
          <h1>${escapeHtml(origin.title)}</h1>
        </header>
        <div class="origin-layout">
          ${origin.image ? `<figure class="origin-image"><img src="${escapeAttr(origin.image)}" alt="${escapeAttr(`${origin.title} song origin`)}" decoding="async"></figure>` : ""}
          <div class="origin-body">
            ${renderOriginText(origin.text)}
            <p class="origin-source"><a href="${escapeAttr(origin.sourceUrl)}">Original Facebook post</a></p>
          </div>
        </div>
        <nav class="origin-nav" aria-label="Song origin navigation">
          ${previous ? `<a href="/song-origins/${escapeAttr(previous.slug)}/">${escapeHtml(previous.title)}</a>` : "<span></span>"}
          ${next ? `<a href="/song-origins/${escapeAttr(next.slug)}/">${escapeHtml(next.title)}</a>` : "<span></span>"}
        </nav>
      </article>
    </main>
    ${renderSiteFooter({ generatedAt: new Date().toISOString(), source: { label: "Song Origins archive" } })}
  </body>
</html>
`;
}

function renderOriginText(text) {
  const formatted = String(text || "")
    .replace(/(:)\s{2,}(?=\d)/g, "$1 ")
    .replace(/[ \t]{2,}/g, "\n\n")
    .replace(/\s+(# of times played:)/g, "\n\n$1")
    .replace(/\s+(First time played:|Frequency:|Longest drought:|Most common lead in:|Most common lead out:|Most common set position:|Notes:|Lyrics:|Chords:|Learn the Guitar Solo:)/g, "\n$1")
    .replace(/\s+(Burnthday's Picks:)/g, "\n\n$1")
    .replace(/\s+(\d{1,2}\/\d{1,2}\/\d{2,4}\s+[^\n]+?https?:\/\/)/g, "\n$1");

  return formatted
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\n/).map((line) => line.trim()).filter(Boolean);
      const className = /^# of times played:/.test(lines[0]) ? " class=\"origin-stats\"" : "";
      return `<p${className}>${lines.map(renderLinkedText).join("<br>")}</p>`;
    })
    .join("");
}

function renderLinkedText(text) {
  const safeText = stripBlockedExternalUrls(text);
  const pieces = [];
  let cursor = 0;
  for (const match of safeText.matchAll(/https?:\/\/[^\s<]+/g)) {
    const rawUrl = match[0];
    const start = match.index || 0;
    const trailing = rawUrl.match(/[),.]+$/)?.[0] || "";
    const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
    pieces.push(escapeHtml(safeText.slice(cursor, start)));
    pieces.push(`<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>${escapeHtml(trailing)}`);
    cursor = start + rawUrl.length;
  }
  pieces.push(escapeHtml(safeText.slice(cursor)));
  return pieces.join("");
}

function renderBreadcrumbJsonLd(items) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, item], index) => ({
      "@type": "ListItem",
      position: index + 1,
      name,
      item
    }))
  }).replace(/</g, "\\u003c");
}

function renderArchiveIndex(entries, data) {
  return renderArchiveListPage({
    title: "Burnthday Archive",
    deck: `${entries.length} preserved Blogger posts and pages from the Takeout export.`,
    canonicalPath: "/archive/",
    entries,
    data
  });
}

function renderPagesIndex(entries, data) {
  return renderArchiveListPage({
    title: "Burnthday Pages",
    deck: `${entries.length} preserved Blogger pages from the Takeout export, including About, Song Origins, lyrics, downloads, and old live stream pages.`,
    canonicalPath: "/archive/",
    noindex: true,
    entries: entries.sort((a, b) => a.title.localeCompare(b.title)),
    data
  });
}

function renderTourReviewIndex(entries, data) {
  return renderArchiveListPage({
    title: "Tour In Review",
    deck: `${entries.length} preserved Tour In Review pages and related review posts.`,
    canonicalPath: "/tour-in-review/",
    entries,
    data
  });
}

function renderArchiveListPage({ title, deck, canonicalPath, noindex = false, entries, data }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${noindex ? '<meta name="robots" content="noindex, follow">' : ""}
    <title>${escapeHtml(title)} | Burnthday</title>
    <meta name="description" content="${escapeAttr(deck)}">
    <link rel="canonical" href="https://burnthday.com${escapeAttr(canonicalPath)}">
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
            <a href="${escapeAttr(canonicalPathFor(entry.path))}">${escapeHtml(entry.title)}</a>
            <span>${escapeHtml(formatArchiveDate(entry.published))}</span>
            ${entry.categories.length ? `<em>${escapeHtml(entry.categories.join(" / "))}</em>` : ""}
          </li>`).join("")}
        </ol>
      </section>
    </main>
    ${renderSiteFooter(data || { generatedAt: new Date().toISOString(), source: { label: "Blogger Takeout" } })}
  </body>
</html>
`;
}

function renderRedirectPage({ title, targetPath, data }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0; url=${escapeAttr(targetPath)}">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(title)} | Burnthday</title>
    <link rel="canonical" href="https://burnthday.com${escapeAttr(targetPath)}">
  </head>
  <body>
    ${renderSiteHeader()}
    <main class="archive-main">
      <article class="archive-page">
        <p><a href="${escapeAttr(targetPath)}">${escapeHtml(title)}</a></p>
      </article>
    </main>
    ${renderSiteFooter(data || { generatedAt: new Date().toISOString(), source: { label: "Blogger Takeout" } })}
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
    <meta property="og:image" content="https://burnthday.com/assets/social-card.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="Burnthday fish and crossbones logo">
    <meta property="og:site_name" content="Burnthday">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(data.site.title)} by Burnthday">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="https://burnthday.com/assets/social-card.png">
    <meta name="twitter:image:alt" content="Burnthday fish and crossbones logo">
    <link rel="canonical" href="https://burnthday.com/">
    <link rel="icon" href="/assets/marker-1.png" type="image/png">
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Burnthday",
      url: "https://burnthday.com/",
      description
    }).replace(/</g, "\\u003c")}</script>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}

    <main>
      ${renderHomeIntro(data)}
      ${renderLatestSetlist(data)}
      ${renderBoardIntro(data)}
      ${renderRotationBoard(data)}
      ${renderSheetBentos(data)}
      ${renderTourStats(data)}
      ${renderShelfWatch(data)}
      ${renderNickJohnsonFeature(data)}
      ${renderSetlists(data, { skipFeaturedRun: true })}
      ${renderCommunityLinks()}
    </main>

    ${renderSiteFooter(data, { stagelight: true })}

    <script>
      ${renderFitScriptBody()}
    </script>
  </body>
</html>
`;
}

function renderHomeIntro(data) {
  const links = [
    ["Song Possibilities", "#song-list"],
    ["Tour Stats", "#tour-stats"],
    ["The Shelf", "#shelf"],
    ["Purgatory", "#purgatory"],
    ["Nick Stats", "#nick-johnson"],
    ["Setlists", "#setlists"]
  ];
  return `<header class="home-intro">
    <h1>WIDESPREAD PANIC ${escapeHtml(String(data.site.year))} TOUR</h1>
    <nav class="home-trail" aria-label="Homepage sections">${links.map(([label, href]) => `<a href="${href}">${escapeHtml(label)}</a>`).join('<span aria-hidden="true">&gt;</span>')}</nav>
  </header>`;
}

function renderFitScriptBody() {
  return `function fitBoardTitles() {
        document.querySelectorAll(".header-row .board-title h1").forEach((title) => {
          const slot = title.parentElement;
          if (!slot) return;

          title.style.fontSize = "";
          const computed = window.getComputedStyle(title);
          let size = Number.parseFloat(computed.fontSize);
          if (!Number.isFinite(size)) return;

          const titleFloor = window.matchMedia("(max-width: 560px)").matches ? 20 : 24;
          const minSize = Math.max(titleFloor, size * 0.46);
          title.style.fontSize = size + "px";

          let guard = 0;
          while (title.scrollWidth > slot.clientWidth && size > minSize && guard < 28) {
            size = Math.max(minSize, size * 0.94);
            title.style.fontSize = size + "px";
            guard += 1;
          }
        });
      }

      function fitSongRows() {
        document.querySelectorAll(".rotation-song:not(.spacer)").forEach((song) => {
          const text = song.querySelector(".marker-text");
          if (!text) return;

          song.style.removeProperty("--song-font-size");
          const baseSize = Number.parseFloat(window.getComputedStyle(song).fontSize) || 22;
          const minimumSize = song.classList.contains("is-hand-addon") ? 15 : 16;
          const fits = () => text.scrollWidth <= text.clientWidth + 1 && song.scrollWidth <= song.clientWidth + 1;
          let fittedSize = baseSize;

          while (!fits() && fittedSize > minimumSize) {
            fittedSize = Math.max(minimumSize, fittedSize - 0.5);
            song.style.setProperty("--song-font-size", fittedSize + "px");
          }

          song.classList.toggle("is-overflowing", !fits());
        });
      }

      fitBoardTitles();
      fitSongRows();
      window.addEventListener("resize", () => window.requestAnimationFrame(() => {
        fitBoardTitles();
        fitSongRows();
      }));
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
        fitBoardTitles();
        fitSongRows();
      });

      if (window.matchMedia("(max-width: 700px)").matches) {
        document.querySelectorAll(".nick-disclosure, .setlist-archive-panel").forEach((panel) => panel.removeAttribute("open"));
      }

      document.querySelectorAll(".tour-table").forEach((table) => {
        const body = table.tBodies[0];
        const buttons = [...table.querySelectorAll("button[data-sort]")];
        const section = table.closest(".tour-stats");
        const showFilter = section?.querySelector("[data-show-filter]");
        const mobileSort = section?.querySelector("[data-mobile-sort]");
        const typeButtons = [...(section?.querySelectorAll("[data-type-filter]") || [])];
        const status = section?.querySelector(".show-filter-status");
        const rarityFilter = section?.querySelector("[data-rarity-filter]");
        const rarityOptions = [...(section?.querySelectorAll("[data-rarity-option]") || [])];
        const rarityClear = section?.querySelector("[data-rarity-clear]");
        const rarityActive = section?.querySelector("[data-rarity-active]");
        let selectedShow = "";
        let selectedType = "all";

        const applyFilters = () => {
          const rows = [...body.rows];
          const selectedRarities = rarityOptions.filter((box) => box.checked).map((box) => box.value);
          let selectedCount = 0;
          let visibleCount = 0;
          rows.forEach((row) => {
            const matchesType = selectedType === "all" || row.dataset.type === selectedType;
            const matchesRarity = !selectedRarities.length || selectedRarities.includes(row.dataset.rarityTier);
            const matchesShow = !selectedShow || (row.dataset.shows || "").split(",").includes(selectedShow);
            const visible = matchesType && matchesRarity;
            row.hidden = !visible;
            if (visible) visibleCount += 1;
            row.classList.toggle("is-selected-show", Boolean(selectedShow && matchesShow && visible));
            if (selectedShow && matchesShow && visible) selectedCount += 1;
          });
          rows.sort((left, right) => {
            const leftSelected = left.classList.contains("is-selected-show") ? 1 : 0;
            const rightSelected = right.classList.contains("is-selected-show") ? 1 : 0;
            return rightSelected - leftSelected || Number(right.dataset.count) - Number(left.dataset.count) || left.dataset.title.localeCompare(right.dataset.title);
          }).forEach((row) => body.appendChild(row));
          if (rarityActive) {
            rarityActive.hidden = !selectedRarities.length;
            rarityActive.textContent = selectedRarities.length ? String(selectedRarities.length) : "";
          }
          if (status) {
            const parts = [];
            if (selectedShow) parts.push(selectedCount + " songs played at selected show");
            if (selectedType !== "all") parts.push(selectedType === "original" ? "Originals only" : "Covers only");
            if (selectedRarities.length) parts.push(visibleCount + " songs at selected rarity");
            status.textContent = parts.join(" · ");
          }
        };

        showFilter?.addEventListener("change", () => {
          selectedShow = showFilter.value;
          applyFilters();
        });
        typeButtons.forEach((typeButton) => typeButton.addEventListener("click", () => {
          selectedType = typeButton.dataset.typeFilter;
          typeButtons.forEach((item) => item.classList.toggle("is-active", item === typeButton));
          applyFilters();
        }));
        rarityOptions.forEach((box) => box.addEventListener("change", applyFilters));
        rarityClear?.addEventListener("click", () => {
          rarityOptions.forEach((box) => { box.checked = false; });
          applyFilters();
        });
        if (rarityFilter) document.addEventListener("click", (event) => {
          if (rarityFilter.open && !rarityFilter.contains(event.target)) rarityFilter.removeAttribute("open");
        });
        mobileSort?.addEventListener("change", () => {
          const key = mobileSort.value;
          const numeric = ["count", "rarity", "heat"].includes(key);
          const rows = [...body.rows].sort((left, right) => {
            const leftSelected = left.classList.contains("is-selected-show") ? 1 : 0;
            const rightSelected = right.classList.contains("is-selected-show") ? 1 : 0;
            const a = left.dataset[key] || "";
            const b = right.dataset[key] || "";
            const comparison = numeric ? Number(b) - Number(a) : a.localeCompare(b);
            return rightSelected - leftSelected || comparison || left.dataset.title.localeCompare(right.dataset.title);
          });
          rows.forEach((row) => body.appendChild(row));
        });
        buttons.forEach((button) => button.addEventListener("click", () => {
          const key = button.dataset.sort;
          const header = button.closest("th");
          const current = header.getAttribute("aria-sort");
          const direction = current === "ascending" ? "descending" : "ascending";
          const multiplier = direction === "ascending" ? 1 : -1;
          const numeric = ["count", "frequency", "l100", "rarity", "heat"].includes(key);
          const rows = [...body.rows].sort((left, right) => {
            const a = left.dataset[key] || "";
            const b = right.dataset[key] || "";
            const comparison = numeric ? Number(a) - Number(b) : a.localeCompare(b);
            return comparison * multiplier || left.dataset.title.localeCompare(right.dataset.title);
          });
          buttons.forEach((item) => {
            item.closest("th").removeAttribute("aria-sort");
            item.querySelector("span").textContent = "↕";
          });
          header.setAttribute("aria-sort", direction);
          button.querySelector("span").textContent = direction === "ascending" ? "↑" : "↓";
          rows.forEach((row) => body.appendChild(row));
        }));
      });`;
}

function renderSiteHeader(options = {}) {
  if (options.stagelight) return renderStagelightHeader(options.data);
  return `<header class="site-head">
  <div class="masthead-row">
    <a class="brand" href="/" aria-label="Burnthday">
      <img class="brand-logo" src="/assets/burnthday-logo.png" alt="Burnthday">
      <img class="brand-logo-sl" src="/assets/brand/burnthday-eater.svg" alt="" aria-hidden="true">
      <span class="brand-wordmark" aria-hidden="true">BURNTHDAY</span>
    </a>
    <nav class="header-social" aria-label="Burnthday social links">
      <a class="social-dot facebook" href="https://www.facebook.com/burnthday" aria-label="burnthday on Facebook">f</a>
      <a class="social-dot twitter" href="https://twitter.com/burnthday" aria-label="burnthday on Twitter">t</a>
    </nav>
  </div>
  ${renderNavLinks(primaryNavItems, "jump-links", "Primary navigation")}
  <details class="mobile-nav">
    <summary><span>MENU</span><span class="menu-icon" aria-hidden="true"><i></i><i></i><i></i></span></summary>
    ${renderNavLinks(primaryNavItems, "mobile-nav-links", "Primary navigation")}
  </details>
  <script>${renderNavigationScriptBody()}</script>
</header>`;
}

function renderStagelightHeader(data) {
  const featured = data?.setlists?.[0] || null;
  const nextShow = (data?.tourDates || []).find((entry) => !entry.isPosted && (!featured || entry.isoDate > featured.isoDate)) || null;
  const homeSubs = [
    ["Song Possibilities", "/#song-list"],
    ["Tour Stats", "/#tour-stats"],
    ["Setlists", "/#setlists"]
  ];
  const megaLinks = primaryNavItems.map(([text, href]) => {
    const link = `<a class="mega-link" href="${escapeAttr(href)}">${escapeHtml(text)}</a>`;
    if (text !== "Home") return link;
    return link + homeSubs.map(([label, anchor]) => `<a class="mega-sub" href="${escapeAttr(anchor)}">${escapeHtml(label)}</a>`).join("");
  }).join("");
  const latestCol = featured ? `<div class="mega-col">
      <div class="mega-col-head"><p class="mega-label">Latest Show</p><a class="mega-more" href="/#latest-setlist">View Setlist</a></div>
      <div class="mega-show">
        <time class="mega-show-date" datetime="${escapeAttr(featured.isoDate || "")}">${escapeHtml([weekdayName(featured.isoDate), featured.date].filter(Boolean).join(" · "))}</time>
        <p class="mega-show-city">${escapeHtml(featured.location)}</p>
        <p class="mega-show-venue">${escapeHtml(featured.venue)}</p>
        ${featured.streamUrl ? `<a class="sc-chip sc-chip-glass" href="${escapeAttr(featured.streamUrl)}">Listen at nugs.net</a>` : ""}
      </div>
      ${nextShow ? `<div class="mega-next">
        <p class="mega-label">Next Show</p>
        <p class="mega-next-line"><strong>${escapeHtml(nextShow.location)}</strong><span>${escapeHtml(nextShow.venue)} · ${escapeHtml(nextShow.date)}</span></p>
      </div>` : ""}
    </div>` : "";
  return `<header class="site-head" id="top">
  <a class="brand" href="/" aria-label="Burnthday">
    <img class="brand-logo-sl" src="/assets/brand/burnthday-eater.svg" alt="" aria-hidden="true">
    <span class="brand-wordmark" aria-hidden="true">Burnthday</span>
  </a>
  <div class="head-actions">
    <a class="head-cta" href="https://widespreadpanic.com/tour">Get Tickets</a>
    <button type="button" class="menu-toggle" aria-expanded="false" aria-controls="mega-menu" aria-label="Open menu">
      <span class="menu-icon" aria-hidden="true"><i></i><i></i></span>
    </button>
  </div>
</header>
<div class="mega-menu" id="mega-menu" hidden>
  <div class="mega-inner">
    <div class="mega-col mega-nav-col">
      <p class="mega-label">Navigation</p>
      <nav class="mega-nav" aria-label="Primary navigation">${megaLinks}</nav>
    </div>
    ${latestCol}
    <div class="mega-col">
      <p class="mega-label">Follow</p>
      <p class="mega-blurb">The working Widespread Panic song list, setlists, and tour data.</p>
      <nav class="mega-social" aria-label="Burnthday social links">
        <a href="https://www.facebook.com/burnthday">Facebook</a>
        <a href="https://twitter.com/burnthday">X</a>
        <a href="https://www.instagram.com/burnthday/">Instagram</a>
      </nav>
      <a class="mega-more" href="https://widespreadpanic.com/tour">Get Tickets</a>
    </div>
  </div>
</div>
<script>${renderStagelightHeaderScriptBody()}</script>`;
}

function renderStagelightHeaderScriptBody() {
  return `(() => {
    const head = document.querySelector(".site-head");
    const toggle = head.querySelector(".menu-toggle");
    const menu = document.getElementById("mega-menu");
    const setOpen = (open) => {
      menu.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      head.classList.toggle("menu-open", open);
      document.body.style.overflow = open ? "hidden" : "";
      if (open) head.classList.remove("is-hidden");
    };
    toggle.addEventListener("click", () => setOpen(menu.hidden));
    menu.addEventListener("click", (event) => {
      if (event.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) setOpen(false);
    });

    let lastY = window.scrollY;
    let ticking = false;
    window.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        if (menu.hidden) {
          if (y > lastY + 6 && y > 180) head.classList.add("is-hidden");
          else if (y < lastY - 6 || y <= 180) head.classList.remove("is-hidden");
        }
        lastY = y;
        ticking = false;
      });
    }, { passive: true });
  })();`;
}

function renderNavigationScriptBody() {
  return `(() => {
    const normalizePath = (value) => {
      const path = value.replace(/\\.html$/i, "").replace(/\\/$/, "") || "/";
      return path === "/index" ? "/" : path;
    };
    const currentPath = normalizePath(window.location.pathname);
    document.querySelectorAll(".jump-links a, .mobile-nav-links a").forEach((link) => {
      const linkPath = normalizePath(new URL(link.href, window.location.origin).pathname);
      if (link.origin === window.location.origin && linkPath === currentPath) link.setAttribute("aria-current", "page");
    });
  })();`;
}

function renderSiteFooter(data, options = {}) {
  const year = data?.site?.year || new Date().getFullYear();
  if (options.stagelight) {
    return `<footer class="site-foot">
  <div class="site-foot-inner">
    <div class="footer-lead">
      <a class="footer-brand" href="/"><img class="footer-mark" src="/assets/brand/burnthday-eater.svg" alt="" aria-hidden="true"><span>Burnthday</span></a>
      <p>The working Widespread Panic song list, setlists, and tour data.</p>
    </div>
    <nav class="footer-links" aria-label="Explore Burnthday">
      <strong>EXPLORE</strong>
      ${footerNavItems.map(([text, href]) => `<a href="${escapeAttr(href)}">${escapeHtml(text)}</a>`).join("")}
    </nav>
    <nav class="social-links" aria-label="Follow Burnthday">
      <strong>FOLLOW</strong>
      <a href="https://www.facebook.com/burnthday"><span class="social-mark facebook" aria-hidden="true">f</span><span>Facebook</span></a>
      <a href="https://twitter.com/burnthday"><span class="social-mark x" aria-hidden="true">X</span><span>X</span></a>
      <a href="https://www.instagram.com/burnthday/"><span class="social-mark instagram" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2"/><circle cx="17.2" cy="6.8" r="1.3" fill="currentColor"/></svg></span><span>Instagram</span></a>
    </nav>
    <div class="footer-bottom">
      <p class="footer-legal">© ${escapeHtml(String(year))} Burnthday. All rights reserved.<span aria-hidden="true">·</span>The Widespread Panic Spread Sheet</p>
      <a class="back-top" href="#top">Back to top <span aria-hidden="true">↑</span></a>
    </div>
  </div>
</footer>`;
  }
  return `<footer class="site-foot">
  <div class="site-foot-inner">
    <div class="footer-lead">
      <a class="footer-brand" href="/">BURNTHDAY</a>
      <p>The working Widespread Panic song list, setlists, and tour data.</p>
    </div>
    <nav class="footer-links" aria-label="Explore Burnthday">
      <strong>EXPLORE</strong>
      ${footerNavItems.map(([text, href]) => `<a href="${escapeAttr(href)}">${escapeHtml(text)}</a>`).join("")}
    </nav>
    <nav class="social-links" aria-label="Follow Burnthday">
      <strong>FOLLOW</strong>
      <a href="https://www.facebook.com/burnthday"><span class="social-mark facebook" aria-hidden="true">f</span><span>Facebook</span></a>
      <a href="https://twitter.com/burnthday"><span class="social-mark x" aria-hidden="true">X</span><span>X</span></a>
      <a href="https://www.instagram.com/burnthday/"><span class="social-mark instagram" aria-hidden="true"></span><span>Instagram</span></a>
    </nav>
    <p class="footer-legal">© ${escapeHtml(String(year))} Burnthday. All rights reserved.<span aria-hidden="true">·</span>The Widespread Panic Spread Sheet</p>
  </div>
</footer>`;
}

function renderNavLinks(items, className, label, withPipes = false) {
  const links = items.map(([text, href]) => `<a href="${escapeAttr(href)}">${escapeHtml(text)}</a>`);
  const html = withPipes ? links.join("<span>|</span>") : links.join("");
  return `<nav class="${escapeAttr(className)}" aria-label="${escapeAttr(label)}">${html}</nav>`;
}

function renderBoardIntro(data) {
  const catalog = data.catalog || [];
  const originals = catalog.filter((row) => (row.type || "").toLowerCase() === "original").length;
  const covers = catalog.filter((row) => (row.type || "").toLowerCase() === "cover").length;
  return `<div class="board-intro">
    <h2>Song Possibilities</h2>
    <p class="board-intro-sub">${formatNumber(catalog.length)} CATALOG · ${formatNumber(originals)} ORIGINALS · ${formatNumber(covers)} COVERS · ${formatNumber(data.totals.currentTourSongs)} PLAYED THIS TOUR</p>
  </div>`;
}

function renderRotationBoard(data) {
  return `<section class="laminate primary-board" id="song-list">
  ${renderPrimaryBoardHeader(data)}
	  ${renderSongPanel("rotation-originals", "ORIGINALS", data.boards.rotationOriginals)}
	  ${renderSongPanel("rotation-covers", "COVERS", data.boards.rotationCovers)}
</section>`;
}

function renderTourStats(data) {
  const shows = data.totals.postedSetlists;
  const plays = data.totals.currentTourPlays;
  const unique = data.totals.currentTourSongs;
  const average = shows ? (plays / shows).toFixed(1) : "0";
  const songs = [...(data.catalog || [])]
    .filter((song) => song.playedThisTour && song.tourCount > 0)
    .sort((left, right) => right.tourCount - left.tourCount || left.title.localeCompare(right.title));
  const showDatesBySong = new Map();
  for (const show of data.setlists || []) {
    const showSongs = new Set((show.sets || []).flatMap((set) => set.songTitles || splitDisplaySetSongs(set.songs)).map(normalizeTitle));
    for (const key of showSongs) {
      if (!showDatesBySong.has(key)) showDatesBySong.set(key, []);
      showDatesBySong.get(key).push(show.isoDate);
    }
  }

  return `<section class="tour-stats" id="tour-stats">
  <div class="section-heading data-heading">
    <h2>TOUR STATS</h2>
    <span>${escapeHtml(String(data.site.year))} through ${escapeHtml(data.site.latestShow?.date || "the latest posted show")}</span>
  </div>
  <div class="data-metrics" aria-label="Current tour summary">
    ${renderNickStat(shows, "shows played")}
    ${renderNickStat(unique, "unique songs")}
    ${renderNickStat(plays, "song plays")}
    ${renderNickStat(average, "songs per show")}
  </div>
  <div class="data-toolbar" aria-label="Tour Stats filters">
    <label class="show-filter"><span>Highlight a show</span><select data-show-filter>
      <option value="">All ${formatNumber(shows)} shows</option>
      ${(data.setlists || []).map((show) => `<option value="${escapeAttr(show.isoDate)}">${escapeHtml(`${show.date} · ${show.location}`)}</option>`).join("")}
    </select></label>
    <div class="type-filter" role="group" aria-label="Filter songs by type">
      <button type="button" class="is-active" data-type-filter="all">All</button>
      <button type="button" data-type-filter="original">Originals</button>
      <button type="button" data-type-filter="cover">Covers</button>
    </div>
    ${renderRarityFilter(songs)}
    <label class="mobile-sort"><span>Sort by</span><select data-mobile-sort><option value="count">Most played</option><option value="rarity">Rarest</option><option value="heat">Longest wait</option><option value="title">Song name</option></select></label>
    <span class="show-filter-status" aria-live="polite"></span>
  </div>
  <div class="tour-table-wrap">
    <table class="tour-table">
      <thead><tr>
        <th scope="col"><button type="button" data-sort="title">Song <span aria-hidden="true">↕</span></button></th>
        <th scope="col" aria-sort="descending"><button type="button" data-sort="count">Plays <span aria-hidden="true">↓</span></button></th>
        <th scope="col"><button type="button" data-sort="rarity">Rarity <span aria-hidden="true">↕</span></button></th>
        <th scope="col"><button type="button" data-sort="heat">Last / usual gap <span aria-hidden="true">↕</span></button></th>
        <th scope="col"><button type="button" data-sort="last">Last played <span aria-hidden="true">↕</span></button></th>
      </tr></thead>
      <tbody>${songs.map((song) => {
        const frequency = shows ? Math.round((song.tourCount / shows) * 100) : 0;
        const showDates = showDatesBySong.get(song.key) || [];
        const rarity = calculateRarity(song);
        const heat = calculateRotationHeat(song, shows);
        return `<tr data-title="${escapeAttr(song.title.toLowerCase())}" data-count="${escapeAttr(String(song.tourCount))}" data-frequency="${escapeAttr(String(frequency))}" data-l100="${escapeAttr(String(song.l100 || 0))}" data-rarity="${escapeAttr(String(rarity.sortValue))}" data-rarity-tier="${escapeAttr(rarity.tier)}" data-heat="${escapeAttr(String(heat.score))}" data-last="${escapeAttr(song.effectiveLastIso || "")}" data-type="${escapeAttr(song.type.toLowerCase())}" data-shows="${escapeAttr(showDates.join(","))}">
          <th scope="row">${escapeHtml(song.title)}</th>
          <td class="plays-cell">${formatNumber(song.tourCount)}</td>
          <td class="signal-cell rarity-cell"><strong><span class="rarity-symbol" aria-hidden="true">${renderRaritySymbol(rarity.tier)}</span>${escapeHtml(rarity.label)}</strong><small>${rarity.score == null ? "new this tour" : `${formatNumber(song.l100 || 0)} in last 100; ${formatNumber(song.total || 0)} ever`}</small></td>
          <td class="signal-cell heat-cell"><strong>${formatNumber(song.effectiveSlp)} ${song.effectiveSlp === 1 ? "show" : "shows"} ago</strong><small>usual gap ${heat.expectedGap.toFixed(1)} shows</small></td>
          <td>${escapeHtml(song.lastDisplay)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>
  </div>
  <details class="index-method">
    <summary>WHAT THESE MEAN</summary>
    <div><p><strong>Rarity</strong> is a simple tour-view badge for how unusual a song is right now: Common, Uncommon, Rare, Double Rare, Ultra Rare, or Hyper Rare. It is driven mostly by plays in the last 100 shows, with lifetime play count as a small tie-breaker. The numbers below the badge show the actual last-100 and lifetime counts. The symbols follow trading-card language: a black circle, diamond, or star; two black stars; two silver stars; three gold stars. A song new this tour gets an open star until it has history.</p><p><strong>Last / usual gap</strong> compares how many shows ago the song was last played with its recent average gap. It is context, not a prediction.</p></div>
  </details>
</section>`;
}

function calculateRarity(song) {
  if (song.seedTotal === 0) return { score: null, sortValue: 101, label: "New", tier: "new" };
  const recentScarcity = 1 - Math.min((song.l100 || 0) / 25, 1);
  const lifetimeScarcity = 1 - Math.min(Math.log10((song.total || 0) + 1) / 3, 1);
  const score = Math.round((recentScarcity * 0.9 + lifetimeScarcity * 0.1) * 100);
  const tier = score >= 95
    ? ["Hyper Rare", "hyper"]
    : score >= 85
      ? ["Ultra Rare", "ultra"]
      : score >= 70
        ? ["Double Rare", "double"]
        : score >= 50
          ? ["Rare", "rare"]
          : score >= 25
            ? ["Uncommon", "uncommon"]
            : ["Common", "common"];
  return { score, sortValue: score, label: tier[0], tier: tier[1] };
}

const RARITY_TIER_ORDER = [
  ["hyper", "Hyper Rare"],
  ["ultra", "Ultra Rare"],
  ["double", "Double Rare"],
  ["rare", "Rare"],
  ["uncommon", "Uncommon"],
  ["common", "Common"],
  ["new", "New"]
];

function renderRarityFilter(songs) {
  const counts = new Map();
  for (const song of songs) {
    const tier = calculateRarity(song).tier;
    counts.set(tier, (counts.get(tier) || 0) + 1);
  }
  const options = RARITY_TIER_ORDER.filter(([tier]) => counts.get(tier)).map(([tier, label]) => `<label class="rf-option">
      <input type="checkbox" value="${tier}" data-rarity-option>
      <span class="rarity-symbol" aria-hidden="true">${renderRaritySymbol(tier)}</span>
      <span class="rf-label">${escapeHtml(label)}</span>
      <span class="rf-count">${formatNumber(counts.get(tier))}</span>
    </label>`).join("");
  return `<details class="rarity-filter" data-rarity-filter>
    <summary><span>Rarity</span><b class="rf-active" data-rarity-active hidden></b><svg class="sc-chev" width="12" height="8" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
    <div class="rarity-pop">
      ${options}
      <button type="button" class="rf-clear" data-rarity-clear>Clear rarity filter</button>
    </div>
  </details>`;
}

const RARITY_INK = "#111111";
const RARITY_SILVER = "#a6a5a1";
const RARITY_GOLD = "#d4a017";
const RARITY_STAR_POINTS = "10,0.5 12.23,6.93 19.03,7.06 13.61,11.17 15.58,17.69 10,13.8 4.42,17.69 6.39,11.17 0.97,7.06 7.77,6.93";

function renderRaritySymbol(tier) {
  const star = (x, y, fill) => `<polygon points="${RARITY_STAR_POINTS}" fill="${fill}" transform="translate(${x} ${y})"/>`;
  if (tier === "common") return `<svg class="rarity-common" viewBox="0 0 20 19"><circle cx="10" cy="9.5" r="8" fill="${RARITY_INK}"/></svg>`;
  if (tier === "uncommon") return `<svg class="rarity-uncommon" viewBox="0 0 20 19"><polygon points="10,1 18.5,9.5 10,18 1.5,9.5" fill="${RARITY_INK}"/></svg>`;
  if (tier === "rare") return `<svg class="rarity-rare" viewBox="0 0 20 19">${star(0, 0, RARITY_INK)}</svg>`;
  if (tier === "double") return `<svg class="rarity-double" viewBox="0 0 42 19">${star(0, 0, RARITY_INK)}${star(22, 0, RARITY_INK)}</svg>`;
  if (tier === "ultra") return `<svg class="rarity-ultra" viewBox="0 0 42 19">${star(0, 0, RARITY_SILVER)}${star(22, 0, RARITY_SILVER)}</svg>`;
  if (tier === "hyper") return `<svg class="rarity-hyper" viewBox="0 0 42 30.5">${star(11, 0, RARITY_GOLD)}${star(0, 11.5, RARITY_GOLD)}${star(22, 11.5, RARITY_GOLD)}</svg>`;
  return `<svg class="rarity-new" viewBox="-1.5 -1.5 23 22"><polygon points="${RARITY_STAR_POINTS}" fill="none" stroke="${RARITY_INK}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

function calculateRotationHeat(song, shows) {
  const tourRate = shows ? song.tourCount / shows : 0;
  const recentRate = (song.l100 || 0) / 100;
  const rate = song.seedTotal === 0
    ? tourRate
    : tourRate > 0 && recentRate > 0
      ? tourRate * 0.6 + recentRate * 0.4
      : Math.max(tourRate, recentRate);
  const expectedGap = rate > 0 ? 1 / rate : Math.max(shows, 1);
  const ratio = expectedGap > 0 ? song.effectiveSlp / expectedGap : 0;
  const score = Math.round(ratio * 100);
  const label = ratio > 1.15
    ? "Past its usual gap"
    : ratio >= 0.85
      ? "Around its usual gap"
      : ratio >= 0.45
        ? "Earlier than usual"
        : "Recently played";
  return { expectedGap, score, label };
}

function renderBentoCard(key, label, count, desc, extra) {
  return `<button type="button" class="bento-card bento-${key}" id="${key}" data-bento="${key}" aria-expanded="false" aria-controls="bento-panel-${key}">
    <span class="bc-open" aria-hidden="true">+</span>
    <span class="bc-name">${escapeHtml(label)}</span>
    <span class="bc-count">${formatNumber(count)}<small>SONGS</small></span>
    <span class="bc-desc">${escapeHtml(desc)}</span>
    ${extra}
  </button>`;
}

function bentoFact(left, right) {
  return `<span class="bc-fact"><span>${escapeHtml(left)}</span><span>${escapeHtml(right)}</span></span>`;
}

function renderBentoPanel(key, label, sheet) {
  return `<div class="bento-panel" id="bento-panel-${key}" hidden role="dialog" aria-modal="true" aria-label="${escapeAttr(label)} sheet">
    <button type="button" class="bento-close" data-bento-close aria-label="Close ${escapeAttr(label)}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 2.5 13.5 13.5M13.5 2.5 2.5 13.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
    ${sheet}
  </div>`;
}

function renderSheetBentos(data) {
  const shelfRows = [...(data.boards.shelfOriginals || []), ...(data.boards.shelfCovers || [])];
  const purgRows = [...(data.boards.purgatoryOriginals || []), ...(data.boards.purgatoryCovers || [])];
  const woodCount = (data.boards.woodshedOriginals?.length || 0) + (data.boards.woodshedCovers?.length || 0);
  const rotationCount = (data.boards.rotationOriginals?.length || 0) + (data.boards.rotationCovers?.length || 0);
  const cleared = Math.max(0, rotationCount - woodCount);
  const clearedPct = rotationCount ? Math.round((cleared / rotationCount) * 100) : 0;
  const topShelf = [...shelfRows].filter((row) => row.total).sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 2);
  const purgSample = purgRows.slice(0, 2);

  const shelfFacts = topShelf.map((row) => bentoFact(row.title.toUpperCase(), `${formatNumber(row.total)} PLAYS · LAST ${row.lastDisplay || ""}`)).join("");
  const purgFacts = purgSample.map((row) => bentoFact(row.title.toUpperCase(), `ONE PLAY${row.lastDisplay ? ` · ${row.lastDisplay}` : ""}`)).join("");
  const woodExtra = `<span class="bc-bar" aria-hidden="true"><i style="width:${clearedPct}%"></i></span>${bentoFact(`${formatNumber(cleared)} OF ${formatNumber(rotationCount)} CLEARED`, `${clearedPct}%`)}`;

  const shelf = `<section class="laminate shelf-board" id="shelf-sheet">
  ${renderBoardHeader("THE SHELF")}
  ${renderSongPanel("shelf-originals", "ORIGINALS", data.boards.shelfOriginals, { shelfMode: true, columns: 3 })}
  ${renderSongPanel("shelf-covers", "COVERS", data.boards.shelfCovers, { shelfMode: true, columns: 3 })}
</section>`;
  const purgatory = `<section class="laminate purgatory-board" id="purgatory-sheet">
  ${renderBoardHeader("PURGATORY")}
  ${renderSongPanel("purgatory-originals", "ORIGINALS", data.boards.purgatoryOriginals, { shelfMode: true, columns: 3 })}
  ${renderSongPanel("purgatory-covers", "COVERS", data.boards.purgatoryCovers, { shelfMode: true, columns: 3 })}
</section>`;
  const woodshed = `<section class="laminate woodshed-board" id="woodshed-sheet">
  ${renderBoardHeader("THE WOODSHED")}
  ${renderSongPanel("woodshed-originals", "ORIGINALS", data.boards.woodshedOriginals, { shelfMode: true, woodshedMode: true, columns: 3 })}
  ${renderSongPanel("woodshed-covers", "COVERS", data.boards.woodshedCovers, { shelfMode: true, woodshedMode: true, columns: 3 })}
</section>`;

  return `<div class="bento-grid" aria-label="Sheet key and reference sheets">
    ${renderSheetKey(data)}
    ${renderBentoCard("shelf", "The Shelf", shelfRows.length, "Not played in 200 shows — off the sheet, not forgotten.", shelfFacts)}
    ${renderBentoCard("purgatory", "Purgatory", purgRows.length, "Played once, ever — waiting on a second life.", purgFacts)}
    ${renderBentoCard("woodshed", "The Woodshed", woodCount, "On the current sheet, not yet played with Nick.", woodExtra)}
  </div>
  ${renderBentoPanel("shelf", "The Shelf", shelf)}
  ${renderBentoPanel("purgatory", "Purgatory", purgatory)}
  ${renderBentoPanel("woodshed", "The Woodshed", woodshed)}
  <script>
    (() => {
      const cards = document.querySelectorAll("[data-bento]");
      const panels = document.querySelectorAll(".bento-panel");
      const closeAll = () => {
        panels.forEach((panel) => { panel.hidden = true; });
        cards.forEach((card) => card.setAttribute("aria-expanded", "false"));
        document.body.style.overflow = "";
      };
      cards.forEach((card) => card.addEventListener("click", () => {
        const wasOpen = card.getAttribute("aria-expanded") === "true";
        closeAll();
        if (!wasOpen) {
          card.setAttribute("aria-expanded", "true");
          const panel = document.getElementById("bento-panel-" + card.getAttribute("data-bento"));
          if (panel) { panel.hidden = false; document.body.style.overflow = "hidden"; }
        }
      }));
      panels.forEach((panel) => panel.addEventListener("click", (event) => {
        if (event.target === panel || event.target.closest("[data-bento-close]")) closeAll();
      }));
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeAll();
      });
    })();
  </script>`;
}

function renderShelfWatch(data) {
  const songs = data.boards.shelfWatch || [];
  if (!songs.length) return "";

  const cutoff = data.rules.rotationSlpLimit;
  return `<section class="shelf-watch" id="shelf-watch">
  <div class="section-heading data-heading">
    <h2>SHELF WATCH</h2>
    <span>songs nearing the ${escapeHtml(String(cutoff))}-show cutoff</span>
  </div>
  <div class="shelf-grid">${songs.map((song) => {
    const remaining = Math.max(0, cutoff - song.effectiveSlp);
    const heat = remaining <= 5 ? "heat-hot" : remaining <= 12 ? "heat-warm" : "heat-cool";
    return `<div class="shelf-card ${heat}" data-song-title="${escapeAttr(song.title)}" data-slp="${escapeAttr(String(song.effectiveSlp))}">
      <p class="n">${formatNumber(remaining)}</p><p class="to">to The Shelf</p>
      <p class="song">${escapeHtml(song.title)}</p>
      <p class="slp">SLP ${formatNumber(song.effectiveSlp)} · LAST ${escapeHtml(song.lastDisplay)}</p>
    </div>`;
  }).join("")}</div>
  <p class="shelf-note">SLP — shows since last play. At ${escapeHtml(String(cutoff))}, a song goes to The Shelf.</p>
</section>`;
}

function renderNickJohnsonFeature(data) {
  const rotation = (data.catalog || [])
    .filter((row) => row.effectiveSlp < data.rules.rotationSlpLimit || row.playedThisTour)
    .sort((left, right) => right.nickCount - left.nickCount || left.title.localeCompare(right.title));
  const played = rotation.filter((row) => row.nickCount > 0);
  const featuredSongs = played.slice(0, 10);
  const remainingSongs = rotation.slice(featuredSongs.length);
  const shows = (data.setlists || []).filter(isNickJohnsonShow).length;
  const plays = sum(played.map((row) => row.nickCount));
  const woodshed = data.boards.woodshedOriginals.length + data.boards.woodshedCovers.length;
  const completion = rotation.length ? Math.round((played.length / rotation.length) * 100) : 0;
  const originals = rotation.filter((row) => row.type === "Original");
  const covers = rotation.filter((row) => row.type === "Cover");
  const playedOriginals = originals.filter((row) => row.nickCount > 0).length;
  const playedCovers = covers.filter((row) => row.nickCount > 0).length;
  const originalWidth = rotation.length ? (playedOriginals / rotation.length) * 100 : 0;
  const coverWidth = rotation.length ? (playedCovers / rotation.length) * 100 : 0;

  return `<section class="nick-feature" id="nick-johnson">
  <details class="nick-disclosure" open>
  <summary class="section-heading data-heading">
    <h2>NICK STATS</h2>
    <span>${escapeHtml(String(data.site.year))} tour</span>
  </summary>
  <div class="nick-feature-body">
  <div class="data-metrics nick-summary" aria-label="Nick Johnson tour stats">
    ${renderNickStat(shows, "shows on guitar")}
    ${renderNickStat(played.length, "unique songs")}
    ${renderNickStat(plays, "song plays")}
    ${renderNickStat(woodshed, "still in The Woodshed")}
  </div>
  <div class="nick-progress" aria-label="${completion}% of current song possibilities played with Nick Johnson">
    <div><strong>${completion}%</strong><span>of current Song Possibilities played with Nick</span></div>
    <span class="nick-progress-track"><i class="is-original" style="width:${originalWidth}%"></i><i class="is-cover" style="width:${coverWidth}%"></i></span>
    <div class="progress-key"><span><i class="key-original"></i>Originals ${formatNumber(playedOriginals)}/${formatNumber(originals.length)}</span><span><i class="key-cover"></i>Covers ${formatNumber(playedCovers)}/${formatNumber(covers.length)}</span><span><i class="key-unplayed"></i>${formatNumber(played.length)}/${formatNumber(rotation.length)} overall</span></div>
  </div>
  <div class="nick-ranking-heading"><h3>MOST PLAYED WITH NICK</h3><span>plays per show</span></div>
  ${renderNickRanking(featuredSongs)}
  ${remainingSongs.length ? `<details class="nick-played-panel">
    <summary><span>VIEW ALL SONGS, INCLUDING ZERO PLAYS</span><strong>${formatNumber(remainingSongs.length)}</strong></summary>
    ${renderNickRanking(remainingSongs, { start: featuredSongs.length + 1, compact: true })}
  </details>` : ""}
  </div>
  </details>
</section>`;
}

function renderNickStat(value, label) {
  return `<div class="nick-stat"><strong>${formatNumber(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderNickRanking(songs, options = {}) {
  const start = options.start || 1;
  const classes = options.compact ? "nick-ranking is-compact" : "nick-ranking";
  return `<ol class="${classes}" start="${start}">${songs.map((song, index) => `<li class="${song.nickCount === 0 ? "is-zero" : ""}" value="${start + index}" data-song-title="${escapeAttr(song.title)}" data-nick-count="${escapeAttr(String(song.nickCount))}">
    <span class="nick-rank" aria-hidden="true">${start + index}</span>
    <span class="nick-song"><strong>${escapeHtml(song.title.toUpperCase())}</strong><small>${escapeHtml(song.type)}</small></span>
    <span class="nick-plays"><strong>${formatNumber(song.nickCount)}</strong><small>${song.nickCount === 1 ? "play" : "plays"}</small></span>
  </li>`).join("")}</ol>`;
}

function renderSheetKey(data) {
  return `<section class="bento-card bento-key sheet-key" id="sheet-key">
    <div class="key-strip">
      <div class="key-head">
        <h2>SHEET KEY</h2>
        <p>Marker color identifies the most recent shows on the sheet.</p>
      </div>
      ${renderMarkerLegend(data.site.markerLegend)}
    </div>
    <details class="key-more">
    <summary><span>What everything on the sheets means</span><svg class="sc-chev" width="12" height="8" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
    <div class="key-topline">
      <section class="key-block key-song-list">
        <h3>Song List</h3>
        <p>The main sheet shows originals and covers active for the ${escapeHtml(String(data.site.year))} tour.</p>
        <ul class="key-points">
          <li><strong>Tiny Number</strong><span>Times played this tour.</span></li>
          <li><strong>Marker</strong><span>Played during one of the last four shows.</span></li>
        </ul>
      </section>
      <section class="key-block key-marker">
        <h3>Marker Colors</h3>
        <p>On the Song List, colors show which recent show the song was played at.</p>
        <p>On Shelf and Purgatory, black means the song came off that sheet this tour.</p>
      </section>
      <section class="key-block key-other-sheets">
        <h3>Other Sheets</h3>
        <dl>
          <div><dt>Shelf</dt><dd>Songs outside the rotation window, with lifetime count and last-played date.</dd></div>
          <div><dt>Shelf Watch</dt><dd>Songs within ${escapeHtml(String(data.rules.shelfWatchWindow))} shows of the ${escapeHtml(String(data.rules.rotationSlpLimit))}-show Shelf cutoff.</dd></div>
          <div><dt>Purgatory</dt><dd>One-timers, with lifetime count and last-played date.</dd></div>
          <div><dt>The Woodshed</dt><dd>Songs on the current sheet not yet played with Nick Johnson on guitar.</dd></div>
        </dl>
      </section>
    </div>
  </details>
</section>`;
}

function renderMarkerLegend(items = []) {
  if (!items.length) return "";
  return `<ol class="marker-legend">${items.map((item) => `<li><img src="/assets/${escapeAttr(item.asset)}" alt=""><span><strong>${escapeHtml(item.color)}</strong><em>${escapeHtml(item.label)}</em></span></li>`).join("")}</ol>`;
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
  const title = formatBoardShowTitle(data.site.boardShow) || latest?.location || data.site.title;

  return `<div class="header-row primary-header">
    <div class="nums left">
      <img alt="1" class="marker-num" src="/assets/marker-1.png">
      <img alt="2" class="marker-num" src="/assets/marker-2.png">
    </div>
    <div class="board-title">
      <h1>${escapeHtml(title.toUpperCase())}</h1>
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
  return `<section class="song-panel" id="${escapeAttr(id)}">
    <h3>${escapeHtml(label)}</h3>
    ${renderSongGrid(rows, options)}
  </section>`;
}

function renderSong(row, options = {}) {
  const stripeAsset = options.shelfMode && !options.woodshedMode && (row.playedFromShelf || row.playedFromPurgatory) ? "marker-black.png" : row.stripeAsset;
  const shelfDate = row.playedFromShelf || row.playedFromPurgatory ? displayDate(row.seedLast) : row.lastDisplay;
  const dateText = options.shelfMode ? shelfDate : row.isAddOn ? row.addOnDate || row.lastDisplay : "";
  const handClass = row.isAddOn ? " hand-addon" : "";
  const title = row.title.toUpperCase();
  const countValue = options.nickMode ? row.nickCount : options.shelfMode ? row.total : row.tourCount;
  const songClasses = ["rotation-song", dateText ? "has-date" : "", countValue > 0 ? "has-count" : "", row.isAddOn ? "is-hand-addon" : ""].filter(Boolean).join(" ");
  const marker = stripeAsset ? `<span class="marker-mask"><img class="marker-img" src="/assets/${escapeAttr(stripeAsset)}" alt=""></span>` : "";
  const count = countValue > 0 ? `<sup>${countValue}</sup>` : "";
  const date = dateText ? `<span class="date-sup${row.isAddOn ? " add-on-date" : ""}">${row.isAddOn ? `(${escapeHtml(dateText)})` : escapeHtml(dateText)}</span>` : "";

  return `<span class="${songClasses}" title="${escapeAttr(title)}"><span class="marker-wrap"><span class="marker-target"><span class="marker-text${handClass}">${escapeHtml(title)}</span>${marker}</span>${count}</span>${date}</span>`;
}

function renderLatestSetlist(data) {
  const posted = data.setlists || [];
  const featured = posted[0];
  if (!featured) return "";
  const run = [];
  for (const show of posted) {
    if (show.venue === featured.venue && show.location === featured.location) run.push(show);
    else break;
  }
  const completedRunShows = run.slice(1);
  return `<section class="latest-setlist" id="latest-setlist">
  ${renderShowCard(data, featured, { latest: true, open: true, priority: true })}
  ${completedRunShows.length ? `<div class="current-stop-setlists">${completedRunShows.map((show) => renderShowCard(data, show, { lazy: true })).join("")}</div>` : ""}
  ${renderNextShowStrip(data, featured)}
</section>`;
}

function renderNextShowStrip(data, featured) {
  const preview = data.site.isShowDayPreview ? data.site.featuredShow : null;
  const upcoming = preview || (data.tourDates || []).find((entry) => !entry.isPosted && entry.isoDate > (featured?.isoDate || ""));
  if (!upcoming) return "";
  const iso = upcoming.isoDate || "";
  const dow = weekdayName(iso).slice(0, 3).toUpperCase();
  return `<details class="next-strip">
    <summary>
      <span class="ns-row">
        <span class="ns-lead">
          <span class="ns-tag">${preview ? "Tonight" : "Next Show"}</span>
          <span class="ns-city">${escapeHtml(upcoming.location)}</span>
          <span class="ns-venue">${escapeHtml(upcoming.venue)}</span>
        </span>
        <span class="ns-meta">
          <time class="ns-date" datetime="${escapeAttr(iso)}">${escapeHtml(dow)} · ${escapeHtml(upcoming.date)}</time>
          <span class="sc-chip sc-chip-glass"><span class="live-dot" aria-hidden="true"></span> nugs.net livestream</span>
        </span>
      </span>
      <svg class="sc-chev" width="14" height="9" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </summary>
    <div class="ns-body">
      ${upcoming.image ? `<figure class="ns-photo"><img src="${escapeAttr(upcoming.image)}" alt="${escapeAttr(`${upcoming.date} ${upcoming.location}`)}" loading="lazy" decoding="async"></figure>` : ""}
      <p class="sc-preview-note">The setlist posts here after the show, verified against the official page.</p>
      ${upcoming.sourceUrl ? `<a class="sc-chip sc-chip-glass" href="${escapeAttr(upcoming.sourceUrl)}">Show Details</a>` : ""}
    </div>
  </details>`;
}

function weekdayName(isoDate) {
  if (!isoDate) return "";
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()];
}

function computeShowPulls(data, show) {
  const byKey = new Map((data.catalog || []).map((row) => [row.key, row]));
  const titles = [...new Set((show.sets || []).flatMap((set) => set.songTitles || []))];
  const pulls = titles
    .map((title) => ({ title, row: byKey.get(normalizeTitle(title)) }))
    .filter((entry) => entry.row)
    .map((entry) => ({ ...entry, rarity: calculateRarity(entry.row) }))
    .filter((entry) => entry.rarity.score != null && entry.rarity.score >= 70)
    .sort((left, right) => right.rarity.score - left.rarity.score);
  const groups = [];
  for (const pull of pulls) {
    let group = groups.find((entry) => entry.label === pull.rarity.label);
    if (!group) { group = { label: pull.rarity.label, tier: pull.rarity.tier, songs: [] }; groups.push(group); }
    group.songs.push(pull.title);
  }
  return groups;
}

function renderShowPulls(groups) {
  if (!groups.length) return "";
  return `<div class="sc-row sc-pulls"><span class="sc-label">Pulls</span><span class="sc-pull-list">${groups.map((group) =>
    `<span class="sc-pull">${renderRaritySymbol(group.tier)}<span class="sc-tier">${escapeHtml(group.label)}</span> ${group.songs.map((song) => `<b>${escapeHtml(song)}</b>`).join(", ")}</span>`
  ).join("")}</span></div>`;
}

function renderShowCard(data, show, options = {}) {
  const annotations = buildSetlistAnnotations(show);
  const sets = (show.sets || []).filter((set) => (set.songTitles && set.songTitles.length) || clean(set.songs));
  const hasSetlist = sets.length > 0;
  const iso = show.isoDate || "";
  const weekday = weekdayName(iso);
  let venueLine = show.venue;
  try {
    const run = tourRunInfo(data.tourDates || [], show);
    if (run && run.length > 1) venueLine = `${show.venue} · Night ${run.number}`;
  } catch {}
  const longDate = formatLongDate(iso || show.date);
  const heading = options.latest ? "h3" : "h4";
  const ariaHeading = escapeAttr(formatSetlistHeading(show));
  const chips = [
    show.streamUrl ? `<a class="sc-chip sc-chip-primary" href="${escapeAttr(show.streamUrl)}" aria-label="Listen to ${ariaHeading} at Nugs.net"><svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><path d="M1.5 1.2c0-.66.72-1.07 1.29-.73l8 4.8a.85.85 0 0 1 0 1.46l-8 4.8A.85.85 0 0 1 1.5 10.8V1.2Z" fill="currentColor"/></svg>nugs.net</a>` : "",
    show.sourceUrl ? `<a class="sc-chip sc-chip-glass" href="${escapeAttr(show.sourceUrl)}" aria-label="${hasSetlist ? "Official setlist and photos" : "Show details"} for ${ariaHeading}">${hasSetlist ? "Photos" : "Show Details"}</a>` : ""
  ].filter(Boolean).join("");
  const setRows = sets.map((set) => `<div class="sc-row"><span class="sc-label">${escapeHtml(formatSetLabel(set.label))}</span><p class="sc-prose">${renderSetSongs(set, annotations)}</p></div>`).join("");
  const notes = (annotations.guestNotes.length || annotations.bracketNotes.length)
    ? `<div class="sc-row sc-notes"><span class="sc-label" aria-hidden="true"></span><div class="setlist-annotations">${renderSetlistGuestNotes(annotations)}${renderSetlistNotes(annotations)}</div></div>`
    : "";
  const pullGroups = hasSetlist ? computeShowPulls(data, show) : [];
  const pullsRow = renderShowPulls(pullGroups);
  const pullCount = sum(pullGroups.map((group) => group.songs.length));
  const miniPulls = pullGroups.length
    ? `<span class="sc-mini-pulls">${renderRaritySymbol(pullGroups[0].tier)}<b>${escapeHtml(pullGroups[0].songs[0])}</b>${pullCount > 1 ? `<span class="sc-more">+${pullCount - 1} MORE</span>` : ""}</span>`
    : "";
  const previewNote = hasSetlist ? "" : `<div class="sc-row"><span class="sc-label" aria-hidden="true"></span><p class="sc-preview-note">The setlist posts here after the show, verified against the official page.</p></div>`;
  const body = setRows || previewNote || pullsRow || notes
    ? `<div class="sc-body"><div class="sc-sets">${setRows}${notes}${previewNote}${pullsRow}</div></div>`
    : "";
  const loading = options.lazy ? ' loading="lazy"' : "";
  const priority = options.priority ? ' fetchpriority="high"' : "";
  const photo = show.image
    ? `<span class="sc-photo"><img src="${escapeAttr(show.image)}" alt="${escapeAttr(`${show.date} ${show.location}`)}" decoding="async"${loading}${priority}></span>`
    : "";
  const bg = show.image ? `<span class="sc-bg" aria-hidden="true"><img src="${escapeAttr(show.image)}" alt="" loading="lazy" decoding="async"></span>` : "";
  return `<details class="show-entry${options.latest ? " is-latest" : ""}${show.image ? "" : " no-image"}"${options.latest || options.open ? " open" : ""}>
    <summary>
      ${bg}
      <span class="sc-closed">
        <time class="sc-date" datetime="${escapeAttr(iso)}">${escapeHtml(show.date)}</time>
        <span class="sc-place"><strong>${escapeHtml(show.location)}</strong><small>${escapeHtml(venueLine)}</small></span>
        ${miniPulls}
      </span>
      <span class="sc-lockup">
        <span class="sc-lock">
          <time class="sc-eyebrow" datetime="${escapeAttr(iso)}">${escapeHtml([weekday, longDate].filter(Boolean).join(" · "))}</time>
          <${heading} class="sc-city">${escapeHtml(show.location)}</${heading}>
          <span class="sc-venue">${escapeHtml(venueLine)}</span>
          ${chips ? `<span class="sc-chips">${chips}</span>` : ""}
        </span>
        ${photo}
      </span>
      <svg class="sc-chev" width="14" height="9" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </summary>
    ${body}
  </details>`;
}

function renderSetlists(data, options = {}) {
  const featuredRunDates = options.skipFeaturedRun
    ? new Set(data.site.featuredRunDates || [])
    : new Set();
  const setlists = data.setlists.filter((show) => !featuredRunDates.has(show.isoDate));
  const postedLabel = featuredRunDates.size ? `${setlists.length} older posted` : `${data.totals.postedSetlists} posted`;
  const upcomingDates = (data.tourDates || []).filter((date) => !date.isPosted);
  const upcomingBlock = upcomingDates.length ? `<div class="upcoming-dates" id="tour-dates">
    <div class="upcoming-heading"><h3>UPCOMING</h3><span>${formatNumber(upcomingDates.length)} shows ahead</span></div>
    <ol class="tour-dates">
      ${upcomingDates.map((date) => `<li class="is-upcoming">
        <time>${escapeHtml(date.date)}</time>
        <strong>${escapeHtml(date.location)}</strong>
        <span>${escapeHtml(date.venue)}</span>
        <em>Upcoming</em>
      </li>`).join("")}
    </ol>
  </div>` : "";
  return `<section class="setlist-section" id="setlists">
  <div class="section-heading">
    <h2>${escapeHtml(String(data.site.year))} SETLISTS</h2>
    <span>${escapeHtml(postedLabel)}</span>
  </div>
  <details class="setlist-archive-panel" open>
    <summary><span>VIEW OLDER SETLISTS</span><strong>${formatNumber(setlists.length)}</strong></summary>
    <div class="setlist-list">
      ${setlists.map((show) => renderShowCard(data, show, { lazy: true })).join("")}
    </div>
  </details>
  ${upcomingBlock}
</section>`;
}

function renderFeaturedSetlist(show, options = {}) {
  const imageClass = show.image ? "" : " no-image";
  return `<article class="setlist-feature${imageClass}">
    ${renderSetlistImage(show, options)}
    <div class="setlist-copy">
      ${renderSetlistText(show)}
    </div>
  </article>`;
}

function renderSetlistCard(show, options = {}) {
  const imageClass = show.image ? "" : " no-image";
  return `<article class="setlist-card${imageClass}">
    ${renderSetlistImage(show, options)}
    ${renderSetlistText(show)}
  </article>`;
}

function renderSetlistRow(show, options = {}) {
  const hasPostedSetlist = (show.sets || []).some((set) => (set.songTitles || []).length || clean(set.songs));
  const actionLinks = [
    show.sourceUrl ? `<a class="show-action details-action" href="${escapeAttr(show.sourceUrl)}" aria-label="${hasPostedSetlist ? "Official setlist and photos" : "Show details"} for ${escapeAttr(formatSetlistHeading(show))}">${hasPostedSetlist ? "Photos" : "Details"}</a>` : "",
    show.streamUrl ? `<a class="show-action play-action" href="${escapeAttr(show.streamUrl)}" aria-label="Listen to ${escapeAttr(formatSetlistHeading(show))} at Nugs.net"><span aria-hidden="true">▶</span></a>` : ""
  ].filter(Boolean).join("");
  return `<details class="setlist-row">
    <summary>
      <time datetime="${escapeAttr(show.isoDate)}">${escapeHtml(show.date)}</time>
      <span class="show-place"><strong>${escapeHtml(show.venue)}</strong><small>${escapeHtml(show.location)}</small></span>
      <span class="show-actions">${actionLinks}</span>
      <span class="row-toggle" aria-hidden="true"></span>
    </summary>
    <div class="setlist-row-body">
      ${renderSetlistImage(show, options)}
      <div class="setlist-copy">${renderSetlistText(show, { hideHeading: true, hideLinks: true })}</div>
    </div>
  </details>`;
}

function renderSetlistImage(show, options = {}) {
  if (!show.image) return "";
  const loading = options.lazy ? ' loading="lazy"' : "";
  const priority = options.priority ? ' fetchpriority="high"' : "";
  return `<figure class="setlist-image"><img src="${escapeAttr(show.image)}" alt="${escapeAttr(`${show.date} ${show.location}`)}" decoding="async"${loading}${priority}></figure>`;
}

function renderSetlistText(show, options = {}) {
  const annotations = buildSetlistAnnotations(show);
  const hasPostedSetlist = (show.sets || []).some((set) => (set.songTitles || []).length || clean(set.songs));
  const links = [
    show.sourceUrl ? `<a href="${escapeAttr(show.sourceUrl)}">${hasPostedSetlist ? "Official Setlist &amp; Photos" : "Show Details"}</a>` : "",
    show.streamUrl ? `<a href="${escapeAttr(show.streamUrl)}">Listen at Nugs.net</a>` : ""
  ].filter(Boolean).join("");
  return `<div class="setlist-text">
    ${options.hideHeading ? "" : renderFeaturedShowHeading(show)}
    <div class="setlist-sets">${(show.sets || []).filter((set) => (set.songTitles && set.songTitles.length) || clean(set.songs)).map((set) => `<p><strong>${escapeHtml(formatSetLabel(set.label))}:</strong> ${renderSetSongs(set, annotations)}</p>`).join("")}</div>
    ${(annotations.guestNotes.length || annotations.bracketNotes.length) ? `<div class="setlist-annotations">${renderSetlistGuestNotes(annotations)}${renderSetlistNotes(annotations)}</div>` : ""}
    ${links && !options.hideLinks ? `<p class="setlist-links">${links}</p>` : ""}
  </div>`;
}

function renderFeaturedShowHeading(show) {
  return `<header class="show-heading">
    <time datetime="${escapeAttr(show.isoDate)}">${escapeHtml(formatLongDate(show.isoDate || show.date))}</time>
    <h3>${escapeHtml(show.location || [show.city, show.state].filter(Boolean).join(", "))}</h3>
    <p>${escapeHtml(show.venue)}</p>
  </header>`;
}

function formatSetLabel(label) {
  const value = clean(label).replace(/:$/, "");
  if (value === "1") return "Set 1";
  if (value === "2") return "Set 2";
  if (/^E$/i.test(value)) return "Encore";
  return value;
}

function formatSetlistHeading(show) {
  const place = [show.venue, show.location].filter(Boolean).join(", ");
  return [show.date, place].filter(Boolean).join(" ");
}

function buildSetlistAnnotations(show) {
  const guestNotes = [];
  const bracketNotes = [];
  const songTitles = [...new Set((show.sets || []).flatMap((set) => set.songTitles || splitDisplaySetSongs(set.songs)))];
  const inlineMarkers = collectInlineGuestMarkers(show);
  const markersBySong = new Map([...inlineMarkers.markersBySong].map(([key, markers]) => [key, [...markers]]));
  const reservedMarkers = new Set(inlineMarkers.allMarkers);
  const claimedMarkers = new Set();

  for (const note of show.notes || []) {
    const numberedGuests = parseNumberedGuestNotes(note);
    if (numberedGuests.length) {
      for (const guest of numberedGuests) {
        guestNotes.push(guest);
        claimedMarkers.add(guest.marker);
        reservedMarkers.add(guest.marker);
      }
      continue;
    }

    const guest = parseGuestNote(note, songTitles);
    if (guest) {
      const matchingInlineMarkers = [...new Set(guest.songKeys.flatMap((key) => markersBySong.get(key) || []))]
        .filter((marker) => !claimedMarkers.has(marker));
      const marker = matchingInlineMarkers.length === 1
        ? matchingInlineMarkers[0]
        : nextGuestMarker(reservedMarkers);

      guestNotes.push({ ...guest, marker });
      claimedMarkers.add(marker);
      reservedMarkers.add(marker);

      for (const key of guest.songKeys) addGuestMarker(markersBySong, key, marker);
      continue;
    }

    const standaloneGuest = normalizeGuestCredit(note);
    const unclaimedInlineMarkers = [...inlineMarkers.allMarkers].filter((marker) => !claimedMarkers.has(marker));
    if (standaloneGuest && unclaimedInlineMarkers.length === 1) {
      const marker = unclaimedInlineMarkers[0];
      guestNotes.push({ marker, text: standaloneGuest, songKeys: [] });
      claimedMarkers.add(marker);
    } else {
      bracketNotes.push({ text: note });
    }
  }

  return { bracketNotes, guestNotes, markersBySong };
}

function parseGuestNote(note, songTitles) {
  const text = clean(note);
  if (!text || /^entire show\b/i.test(text)) return null;
  const match = text.match(/^(.+?)\s+(?:with|w\/|wth)\s*(.+)$/i);
  if (!match) return null;

  const titlePart = match[1].replace(/^["']|["']$/g, "");
  const guestText = normalizeGuestCredit(`with ${match[2]}`);
  if (!guestText) return null;

  const titleKey = normalizeTitleCollection(titlePart);
  const songKeys = songTitles
    .map((title) => ({ title, key: normalizeTitle(title) }))
    .filter(({ key }) => key && (titleKey.includes(key) || key.includes(titleKey)))
    .map(({ key }) => key);

  return songKeys.length ? { songKeys: [...new Set(songKeys)], text: guestText } : null;
}

function parseNumberedGuestNotes(note) {
  const text = clean(note);
  const matches = [...text.matchAll(/([⁰¹²³⁴⁵⁶⁷⁸⁹]+)\s*/g)];
  if (!matches.length || matches[0].index !== 0) return [];

  const guests = matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const credit = normalizeGuestCredit(text.slice(start, end));
    return credit ? { marker: superscriptToDigits(match[1]), text: credit, songKeys: [] } : null;
  });

  return guests.every(Boolean) ? guests : [];
}

function normalizeGuestCredit(value) {
  const text = clean(value).replace(/^w\/\s*/i, "with ").replace(/^with\s+/i, "with ");
  if (!/^with\s+/i.test(text)) return "";
  if (!/\b(?:guitars?|vocals?|keys?|keyboards?|percussion|mandolin|fiddle|horns?|sax(?:ophone)?|pedal steel|drums?|bass)\b/i.test(text)) return "";
  return `with ${text.replace(/^with\s+/i, "").trim()}`;
}

function collectInlineGuestMarkers(show) {
  const markersBySong = new Map();
  const allMarkers = new Set();

  for (const set of show.sets || []) {
    const display = String(set.songs || "");
    const lowerDisplay = display.toLowerCase();
    let cursor = 0;

    for (const title of set.songTitles || []) {
      const index = lowerDisplay.indexOf(String(title).toLowerCase(), cursor);
      if (index < 0) break;

      const markerMatch = display.slice(index + title.length).match(/^([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/);
      if (markerMatch) {
        const marker = superscriptToDigits(markerMatch[1]);
        const key = normalizeTitle(title);
        addGuestMarker(markersBySong, key, marker);
        allMarkers.add(marker);
      }

      cursor = index + title.length + (markerMatch?.[0].length || 0);
    }
  }

  return { markersBySong, allMarkers };
}

function addGuestMarker(markersBySong, key, marker) {
  if (!key || !marker) return;
  const markers = markersBySong.get(key) || [];
  if (!markers.includes(marker)) markers.push(marker);
  markersBySong.set(key, markers);
}

function nextGuestMarker(reservedMarkers) {
  let marker = 1;
  while (reservedMarkers.has(String(marker))) marker += 1;
  return String(marker);
}

function superscriptToDigits(value) {
  const digits = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };
  return [...String(value || "")].map((character) => digits[character] || "").join("");
}

function renderSetSongs(set, annotations) {
  if (!(set.songTitles || []).length) return renderRawSetDisplay(set.songs || "");

  const display = String(set.songs || "");
  const lowerDisplay = display.toLowerCase();
  let cursor = 0;
  let html = "";

  for (const title of set.songTitles || []) {
    const index = lowerDisplay.indexOf(String(title).toLowerCase(), cursor);
    if (index < 0) return renderRawSetDisplay(set.songs || "");

    html += escapeHtml(display.slice(cursor, index));
    const titleEnd = index + title.length;
    const inlineMarkerMatch = display.slice(titleEnd).match(/^([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/);
    const inlineMarkers = inlineMarkerMatch ? [superscriptToDigits(inlineMarkerMatch[1])] : [];
    html += renderSetSongTitle(display.slice(index, titleEnd), annotations, title, inlineMarkers);
    cursor = titleEnd + (inlineMarkerMatch?.[0].length || 0);
  }

  html += escapeHtml(display.slice(cursor));
  return html;
}

function renderSetSongTitle(displayTitle, annotations, canonicalTitle = displayTitle, inlineMarkers = []) {
  const markers = [...new Set([...(annotations.markersBySong.get(normalizeTitle(canonicalTitle)) || []), ...inlineMarkers])];
  const markerText = markers.length ? `<sup class="guest-sup">${escapeHtml(markers.join(","))}</sup>` : "";
  return `${escapeHtml(canonicalDisplaySongTitle(displayTitle))}${markerText}`;
}

function canonicalDisplaySongTitle(value) {
  return String(value || "").replace(/\bJamais Vu\s*\(The World Has Changed\)/gi, "Jamais Vu");
}

function renderRawSetDisplay(value) {
  return String(value || "").split(/([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/).map((part) => {
    if (/^[⁰¹²³⁴⁵⁶⁷⁸⁹]+$/.test(part)) return `<sup class="guest-sup">${escapeHtml(superscriptToDigits(part))}</sup>`;
    return escapeHtml(part);
  }).join("");
}

function renderSetlistGuestNotes(annotations) {
  if (!annotations.guestNotes.length) return "";
  return `<p class="guest-notes">${annotations.guestNotes.map((note) => `<span><sup class="guest-sup">${escapeHtml(note.marker)}</sup> ${escapeHtml(note.text)}</span>`).join(" ")}</p>`;
}

function renderSetlistNotes(annotations) {
  if (!annotations.bracketNotes.length) return "";
  const normalizedNotes = annotations.bracketNotes.map((note) => ({ text: normalizeBracketNote(note.text) }));
  const orderedNotes = normalizedNotes.sort((left, right) => {
    const leftIsEntireShow = /^entire show with Nick Johnson on guitar$/i.test(left.text);
    const rightIsEntireShow = /^entire show with Nick Johnson on guitar$/i.test(right.text);
    return Number(rightIsEntireShow) - Number(leftIsEntireShow);
  });
  return `<p class="notes"><span>[${orderedNotes.map((note) => escapeHtml(note.text)).join("; ")}]</span></p>`;
}

function normalizeBracketNote(value) {
  const text = clean(value);
  if (/^(?:entire show\s+)?with Nick Johnson on (?:lead )?guitar$/i.test(text)) {
    return "Entire show with Nick Johnson on guitar";
  }
  return text;
}

function splitDisplaySetSongs(value) {
  return String(value || "").split(/\s*>\s*/).map((part) => part.trim()).filter(Boolean);
}

function renderCommunityLinks() {
  return `<section class="community-links" aria-label="Community links">
  <a class="ticket-link" href="https://widespreadpanic.com/tour">Get Tickets</a>
</section>`;
}

function renderStat(value, label) {
  const displayValue = typeof value === "string" && value.endsWith("%") ? value : formatNumber(value);
  return `<div class="stat"><strong>${escapeHtml(String(displayValue))}</strong><span>${escapeHtml(label)}</span></div>`;
}


function extractCssBlocks(css, keys) {
  const out = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    const b = css.indexOf("{", i);
    if (b < 0) break;
    const sel = css.slice(i, b).trim();
    let depth = 1;
    let j = b + 1;
    while (j < n && depth) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    const body = css.slice(b + 1, j - 1);
    if (sel.startsWith("@media")) {
      const inner = extractCssBlocks(body, keys);
      if (inner.trim()) out.push(`${sel} {\n${inner}\n}`);
    } else if (!sel.startsWith("@") && keys.some((key) => sel.includes(key))) {
      out.push(`${sel} {${body}}`);
    }
    i = j;
  }
  return out.join("\n");
}

const SHEET_CSS_KEYS = ["laminate", "primary-board", "primary-header", "board-title", "marker-num", "marker-wrap", "marker-text", "song-panel", ".songs", ".col", ".nums", "rotation-song", "shelf-board", "purgatory-board", "woodshed-board", "header-row", "shelf-addition", "handwritten"];

function renderStagelightCss() {
  const base = renderCss();
  const marker = "/* ============================================================\n   STAGELIGHT";
  const markerIdx = base.indexOf(marker);
  const legacy = markerIdx >= 0 ? base.slice(0, markerIdx) : base;
  const overrides = markerIdx >= 0 ? base.slice(markerIdx) : "";
  const fonts = (legacy.match(/@font-face[^}]*}/g) || []).join("\n");
  const rootBlock = legacy.slice(legacy.indexOf(":root {"), legacy.indexOf("}", legacy.indexOf(":root {")) + 1);
  const sheetSelf = extractCssBlocks(legacy, [".laminate"]);
  const legacyScoped = `.laminate {\n${legacy.replace(/@font-face[^}]*}/g, "").replace(/:root\s*\{[^}]*\}/g, "")}\n}`;
  return `${fonts}\n${rootBlock}\n${STAGELIGHT_STRUCTURE}\n${sheetSelf}\n${legacyScoped}\n${overrides}`;
}

const STAGELIGHT_STRUCTURE = `
/* ===== Stagelight structural base (homepage only; no legacy cascade) ===== */
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--ui-font); font-size: 16px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
img { max-width: 100%; display: block; }
a { color: inherit; text-decoration: none; }
button, select { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
h1, h2, h3, h4, p, ul, ol, dl { margin: 0; }
ul, ol { padding: 0; list-style: none; }
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
sup { line-height: 0; }
main { width: min(1400px, calc(100% - 56px)); margin: 0 auto; }
main > section { margin-top: 96px; }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 26px; }
.section-heading h2 { font-size: 34px; font-weight: 640; letter-spacing: -0.01em; line-height: 1.12; }
.section-heading span { font-size: 12px; letter-spacing: 0.08em; }

/* nav internals */
.site-head .brand { display: inline-flex; align-items: center; gap: 12px; }
.header-social { display: flex; gap: 10px; }
.header-social .social-dot { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 50%; font-size: 14px; }
.jump-links a { display: inline-block; }
.mobile-nav { display: none; position: relative; }
.mobile-nav summary { display: inline-flex; align-items: center; gap: 10px; padding: 8px 16px; border: 1px solid rgba(255,255,255,0.16); border-radius: 999px; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; }
.mobile-nav-links { position: absolute; right: 0; top: 48px; min-width: 220px; padding: 10px; border-radius: 16px; z-index: 70; }
.mobile-nav-links a { display: block; padding: 11px 16px; border-radius: 10px; font-size: 15px; }
.menu-icon { display: inline-flex; flex-direction: column; gap: 3px; }
.menu-icon i { width: 14px; height: 1.5px; display: block; }
.home-trail { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }

/* stat tiles + toolbar */
.data-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 22px; }
.data-metrics .nick-stat { padding: 20px 22px; border-radius: 16px; }
.data-metrics .nick-stat strong { display: block; font-size: 30px; font-weight: 620; line-height: 1; }
.data-metrics .nick-stat span { display: block; font-size: 11px; letter-spacing: 0.14em; margin-top: 9px; }
.data-toolbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.show-filter { display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.16); }
.show-filter span { font-size: 11px; letter-spacing: 0.14em; }
.type-filter { display: inline-flex; border-radius: 999px; overflow: hidden; border: 1px solid rgba(255,255,255,0.16); }
.type-filter button { padding: 0 18px; height: 40px; font-size: 13px; font-weight: 560; }
.show-filter-status { margin-left: auto; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }

/* data tables */
.tour-table-wrap, .data-table-wrap { overflow-x: auto; border-radius: 20px; }
.tour-table, .data-table { width: 100%; border-collapse: collapse; }
.tour-table th, .tour-table td, .data-table th, .data-table td { text-align: left; padding: 14px 18px; }
.tour-table td:last-child, .tour-table th:last-child { text-align: right; }
.tour-table thead th, .data-table thead th { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 500; }
.slp-progress { display: inline-block; width: 64px; height: 3px; border-radius: 2px; margin-left: 10px; overflow: hidden; vertical-align: middle; }
.slp-progress i { display: block; height: 100%; }

/* tour dates */
.tour-dates li { display: grid; grid-template-columns: 130px minmax(0, 1fr) auto; gap: 6px 18px; align-items: center; padding: 15px 24px; }
.tour-dates li time { font-size: 13px; letter-spacing: 0.06em; }
.tour-dates li span { grid-column: 2; font-size: 13px; }
.tour-dates li strong { grid-column: 2; font-size: 15px; }
.tour-dates li em { grid-column: 3; grid-row: 1 / span 2; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; font-style: normal; border: 1px solid rgba(255,255,255,0.08); border-radius: 999px; padding: 4px 12px; }

/* sheet key */
.sheet-key { padding: 24px 28px; border-radius: 20px; }
.sheet-key .key-topline { display: flex; gap: 20px 40px; flex-wrap: wrap; align-items: flex-start; }
.key-block h3 { font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; margin-bottom: 10px; }
.marker-legend { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
.marker-legend li { display: inline-flex; align-items: center; gap: 10px; border: 1px solid rgba(255,255,255,0.08); border-radius: 999px; padding: 8px 16px 8px 12px; }
.marker-legend img { width: 22px; height: auto; }
.marker-legend strong { font-size: 13px; }
.marker-legend em { font-size: 12px; font-style: normal; }

/* nick feature */
.nick-feature { padding: 34px 36px; border-radius: 20px; }
.nick-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 22px 0; }
.nick-summary .nick-stat { padding: 20px 22px; border-radius: 16px; }
.nick-summary .nick-stat strong { display: block; font-size: 30px; font-weight: 620; line-height: 1; }
.nick-summary .nick-stat span { display: block; font-size: 11px; letter-spacing: 0.14em; margin-top: 9px; }
.nick-progress { margin: 28px 0 32px; }
.nick-progress > div:first-child { display: flex; align-items: baseline; gap: 12px; }
.nick-progress-track { display: flex; height: 8px; border-radius: 4px; background: rgba(255,255,255,0.1); overflow: hidden; margin: 14px 0 12px; }
.nick-progress-track i { display: block; height: 100%; }
.progress-key { display: flex; gap: 10px 26px; flex-wrap: wrap; }
.progress-key span { display: inline-flex; align-items: center; gap: 8px; }
.progress-key i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.nick-ranking { display: grid; gap: 4px; }
.nick-ranking li { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 12px; align-items: baseline; padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }

/* footer + community */
.community-links { display: flex; align-items: center; justify-content: center; gap: 28px; flex-wrap: wrap; margin-top: 96px; }
.ticket-link { display: inline-flex; align-items: center; height: 44px; padding: 0 26px; border-radius: 999px; font-weight: 650; }
.posse-link img { width: 220px; border-radius: 12px; }
.site-foot { margin-top: 110px; }
.site-foot-inner { width: min(1400px, calc(100% - 56px)); margin: 0 auto; display: flex; justify-content: space-between; gap: 44px; flex-wrap: wrap; padding: 56px 0 40px; }
.footer-lead p { margin-top: 12px; max-width: 300px; font-size: 14px; line-height: 1.55; }
.footer-brand { font-size: 20px; font-weight: 800; letter-spacing: 0.045em; }
.footer-links, .social-links { display: flex; flex-direction: column; gap: 2px; }
.footer-links strong, .social-links strong { font-size: 11px; letter-spacing: 0.18em; margin-bottom: 12px; font-weight: 500; }
.footer-links a, .social-links a { padding: 5px 0; font-size: 14px; }
.social-links a { display: inline-flex; align-items: center; gap: 10px; }
.social-mark { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; font-size: 12px; }

@media (max-width: 900px) {
  .data-metrics, .nick-summary { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 560px) {
  main { width: calc(100% - 36px); }
  main > section { margin-top: 64px; }
  .section-heading h2 { font-size: 28px; }
  .mobile-nav { display: block; }
  .data-metrics, .nick-summary { grid-template-columns: 1fr 1fr; }
  .tour-dates li { grid-template-columns: auto minmax(0, 1fr); padding: 14px 16px; }
  .tour-dates li em { grid-column: 2; grid-row: auto; justify-self: start; }
  .marker-legend { grid-template-columns: 1fr; }
}
`;

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

@font-face {
  font-family: "Geist";
  src: url("/assets/geist-latin-wght-normal.woff2") format("woff2-variations");
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}

@font-face {
  font-family: "Bricolage";
  src: url("/assets/bricolage-grotesque-latin-wght-normal.woff2") format("woff2-variations");
  font-style: normal;
  font-weight: 200 800;
  font-display: swap;
}

@font-face {
  font-family: "Geist Mono";
  src: url("/assets/geist-mono-latin-wght-normal.woff2") format("woff2-variations");
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}

:root {
  color-scheme: light;
  --paper: #ffffff;
  --ink: #111111;
  --muted: #5f5a55;
  --line: rgba(0, 0, 0, 0.12);
  --red: #d4514f;
  --green: #2d7c52;
  --blue: #286e9e;
  --cream: #f7f1e8;
  --ui-font: "Geist", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --type-display: 48px;
  --type-archive-title: 48px;
  --type-section: 26px;
  --type-subsection: 18px;
  --type-body: 16px;
  --type-dense: 15px;
  --type-small: 13px;
  --type-micro: 12px;
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
  font-family: var(--ui-font);
  overflow-x: clip;
}

a {
  color: inherit;
}

.site-head {
  width: min(1380px, calc(100% - 40px));
  margin: 18px auto 0;
}

.masthead-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  min-height: 132px;
}

.brand {
  grid-column: 2;
  display: inline-flex;
  align-items: center;
  justify-self: center;
}

.brand-logo {
  width: clamp(270px, 24vw, 370px);
  height: auto;
  display: block;
}

.header-social {
  grid-column: 3;
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 8px;
}

.social-dot {
  display: inline-grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  color: #ffffff;
  text-decoration: none;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.75), 0 0 0 1px rgba(0, 0, 0, 0.1);
}

.social-dot.facebook {
  background: #1e65ae;
}

.social-dot.twitter {
  background: #66c6e5;
}

.jump-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px clamp(22px, 3vw, 48px);
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: 13px 0 14px;
  font-family: var(--ui-font);
  font-size: 18px;
  font-weight: 600;
  line-height: 1;
}

.jump-links a {
  display: inline-flex;
  align-items: center;
  padding: 4px 0;
  text-decoration: none;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}

.jump-links a[aria-current="page"] {
  color: #b94a4a;
  border-bottom-color: currentColor;
}

.jump-links a:hover {
  border-bottom-color: currentColor;
}

.mobile-nav {
  display: none;
}

main {
  width: min(1540px, calc(100% - 56px));
  margin: 34px auto 56px;
}

.home-intro {
  width: 100%;
  margin: 0 auto 30px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line);
}

.home-intro h1 {
  margin: 0 0 14px;
  font-family: var(--ui-font);
  font-size: var(--type-display);
  line-height: 1;
  font-weight: 700;
  letter-spacing: 0;
}

.home-trail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  font-family: var(--ui-font);
  font-size: 14px;
}

.home-trail a {
  color: var(--ink);
  text-underline-offset: 3px;
}

.home-trail span {
  color: var(--muted);
}

#latest-setlist,
#song-list,
#sheet-key,
#shelf-watch,
#shelf,
#purgatory,
#nick-johnson,
#woodshed,
#setlists,
#tour-dates {
  scroll-margin-top: 18px;
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
  grid-template-columns: max-content minmax(0, 1fr) max-content;
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
  width: 100%;
  max-width: 100%;
  justify-self: center;
}

.board-title h1 {
  margin: 0;
  color: var(--red);
  font-family: "PanicHand", "MilkRun", sans-serif;
  font-size: 96px;
  line-height: 0.95;
  font-weight: 400;
  letter-spacing: 0;
  white-space: nowrap;
  max-width: 100%;
  overflow: visible;
}

.board-title p {
  margin: 4px 0 0;
  color: var(--muted);
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.2;
  letter-spacing: 0;
  overflow-wrap: normal;
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

.sheet-key {
  margin: 0;
  padding: 0;
  font-family: var(--ui-font);
}

.sheet-key-sheet {
  padding-top: 28px;
  padding-bottom: 30px;
}

.sheet-key h2 {
  margin: 0 0 18px;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 28px;
  line-height: 1;
  font-weight: 400;
  letter-spacing: 0;
}

.key-topline {
  display: grid;
  grid-template-columns: minmax(280px, 0.85fr) minmax(360px, 1.15fr);
  gap: clamp(28px, 6vw, 96px);
  align-items: start;
}

.key-block {
  min-width: 0;
}

.key-block h3,
.key-points strong,
.key-other-sheets dt {
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 18px;
  line-height: 1.05;
  font-weight: 400;
  color: var(--ink);
  letter-spacing: 0;
}

.key-block h3 {
  margin: 0 0 7px;
}

.key-block p {
  margin: 0;
  color: var(--muted);
  font-size: 16px;
  line-height: 1.35;
}

.key-block p + p {
  margin-top: 10px;
}

.key-points {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin: 18px 0 0;
  padding: 0;
}

.key-points li {
  min-width: 0;
}

.key-points strong {
  display: block;
  margin-bottom: 3px;
}

.key-points span,
.key-other-sheets dd {
  color: var(--muted);
  font-size: 15px;
  line-height: 1.3;
}

.key-other-sheets {
  margin-top: 22px;
  padding-top: 17px;
  border-top: 1px solid var(--line);
}

.key-other-sheets dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px 32px;
  margin: 0;
}

.key-other-sheets dt {
  margin: 0 0 4px;
}

.key-other-sheets dd {
  margin: 0;
}

.marker-legend {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 18px;
  margin: 12px 0 12px;
  padding: 0;
}

.marker-legend li {
  min-width: 0;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.marker-legend img {
  width: 38px;
  height: 14px;
  object-fit: fill;
  mix-blend-mode: multiply;
}

.marker-legend span {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
}

.marker-legend strong {
  color: var(--ink);
  font-weight: 700;
}

.marker-legend em {
  color: var(--muted);
  font-style: normal;
  min-width: 0;
}

.song-panel {
  margin: 0;
}

.song-panel h3 {
  min-height: 24px;
  display: flex;
  align-items: center;
  margin: 0 0 12px;
  font-size: 20px;
  font-weight: 700;
  text-decoration: underline;
}

.songs.grid4 {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  column-gap: clamp(20px, 3vw, 58px);
}

.songs.grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  column-gap: clamp(18px, 2.6vw, 48px);
}

.songs .col {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.rotation-song {
  --song-font-size: 21px;
  display: flex;
  align-items: baseline;
  max-width: 100%;
  min-width: 0;
  min-height: 27px;
  margin: 0 0 6px;
  font-size: var(--song-font-size);
  text-transform: uppercase;
  line-height: 1.02;
  letter-spacing: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: normal;
  text-wrap: nowrap;
}

.marker-wrap {
  display: inline-flex;
  align-items: baseline;
  min-width: 0;
  max-width: 100%;
  flex: 0 1 auto;
  line-height: 1;
  white-space: nowrap;
}

.rotation-song.has-date .marker-wrap {
  max-width: 100%;
}

.marker-target {
  position: relative;
  display: inline-block;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1;
}

.marker-text {
  position: relative;
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  z-index: 1;
  letter-spacing: 0;
}

.rotation-song sup {
  flex: 0 0 auto;
  position: relative;
  z-index: 2;
}

.marker-mask {
  position: absolute;
  left: -0.14em;
  right: -0.1em;
  top: 0.1em;
  bottom: 0.08em;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}

.marker-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: fill;
  opacity: 0.9;
  mix-blend-mode: multiply;
}

sup {
  font-size: 0.55em;
  position: relative;
  top: -0.5em;
  vertical-align: baseline;
  line-height: 0;
  margin-left: 2px;
}

.date-sup {
  flex: 0 0 auto;
  margin-left: 7px;
}

.add-on-date {
  margin-left: 5px;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 0.72em;
  line-height: 1;
  vertical-align: 0.03em;
}

.hand-addon {
  font-family: "PanicHand", "MilkRun", sans-serif;
  font-size: 0.78em;
  letter-spacing: 0;
  line-height: 1;
  display: inline-block;
  vertical-align: -0.02em;
}

.spacer {
  visibility: hidden;
}

.latest-setlist,
.setlist-section,
.tour-date-section,
.shelf-watch,
.tour-stats,
.nick-feature {
  width: 100%;
  margin: 36px auto;
}

.latest-setlist {
  margin-top: 0;
}

.latest-setlist .setlist-feature {
  margin-bottom: 0;
}

.current-stop-setlists {
  display: grid;
  gap: 56px;
  margin-top: 56px;
}

.tour-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.data-heading {
  border-bottom: 1px solid var(--ink);
  padding-bottom: 12px;
}

.data-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid var(--line);
}

.data-toolbar {
  display: flex;
  align-items: end;
  gap: 12px;
  min-width: 0;
  padding: 18px 0 4px;
}

.show-filter {
  display: grid;
  gap: 6px;
  min-width: min(360px, 50%);
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
}

.show-filter select {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #fff;
  padding: 0 34px 0 11px;
  color: var(--ink);
  font: 600 13px/1 var(--ui-font);
}

.mobile-sort {
  display: none;
}

.type-filter {
  display: inline-flex;
  min-height: 40px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px;
  background: #f5f5f3;
}

.type-filter button {
  border: 0;
  border-radius: 3px;
  background: transparent;
  padding: 0 12px;
  color: var(--muted);
  font: 650 12px/1 var(--ui-font);
  cursor: pointer;
}

.type-filter button.is-active {
  background: #fff;
  color: var(--ink);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}

.show-filter-status {
  margin-left: auto;
  padding-bottom: 11px;
  color: var(--muted);
  font-size: 12px;
}

.tour-table-wrap {
  max-height: 560px;
  overflow: auto;
  margin-top: 24px;
  border-bottom: 1px solid var(--line);
}

.tour-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--ui-font);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.tour-table th,
.tour-table td {
  border-top: 1px solid var(--line);
  padding: 11px 12px;
  text-align: left;
  white-space: nowrap;
}

.tour-table tbody th {
  width: 34%;
  font-weight: 600;
}

.signal-cell {
  min-width: 154px;
}

.signal-cell strong,
.signal-cell small {
  display: block;
}

.signal-cell strong {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 700;
}

.rarity-symbol {
  min-width: 28px;
  display: flex;
  align-items: center;
}

.rarity-symbol svg {
  display: block;
  height: 10px;
  width: auto;
}

.rarity-symbol svg.rarity-hyper {
  height: 15px;
}

.signal-cell small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
}

.index-method {
  border-bottom: 1px solid var(--line);
}

.index-method > summary {
  list-style: none;
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
}

.index-method > summary::-webkit-details-marker { display: none; }

.index-method > summary::after {
  content: "+";
  color: var(--ink);
  font-size: 18px;
  font-weight: 400;
}

.index-method[open] > summary::after { content: "\\2212"; }

.index-method > div {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 28px;
  padding: 0 0 20px;
}

.index-method p {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
}

.index-method strong { color: var(--ink); }

.tour-table tbody tr.is-selected-show {
  background: #f7eeee;
  box-shadow: inset 3px 0 0 var(--red);
}

.tour-table tbody tr[hidden] {
  display: none;
}

.tour-table thead th {
  position: sticky;
  z-index: 2;
  top: 0;
  background: var(--paper);
  padding: 0;
}

.tour-table button {
  width: 100%;
  border: 0;
  background: transparent;
  padding: 12px;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  text-align: left;
  text-transform: uppercase;
  cursor: pointer;
}

.tour-table button:hover,
.tour-table button:focus-visible,
.tour-table th[aria-sort] button {
  color: var(--ink);
}

.tour-table button span {
  margin-left: 4px;
}

.shelf-watch-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--line);
}

.data-table-wrap {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--ui-font);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.data-table th,
.data-table td {
  border-bottom: 1px solid var(--line);
  padding: 12px 10px;
  text-align: left;
}

.data-table thead th {
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
}

.data-table tbody th {
  width: 48%;
  padding-left: 0;
  font-weight: 650;
}

.data-table td:last-child,
.data-table th:last-child {
  padding-right: 0;
  text-align: right;
}

.slp-progress {
  display: inline-block;
  width: 72px;
  height: 4px;
  margin-left: 9px;
  overflow: hidden;
  vertical-align: middle;
  background: #e8e8e6;
}

.slp-progress i {
  display: block;
  height: 100%;
  background: var(--ink);
}

.shelf-watch-list li {
  display: grid;
  grid-template-columns: minmax(220px, 1.5fr) minmax(210px, 0.8fr) minmax(110px, 0.35fr);
  gap: 24px;
  align-items: center;
  min-width: 0;
  border-bottom: 1px solid var(--line);
  padding: 12px 0;
}

.shelf-watch-song {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.shelf-watch-song strong {
  font-family: var(--ui-font);
  font-size: 16px;
  line-height: 1.05;
  font-weight: 650;
}

.shelf-watch-song span,
.shelf-watch-slp span,
.shelf-watch-remaining span {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.2;
}

.shelf-watch-slp,
.shelf-watch-remaining {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.shelf-watch-slp strong,
.shelf-watch-remaining strong {
  flex: 0 0 auto;
  font-family: var(--ui-font);
  font-size: 23px;
  line-height: 1;
  font-weight: 650;
}

.shelf-watch-remaining {
  justify-self: end;
}

.nick-disclosure > summary {
  list-style: none;
  cursor: default;
}

.nick-disclosure > summary::-webkit-details-marker {
  display: none;
}

.nick-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.nick-progress {
  display: grid;
  gap: 9px;
  margin: 22px 0 4px;
}

.nick-progress > div {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.nick-progress strong {
  font-size: 22px;
  line-height: 1;
  font-weight: 700;
}

.nick-progress span {
  color: var(--muted);
  font-size: 13px;
}

.nick-progress-track {
  display: flex;
  width: 100%;
  height: 8px;
  overflow: hidden;
  background: #e8e8e6;
}

.nick-progress-track i {
  display: block;
  height: 100%;
}

.nick-progress-track .is-original { background: var(--ink); }
.nick-progress-track .is-cover { background: var(--red); }

.progress-key {
  display: flex !important;
  flex-wrap: wrap;
  gap: 8px 20px !important;
}

.progress-key span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.progress-key i {
  width: 8px;
  height: 8px;
}

.progress-key .key-original { background: var(--ink); }
.progress-key .key-cover { background: var(--red); }
.progress-key .key-unplayed { background: #e8e8e6; }

.nick-stat {
  min-width: 0;
  display: grid;
  gap: 3px;
  padding: 16px 18px 17px 0;
}

.nick-stat + .nick-stat {
  border-left: 1px solid var(--line);
  padding-left: 18px;
}

.nick-stat strong {
  font-family: var(--ui-font);
  font-size: 28px;
  line-height: 1;
  font-weight: 650;
}

.nick-stat span {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.2;
  text-transform: uppercase;
}

.nick-ranking-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-top: 28px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--line);
}

.nick-ranking-heading h3 {
  margin: 0;
  font-size: 15px;
  line-height: 1;
  font-weight: 700;
}

.nick-ranking-heading span {
  color: var(--muted);
  font-size: 12px;
}

.nick-ranking {
  list-style: none;
  margin: 0;
  padding: 0;
}

.nick-ranking li {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  min-width: 0;
  border-bottom: 1px solid var(--line);
  padding: 11px 0;
}

.nick-rank {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}

.nick-song,
.nick-plays {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.nick-song strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  line-height: 1.1;
  font-weight: 650;
}

.nick-song small,
.nick-plays small {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.1;
}

.nick-plays {
  min-width: 50px;
  text-align: right;
}

.nick-plays strong {
  font-size: 20px;
  line-height: 1;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.nick-played-panel {
  border-bottom: 1px solid var(--line);
}

.nick-played-panel summary {
  list-style: none;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 24px;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  cursor: pointer;
  font-family: var(--ui-font);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
}

.nick-played-panel summary::-webkit-details-marker {
  display: none;
}

.nick-played-panel summary::after {
  content: "+";
  justify-self: end;
  font-family: var(--ui-font);
  font-size: 22px;
  font-weight: 400;
}

.nick-played-panel[open] summary::after {
  content: "\\2212";
}

.nick-played-panel summary strong {
  font-family: var(--ui-font);
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}

.nick-played-panel .nick-ranking {
  border-top: 1px solid var(--line);
}

.nick-ranking.is-compact li {
  padding: 9px 0;
}

.nick-ranking li.is-zero .nick-song,
.nick-ranking li.is-zero .nick-plays {
  color: var(--muted);
}

.community-links {
  width: min(1180px, 100%);
  margin: 34px auto 46px;
  text-align: center;
}

.ticket-link {
  display: block;
  width: max-content;
  margin: 0 auto 34px;
  color: #007cbb;
  font-size: 32px;
  line-height: 1;
  text-decoration: none;
}

.posse-link {
  display: block;
  width: max-content;
  margin: 0 auto;
  text-decoration: none;
}

.posse-link img {
  display: block;
  width: min(200px, 70vw);
  height: auto;
  margin: 0 auto;
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
  font-family: var(--ui-font);
  font-size: var(--type-section);
  line-height: 1;
  font-weight: 700;
  color: var(--ink);
  letter-spacing: 0;
}

.section-heading span {
  color: var(--muted);
  font-family: var(--ui-font);
  font-size: 13px;
}

.setlist-feature {
  display: grid;
  grid-template-columns: minmax(320px, 0.92fr) minmax(0, 1.08fr);
  gap: clamp(36px, 5vw, 72px);
  align-items: start;
  margin-bottom: 36px;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
}

.setlist-feature.no-image {
  grid-template-columns: 1fr;
}

.setlist-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.setlist-list {
  border-top: 1px solid var(--line);
}

.setlist-row {
  border-bottom: 1px solid var(--line);
}

.setlist-row > summary {
  list-style: none;
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr) auto 20px;
  gap: 18px;
  align-items: center;
  min-height: 68px;
  cursor: pointer;
}

.setlist-row > summary::-webkit-details-marker { display: none; }

.setlist-row time {
  color: var(--muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.show-place {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.show-place strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 650;
}

.show-place small {
  color: var(--muted);
  font-size: 12px;
}

.show-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.show-action {
  position: relative;
  z-index: 2;
  color: var(--ink);
  font-size: 12px;
  font-weight: 650;
  text-decoration: none;
}

.details-action {
  border-bottom: 1px solid currentColor;
}

.play-action {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid var(--ink);
  border-radius: 50%;
  font-size: 10px;
  line-height: 1;
}

.play-action span { margin-left: 2px; }

.row-toggle::before {
  content: "+";
  color: var(--muted);
  font-size: 20px;
}

.setlist-row[open] .row-toggle::before { content: "\\2212"; }

.setlist-row-body {
  display: grid;
  grid-template-columns: minmax(220px, .72fr) minmax(0, 1.28fr);
  gap: 22px;
  padding: 8px 0 24px 130px;
}

.setlist-row-body .setlist-image { margin: 0; }

.setlist-card {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0 0 22px;
}

.setlist-image {
  margin: 0 0 12px;
  background: transparent;
  border: 0;
  border-radius: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.setlist-feature .setlist-image {
  margin: 0;
  min-width: 0;
}

.setlist-feature .setlist-copy {
  padding: clamp(8px, 1.5vw, 22px) 0 0;
}

.setlist-image img {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
  background: transparent;
}

.setlist-archive-panel > summary {
  display: none;
}

.setlist-archive-panel > .setlist-grid {
  margin-top: 0;
}

.setlist-text {
  min-width: 0;
  overflow-wrap: break-word;
  word-break: normal;
  font-size: var(--type-dense);
  line-height: 1.35;
}

.setlist-text h3 {
  margin: 0 0 3px;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  font-weight: 700;
  color: var(--ink);
  letter-spacing: 0;
}

.show-heading {
  margin: 0 0 26px;
}

.show-heading time {
  display: block;
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
  text-transform: uppercase;
}

.setlist-text .show-heading h3 {
  margin: 0;
  font-size: clamp(26px, 2.3vw, 34px);
  line-height: 1.04;
  font-weight: 700;
}

.setlist-text .show-heading p {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 16px;
  line-height: 1.25;
}

.setlist-feature .setlist-sets {
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: 22px 0;
}

.setlist-feature .setlist-sets p {
  margin: 0;
}

.setlist-feature .setlist-sets p + p {
  margin-top: 18px;
}

.setlist-annotations {
  padding: 17px 0 4px;
}

.setlist-feature .setlist-annotations .guest-notes,
.setlist-feature .setlist-annotations .notes {
  margin-top: 0;
}

.setlist-feature .setlist-annotations .guest-notes + .notes {
  margin-top: 8px;
}

.setlist-text p {
  margin: 8px 0;
  font-size: inherit;
  line-height: inherit;
}

.setlist-text strong {
  color: var(--ink);
}

.guest-notes,
.notes {
  margin: 10px 0 0;
  padding-left: 0;
  font-size: inherit;
  line-height: inherit;
}

.guest-notes {
  color: var(--ink);
}

.notes {
  color: var(--muted);
}

.guest-notes span,
.notes span {
  display: block;
}

.setlist-text .guest-sup {
  font-size: 0.62em;
  top: -0.55em;
  margin-left: 1px;
}

.notes .guest-sup {
  margin-left: 0;
  margin-right: 2px;
}

.setlist-links {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
  font-size: inherit;
  line-height: inherit;
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
  border-top: 1px solid var(--line);
}

.tour-dates li {
  display: grid;
  grid-template-columns: 100px minmax(160px, 0.65fr) minmax(220px, 1.35fr) 100px;
  gap: 18px;
  align-items: baseline;
  min-height: 48px;
  padding: 13px 0 12px;
  border-bottom: 1px solid var(--line);
}

.tour-dates li time {
  font-family: var(--ui-font);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.tour-dates li strong {
  font-weight: 650;
}

.tour-dates li span {
  color: var(--muted);
}

.tour-dates li em {
  justify-self: end;
  color: var(--muted);
  font-style: normal;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0;
  text-transform: uppercase;
}

.tour-dates li.is-upcoming {
  background: rgba(0, 0, 0, 0.018);
}

.archive-list a {
  color: var(--ink);
  font-weight: 700;
}

.archive-main {
  width: min(1180px, calc(100% - 32px));
  margin: 28px auto 56px;
}

.tour-review-main {
  width: min(1880px, calc(100% - 56px));
  margin: 28px auto 56px;
}

.tour-review-main > .archive-page {
  width: min(1180px, 100%);
  margin: 0 auto 34px;
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
  font-size: var(--type-archive-title);
  line-height: 1;
  font-weight: 400;
}

.archive-title p {
  margin: 0 0 8px;
  color: var(--muted);
}

.page-graphic-title {
  display: grid;
  justify-items: center;
  gap: 14px;
  margin-bottom: 28px;
  border-bottom: 1px solid var(--line);
  padding: 4px 0 22px;
  text-align: center;
}

.page-graphic-title img {
  display: block;
  width: auto;
  max-width: min(300px, 78vw);
  max-height: 180px;
  object-fit: contain;
}

.page-graphic-title h1 {
  margin: 0;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: var(--type-archive-title);
  line-height: 1;
  font-weight: 400;
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

.shelf-explainer {
  max-width: 820px;
  font-size: 18px;
  line-height: 1.5;
}

.shelf-explainer p {
  margin: 0 0 14px;
}

.shelf-current-update h2 {
  margin: 0 0 14px;
  font-family: var(--ui-font);
  font-size: var(--type-section);
  line-height: 1;
  font-weight: 700;
}

.shelf-current-update {
  max-width: 880px;
  margin: 0 auto 34px;
}

.shelf-addition-group {
  margin-top: 22px;
}

.shelf-addition-group h3 {
  margin: 0 0 8px;
  font-family: var(--ui-font);
  font-size: 18px;
}

.shelf-addition-group ul {
  columns: 2;
  column-gap: 44px;
  margin: 0;
  padding-left: 20px;
}

.shelf-addition-group li {
  break-inside: avoid;
  margin: 0 0 7px;
}

.legacy-shelf-notes {
  border-top: 1px solid var(--line);
  padding-top: 28px;
}

.legacy-shelf-notes > h2 {
  margin: 0 0 20px;
  font-family: var(--ui-font);
  font-size: var(--type-section);
}

.current-review-link {
  margin: 0 0 28px;
  text-align: center;
}

.shelf-current-counts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 22px 0 8px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.shelf-current-counts div {
  display: grid;
  gap: 3px;
  padding: 15px 16px 16px 0;
}

.shelf-current-counts div + div {
  border-left: 1px solid var(--line);
  padding-left: 16px;
}

.shelf-current-counts strong {
  font-size: 26px;
  line-height: 1;
}

.shelf-current-counts span,
.shelf-watch-block > p {
  color: var(--muted);
}

.shelf-page-watch li {
  grid-template-columns: minmax(180px, auto) minmax(0, 1fr);
}

.shelf-page-links {
  color: var(--muted);
}

.shelf-page-links a,
.movement-list a {
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.shelf-movement {
  margin-top: 28px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.shelf-movement h2,
.legacy-shelf-notes h2 {
  margin: 0 0 14px;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 30px;
  line-height: 1;
  font-weight: 400;
}

.movement-block {
  margin: 20px 0;
}

.movement-block h3 {
  margin: 0 0 8px;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 22px;
  line-height: 1;
  font-weight: 400;
}

.movement-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.movement-list li {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  gap: 3px 8px;
  align-items: baseline;
}

.generated-review-list li {
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
}

.review-ledger {
  margin-top: 20px;
}

.review-top-songs {
  columns: 2;
  column-gap: 42px;
  margin: 0;
  padding-left: 26px;
  font-size: 18px;
}

.review-top-songs li {
  break-inside: avoid;
  margin: 0 0 7px;
}

.review-top-songs strong {
  font-family: "MilkRun", system-ui, sans-serif;
  font-weight: 400;
}

.review-top-songs span {
  color: var(--muted);
  margin-left: 6px;
}

.movement-list strong {
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 22px;
  line-height: 1;
  font-weight: 400;
}

.movement-list span {
  color: var(--muted);
}

.legacy-shelf-notes {
  margin-top: 36px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
}

.legacy-note {
  color: var(--muted);
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

.origins-main {
  width: min(1240px, calc(100% - 32px));
}

.origin-hero {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  align-items: center;
  gap: 22px;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 18px;
}

.origin-fish {
  display: block;
  width: 150px;
  height: auto;
}

.origin-hero p,
.origin-title p {
  margin: 0 0 7px;
  color: var(--muted);
  font-family: "MilkRun", system-ui, sans-serif;
  text-transform: uppercase;
}

.origin-hero h1 {
  margin: 0;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 56px;
  line-height: 0.95;
  font-weight: 400;
}

.origin-hero span {
  display: block;
  margin-top: 8px;
  color: var(--muted);
}

.origin-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.origin-card {
  min-width: 0;
  display: grid;
  grid-template-rows: auto auto 1fr;
  gap: 7px;
  color: var(--ink);
  text-decoration: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  background: #ffffff;
}

.origin-card img {
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  background: var(--cream);
}

.origin-card span {
  color: var(--muted);
  font-size: 12px;
  text-transform: uppercase;
}

.origin-card strong {
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 24px;
  line-height: 1;
  font-weight: 400;
}

.origin-back {
  margin-bottom: 14px;
}

.origin-back a,
.origin-source a,
.origin-nav a,
.origin-body a {
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.origin-layout {
  display: grid;
  grid-template-columns: minmax(220px, 340px) minmax(0, 1fr);
  gap: 26px;
  align-items: start;
}

.origin-image {
  margin: 0;
}

.origin-image img {
  display: block;
  width: 100%;
  max-height: 520px;
  object-fit: contain;
  background: var(--cream);
}

.origin-body {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: break-word;
  font-size: 17px;
  line-height: 1.52;
}

.origin-body p {
  margin: 0 0 16px;
}

.origin-stats {
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: 12px 0;
  font-family: "MilkRun", system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.55;
}

.origin-source {
  color: var(--muted);
  font-size: 14px;
}

.origin-nav {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-top: 26px;
  border-top: 1px solid var(--line);
  padding-top: 14px;
}

.site-foot {
  width: 100%;
  margin: 0;
  border-top: 1px solid var(--line);
  background: #f7f7f6;
  padding: 48px 28px 24px;
  color: var(--ink);
  font-size: 14px;
  line-height: 1.4;
}

.site-foot-inner {
  width: min(1380px, 100%);
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(280px, 1.35fr) minmax(300px, 1fr) minmax(180px, 0.6fr);
  gap: 48px;
  align-items: start;
}

.site-foot a {
  color: var(--ink);
  text-decoration: none;
}

.footer-lead {
  max-width: 430px;
}

.footer-brand {
  display: inline-block;
  font-size: 28px;
  line-height: 1;
  font-weight: 750;
  letter-spacing: 0;
}

.footer-lead p {
  max-width: 380px;
  margin: 14px 0 0;
  color: var(--muted);
  font-size: 16px;
  line-height: 1.5;
}

.footer-links,
.social-links {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 22px;
}

.footer-links > strong,
.social-links > strong {
  grid-column: 1 / -1;
  margin-bottom: 3px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
}

.footer-links a {
  width: max-content;
  max-width: 100%;
  font-size: 14px;
  text-underline-offset: 4px;
}

.footer-links a:hover,
.footer-links a:focus-visible,
.social-links a:hover span:last-child,
.social-links a:focus-visible span:last-child {
  text-decoration: underline;
}

.social-links {
  grid-template-columns: 1fr;
}

.social-links a {
  display: flex;
  align-items: center;
  gap: 9px;
  width: max-content;
  font-size: 14px;
}

.social-mark {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 50%;
  background: var(--ink);
  color: #ffffff;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
}

.social-mark.instagram::before {
  content: "";
  width: 9px;
  height: 9px;
  border: 1.5px solid #ffffff;
  border-radius: 3px;
}

.social-mark.instagram::after {
  content: "";
  position: absolute;
  top: 7px;
  right: 7px;
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: #ffffff;
}

.footer-legal {
  grid-column: 1 / -1;
  display: flex;
  gap: 8px;
  margin: 8px 0 0;
  border-top: 1px solid var(--line);
  padding-top: 18px;
  color: var(--muted);
  font-size: 12px;
}

@media (max-width: 900px) {
  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .site-head {
    width: min(100% - 28px, 1180px);
  }

  .site-foot-inner {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .footer-lead,
  .footer-legal {
    grid-column: 1 / -1;
  }

  .masthead-row {
    min-height: 112px;
  }

  .brand-logo {
    width: min(320px, 64vw);
  }

  .header-row {
    grid-template-columns: minmax(76px, auto) minmax(0, 1fr) minmax(76px, auto);
    gap: clamp(8px, 2.5vw, 18px);
    margin-bottom: 26px;
  }

  .jump-links {
    width: 100%;
    justify-content: center;
    gap: 10px 24px;
    font-size: 16px;
  }

  .nums.left,
  .nums.right {
    justify-self: stretch;
  }

  .nums {
    gap: clamp(5px, 1.4vw, 10px);
  }

  .nums.left {
    justify-content: flex-start;
  }

  .nums.right {
    justify-content: flex-end;
  }

  .marker-num {
    width: clamp(36px, 7vw, 58px);
    height: clamp(42px, 8vw, 66px);
  }

  .board-title h1 {
    font-size: 48px;
    white-space: nowrap;
    overflow-wrap: normal;
  }

  .songs.grid4 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .songs.grid3 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .rotation-song {
    --song-font-size: 20px;
  }

  .board-ledger,
  .key-topline,
  .key-other-sheets dl,
  .setlist-feature,
  .setlist-grid {
    grid-template-columns: 1fr;
  }

  .origin-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .origin-layout {
    grid-template-columns: 1fr;
  }

  .origin-image img {
    width: min(420px, 100%);
  }
}

@media (max-width: 720px) {
  .shelf-current-counts {
    grid-template-columns: 1fr;
  }

  .shelf-current-counts div + div {
    border-left: 0;
    border-top: 1px solid var(--line);
    padding-left: 0;
  }

  .shelf-page-watch li {
    grid-template-columns: 1fr;
  }

  .nick-summary,
  .data-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .data-toolbar {
    display: grid;
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .index-method > div {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .show-filter {
    min-width: 0;
  }

  .type-filter {
    width: 100%;
  }

  .type-filter button {
    flex: 1;
  }

  .show-filter-status {
    margin-left: 0;
    padding-bottom: 0;
  }

  .nick-disclosure > summary {
    cursor: pointer;
    grid-template-columns: minmax(0, 1fr) auto 24px;
  }

  .nick-disclosure > summary::after {
    content: "+";
    justify-self: end;
    font-size: 22px;
    line-height: 1;
    font-weight: 400;
  }

  .nick-disclosure[open] > summary::after {
    content: "\\2212";
  }

  .nick-disclosure > .nick-feature-body {
    padding-top: 18px;
  }

  .tour-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .nick-stat:nth-child(3) {
    border-left: 0;
  }

  .nick-stat:nth-child(n + 3) {
    border-top: 1px solid var(--line);
  }

  .tour-summary .nick-stat:nth-child(3) {
    border-left: 0;
  }

  .tour-summary .nick-stat:nth-child(n + 3) {
    border-top: 1px solid var(--line);
  }

  .rotation-song {
    --song-font-size: 19px;
  }

  .setlist-archive-panel > summary {
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 46px;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    padding: 0;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
  }

  .setlist-archive-panel > summary::-webkit-details-marker {
    display: none;
  }

  .setlist-archive-panel > summary::after {
    content: "+";
    margin-left: 10px;
    font-size: 20px;
    font-weight: 400;
  }

  .setlist-archive-panel[open] > summary::after {
    content: "\\2212";
  }

  .setlist-archive-panel > summary strong {
    margin-left: auto;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }

  .setlist-archive-panel > .setlist-list {
    margin-top: 18px;
  }

  .setlist-row > summary {
    grid-template-columns: 84px minmax(0, 1fr) auto 16px;
    gap: 10px;
    min-height: 64px;
  }

  .setlist-row time {
    font-size: 11px;
  }

  .details-action {
    display: none;
  }

  .setlist-row-body {
    grid-template-columns: 1fr;
    gap: 14px;
    padding: 4px 0 22px;
  }

  .songs.grid4,
  .songs.grid3 {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  :root {
    --type-display: 30px;
    --type-archive-title: 34px;
    --type-section: 24px;
  }

  main,
  .site-head,
  .tour-review-main {
    width: min(calc(100% - 20px), 1180px);
  }

  .latest-setlist,
  .setlist-section,
  .tour-date-section,
  .shelf-watch,
  .tour-stats,
  .nick-feature {
    width: 100%;
  }

  .masthead-row {
    grid-template-columns: 1fr;
    min-height: 98px;
  }

  .brand {
    grid-column: 1;
  }

  .brand-logo {
    width: min(270px, 72vw);
  }

  .header-social {
    display: none;
  }

  .jump-links {
    display: none;
  }

  .mobile-nav {
    display: block;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }

  .mobile-nav summary {
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 46px;
    padding: 0 2px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
  }

  .mobile-nav summary::-webkit-details-marker {
    display: none;
  }

  .menu-icon {
    width: 20px;
    height: 16px;
    display: grid;
    align-content: space-between;
  }

  .menu-icon i {
    display: block;
    width: 20px;
    height: 2px;
    background: currentColor;
    transition: transform 140ms ease, opacity 140ms ease;
  }

  .mobile-nav[open] .menu-icon i:first-child {
    transform: translateY(7px) rotate(45deg);
  }

  .mobile-nav[open] .menu-icon i:nth-child(2) {
    opacity: 0;
  }

  .mobile-nav[open] .menu-icon i:last-child {
    transform: translateY(-7px) rotate(-45deg);
  }

  .mobile-nav-links {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 20px;
    border-top: 1px solid var(--line);
    padding: 7px 0 10px;
  }

  .mobile-nav-links a {
    display: flex;
    align-items: center;
    min-height: 42px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.07);
    text-decoration: none;
    font-size: 14px;
    font-weight: 600;
  }

  .mobile-nav-links a[aria-current="page"] {
    color: #b94a4a;
  }

  .laminate {
    padding: 13px 12px 18px;
  }

  .header-row {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "left title right";
    gap: 4px;
    align-items: center;
    margin-bottom: 24px;
  }

  .nums.left {
    grid-area: left;
  }

  .nums.right {
    grid-area: right;
  }

  .nums {
    gap: 2px;
  }

  .board-title {
    grid-area: title;
  }

  .marker-num {
    width: 20px;
    height: 24px;
  }

  .board-title h1 {
    font-size: 24px;
    line-height: 1;
  }

  .section-heading h2 {
    font-size: 24px;
  }

  .tour-table-wrap {
    max-height: 500px;
  }

  .tour-table th,
  .tour-table td {
    padding: 10px 8px;
  }

  .tour-table button {
    padding: 11px 8px;
  }

  .tour-table th:nth-child(6),
  .tour-table td:nth-child(6) {
    display: none;
  }

  .mobile-sort {
    display: grid;
    gap: 6px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
    text-transform: uppercase;
  }

  .mobile-sort select {
    width: 100%;
    min-height: 40px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: #fff;
    padding: 0 34px 0 11px;
    color: var(--ink);
    font: 600 13px/1 var(--ui-font);
  }

  .tour-table-wrap {
    overflow: visible;
    max-height: none;
  }

  .tour-table,
  .tour-table tbody,
  .tour-table tr,
  .tour-table th,
  .tour-table td {
    display: block;
    width: auto;
  }

  .tour-table thead {
    display: none;
  }

  .tour-table tbody tr {
    display: grid;
    position: relative;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 18px;
    border-top: 1px solid var(--line);
    padding: 14px 8px;
  }

  .tour-table tbody tr[hidden] {
    display: none;
  }

  .tour-table tbody th,
  .tour-table tbody td {
    border: 0;
    padding: 0;
    white-space: normal;
  }

  .tour-table tbody th {
    grid-column: 1 / -1;
    align-self: center;
    justify-self: stretch;
    box-sizing: border-box;
    width: 100%;
    padding-right: 56px;
    font-size: 15px;
  }

  .tour-table .plays-cell {
    position: absolute;
    top: 14px;
    right: 8px;
    text-align: right;
    font-size: 18px;
    font-weight: 700;
  }

  .tour-table .plays-cell::before {
    content: "PLAYS";
    display: block;
    margin-bottom: 3px;
    color: var(--muted);
    font-size: 9px;
    font-weight: 650;
  }

  .tour-table .rarity-cell {
    grid-column: 1;
  }

  .tour-table .heat-cell {
    grid-column: 2;
    text-align: right;
  }

  .tour-table tbody td:nth-child(5) {
    display: none;
  }

  .signal-cell {
    min-width: 0;
  }

  .setlist-feature {
    gap: 22px;
    margin-bottom: 46px;
  }

  .setlist-feature .setlist-copy {
    padding-top: 0;
  }

  .show-heading {
    margin-bottom: 20px;
  }

  .setlist-text .show-heading h3 {
    font-size: 27px;
  }

  .setlist-feature .setlist-sets {
    padding: 18px 0;
  }

  .board-ledger {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .setlist-text {
    font-size: 14px;
  }

  .key-points,
  .marker-legend,
  .review-top-songs {
    grid-template-columns: 1fr;
    columns: 1;
  }

  .shelf-watch-list li {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 7px 12px;
    padding: 11px 0;
  }

  .shelf-watch-song {
    grid-column: 1 / -1;
  }

  .shelf-watch-slp {
    grid-column: 1;
  }

  .shelf-watch-remaining {
    grid-column: 2;
  }

  .shelf-watch-slp strong,
  .shelf-watch-remaining strong {
    font-size: 22px;
  }

  .song-panel {
    border-bottom: 1px solid var(--line);
  }

  .song-panel h3 {
    min-height: 30px;
    margin: 4px 0 10px;
  }

  .rotation-song {
    --song-font-size: 18px;
  }

  .tour-dates li {
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 10px;
    align-items: start;
    padding: 12px 0;
  }

  .tour-dates li strong,
  .tour-dates li span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .tour-dates li span {
    grid-column: 2;
  }

  .tour-dates li em {
    grid-column: 2;
    grid-row: 3;
    justify-self: start;
    margin-top: 3px;
  }

  .archive-list li {
    grid-template-columns: 1fr;
  }

  .shelf-addition-group ul {
    columns: 1;
  }

  .origin-hero {
    grid-template-columns: 1fr;
    text-align: center;
  }

  .origin-fish {
    margin: 0 auto;
  }

  .origin-grid {
    grid-template-columns: 1fr;
  }

  .origin-card {
    grid-template-columns: 84px minmax(0, 1fr);
    grid-template-rows: auto auto;
    align-items: center;
  }

  .origin-card img {
    grid-row: 1 / span 2;
  }

  .origin-body {
    font-size: 16px;
  }

  .origin-hero h1 {
    font-size: 38px;
  }

  .shelf-explainer {
    font-size: 16px;
  }

  .shelf-movement h2,
  .legacy-shelf-notes h2 {
    font-size: 24px;
  }

  .movement-block h3 {
    font-size: 20px;
  }

  .site-foot {
    padding: 34px 18px 22px;
  }

  .site-foot-inner {
    grid-template-columns: 1fr;
    gap: 30px;
  }

  .footer-lead,
  .footer-legal {
    grid-column: 1;
  }

  .footer-links {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 11px 18px;
  }

  .footer-legal {
    flex-wrap: wrap;
    gap: 4px 7px;
  }
}

@media (max-width: 360px) {
  .marker-num {
    width: 18px;
    height: 22px;
  }

  .board-title h1 {
    font-size: 22px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .menu-icon i {
    transition: none;
  }
}

/* ============================================================
   STAGELIGHT — homepage-scoped dark redesign (body.stagelight)
   The site is the glass case; the sheets stay paper.
   ============================================================ */
body.stagelight {
  --sl-bg: #0b0b0c;
  --sl-ink: #f2f2f0;
  --sl-muted: rgba(242, 242, 240, 0.64);
  --sl-faint: rgba(242, 242, 240, 0.40);
  --sl-line: rgba(255, 255, 255, 0.08);
  --sl-line-strong: rgba(255, 255, 255, 0.16);
  --sl-display: "Bricolage", "Geist", system-ui, sans-serif;
  --sl-mono: "Geist Mono", ui-monospace, monospace;
  --sl-glass: linear-gradient(180deg, rgba(28,28,31,0.55), rgba(18,18,21,0.42));
  --sl-glass-shadow: 0 24px 60px -28px rgba(0,0,0,0.75), 0 2px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07);
  --sl-r: 20px;
  background: var(--sl-bg);
  color: var(--sl-ink);
  position: relative;
}
body.stagelight::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(1700px 1500px at calc(100% + 420px) -420px, rgba(40, 110, 158, 0.40), rgba(40, 110, 158, 0.12) 46%, transparent 70%),
    radial-gradient(1700px 1700px at -620px 22%, rgba(212, 81, 79, 0.30), rgba(212, 81, 79, 0.09) 46%, transparent 70%),
    radial-gradient(1900px 1800px at calc(100% + 680px) 52%, rgba(45, 124, 82, 0.28), rgba(45, 124, 82, 0.08) 46%, transparent 70%),
    radial-gradient(1500px 1400px at -520px 84%, rgba(40, 110, 158, 0.16), transparent 62%);
}
body.stagelight::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.05;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E");
}
body.stagelight > * { position: relative; z-index: 1; }
body.stagelight ::selection { background: rgba(212,81,79,0.45); color: #fff; }

/* glass utility */
.sl-glass {
  background: var(--sl-glass);
  -webkit-backdrop-filter: blur(26px) saturate(1.4); backdrop-filter: blur(26px) saturate(1.4);
  border: 1px solid var(--sl-line); border-radius: var(--sl-r); box-shadow: var(--sl-glass-shadow);
}

/* ---- NAV: brand lockup ---- */
body.stagelight .brand { display: inline-flex; align-items: center; gap: 13px; }
body.stagelight .brand-logo-sl { display: block; height: 38px; width: auto; }
body.stagelight .brand-wordmark {
  display: inline-block; font-family: var(--sl-display); font-weight: 640;
  font-size: 21px; letter-spacing: -0.012em; color: var(--sl-ink);
}

/* ---- MASTHEAD TITLE + TRAIL ---- */
body.stagelight main { color: var(--sl-ink); }
body.stagelight main h1 { font-family: var(--sl-display); color: var(--sl-ink); letter-spacing: -0.02em; }
body.stagelight .home-trail, body.stagelight .home-trail a { color: var(--sl-faint); }
body.stagelight .home-trail a:hover { color: var(--sl-ink); }

/* ---- SECTION HEADINGS ---- */
body.stagelight .section-heading h2 { font-family: var(--sl-display); color: var(--sl-ink); font-weight: 640; letter-spacing: -0.01em; }
body.stagelight .section-heading span { font-family: var(--sl-mono); color: var(--sl-faint); text-transform: uppercase; letter-spacing: 0.06em; }

/* ---- TYPE SCALE + RHYTHM ---- */
body.stagelight main { max-width: 1400px; }
body.stagelight main > section { margin-top: 96px; }
body.stagelight main > .latest-setlist { margin-top: 44px; }
body.stagelight .section-heading h2 { font-size: 34px; }
body.stagelight .section-heading { margin-bottom: 26px; }

/* ---- NAV: single glass bar, brand left, actions + hamburger right ---- */
body.stagelight .site-head {
  display: flex; align-items: center; gap: 28px; min-height: 66px;
  padding: 0 max(28px, calc((100% - 1400px) / 2));
  position: sticky; top: 0; z-index: 60;
  background: linear-gradient(180deg, rgba(16,16,18,0.78), rgba(13,13,15,0.62));
  -webkit-backdrop-filter: blur(24px) saturate(1.4); backdrop-filter: blur(24px) saturate(1.4);
  border-bottom: 1px solid var(--sl-line); box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
  transition: transform 0.3s ease;
}
body.stagelight .site-head.is-hidden { transform: translateY(-102%); }
@media (prefers-reduced-motion: reduce) { body.stagelight .site-head { transition: none; } }
body.stagelight .head-actions { margin-left: auto; display: flex; align-items: center; gap: 12px; }
body.stagelight .head-cta {
  display: inline-flex; align-items: center; height: 40px; padding: 0 20px; border-radius: 999px;
  font-size: 14px; font-weight: 580; color: var(--sl-ink);
  background: rgba(255,255,255,0.055); border: 1px solid var(--sl-line-strong);
  transition: background 0.18s ease, transform 0.18s ease;
}
body.stagelight .head-cta:hover { background: rgba(255,255,255,0.1); transform: translateY(-1px); }
body.stagelight .menu-toggle {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 42px; height: 42px; border-radius: 12px;
  border: 1px solid var(--sl-line-strong); background: rgba(255,255,255,0.04);
  transition: background 0.18s ease;
}
body.stagelight .menu-toggle:hover { background: rgba(255,255,255,0.09); }
body.stagelight .menu-toggle .menu-icon { display: block; width: 16px; height: 10px; position: relative; }
body.stagelight .menu-toggle .menu-icon i {
  position: absolute; left: 0; right: 0; height: 1.6px; background: var(--sl-ink); border-radius: 1px;
  transition: transform 0.24s ease, top 0.24s ease;
}
body.stagelight .menu-toggle .menu-icon i:first-child { top: 0; }
body.stagelight .menu-toggle .menu-icon i:last-child { top: 8.4px; }
body.stagelight .menu-open .menu-toggle .menu-icon i:first-child { top: 4.2px; transform: rotate(45deg); }
body.stagelight .menu-open .menu-toggle .menu-icon i:last-child { top: 4.2px; transform: rotate(-45deg); }

/* ---- MEGA MENU ---- */
body.stagelight .mega-menu {
  position: fixed; inset: 0; z-index: 55; overflow-y: auto;
  padding: 130px max(28px, calc((100% - 1400px) / 2)) 72px;
  background: linear-gradient(180deg, rgba(10,10,12,0.97), rgba(8,8,10,0.985));
  -webkit-backdrop-filter: blur(28px) saturate(1.3); backdrop-filter: blur(28px) saturate(1.3);
}
body.stagelight .mega-menu[hidden] { display: none; }
body.stagelight .mega-inner {
  display: grid; grid-template-columns: 1.35fr 1fr 0.85fr; gap: 40px 64px;
  animation: sl-mega-in 0.32s ease both;
}
@keyframes sl-mega-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { body.stagelight .mega-inner { animation: none; } }
body.stagelight .mega-col { border-top: 1px solid var(--sl-line-strong); padding-top: 18px; min-width: 0; }
body.stagelight .mega-label { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .mega-col-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
body.stagelight .mega-nav { display: flex; flex-direction: column; margin-top: 26px; }
body.stagelight .mega-link {
  font-family: var(--sl-display); font-size: clamp(30px, 3.2vw, 42px); font-weight: 620;
  letter-spacing: -0.015em; line-height: 1.14; padding: 7px 0; color: var(--sl-ink);
  transition: color 0.15s ease, transform 0.18s ease;
}
body.stagelight .mega-link:hover { color: #fff; transform: translateX(6px); }
body.stagelight .mega-sub {
  display: flex; align-items: baseline; gap: 12px; padding: 5px 0 5px 6px;
  font-family: var(--sl-display); font-size: clamp(20px, 2vw, 25px); font-weight: 480;
  letter-spacing: -0.01em; color: var(--sl-muted); transition: color 0.15s ease, transform 0.18s ease;
}
body.stagelight .mega-sub::before { content: "\\21B3"; color: var(--sl-faint); font-size: 0.8em; }
body.stagelight .mega-sub:hover { color: var(--sl-ink); transform: translateX(6px); }
body.stagelight .mega-more { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-muted); border-bottom: 1px solid var(--sl-line-strong); padding-bottom: 3px; }
body.stagelight .mega-more:hover { color: var(--sl-ink); border-color: var(--sl-ink); }
body.stagelight .mega-show { margin-top: 30px; }
body.stagelight .mega-show-date { display: block; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-muted); }
body.stagelight .mega-show-city { font-family: var(--sl-display); font-size: clamp(26px, 2.6vw, 34px); font-weight: 680; letter-spacing: -0.015em; margin-top: 10px; color: var(--sl-ink); }
body.stagelight .mega-show-venue { font-size: 15px; color: var(--sl-muted); margin-top: 6px; }
body.stagelight .mega-show .sc-chip { margin-top: 22px; }
body.stagelight .mega-next { margin-top: 38px; padding-top: 18px; border-top: 1px solid var(--sl-line); }
body.stagelight .mega-next-line { margin-top: 12px; display: flex; flex-direction: column; gap: 3px; }
body.stagelight .mega-next-line strong { font-size: 17px; font-weight: 620; color: var(--sl-ink); }
body.stagelight .mega-next-line span { font-size: 13.5px; color: var(--sl-muted); }
body.stagelight .mega-blurb { margin-top: 26px; font-size: 14.5px; line-height: 1.6; color: var(--sl-muted); max-width: 260px; }
body.stagelight .mega-social { display: flex; flex-direction: column; gap: 2px; margin: 22px 0 30px; }
body.stagelight .mega-social a { padding: 6px 0; font-size: 15px; color: var(--sl-muted); transition: color 0.15s ease, transform 0.18s ease; }
body.stagelight .mega-social a:hover { color: var(--sl-ink); transform: translateX(4px); }
@media (max-width: 900px) {
  body.stagelight .mega-menu { padding-top: 100px; }
  body.stagelight .mega-inner { grid-template-columns: 1fr; gap: 44px; }
  body.stagelight .head-cta { display: none; }
}

/* ---- SHOW ENTRY: one component, two states ---- */
body.stagelight .show-entry {
  position: relative; overflow: hidden; border-radius: var(--sl-r);
  background: var(--sl-glass);
  -webkit-backdrop-filter: blur(26px) saturate(1.4); backdrop-filter: blur(26px) saturate(1.4);
  border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
  margin: 0 0 16px;
}
body.stagelight .show-entry summary { position: relative; display: block; cursor: pointer; list-style: none; }
body.stagelight .show-entry summary::-webkit-details-marker { display: none; }
body.stagelight .sc-chev { position: absolute; top: 26px; right: 26px; z-index: 3; color: var(--sl-faint); transition: transform 0.22s ease; }
body.stagelight .show-entry[open] .sc-chev { transform: rotate(180deg); }
body.stagelight .sc-bg { position: absolute; inset: 0; z-index: 0; display: block; }
body.stagelight .sc-bg img { width: 100%; height: 100%; object-fit: cover; opacity: 0.5; }
body.stagelight .sc-bg::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(9,9,11,0.95) 24%, rgba(9,9,11,0.68) 58%, rgba(9,9,11,0.4)); }
body.stagelight .show-entry[open] .sc-bg { display: none; }
body.stagelight .sc-closed { position: relative; z-index: 1; display: flex; align-items: center; gap: 24px; min-height: 84px; padding: 18px 70px 18px 28px; }
body.stagelight .show-entry[open] .sc-closed { display: none; }
body.stagelight .sc-date { font-family: var(--sl-mono); font-size: 13px; letter-spacing: 0.08em; color: var(--sl-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
body.stagelight .sc-place { display: flex; flex-direction: column; min-width: 0; }
body.stagelight .sc-place strong { font-family: var(--sl-display); font-weight: 640; font-size: 19px; letter-spacing: -0.005em; color: var(--sl-ink); }
body.stagelight .sc-place small { font-size: 13px; color: var(--sl-muted); margin-top: 2px; }
body.stagelight .sc-lockup { display: none; }
body.stagelight .show-entry[open] .sc-lockup,
body.stagelight .show-entry.is-latest[open] .sc-lockup { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 44px; align-items: center; padding: 44px 84px 0 44px; }
body.stagelight .show-entry.no-image[open] .sc-lockup { grid-template-columns: 1fr; padding-right: 84px; }
body.stagelight .sc-lock { display: block; }
body.stagelight .sc-eyebrow { display: block; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-muted); }
body.stagelight .sc-city { display: block; font-family: var(--sl-display); font-weight: 720; font-size: 40px; letter-spacing: -0.015em; line-height: 1.05; margin: 12px 0 0; color: var(--sl-ink); }
body.stagelight .show-entry.is-latest .sc-city { font-size: 56px; letter-spacing: -0.02em; }
body.stagelight .sc-venue { display: block; font-size: 16px; color: var(--sl-muted); margin-top: 10px; font-weight: 440; }
body.stagelight .sc-chips { display: flex; gap: 12px; margin-top: 28px; flex-wrap: wrap; }
body.stagelight .sc-chip { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 18px; border-radius: 999px; font-size: 14px; font-weight: 560; white-space: nowrap; transition: transform 0.18s ease, background 0.18s ease; }
body.stagelight .sc-chip svg { flex: none; }
body.stagelight .sc-chip-primary { background: var(--sl-ink); color: #111; box-shadow: 0 8px 24px -8px rgba(242,242,240,0.35), inset 0 1px 0 rgba(255,255,255,0.9); border: 0; }
body.stagelight .sc-chip-primary:hover { transform: translateY(-1px); background: #fff; }
body.stagelight .sc-chip-glass { background: rgba(255,255,255,0.055); border: 1px solid var(--sl-line-strong); color: var(--sl-ink); }
body.stagelight .sc-chip-glass:hover { transform: translateY(-1px); background: rgba(255,255,255,0.09); }
body.stagelight .sc-photo { display: block; position: relative; }
body.stagelight .sc-photo img { width: 100%; height: auto; border-radius: 14px; border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 30px 60px -24px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.1); }
body.stagelight .sc-body { padding: 0 44px 36px; }
body.stagelight .show-entry.is-latest .sc-body { padding: 0 44px 40px; }
body.stagelight .sc-sets { border-top: 1px solid var(--sl-line); margin-top: 32px; padding-top: 30px; display: grid; gap: 18px; }
body.stagelight .sc-row { display: grid; grid-template-columns: 96px 1fr; gap: 20px; }
body.stagelight .sc-label { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.18em; color: var(--sl-faint); text-transform: uppercase; padding-top: 5px; white-space: nowrap; }
body.stagelight .sc-prose { font-size: 17px; line-height: 1.68; font-weight: 430; color: var(--sl-ink); margin: 0; }
body.stagelight .sc-prose a { color: inherit; }
body.stagelight .sc-preview-note { font-size: 14px; color: var(--sl-faint); margin: 0; }
body.stagelight .sc-notes .setlist-annotations { color: var(--sl-faint); font-size: 13px; }
body.stagelight .sc-pulls { border-top: 1px solid var(--sl-line); margin-top: 6px; padding-top: 22px; }
body.stagelight .sc-pull-list { display: flex; flex-wrap: wrap; gap: 10px 28px; align-items: baseline; }
body.stagelight .sc-pull { font-size: 15px; line-height: 1.6; }
body.stagelight .sc-pull svg { display: inline-block; vertical-align: baseline; margin-right: 6px; height: 10px; width: auto; }
body.stagelight .sc-pull .rarity-symbol svg { height: 10px; }
body.stagelight .sc-tier { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-muted); margin-right: 6px; }
body.stagelight .sc-pull b { font-weight: 600; white-space: nowrap; color: var(--sl-ink); }
body.stagelight .sc-pull [fill="#111111"] { fill: #f2f2f0; }
body.stagelight .sc-pull [stroke="#111111"] { stroke: #f2f2f0; }
body.stagelight .current-stop-setlists { display: grid; gap: 16px; margin-top: 16px; }
body.stagelight .setlist-list { display: grid; gap: 16px; }
body.stagelight .setlist-archive-panel > summary { display: none; }
@media (max-width: 560px) {
  body.stagelight .site-head { gap: 16px; }
  body.stagelight .brand-wordmark { font-size: 19px; }
}
@media (max-width: 900px) {
  body.stagelight .show-entry[open] .sc-lockup,
  body.stagelight .show-entry.is-latest[open] .sc-lockup { grid-template-columns: 1fr; gap: 24px; padding: 26px 22px 0; }
  body.stagelight .show-entry.is-latest .sc-city { font-size: 38px; }
  body.stagelight .sc-city { font-size: 28px; }
  body.stagelight .sc-body, body.stagelight .show-entry.is-latest .sc-body { padding: 0 22px 26px; }
  body.stagelight .sc-row { grid-template-columns: 1fr; gap: 6px; }
  body.stagelight .sc-label { padding-top: 0; }
  body.stagelight .sc-closed { padding: 16px 56px 16px 20px; gap: 12px; flex-wrap: wrap; }
  body.stagelight .sc-chev { top: 22px; right: 18px; }
}

/* ---- DATA METRICS (stat tiles) ---- */
body.stagelight .data-metrics .nick-stat {
  background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line); border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
}
body.stagelight .data-metrics .nick-stat strong { font-family: var(--sl-mono); color: var(--sl-ink); }
body.stagelight .data-metrics .nick-stat span { font-family: var(--sl-mono); color: var(--sl-faint); text-transform: uppercase; letter-spacing: 0.12em; }

/* ---- TOOLBAR CONTROLS ---- */
body.stagelight .data-toolbar { color: var(--sl-muted); }
body.stagelight .data-toolbar .show-filter span { font-family: var(--sl-mono); color: var(--sl-faint); text-transform: uppercase; letter-spacing: 0.12em; }
body.stagelight .data-toolbar select {
  background: rgba(255,255,255,0.05); color: var(--sl-ink); border: 1px solid var(--sl-line-strong); border-radius: 999px;
}
body.stagelight .data-toolbar select option { color: #111; }
body.stagelight .type-filter { border: 1px solid var(--sl-line-strong); background: rgba(255,255,255,0.04); border-radius: 999px; }
body.stagelight .type-filter button { color: var(--sl-muted); }
body.stagelight .type-filter button[aria-pressed="true"], body.stagelight .type-filter button.is-active { background: var(--sl-ink); color: #111; }

/* ---- DATA TABLES (tour stats, shelf watch) ---- */
body.stagelight .tour-stats, body.stagelight .shelf-watch {
  background: var(--sl-glass);
  -webkit-backdrop-filter: blur(26px) saturate(1.4); backdrop-filter: blur(26px) saturate(1.4);
  border: 1px solid var(--sl-line); border-radius: var(--sl-r); box-shadow: var(--sl-glass-shadow);
}
body.stagelight .data-table, body.stagelight .tour-table { color: var(--sl-ink); }
body.stagelight .tour-table thead th { background: rgba(17,17,20,0.94); }
body.stagelight .data-table th, body.stagelight .tour-table th[scope="col"], body.stagelight .data-table thead th {
  font-family: var(--sl-mono); color: var(--sl-faint); text-transform: uppercase; letter-spacing: 0.1em;
  border-bottom: 1px solid var(--sl-line);
}
body.stagelight .data-table td, body.stagelight .tour-table td { border-bottom: 1px solid rgba(255,255,255,0.05); }
body.stagelight .data-table tbody tr:hover, body.stagelight .tour-table tbody tr:hover { background: rgba(255,255,255,0.035); }
body.stagelight .data-table th[scope="row"], body.stagelight .tour-table th[scope="row"] { color: var(--sl-ink); }
body.stagelight .data-table td, body.stagelight .data-table strong { color: var(--sl-ink); }
body.stagelight .tour-table .tc-num, body.stagelight .data-table .mono, body.stagelight .slp { font-family: var(--sl-mono); }
body.stagelight .tour-table button { color: var(--sl-muted); font-family: var(--sl-mono); }
body.stagelight .tour-table button:hover, body.stagelight .tour-table button[aria-sort] { color: var(--sl-ink); }
body.stagelight .slp-progress { background: rgba(255,255,255,0.1); }
body.stagelight .slp-progress i { background: var(--red); }

/* ---- UPCOMING DATES (inside Setlists) ---- */
body.stagelight .upcoming-dates {
  margin-top: 20px; border-radius: var(--sl-r); overflow: hidden;
  background: var(--sl-glass);
  -webkit-backdrop-filter: blur(26px) saturate(1.4); backdrop-filter: blur(26px) saturate(1.4);
  border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
}
body.stagelight .upcoming-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 20px 26px 14px; }
body.stagelight .upcoming-heading h3 { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.18em; font-weight: 600; color: var(--sl-ink); }
body.stagelight .upcoming-heading span { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.08em; color: var(--sl-faint); text-transform: uppercase; }
body.stagelight .tour-dates li { border-top: 1px solid rgba(255,255,255,0.05); }
body.stagelight .tour-dates li time { font-family: var(--sl-mono); color: var(--sl-muted); }
body.stagelight .tour-dates li strong { color: var(--sl-ink); }
body.stagelight .tour-dates li span { color: var(--sl-muted); }
body.stagelight .tour-dates li em { font-family: var(--sl-mono); color: var(--sl-faint); text-transform: uppercase; letter-spacing: 0.12em; font-style: normal; }

/* ---- SHEET KEY ---- */
body.stagelight .sheet-key, body.stagelight .sheet-key h2, body.stagelight .sheet-key h3 { color: var(--sl-ink); }
body.stagelight .sheet-key p, body.stagelight .marker-legend em { color: var(--sl-muted); }
body.stagelight .marker-legend strong { color: var(--sl-ink); }
body.stagelight .key-block { border-color: var(--sl-line); }

/* ---- NICK FEATURE ---- */
body.stagelight .nick-feature {
  background: var(--sl-glass);
  -webkit-backdrop-filter: blur(26px) saturate(1.4); backdrop-filter: blur(26px) saturate(1.4);
  border: 1px solid var(--sl-line); border-radius: var(--sl-r); box-shadow: var(--sl-glass-shadow); color: var(--sl-ink);
}
body.stagelight .nick-feature h2, body.stagelight .nick-feature h3 { color: var(--sl-ink); font-family: var(--sl-display); }
body.stagelight .nick-feature p { color: var(--sl-muted); }
body.stagelight .nick-summary .nick-stat { background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line); border-radius: 16px; }
body.stagelight .nick-summary .nick-stat strong { font-family: var(--sl-mono); color: var(--sl-ink); }
body.stagelight .nick-progress > div:first-child strong { font-family: var(--sl-mono); font-size: 26px; font-weight: 640; color: var(--sl-ink); }
body.stagelight .nick-progress > div:first-child span { font-size: 13.5px; color: var(--sl-muted); }
body.stagelight .nick-progress-track i.is-original { background: var(--green); }
body.stagelight .nick-progress-track i.is-cover { background: rgba(96, 165, 210, 0.85); }
body.stagelight .progress-key span { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.06em; color: var(--sl-faint); text-transform: uppercase; }
body.stagelight .progress-key .key-original { background: var(--green); }
body.stagelight .progress-key .key-cover { background: rgba(96, 165, 210, 0.85); }
body.stagelight .progress-key .key-unplayed { background: rgba(255,255,255,0.18); }
body.stagelight .nick-ranking-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin: 6px 0 10px; }
body.stagelight .nick-ranking-heading h3 { font-size: 17px; font-weight: 640; letter-spacing: 0; }
body.stagelight .nick-ranking-heading span { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.1em; color: var(--sl-faint); text-transform: uppercase; }
body.stagelight .nick-ranking li { padding: 12px 10px; }
body.stagelight .nick-ranking li:hover { background: rgba(255,255,255,0.025); }
body.stagelight .nick-rank { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); font-variant-numeric: tabular-nums; }
body.stagelight .nick-song { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
body.stagelight .nick-song strong { font-size: 15.5px; font-weight: 600; color: var(--sl-ink); letter-spacing: 0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
body.stagelight .nick-song small { font-family: var(--sl-mono); font-size: 10px; letter-spacing: 0.14em; color: var(--sl-faint); text-transform: uppercase; flex: none; }
body.stagelight .nick-plays { display: flex; align-items: baseline; gap: 6px; justify-self: end; }
body.stagelight .nick-plays strong { font-family: var(--sl-mono); font-size: 16px; font-weight: 620; color: var(--sl-ink); font-variant-numeric: tabular-nums; }
body.stagelight .nick-plays small { font-family: var(--sl-mono); font-size: 10.5px; letter-spacing: 0.1em; color: var(--sl-faint); text-transform: uppercase; }
body.stagelight .nick-ranking li.is-zero { opacity: 0.45; }
body.stagelight .nick-played-panel { margin-top: 18px; border-top: 1px solid var(--sl-line); }
body.stagelight .nick-played-panel > summary { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 16px 10px 6px; font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.12em; color: var(--sl-faint); }
body.stagelight .nick-played-panel > summary:hover { color: var(--sl-ink); }
body.stagelight .nick-played-panel > summary strong { font-size: 12px; color: var(--sl-muted); }
body.stagelight .nick-disclosure > summary { width: 100%; }

/* ---- COMMUNITY LINKS ---- */
body.stagelight .ticket-link {
  background: var(--sl-ink); color: #111; border: 0; border-radius: 999px; font-weight: 650;
  box-shadow: 0 8px 24px -8px rgba(242,242,240,0.35), inset 0 1px 0 rgba(255,255,255,0.9);
}
body.stagelight .ticket-link:hover { background: #fff; }

/* ---- RARITY SYMBOLS: light ink shapes on dark (silver/gold kept) ---- */
body.stagelight .rarity-symbol [fill="#111111"] { fill: #f2f2f0; }
body.stagelight .rarity-symbol [stroke="#111111"] { stroke: #f2f2f0; }

/* ---- OLD-SETLIST ROWS: brighten actions + row text ---- */
body.stagelight .setlist-row summary { color: var(--sl-ink); }
body.stagelight .setlist-row time { font-family: var(--sl-mono); color: var(--sl-muted); }
body.stagelight .show-place strong { color: var(--sl-ink); }
body.stagelight .show-place small { color: var(--sl-muted); }
body.stagelight .show-action { color: var(--sl-muted); border-color: var(--sl-line-strong); }
body.stagelight .show-action:hover { color: var(--sl-ink); }
body.stagelight .play-action { border: 1px solid var(--sl-line-strong); }
body.stagelight .row-toggle { color: var(--sl-faint); }
body.stagelight .setlist-row[open] .row-toggle { color: var(--sl-ink); }
body.stagelight .setlist-row { border-bottom: 1px solid var(--sl-line); }
body.stagelight .setlist-section .setlist-text, body.stagelight .setlist-row-body { color: var(--sl-ink); }

/* ---- FOOTER ---- */
body.stagelight .site-foot {
  margin-top: 120px; position: relative;
  background: linear-gradient(180deg, rgba(15,15,17,0.72), rgba(9,9,11,0.92));
  -webkit-backdrop-filter: blur(24px) saturate(1.4); backdrop-filter: blur(24px) saturate(1.4);
  border-top: 1px solid var(--sl-line); color: var(--sl-muted);
}
body.stagelight .site-foot::before {
  content: ""; position: absolute; top: -1px; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.28), transparent);
}
body.stagelight .site-foot-inner {
  display: grid; grid-template-columns: 1.5fr 1fr 1fr; gap: 24px 56px;
  padding: 64px 0 32px; align-items: start;
}
body.stagelight .footer-brand { display: inline-flex; align-items: center; gap: 12px; font-family: var(--sl-display); color: var(--sl-ink); font-weight: 640; font-size: 22px; letter-spacing: -0.012em; }
body.stagelight .footer-mark { height: 34px; width: auto; }
body.stagelight .footer-lead p { color: var(--sl-faint); margin-top: 14px; max-width: 300px; font-size: 14px; line-height: 1.6; }
body.stagelight .footer-links strong, body.stagelight .social-links strong { font-family: var(--sl-mono); color: var(--sl-faint); text-transform: uppercase; letter-spacing: 0.16em; }
body.stagelight .footer-links a, body.stagelight .social-links a { color: var(--sl-muted); transition: color 0.15s ease, transform 0.15s ease; }
body.stagelight .footer-links a:hover, body.stagelight .social-links a:hover { color: var(--sl-ink); transform: translateX(2px); }
body.stagelight .social-mark { background: rgba(255,255,255,0.06); border: 1px solid var(--sl-line-strong); color: var(--sl-muted); }
body.stagelight .footer-bottom {
  grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap;
  margin-top: 34px; padding-top: 22px; border-top: 1px solid var(--sl-line);
}
body.stagelight .footer-legal { font-family: var(--sl-mono); font-size: 11.5px; letter-spacing: 0.04em; color: var(--sl-faint); margin: 0; }
body.stagelight .footer-legal span { margin: 0 8px; }
body.stagelight .back-top { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .back-top:hover { color: var(--sl-ink); }
@media (max-width: 760px) {
  body.stagelight .site-foot-inner { grid-template-columns: 1fr 1fr; padding: 48px 0 28px; gap: 32px 24px; }
  body.stagelight .footer-lead { grid-column: 1 / -1; }
}

/* ---- BENTO CARDS: Sheet Key / Shelf / Purgatory / Woodshed ---- */
body.stagelight .bento-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 44px; }
body.stagelight .bento-key { grid-column: 1 / -1; cursor: default; padding: 24px 26px 18px; }
body.stagelight .bento-key:hover { transform: none; border-color: var(--sl-line); }
body.stagelight .bento-card {
  position: relative; text-align: left; padding: 26px; cursor: pointer;
  font: inherit; color: var(--sl-ink);
  background: var(--sl-glass);
  -webkit-backdrop-filter: blur(26px) saturate(1.4); backdrop-filter: blur(26px) saturate(1.4);
  border: 1px solid var(--sl-line); border-radius: var(--sl-r); box-shadow: var(--sl-glass-shadow);
  transition: transform 0.18s ease, border-color 0.18s ease;
}
body.stagelight .bento-card:hover { transform: translateY(-2px); border-color: rgba(255,255,255,0.2); }
body.stagelight .bento-card[aria-expanded="true"] { border-color: rgba(255,255,255,0.24); }
body.stagelight .bento-shelf[aria-expanded="true"] { box-shadow: var(--sl-glass-shadow), 0 0 60px -18px rgba(212,81,79,0.4); }
body.stagelight .bento-purgatory[aria-expanded="true"] { box-shadow: var(--sl-glass-shadow), 0 0 60px -18px rgba(40,110,158,0.45); }
body.stagelight .bento-woodshed[aria-expanded="true"] { box-shadow: var(--sl-glass-shadow), 0 0 60px -18px rgba(45,124,82,0.45); }
body.stagelight .bc-open { position: absolute; top: 22px; right: 24px; color: var(--sl-faint); font-size: 22px; line-height: 1; font-weight: 300; transition: transform 0.2s ease; }
body.stagelight .bento-card[aria-expanded="true"] .bc-open { transform: rotate(45deg); color: var(--sl-ink); }
body.stagelight .bc-name { display: block; font-family: var(--sl-display); font-weight: 640; font-size: 21px; letter-spacing: -0.005em; }
body.stagelight .bc-count { display: block; font-family: var(--sl-mono); font-size: 38px; font-weight: 640; margin-top: 14px; font-variant-numeric: tabular-nums; }
body.stagelight .bc-count small { font-size: 13px; color: var(--sl-faint); font-weight: 500; letter-spacing: 0.08em; margin-left: 8px; }
body.stagelight .bc-desc { display: block; font-size: 13.5px; color: var(--sl-muted); margin-top: 10px; line-height: 1.5; min-height: 42px; }
body.stagelight .bc-fact { display: flex; justify-content: space-between; gap: 12px; font-family: var(--sl-mono); font-size: 11px; color: var(--sl-faint); margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06); }
body.stagelight .bc-bar { display: block; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.1); margin-top: 16px; overflow: hidden; }
body.stagelight .bc-bar i { display: block; height: 100%; background: var(--green); }
body.stagelight .bento-panel {
  position: fixed; inset: 0; z-index: 90; overflow-y: auto;
  padding: 28px 4vw 9vh;
  background: rgba(4,4,6,0.85);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
}
body.stagelight .bento-panel .laminate { max-width: 1240px; margin: 0 auto; }
body.stagelight .bento-panel[hidden] { display: none; }
body.stagelight .bento-close {
  position: fixed; top: 18px; right: 22px; z-index: 95;
  display: inline-flex; align-items: center; justify-content: center;
  width: 42px; height: 42px; border-radius: 50%;
  background: rgba(24,24,27,0.85); border: 1px solid var(--sl-line-strong); color: var(--sl-ink);
  box-shadow: 0 10px 30px -10px rgba(0,0,0,0.8);
  transition: background 0.18s ease, transform 0.18s ease;
}
body.stagelight .bento-close:hover { background: rgba(46,46,50,0.95); transform: scale(1.05); }
@media (max-width: 900px) { body.stagelight .bento-grid { grid-template-columns: 1fr; } }

/* ---- CLOSED-BAR MINI PULLS ---- */
body.stagelight .sc-mini-pulls { margin-left: auto; display: inline-flex; align-items: baseline; gap: 8px; font-size: 14px; color: var(--sl-muted); white-space: nowrap; }
body.stagelight .sc-mini-pulls b { color: var(--sl-ink); font-weight: 600; }
body.stagelight .sc-mini-pulls svg { height: 9px; width: auto; }
body.stagelight .sc-mini-pulls [fill="#111111"] { fill: #f2f2f0; }
body.stagelight .sc-mini-pulls [stroke="#111111"] { stroke: #f2f2f0; }
body.stagelight .sc-more { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.1em; color: var(--sl-faint); }

/* ---- NEXT SHOW STRIP ---- */

body.stagelight .ns-tag { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.18em; color: var(--sl-faint); text-transform: uppercase; margin: 0; }
body.stagelight .ns-city { font-family: var(--sl-display); font-weight: 640; font-size: 22px; letter-spacing: -0.005em; line-height: 1.15; margin: 2px 0 0; }
body.stagelight .ns-venue { font-size: 14px; color: var(--sl-muted); margin: 2px 0 0; }
body.stagelight .ns-meta { display: flex; align-items: center; gap: 22px; margin-left: auto; flex-wrap: wrap; }
body.stagelight .ns-date { font-family: var(--sl-mono); font-size: 14px; letter-spacing: 0.06em; }
body.stagelight .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--red); box-shadow: 0 0 10px rgba(212,81,79,0.9); animation: sl-pulse 2.4s ease-in-out infinite; }
@keyframes sl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { body.stagelight .live-dot { animation: none; } }
@media (max-width: 760px) {
  body.stagelight .next-strip { padding: 20px; gap: 14px; }
  body.stagelight .ns-meta { margin-left: 0; width: 100%; justify-content: space-between; }
  body.stagelight .sc-mini-pulls { margin-left: 0; width: 100%; }
}

/* ---- TOUR STATS DENSITY + RARITY SYMBOLS ---- */
body.stagelight .signal-cell strong { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 620; }
body.stagelight .signal-cell small { display: block; margin-top: 4px; font-family: var(--sl-mono); font-size: 11px; color: var(--sl-faint); letter-spacing: 0.02em; font-weight: 400; }
body.stagelight .tour-table td, body.stagelight .tour-table th[scope="row"] { vertical-align: top; }
body.stagelight .data-toolbar .mobile-sort { display: none; }
body.stagelight .data-toolbar select {
  -webkit-appearance: none; appearance: none; border: 0; background: transparent;
  font-weight: 560; font-size: 14px; color: var(--sl-ink); padding: 0 4px;
}
body.stagelight .data-toolbar select:focus-visible { outline: 2px solid rgba(242,242,240,0.35); outline-offset: 3px; border-radius: 6px; }
body.stagelight .show-filter { gap: 12px; }
@media (max-width: 760px) {
  body.stagelight .data-toolbar .mobile-sort { display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--sl-line-strong); }
  body.stagelight .data-toolbar .mobile-sort span { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); }
}

/* ---- RARITY FILTER ---- */
body.stagelight .rarity-filter { position: relative; }
body.stagelight .rarity-filter > summary {
  display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 16px;
  border-radius: 999px; border: 1px solid var(--sl-line-strong); font-size: 13px; font-weight: 560; color: var(--sl-muted);
  transition: background 0.15s ease, color 0.15s ease;
}
body.stagelight .rarity-filter > summary:hover { color: var(--sl-ink); background: rgba(255,255,255,0.05); }
body.stagelight .rarity-filter[open] > summary { color: var(--sl-ink); border-color: rgba(255,255,255,0.3); }
body.stagelight .rarity-filter > summary .sc-chev { position: static; transition: transform 0.2s ease; }
body.stagelight .rarity-filter[open] > summary .sc-chev { transform: rotate(180deg); }
body.stagelight .rf-active {
  display: inline-flex; align-items: center; justify-content: center; min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 999px; background: var(--sl-ink); color: #111; font-family: var(--sl-mono); font-size: 11px; font-weight: 640;
}
body.stagelight .rf-active[hidden] { display: none; }
body.stagelight .rarity-pop {
  position: absolute; top: 48px; left: 0; z-index: 40; min-width: 280px; padding: 10px;
  border-radius: 16px; background: rgba(19,19,22,0.97); border: 1px solid var(--sl-line-strong);
  box-shadow: 0 24px 60px -18px rgba(0,0,0,0.85);
}
body.stagelight .rf-option {
  display: grid; grid-template-columns: auto 46px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: 10px; cursor: pointer; font-size: 13.5px; color: var(--sl-ink);
}
body.stagelight .rf-option:hover { background: rgba(255,255,255,0.05); }
body.stagelight .rf-option input {
  appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin: 0;
  border: 1.5px solid var(--sl-line-strong); border-radius: 5px; cursor: pointer; position: relative;
}
body.stagelight .rf-option input:checked { background: var(--sl-ink); border-color: var(--sl-ink); }
body.stagelight .rf-option input:checked::after {
  content: ""; position: absolute; left: 4.5px; top: 1.5px; width: 4px; height: 8px;
  border: solid #111; border-width: 0 1.8px 1.8px 0; transform: rotate(45deg);
}
body.stagelight .rf-option .rarity-symbol { margin: 0; justify-self: start; }
body.stagelight .rf-count { font-family: var(--sl-mono); font-size: 11.5px; color: var(--sl-faint); font-variant-numeric: tabular-nums; }
body.stagelight .rf-clear {
  display: block; width: 100%; margin-top: 6px; padding: 9px 10px; border-top: 1px solid var(--sl-line);
  font-family: var(--sl-mono); font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--sl-faint); text-align: left; border-radius: 0 0 10px 10px;
}
body.stagelight .rf-clear:hover { color: var(--sl-ink); }
@media (max-width: 760px) { body.stagelight .rarity-pop { left: auto; right: 0; } }

body.stagelight .tour-stats { padding: 26px 28px 20px; }
body.stagelight .tour-table th, body.stagelight .tour-table td,
body.stagelight .data-table th, body.stagelight .data-table td { padding: 16px 18px; }
body.stagelight .rarity-symbol { display: inline-flex; align-items: center; min-width: 26px; margin-right: 8px; }
body.stagelight .rarity-symbol svg { height: 10px; width: auto; display: block; }

/* ---- BOARD INTRO ---- */
body.stagelight .board-intro { text-align: center; margin-top: 96px; }
body.stagelight .board-intro h2 { font-family: var(--sl-display); font-size: 34px; font-weight: 640; letter-spacing: -0.01em; }
body.stagelight .board-intro-sub { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.08em; color: var(--sl-faint); margin-top: 10px; }
body.stagelight main > .board-intro + section { margin-top: 44px; }

/* ---- SHEET KEY BENTO ---- */
body.stagelight .key-strip { display: flex; align-items: center; gap: 20px 40px; flex-wrap: wrap; }
body.stagelight .key-head { max-width: 260px; }
body.stagelight .sheet-key h2 { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.18em; font-weight: 600; }
body.stagelight .key-head p { font-size: 13px; color: var(--sl-faint); margin-top: 6px; line-height: 1.5; }
body.stagelight .key-strip .marker-legend { margin-left: auto; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
body.stagelight .key-strip .marker-legend li { flex-direction: column; align-items: flex-start; gap: 8px; border-radius: 14px; padding: 12px 14px; background: rgba(255,255,255,0.025); }
body.stagelight .key-strip .marker-legend img { width: 26px; }
body.stagelight .key-strip .marker-legend span { display: flex; flex-direction: column; }
body.stagelight .key-strip .marker-legend strong { font-size: 12.5px; }
body.stagelight .key-strip .marker-legend em { font-family: var(--sl-mono); font-size: 10.5px; letter-spacing: 0.04em; color: var(--sl-faint); margin-top: 2px; }
body.stagelight .key-more { margin-top: 18px; border-top: 1px solid var(--sl-line); }
body.stagelight .key-more summary { display: flex; align-items: center; gap: 10px; padding: 14px 0 4px; font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .key-more summary:hover { color: var(--sl-ink); }
body.stagelight .key-more summary .sc-chev { position: static; transition: transform 0.2s ease; }
body.stagelight .key-more[open] summary .sc-chev { transform: rotate(180deg); }
body.stagelight .key-more .key-topline { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 28px; margin-top: 16px; padding-bottom: 6px; }
body.stagelight .key-block h3 { font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 8px; color: var(--sl-muted); }
body.stagelight .key-block p, body.stagelight .key-block li, body.stagelight .key-block dd, body.stagelight .key-block dt { font-size: 13px; color: var(--sl-muted); }
body.stagelight .key-block dt { color: var(--sl-ink); font-weight: 600; }
body.stagelight .key-points li { display: flex; gap: 10px; padding: 3px 0; }
body.stagelight .key-points strong { color: var(--sl-ink); }
body.stagelight .key-other-sheets dl { display: grid; gap: 8px; margin-top: 8px; }
body.stagelight .key-other-sheets dd { margin: 2px 0 0; }
@media (max-width: 900px) {
  body.stagelight .key-more .key-topline { grid-template-columns: 1fr; }
  body.stagelight .key-strip .marker-legend { margin-left: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  body.stagelight .key-head { max-width: none; }
}

/* ---- NEXT-SHOW STRIP (closed accordion) ---- */
body.stagelight .next-strip {
  margin-top: 16px; border-radius: var(--sl-r); overflow: hidden;
  background: var(--sl-glass);
  -webkit-backdrop-filter: blur(26px) saturate(1.4); backdrop-filter: blur(26px) saturate(1.4);
  border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
}
body.stagelight .next-strip summary { position: relative; display: block; padding: 22px 64px 22px 30px; }
body.stagelight .next-strip .sc-chev { position: absolute; top: 30px; right: 26px; }
body.stagelight .next-strip[open] .sc-chev { transform: rotate(180deg); }
body.stagelight .ns-row { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; }
body.stagelight .ns-tag { display: block; font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.18em; color: var(--sl-faint); text-transform: uppercase; }
body.stagelight .ns-city { display: block; font-family: var(--sl-display); font-weight: 640; font-size: 22px; letter-spacing: -0.005em; line-height: 1.15; margin-top: 2px; }
body.stagelight .ns-venue { display: block; font-size: 14px; color: var(--sl-muted); margin-top: 2px; }
body.stagelight .ns-meta { display: flex; align-items: center; gap: 22px; margin-left: auto; flex-wrap: wrap; }
body.stagelight .ns-date { font-family: var(--sl-mono); font-size: 14px; letter-spacing: 0.06em; }
body.stagelight .ns-body { padding: 0 30px 26px; display: grid; gap: 16px; justify-items: start; }
body.stagelight .ns-photo img { border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); max-width: 520px; width: 100%; }

/* ---- HERO PHOTO SHEEN ---- */
body.stagelight .sc-photo::after { content: ""; position: absolute; inset: 0; border-radius: 14px; background: linear-gradient(200deg, rgba(255,255,255,0.10), transparent 38%); pointer-events: none; }

/* ---- SHELF WATCH HEAT CARDS ---- */
body.stagelight .shelf-watch { background: none; border: 0; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; }
body.stagelight .shelf-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
body.stagelight .shelf-card {
  padding: 24px; position: relative; border-radius: var(--sl-r);
  background: var(--sl-glass);
  -webkit-backdrop-filter: blur(26px) saturate(1.4); backdrop-filter: blur(26px) saturate(1.4);
  border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
  transition: transform 0.18s ease;
}
body.stagelight .shelf-card:hover { transform: translateY(-2px); }
body.stagelight .shelf-card .n { font-family: var(--sl-mono); font-size: 34px; font-weight: 640; line-height: 1; font-variant-numeric: tabular-nums; margin: 0; }
body.stagelight .shelf-card .to { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.18em; color: var(--sl-faint); text-transform: uppercase; margin: 7px 0 0; }
body.stagelight .shelf-card .song { font-size: 17px; font-weight: 580; margin: 16px 0 0; line-height: 1.35; }
body.stagelight .shelf-card .slp { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.1em; color: var(--sl-muted); margin: 6px 0 0; }
body.stagelight .heat-hot { border-color: rgba(212,81,79,0.42); box-shadow: var(--sl-glass-shadow), 0 0 56px -6px rgba(212,81,79,0.35), inset 0 1px 0 rgba(255,177,175,0.16); }
body.stagelight .heat-hot .n { color: #ef9390; text-shadow: 0 0 24px rgba(212,81,79,0.65); }
body.stagelight .heat-warm { border-color: rgba(212,81,79,0.2); box-shadow: var(--sl-glass-shadow), 0 0 40px -8px rgba(212,81,79,0.16); }
body.stagelight .heat-warm .n { color: #e5b3b1; }
body.stagelight .shelf-note { font-size: 13px; color: var(--sl-faint); margin-top: 18px; }
@media (max-width: 900px) { body.stagelight .shelf-grid { grid-template-columns: 1fr; } }

/* ---- PAGE TITLE + TRAIL: quiet overline, not a masthead ---- */
body.stagelight main > h1 {
  font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.22em;
  color: var(--sl-faint); text-transform: uppercase; font-weight: 500;
  margin: 34px 0 0;
}
body.stagelight .home-trail { margin-top: 6px; }
body.stagelight .home-trail a { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.08em; text-decoration: none; text-transform: uppercase; }
body.stagelight .ticket-link { text-decoration: none; }

/* ---- THE PAPER SHEETS: keep white, add the spotlight case ---- */
/* the sheets are paper artifacts — undo the dark-page text/heading cascade */
body.stagelight .laminate { position: relative; color: #111; }
body.stagelight .primary-board::before,
body.stagelight .shelf-board::before,
body.stagelight .woodshed-board::before,
body.stagelight .purgatory-board::before {
  content: ""; position: absolute; inset: -60px -30px; z-index: -1; pointer-events: none;
  background: radial-gradient(58% 50% at 50% 44%, rgba(255,243,224,0.14), rgba(255,243,224,0.045) 55%, transparent 78%);
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

function renderRedirects(archiveEntries = [], generatedReviews = []) {
  const reviewByYear = new Map(generatedReviews.map((review) => {
    const match = clean(review.path).match(/^\/?(\d{4})\//);
    return match ? [match[1], publicPath(review.path)] : null;
  }).filter(Boolean));
  const review2025Path = reviewByYear.get("2025") || "/";
  const lines = [
    ...[...legacyCoreRoutes].flatMap(([source, target]) => [
      `${source} ${target} 301`,
      `${source}.html ${target} 301`
    ]),
    "/tour-in-review /tour-in-review/ 301",
    `/2025/02/widespread-panic-2025-tour.html ${review2025Path} 301`,
    `/2025/02/widespread-panic-2025-tour ${review2025Path} 301`,
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
      if (sourcePath === "/2025/02/widespread-panic-2025-tour.html" || sourcePath === "/2025/02/widespread-panic-2025-tour") continue;
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

function renderSitemap(data, archiveEntries = [], songOrigins = [], generatedReviews = []) {
  const updated = data.site.latestShow?.isoDate || data.generatedAt.slice(0, 10);
  const redirectedArchivePaths = new Set([
    "/2025/02/widespread-panic-2025-tour",
    "/2025/02/widespread-panic-2025-tour.html"
  ]);
  const redirectedCorePaths = new Set([...legacyCoreRoutes.keys()]);
  const sitemapArchiveEntries = archiveEntries.filter((entry) => {
    const route = publicPath(entry.path);
    return !redirectedArchivePaths.has(route) && !redirectedArchivePaths.has(entry.path) && !redirectedCorePaths.has(route);
  });
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
    <loc>https://burnthday.com/rumors/</loc>
  </url>
  <url>
    <loc>https://burnthday.com/lyrics-chords/</loc>
  </url>
  <url>
    <loc>https://burnthday.com/song-origins/</loc>
  </url>
  <url>
    <loc>https://burnthday.com/tour-in-review/</loc>
  </url>
  <url>
    <loc>https://burnthday.com/shelf/</loc>
  </url>
  <url>
    <loc>https://burnthday.com/about/</loc>
  </url>
  <url>
    <loc>https://burnthday.com/privacy/</loc>
  </url>
  ${songOrigins.map((origin) => `<url>
    <loc>https://burnthday.com/song-origins/${escapeHtml(origin.slug)}/</loc>
  </url>`).join("\n  ")}
  ${generatedReviews.map((review) => `<url>
    <loc>https://burnthday.com${escapeHtml(publicPath(review.path))}</loc>
    <lastmod>${(review.published || updated).slice(0, 10)}</lastmod>
  </url>`).join("\n  ")}
  ${sitemapArchiveEntries.map((entry) => `<url>
    <loc>https://burnthday.com${escapeHtml(publicPath(entry.path))}</loc>
    <lastmod>${(entry.updated || entry.published || updated).slice(0, 10)}</lastmod>
  </url>`).join("\n  ")}
</urlset>
`;
}

function publicPath(pagePath) {
  return String(pagePath || "/").replace(/\/index\.html$/i, "/").replace(/\.html?$/i, "");
}

function canonicalPathFor(pagePath) {
  return legacyCoreRoutes.get(publicPath(pagePath)) || publicPath(pagePath);
}

function splitStrict(items, count) {
  const perColumn = Math.ceil(items.length / count);
  return Array.from({ length: count }, (_, index) => items.slice(index * perColumn, (index + 1) * perColumn));
}

function pickBoardShow(tourDates, setlists) {
  const sortedDates = [...tourDates].filter((show) => show.isoDate).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
  const postedDates = new Set(setlists.map((show) => show.isoDate).filter(Boolean));
  const latestPostedIso = [...postedDates].sort().reverse()[0] || "";
  const nextUnposted = sortedDates.find((show) => !postedDates.has(show.isoDate) && (!latestPostedIso || show.isoDate > latestPostedIso));
  const latestPosted = [...sortedDates].reverse().find((show) => postedDates.has(show.isoDate));
  const selected = nextUnposted || latestPosted || setlists[0] || sortedDates[0] || null;
  if (!selected) return null;

  const run = tourRunInfo(sortedDates, selected);
  return {
    ...selected,
    runNumber: run.number,
    runLength: run.length,
    runLabel: run.length > 1 ? romanNumeral(run.number) : ""
  };
}

function tourRunInfo(tourDates, selected) {
  if (!tourDates.length || !selected?.isoDate) return { number: 1, length: 1 };

  let index = tourDates.findIndex((show) => sameShowDate(show, selected));
  if (index === -1) index = tourDates.findIndex((show) => show.isoDate === selected.isoDate);
  if (index === -1) return { number: 1, length: 1 };

  let first = index;
  let last = index;
  while (first > 0 && sameRunStop(tourDates[first - 1], selected)) first -= 1;
  while (last < tourDates.length - 1 && sameRunStop(tourDates[last + 1], selected)) last += 1;

  return {
    number: index - first + 1,
    length: last - first + 1
  };
}

function tourStopDates(tourDates, selected) {
  if (!selected?.isoDate) return [];
  const sortedDates = [...tourDates].filter((show) => show.isoDate).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
  let index = sortedDates.findIndex((show) => sameShowDate(show, selected));
  if (index === -1) index = sortedDates.findIndex((show) => show.isoDate === selected.isoDate);
  if (index === -1) return [selected.isoDate];

  let first = index;
  let last = index;
  while (first > 0 && sameRunStop(sortedDates[first - 1], selected)) first -= 1;
  while (last < sortedDates.length - 1 && sameRunStop(sortedDates[last + 1], selected)) last += 1;
  return sortedDates.slice(first, last + 1).map((show) => show.isoDate);
}

function venuePreviewKey(show) {
  if (!show) return "";
  return `${normalizeRunValue(show.venue)}|${normalizeRunValue(show.location)}`;
}

function blankSetlist() {
  return ["1", "2", "E"].map((label) => ({ label, songs: "", songTitles: [] }));
}

function deterministicItem(items, seed = "") {
  if (!items.length) return "";
  const hash = [...String(seed)].reduce((total, character) => total + character.charCodeAt(0), 0);
  return items[hash % items.length];
}

function sameShowDate(a, b) {
  return a.isoDate === b.isoDate && normalizeRunValue(a.location) === normalizeRunValue(b.location) && normalizeRunValue(a.venue) === normalizeRunValue(b.venue);
}

function sameRunStop(a, b) {
  return normalizeRunValue(a.location) === normalizeRunValue(b.location) && normalizeRunValue(a.venue) === normalizeRunValue(b.venue);
}

function normalizeRunValue(value) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function romanNumeral(value) {
  const numerals = ["", "I", "II", "III", "IV", "V", "VI"];
  return numerals[value] || String(value);
}

function formatBoardShowTitle(show) {
  if (!show?.location) return "";
  return `${show.location}${show.runLabel ? ` ${show.runLabel}` : ""}`;
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

function formatLongDate(value) {
  const isoDate = parseDateKey(value);
  if (!isoDate) return clean(value);
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function displayDate(value) {
  const isoDate = parseDateKey(value);
  return isoDate ? isoToShortDate(isoDate) : clean(value);
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

const NORMALIZED_TITLE_ALIASES = {
  bowleggedwomanknockkneedman: "bowleggedwoman",
  conradthecaterpillar: "conrad",
  heroesdavidbowie: "heroesdb",
  jamaisvutheworldhaschanged: "jamaisvu",
  knockinaroundthezoo: "knockingroundthezoo",
  nobodysfault: "nobodysfaultbutmine",
  runnindownadream: "runningdownadream",
  thismustbetheplacenavemelody: "thismustbetheplacenaivemelody",
  wrm: "wurm"
};

function normalizeTitleBase(title) {
  return clean(title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00d7/g, "x")
    .replace(/&/g, "and")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeTitle(title) {
  const normalized = normalizeTitleBase(title);
  return NORMALIZED_TITLE_ALIASES[normalized] || normalized;
}

function normalizeTitleCollection(value) {
  let normalized = normalizeTitleBase(value);
  for (const [alias, canonical] of Object.entries(NORMALIZED_TITLE_ALIASES)) {
    normalized = normalized.replaceAll(alias, canonical);
  }
  return normalized;
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

function currentDateIso(timeZone = "UTC", date = new Date()) {
  if (process.env.BURNTHDAY_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(process.env.BURNTHDAY_TODAY)) {
    return process.env.BURNTHDAY_TODAY;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function shiftIsoDate(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isPublicSongTitle(title) {
  const value = clean(title);
  return Boolean(value) && !/^\?+$/.test(value) && !/^jam$/i.test(value) && !/\breprise$/i.test(value);
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
