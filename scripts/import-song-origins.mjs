import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const defaults = {
  feedPath: path.join(root, "data", "source", "blogger-feed.atom"),
  output: path.join(root, "data", "source", "song-origins.json"),
  imageDir: path.join(root, "assets", "song-origins"),
  brightDataZone: process.env.BRIGHTDATA_ZONE || "mcp_unlocker",
  concurrency: 4
};

const args = parseArgs(process.argv.slice(2));

async function main() {
  const links = await extractSongOriginLinks(args.feed || defaults.feedPath);
  await mkdir(args.imageDir || defaults.imageDir, { recursive: true });

  const origins = await mapLimit(links, toNumber(args.concurrency) || defaults.concurrency, async (link, index) => {
    const origin = await importOrigin(link, index);
    const status = origin.text ? "recovered" : "linked";
    console.log(`${String(index + 1).padStart(2, "0")}/${links.length} ${status}: ${origin.title}`);
    return origin;
  });

  const payload = {
    importedAt: new Date().toISOString(),
    source: "Blogger Takeout Song Origins index + public Facebook Open Graph metadata",
    completeCount: origins.filter((origin) => origin.text).length,
    linkedCount: origins.filter((origin) => !origin.text).length,
    origins
  };

  await mkdir(path.dirname(args.out || defaults.output), { recursive: true });
  await writeFile(args.out || defaults.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Imported ${payload.completeCount}/${origins.length} song origins to ${path.relative(root, args.out || defaults.output)}.`);
}

async function extractSongOriginLinks(feedPath) {
  const raw = await readFile(feedPath, "utf8");
  const entries = [...raw.matchAll(/<entry\b[\s\S]*?<\/entry>/g)].map((match) => match[0]);
  const entry = entries.find((item) => item.includes("<blogger:filename>/p/widespread-panic-song-origins-and.html</blogger:filename>"));
  if (!entry) throw new Error("Could not find the Song Origins Blogger page in the feed.");

  const html = decodeHtml(readTag(entry, "content"));
  const links = [...html.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      title: clean(stripTags(match[3])),
      sourceUrl: decodeHtml(match[2]).replace(/&amp;/g, "&")
    }))
    .filter((link) => link.title && /facebook\.com/i.test(link.sourceUrl))
    .map((link) => ({
      ...link,
      slug: slugify(link.title),
      facebookUrl: normalizeFacebookUrl(link.sourceUrl)
    }));

  return dedupeBy(links, (link) => link.slug);
}

async function importOrigin(link, index) {
  let fetched = { html: "", via: "none" };
  let error = "";

  try {
    fetched = await fetchFacebookPage(link.facebookUrl);
  } catch (fetchError) {
    error = fetchError.message;
  }

  const ogTitle = readMeta(fetched.html, "og:title");
  const ogImage = readMeta(fetched.html, "og:image");
  const bestImage = fullSizeFacebookImageUrl(bestFacebookImage(fetched.html, ogImage));
  const text = extractPostText(ogTitle, link.title);
  const image = bestImage ? await downloadImage(bestImage, link.slug).catch(() => "") : "";

  return {
    title: link.title,
    slug: link.slug,
    order: index + 1,
    sourceUrl: link.sourceUrl,
    facebookUrl: link.facebookUrl,
    fetchedVia: fetched.via,
    rawTitle: ogTitle,
    text,
    image,
    imageSourceUrl: bestImage || ogImage,
    error
  };
}

async function fetchFacebookPage(url) {
  const direct = await fetchText(url, {
    headers: { "User-Agent": userAgent() }
  }).catch(() => null);

  if (direct && hasSongOriginMeta(direct.text)) return { html: direct.text, via: "direct" };

  const brightDataToken = process.env.BRIGHTDATA_API_TOKEN;
  if (!brightDataToken) return { html: direct?.text || "", via: direct ? "direct-empty" : "none" };

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch("https://api.brightdata.com/request", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${brightDataToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          zone: args.brightDataZone || defaults.brightDataZone,
          url,
          format: "raw"
        })
      });

      const html = await response.text();
      if (response.ok && hasSongOriginMeta(html)) return { html, via: "bright-data" };
      lastError = new Error(`Bright Data returned ${response.status}: ${html.slice(0, 120)}`);
    } catch (error) {
      lastError = error;
    }
    await wait(800 * attempt);
  }

  throw lastError || new Error("Bright Data did not return Song Origins metadata.");
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, text };
}

function hasSongOriginMeta(html) {
  return /property=(["'])og:title\1/i.test(html) && /Song Origins:/i.test(readMeta(html, "og:title"));
}

async function downloadImage(imageUrl, slug) {
  const decodedUrl = fullSizeFacebookImageUrl(imageUrl);
  const response = await fetch(decodedUrl, { headers: { "User-Agent": userAgent() } });
  if (!response.ok) return "";

  const contentType = response.headers.get("content-type") || "";
  const extension = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const relative = `/assets/song-origins/${slug}.${extension}`;
  const target = path.join(args.imageDir || defaults.imageDir, `${slug}.${extension}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(target, buffer);
  return relative;
}

function extractPostText(ogTitle, expectedTitle) {
  let value = decodeHtml(ogTitle).replace(/\u00a0/g, " ").trim().replace(/\s*\|\s*Facebook$/i, "");
  value = value.replace(/^Burnthday(?:'s)?\s*-\s*/i, "");
  value = value.replace(/^(?:Widespread Panic\s+)?Song Origins:\s*/i, "");

  const titlePattern = new RegExp(`^${escapeRegExp(expectedTitle)}\\b\\s*`, "i");
  value = value.replace(titlePattern, "");
  return value.trim();
}

function readTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1] || "";
}

function readMeta(html, property) {
  const escaped = escapeRegExp(property);
  const propertyFirst = html.match(new RegExp(`<meta\\s+property=(["'])${escaped}\\1\\s+content=(["'])([\\s\\S]*?)\\2`, "i"));
  if (propertyFirst) return decodeHtml(propertyFirst[3]);

  const contentFirst = html.match(new RegExp(`<meta\\s+content=(["'])([\\s\\S]*?)\\1\\s+property=(["'])${escaped}\\3`, "i"));
  return contentFirst ? decodeHtml(contentFirst[2]) : "";
}

function bestFacebookImage(html, fallbackImage) {
  const fallback = decodeHtml(fallbackImage || "");
  if (!fallback) return "";

  const fallbackPath = imagePathKey(fallback);
  const candidates = imageUrlsFromHtml(html)
    .filter((url) => imagePathKey(url) === fallbackPath)
    .sort((a, b) => imageUrlScore(b) - imageUrlScore(a));

  return candidates[0] || fallback;
}

function fullSizeFacebookImageUrl(imageUrl) {
  const decodedUrl = decodeHtml(imageUrl || "");
  try {
    const url = new URL(decodedUrl);
    if (/fbcdn|scontent/i.test(url.hostname)) {
      url.searchParams.delete("ctp");
    }
    return url.toString();
  } catch {
    return decodedUrl;
  }
}

function imageUrlsFromHtml(html) {
  const decoded = decodeHtml(html);
  return [...new Set([...decoded.matchAll(/https?:\\?\/\\?\/[^"'<>\s]+?\.(?:jpe?g|png|webp)(?:\?[^"'<>\s]*)?/gi)]
    .map((match) => match[0].replaceAll("\\/", "/"))
    .map((url) => url.replace(/\\u0025/g, "%"))
    .map(decodeHtml))];
}

function imagePathKey(url) {
  try {
    return new URL(decodeHtml(url)).pathname.split("/").pop() || "";
  } catch {
    return "";
  }
}

function imageUrlScore(url) {
  const dimensions = [...String(url).matchAll(/(?:s|p|mx)(\d+)x(\d+)/gi)]
    .map((match) => Number(match[1]) * Number(match[2]));
  return Math.max(0, ...dimensions);
}

function normalizeFacebookUrl(url) {
  const photoId = url.match(/[?&]fbid=(\d+)/)?.[1] || url.match(/\/(\d{8,})(?:[/?#]|$)/)?.[1];
  return photoId ? `https://www.facebook.com/burnthday/photos/a.407139475973855.93743.122023381152134/${photoId}/` : url;
}

function userAgent() {
  return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }));

  return results;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=");
    parsed[toCamelCase(key)] = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
  }
  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "song-origin";
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
}

function clean(value) {
  return decodeHtml(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  const named = {
    amp: "&",
    gt: ">",
    lt: "<",
    quot: "\"",
    apos: "'",
    nbsp: " ",
    rsquo: "'",
    lsquo: "'",
    rdquo: "\"",
    ldquo: "\"",
    ndash: "-",
    mdash: "-",
    hellip: "..."
  };

  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (match, entity) => named[entity.toLowerCase()] ?? match);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
