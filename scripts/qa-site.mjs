import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");

const checks = [];

async function main() {
  const [homeHtml, siteData, review2025Html] = await Promise.all([
    readText("dist/index.html"),
    readJson("dist/data/site-data.json"),
    readText("dist/2025/12/widespread-panic-2025-tour-in-review.html")
  ]);
  const allHtmlFiles = await listFiles(distDir, (filePath) => filePath.endsWith(".html"));
  const allHtml = await Promise.all(allHtmlFiles.map((filePath) => readFile(filePath, "utf8")));

  checkNoPublicPanicStreamLinks(allHtmlFiles, allHtml);
  checkCanonicalSongNames(allHtmlFiles, allHtml);
  checkCorePageState(homeHtml, siteData);
  checkTourSongCounts(homeHtml, siteData);
  checkLatestSetlist(homeHtml);
  checkGuestAnnotations(homeHtml, review2025Html);
  checkNavigation(homeHtml);
  checkLegacyPages();
  await checkLocalAssets(allHtml);

  const failed = checks.filter((check) => !check.passed);
  for (const check of checks) {
    const prefix = check.passed ? "PASS" : "FAIL";
    console.log(`${prefix} ${check.label}`);
    if (!check.passed && check.detail) console.log(`  ${check.detail}`);
  }

  console.log(`\nSite QA: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

function checkCanonicalSongNames(files, htmlByFile) {
  const offenders = [];
  for (let index = 0; index < files.length; index += 1) {
    if (/Bowlegged Woman,\s*Knock-Kneed Man/i.test(htmlByFile[index])) {
      offenders.push(path.relative(root, files[index]));
    }
  }
  record(
    "Generated HTML uses canonical Bowlegged Woman title",
    offenders.length === 0,
    offenders.slice(0, 10).join("\n")
  );
}

function checkNoPublicPanicStreamLinks(files, htmlByFile) {
  const offenders = [];
  for (let index = 0; index < files.length; index += 1) {
    if (/panicstream/i.test(htmlByFile[index])) {
      offenders.push(path.relative(root, files[index]));
    }
  }
  record(
    "No public generated HTML contains PanicStream references",
    offenders.length === 0,
    offenders.slice(0, 10).join("\n")
  );
}

function checkCorePageState(html, siteData) {
  assertIncludes(html, '<section class="latest-setlist" id="latest-setlist">', "Homepage has latest-setlist section");
  assertIncludes(html, '<section class="laminate primary-board" id="song-list">', "Homepage has song-list laminate");
  assertIncludes(html, '<h1>OAKLAND, CA I</h1>', "Song List title is next show: OAKLAND, CA I");

  record("Latest setlist appears above Song List", indexOf(html, 'id="latest-setlist"') < indexOf(html, 'id="song-list"'));
  record("Sheet key appears below Song List", indexOf(html, 'id="song-list"') < indexOf(html, 'id="sheet-key"'));
  record("Shelf and Purgatory appear below Sheet Key", indexOf(html, 'id="sheet-key"') < indexOf(html, 'id="shelf"') && indexOf(html, 'id="shelf"') < indexOf(html, 'id="purgatory"'));
  record("The Woodshed appears below Purgatory", indexOf(html, 'id="purgatory"') < indexOf(html, 'id="woodshed"'));
  record("Older setlists appear below The Woodshed", indexOf(html, 'id="woodshed"') < indexOf(html, 'id="setlists"'));

  record("2026 unique songs total is 155", siteData.totals?.currentTourSongs === 155);
  record("2026 per-show tour plays total is 490", siteData.totals?.currentTourPlays === 490);
  record("2026 posted shows total is 25", siteData.totals?.postedSetlists === 25);
  record("2026 tour dates total is 42", siteData.totals?.tourDates === 42);

  assertIncludes(html, "Tiny Number", "Sheet key explains Tiny Number");
  assertIncludes(html, "Times played this tour", "Sheet key says tiny numbers are times played this tour");
  assertIncludes(html, "The Woodshed", "Sheet key includes The Woodshed");
  assertIncludes(html, "not yet played with Nick Johnson", "The Woodshed explains Nick Johnson logic");
  checkMarkerLegend(html, siteData);

  assertSongHtml(html, "JUST KISSED MY BABY", ["<sup>1</sup>", "(03/21/26)"], "Song List add-on keeps 2026 play date");
  assertSongHtml(html, "JUST KISSED MY BABY", ["<sup>165</sup>", "05/01/16"], "Shelf bustout keeps prior last-played date");
  assertSongHtml(html, "LOW RIDER", ["<sup>2</sup>", "(07/07/26)"], "Song List Low Rider add-on has tour count and current-tour date");
  assertSongHtml(html, "LOW RIDER", ["<sup>157</sup>", "11/04/09"], "Shelf Low Rider keeps prior last-played date");
  assertSongHtml(html, "ROOM AT THE TOP", ["<sup>1</sup>", "(07/05/26)"], "Song List Room At The Top add-on has current-tour date");
  assertSongHtml(html, "ROOM AT THE TOP", ["<sup>2</sup>", "03/24/24"], "Purgatory Room At The Top keeps prior last-played date");
  assertSongHtml(html, "FREE SOMEHOW", ["<sup>2</sup>"], "Song List Free Somehow shows current tour count");
}

function checkTourSongCounts(html, siteData) {
  const songList = sectionHtml(html, "song-list");
  const missing = (siteData.catalog || [])
    .filter((song) => song.playedThisTour && song.tourCount > 0)
    .filter((song) => !songChunks(songList, song.title.toUpperCase()).some((chunk) => chunk.includes(`<sup>${song.tourCount}</sup>`)))
    .map((song) => `${song.title} (${song.tourCount})`);

  record(
    "Every song played this tour keeps its tiny play count",
    missing.length === 0,
    missing.slice(0, 20).join("\n")
  );
}

function checkLatestSetlist(html) {
  const latest = sectionHtml(html, "latest-setlist");
  assertIncludes(latest, "07/11/2026 Hayden Homes Amphitheater, Bend, OR", "Latest setlist is 07/11/2026 Bend");
  assertIncludes(latest, "Blue Indian &gt; Chainsaw City", "Latest setlist preserves segues");
  assertIncludes(latest, 'Chainsaw City<sup class="guest-sup">1</sup>', "Steve Lopez is a guest superscript on Chainsaw City");
  assertIncludes(latest, '<sup class="guest-sup">1</sup> with Steve Lopez on percussion', "Steve Lopez guest note is keyed to the superscript");
  assertIncludes(latest, "[Entire show with Nick Johnson on guitar]", "Nick Johnson full-show note stays bracketed");
  record("Steve Lopez is not inside bracket notes", !/\[[^\]]*Steve Lopez[^\]]*\]/i.test(stripTags(latest)));
  record("No asterisk guest notation remains in latest setlist", !/\*\s*with Steve Lopez/i.test(stripTags(latest)));

  const pTags = latest.match(/<p><strong>(?:1|2|E):<\/strong>[\s\S]*?<\/p>/g) || [];
  record("Latest setlist has one line each for 1, 2, and E", pTags.length === 3);
}

function checkGuestAnnotations(homeHtml, review2025Html) {
  const atlanta = cardHtml(review2025Html, "12/30/25 The Fox Theatre, Atlanta, GA");
  for (const title of ["Mercy", "Bust it Big", "Chilly Water", "Pickin&#39; Up The Pieces", "Climb To Safety"]) {
    assertIncludes(atlanta, `${title}<sup class="guest-sup">1</sup>`, `12/30/25 numbers Billy Strings sit-in on ${decodeHtml(title)}`);
  }
  assertIncludes(atlanta, '<sup class="guest-sup">1</sup> with Billy Strings on Guitar', "12/30/25 has keyed Billy Strings guest note");
  record("12/30/25 Billy Strings sit-in is not bracketed", !/<p class="notes">[\s\S]*Billy Strings/i.test(atlanta));

  const portChester = cardHtml(review2025Html, "11/22/25 The Capitol Theatre, Port Chester, NY");
  for (const title of ["Good Morning Little School Girl", "Porch Song", "Cortez the Killer", "Runnin&#39; Down A Dream"]) {
    assertIncludes(portChester, `${title}<sup class="guest-sup">1</sup>`, `11/22/25 numbers Warren Haynes sit-in on ${decodeHtml(title)}`);
  }
  assertIncludes(portChester, '<sup class="guest-sup">1</sup> with Warren Haynes on guitar and vocals', "11/22/25 normalizes the Warren Haynes guest credit");

  const atlanticCity = cardHtml(review2025Html, "02/15/25 Hard Rock Live at Etess Arena, Atlantic City, NJ");
  assertIncludes(atlanticCity, 'Party At Your Mama&#39;s House<sup class="guest-sup">1</sup>', "Legacy 2025 inline guest marker renders as a real superscript");
  assertIncludes(atlanticCity, 'I&#39;m So Glad<sup class="guest-sup">8</sup>', "Legacy 2025 marker sequence reaches guest number 8");
  assertIncludes(atlanticCity, '<sup class="guest-sup">8</sup> with John Keane on electric guitar, Jason Crosby on keys', "Legacy 2025 combined guest credits stay keyed");

  const playa = cardHtml(homeHtml, "01/23/2026 Hard Rock Hotel Riviera Maya, Riviera Maya, Quintana Roo");
  assertIncludes(playa, 'And It Stoned Me<sup class="guest-sup">1</sup>', "01/23/26 numbers Sierra Hull sit-in songs");
  assertIncludes(playa, 'Second Skin<sup class="guest-sup">2</sup>', "01/23/26 numbers Adam MacDougall sit-in songs");
  assertIncludes(playa, '<sup class="guest-sup">1</sup> with Sierra Hull', "01/23/26 has keyed Sierra Hull note");
  assertIncludes(playa, '<sup class="guest-sup">2</sup> with Adam MacDougall', "01/23/26 has keyed Adam MacDougall note");

  const unkeyedGuestCredits = [homeHtml, review2025Html]
    .flatMap((html) => [...html.matchAll(/<p class="notes">([\s\S]*?)<\/p>/g)])
    .flatMap((match) => [...stripTags(match[1]).matchAll(/\[([^\]]+)\]/g)].map((note) => note[1]))
    .filter((note) => /(?:\bwith\b|\bw\/|\bwth\b).*(?:guitar|keys?|keyboards?|percussion|vocals?|mandolin|fiddle|horns?|sax(?:ophone)?|drums?|bass)/i.test(note))
    .filter((note) => !/^(?:entire show\s+)?with Nick Johnson\b/i.test(note));
  record("No song-specific guest credit remains inside brackets", unkeyedGuestCredits.length === 0, unkeyedGuestCredits.join("\n"));
}

function checkNavigation(html) {
  const expectedTop = ["Home", "Rumors", "Lyrics & Chords", "Song Origins", "Tour In Review", "The Shelf", "About"];
  const expectedFooter = ["Home", "Rumors", "Lyrics & Chords", "Song Origins", "Tour In Review", "@Burnthday", "About"];
  const topNav = linkTexts(sectionByClass(html, "jump-links"));
  const footerNav = linkTexts(sectionByClass(html, "footer-links"));

  record("Top nav matches old Burnthday nav", arraysEqual(topNav, expectedTop), topNav.join(" | "));
  record("Footer nav matches old Burnthday footer", arraysEqual(footerNav, expectedFooter), footerNav.join(" | "));
  record("Footer intentionally excludes The Shelf", !footerNav.includes("The Shelf"), footerNav.join(" | "));
  assertIncludes(html, "burnthday on Facebook", "Footer includes Facebook text link");
  assertIncludes(html, "burnthday on Twitter", "Footer includes Twitter text link");
  assertIncludes(html, "burnthday on Instagram", "Footer includes Instagram text link");
  assertIncludes(html, "All Rights Reserved. Burnthday", "Footer keeps Burnthday rights line");
  assertIncludes(html, "The Widespread Panic Spread Sheet", "Footer keeps Spread Sheet title");
}

async function checkLegacyPages() {
  const [rumors, tourReview, shelf] = await Promise.all([
    readText("dist/p/rumors.html"),
    readText("dist/p/burnthdays-widespread-panic-tours-in.html"),
    readText("dist/p/theshelf.html")
  ]);
  const rumorsText = normalizeText(stripTags(rumors));
  const tourText = normalizeText(stripTags(tourReview));
  const shelfText = normalizeText(stripTags(shelf));

  record("Rumors page uses imported legacy copy", /2025 Rumors:/.test(rumorsText) && /100% pure speculation/.test(rumorsText));
  record("Rumors page does not use invented placeholder copy", !/I am not trying to become a rumor mill/i.test(rumorsText));
  record("Tour In Review page uses imported legacy copy", /Burnthday's Widespread Panic Tour In Review/.test(tourText));
  record("Shelf page uses imported shelf copy", /The Shelf/i.test(shelfText) && /Purgatory/i.test(shelfText));
}

function checkMarkerLegend(html, siteData) {
  const expected = [
    ["Black", "07/11/26 Bend, OR II"],
    ["Green", "07/10/26 Bend, OR I"],
    ["Blue", "07/08/26 Missoula, MT II"],
    ["Red", "07/07/26 Missoula, MT I"]
  ];
  const legend = siteData.site?.markerLegend || [];
  const matchesData = expected.every(([color, label], index) => {
    const item = legend[index];
    return item?.color === color && item?.label === label;
  });
  const matchesHtml = expected.every(([color, label]) => html.includes(color) && html.includes(label));
  record("Marker legend matches the last four posted shows", matchesData && matchesHtml, JSON.stringify(legend));
}

async function checkLocalAssets(htmlByFile) {
  const refs = new Set();
  for (const html of htmlByFile) {
    for (const match of html.matchAll(/\b(?:src|href)="(\/(?:assets|styles)[^"]+)"/g)) {
      refs.add(match[1].replace(/[?#].*$/, ""));
    }
  }

  const missing = [];
  for (const ref of refs) {
    const filePath = path.join(root, "dist", safeDecodePath(ref));
    try {
      const info = await stat(filePath);
      if (!info.isFile()) missing.push(ref);
    } catch {
      missing.push(ref);
    }
  }
  record("All generated local asset references exist", missing.length === 0, missing.slice(0, 20).join("\n"));
}

async function listFiles(dir, predicate) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(filePath, predicate));
    else if (!predicate || predicate(filePath)) files.push(filePath);
  }
  return files;
}

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function assertSongHtml(html, title, pieces, label) {
  const matches = songChunks(html, title);
  const found = matches.some((match) => pieces.every((piece) => match.includes(piece)));
  record(label, found, matches.map((match) => stripTags(match)).join(" | "));
}

function songChunks(html, title) {
  const needle = `title="${escapeAttribute(title)}"`;
  const chunks = [];
  let cursor = 0;
  while (cursor < html.length) {
    const titleIndex = html.indexOf(needle, cursor);
    if (titleIndex < 0) break;
    const start = html.lastIndexOf('<span class="rotation-song', titleIndex);
    const next = html.indexOf('<span class="rotation-song', titleIndex + needle.length);
    chunks.push(html.slice(start, next > start ? next : html.length));
    cursor = titleIndex + needle.length;
  }
  return chunks;
}

function sectionHtml(html, id) {
  const idIndex = indexOf(html, `id="${id}"`);
  if (idIndex < 0) return "";

  const start = html.lastIndexOf("<section", idIndex);
  if (start < 0) return "";

  const tagPattern = /<\/?section\b[^>]*>/g;
  tagPattern.lastIndex = start;
  let depth = 0;
  let match;

  while ((match = tagPattern.exec(html))) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, tagPattern.lastIndex);
  }

  return html.slice(start);
}

function cardHtml(html, heading) {
  const headingIndex = html.indexOf(`<h3>${heading}</h3>`);
  if (headingIndex < 0) return "";
  const start = html.lastIndexOf('<article class="setlist-card', headingIndex);
  const end = html.indexOf("</article>", headingIndex);
  return start >= 0 && end > start ? html.slice(start, end + "</article>".length) : "";
}

function sectionByClass(html, className) {
  const start = html.indexOf(`<nav class="${className}"`);
  if (start < 0) return "";
  const end = html.indexOf("</nav>", start);
  return end > start ? html.slice(start, end + "</nav>".length) : "";
}

function linkTexts(html) {
  return [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)]
    .map((match) => normalizeText(stripTags(match[1])))
    .filter(Boolean);
}

function assertIncludes(value, expected, label) {
  record(label, String(value).includes(expected), `Missing: ${expected}`);
}

function record(label, passed, detail = "") {
  checks.push({ label, passed: Boolean(passed), detail });
}

function indexOf(value, needle) {
  return String(value).indexOf(needle);
}

function stripTags(value) {
  return decodeHtml(String(value).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " "));
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeDecodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
