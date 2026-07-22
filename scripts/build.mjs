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
  stripeAssets: ["marker-black.png", "marker-blue.png", "marker-green.png", "marker-red.png"]
};

const primaryNavItems = [
  ["Home", "/"],
  ["Albums", "/albums/"],
  ["Rumors", "/rumors/"],
  ["Tour In Review", "/tour-in-review/"],
  ["The Shelf", "/shelf/"],
  ["About", "/about/"]
];

// Mega-menu sub-links shown beneath a parent (matches the Home pattern).
const navSubLinks = {
  "Home": [
    ["Song Possibilities", "/#song-list"],
    ["Song Index", "/songs/"],
    ["Tour Stats", "/#tour-stats"],
    ["{YEAR} Setlists", "/#setlists"]
  ],
  "Albums": [
    ["Lyrics & Chords", "/lyrics-chords/"],
    ["Song Origins", "/song-origins/"]
  ]
};

// Grouped footer link columns — each column has a small mono label header.
// Privacy lives in the bottom bar, not a column.
const footerColumns = [
  ["Live", [
    ["{YEAR} Setlists", "/#setlists"],
    ["Tour In Review", "/tour-in-review/"],
    ["FAQ", "/faq/"],
    ["Rumors", "/rumors/"]
  ]],
  ["Songbook", [
    ["Song Index", "/songs/"],
    ["Albums", "/albums/"],
    ["Lyrics & Chords", "/lyrics-chords/"],
    ["Song Origins", "/song-origins/"]
  ]],
  ["The Sheet", [
    ["Song List", "/"],
    ["The Shelf", "/shelf/"],
    ["About", "/about/"]
  ]]
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
  // lookup so archive/lyrics pages can cross-link to a matching Song Origin
  siteData.originsByTitle = new Map((songOrigins || []).map((origin) => [normalizeTitle(origin.title), origin]));
  // Mikey-era archival layers: Porch Songs + tour posters decorate the Tour In
  // Review hub; the newsletters payload drives the /newsletters/ archive page.
  const [porchSongs, tourPosters, newsletters] = await Promise.all([loadPorchSongs(), loadTourPosters(), loadNewsletters()]);
  siteData.porchSongs = porchSongs;
  siteData.tourPosters = tourPosters;
  siteData.newsletters = newsletters;
  siteData.bandFaq = await loadBandFaq();
  siteData.originAcknowledgments = await loadOriginAcknowledgments();
  // Data layers the lyric/archive pages join against must exist BEFORE those pages
  // render: albums (album chip), song slug map (/song/ live-history link) and the
  // lyrics resource index. These are pure, deterministic joins over already-loaded
  // catalog/archive data — the later writeAlbumPages/writeSongPages calls rebuild the
  // same values idempotently.
  const albums = await loadAlbums();
  siteData.albums = [...albums].sort((a, b) => String(b.releaseDate || "").localeCompare(String(a.releaseDate || "")));
  siteData.songSlugMap = buildSongSlugMap(siteData.catalog || []);
  siteData.lyricsResourceByKey = buildLyricsResourceIndex(archiveEntries);
  // Everyday Companion deep links must load BEFORE the lyric/archive pages render:
  // the Lyrics & Chords hub links EC-only songs and every lyric subpage carries an
  // "Also on Everyday Companion" cross-reference. Absent file → homepage fallback.
  siteData.ecLinksByKey = await loadEcLinks();
  // Which catalog songs Everyday Companion actually knows: a verified deep link, or
  // presence in EC's own play-stat exports. Lyric subpages for EXCLUSIVE songs (a
  // brand-new original EC has no page for) then omit the EC cross-reference instead
  // of dead-ending at the EC homepage.
  siteData.ecKnownKeys = buildEcKnownIndex(siteData.ecLinksByKey, source);
  // Chord content-type index for the Lyrics & Chords hub (LYRICS vs LYRICS + CHORDS).
  siteData.chordsByKey = buildChordsResourceIndex(archiveEntries);
  await writeBloggerArchive(archiveEntries, siteData);
  await writeModernArchivePages(archiveEntries, siteData);
  await writeShelfInfoPage(siteData, archiveEntries);
  await writeRumorsPage(siteData, archiveEntries);
  await writePrivacyPage(siteData);
  // Newsletters parked (removed from nav + site 2026-07-22, kept in code to restore).
  // await writeNewslettersPage(siteData);
  await writeFaqPage(siteData);
  await attachSetlistFmPerformances(siteData);
  // Album pages need data.allShowDates (set above) for the per-track frequency stat.
  await writeAlbumPages(siteData, albums);
  attachSeguePairs(siteData);
  attachAlmanac(siteData, await loadAlmanac());
  attachTonightOdds(siteData);
  // Almanac parked (hidden from the site 2026-07-22; code kept to restore).
  // await writeAlmanacPage(siteData);
  siteData.songVideosByKey = await loadSongVideos();
  siteData.relistenDates = await loadRelistenDates();
  attachBestGuesses(siteData, await loadBestGuesses());
  await writeSongPages(siteData, albums);
  // Origins are written AFTER the song/album/setlist data layers are attached so
  // each origin can join its catalog song (stat strip, /song/ link, album chip).
  await writeSongOrigins(songOrigins, siteData, albums);
  const generatedTourReviews = await writeGeneratedTourReviewPages(siteData);
  const tourInReviews = await writeTourInReviewPages(siteData, archiveEntries);
  await writeTourReviewHub(siteData, archiveEntries, generatedTourReviews, tourInReviews);
  const searchIndex = buildSearchIndex(siteData, archiveEntries, songOrigins, tourInReviews);
  await writeFile(path.join(dist, "data", "search-index.json"), JSON.stringify(searchIndex), "utf8");
  await writeFile(path.join(dist, "index.html"), finalizeHtml(renderHtml(siteData)), "utf8");
  await writeStaticPage("/404.html", renderNotFoundPage(siteData));
  await writeFile(path.join(dist, "styles.css"), renderCss(), "utf8");
  await writeFile(path.join(dist, "stagelight.css"), renderStagelightCss(), "utf8");
  await writeFile(path.join(dist, "data", "site-data.json"), JSON.stringify(siteData, null, 2), "utf8");
  await writeFile(path.join(dist, "data", "freshness.json"), JSON.stringify(buildFreshnessReport(siteData, archiveEntries, songOrigins, generatedTourReviews), null, 2), "utf8");
  await writeFile(path.join(dist, "_headers"), renderHeaders(), "utf8");
  await writeFile(path.join(dist, "_redirects"), renderRedirects(archiveEntries, generatedTourReviews, tourInReviews), "utf8");
  await writeFile(path.join(dist, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://burnthday.com/sitemap.xml\n", "utf8");
  await writeFile(path.join(dist, "llms.txt"), renderLlmsTxt(siteData), "utf8");
  await writeFile(path.join(dist, "sitemap.xml"), renderSitemap(siteData, archiveEntries, songOrigins, generatedTourReviews, tourInReviews), "utf8");

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
  const [spreadsheet, playstats, priorSongStats, venuePreviews, showOverrides] = await Promise.all([
    loadSpreadsheetData(inferSetlistYear(setlists)),
    loadPlaystats(),
    loadPriorSongStats(),
    loadVenuePreviews(),
    loadShowOverrides(inferSetlistYear(setlists))
  ]);
  // Per-show hero art (image / blurred bgImage / photoCredit) applies to posted
  // setlists and, crucially, to shows that have not posted yet (tonight preview).
  for (const show of [...(setlists.setlists || []), ...(setlists.tourDates || [])]) {
    const extra = showOverrides[show.isoDate];
    if (extra) Object.assign(show, { image: extra.image || show.image, bgImage: extra.bgImage || show.bgImage, photoCredit: extra.photoCredit || show.photoCredit });
  }
  return { ...spreadsheet, setlists, playstats, priorSongStats, venuePreviews, showOverrides };
}

async function loadShowOverrides(year) {
  try {
    return JSON.parse(await readFile(path.join(root, "data", "source", `setlist-overrides-${year}.json`), "utf8"));
  } catch { return {}; }
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
  const facebook = await (async () => {
    try {
      const raw = await readFile(path.join(root, "data", "source", "song-origins.json"), "utf8");
      const payload = JSON.parse(raw);
      return (payload.origins || []).filter((origin) => origin.title && origin.slug);
    } catch {
      return [];
    }
  })();
  // Curated supplement (data/source/song-origins-curated.json): net-new, structured
  // origins compiled from interviews/newsletters — a separate shape (quotes[],
  // clusters[], related[], faq[]) rendered by renderCuratedOriginPage. All entries
  // are net-new and de-duplicated by slug against the Facebook-sourced set. Handoff
  // from branch claude/affectionate-blackwell-b25e75 (see SONG-ORIGINS-SPEC.md).
  const curated = await loadCuratedSongOrigins();
  const seen = new Set(facebook.map((origin) => origin.slug));
  const merged = [...facebook];
  for (const entry of curated) {
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    merged.push(entry);
  }
  return merged;
}

async function loadCuratedSongOrigins() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "song-origins-curated.json"), "utf8");
    const payload = JSON.parse(raw);
    return (payload.origins || [])
      .filter((origin) => origin.title && origin.slug)
      .map((origin) => ({ ...origin, curated: true }));
  } catch {
    return [];
  }
}

// Mikey-era archival decorations for the Tour In Review hub and the Newsletters
// page. Each is a curated, attributed pull (the band's own Porch Songs series, the
// official poster archive, and the Moon Times / Panicle newsletters preserved via
// the Internet Archive + a fan transcription). Missing file → empty, never a throw.
async function loadPorchSongs() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "porch-songs.json"), "utf8");
    const payload = JSON.parse(raw);
    return (payload.entries || []).filter((entry) => entry.title);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function loadTourPosters() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "tour-posters.json"), "utf8");
    const payload = JSON.parse(raw);
    return (payload.posters || []).filter((poster) => poster.image && poster.tour);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function loadNewsletters() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "newsletters.json"), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Band-level FAQ (data/source/band-faq.json): the plain-language questions a new
// fan asks, rendered as the /faq/ page + FAQPage JSON-LD. Missing file → an empty
// shape so the page renders nothing rather than throwing.
async function loadBandFaq() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "band-faq.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return { description: "", faqs: [] };
  }
}

// The curated song-origins file carries a top-level acknowledgments[] (e.g. Ethan
// Ice for the Relix scans). Surfaced as a quiet "Special thanks" line on the
// origins index and on any curated origin page whose sources cite Relix.
async function loadOriginAcknowledgments() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "song-origins-curated.json"), "utf8");
    return JSON.parse(raw).acknowledgments || [];
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
  // Per-date normalized title sets so each song can carry a strike for EVERY one
  // of the last four shows it appeared in (the sheet stacks markers).
  const lastFourTitleSets = lastFourDates.map((iso) => new Set(
    ((setlists.find((show) => show.isoDate === iso) || {}).sets || [])
      .flatMap((set) => set.songTitles || [])
      .map((title) => normalizeTitle(title))
  ));
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
  const showOverride = source.showOverrides?.[boardShow?.isoDate] || {};
  const tourImages = setlists.map((show) => show.image).filter(Boolean);
  const previewFallbackImage = deterministicItem(tourImages, boardShow?.isoDate) || "";
  const previewImage = previewMetadata.firstVisit ? previewMetadata.image || previewFallbackImage : previewFallbackImage;
  let featuredShow = isShowDayPreview
    ? { ...boardShow, image: showOverride.image || boardShow.image || previewImage, bgImage: showOverride.bgImage || boardShow.bgImage, photoCredit: showOverride.photoCredit || boardShow.photoCredit, sets: blankSetlist(), notes: [] }
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
      strikeAssets: lastFourTitleSets
        .map((titles, index) => (titles.has(key) ? config.stripeAssets[index] : ""))
        .filter(Boolean),
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
    showOverrides: source.showOverrides || {},
    rules: {
      rotationSlpLimit: config.rotationSlpLimit,
      shelfWatchWindow: config.shelfWatchWindow,
      shelfWatchLimit: config.shelfWatchLimit,
      purgatory: "Songs with one lifetime play stay in Purgatory. If played this tour, they stay marked black until the next tour reset.",
      shelf: "Shelf songs that return this tour stay marked black until the next tour reset.",
      shelfWatch: `Shelf Watch shows up to ${config.shelfWatchLimit} unplayed songs within ${config.shelfWatchWindow} shows of the ${config.rotationSlpLimit}-show Shelf cutoff.`,
      woodshed: "The Woodshed contains songs in rotation that have not been played with Nick Johnson on guitar."
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
  const colorNames = ["Black", "Blue", "Green", "Red"];

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
    // The Lyrics & Chords landing was a bare Blogger link list. Replace it with a
    // searchable, designed index modeled on the Song Index; every other modern
    // page keeps the standard archive template.
    if (page.path === "/lyrics-chords/index.html") {
      await writeStaticPage(page.path, renderLyricsChordsIndex(entries, data, { ...entry, ...page }));
      continue;
    }
    // The About page is the site's E-E-A-T anchor: Alex's authority bio, the
    // noob FAQ, and Person/Dataset/FAQPage structured data. Rendered from a
    // dedicated template instead of the legacy Blogger prose.
    if (page.path === "/about/index.html") {
      const setlistFmCache = await loadSetlistFmCache();
      await writeStaticPage(page.path, renderAboutPage({ ...entry, ...page }, data, setlistFmCache));
      continue;
    }
    await writeStaticPage(page.path, renderArchivePage({ ...entry, ...page }, data));
  }
}

// Build one Lyrics & Chords hub row per CATALOG song (owner UX decision — the hub
// covers the full catalog, not just the songs with an internal transcription).
// Each row is a pure build-time join: title, primary album, lifetime plays, and a
// link target that prefers our internal transcription and otherwise sends the
// reader to Everyday Companion (verified deep link or safe homepage fallback —
// never a guessed 404). Nothing is authored; sorted alphabetically by title.
function collectLyricRows(data) {
  const catalog = [...(data.catalog || [])];
  return catalog.map((song) => {
    const internal = data.lyricsResourceByKey?.get(song.key) || "";
    const primaryAlbum = songAlbumsFor(song, data.albums || [])[0] || null;
    const ec = internal ? null : ecLinkFor(song, data);
    // "Has chords" is only meaningful for songs hosted here — an EC row's chord
    // status is unknowable, so it stays false and gets no content-type indicator.
    const chordInfo = internal ? (data.chordsByKey?.get?.(song.key) || null) : null;
    // A Tab chip appears when the chords live on a SIBLING guitar-tab page (not
    // the lyrics page the title links to). Chords are "reachable" — and the
    // LYRICS + CHORDS badge honest — when the lyrics page itself carries them OR
    // the Tab chip does.
    const tabHref = chordInfo && chordInfo.tabHref && chordInfo.tabHref !== internal ? chordInfo.tabHref : "";
    const hasChords = Boolean(chordInfo && (chordInfo.onLyricsPage || tabHref));
    // ARTIST column: the original artist/writer for COVERS where curated origin data
    // exists (song-origins-curated.json — all 51 carry composer, 11 covers carry
    // originalArtist). Originals and songs with no curated origin stay blank — we
    // never invent an attribution. For a WSP original the "artist" is self-evidently
    // the band, so only covers get a value.
    const originRec = data.originsByTitle?.get(song.key) || null;
    const isCover = (song.type || "").toLowerCase() === "cover";
    const artist = (originRec && isCover) ? (originRec.originalArtist || originRec.composer || "") : "";
    return {
      song,
      title: song.title,
      type: song.type,
      album: primaryAlbum ? primaryAlbum.title : "",
      total: Number.isFinite(song.total) ? song.total : 0,
      internal,
      hasChords,
      tabHref,
      artist,
      ecHref: ec ? ec.href : ""
    };
  }).sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
}

// ── Global command-palette search index (⌘K) ────────────────────────────────
// One compact record per searchable entity, emitted to /data/search-index.json
// and loaded lazily on first palette open. Keys are terse to keep the payload
// lean: t (title), u (url), k (kind), plus per-kind extras. Teaser lyric lines
// (tz) are VERBATIM first lines from content we own — a Best Guess transcription
// or an internal lyric page — and are never authored here; songs with no owned
// lyric content simply carry no teaser.
function buildSearchIndex(data, archiveEntries, songOrigins, tourInReviews) {
  const records = [];
  const catalog = data.catalog || [];
  const slugMap = data.songSlugMap || new Map();
  const relistenDates = data.relistenDates || new Set();
  const lyricsByKey = data.lyricsResourceByKey || new Map();
  const lyricPages = buildLyricPageIndex(archiveEntries, catalog); // key -> {href, content, title}

  for (const song of catalog) {
    const key = song.key;
    const rarity = calculateRarity(song);
    const origin = data.originsByTitle?.get(key) || null;
    const lyricsHref = lyricsByKey.get(key) || "";
    const bestGuess = data.bestGuessByKey?.get(key) || null;
    const rec = {
      t: song.title,
      u: `/song/${slugMap.get(key)}/`,
      k: "song",
      ty: song.type,
      pl: song.total || 0,
      ra: rarity.label
    };
    if (song.playedThisTour) rec.tt = 1;
    if (bestGuess) rec.bg = 1;
    if (lyricsHref) rec.ly = lyricsHref;
    if (origin) rec.og = `/song-origins/${origin.slug}/`;
    const listen = mostRecentRelistenUrl(data.performancesByTitle?.get(key), relistenDates);
    if (listen) rec.li = listen;
    const lastIso = song.effectiveLastIso || parseDateKey(song.last);
    if (lastIso) rec.lp = lastIso;
    // Teaser: the internal lyric page's first true lyric line is preferred (Alex's
    // transcription, no editorial preamble); the Best Guess transcription is the
    // fallback. Only where we own the content — otherwise no teaser.
    const teaser = (lyricsHref ? teaserFromLyricHtml(lyricPages.get(key)?.content) : "")
      || (bestGuess ? teaserFromBestGuess(bestGuess) : "");
    if (teaser) rec.tz = teaser;
    records.push(rec);
  }

  for (const album of data.albums || []) {
    const rec = { t: album.title, u: `/albums/${album.slug}/`, k: "album" };
    const yr = albumYear(album);
    if (yr) rec.yr = yr;
    if (album.cover) rec.cv = album.cover;
    records.push(rec);
  }

  for (const tour of tourInReviews || []) {
    records.push({ t: `${tour.year} ${tour.dispName}`, u: tour.route, k: "tour", yr: tour.year, sh: tour.showCount });
  }

  for (const origin of songOrigins || []) {
    records.push({ t: origin.title, u: `/song-origins/${origin.slug}/`, k: "origin" });
  }

  // Internal lyric pages (deduped per song key — mirrors lyricsResourceByKey).
  for (const entry of lyricPages.values()) {
    records.push({ t: entry.title, u: entry.href, k: "lyrics" });
  }

  // Archive posts — excluding lyric-section pages, which are already indexed as
  // kind=lyrics above (no duplicate URLs across kinds).
  for (const entry of archiveEntries) {
    if (!entry.path || isLyricArchivePage(entry)) continue;
    records.push({ t: cleanArchiveTitle(entry.title) || entry.title, u: entry.path, k: "archive" });
  }

  return records;
}

// Deduped index of internal lyric pages: key -> { href, content, title }. Uses
// the SAME "prefer the shortest/most-specific page per song" rule as
// buildLyricsResourceIndex, so its keys match hasLyrics exactly; additionally
// carries the raw page content (for teaser extraction) and a clean title.
function buildLyricPageIndex(archiveEntries = [], catalog = []) {
  const titleByKey = new Map(catalog.map((song) => [song.key || normalizeTitle(song.title), song.title]));
  const byKey = new Map();
  for (const entry of archiveEntries) {
    if (!isLyricArchivePage(entry) || !entry.path) continue;
    const name = lyricSongName(entry);
    const key = normalizeTitle(name);
    if (!key) continue;
    const contentLen = String(entry.content || "").length;
    const existing = byKey.get(key);
    if (!existing || contentLen < existing.contentLen) {
      byKey.set(key, { href: entry.path, contentLen, content: entry.content || "", title: titleByKey.get(key) || cleanArchiveTitle(name) || name });
    }
  }
  return byKey;
}

// Most-recent RECORDED performance's Relisten URL for a song, gated by the
// committed relisten-dates.json set (data.relistenDates). performancesByTitle is
// sorted newest-first, so the first date that is in the set is the pick. Empty
// string when the song has no recorded, streamable performance.
function mostRecentRelistenUrl(performances, relistenDates) {
  if (!performances || !performances.length || !relistenDates || !relistenDates.size) return "";
  for (const perf of performances) {
    if (perf?.date && relistenDates.has(perf.date)) return relistenUrlFor(perf.date);
  }
  return "";
}

// First lyric line of a Best Guess transcription (the first stanza's first line),
// clamped to a short verbatim teaser.
function teaserFromBestGuess(entry) {
  const html = entry?.transcriptionHtml || "";
  const blocks = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
  for (const block of blocks) {
    const blockText = clean(decodeXml(stripTags(block[1])));
    // Skip an editorial preamble block (Alex sometimes opens with a note).
    if (/\bEDIT\b|seems like it|see the notes/i.test(blockText)) continue;
    const firstLine = clampTeaser(decodeXml(stripTags(block[1].split(/<br\s*\/?>/i)[0])));
    if (firstLine && !isLyricNonContentLine(firstLine)) return firstLine;
  }
  return "";
}

const LYRIC_CREDIT_RE = /\b(?:transcrib|transcription|co-?writ|written by|words? (?:and|&) music|lyrics? (?:and|&) music|music (?:and|&) lyrics|arranged by|performed by|(?:backing|backup) vocals|on (?:fiddle|pedal steel|guitar|drums|bass|keys|keyboards|vocals|backing|backup|trumpet|flugelhorn|sax|saxophone|trombone|horns?|violin|cello|mandolin|banjo|harmonica|percussion|organ|piano))/i;

// First real lyric line of an internal lyric page, skipping credit/session lines
// ("Transcribed by:", "co-written by", "with X on fiddle"), bare contributor
// names, and section markers. Returns a short VERBATIM teaser, or "" if none.
function teaserFromLyricHtml(rawHtml) {
  if (!rawHtml) return "";
  const text = decodeXml(String(rawHtml)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, ""));
  const lines = text.split(/\n/).map((line) => clean(line)).filter(Boolean);
  for (const line of lines) {
    if (isLyricNonContentLine(line)) continue;
    return clampTeaser(line);
  }
  return "";
}

function isLyricNonContentLine(line) {
  const t = clean(line);
  if (!t) return true;
  if (LYRIC_CREDIT_RE.test(t)) return true;
  if (/^\(.*\)$/.test(t)) return true;                 // bare parenthetical, e.g. (Widespread Panic)
  if (/^\[.*\]$/.test(t)) return true;                 // [Verse], [Chorus]
  if (/^(?:verse|chorus|bridge|intro|outro|refrain|pre-?chorus)\b[:]?\s*\d*$/i.test(t)) return true;
  if (/^with\b[\s\S]*\bon\b/i.test(t)) return true;    // "with Bruce Hoffman on fiddle"
  // Session/horn-section credits: "with The Compass Point Horns".
  if (/^with\s+(?:the\s+)?[A-Z][\s\S]*\b(?:horns?|section|singers?|choir|band|players?|ensemble|orchestra|strings?|quartet|group)\b/i.test(t)) return true;
  // A short credit/section header ending in a colon ("The Compass Point Horns:").
  if (/:$/.test(t) && t.split(/\s+/).length <= 6) return true;
  // Session-player roster line: "<Name> on <Instrument>" (incl. a modifier, e.g.
  // "on Valve Trombone"). Restricted to horn/orchestral instruments so ordinary
  // lyrics that merely mention a guitar or drums are not mistaken for credits.
  if (/\bon\b[\s\S]*\b(?:trumpet|trombone|flugelhorn|saxophone|sax|fiddle|violin|cello|mandolin|banjo|harmonica|clarinet|flute|tuba|pedal steel|lap steel|french horn)\b/i.test(t)) return true;
  // A bare contributor name in the credit preamble: a short all-Capitalized line
  // with no lowercase-led word (e.g. "Scott Holcomb", "Jeff Friedman"). Real lyric
  // lines almost always carry a lowercase connective ("to", "and", "the").
  const tokens = t.split(/\s+/);
  if (tokens.length <= 4 && tokens.every((tok) => /^[&,.]$/.test(tok) || /^[A-Z][A-Za-z.'’-]*[.,]?$/.test(tok))) return true;
  return false;
}

// Clamp a raw line to a tidy ~60-char verbatim teaser: strip a leading section
// marker, collapse whitespace, and cut on a word boundary with an ellipsis.
function clampTeaser(value) {
  let v = clean(String(value || "")).replace(/^\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
  v = v.replace(/^["'“”‘’]+/, "").trim();
  if (!v) return "";
  const MAX = 60;
  if (v.length <= MAX) return v;
  const cut = v.slice(0, MAX);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 30 ? cut.slice(0, sp) : cut).replace(/[\s,.;:—–-]+$/, "")}…`;
}

// llms.txt — the /llms.txt convention for AI crawlers and agents: what this
// site is, who runs it, and where the canonical pages and machine-readable
// data live. Counts are computed from live site data so the file never goes
// stale. Attribution terms mirror the footer.
function renderLlmsTxt(data) {
  const year = data?.site?.year || new Date().getFullYear();
  const catalog = Array.isArray(data.catalog) ? data.catalog.length : 0;
  return `# Burnthday

> Burnthday's Widespread Panic Spread Sheet: the working Widespread Panic song
> list, setlists, tour stats, albums, lyrics, and song origins. Independent fan
> site run by Alex Moura since July 27, 2007. The same song list the band uses
> to make setlists, with ${year} tour data. Not affiliated with the band.

## Key pages

- [Song Possibilities (the working list)](https://burnthday.com/)
- [Song Index — every song with live history](https://burnthday.com/songs/)
- [Setlists](https://burnthday.com/#setlists)
- [Tour Stats](https://burnthday.com/#tour-stats)
- [Albums](https://burnthday.com/albums/)
- [Song Origins — researched song stories](https://burnthday.com/song-origins/)
- [Lyrics & Chords](https://burnthday.com/lyrics-chords/)
- [About Alex Moura and the site](https://burnthday.com/about/)

## Data

- [Freshness report (JSON)](https://burnthday.com/data/freshness.json): when the
  data was last generated, the active tour, and the latest show.
- Catalog: ${formatNumber(catalog)} songs with play counts, rarity tiers, and
  last-played dates, rendered across the pages above.

## Citation

Cite as "Burnthday (burnthday.com)". Setlist data via setlist.fm and
widespreadpanic.com; song history via Everyday Companion. Please keep those
attributions when quoting performance data.
`;
}

// ---- ABOUT PAGE (E-E-A-T authority anchor) ----
// The About page carries the site's author identity: who runs Burnthday, the
// documented music-industry work behind it, a plain-English FAQ for people new
// to the rotation, and Person + Dataset + FAQPage structured data so crawlers
// and AI models can bind the site, the dataset, and Alex into one entity.
// Narrative facts come from Alex directly; corroborated credits (TRI Studios,
// HWA 2013-2018, the People.com Band of Heathens credit) are documented in his
// business records. Stats are computed from live site data, never hardcoded.

const ABOUT_FAQ = [
  {
    q: "What is Burnthday?",
    a: "Burnthday is an independent Widespread Panic fan site, running since July 27, 2007. It tracks the working song list, setlists, tour stats, albums, lyrics, and song origins. It is not affiliated with the band."
  },
  {
    q: "Why is it called Burnthday?",
    a: "The name comes from Alex's mom. His sister went to UGA in 1997 and sent him home with Widespread Panic tapes. A blown-out knee from lacrosse turned that into an obsession: a CD burner, traded shows, and hours under headphones. One day his mom pulled the headphones off and said, “Don't burn the day away. Get outside and go have fun.” It stuck."
  },
  {
    q: "How does the Widespread Panic song rotation work?",
    a: "Widespread Panic rarely repeats a song within a run of shows. After each show, Burnthday crosses off every song played in the last four shows. What is left uncrossed is the pool the band is most likely drawing from tonight. That cross-off sheet is the heart of the site."
  },
  {
    q: "Did the band really keep a list like this?",
    a: "Yes. For years the master list lived with Garrie Vereen, the band's longtime crew member. A video shot July 30, 2000 shows him building it by hand: last night's songs crossed off, marker colors for the shows before that, new songs Sharpied in at the bottom. One copy went to the band bus, one to the dressing room. The band picked the first set from it before the show and came back at set break for the second. In Garrie's words, there is a Tuesday song and there is a Thursday song. Garrie passed in 2011, and this site keeps his method rolling on the fan side.",
    link: "https://www.youtube.com/watch?v=axF3SyExCPo",
    linkLabel: "Watch Garrie build the list (July 30, 2000)"
  },
  {
    q: "What is a bustout?",
    a: "A bustout is a song the band brings back after a long absence. On Burnthday, a song that returns after 200 or more shows counts as a Bustout, and after 1,000 or more shows it is a Mega Bustout. Songs that have gone 200 shows without being played live on The Shelf."
  },
  {
    q: "Where does the data come from?",
    a: "Three places. The master spreadsheet holds the song classifications and the working list. Everyday Companion is the reference for song histories. Setlist.fm supplies the complete performance log, every show back to 1985. All of it is cross-checked before it ships."
  },
  {
    q: "Is Burnthday affiliated with Widespread Panic?",
    a: "No. Burnthday is a fan project, built and paid for by one fan since 2007. Band members have been kind about it over the years, but the site is independent."
  },
  {
    q: "How often is the site updated?",
    a: "After every show. Setlists land, the cross-off sheet gets reworked, and the tour stats recompute. Between tours the data layers refresh on a schedule."
  }
];

function aboutStats(data, cache) {
  const catalog = Array.isArray(data.catalog) ? data.catalog.length : 0;
  // songOrigins isn't attached to siteData until later in main(); the
  // originsByTitle map (built before modern pages render) carries the count.
  const origins = Array.isArray(data.songOrigins)
    ? data.songOrigins.length
    : (data.originsByTitle instanceof Map ? data.originsByTitle.size : 0);
  const albums = Array.isArray(data.albums) ? data.albums.length : 0;
  const buildYear = new Date(data.generatedAt || Date.now()).getFullYear();
  const years = buildYear - 2007;
  const shows = cache && Number.isFinite(cache.showCount) ? cache.showCount : 0;
  const performances = cache && Number.isFinite(cache.songPerformances) ? cache.songPerformances : 0;
  let firstShow = "";
  let lastShow = "";
  if (cache && Array.isArray(cache.shows)) {
    for (const show of cache.shows) {
      if (!show?.date) continue;
      if (!firstShow || show.date < firstShow) firstShow = show.date;
      if (!lastShow || show.date > lastShow) lastShow = show.date;
    }
  }
  return { catalog, origins, albums, years, shows, performances, firstShow, lastShow };
}

function renderAboutJsonLd(stats) {
  const person = {
    "@context": "https://schema.org",
    "@type": "Person",
    "@id": "https://burnthday.com/about/#alex-moura",
    name: "Alex Moura",
    url: "https://burnthday.com/about/",
    image: "https://burnthday.com/assets/archive-media/Alex-1_zps04c65eda.png",
    jobTitle: "Creator of Burnthday",
    description: "Alex Moura, creator of Burnthday, the Widespread Panic tour song list and data spreadsheet. Music-industry digital strategist: Hard Working Americans at TRI Studios, JoJo Hermann, Jerry Joseph, Todd Snider, Trondossa Music Festival.",
    worksFor: {
      "@type": "Organization",
      name: "Digital Star Marketing",
      url: "https://www.digitalstarmarketing.com/"
    },
    alumniOf: "University of North Carolina Wilmington",
    knowsAbout: [
      "Widespread Panic",
      "concert setlists",
      "live music data",
      "song rotation analysis",
      "music marketing"
    ],
    sameAs: [
      "https://www.facebook.com/alexmoura",
      "https://www.facebook.com/burnthday",
      "https://twitter.com/burnthday",
      "https://www.instagram.com/burnthday/"
    ]
  };
  const dataset = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Burnthday Widespread Panic Setlist Dataset",
    url: "https://burnthday.com/",
    description: `The working Widespread Panic song list and performance dataset: ${formatNumber(stats.catalog)} catalog songs, ${formatNumber(stats.shows)} shows, and ${formatNumber(stats.performances)} logged song performances, maintained since 2007 and cross-checked against Everyday Companion and setlist.fm.`,
    creator: { "@id": "https://burnthday.com/about/#alex-moura" },
    ...(stats.firstShow && stats.lastShow ? { temporalCoverage: `${stats.firstShow}/${stats.lastShow}` } : {})
  };
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: ABOUT_FAQ.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a }
    }))
  };
  const encode = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${encode(person)}</script>
    <script type="application/ld+json">${encode(dataset)}</script>
    <script type="application/ld+json">${encode(faq)}</script>`;
}

function renderAboutPage(entry, data, cache) {
  const stats = aboutStats(data, cache);
  const title = "About Alex Moura, Creator of Burnthday | Widespread Panic";
  const description = "Alex Moura, creator of Burnthday, the Widespread Panic tour song list and data spreadsheet. Running since July 2007. TRI Studios, Hard Working Americans, JoJo Hermann, Jerry Joseph, Trondossa.";
  const credits = [
    ["Hard Working Americans", "Head of Digital Strategy and Creative Direction, 2013–2018, out of Bob Weir's TRI Studios. No ad budget. Sold-out shows and a number one debut on the iTunes rock chart."],
    ["Dave Schools", "Runs Dave's Facebook page and worked the digital side of the KIMOCK record."],
    ["JoJo Hermann", "Producer and creative director of the Shut Up and Play livestream. It charted on Billboard and helped launch JoJo's solo run."],
    ["Jerry Joseph", "Strategic digital marketing across multiple records."],
    ["Todd Snider", "Digital strategy, releases, and the Return of the Storyteller music video, premiered by People."],
    ["Daniel Hutchens", "Worked the premiere solo record."],
    ["Trondossa Music Festival", "Digital marketing for the band's own festival in Charleston, SC, produced with Live Nation."],
    ["Band of Heathens", "Concepted and produced a music video People premiered. The band's public credit: “A special shoutout goes to Alex Moura for conceptualizing and putting it together so beautifully.”"],
    ["Live Compilations", "Curated Widespread Panic compilations for the fan streaming vault, back when that was the place to listen."],
    ["Jimmy Herring Has a Posse", "Yes, those shirts. Alex made them."]
  ];
  const creditCards = credits.map(([who, what]) => `<div class="about-credit">
        <h3>${escapeHtml(who)}</h3>
        <p>${escapeHtml(what)}</p>
      </div>`).join("\n      ");
  const statCards = [
    [formatNumber(stats.years), "years running"],
    [formatNumber(stats.catalog), "songs tracked"],
    [formatNumber(stats.shows), "shows logged"],
    [formatNumber(stats.performances), "song performances"],
    [formatNumber(stats.albums), "studio albums"],
    [formatNumber(stats.origins), "song origin stories"]
  ].filter(([value]) => value && value !== "0").map(([value, label]) => `<div class="about-stat"><strong>${value}</strong><span>${label}</span></div>`).join("");
  const faqItems = ABOUT_FAQ.map((item) => `<details class="about-faq-item">
        <summary>${escapeHtml(item.q)}</summary>
        <p>${escapeHtml(item.a)}${item.link ? ` <a href="${escapeAttr(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.linkLabel || "Watch")}</a>` : ""}</p>
      </details>`).join("\n      ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(fitMetaText(title, 68))}</title>
    <meta name="description" content="${escapeAttr(fitMetaText(description, 155))}">
    <link rel="canonical" href="https://burnthday.com/about/">
    <meta name="author" content="Alex Moura">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <style>
      .about-lede{font-size:1.06rem;line-height:1.75;max-width:64ch}
      .about-portrait{float:right;width:min(200px,38vw);margin:0 0 1rem 1.5rem;border-radius:10px}
      .about-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem;margin:2.2rem 0}
      .about-stat{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:1rem .9rem;text-align:center}
      @media (max-width:560px){.about-stats{grid-template-columns:repeat(2,1fr)}}
      .about-stat strong{display:block;font-size:1.45rem;letter-spacing:.02em}
      .about-stat span{font-size:.72rem;text-transform:uppercase;letter-spacing:.14em;opacity:.65}
      .about-credits{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:.9rem;margin:1.4rem 0 2.4rem}
      .about-credit{border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:1rem 1.1rem;background:rgba(255,255,255,.02)}
      .about-credit h3{margin:0 0 .4rem;font-size:.95rem;letter-spacing:.02em}
      .about-credit p{margin:0;font-size:.86rem;line-height:1.55;opacity:.8}
      .about-faq-item{border-bottom:1px solid rgba(255,255,255,.09);padding:.35rem 0}
      .about-faq-item summary{cursor:pointer;padding:.8rem 0;font-weight:600;letter-spacing:.01em}
      .about-faq-item p{margin:0;padding:.1rem 0 1rem;line-height:1.7;opacity:.85;max-width:68ch}
      .about-h2{margin-top:2.6rem;letter-spacing:.02em}
      @media (max-width:560px){.about-portrait{float:none;display:block;margin:0 auto 1.2rem}}
    </style>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main">
      <article class="archive-page">
        <header class="archive-title">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">About</span></nav>
          <p class="archive-eyebrow">ABOUT</p>
          <h1>About Burnthday</h1>
          <p class="songs-deck">Alex Moura, creator of Burnthday — the Widespread Panic tour song list and data spreadsheet.</p>
        </header>
        <div class="archive-content prose-plate">
          <img class="about-portrait" src="/assets/archive-media/Alex-1_zps04c65eda.png" alt="Alex Moura">
          <p class="about-lede">Hi! Alex Moura here. Thanks for stopping in. I launched Burnthday's (“burn-the-day”) Widespread Panic Spread Sheet on July 27, 2007, as a place for us die-hard fans to stay informed. After each show, songs from the last four setlists are crossed off the master list in Photoshop, from either the comfort of my home in Charlotte, or a hotel room on the road.</p>
          <p>A little about me: born in Chapel Hill, NC, lived at the beach in Wilmington, NC for ten years, and moved to the Bay Area in 2012. That is where this site changed my life. A tweet got me invited up to Bob Weir's TRI Studios, and when I introduced myself, Dave Schools already knew me from this site. He introduced me to Weir as Widespread Panic's statistician. That turned into running digital strategy and creative direction for Hard Working Americans from 2013 to 2018, and marketing work on many of the albums Dave produced at the studio.</p>
          <p>The email that means the most came from Dave during the Hard Working Americans years. He caught me labeling the Jacksonville show as Miami, and added: “I only mention it because I rely on your site to make setlists! LOL!” That is the whole point of this site in one sentence: the working song list, kept honestly enough that the band itself can lean on it.</p>
          <p>In 2014 my wife Katherine and I founded <a href="https://www.digitalstarmarketing.com/" rel="me">Digital Star Marketing</a>. The music work never stopped: JoJo Hermann, Steve Kimock, Jerry Joseph, Todd Snider, Daniel Hutchens, Band of Heathens, and the band's own Trondossa Music Festival in Charleston. Some of that work has been featured in Rolling Stone, People, Variety, and Grammy.com. Everyday Companion, the longtime keeper of Panic history, links here too.</p>
          <h2 class="about-h2">By the numbers</h2>
          <div class="about-stats">${statCards}</div>
          <h2 class="about-h2">Selected work</h2>
          <div class="about-credits">
      ${creditCards}
          </div>
          <h2 class="about-h2">New to the rotation? Start here</h2>
          ${faqItems}
          <h2 class="about-h2">Friends of Burnthday</h2>
          <p>Nineteen years of this does not happen alone. Thank you to the Widespread Panic band and crew, the taper section — especially the Home Team and the <a href="https://hometeam.fm" target="_blank" rel="noopener noreferrer">hometeam.fm</a> folks, The Sandbox Channel on YouTube, and Topdogger — Ashley and Charles Fox, Z-Man, D.P. Swint, Bennett Schwartz, Ted Rockwell at <a href="https://everydaycompanion.com" target="_blank" rel="noopener noreferrer">Everyday Companion</a>, Horace Moore, J.T. Lucchesi, and Beau Gunn of my favorite radio station, 98.3 The Penguin FM.</p>
          <p>And to the photographers whose shots light up these pages: thank you. Special thanks to Josh Timmermans and Andy Tennille, whose photos and videos of the band have been lighting things up lately, and to all our photographer friends in the Panic family. If your photo is here and you would like a credit added, or the photo taken down, <a href="https://www.facebook.com/burnthday">message Burnthday</a> and it happens, no questions asked.</p>
          <p>Say hi on <a href="https://www.facebook.com/burnthday">Facebook</a>, <a href="https://twitter.com/burnthday">X</a>, or <a href="https://www.instagram.com/burnthday/">Instagram</a>. I hope to see you on the road.</p>
        </div>
      </article>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["About", "https://burnthday.com/about/"]
    ])}</script>
    ${renderAboutJsonLd(stats)}
  </body>
</html>
`;
}


function renderLyricsChordsIndex(entries, data, hubEntry) {
  const rowsData = collectLyricRows(data);
  const total = rowsData.length;
  const albums = [...new Set(rowsData.map((row) => row.album).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  const rows = rowsData.map((row) => {
    const plays = row.total > 0 ? `${formatNumber(row.total)}<small>plays</small>` : "";
    const href = row.internal || row.ecHref;
    const ext = !row.internal;
    // No source names in rows: the WORDS cell says what the click opens; external
    // destinations get the arrow and open in a new window.
    const words = row.internal
      ? (row.hasChords ? "Lyrics + chords" : "Lyrics")
      : `Lyrics<span class="lr-ext-arrow" aria-hidden="true"> ↗</span>`;
    const artistCell = row.artist ? escapeHtml(row.artist) : `<span class="lr-none" aria-hidden="true">—</span>`;
    const albumCell = row.album ? escapeHtml(row.album) : `<span class="lr-none" aria-hidden="true">—</span>`;
    // TAB column: a real sibling <a> overlaying the reserved 5th grid track (nested
    // anchors inside the row link would be invalid HTML — mirrors .sr-resources on
    // the Song Index). Only lights up where we HOST a sibling guitar-tab page; there
    // is no external tab source in the data, so absent tabs show a muted dash rather
    // than a guessed link.
    const tabCell = row.tabHref
      ? `<a class="lr-tab" href="${escapeAttr(row.tabHref)}" aria-label="Guitar tab for ${escapeAttr(row.title)}">Tab</a>`
      : `<span class="lr-tab lr-tab-empty" aria-hidden="true">—</span>`;
    // Facets + sort keys ride on the WRAPPER so the whole row (and its sibling Tab
    // link) hide/reorder together. data-plays is the numeric sort key; data-transcription
    // and data-hastab double as the Lyrics/Tab has-resource sort keys.
    return `<div class="lyric-row-wrap" data-title="${escapeAttr(row.title.toLowerCase())}" data-artist="${escapeAttr((row.artist || "").toLowerCase())}" data-transcription="${row.internal ? "yes" : "no"}" data-haschords="${row.hasChords ? "yes" : "no"}" data-hastab="${row.tabHref ? "yes" : "no"}" data-type="${escapeAttr(row.type.toLowerCase())}" data-album="${escapeAttr(row.album)}" data-plays="${row.total}">
      <a class="lyric-row" href="${escapeAttr(href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>
        <span class="lr-title">${escapeHtml(row.title)}</span>
        <span class="lr-artist">${artistCell}</span>
        <span class="lr-sub">${albumCell}</span>
        <span class="lr-words">${words}</span>
        <span class="lr-plays">${plays}</span>
      </a>
      ${tabCell}
    </div>`;
  }).join("");
  const count = `${formatNumber(total)} song${total === 1 ? "" : "s"}`;
  const albumSelectOptions = [{ value: "", label: "All albums" }, ...albums.map((title) => ({ value: title, label: title }))];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic Lyrics &amp; Chords | Burnthday</title>
    <meta name="description" content="Every Widespread Panic song — where to find its lyrics and chords. Our own transcriptions where they exist, and Everyday Companion for the rest, with live play counts.">
    <link rel="canonical" href="https://burnthday.com/lyrics-chords/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main songs-main">
      <header class="archive-title">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">Lyrics &amp; Chords</span></nav>
        <h1>Lyrics &amp; Chords</h1>
        <p class="songs-deck">The full songbook: lyrics for every song, and guitar chords wherever they exist. Songs we have not transcribed link out to Everyday Companion, which has nearly all of them.</p>
      </header>
      <div class="song-search">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <input type="search" id="lyric-search" placeholder="Search ${formatNumber(total)} songs…" autocomplete="off" aria-label="Search lyrics and chords">
        <span class="song-count" id="lyric-count">${count}</span>
      </div>
      <div class="index-toolbar" role="group" aria-label="Filter lyrics and chords">
        <div class="type-filter" role="group" aria-label="Filter songs by type">
          <button type="button" class="is-active" data-type-filter="all">All</button>
          <button type="button" data-type-filter="original">Originals</button>
          <button type="button" data-type-filter="cover">Covers</button>
        </div>
        <label class="index-check"><input type="checkbox" data-chords-filter> Has chords</label>
        <label class="index-check"><input type="checkbox" data-tab-filter> Has tab</label>
        ${renderCustomSelect({ hook: "data-album-filter", label: "Album", active: "", options: albumSelectOptions })}
      </div>
      <div class="lyric-head" role="row">
        <button type="button" class="lh-col lh-sort lh-title" data-sort="title" aria-sort="none">Song <span class="lh-arrow" aria-hidden="true">↕</span></button>
        <button type="button" class="lh-col lh-sort lh-artist" data-sort="artist" aria-sort="none">Artist <span class="lh-arrow" aria-hidden="true">↕</span></button>
        <span class="lh-col lh-album">Album</span>
        <button type="button" class="lh-col lh-sort lh-words" data-sort="transcription" aria-sort="none">Lyrics <span class="lh-arrow" aria-hidden="true">↕</span></button>
        <button type="button" class="lh-col lh-sort lh-tab" data-sort="hastab" aria-sort="none">Tab <span class="lh-arrow" aria-hidden="true">↕</span></button>
        <button type="button" class="lh-col lh-sort lh-plays" data-sort="plays" aria-sort="none">Plays <span class="lh-arrow" aria-hidden="true">↕</span></button>
      </div>
      <div class="song-list lyrics-list" id="lyric-list">${rows}</div>
      <p class="song-empty" id="lyric-empty" hidden>No songs match those filters.</p>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
    <script>${renderLyricsSearchScript()}</script>
  </body>
</html>
`;
}

// Client-side search + multi-facet filter for the Lyrics & Chords hub. Composes a
// title search, a Type button group, a "Has Burnthday transcription" toggle and an
// Album <select> — all reading the data-* attributes on each .lyric-row. Modeled on
// the homepage Tour Stats rarity/type filter interaction.
function renderLyricsSearchScript() {
  return `(() => {
    const input = document.getElementById("lyric-search");
    const list = document.getElementById("lyric-list");
    const rows = [...list.querySelectorAll(".lyric-row-wrap")];
    const count = document.getElementById("lyric-count");
    const empty = document.getElementById("lyric-empty");
    const total = rows.length;
    const typeButtons = [...document.querySelectorAll(".index-toolbar [data-type-filter]")];
    const chordsBox = document.querySelector("[data-chords-filter]");
    const tabBox = document.querySelector("[data-tab-filter]");
    const albumSelect = document.querySelector("[data-album-filter]");
    let selectedType = "all";
    const base = total + " songs";
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      const chordsOnly = chordsBox && chordsBox.checked;
      const tabOnly = tabBox && tabBox.checked;
      const album = albumSelect ? (albumSelect.dataset.value || "") : "";
      let shown = 0;
      rows.forEach((row) => {
        const hit = (!q || row.dataset.title.includes(q))
          && (selectedType === "all" || row.dataset.type === selectedType)
          && (!chordsOnly || row.dataset.haschords === "yes")
          && (!tabOnly || row.dataset.hastab === "yes")
          && (!album || row.dataset.album === album);
        row.hidden = !hit;
        if (hit) shown++;
      });
      empty.hidden = shown !== 0;
      const filtered = q || selectedType !== "all" || chordsOnly || tabOnly || album;
      count.textContent = filtered ? shown + " of " + total + " songs" : base;
    };
    // Column sort: click a header to sort by that key; click again to flip direction.
    // PLAYS is numeric; LYRICS (data-transcription) and TAB (data-hastab) sort by
    // has-resource ("yes" > "no"), surfacing our own transcriptions / hosted tabs
    // first. Title breaks every tie. Sort reorders the wraps; filtering is unaffected.
    const sortButtons = [...document.querySelectorAll(".lyric-head [data-sort]")];
    const numeric = { plays: true };
    let sortKey = "";
    let sortDir = "asc";
    const compare = (a, b) => {
      const av = a.dataset[sortKey] || "";
      const bv = b.dataset[sortKey] || "";
      let c = numeric[sortKey] ? (Number(av) - Number(bv)) : av.localeCompare(bv);
      if (!c) c = a.dataset.title.localeCompare(b.dataset.title);
      return sortDir === "asc" ? c : -c;
    };
    const runSort = () => {
      [...list.querySelectorAll(".lyric-row-wrap")].sort(compare).forEach((w) => list.appendChild(w));
    };
    sortButtons.forEach((btn) => btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = (key === "title" || key === "artist") ? "asc" : "desc";
      }
      sortButtons.forEach((b) => {
        const on = b.dataset.sort === sortKey;
        b.setAttribute("aria-sort", on ? (sortDir === "asc" ? "ascending" : "descending") : "none");
        const arrow = b.querySelector(".lh-arrow");
        if (arrow) arrow.textContent = on ? (sortDir === "asc" ? "↑" : "↓") : "↕";
      });
      runSort();
    }));
    typeButtons.forEach((btn) => btn.addEventListener("click", () => {
      selectedType = btn.dataset.typeFilter;
      typeButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
      apply();
    }));
    if (chordsBox) chordsBox.addEventListener("change", apply);
    if (tabBox) tabBox.addEventListener("change", apply);
    if (albumSelect) albumSelect.addEventListener("cs:change", apply);
    input.addEventListener("input", apply);
    input.focus();
  })();
  ${renderCustomSelectScript()}`;
}

async function writeSongOrigins(origins, data, albums = []) {
  if (!origins.length) return;

  await writeStaticPage("/song-origins/index.html", renderSongOriginsIndex(origins, {
    canonicalPath: "/song-origins/",
    data,
    albums
  }));
  await Promise.all(origins.map((origin) => writeStaticPage(`/song-origins/${origin.slug}/index.html`, renderSongOriginPage(origin, origins, data, albums))));
}

// Join a Song Origin to the rich data layer WITHOUT touching Alex's prose. Every
// field here is computed at build time from the catalog / albums / setlist data —
// nothing is authored, nothing is written in his voice. Returns null-ish members
// when a join is missing so the template can omit tiles/links cleanly.
function originDataJoin(origin, data, albums = []) {
  const key = normalizeTitle(origin.title);
  const song = (data.catalog || []).find((row) => row.key === key) || null;
  if (!song) return { song: null, slug: "", onAlbums: [], lyricsHref: "" };
  const slug = data.songSlugMap?.get(song.key) || "";
  const onAlbums = songAlbumsFor(song, albums);
  const lyricsHref = data.lyricsResourceByKey?.get(song.key) || "";
  return { song, slug, onAlbums, lyricsHref };
}

async function writeStaticPage(pagePath, html) {
  const relative = pagePath.replace(/^\/+/, "");
  const target = path.join(dist, relative);
  if (!target.startsWith(dist)) throw new Error(`Refusing to write outside dist: ${pagePath}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, finalizeHtml(html), "utf8");
}

// Content-hash cache-busting for the stylesheets. The generated CSS strings are
// deterministic (renderCss / renderStagelightCss take no arguments), so we hash
// them once, lazily, and reuse the digest for every page. A short hash (first 10
// hex of sha256) is plenty to distinguish deploys while keeping the URL tidy.
let cssVersionCache = null;
function cssVersions() {
  if (!cssVersionCache) {
    const shortHash = (str) => crypto.createHash("sha256").update(String(str), "utf8").digest("hex").slice(0, 10);
    cssVersionCache = {
      stagelight: shortHash(renderStagelightCss()),
      styles: shortHash(renderCss())
    };
  }
  return cssVersionCache;
}

// Rewrite every sitewide stylesheet <link> to carry a ?v=<contenthash> query.
// This is what actually fixes the "Franken-styling" bug: browsers cache CSS by
// the FULL URL including the query string, so when the CSS content changes the
// query changes and the browser is forced to fetch the new file — it can never
// pair fresh HTML with a stale immutable-cached stylesheet. Runs on every page
// (via finalizeHtml) and is idempotent (an existing ?v= is replaced, not stacked).
function versionStylesheetLinks(html) {
  const { stagelight, styles } = cssVersions();
  return String(html || "")
    .replace(/href="\/stagelight\.css(?:\?[^"]*)?"/g, `href="/stagelight.css?v=${stagelight}"`)
    .replace(/href="\/styles\.css(?:\?[^"]*)?"/g, `href="/styles.css?v=${styles}"`);
}

function finalizeHtml(html) {
  const value = normalizeMetaDescriptionHtml(rewriteLegacyCoreLinks(versionStylesheetLinks(html)));
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
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="stylesheet" href="/stagelight.css">
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main nf-main">
      <p class="nf-eyebrow">404 · Lost at the show</p>
      <h1 class="nf-title">You wandered off during Drums.</h1>
      <figure class="nf-gif">
        <img src="/assets/archive-media/15.gif" alt="A man raving blissfully in the dark with glow sticks" width="480" height="266">
        <figcaption>Live look at you, trying to find this page.</figcaption>
      </figure>
      <p class="nf-copy">Whatever you were after either got shelved, never made the sheet, or stayed behind when Burnthday left Blogger. The band plays on:</p>
      <nav class="nf-links" aria-label="Find your way back">
        <a href="/">Song Possibilities</a>
        <a href="/songs/">Song Index</a>
        <a href="/#setlists">Setlists</a>
        <a href="/archive/">The Archive</a>
      </nav>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
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
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main">
      <article class="archive-page privacy-page">
        <header class="archive-title">
          <p>Last updated July 18, 2026</p>
          <h1>Privacy</h1>
        </header>
        <div class="archive-content prose-plate">
          <p>Burnthday is an independent Widespread Panic fan site. You do not need an account, and the site does not ask for your name, email address, or payment information.</p>
          <h2>Analytics</h2>
          <p>Burnthday uses Google Analytics 4 to understand which pages people visit, how they found the site, and how the site performs on different devices. Google Analytics may use cookies and collect information such as browser and device details, approximate location, referring pages, and interactions with the site. Burnthday uses this information in aggregate to maintain and improve the site.</p>
          <p>Burnthday does not sell personal information. You can learn how Google handles information in the <a href="https://policies.google.com/privacy">Google Privacy Policy</a> and install the <a href="https://tools.google.com/dlpage/gaoptout">Google Analytics opt-out browser add-on</a>.</p>
          <h2>Affiliation</h2>
          <p>Burnthday is a fan project. It is not affiliated with, endorsed by, or operated by Widespread Panic, the band's management, or its record labels. Band names, song titles, and album artwork belong to their respective owners and appear here for identification and commentary. Setlist data is used with attribution per the source terms shown in the footer. If you own a photo or other work shown here and would like credit added or the item removed, message Burnthday and it happens.</p>
          <h2>External Links</h2>
          <p>The site links to Widespread Panic, Nugs.net, Facebook, Instagram, X, YouTube, and other independent sources. Those sites have their own privacy practices, and Burnthday does not control them.</p>
          <h2>Questions</h2>
          <p>Questions about this page can be sent through <a href="https://www.facebook.com/burnthday">Burnthday on Facebook</a> or <a href="https://www.instagram.com/burnthday/">Burnthday on Instagram</a>.</p>
        </div>
      </article>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
  </body>
</html>`;
}

async function writeNewslettersPage(data) {
  await writeStaticPage("/newsletters/index.html", renderNewslettersPage(data));
}

// Newsletter archive: the official Moon Times (preserved by the Internet Archive)
// and the fan-run Panicle (transcribed by a fan blog). This is preservation with
// attribution, not republication: each issue shows a short excerpt and a prominent
// outbound link to the source that holds the full text. Known gaps are surfaced
// honestly so the archive does not read as complete when it is not.
function renderNewslettersPage(data) {
  const nl = data.newsletters || {};
  const sources = nl.sources || [];
  const moonSource = sources.find((source) => source.publication === "Moon Times") || {};
  const panicleSource = sources.find((source) => source.publication === "The Panicle") || {};
  const issues = nl.issues || [];
  const moon = issues.filter((issue) => issue.publication === "Moon Times");
  const panicle = issues.filter((issue) => issue.publication === "The Panicle");
  const description = "A preserved archive of Widespread Panic fan newsletters: the official Moon Times via the Internet Archive and the fan-run Panicle via fan transcription, each linked back to its source.";

  const excerpt = (text) => {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return "";
    return clean.length > 260 ? `${clean.slice(0, 260).trim()}…` : clean;
  };

  const originChips = (issue) => {
    const seen = new Set();
    const chips = [];
    for (const mention of issue.songMentions || []) {
      if (!mention.crossReferencesOrigin || !mention.originSlug || seen.has(mention.originSlug)) continue;
      seen.add(mention.originSlug);
      chips.push(`<a class="nl-chip" href="/song-origins/${escapeAttr(mention.originSlug)}/">${escapeHtml(mention.song)}</a>`);
    }
    return chips.length ? `<div class="nl-origins"><span class="nl-origins-label">Song origins mentioned</span>${chips.join("")}</div>` : "";
  };

  const issueCard = (issue, sourceLabel) => {
    const meta = [issue.label, issue.date].filter(Boolean).map((part) => escapeHtml(String(part))).join(" · ");
    const body = excerpt(issue.text);
    return `<li class="nl-issue">
              <div class="nl-issue-head">
                <h3>${escapeHtml(issue.title || issue.label || "Newsletter")}</h3>
                <p class="nl-meta">${meta}</p>
              </div>
              ${body ? `<p class="nl-excerpt">${escapeHtml(body)}</p>` : ""}
              ${originChips(issue)}
              ${issue.sourceUrl ? `<p class="nl-actions"><a class="nl-source" href="${escapeAttr(issue.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceLabel)}</a></p>` : ""}
            </li>`;
  };

  // Moon Times, grouped by volume (ascending), issues ordered by number.
  const moonByVolume = new Map();
  for (const issue of moon) {
    const vol = issue.volume ?? 0;
    if (!moonByVolume.has(vol)) moonByVolume.set(vol, []);
    moonByVolume.get(vol).push(issue);
  }
  const moonVolumes = [...moonByVolume.keys()].sort((a, b) => a - b);
  const moonSection = moon.length ? `<section class="nl-section" aria-labelledby="moon-heading">
          <div class="nl-section-head">
            <h2 id="moon-heading">Moon Times</h2>
            <p>${escapeHtml(moonSource.attribution || "The official Widespread Panic newsletter.")}</p>
          </div>
          ${moonVolumes.map((vol) => `<div class="nl-volume">
            <h3 class="nl-volume-head">Volume ${escapeHtml(String(vol))}</h3>
            <ul class="nl-issue-grid">${moonByVolume.get(vol).sort((a, b) => (a.number || 0) - (b.number || 0)).map((issue) => issueCard(issue, "Read on the Internet Archive")).join("")}</ul>
          </div>`).join("")}
        </section>` : "";

  const panicleSection = panicle.length ? `<section class="nl-section" aria-labelledby="panicle-heading">
          <div class="nl-section-head">
            <h2 id="panicle-heading">The Panicle</h2>
            <p>${escapeHtml(panicleSource.attribution || "A fan-run Widespread Panic newsletter, transcribed by fans.")}</p>
          </div>
          <ul class="nl-issue-grid">${panicle.map((issue) => issueCard(issue, "Read the transcription")).join("")}</ul>
        </section>` : "";

  // Honest "what's missing" note from knownGaps + unreachable.
  const gaps = nl.knownGaps || {};
  const gapItems = [];
  for (const gap of gaps.moonTimes || []) gapItems.push(`<li><strong>Moon Times ${escapeHtml(gap.label)}:</strong> ${escapeHtml(gap.note || "not located online.")}</li>`);
  for (const gap of gaps.moonTimesMastheadOnly || []) gapItems.push(`<li><strong>Moon Times ${escapeHtml(gap.label)}:</strong> masthead archived, but the content pages redirect to ${escapeHtml(gap.duplicateOf || "another issue")}, so no distinct copy survives online.</li>`);
  for (const gap of gaps.panicle || []) gapItems.push(`<li><strong>Panicle ${escapeHtml(gap.label)}${gap.date ? ` (${escapeHtml(gap.date)})` : ""}:</strong> ${escapeHtml(gap.note || "no transcription located online.")}</li>`);
  const unreachable = nl.unreachable || [];
  for (const item of unreachable) gapItems.push(`<li><strong>${escapeHtml(item.publication)} ${escapeHtml(item.label)}:</strong> the archived snapshot no longer loads.</li>`);
  const gapsSection = gapItems.length ? `<section class="nl-gaps" aria-labelledby="gaps-heading">
          <h2 id="gaps-heading">What's missing</h2>
          ${gaps.note ? `<p>${escapeHtml(gaps.note)}</p>` : ""}
          <ul>${gapItems.join("")}</ul>
        </section>` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic Newsletters | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com/newsletters/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <style>${renderNewslettersCss()}</style>
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["Newsletters", "https://burnthday.com/newsletters/"]
    ])}</script>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main">
      <article class="archive-page nl-page">
        <header class="archive-title">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">Newsletters</span></nav>
          <h1>Newsletters</h1>
          <p class="nl-deck">Two Widespread Panic fan newsletters, preserved and linked back to their sources. The official Moon Times and the fan-run Panicle.</p>
        </header>
        <section class="nl-attribution" aria-label="Sources and attribution">
          <p>Moon Times was the official Widespread Panic newsletter. Its text is preserved by the <a href="https://web.archive.org/" target="_blank" rel="noopener noreferrer">Internet Archive's Wayback Machine</a>${moonSource.indexUrl ? ` from <a href="${escapeAttr(moonSource.indexUrl)}" target="_blank" rel="noopener noreferrer">widespreadpanic.com's own archived pages</a>` : ""}.</p>
          <p>The Panicle was a fan-run newsletter from Athens, Georgia. The issues here were transcribed by the <a href="${escapeAttr(panicleSource.indexUrl || "http://widespread-panic.blogspot.com/")}" target="_blank" rel="noopener noreferrer">Nothing But Widespread Panic</a> fan blog. Credit to the blog and the original Panicle authors.</p>
          <p class="nl-attribution-note">This is preservation with attribution, not republication. Each issue below links out to the source that holds the full text.</p>
        </section>
        ${moonSection}
        ${panicleSection}
        ${gapsSection}
      </article>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
  </body>
</html>`;
}

function renderNewslettersCss() {
  return `
      .nl-page { max-width: 940px; }
      .nl-deck { font-size: 1rem; opacity: 0.8; }
      .nl-attribution { border: 1px solid rgba(0,0,0,0.12); border-radius: 10px; padding: 1rem 1.2rem; background: rgba(255,255,255,0.55); margin: 1.5rem 0 2rem; }
      .nl-attribution p { margin: 0 0 0.6rem; font-size: 0.9rem; line-height: 1.55; }
      .nl-attribution p:last-child { margin-bottom: 0; }
      .nl-attribution-note { opacity: 0.72; }
      .nl-section { margin-top: 2.5rem; }
      .nl-section-head h2 { margin: 0 0 0.35rem; }
      .nl-section-head p { margin: 0; font-size: 0.85rem; opacity: 0.72; line-height: 1.5; }
      .nl-volume { margin-top: 1.5rem; }
      .nl-volume-head { font-size: 0.95rem; margin: 0 0 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.85; }
      .nl-issue-grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
      .nl-issue { border: 1px solid rgba(0,0,0,0.12); border-radius: 10px; padding: 1rem 1.1rem; background: rgba(255,255,255,0.5); display: flex; flex-direction: column; gap: 0.6rem; }
      .nl-issue-head h3 { margin: 0; font-size: 1rem; line-height: 1.25; }
      .nl-meta { margin: 0.25rem 0 0; font-size: 0.8rem; opacity: 0.72; }
      .nl-excerpt { margin: 0; font-size: 0.88rem; line-height: 1.5; opacity: 0.9; }
      .nl-origins { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: baseline; }
      .nl-origins-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; width: 100%; }
      .nl-chip { font-size: 0.8rem; font-weight: 600; padding: 0.1rem 0.5rem; border: 1px solid rgba(0,0,0,0.18); border-radius: 999px; }
      .nl-actions { margin: auto 0 0; padding-top: 0.35rem; }
      .nl-source { font-size: 0.82rem; font-weight: 600; }
      .nl-gaps { margin-top: 2.5rem; border-top: 1px solid rgba(0,0,0,0.12); padding-top: 1.5rem; }
      .nl-gaps h2 { margin: 0 0 0.5rem; }
      .nl-gaps p { font-size: 0.9rem; opacity: 0.8; line-height: 1.55; }
      .nl-gaps ul { font-size: 0.88rem; line-height: 1.6; padding-left: 1.1rem; }
  `;
}

async function writeFaqPage(data) {
  await writeStaticPage("/faq/index.html", renderFaqPage(data));
}

// Band-level FAQ page (/faq/). Renders the questions a new Widespread Panic fan
// asks as details/summary entries (mirrors the About-page FAQ pattern), each with
// a small sources line — linked when a URL exists, label-only when it does not
// (source URLs are never invented). Entries flagged verify:true are general
// knowledge awaiting human fact-check and are excluded from rendering entirely;
// they stay in the data. FAQPage JSON-LD is emitted from the rendered entries only.
function renderFaqPage(data) {
  const faqData = data.bandFaq || {};
  const allFaqs = faqData.faqs || [];
  const faqs = allFaqs.filter((faq) => faq.verify !== true);
  const held = allFaqs.length - faqs.length;
  const description = faqData.description || "The questions a new Widespread Panic fan actually asks, answered plainly with sources.";

  const sourcesLine = (faq) => {
    const srcs = faq.sources || [];
    if (!srcs.length) return "";
    const parts = srcs.map((s) => (s.url
      ? `<a href="${escapeAttr(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)}</a>`
      : escapeHtml(s.label)));
    return `<p class="faq-sources"><span class="faq-sources-label">Sources</span>${parts.join('<span class="faq-sep" aria-hidden="true">·</span>')}</p>`;
  };

  // Optional in-answer media, all placed INSIDE the <details> answer body (never as
  // section breaks or a page hero). Only images explicitly supplied per entry are
  // rendered — a photo (with a plain caption + optional mono sub-line), a verbatim
  // pull-quote, and verified "watch" links. Nothing is invented; a field is rendered
  // only when the data carries it.
  const renderExtras = (faq) => {
    let out = "";
    if (faq.pullquote) {
      out += `<blockquote class="faq-pullquote"><p>${escapeHtml(faq.pullquote.text)}</p>${faq.pullquote.cite ? `<cite>${escapeHtml(faq.pullquote.cite)}</cite>` : ""}</blockquote>`;
    }
    if (faq.image) {
      const img = faq.image;
      const caps = (Array.isArray(img.caption) ? img.caption : [img.caption]).filter(Boolean);
      out += `<figure class="faq-figure">
            <img src="${escapeAttr(img.src)}" alt="${escapeAttr(img.alt || "")}" loading="lazy" decoding="async"${img.w ? ` width="${img.w}"` : ""}${img.h ? ` height="${img.h}"` : ""}>
            <figcaption class="faq-figcaption">${caps.map((c, i) => `<span class="${i === 0 ? "faq-figcap-main" : "faq-figcap-sub"}">${escapeHtml(c)}</span>`).join("")}</figcaption>
          </figure>`;
    }
    if (faq.links && faq.links.length) {
      out += `<p class="faq-watch">${faq.links.map((l) => `<a href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.label)} <span aria-hidden="true">↗</span></a>`).join('<span class="faq-sep" aria-hidden="true">·</span>')}</p>`;
    }
    return out;
  };

  const renderItem = (faq) => {
    const paras = String(faq.answer || "").split(/\n\n+/).map((p) => `<p>${escapeHtml(p)}</p>`).join("\n            ");
    return `<details class="faq-item"${faq.id ? ` id="${escapeAttr(faq.id)}"` : ""}>
          <summary>${escapeHtml(faq.question)}</summary>
          <div class="faq-answer">
            ${paras}
            ${renderExtras(faq)}
            ${sourcesLine(faq)}
          </div>
        </details>`;
  };

  // Group the rendered questions under mono-label section headers, preserving the
  // order sections first appear in the data. No section-break imagery — the only
  // photographs on the page live inside the specific answers they illustrate.
  const sectionOrder = [];
  for (const faq of faqs) {
    const name = faq.section || "More";
    if (!sectionOrder.includes(name)) sectionOrder.push(name);
  }
  const items = sectionOrder.map((name) => {
    const groupFaqs = faqs.filter((faq) => (faq.section || "More") === name);
    const count = groupFaqs.length;
    return `<section class="faq-group" aria-labelledby="grp-${slugify(name)}">
          <h2 class="faq-group-label" id="grp-${slugify(name)}">${escapeHtml(name)}<span class="faq-group-count" aria-hidden="true">${count}</span></h2>
          ${groupFaqs.map(renderItem).join("\n          ")}
        </section>`;
  }).join("\n        ");

  const faqJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: String(faq.answer || "").replace(/\s*\n+\s*/g, " ").trim() }
    }))
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic FAQ | Burnthday</title>
    <meta name="description" content="${escapeAttr(fitMetaText(description, 155))}">
    <link rel="canonical" href="https://burnthday.com/faq/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <style>${renderFaqCss()}</style>
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["FAQ", "https://burnthday.com/faq/"]
    ])}</script>
    <script type="application/ld+json">${faqJsonLd}</script>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <!-- ${held} FAQ entr${held === 1 ? "y is" : "ies are"} held back for human verification (verify:true) and not rendered. -->
    <main class="archive-main">
      <article class="archive-page faq-page">
        <header class="faq-hero">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">FAQ</span></nav>
          <p class="faq-eyebrow">Widespread Panic</p>
          <h1>The questions we actually get</h1>
          <p class="faq-deck">New to the band? Here's the name, the story, the people, where they stand right now, and where to start listening. Written by fans who've been in the room.</p>
        </header>
        <div class="faq-list">
        ${items}
        </div>
      </article>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
  </body>
</html>`;
}

function renderFaqCss() {
  return `
      .faq-page { max-width: 840px; }

      /* Hero: a quiet glass panel (no backdrop photo — the only images on this page
         live inside the specific answers they illustrate). A soft vertical gradient
         gives it depth; crumbs, title and deck ride above the ::before on z-index. */
      .faq-hero {
        position: relative; overflow: hidden; isolation: isolate;
        border: 1px solid var(--sl-line); border-radius: var(--sl-r);
        padding: clamp(30px, 6vw, 60px) clamp(22px, 5vw, 44px) clamp(24px, 4vw, 34px);
        box-shadow: var(--sl-glass-shadow);
      }
      .faq-hero::before {
        content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
        background-image: linear-gradient(180deg, rgba(9,9,11,0.34) 0%, rgba(11,11,12,0.62) 100%);
      }
      .faq-hero .crumbs { position: relative; }
      .faq-eyebrow {
        margin: 18px 0 8px; font-family: var(--sl-mono); text-transform: uppercase;
        letter-spacing: 0.22em; font-size: 11px; color: var(--sl-faint);
      }
      .faq-hero h1 {
        margin: 0; line-height: 1.04; letter-spacing: -0.01em;
        font-size: clamp(1.9rem, 5.4vw, 3rem);
      }
      .faq-deck {
        margin: 16px 0 0; font-size: 1.02rem; line-height: 1.6; color: var(--sl-muted);
        max-width: 58ch;
      }
      .faq-credit {
        margin: 20px 0 0; font-family: var(--sl-mono); font-size: 9.5px;
        letter-spacing: 0.1em; text-transform: uppercase; color: var(--sl-faint);
      }

      .faq-page .faq-list { margin-top: clamp(30px, 5vw, 46px); }

      /* Section groups with a mono label header, a running count, and a hairline. */
      .faq-group { margin-top: 44px; }
      .faq-group:first-child { margin-top: 0; }
      .faq-group-label {
        display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
        margin: 0; padding: 0 0 12px; border-bottom: 1px solid var(--sl-line-strong);
        font-family: var(--sl-mono); text-transform: uppercase; letter-spacing: 0.2em;
        font-size: 12px; font-weight: 600; color: var(--sl-ink);
      }
      .faq-group-count {
        font-size: 11px; letter-spacing: 0.12em; color: var(--sl-faint); font-weight: 400;
      }

      /* In-answer photo: a captioned figure sitting inside a single answer body.
         Caption is a plain lead line plus an optional mono sub-line (date/place). */
      .faq-figure { margin: 1.1rem 0 1.2rem; }
      .faq-figure img {
        display: block; width: 100%; height: auto; border-radius: var(--sl-r-md);
        border: 1px solid var(--sl-line);
      }
      .faq-figcaption { margin: 9px 0 0; display: flex; flex-direction: column; gap: 3px; }
      .faq-figcap-main { font-size: .82rem; line-height: 1.5; color: var(--sl-muted); max-width: 60ch; }
      .faq-figcap-sub {
        font-family: var(--sl-mono); font-size: 9.5px; letter-spacing: 0.08em;
        text-transform: uppercase; color: var(--sl-faint);
      }

      /* Verbatim pull-quote inside an answer (e.g. Michael Houser, 1996). */
      .faq-pullquote {
        margin: 1.1rem 0; padding: .1rem 0 .1rem 1.1rem;
        border-left: 2px solid var(--sl-line-strong);
      }
      .faq-pullquote p {
        margin: 0 0 .5rem; font-size: 1.05rem; line-height: 1.65; font-style: italic;
        color: var(--sl-ink); max-width: 62ch;
      }
      .faq-pullquote cite {
        font-family: var(--sl-mono); font-style: normal; font-size: .7rem;
        letter-spacing: .1em; text-transform: uppercase; color: var(--sl-faint);
      }

      /* Verified "watch" links inside an answer. */
      .faq-watch { margin: .55rem 0 0; font-size: .85rem; display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
      .faq-watch a { color: var(--sl-muted); }

      .faq-item { border-bottom: 1px solid var(--sl-line); padding: .2rem 0; }
      .faq-item:last-child { border-bottom: none; }
      .faq-item summary { cursor: pointer; padding: 1rem 0; font-weight: 600; letter-spacing: .005em; font-size: 1.04rem; }
      .faq-answer { margin: 0; padding: .1rem 0 1.15rem; }
      .faq-answer p { margin: 0 0 .7rem; line-height: 1.72; color: var(--sl-muted); max-width: 68ch; }
      .faq-sources { display: flex; flex-wrap: wrap; gap: .45rem; align-items: baseline; margin: .35rem 0 0; font-size: .82rem; color: var(--sl-faint); }
      .faq-sources a { color: var(--sl-muted); }
      .faq-sources-label { font-family: var(--sl-mono); text-transform: uppercase; letter-spacing: .1em; font-size: .66rem; opacity: .9; }
      .faq-sep { opacity: .5; }
  `;
}

// ── THE ALMANAC PAGE (/almanac/) ─────────────────────────────────────────────
// Renders the computed almanac. Page chrome is neutral site voice; Burnthday's
// verbatim "Play" notes appear only inside the pull card with a "— Burnthday"
// attribution, and the lyric snippets are styled as 🎵 pull-lines. Tiers are
// shown as plain-language badges; the p-value lives in a title attribute + small
// print, never on the surface.
async function writeAlmanacPage(data) {
  if (!data.almanac) return;
  await writeStaticPage("/almanac/index.html", renderAlmanacPage(data));
}

function almanacTierBadge(entry) {
  const tier = entry.tier;
  const long = entry.behavioral && tier === "confirmed" ? "Confirmed pattern" : (ALMANAC_TIER_LABEL[tier] || "");
  const title = entry.stat && Number.isFinite(entry.stat.p)
    ? `Exact binomial p = ${entry.stat.p.toExponential(1)}`
    : "";
  return `<span class="alm-badge alm-badge-${tier}"${title ? ` title="${escapeAttr(title)}"` : ""}>${escapeHtml(long)}</span>`;
}

// The stat sentence, in plain language, no p-value on the surface.
function almanacWeeklyStatLine(entry) {
  const s = entry.stat;
  if (!s || !s.tot) return "";
  const ratio = s.ratio >= 10 ? Math.round(s.ratio) : s.ratio.toFixed(1);
  return `${formatNumber(s.obs)} of ${formatNumber(s.tot)} lifetime plays are ${escapeHtml(entry.dayPlural || (entry.day + "s"))} · ${ratio}× the odds`;
}
function almanacHolidayStatLine(entry) {
  const s = entry.stat;
  if (!s) return "";
  const occ = entry.occasion || "holiday";
  if (s.dateShows < ALMANAC_MIN_TARGET_SHOWS && entry.tier === "watching") {
    return `Only ${formatNumber(s.dateShows)} ${escapeHtml(occ)} shows in history — not enough data to prove it yet.`;
  }
  const ratio = s.ratio >= 10 ? Math.round(s.ratio) : s.ratio.toFixed(1);
  return `${formatNumber(s.obs)} of ${formatNumber(s.dateShows)} ${escapeHtml(occ)} shows have featured it · ${ratio}× the odds`;
}

function almanacSongLink(entry) {
  return entry.slug
    ? `<a href="/song/${escapeAttr(entry.slug)}/">${escapeHtml(entry.song)}</a>`
    : escapeHtml(entry.song);
}

// One tradition card — song, tier badge, 🎵 lyric pull-line, verbatim Play note,
// and the plain stat line.
function renderAlmanacTraditionCard(entry, statLine) {
  const dayTag = entry.day ? `<span class="alm-daytag">${escapeHtml(entry.day)}</span>`
    : (entry.occasion ? `<span class="alm-daytag">${escapeHtml(entry.occasion)}</span>` : "");
  const lyric = entry.lyric
    ? `<p class="alm-lyric"><span class="alm-note-icon" aria-hidden="true">🎵</span>${escapeHtml(entry.lyric)}</p>`
    : "";
  const play = entry.play
    ? `<blockquote class="alm-play"><p>${escapeHtml(entry.play)}</p><cite>— Burnthday</cite></blockquote>`
    : "";
  // Entries with neither lyric nor Play note (End of the Show, Ain't Life Grand)
  // get a neutral, factual line instead — never written in the owner's voice.
  let neutral = "";
  if (!entry.lyric && !entry.play) {
    if (entry.behavioral) neutral = `<p class="alm-neutral">No lyric predicts this one — but the pattern is hard to ignore.</p>`;
    else if (entry.claim === "owner") neutral = `<p class="alm-neutral">No lyric flags the day, but Burnthday vouches for it — and the numbers lean his way.</p>`;
  }
  return `<article class="alm-card alm-tier-${entry.tier}">
        <header class="alm-card-head">
          <h3 class="alm-song">${almanacSongLink(entry)}</h3>
          <div class="alm-tags">${dayTag}${almanacTierBadge(entry)}</div>
        </header>
        ${lyric}
        ${play}
        ${neutral}
        ${statLine ? `<p class="alm-stat">${statLine}</p>` : ""}
      </article>`;
}

function renderAlmanacCuriosity(entry) {
  if (entry.songs) {
    const rows = entry.songs.map((s) => {
      const ratio = s.stat.ratio >= 10 ? Math.round(s.stat.ratio) : s.stat.ratio.toFixed(1);
      const name = s.slug ? `<a href="/song/${escapeAttr(s.slug)}/">${escapeHtml(s.title)}</a>` : escapeHtml(s.title);
      return `<li><span class="alm-cur-song">${name}</span><span class="alm-cur-ratio">${ratio}× on ${escapeHtml(entry.day)}s</span><small>${formatNumber(s.stat.obs)} of ${formatNumber(s.stat.tot)}</small></li>`;
    }).join("");
    return `<article class="alm-curio">
        <header class="alm-card-head"><h3 class="alm-song">${escapeHtml(entry.title)}</h3><div class="alm-tags"><span class="alm-daytag">${escapeHtml(entry.day)}</span><span class="alm-badge alm-badge-curiosity">Curiosity</span></div></header>
        ${entry.note ? `<p class="alm-cur-note">${escapeHtml(entry.note)}</p>` : ""}
        <ul class="alm-cur-list">${rows}</ul>
      </article>`;
  }
  const s = entry.stat;
  const ratio = s && s.ratio >= 10 ? Math.round(s.ratio) : (s ? s.ratio.toFixed(1) : "");
  const tag = entry.occasion || entry.day || "";
  const statLine = entry.date
    ? `${formatNumber(s.obs)} of ${formatNumber(s.dateShows)} ${escapeHtml(entry.occasion || "")} shows · ${ratio}× the odds`
    : `${formatNumber(s.obs)} of ${formatNumber(s.tot)} plays land on ${escapeHtml(entry.day)}s · ${ratio}× the odds`;
  const name = entry.slug ? `<a href="/song/${escapeAttr(entry.slug)}/">${escapeHtml(entry.song)}</a>` : escapeHtml(entry.song);
  return `<article class="alm-curio">
        <header class="alm-card-head"><h3 class="alm-song">${name}</h3><div class="alm-tags">${tag ? `<span class="alm-daytag">${escapeHtml(tag)}</span>` : ""}<span class="alm-badge alm-badge-curiosity">Curiosity</span></div></header>
        ${entry.note ? `<p class="alm-cur-note">${escapeHtml(entry.note)}</p>` : ""}
        <p class="alm-stat">${statLine}</p>
      </article>`;
}

function renderAlmanacPage(data) {
  const alm = data.almanac;
  const totalShows = formatNumber(alm.totalShows || 0);
  const weekly = alm.weekly.map((e) => renderAlmanacTraditionCard(e, almanacWeeklyStatLine(e))).join("\n      ");
  const holiday = alm.holiday.map((e) => renderAlmanacTraditionCard(e, almanacHolidayStatLine(e))).join("\n      ");
  const curios = alm.curiosities.map((e) => renderAlmanacCuriosity(e)).join("\n      ");
  const description = `Widespread Panic's day-of-the-week and holiday song traditions — lyrics that predict when a song gets played, tested against ${totalShows} shows of setlist history.`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>The Almanac | When Widespread Panic Plays What | Burnthday</title>
    <meta name="description" content="${escapeAttr(fitMetaText(description, 155))}">
    <link rel="canonical" href="https://burnthday.com/almanac/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <style>${renderAlmanacCss()}</style>
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["The Almanac", "https://burnthday.com/almanac/"]
    ])}</script>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main almanac-main">
      <article class="archive-page almanac-page">
        <header class="archive-title">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">The Almanac</span></nav>
          <h1>The Almanac</h1>
          <p class="alm-deck">Some Widespread Panic songs carry the day of the week — or the holiday — right in their lyrics. Fans have long noticed that the band leans into those lines when the calendar lines up. This is the ledger of those traditions: each one a lyric-predicted hunch, then tested against ${totalShows} shows of setlist history to see whether the numbers actually back it up.</p>
        </header>

        <section class="alm-section" aria-labelledby="alm-weekly-h">
          <div class="alm-section-head">
            <h2 id="alm-weekly-h">Weekly &amp; Calendar Traditions</h2>
            <p>Songs whose lyrics name a day — and the setlist record that either confirms it or vouches for it.</p>
          </div>
          <div class="alm-grid">
      ${weekly}
          </div>
        </section>

        <section class="alm-section" aria-labelledby="alm-holiday-h">
          <div class="alm-section-head">
            <h2 id="alm-holiday-h">The Holiday Stat-Pack</h2>
            <p>The Fourth of July and New Year's Eve bust-outs, with the numbers behind each one.</p>
          </div>
          <div class="alm-grid">
      ${holiday}
          </div>
        </section>

        <section class="alm-section alm-whispers" aria-labelledby="alm-whispers-h">
          <div class="alm-section-head">
            <h2 id="alm-whispers-h">The Data Whispers</h2>
            <p>No lyric predicted these — they surfaced from scanning the numbers, and scanning enough numbers always finds <em>some</em> pattern by chance. Fun to notice; not the same kind of claim as the traditions above.</p>
          </div>
          <div class="alm-grid alm-grid-curio">
      ${curios}
          </div>
        </section>

        <p class="alm-foot">Ratios compare a song's share of plays on the target day against the band's overall share of shows on that day. Significance is an exact binomial test; the tier badges translate it into plain language — <strong>Confirmed</strong> (the lyric's hunch holds up strongly), <strong>Vouched</strong> (supported, if less overwhelmingly), <strong>Watching</strong> (too few shows to say yet). Computed from the setlist.fm cache; entertainment, not prophecy.</p>
      </article>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
  </body>
</html>
`;
}

function renderAlmanacCss() {
  return `
      .almanac-page { max-width: 940px; }
      body.stagelight .archive-title p.alm-deck { font-family: var(--sl-display); font-size: 17px; line-height: 1.6; letter-spacing: -0.01em; text-transform: none; color: var(--sl-muted); opacity: 1; max-width: 66ch; margin: 14px 0 0; }
      .alm-section { margin-top: 2.6rem; }
      .alm-section-head h2 { font-family: var(--sl-display); font-size: 1.5rem; letter-spacing: -.01em; margin: 0 0 .3rem; }
      .alm-section-head p { margin: 0 0 1.1rem; opacity: .72; max-width: 62ch; line-height: 1.55; font-size: .95rem; }
      .alm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
      .alm-card, .alm-curio { border: 1px solid var(--sl-line); border-radius: var(--sl-r-md); background: rgba(255,255,255,.022); padding: 1.05rem 1.15rem 1.15rem; display: flex; flex-direction: column; gap: .55rem; }
      .alm-card.alm-tier-confirmed { border-color: rgba(224,190,122,.34); background: linear-gradient(180deg, rgba(224,190,122,.06), rgba(255,255,255,.015)); }
      .alm-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .6rem; }
      .alm-song { font-family: var(--sl-display); font-size: 1.18rem; letter-spacing: -.01em; margin: 0; line-height: 1.2; }
      .alm-song a { color: var(--sl-ink); text-decoration: none; border-bottom: 1px solid transparent; }
      .alm-song a:hover { border-bottom-color: rgba(224,190,122,.6); }
      .alm-tags { display: flex; flex-direction: column; align-items: flex-end; gap: .35rem; flex-shrink: 0; }
      .alm-daytag { font-family: var(--sl-mono); font-size: .64rem; text-transform: uppercase; letter-spacing: .1em; opacity: .68; white-space: nowrap; }
      .alm-badge { font-family: var(--sl-mono); font-size: .62rem; text-transform: uppercase; letter-spacing: .08em; padding: .2rem .5rem; border-radius: var(--sl-r-pill); border: 1px solid var(--sl-line-strong); white-space: nowrap; }
      .alm-badge-confirmed { color: #e0be7a; border-color: rgba(224,190,122,.5); background: rgba(224,190,122,.1); }
      .alm-badge-vouched { color: #cbd6c4; border-color: rgba(203,214,196,.4); }
      .alm-badge-watching { color: var(--sl-muted); }
      .alm-badge-curiosity { color: var(--sl-faint); }
      .alm-lyric { margin: 0; font-size: 1.02rem; line-height: 1.5; color: #e6cf9e; font-style: italic; display: flex; gap: .5rem; align-items: baseline; }
      .alm-note-icon { font-style: normal; font-size: .9rem; opacity: .9; }
      .alm-play { margin: 0; border-left: 2px solid rgba(224,190,122,.4); padding: .1rem 0 .1rem .85rem; }
      .alm-play p { margin: 0 0 .35rem; line-height: 1.55; color: var(--sl-ink); font-size: .96rem; }
      .alm-play cite { font-family: var(--sl-mono); font-size: .72rem; font-style: normal; letter-spacing: .04em; opacity: .7; }
      .alm-neutral { margin: 0; font-size: .93rem; line-height: 1.55; opacity: .78; }
      .alm-stat { margin: .1rem 0 0; font-family: var(--sl-mono); font-size: .78rem; letter-spacing: .01em; opacity: .82; line-height: 1.5; }
      .alm-cur-note { margin: 0; font-size: .93rem; line-height: 1.55; opacity: .78; }
      .alm-cur-list { list-style: none; margin: .25rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
      .alm-cur-list li { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: .2rem .6rem; font-size: .9rem; border-top: 1px solid var(--sl-line-faint); padding-top: .4rem; }
      .alm-cur-list li small { grid-column: 1 / -1; font-family: var(--sl-mono); font-size: .68rem; opacity: .55; }
      .alm-cur-song a { color: var(--sl-ink); }
      .alm-cur-ratio { font-family: var(--sl-mono); font-size: .76rem; color: #e0be7a; opacity: .85; }
      .alm-whispers .alm-section-head p em { font-style: italic; opacity: .95; }
      .alm-foot { margin-top: 2.4rem; padding-top: 1.2rem; border-top: 1px solid var(--sl-line); font-size: .82rem; line-height: 1.6; opacity: .62; max-width: 74ch; }
      .alm-foot strong { color: var(--sl-muted); font-weight: 600; }
  `;
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

async function writeTourReviewHub(data, entries, generatedReviews = [], tourInReviews = []) {
  await writeStaticPage("/tour-in-review/index.html", renderTourReviewHubPage(data, entries, generatedReviews, tourInReviews));
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
  const content = sanitizeArchiveProse(repairArchiveAlbumArtwork(removeFirstArchiveGraphic(entry.content, entry.pageGraphic), entry.path));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com${escapeAttr(publicPath(entry.path))}">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main">
      <article class="archive-page">
        ${renderArchiveHeader(entry, data)}
        <div class="archive-content prose-plate">
          ${content}
        </div>
        ${isLyricArchivePage(entry) ? renderLyricCrosslinks(entry, data) : renderArchiveOriginLink(entry, data)}
      </article>
    </main>
    ${renderSiteFooter(data || { generatedAt: new Date().toISOString(), source: { label: "Blogger Takeout" } }, { stagelight: true })}
  </body>
</html>
`;
}

// The legacy Blogger clip-art PNGs (crystal ball, guitar house, etc.) were
// low-res raster art built for a white page. We retire them in favor of a
// clean typographic title; the source files stay in the repo but aren't shown.
function renderPageGraphicTitle(title) {
  return `<header class="page-graphic-title">
    <h1>${escapeHtml(title)}</h1>
  </header>`;
}

// Strip the Blogger "Microsoft Word" inline formatting so imported prose
// inherits the Stagelight type system. Lyric line breaks (<br>) are preserved;
// only absurd 4+ runs are collapsed.
function sanitizeArchiveProse(content) {
  return String(content || "")
    .replace(/\s*(?:text-align|font-family|font-size|line-height|letter-spacing|color|background(?:-color)?)\s*:\s*[^;"']*;?/gi, "")
    .replace(/\s*style=(["'])\s*\1/gi, "")
    .replace(/<span>\s*/gi, "")
    .replace(/\s*<\/span>/gi, "")
    .replace(/<o:p>\s*<\/o:p>/gi, "")
    .replace(/(?:\s*<br\s*\/?>\s*){4,}/gi, "<br><br>")
    .replace(/<div>\s*<\/div>/gi, "");
}

// Display-clean a Blogger post title: drop the "Widespread Panic" prefix and
// trailing "Lyrics"/"Chords" noise for the H1 and breadcrumb.
function cleanArchiveTitle(title) {
  let value = clean(String(title || "").replace(/^widespread panic\s+/i, "")) || String(title || "");
  // Blogger shouted some titles in all caps; title-case those for a pro feel.
  if (value && value === value.toUpperCase() && /[A-Z]/.test(value)) {
    const small = new Set(["a", "an", "and", "the", "of", "to", "in", "on", "for", "at", "by"]);
    value = value.toLowerCase().replace(/[a-z0-9][a-z0-9'’]*/g, (word, index) =>
      index !== 0 && small.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)
    );
  }
  return value;
}

// A lyric/chord archive page is exactly one whose section resolves to the
// Lyrics & Chords hub (title/category carries "lyric" or "chord"). Single source
// of truth so the hub list, the subpage framing and the resource index agree.
function isLyricArchivePage(entry) {
  return archiveSection(entry).href === "/lyrics-chords/";
}

// Reduce a lyric-page title down to the bare song name so it can join the
// catalog: drop the "Widespread Panic" prefix (via cleanArchiveTitle) and the
// trailing "(Album) Lyrics"/"Chords"/"| Burnthday" noise. Content is never touched.
function lyricSongName(entry) {
  return cleanArchiveTitle(entry.title)
    .replace(/\b(album\s+)?lyrics?\b/gi, "")
    .replace(/\bchords?\b/gi, "")
    .replace(/[|–—-]\s*burnthday.*$/i, "")
    .trim();
}

// Build the computed join for a single lyric page WITHOUT authoring anything:
// the matched catalog song, its /song/ slug, a researched Song Origin and the
// album it appears on. Returns null-ish members when a join is missing.
function lyricPageJoin(entry, data) {
  const songName = lyricSongName(entry);
  const key = normalizeTitle(songName);
  const song = key ? (data.catalog || []).find((row) => (row.key || normalizeTitle(row.title)) === key) : null;
  const slug = song ? (data.songSlugMap?.get(song.key) || "") : "";
  const origin = key ? (data.originsByTitle?.get(key) || null) : null;
  const primaryAlbum = song ? (songAlbumsFor(song, data.albums || [])[0] || null) : null;
  return { songName, key, song, slug, origin, primaryAlbum };
}

function archiveSection(entry) {
  const haystack = `${entry.title || ""} ${(entry.categories || []).join(" ")}`.toLowerCase();
  if (/^\s*about\b/.test((entry.title || "").toLowerCase())) return { label: "About", href: "/about/" };
  if (/lyric|chord/.test(haystack)) return { label: "Lyrics & Chords", href: "/lyrics-chords/" };
  if (/tour in review|in review/.test(haystack)) return { label: "Tour In Review", href: "/tour-in-review/" };
  if (/rumor/.test(haystack)) return { label: "Rumors", href: "/rumors/" };
  if (/\bshelf\b|purgatory/.test(haystack)) return { label: "The Shelf", href: "/shelf/" };
  return { label: "Archive", href: "/archive/" };
}

function renderArchiveHeader(entry, data) {
  const section = archiveSection(entry);
  const title = cleanArchiveTitle(entry.title);
  const isLanding = section.label.toLowerCase() === title.toLowerCase();
  const trail = [`<a href="/">Home</a>`];
  // Detail pages show the ancestor trail only — the current page is already the H1
  // and the categorizing eyebrow, so a self-referential last crumb is dropped. A
  // landing page (section === title) keeps its single current crumb.
  if (!isLanding) {
    trail.push(`<a href="${escapeAttr(section.href)}">${escapeHtml(section.label)}</a>`);
  } else {
    trail.push(`<span aria-current="page">${escapeHtml(title)}</span>`);
  }
  // Lyric/chord pages get a song-specific eyebrow so they read as part of the
  // Lyrics & Chords section rather than an anonymous Blogger post. Framing only —
  // the breadcrumb, title and verbatim body are untouched.
  return `<header class="archive-title">
    <nav class="crumbs" aria-label="Breadcrumb">${trail.join('<span class="crumb-sep" aria-hidden="true">›</span>')}</nav>
    <h1>${escapeHtml(title)}</h1>
    ${entry.categories && entry.categories.length ? `<div class="archive-tags">${entry.categories.map((category) => `<span>${escapeHtml(category)}</span>`).join("")}</div>` : ""}
  </header>`;
}

// Song-specific crosslink row for a lyric/chord page. Every link is a computed
// join over the catalog / origins / albums — nothing here rewrites or reformats
// Alex's lyric body, which stays verbatim on the prose plate above. Reuses the
// same .origin-crosslinks component the Song Origin template ships.
function renderLyricCrosslinks(entry, data) {
  const { song, slug, origin, primaryAlbum } = lyricPageJoin(entry, data);
  const links = [];
  if (song && slug) links.push(`<a class="origin-xlink" href="/song/${escapeAttr(slug)}/"><span class="oxl-label">Live history</span><span class="oxl-go" aria-hidden="true">→</span></a>`);
  // When this lyrics page has a sibling guitar-tab page, cross-link to it (chords
  // live there, not here — no false "chords on this page" promise).
  const chordInfo = song ? data.chordsByKey?.get?.(song.key) : null;
  if (chordInfo && chordInfo.tabHref && chordInfo.tabHref !== entry.path) {
    links.push(`<a class="origin-xlink" href="${escapeAttr(chordInfo.tabHref)}"><span class="oxl-label">Guitar tab</span><span class="oxl-go" aria-hidden="true">→</span></a>`);
  }
  if (origin) links.push(`<a class="origin-xlink" href="/song-origins/${escapeAttr(origin.slug)}/"><span class="oxl-label">Song origin</span><span class="oxl-go" aria-hidden="true">→</span></a>`);
  if (primaryAlbum) links.push(`<a class="origin-xlink" href="/albums/${escapeAttr(primaryAlbum.slug)}/"><span class="oxl-label">Appears on ${escapeHtml(primaryAlbum.title)}</span><span class="oxl-go" aria-hidden="true">→</span></a>`);
  // Small cross-reference to the community canon on Everyday Companion — a verified
  // deep link when one exists, else the safe EC homepage. Our verbatim transcription
  // above stays the primary content; this is a courtesy exit. Rendered ONLY when EC
  // actually knows the song: an exclusive Burnthday page (a brand-new song EC has no
  // entry for) omits the cross-reference rather than dead-ending at the EC homepage.
  if (!links.length) return "";
  return `<nav class="origin-crosslinks" aria-label="Related pages">${links.join("")}</nav>`;
}

// If a lyrics/archive page resolves to a single catalog song that has a
// researched Song Origin, link the two together at the foot of the page.
function renderArchiveOriginLink(entry, data) {
  const index = data?.originsByTitle;
  if (!index || !index.size) return "";
  const songName = cleanArchiveTitle(entry.title)
    .replace(/\b(album\s+)?lyrics?\b/gi, "")
    .replace(/\bchords?\b/gi, "")
    .replace(/[|–—-]\s*burnthday.*$/i, "")
    .trim();
  const origin = index.get(normalizeTitle(songName));
  if (!origin) return "";
  return `<nav class="archive-crosslink" aria-label="Related">
    <a href="/song-origins/${escapeAttr(origin.slug)}/">
      <span class="xl-eyebrow">Song Origin</span>
      <span class="xl-title">The story behind “${escapeHtml(origin.title)}”</span>
      <span class="xl-go" aria-hidden="true">→</span>
    </a>
  </nav>`;
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
  const limit = data.rules.rotationSlpLimit;
  const slugMap = data.songSlugMap || new Map();

  // The Shelf board, same definition as the homepage bento (songs off rotation,
  // plus the handful that returned this tour). Kept in sync so the two views agree.
  const shelfRows = [...(data.boards.shelfOriginals || []), ...(data.boards.shelfCovers || [])];
  const shelfCount = shelfRows.length;
  const offRotation = shelfRows
    .filter((row) => !row.playedThisTour)
    .sort((a, b) => b.effectiveSlp - a.effectiveSlp || byTitle(a, b));
  const returns = shelfRows.filter((row) => row.playedFromShelf).sort((a, b) => b.total - a.total || byTitle(a, b));
  const longest = offRotation[0] || null;

  // Freshly shelved this era: songs that were inside the window last tour
  // (seedSlp < limit) but have now crossed it. This is the computed replacement
  // for the old bulleted "New Additions" dump — same rule, designed as rows.
  const newAdds = data.catalog
    .filter((row) => row.total > 1 && !row.playedThisTour && row.seedSlp < limit && row.effectiveSlp >= limit)
    .sort((a, b) => b.effectiveSlp - a.effectiveSlp || byTitle(a, b));
  const newAddKeys = new Set(newAdds.map((row) => row.key));
  // Longest-gone cut: the deepest of the shelf, excluding the just-shelved so the
  // two lists never repeat a title.
  const deepest = offRotation.filter((row) => !newAddKeys.has(row.key)).slice(0, 8);

  const purgCount = (data.boards.purgatoryOriginals?.length || 0) + (data.boards.purgatoryCovers?.length || 0);
  const woodCount = (data.boards.woodshedOriginals?.length || 0) + (data.boards.woodshedCovers?.length || 0);

  const description = `Burnthday's Widespread Panic Shelf and Purgatory notes for the ${year} tour.`;
  const historicalContent = removeFirstArchiveGraphic(oldShelfEntry?.content || "", "shelf.png");

  // Stat strip — reuse the .song-stat tile pattern. Tabular mono numbers, and
  // any tile whose number we can't compute is omitted rather than faked.
  const tile = (value, label, sub = "") => `<div class="song-stat"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</div>`;
  const statTiles = [];
  if (shelfCount) statTiles.push(tile(formatNumber(shelfCount), "songs shelved", `off the ${formatNumber(limit)}-show window`));
  if (longest) statTiles.push(tile(formatNumber(longest.effectiveSlp), "longest gap", `${longest.title} · last ${longest.lastDisplay}`));
  if (newAdds.length) statTiles.push(tile(formatNumber(newAdds.length), "shelved this era", `crossed the ${formatNumber(limit)}-show line`));
  if (returns.length) statTiles.push(tile(formatNumber(returns.length), "came back this tour", returns.map((row) => row.title).slice(0, 2).join(" · ")));

  const neighbors = [
    { href: "/#purgatory-sheet", name: "Purgatory", count: purgCount, desc: "Played once, ever — waiting on a second life." },
    { href: "/#woodshed-sheet", name: "The Woodshed", count: woodCount, desc: "In rotation, not yet played with Nick Johnson." }
  ].filter((item) => item.count);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic Shelf &amp; Purgatory | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com/shelf/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main shelf-main">
      <article class="archive-page shelf-info-page">
        <header class="archive-title">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">The Shelf</span></nav>
          <h1>The Shelf</h1>
          <p class="shelf-deck">${escapeHtml(`${formatNumber(shelfCount)} songs sit off the ${formatNumber(limit)}-show rotation window — off the sheet, not forgotten. When a song goes ${formatNumber(limit)} shows without a play, it drops here until it earns its way back.`)}</p>
        </header>
        ${statTiles.length ? `<div class="song-stat-grid">${statTiles.join("")}</div>` : ""}
        <section class="shelf-list-section">
          <div class="shelf-section-head">
            <h2>Spring ${escapeHtml(String(year))} New Additions To The Shelf</h2>
            <span>${escapeHtml(`${formatNumber(newAdds.length)} songs crossed the line this era · longest gap first`)}</span>
          </div>
          ${newAdds.length ? `<div class="shelf-list">${newAdds.map((row) => renderShelfRow(row, slugMap, limit)).join("")}</div>` : "<p class=\"shelf-empty\">Nothing new to the Shelf this era.</p>"}
        </section>
        ${deepest.length ? `<section class="shelf-list-section">
          <div class="shelf-section-head">
            <h2>Longest Gone</h2>
            <span>the deepest of the ${escapeHtml(formatNumber(shelfCount))} · shows since last played</span>
          </div>
          <div class="shelf-list is-compact">${deepest.map((row) => renderShelfRow(row, slugMap, limit, { compact: true })).join("")}</div>
          <p class="shelf-more">The Shelf runs ${escapeHtml(formatNumber(shelfCount))} songs deep. <a href="/songs/">Browse the full catalog on the Song Index →</a></p>
        </section>` : ""}
        ${neighbors.length ? `<section class="shelf-neighbors">
          <div class="shelf-section-head"><h2>Related Sheets</h2><span>tracked live on the homepage</span></div>
          <div class="shelf-neighbor-grid">${neighbors.map((item) => `<a class="shelf-neighbor" href="${escapeAttr(item.href)}">
            <span class="shn-count">${formatNumber(item.count)}<small>songs</small></span>
            <span class="shn-name">${escapeHtml(item.name)}</span>
            <span class="shn-desc">${escapeHtml(item.desc)}</span>
            <span class="shn-go" aria-hidden="true">Open on the homepage →</span>
          </a>`).join("")}</div>
        </section>` : ""}
        ${historicalContent ? `<section class="legacy-shelf-notes"><div class="shelf-section-head"><h2>Previous Shelf Updates</h2><span>from the Shelf, in Burnthday's own words</span></div><div class="archive-content prose-plate">${historicalContent}</div></section>` : ""}
      </article>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
  </body>
</html>
`;
}

// One designed Shelf row: title (links to the song's live history), type, last
// played, and the shows-since-last "gap" with a meter showing how far past the
// rotation line it sits. Meter scale = shows past the line as a fraction of one
// full rotation window (`limit`), capped — so a just-shelved song reads short and
// a long-gone one reads full. Compact rows drop the type + meter.
function renderShelfRow(row, slugMap, limit, options = {}) {
  const slug = slugMap.get(row.key) || "";
  const gap = row.effectiveSlp ?? 0;
  const past = Math.max(0, gap - limit);
  const pct = Math.min(100, Math.max(4, Math.round((past / limit) * 100)));
  const title = escapeHtml(row.title);
  const open = slug ? `<a class="shelf-row${options.compact ? " is-compact" : ""}" href="/song/${escapeAttr(slug)}/">` : `<div class="shelf-row${options.compact ? " is-compact" : ""}">`;
  const close = slug ? "</a>" : "</div>";
  if (options.compact) {
    return `${open}
      <span class="shr-title">${title}</span>
      <span class="shr-last">${escapeHtml(row.lastDisplay || "")}<small>last played</small></span>
      <span class="shr-gap-num">${formatNumber(gap)}<small>gap</small></span>
    ${close}`;
  }
  return `${open}
      <span class="shr-title">${title}</span>
      <span class="shr-type">${escapeHtml(row.type)}</span>
      <span class="shr-last">${escapeHtml(row.lastDisplay || "")}<small>last played</small></span>
      <span class="shr-gap"><span class="shr-meter" aria-hidden="true"><i style="width:${pct}%"></i></span><span class="shr-gap-num">${formatNumber(gap)}<small>gap</small></span></span>
    ${close}`;
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
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main">
      <article class="archive-page rumors-page">
        ${renderPageGraphicTitle("Rumors", "crystalball.png")}
        ${renderCurrentRumors(data)}
      </article>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
  </body>
</html>
`;
}

// Current-season rumors, in Burnthday's own words. These are speculation the
// band has not confirmed — kept clearly flagged as such.
const CURRENT_RUMORS = [
  {
    slot: "Halloween",
    place: "New Orleans, LA",
    heat: "Rumored",
    note: "The frontrunner for the Halloween run is a New Orleans stand — the long-wished-for “NOLAween.” Nothing is locked, and a couple of other Southeast rooms keep getting floated, so read this as a lean, not a lock."
  },
  {
    slot: "New Year's Eve",
    place: "Charlotte, NC",
    heat: "Heavily rumored",
    note: "Charlotte is the heavy favorite for the New Year's run. It is not official until the band says so, but this one has legs."
  }
];

function renderCurrentRumors(data) {
  const year = data?.site?.year || 2026;
  return `<section class="current-rumors">
    <div class="rumor-heading">
      <h2>${escapeHtml(String(year))} Rumors</h2>
      <span>Speculation only — confirm before you book</span>
    </div>
    <div class="rumor-grid">
      ${CURRENT_RUMORS.map((rumor) => `<article class="rumor-card">
        <p class="rumor-slot">${escapeHtml(rumor.slot)}</p>
        <p class="rumor-place">${escapeHtml(rumor.place)}</p>
        <p class="rumor-note">${escapeHtml(rumor.note)}</p>
        <span class="rumor-flag">${escapeHtml(rumor.heat)}</span>
      </article>`).join("")}
    </div>
    <p class="rumor-foot">Don't go booking flights until dates are announced 'cause the above is 100% pure speculation. Check <a href="https://widespreadpanic.com/tour" target="_blank" rel="noopener">WidespreadPanic.com/Tour</a> for official dates and call before you haul!</p>
    <p class="rumor-foot">Heard something with a date, venue, and city? Pass it along to <a href="https://www.facebook.com/burnthday">Burnthday on Facebook</a>. Only rumors with real details get posted.</p>
  </section>`;
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

// Compact date range for a tour row: "Oct 5 – Nov 14, 2010" when both ends share a
// year, otherwise the full "Dec 30, 2011 – Jan 1, 2012". Used on the hub index.
function formatTourSpan(first, last) {
  const a = parseDateKey(first);
  const b = parseDateKey(last);
  if (!a || !b) return "";
  const short = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
  };
  const yearA = a.slice(0, 4);
  const yearB = b.slice(0, 4);
  if (a === b) return `${short(a)}, ${yearA}`;
  if (yearA === yearB) return `${short(a)} – ${short(b)}, ${yearA}`;
  return `${short(a)}, ${yearA} – ${short(b)}, ${yearB}`;
}

function decadeLabel(decade) {
  return `${decade}s`;
}

// Porch Songs: the band's own archival-release series of historic Mikey-era shows.
// Burnthday is the compiler here, not the narrator: the highlight prose is the
// band's own copy, rendered as a quoted, attributed block that links back to the
// official page. Full text stays on widespreadpanic.com. No cross-links are mined
// from the prose (the data carries no explicit song fields).
function renderPorchSongsSection(data) {
  const entries = [...(data.porchSongs || [])].sort((a, b) => String(a.dateSort || "").localeCompare(String(b.dateSort || "")) || String(a.year || "").localeCompare(String(b.year || "")));
  if (!entries.length) return "";

  const cards = entries.map((entry) => {
    const place = String(entry.title || "").replace(/^Porch Songs:\s*/i, "").trim() || entry.title;
    const meta = [entry.date, entry.venue].filter(Boolean).map((part) => escapeHtml(String(part))).join(" · ");
    const listen = entry.listen || {};
    const listenLinks = [];
    if (listen.relisten) listenLinks.push(`<a class="porch-listen" href="${escapeAttr(listen.relisten)}" target="_blank" rel="noopener noreferrer">Listen on Relisten</a>`);
    if (listen.archiveOrg) listenLinks.push(`<a class="porch-listen" href="${escapeAttr(listen.archiveOrg)}" target="_blank" rel="noopener noreferrer">archive.org</a>`);
    const highlight = entry.hasHighlights && entry.highlights
      ? `<blockquote class="porch-note"><p>${escapeHtml(String(entry.highlights))}</p><cite>From the band's Porch Songs series, <a href="${escapeAttr(entry.sourceUrl)}" target="_blank" rel="noopener noreferrer">widespreadpanic.com</a></cite></blockquote>`
      : (entry.sourceUrl ? `<p class="porch-source"><a href="${escapeAttr(entry.sourceUrl)}" target="_blank" rel="noopener noreferrer">Read on widespreadpanic.com</a></p>` : "");
    return `<li class="porch-card${entry.hasHighlights ? " has-note" : ""}">
              <div class="porch-card-head">
                <h3>${escapeHtml(place)}</h3>
                <p class="porch-meta">${meta}</p>
              </div>
              ${highlight}
              ${listenLinks.length ? `<p class="porch-actions">${listenLinks.join("")}</p>` : ""}
            </li>`;
  }).join("");

  return `<section class="tour-porch" aria-labelledby="porch-heading">
          <div class="tour-index-head">
            <h2 id="porch-heading">Porch Songs</h2>
            <span>The band's archival releases of historic Mikey-era shows, with their note and a link to listen.</span>
          </div>
          <ul class="porch-grid">${cards}</ul>
        </section>`;
}

// Tour Prints: one commissioned poster per tour from the band's official archive.
// Poster art is © the credited artists, so every image renders with its artist
// credit and a link back to the official page. Never an unattributed image, never
// an invented artist name.
function renderTourPrintsSection(data) {
  const posters = [...(data.tourPosters || [])].sort((a, b) => String(a.tourSort || a.year || "").localeCompare(String(b.tourSort || b.year || "")));
  if (!posters.length) return "";

  const cards = posters.map((poster) => {
    const alt = `${poster.tour} tour poster${poster.artist ? ` by ${poster.artist}` : ""}`;
    const credit = poster.artist
      ? `<a class="print-credit" href="${escapeAttr(poster.sourceUrl)}" target="_blank" rel="noopener noreferrer">Print by ${escapeHtml(poster.artist)}</a>`
      : `<a class="print-credit" href="${escapeAttr(poster.sourceUrl)}" target="_blank" rel="noopener noreferrer">via widespreadpanic.com</a>`;
    return `<li class="print-card">
              <a class="print-image" href="${escapeAttr(poster.sourceUrl)}" target="_blank" rel="noopener noreferrer"><img src="${escapeAttr(poster.image)}" alt="${escapeAttr(alt)}" loading="lazy"></a>
              <p class="print-tour">${escapeHtml(poster.tour)}</p>
              ${credit}
            </li>`;
  }).join("");

  return `<section class="tour-prints" aria-labelledby="prints-heading">
          <div class="tour-index-head">
            <h2 id="prints-heading">Tour Prints</h2>
            <span>One commissioned print per tour from the band's official poster archive. Art belongs to the credited artists.</span>
          </div>
          <ul class="print-grid">${cards}</ul>
        </section>`;
}

// Scoped styles for the Porch Songs + Tour Prints archival sections on the hub.
function renderTourArchiveCss() {
  return `
      .tour-porch, .tour-prints { margin-top: 3rem; }
      .porch-grid, .print-grid { list-style: none; margin: 1.25rem 0 0; padding: 0; display: grid; gap: 1rem; }
      .porch-grid { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
      .porch-card { border: 1px solid rgba(0,0,0,0.12); border-radius: 10px; padding: 1rem 1.1rem; background: rgba(255,255,255,0.55); display: flex; flex-direction: column; gap: 0.6rem; }
      .porch-card-head h3 { margin: 0; font-size: 1.05rem; line-height: 1.2; }
      .porch-meta { margin: 0.25rem 0 0; font-size: 0.82rem; opacity: 0.72; }
      .porch-note { margin: 0; border-left: 3px solid rgba(0,0,0,0.28); padding: 0.1rem 0 0.1rem 0.85rem; }
      .porch-note p { margin: 0; font-size: 0.9rem; line-height: 1.5; }
      .porch-note cite { display: block; margin-top: 0.5rem; font-size: 0.78rem; font-style: normal; opacity: 0.72; }
      .porch-actions, .porch-source { margin: auto 0 0; display: flex; flex-wrap: wrap; gap: 0.75rem; padding-top: 0.35rem; }
      .porch-listen, .porch-source a { font-size: 0.82rem; font-weight: 600; }
      .print-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
      .print-card { display: flex; flex-direction: column; gap: 0.4rem; }
      .print-image { display: block; border-radius: 8px; overflow: hidden; border: 1px solid rgba(0,0,0,0.12); }
      .print-image img { display: block; width: 100%; height: auto; }
      .print-tour { margin: 0.35rem 0 0; font-size: 0.88rem; font-weight: 600; line-height: 1.25; }
      .print-credit { font-size: 0.78rem; opacity: 0.8; }
  `;
}

function renderTourReviewHubPage(data, archiveEntries, generatedReviews = [], tourInReviews = []) {
  const description = "Burnthday's Widespread Panic Tour In Review: one computed page per tour from setlist.fm, unified with Alex's hand-written reviews.";

  // Sort newest first (by last show date, then first).
  const sorted = [...tourInReviews].sort((a, b) => (b.last || "").localeCompare(a.last || "") || (b.first || "").localeCompare(a.first || ""));

  // Join each generated tour page to Alex's matching written review, reusing the
  // same year + season-keyword matcher the detail pages use for their crosslink.
  const proseByRoute = new Map();
  for (const tour of sorted) {
    const prose = findProseReviewForTour(tour, archiveEntries || []);
    if (prose) proseByRoute.set(tour.route, prose);
  }
  const writtenCount = proseByRoute.size;
  const yearsAll = sorted.map((tour) => tour.year).filter(Boolean);
  const minYear = yearsAll.length ? Math.min(...yearsAll) : 0;
  const maxYear = yearsAll.length ? Math.max(...yearsAll) : 0;
  const spanLabel = minYear && maxYear ? (minYear === maxYear ? String(minYear) : `${minYear}–${maxYear}`) : "";
  const countLine = `${formatNumber(sorted.length)} tours · ${spanLabel} · ${formatNumber(writtenCount)} with written reviews`;

  // Group into decades, newest first; each decade keeps its tours newest first.
  const byDecade = new Map();
  for (const tour of sorted) {
    const decade = Math.floor(tour.year / 10) * 10;
    if (!byDecade.has(decade)) byDecade.set(decade, []);
    byDecade.get(decade).push(tour);
  }
  const decades = [...byDecade.keys()].sort((a, b) => b - a);

  const badge = (route) => {
    const prose = proseByRoute.get(route);
    return prose ? `<a class="tr-badge" href="${escapeAttr(publicPath(prose.path))}">Burnthday review</a>` : "";
  };

  const decadeButtons = [`<button type="button" class="is-active" data-decade-filter="all">All</button>`]
    .concat(decades.map((decade) => `<button type="button" data-decade-filter="${decade}">${escapeHtml(decadeLabel(decade))}</button>`))
    .join("");

  const tourIndex = decades.length ? `<section class="tour-index" aria-label="Every tour in review">
          <div class="tour-index-head">
            <h2>Every Tour</h2>
            <span>${escapeHtml(countLine)}</span>
          </div>
          ${decades.map((decade) => `<div class="tour-decade" data-decade="${decade}">
            <h3 class="tour-decade-head">${escapeHtml(decadeLabel(decade))}<span>${formatNumber(byDecade.get(decade).length)} ${byDecade.get(decade).length === 1 ? "tour" : "tours"}</span></h3>
            <ul class="tour-rows">${byDecade.get(decade).map((tour) => `<li class="tour-row" data-decade="${decade}" data-review="${proseByRoute.has(tour.route) ? "yes" : "no"}" data-name="${escapeAttr(`${tour.year} ${tour.dispName}`.toLowerCase())}">
              <a class="tour-row-link" href="${escapeAttr(tour.route)}">
                <span class="tr-name">${escapeHtml(`${tour.year} ${tour.dispName}`)}</span>
                <span class="tr-span">${escapeHtml(formatTourSpan(tour.first, tour.last))}</span>
                <span class="tr-shows">${formatNumber(tour.showCount)} ${tour.showCount === 1 ? "show" : "shows"}</span>
              </a>
              ${badge(tour.route)}
            </li>`).join("")}</ul>
          </div>`).join("")}
        </section>` : "";

  const featured = writtenCount ? `<section class="tour-featured" aria-label="Tours Alex reviewed by hand">
          <div class="tour-index-head">
            <h2>Written Reviews</h2>
            <span>${formatNumber(writtenCount)} tours reviewed by hand</span>
          </div>
          <ul class="tour-featured-grid">
            ${sorted.filter((tour) => proseByRoute.has(tour.route)).map((tour) => {
              const prose = proseByRoute.get(tour.route);
              return `<li><a href="${escapeAttr(publicPath(prose.path))}"><span class="tfc-year">${escapeHtml(String(tour.year))}</span><span class="tfc-name">${escapeHtml(tour.dispName)}</span><span class="tfc-tag">Burnthday review →</span></a></li>`;
            }).join("")}
          </ul>
        </section>` : "";

  const yearSummary = generatedReviews.length ? `<section class="tour-year-summary" aria-label="Year summaries">
          ${generatedReviews.map((review) => `<a href="${escapeAttr(publicPath(review.path))}"><span>Year in review</span><strong>${escapeHtml(String(review.year || 2025))} Tour</strong></a>`).join("")}
        </section>` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic Tour In Review | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com/tour-in-review/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <style>${renderTourArchiveCss()}</style>
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["Tour In Review", "https://burnthday.com/tour-in-review/"]
    ])}</script>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main songs-main">
      <header class="archive-title tour-hub-title">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">Tour In Review</span></nav>
        <h1>Tour In Review</h1>
        <p class="tour-hub-deck">Burnthday's Widespread Panic Tour In Review pages — one page per tour, computed from setlist.fm and unified with Alex's hand-written reviews. <b>${escapeHtml(countLine)}.</b></p>
      </header>
      ${featured}
      <div class="song-search">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <input type="search" id="tour-search" placeholder="Search ${formatNumber(sorted.length)} tours…" autocomplete="off" aria-label="Search tours">
        <span class="song-count" id="tour-count">${escapeHtml(countLine)}</span>
      </div>
      <div class="index-toolbar" role="group" aria-label="Filter tours">
        <div class="type-filter" role="group" aria-label="Filter tours by decade">
          ${decadeButtons}
        </div>
        <button type="button" class="index-toggle" data-review-filter aria-pressed="false">Written reviews only</button>
      </div>
      ${tourIndex}
      <p class="song-empty" id="tour-empty" hidden>No tours match those filters.</p>
      ${yearSummary}
      ${renderPorchSongsSection(data)}
      ${renderTourPrintsSection(data)}
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
    <script>${renderTourHubScript()}</script>
  </body>
</html>
`;
}

// Client-side search + decade filter + "written reviews only" toggle for the Tour
// In Review hub. Modeled on renderLyricsSearchScript: reads data-* on each .tour-row,
// hides non-matching rows, and collapses any decade group with no visible rows.
function renderTourHubScript() {
  return `(() => {
    const input = document.getElementById("tour-search");
    const rows = [...document.querySelectorAll(".tour-row")];
    const decades = [...document.querySelectorAll(".tour-decade")];
    const count = document.getElementById("tour-count");
    const empty = document.getElementById("tour-empty");
    const total = rows.length;
    const base = count.textContent;
    const decadeButtons = [...document.querySelectorAll(".index-toolbar [data-decade-filter]")];
    const reviewToggle = document.querySelector("[data-review-filter]");
    let selectedDecade = "all";
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      const reviewOnly = reviewToggle && reviewToggle.getAttribute("aria-pressed") === "true";
      let shown = 0;
      rows.forEach((row) => {
        const hit = (!q || row.dataset.name.includes(q))
          && (selectedDecade === "all" || row.dataset.decade === selectedDecade)
          && (!reviewOnly || row.dataset.review === "yes");
        row.hidden = !hit;
        if (hit) shown++;
      });
      decades.forEach((group) => {
        const anyVisible = [...group.querySelectorAll(".tour-row")].some((row) => !row.hidden);
        group.hidden = !anyVisible;
      });
      empty.hidden = shown !== 0;
      const filtered = q || selectedDecade !== "all" || reviewOnly;
      count.textContent = filtered ? shown + " of " + total + " tours" : base;
    };
    decadeButtons.forEach((btn) => btn.addEventListener("click", () => {
      selectedDecade = btn.dataset.decadeFilter;
      decadeButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
      apply();
    }));
    if (reviewToggle) reviewToggle.addEventListener("click", () => {
      reviewToggle.setAttribute("aria-pressed", reviewToggle.getAttribute("aria-pressed") === "true" ? "false" : "true");
      apply();
    });
    input.addEventListener("input", apply);
  })();`;
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
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
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
      ${renderStrikeScriptBody()}
      ${renderCustomSelectScript()}
    </script>
  </body>
</html>
`;
}

/* ============================================================
   DATA-DRIVEN "TOUR IN REVIEW" — one page per tour, built from
   the setlist.fm cache. A tour is a run of shows split wherever
   the gap between consecutive shows exceeds 21 days. Mirrors
   Alex's own hand-written reviews and reuses the laminate sheet
   components (renderSongPanel / renderSong).
   ============================================================ */

const TOUR_GAP_DAYS = 21;
const TOUR_BUSTOUT_MIN = 50; // "Welcome Back" cutoff, in shows since last play
const TOUR_ROTATION_PRIOR = 200; // shows before a tour that define its rotation
const TOUR_DEBUT_LIST_CAP = 30;
const TOUR_IGNORE_KEYS = new Set(["jam", "drumsandbass"]); // segment labels, not songs
const FULL_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function daysBetweenIso(a, b) {
  if (!a || !b) return 0;
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
}

function tourSeasonName(leg) {
  const first = leg[0];
  const month = Number(first.date.slice(5, 7));
  const hasOct31 = leg.some((s) => s.date.slice(5) === "10-31");
  const hasNewYear = leg.some((s) => { const md = s.date.slice(5); return md >= "12-29" && md <= "12-31"; });
  if (leg.length <= 6 && hasOct31) return "Halloween Run";
  if (hasNewYear) return "New Year's Run";
  if (leg.length < 5) return `${FULL_MONTH_NAMES[month - 1]} Run`;
  if (month <= 2) return "Winter Tour";
  if (month <= 5) return "Spring Tour";
  if (month <= 8) return "Summer Tour";
  return "Fall Tour";
}

function tourNameSlug(name) {
  return slugify(name.replace(/['’]/g, ""));
}

async function writeTourInReviewPages(data, archiveEntries = []) {
  const cache = await loadSetlistFmCache();
  if (!cache) return [];
  const reviews = buildTourInReviews(data, cache);
  const notesBySlug = await loadTourNotes();
  for (let i = 0; i < reviews.length; i += 1) {
    const prev = reviews[i - 1] || null;
    const next = reviews[i + 1] || null;
    const crosslink = findProseReviewForTour(reviews[i], archiveEntries);
    const notes = notesBySlug.get(reviews[i].slug) || null;
    await writeStaticPage(reviews[i].path, renderTourInReviewPage(reviews[i], data, prev, next, crosslink, notes));
  }
  return reviews;
}

function buildTourInReviews(data, cache) {
  const catalogByKey = new Map((data.catalog || []).map((row) => [normalizeTitle(row.title), row]));
  const shows = [...(cache.shows || [])]
    .filter((show) => show && /^\d{4}-\d{2}-\d{2}$/.test(show.date || ""))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Per-show deduped song keys (segment labels excluded) plus display names.
  const showData = shows.map((show) => {
    const keys = new Set();
    const names = new Map();
    for (const song of show.songs || []) {
      const key = normalizeTitle(song.name);
      if (!key || TOUR_IGNORE_KEYS.has(key)) continue;
      if (!names.has(key)) names.set(key, song.name);
      keys.add(key);
    }
    return { date: show.date, city: clean(show.city), state: clean(show.state), country: clean(show.country), keys, names };
  });

  // Global play indices per song key (ascending), for LTP-gap and debut math.
  const playIndices = new Map();
  showData.forEach((sd, index) => {
    for (const key of sd.keys) {
      if (!playIndices.has(key)) playIndices.set(key, []);
      playIndices.get(key).push(index);
    }
  });

  // Split into legs on >21-day gaps.
  const legs = [];
  let current = [];
  for (let i = 0; i < showData.length; i += 1) {
    if (current.length && daysBetweenIso(showData[current[current.length - 1]].date, showData[i].date) > TOUR_GAP_DAYS) {
      legs.push(current);
      current = [];
    }
    current.push(i);
  }
  if (current.length) legs.push(current);

  const newestDate = showData.length ? showData[showData.length - 1].date : "";
  const meta = legs.map((idxs) => {
    const legShows = idxs.map((i) => showData[i]);
    return {
      idxs,
      year: Number(legShows[0].date.slice(0, 4)),
      name: tourSeasonName(legShows),
      first: legShows[0].date,
      last: legShows[legShows.length - 1].date
    };
  });

  // Merge same-named legs within a year into ONE tour (owner's rule): a small
  // break inside a season does not create a second tour. "Spring Tour" +
  // "Spring Tour II" become one "Spring Tour" spanning both legs — all shows
  // included, every stat computed over the union of show indices. Distinctly-
  // named runs (Halloween Run, New Year's Run, <Month> Run) stay separate; two
  // same-named month runs in one year (rare) merge too, since the group key is
  // year + name. We record the -ii slugs the old disambiguation WOULD have
  // produced so renderRedirects can 301 those dead links to the merged page.
  const byYearName = new Map();
  const order = [];
  for (const m of meta) {
    const groupKey = `${m.year}|${m.name}`;
    if (!byYearName.has(groupKey)) { byYearName.set(groupKey, []); order.push(groupKey); }
    byYearName.get(groupKey).push(m);
  }
  const mergedMeta = [];
  const deadSlugRedirects = new Map(); // dead -ii slug -> surviving merged slug
  for (const groupKey of order) {
    const group = byYearName.get(groupKey);
    const base = group[0];
    if (group.length > 1) {
      const survivingSlug = `${base.year}-${tourNameSlug(base.name)}`;
      group.forEach((m, i) => {
        if (i > 0) {
          const deadDisp = `${m.name} ${romanNumeral(i + 1)}`;
          deadSlugRedirects.set(`${m.year}-${tourNameSlug(deadDisp)}`, survivingSlug);
        }
      });
      const idxs = group.flatMap((m) => m.idxs).sort((a, b) => a - b);
      base.idxs = idxs;
      base.first = showData[idxs[0]].date;
      base.last = showData[idxs[idxs.length - 1]].date;
    }
    base.dispName = base.name;
    base.slug = `${base.year}-${tourNameSlug(base.name)}`;
    base.inProgress = daysBetweenIso(base.last, newestDate) <= TOUR_GAP_DAYS;
    mergedMeta.push(base);
  }

  const reviews = [];
  for (const m of mergedMeta) {
    if (m.inProgress) continue; // exclude the currently-running tour
    const review = computeTourReview(m, showData, playIndices, catalogByKey);
    if (review) reviews.push(review);
  }
  reviews.deadSlugRedirects = deadSlugRedirects; // consumed by renderRedirects
  return reviews;
}

function computeTourReview(meta, showData, playIndices, catalogByKey) {
  const { idxs } = meta;
  const tourShows = idxs.map((i) => showData[i]);
  const showCount = tourShows.length;

  // Contiguous legs within the tour (a merged tour spans >1 leg), split on the
  // same >21-day gap. Powers the compact logistics strip on the page.
  const legs = [];
  let legStart = 0;
  for (let i = 1; i < tourShows.length; i += 1) {
    if (daysBetweenIso(tourShows[i - 1].date, tourShows[i].date) > TOUR_GAP_DAYS) {
      legs.push({ first: tourShows[legStart].date, last: tourShows[i - 1].date, shows: i - legStart });
      legStart = i;
    }
  }
  if (tourShows.length) legs.push({ first: tourShows[legStart].date, last: tourShows[tourShows.length - 1].date, shows: tourShows.length - legStart });

  const counts = new Map();
  const firstTourIdxByKey = new Map();
  for (const gi of idxs) {
    for (const key of showData[gi].keys) {
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!firstTourIdxByKey.has(key)) firstTourIdxByKey.set(key, gi);
    }
  }
  if (counts.size === 0) return null; // nothing to render (e.g. a lone data-less show)

  const displayFor = (key) => {
    const cat = catalogByKey.get(key);
    if (cat) return cat.title;
    const gi = firstTourIdxByKey.get(key);
    const raw = gi != null ? showData[gi].names.get(key) : "";
    return titleCase(raw || key);
  };
  const isOriginal = (key) => catalogByKey.get(key)?.type === "Original"; // unmatched -> covers panel

  const totalPlays = sum([...counts.values()]);
  const uniqueSongs = counts.size;
  const avg = showCount ? (totalPlays / showCount).toFixed(1) : "0.0";

  const cities = new Set();
  const stateShows = new Map();
  for (const show of tourShows) {
    if (show.city) cities.add(`${show.city.toLowerCase()}|${show.state.toLowerCase()}`);
    if (show.state) stateShows.set(show.state, (stateShows.get(show.state) || 0) + 1);
  }

  // Alex's convention: instrumental segments stay on the sheet and in the
  // totals, but never rank in "Most Played" (his 2010 review hand-omits Drums).
  const rankable = [...counts.entries()]
    .filter(([key]) => key !== "drums")
    .map(([key, count]) => ({ key, count, title: displayFor(key) }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  const topCount = rankable.length ? rankable[0].count : 0;
  const mostPlayed = rankable.slice(0, 10);

  const bustouts = [];
  const debuts = [];
  for (const [key] of counts) {
    const firstIdx = firstTourIdxByKey.get(key);
    const indices = playIndices.get(key) || [];
    let prevIdx = -1;
    for (let j = indices.length - 1; j >= 0; j -= 1) {
      if (indices[j] < firstIdx) { prevIdx = indices[j]; break; }
    }
    if (prevIdx === -1) {
      const show = showData[firstIdx];
      debuts.push({ key, title: displayFor(key), date: show.date, city: show.city, state: show.state, gi: firstIdx });
    } else {
      const gap = firstIdx - prevIdx;
      if (gap >= TOUR_BUSTOUT_MIN) bustouts.push({ key, title: displayFor(key), gap });
    }
  }
  bustouts.sort((a, b) => b.gap - a.gap || a.title.localeCompare(b.title));
  debuts.sort((a, b) => a.gi - b.gi || a.title.localeCompare(b.title));
  const biggestGap = bustouts.length ? bustouts[0].gap : 0;

  // Rotation as of the tour's first show: distinct songs from the prior 200
  // shows (fewer if fewer exist; the tour's own songs for the very first tour).
  const firstGlobal = idxs[0];
  const rotationKeys = new Set();
  if (firstGlobal === 0) {
    for (const key of counts.keys()) rotationKeys.add(key);
  } else {
    for (let gi = Math.max(0, firstGlobal - TOUR_ROTATION_PRIOR); gi < firstGlobal; gi += 1) {
      for (const key of showData[gi].keys) rotationKeys.add(key);
    }
  }

  const rotationRow = (key) => ({ title: displayFor(key), key, tourCount: counts.get(key) || 0, stripeAsset: "", isAddOn: false });
  const rotationRows = [...rotationKeys].map(rotationRow);
  const handRow = (key) => ({
    title: displayFor(key),
    key,
    tourCount: counts.get(key) || 0,
    stripeAsset: "",
    isAddOn: true,
    addOnDate: isoToShortDate(showData[firstTourIdxByKey.get(key)].date)
  });
  const handRows = [...counts.keys()].filter((key) => !rotationKeys.has(key)).map(handRow);

  const sheetOriginals = [
    ...rotationRows.filter((row) => isOriginal(row.key)).sort(byTitle),
    ...handRows.filter((row) => isOriginal(row.key)).sort(byTitle)
  ];
  const sheetCovers = [
    ...rotationRows.filter((row) => !isOriginal(row.key)).sort(byTitle),
    ...handRows.filter((row) => !isOriginal(row.key)).sort(byTitle)
  ];

  return {
    year: meta.year,
    name: meta.name,
    dispName: meta.dispName,
    slug: meta.slug,
    path: `/tour-in-review/${meta.slug}/index.html`,
    route: `/tour-in-review/${meta.slug}/`,
    first: meta.first,
    last: meta.last,
    showCount,
    cityCount: cities.size,
    stateCount: stateShows.size,
    uniqueSongs,
    totalPlays,
    avg,
    debutCount: debuts.length,
    biggestGap,
    stateLine: [...stateShows.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    mostPlayed,
    topCount,
    bustouts,
    debuts,
    sheet: { originals: sheetOriginals, covers: sheetCovers },
    handWriteInCount: handRows.length,
    legs
  };
}

function tourReviewKeywords(tour) {
  const keywords = [];
  if (/Winter/.test(tour.name)) keywords.push("winter");
  else if (/Spring/.test(tour.name)) keywords.push("spring");
  else if (/Summer/.test(tour.name)) keywords.push("summer");
  else if (/Fall/.test(tour.name) || tour.name === "Halloween Run") keywords.push("fall");
  if (tour.name === "New Year's Run") keywords.push("new year", "nye");
  if (tour.name === "Halloween Run") keywords.push("halloween");
  return keywords;
}

function findProseReviewForTour(tour, archiveEntries = []) {
  const keywords = tourReviewKeywords(tour);
  if (!keywords.length) return null;
  const year = String(tour.year);
  return (archiveEntries || []).find((entry) => {
    const title = (entry.title || "").toLowerCase();
    return entry.isReview && title.includes(year) && /review/.test(title) && keywords.some((keyword) => title.includes(keyword));
  }) || null;
}

function renderTourInReviewPage(tour, data, prev, next, crosslink, notes = null) {
  const title = `${tour.year} ${tour.dispName}`;
  const dateRange = `${formatLongDate(tour.first)} – ${formatLongDate(tour.last)}`;
  const countLine = `${formatNumber(tour.showCount)} shows · ${formatNumber(tour.cityCount)} cities · ${formatNumber(tour.stateCount)} states`;
  const description = fitMetaText(`${title}: ${tour.showCount} shows, ${tour.uniqueSongs} unique songs, ${tour.debutCount} debuts. A data-driven Widespread Panic tour in review from Burnthday.`, 155);
  const stateLine = tour.stateLine.map(([state, n]) => `${escapeHtml(state)} ×${n}`).join(" · ");

  const tile = (value, label, sub = "") => `<div class="song-stat"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</div>`;
  const tiles = [
    tile(formatNumber(tour.uniqueSongs), "unique songs"),
    tile(tour.avg, "songs per show"),
    tile(formatNumber(tour.debutCount), tour.debutCount === 1 ? "debut" : "debuts"),
    tile(formatNumber(tour.biggestGap), "biggest LTP gap bridged", tour.biggestGap ? "shows" : "none")
  ];

  const debutShown = tour.debuts.slice(0, TOUR_DEBUT_LIST_CAP);
  const debutMore = tour.debuts.length - debutShown.length;

  // TOUR NOTES — the human lead, directly under the hero when it exists. Prose in
  // Burnthday's voice, byline, and a mono "Sources" line linking each URL. These
  // are drafts for the owner's review.
  const notesHtml = notes ? `<section class="tour-notes" aria-label="Tour Notes">
        <div class="tour-notes-head">
          <h2 class="tour-h2">Tour Notes</h2>
          <span class="tour-notes-byline">Notes by ${escapeHtml(notes.byline || "Burnthday")}</span>
        </div>
        <div class="tour-notes-body prose-plate">${notes.bodyHtml}</div>
        ${notes.sources.length ? `<p class="tour-notes-sources"><span class="tns-label">Sources</span>${notes.sources.map((url, i) => {
          let host = url;
          try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep raw */ }
          return `<a href="${escapeAttr(url)}" rel="noopener noreferrer nofollow"><span class="tns-num">${i + 1}</span>${escapeHtml(host)}</a>`;
        }).join("")}</p>` : ""}
      </section>` : "";

  // "The news" — paired Welcome Back (bustouts w/ LTP) + Nice To Meet You (FTP).
  const welcomeCol = tour.bustouts.length ? `<div class="tour-news-col">
          <h2 class="tour-h2">Welcome Back</h2>
          <p class="tour-news-sub">Bustouts — back after a long absence</p>
          <ul class="tour-ltp-list">
            ${tour.bustouts.map((row) => `<li><span class="tl-song">${escapeHtml(row.title)}</span><span class="tl-ltp">LTP ${row.gap}</span></li>`).join("")}
          </ul>
        </div>` : "";
  const meetCol = tour.debuts.length ? `<div class="tour-news-col">
          <h2 class="tour-h2">Nice To Meet You <span class="tour-h2-tag">FTP</span></h2>
          <p class="tour-news-sub">First time played anywhere</p>
          <ul class="tour-ftp-list">
            ${debutShown.map((row) => `<li><span class="tf-song">${escapeHtml(row.title)}</span><span class="tf-meta">${escapeHtml(isoToShortDate(row.date))}${row.city ? ` · ${escapeHtml([row.city, row.state].filter(Boolean).join(", "))}` : ""}</span></li>`).join("")}
          </ul>
          ${debutMore > 0 ? `<p class="tour-more">+${formatNumber(debutMore)} more</p>` : ""}
        </div>` : "";
  const newsHtml = (welcomeCol || meetCol) ? `<section class="tour-news${welcomeCol && meetCol ? "" : " is-single"}" aria-label="Bustouts and debuts">
        ${welcomeCol}${meetCol}
      </section>` : "";

  // Compact logistics strip — tour legs/dates + Shows by State, demoted to mono.
  const legsStrip = (tour.legs && tour.legs.length > 1) ? `<div class="tl-legs">
          <span class="tl-legs-label">Legs</span>
          ${tour.legs.map((leg) => `<span class="tl-leg">${escapeHtml(formatTourSpan(leg.first, leg.last))} <small>${leg.shows} ${leg.shows === 1 ? "show" : "shows"}</small></span>`).join("")}
        </div>` : "";
  const logisticsHtml = (legsStrip || stateLine) ? `<section class="tour-logistics" aria-label="Tour logistics">
        <h2 class="tour-logistics-h">Logistics</h2>
        ${legsStrip}
        ${stateLine ? `<div class="tl-states"><span class="tl-legs-label">Shows by state</span><span class="tour-state-line">${stateLine}</span></div>` : ""}
      </section>` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(`${title} — Tour In Review | Burnthday`)}</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com${escapeAttr(tour.route)}">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["Tour In Review", "https://burnthday.com/tour-in-review/"],
      [title, `https://burnthday.com${tour.route}`]
    ])}</script>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="tour-in-review-main">
      <header class="tour-hero">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><a href="/tour-in-review/">Tour In Review</a></nav>
        <p class="tour-eyebrow">Tour In Review</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="tour-range">${escapeHtml(dateRange)}</p>
        <p class="tour-countline">${escapeHtml(countLine)}</p>
        <p class="tour-attr">Compiled from <a href="https://www.setlist.fm/" rel="noopener noreferrer">setlist.fm</a> · ${formatNumber(tour.showCount)} shows</p>
      </header>

      ${notesHtml}

      ${newsHtml}

      <section class="tour-stats-block" aria-label="By the numbers">
        <div class="song-stat-grid">${tiles.join("")}</div>
        <div class="tour-mostplayed">
          <h2 class="tour-h2">Most Played (${tour.topCount})</h2>
          <ol class="tour-toplist">
            ${tour.mostPlayed.map((row) => `<li><span class="tt-song">${escapeHtml(row.title)}</span><span class="tt-count">${row.count}</span></li>`).join("")}
          </ol>
        </div>
      </section>

      <section class="tour-sheet-wrap" aria-label="The Sheet">
        <p class="tour-sheet-intro">The rotation as it stood when the tour opened — every song on the board, hand write-ins dated the night they landed.</p>
        <div class="laminate primary-board tour-review-sheet" id="the-sheet">
          ${renderBoardHeader("THE SHEET", `Rotation as of ${formatLongDate(tour.first)}`)}
          ${renderSongPanel(`sheet-${tour.slug}-originals`, "ORIGINALS", tour.sheet.originals)}
          ${renderSongPanel(`sheet-${tour.slug}-covers`, "COVERS", tour.sheet.covers)}
        </div>
      </section>

      ${logisticsHtml}

      ${crosslink ? `<nav class="archive-crosslink tour-crosslink" aria-label="Related">
        <a href="${escapeAttr(publicPath(crosslink.path))}"><span class="xl-eyebrow">Burnthday Review</span><span class="xl-title">Read Burnthday's written review of this tour</span><span class="xl-go" aria-hidden="true">→</span></a>
      </nav>` : ""}

      <nav class="album-nav" aria-label="More tours">
        ${prev ? `<a href="${escapeAttr(prev.route)}"><span>Earlier</span><strong>${escapeHtml(`${prev.year} ${prev.dispName}`)}</strong></a>` : "<span></span>"}
        ${next ? `<a class="is-next" href="${escapeAttr(next.route)}"><span>Later</span><strong>${escapeHtml(`${next.year} ${next.dispName}`)}</strong></a>` : "<span></span>"}
      </nav>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
    <script>
      ${renderFitScriptBody()}
      ${renderStrikeScriptBody()}
      ${renderCustomSelectScript()}
    </script>
  </body>
</html>
`;
}

function renderSongOriginsIndex(origins, options = {}) {
  const canonicalPath = options.canonicalPath || "/song-origins/";
  const data = options.data;
  const albums = options.albums || [];
  const description = "Widespread Panic song origins, histories, notes, and Burnthday picks.";
  // Curated entries carry a kind: "story" gets the full card, "fact" a compact
  // card, "trivia" a one-liner pulled out into a "Deep cuts" strip at the end.
  // Legacy (Facebook-sourced) origins have no kind and keep their card treatment
  // and their order untouched: they render in the main grid exactly as before.
  const mainOrigins = origins.filter((origin) => !(origin.curated && origin.kind === "trivia"));
  const trivia = origins.filter((origin) => origin.curated && origin.kind === "trivia");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic Song Origins | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com${escapeAttr(canonicalPath)}">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <style>${renderOriginIndexCss()}</style>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main origins-main">
      <section class="archive-index origin-index">
        <header class="origin-hero">
          <img class="origin-fish" src="/assets/archive-media/SongOriginsOriginalWSPfish.png" alt="">
          <div>
            <h1>Widespread Panic Song Origins</h1>
            <span>The stories behind the songs: how they got written, where they came from, and the people in them. Pulled from band interviews and old fan newsletters, with play history and Burnthday's picks.</span>
          </div>
        </header>
        <div class="origin-grid">
          ${mainOrigins.map((origin) => renderSongOriginCard(origin, data, albums)).join("")}
        </div>
        ${renderDeepCutsStrip(trivia)}
        ${renderOriginAcknowledgments(data)}
      </section>
    </main>
    ${renderSiteFooter({ generatedAt: new Date().toISOString(), source: { label: "Song Origins archive" } }, { stagelight: true })}
  </body>
</html>
`;
}

// Scoped styles for the origins index: compact "fact" cards, the "Deep cuts"
// trivia strip, and the quiet acknowledgments line. The base .origin-card /
// .origin-grid rules live in renderStagelightCss and are left untouched.
function renderOriginIndexCss() {
  return `
      .origin-card[data-kind="fact"] { gap: .2rem; }
      .origin-card[data-kind="fact"] .origin-card-line { display: block; margin-top: .35rem; font-size: .82rem; line-height: 1.45; opacity: .72; }
      .origin-deepcuts { margin-top: 2.6rem; border-top: 1px solid rgba(255,255,255,.12); padding-top: 1.4rem; }
      .origin-deepcuts h2 { margin: 0 0 .2rem; font-size: 1.1rem; letter-spacing: .02em; }
      .origin-deepcuts-sub { margin: 0 0 1rem; font-size: .85rem; opacity: .7; }
      .origin-deepcuts-list { display: grid; gap: .5rem; }
      .origin-deepcuts .origin-card { display: flex; flex-wrap: wrap; align-items: baseline; gap: .1rem .6rem; padding: .55rem .8rem; }
      .origin-deepcuts .origin-card strong { font-size: .95rem; }
      .origin-deepcut-note { font-size: .82rem; opacity: .68; line-height: 1.4; }
      .origin-ack { margin-top: 2.4rem; padding-top: 1.2rem; border-top: 1px solid rgba(255,255,255,.09); font-size: .82rem; opacity: .72; line-height: 1.6; }
      .origin-ack-label { display: inline; text-transform: uppercase; letter-spacing: .09em; font-size: .68rem; opacity: .85; margin-right: .5rem; }
  `;
}

// The "Deep cuts" strip: curated trivia entries rendered as one-liners grouped at
// the end of the index. Each keeps the base .origin-card class (so the index's
// per-origin count stays honest) with data-kind="trivia" for the compact styling.
function renderDeepCutsStrip(trivia) {
  if (!trivia.length) return "";
  const items = trivia.map((origin) => `<a class="origin-card" data-kind="trivia" href="/song-origins/${escapeAttr(origin.slug)}/">
            <strong>${escapeHtml(origin.title)}</strong>${origin.summary ? `<span class="origin-deepcut-note">${escapeHtml(oneLineOriginSummary(origin.summary))}</span>` : ""}
          </a>`).join("");
  return `<section class="origin-deepcuts" aria-label="Deep cuts">
          <h2>Deep cuts</h2>
          <p class="origin-deepcuts-sub">Short, sourced confirmations of the rarities and the unreleased.</p>
          <div class="origin-deepcuts-list">${items}</div>
        </section>`;
}

// Quiet "Special thanks" line rendering each acknowledgments[] entry from the
// curated data. Plain text, no invented links.
function renderOriginAcknowledgments(data) {
  const acks = (data && data.originAcknowledgments) || [];
  if (!acks.length) return "";
  const lines = acks
    .map((ack) => `<span class="origin-ack-item">${escapeHtml(ack.name)}${ack.for ? ` for ${escapeHtml(ack.for)}` : ""}.</span>`)
    .join(" ");
  return `<aside class="origin-ack" aria-label="Special thanks"><span class="origin-ack-label">Special thanks</span>${lines}</aside>`;
}

// Collapse a curated summary to a single clean line for the compact cards / strip.
function oneLineOriginSummary(summary) {
  return String(summary || "").replace(/\s+/g, " ").trim();
}

function renderSongOriginCard(origin, data, albums = []) {
  // Curated "fact" entries are a sourced note, not a saga: a compact card of just
  // title + one-line summary. Story and legacy (no-kind) entries keep the full card.
  if (origin.curated && origin.kind === "fact") return renderCompactOriginCard(origin);
  // Cheap computed meta line: lifetime plays and/or its album, joined from the
  // catalog. Nothing authored — purely derived, omitted when the join is missing.
  const { song, onAlbums } = data ? originDataJoin(origin, data, albums) : { song: null, onAlbums: [] };
  const bits = [];
  if (song && Number.isFinite(song.total) && song.total > 0) bits.push(`${formatNumber(song.total)} plays`);
  else if (Number.isFinite(origin.timesPlayed) && origin.timesPlayed > 0) bits.push(`${formatNumber(origin.timesPlayed)} plays`);
  if (onAlbums[0]) bits.push(escapeHtml(onAlbums[0].title));
  else if (origin.albums?.[0]?.name) bits.push(escapeHtml(origin.albums[0].name));
  const meta = bits.length ? `<small class="origin-card-meta">${bits.join('<span class="ocm-sep" aria-hidden="true">·</span>')}</small>` : "";
  const cardImage = origin.image || origin.albumArt || "";
  return `<a class="origin-card" href="/song-origins/${escapeAttr(origin.slug)}/">
    ${cardImage ? `<img src="${escapeAttr(cardImage)}" alt="${escapeAttr(`${origin.title} song origin`)}" loading="lazy" decoding="async">` : ""}
    <span>Song Origins</span>
    <strong>${escapeHtml(origin.title)}</strong>
    ${meta}
  </a>`;
}

// Compact card for a curated "fact" origin: title + one-line summary, no image, no
// stat meta. Keeps the base .origin-card class (so the index count stays honest)
// with data-kind="fact" driving the tightened styling.
function renderCompactOriginCard(origin) {
  const line = origin.summary ? oneLineOriginSummary(origin.summary) : "";
  return `<a class="origin-card" data-kind="fact" href="/song-origins/${escapeAttr(origin.slug)}/">
    <span>Song Origins</span>
    <strong>${escapeHtml(origin.title)}</strong>
    ${line ? `<small class="origin-card-line">${escapeHtml(line)}</small>` : ""}
  </a>`;
}

// ---- "By the Numbers" footer parser (Song Origins) ------------------------
// Alex's Facebook posts end with a semi-structured, template-driven "by the
// numbers" footer transcribed as one running blob: a set of "Label: value"
// stats, resource links, and a "Burnthday's Picks" list. Left alone it renders
// as an ugly code-dump inside the prose. This parses that footer OUT of the
// verbatim story so the body no longer shows the dump, and returns the pieces
// so they can be re-laid-out as a designed data panel. It is conservative:
//   * The footer is anchored on "# of times played" — the fixed first label of
//     every post. Absent it, we return null and the story renders unchanged.
//   * strippedText is everything BEFORE that anchor (the footer is always the
//     tail), so non-footer prose is never touched.
//   * The stale duplicates "# of times played" / "First time played" are parsed
//     but never surfaced — the computed live strip already shows those, and his
//     transcribed numbers are stale.
//   * panicstream.* URLs are never emitted (they are stripped sitewide).
// Values, labels, notes and pick venues are kept verbatim — this re-lays-out
// his typed data, it does not rewrite it.
const ORIGIN_FOOTER_STOP = String.raw`(?=\s*(?:# of times played|First time played|Frequency|Longest drought|Most common lead\s?in|Most common lead\s?out|Most common set position|Co-written by|Author|Notes|Editor'?s Footnote|Larry'?s Code|Original Lyrics|Alternate version|Song Credits|Annotated|Lyrics|Chords|Learn the Guitar Solo|Guitar [Tt]ab|Burnthday.?s [Pp]icks|https?://)\b|$)`;

const ORIGIN_ANALYTIC_FIELDS = [
  ["Frequency", "Frequency"],
  ["Longest drought", "Longest drought"],
  ["Most common lead in", "Most common lead\\s?in"],
  ["Most common lead out", "Most common lead\\s?out"],
  ["Most common set position", "Most common set position"]
];

// keyword: url — the resource links Alex embeds (Lyrics / Chords / guitar solo /
// tab / song credits). The label is just the keyword so it can never swallow the
// preceding Notes value; the display label is normalised from it.
const ORIGIN_LINK_KEYWORD = /(Learn the Guitar Solo|Guitar [Tt]ab|Song Credits|Lyrics|Chords)\s*:\s*(https?:\/\/\S+)/gi;

function stripPanicStreamText(value) {
  return String(value || "")
    .replace(/(?:https?:\/\/)?(?:www\.)?panicstream\.(?:com|net)\/[^\s"'<>)]*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normaliseOriginLinkLabel(keyword) {
  if (/Solo/i.test(keyword)) return "Learn the guitar solo";
  if (/Tab/i.test(keyword)) return "Guitar tab";
  if (/Credits/i.test(keyword)) return "Song credits";
  if (/Chords/i.test(keyword)) return "Chords";
  return "Lyrics";
}

function originPickIso(mmddyy) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(mmddyy).trim());
  if (!m) return "";
  const [, mo, da, yr] = m;
  const year = yr.length === 4 ? Number(yr) : (Number(yr) >= 80 ? 1900 + Number(yr) : 2000 + Number(yr));
  return `${year}-${String(Number(mo)).padStart(2, "0")}-${String(Number(da)).padStart(2, "0")}`;
}

function parseOriginStatsFooter(text) {
  const src = String(text || "");
  const footerStart = src.indexOf("# of times played");
  if (footerStart < 0) return null;
  const strippedText = src.slice(0, footerStart).replace(/\s+$/, "");
  const footer = src.slice(footerStart);

  // 1. Kept analytics (verbatim). Track the end of the whole stats block so the
  //    notes/picks scan starts safely after the drought/lead-in/out dates.
  const analytics = [];
  let statsEnd = 0;
  for (const [label, pattern] of ORIGIN_ANALYTIC_FIELDS) {
    const re = new RegExp(pattern + "\\s*:\\s*([\\s\\S]*?)" + ORIGIN_FOOTER_STOP);
    const m = re.exec(footer);
    if (!m) continue;
    const value = String(m[1]).replace(/\s+/g, " ").replace(/[;\s]+$/, "").trim();
    if (value) {
      analytics.push({ label, value });
      statsEnd = Math.max(statsEnd, m.index + m[0].length);
    }
  }
  if (!analytics.length) return null;

  // 2. Resource link chips — panicstream never emitted.
  const links = [];
  ORIGIN_LINK_KEYWORD.lastIndex = 0;
  let lm;
  while ((lm = ORIGIN_LINK_KEYWORD.exec(footer))) {
    const url = lm[2].replace(/[),.;]+$/, "");
    if (/panicstream/i.test(url)) continue;
    links.push({ label: normaliseOriginLinkLabel(lm[1]), url });
  }

  // 3. Picks — date + venue + trailing URL. Scanned only after the stats block
  //    so First-time-played / drought dates are never mistaken for a pick. The
  //    (scheme-less) URL is only a terminator; it is never emitted.
  const picks = [];
  const pickRe = /(\d{1,2}\/\d{1,2}\/\d{2})\s+([\s\S]*?)\s*(?:Link\s*:\s*)?((?:https?:\/\/|www\.)\S+)/g;
  pickRe.lastIndex = statsEnd;
  let firstPickIdx = -1;
  let pm;
  while ((pm = pickRe.exec(footer))) {
    if (firstPickIdx < 0) firstPickIdx = pm.index;
    const venue = stripPanicStreamText(String(pm[2]).replace(/\s+/g, " ").replace(/[;\s]+$/, "").trim());
    if (!venue) continue;
    picks.push({ date: pm[1], iso: originPickIso(pm[1]), venue });
  }

  // 4. Notes — the free text between the stats block and the picks block, with
  //    the extracted link (keyword: url) segments removed. Preserves Notes /
  //    Author / Song Credits / JBism etc. verbatim; nothing is dropped.
  const bHeader = footer.search(/Burnthday.?s [Pp]icks/i);
  let notesEnd = footer.length;
  if (firstPickIdx >= 0) notesEnd = Math.min(notesEnd, firstPickIdx);
  if (bHeader >= 0) notesEnd = Math.min(notesEnd, bHeader);
  let notes = footer.slice(statsEnd, notesEnd)
    .replace(ORIGIN_LINK_KEYWORD, "")
    .replace(/Burnthday.?s [Pp]icks\s*:?\s*$/i, "");
  notes = stripPanicStreamText(notes).replace(/^Notes\s*:?\s*/i, "").replace(/[;:\s]+$/, "").trim();
  if (!notes || /^(author|song credits)\s*:?$/i.test(notes)) notes = "";

  return { analytics, links, picks, notes, strippedText };
}

// Pull the songwriter credit and the original-source album out of Alex's verbatim
// footer notes so they can be surfaced in the hero. Names/albums are kept exactly
// as he typed them. The "Appears on …" clause is only lifted when a writer credit
// is present (a cover with an outside origin album); a plain WSP-album note stays
// in the notes since the stat strip already carries the studio album. Returns the
// pulled fields plus the remaining notes with the lifted clauses removed.
function parseOriginCredits(notes) {
  let remaining = String(notes || "").trim();
  let writer = "";
  let appearsOn = "";
  const writerRe = /\b(?:Author|Written by|Co-written by)\s*:?\s*([^;\n]+)/i;
  const wm = writerRe.exec(remaining);
  if (wm) {
    writer = wm[1].trim().replace(/[;,.\s]+$/, "");
    remaining = remaining.slice(0, wm.index) + remaining.slice(wm.index + wm[0].length);
    const appearsRe = /\bAppears on\s+([^;\n]+?)(?=\s*(?:;|Lyrics\s*:|Chords\s*:|Guitar\s*Tab\s*:|Song\s*Credits\s*:|$))/i;
    const am = appearsRe.exec(remaining);
    if (am) {
      appearsOn = am[1].trim().replace(/[;,.\s]+$/, "");
      remaining = remaining.slice(0, am.index) + remaining.slice(am.index + am[0].length);
    }
  }
  remaining = remaining.replace(/^[\s;,.]+/, "").replace(/[\s;,.]+$/, "").replace(/\s{2,}/g, " ").trim();
  return { writer, appearsOn, remaining };
}

// ---- Computed origin "By the Numbers" ----
// The 5 stat rows are COMPUTED live from the full ordered performance log
// (data.setlistShows), replacing Alex's years-old typed snapshot. His verbatim
// notes / credits / Picks / resource links are never touched — only the numbers.
// Jam and Drums and Bass are segment pseudo-songs and are excluded from adjacency.
function isSegmentKey(key) {
  return key === "jam" || key === "drumsandbass" || key === "drumsbass" || key === "drums";
}

// MM/DD/YY from an ISO date, matching Alex's drought bracket formatting.
function shortMdy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : String(iso || "");
}

// Fold setlist.fm's messy set labels ("Set 1:", "Set One", "Set I", "1", "1st",
// "Encore 1", "t 1:") into a canonical bucket. Descriptive labels (Acoustic /
// Electric …) are kept as-is so we never fabricate a set number.
function canonicalSetLabel(raw, encore) {
  const value = String(raw || "").trim();
  if (encore || /^encore/i.test(value)) {
    const m = /encore\s*(\d+)/i.exec(value);
    return m ? `Encore ${m[1]}` : "Encore";
  }
  const core = value.replace(/:$/, "").replace(/\s*\(.*?\)\s*$/, "").replace(/\s+-\s+.*$/, "").trim();
  const words = { one: 1, two: 2, three: 3, i: 1, ii: 2, iii: 3 };
  let m;
  if ((m = /^set\s+(\d+)/i.exec(core))) return `Set ${m[1]}`;
  if ((m = /^set\s+(one|two|three|i{1,3})\b/i.exec(core))) return `Set ${words[m[1].toLowerCase()]}`;
  if ((m = /^t\s+(\d+)/i.exec(core))) return `Set ${m[1]}`;
  if ((m = /^(\d+)(?:st|nd|rd|th)?$/i.exec(core))) return `Set ${m[1]}`;
  if (!core) return "Set 1";
  return /^set\b/i.test(core) ? core.replace(/^set\s*/i, "Set ") : core;
}

// Compute the 5 By-the-Numbers metrics for an origin's matched catalog song from
// the ordered show log. Returns an ordered [{label, value}] array; a metric that
// cannot be computed (e.g. a single-performance song has no drought) is omitted.
function computeOriginNumbers(origin, data) {
  const shows = data.setlistShows || [];
  if (!shows.length) return [];
  const key = normalizeTitle(origin.title);
  const song = (data.catalog || []).find((row) => row.key === key) || null;
  const target = song ? song.key : key;
  if (!target) return [];
  const titleFor = (k, fallback) => {
    const s = (data.catalog || []).find((row) => row.key === k);
    return s ? s.title : fallback;
  };

  const playIdx = [];
  shows.forEach((show, i) => { if (show.songs.some((s) => s.key === target)) playIdx.push(i); });
  if (!playIdx.length) return [];

  const rows = [];
  const totalShows = shows.length;
  const plays = playIdx.length;
  const first = playIdx[0];

  // Frequency: shows-per-play across the window from this song's debut to the
  // latest logged show → "1 in every N.N shows".
  const windowShows = totalShows - first;
  rows.push({ label: "Frequency", value: `1 in every ${(windowShows / plays).toFixed(1)} shows` });

  // Longest drought: most shows elapsed between two consecutive performances.
  if (plays >= 2) {
    let maxGap = 0;
    let gapA = -1;
    let gapB = -1;
    for (let k = 0; k < playIdx.length - 1; k++) {
      const gap = playIdx[k + 1] - playIdx[k];
      if (gap > maxGap) { maxGap = gap; gapA = playIdx[k]; gapB = playIdx[k + 1]; }
    }
    if (maxGap > 1 && gapA >= 0) {
      rows.push({ label: "Longest drought", value: `${maxGap} shows (${shortMdy(shows[gapA].date)} > ${shortMdy(shows[gapB].date)})` });
    }
  }

  // Lead in / lead out: the immediate non-segment neighbour in each show's flat,
  // in-order song list.
  const bump = (map, k, name) => {
    const existing = map.get(k);
    if (existing) existing.count++;
    else map.set(k, { key: k, name, count: 1 });
  };
  const leadIn = new Map();
  const leadOut = new Map();
  for (const i of playIdx) {
    const flat = shows[i].songs.filter((s) => !isSegmentKey(s.key));
    const pos = flat.findIndex((s) => s.key === target);
    if (pos < 0) continue;
    if (pos > 0) bump(leadIn, flat[pos - 1].key, flat[pos - 1].name);
    if (pos < flat.length - 1) bump(leadOut, flat[pos + 1].key, flat[pos + 1].name);
  }
  const topOf = (map) => {
    let best = null;
    for (const v of map.values()) if (!best || v.count > best.count) best = v;
    return best;
  };
  const li = topOf(leadIn);
  if (li) rows.push({ label: "Most common lead in", value: `${titleFor(li.key, li.name)} (${li.count} time${li.count === 1 ? "" : "s"})` });
  const lo = topOf(leadOut);
  if (lo) rows.push({ label: "Most common lead out", value: `${titleFor(lo.key, lo.name)} (${lo.count} time${lo.count === 1 ? "" : "s"})` });

  // Most common set position: the most frequent (canonical set + index-within-set).
  const posCount = new Map();
  for (const i of playIdx) {
    const seq = new Map();
    for (const s of shows[i].songs) {
      const label = canonicalSetLabel(s.set, s.encore);
      const idx = (seq.get(label) || 0) + 1;
      seq.set(label, idx);
      if (s.key === target) {
        const k = `${label}|${idx}`;
        posCount.set(k, (posCount.get(k) || 0) + 1);
      }
    }
  }
  let bestPos = null;
  for (const [k, count] of posCount) if (!bestPos || count > bestPos.count) bestPos = { k, count };
  if (bestPos) {
    const [label, idx] = bestPos.k.split("|");
    rows.push({ label: "Most common set position", value: `${label}, song ${idx} (${bestPos.count} time${bestPos.count === 1 ? "" : "s"})` });
  }

  return rows;
}

// Render the "By the Numbers" data panel: a mono eyebrow, the COMPUTED analytics as
// a definition grid (tabular-nums), his notes verbatim, resource chips (Learn-It
// styling), and the Picks list. panicstream URLs are never emitted; picks link
// straight to Relisten (deterministic per-date URLs for these taped shows).
function renderOriginNumbers(footer, data, computed = []) {
  const stats = computed.length ? computed : footer.analytics;
  if (!footer || (!stats.length && !footer.links.length && !footer.picks.length && !footer.notes)) return "";

  const rows = stats
    .map((a) => `<div class="on-row"><dt>${escapeHtml(a.label)}</dt><dd>${escapeHtml(a.value)}</dd></div>`)
    .join("");
  const grid = rows ? `<dl class="origin-stat-grid">${rows}</dl>` : "";

  const note = footer.notes ? `<p class="origin-numbers-note">${renderLinkedText(footer.notes)}</p>` : "";

  const chips = footer.links
    .map((l) => {
      let host = "";
      try { host = new URL(l.url).hostname.replace(/^www\./i, ""); } catch { host = ""; }
      return `<a class="learn-chip learn-ext" href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.label)} <span class="learn-go" aria-hidden="true">↗</span>${host ? `<small>${escapeHtml(host)}</small>` : ""}</a>`;
    })
    .join("");
  const chipRow = chips ? `<div class="origin-resource-chips song-learn-chips">${chips}</div>` : "";

  let picksBlock = "";
  if (footer.picks.length) {
    const items = footer.picks
      .map((p) => {
        const dateLong = p.iso ? (formatLongDate(p.iso) || p.date) : p.date;
        // Picks link straight to Relisten: the URL is deterministic from the date
        // and these curated shows are essentially all taped, so we don't gate on the
        // (optional) relisten cache the way the per-performance rows do.
        const relistenUrl = p.iso ? relistenUrlFor(p.iso) : "";
        const listen = relistenUrl
          ? `<a class="origin-pick-listen" href="${escapeAttr(relistenUrl)}" target="_blank" rel="noopener noreferrer">Listen ↗</a>`
          : "";
        return `<li class="origin-pick${relistenUrl ? " has-relisten" : ""}"><span class="origin-pick-venue">${escapeHtml(p.venue)}</span><span class="origin-pick-meta"><span class="origin-pick-date">${escapeHtml(dateLong)}</span>${listen}</span></li>`;
      })
      .join("");
    picksBlock = `<div class="origin-picks-block">
            <h3 class="origin-picks-head">Burnthday's Picks</h3>
            <ul class="origin-picks">${items}</ul>
          </div>`;
  }

  return `<section class="origin-numbers" aria-labelledby="origin-numbers-h">
          <div class="origin-numbers-head">
            <h2 class="on-eyebrow" id="origin-numbers-h">BY THE NUMBERS</h2>
            <p class="on-sub">Computed from every logged performance</p>
          </div>
          ${grid}
          ${note}
          ${chipRow}
          ${picksBlock}
        </section>`;
}

function renderSongOriginPage(origin, origins, data, albums = []) {
  // Curated origins carry a structured shape (quotes[]/clusters[]/related[]/faq[]),
  // not the Facebook prose body, so they render through a dedicated path.
  if (origin.curated) return renderCuratedOriginPage(origin, origins, data, albums);
  const description = clean(origin.text).slice(0, 180) || `Burnthday Song Origins: ${origin.title}`;
  const currentIndex = origins.findIndex((item) => item.slug === origin.slug);
  const previous = origins[currentIndex - 1] || null;
  const next = origins[currentIndex + 1] || null;
  const statsFooter = parseOriginStatsFooter(origin.text);
  const originBody = renderOriginText(statsFooter ? statsFooter.strippedText : origin.text);
  // The 5 numeric metrics are computed live from the performance log; everything
  // else in the footer (notes, picks, resource links) stays Alex's verbatim text.
  const computedNumbers = statsFooter ? computeOriginNumbers(origin, data) : [];
  // Surface the songwriter credit + original-source album from his notes UP into
  // the hero (key context: identifies a cover, its writer, its origin album), and
  // strip them from the bottom notes so they are not duplicated.
  const credits = statsFooter ? parseOriginCredits(statsFooter.notes) : { writer: "", appearsOn: "", remaining: "" };
  const panelFooter = statsFooter ? { ...statsFooter, notes: credits.remaining } : null;
  const numbersPanel = panelFooter ? renderOriginNumbers(panelFooter, data, computedNumbers) : "";
  const hasLiteEmbed = originBody.includes('class="yt-lite"');
  const heroCredits = [
    credits.writer ? `<p class="origin-credit">Written by ${escapeHtml(credits.writer)}</p>` : "",
    credits.appearsOn ? `<p class="origin-credit origin-credit-source">Originally on ${escapeHtml(credits.appearsOn)}</p>` : ""
  ].filter(Boolean).join("");

  // ---- Computed data join (nothing here is authored in Alex's voice) ----
  const { song, slug, onAlbums, lyricsHref } = originDataJoin(origin, data, albums);
  const firstLong = song ? (formatLongDate(parseDateKey(song.first) || song.first) || song.first) : "";
  const lastIso = song ? (song.effectiveLastIso || parseDateKey(song.last)) : null;
  const lastLong = song ? (lastIso ? formatLongDate(lastIso) : song.lastDisplay || "") : "";
  const primaryAlbum = onAlbums[0] || null;

  // Stat strip — reuse the .song-stat tile pattern. Each tile is omitted when its
  // datum is missing; the whole strip is omitted when the origin has no catalog song.
  const tile = (value, label, sub = "") => `<div class="song-stat"><strong>${value}</strong><span>${escapeHtml(label)}</span>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</div>`;
  const statTiles = [];
  if (song) {
    if (Number.isFinite(song.total) && song.total > 0) statTiles.push(tile(formatNumber(song.total), "lifetime plays", "live performances"));
    if (firstLong) statTiles.push(`<div class="song-stat"><strong class="song-stat-date">${escapeHtml(firstLong)}</strong><span>first played</span></div>`);
    if (lastLong) statTiles.push(`<div class="song-stat"><strong class="song-stat-date">${escapeHtml(lastLong)}</strong><span>last played</span></div>`);
    if (primaryAlbum) statTiles.push(`<div class="song-stat"><strong class="song-stat-album">${escapeHtml(primaryAlbum.title)}</strong><span>appears on</span>${albumYear(primaryAlbum) ? `<small>${escapeHtml(albumYear(primaryAlbum))}</small>` : ""}</div>`);
  }
  const statStrip = statTiles.length
    ? `<div class="origin-strip" aria-label="Live history for ${escapeAttr(origin.title)}">${statTiles.join("")}</div>`
    : "";

  // Cross-links (article footer) — all computed from the join.
  const links = [];
  if (song && slug) links.push(`<a class="origin-xlink" href="/song/${escapeAttr(slug)}/"><span class="oxl-label">Full live history</span><span class="oxl-go" aria-hidden="true">→</span></a>`);
  if (lyricsHref) links.push(`<a class="origin-xlink" href="${escapeAttr(lyricsHref)}"><span class="oxl-label">Lyrics &amp; chords</span><span class="oxl-go" aria-hidden="true">→</span></a>`);
  if (primaryAlbum) links.push(`<a class="origin-xlink" href="/albums/${escapeAttr(primaryAlbum.slug)}/"><span class="oxl-label">Appears on ${escapeHtml(primaryAlbum.title)}</span><span class="oxl-go" aria-hidden="true">→</span></a>`);
  const crosslinks = links.length
    ? `<nav class="origin-crosslinks" aria-label="Related pages">${links.join("")}</nav>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(origin.title)} Song Origin | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com/song-origins/${escapeAttr(origin.slug)}/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["Song Origins", "https://burnthday.com/song-origins/"],
      [origin.title, `https://burnthday.com/song-origins/${origin.slug}/`]
    ])}</script>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main origins-main">
      <article class="archive-page origin-article">
        <header class="origin-article-head">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><a href="/song-origins/">Song Origins</a></nav>
          <p class="origin-eyebrow">SONG ORIGIN</p>
          <h1>${escapeHtml(origin.title)}</h1>
          ${heroCredits}
        </header>
        ${origin.image ? `<figure class="origin-hero-media"><img src="${escapeAttr(origin.image)}" alt="${escapeAttr(`${origin.title} song origin`)}" decoding="async"></figure>` : ""}
        ${statStrip}
        <div class="origin-body prose-plate">
          ${originBody}
          <p class="origin-source"><a href="${escapeAttr(origin.sourceUrl)}">Original Facebook post</a></p>
        </div>
        ${numbersPanel}
        ${crosslinks}
        <nav class="origin-nav" aria-label="Song origin navigation">
          ${previous ? `<a class="origin-nav-prev" href="/song-origins/${escapeAttr(previous.slug)}/"><span class="onav-dir">← Previous origin</span><span class="onav-title">${escapeHtml(previous.title)}</span></a>` : "<span></span>"}
          ${next ? `<a class="origin-nav-next" href="/song-origins/${escapeAttr(next.slug)}/"><span class="onav-dir">Next origin →</span><span class="onav-title">${escapeHtml(next.title)}</span></a>` : "<span></span>"}
        </nav>
      </article>
    </main>
    ${renderSiteFooter({ generatedAt: new Date().toISOString(), source: { label: "Song Origins archive" } }, { stagelight: true })}
    ${hasLiteEmbed ? LITE_EMBED_SCRIPT : ""}
  </body>
</html>
`;
}

// Curated Song Origin page. Renders the structured, sourced supplement (interviews
// + newsletters) rather than a Facebook prose post: an attributed-quotes body, the
// live catalog stat strip, and the enrichment mesh (clusters / related origins /
// FAQ) with MusicComposition + FAQPage JSON-LD. Data + schema handoff from branch
// claude/affectionate-blackwell-b25e75 (data/source/SONG-ORIGINS-SPEC.md).
function renderCuratedOriginPage(origin, origins, data, albums = []) {
  const description = clean(origin.summary).slice(0, 180) || `Burnthday Song Origins: ${origin.title}`;
  // "fact" and "trivia" entries are short sourced notes, not full stories: tighten
  // the layout so a sparse entry does not read as a padded-out saga. "story" pages
  // are unchanged.
  const compact = origin.kind === "fact" || origin.kind === "trivia";
  const currentIndex = origins.findIndex((item) => item.slug === origin.slug);
  const previous = origins[currentIndex - 1] || null;
  const next = origins[currentIndex + 1] || null;

  // Hero credits: identify a cover + its writer/original artist up front.
  const heroCredits = [
    origin.isCover && origin.originalArtist ? `<p class="origin-credit">Cover of a ${escapeHtml(origin.originalArtist)} song</p>` : "",
    origin.composer && origin.composer !== origin.performedBy ? `<p class="origin-credit origin-credit-source">Written by ${escapeHtml(origin.composer)}</p>` : ""
  ].filter(Boolean).join("");

  // Live catalog join — identical to the Facebook path: the stat strip is computed
  // from the catalog, nothing here is authored.
  const { song, slug, onAlbums, lyricsHref } = originDataJoin(origin, data, albums);
  const firstLong = song ? (formatLongDate(parseDateKey(song.first) || song.first) || song.first) : "";
  const lastIso = song ? (song.effectiveLastIso || parseDateKey(song.last)) : null;
  const lastLong = song ? (lastIso ? formatLongDate(lastIso) : song.lastDisplay || "") : "";
  const primaryAlbum = onAlbums[0] || null;
  const statTiles = [];
  if (song) {
    if (Number.isFinite(song.total) && song.total > 0) statTiles.push(`<div class="song-stat"><strong>${formatNumber(song.total)}</strong><span>lifetime plays</span><small>live performances</small></div>`);
    if (firstLong) statTiles.push(`<div class="song-stat"><strong class="song-stat-date">${escapeHtml(firstLong)}</strong><span>first played</span></div>`);
    if (lastLong) statTiles.push(`<div class="song-stat"><strong class="song-stat-date">${escapeHtml(lastLong)}</strong><span>last played</span></div>`);
    if (primaryAlbum) statTiles.push(`<div class="song-stat"><strong class="song-stat-album">${escapeHtml(primaryAlbum.title)}</strong><span>appears on</span>${albumYear(primaryAlbum) ? `<small>${escapeHtml(albumYear(primaryAlbum))}</small>` : ""}</div>`);
  } else if (Number.isFinite(origin.timesPlayed) && origin.timesPlayed > 0) {
    // Fall back to the curated play count when the title has no live-catalog join.
    statTiles.push(`<div class="song-stat"><strong>${formatNumber(origin.timesPlayed)}</strong><span>times played</span><small>per Everyday Companion</small></div>`);
    if (origin.firstPlayedDisplay) statTiles.push(`<div class="song-stat"><strong class="song-stat-date">${escapeHtml(origin.firstPlayedDisplay)}</strong><span>first played</span></div>`);
    if (origin.albums?.[0]) statTiles.push(`<div class="song-stat"><strong class="song-stat-album">${escapeHtml(origin.albums[0].name)}</strong><span>appears on</span>${origin.albums[0].year ? `<small>${escapeHtml(String(origin.albums[0].year))}</small>` : ""}</div>`);
  }
  const statStrip = statTiles.length
    ? `<div class="origin-strip" aria-label="Live history for ${escapeAttr(origin.title)}">${statTiles.join("")}</div>`
    : "";

  // Body: plain-language summary lede, then verbatim attributed quotes, then notes.
  // Burnthday is the compiler here; the sources speak in their own words.
  const linkUrl = (url) => (url && !isBlockedExternalUrl(url) ? url : "");
  const quotesHtml = (origin.quotes || []).map((quote) => {
    const attribParts = [quote.speaker, quote.speakerRole].filter(Boolean).map(escapeHtml).join(", ");
    const url = linkUrl(quote.url);
    const src = quote.source
      ? (url
        ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(quote.source)}</a>`
        : escapeHtml(quote.source))
      : "";
    const cite = [attribParts, src].filter(Boolean).join(" &middot; ");
    return `<blockquote class="origin-quote"><p>${escapeHtml(quote.text)}</p>${cite ? `<cite>${cite}</cite>` : ""}</blockquote>`;
  }).join("");
  const bodyBlocks = [
    origin.summary ? `<p class="origin-summary">${escapeHtml(origin.summary)}</p>` : "",
    quotesHtml,
    origin.notes ? `<p class="origin-note">${escapeHtml(origin.notes)}</p>` : ""
  ].filter(Boolean).join("\n          ");

  // Sources block replaces the Facebook "Original post" link.
  const sourcesHtml = (origin.sources || []).length
    ? `<div class="origin-sources"><span class="origin-sources-label">Sources</span><ul>${(origin.sources || []).map((s) => {
        const url = linkUrl(s.url);
        const label = [s.label, s.publisher].filter(Boolean).map(escapeHtml).join(" &middot; ");
        return `<li>${url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label}</li>`;
      }).join("")}</ul></div>`
    : "";

  // Relix credit: entries sourced to the Relix Oct/Nov 2003 issue carry the same
  // one-line acknowledgment (Ethan Ice provided the scans) at the bottom.
  const relixCredit = renderRelixCredit(origin, data);

  // Enrichment mesh: filed-under cluster chips, related origins, FAQ. Cluster pages
  // are not yet built, so chips are non-linked labels (no dead links); related
  // targets all resolve to real curated origin pages.
  const clustersHtml = (origin.clusters || []).length
    ? `<nav class="origin-clusters" aria-label="Filed under"><span class="origin-clusters-label">Filed under</span>${(origin.clusters || []).map((c) => `<span class="origin-cluster-chip" data-cluster-type="${escapeAttr(c.type)}">${escapeHtml(c.label)}</span>`).join("")}</nav>`
    : "";
  const relatedHtml = (origin.related || []).length
    ? `<section class="origin-related" aria-label="Related origins"><h2>Related origins</h2><ul class="origin-related-list">${(origin.related || []).map((r) => `<li><a href="/song-origins/${escapeAttr(r.slug)}/"><span class="orl-title">${escapeHtml(r.title)}</span>${r.why ? `<span class="orl-why">${escapeHtml(r.why)}</span>` : ""}<span class="orl-go" aria-hidden="true">&rarr;</span></a></li>`).join("")}</ul></section>`
    : "";
  const faqHtml = (origin.faq || []).length
    ? `<section class="origin-faq" aria-label="Frequently asked questions"><h2>Frequently asked</h2><dl>${(origin.faq || []).map((f) => `<div class="origin-faq-item"><dt>${escapeHtml(f.q)}</dt><dd>${escapeHtml(f.a)}</dd></div>`).join("")}</dl></section>`
    : "";

  // Cross-links (article footer) — computed from the join, same controls as the
  // Facebook path.
  const links = [];
  if (song && slug) links.push(`<a class="origin-xlink" href="/song/${escapeAttr(slug)}/"><span class="oxl-label">Full live history</span><span class="oxl-go" aria-hidden="true">&rarr;</span></a>`);
  if (lyricsHref) links.push(`<a class="origin-xlink" href="${escapeAttr(lyricsHref)}"><span class="oxl-label">Lyrics &amp; chords</span><span class="oxl-go" aria-hidden="true">&rarr;</span></a>`);
  if (primaryAlbum) links.push(`<a class="origin-xlink" href="/albums/${escapeAttr(primaryAlbum.slug)}/"><span class="oxl-label">Appears on ${escapeHtml(primaryAlbum.title)}</span><span class="oxl-go" aria-hidden="true">&rarr;</span></a>`);
  const crosslinks = links.length
    ? `<nav class="origin-crosslinks" aria-label="Related pages">${links.join("")}</nav>`
    : "";

  const heroMedia = origin.albumArt
    ? `<figure class="origin-hero-media origin-hero-art"><img src="${escapeAttr(origin.albumArt)}" alt="${escapeAttr(origin.summary || `${origin.title} album art`)}" decoding="async"></figure>`
    : "";

  const jsonLdBlocks = [
    renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["Song Origins", "https://burnthday.com/song-origins/"],
      [origin.title, `https://burnthday.com/song-origins/${origin.slug}/`]
    ]),
    renderMusicCompositionJsonLd(origin),
    renderOriginFaqJsonLd(origin)
  ].filter(Boolean).map((block) => `<script type="application/ld+json">${block}</script>`).join("\n    ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(origin.title)} Song Origin | Burnthday</title>
    <meta name="description" content="${escapeAttr(description)}">
    <link rel="canonical" href="https://burnthday.com/song-origins/${escapeAttr(origin.slug)}/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    ${compact ? `<style>${renderCompactOriginCss()}</style>` : ""}
    ${jsonLdBlocks}
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main origins-main">
      <article class="archive-page origin-article${compact ? " origin-article-compact" : ""}">
        <header class="origin-article-head">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">&rsaquo;</span><a href="/song-origins/">Song Origins</a></nav>
          <p class="origin-eyebrow">SONG ORIGIN</p>
          <h1>${escapeHtml(origin.title)}</h1>
          ${heroCredits}
        </header>
        ${heroMedia}
        ${statStrip}
        <div class="origin-body prose-plate">
          ${bodyBlocks}
          ${sourcesHtml}
          ${relixCredit}
        </div>
        ${clustersHtml}
        ${relatedHtml}
        ${faqHtml}
        ${crosslinks}
        <nav class="origin-nav" aria-label="Song origin navigation">
          ${previous ? `<a class="origin-nav-prev" href="/song-origins/${escapeAttr(previous.slug)}/"><span class="onav-dir">&larr; Previous origin</span><span class="onav-title">${escapeHtml(previous.title)}</span></a>` : "<span></span>"}
          ${next ? `<a class="origin-nav-next" href="/song-origins/${escapeAttr(next.slug)}/"><span class="onav-dir">Next origin &rarr;</span><span class="onav-title">${escapeHtml(next.title)}</span></a>` : "<span></span>"}
        </nav>
      </article>
    </main>
    ${renderSiteFooter({ generatedAt: new Date().toISOString(), source: { label: "Song Origins archive" } }, { stagelight: true })}
  </body>
</html>
`;
}

// Scoped tightening for compact (fact/trivia) curated origin pages: a narrower
// measure and less vertical padding so a short sourced note does not read as a
// padded saga. The base .origin-article / .prose-plate rules stay in stagelight.css.
function renderCompactOriginCss() {
  return `
      .origin-article-compact { max-width: 720px; }
      .origin-article-compact .origin-body.prose-plate { min-height: 0; padding-top: 1.1rem; padding-bottom: 1.1rem; }
      .origin-article-compact .origin-summary { font-size: 1.02rem; line-height: 1.6; margin-bottom: 1rem; }
      .origin-article-compact .origin-note { margin-top: 1rem; }
  `;
}

// Relix acknowledgment: any curated origin whose sources cite Relix carries the
// same one-line credit (Ethan Ice provided the Oct/Nov 2003 scans). Rendered from
// the acknowledgments data; no link is invented.
function renderRelixCredit(origin, data) {
  const citesRelix = (origin.sources || []).some((s) => /Relix/i.test(`${s.label || ""} ${s.publisher || ""}`));
  if (!citesRelix) return "";
  const acks = (data && data.originAcknowledgments) || [];
  const ack = acks.find((a) => /Relix/i.test(a.for || "")) || acks[0];
  const name = ack ? ack.name : "Ethan Ice";
  return `<p class="origin-relix-credit">Special thanks to ${escapeHtml(name)} for providing the Relix (Oct/Nov 2003) scans that sourced this entry.</p>`;
}

// MusicComposition JSON-LD for a curated origin (composer / byArtist for covers,
// sameAs authority links). See SONG-ORIGINS-SPEC.md.
function renderMusicCompositionJsonLd(origin) {
  const node = {
    "@context": "https://schema.org",
    "@type": "MusicComposition",
    name: origin.title
  };
  if (origin.composer) node.composer = { "@type": "Person", name: origin.composer };
  if (origin.isCover && origin.originalArtist) node.firstPerformer = { "@type": "MusicGroup", name: origin.originalArtist };
  const album = origin.albums?.[0];
  if (album?.name) node.recordedAs = { "@type": "MusicRecording", name: origin.title, inAlbum: { "@type": "MusicAlbum", name: album.name } };
  const sameAs = (origin.sameAs || []).filter((url) => url && !isBlockedExternalUrl(url));
  if (sameAs.length) node.sameAs = sameAs;
  return JSON.stringify(node).replace(/</g, "\\u003c");
}

// FAQPage JSON-LD straight from the curated faq[] (verbatim Q&A). See spec.
function renderOriginFaqJsonLd(origin) {
  const faqs = (origin.faq || []).filter((f) => f.q && f.a);
  if (!faqs.length) return "";
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a }
    }))
  }).replace(/</g, "\\u003c");
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
    const ytId = extractYouTubeId(url);
    if (ytId) {
      // Hand-placed YouTube link in an origin post → click-to-play lite embed.
      pieces.push(renderLiteEmbed(ytId, { fallbackUrl: url }));
      pieces.push(escapeHtml(trailing));
    } else {
      pieces.push(`<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>${escapeHtml(trailing)}`);
    }
    cursor = start + rawUrl.length;
  }
  pieces.push(escapeHtml(safeText.slice(cursor)));
  return pieces.join("");
}

// ---- Shared "lite" YouTube embed (Feature 1 origins + Feature 2 song WATCH) ----
// A privacy-lean, click-to-play facade: a static thumbnail + play button that
// only swaps in the real (no-cookie) iframe on interaction. One tiny delegated
// script (LITE_EMBED_SCRIPT) drives every facade on a page; the original link is
// preserved inside <noscript> so it degrades cleanly. Marker class: yt-lite.

// Pull the 11-char video id out of a watch / youtu.be / embed URL. Tolerates the
// player_embedded feature param and #! fragments the Blogger export left behind.
function extractYouTubeId(rawUrl) {
  try {
    const u = new URL(String(rawUrl).replace(/^http:/i, "https:"));
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const valid = (id) => (/^[A-Za-z0-9_-]{11}$/.test(id) ? id : "");
    if (host === "youtu.be") return valid(u.pathname.split("/").filter(Boolean)[0] || "");
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      if (u.pathname === "/watch") return valid(u.searchParams.get("v") || "");
      const m = u.pathname.match(/^\/(?:embed|v|shorts)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch {
    // Not a parseable URL → not a YouTube link.
  }
  return "";
}

function renderLiteEmbed(id, options = {}) {
  const title = options.title || "video";
  const thumb = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
  const embed = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
  const fallback = options.fallbackUrl || `https://www.youtube.com/watch?v=${id}`;
  const label = `Play video: ${title}`;
  return `<span class="yt-lite" data-yt-src="${escapeAttr(embed)}">` +
    `<button type="button" class="yt-lite-btn" aria-label="${escapeAttr(label)}">` +
    `<img class="yt-lite-thumb" src="${escapeAttr(thumb)}" alt="" loading="lazy" decoding="async" width="480" height="360">` +
    `<span class="yt-lite-play" aria-hidden="true"><svg viewBox="0 0 68 48" width="52" height="37"><path class="yt-lite-play-bg" d="M66.5 7.5a8 8 0 0 0-5.6-5.7C56 .5 34 .5 34 .5s-22 0-26.9 1.3A8 8 0 0 0 1.5 7.5 83 83 0 0 0 .2 24a83 83 0 0 0 1.3 16.5 8 8 0 0 0 5.6 5.7C12 47.5 34 47.5 34 47.5s22 0 26.9-1.3a8 8 0 0 0 5.6-5.7A83 83 0 0 0 67.8 24a83 83 0 0 0-1.3-16.5Z"/><path d="M27 34l18-10-18-10z" fill="#fff"/></svg></span>` +
    `</button>` +
    `<noscript><a href="${escapeAttr(fallback)}" target="_blank" rel="noopener noreferrer">Watch on YouTube ↗</a></noscript>` +
    `</span>`;
}

// One shared, delegated handler. Native button semantics give us keyboard
// activation (Enter/Space fire a click) for free.
const LITE_EMBED_SCRIPT = `<script>document.addEventListener("click",function(e){var b=e.target.closest(".yt-lite-btn");if(!b)return;var w=b.parentNode,src=w.getAttribute("data-yt-src");if(!src)return;var f=document.createElement("iframe");f.className="yt-lite-frame";f.setAttribute("src",src);f.setAttribute("title",b.getAttribute("aria-label")||"YouTube video");f.setAttribute("frameborder","0");f.setAttribute("allow","accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");f.setAttribute("allowfullscreen","");w.classList.add("is-playing");w.innerHTML="";w.appendChild(f);f.focus();});</script>`;

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

// ---- SONG INDEX + per-song history pages ----
// Load the setlist.fm ingestion cache (see data/source/SETLISTFM-SYNC.md) and
// index every performance by canonical song key. Dormant until a real cache
// exists — the live pull runs in the nightly Action, not here.
async function loadSetlistFmCache() {
  const cachePath = process.env.SETLISTFM_CACHE || path.join(root, "data", "source", "setlistfm-cache.json");
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8"));
    return Array.isArray(parsed.shows) ? parsed : null;
  } catch {
    return null;
  }
}

async function attachSetlistFmPerformances(data) {
  const cache = await loadSetlistFmCache();
  data.setlistFm = cache ? { fetchedAt: cache.fetchedAt, showCount: cache.showCount } : null;
  const byTitle = new Map();
  if (!cache) {
    data.performancesByTitle = byTitle;
    return;
  }
  for (const show of cache.shows || []) {
    if (!show?.date) continue;
    for (const song of show.songs || []) {
      const key = normalizeTitle(song.name);
      if (!key) continue;
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push({
        date: show.date,
        venue: show.venue,
        city: show.city,
        state: show.state,
        url: show.url,
        tour: show.tour,
        guest: song.guest || "",
        encore: Boolean(song.encore),
        tape: Boolean(song.tape)
      });
    }
  }
  for (const list of byTitle.values()) list.sort((a, b) => b.date.localeCompare(a.date));
  data.performancesByTitle = byTitle;
  // Sorted unique show-date spine (oldest first) so we can count how many shows
  // fell between a song's two most recent performances = its last-time-played gap.
  data.allShowDates = [...new Set((cache.shows || []).map((show) => show.date).filter(Boolean))].sort();

  // Ordered show log (oldest-first) with each show's flat, in-order song list. This
  // is what the origin "By the Numbers" panel computes over: frequency, drought,
  // lead-in/out adjacency and set position all need whole-show ordering, which the
  // per-title index above deliberately flattens away. Only shows that actually have
  // a setlist are kept (future/empty shows contribute no data).
  const orderedShows = (cache.shows || [])
    .filter((show) => show?.date && Array.isArray(show.songs) && show.songs.length)
    .map((show) => ({
      date: show.date,
      venue: show.venue,
      songs: show.songs.map((song) => ({
        key: normalizeTitle(song.name),
        name: song.name,
        set: song.set || "",
        encore: Boolean(song.encore)
      }))
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  data.setlistShows = orderedShows;
}

// ── THE PREDICTION LAYER ─────────────────────────────────────────────────────
// Two build-time passes over the ordered show log (data.setlistShows):
//   1. The Almanac stat engine — tests each pre-registered lore claim against the
//      whole cache: plays on the target day/date, ratio vs the band's baseline
//      share, and an exact binomial upper-tail p-value. Tiers are COMPUTED from
//      the claim category + significance, never hand-assigned.
//   2. Segue-pair mining — every ordered adjacent pair, with confidence + lift.
// "Jam" and "Drums and Bass" are segment pseudo-songs, excluded from ALL of this
// math; "Drums" alone is a real song and is kept.
function isPseudoSong(key) {
  return key === "jam" || key === "drumsandbass" || key === "drumsbass";
}

const ALMANAC_DOW_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

// Lazily-built log-factorial table for the exact binomial tail. Sized to the
// largest n we could ever pass (a song's lifetime play count ≤ total shows).
let _logFactCache = null;
function logFactorials(upTo) {
  if (_logFactCache && _logFactCache.length > upTo) return _logFactCache;
  const n = Math.max(upTo + 1, 4096);
  const lf = new Float64Array(n);
  for (let i = 2; i < n; i++) lf[i] = lf[i - 1] + Math.log(i);
  _logFactCache = lf;
  return lf;
}

// P(X >= k) for X ~ Binomial(n, p): the chance of seeing at least this many
// hits by luck alone. Summed in log-space via log-factorials for stability.
function binomialUpperTail(k, n, p) {
  if (n <= 0 || k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (k > n) return 0;
  const lf = logFactorials(n);
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  let sum = 0;
  for (let i = k; i <= n; i++) {
    sum += Math.exp(lf[n] - lf[i] - lf[n - i] + i * lp + (n - i) * lq);
  }
  return Math.min(1, Math.max(0, sum));
}

// One pass over the ordered show log → the distributions every Almanac stat reads:
// band totals by weekday + by MM-DD, and per-song the same (deduped within a show,
// so a "play" here means "a show that featured the song").
function buildDayDistributions(shows) {
  const bandDow = new Array(7).fill(0);
  const bandMd = new Map();
  const songDow = new Map();
  const songMd = new Map();
  const songTotal = new Map();
  let totalShows = 0;
  for (const show of shows) {
    const dow = isoDayOfWeek(show.date);
    if (dow < 0) continue;
    const md = String(show.date).slice(5);
    totalShows += 1;
    bandDow[dow] += 1;
    bandMd.set(md, (bandMd.get(md) || 0) + 1);
    const seen = new Set();
    for (const song of show.songs || []) {
      const key = song.key;
      if (!key || isPseudoSong(key) || seen.has(key)) continue;
      seen.add(key);
      if (!songDow.has(key)) { songDow.set(key, new Array(7).fill(0)); songMd.set(key, new Map()); songTotal.set(key, 0); }
      songDow.get(key)[dow] += 1;
      songTotal.set(key, songTotal.get(key) + 1);
      const m = songMd.get(key);
      m.set(md, (m.get(md) || 0) + 1);
    }
  }
  return { bandDow, bandMd, songDow, songMd, songTotal, totalShows };
}

// Tier from the claim category + significance. The gates reproduce the owner-
// approved hierarchy: a lyric that PREDICTED the day is a strong claim (Confirmed
// at p<1e-3); Burnthday's word alone tops out at Vouched; a data-only pattern is
// forever a Curiosity no matter how significant; and an endorsed claim with too
// few target-date shows to resolve is honestly held at Watching.
const ALMANAC_MIN_TARGET_SHOWS = 15;
function assignAlmanacTier(claim, p, targetShows) {
  if (claim === "dredged") return "curiosity";
  const significant = Number.isFinite(p) && p < 0.05;
  if (targetShows < ALMANAC_MIN_TARGET_SHOWS && !significant) return "watching";
  if (claim === "lyric" || claim === "behavioral") {
    if (Number.isFinite(p) && p < 1e-3) return "confirmed";
    if (significant) return "vouched";
    return "watching";
  }
  // claim === "owner": endorsed but not lyric-predicted → capped at Vouched.
  if (significant) return "vouched";
  return "watching";
}

const ALMANAC_TIER_LABEL = { confirmed: "Confirmed", vouched: "Vouched", watching: "Watching", curiosity: "Curiosity" };

async function loadAlmanac() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "almanac.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

// Compute one song's day/date stat block from the distributions.
function almanacSongStat({ key, dow, md, dist }) {
  const tot = dist.songTotal.get(key) || 0;
  if (dow != null) {
    const obs = (dist.songDow.get(key) || [])[dow] || 0;
    const base = dist.totalShows ? dist.bandDow[dow] / dist.totalShows : 0;
    const share = tot ? obs / tot : 0;
    const ratio = base ? share / base : 0;
    const expected = tot * base;
    const p = binomialUpperTail(obs, tot, base);
    return { obs, tot, base, share, ratio, expected, p, targetShows: dist.bandDow[dow] || 0 };
  }
  const obs = (dist.songMd.get(key) || new Map()).get(md) || 0;
  const dateShows = dist.bandMd.get(md) || 0;
  const base = dist.totalShows ? dateShows / dist.totalShows : 0;
  const share = tot ? obs / tot : 0;
  const ratio = base ? share / base : 0;
  const expected = tot * base;
  const p = binomialUpperTail(obs, tot, base);
  return { obs, tot, base, share, ratio, expected, p, targetShows: dateShows, dateShows };
}

const WEEKDAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

function attachAlmanac(data, almanac) {
  data.almanac = null;
  if (!almanac || !Array.isArray(almanac.entries)) return;
  const shows = data.setlistShows || [];
  if (shows.length < 100) return; // dormant until a real cache exists
  const dist = buildDayDistributions(shows);
  const slugMap = data.songSlugMap || new Map();
  const catalogByKey = new Map((data.catalog || []).map((row) => [row.key || normalizeTitle(row.title), row]));

  const entries = almanac.entries.map((raw) => {
    const dow = raw.day ? ALMANAC_DOW_INDEX[String(raw.day).toLowerCase()] : null;
    const md = raw.date || null;
    const entry = {
      id: raw.id,
      kind: raw.kind,
      claim: raw.claim,
      day: raw.day || "",
      dayPlural: dow != null ? WEEKDAY_PLURAL[dow] : "",
      date: md || "",
      occasion: raw.occasion || "",
      lyric: raw.lyric || "",
      play: raw.play || "",
      note: raw.note || ""
    };
    if (Array.isArray(raw.songs)) {
      // Multi-song curiosity (e.g. "Loose Monday"): one stat per song.
      entry.title = raw.title || "";
      entry.songs = raw.songs.map((title) => {
        const key = normalizeTitle(title);
        const stat = almanacSongStat({ key, dow, md, dist });
        return { title, key, slug: slugMap.get(key) || "", stat };
      }).sort((a, b) => b.stat.ratio - a.stat.ratio);
      entry.tier = "curiosity";
      entry.tierLabel = ALMANAC_TIER_LABEL.curiosity;
      return entry;
    }
    const key = normalizeTitle(raw.song || "");
    const stat = almanacSongStat({ key, dow, md, dist });
    entry.song = raw.song;
    entry.key = key;
    entry.slug = slugMap.get(key) || "";
    entry.songType = catalogByKey.get(key)?.type || "";
    entry.stat = stat;
    entry.tier = assignAlmanacTier(raw.claim, stat.p, stat.targetShows);
    entry.tierLabel = ALMANAC_TIER_LABEL[entry.tier] || "";
    entry.behavioral = raw.claim === "behavioral";
    entry.hasLyric = Boolean(raw.lyric);
    return entry;
  });

  // Lookup used by Tonight's Odds: Confirmed/Vouched single-song entries that
  // carry a lyric, keyed by song → {day/date, lyric, ratioPct}. Only these
  // "strong claim" rows earn the right to replace the bare % with their lyric.
  const oddsReasons = new Map();
  for (const e of entries) {
    if (e.songs) continue;
    if (!(e.tier === "confirmed" || e.tier === "vouched")) continue;
    if (!e.hasLyric) continue;
    oddsReasons.set(e.key, {
      dow: e.day ? ALMANAC_DOW_INDEX[e.day.toLowerCase()] : null,
      md: e.date || null,
      lyric: e.lyric,
      ratioPct: Math.round((e.stat.ratio - 1) * 100),
      day: e.day,
      occasion: e.occasion
    });
  }

  data.almanac = {
    entries,
    oddsReasons,
    weekly: entries.filter((e) => e.kind === "weekly"),
    holiday: entries.filter((e) => e.kind === "holiday"),
    curiosities: entries.filter((e) => e.kind === "curiosity"),
    totalShows: dist.totalShows
  };
}

// ── SEGUE-PAIR MINING ────────────────────────────────────────────────────────
// Over the flat, in-order song list of every show: count directional adjacency,
// per-song show counts, and shows-together. LIFETIME pairs survive adjacency≥15,
// lift≥2.0 and a max-direction confidence ≥40%. TOUR-ACTIVE pairs are any two
// songs that segued (were adjacent) at least once in the CURRENT tour's posted
// setlists, regardless of lifetime strength.
const PAIR_MIN_ADJ = 15;
const PAIR_MIN_LIFT = 2.0;
const PAIR_MIN_CONF = 0.40;

function attachSeguePairs(data) {
  data.lifetimePairs = new Map();
  data.recentPairs = new Map();
  const shows = data.setlistShows || [];
  if (shows.length < 100) return;

  const dirAdj = new Map(); // "a>b" → times a immediately preceded b
  const together = new Map(); // "a|b" (sorted) → shows featuring both
  const showCount = new Map(); // song → shows featuring it
  const N = shows.length;
  const pk = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const show of shows) {
    const flat = (show.songs || []).map((s) => s.key).filter((k) => k && !isPseudoSong(k));
    for (let i = 0; i < flat.length - 1; i++) {
      const a = flat[i], b = flat[i + 1];
      if (a === b) continue;
      const dk = `${a}>${b}`;
      dirAdj.set(dk, (dirAdj.get(dk) || 0) + 1);
    }
    const uniq = [...new Set(flat)];
    for (const k of uniq) showCount.set(k, (showCount.get(k) || 0) + 1);
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const key = pk(uniq[i], uniq[j]);
        together.set(key, (together.get(key) || 0) + 1);
      }
    }
  }
  const adjTotal = (a, b) => (dirAdj.get(`${a}>${b}`) || 0) + (dirAdj.get(`${b}>${a}`) || 0);

  // Build the lifetime partner map (song → sorted partners), symmetric.
  const partners = new Map();
  const addPartner = (from, to, rec) => {
    if (!partners.has(from)) partners.set(from, []);
    partners.get(from).push({ key: to, ...rec });
  };
  const slugMap = data.songSlugMap || new Map();
  const titleByKey = new Map((data.catalog || []).map((row) => [row.key || normalizeTitle(row.title), row.title]));
  let lifetimeCount = 0;
  for (const [key, tog] of together) {
    const [a, b] = key.split("|");
    const adj = adjTotal(a, b);
    if (adj < PAIR_MIN_ADJ) continue;
    const cA = showCount.get(a) || 0, cB = showCount.get(b) || 0;
    if (!cA || !cB) continue;
    const lift = (tog * N) / (cA * cB);
    if (lift < PAIR_MIN_LIFT) continue;
    const confAtoB = tog / cA; // P(B in show | A in show)
    const confBtoA = tog / cB; // P(A in show | B in show)
    if (Math.max(confAtoB, confBtoA) < PAIR_MIN_CONF) continue;
    lifetimeCount += 1;
    const aLeads = (dirAdj.get(`${a}>${b}`) || 0) >= (dirAdj.get(`${b}>${a}`) || 0);
    // From A's page: partner B, confidence = P(B|A), arrow points to whoever leads.
    addPartner(a, b, { title: titleByKey.get(b) || b, slug: slugMap.get(b) || "", confidence: confAtoB, adj, together: tog, lift, leadsInto: aLeads });
    addPartner(b, a, { title: titleByKey.get(a) || a, slug: slugMap.get(a) || "", confidence: confBtoA, adj, together: tog, lift, leadsInto: !aLeads });
  }
  for (const list of partners.values()) list.sort((x, y) => y.confidence - x.confidence || y.adj - x.adj);
  data.lifetimePairs = partners;
  data.lifetimePairCount = lifetimeCount;

  // RECENT-WINDOW pairs: directional adjacency over the last 100 shows, counting
  // only transitions WITHIN a set (same canonical set label) and excluding the
  // Jam / Drums and Bass / Drums segment markers entirely. A directional pair
  // survives at count ≥ 3; its confidence is count ÷ the SOURCE song's plays in
  // the window — i.e. how often, when the source plays, the partner follows.
  // This supersedes the old current-tour-only set (a superset) and drives both
  // the odds propagation and the song page's recency view of "Travels With".
  const RECENT_WINDOW_SIZE = 100;
  const RECENT_MIN_COUNT = 3;
  const isRecentReal = (k) => k && !isPseudoSong(k) && k !== "drums";
  const window = shows.slice(-RECENT_WINDOW_SIZE);
  const recentDir = new Map(); // "a>b" → count (same-set adjacency)
  const recentPlays = new Map(); // song → shows in window that featured it
  for (const show of window) {
    const items = (show.songs || [])
      .filter((s) => isRecentReal(s.key))
      .map((s) => ({ key: s.key, set: canonicalSetLabel(s.set, s.encore) }));
    const seen = new Set();
    for (const it of items) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      recentPlays.set(it.key, (recentPlays.get(it.key) || 0) + 1);
    }
    for (let i = 0; i < items.length - 1; i++) {
      const a = items[i], b = items[i + 1];
      if (a.key === b.key || a.set !== b.set) continue;
      const dk = `${a.key}>${b.key}`;
      recentDir.set(dk, (recentDir.get(dk) || 0) + 1);
    }
  }
  // Build per-song recent partner lists. A song sees a partner it LEADS INTO
  // (arrow →, confidence = P(partner follows this song)) and a partner that
  // LEADS INTO it (arrow ←, confidence = P(this song follows the partner)).
  const recentPartners = new Map();
  const recentList = [];
  const pushRecent = (from, partnerKey, count, sourcePlays, leadsInto) => {
    if (!recentPartners.has(from)) recentPartners.set(from, []);
    const list = recentPartners.get(from);
    const confidence = sourcePlays ? count / sourcePlays : 0;
    const existing = list.find((p) => p.key === partnerKey);
    if (existing) { if (confidence > existing.confidence) Object.assign(existing, { count, confidence, leadsInto }); return; }
    list.push({ key: partnerKey, title: titleByKey.get(partnerKey) || partnerKey, slug: slugMap.get(partnerKey) || "", count, confidence, leadsInto });
  };
  let recentPairCount = 0;
  for (const [dk, count] of recentDir) {
    if (count < RECENT_MIN_COUNT) continue;
    const [a, b] = dk.split(">");
    const playsA = recentPlays.get(a) || 0;
    recentPairCount += 1;
    pushRecent(a, b, count, playsA, true);   // a leads into b (from a's page)
    pushRecent(b, a, count, playsA, false);  // a leads into b (from b's page: ← a)
    recentList.push({ a, b, count, confidence: playsA ? count / playsA : 0 });
  }
  for (const list of recentPartners.values()) list.sort((x, y) => y.confidence - x.confidence || y.count - x.count);
  data.recentPairs = recentPartners;
  data.recentPairCount = recentPairCount;
  data.recentWindow = window.length ? { from: window[0].date, to: window[window.length - 1].date, shows: window.length } : null;
}

// ── TONIGHT'S ODDS ───────────────────────────────────────────────────────────
// Entertainment, not prophecy. When there is a show TODAY (the board show is
// still unposted), rank the songs most likely to appear. Score per song:
//   tourFrequency  = plays this tour / shows played
//   dueFactor      = boost when a tour regular has been absent from the last 4
//                    shows; suppress a song played in the last show or two
//   dayOfWeekAffinity = the song's historical share of plays on today's weekday
//                    vs the band's overall share of shows on that weekday
//                    (setlist.fm cache; ratio>1 = affinity; neutral 1.0 under a
//                    30-play sample). Product is normalized to a 0-100 "heat".
function isoDayOfWeek(iso) {
  if (!iso) return -1;
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? -1 : d.getUTCDay();
}

function attachTonightOdds(data) {
  const board = data.site?.boardShow;
  if (!data.site?.isShowDayPreview || !board?.isoDate) { data.tonightOdds = null; return; }
  const shows = data.setlistShows || [];
  if (shows.length < 100) { data.tonightOdds = null; return; }

  const todayDow = isoDayOfWeek(board.isoDate);
  if (todayDow < 0) { data.tonightOdds = null; return; }

  // One pass: band weekday distribution + per-song weekday distribution.
  const bandDow = new Array(7).fill(0);
  const songDow = new Map(); // key -> { dow:[7], total }
  for (const show of shows) {
    const dow = isoDayOfWeek(show.date);
    if (dow < 0) continue;
    bandDow[dow] += 1;
    const seen = new Set();
    for (const song of show.songs || []) {
      if (!song.key || seen.has(song.key)) continue;
      seen.add(song.key);
      let rec = songDow.get(song.key);
      if (!rec) { rec = { dow: new Array(7).fill(0), total: 0 }; songDow.set(song.key, rec); }
      rec.dow[dow] += 1;
      rec.total += 1;
    }
  }
  const totalShows = shows.length;
  const bandShareToday = totalShows ? bandDow[todayDow] / totalShows : 0;

  // Songs in the last 4 posted shows (used for the due factor).
  const recent = (data.setlists || []).slice(0, 4);
  const last4 = new Set();
  for (const show of recent) {
    for (const set of show.sets || []) {
      const titles = set.songTitles || splitDisplaySetSongs(set.songs || "");
      for (const t of titles) last4.add(normalizeTitle(t));
    }
  }

  const showsPlayed = data.totals?.postedSetlists || 0;
  const rotationLimit = data.rules?.rotationSlpLimit || 30;
  const dowName = weekdayName(board.isoDate);

  const candidates = (data.catalog || []).filter(
    (s) => s.playedThisTour || (Number.isFinite(s.effectiveSlp) && s.effectiveSlp < rotationLimit)
  );

  const scored = candidates.map((song) => {
    const tourFreq = showsPlayed
      ? (song.playedThisTour ? song.tourCount / showsPlayed : 0.5 / showsPlayed)
      : 0;
    const slp = Number.isFinite(song.effectiveSlp) ? song.effectiveSlp : 99;
    const absentLast4 = !last4.has(song.key);
    let due = 1;
    if (song.playedThisTour && slp <= 1) due = 0.3;
    else if (song.playedThisTour && slp <= 3) due = 0.75;
    else if (absentLast4) due = 1 + Math.min(0.8, tourFreq * 2);

    // Day-of-week affinity (neutral under a 30-play sample).
    const rec = songDow.get(song.key);
    const lifetime = rec?.total || 0;
    let affinity = 1;
    let affinityPct = 0;
    if (lifetime >= 30 && bandShareToday > 0) {
      const songShareToday = rec.dow[todayDow] / lifetime;
      const ratio = songShareToday / bandShareToday;
      affinity = Math.max(0.3, Math.min(3, ratio));
      affinityPct = Math.round((ratio - 1) * 100);
    }

    const score = tourFreq * due * affinity;
    return { song, score, tourFreq, slp, absentLast4, affinity, affinityPct, lifetime, due };
  }).filter((row) => row.score > 0);

  // Base heats first (pre-boost), so propagation reads a fixed input and can't
  // oscillate. Heat is the score relative to the strongest base score.
  scored.sort((a, b) => b.score - a.score || b.song.tourCount - a.song.tourCount || a.song.title.localeCompare(b.song.title));
  const baseMax = scored.length ? scored[0].score : 1;
  for (const row of scored) row.baseHeat = Math.max(1, Math.round((row.score / baseMax) * 100));
  const scoredByKey = new Map(scored.map((row) => [row.song.key, row]));

  // (b) PAIR PROPAGATION — one deterministic pass. A song gets a lift when a
  // segue partner that is ITSELF hot tonight is in the running: boost = 1 + 0.25
  // × (partnerHeat/100) × pairConfidence, capped at 1.35×. Lifetime partners use
  // their real confidence; a partner that only paired up on THIS tour uses a flat
  // recent-signal weight. Only the single strongest partner drives the boost.
  const lifetimePairs = data.lifetimePairs || new Map();
  const recentPairs = data.recentPairs || new Map();
  for (const row of scored) {
    let bestBoost = 1;
    let bestPartner = null;
    const consider = (partnerKey, conf) => {
      const pr = scoredByKey.get(partnerKey);
      if (!pr || pr === row) return;
      const b = 1 + 0.25 * (pr.baseHeat / 100) * conf;
      if (b > bestBoost) { bestBoost = b; bestPartner = pr; }
    };
    for (const p of (lifetimePairs.get(row.song.key) || [])) consider(p.key, p.confidence);
    for (const p of (recentPairs.get(row.song.key) || [])) consider(p.key, p.confidence);
    const boost = Math.min(1.35, bestBoost);
    row.boostedScore = row.score * boost;
    // The visible "travels with" hint is reserved for a real lift — a genuinely
    // hot segue partner is also in the running tonight — so it reads as signal.
    row.pairPartner = boost >= 1.05 && bestPartner ? bestPartner.song.title : "";
  }

  scored.sort((a, b) => b.boostedScore - a.boostedScore || b.song.tourCount - a.song.tourCount || a.song.title.localeCompare(b.song.title));
  const top = scored.slice(0, 25);
  const max = top.length ? top[0].boostedScore : 1;

  // (a) ALMANAC REASONS — a Confirmed/Vouched lyric-predicted entry that matches
  // tonight's weekday or date earns its 🎵 lyric as the row's headline reason.
  const almReasons = data.almanac?.oddsReasons || new Map();
  const boardMd = String(board.isoDate).slice(5);

  const rows = top.map((row) => {
    const heat = Math.max(1, Math.round((row.boostedScore / max) * 100));
    const tier = heat >= 66 ? "hot" : heat >= 33 ? "warm" : "long";
    const hints = [];
    hints.push(row.song.playedThisTour ? `${row.song.tourCount} this tour` : "in rotation");
    if (row.song.playedThisTour) hints.push(row.slp <= 0 ? "played last show" : `last seen ${row.slp} ${row.slp === 1 ? "show" : "shows"} ago`);
    else hints.push("not yet this tour");
    if (row.lifetime >= 30 && Math.abs(row.affinityPct) >= 8) {
      hints.push(`${dowName}s ${row.affinityPct >= 0 ? "+" : ""}${row.affinityPct}%`);
    }
    if (row.pairPartner) hints.push(`travels with ${row.pairPartner}`);

    const out = { title: row.song.title, heat, tier, hint: hints.join(" · ") };
    const reason = almReasons.get(row.song.key);
    if (reason && (reason.dow === todayDow || (reason.md && reason.md === boardMd))) {
      out.reason = reason.lyric;
      out.reasonPct = reason.ratioPct;
    }
    return out;
  });

  data.tonightOdds = rows.length
    ? { city: board.location || "", venue: board.venue || "", iso: board.isoDate, dowName, count: rows.length, songs: rows }
    : null;
}

function buildSongSlugMap(catalog) {
  const map = new Map();
  const used = new Set();
  for (const song of catalog) {
    let base = slugify(song.title);
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    map.set(song.key, slug);
  }
  return map;
}

function songAlbumsFor(song, albums) {
  return (albums || [])
    .filter((album) => (album.tracks || []).some((track) => {
      const t = normalizeTitle(track.title);
      return t === song.key || normalizeTitle(String(track.title).replace(/\s*\([^)]*\)\s*$/, "")) === song.key;
    }));
}

async function writeSongPages(data, albums) {
  const catalog = data.catalog || [];
  if (!catalog.length) return;
  const slugMap = buildSongSlugMap(catalog);
  data.songSlugMap = slugMap;
  await writeStaticPage("/songs/index.html", renderSongsIndex(data, slugMap));
  for (const song of catalog) {
    const slug = slugMap.get(song.key);
    await writeStaticPage(`/song/${slug}/index.html`, renderSongPage(song, data, albums, slugMap));
  }
}

function renderSongsIndex(data, slugMap) {
  const catalog = [...(data.catalog || [])].sort((a, b) => a.title.localeCompare(b.title));
  const originals = catalog.filter((s) => s.type === "Original").length;
  const covers = catalog.length - originals;
  // Shelf / Purgatory membership by song key. A shelved or purgatoried song must
  // NOT show a frequency-rarity tier like HYPER RARE (it misleads — the song is
  // dormant, not rare-when-played), so board status overrides the tier. Owner QA.
  const shelfKeys = new Set([...(data.boards?.shelfOriginals || []), ...(data.boards?.shelfCovers || [])].map((row) => row.key));
  const purgatoryKeys = new Set([...(data.boards?.purgatoryOriginals || []), ...(data.boards?.purgatoryCovers || [])].map((row) => row.key));
  const rotationKeys = new Set([...(data.boards?.rotationOriginals || []), ...(data.boards?.rotationCovers || [])].map((row) => row.key));
  const rotationLimit = data.rules?.rotationSlpLimit || 200;
  const rows = catalog.map((song) => {
    const rarity = calculateRarity(song);
    // Two independent axes now, per owner feedback:
    //   STATUS  = board state (In Rotation / Shelf / Purgatory) — where the song lives.
    //   RARITY  = frequency tier (Common…Hyper Rare, or a Bustout) — how rare when played.
    // Shelf/Purgatory intentionally suppress the RARITY column: a dormant song is not
    // "rare when played", it's parked, so a frequency tier there misleads (owner QA).
    // Precedence: In Rotation (active or on this tour's sheet) wins, then Shelf, then
    // Purgatory; the field fallback keeps Unclassified-type songs classified too.
    let statusTier;
    if (song.playedThisTour || rotationKeys.has(song.key)) statusTier = "rotation";
    else if (shelfKeys.has(song.key)) statusTier = "shelf";
    else if (purgatoryKeys.has(song.key)) statusTier = "purgatory";
    else if ((song.effectiveSlp ?? Infinity) < rotationLimit) statusTier = "rotation";
    else if ((song.total || 0) === 1) statusTier = "purgatory";
    else if ((song.total || 0) > 1) statusTier = "shelf";
    else statusTier = "rotation";
    const statusLabel = statusTier === "shelf" ? "Shelf" : statusTier === "purgatory" ? "Purgatory" : "In Rotation";
    const statusMarkup = `<span class="sr-status sr-status-${statusTier}">${statusLabel}</span>`;
    // RARITY: symbol + label, but only for In Rotation songs. Shelf/Purgatory show a
    // muted dash — no frequency tier on a parked song.
    const rarityMarkup = statusTier === "rotation"
      ? `<span class="rarity-symbol" aria-hidden="true">${renderRaritySymbol(rarity.tier)}</span>${escapeHtml(rarity.label)}`
      : '<span class="sr-none" aria-hidden="true">—</span><span class="sr-sr-only">No rarity — parked</span>';
    // Per-row resource indicators. These are REAL, separate <a> elements — the row
    // itself is one big <a>, and nested anchors are invalid HTML. They live in a
    // dedicated grid column (see .song-row-wrap / .sr-resources in renderStagelightCss)
    // that overlays the reserved RESOURCES track, so the whole row stays clickable
    // while each chip is independently tabbable with its own aria-label. Origin +
    // Lyrics light up only when the data join exists; Tab (Songsterr search) mirrors
    // the /song/ page link and is always available.
    const resChips = [];
    const origin = data.originsByTitle?.get(song.key);
    if (origin && origin.slug) {
      resChips.push(`<a class="sr-chip" href="/song-origins/${escapeAttr(origin.slug)}/" aria-label="${escapeAttr(song.title)} song origin">Origin</a>`);
    }
    const lyricsHref = data.lyricsResourceByKey?.get(song.key);
    if (lyricsHref) {
      resChips.push(`<a class="sr-chip" href="${escapeAttr(lyricsHref)}" aria-label="${escapeAttr(song.title)} lyrics and chords">Lyrics</a>`);
    }
    resChips.push(`<a class="sr-chip sr-chip-ext" href="https://www.songsterr.com/?pattern=${encodeURIComponent(song.title)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(song.title)} guitar tab on Songsterr">Tab</a>`);
    // Sortable/filterable data axes. STATUS sorts by a board rank (rotation → shelf →
    // purgatory); RARITY sorts by the frequency sortValue but ONLY for In-Rotation
    // songs — parked songs show a dash in the rarity column, so they carry an empty
    // data-rarity-tier (excluded from the rarity filter) and sink to -1 on a rarity sort.
    const statusRank = statusTier === "rotation" ? 0 : statusTier === "shelf" ? 1 : 2;
    const rarityTierAttr = statusTier === "rotation" ? rarity.tier : "";
    const raritySort = statusTier === "rotation" ? rarity.sortValue : -1;
    return `<div class="song-row-wrap" data-title="${escapeAttr(song.title.toLowerCase())}" data-type="${escapeAttr(song.type.toLowerCase())}" data-tour="${song.playedThisTour ? "yes" : "no"}" data-tier="${escapeAttr(statusTier)}" data-status="${statusRank}" data-rarity="${escapeAttr(String(raritySort))}" data-rarity-tier="${escapeAttr(rarityTierAttr)}" data-plays="${escapeAttr(String(song.total || 0))}">
      <a class="song-row" href="/song/${escapeAttr(slugMap.get(song.key))}/" tabindex="0">
        <span class="sr-title">${escapeHtml(song.title)}</span>
        <span class="sr-type">${escapeHtml(song.type)}</span>
        <span class="sr-status-cell">${statusMarkup}</span>
        <span class="sr-rarity">${rarityMarkup}</span>
        <span class="sr-plays">${formatNumber(song.total || 0)}<small>plays</small></span>
      </a>
      <span class="sr-resources">${resChips.join("")}</span>
    </div>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Song Index | Every Widespread Panic Song | Burnthday</title>
    <meta name="description" content="Search every song in the Widespread Panic catalog and see its full live history — total plays, first and last, rarity, and the album it came from.">
    <link rel="canonical" href="https://burnthday.com/songs/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main songs-main">
      <header class="archive-title">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">Songs</span></nav>
        <h1>Song Index</h1>
        <p class="songs-deck">The master catalog. Every song the band has played, with its live status, rarity, and where to go deeper.</p>
      </header>
      <div class="song-search">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <input type="search" id="song-search" placeholder="Search ${formatNumber(catalog.length)} songs…" autocomplete="off" aria-label="Search songs">
        <span class="song-count" id="song-count">${formatNumber(catalog.length)} songs · ${formatNumber(originals)} originals · ${formatNumber(covers)} covers</span>
      </div>
      <div class="index-toolbar" role="group" aria-label="Filter songs">
        <div class="type-filter" role="group" aria-label="Filter songs by type">
          <button type="button" class="is-active" data-type-filter="all">All</button>
          <button type="button" data-type-filter="original">Originals</button>
          <button type="button" data-type-filter="cover">Covers</button>
        </div>
        ${renderCustomSelect({ hook: "data-status-filter", label: "Status", active: "", options: [
          { value: "", label: "All songs" },
          { value: "tour", label: `${data.site.year} tour` },
          { value: "shelf", label: "The Shelf" },
          { value: "purgatory", label: "Purgatory" }
        ] })}
        ${renderCustomSelect({ hook: "data-rarity-filter", label: "Rarity", active: "", options: [
          { value: "", label: "All rarities" },
          { value: "common", label: "Common" },
          { value: "uncommon", label: "Uncommon" },
          { value: "rare", label: "Rare" },
          { value: "ultra", label: "Ultra Rare" },
          { value: "hyper", label: "Hyper Rare" },
          { value: "bustout", label: "Bustout" },
          { value: "mega", label: "Mega Bustout" },
          { value: "new", label: "New this tour" }
        ] })}
      </div>
      <div class="song-index-head" role="row">
        <button type="button" class="sih-col sih-sort" data-sort="title" aria-sort="ascending">Title <span class="sih-arrow" aria-hidden="true">↑</span></button>
        <button type="button" class="sih-col sih-sort sih-type" data-sort="type" aria-sort="none">Type <span class="sih-arrow" aria-hidden="true">↕</span></button>
        <button type="button" class="sih-col sih-sort sih-status" data-sort="status" aria-sort="none">Status <span class="sih-arrow" aria-hidden="true">↕</span></button>
        <button type="button" class="sih-col sih-sort sih-rarity" data-sort="rarity" aria-sort="none">Rarity <span class="sih-arrow" aria-hidden="true">↕</span></button>
        <span class="sih-col sih-more">Links</span>
        <button type="button" class="sih-col sih-sort sih-plays" data-sort="plays" aria-sort="none">Plays <span class="sih-arrow" aria-hidden="true">↕</span></button>
      </div>
      <div class="song-list" id="song-list">${rows}</div>
      <p class="song-empty" id="song-empty" hidden>No songs match that search.</p>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
    <script>${renderSongSearchScript()}</script>
  </body>
</html>
`;
}

// Client-side search + filter + column-sort for the Song Index. Composes a title
// search, a Type button group, a STATUS custom-select (All songs / this tour / Shelf /
// Purgatory) and a RARITY custom-select (All rarities / each tier) — all reading the
// data-* attributes on each .song-row-wrap (the wrapper carries the facets and the hide
// toggle so its resource links hide with the row). Every column header is a sort button
// (mirrors the Lyrics & Chords hub). The dropdowns reuse the sitewide custom-select.
function renderSongSearchScript() {
  return `(() => {
    const input = document.getElementById("song-search");
    const list = document.getElementById("song-list");
    const rows = [...list.querySelectorAll(".song-row-wrap")];
    const count = document.getElementById("song-count");
    const empty = document.getElementById("song-empty");
    const total = rows.length;
    const baseLabel = count.textContent;
    const typeButtons = [...document.querySelectorAll(".index-toolbar [data-type-filter]")];
    const statusSelect = document.querySelector("[data-status-filter]");
    const raritySelect = document.querySelector("[data-rarity-filter]");
    let selectedType = "all";
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      const status = statusSelect ? (statusSelect.dataset.value || "") : "";
      const rarity = raritySelect ? (raritySelect.dataset.value || "") : "";
      // STATUS: "tour" reads the this-tour flag; "shelf"/"purgatory" read the board tier.
      let shown = 0;
      rows.forEach((row) => {
        const statusHit = !status
          || (status === "tour" ? row.dataset.tour === "yes" : row.dataset.tier === status);
        const hit = (!q || row.dataset.title.includes(q))
          && (selectedType === "all" || row.dataset.type === selectedType)
          && statusHit
          && (!rarity || row.dataset.rarityTier === rarity);
        row.hidden = !hit;
        if (hit) shown++;
      });
      empty.hidden = shown !== 0;
      const filtered = q || selectedType !== "all" || status || rarity;
      count.textContent = filtered ? shown + " of " + total + " songs" : baseLabel;
    };
    // Column sort: click a header to sort by that key; click again to flip direction.
    // STATUS (board rank), RARITY (frequency sortValue) and PLAYS (total) are numeric;
    // TITLE and TYPE sort alphabetically. Title breaks every tie. Sort reorders the
    // wraps in place; the filter's hidden state is untouched. Title is the default (A-Z).
    const sortButtons = [...document.querySelectorAll(".song-index-head [data-sort]")];
    const numeric = { status: true, rarity: true, plays: true };
    let sortKey = "title";
    let sortDir = "asc";
    const compare = (a, b) => {
      const av = a.dataset[sortKey] || "";
      const bv = b.dataset[sortKey] || "";
      let c = numeric[sortKey] ? (Number(av) - Number(bv)) : av.localeCompare(bv);
      if (!c) c = a.dataset.title.localeCompare(b.dataset.title);
      return sortDir === "asc" ? c : -c;
    };
    const runSort = () => {
      [...list.querySelectorAll(".song-row-wrap")].sort(compare).forEach((w) => list.appendChild(w));
    };
    sortButtons.forEach((btn) => btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = (key === "title" || key === "type") ? "asc" : "desc";
      }
      sortButtons.forEach((b) => {
        const on = b.dataset.sort === sortKey;
        b.setAttribute("aria-sort", on ? (sortDir === "asc" ? "ascending" : "descending") : "none");
        const arrow = b.querySelector(".sih-arrow");
        if (arrow) arrow.textContent = on ? (sortDir === "asc" ? "↑" : "↓") : "↕";
      });
      runSort();
    }));
    typeButtons.forEach((btn) => btn.addEventListener("click", () => {
      selectedType = btn.dataset.typeFilter;
      typeButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
      apply();
    }));
    if (statusSelect) statusSelect.addEventListener("cs:change", apply);
    if (raritySelect) raritySelect.addEventListener("cs:change", apply);
    input.addEventListener("input", apply);
    input.focus();
  })();
  ${renderCustomSelectScript()}`;
}

// Optional verified Everyday Companion deep links, keyed by the same
// normalizeTitle() key the catalog uses. Produced by scripts/verify-ec-links.mjs
// (which runs where outbound web is available) and committed as
// data/source/ec-links.json. Absent by default — deep links light up the day the
// file lands, no code change required. Accepts either a flat { key: url } object
// or a wrapped { links: { key: url } } shape.
async function loadEcLinks() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "ec-links.json"), "utf8");
    const parsed = JSON.parse(raw);
    const map = parsed && typeof parsed.links === "object" && parsed.links ? parsed.links : parsed;
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

// Alex's "Best Guess" lyric transcriptions + interpretations, one markdown file
// per song in data/source/best-guess/. Each file is frontmatter (song, published,
// source, note) then a "## Best guess…" lyric section and a "## Notes" commentary
// section. We render his words verbatim — no paraphrasing, no summarizing — only
// the minimal markdown he uses: blank-line-separated blocks, **bold**, and (in the
// lyric section) preserved line breaks so the stanza shape survives.
async function loadBestGuesses() {
  const dir = path.join(root, "data", "source", "best-guess");
  let files = [];
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith(".md"));
  } catch {
    return [];
  }
  const entries = [];
  for (const file of files.sort()) {
    let raw;
    try {
      raw = await readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseBestGuess(raw, file);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

// Sourced "Tour Notes" in Burnthday's voice, one markdown file per tour in
// data/source/tour-notes/<tour-slug>.md. Frontmatter: tour (slug), written,
// byline, sources (bracketed comma list of URLs). Body is blank-line-separated
// prose with **bold**. Rendered on the tour page under the hero. These are
// DRAFTS for the owner's review — the files are hand-editable.
async function loadTourNotes() {
  const dir = path.join(root, "data", "source", "tour-notes");
  let files = [];
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith(".md"));
  } catch {
    return new Map();
  }
  const bySlug = new Map();
  for (const file of files.sort()) {
    let raw;
    try {
      raw = await readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseTourNotes(raw, file);
    if (parsed && parsed.slug) bySlug.set(parsed.slug, parsed);
  }
  return bySlug;
}

function parseTourNotes(raw, file) {
  const fm = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fm) {
    console.warn(`Tour Notes: ${file} has no frontmatter; skipping.`);
    return null;
  }
  const front = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) front[key] = line.slice(idx + 1).trim();
  }
  const sources = String(front.sources || "")
    .replace(/^\[|\]$/g, "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s));
  return {
    slug: (front.tour || file.replace(/\.md$/, "")).trim(),
    written: front.written || "",
    byline: front.byline || "Burnthday",
    sources,
    bodyHtml: renderBestGuessBlocks(fm[2], "para")
  };
}

function parseBestGuess(raw, file) {
  const fm = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fm) {
    console.warn(`Best Guess: ${file} has no frontmatter; skipping.`);
    return null;
  }
  const front = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) front[key] = line.slice(idx + 1).trim();
  }
  const body = fm[2];
  const heads = [];
  const headRe = /^##\s+(.+?)\s*$/gm;
  let match;
  while ((match = headRe.exec(body))) {
    heads.push({ title: match[1].trim(), contentStart: headRe.lastIndex, headStart: match.index });
  }
  const sections = {};
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].headStart : body.length;
    sections[heads[i].title] = body.slice(heads[i].contentStart, end).trim();
  }
  const bestKey = Object.keys(sections).find((k) => /best\s*guess/i.test(k));
  const notesKey = Object.keys(sections).find((k) => /notes/i.test(k));
  return {
    song: front.song || "",
    published: front.published || "",
    source: front.source || "",
    note: front.note || "",
    key: normalizeTitle(front.song || ""),
    transcriptionHtml: bestKey ? renderBestGuessBlocks(sections[bestKey], "stanza") : "",
    notesHtml: notesKey ? renderBestGuessBlocks(sections[notesKey], "para") : "",
    file
  };
}

// Render blank-line-separated blocks. In "stanza" mode each source line becomes a
// <br>-separated line so the lyric shape is preserved; in "para" mode wrapped lines
// are joined into flowing prose. Text is HTML-escaped first, then **bold** applied
// (the escape leaves ** untouched), so bold can span a preserved line break.
function renderBestGuessBlocks(text, mode) {
  const joiner = mode === "stanza" ? "<br>" : " ";
  const cls = mode === "stanza" ? "bg-stanza" : "bg-para";
  return String(text || "")
    .split(/\r?\n[ \t]*\r?\n/)
    .map((block) => block.replace(/^\s+|\s+$/g, ""))
    .filter(Boolean)
    .map((block) => {
      const inner = block
        .split(/\r?\n/)
        .map((line) => escapeHtml(line.trim()))
        .join(joiner);
      return `<p class="${cls}">${applyBestGuessBold(inner)}</p>`;
    })
    .join("\n");
}

function applyBestGuessBold(text) {
  return text.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
}

// Build the catalog-key -> Best Guess map, warning (and skipping) any file that
// does not match a catalog song so a transcription is never attached to the wrong
// song.
function attachBestGuesses(data, entries) {
  const catalogKeys = new Set((data.catalog || []).map((song) => song.key || normalizeTitle(song.title)));
  const byKey = new Map();
  for (const entry of entries) {
    if (!entry.key) {
      console.warn(`Best Guess: ${entry.file} has no song title in frontmatter; skipping.`);
      continue;
    }
    if (!catalogKeys.has(entry.key)) {
      console.warn(`Best Guess: no catalog match for "${entry.song}" (${entry.file}); skipping.`);
      continue;
    }
    byKey.set(entry.key, entry);
  }
  data.bestGuessByKey = byKey;
  return byKey;
}

// Map catalog song key -> internal Burnthday lyrics page path, for the song
// "Learn It" block. A match exists only when the archive has a lyrics page whose
// own title IS this song (so the page's HTML necessarily contains the title).
// We deliberately never fall back to the generic /lyrics-chords/ hub — a missing
// match means the internal chip is omitted rather than faked.
function buildLyricsResourceIndex(archiveEntries = []) {
  const byKey = new Map();
  for (const entry of archiveEntries) {
    if (!isLyricArchivePage(entry)) continue;
    if (!entry.path) continue;
    const key = normalizeTitle(lyricSongName(entry));
    if (!key) continue;
    const contentLen = String(entry.content || "").length;
    const existing = byKey.get(key);
    // Prefer the most specific (shortest) page for a song — a dedicated per-song
    // lyrics page over a giant multi-track album-lyrics compilation.
    if (!existing || contentLen < existing.contentLen) {
      byKey.set(key, { href: entry.path, contentLen });
    }
  }
  const result = new Map();
  for (const [key, value] of byKey) result.set(key, value.href);
  return result;
}

// ---- Chord detection (Lyrics & Chords hub content-type indicator) ----
// Burnthday hosts two kinds of internal transcription page per song: a plain
// "… Lyrics" page (words only) and, for many songs, a sibling "… Guitar Tab" page
// that carries the actual chords/tab. detectChords() reads a page's source text
// and decides — conservatively — whether it contains real chord content, so the
// hub can badge a song "LYRICS + CHORDS" vs "LYRICS". Nothing is authored; this
// only classifies Alex's existing pages, never rewrites them.
const CHORD_TOKEN = /^(?:[A-G](?:#|b|♯|♭)?(?:maj|min|m|sus|add|dim|aug|M)?\d{0,2}(?:sus\d)?(?:\/[A-G](?:#|b)?)?)$/;
const BRACKET_CHORD = /\[[A-G](?:#|b)?(?:maj|min|m|sus|add|dim|aug)?\d{0,2}(?:\/[A-G](?:#|b)?)?\]/g;
// A tablature line: a string/note label followed by a run of fret/dash characters.
const TAB_LINE = /^[\s|]*[eEADGBhH][\s|]{0,3}[-–|][-–x0-9phb\/\\~()\s|]{6,}$/;

function detectChords(html) {
  const text = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
  const lines = text.split(/\n/).map((line) => line.trim());
  let chordDenseLines = 0;
  let tabLines = 0;
  for (const line of lines) {
    if (!line) continue;
    if (TAB_LINE.test(line)) { tabLines++; continue; }
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 12) continue;
    const chords = tokens.filter((token) => CHORD_TOKEN.test(token));
    // Guard against prose false-positives: a bare "A"/"C" is a common English word,
    // so a chord-dense line needs a multi-character chord (Am, C#m7, D/F#) or a run
    // of three-plus chord tokens, AND the line must be MOSTLY chords.
    const richChords = chords.filter((token) => token.length >= 2 || /[#b]/.test(token));
    if (chords.length >= 2 && chords.length / tokens.length >= 0.7 && (richChords.length >= 1 || chords.length >= 3)) {
      chordDenseLines++;
    }
  }
  const brackets = (text.match(BRACKET_CHORD) || []).length;
  const capo = /\bcapo\s*\d/i.test(text);
  const tuning = /\b(drop\s*d\b|standard tuning|tuning\s*:)/i.test(text);
  return (
    tabLines >= 3 ||
    brackets >= 3 ||
    chordDenseLines >= 3 ||
    (chordDenseLines >= 2 && (capo || tuning || brackets >= 1)) ||
    (capo && chordDenseLines >= 1) ||
    (tabLines >= 2 && chordDenseLines >= 1) ||
    (tabLines >= 1 && (capo || tuning))
  );
}

// Reduce a lyric/tab page title to the catalog key so a "… Guitar Tab" page can be
// joined to the same song as its "… Lyrics" sibling.
function chordPageSongKey(title) {
  const name = cleanArchiveTitle(title)
    .replace(/\b(album\s+)?guitar\s+tab\b/gi, "")
    .replace(/\btab\b/gi, "")
    .replace(/\b(album\s+)?lyrics?\b/gi, "")
    .replace(/\bchords?\b/gi, "")
    .replace(/[|–—-]\s*burnthday.*$/i, "")
    .trim();
  return normalizeTitle(name);
}

// True when an archive page's title marks it a guitar-tab/chords sibling of a
// "… Lyrics" page (rather than the lyrics page itself).
function isGuitarTabPage(entry) {
  return /\bguitar\s*tab\b|\btab\b|\bchords?\b/i.test(entry?.title || "");
}

// Map of catalog key -> where its real chord content lives:
//   { onLyricsPage, tabHref, tabTitle }
// onLyricsPage is true when the song's own lyrics page carries chords; tabHref
// points at a sibling "… Guitar Tab" page when one exists. Conservative: a page
// only contributes when detectChords() is satisfied. Exposes .has()/.get() so it
// stays a drop-in for the old Set-based callers.
function buildChordsResourceIndex(archiveEntries = []) {
  const byKey = new Map();
  for (const entry of archiveEntries) {
    if (!entry.content || !detectChords(entry.content)) continue;
    const key = chordPageSongKey(entry.title || "");
    if (!key) continue;
    let rec = byKey.get(key);
    if (!rec) { rec = { onLyricsPage: false, tabHref: "", tabTitle: "" }; byKey.set(key, rec); }
    if (isGuitarTabPage(entry)) {
      if (!rec.tabHref && entry.path) { rec.tabHref = entry.path; rec.tabTitle = cleanArchiveTitle(entry.title || ""); }
    } else {
      rec.onLyricsPage = true;
    }
  }
  return byKey;
}

// Resolve the Everyday Companion link for a catalog song: the verified deep link
// from data/source/ec-links.json when it exists, else the safe homepage fallback.
// We NEVER synthesize a guessed per-song URL that could 404. Shared by the song
// "Learn It" block, the Lyrics & Chords hub and the lyric-subpage cross-reference
// so all three stay in lockstep. Returns { href, deep } — `deep` is true only when
// the link is a verified per-song page.
function ecLinkFor(song, data) {
  const key = (song && song.key) || normalizeTitle((song && song.title) || "");
  const deep = key ? (data.ecLinksByKey?.[key] || "") : "";
  return { href: deep || "http://everydaycompanion.com/", deep: Boolean(deep) };
}

// Set of catalog keys Everyday Companion demonstrably knows: any key with a verified
// deep link, plus every song present in EC's play-stat exports. Used to gate the
// lyric-subpage "Also on Everyday Companion" cross-reference — exclusive songs (no
// EC entry at all) get no cross-reference rather than a misleading homepage link.
function buildEcKnownIndex(ecLinksByKey = {}, source = {}) {
  const keys = new Set(Object.keys(ecLinksByKey || {}));
  for (const row of source.playstats?.rows || []) {
    const key = normalizeTitle(row.title || "");
    if (key) keys.add(key);
  }
  for (const row of source.priorSongStats?.rows || []) {
    const key = normalizeTitle(row.title || "");
    if (key) keys.add(key);
  }
  return keys;
}

function ecKnownFor(song, data) {
  const key = (song && song.key) || normalizeTitle((song && song.title) || "");
  if (!key) return false;
  if (data.ecLinksByKey?.[key]) return true;
  return Boolean(data.ecKnownKeys?.has?.(key));
}

// The guitarist-facing "Learn It" resource row: internal lyrics (only when a real
// archive page exists), Everyday Companion (community canon, deep-linked when
// verified), and a Songsterr tab search. Sits right after the song facts.
function renderSongLearnIt(song, data) {
  const chips = [];
  const internal = data.lyricsResourceByKey?.get(song.key);
  if (internal) {
    chips.push(`<a class="learn-chip" href="${escapeAttr(internal)}">Lyrics on Burnthday<small>lyrics &amp; chords</small></a>`);
  }
  const ecHref = ecLinkFor(song, data).href;
  chips.push(`<a class="learn-chip learn-ext" href="${escapeAttr(ecHref)}" target="_blank" rel="noopener noreferrer">Everyday Companion <span class="learn-go" aria-hidden="true">↗</span><small>lyrics &amp; chords</small></a>`);
  chips.push(`<a class="learn-chip learn-ext" href="https://www.songsterr.com/?pattern=${encodeURIComponent(song.title)}" target="_blank" rel="noopener noreferrer">Songsterr tab <span class="learn-go" aria-hidden="true">↗</span></a>`);
  return `<section class="song-learn" aria-labelledby="song-learn-h">
        <h2 class="song-learn-eyebrow" id="song-learn-h">LEARN IT</h2>
        <div class="song-learn-chips">${chips.join("")}</div>
      </section>`;
}

// Official-video support (Feature 2). Real data lives in data/source/song-videos.json,
// which deliberately does NOT ship in the repo — only song-videos.example.json documents
// the shape. When the real file is absent the whole WATCH layer stays dormant. Keys are
// normalizedTitle(song); each value is an array of { youtubeId, title, era, official }.
async function loadSongVideos() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "song-videos.json"), "utf8");
    const parsed = JSON.parse(raw);
    const source = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed.videos && typeof parsed.videos === "object" ? parsed.videos : parsed)
      : {};
    const byKey = new Map();
    for (const [rawKey, value] of Object.entries(source)) {
      if (!Array.isArray(value)) continue;
      const key = normalizeTitle(rawKey);
      if (!key) continue;
      const entries = value.filter((entry) => entry && entry.youtubeId && entry.official === true);
      if (entries.length) byKey.set(key, entries);
    }
    return byKey;
  } catch {
    return new Map();
  }
}

// Relisten links (Feature 3). data/source/relisten-dates.json is an array of
// "YYYY-MM-DD" strings — the show dates archive.org has confirmed streamable at
// relisten.net. The file does NOT ship in the repo; when absent the entire Relisten
// layer stays dormant (empty Set → no links anywhere). Populate it with
// scripts/verify-relisten-dates.mjs where network access exists.
async function loadRelistenDates() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "relisten-dates.json"), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.dates) ? parsed.dates : []);
    return new Set(list.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value))));
  } catch {
    return new Set();
  }
}

// relisten.net organizes Widespread Panic streams under the artist slug "wsp",
// by /wsp/YYYY/MM/DD (e.g. https://relisten.net/wsp/2026/05/08).
function relistenUrlFor(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  return match ? `https://relisten.net/wsp/${match[1]}/${match[2]}/${match[3]}` : "";
}

// The WATCH section (Feature 2): a single lite embed of the "definitive" official
// video for a song. Sits between LEARN IT and "Appears on". Selection: if the song
// debuted in the Houser era (first played before 2002-08-11) AND a houser-era entry
// exists, prefer that performance; otherwise take the first listed entry. Only
// official:true entries are ever loaded, so nothing else can render here.
const HOUSER_ERA_CUTOFF = "2002-08-11";

function selectSongVideo(song, data) {
  const entries = data.songVideosByKey?.get(song.key);
  if (!entries || !entries.length) return null;
  const firstIso = parseDateKey(song.first);
  const houserEra = firstIso && firstIso < HOUSER_ERA_CUTOFF;
  if (houserEra) {
    const houserPick = entries.find((entry) => entry.era === "houser");
    if (houserPick) return houserPick;
  }
  return entries[0];
}

function renderSongWatch(song, data) {
  const video = selectSongVideo(song, data);
  if (!video) return "";
  const id = extractYouTubeId(`https://www.youtube.com/watch?v=${video.youtubeId}`) || video.youtubeId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return "";
  return `<section class="song-watch" aria-labelledby="song-watch-h">
        <h2 class="song-watch-eyebrow" id="song-watch-h">WATCH</h2>
        <div class="song-watch-embed">${renderLiteEmbed(id, { title: video.title || song.title })}</div>
      </section>`;
}

function renderSongPage(song, data, albums, slugMap) {
  const rarity = calculateRarity(song);
  const heat = calculateRotationHeat(song, data.totals?.postedSetlists || 0);
  const onAlbums = songAlbumsFor(song, albums);
  const origin = data.originsByTitle?.get(song.key) || null;
  const writtenBy = onAlbums.flatMap((a) => a.tracks).find((t) => normalizeTitle(t.title) === song.key)?.writtenBy;
  const firstLong = formatLongDate(parseDateKey(song.first) || song.first) || song.first;
  const lastLong = song.effectiveLastIso ? formatLongDate(song.effectiveLastIso) : (formatLongDate(parseDateKey(song.last) || song.last) || song.lastDisplay);
  const spanYears = (() => {
    const f = parseDateKey(song.first), l = song.effectiveLastIso || parseDateKey(song.last);
    if (!f || !l) return null;
    return Math.max(0, Math.round((new Date(l) - new Date(f)) / (365.25 * 864e5)));
  })();
  const eyebrow = song.type === "Cover" ? `Cover${writtenBy ? ` · written by ${writtenBy}` : ""}` : "Original";

  const tile = (value, label, sub = "") => `<div class="song-stat"><strong>${value}</strong><span>${escapeHtml(label)}</span>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</div>`;
  const tiles = [
    tile(formatNumber(song.total || 0), "lifetime plays", "since debut"),
    tile(formatNumber(song.tourCount || 0), `played this tour`, song.playedThisTour ? "in rotation" : "not yet this tour"),
    `<div class="song-stat"><strong class="song-rarity"><span class="rarity-symbol" aria-hidden="true">${renderRaritySymbol(rarity.tier)}</span>${escapeHtml(rarity.label)}</strong><span>tour rarity</span>${rarity.tier !== "new" ? `<small>${formatNumber(song.l100 || 0)} in last 100</small>` : ""}</div>`,
    tile(`${formatNumber(song.effectiveSlp ?? 0)}`, "shows since last", `usual gap ${heat.expectedGap.toFixed(1)}`)
  ];
  if (song.nickCount > 0) tiles.push(tile(formatNumber(song.nickCount), "plays with Nick", "current era"));

  const bestGuess = data.bestGuessByKey?.get(song.key) || null;
  const description = bestGuess
    ? `Best Guess lyric transcription and interpretation of ${song.title}, plus its full Widespread Panic live history — total plays, first and last — from Burnthday.`
    : `${song.title} — ${song.type.toLowerCase()} with ${formatNumber(song.total || 0)} live plays, first played ${song.first}, last ${song.lastDisplay}. Full Widespread Panic history from Burnthday.`;
  const titleSuffix = " | Burnthday";
  const titleCandidates = bestGuess
    ? [`${song.title} — Lyrics (Best Guess) & Live History`, `${song.title} — Lyrics (Best Guess)`, `${song.title} — Live History`, song.title]
    : [`${song.title} — Live History`, song.title];
  let pageTitle = `${titleCandidates.find((c) => (c + titleSuffix).length <= 70) ?? song.title}${titleSuffix}`;
  if (pageTitle.length > 70) pageTitle = `${song.title.slice(0, 70 - titleSuffix.length - 1).trimEnd()}…${titleSuffix}`;

  const songWatch = renderSongWatch(song, data);
  const hasLiteEmbed = songWatch.includes('class="yt-lite"');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(pageTitle)}</title>
    <meta name="description" content="${escapeAttr(fitMetaText(description, 155))}">
    <link rel="canonical" href="https://burnthday.com/song/${escapeAttr(slugMap.get(song.key))}/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["Songs", "https://burnthday.com/songs/"],
      [song.title, `https://burnthday.com/song/${slugMap.get(song.key)}/`]
    ])}</script>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main song-main">
      <header class="archive-title">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><a href="/songs/">Songs</a></nav>
        <h1>${escapeHtml(song.title)}</h1>
      </header>
      <div class="song-stat-grid">${tiles.join("")}</div>
      <dl class="song-facts">
        <div><dt>First played</dt><dd>${escapeHtml(firstLong)}</dd></div>
        <div><dt>Last played</dt><dd>${escapeHtml(lastLong)}</dd></div>
        ${spanYears != null ? `<div><dt>In the rotation</dt><dd>${spanYears === 0 ? "under a year" : `${spanYears} year${spanYears === 1 ? "" : "s"}`} of history</dd></div>` : ""}
        <div><dt>Type</dt><dd>${escapeHtml(eyebrow)}</dd></div>
      </dl>
      ${renderSongLearnIt(song, data)}
      ${renderSongTravelsWith(song, data)}
      ${songWatch}
      ${onAlbums.length ? `<section class="song-albums">
        <h2>Appears on</h2>
        <div class="song-album-chips">${onAlbums.map((a) => `<a href="/albums/${escapeAttr(a.slug)}/">${escapeHtml(a.title)}<small>${escapeHtml(albumYear(a))}</small></a>`).join("")}</div>
      </section>` : ""}
      ${renderSongBestGuess(song, data)}
      ${origin ? `<nav class="archive-crosslink" aria-label="Related">
        <a href="/song-origins/${escapeAttr(origin.slug)}/"><span class="xl-eyebrow">Song Origin</span><span class="xl-title">The story behind “${escapeHtml(origin.title)}”</span><span class="xl-go" aria-hidden="true">→</span></a>
      </nav>` : ""}
      ${renderSongPerformanceLog(song, data)}
      <p class="song-back"><a href="/songs/">← All songs</a></p>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
    ${hasLiteEmbed ? LITE_EMBED_SCRIPT : ""}
  </body>
</html>
`;
}

// "Travels With" — the song's strongest segue partners, mined from the ordered
// setlist log. RECENCY WINS: partners from the last-100-show window lead, tagged
// "recent" (confidence = how often the partner follows when this song plays), and
// each also shows its all-time figure when a durable lifetime bond exists. Any
// remaining slots (top 3) fill with lifetime-only partners tagged "all-time".
function renderSongTravelsWith(song, data) {
  const recent = data.recentPairs?.get(song.key) || [];
  const lifetime = data.lifetimePairs?.get(song.key) || [];
  if (!recent.length && !lifetime.length) return "";
  const lifeByKey = new Map(lifetime.map((p) => [p.key, p]));
  const twRow = (p, arrow, statHtml, tag) => {
    const name = p.slug ? `<a href="/song/${escapeAttr(p.slug)}/">${escapeHtml(p.title)}</a>` : escapeHtml(p.title);
    return `<li class="tw-row">
          <span class="tw-pair"><span class="tw-this">${escapeHtml(song.title)}</span><span class="tw-arrow" aria-hidden="true">${arrow}</span><span class="tw-partner">${name}</span><span class="tw-tag tw-tag-${tag === "recent" ? "recent" : "alltime"}">${tag}</span></span>
          <span class="tw-stat">${statHtml}</span>
        </li>`;
  };
  const rows = [];
  const used = new Set();
  for (const p of recent) {
    if (rows.length >= 3) break;
    used.add(p.key);
    const pct = Math.round(p.confidence * 100);
    const life = lifeByKey.get(p.key);
    const allTime = life ? `<small class="tw-era">${Math.round(life.confidence * 100)}% all-time · ${formatNumber(life.adj)} segues</small>` : "";
    rows.push(twRow(p, p.leadsInto ? "→" : "←", `<b>${pct}%</b> recently · ${formatNumber(p.count)} in last 100${allTime}`, "recent"));
  }
  for (const p of lifetime) {
    if (rows.length >= 3) break;
    if (used.has(p.key)) continue;
    used.add(p.key);
    const pct = Math.round(p.confidence * 100);
    rows.push(twRow(p, p.leadsInto ? "→" : "←", `<b>${pct}%</b> of the time · ${formatNumber(p.adj)} segues`, "all-time"));
  }
  if (!rows.length) return "";
  const lead = recent.length
    ? "Songs this one tends to segue with — recent pairings first, all-time bonds where they run deep."
    : "Songs this one tends to segue with, across every setlist on record.";
  return `<section class="song-travels">
        <h2>Travels with</h2>
        <p class="tw-lead">${lead}</p>
        <ol class="tw-list">${rows.join("")}</ol>
      </section>`;
}

// Alex's "Best Guess" lyric transcription + interpretation, rendered as a distinct
// editorial section between the album chips and the performance log. His voice
// appears ONLY in his verbatim words — the eyebrow, byline, dates and source line
// are neutral UI chrome; nothing is written in his style.
function renderSongBestGuess(song, data) {
  const entry = data.bestGuessByKey?.get(song.key);
  if (!entry) return "";
  const dateLong = entry.published ? formatLongDate(entry.published) : "";
  const byline = `Burnthday${dateLong ? ` · ${escapeHtml(dateLong)}` : ""}`;
  return `<section class="song-bestguess" aria-labelledby="song-bg-h">
        <p class="bg-eyebrow" id="song-bg-h">BEST GUESS</p>
        <p class="bg-byline">${byline}</p>
        ${entry.note ? `<p class="bg-note">${escapeHtml(entry.note)}</p>` : ""}
        <div class="bg-card">
          ${entry.transcriptionHtml ? `<div class="bg-lyrics">${entry.transcriptionHtml}</div>` : ""}
          ${entry.notesHtml ? `<div class="bg-notes"><h3 class="bg-notes-label">Notes</h3>${entry.notesHtml}</div>` : ""}
        </div>
        ${entry.source ? `<p class="bg-source"><a href="${escapeAttr(entry.source)}" target="_blank" rel="noopener noreferrer">Originally posted on X <span aria-hidden="true">↗</span></a></p>` : ""}
      </section>`;
}

// "Every performance" log from the setlist.fm cache. Empty (section omitted)
// until a real cache exists. Capped to the most-recent SHOWN to keep 698 pages
// light; the full archive lives on setlist.fm.
function renderSongPerformanceLog(song, data) {
  const performances = data.performancesByTitle?.get(song.key) || [];
  if (!performances.length) return "";
  const SHOWN = 40;
  const recent = performances.slice(0, SHOWN);
  const searchUrl = `https://www.setlist.fm/search?query=${encodeURIComponent(`Widespread Panic ${song.title}`)}`;
  const relistenDates = data.relistenDates || new Set();
  const rows = recent.map((perf) => {
    const loc = [perf.city, perf.state].filter(Boolean).join(", ");
    const tags = [
      perf.encore ? '<span class="perf-tag">Encore</span>' : "",
      perf.guest ? `<span class="perf-tag">with ${escapeHtml(perf.guest)}</span>` : "",
      perf.tape ? '<span class="perf-tag">Tape</span>' : ""
    ].join("");
    const inner = `<span class="perf-date">${escapeHtml(formatLongDate(perf.date) || perf.date)}</span>
        <span class="perf-venue">${escapeHtml(perf.venue || "Unknown venue")}</span>
        <span class="perf-loc">${escapeHtml(loc)}</span>
        ${tags ? `<span class="perf-tags">${tags}</span>` : ""}`;
    // One action per row: Listen on Relisten when a recording exists. The whole row
    // is the Relisten link (big target, chip inline after the location); rows with
    // no recording render static on the same grid so alignment never shifts. The
    // per-row setlist.fm links are gone — the footer link covers the full archive.
    const relistenUrl = relistenDates.has(perf.date) ? relistenUrlFor(perf.date) : "";
    const main = relistenUrl
      ? `<a href="${escapeAttr(relistenUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Listen to ${escapeAttr(`${perf.date} ${perf.venue || ""}`)} on Relisten">${inner}<span class="perf-listen">Listen <span aria-hidden="true">↗</span></span></a>`
      : `<span class="perf-static">${inner}</span>`;
    return `<li class="perf">${main}</li>`;
  }).join("");
  return `<section class="song-history">
        <div class="song-history-head">
          <h2>Every performance</h2>
          <span>${formatNumber(performances.length)} total</span>
        </div>
        <ol class="perf-list">${rows}</ol>
        ${performances.length > SHOWN
          ? `<p class="perf-more">Showing the ${SHOWN} most recent of ${formatNumber(performances.length)}. <a href="${escapeAttr(searchUrl)}" target="_blank" rel="noopener noreferrer">Full history on setlist.fm <span aria-hidden="true">↗</span></a></p>`
          : ""}
      </section>`;
}

async function loadAlbums() {
  try {
    const raw = await readFile(path.join(root, "data", "source", "albums.json"), "utf8");
    const parsed = JSON.parse(raw);
    return (parsed.albums || []).filter((album) => album.slug && album.title);
  } catch {
    return [];
  }
}

async function writeAlbumPages(data, albums) {
  if (!albums.length) return;
  const ordered = [...albums].sort((a, b) => String(b.releaseDate || "").localeCompare(String(a.releaseDate || "")));
  data.albums = ordered;
  await writeStaticPage("/albums/index.html", renderAlbumsIndex(ordered, data));
  for (const album of ordered) {
    await writeStaticPage(`/albums/${album.slug}/index.html`, renderAlbumPage(album, ordered, data));
  }
}

// Intentional placeholder until real cover art is added — branded, not broken.
function renderAlbumCoverFallback(album) {
  return `<span class="album-cover-fallback">
    <img class="acf-mark" src="/assets/brand/burnthday-eater.svg" alt="" aria-hidden="true">
    <span class="acf-title">${escapeHtml(album.title)}</span>
    <span class="acf-note">Artwork coming soon</span>
  </span>`;
}

function albumYear(album) {
  const match = String(album.releaseDate || "").match(/^(\d{4})/);
  return match ? match[1] : "";
}

function albumTrackStats(album, data) {
  const byKey = new Map((data.catalog || []).map((row) => [row.key, row]));
  const cutoff = data.rules?.rotationSlpLimit || 200;
  const lookup = (title) => {
    // exact, then with any "(parenthetical)" subtitle stripped to match the live name
    return byKey.get(normalizeTitle(title)) || byKey.get(normalizeTitle(String(title).replace(/\s*\([^)]*\)\s*$/, "")));
  };
  const allDates = data.allShowDates || [];
  const tracks = (album.tracks || []).map((track) => {
    const row = lookup(track.title);
    const onSheet = row ? row.playedThisTour || (row.effectiveSlp ?? Infinity) < cutoff : false;
    // Lifetime frequency: shows the band has played since the song's debut, per play.
    let frequency = null;
    if (row && (row.total || 0) > 0) {
      const firstIso = parseDateKey(row.first);
      const showsSince = firstIso ? allDates.filter((iso) => iso >= firstIso).length : 0;
      if (showsSince >= row.total && row.total > 0) frequency = showsSince / row.total;
    }
    return { ...track, row, onSheet, total: row?.total || 0, frequency };
  });
  const matched = tracks.filter((track) => track.row);
  return {
    tracks,
    onSheetCount: tracks.filter((track) => track.onSheet).length,
    totalPlays: sum(matched.map((track) => track.total)),
    matchedCount: matched.length
  };
}

function renderAlbumsIndex(albums, data) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Widespread Panic Albums | Burnthday</title>
    <meta name="description" content="The modern Widespread Panic studio albums — tracklists, credits, and how each record lives on stage.">
    <link rel="canonical" href="https://burnthday.com/albums/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main albums-main">
      <header class="archive-title">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">Albums</span></nav>
        <h1>Albums</h1>
        <p class="albums-deck">Every studio album, and what the band still plays from each.</p>
      </header>
      <div class="album-grid">
        ${albums.map((album) => `<a class="album-tile" href="/albums/${escapeAttr(album.slug)}/">
          <span class="album-cover${album.cover ? "" : " is-empty"}">${album.cover ? `<img src="${escapeAttr(album.cover)}" alt="${escapeAttr(`${album.title} cover`)}" loading="lazy" decoding="async">` : renderAlbumCoverFallback(album)}</span>
          <span class="album-tile-title">${escapeHtml(album.title)}</span>
          <span class="album-tile-year">${escapeHtml(albumYear(album))}</span>
        </a>`).join("")}
      </div>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
  </body>
</html>
`;
}

function renderAlbumPage(album, albums, data) {
  const year = albumYear(album);
  const longDate = album.releaseDate ? formatLongDate(album.releaseDate) : "";
  const stats = albumTrackStats(album, data);
  const index = albums.findIndex((entry) => entry.slug === album.slug);
  const previous = albums[index + 1] || null;
  const next = albums[index - 1] || null;
  const description = clean(album.blurb) || `${album.title} (${year}) by Widespread Panic — tracklist, credits, and live history from Burnthday.`;

  const credits = [
    ["Produced by", album.producedBy],
    ["Engineered by", album.engineeredBy],
    ["Mixed by", album.mixedBy],
    ["Recorded at", album.recordedAt]
  ].filter(([, value]) => (value || []).length);
  const streamLinks = Object.entries(album.links || {}).filter(([, url]) => clean(url));
  const streamLabels = { spotify: "Spotify", appleMusic: "Apple Music", bandcamp: "Bandcamp", amazon: "Amazon", purchase: "Store" };

  const trackRows = stats.tracks.map((track, i) => {
    const stat = track.row
      ? `<span class="track-stat">${track.onSheet ? `<span class="track-live">In Rotation</span>` : ""}${track.frequency ? `<span class="track-freq">1 in every ${track.frequency >= 10 ? Math.round(track.frequency) : track.frequency.toFixed(1)} shows</span>` : ""}<span class="track-plays">${formatNumber(track.total)} live</span></span>`
      : "";
    return `<li class="album-track${track.row ? "" : " no-data"}">
      <span class="track-n">${String(i + 1).padStart(2, "0")}</span>
      <span class="track-title">${track.row && data.songSlugMap?.get(track.row.key) ? `<a href="/song/${escapeAttr(data.songSlugMap.get(track.row.key))}/">${escapeHtml(track.title)}</a>` : escapeHtml(track.title)}${track.writtenBy ? `<small>${escapeHtml(track.writtenBy)}</small>` : ""}</span>
      ${stat}
    </li>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(album.title)} | Widespread Panic Album | Burnthday</title>
    <meta name="description" content="${escapeAttr(fitMetaText(description, 155))}">
    <link rel="canonical" href="https://burnthday.com/albums/${escapeAttr(album.slug)}/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["Albums", "https://burnthday.com/albums/"],
      [album.title, `https://burnthday.com/albums/${album.slug}/`]
    ])}</script>
  </head>
  <body class="stagelight album-page-body">
    <div class="album-backdrop"${album.cover ? ` style="--album-art:url('${escapeAttr(album.cover)}')"` : ""} aria-hidden="true"></div>
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main album-main">
      <header class="archive-title">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><a href="/albums/">Albums</a></nav>
        <h1>${escapeHtml(album.title)}</h1>
      </header>

      <div class="album-layout">
        <div class="album-aside">
          <figure class="album-cover-lg${album.cover ? "" : " is-empty"}">${album.cover ? `<img src="${escapeAttr(album.cover)}" alt="${escapeAttr(`${album.title} cover`)}" decoding="async">` : renderAlbumCoverFallback(album)}</figure>
          ${longDate ? `<div class="album-meta"><p class="album-meta-label">Released</p><p class="album-meta-value">${escapeHtml(longDate)}</p></div>` : ""}
          ${album.label ? `<div class="album-meta"><p class="album-meta-label">Label</p><p class="album-meta-value">${escapeHtml(album.label)}</p></div>` : ""}
          ${streamLinks.length ? `<div class="album-listen"><p class="album-meta-label">Listen</p><div class="album-listen-links">${streamLinks.map(([key, url]) => `<a class="sc-chip sc-chip-glass" href="${escapeAttr(url)}">${escapeHtml(streamLabels[key] || key)}</a>`).join("")}</div></div>` : ""}
        </div>

        <div class="album-body">
          ${album.blurb ? `<p class="album-blurb">${escapeHtml(album.blurb)}</p>` : ""}
          ${stats.matchedCount ? `<div class="album-footprint">
            <div><strong>${formatNumber(stats.onSheetCount)}</strong><span>in rotation</span></div>
            <div><strong>${formatNumber(stats.totalPlays)}</strong><span>live plays, these songs</span></div>
            <div><strong>${formatNumber(stats.tracks.length)}</strong><span>tracks</span></div>
          </div>` : ""}
          ${trackRows ? `<div class="album-tracks-head"><h2>Tracks</h2><span>plays are lifetime, live</span></div>
          <ol class="album-tracks">${trackRows}</ol>` : `<p class="album-pending">Tracklist coming soon.</p>`}
          ${credits.length ? `<div class="album-credits">
            ${credits.map(([label, value]) => `<div class="credit-block"><h3>${escapeHtml(label)}</h3><p>${value.map((entry) => escapeHtml(entry)).join("<br>")}</p></div>`).join("")}
            ${album.personnel && album.personnel.length ? `<div class="credit-block credit-personnel"><h3>The Band</h3><p>${album.personnel.map((person) => `${escapeHtml(person.name)}${person.role ? ` — ${escapeHtml(person.role)}` : ""}`).join("<br>")}</p></div>` : ""}
          </div>` : ""}
        </div>
      </div>

      <nav class="album-nav" aria-label="More albums">
        ${previous ? `<a href="/albums/${escapeAttr(previous.slug)}/"><span>Earlier</span><strong>${escapeHtml(previous.title)}</strong></a>` : "<span></span>"}
        ${next ? `<a class="is-next" href="/albums/${escapeAttr(next.slug)}/"><span>Later</span><strong>${escapeHtml(next.title)}</strong></a>` : "<span></span>"}
      </nav>
    </main>
    ${renderSiteFooter(data, { stagelight: true })}
  </body>
</html>
`;
}

// The archive index is a utility/findability page: every preserved Blogger post
// and page, grouped by year (newest first) into scannable tokenized rows, with a
// client-side title search. Clean and fast — no laminate, no heavy design.
function renderArchiveIndex(entries, data) {
  const deck = `${formatNumber(entries.length)} preserved Blogger posts and pages from the Takeout export — grouped by year and searchable by title.`;
  // Entries arrive newest-first. Group by published year; anything undated falls
  // into a trailing "Undated" bucket so nothing is dropped.
  const byYear = new Map();
  for (const entry of entries) {
    const year = (entry.published || "").slice(0, 4) || "Undated";
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(entry);
  }
  const years = [...byYear.keys()].sort((a, b) => {
    if (a === "Undated") return 1;
    if (b === "Undated") return -1;
    return b.localeCompare(a);
  });

  const groups = years.map((year) => `<section class="archive-year" data-year="${escapeAttr(year)}">
          <h2 class="archive-year-head">${escapeHtml(year)}<span>${formatNumber(byYear.get(year).length)} ${byYear.get(year).length === 1 ? "post" : "posts"}</span></h2>
          <ul class="archive-rows">${byYear.get(year).map((entry) => `<li class="archive-row" data-title="${escapeAttr((entry.title || "").toLowerCase())}">
            <a href="${escapeAttr(canonicalPathFor(entry.path))}"><span class="ar-title">${escapeHtml(entry.title)}</span><span class="ar-date">${escapeHtml(formatArchiveDate(entry.published))}</span></a>
          </li>`).join("")}</ul>
        </section>`).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Burnthday Archive | Widespread Panic Blog</title>
    <meta name="description" content="${escapeAttr(deck)}">
    <link rel="canonical" href="https://burnthday.com/archive/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
    <script type="application/ld+json">${renderBreadcrumbJsonLd([
      ["Home", "https://burnthday.com/"],
      ["Archive", "https://burnthday.com/archive/"]
    ])}</script>
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main songs-main">
      <header class="archive-title archive-hub-title">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span class="crumb-sep" aria-hidden="true">›</span><span aria-current="page">Archive</span></nav>
        <h1>Archive</h1>
        <p class="archive-hub-deck">${escapeHtml(deck)}</p>
      </header>
      <div class="song-search">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <input type="search" id="archive-search" placeholder="Search ${formatNumber(entries.length)} posts…" autocomplete="off" aria-label="Search archive by title">
        <span class="song-count" id="archive-count">${formatNumber(entries.length)} posts</span>
      </div>
      <div class="archive-groups">${groups}</div>
      <p class="song-empty" id="archive-empty" hidden>No posts match your search.</p>
    </main>
    ${renderSiteFooter(data || { generatedAt: new Date().toISOString(), source: { label: "Blogger Takeout" } }, { stagelight: true })}
    <script>${renderArchiveSearchScript()}</script>
  </body>
</html>
`;
}

// Client-side title search for the Archive index. Hides non-matching rows and
// collapses any year group left with no visible posts. Modeled on the Lyrics &
// Chords / Tour hub search scripts.
function renderArchiveSearchScript() {
  return `(() => {
    const input = document.getElementById("archive-search");
    const rows = [...document.querySelectorAll(".archive-row")];
    const groups = [...document.querySelectorAll(".archive-year")];
    const count = document.getElementById("archive-count");
    const empty = document.getElementById("archive-empty");
    const total = rows.length;
    const base = count.textContent;
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      rows.forEach((row) => {
        const hit = !q || row.dataset.title.includes(q);
        row.hidden = !hit;
        if (hit) shown++;
      });
      groups.forEach((group) => {
        group.hidden = ![...group.querySelectorAll(".archive-row")].some((row) => !row.hidden);
      });
      empty.hidden = shown !== 0;
      count.textContent = q ? shown + " of " + total + " posts" : base;
    };
    input.addEventListener("input", apply);
  })();`;
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
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
    <link rel="preload" href="/assets/milkrun.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/Panic-Hand.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/stagelight.css">
  </head>
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
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
    ${renderSiteFooter(data || { generatedAt: new Date().toISOString(), source: { label: "Blogger Takeout" } }, { stagelight: true })}
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
  <body class="stagelight">
    ${renderSiteHeader({ stagelight: true, data })}
    <main class="archive-main">
      <article class="archive-page">
        <p><a href="${escapeAttr(targetPath)}">${escapeHtml(title)}</a></p>
      </article>
    </main>
    ${renderSiteFooter(data || { generatedAt: new Date().toISOString(), source: { label: "Blogger Takeout" } }, { stagelight: true })}
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
    <meta property="og:image:alt" content="Burnthday — the Widespread Panic spread sheet, 698 songs and 158 tours">
    <meta property="og:site_name" content="Burnthday">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(data.site.title)} by Burnthday">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="https://burnthday.com/assets/social-card.png">
    <meta name="twitter:image:alt" content="Burnthday — the Widespread Panic spread sheet, 698 songs and 158 tours">
    <link rel="canonical" href="https://burnthday.com/">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/assets/marker-1.png" sizes="any">
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
      <h1 class="sr-only">WIDESPREAD PANIC ${escapeHtml(String(data.site.year))} TOUR</h1>
      ${renderHomeSectionNav(data)}
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
      ${renderNickRankingScript()}
      ${renderSetlistExpandScript()}
      ${renderStatsAutoCollapseScript()}
      ${renderHomeNavScript()}
      ${renderHeroModalScript()}
      ${renderStrikeScriptBody()}
      ${renderCustomSelectScript()}
    </script>
  </body>
</html>
`;
}

// Draw the dry-erase strikes as they scroll into view. Gated behind .can-strike
// so no-JS (and no-IO) visitors see the strikes fully drawn from the start.
function renderStrikeScriptBody() {
  return `(() => {
    if (!("IntersectionObserver" in window)) return;
    const masks = document.querySelectorAll(".marker-mask");
    if (!masks.length) return;
    document.body.classList.add("can-strike");
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("draw");
          io.unobserve(entry.target);
        }
      }
    }, { rootMargin: "0px 0px -6% 0px" });
    masks.forEach((mask) => io.observe(mask));
  })();`;
}

// Client filter/sort for the merged "Most played with Nick Johnson" ranking. Reads the
// data-type / data-played / data-nick-count facets each row already carries, applies the
// type chips (All/Originals/Covers) and state toggles (Played/Not yet played/Everything),
// sorts by plays (default, descending) or title (A–Z), then renumbers the visible rows so
// the ranked column always reads 1..N. Self-contained; no-ops on pages without the feature.
function renderSetlistExpandScript() {
  return `(() => {
    const btn = document.querySelector("[data-setlist-expand]");
    const section = document.getElementById("setlists");
    if (!btn || !section) return;
    const label = btn.querySelector(".sea-label");
    btn.addEventListener("click", () => {
      const cards = [...section.querySelectorAll(".setlist-list .show-entry")];
      const anyClosed = cards.some((card) => !card.open);
      cards.forEach((card) => { card.open = anyClosed; });
      btn.setAttribute("aria-expanded", String(anyClosed));
      if (label) label.textContent = anyClosed ? "Collapse all" : "Open all setlists";
    });
  })();`;
}

// Sticky home section-nav: highlight the link whose section is in view. Subtle
// IntersectionObserver, guarded so no-IO visitors just get plain links.
// Hero interactions: stats expansion, card view-swap with FLIP motion on the
// card stack, cursor-tracking glint, and a spotlight tinted from the photo.
function renderHeroModalScript() {
  return `(() => {
    const hero = document.querySelector(".home-hero");
    if (!hero) return;
    const slots = [...hero.querySelectorAll(".hero-slot")];

    const activePanel = () => hero.querySelector(".hero-media-slot .hv.is-active .hero-stats-panel");
    const closeStats = () => {
      const panel = activePanel();
      const media = panel?.closest(".hero-media");
      if (!panel || !media || !media.classList.contains("stats-open")) return;
      media.classList.remove("stats-open");
      const done = () => { panel.hidden = true; panel.removeEventListener("transitionend", done); };
      panel.addEventListener("transitionend", done);
      setTimeout(done, 500);
      hero.querySelectorAll("[data-stats-open]").forEach((btn) => btn.setAttribute("aria-expanded", "false"));
    };
    hero.addEventListener("click", (event) => {
      const openBtn = event.target.closest("[data-stats-open]");
      const closeBtn = event.target.closest("[data-stats-close]");
      if (closeBtn) { closeStats(); return; }
      if (!openBtn) return;
      const panel = activePanel();
      const media = panel?.closest(".hero-media");
      if (!panel || !media) return;
      if (media.classList.contains("stats-open")) { closeStats(); openBtn.focus(); return; }
      panel.hidden = false;
      void panel.offsetHeight;
      media.classList.add("stats-open");
      openBtn.setAttribute("aria-expanded", "true");
      panel.querySelector(".hero-modal-x")?.focus();
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeStats(); });

    // View swap. Card stack animates with FLIP: remaining cards slide into the
    // vacated spot, the returning card fades in.
    let swapping = false;
    // rAF with a timeout fallback: frame-accurate when visible, never wedges when
    // the tab is throttled (backgrounded) and rAF stalls.
    const nextFrame = (fn) => {
      let done = false;
      const go = () => { if (done) return; done = true; fn(); };
      requestAnimationFrame(() => requestAnimationFrame(go));
      setTimeout(go, 140);
    };
    const afterFade = (el, fn) => {
      let done = false;
      const fin = () => { if (done) return; done = true; el.removeEventListener("transitionend", fin); fn(); };
      el.addEventListener("transitionend", fin);
      setTimeout(fin, 320);
    };
    const showView = (iso) => {
      if (swapping) return;
      swapping = true;
      closeStats();
      // Two frames guarantee the fade-out actually paints before the DOM swap.
      nextFrame(() => {
        slots.forEach((slot) => slot.classList.add("is-fading"));
        afterFade(slots[0], () => {
          slots.forEach((slot) => {
            slot.querySelectorAll(".hv").forEach((view) => {
              const on = view.dataset.view === iso;
              view.classList.toggle("is-active", on);
              view.hidden = !on;
            });
          });
          hero.querySelectorAll("[data-view-bg]").forEach((layer) => {
            const on = layer.dataset.viewBg === iso;
            layer.classList.toggle("is-active", on);
            if (on && layer.complete && layer.naturalWidth) tintFrom(layer);
            else if (on) layer.addEventListener("load", () => tintFrom(layer), { once: true });
          });
          void hero.offsetHeight;
          hero.dispatchEvent(new CustomEvent("viewchange"));
          nextFrame(() => {
            slots.forEach((slot) => slot.classList.remove("is-fading"));
            afterFade(slots[0], () => { swapping = false; });
          });
        });
      });
    };
    // Fixed rail: slots never move. The two context slots refill (quick content
    // fade) with the nearest shows before the active view; latest + upcoming
    // are pinned. The card matching the active view carries the current-ring.
    const meta = JSON.parse(document.getElementById("hero-card-meta")?.textContent || "{}");
    const slotA = hero.querySelector('[data-card-slot="a"]');
    const slotB = hero.querySelector('[data-card-slot="b"]');
    const upcomingCardEl = hero.querySelector(".hero-card-upcoming");
    const upcomingIso = upcomingCardEl?.dataset.viewBtn;
    const fillSlot = (slotEl, iso) => {
      if (!slotEl) return;
      if (!iso || !meta[iso]) { slotEl.hidden = true; return; }
      slotEl.hidden = false;
      if (slotEl.dataset.viewBtn === iso) return;
      slotEl.classList.add("is-refilling");
      const paint = () => {
        slotEl.dataset.viewBtn = iso;
        const m = meta[iso];
        const time = slotEl.querySelector(".sc-date");
        time.textContent = m.d; time.setAttribute("datetime", iso);
        slotEl.querySelector(".hc-place strong").textContent = m.c;
        slotEl.querySelector(".hc-place small").textContent = m.v + (m.n ? " · " + m.n : "");
        slotEl.classList.remove("is-refilling");
      };
      setTimeout(paint, 160);
    };
    const updateCards = (activeIso) => {
      const order = hero.querySelector(".hero-pager")?.dataset.pagerOrder.split(",") || [];
      // Pager order is oldest-first; the rail thinks newest-first.
      const posted = order.filter((iso) => iso !== upcomingIso).reverse();
      // Never show the two most recent setlists (the hero features them), the
      // active view itself, or run-mates from the active view's city.
      const cityOf = (iso) => String(meta[iso]?.c || "").split(",")[0];
      const activeCity = cityOf(activeIso);
      const pool = posted.filter((iso, index) =>
        index > 1 && iso !== activeIso && (!activeCity || cityOf(iso) !== activeCity));
      fillSlot(slotA, pool[0]);
      fillSlot(slotB, pool[1]);
      [slotA, slotB, upcomingCardEl].forEach((card) => {
        if (!card) return;
        const on = card.dataset.viewBtn === activeIso;
        card.classList.toggle("is-current", on);
        card.setAttribute("aria-pressed", String(on));
      });
    };
    hero.querySelector(".hero-cards")?.addEventListener("click", (event) => {
      const card = event.target.closest("[data-view-btn]");
      if (card && !card.classList.contains("is-current")) showView(card.dataset.viewBtn);
    });
    hero.addEventListener("viewchange", () => updateCards(hero.querySelector(".hero-lock-slot .hv.is-active")?.dataset.view || ""));
    updateCards(hero.querySelector(".hero-lock-slot .hv.is-active")?.dataset.view || "");

    // Date pager: walks every view chronologically and wraps at both ends.
    const pagerEl = hero.querySelector(".hero-pager");
    if (pagerEl) {
      const order = pagerEl.dataset.pagerOrder.split(",");
      const currentIso = () => hero.querySelector(".hero-lock-slot .hv.is-active")?.dataset.view || "";
      const step = (dir) => {
        const at = order.indexOf(currentIso());
        showView(order[(at + dir + order.length) % order.length]);
      };
      pagerEl.querySelector("[data-page-prev]")?.addEventListener("click", () => step(-1));
      pagerEl.querySelector("[data-page-next]")?.addEventListener("click", () => step(1));
      document.addEventListener("keydown", (event) => {
        if (event.target.closest("input, textarea, select")) return;
        if (event.key === "ArrowLeft") step(-1);
        else if (event.key === "ArrowRight") step(1);
      });
    }

    // Glint follows the cursor while hovering the stats button.
    hero.addEventListener("pointermove", (event) => {
      const btn = event.target.closest(".hero-stats-btn");
      if (!btn) return;
      const ring = btn.querySelector(".hsb-ring");
      if (!ring) return;
      const rect = btn.getBoundingClientRect();
      const angle = Math.atan2(event.clientY - (rect.top + rect.height / 2), event.clientX - (rect.left + rect.width / 2));
      ring.style.setProperty("--hsb-a", ((angle * 180 / Math.PI) + 450) % 360 + "deg");
    });

    // Spotlight tint: average the hero photo's color and warm/cool the glow to
    // match. Cross-origin-safe (falls back to the default tint on taint).
    function tintFrom(img) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 8; canvas.height = 8;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 8, 8);
        const px = ctx.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
        const n = px.length / 4;
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        const max = Math.max(r, g, b, 1);
        const boost = 200 / max;
        document.documentElement.style.setProperty("--hero-glow",
          "rgba(" + Math.min(255, Math.round(r * boost)) + "," + Math.min(255, Math.round(g * boost)) + "," + Math.min(255, Math.round(b * boost)) + ",0.12)");
      } catch (err) { /* tainted canvas: keep the default glow */ }
    }
    const heroImg = hero.querySelector(".hero-bg img");
    if (heroImg) {
      if (heroImg.complete && heroImg.naturalWidth) tintFrom(heroImg);
      else heroImg.addEventListener("load", () => tintFrom(heroImg), { once: true });
    }
  })();`;
}

function renderHomeNavScript() {
  return `(() => {
    const nav = document.querySelector(".home-nav");
    if (!nav || !("IntersectionObserver" in window)) return;
    const links = [...nav.querySelectorAll("a[data-nav-section]")];
    const byId = new Map(links.map((a) => [a.dataset.navSection, a]));
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        links.forEach((a) => a.classList.remove("is-active"));
        const link = byId.get(entry.target.id);
        if (link) link.classList.add("is-active");
      }
    }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });
    byId.forEach((_link, id) => { const el = document.getElementById(id); if (el) io.observe(el); });
  })();`;
}

// Auto-collapse an expanded per-card "Song stats" box once it scrolls out of view,
// compensating scroll so the page doesn't jump when a box above the viewport shrinks.
function renderStatsAutoCollapseScript() {
  return `(() => {
    if (!("IntersectionObserver" in window)) return;
    // Per-card setlist "Song stats" details: close when scrolled out of view.
    const stats = [...document.querySelectorAll("[data-sc-stats]")];
    if (stats.length) {
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const el = entry.target;
          if (!el.open || entry.isIntersecting) continue;
          const rect = el.getBoundingClientRect();
          const before = el.offsetHeight;
          el.open = false;
          const delta = el.offsetHeight - before;
          if (rect.bottom < 0) window.scrollBy(0, delta);
        }
      }, { threshold: 0 });
      stats.forEach((el) => io.observe(el));
    }
    // Expanded stat lists (Tour Stats table, Nick ranking): once you scroll past
    // them into the next section, re-collapse to the capped height so the long
    // list never trails behind you. Compensate scroll when the block is above the
    // viewport so the page doesn't lurch.
    const lists = [...document.querySelectorAll("[data-nick-scroll], [data-table-scroll]")];
    if (lists.length) {
      const io2 = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const wrap = entry.target;
          if (entry.isIntersecting || wrap.classList.contains("is-capped")) continue;
          if (entry.boundingClientRect.top > 0) continue; // only when scrolled past the top
          const btn = wrap.parentElement.querySelector("[data-nick-expand], [data-table-expand]");
          const before = wrap.getBoundingClientRect().top;
          wrap.classList.add("is-capped");
          if (btn) { btn.setAttribute("aria-expanded", "false"); btn.textContent = btn.dataset.expandLabel; }
          window.scrollBy(0, wrap.getBoundingClientRect().top - before);
        }
      }, { threshold: 0 });
      lists.forEach((el) => io2.observe(el));
    }
  })();`;
}

function renderNickRankingScript() {
  return `(() => {
    const feature = document.querySelector(".nick-feature");
    const list = feature && feature.querySelector(".nick-ranking");
    if (!list) return;
    const rows = [...list.children];
    const typeButtons = [...feature.querySelectorAll("[data-nick-type]")];
    const stateButtons = [...feature.querySelectorAll("[data-nick-state]")];
    const sortButtons = [...feature.querySelectorAll("[data-nick-sort]")];
    const status = feature.querySelector("[data-nick-status]");
    let type = "all";
    let state = "played";
    let sort = "plays";
    const apply = () => {
      const visible = rows.filter((row) => {
        const played = row.dataset.played === "yes";
        const typeOk = type === "all" || row.dataset.type === type;
        const stateOk = state === "everything" || (state === "played" ? played : !played);
        const ok = typeOk && stateOk;
        row.hidden = !ok;
        return ok;
      });
      visible.sort((a, b) => sort === "title"
        ? a.dataset.songTitle.localeCompare(b.dataset.songTitle)
        : Number(b.dataset.nickCount) - Number(a.dataset.nickCount) || a.dataset.songTitle.localeCompare(b.dataset.songTitle));
      visible.forEach((row, index) => {
        list.appendChild(row);
        const rank = row.querySelector(".nick-rank");
        if (rank) rank.textContent = String(index + 1);
      });
      if (status) status.textContent = visible.length + (visible.length === 1 ? " song" : " songs");
    };
    const wire = (buttons, set) => buttons.forEach((btn) => btn.addEventListener("click", () => {
      set(btn);
      buttons.forEach((b) => b.classList.toggle("is-active", b === btn));
      apply();
    }));
    wire(typeButtons, (btn) => { type = btn.dataset.nickType; });
    wire(stateButtons, (btn) => { state = btn.dataset.nickState; });
    wire(sortButtons, (btn) => { sort = btn.dataset.nickSort; });
    const nickScroll = feature.querySelector("[data-nick-scroll]");
    const nickExpand = feature.querySelector("[data-nick-expand]");
    nickExpand?.addEventListener("click", () => {
      // Collapsing shrinks the list above the button; compensate scroll so the
      // button (and the reader's eye) stays put instead of jumping to the footer.
      const before = nickExpand.getBoundingClientRect().top;
      const capped = nickScroll?.classList.toggle("is-capped");
      nickExpand.setAttribute("aria-expanded", String(!capped));
      nickExpand.textContent = capped ? nickExpand.dataset.expandLabel : nickExpand.dataset.collapseLabel;
      nickExpand.classList.toggle("is-pinned", !capped);
      if (capped) window.scrollBy(0, nickExpand.getBoundingClientRect().top - before);
    });
    apply();
  })();`;
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
          const baseSize = Number.parseFloat(window.getComputedStyle(song).fontSize) || 17;
          const minimumSize = song.classList.contains("is-hand-addon") ? 13 : 14;
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
        document.querySelectorAll(".nick-disclosure, .stats-disclosure, .setlist-archive-panel").forEach((panel) => panel.removeAttribute("open"));
      }

      document.querySelectorAll(".tour-table").forEach((table) => {
        const body = table.tBodies[0];
        const buttons = [...table.querySelectorAll("button[data-sort]")];
        const section = table.closest(".tour-stats");
        const showDd = section?.querySelector("[data-show-filter-dd]");
        const showValue = section?.querySelector("[data-show-filter-value]");
        const showOptions = [...(section?.querySelectorAll("[data-show-value]") || [])];
        const mobileSort = section?.querySelector("[data-mobile-sort]");
        const typeButtons = [...(section?.querySelectorAll("[data-type-filter]") || [])];
        const notPlayedToggle = section?.querySelector("[data-notplayed-toggle]");
        const status = section?.querySelector(".show-filter-status");
        const rarityFilter = section?.querySelector("[data-rarity-filter]");
        const rarityOptions = [...(section?.querySelectorAll("[data-rarity-option]") || [])];
        const rarityClear = section?.querySelector("[data-rarity-clear]");
        const rarityActive = section?.querySelector("[data-rarity-active]");
        let selectedShow = "";
        let selectedType = "all";
        let notPlayedOn = false;
        let sortKey = "count";
        let sortDirection = "descending";

        const compareRows = (left, right) => {
          const numeric = ["count", "frequency", "l100", "rarity", "heat"].includes(sortKey);
          const a = left.dataset[sortKey] || "";
          const b = right.dataset[sortKey] || "";
          const comparison = numeric ? Number(a) - Number(b) : a.localeCompare(b);
          return comparison * (sortDirection === "ascending" ? 1 : -1) || left.dataset.title.localeCompare(right.dataset.title);
        };

        const applyState = () => {
          const rows = [...body.rows];
          const selectedRarities = rarityOptions.filter((box) => box.checked).map((box) => box.value);
          let selectedCount = 0;
          let visibleCount = 0;
          rows.forEach((row) => {
            const matchesType = selectedType === "all" || row.dataset.type === selectedType;
            const matchesRarity = !selectedRarities.length || selectedRarities.includes(row.dataset.rarityTier);
            const matchesShow = !selectedShow || (row.dataset.shows || "").split(",").includes(selectedShow);
            const matchesPlayed = notPlayedOn ? row.dataset.played === "no" : row.dataset.played !== "no";
            const visible = matchesType && matchesRarity && matchesPlayed;
            row.hidden = !visible;
            if (visible) visibleCount += 1;
            row.classList.toggle("is-selected-show", Boolean(selectedShow && matchesShow && visible));
            if (selectedShow && matchesShow && visible) selectedCount += 1;
          });
          // Recency sort keeps the natural order (black above red) and scrolls to the
          // selection; every other sort floats the selected show's block to the top.
          const boostSelected = Boolean(selectedShow) && sortKey !== "last";
          rows.sort((left, right) => {
            const leftSelected = boostSelected && left.classList.contains("is-selected-show") ? 1 : 0;
            const rightSelected = boostSelected && right.classList.contains("is-selected-show") ? 1 : 0;
            return rightSelected - leftSelected || compareRows(left, right);
          }).forEach((row) => body.appendChild(row));
          if (selectedShow && sortKey === "last") {
            const wrap = table.closest("[data-table-scroll]");
            const firstSelected = body.querySelector("tr.is-selected-show:not([hidden])");
            if (wrap && firstSelected) wrap.scrollTo({ top: Math.max(firstSelected.offsetTop - 64, 0), behavior: "smooth" });
          }
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

        showOptions.forEach((option) => option.addEventListener("click", () => {
          selectedShow = option.dataset.showValue;
          if (section) section.dataset.hl = selectedShow ? (option.dataset.marker || "white") : "";
          showOptions.forEach((item) => item.classList.toggle("is-active", item === option));
          if (showValue) showValue.textContent = option.textContent;
          showDd?.removeAttribute("open");
          applyState();
        }));
        typeButtons.forEach((typeButton) => typeButton.addEventListener("click", () => {
          selectedType = typeButton.dataset.typeFilter;
          typeButtons.forEach((item) => item.classList.toggle("is-active", item === typeButton));
          applyState();
        }));
        notPlayedToggle?.addEventListener("click", () => {
          notPlayedOn = !notPlayedOn;
          notPlayedToggle.setAttribute("aria-pressed", String(notPlayedOn));
          notPlayedToggle.classList.toggle("is-active", notPlayedOn);
          if (notPlayedOn) {
            // Not-played songs never belong to a highlighted show; reset the show filter.
            selectedShow = "";
            if (section) section.dataset.hl = "";
            showOptions.forEach((item) => item.classList.toggle("is-active", item.dataset.showValue === ""));
            const allOption = showOptions.find((item) => item.dataset.showValue === "");
            if (showValue && allOption) showValue.textContent = allOption.textContent;
          }
          applyState();
        });
        rarityOptions.forEach((box) => box.addEventListener("change", applyState));
        rarityClear?.addEventListener("click", () => {
          rarityOptions.forEach((box) => { box.checked = false; });
          applyState();
        });
        document.addEventListener("click", (event) => {
          [rarityFilter, showDd].forEach((dropdown) => {
            if (dropdown && dropdown.open && !dropdown.contains(event.target)) dropdown.removeAttribute("open");
          });
        });
        mobileSort?.addEventListener("cs:change", (event) => {
          sortKey = event.detail.value;
          sortDirection = sortKey === "title" ? "ascending" : "descending";
          applyState();
        });
        buttons.forEach((button) => button.addEventListener("click", () => {
          const header = button.closest("th");
          const current = header.getAttribute("aria-sort");
          sortKey = button.dataset.sort;
          sortDirection = current === "ascending" ? "descending" : "ascending";
          buttons.forEach((item) => {
            item.closest("th").removeAttribute("aria-sort");
            item.querySelector("span").textContent = "↕";
          });
          header.setAttribute("aria-sort", sortDirection);
          button.querySelector("span").textContent = sortDirection === "ascending" ? "↑" : "↓";
          applyState();
        }));
        const tableScroll = section?.querySelector("[data-table-scroll]");
        const tableExpand = section?.querySelector("[data-table-expand]");
        tableExpand?.addEventListener("click", () => {
          const before = tableExpand.getBoundingClientRect().top;
          const capped = tableScroll?.classList.toggle("is-capped");
          tableExpand.setAttribute("aria-expanded", String(!capped));
          tableExpand.textContent = capped ? tableExpand.dataset.expandLabel : tableExpand.dataset.collapseLabel;
          tableExpand.classList.toggle("is-pinned", !capped);
          if (capped) window.scrollBy(0, tableExpand.getBoundingClientRect().top - before);
        });
        const tonight = section?.querySelector("[data-tonight]");
        const tonightToggle = section?.querySelector("[data-tonight-toggle]");
        tonightToggle?.addEventListener("click", () => {
          const open = tonight.classList.toggle("is-open");
          tonightToggle.setAttribute("aria-expanded", String(open));
        });
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
  const megaLinks = primaryNavItems.map(([text, href]) => {
    const link = `<a class="mega-link" href="${escapeAttr(href)}">${escapeHtml(text)}</a>`;
    const subs = navSubLinks[text];
    if (!subs) return link;
    return link + subs.map(([label, anchor]) => `<a class="mega-sub" href="${escapeAttr(anchor)}">${escapeHtml(label.replace("{YEAR}", String(data?.site?.year || new Date().getFullYear())))}</a>`).join("");
  }).join("");
  const latestCol = featured ? `<div class="mega-col">
      <div class="mega-col-head"><p class="mega-label">Latest Show</p><a class="mega-more" href="/#latest-setlist">View Setlist</a></div>
      <div class="mega-show">
        ${featured.image ? `<a class="mega-show-photo" href="/#latest-setlist" tabindex="-1" aria-hidden="true"><img src="${escapeAttr(featured.image)}" alt="" loading="lazy" decoding="async"></a>` : ""}
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
  <a class="brand" href="/" aria-label="Burnthday home">
    <img class="brand-logo-sl" src="/assets/brand/burnthday-eater.svg" alt="" aria-hidden="true">
  </a>
  <div class="head-actions">
    <button type="button" class="head-search" data-search-open aria-haspopup="dialog" aria-controls="site-search" aria-keyshortcuts="Meta+K Control+K" aria-label="Search Burnthday">
      <svg class="head-search-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <span class="head-search-label">Search</span>
      <kbd class="head-search-kbd" aria-hidden="true"><span class="head-search-cmd">⌘</span>K</kbd>
    </button>
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
        <a href="https://www.facebook.com/burnthday" aria-label="Burnthday on Facebook"><span class="social-mark facebook" aria-hidden="true">f</span></a>
        <a href="https://twitter.com/burnthday" aria-label="Burnthday on X"><span class="social-mark x" aria-hidden="true">X</span></a>
        <a href="https://www.instagram.com/burnthday/" aria-label="Burnthday on Instagram"><span class="social-mark instagram" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2"/><circle cx="17.2" cy="6.8" r="1.3" fill="currentColor"/></svg></span></a>
      </nav>
      <a class="mega-cta" href="https://widespreadpanic.com/tour">Get Tickets</a>
    </div>
  </div>
</div>
${renderCommandPalette()}
<script>${renderStagelightHeaderScriptBody()}</script>
<script>${renderCommandPaletteScriptBody()}</script>`;
}

// Global command-palette (⌘K) markup. Rendered once per page (the stagelight
// header is on every page) so the search dialog + trigger are ubiquitous. The
// results list is populated client-side from /data/search-index.json, fetched
// lazily on first open. role=dialog + aria wiring for accessibility; the whole
// thing is inert (hidden) until opened.
function renderCommandPalette() {
  return `<div class="cmdk" id="site-search" hidden>
  <div class="cmdk-backdrop" data-search-close></div>
  <div class="cmdk-panel" role="dialog" aria-modal="true" aria-labelledby="cmdk-label">
    <h2 class="cmdk-label" id="cmdk-label">Search Burnthday</h2>
    <div class="cmdk-bar">
      <svg class="cmdk-bar-icon" width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <input type="search" class="cmdk-input" id="cmdk-input" placeholder="Search songs, albums, tours, origins…" autocomplete="off" autocorrect="off" spellcheck="false" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="cmdk-results" aria-label="Search the Burnthday catalog">
      <button type="button" class="cmdk-close" data-search-close aria-label="Close search"><kbd>Esc</kbd></button>
    </div>
    <div class="cmdk-results" id="cmdk-results" role="listbox" aria-label="Search results" tabindex="-1"></div>
    <p class="cmdk-hint" id="cmdk-hint">Type to search ${"the whole catalog"} — songs, albums, tours, and song origins.</p>
    <div class="cmdk-foot" aria-hidden="true">
      <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span><kbd>↵</kbd> open</span>
      <span><kbd>esc</kbd> close</span>
    </div>
  </div>
</div>`;
}

// Client behavior for the command palette. Zero dependencies: lazy-fetches
// /data/search-index.json once, does title-substring + word-prefix scoring,
// groups results by kind, renders rich song rows, and wires full keyboard
// navigation + a focus trap. Written in plain concatenated strings (no browser
// template literals) so it drops cleanly inside this Node template.
function renderCommandPaletteScriptBody() {
  return `(function () {
  var root = document.getElementById("site-search");
  if (!root || root.dataset.wired) return;
  root.dataset.wired = "1";
  var input = document.getElementById("cmdk-input");
  var results = document.getElementById("cmdk-results");
  var hint = document.getElementById("cmdk-hint");
  var panel = root.querySelector(".cmdk-panel");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var KIND_ORDER = ["song", "album", "tour", "origin", "lyrics", "archive"];
  var KIND_LABEL = { song: "Songs", album: "Albums", tour: "Tours", origin: "Song Origins", lyrics: "Lyrics", archive: "Archive" };
  var PER_GROUP = 8;
  var index = null, loading = null, lastReturn = null, options = [], active = -1, seq = 0;

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\\"/g, "&quot;"); }
  function fmt(n) { try { return Number(n || 0).toLocaleString("en-US"); } catch (e) { return String(n || 0); } }
  function norm(s) { return String(s || "").toLowerCase(); }

  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (loading) return loading;
    loading = fetch("/data/search-index.json").then(function (r) { return r.ok ? r.json() : []; }).then(function (d) { index = Array.isArray(d) ? d : []; return index; }).catch(function () { index = []; return index; });
    return loading;
  }

  function score(rec, q, terms) {
    if (!q) return 0;
    var t = norm(rec.t), s = 0;
    if (t === q) s += 1000;
    else if (t.indexOf(q) === 0) s += 500;
    else {
      var words = t.split(/[^a-z0-9]+/), pref = false;
      for (var i = 0; i < words.length; i++) { if (words[i] && words[i].indexOf(q) === 0) { pref = true; break; } }
      if (pref) s += 300;
      else if (t.indexOf(q) !== -1) s += 150;
    }
    if (s === 0 && terms.length > 1) {
      var all = true;
      for (var j = 0; j < terms.length; j++) { if (t.indexOf(terms[j]) === -1) { all = false; break; } }
      if (all) s += 90;
    }
    if (s === 0 && rec.tz && norm(rec.tz).indexOf(q) !== -1) s += 40;
    if (s > 0 && rec.k === "song" && rec.pl) s += Math.min(rec.pl / 2000, 25);
    return s;
  }

  function badge(cls, text) { return "<span class='cmdk-badge " + cls + "'>" + esc(text) + "</span>"; }

  function songRow(rec) {
    var meta = "<span class='cmdk-meta'>";
    meta += badge("cmdk-type", rec.ty || "");
    if (rec.pl != null) meta += "<span class='cmdk-plays'>" + fmt(rec.pl) + "<small>plays</small></span>";
    if (rec.ra) meta += "<span class='cmdk-rarity'>" + esc(rec.ra) + "</span>";
    if (rec.tt) meta += badge("cmdk-tour", "this tour");
    if (rec.bg) meta += badge("cmdk-bg", "Best Guess");
    meta += "</span>";
    var body = "<span class='cmdk-line'><span class='cmdk-title'>" + esc(rec.t) + "</span>" + meta + "</span>";
    if (rec.tz) body += "<span class='cmdk-teaser'>" + esc(rec.tz) + "</span>";
    var acts = "";
    if (rec.ly) acts += "<a class='cmdk-action' href='" + esc(rec.ly) + "' data-stop>Lyrics</a>";
    if (rec.og) acts += "<a class='cmdk-action' href='" + esc(rec.og) + "' data-stop>Origin</a>";
    if (rec.li) acts += "<a class='cmdk-action cmdk-listen' href='" + esc(rec.li) + "' target='_blank' rel='noopener noreferrer' data-stop>Listen <span aria-hidden='true'>\\u2197</span></a>";
    if (acts) body += "<span class='cmdk-actions'>" + acts + "</span>";
    return body;
  }

  function subRow(rec) {
    var sub = "";
    if (rec.k === "album") sub = "Album" + (rec.yr ? " \\u00b7 " + esc(rec.yr) : "");
    else if (rec.k === "tour") sub = (rec.yr ? esc(rec.yr) + " \\u00b7 " : "") + fmt(rec.sh || 0) + " shows";
    else if (rec.k === "origin") sub = "Song origin";
    else if (rec.k === "lyrics") sub = "Lyrics";
    else sub = "Archive";
    var thumb = "";
    if (rec.k === "album") thumb = "<span class='cmdk-thumb'>" + (rec.cv ? "<img src='" + esc(rec.cv) + "' alt='' loading='lazy'>" : "") + "</span>";
    return thumb + "<span class='cmdk-line'><span class='cmdk-title'>" + esc(rec.t) + "</span><span class='cmdk-sub'>" + sub + "</span></span>";
  }

  function render(q) {
    var terms = q.split(/\\s+/).filter(Boolean);
    var scored = [];
    if (q && index) {
      for (var i = 0; i < index.length; i++) {
        var sc = score(index[i], q, terms);
        if (sc > 0) scored.push({ r: index[i], s: sc });
      }
    }
    results.innerHTML = "";
    options = [];
    active = -1;
    if (!q) {
      hint.hidden = false;
      hint.textContent = index ? "Type to search the whole catalog \\u2014 songs, albums, tours, and song origins." : "Loading the catalog\\u2026";
      input.removeAttribute("aria-activedescendant");
      return;
    }
    var groups = {};
    for (var k = 0; k < scored.length; k++) { var kind = scored[k].r.k; (groups[kind] = groups[kind] || []).push(scored[k]); }
    var total = 0, frag = document.createDocumentFragment();
    for (var g = 0; g < KIND_ORDER.length; g++) {
      var kind2 = KIND_ORDER[g], list = groups[kind2];
      if (!list || !list.length) continue;
      list.sort(function (a, b) { return b.s - a.s || (b.r.pl || 0) - (a.r.pl || 0) || String(a.r.t).localeCompare(String(b.r.t)); });
      var section = document.createElement("div");
      section.className = "cmdk-group";
      var shown = list.slice(0, PER_GROUP), extra = list.length - shown.length;
      var head = "<div class='cmdk-group-head'>" + esc(KIND_LABEL[kind2]) + "<span class='cmdk-count'>" + list.length + "</span></div>";
      var rowsHtml = "";
      for (var s2 = 0; s2 < shown.length; s2++) {
        var rec = shown[s2].r, id = "cmdk-opt-" + (seq++) ;
        var cls = "cmdk-row cmdk-" + kind2;
        rowsHtml += "<div class='" + cls + "' id='" + id + "' role='option' aria-selected='false' data-url='" + esc(rec.u) + "'>" + (kind2 === "song" ? songRow(rec) : subRow(rec)) + "</div>";
      }
      if (extra > 0) rowsHtml += "<div class='cmdk-more'>+" + extra + " more " + esc(KIND_LABEL[kind2].toLowerCase()) + "</div>";
      section.innerHTML = head + rowsHtml;
      frag.appendChild(section);
      total += shown.length;
    }
    results.appendChild(frag);
    options = [].slice.call(results.querySelectorAll(".cmdk-row"));
    hint.hidden = total > 0;
    if (!total) { hint.hidden = false; hint.textContent = "No matches for \\u201c" + q + "\\u201d."; }
    options.forEach(function (el, i) {
      el.addEventListener("mousemove", function () { setActive(i); });
      el.addEventListener("click", function (ev) { var a = ev.target.closest("[data-stop]"); if (a) { ev.stopPropagation(); return; } go(el); });
    });
    if (options.length) setActive(0);
    else input.removeAttribute("aria-activedescendant");
  }

  function setActive(i) {
    if (active === i) return;
    if (options[active]) { options[active].classList.remove("is-active"); options[active].setAttribute("aria-selected", "false"); }
    active = i;
    var el = options[active];
    if (el) { el.classList.add("is-active"); el.setAttribute("aria-selected", "true"); input.setAttribute("aria-activedescendant", el.id); el.scrollIntoView({ block: "nearest" }); }
  }

  function go(el) { var url = el && el.getAttribute("data-url"); if (url) window.location.href = url; }

  var runTimer = null;
  function run(q) { render((q || "").trim().toLowerCase()); }
  function onInput() { render(input.value.trim().toLowerCase()); }

  function open() {
    if (!root.hidden) return;
    lastReturn = document.activeElement;
    root.hidden = false;
    document.body.classList.add("cmdk-lock");
    if (!reduce) root.classList.add("is-anim");
    requestAnimationFrame(function () { root.classList.add("is-open"); input.focus(); input.select(); });
    document.querySelectorAll("[data-search-open]").forEach(function (b) { b.setAttribute("aria-expanded", "true"); });
    loadIndex().then(function () { if (!root.hidden) render(input.value.trim().toLowerCase()); });
  }
  function close() {
    if (root.hidden) return;
    root.classList.remove("is-open");
    document.querySelectorAll("[data-search-open]").forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
    var done = function () { root.hidden = true; root.classList.remove("is-anim"); document.body.classList.remove("cmdk-lock"); };
    if (reduce) done(); else window.setTimeout(done, 190);
    if (lastReturn && lastReturn.focus) lastReturn.focus();
  }

  document.querySelectorAll("[data-search-open]").forEach(function (b) { b.addEventListener("click", function (e) { e.preventDefault(); open(); }); });
  root.querySelectorAll("[data-search-close]").forEach(function (b) { b.addEventListener("click", function (e) { e.preventDefault(); close(); }); });
  input.addEventListener("input", onInput);

  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); if (options.length) setActive((active + 1) % options.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (options.length) setActive((active - 1 + options.length) % options.length); }
    else if (e.key === "Enter") { e.preventDefault(); if (options[active]) go(options[active]); }
    else if (e.key === "Home") { if (options.length) { e.preventDefault(); setActive(0); } }
    else if (e.key === "End") { if (options.length) { e.preventDefault(); setActive(options.length - 1); } }
  });

  root.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") {
      var f = panel.querySelectorAll("input, button, a[href]");
      f = [].slice.call(f).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  document.addEventListener("keydown", function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); root.hidden ? open() : close(); return; }
    if (e.key === "/" && !mod && root.hidden) {
      var t = e.target, tag = t && t.tagName ? t.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) return;
      e.preventDefault(); open();
    }
  });
})();`;
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
      const link = event.target.closest("a");
      if (!link) return;
      // Only close for in-page (hash) navigation. For a real cross-document
      // navigation we leave the overlay in place so it is captured by the view
      // transition and leaves WITH the old page — no flash of the menu-less page.
      const samePage = link.getAttribute("href")?.startsWith("#")
        || (link.pathname === window.location.pathname && link.hash);
      const noTransition = !document.startViewTransition
        || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (samePage || noTransition) setOpen(false);
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
          if (y > lastY + 6 && y > 180) { head.classList.add("is-hidden"); document.body.classList.add("nav-hidden"); }
          else if (y < lastY - 6 || y <= 180) { head.classList.remove("is-hidden"); document.body.classList.remove("nav-hidden"); }
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

function renderFooterSocialRow() {
  return `<nav class="social-links" aria-label="Follow Burnthday">
      <a href="https://www.facebook.com/burnthday" aria-label="Burnthday on Facebook"><span class="social-mark facebook" aria-hidden="true">f</span><span>Facebook</span></a>
      <a href="https://twitter.com/burnthday" aria-label="Burnthday on X"><span class="social-mark x" aria-hidden="true">X</span><span>X</span></a>
      <a href="https://www.instagram.com/burnthday/" aria-label="Burnthday on Instagram"><span class="social-mark instagram" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2"/><circle cx="17.2" cy="6.8" r="1.3" fill="currentColor"/></svg></span><span>Instagram</span></a>
    </nav>`;
}

function renderFooterColumns(year = new Date().getFullYear()) {
  return footerColumns.map(([label, links]) => `<nav class="footer-links" aria-label="${escapeAttr(label)}">
      <strong>${escapeHtml(label)}</strong>
      ${links.map(([text, href]) => `<a href="${escapeAttr(href)}">${escapeHtml(text.replace("{YEAR}", String(year)))}</a>`).join("")}
    </nav>`).join("\n    ");
}

function renderFooterBottom(year) {
  return `<div class="footer-bottom">
      <p class="footer-sources">Setlist data via <a href="https://www.setlist.fm/" rel="noopener">setlist.fm</a>, <a href="https://widespreadpanic.com/" rel="noopener">widespreadpanic.com</a>, and <a href="http://everydaycompanion.com/" rel="noopener">everydaycompanion.com</a></p>
      <div class="footer-bottom-links">
        <span class="footer-copy">© ${escapeHtml(String(year))} Burnthday</span>
        <a class="footer-privacy" href="/privacy/">Privacy</a>
        <a class="site-credit" href="https://gnarlywhal.com">Site by Gnarlywhal</a>
        <a class="back-top" href="#top" aria-label="Back to top"><span aria-hidden="true">↑</span></a>
      </div>
    </div>`;
}

function renderSiteFooter(data, options = {}) {
  const year = data?.site?.year || new Date().getFullYear();
  if (options.stagelight) {
    return `<footer class="site-foot">
  <div class="site-foot-inner">
    <div class="footer-lead">
      <a class="footer-brand" href="/"><img class="footer-mark" src="/assets/brand/burnthday-eater.svg" alt="Burnthday"></a>
      <p class="footer-identity">Burnthday's Panic Spread Sheet</p>
      <p>The same song list the band uses to make setlists, with ${year} tour data and more.</p>
      ${renderFooterSocialRow()}
    </div>
    ${renderFooterColumns(year)}
    ${renderFooterBottom(year)}
  </div>
</footer>`;
  }
  return `<footer class="site-foot">
  <div class="site-foot-inner">
    <div class="footer-lead">
      <a class="footer-brand" href="/">BURNTHDAY</a>
      <p>The working Widespread Panic song list, setlists, and tour data.</p>
      ${renderFooterSocialRow()}
    </div>
    ${renderFooterColumns(year)}
    ${renderFooterBottom(year)}
  </div>
</footer>`;
}

function renderNavLinks(items, className, label, withPipes = false) {
  const links = items.map(([text, href]) => `<a href="${escapeAttr(href)}">${escapeHtml(text)}</a>`);
  const html = withPipes ? links.join("<span>|</span>") : links.join("");
  return `<nav class="${escapeAttr(className)}" aria-label="${escapeAttr(label)}">${html}</nav>`;
}

// Stripe-style intro line: bold lead, then a greyed continuation naming when and
// where the next show is ("...for tonight's show at Sacramento's Channel 24.").
function renderBoardIntro(data) {
  const latest = data.setlists?.[0];
  const upcoming = (data.site.isShowDayPreview ? data.site.featuredShow : null)
    || (data.tourDates || []).find((entry) => !entry.isPosted && entry.isoDate > (latest?.isoDate || ""));
  let where = "the next show";
  if (upcoming) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const days = Math.round((new Date(`${upcoming.isoDate}T12:00:00Z`) - new Date(`${todayIso}T12:00:00Z`)) / 86400000);
    const when = days <= 0 ? "tonight's" : days === 1 ? "tomorrow's" : days < 7 ? `${weekdayName(upcoming.isoDate)}'s` : "next week's";
    const city = clean(String(upcoming.location).split(",")[0]) || upcoming.location;
    where = `${when} show at ${city}'s ${upcoming.venue}`;
  }
  const legend = data.site.markerLegend || [];
  // Right-edge "dry-out" angle varies per stroke so the row reads hand-made.
  const cuts = ["96%", "94%", "97%", "95%"];
  const swipes = legend.map((item, index) => {
    // Black lifts to charcoal so the stroke reads on the near-black page (the
    // clip-path diagonal eats box-shadow rings, so no outline is available).
    const raw = STRIKE_COLORS[item.asset] || "#131313";
    const color = raw === "#131313" ? "#26262b" : raw;
    const shortDate = isoToShortDate(item.isoDate);
    const location = item.label.startsWith(shortDate) ? item.label.slice(shortDate.length).trim() : item.label;
    const city = clean(String(location).split(",")[0]) || location;
    const numeral = (location.match(/\b([IVX]+)$/) || [])[1] || "";
    const run = numeral ? ` ${romanToNumber(numeral)}` : "";
    return `<li class="bi-swipe" style="--mc:${color}; --cut:${cuts[index] || "96%"}" data-date="${escapeAttr(item.isoDate)}"><b>${escapeHtml(city)}${run}</b></li>`;
  }).join("");
  return `<div class="board-intro">
    <div class="bi-copy">
      <h2 class="board-intro-line"><span class="bi-lead">Widespread Panic song possibilities</span> <span class="bi-rest">for ${escapeHtml(where)}. Every song on the table, the last four shows marked out in color, and how many times each has been played this year.</span></h2>
    </div>
    ${legend.length ? `<ol class="bi-swipes" aria-label="Marker colors, most recent show first">${swipes}</ol>` : ""}
  </div>`;
}

function renderRotationBoard(data) {
  return `<section class="laminate primary-board" id="song-list">
  ${renderPrimaryBoardHeader(data)}
	  ${renderSongPanel("rotation-originals", "ORIGINALS", data.boards.rotationOriginals)}
	  ${renderSongPanel("rotation-covers", "COVERS", data.boards.rotationCovers)}
</section>`;
}

// Tonight's Odds — a ranked, play-likelihood panel shown only when there is a
// show today. Entertainment framing; the disclaimer makes the stakes clear.
function renderTonightOdds(odds) {
  if (!odds || !odds.songs?.length) return "";
  const tierLabel = { hot: "Hot", warm: "Warm", long: "Long shot" };
  const where = odds.city ? ` in ${odds.city}` : "";
  const rows = odds.songs.map((song, index) => {
    const reason = song.reason
      ? `<small class="tn-reason"><span class="tn-note-icon" aria-hidden="true">🎵</span>${escapeHtml(song.reason)}${Number.isFinite(song.reasonPct) ? ` <span class="tn-reason-pct">${song.reasonPct >= 0 ? "+" : ""}${song.reasonPct}%</span>` : ""}</small>`
      : "";
    return `<li class="tn-row tn-${song.tier}${song.reason ? " tn-has-reason" : ""}">
      <span class="tn-rank" aria-hidden="true">${index + 1}</span>
      <span class="tn-song">${escapeHtml(song.title)}${reason}<small class="tn-hint">${escapeHtml(song.hint)}</small></span>
      <span class="tn-heat"><span class="tn-tier">${tierLabel[song.tier] || ""}</span><b>${song.heat}</b></span>
    </li>`;
  }).join("");
  return `<div class="tonight-odds" data-tonight>
    <button type="button" class="tonight-toggle" data-tonight-toggle aria-expanded="false" aria-controls="tonight-panel">
      <span class="tn-live"><span class="live-dot" aria-hidden="true"></span>Tonight</span>
      <span class="tn-lead">Tonight's Odds — what might they play${escapeHtml(where)}?</span>
      <svg class="sc-chev" width="14" height="9" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="tonight-panel-wrap">
      <div class="tonight-panel" id="tonight-panel" data-tonight-panel>
        <ol class="tn-list">${rows}</ol>
        <p class="tn-disclaimer">The sheet decides nothing. This is just math having fun.</p>
      </div>
    </div>
  </div>`;
}

// The ONE dropdown component sitewide: the dark popover pattern that started as
// the homepage "Highlight a show" control, now the replacement for every native
// <select>. Managed instances own their value (data-value) and emit a "cs:change"
// event; keyboard + listbox semantics are wired by renderCustomSelectScript().
function renderCustomSelect({ hook, label, options, active = "" }) {
  const activeOpt = options.find((option) => option.value === active) || options[0];
  return `<details class="show-filter custom-select" data-cs data-cs-managed ${hook} data-value="${escapeAttr(activeOpt.value)}">
    <summary aria-label="${escapeAttr(label)}"><span>${escapeHtml(label)}</span><b class="sf-value" data-cs-value>${escapeHtml(activeOpt.label)}</b><svg class="sc-chev" width="12" height="8" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
    <div class="sf-pop">
      ${options.map((option) => `<button type="button" class="sf-option${option.value === activeOpt.value ? " is-active" : ""}" data-value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</button>`).join("")}
    </div>
  </details>`;
}

// Progressive enhancement for every custom dropdown ([data-cs]): listbox ARIA,
// arrow/Home/End/Enter/Escape keyboard nav, outside-click close, and — for
// managed instances — value tracking + a cs:change event. Unmanaged instances
// (the homepage show-filter, whose option clicks are handled by the stats
// script) get the keyboard + ARIA layer only. The selected option is always the
// visibly highlighted .is-active row.
function renderCustomSelectScript() {
  return `(() => {
    document.querySelectorAll("[data-cs]").forEach((dd) => {
      const summary = dd.querySelector("summary");
      const pop = dd.querySelector(".sf-pop");
      const options = [...dd.querySelectorAll(".sf-option")];
      if (!summary || !pop || !options.length) return;
      const managed = dd.hasAttribute("data-cs-managed");
      const valueEl = dd.querySelector("[data-cs-value]");
      summary.setAttribute("aria-haspopup", "listbox");
      summary.setAttribute("aria-expanded", "false");
      pop.setAttribute("role", "listbox");
      pop.setAttribute("aria-label", summary.getAttribute("aria-label") || "");
      options.forEach((opt) => {
        opt.setAttribute("role", "option");
        opt.setAttribute("aria-selected", opt.classList.contains("is-active") ? "true" : "false");
      });
      dd.addEventListener("toggle", () => {
        summary.setAttribute("aria-expanded", String(dd.open));
        if (dd.open) (options.find((o) => o.classList.contains("is-active")) || options[0]).focus();
      });
      if (managed) options.forEach((opt) => opt.addEventListener("click", (event) => {
        event.preventDefault();
        options.forEach((o) => { o.classList.toggle("is-active", o === opt); o.setAttribute("aria-selected", o === opt ? "true" : "false"); });
        if (valueEl) valueEl.textContent = opt.textContent;
        dd.dataset.value = opt.dataset.value || "";
        dd.dispatchEvent(new CustomEvent("cs:change", { detail: { value: dd.dataset.value } }));
        dd.removeAttribute("open");
        summary.focus();
      }));
      pop.addEventListener("keydown", (event) => {
        const i = options.indexOf(document.activeElement);
        if (event.key === "ArrowDown") { event.preventDefault(); (options[i + 1] || options[options.length - 1]).focus(); }
        else if (event.key === "ArrowUp") { event.preventDefault(); (options[i - 1] || options[0]).focus(); }
        else if (event.key === "Home") { event.preventDefault(); options[0].focus(); }
        else if (event.key === "End") { event.preventDefault(); options[options.length - 1].focus(); }
        else if (event.key === "Escape") { event.preventDefault(); dd.removeAttribute("open"); summary.focus(); }
      });
    });
    document.addEventListener("click", (event) => {
      document.querySelectorAll("[data-cs][open]").forEach((dd) => { if (!dd.contains(event.target)) dd.removeAttribute("open"); });
    });
  })();`;
}

function renderTourStats(data) {
  const shows = data.totals.postedSetlists;
  const plays = data.totals.currentTourPlays;
  const unique = data.totals.currentTourSongs;
  const average = shows ? (plays / shows).toFixed(1) : "0";
  const songs = [...(data.catalog || [])]
    .filter((song) => song.playedThisTour && song.tourCount > 0)
    .sort((left, right) => right.tourCount - left.tourCount || left.title.localeCompare(right.title));
  const sheetSongs = [...(data.boards?.rotationOriginals || []), ...(data.boards?.rotationCovers || [])];
  const notPlayed = sheetSongs
    .filter((song) => !song.playedThisTour)
    .sort((left, right) => left.title.localeCompare(right.title));
  const showDatesBySong = new Map();
  for (const show of data.setlists || []) {
    const showSongs = new Set((show.sets || []).flatMap((set) => set.songTitles || splitDisplaySetSongs(set.songs)).map(normalizeTitle));
    for (const key of showSongs) {
      if (!showDatesBySong.has(key)) showDatesBySong.set(key, []);
      showDatesBySong.get(key).push(show.isoDate);
    }
  }
  // Color-coded left-rail: each of the last four shows a song appeared in gets one
  // segment in that show's canonical marker color, always visible (not just on select).
  const lastFour = (data.site.markerLegend || []).filter((mark) => mark.isoDate);
  const lastFourRail = (dates) => {
    const played = new Set(dates);
    return lastFour.filter((mark) => played.has(mark.isoDate)).map((mark) => mark.color.toLowerCase());
  };

  return `<section class="tour-stats" id="tour-stats">
  <details class="stats-disclosure" open>
  <summary class="section-heading data-heading">
    <h2>Tour stats</h2>
    <svg class="sc-chev" width="14" height="9" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </summary>
  <div class="stats-body">
  <div class="data-metrics" aria-label="Current tour summary">
    ${renderNickStat(shows, "shows played")}
    ${renderNickStat(unique, "unique songs")}
    ${renderNickStat(plays, "song plays")}
    ${renderNickStat(average, "songs per show")}
  </div>
  ${renderTonightOdds(data.tonightOdds)}
  <div class="data-toolbar" aria-label="Tour Stats filters">
    <details class="show-filter" data-show-filter-dd data-cs>
      <summary aria-label="Highlight a show"><span>Highlight a show</span><b class="sf-value" data-show-filter-value>All ${formatNumber(shows)} shows</b><svg class="sc-chev" width="12" height="8" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
      <div class="sf-pop">
        <button type="button" class="sf-option is-active" data-show-value="">All ${formatNumber(shows)} shows</button>
        ${(data.setlists || []).map((show) => {
          const legend = (data.site.markerLegend || []).find((mark) => mark.isoDate === show.isoDate);
          return `<button type="button" class="sf-option" data-show-value="${escapeAttr(show.isoDate)}" data-marker="${legend ? escapeAttr(legend.color.toLowerCase()) : ""}">${escapeHtml(`${show.date} · ${show.location}`)}</button>`;
        }).join("")}
      </div>
    </details>
    <div class="type-filter" role="group" aria-label="Filter songs by type">
      <button type="button" class="is-active" data-type-filter="all">All</button>
      <button type="button" data-type-filter="original">Originals</button>
      <button type="button" data-type-filter="cover">Covers</button>
    </div>
    <button type="button" class="np-toggle" data-notplayed-toggle aria-pressed="false">Not played</button>
    ${renderRarityFilter(songs)}
    <div class="mobile-sort">${renderCustomSelect({ hook: "data-mobile-sort", label: "Sort by", active: "count", options: [{ value: "count", label: "Most played" }, { value: "rarity", label: "Rarest" }, { value: "heat", label: "Longest wait" }, { value: "title", label: "Song name" }] })}</div>
    <span class="show-filter-status" aria-live="polite"></span>
  </div>
  <div class="tour-table-wrap is-capped" data-table-scroll>
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
        const railColors = lastFourRail(showDates);
        const railAttr = railColors.length ? ` data-lastfour="${escapeAttr(railColors.join(","))}"` : "";
        const rail = railColors.length ? `<span class="lf-rail" aria-hidden="true">${railColors.map((color) => `<i class="rail-${color}"></i>`).join("")}</span>` : "";
        return `<tr data-title="${escapeAttr(song.title.toLowerCase())}" data-count="${escapeAttr(String(song.tourCount))}" data-frequency="${escapeAttr(String(frequency))}" data-l100="${escapeAttr(String(song.l100 || 0))}" data-rarity="${escapeAttr(String(rarity.sortValue))}" data-rarity-tier="${escapeAttr(rarity.tier)}" data-heat="${escapeAttr(String(heat.score))}" data-last="${escapeAttr(song.effectiveLastIso || "")}" data-type="${escapeAttr(song.type.toLowerCase())}" data-shows="${escapeAttr(showDates.join(","))}"${railAttr} data-played="yes">
          <th scope="row">${rail}${escapeHtml(song.title)}</th>
          <td class="plays-cell">${formatNumber(song.tourCount)}</td>
          <td class="signal-cell rarity-cell"><strong><span class="rarity-symbol" aria-hidden="true">${renderRaritySymbol(rarity.tier)}</span>${escapeHtml(rarity.label)}</strong><small>${rarity.tier === "new" ? "new this tour" : rarity.tier === "bustout" || rarity.tier === "mega" ? `back after ${formatNumber(song.seedSlp || 0)} shows · LTP ${escapeHtml(song.seedLast || "")}` : `${formatNumber(song.l100 || 0)} in last 100; ${formatNumber(song.total || 0)} ever`}</small></td>
          <td class="signal-cell heat-cell"><strong>${formatNumber(song.effectiveSlp)} ${song.effectiveSlp === 1 ? "show" : "shows"} ago</strong><small>usual gap ${heat.expectedGap.toFixed(1)} shows</small></td>
          <td>${escapeHtml(song.lastDisplay)}</td>
        </tr>`;
      }).join("")}${notPlayed.map((song) => {
        const rarity = calculateRarity(song);
        const heat = calculateRotationHeat(song, shows);
        return `<tr data-title="${escapeAttr(song.title.toLowerCase())}" data-count="0" data-frequency="0" data-l100="${escapeAttr(String(song.l100 || 0))}" data-rarity="${escapeAttr(String(rarity.sortValue))}" data-rarity-tier="${escapeAttr(rarity.tier)}" data-heat="${escapeAttr(String(heat.score))}" data-last="${escapeAttr(song.effectiveLastIso || "")}" data-type="${escapeAttr(song.type.toLowerCase())}" data-shows="" data-played="no" hidden>
          <th scope="row">${escapeHtml(song.title)}</th>
          <td class="plays-cell">0</td>
          <td class="signal-cell rarity-cell"><strong><span class="rarity-symbol" aria-hidden="true">${renderRaritySymbol(rarity.tier)}</span>${escapeHtml(rarity.label)}</strong><small>${rarity.tier === "new" ? "new this tour" : `${formatNumber(song.l100 || 0)} in last 100; ${formatNumber(song.total || 0)} ever`}</small></td>
          <td class="signal-cell heat-cell"><strong>${song.effectiveSlp ? `${formatNumber(song.effectiveSlp)} ${song.effectiveSlp === 1 ? "show" : "shows"} ago` : "—"}</strong><small>not played this tour</small></td>
          <td>${escapeHtml(song.lastDisplay || "—")}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>
  </div>
  ${songs.length > 12 ? `<button type="button" class="stats-expand" data-table-expand aria-expanded="false" data-expand-label="Show all ${formatNumber(songs.length)} songs" data-collapse-label="Show fewer">Show all ${formatNumber(songs.length)} songs</button>` : ""}
  <details class="index-method">
    <summary><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="4.8" r="0.9" fill="currentColor"/></svg><span>What these mean</span></summary>
    <div><p><strong>Rarity</strong> is a simple tour-view badge for how unusual a song is right now: Common, Uncommon, Rare, Ultra Rare, or Hyper Rare, driven mostly by plays in the last 100 shows with lifetime play count as a small tie-breaker. Two gap tiers outrank them all: a song that returns after 200+ shows away (the Shelf cutoff) is a <strong>Bustout</strong>, and one back after 1,000+ shows is a <strong>Mega Bustout</strong>. The symbols follow trading-card language: a black circle, diamond, or star; two silver stars; three gold stars; a radiant star for a Bustout, doubled for a Mega. A song new this tour gets an open star until it has history.</p><p><strong>Last / usual gap</strong> compares how many shows ago the song was last played with its recent average gap. It is context, not a prediction.</p></div>
  </details>
  </div>
  </details>
</section>`;
}

const BUSTOUT_SLP = 200;
const MEGA_BUSTOUT_SLP = 1000;

function calculateRarity(song) {
  if (song.seedTotal === 0) return { score: null, sortValue: 101, label: "New", tier: "new" };
  // Gap tiers outrank frequency tiers: a song pulled after a 200-show
  // absence (the Shelf cutoff) is a Bustout no matter how often it ran before.
  if (song.playedThisTour && (song.seedSlp || 0) >= MEGA_BUSTOUT_SLP) {
    return { score: null, sortValue: 120, label: "Mega Bustout", tier: "mega" };
  }
  if (song.playedThisTour && (song.seedSlp || 0) >= BUSTOUT_SLP) {
    return { score: null, sortValue: 110, label: "Bustout", tier: "bustout" };
  }
  const recentScarcity = 1 - Math.min((song.l100 || 0) / 25, 1);
  const lifetimeScarcity = 1 - Math.min(Math.log10((song.total || 0) + 1) / 3, 1);
  const score = Math.round((recentScarcity * 0.9 + lifetimeScarcity * 0.1) * 100);
  const tier = score >= 85
    ? ["Hyper Rare", "hyper"]
    : score >= 70
      ? ["Ultra Rare", "ultra"]
      : score >= 50
        ? ["Rare", "rare"]
        : score >= 25
          ? ["Uncommon", "uncommon"]
          : ["Common", "common"];
  return { score, sortValue: score, label: tier[0], tier: tier[1] };
}

const RARITY_TIER_ORDER = [
  ["mega", "Mega Bustout"],
  ["bustout", "Bustout"],
  ["hyper", "Hyper Rare"],
  ["ultra", "Ultra Rare"],
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
  const burst = (x, fill) => `<g transform="translate(${x} 0)"><g stroke="${fill}" stroke-width="1.5" stroke-linecap="round"><line x1="10" y1="-3.2" x2="10" y2="-0.6"/><line x1="20.4" y1="4" x2="18.2" y2="5.3"/><line x1="20.4" y1="15" x2="18.2" y2="13.7"/><line x1="-0.4" y1="4" x2="1.8" y2="5.3"/><line x1="-0.4" y1="15" x2="1.8" y2="13.7"/></g>${star(0, 1.5, fill)}</g>`;
  if (tier === "common") return `<svg class="rarity-common" viewBox="0 0 20 19"><circle cx="10" cy="9.5" r="8" fill="${RARITY_INK}"/></svg>`;
  if (tier === "uncommon") return `<svg class="rarity-uncommon" viewBox="0 0 20 19"><polygon points="10,1 18.5,9.5 10,18 1.5,9.5" fill="${RARITY_INK}"/></svg>`;
  if (tier === "rare") return `<svg class="rarity-rare" viewBox="0 0 20 19">${star(0, 0, RARITY_INK)}</svg>`;
  if (tier === "ultra") return `<svg class="rarity-ultra" viewBox="0 0 42 19">${star(0, 0, RARITY_SILVER)}${star(22, 0, RARITY_SILVER)}</svg>`;
  if (tier === "hyper") return `<svg class="rarity-hyper" viewBox="0 0 42 30.5">${star(11, 0, RARITY_GOLD)}${star(0, 11.5, RARITY_GOLD)}${star(22, 11.5, RARITY_GOLD)}</svg>`;
  if (tier === "bustout") return `<svg class="rarity-bustout" viewBox="-2 -4.5 24 25">${burst(0, RARITY_GOLD)}</svg>`;
  if (tier === "mega") return `<svg class="rarity-mega" viewBox="-2 -4.5 46 25">${burst(0, RARITY_GOLD)}${burst(22, RARITY_GOLD)}</svg>`;
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
  ${renderBoardHeader("WOODSHED")}
  ${renderSongPanel("woodshed-originals", "ORIGINALS", data.boards.woodshedOriginals, { shelfMode: true, woodshedMode: true, columns: 3 })}
  ${renderSongPanel("woodshed-covers", "COVERS", data.boards.woodshedCovers, { shelfMode: true, woodshedMode: true, columns: 3 })}
</section>`;

  return `${renderSheetKey(data)}
  <div class="bento-grid" aria-label="Reference sheets">
    ${renderBentoCard("shelf", "The Shelf", shelfRows.length, "Not played in 200 shows — off the sheet, not forgotten.", shelfFacts)}
    ${renderBentoCard("purgatory", "Purgatory", purgRows.length, "Played once, ever — waiting on a second life.", purgFacts)}
    ${renderBentoCard("woodshed", "The Woodshed", woodCount, "In rotation, not yet played with Nick.", woodExtra)}
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
        document.body.classList.remove("bento-open");
      };
      cards.forEach((card) => card.addEventListener("click", () => {
        const wasOpen = card.getAttribute("aria-expanded") === "true";
        closeAll();
        if (!wasOpen) {
          card.setAttribute("aria-expanded", "true");
          const panel = document.getElementById("bento-panel-" + card.getAttribute("data-bento"));
          if (panel) { panel.hidden = false; document.body.style.overflow = "hidden"; document.body.classList.add("bento-open"); }
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
    <h2>Shelf watch</h2>
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
    <h2>Nick stats</h2>
    <span>${escapeHtml(String(data.site.year))} tour</span>
  </summary>
  <div class="nick-feature-body nick-two-col">
  <div class="nick-left">
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
  </div>
  <div class="nick-right">
    <div class="nick-controls" role="group" aria-label="Filter and sort songs played with Nick Johnson">
      <div class="type-filter nick-chip-group" role="group" aria-label="Filter by song type">
        <button type="button" class="is-active" data-nick-type="all">All</button>
        <button type="button" data-nick-type="original">Originals</button>
        <button type="button" data-nick-type="cover">Covers</button>
      </div>
      <div class="type-filter nick-chip-group" role="group" aria-label="Filter by play state">
        <button type="button" class="is-active" data-nick-state="played">Played</button>
        <button type="button" data-nick-state="woodshed">Not yet</button>
        <button type="button" data-nick-state="everything">All</button>
      </div>
      <div class="type-filter nick-chip-group" role="group" aria-label="Sort songs">
        <button type="button" class="is-active" data-nick-sort="plays">Plays</button>
        <button type="button" data-nick-sort="title">A–Z</button>
      </div>
      <span class="nick-ranking-status" data-nick-status aria-live="polite"></span>
    </div>
    <div class="nick-ranking-head" role="presentation" aria-hidden="true">
      <span class="nrh-col">#</span>
      <span class="nrh-col">Song</span>
      <span class="nrh-col nrh-plays">Plays</span>
    </div>
    <div class="nick-ranking-wrap is-capped" data-nick-scroll>
    ${renderNickRanking(rotation)}
    </div>
    <button type="button" class="stats-expand" data-nick-expand aria-expanded="false" data-expand-label="Show the full list" data-collapse-label="Show fewer">Show the full list</button>
  </div>
  </div>
  </details>
</section>`;
}

function renderNickStat(value, label) {
  return `<div class="nick-stat"><strong>${formatNumber(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

// One merged, filterable/sortable ranking of the full rotation. Every song ships in
// the DOM carrying its facets (data-type, data-played) and per-show count so the inline
// nick-ranking handler can filter (type + play state) and sort (plays / A–Z) without a
// refetch. Zero-play songs render hidden by default so the restrained view shows only
// songs actually played with Nick until "Not yet played" or "Everything" is chosen.
// Rows stay in rotation order (plays desc, alphabetical tie-break) for the no-JS default.
function renderNickRanking(songs) {
  return `<ol class="nick-ranking">${songs.map((song, index) => {
    const played = song.nickCount > 0;
    const type = song.type === "Cover" ? "cover" : "original";
    return `<li class="nick-row${played ? "" : " is-zero"}" data-type="${type}" data-song-title="${escapeAttr(song.title)}" data-nick-count="${escapeAttr(String(song.nickCount))}" data-played="${played ? "yes" : "no"}"${played ? "" : " hidden"}>
    <span class="nick-rank" aria-hidden="true">${index + 1}</span>
    <span class="nick-song"><strong>${escapeHtml(song.title)}</strong><small>${escapeHtml(song.type)}</small></span>
    <span class="nick-plays"><strong>${formatNumber(song.nickCount)}</strong><small>${song.nickCount === 1 ? "play" : "plays"}</small></span>
  </li>`;
  }).join("")}</ol>`;
}

function renderSheetKey(data) {
  // Marker color key lives in the board intro (bi-swipes); this section keeps
  // only the quiet "what everything means" disclosure.
  return `<section class="sheet-key" id="sheet-key">
    <details class="key-more">
    <summary class="link-quiet">What everything on the sheets means <svg class="sc-chev" width="12" height="8" viewBox="0 0 12 8" fill="none" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
    <div class="key-grid">
      <p><b>The band uses this color-coded song list</b> to pick covers and originals that haven't run in the last four shows. The tiny number beside a song counts its plays this tour.</p>
      <p><b>The Shelf holds songs 200 shows gone.</b> When one comes back it's a bustout, the pull every crowd hopes for. This sheet shows how deep the band can reach.</p>
      <p><b>Purgatory keeps the one-timers,</b> songs played exactly once, ever. Some are covers from a single wild night. A second play moves a song out, and it rarely comes.</p>
      <p><b>The Woodshed lists rotation songs</b> Nick Johnson hasn't played yet. It shrinks every night he digs deeper, and it's the cleanest read on how fast he's learning the book.</p>
    </div>
  </details>
</section>`;
}

function renderMarkerLegend(items = []) {
  if (!items.length) return "";
  return `<ol class="marker-legend">${items.map((item) => {
    const color = STRIKE_COLORS[item.asset];
    const swatch = color
      ? `<span class="legend-swipe" style="--mc:${color}"></span>`
      : `<img src="/assets/${escapeAttr(item.asset)}" alt="">`;
    return `<li>${swatch}<span><strong>${escapeHtml(item.color)}</strong><em>${escapeHtml(item.label)}</em></span></li>`;
  }).join("")}</ol>`;
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

// Dry-erase strike colors, one per show in the last-four legend (matches the
// retired marker-*.png scans).
const STRIKE_COLORS = {
  "marker-black.png": "#131313",
  "marker-green.png": "#47866a",
  "marker-blue.png": "#465692",
  "marker-red.png": "#d4514f"
};

function strikeHash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
}

// Translucent dry-erase swipe covering the whole title, with a chisel/diagonal
// right end — like the real marker. CSS clip-path (see .marker-ink) keeps the
// diagonal crisp at any width; the tint comes from the per-show legend color.
function renderStrikeMark(asset, seed, stackIndex = 0) {
  const color = STRIKE_COLORS[asset];
  if (!color) return `<span class="marker-mask"><img class="marker-img" src="/assets/${escapeAttr(asset)}" alt=""></span>`;
  const h = strikeHash(String(seed || ""));
  const variant = (h % 4) + 1;
  const delay = (h >> 4) % 7;
  const nudge = [0, 4, -4, 7][stackIndex % 4];
  return `<span class="marker-mask sv${variant}" style="--mc:${color};--sd:${delay * 0.04}s;--dy:${nudge}px"><span class="marker-ink"></span></span>`;
}

function renderSong(row, options = {}) {
  const stripeAsset = options.shelfMode && !options.woodshedMode && (row.playedFromShelf || row.playedFromPurgatory) ? "marker-black.png" : row.stripeAsset;
  const shelfDate = row.playedFromShelf || row.playedFromPurgatory ? displayDate(row.seedLast) : row.lastDisplay;
  const dateText = options.shelfMode ? shelfDate : row.isAddOn ? row.addOnDate || row.lastDisplay : "";
  const handClass = row.isAddOn ? " hand-addon" : "";
  const title = row.title.toUpperCase();
  const countValue = options.nickMode ? row.nickCount : options.shelfMode ? row.total : row.tourCount;
  const songClasses = ["rotation-song", dateText ? "has-date" : "", countValue > 0 ? "has-count" : "", row.isAddOn ? "is-hand-addon" : ""].filter(Boolean).join(" ");
  const strikeList = options.shelfMode && !options.woodshedMode && (row.playedFromShelf || row.playedFromPurgatory)
    ? ["marker-black.png"]
    : (row.strikeAssets && row.strikeAssets.length ? row.strikeAssets : (stripeAsset ? [stripeAsset] : []));
  const marker = strikeList.map((asset, index) => renderStrikeMark(asset, `${row.key || row.title}:${index}`, index)).join("");
  const count = countValue > 0 ? `<sup>${countValue}</sup>` : "";
  const date = dateText ? `<span class="date-sup${row.isAddOn ? " add-on-date" : ""}">${row.isAddOn ? `(${escapeHtml(dateText)})` : escapeHtml(dateText)}</span>` : "";

  return `<span class="${songClasses}" title="${escapeAttr(title)}"><span class="marker-wrap"><span class="marker-target"><span class="marker-text${handClass}">${escapeHtml(title)}</span>${marker}</span>${count}</span>${date}</span>`;
}

// Slim sticky in-page nav at the top of the homepage — three quiet section links.
// Sits under the sticky site header and rides up with it on scroll (body.nav-hidden).
function renderHomeSectionNav(data) {
  const links = [
    { id: "song-list", label: "Song possibilities" },
    { id: "tour-stats", label: "Tour stats" },
    { id: "setlists", label: `${escapeHtml(String(data.site.year))} setlists` }
  ];
  return `<nav class="home-nav" aria-label="Jump to a section">
    ${links.map((link) => `<a href="/#${link.id}" data-nav-section="${link.id}">${link.label}</a>`).join('<span class="home-nav-sep" aria-hidden="true">›</span>')}
  </nav>`;
}

// Home hero: the latest posted show, full width, with a blurred backdrop and the
// sharp photo framed at the top-right (renderShowCard's `latest` layout). A slim
// upcoming/next-show strip sits directly beneath it. The other run nights are NOT
// pinned here — they flow into the 2026 setlist feed below.
// Purpose-built homepage hero — a full-bleed <section>, NOT the collapsible
// .show-entry setlist card. Blurred show photo spans the whole viewport; the
// lockup + sharp framed photo + setlist ride the 1400 rail. No card chrome,
// no chevron, not collapsible.
// Per-show hero pieces: identity lock, music (setlist + footnote + stats button),
// media (photo + stats panel), and the highlights ticker. Each run night gets a
// full view; the night cards crossfade a view into place (never a half-swap where
// one show's setlist sits under another's title).
function renderHeroView(data, show, opts = {}) {
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
  const ariaHeading = escapeAttr(formatSetlistHeading(show));
  const relistenUrl = (data.relistenDates || new Set()).has(iso) ? relistenUrlFor(iso) : "";
  const chips = [
    show.streamUrl ? `<a class="sc-chip sc-chip-primary" href="${escapeAttr(show.streamUrl)}" aria-label="Listen to ${ariaHeading} at Nugs.net"><svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><path d="M1.5 1.2c0-.66.72-1.07 1.29-.73l8 4.8a.85.85 0 0 1 0 1.46l-8 4.8A.85.85 0 0 1 1.5 10.8V1.2Z" fill="currentColor"/></svg>nugs.net</a>` : "",
    relistenUrl ? `<a class="sc-chip sc-chip-glass sc-chip-relisten" href="${escapeAttr(relistenUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Listen to ${ariaHeading} on Relisten">Listen on Relisten</a>` : "",
    show.sourceUrl ? `<a class="sc-chip sc-chip-glass" href="${escapeAttr(show.sourceUrl)}" aria-label="Official setlist and photos for ${ariaHeading}">Photos</a>` : ""
  ].filter(Boolean).join("");
  const setRows = sets.map((set) => `<div class="sc-row"><span class="sc-label">${escapeHtml(formatSetLabel(set.label))}</span><p class="sc-prose">${renderSetSongs(set, annotations)}</p></div>`).join("");
  const pullGroups = hasSetlist ? computeShowPulls(data, show) : [];
  const ltpRows = hasSetlist ? computeLastPlayedRows(data, show) : [];

  // Ticker: pulls + 30-show-plus gaps + live debuts + editorial notes (no lineup boilerplate).
  const tickerItems = [];
  for (const group of pullGroups) {
    for (const song of group.songs) tickerItems.push(`<span class="tk-item">${renderRaritySymbol(group.tier)}<em>${escapeHtml(group.label)}</em><b>${escapeHtml(song)}</b></span>`);
  }
  for (const r of ltpRows) {
    if (r.gap !== null && r.gap >= 30) tickerItems.push(`<span class="tk-item"><em>Last</em><b>${escapeHtml(r.title)}</b><em>${formatNumber(r.gap)} shows ago</em></span>`);
    if (r.gap === null) tickerItems.push(`<span class="tk-item tk-debut"><em>Live debut</em><b>${escapeHtml(r.title)}</b></span>`);
  }
  const isLineupNote = (note) => /entire (show|night)|on guitar|sitting in for|filling in/i.test(note);
  const noteText = (note) => clean(String((note && typeof note === "object" ? note.text : note) || "").replace(/^\[|\]$/g, ""));
  for (const note of [...annotations.guestNotes, ...annotations.bracketNotes]) {
    const text = noteText(note);
    if (text && !isLineupNote(text)) tickerItems.push(`<span class="tk-item tk-note"><b>${escapeHtml(text)}</b></span>`);
  }
  const tickerSeq = tickerItems.length ? tickerItems.join('<span class="tk-sep" aria-hidden="true">·</span>') + '<span class="tk-sep" aria-hidden="true">·</span>' : "";
  const ticker = tickerItems.length
    ? `<div class="hero-ticker" aria-label="Show highlights"><div class="tk-track">${tickerSeq}${tickerSeq}</div></div>`
    : "";

  const lineupNotes = [...annotations.guestNotes, ...annotations.bracketNotes]
    .map(noteText)
    .filter((text) => text && isLineupNote(text));
  const footnote = lineupNotes.length
    ? `<p class="hero-footnote">${lineupNotes.map((text) => `[${escapeHtml(text)}]`).join(" ")}</p>`
    : "";

  const statCell = (r) => {
    const g = r.gap === null ? "Live debut" : r.gap === 0 ? "Also last show" : `${formatNumber(r.gap)} show${r.gap === 1 ? "" : "s"} ago`;
    const name = r.slug ? `<a href="/song/${escapeAttr(r.slug)}/">${escapeHtml(r.title)}</a>` : escapeHtml(r.title);
    const symbol = r.tier ? `<span class="rarity-symbol" aria-hidden="true">${renderRaritySymbol(r.tier)}</span>` : "";
    return `<li class="ltp-item">${symbol}<span class="ltp-song">${name}</span><span class="ltp-gap${r.gap === null || (r.gap || 0) >= 40 ? " is-rare" : ""}">${g}</span></li>`;
  };
  const rareCount = ltpRows.filter((r) => r.gap === null || (r.gap || 0) >= 40).length;
  const statsButton = ltpRows.length
    ? `<button type="button" class="hero-stats-btn" data-stats-open="${escapeAttr(iso)}" aria-expanded="false" aria-controls="hero-stats-panel-${escapeAttr(iso)}">Song stats<span>${formatNumber(ltpRows.length)} songs${rareCount ? ` · ${rareCount} deep pull${rareCount === 1 ? "" : "s"}` : ""}</span><i class="hsb-ring" aria-hidden="true"></i></button>`
    : "";
  const statsPanel = ltpRows.length
    ? `<div class="hero-stats-panel" id="hero-stats-panel-${escapeAttr(iso)}" role="region" aria-label="Song stats for ${ariaHeading}" hidden>
        <div class="hero-modal-head"><h3>Song stats</h3><span>${escapeHtml(show.date)} · ${escapeHtml(show.location)}</span><button type="button" class="hero-modal-x" data-stats-close aria-label="Close song stats">✕</button></div>
        <ol class="ltp-list">${ltpRows.map(statCell).join("")}</ol>
      </div>`
    : "";
  const credit = show.photoCredit ? `<figcaption class="hero-credit">Photo: ${escapeHtml(show.photoCredit)}</figcaption>` : "";
  const photo = show.image
    ? `<figure class="hero-photo"><img src="${escapeAttr(show.image)}" alt="${escapeAttr(`${show.date} ${show.location}`)}" crossorigin="anonymous" decoding="async"${opts.eager ? ' fetchpriority="high"' : ' loading="lazy"'}>${credit}</figure>`
    : "";
  return {
    iso,
    ariaHeading,
    lock: `<time class="sc-eyebrow" datetime="${escapeAttr(iso)}">${escapeHtml([weekday, longDate].filter(Boolean).join(" · "))}</time>
        <h2 class="sc-city">${escapeHtml(show.location)}</h2>
        <span class="sc-venue">${escapeHtml(venueLine)}</span>
        ${chips ? `<span class="sc-chips">${chips}</span>` : ""}`,
    music: `<div class="hero-sets sc-sets">${setRows}${annotations.guestNotes.length ? `<div class="sc-row sc-notes"><span class="sc-label" aria-hidden="true"></span><div class="setlist-annotations">${renderSetlistGuestNotes(annotations)}</div></div>` : ""}</div>${footnote}${statsButton}`,
    media: `<div class="hero-media">${photo}${statsPanel}</div>`,
    ticker
  };
}

// Overdue regulars for the upcoming show's "on the table" teaser: songs that
// usually run every N shows and are now well past that. Pure data, no invention.
function computeOnTheTable(data) {
  // "Plays about 1-in-N shows and it's been well past N": recent-frequency
  // regulars (last-100 rate) sitting far beyond their usual gap.
  return (data.catalog || [])
    .filter((song) => (song.l100 || 0) >= 6 && (song.effectiveSlp || 0) >= 20)
    .map((song) => ({ song, usualGap: 100 / song.l100, ratio: song.effectiveSlp / (100 / song.l100) }))
    .filter((entry) => entry.ratio >= 2)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 3);
}

// The upcoming show as a hero view: identity + stream links on the left, a
// data-driven "on the table" paragraph where the setlist will land, the show
// photo (when the venue shot exists) on the right.
function renderUpcomingHeroView(data, upcoming, isTonight) {
  const iso = upcoming.isoDate || "";
  const weekday = weekdayName(iso);
  const longDate = formatLongDate(iso || upcoming.date);
  const ariaHeading = escapeAttr(`${upcoming.date} ${upcoming.venue}, ${upcoming.location}`);
  const chips = [
    `<a class="sc-chip sc-chip-primary" href="https://nugs.net/widespreadpanic" target="_blank" rel="noopener noreferrer"><svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><path d="M1.5 1.2c0-.66.72-1.07 1.29-.73l8 4.8a.85.85 0 0 1 0 1.46l-8 4.8A.85.85 0 0 1 1.5 10.8V1.2Z" fill="currentColor"/></svg>Watch on nugs.net</a>`,
    `<a class="sc-chip sc-chip-glass" href="https://twitch.tv/widespreadpanichq" target="_blank" rel="noopener noreferrer">Twitch audio</a>`,
    `<a class="sc-chip sc-chip-glass" href="https://www.youtube.com/user/WidespreadPanicMusic" target="_blank" rel="noopener noreferrer">YouTube</a>`,
    upcoming.sourceUrl ? `<a class="sc-chip sc-chip-glass" href="${escapeAttr(upcoming.sourceUrl)}">Official page</a>` : ""
  ].filter(Boolean).join("");
  const table = computeOnTheTable(data);
  const tableSentences = table.map(({ song, usualGap }) =>
    `<b>${escapeHtml(song.title)}</b> runs about every ${Math.round(usualGap)} shows and it's been ${formatNumber(song.effectiveSlp)}`);
  const tableProse = table.length
    ? `<p class="hero-table-note"><span class="sc-label">On the table</span>${tableSentences.join(". ")}. The setlist posts here after the show, verified against the official page.</p>`
    : `<p class="hero-table-note"><span class="sc-label">On deck</span>The setlist posts here after the show, verified against the official page.</p>`;
  const credit = upcoming.photoCredit ? `<figcaption class="hero-credit">Photo: ${escapeHtml(upcoming.photoCredit)}</figcaption>` : "";
  const photo = upcoming.image
    ? `<figure class="hero-photo"><img src="${escapeAttr(upcoming.image)}" alt="${escapeAttr(`${upcoming.date} ${upcoming.location}`)}" crossorigin="anonymous" decoding="async">${credit}</figure>`
    : "";
  return {
    iso,
    ariaHeading,
    lock: `<time class="sc-eyebrow" datetime="${escapeAttr(iso)}">${escapeHtml([weekday, longDate].filter(Boolean).join(" · "))}${isTonight ? ' · <span class="hero-tonight">Tonight</span>' : ""}</time>
        <h2 class="sc-city">${escapeHtml(upcoming.location)}</h2>
        <span class="sc-venue">${escapeHtml(upcoming.venue)}</span>
        <span class="sc-chips">${chips}</span>`,
    music: tableProse,
    media: `<div class="hero-media">${photo}</div>`,
    ticker: ""
  };
}

function renderHomeHero(data) {
  const posted = data.setlists || [];
  const featured = posted[0];
  if (!featured) return "";
  // Every posted setlist is a hero view, so the date pager can walk the whole tour.
  const views = posted.map((entry, index) => ({ show: entry, view: renderHeroView(data, entry, { eager: index === 0 }), kind: "night" }));
  const preview = data.site.isShowDayPreview ? data.site.featuredShow : null;
  let upcoming = preview || (data.tourDates || []).find((entry) => !entry.isPosted && entry.isoDate > (featured.isoDate || ""));
  if (upcoming) {
    const extra = data.showOverrides?.[upcoming.isoDate] || {};
    upcoming = { ...upcoming, image: extra.image || upcoming.image, bgImage: extra.bgImage || upcoming.bgImage, photoCredit: extra.photoCredit || upcoming.photoCredit };
    views.push({ show: upcoming, view: renderUpcomingHeroView(data, upcoming, Boolean(preview)), kind: "upcoming" });
  }

  const slot = (kind) => views.map(({ view }, index) =>
    `<div class="hv${index === 0 ? " is-active" : ""}" data-view="${escapeAttr(view.iso)}"${index === 0 ? "" : " hidden"}>${view[kind]}</div>`
  ).join("");

  // Fixed four-slot rail: two contextual slots (content swaps, position never
  // moves), the latest show pinned third, tonight/upcoming pinned fourth. The
  // card matching the active view gets the red current-ring instead of hiding.
  const nightFor = (entry) => {
    try { const run = tourRunInfo(data.tourDates || [], entry); if (run && run.length > 1) return `Night ${run.number}`; } catch {}
    return "";
  };
  const cardMeta = {};
  for (const { show: entry, kind } of views) {
    if (kind === "upcoming") continue;
    cardMeta[entry.isoDate] = { d: entry.date, c: entry.location, v: entry.venue, n: nightFor(entry) };
  }
  const slotCard = (entry, extraClass = "", slotName = "") => `<button type="button" class="hero-card${extraClass}"${slotName ? ` data-card-slot="${slotName}"` : ""} data-view-btn="${escapeAttr(entry.isoDate)}" aria-pressed="false">
      <time class="sc-date" datetime="${escapeAttr(entry.isoDate)}">${escapeHtml(entry.date)}</time>
      <span class="hc-place"><strong>${escapeHtml(entry.location)}</strong><small>${escapeHtml(entry.venue)}${nightFor(entry) ? ` · ${nightFor(entry)}` : ""}</small></span>
      <span class="hc-go" aria-hidden="true">→</span>
    </button>`;
  // Context picks skip the two most recent setlists (the hero already features
  // them) and any run-mate from the featured show's city (Alex: redundant).
  const featCity = String(featured.location || "").split(",")[0];
  const contextShows = posted.slice(2)
    .filter((entry) => String(entry.location || "").split(",")[0] !== featCity)
    .slice(0, 2);
  const upDow = upcoming ? weekdayName(upcoming.isoDate || "").slice(0, 3).toUpperCase() : "";
  const upcomingCard = upcoming ? `<button type="button" class="hero-card hero-card-upcoming" data-view-btn="${escapeAttr(upcoming.isoDate)}" aria-pressed="false">
        <time class="sc-date" datetime="${escapeAttr(upcoming.isoDate || "")}">${escapeHtml(upcoming.date)}</time>
        <span class="hc-place"><strong>${escapeHtml(upcoming.location)}</strong><small>${escapeHtml(upcoming.venue)}</small></span>
        <span class="ns-flag${preview ? " is-tonight" : ""}">${preview ? '<span class="live-dot" aria-hidden="true"></span>Tonight' : `Next show · ${escapeHtml(upDow)}`}</span>
      </button>` : "";
  // Three cards only: two context slots + the upcoming show pinned last.
  const cards = [
    contextShows[0] ? slotCard(contextShows[0], "", "a") : "",
    contextShows[1] ? slotCard(contextShows[1], "", "b") : "",
    upcomingCard
  ].join("");
  const cardMetaJson = `<script type="application/json" id="hero-card-meta">${JSON.stringify(cardMeta).replace(/</g, "\\u003c")}</script>`;

  const bgFor = (entry) => entry.bgImage || entry.image || "";
  const bgLayers = views.map(({ show: entry, view }, index) => {
    const src = bgFor(entry) || bgFor(featured);
    return src ? `<img class="hero-bg-layer${index === 0 ? " is-active" : ""}" data-view-bg="${escapeAttr(view.iso)}" src="${escapeAttr(src)}" alt="" crossorigin="anonymous"${index === 0 ? "" : ' loading="lazy"'} decoding="async">` : "";
  }).join("");
  const bg = bgLayers ? `<div class="hero-bg" aria-hidden="true">${bgLayers}</div>` : "";
  const bgSrc = bgFor(featured);
  // The blurred backdrop continues past the hero as a mirrored echo, so the next
  // section fades out of the same light instead of cutting to flat black.
  const echo = bgSrc ? `<div class="hero-echo" aria-hidden="true"><img src="${escapeAttr(bgSrc)}" alt="" crossorigin="anonymous" loading="lazy" decoding="async"></div>` : "";
  const pagerOrder = [...views].sort((a, b) => (a.view.iso || "").localeCompare(b.view.iso || "")).map(({ view }) => view.iso);
  const pager = pagerOrder.length > 1 ? `<div class="hero-pager" data-pager-order="${escapeAttr(pagerOrder.join(","))}">
      <button type="button" class="hero-page" data-page-prev aria-label="Earlier show">&#8249;</button>
      <button type="button" class="hero-page" data-page-next aria-label="Later show">&#8250;</button>
    </div>` : "";
  return `<section class="home-hero${featured.image ? "" : " no-image"}" id="latest-setlist" aria-label="Latest setlist: ${views[0].view.ariaHeading}">
    ${bg}
    <div class="hero-inner">
      <div class="hero-lockwrap">${pager}<div class="hero-slot hero-lock-slot">${slot("lock")}</div></div>
      <div class="hero-slot hero-media-slot">${slot("media")}</div>
      <div class="hero-slot hero-music-slot">${slot("music")}</div>
      <div class="hero-rail">
        <div class="hero-slot hero-ticker-slot">${slot("ticker")}</div>
        <div class="hero-cards">
          ${cards}
          <a class="link-quiet hero-all" href="/#setlists">All ${escapeHtml(String(data.site.year))} setlists <span aria-hidden="true">→</span></a>
        </div>
        ${cardMetaJson}
      </div>
    </div>
  </section>${echo}`;
}

function renderLatestSetlist(data) {
  return renderHomeHero(data);
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
    .filter((entry) => entry.rarity.tier !== "new" && entry.rarity.sortValue >= 70)
    .sort((left, right) => right.rarity.sortValue - left.rarity.sortValue);
  const groups = [];
  for (const pull of pulls) {
    let group = groups.find((entry) => entry.label === pull.rarity.label);
    if (!group) { group = { label: pull.rarity.label, tier: pull.rarity.tier, songs: [] }; groups.push(group); }
    group.songs.push(pull.title);
  }
  return groups;
}

// Shared: per-song last-time-played rows for a show, sorted longest gap first.
function computeLastPlayedRows(data, show) {
  const titles = [...new Set((show.sets || []).flatMap((set) => set.songTitles || []))];
  return titles.map((title) => {
    const key = normalizeTitle(title);
    const row = (data.catalog || []).find((entry) => entry.key === key);
    const gap = lastTimePlayedGap(data, key, show.isoDate);
    const slug = data.songSlugMap?.get(key);
    const tier = row ? calculateRarity(row).tier : null;
    return { title, slug, gap, tier };
  }).sort((a, b) => {
    if (a.gap === null) return -1; if (b.gap === null) return 1;
    return b.gap - a.gap;
  });
}

function renderShowLastPlayed(data, show) {
  const rows = computeLastPlayedRows(data, show);
  const cell = (r) => {
    const g = r.gap === null ? "Live debut" : r.gap === 0 ? "Also last show" : `${formatNumber(r.gap)} show${r.gap === 1 ? "" : "s"} ago`;
    const name = r.slug ? `<a href="/song/${escapeAttr(r.slug)}/">${escapeHtml(r.title)}</a>` : escapeHtml(r.title);
    return `<li class="ltp-item"><span class="ltp-song">${name}</span><span class="ltp-gap${r.gap === null || (r.gap || 0) >= 40 ? " is-rare" : ""}">${g}</span></li>`;
  };
  if (!rows.length) return "";
  const rare = rows.filter((r) => r.gap === null || (r.gap || 0) >= 40).length;
  return `<details class="sc-stats" data-sc-stats>
    <summary><span class="sc-stats-title">Song stats</span><span class="sc-stats-meta">${formatNumber(rows.length)} song${rows.length === 1 ? "" : "s"}${rare ? ` · ${rare} deep pull${rare === 1 ? "" : "s"}` : ""}</span><span class="sc-stats-chev" aria-hidden="true">›</span></summary>
    <div class="sc-stats-body">
      <p class="sc-stats-head"><span>Song</span><span>Last time played</span></p>
      <ol class="ltp-list">${rows.map(cell).join("")}</ol>
    </div>
  </details>`;
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
  const relistenUrl = (data.relistenDates || new Set()).has(iso) ? relistenUrlFor(iso) : "";
  const chips = [
    show.streamUrl ? `<a class="sc-chip sc-chip-primary" href="${escapeAttr(show.streamUrl)}" aria-label="Listen to ${ariaHeading} at Nugs.net"><svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><path d="M1.5 1.2c0-.66.72-1.07 1.29-.73l8 4.8a.85.85 0 0 1 0 1.46l-8 4.8A.85.85 0 0 1 1.5 10.8V1.2Z" fill="currentColor"/></svg>nugs.net</a>` : "",
    relistenUrl ? `<a class="sc-chip sc-chip-glass sc-chip-relisten" href="${escapeAttr(relistenUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Listen to ${ariaHeading} on Relisten">Listen on Relisten</a>` : "",
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
  const ltpRow = hasSetlist ? renderShowLastPlayed(data, show) : "";
  const body = setRows || previewNote || pullsRow || notes || ltpRow
    ? `<div class="sc-body"><div class="sc-sets">${setRows}${notes}${previewNote}${pullsRow}${ltpRow}</div></div>`
    : "";
  const loading = options.lazy ? ' loading="lazy"' : "";
  const priority = options.priority ? ' fetchpriority="high"' : "";
  const photo = show.image
    ? `<span class="sc-photo"><img src="${escapeAttr(show.image)}" alt="${escapeAttr(`${show.date} ${show.location}`)}" decoding="async"${loading}${priority}></span>`
    : "";
  const bg = show.image ? `<span class="sc-bg" aria-hidden="true"><img src="${escapeAttr(show.image)}" alt="" loading="lazy" decoding="async"></span>` : "";
  return `<details class="show-entry${options.latest ? " is-latest" : ""}${show.image ? "" : " no-image"}"${options.latest || options.open ? " open" : ""}${show.isoDate ? ` id="setlist-${escapeAttr(show.isoDate)}"` : ""} style="scroll-margin-top: 120px">
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
  // Only the single featured (latest posted) show is pinned in the hero, so it is
  // the only one held out of this feed. The rest of its run flows back in here.
  const skipDates = options.skipFeaturedRun && data.setlists[0]
    ? new Set([data.setlists[0].isoDate])
    : new Set();
  const setlists = data.setlists.filter((show) => !skipDates.has(show.isoDate));
  const postedLabel = skipDates.size ? `${setlists.length} older posted` : `${data.totals.postedSetlists} posted`;
  const upcomingDates = (data.tourDates || []).filter((date) => !date.isPosted);
  const upcomingBlock = upcomingDates.length ? `<div class="upcoming-dates" id="tour-dates">
    <div class="upcoming-heading"><h3>UPCOMING</h3><span>${formatNumber(upcomingDates.length)} shows ahead</span></div>
    <ol class="tour-dates">
      ${upcomingDates.map((date) => `<li class="is-upcoming">
        <time class="sc-date" datetime="${escapeAttr(date.isoDate || "")}">${escapeHtml(date.date)}</time>
        <span class="sc-place"><strong>${escapeHtml(date.location)}</strong><small>${escapeHtml(date.venue)}</small></span>
        <em class="up-flag">Upcoming</em>
      </li>`).join("")}
    </ol>
  </div><p class="upcoming-credit">Photo: Andy Tennille</p>` : "";
  return `<section class="setlist-section" id="setlists">
  <div class="section-heading">
    <h2>${escapeHtml(String(data.site.year))} setlists</h2>
    <button type="button" class="setlist-expand-all" data-setlist-expand aria-expanded="false"><span class="sea-label">Open all setlists</span><span class="sea-count">${escapeHtml(postedLabel)}</span></button>
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
  const cards = [
    {
      href: "/song-origins/",
      img: "/assets/song-origins/chilly-water.jpg",
      eyebrow: "Song Origins",
      title: "Where the songs come from",
      desc: "Sourced stories behind the catalog — quotes, not guesses.",
      tone: "photo"
    },
    {
      href: "/lyrics-chords/",
      img: "/assets/archive-media/dirty-side-down-cover.jpg",
      eyebrow: "Lyrics & Chords",
      title: "Words, chords, and tab",
      desc: "Every song, with our transcriptions where they exist.",
      tone: "cover"
    }
  ];
  return `<section class="cross-promo" aria-label="More from Burnthday">
  ${cards.map((card) => `<a class="xp-card xp-${card.tone}" href="${escapeAttr(card.href)}">
    <span class="xp-bg" aria-hidden="true"><img src="${escapeAttr(card.img)}" alt="" loading="lazy" decoding="async"></span>
    <span class="xp-body">
      <span class="xp-eyebrow">${escapeHtml(card.eyebrow)}</span>
      <span class="xp-title">${escapeHtml(card.title)}</span>
      <span class="xp-desc">${escapeHtml(card.desc)}</span>
    </span>
    <span class="xp-arrow" aria-hidden="true">→</span>
  </a>`).join("")}
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

// Structural classes used only by the secondary content pages. Hoisted out of
// the .laminate scope in renderStagelightCss so those pages keep their layout.
const CONTENT_PAGE_CSS_KEYS = [
  ".archive-main", ".archive-page", ".archive-content", ".archive-index", ".archive-title", ".archive-list", ".archive-tags",
  ".page-graphic-title", ".origin", ".shelf-info-page", ".shelf-current-update", ".legacy-shelf-notes", ".shelf-addition-group",
  ".rumors-page", ".tour-review", ".current-review-link", ".privacy-page", ".movement-", ".setlist-grid", ".setlist-card", ".setlist-image", ".setlist-text", ".setlist-copy", ".setlist-feature"
];

function renderStagelightCss() {
  const base = renderCss();
  const marker = "/* ============================================================\n   STAGELIGHT";
  const markerIdx = base.indexOf(marker);
  const legacy = markerIdx >= 0 ? base.slice(0, markerIdx) : base;
  const overrides = markerIdx >= 0 ? base.slice(markerIdx) : "";
  const fonts = (legacy.match(/@font-face[^}]*}/g) || []).join("\n");
  const rootBlock = legacy.slice(legacy.indexOf(":root {"), legacy.indexOf("}", legacy.indexOf(":root {")) + 1);
  const sheetSelf = extractCssBlocks(legacy, [".laminate"]);
  // Content pages (archive, origins, shelf, rumors, tour-in-review, privacy)
  // keep their legacy structure but at top level, so it isn't trapped in the
  // .laminate scope. body.stagelight overrides below recolor them for dark.
  const contentSelf = extractCssBlocks(legacy, CONTENT_PAGE_CSS_KEYS);
  const legacyScoped = `.laminate {\n${legacy.replace(/@font-face[^}]*}/g, "").replace(/:root\s*\{[^}]*\}/g, "")}\n}`;
  return `${fonts}\n${rootBlock}\n${STAGELIGHT_STRUCTURE}\n${sheetSelf}\n${contentSelf}\n${legacyScoped}\n${overrides}`;
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
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
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
.marker-legend .legend-swipe { width: 30px; height: 13px; flex: none; background: var(--mc); opacity: 0.62; mix-blend-mode: multiply; border-radius: 1px; clip-path: polygon(1% 12%, 99% 3%, 100% 82%, 93% 100%, 1% 92%); }
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
  font-family: "Geist", system-ui, sans-serif;
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
  font-family: "Geist", system-ui, sans-serif;
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
  font-family: "Geist", system-ui, sans-serif;
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
  font-family: "Geist", system-ui, sans-serif;
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
  font-family: "Geist", system-ui, sans-serif;
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

.marker-legend .legend-swipe {
  width: 38px;
  height: 14px;
  background: var(--mc);
  opacity: 0.62;
  mix-blend-mode: multiply;
  border-radius: 1px;
  clip-path: polygon(1% 12%, 99% 3%, 100% 82%, 93% 100%, 1% 92%);
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
  --song-font-size: 17px;
  display: flex;
  align-items: baseline;
  max-width: 100%;
  min-width: 0;
  min-height: 27px;
  margin: 0 0 6px;
  font-size: var(--song-font-size);
  text-transform: uppercase;
  line-height: 1.02;
  letter-spacing: -0.012em;
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
  left: -0.16em;
  right: -0.12em;
  top: -0.02em;
  bottom: -0.02em;
  overflow: visible;
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
  font-family: "Geist", system-ui, sans-serif;
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

.nick-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 28px;
}

.nick-controls .nick-ranking-status {
  margin-left: auto;
  color: var(--muted);
  font: 600 12px/1 var(--ui-font);
}

.nick-ranking-head {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  gap: 12px;
  margin-top: 16px;
  padding: 0 0 8px;
  border-bottom: 1px solid var(--line);
}

.nick-ranking-head .nrh-col {
  color: var(--muted);
  font: 500 11px/1 var(--ui-font);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.nick-ranking-head .nrh-plays {
  min-width: 50px;
  text-align: right;
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
  font-family: var(--sl-display, "Bricolage", "Geist", system-ui, sans-serif);
  font-size: var(--type-archive-title);
  line-height: 1.04;
  font-weight: 640;
  letter-spacing: -0.02em;
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
  font-family: var(--sl-display, "Bricolage", "Geist", system-ui, sans-serif);
  font-size: var(--type-archive-title);
  line-height: 1.04;
  font-weight: 640;
  letter-spacing: -0.02em;
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
  font-family: var(--sl-display, "Bricolage", "Geist", system-ui, sans-serif);
  font-size: 26px;
  line-height: 1.05;
  font-weight: 640;
  letter-spacing: -0.02em;
}

.movement-block {
  margin: 20px 0;
}

.movement-block h3 {
  margin: 0 0 8px;
  font-family: var(--sl-display, "Bricolage", "Geist", system-ui, sans-serif);
  font-size: 19px;
  line-height: 1.1;
  font-weight: 620;
  letter-spacing: -0.01em;
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
  font-family: "Geist", system-ui, sans-serif;
  font-weight: 600;
}

.review-top-songs span {
  color: var(--muted);
  margin-left: 6px;
}

.movement-list strong {
  font-family: "Geist", system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.2;
  font-weight: 600;
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
  font-family: var(--sl-mono, "Geist Mono", ui-monospace, monospace);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.origin-hero h1 {
  margin: 0;
  font-family: var(--sl-display, "Bricolage", "Geist", system-ui, sans-serif);
  font-size: 46px;
  line-height: 1;
  font-weight: 660;
  letter-spacing: -0.02em;
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
  font-family: var(--sl-display, "Bricolage", "Geist", system-ui, sans-serif);
  font-size: 19px;
  line-height: 1.1;
  font-weight: 600;
  letter-spacing: -0.01em;
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
  font-family: var(--sl-mono, "Geist Mono", ui-monospace, monospace);
  font-size: 13px;
  line-height: 1.7;
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
  grid-template-columns: minmax(260px, 1.5fr) repeat(3, minmax(120px, 1fr));
  gap: 40px 48px;
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

.footer-links {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.footer-links > strong {
  margin-bottom: 6px;
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
.footer-links a:focus-visible {
  text-decoration: underline;
}

.social-links {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
}

.social-links a {
  display: inline-flex;
  align-items: center;
}

/* Icon-only social row: keep labels for a11y + QA, hide visually. */
.social-links a > span:last-child {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
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

.footer-bottom {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 20px;
  margin-top: 12px;
  border-top: 1px solid var(--line);
  padding-top: 18px;
  color: var(--muted);
  font-size: 12px;
}

.footer-legal {
  display: flex;
  gap: 8px;
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.footer-sources {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.footer-sources a {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.footer-bottom-links {
  display: flex;
  align-items: baseline;
  gap: 20px;
  margin-left: auto;
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
    --song-font-size: 16.5px;
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
    --song-font-size: 16px;
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
    --song-font-size: 15px;
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
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 28px 24px;
  }

  .footer-lead,
  .footer-bottom {
    grid-column: 1 / -1;
  }

  .footer-legal {
    flex-wrap: wrap;
    gap: 4px 7px;
  }

  .footer-bottom-links {
    margin-left: 0;
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
  /* ---- HAIRLINES: exactly three border alphas site-wide ---- */
  --sl-line-faint: rgba(255, 255, 255, 0.05);   /* faint row dividers */
  --sl-line: rgba(255, 255, 255, 0.08);         /* default hairline */
  --sl-line-strong: rgba(255, 255, 255, 0.16);  /* hover / active / open borders */
  --sl-display: "Bricolage", "Geist", system-ui, sans-serif;
  --sl-mono: "Geist Mono", ui-monospace, monospace;
  /* ---- CANONICAL GLASS: background + blur(26px) saturate(1.4) + 1px var(--sl-line)
     border + var(--sl-r-lg) radius + var(--sl-shadow-1). See .sl-glass utility. ---- */
  --sl-glass: linear-gradient(180deg, rgba(28,28,31,0.55), rgba(18,18,21,0.42));
  /* ---- ELEVATION: three neutral recipes only (+ laminate is its own system) ---- */
  --sl-shadow-1: 0 24px 60px -28px rgba(0,0,0,0.75), 0 2px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07); /* subtle card */
  --sl-shadow-2: 0 24px 60px -18px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.08); /* raised / hover / popover */
  --sl-shadow-3: 0 40px 90px -30px rgba(0,0,0,0.9), 0 0 0 1px var(--sl-line), inset 0 1px 0 rgba(255,255,255,0.08); /* modal / laminate-level */
  --sl-glass-shadow: var(--sl-shadow-1); /* canonical glass elevation = shadow-1 */
  /* ---- RADII: sm / md / lg + pill (four values) ---- */
  --sl-r-sm: 6px;
  --sl-r-md: 12px;
  --sl-r-lg: 20px;
  --sl-r-pill: 999px;
  --sl-r: var(--sl-r-lg); /* legacy alias, unchanged 20px meaning */
  /* ---- TYPE SCALE (px, snapped literals): 12 / 13.5 / 15 / 17 / 21 / 26 / 34 / 46
     Intentional off-scale exceptions (snapping would shift visual hierarchy):
       - clamp() hero sizes (.tour-hero/.origin-hero/.nf-title/mega display) keep
         their fluid min/max endpoints so the desktop-active size doesn't jump;
       - .sc-city latest-show display headline (28/38/40/56) is its own step ramp;
       - .marker-legend + laminate/hand belong to the paper-sheet systems (untouched);
       - one 0.8em decorative bullet in .mega-sub. ---- */
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
body.stagelight ::selection { background: #d4514f; color: #f5f4f0; }

/* ---- CROSS-DOCUMENT PAGE TRANSITIONS (progressive enhancement) ---- */
@view-transition { navigation: auto; }
::view-transition-old(root) { animation: sl-vt-out 220ms ease both; }
::view-transition-new(root) { animation: sl-vt-in 220ms ease both; }
@keyframes sl-vt-out { to { opacity: 0; transform: translateY(-4px); } }
@keyframes sl-vt-in { from { opacity: 0; transform: translateY(6px); } }
/* The header persists continuously across navigations. */
body.stagelight .site-head { view-transition-name: site-header; }
@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
}
/* single keyboard-focus ring; outline follows each element's own border-radius */
body.stagelight :focus-visible { outline: 2px solid #d4514f; outline-offset: 2px; }
/* tabular figures everywhere numbers are read as data: stat tiles, counts,
   perf logs, tour stats, footprint numbers */
body.stagelight .song-stat, body.stagelight .nick-stat, body.stagelight .album-footprint,
body.stagelight .song-count, body.stagelight .bc-count, body.stagelight .tt-count,
body.stagelight .sr-plays, body.stagelight .rf-count, body.stagelight .sf-value,
body.stagelight .signal-cell, body.stagelight .origin-stats,
body.stagelight .perf-date, body.stagelight .perf-loc, body.stagelight .perf-tag,
body.stagelight .tour-toplist, body.stagelight .tour-ltp-list,
body.stagelight .tour-countline, body.stagelight .tl-ltp, body.stagelight .ti-meta,
body.stagelight .nick-rank, body.stagelight .sc-tier, body.stagelight .sr-plays small {
  font-variant-numeric: tabular-nums;
}

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
  background: linear-gradient(180deg, rgba(13,13,15,0.72), rgba(11,11,13,0.58));
  -webkit-backdrop-filter: blur(22px) saturate(1.5); backdrop-filter: blur(22px) saturate(1.5);
  border-bottom: 1px solid var(--sl-line); box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
  transition: transform 0.3s ease;
}
body.stagelight .site-head.is-hidden { transform: translateY(-102%); }
@media (prefers-reduced-motion: reduce) { body.stagelight .site-head { transition: none; } }
/* Anchor landings sat behind the fixed, sticky header (66px tall). Every in-page
   target reachable from the nav / mega-menu / footer / board cards gets a
   scroll-margin so it lands clear of the bar (header height + breathing room).
   Owner QA: anchored sections "open behind and under the menu." */
body.stagelight :is(
  #song-list, #setlists, #tour-stats, #latest-setlist,
  #shelf-sheet, #shelf-watch, #nick-johnson,
  #purgatory-sheet, #woodshed-sheet
) { scroll-margin-top: 96px; }
body.stagelight .head-actions { margin-left: auto; display: flex; align-items: center; gap: 12px; }
body.stagelight .head-cta {
  display: inline-flex; align-items: center; height: 40px; padding: 0 20px; border-radius: var(--sl-r-pill);
  font-size: 13.5px; font-weight: 580; color: var(--sl-ink);
  background: rgba(255,255,255,0.055); border: 1px solid var(--sl-line-strong);
  transition: background 0.18s ease, transform 0.18s ease;
}
body.stagelight .head-cta:hover { background: rgba(255,255,255,0.1); transform: translateY(-1px); }
body.stagelight .menu-toggle {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 42px; height: 42px; border-radius: var(--sl-r-md);
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

/* ---- COMMAND PALETTE TRIGGER (⌘K) ---- */
body.stagelight .head-search {
  display: inline-flex; align-items: center; gap: 9px; height: 40px; padding: 0 10px 0 13px;
  border-radius: var(--sl-r-pill); color: var(--sl-muted);
  background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line);
  font-size: 13px; cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease;
}
body.stagelight .head-search:hover { background: rgba(255,255,255,0.07); color: var(--sl-ink); border-color: var(--sl-line-strong); }
body.stagelight .head-search-icon { flex: none; opacity: 0.85; }
body.stagelight .head-search-label { font-weight: 500; letter-spacing: 0.005em; }
body.stagelight .head-search-kbd {
  display: inline-flex; align-items: center; gap: 1px; font-family: var(--sl-mono); font-size: 11px;
  padding: 2px 6px; border-radius: var(--sl-r-sm); color: var(--sl-faint);
  background: rgba(255,255,255,0.05); border: 1px solid var(--sl-line);
}
body.stagelight .head-search-cmd { font-size: 12px; line-height: 1; }
@media (max-width: 720px) {
  body.stagelight .head-search { padding: 0; width: 40px; justify-content: center; gap: 0; }
  body.stagelight .head-search-label, body.stagelight .head-search-kbd { display: none; }
}

/* ---- COMMAND PALETTE (⌘K) OVERLAY ---- */
body.cmdk-lock { overflow: hidden; }
body.stagelight .cmdk { position: fixed; inset: 0; z-index: 120; display: flex; justify-content: center; align-items: flex-start; }
body.stagelight .cmdk[hidden] { display: none; }
body.stagelight .cmdk-backdrop {
  position: absolute; inset: 0; background: rgba(6,6,8,0.62);
  -webkit-backdrop-filter: blur(8px) saturate(1.1); backdrop-filter: blur(8px) saturate(1.1);
  opacity: 0; transition: opacity 0.2s ease;
}
body.stagelight .cmdk.is-open .cmdk-backdrop { opacity: 1; }
body.stagelight .cmdk-panel {
  position: relative; z-index: 1; width: min(640px, calc(100vw - 32px)); margin-top: min(12vh, 108px);
  max-height: min(72vh, 640px); display: flex; flex-direction: column; overflow: hidden;
  background: linear-gradient(180deg, rgba(30,30,34,0.86), rgba(18,18,21,0.82));
  -webkit-backdrop-filter: blur(30px) saturate(1.5); backdrop-filter: blur(30px) saturate(1.5);
  border: 1px solid var(--sl-line-strong); border-radius: var(--sl-r-lg); box-shadow: var(--sl-shadow-3);
  opacity: 0; transform: translateY(-8px) scale(0.985); transition: opacity 0.2s ease, transform 0.2s ease;
}
body.stagelight .cmdk.is-open .cmdk-panel { opacity: 1; transform: none; }
body.stagelight .cmdk-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
body.stagelight .cmdk-bar { display: flex; align-items: center; gap: 12px; padding: 15px 16px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .cmdk-bar-icon { flex: none; color: var(--sl-faint); }
body.stagelight .cmdk-input {
  flex: 1 1 auto; min-width: 0; background: transparent; border: 0; outline: none; color: var(--sl-ink);
  font-family: var(--sl-display); font-size: 18px; letter-spacing: -0.01em; padding: 2px 0;
}
body.stagelight .cmdk-input::placeholder { color: var(--sl-faint); }
body.stagelight .cmdk-input::-webkit-search-cancel-button { -webkit-appearance: none; }
body.stagelight .cmdk-close {
  flex: none; display: inline-flex; align-items: center; padding: 4px 8px; border-radius: var(--sl-r-sm);
  background: rgba(255,255,255,0.04); border: 1px solid var(--sl-line); cursor: pointer;
}
body.stagelight .cmdk-close kbd { font-family: var(--sl-mono); font-size: 11px; color: var(--sl-faint); }
body.stagelight .cmdk-close:hover { background: rgba(255,255,255,0.09); }
body.stagelight .cmdk-results { overflow-y: auto; overscroll-behavior: contain; padding: 6px; flex: 1 1 auto; }
body.stagelight .cmdk-group { animation: cmdk-group-in 0.22s ease both; }
body.stagelight .cmdk-group:nth-child(2) { animation-delay: 0.03s; }
body.stagelight .cmdk-group:nth-child(3) { animation-delay: 0.06s; }
body.stagelight .cmdk-group:nth-child(4) { animation-delay: 0.09s; }
body.stagelight .cmdk-group:nth-child(n+5) { animation-delay: 0.12s; }
@keyframes cmdk-group-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
body.stagelight .cmdk-group-head {
  display: flex; align-items: center; gap: 8px; padding: 12px 12px 6px;
  font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint);
}
body.stagelight .cmdk-count { font-size: 10.5px; color: var(--sl-faint); background: rgba(255,255,255,0.05); border-radius: var(--sl-r-pill); padding: 1px 7px; }
body.stagelight .cmdk-row {
  display: flex; flex-direction: column; gap: 5px; padding: 9px 12px; border-radius: var(--sl-r-md);
  cursor: pointer; border: 1px solid transparent; scroll-margin: 12px;
}
body.stagelight .cmdk-row.is-active { background: rgba(255,255,255,0.07); border-color: var(--sl-line-strong); }
body.stagelight .cmdk-row.cmdk-album, body.stagelight .cmdk-row.cmdk-tour, body.stagelight .cmdk-row.cmdk-origin,
body.stagelight .cmdk-row.cmdk-lyrics, body.stagelight .cmdk-row.cmdk-archive { flex-direction: row; align-items: center; gap: 12px; }
body.stagelight .cmdk-line { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; min-width: 0; }
body.stagelight .cmdk-row.cmdk-album .cmdk-line, body.stagelight .cmdk-row.cmdk-tour .cmdk-line,
body.stagelight .cmdk-row.cmdk-origin .cmdk-line, body.stagelight .cmdk-row.cmdk-lyrics .cmdk-line,
body.stagelight .cmdk-row.cmdk-archive .cmdk-line { flex-direction: column; gap: 2px; }
body.stagelight .cmdk-title { font-family: var(--sl-display); font-size: 15.5px; font-weight: 560; color: var(--sl-ink); letter-spacing: -0.01em; }
body.stagelight .cmdk-sub { font-family: var(--sl-mono); font-size: 11.5px; color: var(--sl-faint); letter-spacing: 0.02em; }
body.stagelight .cmdk-meta { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
body.stagelight .cmdk-badge {
  font-family: var(--sl-mono); font-size: 10.5px; letter-spacing: 0.03em; text-transform: uppercase;
  padding: 2px 7px; border-radius: var(--sl-r-pill); color: var(--sl-muted);
  background: rgba(255,255,255,0.05); border: 1px solid var(--sl-line);
}
body.stagelight .cmdk-badge.cmdk-tour { color: #ffe9c2; background: rgba(255,206,120,0.12); border-color: rgba(255,206,120,0.28); }
body.stagelight .cmdk-badge.cmdk-bg { color: #cfe6ff; background: rgba(130,190,255,0.12); border-color: rgba(130,190,255,0.28); }
body.stagelight .cmdk-plays { font-family: var(--sl-mono); font-size: 12px; font-variant-numeric: tabular-nums; color: var(--sl-muted); }
body.stagelight .cmdk-plays small { font-size: 10px; color: var(--sl-faint); margin-left: 3px; }
body.stagelight .cmdk-rarity { font-family: var(--sl-mono); font-size: 11px; color: var(--sl-faint); letter-spacing: 0.02em; }
body.stagelight .cmdk-teaser {
  font-size: 13px; color: var(--sl-muted); font-style: italic; opacity: 0.85;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
}
body.stagelight .cmdk-actions { display: inline-flex; gap: 8px; flex-wrap: wrap; margin-top: 1px; }
body.stagelight .cmdk-action {
  font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.02em; color: var(--sl-muted);
  padding: 3px 9px; border-radius: var(--sl-r-pill); background: rgba(255,255,255,0.04); border: 1px solid var(--sl-line);
  transition: background 0.15s ease, color 0.15s ease;
}
body.stagelight .cmdk-action:hover { background: rgba(255,255,255,0.1); color: var(--sl-ink); }
body.stagelight .cmdk-thumb {
  flex: none; width: 40px; height: 40px; border-radius: var(--sl-r-sm); overflow: hidden;
  background: rgba(255,255,255,0.05); border: 1px solid var(--sl-line);
}
body.stagelight .cmdk-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
body.stagelight .cmdk-more { padding: 7px 12px 10px; font-family: var(--sl-mono); font-size: 11px; color: var(--sl-faint); letter-spacing: 0.02em; }
body.stagelight .cmdk-hint { padding: 26px 18px; text-align: center; color: var(--sl-faint); font-size: 13.5px; }
body.stagelight .cmdk-hint[hidden] { display: none; }
body.stagelight .cmdk-foot {
  display: flex; gap: 18px; padding: 10px 16px; border-top: 1px solid var(--sl-line);
  font-family: var(--sl-mono); font-size: 11px; color: var(--sl-faint); letter-spacing: 0.02em;
}
body.stagelight .cmdk-foot kbd {
  font-family: var(--sl-mono); font-size: 10.5px; padding: 1px 5px; margin: 0 1px; border-radius: 4px;
  background: rgba(255,255,255,0.05); border: 1px solid var(--sl-line); color: var(--sl-muted);
}
@media (max-width: 560px) {
  body.stagelight .cmdk-panel {
    width: 100vw; height: 100vh; max-height: 100vh; margin-top: 0; border-radius: 0; border: 0;
  }
  body.stagelight .cmdk-foot { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  body.stagelight .cmdk-backdrop, body.stagelight .cmdk-panel, body.stagelight .cmdk-group { transition: none; animation: none; }
}

/* ---- MEGA MENU ---- */
body.stagelight .mega-menu {
  position: fixed; inset: 0; z-index: 55; overflow-y: auto;
  padding: 104px max(28px, calc((100% - 1400px) / 2)) 64px;
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
body.stagelight .mega-label { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .mega-col-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
body.stagelight .mega-nav { display: flex; flex-direction: column; margin-top: 22px; }
body.stagelight .mega-link {
  font-family: var(--sl-display); font-size: clamp(29px, 3vw, 40px); font-weight: 620;
  letter-spacing: -0.015em; line-height: 1.08; padding: 5px 0; color: var(--sl-ink);
  transition: color 0.15s ease, transform 0.18s ease;
}
body.stagelight .mega-link:hover { color: #fff; transform: translateX(6px); }
body.stagelight .mega-sub {
  display: flex; align-items: baseline; gap: 12px; padding: 3px 0 3px 6px;
  font-family: var(--sl-display); font-size: clamp(19px, 1.9vw, 24px); font-weight: 480;
  letter-spacing: -0.01em; color: var(--sl-muted); transition: color 0.15s ease, transform 0.18s ease;
}
body.stagelight .mega-sub::before { content: "\\21B3"; color: var(--sl-faint); font-size: 0.8em; }
body.stagelight .mega-sub:hover { color: var(--sl-ink); transform: translateX(6px); }
body.stagelight .mega-more { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-muted); border-bottom: 1px solid var(--sl-line-strong); padding-bottom: 3px; }
body.stagelight .mega-more:hover { color: var(--sl-ink); border-color: var(--sl-ink); }
body.stagelight .mega-show { margin-top: 24px; }
body.stagelight .mega-show-photo { display: block; margin-bottom: 20px; border-radius: var(--sl-r-md); overflow: hidden; border: 1px solid var(--sl-line); box-shadow: 0 24px 50px -22px rgba(0,0,0,0.8); }
body.stagelight .mega-show-photo img { display: block; width: 100%; aspect-ratio: 16 / 9.5; object-fit: cover; }
body.stagelight .mega-show-date { display: block; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-muted); }
body.stagelight .mega-show-city { font-family: var(--sl-display); font-size: clamp(26px, 2.6vw, 34px); font-weight: 680; letter-spacing: -0.015em; margin-top: 10px; color: var(--sl-ink); }
body.stagelight .mega-show-venue { font-size: 15px; color: var(--sl-muted); margin-top: 6px; }
body.stagelight .mega-show .sc-chip { margin-top: 22px; }
body.stagelight .mega-next { margin-top: 38px; padding-top: 18px; border-top: 1px solid var(--sl-line); }
body.stagelight .mega-next-line { margin-top: 12px; display: flex; flex-direction: column; gap: 3px; }
body.stagelight .mega-next-line strong { font-size: 17px; font-weight: 620; color: var(--sl-ink); }
body.stagelight .mega-next-line span { font-size: 13.5px; color: var(--sl-muted); }
body.stagelight .mega-blurb { margin-top: 26px; font-size: 15px; line-height: 1.6; color: var(--sl-muted); max-width: 260px; }
body.stagelight .mega-social { display: flex; align-items: center; gap: 12px; margin: 22px 0 28px; }
body.stagelight .mega-social a { display: inline-flex; }
body.stagelight .mega-social .social-mark { width: 38px; height: 38px; flex: 0 0 38px; font-size: 16px; background: rgba(255,255,255,0.06); border: 1px solid var(--sl-line-strong); color: var(--sl-muted); transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease, transform 0.18s ease; }
body.stagelight .mega-social a:hover .social-mark { color: var(--sl-ink); border-color: var(--sl-ink); background: rgba(255,255,255,0.1); transform: translateY(-1px); }
body.stagelight .mega-cta {
  display: inline-flex; align-items: center; height: 40px; padding: 0 20px; border-radius: var(--sl-r-pill);
  font-size: 13.5px; font-weight: 580; color: var(--sl-ink);
  background: rgba(255,255,255,0.055); border: 1px solid var(--sl-line-strong);
  transition: background 0.18s ease, transform 0.18s ease;
}
body.stagelight .mega-cta:hover { background: rgba(255,255,255,0.1); transform: translateY(-1px); }
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
  margin: 0;
}
body.stagelight .latest-setlist { display: grid; gap: 16px; }
body.stagelight .show-entry summary { position: relative; display: block; cursor: pointer; list-style: none; }
body.stagelight .show-entry summary::-webkit-details-marker { display: none; }
body.stagelight .sc-chev { position: absolute; top: 26px; right: 26px; z-index: 3; color: var(--sl-faint); transition: transform 0.22s ease; }
body.stagelight .show-entry[open] .sc-chev { transform: rotate(180deg); }
body.stagelight .setlist-expand-all { display: inline-flex; align-items: center; gap: 10px; padding: 6px 14px; border: 1px solid var(--sl-line); border-radius: var(--sl-r-pill); background: transparent; color: var(--sl-muted); cursor: pointer; font: inherit; transition: color 0.15s ease, border-color 0.15s ease; }
body.stagelight .setlist-expand-all:hover { color: var(--sl-ink); border-color: var(--sl-line-strong); }
body.stagelight .setlist-expand-all .sea-label { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; }
body.stagelight .setlist-expand-all .sea-count { font-weight: 700; color: var(--sl-ink); }
body.stagelight .sc-stats { margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); }
body.stagelight .sc-stats > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 12px; padding: 12px 2px 2px; }
body.stagelight .sc-stats > summary::-webkit-details-marker { display: none; }
body.stagelight .sc-stats-title { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-muted); }
body.stagelight .sc-stats[open] .sc-stats-title { color: var(--sl-ink); }
body.stagelight .sc-stats-meta { font-size: 12px; color: var(--sl-faint); }
body.stagelight .sc-stats-chev { margin-left: auto; color: var(--sl-faint); transition: transform 0.2s ease; font-size: 16px; line-height: 1; }
body.stagelight .sc-stats[open] .sc-stats-chev { transform: rotate(90deg); }
body.stagelight .sc-stats-body { padding: 8px 0 6px; }
body.stagelight .sc-stats-head { display: flex; justify-content: space-between; gap: 16px; margin: 0 0 4px; font-family: var(--sl-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .sc-stats .ltp-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; }
body.stagelight .ltp-item { display: flex; justify-content: space-between; gap: 16px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 14px; }
body.stagelight .ltp-song a { color: var(--sl-ink); text-decoration: none; }
body.stagelight .ltp-song a:hover { text-decoration: underline; }
body.stagelight .ltp-gap { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.03em; color: var(--sl-faint); white-space: nowrap; }
body.stagelight .ltp-gap.is-rare { color: #e0a24a; }
@media (max-width: 560px) { body.stagelight .sc-stats .ltp-list { grid-template-columns: 1fr; } body.stagelight .sc-stats-head span:last-child { display: none; } }
body.stagelight .sc-bg { position: absolute; inset: 0; z-index: 0; display: block; }
body.stagelight .sc-bg img { width: 100%; height: 100%; object-fit: cover; opacity: 0.5; }
body.stagelight .sc-bg::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(9,9,11,0.95) 24%, rgba(9,9,11,0.68) 58%, rgba(9,9,11,0.4)); }
body.stagelight .show-entry[open] .sc-bg { display: none; }
/* Latest-show hero: keep the blurred, scaled photo as a full-panel backdrop even
   when open, with a top-to-bottom dark scrim so the setlist reads on the dark side.
   The sharp photo returns framed at the top-right inside the .sc-lockup grid. */
body.stagelight .show-entry.is-latest[open] .sc-bg { display: block; overflow: hidden; bottom: -32px; }
body.stagelight .show-entry.is-latest[open] .sc-bg img { opacity: 0.5; object-position: center 34%; transform: scale(1.35); filter: blur(18px) saturate(1.1); }
body.stagelight .show-entry.is-latest[open] .sc-bg::after { background: linear-gradient(180deg, rgba(9,9,11,0.30) 0%, rgba(10,10,12,0.72) 44%, rgba(11,11,12,0.94) 78%, rgba(11,11,12,1) 100%); }
body.stagelight .show-entry[open] .sc-lockup, body.stagelight .sc-body { position: relative; z-index: 1; }
/* ---- HOMEPAGE HERO (dedicated section, not the setlist card) ----
   Pulls up behind the glassy header + breadcrumb so the blurred backdrop shows
   through them, and the whole hero is tuned to fit ~one viewport (capped photo,
   two-column setlist + pulls) without dynamic text shrinking. */
body.stagelight .home-hero { position: relative; width: 100vw; margin-left: calc(50% - 50vw); margin-top: calc(-1 * (66px + var(--sl-breadcrumb-h, 37px))); overflow: hidden; isolation: isolate; }
body.stagelight .hero-bg { position: absolute; inset: 0; z-index: 0; }
body.stagelight .hero-bg img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; object-position: center 30%; transform: scale(1.35); filter: blur(22px) saturate(1.1); transition: opacity 0.6s ease; }
body.stagelight .hero-bg img.is-active { opacity: 0.55; }
body.stagelight .hero-bg::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(9,9,11,0.30) 0%, rgba(10,10,12,0.6) 52%, rgba(11,11,12,0.92) 84%, #0b0b0d 100%); }
/* Mirrored continuation of the hero backdrop under the fold + tinted spotlight. */
body.stagelight .hero-bg::before { content: ""; position: absolute; inset: 0; z-index: 1; background: radial-gradient(58% 46% at 68% 18%, var(--hero-glow, rgba(255,186,128,0.10)), transparent 72%); }
/* Seamless: solid page color at the seam (no line), the mirrored light ghosts
   through just below it, then fades back to solid. Content always sits above. */
body.stagelight .hero-echo { position: relative; width: 100vw; margin-left: calc(50% - 50vw); height: 380px; margin-bottom: -380px; overflow: hidden; pointer-events: none; z-index: 0; }
body.stagelight .hero-echo img { width: 100%; height: 100%; object-fit: cover; object-position: center 30%; transform: scale(1.35) scaleY(-1); filter: blur(26px) saturate(1.05); opacity: 0.3; }
body.stagelight .hero-echo::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, #0b0b0d 0%, rgba(11,11,13,0.55) 26%, rgba(11,11,13,0.8) 60%, #0b0b0d 100%); }
body.stagelight main > *:not(.hero-echo) { position: relative; z-index: 1; }
body.stagelight main > .home-nav { position: sticky; z-index: 55; }
body.stagelight .hero-inner { position: relative; z-index: 1; padding: calc(66px + var(--sl-breadcrumb-h, 37px) + 30px) max(28px, calc((100% - 1400px) / 2)) 38px; }
/* Strict 50/50, 2x2: row 1 = identity (vertically centered) | photo. Row 2 =
   setlist | ticker + cards. Nothing crosses the center gutter; the setlist falls
   below the image line so the left column breathes. */
body.stagelight .hero-inner { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: auto auto; column-gap: 64px; row-gap: 14px; align-items: start; }
body.stagelight .home-hero.no-image .hero-inner { grid-template-columns: 1fr; }
body.stagelight .hero-slot, body.stagelight .hero-rail { min-width: 0; }
body.stagelight .hero-lockwrap { grid-column: 1; grid-row: 1; align-self: center; min-width: 0; }
body.stagelight .hero-pager { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
body.stagelight .hero-page {
  width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid var(--sl-line-strong);
  border-radius: 50%; background: transparent; color: var(--sl-muted); font-size: 17px; line-height: 1;
  cursor: pointer; transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
body.stagelight .hero-page:hover:not(:disabled) { color: var(--sl-ink); border-color: var(--sl-muted); background: rgba(255,255,255,0.05); }
body.stagelight .hero-page:disabled { opacity: 0.3; cursor: default; }
body.stagelight .hero-media-slot { grid-column: 2; grid-row: 1; }
body.stagelight .hero-music-slot { grid-column: 1; grid-row: 2; }
body.stagelight .hero-rail { grid-column: 2; grid-row: 2; }
/* View crossfade: the swap script fades each slot, switches the active view, fades back. */
body.stagelight .hero-slot { transition: opacity 0.22s ease; }
body.stagelight .hero-slot.is-fading { opacity: 0; }
body.stagelight .hv[hidden] { display: none; }
body.stagelight .home-hero .sc-eyebrow { display: block; font-family: var(--sl-mono); font-size: 12.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-muted); }
body.stagelight .home-hero .sc-city { margin: 12px 0 0; font-family: var(--sl-display); font-size: 52px; font-weight: 680; letter-spacing: -0.02em; line-height: 1.02; color: var(--sl-ink); text-shadow: 0 2px 40px rgba(0,0,0,0.55); }
body.stagelight .home-hero .sc-venue { display: block; margin-top: 10px; font-size: 16px; color: var(--sl-muted); }
body.stagelight .home-hero .sc-chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
body.stagelight .hero-sets { display: grid; gap: 12px; }
/* No divider: the base .sc-sets card styling doesn't apply in the hero — the two
   columns start on one shared line and alignment does the separating. */
body.stagelight .home-hero .sc-sets { border-top: 0; margin-top: 0; padding-top: 0; }
body.stagelight .hero-table-note { margin: 0; max-width: 56ch; font-size: 15.5px; line-height: 1.65; color: var(--sl-muted); }
body.stagelight .hero-table-note b { color: var(--sl-ink); font-weight: 620; }
body.stagelight .hero-table-note .sc-label { display: block; margin-bottom: 10px; }
body.stagelight .hero-tonight { color: #d4514f; }
body.stagelight .home-hero .sc-row { grid-template-columns: 52px minmax(0, 1fr); gap: 14px; }
body.stagelight .hero-footnote { margin: 14px 0 0; font-size: 13px; color: var(--sl-faint); }
body.stagelight .hero-stats-btn {
  display: inline-flex; align-items: baseline; gap: 10px; margin-top: 22px; padding: 10px 16px;
  border: 1px solid var(--sl-line-strong); border-radius: var(--sl-r-pill); background: rgba(255,255,255,0.04);
  font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-ink);
  cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease;
}
body.stagelight .hero-stats-btn span { color: var(--sl-faint); letter-spacing: 0.04em; text-transform: none; font-size: 11.5px; }
body.stagelight .hero-stats-btn:hover { background: rgba(255,255,255,0.08); border-color: var(--sl-muted); }
/* Trippy-but-subtle: a faint glint orbits the button outline clockwise (18s);
   on hover it locks to the cursor's angle. Static under reduced motion. */
@property --hsb-a { syntax: "<angle>"; initial-value: 0deg; inherits: false; }
body.stagelight .hero-stats-btn { position: relative; }
body.stagelight .hsb-ring {
  position: absolute; inset: -1px; border-radius: inherit; pointer-events: none;
  background: conic-gradient(from var(--hsb-a), transparent 0deg 318deg, rgba(255,255,255,0.55) 338deg, transparent 358deg);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
  padding: 1px; animation: hsb-orbit 18s linear infinite;
}
body.stagelight .hero-stats-btn:hover .hsb-ring { animation-play-state: paused; }
@keyframes hsb-orbit { to { --hsb-a: 360deg; } }
@media (prefers-reduced-motion: reduce) { body.stagelight .hsb-ring { animation: none; } }
body.stagelight .hero-photo { position: relative; margin: 0; width: 100%; height: clamp(300px, 44vh, 460px); border-radius: 0 0 var(--sl-r-md) var(--sl-r-md); overflow: hidden; border: 1px solid var(--sl-line); border-top: 0; box-shadow: 0 40px 80px -28px rgba(0,0,0,0.85); }
body.stagelight .hero-photo img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: center 20%; }
/* The photo rises flush to the bar above (square top, no top border). */
body.stagelight .hero-media-slot { margin-top: -30px; }
body.stagelight .hero-credit { position: absolute; right: 8px; bottom: 6px; font-family: var(--sl-mono); font-size: 9.5px; letter-spacing: 0.04em; color: rgba(255,255,255,0.72); text-shadow: 0 1px 4px rgba(0,0,0,0.9); pointer-events: none; }
/* Ticker: slow continuous crawl, pauses on hover; static scroll under 900px / reduced motion. */
body.stagelight .hero-ticker { overflow: hidden; -webkit-mask-image: linear-gradient(90deg, transparent, #000 4%, #000 96%, transparent); mask-image: linear-gradient(90deg, transparent, #000 4%, #000 96%, transparent); }
body.stagelight .tk-track { display: inline-flex; align-items: center; gap: 18px; padding: 4px 2px 8px; white-space: nowrap; width: max-content; animation: tk-crawl 46s linear infinite; }
body.stagelight .hero-ticker:hover .tk-track { animation-play-state: paused; }
@keyframes tk-crawl { from { transform: translateX(0); } to { transform: translateX(-50%); } }
body.stagelight .tk-item { display: inline-flex; align-items: baseline; gap: 7px; font-size: 13px; }
body.stagelight .tk-item em { font-style: normal; font-family: var(--sl-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .tk-item b { font-weight: 600; color: var(--sl-ink); }
body.stagelight .tk-item svg { width: 15px; height: auto; flex: none; align-self: center; }
body.stagelight .tk-item svg polygon, body.stagelight .tk-item svg circle { fill: var(--sl-muted); }
body.stagelight .tk-item svg.rarity-ultra polygon { fill: #b9c0cc; }
body.stagelight .tk-item svg.rarity-hyper polygon, body.stagelight .tk-item svg.rarity-bustout polygon, body.stagelight .tk-item svg.rarity-mega polygon { fill: #d9a84e; }
body.stagelight .tk-note b { font-weight: 500; color: var(--sl-muted); }
body.stagelight .tk-sep { color: var(--sl-faint); opacity: 0.5; }
@media (prefers-reduced-motion: reduce) { body.stagelight .tk-track { animation: none; } body.stagelight .hero-ticker { overflow-x: auto; } }
/* Right-rail cards */
body.stagelight .hero-cards { margin-top: 12px; display: grid; gap: 10px; }
body.stagelight .hero-card[hidden] { display: none; }
body.stagelight .hero-card.is-refilling time, body.stagelight .hero-card.is-refilling .hc-place { opacity: 0; transition: opacity 0.16s ease; }
body.stagelight .hero-card time, body.stagelight .hero-card .hc-place { transition: opacity 0.2s ease; }
/* The card for the view you're on: red current-ring (shelf-watch language). */
body.stagelight .hero-card.is-current { border-color: rgba(212,81,79,0.55); box-shadow: 0 0 0 1px rgba(212,81,79,0.35), 0 0 24px -8px rgba(212,81,79,0.3); cursor: default; }
body.stagelight .hero-card.is-current:hover { transform: none; background: rgba(255,255,255,0.035); }
body.stagelight .hero-card {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 18px;
  width: 100%; text-align: left; cursor: pointer; font: inherit;
  padding: 13px 18px; border: 1px solid var(--sl-line); border-radius: var(--sl-r-md);
  background: rgba(16,16,20,0.32); -webkit-backdrop-filter: blur(16px) saturate(1.2); backdrop-filter: blur(16px) saturate(1.2);
  color: var(--sl-ink); transition: border-color 0.15s ease, transform 0.18s ease, filter 0.18s ease;
}
body.stagelight .hero-card:hover { background: rgba(28,28,34,0.45); border-color: var(--sl-line-strong); transform: translateY(-1px); }

body.stagelight .hc-place { display: flex; flex-direction: column; min-width: 0; }
body.stagelight .hc-place strong { font-size: 15px; font-weight: 620; }
body.stagelight .hc-place small { font-size: 12.5px; color: var(--sl-faint); }
body.stagelight .hc-go { color: var(--sl-faint); }
body.stagelight .hero-card-upcoming { border-style: dashed; }
/* Quiet link utility — bare text action, used sparingly (tertiary actions only). */
body.stagelight .link-quiet { display: inline-flex; align-items: baseline; gap: 7px; font-size: 14px; color: var(--sl-muted); transition: color 0.15s ease; }
body.stagelight .link-quiet span { transition: transform 0.18s ease; }
body.stagelight .link-quiet:hover { color: var(--sl-ink); }
body.stagelight .link-quiet:hover span { transform: translateX(2px); }
body.stagelight .hero-all { justify-self: end; margin-top: 4px; }
/* Song stats: in-place expansion. The photo and the stats panel share one slot
   (.hero-media, sized by the photo cap); toggling .stats-open crossfades the
   photo away and slides the panel up into its place — cards stay put, hero
   height never changes. */
body.stagelight .hero-media { position: relative; height: clamp(300px, 44vh, 460px); }
body.stagelight .hero-media .hero-photo { position: absolute; inset: 0; height: 100%; transition: opacity 0.42s cubic-bezier(0.22,1,0.36,1), transform 0.42s cubic-bezier(0.22,1,0.36,1); }
body.stagelight .hero-stats-panel {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  padding: 18px 22px 16px; border-radius: var(--sl-r-md); border: 1px solid var(--sl-line-strong);
  background: rgba(16,16,19,0.88); -webkit-backdrop-filter: blur(18px) saturate(1.3); backdrop-filter: blur(18px) saturate(1.3);
  box-shadow: 0 40px 80px -28px rgba(0,0,0,0.85);
  opacity: 0; transform: translateY(14px); pointer-events: none;
  transition: opacity 0.42s cubic-bezier(0.22,1,0.36,1), transform 0.42s cubic-bezier(0.22,1,0.36,1);
}
body.stagelight .hero-media.stats-open .hero-photo { opacity: 0; transform: scale(0.985) translateY(-6px); pointer-events: none; }
body.stagelight .hero-media.stats-open .hero-stats-panel { opacity: 1; transform: none; pointer-events: auto; }
@media (prefers-reduced-motion: reduce) {
  body.stagelight .hero-media .hero-photo, body.stagelight .hero-stats-panel { transition: none; }
}
body.stagelight .hero-modal-head { flex: none; display: flex; align-items: baseline; gap: 14px; margin-bottom: 12px; }
body.stagelight .hero-modal-head h3 { font-family: var(--sl-display); font-size: 20px; font-weight: 650; }
body.stagelight .hero-modal-head span { font-family: var(--sl-mono); font-size: 11.5px; color: var(--sl-faint); }
body.stagelight .hero-modal-x { margin-left: auto; width: 30px; height: 30px; border: 1px solid var(--sl-line); border-radius: 8px; background: transparent; color: var(--sl-muted); cursor: pointer; }
body.stagelight .hero-modal-x:hover { color: var(--sl-ink); border-color: var(--sl-muted); }
body.stagelight .hero-stats-panel .ltp-list { list-style: none; margin: 0; padding: 0 2px 4px; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 0 26px; align-content: start; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
body.stagelight .hero-stats-panel .ltp-item { display: flex; align-items: baseline; gap: 8px; }
body.stagelight .hero-stats-panel .ltp-item .rarity-symbol { flex: none; min-width: 30px; }
body.stagelight .hero-stats-panel .ltp-song { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 640px) { body.stagelight .hero-stats-panel .ltp-list { grid-template-columns: 1fr; } }
@media (max-width: 900px) {
  /* Single column: the 2x2 slots keep desktop grid-column/row placements, so
     they MUST be reset here or the 1fr grid grows a phantom second column
     (the "hero-right" selector this replaced was stale — no such element). */
  body.stagelight .hero-inner { grid-template-columns: 1fr; grid-template-rows: none; row-gap: 26px; }
  body.stagelight .hero-lockwrap,
  body.stagelight .hero-media-slot,
  body.stagelight .hero-music-slot,
  body.stagelight .hero-rail { grid-column: 1; grid-row: auto; }
  body.stagelight .hero-lockwrap { order: 1; align-self: start; }
  body.stagelight .hero-media-slot { order: 2; margin-top: 0; }
  body.stagelight .hero-photo { border-radius: var(--sl-r-md); border-top: 1px solid var(--sl-line); }
  body.stagelight .hero-music-slot { order: 3; }
  body.stagelight .hero-rail { order: 4; }
  body.stagelight .hero-photo { height: clamp(200px, 30vh, 300px); }
  body.stagelight .hero-media { height: auto; min-height: clamp(200px, 30vh, 300px); }
}
@media (max-width: 560px) {
  body.stagelight .home-hero .sc-city { font-size: 30px; }
  body.stagelight .hero-inner { padding-top: calc(66px + var(--sl-breadcrumb-h, 37px) + 18px); padding-bottom: 28px; row-gap: 20px; }
  body.stagelight .hero-photo, body.stagelight .hero-media { height: clamp(180px, 26vh, 240px); min-height: 0; }
  body.stagelight .hero-card { gap: 12px; padding: 11px 14px; }
}
body.stagelight .sc-closed { position: relative; z-index: 1; display: flex; align-items: center; gap: 24px; min-height: 84px; padding: 18px 70px 18px 28px; }
body.stagelight .show-entry[open] .sc-closed { display: none; }
body.stagelight .sc-date { font-family: var(--sl-mono); font-size: 13.5px; letter-spacing: 0.08em; color: var(--sl-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
body.stagelight .sc-place { display: flex; flex-direction: column; min-width: 0; }
body.stagelight .sc-place strong { font-family: var(--sl-display); font-weight: 640; font-size: 17px; letter-spacing: -0.005em; color: var(--sl-ink); }
body.stagelight .sc-place small { font-size: 13.5px; color: var(--sl-muted); margin-top: 2px; }
body.stagelight .sc-lockup { display: none; }
body.stagelight .show-entry[open] .sc-lockup { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 44px; align-items: center; padding: 44px 84px 0 44px; }
body.stagelight .show-entry.no-image[open] .sc-lockup { grid-template-columns: 1fr; padding-right: 84px; }
body.stagelight .sc-lock { display: block; }
body.stagelight .sc-eyebrow { display: block; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-muted); }
body.stagelight .sc-city { display: block; font-family: var(--sl-display); font-weight: 720; font-size: 40px; letter-spacing: -0.015em; line-height: 1.05; margin: 12px 0 0; color: var(--sl-ink); }
body.stagelight .show-entry.is-latest .sc-city { font-size: 56px; letter-spacing: -0.02em; }
body.stagelight .sc-venue { display: block; font-size: 15px; color: var(--sl-muted); margin-top: 10px; font-weight: 440; }
body.stagelight .sc-chips { display: flex; gap: 12px; margin-top: 28px; flex-wrap: wrap; }
body.stagelight .sc-chip { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 18px; border-radius: var(--sl-r-pill); font-size: 13.5px; font-weight: 560; white-space: nowrap; transition: transform 0.18s ease, background 0.18s ease; }
body.stagelight .sc-chip svg { flex: none; }
body.stagelight .sc-chip-primary { background: var(--sl-ink); color: #111; box-shadow: 0 8px 24px -8px rgba(242,242,240,0.35), inset 0 1px 0 rgba(255,255,255,0.9); border: 0; }
body.stagelight .sc-chip-primary:hover { transform: translateY(-1px); background: #fff; }
body.stagelight .sc-chip-glass { background: rgba(255,255,255,0.055); border: 1px solid var(--sl-line-strong); color: var(--sl-ink); }
body.stagelight .sc-chip-glass:hover { transform: translateY(-1px); background: rgba(255,255,255,0.09); }
body.stagelight .sc-photo { display: block; position: relative; }
body.stagelight .sc-photo img { width: 100%; height: auto; border-radius: var(--sl-r-md); border: 1px solid var(--sl-line); box-shadow: 0 30px 60px -24px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.1); }
body.stagelight .sc-body { padding: 0 44px 36px; }
body.stagelight .show-entry.is-latest .sc-body { padding: 0 max(28px, calc((100% - 1400px) / 2)) 40px; }
body.stagelight .sc-sets { border-top: 1px solid var(--sl-line); margin-top: 32px; padding-top: 30px; display: grid; gap: 18px; }
body.stagelight .sc-row { display: grid; grid-template-columns: 96px 1fr; gap: 20px; }
body.stagelight .sc-label { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.18em; color: var(--sl-faint); text-transform: uppercase; padding-top: 5px; white-space: nowrap; }
body.stagelight .sc-prose { font-size: 17px; line-height: 1.68; font-weight: 430; color: var(--sl-ink); margin: 0; }
body.stagelight .sc-prose a { color: inherit; }
body.stagelight .sc-preview-note { font-size: 13.5px; color: var(--sl-faint); margin: 0; }
body.stagelight .sc-notes .setlist-annotations { color: var(--sl-faint); font-size: 13.5px; }
body.stagelight .sc-pulls { border-top: 1px solid var(--sl-line); margin-top: 6px; padding-top: 22px; }
body.stagelight .sc-pull-list { display: flex; flex-wrap: wrap; gap: 10px 28px; align-items: baseline; }
body.stagelight .sc-pull { font-size: 15px; line-height: 1.6; }
body.stagelight .sc-pull svg { display: inline-block; vertical-align: baseline; margin-right: 6px; height: 10px; width: auto; }
body.stagelight .sc-pull .rarity-symbol svg { height: 10px; }
body.stagelight .sc-tier { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-muted); margin-right: 6px; }
body.stagelight .sc-pull b { font-weight: 600; white-space: nowrap; color: var(--sl-ink); }
body.stagelight .sc-pull [fill="#111111"] { fill: #f2f2f0; }
body.stagelight .sc-pull [stroke="#111111"] { stroke: #f2f2f0; }
body.stagelight .setlist-list { display: grid; gap: 16px; }
body.stagelight .setlist-archive-panel > summary { display: none; }
@media (max-width: 560px) {
  body.stagelight .site-head { gap: 16px; }
  body.stagelight .brand-wordmark { font-size: 17px; }
}
@media (max-width: 900px) {
  body.stagelight .show-entry[open] .sc-lockup { grid-template-columns: 1fr; gap: 24px; padding: 26px 22px 0; }
  body.stagelight .sc-city { font-size: 28px; }
  body.stagelight .hero-inner { padding-left: 22px; padding-right: 22px; }
  body.stagelight .home-hero .sc-city { font-size: 38px; }
  body.stagelight .sc-body { padding: 0 22px 26px; }
  body.stagelight .sc-row { grid-template-columns: 1fr; gap: 6px; }
  body.stagelight .sc-label { padding-top: 0; }
  body.stagelight .sc-closed { padding: 16px 56px 16px 20px; gap: 12px; flex-wrap: wrap; }
  body.stagelight .sc-chev { top: 22px; right: 18px; }
}

/* ---- DATA METRICS (stat tiles) ---- */
body.stagelight .data-metrics .nick-stat {
  background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line); border-radius: var(--sl-r-md);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
}
body.stagelight .data-metrics .nick-stat strong { font-family: var(--sl-mono); color: var(--sl-ink); }
body.stagelight .data-metrics .nick-stat span { font-family: var(--sl-mono); color: var(--sl-faint); text-transform: uppercase; letter-spacing: 0.12em; }

/* ---- TOOLBAR CONTROLS ---- */
body.stagelight .data-toolbar { color: var(--sl-muted); }
body.stagelight .data-toolbar .show-filter span { font-family: var(--sl-mono); color: var(--sl-faint); text-transform: uppercase; letter-spacing: 0.12em; }
body.stagelight .data-toolbar select {
  background: rgba(255,255,255,0.05); color: var(--sl-ink); border: 1px solid var(--sl-line-strong); border-radius: var(--sl-r-pill);
}
body.stagelight .data-toolbar select option { color: #111; }
body.stagelight .type-filter { border: 1px solid var(--sl-line-strong); background: rgba(255,255,255,0.04); border-radius: var(--sl-r-pill); }
body.stagelight .type-filter button { color: var(--sl-muted); }
body.stagelight .type-filter button[aria-pressed="true"], body.stagelight .type-filter button.is-active { background: var(--sl-ink); color: #111; }

/* ---- DATA TABLES (tour stats, shelf watch) ---- */
/* Fixed layout locks columns to the header so filtering/sorting (which changes
   the widest visible cell) can never re-flow them. Durable fix for "columns move
   when I click Not Played." Lives here in the stagelight overrides (not the base
   sheet) so it reliably ships in stagelight.css and wins the cascade. */
body.stagelight .tour-table { table-layout: fixed; }
body.stagelight .tour-table thead th:nth-child(1) { width: 24%; }
body.stagelight .tour-table thead th:nth-child(2) { width: 12%; }
body.stagelight .tour-table thead th:nth-child(3) { width: 25%; }
body.stagelight .tour-table thead th:nth-child(4) { width: 24%; }
body.stagelight .tour-table thead th:nth-child(5) { width: 15%; }
body.stagelight .tour-table tbody th[scope="row"] { overflow: hidden; text-overflow: ellipsis; }
body.stagelight .tour-table .signal-cell small { white-space: normal; }
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
body.stagelight .data-table td, body.stagelight .tour-table td { border-bottom: 1px solid var(--sl-line-faint); }
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
  position: relative; margin-top: 16px; border-radius: var(--sl-r); overflow: hidden;
  background: var(--sl-glass);
  -webkit-backdrop-filter: blur(26px) saturate(1.4); backdrop-filter: blur(26px) saturate(1.4);
  border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
}
/* Full-bleed live-show backdrop (Andy Tennille). A dark vertical gradient — same
   overlay idiom as the latest-show card's .sc-bg::after — keeps every mono label
   and row above WCAG contrast. Image + overlay ride an ::before so the section's
   own content (heading, rows, credit) stacks cleanly above it. */
body.stagelight .upcoming-dates::before {
  content: ""; position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background-image: linear-gradient(180deg, rgba(9,9,11,0.74) 0%, rgba(10,10,12,0.82) 48%, rgba(11,11,12,0.9) 100%), url("/assets/upcoming-bg-andy-tennille.jpg");
  background-size: cover, cover; background-position: center, center;
}
body.stagelight .upcoming-heading, body.stagelight .upcoming-dates .tour-dates { position: relative; z-index: 1; }
body.stagelight .upcoming-dates .tour-dates { padding-bottom: 20px; }
/* Quiet photographer credit — band policy is to credit every photographer. */
body.stagelight .upcoming-credit {
  display: block; text-align: right; margin: 10px 6px 0 0; position: relative; z-index: 1;
  font-family: var(--sl-mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--sl-faint); pointer-events: none;
}
body.stagelight .upcoming-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 20px 26px 14px; }
body.stagelight .upcoming-heading h3 { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.18em; font-weight: 600; color: var(--sl-ink); }
body.stagelight .upcoming-heading span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.08em; color: var(--sl-faint); text-transform: uppercase; }
/* Upcoming rows share the posted-show card geometry: date | place | flag,
   same columns, with the Upcoming badge in the setlist-affordance slot. */
body.stagelight .tour-dates li.is-upcoming {
  display: flex; align-items: center; gap: 24px; min-height: 84px; padding: 18px 28px;
  border-top: 1px solid var(--sl-line-faint);
}
body.stagelight .tour-dates li .up-flag {
  margin-left: auto; display: inline-flex; align-items: center; font-style: normal;
  font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--sl-muted); border: 1px solid var(--sl-line-strong); border-radius: 999px; padding: 8px 16px; white-space: nowrap;
}
@media (max-width: 560px) {
  body.stagelight .tour-dates li.is-upcoming { padding: 16px 20px; gap: 12px; flex-wrap: wrap; }
  body.stagelight .tour-dates li .up-flag { margin-left: 0; }
}

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
body.stagelight .nick-summary .nick-stat { background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line); border-radius: var(--sl-r-md); }
body.stagelight .nick-summary .nick-stat strong { font-family: var(--sl-mono); color: var(--sl-ink); }
body.stagelight .nick-progress > div:first-child strong { font-family: var(--sl-mono); font-size: 26px; font-weight: 640; color: var(--sl-ink); }
body.stagelight .nick-progress > div:first-child span { font-size: 13.5px; color: var(--sl-muted); }
body.stagelight .nick-progress-track i.is-original { background: var(--green); }
body.stagelight .nick-progress-track i.is-cover { background: rgba(96, 165, 210, 0.85); }
body.stagelight .progress-key span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.06em; color: var(--sl-faint); text-transform: uppercase; }
body.stagelight .progress-key .key-original { background: var(--green); }
body.stagelight .progress-key .key-cover { background: rgba(96, 165, 210, 0.85); }
body.stagelight .progress-key .key-unplayed { background: rgba(255,255,255,0.18); }
body.stagelight .nick-ranking-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin: 6px 0 10px; }
body.stagelight .nick-ranking-heading h3 { font-size: 17px; font-weight: 640; letter-spacing: 0; }
body.stagelight .nick-ranking-heading span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.1em; color: var(--sl-faint); text-transform: uppercase; }
body.stagelight .nick-ranking li { padding: 12px 10px; }
body.stagelight .nick-ranking li:hover { background: rgba(255,255,255,0.025); }
body.stagelight .nick-rank { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); font-variant-numeric: tabular-nums; }
body.stagelight .nick-song { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
body.stagelight .nick-song strong { font-size: 15px; font-weight: 600; color: var(--sl-ink); letter-spacing: 0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
body.stagelight .nick-song small { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.14em; color: var(--sl-faint); text-transform: uppercase; flex: none; }
body.stagelight .nick-plays { display: flex; align-items: baseline; gap: 6px; justify-self: end; }
body.stagelight .nick-plays strong { font-family: var(--sl-mono); font-size: 15px; font-weight: 620; color: var(--sl-ink); font-variant-numeric: tabular-nums; }
body.stagelight .nick-plays small { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.1em; color: var(--sl-faint); text-transform: uppercase; }
body.stagelight .nick-ranking li.is-zero { opacity: 0.45; }
body.stagelight .nick-played-panel { margin-top: 18px; border-top: 1px solid var(--sl-line); }
body.stagelight .nick-played-panel > summary { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 16px 10px 6px; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.12em; color: var(--sl-faint); }
body.stagelight .nick-played-panel > summary:hover { color: var(--sl-ink); }
body.stagelight .nick-played-panel > summary strong { font-size: 12px; color: var(--sl-muted); }
body.stagelight .nick-disclosure > summary { width: 100%; }

/* ---- COMMUNITY LINKS ---- */
body.stagelight .ticket-link {
  background: var(--sl-ink); color: #111; border: 0; border-radius: var(--sl-r-pill); font-weight: 650;
  box-shadow: 0 8px 24px -8px rgba(242,242,240,0.35), inset 0 1px 0 rgba(255,255,255,0.9);
}
body.stagelight .ticket-link:hover { background: #fff; }

/* ---- CROSS-PROMO BAND ---- */
body.stagelight .cross-promo { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
body.stagelight .xp-card {
  position: relative; display: flex; align-items: flex-end; min-height: 260px; overflow: hidden;
  border-radius: var(--sl-r); border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
  text-decoration: none; isolation: isolate;
  transition: transform 0.28s ease, box-shadow 0.28s ease, border-color 0.28s ease;
}
body.stagelight .xp-bg { position: absolute; inset: 0; z-index: -2; }
body.stagelight .xp-bg img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.5s ease; }
body.stagelight .xp-card::after {
  content: ""; position: absolute; inset: 0; z-index: -1;
  background: linear-gradient(200deg, rgba(9,9,11,0.28) 0%, rgba(9,9,11,0.62) 46%, rgba(9,9,11,0.94) 100%);
}
body.stagelight .xp-cover .xp-bg img { object-position: center 30%; }
body.stagelight .xp-body { position: relative; z-index: 1; display: grid; gap: 6px; padding: 26px 28px; }
body.stagelight .xp-eyebrow { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .xp-title { font-family: var(--sl-display); font-weight: 640; font-size: 24px; letter-spacing: -0.01em; color: var(--sl-ink); }
body.stagelight .xp-desc { font-size: 14px; color: var(--sl-muted); max-width: 34ch; }
body.stagelight .xp-arrow {
  position: absolute; z-index: 1; top: 24px; right: 26px; width: 40px; height: 40px;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 50%;
  background: rgba(24,24,27,0.55); border: 1px solid var(--sl-line-strong); color: var(--sl-ink);
  font-size: 17px; transition: transform 0.28s ease, background 0.28s ease;
}
body.stagelight .xp-card:hover { transform: translateY(-4px); box-shadow: 0 26px 60px -22px rgba(0,0,0,0.85); border-color: rgba(255,255,255,0.24); }
body.stagelight .xp-card:hover .xp-bg img { transform: scale(1.05); }
body.stagelight .xp-card:hover .xp-arrow { transform: translateX(3px); background: rgba(38,38,42,0.75); }
@media (prefers-reduced-motion: reduce) {
  body.stagelight .xp-card, body.stagelight .xp-bg img, body.stagelight .xp-arrow { transition: none; }
  body.stagelight .xp-card:hover { transform: none; }
  body.stagelight .xp-card:hover .xp-bg img { transform: none; }
}
@media (max-width: 760px) { body.stagelight .cross-promo { grid-template-columns: 1fr; } }

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
  display: grid; grid-template-columns: 2.1fr 1fr 1fr 1fr; gap: 20px 40px;
  padding: 64px 0 32px; align-items: start;
}
body.stagelight .footer-lead { max-width: 420px; }
body.stagelight .footer-brand { display: inline-flex; align-items: center; gap: 12px; font-family: var(--sl-display); color: var(--sl-ink); font-weight: 640; font-size: 21px; letter-spacing: -0.012em; }
body.stagelight .footer-mark { width: min(384px, 94%); height: auto; }
body.stagelight .footer-lead p.footer-identity { margin: 18px 0 0; max-width: none; white-space: nowrap; font-weight: 650; font-size: 19px; color: var(--sl-ink); letter-spacing: 0.01em; }
body.stagelight .footer-copy { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; color: var(--sl-faint); }
body.stagelight .footer-lead p { color: var(--sl-muted); margin-top: 8px; max-width: 340px; font-size: 17px; line-height: 1.55; }
body.stagelight .footer-links { gap: 9px; }
body.stagelight .footer-links strong { font-family: var(--sl-mono); font-size: 11px; color: var(--sl-faint); text-transform: uppercase; letter-spacing: 0.16em; margin-bottom: 8px; }
body.stagelight .footer-links a { color: var(--sl-muted); font-size: 17px; transition: color 0.15s ease, transform 0.15s ease; }
body.stagelight .footer-links a:hover { color: var(--sl-ink); transform: translateX(2px); }
body.stagelight .social-links { display: flex; flex-direction: row; align-items: center; gap: 12px; margin-top: 22px; }
body.stagelight .social-links a { display: inline-flex; }
body.stagelight .social-links a > span:last-child { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
body.stagelight .social-links .social-mark { width: 36px; height: 36px; flex: 0 0 36px; display: inline-grid; place-items: center; border-radius: 50%; font-family: Arial, Helvetica, sans-serif; font-size: 15px; font-weight: 700; }
body.stagelight .social-links a:hover .social-mark { color: var(--sl-ink); border-color: var(--sl-ink); background: rgba(255,255,255,0.1); transform: translateY(-1px); }
body.stagelight .social-mark { background: rgba(255,255,255,0.06); border: 1px solid var(--sl-line-strong); color: var(--sl-muted); transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease, transform 0.18s ease; }
body.stagelight .footer-bottom {
  grid-column: 1 / -1; display: flex; align-items: center; gap: 8px 24px; flex-wrap: wrap;
  margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--sl-line);
}
body.stagelight .footer-legal { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; color: var(--sl-faint); margin: 0; }
body.stagelight .footer-legal span { margin: 0 8px; }
body.stagelight .footer-sources { margin: 0; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.03em; color: var(--sl-faint); }
body.stagelight .footer-sources a { color: var(--sl-muted); text-decoration: underline; text-underline-offset: 2px; }
body.stagelight .footer-sources a:hover { color: var(--sl-ink); }
body.stagelight .footer-bottom-links { display: flex; align-items: center; gap: 24px; margin-left: auto; }
body.stagelight .footer-privacy { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; color: var(--sl-faint); }
body.stagelight .footer-privacy:hover { color: var(--sl-ink); }
body.stagelight .back-top { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border: 1px solid var(--sl-line); border-radius: 9px; font-size: 15px; color: var(--sl-faint); transition: color 0.15s ease, border-color 0.15s ease, transform 0.15s ease; }
body.stagelight .back-top:hover { color: var(--sl-ink); border-color: var(--sl-muted); transform: translateY(-2px); }
@media (max-width: 900px) {
  body.stagelight .site-foot-inner { grid-template-columns: 1fr 1fr 1fr; padding: 48px 0 28px; gap: 30px 24px; }
  body.stagelight .footer-lead { grid-column: 1 / -1; max-width: 420px; }
  body.stagelight .footer-bottom-links { margin-left: 0; }
}
@media (max-width: 640px) {
  body.stagelight .footer-lead p.footer-identity { white-space: normal; }
  /* Copyright row stacks and centers so nothing crowds or overflows on phones. */
  body.stagelight .footer-bottom { flex-direction: column; align-items: center; text-align: center; gap: 16px; }
  body.stagelight .footer-sources { max-width: 34ch; }
  body.stagelight .footer-bottom-links { margin-left: 0; justify-content: center; flex-wrap: wrap; gap: 16px 20px; }
}
@media (max-width: 540px) {
  body.stagelight .site-foot-inner { grid-template-columns: 1fr 1fr; }
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
body.stagelight .bento-card:hover { transform: translateY(-2px); border-color: var(--sl-line-strong); }
body.stagelight .bento-card[aria-expanded="true"] { border-color: var(--sl-line-strong); }
body.stagelight .bento-shelf[aria-expanded="true"] { box-shadow: var(--sl-glass-shadow), 0 0 60px -18px rgba(212,81,79,0.4); }
body.stagelight .bento-purgatory[aria-expanded="true"] { box-shadow: var(--sl-glass-shadow), 0 0 60px -18px rgba(40,110,158,0.45); }
body.stagelight .bento-woodshed[aria-expanded="true"] { box-shadow: var(--sl-glass-shadow), 0 0 60px -18px rgba(45,124,82,0.45); }
body.stagelight .bc-open { position: absolute; top: 22px; right: 24px; color: var(--sl-faint); font-size: 21px; line-height: 1; font-weight: 300; transition: transform 0.2s ease; }
body.stagelight .bento-card[aria-expanded="true"] .bc-open { transform: rotate(45deg); color: var(--sl-ink); }
body.stagelight .bc-name { display: block; font-family: var(--sl-display); font-weight: 640; font-size: 21px; letter-spacing: -0.005em; }
body.stagelight .bc-count { display: block; font-family: var(--sl-mono); font-size: 34px; font-weight: 640; margin-top: 14px; font-variant-numeric: tabular-nums; }
body.stagelight .bc-count small { font-size: 13.5px; color: var(--sl-faint); font-weight: 500; letter-spacing: 0.08em; margin-left: 8px; }
body.stagelight .bc-desc { display: block; font-size: 13.5px; color: var(--sl-muted); margin-top: 10px; line-height: 1.5; min-height: 42px; }
body.stagelight .bc-fact { display: flex; justify-content: space-between; gap: 12px; font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--sl-line-faint); }
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
/* A bento sheet is a full-screen overlay; the sticky header sits in its own
   stacking context (z-index:60 at the body level) that traps the panel's
   z-index, so hide the header entirely while a sheet is open. */
body.stagelight.bento-open .site-head { opacity: 0; visibility: hidden; pointer-events: none; }
body.stagelight .bento-close {
  position: fixed; top: 18px; right: 22px; z-index: 95;
  display: inline-flex; align-items: center; justify-content: center;
  width: 42px; height: 42px; border-radius: 50%;
  background: rgba(24,24,27,0.85); border: 1px solid var(--sl-line-strong); color: var(--sl-ink);
  box-shadow: var(--sl-shadow-2);
  transition: background 0.18s ease, transform 0.18s ease;
}
body.stagelight .bento-close:hover { background: rgba(46,46,50,0.95); transform: scale(1.05); }
@media (max-width: 900px) { body.stagelight .bento-grid { grid-template-columns: 1fr; } }

/* ---- CLOSED-BAR MINI PULLS ---- */
body.stagelight .sc-mini-pulls { margin-left: auto; display: inline-flex; align-items: baseline; gap: 8px; font-size: 13.5px; color: var(--sl-muted); white-space: nowrap; }
body.stagelight .sc-mini-pulls b { color: var(--sl-ink); font-weight: 600; }
body.stagelight .sc-mini-pulls svg { height: 9px; width: auto; }
body.stagelight .sc-mini-pulls [fill="#111111"] { fill: #f2f2f0; }
body.stagelight .sc-mini-pulls [stroke="#111111"] { stroke: #f2f2f0; }
body.stagelight .sc-more { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.1em; color: var(--sl-faint); }

/* ---- NEXT SHOW STRIP ---- */
body.stagelight .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--red); box-shadow: 0 0 10px rgba(212,81,79,0.9); animation: sl-pulse 2.4s ease-in-out infinite; }
@keyframes sl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { body.stagelight .live-dot { animation: none; } }
@media (max-width: 760px) {
  body.stagelight .sc-mini-pulls { margin-left: 0; width: 100%; }
}

/* ---- TOUR STATS DENSITY + RARITY SYMBOLS ---- */
body.stagelight .signal-cell strong { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 620; }
body.stagelight .signal-cell small { display: block; margin-top: 4px; font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); letter-spacing: 0.02em; font-weight: 400; }
body.stagelight .tour-table td, body.stagelight .tour-table th[scope="row"] { vertical-align: top; }
/* Mobile: the capped table scrolls sideways; a legacy card-layout rule zeroed the
   signal columns' min-width, crushing RARITY/HEAT into tall word-per-line stacks. */
@media (max-width: 560px) {
  body.stagelight .tour-table .signal-cell { min-width: 150px; }
}
/* mobile-sort now wraps the shared custom-select; the inner summary is the pill */
body.stagelight .data-toolbar .mobile-sort { display: none; }
body.stagelight .show-filter { gap: 12px; }
/* The label span inside a custom-select summary reads as a mono overline */
body.stagelight .custom-select > summary > span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); }
@media (max-width: 760px) {
  body.stagelight .data-toolbar .mobile-sort { display: block; }
}

/* ---- RARITY FILTER ---- */
body.stagelight .rarity-filter { position: relative; }
body.stagelight .rarity-filter > summary {
  display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 16px;
  border-radius: var(--sl-r-pill); border: 1px solid var(--sl-line-strong); font-size: 13.5px; font-weight: 560; color: var(--sl-muted);
  transition: background 0.15s ease, color 0.15s ease;
}
body.stagelight .rarity-filter > summary:hover { color: var(--sl-ink); background: rgba(255,255,255,0.05); }
body.stagelight .rarity-filter[open] > summary { color: var(--sl-ink); border-color: var(--sl-line-strong); }
body.stagelight .rarity-filter > summary .sc-chev { position: static; transition: transform 0.2s ease; }
body.stagelight .rarity-filter[open] > summary .sc-chev { transform: rotate(180deg); }
body.stagelight .rf-active {
  display: inline-flex; align-items: center; justify-content: center; min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: var(--sl-r-pill); background: var(--sl-ink); color: #111; font-family: var(--sl-mono); font-size: 12px; font-weight: 640;
}
body.stagelight .rf-active[hidden] { display: none; }
body.stagelight .rarity-pop {
  position: absolute; top: 48px; left: 0; z-index: 40; min-width: 280px; padding: 10px;
  border-radius: var(--sl-r-md); background: rgba(19,19,22,0.97); border: 1px solid var(--sl-line-strong);
  box-shadow: var(--sl-shadow-2);
}
body.stagelight .rf-option {
  display: grid; grid-template-columns: auto 46px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: var(--sl-r-md); cursor: pointer; font-size: 13.5px; color: var(--sl-ink);
}
body.stagelight .rf-option:hover { background: rgba(255,255,255,0.05); }
body.stagelight .rf-option input {
  appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin: 0;
  border: 1.5px solid var(--sl-line-strong); border-radius: var(--sl-r-sm); cursor: pointer; position: relative;
}
body.stagelight .rf-option input:checked { background: var(--sl-ink); border-color: var(--sl-ink); }
body.stagelight .rf-option input:checked::after {
  content: ""; position: absolute; left: 4.5px; top: 1.5px; width: 4px; height: 8px;
  border: solid #111; border-width: 0 1.8px 1.8px 0; transform: rotate(45deg);
}
body.stagelight .rf-option .rarity-symbol { margin: 0; justify-self: start; }
body.stagelight .rf-count { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); font-variant-numeric: tabular-nums; }
body.stagelight .rf-clear {
  display: block; width: 100%; margin-top: 6px; padding: 9px 10px; border-top: 1px solid var(--sl-line);
  font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--sl-faint); text-align: left; border-radius: 0 0 var(--sl-r-md) var(--sl-r-md);
}
body.stagelight .rf-clear:hover { color: var(--sl-ink); }
@media (max-width: 760px) { body.stagelight .rarity-pop { left: auto; right: 0; } }

/* ---- SHOW-HIGHLIGHT DROPDOWN (custom, matches rarity filter) ---- */
body.stagelight .show-filter { position: relative; display: block; height: auto; padding: 0; border: 0; }
body.stagelight .show-filter > summary {
  display: inline-flex; align-items: center; gap: 12px; height: 40px; padding: 0 16px;
  border-radius: var(--sl-r-pill); border: 1px solid var(--sl-line-strong);
  transition: background 0.15s ease;
}
body.stagelight .show-filter > summary:hover { background: rgba(255,255,255,0.05); }
body.stagelight .show-filter[open] > summary { border-color: var(--sl-line-strong); }
body.stagelight .show-filter > summary .sc-chev { position: static; color: var(--sl-faint); transition: transform 0.2s ease; }
body.stagelight .show-filter[open] > summary .sc-chev { transform: rotate(180deg); }
body.stagelight .sf-value { font-size: 13.5px; font-weight: 580; color: var(--sl-ink); }
body.stagelight .sf-pop {
  position: absolute; top: 48px; left: 0; z-index: 40; min-width: 300px; max-height: 344px; overflow-y: auto; padding: 8px;
  border-radius: var(--sl-r-md); background: rgba(19,19,22,0.97); border: 1px solid var(--sl-line-strong);
  box-shadow: var(--sl-shadow-2);
}
body.stagelight .sf-option {
  display: block; width: 100%; text-align: left; padding: 10px 12px; border-radius: var(--sl-r-md);
  font-size: 13.5px; color: var(--sl-muted); font-variant-numeric: tabular-nums;
}
body.stagelight .sf-option:hover { background: rgba(255,255,255,0.05); color: var(--sl-ink); }
body.stagelight .sf-option.is-active { color: var(--sl-ink); font-weight: 600; }
body.stagelight .sf-option.is-active::after { content: "\\2713"; float: right; color: var(--sl-faint); }

/* ---- STATS DISCLOSURE (accordion) ---- */
body.stagelight .stats-disclosure > summary { cursor: pointer; }
body.stagelight .stats-disclosure > summary:hover h2 { color: #fff; }
body.stagelight .stats-disclosure > summary .sc-chev { position: static; margin-left: 4px; align-self: center; color: var(--sl-faint); transition: transform 0.22s ease; }
body.stagelight .stats-disclosure[open] > summary .sc-chev { transform: rotate(180deg); }
body.stagelight .stats-disclosure:not([open]) > summary.section-heading { margin-bottom: 0; }

/* ---- TOUR-STATS TABLE: capped preview + expand affordance ---- */
body.stagelight .tour-table-wrap.is-capped { max-height: 560px; overflow-y: auto; position: relative; border-radius: var(--sl-r-md); -webkit-mask-image: linear-gradient(180deg, #000 92%, transparent); mask-image: linear-gradient(180deg, #000 92%, transparent); scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
/* Nick stats: stat tiles + progress on the left; a slim, simply-filtered list on
   the right. Kills the second full-width spreadsheet on the page. */
body.stagelight .nick-two-col { display: grid; grid-template-columns: 1fr 1.35fr; gap: 44px 56px; align-items: start; }
body.stagelight .nick-two-col .nick-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
body.stagelight .nick-two-col .nick-progress { margin: 26px 0 0; }
body.stagelight .nick-two-col .nick-controls { margin-bottom: 14px; display: flex; flex-wrap: wrap; gap: 8px; }
body.stagelight .nick-two-col .nick-chip-group button { padding: 7px 13px; font-size: 12.5px; }
@media (max-width: 900px) { body.stagelight .nick-two-col { grid-template-columns: 1fr; gap: 26px; } }
/* Nick's ranking gets the same capped-scroll treatment as the Tour Stats table. */
body.stagelight .nick-ranking-wrap.is-capped { max-height: 520px; overflow-y: auto; -webkit-mask-image: linear-gradient(180deg, #000 92%, transparent); mask-image: linear-gradient(180deg, #000 92%, transparent); scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
body.stagelight .tour-table-wrap.is-capped::-webkit-scrollbar { width: 8px; }
body.stagelight .tour-table-wrap.is-capped::-webkit-scrollbar-track { background: transparent; }
body.stagelight .tour-table-wrap.is-capped::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
body.stagelight .tour-table-wrap.is-capped::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.24); border: 2px solid transparent; background-clip: content-box; }
body.stagelight .tour-table thead th { position: sticky; top: 0; z-index: 3; background: #101013; }
body.stagelight .tour-table-wrap.is-capped thead th:first-child { border-top-left-radius: var(--sl-r-md); }
body.stagelight .tour-table-wrap.is-capped thead th:last-child { border-top-right-radius: var(--sl-r-md); }
/* Color-coded last-four rail on the song name cell */
body.stagelight .tour-table tbody th[scope="row"] { position: relative; }
/* Full row height with no radius so consecutive rows' bars read as continuous
   vertical strips; multiple shows stack side by side, never overlapping. */
body.stagelight .lf-rail { position: absolute; left: 0; top: 0; bottom: 0; display: flex; gap: 1px; }
body.stagelight .lf-rail i { display: block; width: 2px; background: currentColor; }
/* A second (older) show reads as a barely-there sliver, essentially a right-edge accent. */
body.stagelight .lf-rail i:nth-child(n+2) { width: 1px; }
body.stagelight .lf-rail .rail-black { color: #2e2e30; }
body.stagelight .lf-rail .rail-blue { color: #465692; }
body.stagelight .lf-rail .rail-green { color: #47866a; }
body.stagelight .lf-rail .rail-red { color: #d4514f; }
body.stagelight .tour-table tbody th[scope="row"] { padding-left: 18px; }
/* Not-played toggle chip */
body.stagelight .np-toggle { height: 40px; padding: 0 16px; border-radius: var(--sl-r-pill); border: 1px solid var(--sl-line-strong); background: rgba(255,255,255,0.04); color: var(--sl-muted); font-size: 13px; font-weight: 560; cursor: pointer; }
body.stagelight .np-toggle:hover { color: var(--sl-ink); }
body.stagelight .np-toggle[aria-pressed="true"], body.stagelight .np-toggle.is-active { background: var(--sl-ink); color: #111; border-color: var(--sl-ink); }
/* Highlight-a-show: rows wash in the show's tint. For the last four shows the
   always-on left rail already carries the marker color at full height, so no
   inset bar (it collided with the rail and read as a glitch). Older shows have
   no rail, so the white highlight keeps its inset bar. */
body.stagelight .tour-table tbody tr.is-selected-show { background: rgba(255,255,255,0.08); box-shadow: inset 3px 0 0 #e8e6e1; }
body.stagelight .tour-stats[data-hl="black"] .tour-table tbody tr.is-selected-show { background: rgba(255,255,255,0.06); box-shadow: none; }
body.stagelight .tour-stats[data-hl="blue"] .tour-table tbody tr.is-selected-show { background: rgba(70,86,146,0.16); box-shadow: none; }
body.stagelight .tour-stats[data-hl="green"] .tour-table tbody tr.is-selected-show { background: rgba(71,134,106,0.14); box-shadow: none; }
body.stagelight .tour-stats[data-hl="red"] .tour-table tbody tr.is-selected-show { background: rgba(212,81,79,0.12); box-shadow: none; }
body.stagelight .stats-expand {
  display: block; width: 100%; margin: 14px 0 0; padding: 12px; border-radius: var(--sl-r-sm);
  border: 1px solid var(--sl-line-strong); background: transparent; color: var(--sl-muted);
  font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
body.stagelight .stats-expand:hover { background: rgba(255,255,255,0.05); color: var(--sl-ink); }
/* When a capped list is expanded, its collapse control pins to the bottom of the
   viewport so you can close it from anywhere in the long list. */
body.stagelight .stats-expand.is-pinned { position: sticky; bottom: 14px; z-index: 4; background: rgba(20,20,23,0.92); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: 0 10px 40px -12px rgba(0,0,0,0.7); }

/* "What these mean" — quiet footnote toggle, not a bolted-on bar. */
body.stagelight .index-method { border-bottom: 0; margin-top: 6px; }
body.stagelight .index-method > summary {
  min-height: 44px; justify-content: flex-start; gap: 8px;
  font-family: var(--sl-mono); font-size: 11px; font-weight: 500; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--sl-faint); transition: color 0.15s ease;
}
body.stagelight .index-method > summary:hover { color: var(--sl-muted); }
body.stagelight .index-method > summary svg { flex: none; opacity: 0.7; margin-right: 9px; }
body.stagelight .index-method > summary span { display: inline-block; }
@supports (gap: 8px) { body.stagelight .index-method > summary svg { margin-right: 0; } }
body.stagelight .index-method > summary::after { content: none; }
body.stagelight .index-method[open] > summary { color: var(--sl-muted); }
body.stagelight .index-method > div {
  border: 1px solid var(--sl-line); border-radius: var(--sl-r-md); background: var(--sl-glass);
  padding: 18px 20px; margin-bottom: 8px;
}
body.stagelight .index-method p { color: var(--sl-muted); font-size: 13.5px; line-height: 1.6; }
body.stagelight .index-method strong { color: var(--sl-ink); }

/* ---- SONGS NOT PLAYED (expandable) ---- */
body.stagelight .not-played { margin-top: 16px; border-top: 1px solid var(--sl-line); }
body.stagelight .not-played > summary {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer;
  padding: 16px 2px 6px; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--sl-faint);
}
body.stagelight .not-played > summary:hover { color: var(--sl-ink); }
body.stagelight .not-played > summary .sc-chev { position: static; color: var(--sl-faint); transition: transform 0.22s ease; }
body.stagelight .not-played[open] > summary .sc-chev { transform: rotate(180deg); }
body.stagelight .np-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 2px 24px; padding: 12px 0 6px; }
body.stagelight .np-list li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 7px 2px; border-bottom: 1px solid var(--sl-line-faint); }
body.stagelight .np-title { color: var(--sl-muted); font-size: 14px; }
body.stagelight .np-meta { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.04em; color: var(--sl-faint); white-space: nowrap; }

/* ---- TONIGHT'S ODDS ---- */
body.stagelight .tonight-odds {
  margin: 0 0 22px; border-radius: var(--sl-r); overflow: hidden;
  border: 1px solid rgba(212,81,79,0.4); background: linear-gradient(180deg, rgba(212,81,79,0.10), rgba(16,16,18,0.4));
}
body.stagelight .tonight-toggle {
  display: flex; align-items: center; gap: 18px; width: 100%; padding: 18px 22px; cursor: pointer;
  background: transparent; border: 0; text-align: left; color: var(--sl-ink);
}
body.stagelight .tn-live { display: inline-flex; align-items: center; gap: 8px; font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-ink); }
body.stagelight .tn-lead { font-family: var(--sl-display); font-weight: 620; font-size: 18px; letter-spacing: -0.005em; }
body.stagelight .tonight-toggle .sc-chev { position: static; margin-left: auto; color: var(--sl-faint); transition: transform 0.22s ease; }
body.stagelight .tonight-odds.is-open .tonight-toggle .sc-chev { transform: rotate(180deg); }
body.stagelight .tonight-panel-wrap { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 0.25s ease; }
body.stagelight .tonight-odds.is-open .tonight-panel-wrap { grid-template-rows: 1fr; }
body.stagelight .tonight-panel { overflow: hidden; min-height: 0; }
body.stagelight .tn-list { padding: 4px 22px 8px; }
body.stagelight .tn-row { display: flex; align-items: center; gap: 16px; padding: 11px 0; border-top: 1px solid var(--sl-line-faint); }
body.stagelight .tn-rank { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); min-width: 22px; font-variant-numeric: tabular-nums; }
body.stagelight .tn-song { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
body.stagelight .tn-song { font-family: var(--sl-display); font-weight: 600; font-size: 16px; color: var(--sl-ink); }
body.stagelight .tn-hint { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.03em; font-weight: 400; color: var(--sl-faint); }
body.stagelight .tn-reason { font-family: var(--sl-display); font-weight: 500; font-size: 12.5px; font-style: italic; color: #e6cf9e; line-height: 1.4; display: block; margin: 1px 0; }
body.stagelight .tn-note-icon { font-style: normal; font-size: 10px; margin-right: 4px; opacity: 0.85; }
body.stagelight .tn-reason-pct { font-family: var(--sl-mono); font-style: normal; font-size: 10.5px; color: #e0be7a; opacity: 0.85; }
body.stagelight .tn-heat { display: inline-flex; align-items: center; gap: 12px; margin-left: auto; }
body.stagelight .tn-tier { font-family: var(--sl-mono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .tn-heat b { font-variant-numeric: tabular-nums; font-size: 17px; font-weight: 640; min-width: 30px; text-align: right; }
body.stagelight .tn-hot .tn-tier, body.stagelight .tn-hot .tn-heat b { color: #e5726f; }
body.stagelight .tn-warm .tn-tier, body.stagelight .tn-warm .tn-heat b { color: #e5b3b1; }
body.stagelight .tn-long .tn-heat b { color: var(--sl-muted); }
body.stagelight .tn-disclaimer { padding: 8px 22px 20px; font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.04em; color: var(--sl-faint); }
@media (prefers-reduced-motion: reduce) { body.stagelight .tonight-panel-wrap { transition: none; } }
@media (max-width: 560px) { body.stagelight .tn-lead { font-size: 15px; } body.stagelight .tonight-toggle { gap: 12px; padding: 16px; } }

/* ---- FOOTER CREDIT ---- */
body.stagelight .site-credit { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; color: var(--sl-faint); }
body.stagelight .site-credit:hover { color: var(--sl-ink); }

body.stagelight .tour-stats { padding: 26px 28px 20px; }
body.stagelight .tour-table th, body.stagelight .tour-table td,
body.stagelight .data-table th, body.stagelight .data-table td { padding: 16px 18px; }
body.stagelight .rarity-symbol { display: inline-flex; align-items: center; min-width: 26px; margin-right: 8px; }
body.stagelight .rarity-symbol svg { height: 10px; width: auto; display: block; }
/* In the Tour Stats rarity cell the symbol sits inline with the label, so drop
   the alignment min-width/margin and use one small consistent gap. */
body.stagelight .rarity-cell strong { gap: 6px; }
body.stagelight .rarity-cell .rarity-symbol { min-width: 0; margin-right: 0; }

/* ---- BOARD INTRO ---- */
body.stagelight .board-intro { position: relative; margin-top: 96px; }
/* Stage light: a soft beam falls on the intro, tinted from the hero photo. */
body.stagelight .board-intro::before {
  content: ""; position: absolute; left: -12%; top: -170px; width: 74%; height: 340px;
  background: radial-gradient(52% 58% at 32% 38%, var(--hero-glow, rgba(255,186,128,0.10)), transparent 74%);
  pointer-events: none;
}
body.stagelight .board-intro { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr); gap: 32px 72px; align-items: center; }
body.stagelight .board-intro-line {
  position: relative; font-family: var(--sl-display);
  font-size: 27px; font-weight: 640; letter-spacing: -0.015em; line-height: 1.42;
}
body.stagelight .bi-lead { color: var(--sl-ink); }
body.stagelight .bi-rest { color: rgba(242,242,240,0.5); }
/* Marker swipes: the four most recent shows as big highlighter strokes. Straight
   left-to-right; the imperfection is the right edge, clipped at a per-stroke
   diagonal (--cut) like the marker lifting off the page. */
body.stagelight .bi-swipes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 18px; }
body.stagelight .bi-swipe {
  position: relative; display: flex; align-items: center;
  padding: 12px 26px 14px 20px; background: var(--mc);
  border-radius: 10px 4px 14px 8px / 14px 6px 10px 12px;
  clip-path: polygon(0 0, 100% 0, var(--cut, 96%) 100%, 0 100%);
  box-shadow: 0 0 0 1px rgba(255,255,255,0.14), 0 18px 34px -18px rgba(0,0,0,0.75);
  transition: filter 0.2s ease;
}
/* Ink texture: a light entry edge fading into a darker dry-out, like one pass of a marker. */
body.stagelight .bi-swipe::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: linear-gradient(100deg, rgba(255,255,255,0.12), transparent 34%, rgba(0,0,0,0.16) 90%);
}
body.stagelight .bi-swipe:hover { filter: brightness(1.12); }
body.stagelight .bi-swipe b { font-family: "PanicHand", "MilkRun", var(--sl-display), sans-serif; font-size: 26px; font-weight: 400; letter-spacing: 0.01em; color: rgba(255,255,255,0.96); line-height: 1.05; }
@media (max-width: 900px) {
  body.stagelight .board-intro { grid-template-columns: 1fr; gap: 28px; }
  body.stagelight .board-intro-line { font-size: 26px; }
  body.stagelight .bi-swipe { padding: 13px 16px 12px; }
  body.stagelight .bi-swipe b { font-size: 17px; }
}
body.stagelight main > .board-intro + section { margin-top: 68px; }

/* ---- SHEET KEY (quiet disclosure only; the color key is the intro's bi-swipes) ---- */
body.stagelight .sheet-key { margin-bottom: 34px; }
body.stagelight .key-more { margin-top: 24px; }
body.stagelight .key-more summary { list-style: none; cursor: pointer; }
body.stagelight .key-more summary::-webkit-details-marker { display: none; }
body.stagelight .key-more summary .sc-chev { position: static; align-self: center; transition: transform 0.2s ease; }
body.stagelight .key-more[open] summary .sc-chev { transform: rotate(180deg); }
/* Ramp-style explainer: four equal columns, lead words bold, plain language. */
body.stagelight .key-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 36px; margin-top: 22px; }
body.stagelight .key-grid p { margin: 0; font-size: 14.5px; line-height: 1.6; color: var(--sl-muted); }
body.stagelight .key-grid b { color: var(--sl-ink); font-weight: 650; }
@media (max-width: 900px) {
  body.stagelight .key-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
}
@media (max-width: 560px) { body.stagelight .key-grid { grid-template-columns: 1fr; } }

/* ---- HOME SECTION NAV (sticky breadcrumbs) ---- */
/* Quiet glass bar under the sticky site header. Rides up with the header when it
   hides on scroll-down (body.nav-hidden), mirroring the .song-search pattern. */
/* Full-width section breadcrumb: no card, no top line (the header's own bottom
   border is the top edge), just a bottom hairline. Starts on the page's left
   rail, tight vertical padding, opaque-enough glass to hold over the white boards. */
body.stagelight .home-nav {
  position: sticky; top: 66px; z-index: 55;
  transition: top 0.28s ease;
  display: flex; flex-wrap: wrap; align-items: center; gap: 2px 7px;
  width: 100vw; margin: 0 calc(50% - 50vw);
  padding: 4px max(28px, calc((100% - 1400px) / 2));
  border-bottom: 1px solid rgba(255,255,255,0.08);
  background: rgba(11,11,13,0.62); -webkit-backdrop-filter: blur(16px) saturate(1.4); backdrop-filter: blur(16px) saturate(1.4);
}
body.stagelight.nav-hidden .home-nav { top: 0; }
body.stagelight .home-nav a {
  font-family: var(--sl-mono); font-size: 10px; letter-spacing: 0.09em; text-transform: uppercase;
  color: var(--sl-faint); text-decoration: none; padding: 3px 0;
  transition: color 0.16s ease;
}
body.stagelight .home-nav a:hover { color: var(--sl-muted); }
body.stagelight .home-nav a.is-active { color: var(--sl-ink); }
body.stagelight .home-nav-sep { color: var(--sl-faint); font-size: 10px; opacity: 0.45; }
@media (max-width: 560px) {
  body.stagelight .home-nav { gap: 2px 6px; padding-top: 6px; padding-bottom: 6px; }
  body.stagelight .home-nav a { font-size: 10px; letter-spacing: 0.08em; }
}

/* ---- UPCOMING FLAG (hero upcoming card) ---- */
body.stagelight .ns-flag {
  margin-left: auto; display: inline-flex; align-items: center; gap: 9px;
  font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--sl-muted); border: 1px solid var(--sl-line-strong); border-radius: var(--sl-r-pill); padding: 8px 16px; white-space: nowrap;
}
body.stagelight .ns-flag.is-tonight { color: var(--sl-ink); border-color: rgba(212,81,79,0.5); }
@media (max-width: 760px) { body.stagelight .ns-flag { margin-left: 0; } }

/* ---- HERO PHOTO SHEEN ---- */
body.stagelight .sc-photo::after { content: ""; position: absolute; inset: 0; border-radius: var(--sl-r-md); background: linear-gradient(200deg, rgba(255,255,255,0.10), transparent 38%); pointer-events: none; }

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
body.stagelight .shelf-card .to { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.18em; color: var(--sl-faint); text-transform: uppercase; margin: 7px 0 0; }
body.stagelight .shelf-card .song { font-size: 17px; font-weight: 580; margin: 16px 0 0; line-height: 1.35; }
body.stagelight .shelf-card .slp { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.1em; color: var(--sl-muted); margin: 6px 0 0; }
body.stagelight .heat-hot { border-color: rgba(212,81,79,0.42); box-shadow: var(--sl-glass-shadow), 0 0 56px -6px rgba(212,81,79,0.35), inset 0 1px 0 rgba(255,177,175,0.16); }
body.stagelight .heat-hot .n { color: #ef9390; text-shadow: 0 0 24px rgba(212,81,79,0.65); }
body.stagelight .heat-warm { border-color: rgba(212,81,79,0.2); box-shadow: var(--sl-glass-shadow), 0 0 40px -8px rgba(212,81,79,0.16); }
body.stagelight .heat-warm .n { color: #e5b3b1; }
body.stagelight .shelf-note { font-size: 13.5px; color: var(--sl-faint); margin-top: 18px; }
@media (max-width: 900px) { body.stagelight .shelf-grid { grid-template-columns: 1fr; } }

body.stagelight .ticket-link { text-decoration: none; }

/* ---- THE PAPER SHEETS: keep white, add the spotlight case ---- */
/* the sheets are paper artifacts — undo the dark-page text/heading cascade */
body.stagelight .laminate { position: relative; color: #111; }

/* ---- REAL LAMINATE: clear plastic pouch sealed around the paper ---- */
body.stagelight .laminate {
  border: 0;
  border-radius: 4px;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.06),
    0 30px 80px rgba(0, 0, 0, 0.55);
}
/* the clear plastic rim sealed past the paper edge — thin, and it shares its
   exact geometry with the glare overlay below so the two always line up */
body.stagelight .laminate::before {
  content: "";
  position: absolute;
  inset: -10px;
  z-index: -1;
  border-radius: 10px;
  background: linear-gradient(118deg,
    rgba(255, 255, 255, 0.20) 0%,
    rgba(255, 255, 255, 0.07) 24%,
    rgba(255, 255, 255, 0.15) 48%,
    rgba(255, 255, 255, 0.05) 70%,
    rgba(255, 255, 255, 0.18) 100%);
  border: 1px solid rgba(255, 255, 255, 0.38);
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, 0.45),
    inset 0 -1px 2px rgba(0, 0, 0, 0.3),
    0 24px 60px rgba(0, 0, 0, 0.55),
    0 -20px 90px 12px rgba(255, 243, 224, 0.09);
}
/* specular glare: a single px-bounded radial anchored top-left that fades out
   naturally — no background-size cutoff, no seam to mismatch the rim */
body.stagelight .laminate::after {
  content: "";
  position: absolute;
  inset: -10px;
  z-index: 6;
  border-radius: 10px;
  pointer-events: none;
  background: radial-gradient(1200px 420px at 8% -80px, rgba(255, 255, 255, 0.17), transparent 62%);
}

/* ---- DRY-ERASE STRIKES: SVG marker swipes over played songs ---- */
/* the ink block: translucent marker fill covering the whole word, with a
   chisel/diagonal right end via clip-path (crisp at any width) */
.marker-ink {
  display: block; width: 100%; height: 100%;
  background: var(--mc);
  opacity: 0.62;
  mix-blend-mode: multiply;
  border-radius: 1px;
  clip-path: polygon(0.6% 12%, 99% 3%, 100% 82%, 93% 100%, 1% 92%);
  transform-origin: left center;
}
.marker-mask.sv1 { transform: rotate(-1deg) translateY(var(--dy, 0px)); }
.marker-mask.sv2 { transform: rotate(0.7deg) translateY(var(--dy, 0px)); }
.marker-mask.sv3 { transform: rotate(-0.5deg) translateY(var(--dy, 0px)); }
.marker-mask.sv4 { transform: rotate(1deg) translateY(var(--dy, 0px)); }
.marker-mask.sv2 .marker-ink { clip-path: polygon(0.6% 6%, 99% 12%, 100% 96%, 92% 88%, 1% 98%); }
.marker-mask.sv4 .marker-ink { clip-path: polygon(0.6% 9%, 99% 4%, 100% 90%, 94% 98%, 1% 95%); }
/* draw-in: the marker wipes across left-to-right as the board scrolls in */
.can-strike .marker-ink { transform: scaleX(0); }
.can-strike .marker-mask.draw .marker-ink { animation: strike-wipe 0.28s cubic-bezier(0.5, 0, 0.4, 1) forwards; animation-delay: var(--sd, 0s); }
@keyframes strike-wipe { to { transform: scaleX(1); } }
@media (prefers-reduced-motion: reduce) {
  .can-strike .marker-ink { transform: scaleX(1); animation: none !important; }
}

/* ============================================================
   STAGELIGHT — SECONDARY CONTENT PAGES (archive, origins,
   shelf, rumors, tour-in-review, privacy). Legacy structure is
   hoisted out of .laminate above; here we recolor for dark.
   ============================================================ */
/* strip the legacy white "paper card" wrapper so dark text/glass read right */
body.stagelight .archive-page, body.stagelight .archive-index {
  background: transparent; border: 0; border-radius: 0; padding: 0;
}
body.stagelight .archive-main { width: min(680px, calc(100% - 48px)); margin: 56px auto 0; color: var(--sl-ink); }
body.stagelight .origins-main, body.stagelight .tour-review-main { width: min(1180px, calc(100% - 48px)); }
body.stagelight .archive-page { color: var(--sl-ink); }
body.stagelight .origin-hero { border-bottom: 1px solid var(--sl-line); padding-bottom: 26px; }

/* page titles: hide the light-on-transparent graphic PNGs, promote the h1 */
body.stagelight .page-graphic-title { display: block; margin: 8px 0 40px; }
body.stagelight .page-graphic-title img { display: none; }
body.stagelight .page-graphic-title h1,
body.stagelight .archive-title h1 {
  position: static; width: auto; height: auto; clip: auto; margin: 0;
  font-family: var(--sl-display); font-weight: 660; font-size: clamp(34px, 5vw, 52px);
  letter-spacing: -0.02em; line-height: 1.04; color: var(--sl-ink);
}
body.stagelight .archive-title { margin-bottom: 34px; border-bottom: 1px solid var(--sl-line); padding-bottom: 24px; }
body.stagelight .archive-title p { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); margin-bottom: 12px; }
/* breadcrumbs */
body.stagelight .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 16px; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; }
body.stagelight .crumbs a { color: var(--sl-faint); }
body.stagelight .crumbs a:hover { color: var(--sl-ink); }
body.stagelight .crumbs [aria-current="page"] { color: var(--sl-muted); }
body.stagelight .crumb-sep { color: var(--sl-faint); opacity: 0.6; }
body.stagelight .archive-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
body.stagelight .archive-tags span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-muted); border: 1px solid var(--sl-line-strong); border-radius: var(--sl-r-pill); padding: 5px 12px; }

/* imported Blogger prose — editorial, left-aligned, no Word-doc centering */
body.stagelight .archive-content { color: var(--sl-muted); font-size: 17px; line-height: 1.7; text-align: left; }
body.stagelight .archive-content [style*="text-align"], body.stagelight .archive-content [align] { text-align: left !important; }
body.stagelight .archive-content div { text-align: left; }
body.stagelight .archive-content p { margin: 0 0 18px; color: var(--sl-muted); }
body.stagelight .archive-content b, body.stagelight .archive-content strong { color: var(--sl-ink); font-weight: 620; }
body.stagelight .archive-content h2, body.stagelight .archive-content h3, body.stagelight .archive-content h4 { font-family: var(--sl-display); color: var(--sl-ink); letter-spacing: -0.01em; margin: 34px 0 14px; line-height: 1.15; }
body.stagelight .archive-content h2 { font-size: 26px; }
body.stagelight .archive-content h3 { font-size: 21px; }
body.stagelight .archive-content a { color: var(--sl-ink); text-decoration: underline; text-decoration-color: var(--sl-line-strong); text-underline-offset: 3px; }
body.stagelight .archive-content a:hover { text-decoration-color: var(--sl-ink); }
body.stagelight .archive-content ul, body.stagelight .archive-content ol { margin: 0 0 18px; padding-left: 22px; list-style: revert; }
body.stagelight .archive-content li { margin: 0 0 7px; }
body.stagelight .archive-content img { border-radius: var(--sl-r-md); border: 1px solid var(--sl-line); margin: 8px 0; height: auto; }
body.stagelight .archive-content blockquote { border-left: 2px solid var(--sl-line-strong); margin: 0 0 18px; padding: 4px 0 4px 20px; color: var(--sl-faint); font-style: italic; }
body.stagelight .archive-content hr { border: 0; border-top: 1px solid var(--sl-line); margin: 30px 0; }
body.stagelight .archive-content table { width: 100%; border-collapse: collapse; margin: 0 0 20px; font-size: 15px; }
body.stagelight .archive-content th, body.stagelight .archive-content td { border-bottom: 1px solid var(--sl-line); padding: 10px 12px; text-align: left; }
body.stagelight .archive-content strong, body.stagelight .archive-content b { color: var(--sl-ink); }

/* ============================================================
   PROSE PLATE
   ------------------------------------------------------------
   ONE reading-typography system for every archive-derived body:
   individual archive posts, lyrics/chords pages, song-origin
   detail pages, and the shelf/rumors/privacy legacy prose. Each
   of those containers carries the shared .prose-plate class
   (alongside its own .archive-content / .origin-body hook), so
   the rules below apply everywhere long-form reading happens and
   nowhere else. Scope is typography + rhythm only: measure,
   vertical rhythm, hierarchy, lists, quotes, links, media. It
   layers on top of the legacy .archive-content baseline above and
   wins where the two overlap. The homepage sheet, albums, songs
   and the (already-designed) tour-review pages are untouched.

   Note on imported markup: the Blogger export wraps each line in a
   bare <div> and separates paragraphs with empty <div><br></div>
   spacers / literal <br><br> walls. We DON'T rewrite that (it would
   risk setlist/lyric line integrity) — the measure + line-height
   below turn those blank lines into clean editorial rhythm.
   ============================================================ */
body.stagelight .prose-plate {
  /* ~68 characters of running prose. Expressed in px because Geist's ch
     unit (the '0' width) overstates a comfortable measure by a wide margin. */
  --prose-measure: 640px;
  color: var(--sl-muted);
  font-size: 17px;
  line-height: 1.72;
  text-align: left;
  overflow-wrap: break-word;
}
/* keep every child inside the reading measure, kill Word-doc centering */
body.stagelight .prose-plate [style*="text-align"],
body.stagelight .prose-plate [align] { text-align: left !important; }
body.stagelight .prose-plate div { text-align: left; }

/* paragraph rhythm — real <p> get editorial spacing; Blogger's
   line-per-<div> blocks stay on the line grid (blank divs = gaps) */
body.stagelight .prose-plate p { margin: 0 0 1.15em; color: var(--sl-muted); }
body.stagelight .prose-plate p:last-child { margin-bottom: 0; }
body.stagelight .prose-plate > *:first-child { margin-top: 0; }

/* headings — display face, snapped to the type scale, clear hierarchy */
body.stagelight .prose-plate h2,
body.stagelight .prose-plate h3,
body.stagelight .prose-plate h4 {
  font-family: var(--sl-display); color: var(--sl-ink);
  letter-spacing: -0.015em; line-height: 1.16; text-wrap: balance;
}
body.stagelight .prose-plate h2 { font-size: 27px; margin: 1.85em 0 0.5em; }
body.stagelight .prose-plate h3 { font-size: 21px; margin: 1.6em 0 0.45em; }
body.stagelight .prose-plate h4 { font-size: 17.5px; letter-spacing: -0.005em; margin: 1.4em 0 0.4em; }
body.stagelight .prose-plate h2:first-child,
body.stagelight .prose-plate h3:first-child,
body.stagelight .prose-plate h4:first-child { margin-top: 0; }

/* emphasis — tasteful, not the Blogger heavy-bold wall */
body.stagelight .prose-plate b,
body.stagelight .prose-plate strong { font-weight: 600; color: var(--sl-ink); }
body.stagelight .prose-plate i,
body.stagelight .prose-plate em { font-style: italic; color: inherit; }

/* inline links — the site's underline-offset treatment, everywhere */
body.stagelight .prose-plate a {
  color: var(--sl-ink); text-decoration: underline;
  text-decoration-color: var(--sl-line-strong);
  text-decoration-thickness: 1px; text-underline-offset: 3px;
  overflow-wrap: break-word;
  transition: color 0.15s ease, text-decoration-color 0.15s ease;
}
body.stagelight .prose-plate a:hover { color: #fff; text-decoration-color: var(--sl-ink); }

/* lists — intentional indentation, colored markers, item rhythm
   (also de-lazies the Shelf's plain <ul>s via the shared system) */
body.stagelight .prose-plate ul,
body.stagelight .prose-plate ol { margin: 0 0 1.15em; padding-left: 0; }
body.stagelight .prose-plate li { margin: 0 0 0.5em; line-height: 1.6; }
body.stagelight .prose-plate li:last-child { margin-bottom: 0; }
body.stagelight .prose-plate ul { list-style: none; }
body.stagelight .prose-plate ul > li { position: relative; padding-left: 1.4em; }
body.stagelight .prose-plate ul > li::before {
  content: ""; position: absolute; left: 0.15em; top: 0.66em;
  width: 5px; height: 5px; border-radius: 50%; background: var(--sl-faint);
}
body.stagelight .prose-plate ol { list-style: none; counter-reset: prose-ol; padding-left: 0.2em; }
body.stagelight .prose-plate ol > li { position: relative; padding-left: 1.9em; counter-increment: prose-ol; }
body.stagelight .prose-plate ol > li::before {
  content: counter(prose-ol) "."; position: absolute; left: 0; top: 0;
  font-family: var(--sl-mono); font-size: 0.86em; color: var(--sl-faint);
  font-variant-numeric: tabular-nums;
}
body.stagelight .prose-plate li > ul,
body.stagelight .prose-plate li > ol { margin: 0.5em 0 0; }

/* blockquote — pull-quote treatment with a left rule; mono attribution */
body.stagelight .prose-plate blockquote {
  margin: 1.6em 0; padding: 2px 0 2px 22px;
  border-left: 2px solid var(--sl-line-strong);
  color: var(--sl-ink); font-size: 19px; line-height: 1.5; font-style: italic;
}
body.stagelight .prose-plate blockquote p { color: var(--sl-ink); }
body.stagelight .prose-plate blockquote cite,
body.stagelight .prose-plate blockquote footer {
  display: block; margin-top: 12px; font-style: normal;
  font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--sl-faint);
}

/* images / figures — rounded per tokens, subtle border+shadow, centered,
   never wider than the measure */
body.stagelight .prose-plate img {
  display: block; max-width: 100%; height: auto; margin: 1.7em auto;
  border-radius: var(--sl-r-md); border: 1px solid var(--sl-line);
  box-shadow: var(--sl-shadow-1);
}
body.stagelight .prose-plate figure { margin: 1.7em 0; }
body.stagelight .prose-plate figure img { margin: 0 auto; }
body.stagelight .prose-plate figcaption {
  margin-top: 10px; text-align: center; font-family: var(--sl-mono);
  font-size: 12px; letter-spacing: 0.04em; color: var(--sl-faint);
}

/* horizontal rule / section break — a tasteful fade, not a hard line */
body.stagelight .prose-plate hr {
  border: 0; height: 1px; width: 100%; margin: 2.4em auto;
  background: linear-gradient(90deg, transparent, var(--sl-line-strong) 50%, transparent);
}

/* code + monospace */
body.stagelight .prose-plate code,
body.stagelight .prose-plate kbd,
body.stagelight .prose-plate samp {
  font-family: var(--sl-mono); font-size: 0.9em;
  background: rgba(255,255,255,0.05); border: 1px solid var(--sl-line);
  border-radius: var(--sl-r-sm); padding: 1px 6px;
}
body.stagelight .prose-plate pre {
  font-family: var(--sl-mono); font-size: 13.5px; line-height: 1.6;
  background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line);
  border-radius: var(--sl-r-md); padding: 16px 18px; margin: 1.4em 0; overflow-x: auto;
}
body.stagelight .prose-plate pre code { background: none; border: 0; padding: 0; font-size: inherit; }

/* tables — hairline rows, tabular figures for numeric columns */
body.stagelight .prose-plate table { width: 100%; border-collapse: collapse; margin: 0 0 1.3em; font-size: 15px; }
body.stagelight .prose-plate th,
body.stagelight .prose-plate td { border-bottom: 1px solid var(--sl-line); padding: 10px 12px; text-align: left; }
body.stagelight .prose-plate th { color: var(--sl-ink); font-weight: 600; }
body.stagelight .prose-plate td { color: var(--sl-muted); font-variant-numeric: tabular-nums; }

/* song-origin prose sits in a wide 2-col grid cell — cap it to the
   same reading measure so the line length stays comfortable */
body.stagelight .origin-body.prose-plate { max-width: var(--prose-measure); }

/* song-origin cross-link at the foot of a lyrics/archive page */
body.stagelight .archive-crosslink { margin-top: 40px; }
body.stagelight .archive-crosslink a {
  display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 16px;
  padding: 22px 26px; border-radius: var(--sl-r); color: var(--sl-ink);
  background: var(--sl-glass); border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
  transition: transform 0.18s ease, border-color 0.18s ease;
}
body.stagelight .archive-crosslink a:hover { transform: translateY(-2px); border-color: var(--sl-line-strong); }
body.stagelight .xl-eyebrow { grid-column: 1; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .xl-title { grid-column: 1; font-family: var(--sl-display); font-size: 21px; font-weight: 600; letter-spacing: -0.01em; }
body.stagelight .xl-go { grid-column: 2; grid-row: 1 / span 2; font-size: 21px; color: var(--sl-faint); }
body.stagelight .archive-crosslink a:hover .xl-go { color: var(--sl-ink); }

/* archive + tour-review index lists */
body.stagelight .archive-index .archive-title p { text-transform: none; font-family: var(--ui-font); font-size: 15px; letter-spacing: 0; color: var(--sl-muted); }
body.stagelight .archive-list { display: grid; gap: 2px; }
body.stagelight .archive-list li { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: baseline; gap: 6px 18px; padding: 16px 6px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .archive-list a { font-size: 17px; font-weight: 540; color: var(--sl-ink); }
body.stagelight .archive-list a:hover { color: #fff; }
body.stagelight .archive-list span { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); }
body.stagelight .archive-list em { grid-column: 1 / -1; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sl-faint); font-style: normal; }

/* ---- ARCHIVE INDEX: grouped-by-year, searchable utility list ---- */
body.stagelight .archive-hub-title { border-bottom: 0; margin-bottom: 20px; padding-bottom: 0; }
body.stagelight .archive-hub-deck, body.stagelight .archive-title p.archive-hub-deck {
  font-family: var(--sl-display); font-size: 17px; line-height: 1.55; letter-spacing: -0.01em;
  text-transform: none; color: var(--sl-muted); margin: 14px 0 0; max-width: 66ch;
}
body.stagelight .archive-groups { display: grid; gap: 8px; }
body.stagelight .archive-year { padding: 6px 0; }
body.stagelight .archive-year[hidden] { display: none; }
body.stagelight .archive-year-head { display: flex; align-items: baseline; gap: 12px; margin: 20px 0 8px; font-family: var(--sl-mono); font-size: 15px; letter-spacing: 0.04em; color: var(--sl-ink); font-variant-numeric: tabular-nums; }
body.stagelight .archive-year-head span { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .archive-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
body.stagelight .archive-row[hidden] { display: none; }
body.stagelight .archive-row a { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: baseline; gap: 6px 18px; padding: 12px 6px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .archive-row a:hover { background: rgba(255,255,255,0.03); }
body.stagelight .ar-title { font-size: 16px; font-weight: 540; color: var(--sl-ink); overflow: hidden; text-overflow: ellipsis; }
body.stagelight .archive-row a:hover .ar-title { color: #fff; }
body.stagelight .ar-date { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); white-space: nowrap; font-variant-numeric: tabular-nums; }
@media (max-width: 640px) {
  body.stagelight .archive-row a { grid-template-columns: 1fr; gap: 3px; }
}

body.stagelight .current-review-link { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 30px; }
body.stagelight .current-review-link div { padding: 18px 22px; border-radius: var(--sl-r-md); background: var(--sl-glass); border: 1px solid var(--sl-line); }
body.stagelight .current-review-link a { color: var(--sl-ink); text-decoration: underline; text-underline-offset: 3px; }

/* ---- ALBUMS: index grid ---- */
/* Albums index rides the full 1400px header rail (like the homepage/stats page),
   so the grid's left edge lines up under the wordmark. The detail page stays on
   the narrower reading rail so its cover keeps matching the index card size. */
body.stagelight .albums-main { width: min(1400px, calc(100% - 56px)); }
/* Detail pages share the SAME left margin line as the index: left edge pinned to
   the 1400 rail, content keeps its narrower 1180 reading measure to the right. */
body.stagelight .album-main { width: min(1180px, calc(100% - 56px)); margin-left: max(28px, calc((100% - 1400px) / 2)); margin-right: auto; }
body.stagelight .albums-deck { font-size: 15px; color: var(--sl-muted); margin-top: 12px; }
body.stagelight .album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 22px; }
body.stagelight .album-tile { display: block; color: var(--sl-ink); }
body.stagelight .album-cover, body.stagelight .album-cover-lg {
  display: block; margin: 0; position: relative; aspect-ratio: 1 / 1; border-radius: var(--sl-r-md); overflow: hidden;
  border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow); background: rgba(255,255,255,0.03);
}
body.stagelight .album-cover img, body.stagelight .album-cover-lg img { width: 100%; height: 100%; object-fit: cover; }
body.stagelight .album-tile:hover .album-cover { transform: translateY(-3px); border-color: var(--sl-line-strong); transition: transform 0.18s ease, border-color 0.18s ease; }
body.stagelight .album-cover.is-empty, body.stagelight .album-cover-lg.is-empty { display: flex; align-items: center; justify-content: center; background: radial-gradient(120% 120% at 50% 0%, rgba(255,255,255,0.05), rgba(255,255,255,0.015) 60%, transparent), var(--sl-glass); }
body.stagelight .album-cover-fallback { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; padding: 22px; width: 100%; height: 100%; }
body.stagelight .acf-mark { width: 46%; max-width: 120px; height: auto; opacity: 0.5; }
body.stagelight .acf-title { font-family: var(--sl-display); font-weight: 640; font-size: 17px; letter-spacing: -0.01em; color: var(--sl-muted); }
body.stagelight .acf-note { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .album-tile-title { display: block; font-family: var(--sl-display); font-size: 17px; font-weight: 600; letter-spacing: -0.01em; margin-top: 14px; }
body.stagelight .album-tile-year { display: block; font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); margin-top: 3px; }

/* ---- ALBUMS: full-width atmospheric backdrop (color bled from the cover) ---- */
body.stagelight .album-backdrop { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
body.stagelight .album-backdrop::before {
  content: ""; position: absolute; inset: -12%;
  background-image: var(--album-art); background-size: cover; background-position: center 22%;
  filter: blur(90px) saturate(1.35); opacity: 0.55; transform: scale(1.25);
}
body.stagelight .album-backdrop::after {
  content: ""; position: absolute; inset: 0;
  background:
    radial-gradient(120% 80% at 50% -10%, transparent, rgba(11,11,12,0.5) 46%, rgba(11,11,12,0.82) 68%, var(--sl-bg) 92%),
    linear-gradient(180deg, rgba(11,11,12,0.35), var(--sl-bg) 88%);
}
body.stagelight.album-page-body .album-main { position: relative; z-index: 1; }
body.stagelight.album-page-body .album-cover-lg { box-shadow: 0 40px 90px -30px rgba(0,0,0,0.9), 0 0 0 1px var(--sl-line), inset 0 1px 0 rgba(255,255,255,0.08); }

/* ---- ALBUMS: single album page ---- */
body.stagelight .album-eyebrow { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint); margin-bottom: 10px; }
body.stagelight .album-layout { display: grid; grid-template-columns: calc((100% - 66px) / 4) minmax(0, 1fr); gap: 48px; align-items: start; margin-top: 8px; }
body.stagelight .album-aside { position: sticky; top: 92px; display: grid; gap: 20px; }
body.stagelight .album-cover-lg { aspect-ratio: 1 / 1; border-radius: var(--sl-r); }
body.stagelight .album-meta-label { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .album-meta-value { font-size: 15px; color: var(--sl-ink); margin-top: 5px; }
body.stagelight .album-listen-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
body.stagelight .album-blurb { font-size: 17px; line-height: 1.65; color: var(--sl-ink); margin: 0 0 30px; }
body.stagelight .album-footprint { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 34px; }
body.stagelight .album-footprint div { padding: 18px 20px; border-radius: var(--sl-r-md); background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line); }
body.stagelight .album-footprint strong { display: block; font-family: var(--sl-mono); font-size: 26px; font-weight: 640; color: var(--sl-ink); line-height: 1; }
body.stagelight .album-footprint span { display: block; font-size: 12px; letter-spacing: 0.04em; color: var(--sl-faint); margin-top: 8px; }
body.stagelight .album-tracks-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .album-tracks-head h2 { font-family: var(--sl-display); font-size: 21px; font-weight: 640; letter-spacing: -0.01em; }
body.stagelight .album-tracks-head span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .album-tracks { display: grid; gap: 2px; }
body.stagelight .album-track { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 14px 8px; border-bottom: 1px solid var(--sl-line-faint); }
body.stagelight .album-track:hover { background: rgba(255,255,255,0.025); }
body.stagelight .track-n { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); font-variant-numeric: tabular-nums; }
body.stagelight .track-title { font-size: 17px; font-weight: 520; color: var(--sl-ink); display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
body.stagelight .track-title small { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; color: var(--sl-faint); text-transform: uppercase; }
body.stagelight .track-stat { display: inline-flex; align-items: center; gap: 12px; white-space: nowrap; }
body.stagelight .track-live { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-ink); border: 1px solid rgba(45,124,82,0.55); border-radius: var(--sl-r-pill); padding: 4px 10px; }
body.stagelight .track-plays { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-muted); font-variant-numeric: tabular-nums; }
body.stagelight .track-freq { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
body.stagelight .album-track.no-data .track-title { color: var(--sl-muted); }
body.stagelight .album-pending { color: var(--sl-faint); font-size: 15px; }
body.stagelight .album-credits { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 22px 28px; margin-top: 40px; padding-top: 26px; border-top: 1px solid var(--sl-line); }
body.stagelight .credit-block h3 { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); margin-bottom: 8px; }
body.stagelight .credit-block p { font-size: 15px; line-height: 1.6; color: var(--sl-muted); }
body.stagelight .album-nav { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 52px; padding-top: 24px; border-top: 1px solid var(--sl-line); }
body.stagelight .album-nav a { display: grid; gap: 4px; color: var(--sl-muted); }
body.stagelight .album-nav a.is-next { text-align: right; }
body.stagelight .album-nav a span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .album-nav a strong { font-family: var(--sl-display); font-size: 17px; font-weight: 600; color: var(--sl-ink); }
body.stagelight .album-nav a:hover strong { color: #fff; }
@media (max-width: 820px) {
  body.stagelight .album-layout { grid-template-columns: 1fr; gap: 30px; }
  body.stagelight .album-aside { position: static; grid-template-columns: 160px 1fr; align-items: center; gap: 16px 22px; }
  body.stagelight .album-cover-lg { grid-row: 1 / span 3; }
  body.stagelight .album-footprint { grid-template-columns: 1fr; }
}
/* Mobile: the nowrap ON-THE-CURRENT-SHEET pill + plays ate the whole row and sat
   on top of the track title. Stack the stat line under the title instead. */
@media (max-width: 560px) {
  body.stagelight .album-track { grid-template-columns: 34px minmax(0, 1fr); row-gap: 8px; }
  body.stagelight .album-track .track-stat { grid-column: 2; grid-row: 2; justify-content: flex-start; flex-wrap: wrap; white-space: normal; }
}

/* song index + per-song history */
body.stagelight .songs-main { width: min(1180px, calc(100% - 28px)); }
body.stagelight .song-main { width: min(820px, calc(100% - 48px)); }
body.stagelight .shelf-main { width: min(1000px, calc(100% - 48px)); }
body.stagelight .songs-deck { font-size: 15px; color: var(--sl-muted); margin-top: 12px; }

/* ---- THE SHELF: designed data page (hero deck, stat strip via .song-stat,
   designed row list with gap meter, related-sheet cards) ---- */
body.stagelight .shelf-info-page .archive-title { border-bottom: 0; margin-bottom: 22px; padding-bottom: 0; }
body.stagelight .archive-title p.shelf-deck { font-family: var(--sl-display); font-size: 17px; line-height: 1.55; letter-spacing: -0.01em; text-transform: none; color: var(--sl-muted); margin: 14px 0 0; max-width: 62ch; }
body.stagelight .shelf-list-section, body.stagelight .shelf-neighbors { margin-top: 52px; }
body.stagelight .shelf-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; padding-bottom: 14px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .shelf-section-head h2 { font-family: var(--sl-display); font-size: 21px; font-weight: 640; letter-spacing: -0.01em; color: var(--sl-ink); }
body.stagelight .shelf-section-head span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .shelf-list { display: flex; flex-direction: column; }
body.stagelight .shelf-row {
  display: grid; grid-template-columns: minmax(0, 1fr) 96px 132px 168px; align-items: center; gap: 20px;
  padding: 14px 10px; color: var(--sl-ink); border-bottom: 1px solid var(--sl-line-faint); transition: background 0.16s ease;
}
body.stagelight .shelf-row:hover { background: rgba(255,255,255,0.03); }
body.stagelight .shelf-row.is-compact { grid-template-columns: minmax(0, 1fr) 132px 96px; }
body.stagelight .shr-title { font-family: var(--sl-display); font-size: 15px; font-weight: 560; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body.stagelight .shr-type { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .shr-last { font-family: var(--sl-mono); font-size: 13.5px; color: var(--sl-muted); font-variant-numeric: tabular-nums; }
body.stagelight .shr-last small { display: block; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-faint); margin-top: 2px; }
body.stagelight .shr-gap { display: flex; align-items: center; gap: 12px; justify-content: flex-end; }
body.stagelight .shr-meter { flex: 1; min-width: 40px; height: 5px; border-radius: var(--sl-r-pill); background: rgba(255,255,255,0.07); overflow: hidden; }
body.stagelight .shr-meter i { display: block; height: 100%; border-radius: var(--sl-r-pill); background: linear-gradient(90deg, rgba(212,81,79,0.55), rgba(212,81,79,0.95)); }
body.stagelight .shr-gap-num { flex: none; text-align: right; font-family: var(--sl-mono); font-size: 15px; color: var(--sl-ink); font-variant-numeric: tabular-nums; }
body.stagelight .shr-gap-num small { display: block; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-faint); margin-top: 2px; }
body.stagelight .shelf-more { margin-top: 18px; font-size: 14px; color: var(--sl-muted); }
body.stagelight .shelf-more a { color: var(--sl-ink); text-decoration: underline; text-decoration-color: var(--sl-line-strong); text-underline-offset: 3px; }
body.stagelight .shelf-more a:hover { text-decoration-color: var(--sl-ink); }
body.stagelight .shelf-empty { color: var(--sl-faint); font-size: 15px; padding: 14px 10px; }
body.stagelight .shelf-neighbor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
body.stagelight .shelf-neighbor { display: flex; flex-direction: column; gap: 8px; padding: 22px 22px 20px; border-radius: var(--sl-r-md); border: 1px solid var(--sl-line); background: rgba(255,255,255,0.03); transition: border-color 0.16s ease, background 0.16s ease; }
body.stagelight .shelf-neighbor:hover { border-color: var(--sl-line-strong); background: rgba(255,255,255,0.05); }
body.stagelight .shn-count { font-family: var(--sl-mono); font-size: 26px; font-weight: 640; color: var(--sl-ink); line-height: 1; font-variant-numeric: tabular-nums; }
body.stagelight .shn-count small { margin-left: 8px; font-size: 11px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .shn-name { font-family: var(--sl-display); font-size: 18px; font-weight: 640; letter-spacing: -0.01em; color: var(--sl-ink); }
body.stagelight .shn-desc { font-size: 14px; line-height: 1.5; color: var(--sl-muted); }
body.stagelight .shn-go { margin-top: 4px; font-family: var(--sl-mono); font-size: 11.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .shelf-neighbor:hover .shn-go { color: var(--sl-muted); }
body.stagelight .legacy-shelf-notes { margin-top: 56px; }
@media (max-width: 640px) {
  body.stagelight .shelf-row { grid-template-columns: minmax(0, 1fr) 88px; grid-auto-rows: auto; row-gap: 6px; column-gap: 14px; }
  body.stagelight .shr-type { grid-column: 1; grid-row: 2; }
  body.stagelight .shr-last { grid-column: 1; grid-row: 3; }
  body.stagelight .shr-gap { grid-column: 2; grid-row: 1 / span 3; flex-direction: column; align-items: flex-end; justify-content: center; gap: 8px; }
  body.stagelight .shr-meter { width: 100%; flex: none; }
  body.stagelight .shelf-row.is-compact { grid-template-columns: minmax(0, 1fr) 88px; }
  body.stagelight .shelf-row.is-compact .shr-last { grid-column: 1; grid-row: 2; }
  body.stagelight .shelf-row.is-compact .shr-gap-num { grid-column: 2; grid-row: 1; }
}
body.stagelight .song-search {
  position: sticky; top: 78px; z-index: 3; display: flex; align-items: center; gap: 12px;
  transition: top 0.28s ease;
  margin: 28px 0 18px; padding: 13px 18px; border-radius: var(--sl-r-md);
  background: color-mix(in srgb, var(--sl-glass) 88%, #000); border: 1px solid var(--sl-line);
  box-shadow: var(--sl-glass-shadow); backdrop-filter: blur(14px);
}
body.stagelight .song-search svg { flex: none; color: var(--sl-faint); }
body.stagelight .song-search input {
  flex: 1; min-width: 0; background: transparent; border: 0; outline: none;
  color: var(--sl-ink); font-family: var(--sl-display); font-size: 17px; letter-spacing: -0.01em;
}
body.stagelight .song-search input::placeholder { color: var(--sl-faint); }
body.stagelight .song-count { flex: none; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-faint); white-space: nowrap; }
/* Shared index filter toolbar — Song Index + Lyrics & Chords hub. Reuses the
   homepage .type-filter button group; toggles + album select match its chip vocab. */
body.stagelight .index-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 0 0 22px; }
body.stagelight .index-toggle {
  height: 40px; padding: 0 16px; border-radius: var(--sl-r-pill);
  border: 1px solid var(--sl-line-strong); background: rgba(255,255,255,0.04);
  color: var(--sl-muted); font-size: 13px; font-weight: 560; letter-spacing: 0.01em; cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
}
/* Plain labeled checkboxes for boolean filters (owner: a checkbox, not a button). */
body.stagelight .index-check {
  display: inline-flex; align-items: center; gap: 9px; height: 40px; padding: 0 4px;
  color: var(--sl-muted); font-size: 13.5px; font-weight: 540; cursor: pointer; user-select: none;
}
body.stagelight .index-check:hover { color: var(--sl-ink); }
body.stagelight .index-check input {
  appearance: none; -webkit-appearance: none; width: 17px; height: 17px; margin: 0;
  border: 1px solid var(--sl-line-strong); border-radius: 5px; background: rgba(255,255,255,0.04);
  display: inline-grid; place-items: center; cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
body.stagelight .index-check input:checked { background: #d4514f; border-color: #d4514f; }
body.stagelight .index-check input:checked::after {
  content: ""; width: 9px; height: 5px; margin-top: -2px;
  border-left: 2px solid #fff; border-bottom: 2px solid #fff; transform: rotate(-45deg);
}
body.stagelight .index-check input:focus-visible { outline: 2px solid var(--sl-muted); outline-offset: 2px; }
body.stagelight .index-check:has(input:checked) { color: var(--sl-ink); }
body.stagelight .index-toggle:hover { color: var(--sl-ink); background: rgba(255,255,255,0.08); }
body.stagelight .index-toggle[aria-pressed="true"] { background: var(--sl-ink); color: #111; border-color: var(--sl-ink); }
body.stagelight .index-select {
  display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 8px 0 15px;
  border-radius: var(--sl-r-pill); border: 1px solid var(--sl-line-strong); background: rgba(255,255,255,0.04);
}
body.stagelight .index-select span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .index-select select {
  background: transparent; border: 0; outline: none; color: var(--sl-ink);
  font-family: var(--sl-display); font-size: 14px; font-weight: 560; cursor: pointer; padding: 0 6px 0 0;
}
body.stagelight .index-select select option { color: #111; }
/* One shared column template drives BOTH the header row and every song row.
   Each .song-row is its OWN grid, so an auto status track used to size to each
   row's content independently — columns never lined up. Fixed tracks make every
   independent row resolve identical column edges. Title flexes; type/status/plays
   are fixed; plays right-aligned. Owner QA: columns did not align across rows. */
/* Six shared columns: TITLE | TYPE | STATUS | RARITY | RESOURCES | PLAYS.
   STATUS (board state) and RARITY (frequency tier) are now separate axes per owner
   feedback. RESOURCES is a reserved empty track in the row anchor that .sr-resources
   overlays, so the whole row stays one clickable <a> while the chips are real siblings. */
body.stagelight .songs-main { --sr-cols: minmax(0, 1fr) 82px 128px 148px 138px 84px; --sr-gap: 16px; }
body.stagelight .song-list { display: grid; gap: 1px; }
/* Column-header row — mono/uppercase label idiom, sticky just under the sticky
   search bar (search sticks at top:78 and is ~48px tall, so ~128px lands it flush
   below). z-index sits under the search bar but over the scrolling rows. */
body.stagelight .song-index-head {
  display: grid; grid-template-columns: var(--sr-cols); gap: var(--sr-gap);
  align-items: center; padding: 10px 10px; margin-top: 6px;
  position: sticky; top: 128px; z-index: 2;
  transition: top 0.28s ease;
  background: color-mix(in srgb, var(--sl-glass) 92%, #000);
  border-bottom: 1px solid var(--sl-line);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
}
/* When the header slides away on scroll-down, the sticky toolbars follow it up
   instead of leaving a dead gap where the menu was. */
body.stagelight.nav-hidden .song-search { top: 12px; }
body.stagelight.nav-hidden .song-index-head { top: 62px; }
body.stagelight .sih-col { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); }
/* Sortable column headers — buttons styled to read as the same mono/uppercase label
   idiom as the static .sih-col, with an arrow glyph that lights up on the active sort.
   Mirrors the Lyrics & Chords hub's .lh-sort so the two index pages feel identical. */
body.stagelight button.sih-sort { background: transparent; border: 0; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 0; text-align: left; transition: color 0.15s ease; }
body.stagelight button.sih-sort:hover { color: var(--sl-muted); }
body.stagelight button.sih-sort[aria-sort="ascending"], body.stagelight button.sih-sort[aria-sort="descending"] { color: var(--sl-ink); }
body.stagelight .sih-arrow { font-size: 10px; color: var(--sl-line-strong); }
body.stagelight button.sih-sort[aria-sort="ascending"] .sih-arrow, body.stagelight button.sih-sort[aria-sort="descending"] .sih-arrow { color: rgba(212,81,79,0.95); }
body.stagelight .sih-plays { text-align: right; justify-self: end; }
body.stagelight button.sih-plays { justify-content: flex-end; }
/* The wrapper's display:grid outweighs the UA [hidden] rule, so filtered/searched
   rows need an explicit, equal-specificity hide. The wrap (not the inner row) is
   what the search script toggles, so its resource links hide with it. */
body.stagelight .song-row-wrap[hidden], body.stagelight .lyric-row-wrap[hidden] { display: none; }
/* Song Index row = a wrapper grid so the resource links can be REAL sibling <a>
   elements (nested anchors inside the row link would be invalid HTML). The wrap
   shares the row's --sr-cols template; the row anchor spans every column and holds
   an empty RESOURCES track, and .sr-resources overlays that same track on top. */
/* Owner QA: the LINKS chips must share the header's left edge. The header carries
   10px horizontal padding; the wrap now carries the SAME 10px so both grids resolve
   the flexible TITLE track identically and every column edge lines up. The row's own
   horizontal padding is dropped (moved to the wrap) so its cells sit flush on the
   shared tracks — .sr-resources (a wrap child) then aligns with the LINKS header. */
body.stagelight .song-row-wrap {
  position: relative; display: grid; grid-template-columns: var(--sr-cols);
  align-items: center; gap: var(--sr-gap); padding: 0 10px; border-bottom: 1px solid var(--sl-line-faint);
}
body.stagelight .song-row {
  grid-column: 1 / -1; grid-row: 1; display: grid; grid-template-columns: var(--sr-cols);
  align-items: center; gap: var(--sr-gap); padding: 14px 0; color: var(--sl-ink);
}
body.stagelight .sr-plays { grid-column: 6; }
body.stagelight .song-row-wrap:hover { background: rgba(255,255,255,0.03); }
/* Resource chips: quiet mono pills sitting in the reserved RESOURCES column (5),
   layered above the row anchor (z-index) so each stays independently clickable + tabbable. */
body.stagelight .sr-resources {
  grid-column: 5; grid-row: 1; z-index: 1; position: relative;
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-self: start;
}
body.stagelight .sr-chip {
  font-family: var(--sl-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--sl-muted); padding: 3px 8px; border-radius: var(--sl-r-pill);
  border: 1px solid var(--sl-line-strong); white-space: nowrap; transition: color 0.15s ease, border-color 0.15s ease;
}
body.stagelight .sr-chip:hover { color: var(--sl-ink); border-color: var(--sl-muted); }
body.stagelight .sr-chip:focus-visible { outline: 2px solid var(--sl-muted); outline-offset: 2px; }
body.stagelight .sr-title { font-family: var(--sl-display); font-size: 15px; font-weight: 560; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body.stagelight .sr-type { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sl-faint); }
/* STATUS column — board state pill. In Rotation carries the stage-red accent; Shelf
   and Purgatory are deliberately muted so a parked song never reads as active. */
body.stagelight .sr-status-cell { display: flex; align-items: center; }
body.stagelight .sr-status { font-family: var(--sl-mono); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 9px; border-radius: var(--sl-r-pill); border: 1px solid var(--sl-line-strong); white-space: nowrap; }
body.stagelight .sr-status-rotation { color: var(--sl-ink); border-color: rgba(212,81,79,0.5); }
body.stagelight .sr-status-shelf { color: var(--sl-muted); background: rgba(255,255,255,0.04); }
body.stagelight .sr-status-purgatory { color: var(--sl-faint); background: rgba(255,255,255,0.02); border-style: dashed; }
/* RARITY column — frequency tier symbol + label, shown only for In Rotation songs;
   Shelf/Purgatory show a muted dash (no frequency tier on a parked song). */
body.stagelight .sr-rarity { display: flex; align-items: center; gap: 6px; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--sl-muted); }
body.stagelight .sr-rarity .rarity-symbol { min-width: 0; margin-right: 0; flex: none; }
body.stagelight .sr-none { color: var(--sl-faint); }
body.stagelight .sr-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
body.stagelight .sr-title .sr-bestguess { margin-left: 9px; font-family: var(--sl-mono); font-size: 10.5px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 7px; border-radius: var(--sl-r-pill); border: 1px solid var(--sl-line-strong); color: var(--sl-muted); vertical-align: middle; }
body.stagelight .sr-plays { text-align: right; font-family: var(--sl-mono); font-size: 15px; color: var(--sl-ink); }
body.stagelight .sr-plays small { display: block; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-faint); margin-top: 2px; }
body.stagelight .song-empty { margin-top: 28px; text-align: center; color: var(--sl-faint); font-size: 15px; }
/* Tablet (641–950px): drop the TYPE and RESOURCES columns so the seven-column grid
   never overflows. Collapses to TITLE | STATUS | RARITY | PLAYS — both header and
   rows share the reduced --sr-cols, and plays re-anchors to the 4th track.
   Resources fold away (the /song/ pages carry every link anyway). */
@media (min-width: 641px) and (max-width: 950px) {
  body.stagelight .songs-main { --sr-cols: minmax(0, 1fr) 132px 148px 84px; }
  body.stagelight .sr-type, body.stagelight .sih-type,
  body.stagelight .sr-resources, body.stagelight .sih-more { display: none; }
  body.stagelight .sr-plays { grid-column: 4; }
}
/* Mobile (<=640px): collapse to TITLE + PLAYS, with STATUS riding inline under each
   title. Header collapses to TITLE | PLAYS. Tighter paddings; sticky header stays. */
@media (max-width: 640px) {
  body.stagelight .songs-main { --sr-cols: minmax(0, 1fr) 76px; --sr-gap: 12px; }
  body.stagelight .song-row-wrap { padding: 0 4px; }
  body.stagelight .song-row { grid-auto-rows: auto; row-gap: 4px; padding: 12px 0; }
  body.stagelight .sr-type, body.stagelight .sr-rarity { display: none; }
  body.stagelight .sr-status-cell { grid-column: 1; grid-row: 2; }
  body.stagelight .sr-plays { grid-column: 2; grid-row: 1; }
  /* Resource column is desktop-only — the /song/ pages already link every resource,
     so mobile drops the chips to keep the two-column row readable. */
  body.stagelight .sr-resources { display: none; }
  body.stagelight .song-index-head { padding: 9px 4px; }
  body.stagelight .song-index-head .sih-col:nth-child(2),
  body.stagelight .song-index-head .sih-col:nth-child(3),
  body.stagelight .song-index-head .sih-col:nth-child(4),
  body.stagelight .song-index-head .sih-col:nth-child(5) { display: none; }
  body.stagelight .song-count { display: none; }
}

/* Lyrics & Chords hub — SONG | ARTIST | ALBUM | LYRICS | TAB | PLAYS. One shared
   column template drives BOTH the sticky header and every row so columns line up at
   every width (owner QA: header/rows must share one grid). Mirrors .song-row-wrap:
   each row is a wrapper grid, the row anchor (the LYRICS link) spans all six tracks,
   and the TAB link overlays the reserved 5th track as a real sibling <a>. */
body.stagelight .archive-eyebrow { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); margin: 4px 0 12px; }
body.stagelight .lyrics-list, body.stagelight .lyric-head { --lr-cols: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr) 128px 84px 100px; }
body.stagelight .song-list.lyrics-list { display: grid; gap: 1px; }
/* Column-header row — mono/uppercase labels; sortable columns are buttons. Sticky
   just under the sticky search bar, matching the Song Index head. */
body.stagelight .lyric-head {
  display: grid; grid-template-columns: var(--lr-cols); gap: 16px;
  align-items: center; padding: 10px 12px; margin-top: 6px;
  position: sticky; top: 128px; z-index: 2; transition: top 0.28s ease;
  background: color-mix(in srgb, var(--sl-glass) 92%, #000);
  border-bottom: 1px solid var(--sl-line);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
}
body.stagelight.nav-hidden .lyric-head { top: 62px; }
body.stagelight .lh-col { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight button.lh-sort { background: transparent; border: 0; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 0; text-align: left; transition: color 0.15s ease; }
body.stagelight button.lh-sort:hover { color: var(--sl-muted); }
body.stagelight button.lh-sort[aria-sort="ascending"], body.stagelight button.lh-sort[aria-sort="descending"] { color: var(--sl-ink); }
body.stagelight .lh-arrow { font-size: 10px; color: var(--sl-line-strong); }
body.stagelight button.lh-sort[aria-sort="ascending"] .lh-arrow, body.stagelight button.lh-sort[aria-sort="descending"] .lh-arrow { color: rgba(212,81,79,0.95); }
body.stagelight .lh-plays { text-align: right; justify-self: end; }
body.stagelight button.lh-plays { justify-content: flex-end; }
/* The wrapper grid outweighs the UA [hidden] rule, so filtered rows need an explicit,
   equal-specificity hide (declared with .song-row-wrap above; the wrap is what the
   search script toggles, so its Tab link hides with it). */
body.stagelight .lyric-row-wrap {
  position: relative; display: grid; grid-template-columns: var(--lr-cols);
  align-items: center; gap: 16px; border-bottom: 1px solid var(--sl-line-faint);
}
body.stagelight .lyric-row {
  grid-column: 1 / -1; grid-row: 1; display: grid; grid-template-columns: var(--lr-cols);
  align-items: center; gap: 16px; padding: 15px 12px; color: var(--sl-ink); text-decoration: none;
}
/* Plays skips the reserved TAB track (5) so the Tab link can overlay it. */
body.stagelight .lr-plays { grid-column: 6; }
body.stagelight .lyric-row-wrap:hover { background: rgba(255,255,255,0.03); }
/* TAB overlay — real sibling <a> in track 5, layered above the row anchor so it stays
   independently clickable + tabbable. Empty rows show a muted dash (no external tab
   source exists in the data, so absent tabs are never a guessed link). */
body.stagelight .lr-tab {
  grid-column: 5; grid-row: 1; z-index: 1; position: relative; justify-self: start;
  font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 5px 12px; border-radius: var(--sl-r-pill); white-space: nowrap; text-decoration: none;
}
body.stagelight a.lr-tab { border: 1px solid rgba(212,81,79,0.5); color: var(--sl-ink); transition: background 0.15s ease; }
body.stagelight a.lr-tab:hover { background: rgba(212,81,79,0.16); }
body.stagelight a.lr-tab:focus-visible { outline: 2px solid var(--sl-muted); outline-offset: 2px; }
body.stagelight .lr-tab-empty { color: var(--sl-faint); border: 0; padding-left: 2px; }
body.stagelight .lr-title { font-family: var(--sl-display); font-size: 15px; font-weight: 560; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body.stagelight .lr-artist { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; color: var(--sl-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body.stagelight .lr-sub { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--sl-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
body.stagelight .lr-words { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; color: var(--sl-muted); white-space: nowrap; }
body.stagelight .lr-ext-arrow { color: var(--sl-faint); }
body.stagelight .lr-none { color: var(--sl-faint); }
body.stagelight .lr-plays { text-align: right; justify-self: end; font-family: var(--sl-mono); font-size: 15px; color: var(--sl-ink); font-variant-numeric: tabular-nums; }
body.stagelight .lr-plays small { display: block; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-faint); margin-top: 2px; }
/* Tablet (561–900px): drop ARTIST + ALBUM, leaving SONG | LYRICS | TAB | PLAYS. */
@media (min-width: 561px) and (max-width: 900px) {
  body.stagelight .lyrics-list, body.stagelight .lyric-head { --lr-cols: minmax(0, 1fr) 120px 84px 96px; }
  body.stagelight .lr-artist, body.stagelight .lr-sub,
  body.stagelight .lh-artist, body.stagelight .lh-album { display: none; }
  body.stagelight .lr-tab { grid-column: 3; }
  body.stagelight .lr-plays { grid-column: 4; }
}
/* Mobile (<=560px): collapse to the essentials — SONG | LYRICS | PLAYS. */
@media (max-width: 560px) {
  body.stagelight .lyrics-list, body.stagelight .lyric-head { --lr-cols: minmax(0, 1fr) 90px 68px; }
  body.stagelight .lr-artist, body.stagelight .lr-sub, body.stagelight .lr-tab,
  body.stagelight .lh-artist, body.stagelight .lh-album, body.stagelight .lh-tab { display: none; }
  body.stagelight .lr-words { grid-column: 2; }
  body.stagelight .lr-plays { grid-column: 3; }
}

body.stagelight .song-eyebrow { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint); margin-bottom: 10px; }
body.stagelight .song-stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin: 22px 0 34px; }
body.stagelight .song-stat { padding: 18px 20px; border-radius: var(--sl-r-md); background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line); }
body.stagelight .song-stat strong { display: block; font-family: var(--sl-mono); font-size: 26px; font-weight: 640; color: var(--sl-ink); line-height: 1; }
body.stagelight .song-stat span { display: block; font-size: 12px; letter-spacing: 0.04em; color: var(--sl-faint); margin-top: 9px; }
body.stagelight .song-stat small { display: block; font-size: 12px; color: var(--sl-muted); margin-top: 4px; }
body.stagelight .song-rarity { display: flex; align-items: center; gap: 9px; font-family: var(--sl-display); font-size: 17px; font-weight: 620; letter-spacing: -0.01em; }
body.stagelight .song-rarity .rarity-symbol { flex: none; }
body.stagelight .song-rarity .rarity-symbol svg { width: 20px; height: 20px; }
body.stagelight .song-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 18px 28px; margin: 0 0 36px; padding-bottom: 30px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .song-facts dt { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .song-facts dd { font-size: 15px; color: var(--sl-ink); margin: 6px 0 0; }
body.stagelight .song-albums { margin-bottom: 8px; }
body.stagelight .song-albums h2 { font-family: var(--sl-display); font-size: 21px; font-weight: 640; letter-spacing: -0.01em; margin-bottom: 16px; }
body.stagelight .song-album-chips { display: flex; flex-wrap: wrap; gap: 10px; }
body.stagelight .song-album-chips a {
  display: inline-flex; align-items: baseline; gap: 8px; padding: 10px 16px; border-radius: var(--sl-r-pill);
  background: var(--sl-glass); border: 1px solid var(--sl-line); color: var(--sl-ink);
  font-family: var(--sl-display); font-size: 15px; font-weight: 560; transition: border-color 0.16s ease, transform 0.16s ease;
}
body.stagelight .song-album-chips a:hover { border-color: var(--sl-line-strong); transform: translateY(-2px); }
body.stagelight .song-album-chips a small { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); }
body.stagelight .song-travels { margin: 34px 0 8px; }
body.stagelight .song-travels h2 { font-family: var(--sl-display); font-size: 21px; font-weight: 640; letter-spacing: -0.01em; margin-bottom: 4px; }
body.stagelight .tw-lead { margin: 0 0 16px; color: var(--sl-muted); font-size: 14.5px; line-height: 1.5; }
body.stagelight .tw-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
body.stagelight .tw-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px 20px; flex-wrap: wrap;
  padding: 12px 16px; border-radius: var(--sl-r-md); background: var(--sl-glass); border: 1px solid var(--sl-line);
}
body.stagelight .tw-pair { display: inline-flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-family: var(--sl-display); font-size: 15.5px; font-weight: 560; }
body.stagelight .tw-this { color: var(--sl-muted); }
body.stagelight .tw-arrow { color: #e0be7a; font-size: 15px; }
body.stagelight .tw-partner a { color: var(--sl-ink); border-bottom: 1px solid transparent; }
body.stagelight .tw-partner a:hover { border-bottom-color: rgba(224,190,122,0.6); }
body.stagelight .tw-tag { font-family: var(--sl-mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 7px; border-radius: var(--sl-r-pill); border: 1px solid var(--sl-line-strong); align-self: center; }
body.stagelight .tw-tag-recent { color: #e0be7a; border-color: rgba(224,190,122,0.45); background: rgba(224,190,122,0.08); }
body.stagelight .tw-tag-alltime { color: var(--sl-faint); }
body.stagelight .tw-stat { font-family: var(--sl-mono); font-size: 12.5px; color: var(--sl-muted); text-align: right; }
body.stagelight .tw-stat b { color: #e0be7a; font-weight: 600; }
body.stagelight .tw-era { display: block; font-size: 11px; color: var(--sl-faint); margin-top: 2px; }
body.stagelight .song-history { margin: 40px 0 8px; }
body.stagelight .song-history-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .song-history-head h2 { font-family: var(--sl-display); font-size: 21px; font-weight: 640; letter-spacing: -0.01em; }
body.stagelight .song-history-head span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-faint); white-space: nowrap; }
body.stagelight .perf-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; }
/* Row grid: DATE | VENUE | LOCATION | LISTEN. Static rows share the same template
   (empty last track) so nothing shifts when a show has no recording. */
body.stagelight .perf > a, body.stagelight .perf > .perf-static {
  display: grid; grid-template-columns: 150px minmax(0, 1fr) auto 84px; align-items: baseline; gap: 6px 16px;
  padding: 12px 8px; color: var(--sl-ink); border-bottom: 1px solid var(--sl-line-faint);
}
body.stagelight .perf > a:hover { background: rgba(255,255,255,0.03); }
body.stagelight .perf-date { grid-column: 1; grid-row: 1; font-family: var(--sl-mono); font-size: 13.5px; color: var(--sl-muted); }
body.stagelight .perf-venue { grid-column: 2; grid-row: 1; font-size: 15px; font-weight: 520; }
body.stagelight .perf-loc { grid-column: 3; grid-row: 1; font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); text-align: right; }
body.stagelight .perf-tags { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 6px; }
body.stagelight .perf-tag { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sl-muted); border: 1px solid var(--sl-line); border-radius: var(--sl-r-pill); padding: 2px 8px; }
body.stagelight .perf-listen { grid-column: 4; grid-row: 1; align-self: center; text-align: right; font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sl-muted); white-space: nowrap; }
body.stagelight .perf > a:hover .perf-listen { color: var(--sl-ink); }
body.stagelight .perf-more { margin-top: 16px; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.03em; color: var(--sl-faint); }
body.stagelight .perf-more a { color: var(--sl-muted); text-decoration: underline; text-underline-offset: 2px; }
body.stagelight .perf-more a:hover { color: var(--sl-ink); }
@media (max-width: 640px) {
  body.stagelight .perf > a, body.stagelight .perf > .perf-static { grid-template-columns: minmax(0, 1fr) 72px; gap: 2px 12px; }
  body.stagelight .perf-date { grid-column: 1 / -1; grid-row: 1; }
  body.stagelight .perf-venue { grid-column: 1; grid-row: 2; }
  body.stagelight .perf-loc { grid-column: 1; grid-row: 3; text-align: left; }
  body.stagelight .perf-listen { grid-column: 2; grid-row: 2; }
  body.stagelight .perf-tags { grid-column: 1 / -1; }
}
/* "Learn It" resource row — guitarist-facing, styled to match .song-album-chips */
body.stagelight .song-learn { margin: 0 0 30px; }
body.stagelight .song-learn-eyebrow { font-family: var(--sl-mono); font-size: 12px; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); margin: 0 0 14px; }
body.stagelight .song-learn-chips { display: flex; flex-wrap: wrap; gap: 10px; }
body.stagelight .song-learn-chips a {
  display: inline-flex; align-items: baseline; gap: 8px; padding: 10px 16px; border-radius: var(--sl-r-pill);
  background: var(--sl-glass); border: 1px solid var(--sl-line); box-shadow: var(--sl-shadow-1); color: var(--sl-ink);
  font-family: var(--sl-display); font-size: 15px; font-weight: 560; transition: border-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease;
}
body.stagelight .song-learn-chips a:hover { border-color: var(--sl-line-strong); transform: translateY(-2px); box-shadow: var(--sl-shadow-2); }
body.stagelight .song-learn-chips a small { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); }
body.stagelight .song-learn-chips .learn-go { font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); align-self: center; }
body.stagelight .song-learn-chips .learn-ext:hover .learn-go { color: var(--sl-ink); }
/* Lite YouTube embed — click-to-play facade shared by Song Origins + song WATCH */
body.stagelight .yt-lite {
  display: block; position: relative; width: 100%; max-width: 640px; aspect-ratio: 16 / 9;
  border-radius: var(--sl-r); overflow: hidden; background: #000;
  border: 1px solid var(--sl-line); box-shadow: var(--sl-shadow-1);
}
body.stagelight .yt-lite-btn {
  display: block; position: absolute; inset: 0; width: 100%; height: 100%; padding: 0;
  margin: 0; border: 0; cursor: pointer; background: #000; overflow: hidden;
}
body.stagelight .yt-lite-thumb {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  transition: transform 0.3s ease, opacity 0.3s ease; opacity: 0.92;
}
body.stagelight .yt-lite-btn:hover .yt-lite-thumb, body.stagelight .yt-lite-btn:focus-visible .yt-lite-thumb { transform: scale(1.03); opacity: 1; }
body.stagelight .yt-lite-play {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: flex; align-items: center; justify-content: center;
  filter: drop-shadow(0 6px 18px rgba(0,0,0,0.5)); transition: transform 0.16s ease;
}
body.stagelight .yt-lite-play .yt-lite-play-bg { fill: #212121; opacity: 0.86; transition: fill 0.16s ease, opacity 0.16s ease; }
body.stagelight .yt-lite-btn:hover .yt-lite-play, body.stagelight .yt-lite-btn:focus-visible .yt-lite-play { transform: translate(-50%, -50%) scale(1.06); }
body.stagelight .yt-lite-btn:hover .yt-lite-play-bg, body.stagelight .yt-lite-btn:focus-visible .yt-lite-play-bg { fill: #ff0000; opacity: 1; }
body.stagelight .yt-lite-btn:focus-visible { outline: 2px solid var(--sl-ink); outline-offset: -3px; }
body.stagelight .yt-lite.is-playing { border-color: var(--sl-line-strong); }
body.stagelight .yt-lite-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
body.stagelight .yt-lite noscript a { position: absolute; inset: auto 0 0 0; padding: 8px 12px; font-family: var(--sl-mono); font-size: 12px; color: var(--sl-ink); background: rgba(0,0,0,0.6); }
/* origin body: keep an inline embed on its own line with breathing room */
body.stagelight .origin-body .yt-lite { margin: 18px 0; }
/* WATCH section — one official video, mono eyebrow, between LEARN IT and Appears on */
body.stagelight .song-watch { margin: 0 0 30px; }
body.stagelight .song-watch-eyebrow { font-family: var(--sl-mono); font-size: 12px; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); margin: 0 0 14px; }
/* Relisten link on a performance row — compact, sits after the setlist.fm anchor */
/* "Best Guess" — Alex's verbatim lyric transcription + interpretation, editorial */
body.stagelight .song-bestguess { margin: 0 0 34px; }
body.stagelight .bg-eyebrow { font-family: var(--sl-mono); font-size: 12px; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); margin: 0 0 8px; }
body.stagelight .bg-byline { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; color: var(--sl-muted); margin: 0 0 6px; }
body.stagelight .bg-note { font-size: 13.5px; line-height: 1.6; color: var(--sl-faint); margin: 0 0 16px; max-width: 62ch; }
body.stagelight .bg-card {
  padding: 34px 36px; border-radius: var(--sl-r);
  background: var(--sl-glass); border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
}
body.stagelight .bg-lyrics { font-family: "Geist", system-ui, sans-serif; font-size: 17px; line-height: 1.7; color: var(--sl-ink); }
body.stagelight .bg-stanza { margin: 0 0 20px; }
body.stagelight .bg-stanza:last-child { margin-bottom: 0; }
body.stagelight .bg-notes { margin-top: 30px; padding-top: 26px; border-top: 1px solid var(--sl-line); }
body.stagelight .bg-notes-label { font-family: var(--sl-mono); font-size: 12px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); margin: 0 0 14px; }
body.stagelight .bg-para { font-family: "Geist", system-ui, sans-serif; font-size: 15px; line-height: 1.7; color: var(--sl-muted); margin: 0 0 14px; }
body.stagelight .bg-para:last-child { margin-bottom: 0; }
body.stagelight .bg-notes strong, body.stagelight .bg-lyrics strong { color: var(--sl-ink); font-weight: 640; }
body.stagelight .bg-source { margin: 16px 0 0; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.03em; color: var(--sl-faint); }
body.stagelight .bg-source a { color: var(--sl-muted); text-decoration: underline; text-underline-offset: 2px; }
body.stagelight .bg-source a:hover { color: var(--sl-ink); }
@media (max-width: 640px) { body.stagelight .bg-card { padding: 24px 22px; } }
/* 404 — lost at the show */
body.stagelight .nf-main { max-width: 620px; text-align: center; padding: 40px 0 60px; }
body.stagelight .nf-eyebrow { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); margin-bottom: 14px; }
body.stagelight .nf-title { font-family: var(--sl-display); font-size: clamp(30px, 5vw, 44px); font-weight: 660; letter-spacing: -0.02em; margin-bottom: 30px; }
body.stagelight .nf-gif { margin: 0 auto 26px; max-width: 480px; }
body.stagelight .nf-gif img { width: 100%; height: auto; border-radius: var(--sl-r, 18px); border: 1px solid var(--sl-line); box-shadow: 0 24px 60px rgba(0,0,0,0.55); }
body.stagelight .nf-gif figcaption { margin-top: 12px; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .nf-copy { font-size: 15px; line-height: 1.65; color: var(--sl-muted); margin: 0 auto 26px; max-width: 460px; }
body.stagelight .nf-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
body.stagelight .nf-links a { padding: 10px 18px; border-radius: var(--sl-r-pill); background: var(--sl-glass); border: 1px solid var(--sl-line); color: var(--sl-ink); font-size: 13.5px; font-weight: 540; transition: border-color 0.16s ease, transform 0.16s ease; }
body.stagelight .nf-links a:hover { border-color: var(--sl-line-strong); transform: translateY(-2px); }

body.stagelight .song-back { margin-top: 34px; }
body.stagelight .song-back a { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-muted); }
body.stagelight .song-back a:hover { color: var(--sl-ink); }

/* current rumors cards */
body.stagelight .current-rumors { margin: 4px 0 44px; }
body.stagelight .rumor-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
body.stagelight .rumor-heading h2 { font-family: var(--sl-display); font-size: 26px; font-weight: 640; letter-spacing: -0.01em; color: var(--sl-ink); }
body.stagelight .rumor-heading span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .rumor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
body.stagelight .rumor-card {
  position: relative; padding: 24px 26px; border-radius: var(--sl-r);
  background: var(--sl-glass); border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
}
body.stagelight .rumor-slot { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint); margin: 0; }
body.stagelight .rumor-place { font-family: var(--sl-display); font-size: 26px; font-weight: 660; letter-spacing: -0.015em; color: var(--sl-ink); margin: 8px 0 0; }
body.stagelight .rumor-note { font-size: 15px; line-height: 1.6; color: var(--sl-muted); margin: 14px 0 0; }
body.stagelight .rumor-flag { display: inline-flex; align-items: center; gap: 8px; margin-top: 18px; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-ink); border: 1px solid rgba(212,81,79,0.5); border-radius: var(--sl-r-pill); padding: 6px 14px; }
body.stagelight .rumor-flag::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--red); box-shadow: 0 0 8px rgba(212,81,79,0.9); }
body.stagelight .rumor-foot { margin: 22px 0 0; font-size: 13.5px; color: var(--sl-faint); }
body.stagelight .rumor-foot a { color: var(--sl-ink); text-decoration: underline; text-underline-offset: 3px; }

/* shelf info page */
body.stagelight .shelf-current-update h2, body.stagelight .legacy-shelf-notes h2 { font-family: var(--sl-display); color: var(--sl-ink); font-size: 26px; margin: 30px 0 16px; }
body.stagelight .shelf-addition-group { margin-bottom: 20px; }
body.stagelight .shelf-addition-group h3 { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); margin-bottom: 10px; }
body.stagelight .shelf-addition-group ul { padding-left: 20px; list-style: disc; color: var(--sl-muted); }
body.stagelight .shelf-addition-group li { margin-bottom: 5px; }
body.stagelight .legacy-shelf-notes { margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--sl-line); }

/* origins index hero + grid */
body.stagelight .origin-hero { display: flex; align-items: center; gap: 26px; margin: 40px 0 44px; }
body.stagelight .origin-fish { width: 110px; height: auto; flex: none; opacity: 0.92; }
body.stagelight .origin-hero h1 { font-family: var(--sl-display); font-weight: 660; font-size: clamp(30px, 4.4vw, 46px); letter-spacing: -0.02em; color: var(--sl-ink); margin: 0; }
body.stagelight .origin-hero span { display: block; margin-top: 12px; font-size: 15px; line-height: 1.6; color: var(--sl-muted); max-width: 640px; }
body.stagelight .origin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
body.stagelight .origin-card {
  display: block; padding: 0; overflow: hidden; border-radius: var(--sl-r); color: var(--sl-ink);
  background: var(--sl-glass); border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
  transition: transform 0.18s ease, border-color 0.18s ease;
}
body.stagelight .origin-card:hover { transform: translateY(-3px); border-color: var(--sl-line-strong); }
body.stagelight .origin-card img { width: 100%; aspect-ratio: 3 / 2; object-fit: cover; border: 0; border-radius: 0; margin: 0; }
body.stagelight .origin-card span { display: block; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint); padding: 16px 18px 0; }
body.stagelight .origin-card strong { display: block; font-family: var(--sl-display); font-size: 17px; font-weight: 600; letter-spacing: -0.01em; padding: 4px 18px 4px; }
body.stagelight .origin-card-meta { display: block; font-family: var(--sl-mono); font-size: 11.5px; letter-spacing: 0.04em; color: var(--sl-faint); padding: 0 18px 18px; font-variant-numeric: tabular-nums; }
body.stagelight .origin-card:not(:has(strong + .origin-card-meta)) strong { padding-bottom: 18px; }
body.stagelight .origin-card-meta .ocm-sep { margin: 0 7px; opacity: 0.6; }

/* single origin page — designed article: hero, computed stat strip, verbatim story, crosslinks */
body.stagelight .origin-article { max-width: 860px; }
body.stagelight .origin-article-head { margin-bottom: 30px; }
body.stagelight .origin-eyebrow { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); margin: 4px 0 12px; }
body.stagelight .origin-article-head h1 { font-family: var(--sl-display); font-weight: 660; font-size: clamp(32px, 5vw, 52px); letter-spacing: -0.02em; color: var(--sl-ink); margin: 0; line-height: 1.02; }
body.stagelight .origin-credit { font-family: var(--sl-mono); font-size: 13px; letter-spacing: 0.02em; color: var(--sl-muted); margin: 12px 0 0; }
body.stagelight .origin-credit-source { color: var(--sl-faint); margin-top: 4px; }
body.stagelight .origin-hero-media { margin: 0 0 34px; }
body.stagelight .origin-hero-media img { width: 100%; height: auto; display: block; border-radius: var(--sl-r-lg); border: 1px solid var(--sl-line); box-shadow: var(--sl-shadow-2); }
body.stagelight .origin-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin: 0 0 38px; }
body.stagelight .origin-strip .song-stat { font-variant-numeric: tabular-nums; }
body.stagelight .origin-strip .song-stat-date { font-family: var(--sl-mono); font-size: 17px; font-weight: 600; letter-spacing: -0.005em; line-height: 1.15; }
body.stagelight .origin-strip .song-stat-album { font-family: var(--sl-display); font-size: 18px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.15; }
body.stagelight .origin-source { margin-top: 26px; }
body.stagelight .origin-source a { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .origin-source a:hover { color: var(--sl-ink); }
body.stagelight .origin-stats { font-family: var(--sl-mono); font-size: 13.5px; line-height: 1.9; color: var(--sl-ink); background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line); border-radius: var(--sl-r-md); padding: 16px 18px; }
/* "By the Numbers" — the parsed FB footer, re-laid-out as a designed data panel.
   Sits after the verbatim story, before the crosslink row. */
body.stagelight .origin-numbers { margin: 40px 0 0; padding-top: 34px; border-top: 1px solid var(--sl-line); }
body.stagelight .origin-numbers-head { margin: 0 0 20px; }
body.stagelight .origin-numbers .on-eyebrow { font-family: var(--sl-mono); font-size: 12px; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); margin: 0 0 6px; }
body.stagelight .origin-numbers .on-sub { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; color: var(--sl-muted); margin: 0; }
body.stagelight .origin-stat-grid { margin: 0 0 20px; border: 1px solid var(--sl-line); border-radius: var(--sl-r-md); background: rgba(255,255,255,0.03); overflow: hidden; }
body.stagelight .origin-stat-grid .on-row { display: grid; grid-template-columns: minmax(150px, 34%) 1fr; gap: 12px 20px; padding: 12px 18px; border-top: 1px solid var(--sl-line); }
body.stagelight .origin-stat-grid .on-row:first-child { border-top: 0; }
body.stagelight .origin-stat-grid dt { font-family: var(--sl-mono); font-size: 11.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-faint); align-self: baseline; }
body.stagelight .origin-stat-grid dd { margin: 0; font-family: var(--sl-display); font-size: 16px; font-weight: 560; color: var(--sl-ink); font-variant-numeric: tabular-nums; }
body.stagelight .origin-numbers-note { font-size: 13.5px; line-height: 1.65; color: var(--sl-muted); margin: 0 0 20px; max-width: 66ch; }
body.stagelight .origin-numbers-note a { color: var(--sl-ink); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--sl-line-strong); }
body.stagelight .origin-numbers-note a:hover { color: #fff; }
body.stagelight .origin-resource-chips { margin: 0 0 24px; }
body.stagelight .origin-picks-block { margin: 4px 0 0; }
body.stagelight .origin-picks-head { font-family: var(--sl-mono); font-size: 12px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); margin: 0 0 12px; }
body.stagelight .origin-picks { list-style: none; margin: 0; padding: 0; }
body.stagelight .origin-pick { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; padding: 11px 0; border-top: 1px solid var(--sl-line); }
body.stagelight .origin-pick:first-child { border-top: 0; }
body.stagelight .origin-pick-venue { font-family: var(--sl-display); font-size: 15.5px; font-weight: 540; color: var(--sl-ink); flex: 1 1 60%; min-width: 0; }
body.stagelight .origin-pick-meta { display: inline-flex; align-items: baseline; gap: 14px; flex: 0 0 auto; }
body.stagelight .origin-pick-date { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.02em; color: var(--sl-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
body.stagelight .origin-pick-listen { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sl-ink); text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
body.stagelight .origin-pick-listen:hover { color: #fff; }
@media (max-width: 620px) {
  body.stagelight .origin-stat-grid .on-row { grid-template-columns: 1fr; gap: 3px; }
}
body.stagelight .origin-crosslinks { display: flex; flex-wrap: wrap; gap: 12px; margin: 40px 0 0; padding-top: 30px; border-top: 1px solid var(--sl-line); }
body.stagelight .origin-xlink {
  display: inline-flex; align-items: center; gap: 12px; padding: 12px 18px; border-radius: var(--sl-r-pill);
  background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line); color: var(--sl-ink);
  transition: transform 0.18s ease, border-color 0.18s ease;
}
body.stagelight .origin-xlink:hover { transform: translateY(-2px); border-color: var(--sl-line-strong); }
body.stagelight .origin-xlink .oxl-label { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
body.stagelight .origin-xlink .oxl-go { color: var(--sl-faint); transition: color 0.18s ease; }
body.stagelight .origin-xlink:hover .oxl-go { color: var(--sl-ink); }
body.stagelight .origin-xlink-ext { background: transparent; border-style: dashed; }
body.stagelight .origin-xlink-ext .oxl-label { color: var(--sl-muted); }
/* Curated origins: attributed-quote body, sources, and the enrichment mesh
   (filed-under cluster chips, related origins, FAQ). */
body.stagelight .origin-summary { font-size: 18px; line-height: 1.6; color: var(--sl-ink); margin: 0 0 1.3em; }
body.stagelight .origin-quote { margin: 0 0 1.5em; padding: 2px 0 2px 20px; border-left: 3px solid var(--sl-line-strong); }
body.stagelight .origin-quote p { font-size: 17px; line-height: 1.62; color: var(--sl-ink); margin: 0 0 10px; }
body.stagelight .origin-quote cite { display: block; font-family: var(--sl-mono); font-style: normal; font-size: 12.5px; letter-spacing: 0.02em; color: var(--sl-muted); }
body.stagelight .origin-quote cite a { color: var(--sl-ink); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--sl-line-strong); }
body.stagelight .origin-quote cite a:hover { color: #fff; }
body.stagelight .origin-note { font-size: 15px; line-height: 1.65; color: var(--sl-muted); margin: 0 0 1.2em; }
body.stagelight .origin-sources { margin: 1.4em 0 0; padding-top: 18px; border-top: 1px solid var(--sl-line); }
body.stagelight .origin-sources-label { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .origin-sources ul { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
body.stagelight .origin-sources li { font-size: 13.5px; line-height: 1.5; color: var(--sl-muted); }
body.stagelight .origin-sources a { color: var(--sl-ink); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--sl-line-strong); }
body.stagelight .origin-sources a:hover { color: #fff; }
body.stagelight .origin-clusters { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin: 34px 0 0; padding-top: 28px; border-top: 1px solid var(--sl-line); }
body.stagelight .origin-clusters-label { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint); margin-right: 4px; }
body.stagelight .origin-cluster-chip { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.02em; color: var(--sl-ink); padding: 6px 13px; border-radius: var(--sl-r-pill); background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line); }
body.stagelight .origin-cluster-chip[data-cluster-type="writer"] { border-color: rgba(45,124,82,0.5); color: #8fd6ab; }
body.stagelight .origin-cluster-chip[data-cluster-type="album"] { border-color: rgba(40,110,158,0.5); color: #8ec2e6; }
body.stagelight .origin-cluster-chip[data-cluster-type="theme"] { border-color: rgba(212,81,79,0.5); color: #e79b9a; }
body.stagelight .origin-related { margin: 40px 0 0; padding-top: 30px; border-top: 1px solid var(--sl-line); }
body.stagelight .origin-related h2 { font-family: var(--sl-mono); font-size: 12px; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); margin: 0 0 16px; }
body.stagelight .origin-related-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
body.stagelight .origin-related-list a { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-radius: var(--sl-r-card, 12px); background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line); color: var(--sl-ink); transition: transform 0.18s ease, border-color 0.18s ease; }
body.stagelight .origin-related-list a:hover { transform: translateY(-2px); border-color: var(--sl-line-strong); }
body.stagelight .origin-related-list .orl-title { font-family: var(--sl-display); font-size: 16px; font-weight: 560; }
body.stagelight .origin-related-list .orl-why { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.02em; color: var(--sl-faint); margin-left: auto; text-align: right; }
body.stagelight .origin-related-list .orl-go { color: var(--sl-faint); }
body.stagelight .origin-related-list a:hover .orl-go { color: var(--sl-ink); }
body.stagelight .origin-faq { margin: 40px 0 0; padding-top: 30px; border-top: 1px solid var(--sl-line); }
body.stagelight .origin-faq h2 { font-family: var(--sl-mono); font-size: 12px; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); margin: 0 0 18px; }
body.stagelight .origin-faq dl { margin: 0; }
body.stagelight .origin-faq-item { padding: 0 0 16px; margin: 0 0 16px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .origin-faq-item:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
body.stagelight .origin-faq dt { font-family: var(--sl-display); font-size: 16px; font-weight: 600; color: var(--sl-ink); margin: 0 0 7px; }
body.stagelight .origin-faq dd { font-size: 15px; line-height: 1.6; color: var(--sl-muted); margin: 0; }
body.stagelight .origin-hero-art img { max-width: 320px; border-radius: var(--sl-r-card, 12px); }
body.stagelight .origin-nav { display: flex; justify-content: space-between; gap: 16px; margin-top: 44px; padding-top: 22px; border-top: 1px solid var(--sl-line); }
body.stagelight .origin-nav a { display: flex; flex-direction: column; gap: 5px; font-size: 15px; color: var(--sl-muted); max-width: 48%; }
body.stagelight .origin-nav .origin-nav-next { text-align: right; margin-left: auto; align-items: flex-end; }
body.stagelight .origin-nav .onav-dir { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .origin-nav .onav-title { font-family: var(--sl-display); font-size: 16px; font-weight: 560; color: var(--sl-ink); }
body.stagelight .origin-nav a:hover .onav-title { color: #fff; }

/* tour-in-review generated page: setlist card grid */
body.stagelight .setlist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
body.stagelight .setlist-card {
  overflow: hidden; border-radius: var(--sl-r); color: var(--sl-ink);
  background: var(--sl-glass); border: 1px solid var(--sl-line); box-shadow: var(--sl-glass-shadow);
}
body.stagelight .setlist-card .setlist-image img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border: 0; }
body.stagelight .setlist-card .setlist-text, body.stagelight .setlist-card .setlist-copy { padding: 18px 20px; color: var(--sl-ink); }
body.stagelight .setlist-card h3, body.stagelight .setlist-feature h3 { font-family: var(--sl-display); color: var(--sl-ink); }
body.stagelight .setlist-card p { color: var(--sl-muted); font-size: 13.5px; }
body.stagelight .setlist-card a { color: var(--sl-ink); }

/* data-driven Tour In Review page */
body.stagelight .tour-in-review-main { width: min(1180px, calc(100% - 48px)); margin: 48px auto 0; }
body.stagelight .tour-in-review-main > * { margin-top: 48px; }
body.stagelight .tour-in-review-main > .tour-hero { margin-top: 0; }
body.stagelight .tour-hero { padding-bottom: 26px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .tour-eyebrow { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--sl-faint); margin: 4px 0 12px; }
body.stagelight .tour-hero h1 { font-family: var(--sl-display); font-weight: 660; font-size: clamp(32px, 5vw, 52px); letter-spacing: -0.02em; color: var(--sl-ink); margin: 0; }
body.stagelight .tour-range { font-family: var(--sl-display); font-size: 17px; color: var(--sl-muted); margin: 14px 0 0; }
body.stagelight .tour-countline { font-family: var(--sl-mono); font-size: 13.5px; letter-spacing: 0.05em; color: var(--sl-ink); margin: 8px 0 0; font-variant-numeric: tabular-nums; }
body.stagelight .tour-attr { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sl-faint); margin: 14px 0 0; }
body.stagelight .tour-attr a { color: var(--sl-muted); text-decoration: underline; text-underline-offset: 2px; }
body.stagelight .tour-attr a:hover { color: var(--sl-ink); }
body.stagelight .tour-h2 { font-family: var(--sl-display); font-size: 26px; font-weight: 640; letter-spacing: -0.01em; color: var(--sl-ink); margin: 0 0 18px; }
body.stagelight .tour-state-line { font-family: var(--sl-mono); font-size: 13.5px; line-height: 1.9; color: var(--sl-ink); font-variant-numeric: tabular-nums; }
body.stagelight .tour-toplist { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 0 32px; }
body.stagelight .tour-toplist li { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 11px 4px; border-bottom: 1px solid var(--sl-line-faint); }
body.stagelight .tt-song { font-family: var(--sl-display); font-size: 15px; font-weight: 540; color: var(--sl-ink); }
body.stagelight .tt-count { font-family: var(--sl-mono); font-size: 15px; color: var(--sl-muted); font-variant-numeric: tabular-nums; }
body.stagelight .tour-ltp-list, body.stagelight .tour-ftp-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 0 32px; }
body.stagelight .tour-ltp-list li, body.stagelight .tour-ftp-list li { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 11px 4px; border-bottom: 1px solid var(--sl-line-faint); }
body.stagelight .tl-song, body.stagelight .tf-song { font-family: var(--sl-display); font-size: 15px; font-weight: 540; color: var(--sl-ink); }
body.stagelight .tl-ltp { flex: none; font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sl-ink); border: 1px solid rgba(212,81,79,0.5); border-radius: var(--sl-r-pill); padding: 3px 10px; white-space: nowrap; }
body.stagelight .tf-meta { flex: none; font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); font-variant-numeric: tabular-nums; text-align: right; }
body.stagelight .tour-more { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.04em; color: var(--sl-faint); margin: 14px 0 0; }
body.stagelight .tour-review-sheet { margin-left: auto; margin-right: auto; }
body.stagelight .tour-h2-tag { font-family: var(--sl-mono); font-size: 0.62em; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sl-faint); border: 1px solid var(--sl-line-strong); border-radius: var(--sl-r-pill); padding: 2px 8px; vertical-align: middle; margin-left: 6px; font-variant-numeric: tabular-nums; }

/* ---- TOUR IN REVIEW DETAIL v2: editorial top-to-bottom flow ---- */
/* Tour Notes — the human lead directly under the hero. */
body.stagelight .tour-notes { border-left: 2px solid var(--sl-accent, var(--sl-line-strong)); padding: 4px 0 4px 26px; }
body.stagelight .tour-notes-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
body.stagelight .tour-notes-head .tour-h2 { margin: 0; }
body.stagelight .tour-notes-byline { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .tour-notes-body { font-size: 16.5px; line-height: 1.62; max-width: 68ch; }
body.stagelight .tour-notes-body p { color: var(--sl-muted); }
body.stagelight .tour-notes-sources { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: 20px 0 0; }
body.stagelight .tour-notes-sources .tns-label { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .tour-notes-sources a { display: inline-flex; align-items: center; gap: 6px; font-family: var(--sl-mono); font-size: 11.5px; letter-spacing: 0.02em; color: var(--sl-muted); border: 1px solid var(--sl-line); border-radius: var(--sl-r-pill); padding: 3px 10px 3px 6px; }
body.stagelight .tour-notes-sources a:hover { color: var(--sl-ink); border-color: var(--sl-line-strong); }
body.stagelight .tour-notes-sources .tns-num { font-size: 10px; color: var(--sl-faint); border: 1px solid var(--sl-line); border-radius: 999px; width: 15px; height: 15px; display: inline-flex; align-items: center; justify-content: center; }

/* The news — paired Welcome Back + Nice To Meet You columns. */
body.stagelight .tour-news { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: start; }
body.stagelight .tour-news.is-single { grid-template-columns: 1fr; max-width: 640px; }
body.stagelight .tour-news-sub { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.02em; color: var(--sl-faint); margin: -8px 0 16px; }
body.stagelight .tour-news .tour-ltp-list, body.stagelight .tour-news .tour-ftp-list { grid-template-columns: 1fr; }

/* By the numbers — tiles + Most Played grouped. */
body.stagelight .tour-mostplayed { margin-top: 28px; }

/* The Sheet — full-width centerpiece with a one-line intro. */
body.stagelight .tour-sheet-intro { font-family: var(--sl-display); font-size: 16px; line-height: 1.5; color: var(--sl-muted); margin: 0 0 18px; max-width: 62ch; }

/* Compact logistics — legs/dates + shows-by-state as a tight mono strip. */
body.stagelight .tour-logistics { background: rgba(255,255,255,0.02); border: 1px solid var(--sl-line); border-radius: var(--sl-r-md); padding: 18px 22px; }
body.stagelight .tour-logistics-h { font-family: var(--sl-mono); font-size: 11px; font-weight: 500; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sl-faint); margin: 0 0 14px; }
body.stagelight .tl-legs, body.stagelight .tl-states { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; }
body.stagelight .tl-states { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--sl-line-faint); }
body.stagelight .tl-legs-label { flex: none; font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sl-faint); min-width: 92px; }
body.stagelight .tl-leg { font-family: var(--sl-mono); font-size: 13px; color: var(--sl-ink); font-variant-numeric: tabular-nums; }
body.stagelight .tl-leg small { color: var(--sl-faint); }
body.stagelight .tl-leg + .tl-leg { border-left: 1px solid var(--sl-line); padding-left: 14px; }
body.stagelight .tl-states .tour-state-line { line-height: 1.7; }
body.stagelight .tour-crosslink { margin-left: auto; margin-right: auto; }
@media (max-width: 760px) {
  body.stagelight .tour-news { grid-template-columns: 1fr; gap: 34px; }
  body.stagelight .tl-legs-label { min-width: 0; flex-basis: 100%; }
}

/* Tour In Review hub: year-grouped index */
body.stagelight .tour-index { margin: 8px 0 44px; }
body.stagelight .tour-index-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; padding-bottom: 14px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .tour-index-head h2 { font-family: var(--sl-display); font-size: 26px; font-weight: 640; letter-spacing: -0.01em; color: var(--sl-ink); }
body.stagelight .tour-index-head span { font-family: var(--sl-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .tour-index-year { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px 20px; padding: 18px 0; border-bottom: 1px solid var(--sl-line-faint); }
body.stagelight .tour-index-year h3 { font-family: var(--sl-mono); font-size: 17px; color: var(--sl-ink); font-variant-numeric: tabular-nums; }
body.stagelight .tour-index-year ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px 16px; }
body.stagelight .tour-index-year a { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; color: var(--sl-ink); }
body.stagelight .tour-index-year a:hover .ti-name { color: #fff; text-decoration: underline; text-underline-offset: 3px; }
body.stagelight .ti-name { font-family: var(--sl-display); font-size: 15px; font-weight: 560; letter-spacing: -0.01em; }
body.stagelight .ti-meta { flex: none; font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); }
@media (max-width: 640px) {
  body.stagelight .tour-index-year { grid-template-columns: 1fr; gap: 8px; }
}

/* ---- TOUR IN REVIEW HUB: landing (hero deck, featured written reviews,
        decade-grouped searchable index of every generated tour) ---- */
body.stagelight .tour-hub-title { border-bottom: 0; margin-bottom: 20px; padding-bottom: 0; }
body.stagelight .tour-hub-deck, body.stagelight .archive-title p.tour-hub-deck {
  font-family: var(--sl-display); font-size: 17px; line-height: 1.55; letter-spacing: -0.01em;
  text-transform: none; color: var(--sl-muted); margin: 14px 0 0; max-width: 66ch;
}
body.stagelight .tour-hub-deck b { color: var(--sl-ink); font-weight: 600; }
body.stagelight .tour-featured { margin: 0 0 40px; }
body.stagelight .tour-featured-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
body.stagelight .tour-featured-grid a {
  display: grid; grid-template-columns: auto minmax(0,1fr); align-items: baseline; gap: 4px 12px;
  padding: 14px 16px; border-radius: var(--sl-r-md); background: rgba(255,255,255,0.03); border: 1px solid var(--sl-line);
  transition: transform 0.15s ease, border-color 0.15s ease;
}
body.stagelight .tour-featured-grid a:hover { transform: translateY(-2px); border-color: var(--sl-line-strong); }
body.stagelight .tfc-year { font-family: var(--sl-mono); font-size: 13px; color: var(--sl-faint); font-variant-numeric: tabular-nums; }
body.stagelight .tfc-name { font-family: var(--sl-display); font-size: 16px; font-weight: 580; letter-spacing: -0.01em; color: var(--sl-ink); }
body.stagelight .tfc-tag { grid-column: 2; font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .tour-featured-grid a:hover .tfc-tag { color: var(--sl-ink); }
body.stagelight .tour-decade { padding: 8px 0 4px; }
body.stagelight .tour-decade[hidden] { display: none; }
body.stagelight .tour-decade-head { display: flex; align-items: baseline; gap: 12px; margin: 18px 0 10px; font-family: var(--sl-mono); font-size: 15px; letter-spacing: 0.04em; color: var(--sl-ink); font-variant-numeric: tabular-nums; }
body.stagelight .tour-decade-head span { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .tour-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
body.stagelight .tour-row[hidden] { display: none; }
body.stagelight .tour-row { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 4px 16px; padding: 12px 6px; border-bottom: 1px solid var(--sl-line); }
body.stagelight .tour-row-link { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: baseline; gap: 4px 16px; min-width: 0; }
body.stagelight .tour-row:hover { background: rgba(255,255,255,0.03); }
body.stagelight .tr-name { font-family: var(--sl-display); font-size: 16px; font-weight: 560; letter-spacing: -0.01em; color: var(--sl-ink); }
body.stagelight .tour-row:hover .tr-name { color: #fff; }
body.stagelight .tr-span { grid-column: 1; font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); }
body.stagelight .tr-shows { grid-column: 2; grid-row: 1 / span 2; align-self: center; font-family: var(--sl-mono); font-size: 12px; color: var(--sl-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
body.stagelight .tr-badge {
  justify-self: end; font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--sl-ink); padding: 5px 11px; border-radius: var(--sl-r-pill); border: 1px solid var(--sl-line-strong); background: rgba(255,255,255,0.04); white-space: nowrap;
}
body.stagelight .tr-badge:hover { background: var(--sl-ink); color: #111; border-color: var(--sl-ink); }
body.stagelight .tour-year-summary { display: flex; flex-wrap: wrap; gap: 12px; margin: 36px 0 0; }
body.stagelight .tour-year-summary a {
  display: grid; gap: 4px; padding: 16px 20px; border-radius: var(--sl-r-md); border: 1px solid var(--sl-line); background: rgba(255,255,255,0.03);
}
body.stagelight .tour-year-summary a:hover { border-color: var(--sl-line-strong); }
body.stagelight .tour-year-summary span { font-family: var(--sl-mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sl-faint); }
body.stagelight .tour-year-summary strong { font-family: var(--sl-display); font-size: 18px; font-weight: 600; letter-spacing: -0.01em; color: var(--sl-ink); }
@media (max-width: 640px) {
  body.stagelight .tour-index-year { grid-template-columns: 1fr; gap: 8px; }
  body.stagelight .tour-row-link { grid-template-columns: minmax(0,1fr); }
  body.stagelight .tr-shows { grid-column: 1; grid-row: auto; }
}

@media (max-width: 760px) {
  body.stagelight .origin-hero { flex-direction: column; align-items: flex-start; gap: 18px; }
  body.stagelight .origin-strip { grid-template-columns: repeat(2, 1fr); }
  body.stagelight .origin-nav { flex-direction: column; }
  body.stagelight .origin-nav a { max-width: 100%; }
  body.stagelight .origin-nav .origin-nav-next { text-align: left; margin-left: 0; align-items: flex-start; }
  body.stagelight .archive-main { margin-top: 40px; }
}

/* ── FAQ ACCORDIONS — shared by /faq/ (.faq-item) and About (.about-faq-item) ──
   One treatment for both surfaces: a chevron affordance that rotates 180deg on open,
   and a smooth open/close. interpolate-size lets block-size animate to/from the auto
   keyword on 2026-baseline browsers; where ::details-content or interpolate-size are
   unsupported the accordion simply toggles with no animation — still fully functional. */
:root { interpolate-size: allow-keywords; }
body.stagelight .faq-item > summary,
body.stagelight .about-faq-item > summary {
  display: flex; align-items: center; gap: 16px; list-style: none;
}
body.stagelight .faq-item > summary::-webkit-details-marker,
body.stagelight .about-faq-item > summary::-webkit-details-marker { display: none; }
/* CSS-triangle chevron (a border corner rotated to a downward "v"). */
body.stagelight .faq-item > summary::after,
body.stagelight .about-faq-item > summary::after {
  content: ""; flex: none; width: 8px; height: 8px; margin-left: auto; margin-right: 3px;
  border-right: 2px solid var(--sl-muted); border-bottom: 2px solid var(--sl-muted);
  transform: rotate(45deg); transform-origin: center; transition: transform 0.2s ease;
}
body.stagelight .faq-item[open] > summary::after,
body.stagelight .about-faq-item[open] > summary::after { transform: rotate(225deg); }
body.stagelight .faq-item > summary:focus-visible,
body.stagelight .about-faq-item > summary:focus-visible { outline: 2px solid var(--sl-muted); outline-offset: 3px; border-radius: 4px; }
body.stagelight .faq-item::details-content,
body.stagelight .about-faq-item::details-content {
  block-size: 0; overflow: clip;
  transition: content-visibility 0.25s allow-discrete, block-size 0.25s ease;
}
body.stagelight .faq-item[open]::details-content,
body.stagelight .about-faq-item[open]::details-content { block-size: auto; }

`;
}

function renderHeaders() {
  // Cache-Control strategy (fixes the "Franken-styling" bug: fresh HTML paired
  // with stale cached CSS after a deploy):
  //   - HTML (the /* catch-all) is revalidated on every load, so a new deploy's
  //     markup is never served from a stale browser cache.
  //   - Stylesheets are immutable-cached, which is safe ONLY because their <link>
  //     href carries a ?v=<contenthash> query added in finalizeHtml. Browsers key
  //     their cache on the FULL URL including the query string, so when the CSS
  //     changes the hash changes and the browser fetches the new file — the
  //     immutable cache can never serve stale CSS for a new hash. (Cloudflare's CDN
  //     may ignore the query in its own cache key; harmless, since the bug we fix
  //     is the *browser* pairing new HTML with old CSS, which the query defeats.)
  //   - _headers precedence: every matching rule applies, and for a shared header
  //     the later / more-specific rule wins. The /* rule is first (least specific),
  //     so the more-specific /assets/*, /stagelight.css and /styles.css rules below
  //     override its Cache-Control — /assets/* keeps its immutable caching.
  return `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cache-Control: public, max-age=0, must-revalidate

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/stagelight.css
  Cache-Control: public, max-age=31536000, immutable

/styles.css
  Cache-Control: public, max-age=31536000, immutable

/data/*
  Cache-Control: public, max-age=300
`;
}

function renderRedirects(archiveEntries = [], generatedReviews = [], tourInReviews = []) {
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

  // 301 each dead same-season "-ii" tour slug to the merged tour page so old
  // shared links never 404 after same-named legs were merged into one tour.
  for (const [deadSlug, survivingSlug] of (tourInReviews?.deadSlugRedirects || new Map())) {
    lines.push(`/tour-in-review/${deadSlug} /tour-in-review/${survivingSlug}/ 301`);
    lines.push(`/tour-in-review/${deadSlug}/ /tour-in-review/${survivingSlug}/ 301`);
  }

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

function renderSitemap(data, archiveEntries = [], songOrigins = [], generatedReviews = [], tourInReviews = []) {
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
    <loc>https://burnthday.com/albums/</loc>
  </url>
  <url>
    <loc>https://burnthday.com/songs/</loc>
    <lastmod>${updated}</lastmod>
  </url>
  <url>
    <loc>https://burnthday.com/song-origins/</loc>
  </url>
  ${(data.albums || []).map((album) => `<url>
    <loc>https://burnthday.com/albums/${escapeHtml(album.slug)}/</loc>
  </url>`).join("\n  ")}
  ${(data.catalog || []).map((song) => `<url>
    <loc>https://burnthday.com/song/${escapeHtml(data.songSlugMap?.get(song.key) || slugify(song.title))}/</loc>
  </url>`).join("\n  ")}
  <url>
    <loc>https://burnthday.com/tour-in-review/</loc>
  </url>
  ${tourInReviews.map((tour) => `<url>
    <loc>https://burnthday.com${escapeHtml(tour.route)}</loc>
    <lastmod>${escapeHtml(tour.last)}</lastmod>
  </url>`).join("\n  ")}
  <url>
    <loc>https://burnthday.com/faq/</loc>
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

function romanToNumber(numeral) {
  const index = ["", "I", "II", "III", "IV", "V", "VI"].indexOf(numeral);
  return index > 0 ? index : numeral;
}

function formatBoardShowTitle(show) {
  if (!show?.location) return "";
  // Board header style: "Sacramento CA", no comma (Alex, round 5).
  return `${show.location.replace(",", "")}${show.runLabel ? ` ${show.runLabel}` : ""}`;
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

// Last-time-played gap for a song at a given show: how many shows the band played
// between this appearance and the previous one. 0 = also played the show before;
// null = no prior performance in the setlist.fm history (a debut here).
function lastTimePlayedGap(data, key, showIso) {
  const perfs = data.performancesByTitle?.get(key);
  const dates = data.allShowDates;
  if (!perfs || !dates || !showIso) return null;
  const prev = perfs.find((perf) => perf.date < showIso);
  if (!prev) return null;
  let lo = 0, hi = dates.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid] <= prev.date) lo = mid + 1; else hi = mid; }
  let count = 0;
  for (let i = lo; i < dates.length && dates[i] < showIso; i += 1) count += 1;
  return count;
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
  // Alex titles his Best Guess file "Cosmic Confidant"; the catalog spells it
  // "Cosmic Confidante" (verified against catalog.csv / albums.json). Alias his
  // spelling to the catalog key so the transcription attaches — his file is left
  // exactly as written.
  cosmicconfidant: "cosmicconfidante",
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
