import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const defaults = {
  feedUrl: process.env.BLOGGER_FEED_URL || "https://www.burnthday.com/feeds/posts/default?alt=json&max-results=500",
  titlePattern: /widespread panic 2025 tour/i,
  output: path.join(root, "data", "source", "setlists-2025.json")
};

const args = parseArgs(process.argv.slice(2));

async function main() {
  const feed = args.fromFile ? await loadFeedFile(args.fromFile) : await fetchFeed(args.feedUrl || defaults.feedUrl);
  const entry = findTourEntry(feed);
  const html = entry.content?.$t || "";
  const setlists = parseSetlists(html);
  const images = parseImages(html);

  setlists.forEach((show, index) => {
    show.image = images[index]?.src || "";
    show.imageWidth = images[index]?.width || 0;
    show.imageHeight = images[index]?.height || 0;
  });

  const payload = {
    title: entry.title?.$t || "WIDESPREAD PANIC 2025 TOUR",
    sourceUrl: alternateUrl(entry),
    sourcePublishedAt: entry.published?.$t || "",
    importedAt: new Date().toISOString(),
    setlists,
    tourDates: parseTourDates(html)
  };

  await mkdir(path.dirname(args.out || defaults.output), { recursive: true });
  await writeFile(args.out || defaults.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Imported ${setlists.length} setlists to ${path.relative(root, args.out || defaults.output)}.`);
}

async function loadFeedFile(filename) {
  const raw = await readFile(filename, "utf8");
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(raw);
  if (trimmed.startsWith("<")) return parseAtomFeed(raw);
  throw new Error(`Unsupported feed file format: ${filename}`);
}

async function fetchFeed(feedUrl) {
  const response = await fetch(feedUrl);
  if (!response.ok) throw new Error(`Blogger feed returned ${response.status} ${response.statusText}`);
  return response.json();
}

function parseAtomFeed(raw) {
  const entries = [...raw.matchAll(/<entry\b[\s\S]*?<\/entry>/g)].map((match) => {
    const entryXml = match[0];
    const title = decodeHtml(stripTags(readTag(entryXml, "title")));
    const content = decodeHtml(readTag(entryXml, "content"));
    const published = decodeHtml(readTag(entryXml, "published"));
    const links = [...entryXml.matchAll(/<link\b([^>]*)\/?>/g)].map((linkMatch) => ({
      rel: readAttr(linkMatch[1], "rel"),
      href: decodeHtml(readAttr(linkMatch[1], "href"))
    }));

    return {
      title: { $t: title },
      content: { $t: content },
      published: { $t: published },
      link: links
    };
  });

  return { feed: { entry: entries } };
}

function readTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1] || "";
}

function readAttr(attrs, attrName) {
  const match = attrs.match(new RegExp(`${attrName}=(["'])(.*?)\\1`, "i"));
  return match?.[2] || "";
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
}

function findTourEntry(feed) {
  const entries = feed.feed?.entry || feed.entry || [];
  const entry = entries.find((item) => defaults.titlePattern.test(item.title?.$t || ""));
  if (!entry) throw new Error("Could not find the 2025 tour post in the Blogger feed.");
  return entry;
}

function parseSetlists(html) {
  const lines = htmlToLines(html);
  const starts = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = parseShowHeader(lines[index]);
    if (!header) continue;
    const hasSetLineSoon = lines.slice(index + 1, index + 4).some((line) => isSetLine(line));
    const hasContinuationThenSet = !isSetLine(lines[index + 1] || "") && isSetLine(lines[index + 2] || "");

    if (hasSetLineSoon || hasContinuationThenSet) {
      starts.push(index);
    }
  }

  return starts.map((start, startIndex) => {
    let headerLine = lines[start];
    let cursor = start + 1;
    if (!isSetLine(lines[cursor] || "")) {
      headerLine = `${headerLine} ${lines[cursor] || ""}`;
      cursor += 1;
    }

    const header = parseShowHeader(headerLine);
    const end = starts[startIndex + 1] || lines.findIndex((line, index) => index > start && /^2025 tour dates$/i.test(line));
    const block = lines.slice(cursor, end > -1 ? end : undefined);
    const sets = [];
    const notes = [];

    for (const line of block) {
      const setLine = parseSetLine(line);
      if (setLine) {
        sets.push(setLine);
      } else if (line && !isSectionNoise(line) && !isCatalogDumpLine(line)) {
        notes.push(cleanNote(line));
      }
    }

    return {
      date: header.date,
      isoDate: toIsoDate(header.date),
      venue: header.venue,
      city: header.city,
      state: header.state,
      location: [header.city, header.state].filter(Boolean).join(", "),
      sets,
      notes: notes.filter(Boolean)
    };
  });
}

function parseTourDates(html) {
  const lines = htmlToLines(html);
  const start = lines.findIndex((line) => /^2025 tour dates$/i.test(line));
  if (start === -1) return [];

  const dates = [];
  for (const line of lines.slice(start + 1)) {
    if (/get tickets/i.test(line)) break;
    const header = parseShowHeader(line);
    if (header) {
      dates.push({
        date: header.date,
        isoDate: toIsoDate(header.date),
        venue: header.venue,
        city: header.city,
        state: header.state,
        location: [header.city, header.state].filter(Boolean).join(", ")
      });
    }
  }
  return dates;
}

function parseImages(html) {
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  return tags
    .map((tag) => {
      const attrs = Object.fromEntries([...tag.matchAll(/([a-zA-Z0-9:-]+)=["']([^"']*)["']/g)].map((match) => [match[1], decodeHtml(match[2])]));
      const width = toNumber(attrs["data-original-width"] || attrs.width);
      const height = toNumber(attrs["data-original-height"] || attrs.height);
      return { src: attrs.src || "", width, height };
    })
    .filter((image) => image.src)
    .filter((image) => !/panic-font\/marker-/i.test(image.src))
    .filter((image) => !/Untitled-1-3\.png/i.test(image.src))
    .filter((image) => image.width >= 400 || image.height >= 400);
}

function htmlToLines(html) {
  return html
    .replace(/\r?\n/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\r?\n/)
    .map((line) => decodeHtml(line).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseShowHeader(line) {
  const match = line.match(/^\s*(?:0\s+)?(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2})\s+(.+)$/);
  if (!match) return null;

  const date = `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}/${match[3]}`;
  const rawPlace = match[4].replace(/\s+/g, " ").trim();
  const parts = rawPlace.split(",").map((part) => part.trim()).filter(Boolean);
  const state = parts.length > 1 ? parts.at(-1) : "";
  const city = parts.length > 1 ? parts.at(-2) : "";
  const venue = parts.length > 2 ? parts.slice(0, -2).join(", ") : rawPlace;

  return { date, venue, city, state };
}

function parseSetLine(line) {
  const match = line.match(/^([1-4]|E)\s*:\s*(.+)$/i);
  if (!match) return null;
  return {
    label: match[1].toUpperCase(),
    songs: normalizeSetText(match[2])
  };
}

function isSetLine(line) {
  return /^([1-4]|E)\s*:/i.test(line || "");
}

function isSectionNoise(line) {
  return /^(RICHMOND, VA I|ORIGINALS|COVERS|THE SHELF|PURGATORY)$/i.test(line);
}

function isCatalogDumpLine(line) {
  const dateCount = [...String(line || "").matchAll(/(?:\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})|\?\?\/\?\?\/\d{2,4})/g)].length;
  return dateCount >= 3;
}

function normalizeSetText(value) {
  return value
    .replace(/\bBowlegged Woman,\s*Knock-Kneed Man\b/gi, "Bowlegged Woman")
    .replace(/\s+/g, " ")
    .replace(/\s+>/g, " >")
    .replace(/>\s+/g, "> ")
    .trim();
}

function cleanNote(line) {
  return line
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim();
}

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function toIsoDate(date) {
  const [month, day, year] = date.split("/");
  return `20${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function alternateUrl(entry) {
  return (entry.link || []).find((link) => link.rel === "alternate")?.href || "";
}

function toNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--from-file") parsed.fromFile = values[++index];
    else if (value === "--out") parsed.out = values[++index];
    else if (value === "--feed-url") parsed.feedUrl = values[++index];
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
