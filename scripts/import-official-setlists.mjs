import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const year = args.year || process.env.TOUR_YEAR || String(new Date().getFullYear());
const sitemapUrl = args.sitemap || "https://widespreadpanic.com/wp-sitemap-posts-audiotheme_gig-1.xml";
const output = args.out || path.join(root, "data", "source", `setlists-${year}.json`);

async function main() {
  const urls = await discoverShowUrls();
  const tourPages = [];

  for (const url of urls) {
    const html = await fetchText(url);
    const parsed = parseShowPage(url, html);
    tourPages.push(parsed);
  }

  const shows = tourPages.filter((show) => show.sets.length);

  const payload = {
    title: `WIDESPREAD PANIC ${year} TOUR`,
    sourceUrl: "https://widespreadpanic.com/shows/",
    sourceSitemapUrl: sitemapUrl,
    sourcePublishedAt: "",
    importedAt: new Date().toISOString(),
    setlists: shows.sort((a, b) => a.isoDate.localeCompare(b.isoDate)),
    tourDates: tourPages.map(tourDateSummary).sort((a, b) => a.isoDate.localeCompare(b.isoDate))
  };

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Imported ${payload.setlists.length} ${year} official setlists and ${payload.tourDates.length} tour dates to ${path.relative(root, output)}.`);
}

function tourDateSummary(show) {
  return {
    date: show.date,
    isoDate: show.isoDate,
    venue: show.venue,
    city: show.city,
    state: show.state,
    location: show.location,
    sourceUrl: show.sourceUrl
  };
}

async function discoverShowUrls() {
  const xml = await fetchText(sitemapUrl);
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)]
    .map((match) => decodeHtml(match[1]).trim())
    .filter((url) => new RegExp(`/shows/${year}-`).test(url))
    .sort();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "Burnthday static-site importer" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  return response.text();
}

function parseShowPage(url, html) {
  const fallback = parseTourDateFromUrl(url);
  const title = cleanText(readFirst(html, /<h1 class="entry-title">\s*([\s\S]*?)\s*<\/h1>/i));
  const venue = cleanText(readFirst(html, /<span class="venue-name[^"]*">\s*([\s\S]*?)\s*<\/span>/i)) || title || fallback.venue;
  const city = cleanText(readFirst(html, /<span class="venue-locality locality">\s*([\s\S]*?)\s*<\/span>/i)) || fallback.city;
  const state = cleanText(readFirst(html, /<span class="venue-region region">\s*([\s\S]*?)\s*<\/span>/i)) || fallback.state;
  const notes = parseNotes(html);
  const streamUrl = decodeHtml(readFirst(html, /<div class="download-link">[\s\S]*?<a href="([^"]+)"/i));
  const image = parsePrimaryImage(html);

  return {
    date: isoToShortDate(fallback.isoDate),
    isoDate: fallback.isoDate,
    venue,
    city,
    state,
    location: [city, state].filter(Boolean).join(", "),
    sourceUrl: url,
    streamUrl,
    sets: parseSetlists(html),
    notes,
    image,
    imageWidth: 0,
    imageHeight: 0
  };
}

function parseTourDateFromUrl(url) {
  const match = String(url).match(/\/shows\/(\d{4})-(\d{2})-(\d{2})-([^/]+)\//);
  if (!match) return null;
  const isoDate = `${match[1]}-${match[2]}-${match[3]}`;
  const parts = match[4].split("-");
  const stateIndex = parts.findIndex((part, index) => index > 0 && /^[a-z]{2}$/.test(part));
  const city = stateIndex > 0 ? titleCase(parts.slice(0, stateIndex).join(" ")) : "";
  const state = stateIndex > 0 ? parts[stateIndex].toUpperCase() : "";
  const venue = stateIndex > -1 ? titleCase(parts.slice(stateIndex + 1).join(" ")) : titleCase(parts.join(" "));
  return {
    date: isoToShortDate(isoDate),
    isoDate,
    venue,
    city,
    state,
    location: [city, state].filter(Boolean).join(", ")
  };
}

function parseSetlists(html) {
  const block = readFirst(html, /<div class="show-setlist">([\s\S]*?)<div class="show-content">/i);
  if (!block) return [];

  const tokens = [...block.matchAll(/<div class="set-title">\s*([\s\S]*?)\s*<\/div>|<div class="setlist-item-title">\s*<span class="setlist-item-index">[\s\S]*?<\/span>\s*([\s\S]*?)\s*<\/div>/gi)];
  const sets = [];
  let current = null;

  for (const token of tokens) {
    if (token[1]) {
      current = { label: normalizeSetLabel(cleanText(token[1])), songs: [] };
      sets.push(current);
    } else if (current && token[2]) {
      const song = normalizeSongTitle(cleanText(token[2]));
      if (song) current.songs.push(song);
    }
  }

  return sets
    .filter((set) => set.songs.length)
    .map((set) => ({ label: set.label, songs: set.songs.join(", "), songTitles: set.songs }));
}

function parseNotes(html) {
  const notesBlock = readFirst(html, /<div class="gig-notes">([\s\S]*?)<\/div>/i);
  if (!notesBlock) return [];
  return notesBlock
    .replace(/<\/p>/gi, "\n")
    .split(/\n+/)
    .map(cleanText)
    .filter((note) => note && isSetlistNote(note));
}

function isSetlistNote(note) {
  return !(
    /^tickets?\b/i.test(note) ||
    /^\d+-day tickets?$/i.test(note) ||
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}$/i.test(note)
  );
}

function parsePrimaryImage(html) {
  const og = readFirst(html, /<meta property="og:image" content="([^"]+)"/i);
  if (og) return decodeHtml(og);
  const schema = readFirst(html, /"thumbnailUrl":"([^"]+)"/i);
  return schema ? decodeHtml(schema.replace(/\\\//g, "/")) : "";
}

function normalizeSetLabel(value) {
  return value.toUpperCase() === "E" ? "E" : value.toUpperCase();
}

function normalizeSongTitle(value) {
  return value
    .replace(/\u00d7/g, " x ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value) {
  return decodeHtml(stripTags(value)).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function readFirst(value, pattern) {
  return String(value || "").match(pattern)?.[1] || "";
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
    .replace(/&#215;/g, "x")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function isoToShortDate(value) {
  const [, year, month, day] = value.match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  return year ? `${month}/${day}/${year}` : "";
}

function titleCase(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--year") parsed.year = values[++index];
    else if (value === "--out") parsed.out = values[++index];
    else if (value === "--sitemap") parsed.sitemap = values[++index];
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
