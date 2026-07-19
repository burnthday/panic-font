import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const year = args.year || process.env.TOUR_YEAR || String(new Date().getFullYear());
const input = args.in || path.join(root, "data", "source", `setlists-${year}.json`);
const output = args.out || input;
const requireAll = Boolean(args.requireAll || process.env.REQUIRE_SETLIST_TRANSITIONS === "1");
const statusFile = args.statusFile || "";

const archiveSearchBase = "https://archive.org/advancedsearch.php";
const archiveDetailsBase = "https://archive.org/details/";
const archiveMetadataBase = "https://archive.org/metadata/";
const retryableStatuses = new Set([429, 500, 502, 503, 504]);
const maxFetchAttempts = 4;

async function main() {
  const payload = JSON.parse(await readFile(input, "utf8"));
  const archiveDocs = await searchArchiveDocs(year);
  const docsByDate = groupArchiveDocsByDate(archiveDocs);

  let enriched = 0;
  let unchanged = 0;
  const misses = [];

  for (const show of payload.setlists || []) {
    const docs = docsByDate.get(show.isoDate) || [];
    if (!docs.length) {
      unchanged += 1;
      misses.push(`${show.isoDate} ${show.location}: no Archive recording found`);
      continue;
    }

    const result = await bestTransitionSource(show, docs);
    if (!result || !result.score.enrichable) {
      unchanged += 1;
      misses.push(`${show.isoDate} ${show.location}: no aligned Archive transitions`);
      continue;
    }

    applyTransitions(show, result);
    enriched += 1;
  }

  payload.transitionSource = {
    label: "Internet Archive Live Music Archive",
    sourceUrl: "https://archive.org/details/WidespreadPanic",
    importedAt: new Date().toISOString(),
    rule: "Official Widespread Panic setlist titles are retained; same-date Archive track metadata supplies only segue markers."
  };

  console.log(`Enriched ${enriched} ${year} setlists with Archive segue markers; ${unchanged} unchanged.`);
  if (misses.length) {
    console.log(`Unchanged shows:\n${misses.slice(0, 20).join("\n")}${misses.length > 20 ? `\n+${misses.length - 20} more` : ""}`);
  }
  if (statusFile) {
    await mkdir(path.dirname(statusFile), { recursive: true });
    await writeFile(statusFile, `${JSON.stringify({ year, ready: misses.length === 0, enriched, unchanged, misses }, null, 2)}\n`, "utf8");
  }
  if (requireAll && misses.length) {
    const error = new Error(`Refusing to write ${year} setlists because ${misses.length} show(s) are missing Archive transition markers.`);
    error.exitCode = 75;
    throw error;
  }

  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function searchArchiveDocs(targetYear) {
  const params = new URLSearchParams({
    q: `collection:(WidespreadPanic) AND date:[${targetYear}-01-01 TO ${targetYear}-12-31]`,
    output: "json",
    rows: "500",
    sort: "date asc"
  });

  for (const field of ["identifier", "title", "date", "description"]) {
    params.append("fl[]", field);
  }

  const payload = await fetchJson(`${archiveSearchBase}?${params}`);
  return payload.response?.docs || [];
}

function groupArchiveDocsByDate(docs) {
  const byDate = new Map();
  for (const doc of docs) {
    const isoDate = archiveDocDate(doc);
    if (!isoDate) continue;
    const list = byDate.get(isoDate) || [];
    list.push(doc);
    byDate.set(isoDate, list);
  }
  return byDate;
}

function archiveDocDate(doc) {
  const fromDate = String(doc.date || "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (fromDate) return fromDate;
  return String(doc.identifier || doc.title || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

async function bestTransitionSource(show, docs) {
  const candidates = [];

  for (const doc of docs) {
    try {
      const metadata = await fetchArchiveMetadata(doc.identifier);
      const parsed = parseArchiveSetlist(metadata);
      const score = scoreCandidate(show, parsed);
      candidates.push({ doc, metadata, parsed, score });
    } catch (error) {
      candidates.push({
        doc,
        metadata: null,
        parsed: { sets: [], tracks: [] },
        score: { enrichable: false, value: 0, reason: error.message }
      });
    }
  }

  candidates.sort((a, b) => b.score.value - a.score.value);
  return candidates[0] || null;
}

async function fetchArchiveMetadata(identifier) {
  if (!identifier) throw new Error("Archive document has no identifier");
  return fetchJson(`${archiveMetadataBase}${encodeURIComponent(identifier)}`);
}

async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= maxFetchAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        headers: { "user-agent": "Burnthday static-site transition importer" }
      });
    } catch (error) {
      lastError = error;
      if (attempt === maxFetchAttempts) throw error;
    }

    if (response?.ok) return response.json();
    if (response) {
      lastError = new Error(`${url} returned ${response.status} ${response.statusText}`);
      if (!retryableStatuses.has(response.status) || attempt === maxFetchAttempts) throw lastError;
    }

    const delayMs = 2 ** (attempt - 1) * 1_000;
    console.warn(`Archive request failed (attempt ${attempt}/${maxFetchAttempts}); retrying in ${delayMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw lastError;
}

function parseArchiveSetlist(metadata) {
  const descriptionSets = parseDescriptionSetlist(metadata.metadata?.description || "");
  const fileTracks = parseFileTracks(metadata.files || []);
  return {
    sets: descriptionSets.length ? descriptionSets : tracksToLooseSet(fileTracks),
    tracks: fileTracks
  };
}

function parseDescriptionSetlist(description) {
  const sets = [];
  let current = null;

  for (const rawLine of htmlishLines(description)) {
    const label = parseSetLabel(rawLine);
    if (label) {
      current = { label, tracks: [] };
      sets.push(current);
      continue;
    }

    const track = parseTrackTitle(rawLine);
    if (!track || !current) continue;
    current.tracks.push(track);
  }

  return sets.filter((set) => set.tracks.length);
}

function htmlishLines(value) {
  const text = String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|span)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtml(text)
    .replace(/\s+\b((?:set\s*)?(?:1|2|3)|(?:1st|2nd|3rd)\s+set|set\s+(?:one|two|three|i|ii|iii)|one\s+set|encore(?:s)?(?:\s*\d+)?|second\s+encore|2nd\s+encore)\s*:?(?=\s|$)/gi, "\n$1\n")
    .replace(/\s+(?=\d{2}[.)]\s+)/g, "\n")
    .replace(/\s+(?=\d{2}\s+[A-Z*/(/])/g, "\n")
    .split(/\n+/)
    .map((line) => decodeHtml(line.replace(/^(?:>|&gt;)+\s*/i, "")).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseSetLabel(value) {
  const line = cleanLine(value).replace(/^set\s+/i, "");
  if (/^one\s+set$/i.test(line)) return "1";
  if (/^(?:1|one|first|1st|i)\s*(?:set)?$/i.test(line)) return "1";
  if (/^(?:2|two|second|2nd|ii)\s*(?:set)?$/i.test(line)) return "2";
  if (/^(?:3|three|third|3rd|iii)\s*(?:set)?$/i.test(line)) return "3";
  if (/^(?:e|encore|encores|encore\s*1)$/i.test(line)) return "E";
  if (/^(?:e2|encore\s*2|second\s+encore|2nd\s+encore)$/i.test(line)) return "E2";
  if (/^(?:set\s*)?1$/i.test(line)) return "1";
  if (/^(?:set\s*)?2$/i.test(line)) return "2";
  return "";
}

function parseFileTracks(files) {
  const tracks = [];
  const seen = new Set();

  for (const file of files || []) {
    const title = cleanLine(file.title || "");
    const name = String(file.name || "");
    const mediaKey = name.replace(/\.(?:flac|mp3|wav|m4a|ogg|shn)$/i, "");
    if (!title || seen.has(mediaKey)) continue;
    if (!/\.(?:flac|mp3|wav|m4a|ogg|shn)$/i.test(name)) continue;

    const track = parseTrackTitle(title);
    if (track) {
      seen.add(mediaKey);
      tracks.push({ ...track, filename: name });
    }
  }

  return tracks;
}

function tracksToLooseSet(tracks) {
  return tracks.length ? [{ label: "", tracks }] : [];
}

function parseTrackTitle(value) {
  let title = cleanLine(value)
    .replace(/^\(?\d{1,2}\)?[\s.)-]+/, "")
    .replace(/^d\d+t\d+\s*[-.)]?\s*/i, "")
    .replace(/^s\d+t\d+\s*[-.)]?\s*/i, "")
    .replace(/^[/\\]+\s*/, "")
    .replace(/^[*#^@]+\s*/, "")
    .trim();

  if (!title || isNoiseTrack(title)) return null;

  const segue = /-?>\s*$/.test(title);
  title = title
    .replace(/-?>\s*$/, "")
    .replace(/\s*[*#^@]+\s*$/g, "")
    .replace(/\s+\[[^\]]+\]\s*$/g, "")
    .replace(/\s+\([^)]*(?:with|w\/|guest|false start|tease|rain delay|continued)[^)]*\)\s*$/i, "")
    .trim();

  if (!title || isNoiseTrack(title)) return null;
  return { title, segue };
}

function cleanLine(value) {
  return decodeHtml(String(value || ""))
    .replace(/[“”]/g, "\"")
    .replace(/[‘’`]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoiseTrack(title) {
  return /^(?:intro(?:\/tuning|\s+\d+)?|tuning|crowd|encore\s*break|banter|stage\s*banter|announcement|announcements|outro|pause|break|howdy(?:!!)?|(?:jb\s+greeting|greeting\s+by\s+jb)|good\s+evening|walk\s*on)$/i.test(cleanLine(title).replace(/[.!]+$/g, ""));
}

function scoreCandidate(show, parsed) {
  const officialSets = show.sets || [];
  const setScores = officialSets.map((officialSet) => {
    const candidates = candidateSetsForLabel(parsed.sets, officialSet.label);
    return bestSetScore(officialSet, candidates);
  });

  const matched = setScores.filter((score) => score.matched);
  const officialSongs = officialSets.reduce((count, set) => count + (set.songTitles || []).length, 0);
  const matchedSongs = matched.reduce((count, score) => count + score.matchedSongs, 0);
  const segues = matched.reduce((count, score) => count + score.segues, 0);
  const exactRatio = officialSongs ? matchedSongs / officialSongs : 0;
  const hasAllSets = matched.length === officialSets.length;
  const enrichable = hasAllSets && exactRatio >= 0.82 && segues > 0;

  return {
    enrichable,
    value: (enrichable ? 100000 : 0) + Math.round(exactRatio * 1000) + segues * 10 + matched.length,
    exactRatio,
    matchedSongs,
    officialSongs,
    segues,
    setScores
  };
}

function candidateSetsForLabel(sets, label) {
  const normalizedLabel = normalizeSetLabel(label);
  const exact = sets.filter((set) => normalizeSetLabel(set.label) === normalizedLabel);
  return exact.length ? exact : sets.filter((set) => !set.label);
}

function bestSetScore(officialSet, candidates) {
  const officialTitles = officialSet.songTitles || splitOfficialSongs(officialSet.songs);
  let best = { matched: false, matchedSongs: 0, segues: 0, tracks: [], transitions: [] };

  for (const candidate of candidates) {
    const alignment = alignTracks(officialTitles, candidate.tracks);
    const matchedSongs = alignment.filter(Boolean).length;
    const ratio = officialTitles.length ? matchedSongs / officialTitles.length : 0;
    const transitions = alignment.map((track) => Boolean(track?.segue));
    const segues = transitions.filter(Boolean).length;
    const matched = officialTitles.length > 0 && ratio >= 0.82;
    const value = (matched ? 10000 : 0) + Math.round(ratio * 1000) + segues * 10;

    if (value > (best.value || 0)) {
      best = { matched, value, matchedSongs, segues, tracks: alignment, transitions };
    }
  }

  return best;
}

function alignTracks(officialTitles, archiveTracks) {
  const used = new Set();
  return officialTitles.map((title, index) => {
    const preferred = archiveTracks[index];
    if (preferred && titleMatches(title, preferred.title) && !used.has(index)) {
      used.add(index);
      return preferred;
    }

    for (let offset = 1; offset <= 2; offset += 1) {
      for (const candidateIndex of [index - offset, index + offset]) {
        const candidate = archiveTracks[candidateIndex];
        if (candidate && !used.has(candidateIndex) && titleMatches(title, candidate.title)) {
          used.add(candidateIndex);
          return candidate;
        }
      }
    }

    for (let candidateIndex = 0; candidateIndex < archiveTracks.length; candidateIndex += 1) {
      const candidate = archiveTracks[candidateIndex];
      if (candidate && !used.has(candidateIndex) && titleMatches(title, candidate.title)) {
        used.add(candidateIndex);
        return candidate;
      }
    }

    return null;
  });
}

function applyTransitions(show, result) {
  const sourceUrl = `${archiveDetailsBase}${encodeURIComponent(result.doc.identifier)}`;

  show.transitionSourceUrl = sourceUrl;
  show.transitionSourceTitle = result.metadata?.metadata?.title || result.doc.title || "";

  for (let index = 0; index < (show.sets || []).length; index += 1) {
    const set = show.sets[index];
    const score = result.score.setScores[index];
    if (!score?.matched) continue;

    const titles = set.songTitles || splitOfficialSongs(set.songs);
    set.songs = renderSegueSongs(titles, score.transitions);
  }
}

function renderSegueSongs(titles, transitions) {
  let output = "";
  for (let index = 0; index < titles.length; index += 1) {
    output += titles[index];
    if (index === titles.length - 1) continue;
    output += transitions[index] ? " > " : ", ";
  }
  return output;
}

function splitOfficialSongs(value) {
  return String(value || "")
    .split(/\s*>\s*|\s*,\s*/)
    .map((song) => cleanLine(song))
    .filter(Boolean);
}

function titleMatches(official, archiveTitle) {
  return songKey(official) === songKey(archiveTitle);
}

function songKey(value) {
  const cleaned = cleanLine(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(the)\b/gi, "")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  return songAliases[cleaned] || cleaned;
}

const songAliases = {
  aintlifegrand: "aintlifegrand",
  anditstoneme: "anditstonedme",
  andstonedme: "anditstonedme",
  beargonefishin: "bearsgonefishin",
  beargonefishing: "bearsgonefishin",
  bearsgonefishing: "bearsgonefishin",
  bowlleggedwoman: "bowleggedwomanknockkneedman",
  bowlleggedwomanknockkneedman: "bowleggedwomanknockkneedman",
  bowleggedwoman: "bowleggedwomanknockkneedman",
  fishin: "fishing",
  givin: "giving",
  guildedsplinters: "iwalkonguildedsplinters",
  heros: "heroes",
  holdensoversoul: "holdenoversoul",
  hopeonahopelessworld: "hopeinahopelessworld",
  keepmeinyourheartforawhile: "keepmeinyourheart",
  pickingupthepieces: "pickinupthepieces",
  lowparkofhighheeledboys: "lowsparkofhighheeledboys",
  lowparkofhighheelboys: "lowsparkofhighheeledboys",
  lowsparkofhighheelboys: "lowsparkofhighheeledboys",
  partyatyourmamashouse: "partyatyourmamashouse",
  partyatyomamashouse: "partyatyourmamashouse",
  provinround: "provingground",
  provinground: "provingground",
  proteindrink: "proteindrink",
  proteendrink: "proteindrink",
  redhotmomma: "redhotmama",
  stopbreakindown: "stopbreakindownblues",
  stopgo: "stopgo",
  stoneme: "anditstonedme",
  thatthang: "partyatyourmamashouse",
  drivinsong: "drivingsong",
  walkin: "walkinforyourlove",
  walkineachotherhome: "wewalkeachotherhome",
  walkeachotherhome: "wewalkeachotherhome",
  wonderin: "wondering"
};

function normalizeSetLabel(label) {
  return String(label || "").toUpperCase().replace(/^ENCORE$/, "E").replace(/^SECOND ENCORE$/, "E2");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, "\"")
    .replace(/&#8221;/g, "\"")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--year") parsed.year = values[++index];
    else if (value === "--in") parsed.in = values[++index];
    else if (value === "--out") parsed.out = values[++index];
    else if (value === "--status-file") parsed.statusFile = values[++index];
    else if (value === "--require-all") parsed.requireAll = true;
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exit(error.exitCode || 1);
});
