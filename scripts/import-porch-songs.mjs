import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Import the band's "Porch Songs" series: ~30 archival live-release write-ups
 * on widespreadpanic.com, each a specific historic show (mostly the Michael
 * Houser era, 1991-2002) with the band's own highlight notes. We keep the
 * facts and a short highlight snippet, link back to the official page, and add
 * a listen link (archive.org / Relisten), so the site can decorate its
 * Tour-in-Review pages for the sparse pre-2002 years. Curation + attribution,
 * not republication.
 *
 * Output: data/source/porch-songs.json
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const CDX = "http://web.archive.org/cdx/search/cdx";
const OUT = path.join(root, "data", "source", "porch-songs.json");

async function main() {
  // fl includes timestamp so we can fetch the clean Wayback capture ("id_"),
  // which returns the article HTML without the live site's heavy nav wrapper.
  const rows = await cdx("widespreadpanic.com", {
    matchType: "domain", filter: ["original:.*porch-songs-[a-z].*", "statuscode:200"],
    collapse: "urlkey", fl: "timestamp,original", limit: "800"
  });
  // unique article pages, dedup to one canonical URL per show, newest capture
  const byShow = new Map();
  for (const [timestamp, original] of rows) {
    const u = original.replace(/^https?:\/\//, "").replace(":80", "").replace(/^www\./, "");
    if (!/\/porch-songs-[a-z0-9]/i.test(u)) continue;
    if (/\/(feed|comment-page|cache|photo-\d|jb_sunny|palace-ceiling|dave_kalamazoo|mikey_kalamazoo|discography)\b/i.test(u)) continue;
    if (/(oembed|__utm|\.gif|\.jpg|\.png|\?)/i.test(u)) continue;
    const slug = u.split("/").filter(Boolean).pop();
    if (slug === "porch-songs-discography" || u.includes("porch-songs-discography")) continue;
    const key = showKey(slug);
    if (!key) continue;
    // prefer a real article path, and among those the newest capture
    const rank = /\/\d{4}\/\d{2}\/\d{2}\//.test(u) ? 0 : u.includes("/news/") ? 1 : 2;
    const existing = byShow.get(key);
    if (!existing || rank < existing.rank || (rank === existing.rank && timestamp > existing.timestamp)) {
      byShow.set(key, { url: `https://web.archive.org/web/${timestamp}id_/${original}`, live: `https://${u.replace(/\/$/, "")}/`, rank, timestamp, slug });
    }
  }
  const shows = [...byShow.values()];
  console.log(`Found ${shows.length} distinct Porch Songs shows. Fetching…`);

  const entries = [];
  for (let i = 0; i < shows.length; i += 1) {
    const e = await extractShow(shows[i]);
    console.log(`  ${String(i + 1).padStart(2, "0")}/${shows.length} ${e ? `${e.date || "?"} ${e.venue || e.title}`.slice(0, 60) : `(skip ${shows[i].slug})`}`);
    if (e) entries.push(e);
    await sleep(250);
  }
  entries.sort((a, b) => ((a.dateSort || a.year || "").localeCompare(b.dateSort || b.year || "")));

  const payload = {
    importedAt: new Date().toISOString(),
    description:
      "Widespread Panic's official \"Porch Songs\" archival live-release series (widespreadpanic.com): specific historic shows, mostly the Michael Houser era, each with the band's own highlight notes. Facts + short highlight snippet + a listen link; full text stays on the band's site. Use to decorate Tour-in-Review, especially 1991-2002.",
    source: { publication: "Porch Songs", publisher: "widespreadpanic.com (official)", indexUrl: "https://widespreadpanic.com/archive/porch-songs-discography/" },
    count: entries.length,
    entries
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${entries.length} Porch Songs entries to ${path.relative(root, OUT)}.`);
}

// Collapse every URL variant of one show to a stable "city|year" key. Slugs
// come in many forms: porch-songs-6-morrison-co-1996, porch-songs-morrison-co-5311996,
// porch-songs-morrison-1996, porch-songs-red-rocks-2001 (also Morrison), etc.
function showKey(slug) {
  if (!slug) return null;
  const base = slug.toLowerCase().replace(/^porch-songs-/, "").replace(/^release-\d*-?/, "").replace(/^\d+-/, "");
  const year = base.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/)?.[1] || slugPackedDate(base)?.slice(0, 4);
  const city = base.replace(/(?:19|20)\d{2}/g, " ").replace(/\d+/g, " ").replace(/\b(nights?|run|c|co|il|mi|ne|de|ga|ky|wy|mn|nm|tn|ia|mt|al|ms|la|ca|pa|va|nc|sc|oh|wa|or|ks|wi|tx|fl|ny|mo|mn)\b/g, " ").replace(/[^a-z]+/g, " ").trim();
  // Red Rocks and Morrison, CO are the same venue — normalize
  const cityNorm = city.replace(/\bred rocks\b/, "morrison").replace(/\s+/g, " ").trim();
  return year ? `${cityNorm}|${year}` : null;
}

// Parse a packed date embedded in a slug: 7222001 -> 2001-07-22, 10311996 -> 1996-10-31,
// 742001 -> 2001-07-04, 5-7-1997 -> 1997-05-07. Returns ISO or null.
function slugPackedDate(s) {
  const dashed = s.match(/\b(\d{1,2})-(\d{1,2})-((?:19|20)\d{2})\b/);
  if (dashed) return `${dashed[3]}-${dashed[1].padStart(2, "0")}-${dashed[2].padStart(2, "0")}`;
  const packed = s.match(/\b(\d{5,8})\b/);
  if (packed) {
    const d = packed[1];
    const yr = d.slice(-4);
    if (/^(19|20)/.test(yr)) {
      const md = d.slice(0, -4); // 1-4 digits: M, MD, MMD, MMDD
      let mo, da;
      if (md.length <= 2) { mo = md; da = ""; }
      else if (md.length === 3) { mo = md.slice(0, 1); da = md.slice(1); }
      else { mo = md.slice(0, 2); da = md.slice(2); }
      if (mo && da) return `${yr}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}`;
    }
  }
  return null;
}

async function extractShow({ url, live, slug }) {
  const res = await fetchWithRetry(url);
  if (!res || !res.ok) return null;
  const html = await res.text();
  const body = entryContent(html);
  if (!body) return null;
  let text = htmlToText(body);
  // if we grabbed site chrome instead of the article, slice from the heading
  const ph = text.search(/porch\s*songs[:#]/i);
  if (/skip to content|releases archive|all the way from athens/i.test(text.slice(0, 80)) && ph > 0) text = text.slice(ph);
  if (text.length < 40) return null;

  const title = (text.match(/porch\s*songs[:#\s]+([^\n.]{2,60})/i)?.[1] || slug.replace(/^porch-songs-/, "").replace(/-/g, " ")).trim();
  const volume = ordinal(text.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|\d+(?:st|nd|rd|th))\b\s+(?:in the|installment|volume|of the)/i)?.[1]);
  const dm = text.match(/\b(\d{1,2}\/\d{1,2}(?:,\d{1,2})*\/\d{2,4})\b/);
  const date = dm ? dm[1] : null;
  const dateSort = (date ? iso(date) : null) || slugPackedDate(slug);
  const year = (dateSort ? dateSort.slice(0, 4) : null) || slug.match(/((?:19|20)\d{2})/)?.[1] || null;
  const venue = venueLine(text, date);
  // highlights = the editorial intro, minus the store/setlist boilerplate
  let highlights = text
    .replace(/\n/g, " ")
    // strip leading date stamps + the repeated "Porch Songs: <name> <year>" title
    .replace(/^(?:Archive|Releases|News|Streams?)\s+on\b.*?(?=Porch Songs|$)/i, "")
    .replace(/^Porch Songs:?\s*[^.]*?\b(?:19|20)\d{2}\b[.,]?\s*/i, "")
    // cut only at genuine trailers (setlist / "Horace has the scoop" / share bar)
    .split(/Set:\s|Horace (?:has|breaks)|Full list of past|SPREAD THE WORD|Grab your copy|Read the full synopsis|Home Releases|Multitrack Discography/i)[0]
    // remove the mid-text store-promo sentence so real highlights survive
    .replace(/[^.]*?(?:made available|now available|available (?:today|now))[^.]*?(?:LiveWidespreadPanic|Live Widespread Panic|the Archive)[^.]*?\.\s*/gi, "")
    .replace(/\s+/g, " ").trim();
  if (highlights.length > 600) highlights = `${highlights.slice(0, 600).trim()}…`;
  // thin promos, or leftover site chrome, carry no real detail
  const thin = highlights.length < 45 || /^the newest release/i.test(highlights) || /skip to content|releases archive|all the way from athens|menu\b|porch songs discography|multitrack discography|widespread panic archives|archive home/i.test(highlights);

  return {
    title: `Porch Songs: ${title}`,
    volume,
    year,
    date,
    dateSort,
    venue,
    highlights: thin ? null : highlights,
    hasHighlights: !thin,
    sourceUrl: live,
    listen: dateSort
      ? { relisten: `https://relisten.net/widespread-panic/${dateSort}`, archiveOrg: `https://archive.org/search?query=collection%3AWidespreadPanic+AND+date%3A${dateSort}` }
      : (year ? { archiveOrg: `https://archive.org/search?query=collection%3AWidespreadPanic+AND+year%3A${year}` } : null)
  };
}

function venueLine(text, date) {
  if (!date) return null;
  const i = text.indexOf(date);
  if (i === -1) return null;
  const after = text.slice(i + date.length, i + date.length + 90).replace(/\s+/g, " ").trim();
  const m = after.match(/^[\s,–-]*([A-Z][^\n]*?(?:,\s*[A-Z]{2}|,\s*[A-Z][a-z]+))/);
  return m ? m[1].replace(/\s+/g, " ").trim() : (after.split(/\s{2,}|Available|Set:/)[0].trim() || null);
}

function ordinal(w) {
  if (!w) return null;
  const words = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20 };
  const lw = w.toLowerCase();
  if (words[lw]) return words[lw];
  const n = lw.match(/^(\d+)/);
  return n ? Number(n[1]) : null;
}

function iso(dstr) {
  const m = dstr.match(/^(\d{1,2})\/(\d{1,2})(?:,\d{1,2})*\/(\d{2,4})$/);
  if (!m) return null;
  let [, mo, da, yr] = m;
  yr = Number(yr); if (yr < 100) yr = yr < 30 ? 2000 + yr : 1900 + yr;
  return `${yr}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
}

function entryContent(html) {
  const idx = html.search(/class="[^"]*entry-content[^"]*"/i);
  if (idx === -1) return stripNoise(html);
  const open = html.indexOf(">", idx) + 1;
  const re = /<\/?div\b[^>]*>/gi; re.lastIndex = open;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    depth += /^<div/i.test(m[0]) ? 1 : -1;
    if (depth === 0) return stripNoise(html.slice(open, m.index));
  }
  return stripNoise(html.slice(open, open + 4000));
}

function stripNoise(h) {
  return h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
}

function htmlToText(html) {
  return decodeEntities(html.replace(/<\s*(br|p|div|li|h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–", hellip: "…", eacute: "é" };
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n] ?? named[n.toLowerCase()] ?? m);
}

async function cdx(url, params = {}) {
  const qs = new URLSearchParams({ url, output: "text", ...params });
  if (Array.isArray(params.filter)) { qs.delete("filter"); for (const f of params.filter) qs.append("filter", f); }
  const res = await fetchWithRetry(`${CDX}?${qs.toString()}`);
  if (!res || !res.ok) return [];
  return (await res.text()).split(/\r?\n/).filter(Boolean).map((l) => l.split(/\s+/));
}

async function fetchWithRetry(url, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (res.status === 429 || res.status >= 500) throw new Error(`status ${res.status}`);
      return res;
    } catch (err) {
      if (i === attempts - 1) { console.warn(`  ! ${url} failed: ${err.message}`); return null; }
      await sleep(1000 * (i + 1));
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => { console.error(e); process.exit(1); });
