import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Import the two Widespread Panic fan newsletters into a single catalog:
 *
 *   1. MOON TIMES  — the official WSP newsletter (Brown Cat / WSP office).
 *      Preserved on the Internet Archive from widespreadpanic.com's own
 *      "nonflash" (text) site. Six volumes of four issues, plus a current
 *      issue, laid out as archive/vol{V}/vol{V}no{N}/.
 *
 *   2. THE PANICLE — the earlier '90s fan herald "from the Proving Ground"
 *      (Athens, GA). No complete archive exists; a single issue (Vol. 1 #5,
 *      July 1992) is transcribed on the "Nothing But Widespread Panic" fan
 *      blog. It is heavily song-history focused (debuts, alternate titles).
 *
 * This is preservation + attribution, not uncredited republication: Moon
 * Times is official content (linked/attributed to WSP + the Internet Archive);
 * the Panicle text is a fan transcription (credited to the blog).
 *
 * Output: data/source/newsletters.json — one record per reachable issue with
 * full extracted text plus song-origin/song-history mentions cross-referenced
 * against data/source/song-origins.json and data/source/catalog.csv.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// The index capture we anchor from; Wayback redirects each issue to its own
// nearest capture, which we record per issue.
const MOONTIMES_BASE =
  "https://web.archive.org/web/20010805112149/http://widespreadpanic.com/nonflash/moontimes";

const MOONTIMES_ATTRIBUTION =
  "Moon Times was the official Widespread Panic newsletter, produced by the WSP office / Brown Cat. Text preserved by the Internet Archive (web.archive.org) from widespreadpanic.com's own site.";

const PANICLE_ISSUES = [
  {
    volume: 1,
    number: 5,
    label: "Vol. 1 #5",
    date: "July 1992",
    dateSort: "1992-07",
    url: "http://widespread-panic.blogspot.com/1992/07/july-1992-panicle-newsletter.html",
    attribution:
      "The Panicle was a fan-run Widespread Panic newsletter (Athens, GA, \"from the Proving Ground\"). This issue was transcribed by the \"Nothing But Widespread Panic\" fan blog (widespread-panic.blogspot.com). Credit to the blog and the original Panicle authors."
  }
];

// Panicle issues known to have existed but NOT transcribed online. Recorded so
// the catalog is honest about coverage and so Alex's physical copies can fill
// the gaps by scan later.
const PANICLE_GAPS = [
  { label: "Vol. 1 #4", date: "June 1992", note: "Physical copies surface on WorthPoint/eBay; no transcription located online." },
  { label: "Vol. 1 #1–#3", date: "1991–1992", note: "Earlier issues referenced by later ones; no transcription located online." }
];

// CDX host for enumerating what the Internet Archive actually holds.
const CDX = "http://web.archive.org/cdx/search/cdx";
const MOONTIMES_PREFIX = "widespreadpanic.com/nonflash/moontimes";

const defaults = {
  output: path.join(root, "data", "source", "newsletters.json"),
  songOrigins: path.join(root, "data", "source", "song-origins.json"),
  catalog: path.join(root, "data", "source", "catalog.csv"),
  concurrency: 3
};

async function main() {
  const titleIndex = await buildTitleIndex();

  console.log("Enumerating the Moon Times inventory from the Internet Archive (CDX)…");
  const moonTargets = await moonTimesTargets();
  console.log(`  ${moonTargets.length} issue roots archived: ${moonTargets.map((t) => t.label).join(", ")}`);

  console.log("Fetching Moon Times issues…");
  const moonIssues = await mapLimit(moonTargets, defaults.concurrency, async (target, i) => {
    const issue = await fetchMoonTimesIssue(target);
    const status = issue.missingCapture ? "no capture" : `${issue.text.length} chars${issue.parts ? ` (${issue.parts} parts)` : ""}`;
    console.log(`  ${String(i + 1).padStart(2, "0")}/${moonTargets.length} ${issue.label}: ${status}`);
    return issue;
  });

  console.log("Recovering web-only issues from Current Issue snapshots…");
  const captured = moonIssues.filter((i) => !i.missingCapture);
  const { recovered: currentIssues, mastheadOnly } = await recoverCurrentIssues(captured);
  for (const ci of currentIssues) console.log(`  recovered ${ci.label} (${ci.text.length} chars) from Current Issue snapshot @ ${ci.waybackTimestamp}`);
  for (const g of mastheadOnly) console.log(`  ${g.label}: masthead survives but content redirects to ${g.duplicateOf} — no distinct copy archived`);
  moonIssues.push(...currentIssues);

  console.log("Fetching Panicle transcription(s)…");
  const panicleIssues = await mapLimit(PANICLE_ISSUES, defaults.concurrency, async (spec, i) => {
    const issue = await fetchPanicleIssue(spec);
    console.log(`  ${i + 1}/${PANICLE_ISSUES.length} ${issue.label}: ${issue.missingCapture ? "unreachable" : `${issue.text.length} chars`}`);
    return issue;
  });

  const issues = [...moonIssues, ...panicleIssues]
    .filter((issue) => !issue.missingCapture)
    .map((issue) => ({ ...issue, songMentions: extractSongMentions(issue, titleIndex) }));

  const missing = [...moonIssues, ...panicleIssues].filter((issue) => issue.missingCapture);

  const payload = {
    importedAt: new Date().toISOString(),
    description:
      "Digitized Widespread Panic fan-newsletter archive: the official Moon Times (via the Internet Archive) and the fan-run Panicle (via fan transcription). Preservation with attribution; song-history mentions cross-referenced against song-origins.json.",
    sources: [
      {
        publication: "Moon Times",
        role: "official",
        publisher: "Widespread Panic office / Brown Cat",
        indexUrl: `${MOONTIMES_BASE}/`,
        attribution: MOONTIMES_ATTRIBUTION
      },
      {
        publication: "The Panicle",
        role: "fan newsletter (transcribed)",
        publisher: "Fan-run, Athens GA (\"from the Proving Ground\")",
        indexUrl: "http://widespread-panic.blogspot.com/",
        attribution:
          "Fan transcription hosted by the \"Nothing But Widespread Panic\" blog. Original Panicle newsletter by its uncredited '90s fan authors."
      }
    ],
    counts: {
      issues: issues.length,
      moonTimes: issues.filter((i) => i.publication === "Moon Times").length,
      panicle: issues.filter((i) => i.publication === "The Panicle").length,
      songMentions: issues.reduce((n, i) => n + i.songMentions.length, 0),
      crossReferencedOrigins: new Set(
        issues.flatMap((i) => i.songMentions.filter((m) => m.crossReferencesOrigin).map((m) => m.slug))
      ).size
    },
    knownGaps: {
      moonTimes: moonTimesGaps(issues),
      moonTimesMastheadOnly: mastheadOnly,
      panicle: PANICLE_GAPS,
      note:
        "Moon Times gaps are issues in the vol. 1–6 numbering that the Internet Archive never captured. 'MastheadOnly' issues (e.g. Vol. 7 #3) had their masthead frame archived but their content frames redirect to another issue, so no distinct copy survives online. The Panicle has no complete online archive — only the issue(s) above are transcribed. Alex holds physical copies that can be scanned to fill these gaps."
    },
    unreachable: missing.map(({ publication, label, url }) => ({ publication, label, url })),
    issues
  };

  await mkdir(path.dirname(defaults.output), { recursive: true });
  await writeFile(defaults.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    `\nWrote ${payload.counts.issues} issues (${payload.counts.moonTimes} Moon Times, ${payload.counts.panicle} Panicle), ` +
      `${payload.counts.songMentions} song mentions, ${payload.counts.crossReferencedOrigins} distinct origins cross-referenced ` +
      `to ${path.relative(root, defaults.output)}.`
  );
  if (missing.length) {
    console.log(`Unreachable captures: ${missing.map((m) => m.label).join(", ")}`);
  }
}

function moonTimesGaps(issues) {
  const have = new Set(
    issues
      .filter((i) => i.publication === "Moon Times" && i.volume && i.number)
      .map((i) => `${i.volume}:${i.number}`)
  );
  const gaps = [];
  for (let vol = 1; vol <= 6; vol += 1) {
    for (let no = 1; no <= 4; no += 1) {
      if (!have.has(`${vol}:${no}`)) {
        gaps.push({ label: `Vol. ${vol} #${no}`, note: "Not captured by the Internet Archive; no surviving online copy located." });
      }
    }
  }
  return gaps;
}

async function moonTimesTargets() {
  // Ask the Internet Archive what issue roots it actually holds, rather than
  // assuming a fixed 6×4 grid. This picks up the "issue 3.5" oddity and the
  // web-only vol. 7 era automatically, and skips issues that were never
  // archived (vol. 2 #2, vol. 4 #4).
  const rows = await cdx(`${MOONTIMES_PREFIX}/archive/`, { matchType: "prefix", fl: "original", collapse: "urlkey" });
  const roots = new Map();
  for (const [original] of rows) {
    const m = original.match(/\/archive\/vol(\d+)\/vol\1no(\d+(?:_\d+)?)\/?$/i);
    if (!m) continue; // skip sub-article pages, images, assets
    const volume = Number(m[1]);
    const seg = m[2]; // raw path segment, e.g. "4" or "3_5"
    const display = seg.replace("_", ".");
    const key = `vol${volume}no${seg}`;
    if (roots.has(key)) continue;
    roots.set(key, {
      publication: "Moon Times",
      volume,
      number: display.includes(".") ? display : Number(display),
      label: `Vol. ${volume} #${display}`,
      url: `${MOONTIMES_BASE}/archive/vol${volume}/${key}/`
    });
  }
  return [...roots.values()].sort((a, b) => a.volume - b.volume || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}

async function fetchMoonTimesIssue(target) {
  const res = await fetchWithRetry(target.url);
  if (!res || !res.ok) return { ...target, missingCapture: true };
  let html = await decodeBody(res);
  const wayback = waybackMeta(res.url);
  let cleaned;
  let parts = 0;

  if (isFrameset(html)) {
    // Web-only era (vol. 7 / current issue): a frameset whose real content is
    // main.htm plus sibling .asp article pages. Pull and concatenate them.
    const assembled = await assembleFramesetIssue(target.url, wayback.timestamp);
    if (!assembled.text || assembled.text.length < 120) return { ...target, missingCapture: true };
    cleaned = assembled;
    parts = assembled.parts;
  } else {
    cleaned = cleanMoonTimesHtml(html);
    if (!cleaned.text || cleaned.text.length < 120) return { ...target, missingCapture: true };
  }

  const est = estimateIssueDate(target.volume, target.number);
  return {
    publication: "Moon Times",
    volume: target.volume,
    number: target.number,
    label: cleaned.label || target.label,
    title: cleaned.title || `Moon Times ${target.label}`,
    datePrinted: cleaned.date || null,
    date: cleaned.date || est.label,
    dateSort: cleaned.dateSort || est.dateSort,
    dateEstimated: !cleaned.dateSort,
    sourceUrl: res.url,
    waybackTimestamp: wayback.timestamp,
    originalUrl: wayback.original,
    attribution: MOONTIMES_ATTRIBUTION,
    ...(parts ? { parts } : {}),
    text: cleaned.text
  };
}

function isFrameset(html) {
  // Detect a genuine frameset, ignoring the Wayback toolbar / injected scripts
  // (which can contain <p> and other tags that confuse naive heuristics).
  const stripped = html
    .replace(/<!--\s*BEGIN WAYBACK TOOLBAR INSERT[\s\S]*?END WAYBACK TOOLBAR INSERT\s*-->/i, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<div id=["']wm-ipp[\s\S]*?<\/div>/i, " ");
  return /<frameset\b/i.test(stripped) || /<frame\b[^>]*\bsrc=/i.test(stripped);
}

async function assembleFramesetIssue(issueUrl, timestamp) {
  const issuePath = issueUrl.replace(MOONTIMES_BASE, MOONTIMES_PREFIX).replace(/\/$/, "");
  const rows = await cdx(`${issuePath}/`, { matchType: "prefix", fl: "original", collapse: "urlkey" });
  const pages = rows
    .map(([original]) => original.replace(/^https?:\/\//, "").replace(":80", "").replace("www.", ""))
    .filter((u) => /\.(asp|html?|htm)$/i.test(u))
    .filter((u) => !/\/(top|bottom\d*|index\d+|nav)\.html?$/i.test(u))
    .map((u) => u.split("/").pop())
    .filter((f, i, a) => a.indexOf(f) === i)
    .sort(contentPageOrder);

  const texts = [];
  let label = null;
  let title = null;
  for (const page of pages) {
    const url = `https://web.archive.org/web/${timestamp}/http://${issuePath}/${page}`;
    const r = await fetchWithRetry(url);
    if (!r || !r.ok) continue;
    const c = cleanMoonTimesHtml(await decodeBody(r));
    if (!c.text || c.text.length < 40) continue;
    if (!label && c.label) label = c.label;
    const heading = page === "main.htm" || page === "default.asp" ? null : sectionHeading(page);
    texts.push(heading ? `## ${heading}\n${c.text}` : c.text);
    await sleep(200);
  }
  // The masthead ("vol.7 no.3") often lives only in the nav frame (top.htm),
  // which we exclude from the body. Fetch it just to recover the label.
  if (!label) {
    for (const nav of ["top.htm", "top.html"]) {
      const r = await fetchWithRetry(`https://web.archive.org/web/${timestamp}/http://${issuePath}/${nav}`);
      if (!r || !r.ok) continue;
      const c = cleanMoonTimesHtml(await decodeBody(r));
      if (c.label) { label = c.label; break; }
    }
  }

  const text = texts.join("\n\n").trim();
  const { date, dateSort } = guessDate(text);
  return { label, title: title || (label ? `Moon Times ${label}` : null), date, dateSort, text, parts: texts.length };
}

function contentPageOrder(a, b) {
  const rank = (f) => (f === "main.htm" || f === "default.asp" ? 0 : /^\d+\.html?$/i.test(f) ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b, undefined, { numeric: true });
}

function sectionHeading(page) {
  return page
    .replace(/\.(asp|html?|htm)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function recoverCurrentIssues(capturedIssues) {
  // The "current issue" slot rotated over time and could, in principle, be the
  // only surviving copy of an issue never filed under archive/. In practice the
  // Internet Archive captured the current-issue masthead frame but redirected
  // its content frames to a neighbouring issue's cached pages — so most
  // snapshots resolve to text identical to an issue we already hold. We recover
  // a snapshot only when its body is genuinely distinct; a snapshot whose
  // masthead is new but whose body duplicates an existing issue is recorded as
  // a "masthead-only" gap rather than a mislabeled duplicate.
  const coveredLabels = new Set(capturedIssues.map((i) => i.label.toLowerCase()));
  const fingerprints = new Map(capturedIssues.map((i) => [textFingerprint(i.text), i.label]));

  const rows = await cdx(`${MOONTIMES_PREFIX}/currentissue/`, { fl: "timestamp,statuscode,digest", filter: "statuscode:200", collapse: "digest" });
  const recovered = [];
  const mastheadOnly = [];
  const unidentified = [];
  const seen = new Set();
  for (const [timestamp] of rows) {
    const url = `https://web.archive.org/web/${timestamp}/http://${MOONTIMES_PREFIX}/currentissue/`;
    const r = await fetchWithRetry(url);
    if (!r || !r.ok) continue;
    const html = await decodeBody(r);
    // The snapshot's own root page carries the authoritative masthead for that
    // moment; the assembler's top.htm fallback can pull a stale neighbouring
    // label, so for the current-issue slot we trust the root masthead only.
    const label = cleanMoonTimesHtml(html).label;
    const assembled = isFrameset(html)
      ? await assembleFramesetIssue(`${MOONTIMES_BASE}/currentissue/`, timestamp)
      : cleanMoonTimesHtml(html);
    if (!assembled.text || assembled.text.length < 200) continue;
    if (!label) {
      unidentified.push({ timestamp, chars: assembled.text.length });
      continue;
    }
    const key = label.toLowerCase();
    if (coveredLabels.has(key) || seen.has(key)) continue;

    const dupeOf = fingerprints.get(textFingerprint(assembled.text));
    if (dupeOf) {
      mastheadOnly.push({ label, duplicateOf: dupeOf, waybackTimestamp: timestamp, sourceUrl: url });
      seen.add(key);
      continue;
    }
    seen.add(key);
    recovered.push({
      publication: "Moon Times",
      volume: labelVolume(label),
      number: labelNumber(label),
      label,
      title: assembled.title || `Moon Times ${label}`,
      date: assembled.date,
      dateSort: assembled.dateSort,
      sourceUrl: url,
      waybackTimestamp: timestamp,
      recoveredFrom: "currentissue snapshot",
      ...(assembled.parts ? { parts: assembled.parts } : {}),
      attribution: MOONTIMES_ATTRIBUTION,
      text: assembled.text
    });
    await sleep(200);
  }
  if (unidentified.length) {
    console.log(`  ${unidentified.length} current-issue snapshot(s) had content but no parseable masthead (skipped): ${unidentified.map((u) => u.timestamp).join(", ")}`);
  }
  return { recovered, mastheadOnly };
}

function textFingerprint(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 500);
}

function labelVolume(label) {
  const m = label.match(/vol\.?\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function labelNumber(label) {
  const m = label.match(/#\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

async function cdx(url, params = {}) {
  const qs = new URLSearchParams({ url, output: "text", ...params }).toString();
  const res = await fetchWithRetry(`${CDX}?${qs}`);
  if (!res || !res.ok) return [];
  const text = await res.text();
  return text.split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/));
}

async function fetchPanicleIssue(spec) {
  const res = await fetchWithRetry(spec.url);
  if (!res || !res.ok) return { ...spec, publication: "The Panicle", missingCapture: true };
  const html = await decodeBody(res);
  const text = cleanPanicleHtml(html);
  if (!text || text.length < 120) return { ...spec, publication: "The Panicle", missingCapture: true };
  return {
    publication: "The Panicle",
    volume: spec.volume,
    number: spec.number,
    label: spec.label,
    title: `The Panicle — ${spec.date}`,
    datePrinted: spec.date,
    date: spec.date,
    dateSort: spec.dateSort,
    dateEstimated: false,
    sourceUrl: spec.url,
    attribution: spec.attribution,
    text
  };
}

// --- HTML -> text -------------------------------------------------------

function cleanMoonTimesHtml(html) {
  let body = html;
  // Drop the Wayback toolbar insert and any scripts/styles/comments.
  body = body.replace(/<!--\s*BEGIN WAYBACK TOOLBAR INSERT\s*-->[\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->/gi, " ");
  body = stripNoise(body);

  // Pull the printed masthead line ("vol.1 :: #1") before we flatten, so we
  // can label the issue even if the URL parse is ambiguous.
  const text = htmlToText(body);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let label = null;
  let title = null;
  const kept = [];
  const boilerplate = [
    /^widespread panic$/i,
    /^widespreadpanic\.com\s*::?/i,
    /^moontimes\s*::?/i,
    /^archive\s*::?/i,
    /^vol\.?\s*\d+\s*(::?\s*#?|no\.?\s*)\d+\s*$/i,
    /^the official panic newsletter$/i,
    /^created and maintained by/i,
    /^file archived on/i,
    /internet archive/i,
    /javascript appended by wayback/i,
    /^tuw ?designs?/i,
    /^back to (top|archive)/i,
    /^\W{0,3}$/
  ];
  const mastheadRe = /vol\.?\s*(\d+)\s*(?:::?\s*#?\s*|no\.?\s*|#\s*)(\d+(?:\.\d+)?)/i;
  for (const line of lines) {
    const volMatch = line.match(mastheadRe);
    if (volMatch && !label) label = `Vol. ${volMatch[1]} #${volMatch[2]}`;
    if (/^the official panic newsletter$/i.test(line) && !title) title = "The Official Panic Newsletter";
    if (boilerplate.some((re) => re.test(line))) continue;
    kept.push(line);
  }

  const cleanText = kept.join("\n").trim();
  const { date, dateSort } = guessDate(cleanText);
  return { label, title: title || `Moon Times ${label || ""}`.trim(), date, dateSort, text: cleanText };
}

function cleanPanicleHtml(html) {
  // Prefer the Blogger post body div; fall back to the whole document.
  const div = extractPostBody(html);
  const text = htmlToText(stripNoise(div || html));
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const boilerplate = [
    /^nothing but widespread panic/i,
    /^reporting on widespread panic/i,
    /^you can also find reprinted/i,
    /^skip to (main|sidebar)/i,
    /^posted by/i,
    /^labels:/i,
    /^(newer|older|home) ?post/i,
    /^subscribe to:/i,
    /^\d+ comments?:?$/i,
    /^no comments:?$/i,
    /^blog archive$/i,
    /^followers$/i,
    /^about me$/i,
    /^share this/i,
    /^email this/i,
    /^\W{0,3}$/
  ];
  const kept = lines.filter((line) => !boilerplate.some((re) => re.test(line)));
  return kept.join("\n").trim();
}

function extractPostBody(html) {
  const idx = html.search(/class="[^"]*post-body[^"]*"/i);
  if (idx === -1) return null;
  const open = html.lastIndexOf("<div", idx);
  if (open === -1) return null;
  // Walk div nesting from the opening tag to find the matching close.
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = open;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    if (/^<div/i.test(m[0])) depth += 1;
    else depth -= 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  return html.slice(open);
}

function stripNoise(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<\s*(br|p|div|tr|li|h[1-6]|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<\/\s*(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–", hellip: "…", eacute: "é" };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (named[n] ?? named[n.toLowerCase()] ?? m));
}

function waybackMeta(url) {
  const m = url.match(/web\.archive\.org\/web\/(\d+)(?:\w+)?\/(.*)$/);
  return { timestamp: m ? m[1] : null, original: m ? m[2] : url };
}

const SEASON_MONTH = { spring: "03", summer: "06", fall: "09", autumn: "09", winter: "12" };
const MONTH_NUM = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };

// Extract only a date the issue prints about ITSELF, and only from the
// masthead/intro region — scanning the whole body grabs years mentioned inside
// articles (band history: "1971", "1986", etc.) or the Wayback capture year.
// A bare year with no season/month is deliberately NOT accepted; those are the
// noisy false positives. When nothing reliable prints, the caller falls back to
// a clearly-flagged volume estimate.
function guessDate(text) {
  const intro = (text || "").slice(0, 1200);
  const seasons = "spring|summer|fall|autumn|winter";
  const seasonYear =
    intro.match(new RegExp(`(${seasons})\\s+tour\\s+(?:for\\s+)?(?:the\\s+)?(19|20)\\d{2}`, "i")) ||
    intro.match(new RegExp(`(19|20)\\d{2}\\s+(${seasons})\\s+tour`, "i")) ||
    intro.match(new RegExp(`(${seasons})\\s+(19|20)\\d{2}`, "i")) ||
    intro.match(new RegExp(`(19|20)\\d{2}\\s+(${seasons})`, "i"));
  const monthYear = intro.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(19|20)\d{2}/i);
  const raw = (seasonYear && seasonYear[0]) || (monthYear && monthYear[0]) || null;
  if (!raw) return { date: null, dateSort: null };
  const y = raw.match(/(19|20)\d{2}/);
  const season = raw.match(new RegExp(seasons, "i"));
  const month = raw.match(/January|February|March|April|May|June|July|August|September|October|November|December/i);
  const mm = month ? MONTH_NUM[month[0].toLowerCase()] : season ? SEASON_MONTH[season[0].toLowerCase()] : null;
  const dateSort = y ? (mm ? `${y[0]}-${mm}` : y[0]) : null;
  return { date: raw.replace(/\s+/g, " ").trim(), dateSort };
}

// Moon Times ran roughly quarterly, one issue per tour, from vol. 1 (1995) to
// vol. 7 (2001–02): year ≈ 1994 + volume, issue number ≈ season. Used only when
// the issue itself prints no reliable date, and always flagged as estimated.
function estimateIssueDate(volume, number) {
  if (!volume) return { dateSort: null, label: null };
  const year = 1994 + volume;
  const seasonByNumber = { 1: "spring", 2: "summer", 3: "fall", 4: "winter" };
  const season = seasonByNumber[Math.floor(Number(number))] || null;
  const mm = season ? SEASON_MONTH[season] : null;
  return {
    dateSort: mm ? `${year}-${mm}` : String(year),
    label: season ? `circa ${season[0].toUpperCase()}${season.slice(1)} ${year}` : `circa ${year}`
  };
}

// --- Song-mention extraction -------------------------------------------

async function buildTitleIndex() {
  const originsRaw = JSON.parse(await readFile(defaults.songOrigins, "utf8"));
  const originSlugs = new Map(originsRaw.origins.map((o) => [normalizeTitle(o.title), { title: o.title, slug: o.slug }]));

  const csv = await readFile(defaults.catalog, "utf8");
  const rows = csv.split(/\r?\n/).slice(1).filter(Boolean);
  const catalog = new Map();
  for (const row of rows) {
    const cols = parseCsvRow(row);
    const title = cols[0];
    if (!title) continue;
    catalog.set(normalizeTitle(title), {
      title,
      first: cols[1] || null,
      type: cols[6] || null
    });
  }

  // Merge into one lookup keyed by normalized title.
  const index = new Map();
  for (const [norm, entry] of catalog) {
    index.set(norm, {
      title: entry.title,
      slug: slugify(entry.title),
      first: entry.first,
      type: entry.type,
      hasOrigin: originSlugs.has(norm),
      originSlug: originSlugs.get(norm)?.slug || null
    });
  }
  // Ensure every origin is representable even if absent from the catalog CSV.
  for (const [norm, entry] of originSlugs) {
    if (!index.has(norm)) {
      index.set(norm, { title: entry.title, slug: entry.slug, first: null, type: null, hasOrigin: true, originSlug: entry.slug });
    }
  }
  return index;
}

// Names that read like song titles but are people (band members) or the band
// itself — they dominate newsletter prose and must never be tagged as songs.
const NON_SONG = new Set(["jojo", "sunny", "jb", "brown cat", "widespread panic", "michael houser", "dave schools", "todd nance", "domingo ortiz"]);

function extractSongMentions(issue, titleIndex) {
  const text = issue.text;
  const issueYear = issue.dateSort ? Number(String(issue.dateSort).slice(0, 4)) : null;
  const mentions = new Map();

  // 1. Quoted song names ("Gomero Blanco") — highest precision, especially in
  //    the Panicle, which discusses songs one by one in quotes. Resolve "The X"
  //    to the catalog's "X" so the two don't split into duplicate entries.
  const quoteRe = /[“"]([^”"\n]{2,40})[”"]/g;
  let q;
  while ((q = quoteRe.exec(text))) {
    const phrase = q[1].trim();
    const entry = titleIndex.get(normalizeTitle(phrase)) || (/^the\s+/i.test(phrase) ? titleIndex.get(normalizeTitle(phrase.replace(/^the\s+/i, ""))) : null);
    addMention(mentions, { matchedText: entry?.title || phrase, quoted: true, known: Boolean(entry), entry: entry || null, index: q.index, text });
  }

  // 2. Known catalog titles appearing unquoted. Restrict to multi-word or
  //    distinctive titles to avoid matching common English words.
  for (const [norm, entry] of titleIndex) {
    if (norm.length < 5) continue; // skip very short titles (high false-positive)
    const words = entry.title.split(/\s+/);
    const isDistinct = words.length >= 2 || /[^a-z]/i.test(entry.title) || norm.length >= 7;
    if (!isDistinct) continue;
    const re = new RegExp(`\\b${escapeRegex(entry.title)}\\b`, "gi");
    let m;
    while ((m = re.exec(text))) {
      addMention(mentions, { matchedText: entry.title, quoted: false, known: true, entry, index: m.index, text });
    }
  }

  const list = [...mentions.values()];
  return list
    // Keep known songs and unknown quoted phrases that read like song titles
    // (the Panicle names lost/renamed songs predating the modern catalog)…
    .filter((mm) => mm.known || (mm.quoted && looksLikeSongTitle(mm.matchedText)))
    // …but an uncatalogued quoted phrase is only a song if its context talks
    // about a song. This rejects joke quotes like the "GO GO super drink" /
    // "Ginger Snaps" band-member snack bit in vol. 5 #1.
    .filter((mm) => mm.known || hasSongContext(mm.snippet, mm.matchedText))
    // Drop band members / the band name.
    .filter((mm) => !NON_SONG.has(normalizeTitle(mm.entry?.title || mm.matchedText)))
    .map((mm) => {
      const note = classifyMention(mm.snippet);
      const firstYear = mm.entry?.first ? Number(String(mm.entry.first).split("/").pop()) : null;
      const yr = firstYear != null ? (firstYear >= 70 ? 1900 + firstYear : 2000 + firstYear) : null;
      // A newsletter cannot report on a song first played years after it went
      // to print — those are common-word false matches (e.g. "Sometimes"→1999).
      const temporalMismatch = Boolean(mm.known && issueYear && yr && yr > issueYear + 1);
      const confidence =
        mm.quoted && (mm.known || note !== "mention") ? "high" :
        mm.known && (/\s/.test(mm.entry.title) || note !== "mention") ? "medium" : "low";
      return {
        song: mm.entry?.title || mm.matchedText,
        slug: mm.entry?.slug || slugify(mm.matchedText),
        inCatalog: mm.known,
        crossReferencesOrigin: Boolean(mm.entry?.hasOrigin),
        originSlug: mm.entry?.originSlug || null,
        catalogFirstPlayed: mm.entry?.first || null,
        note,
        confidence,
        firstIndex: mm.firstIndex,
        temporalMismatch,
        snippet: mm.snippet
      };
    })
    // A generic single-word unquoted match with no origin/debut context, or a
    // temporal impossibility, is noise; keep the substantive mentions.
    .filter((mm) => !mm.temporalMismatch && mm.confidence !== "low")
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map(({ firstIndex, temporalMismatch, ...keep }) => keep);
}

function addMention(map, { matchedText, quoted, known, entry, index, text }) {
  const key = (entry?.slug || slugify(matchedText)).toLowerCase();
  const snippet = snippetAround(text, index, matchedText.length);
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    if (quoted) existing.quoted = true;
    if (known && !existing.known) {
      existing.known = true;
      existing.entry = entry;
    }
    // Prefer a snippet that carries origin/debut language.
    if (classifyMention(snippet) !== "mention" && classifyMention(existing.snippet) === "mention") {
      existing.snippet = snippet;
    }
    return;
  }
  map.set(key, { matchedText, quoted, known, entry, firstIndex: index, snippet, count: 1 });
}

function snippetAround(text, index, len) {
  const start = Math.max(0, index - 140);
  const end = Math.min(text.length, index + len + 200);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function classifyMention(snippet) {
  const s = snippet.toLowerCase();
  if (/\bdebut|first (played|recorded|performed|appear)|premiere|first time\b/.test(s)) return "debut";
  if (/\bwritten|wrote|inspired|based on|named (after|for)|comes from|origin|story behind\b/.test(s)) return "origin";
  if (/\b(also |commonly |originally |formerly )?(known|called|titled) as|renamed|early version|became\b/.test(s)) return "alt-title";
  if (/\brecorded|sessions|album|cd|released\b/.test(s)) return "recording";
  return "mention";
}

function hasSongContext(snippet, phrase) {
  // Only accept song-history language that sits right next to the phrase — a
  // distant "…record an album…" a sentence away must not vouch for a joke quote.
  const re = /\b(debut|first (?:played|recorded|performed|appear)|written|wrote|version|instrumental|this (?:song|tune)|the song|played live|set ?list|opener?|encore|jam|recorded|sessions|album|tune|lyrics|segue)\b/i;
  const i = phrase ? snippet.toLowerCase().indexOf(phrase.toLowerCase()) : -1;
  const window = i >= 0 ? snippet.slice(Math.max(0, i - 70), i + phrase.length + 90) : snippet;
  return re.test(window);
}

function looksLikeSongTitle(phrase) {
  if (phrase.length < 3 || phrase.length > 40) return false;
  if (/[.?!]$/.test(phrase)) return false;
  const words = phrase.split(/\s+/);
  if (words.length > 6) return false;
  // Mostly title-cased words.
  const capish = words.filter((w) => /^[A-Z0-9(]/.test(w)).length;
  return capish >= Math.ceil(words.length * 0.6);
}

// --- utilities ----------------------------------------------------------

function normalizeTitle(t) {
  return t
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(t) {
  return t
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCsvRow(row) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i += 1) {
    const c = row[i];
    if (c === '"') {
      if (inQ && row[i + 1] === '"') { cur += '"'; i += 1; }
      else inQ = !inQ;
    } else if (c === "," && !inQ) {
      out.push(cur); cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// These late-'90s/early-2000s pages are windows-1252, but node's fetch decodes
// as UTF-8, turning smart quotes/ellipses into U+FFFD. Decode as UTF-8 first,
// and only if that produced replacement chars fall back to windows-1252.
async function decodeBody(res) {
  const buf = new Uint8Array(await res.arrayBuffer());
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("windows-1252").decode(buf);
  } catch {
    return utf8;
  }
}

async function fetchWithRetry(url, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (res.status === 429 || res.status >= 500) throw new Error(`status ${res.status}`);
      return res;
    } catch (err) {
      if (i === attempts - 1) {
        console.warn(`  ! ${url} failed: ${err.message}`);
        return null;
      }
      await sleep(1200 * (i + 1));
    }
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await fn(items[i], i);
      await sleep(250);
    }
  });
  await Promise.all(workers);
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
