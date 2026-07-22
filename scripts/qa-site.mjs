import { createHash } from "node:crypto";
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
  checkTourStats(homeHtml, siteData);
  checkShelfWatch(homeHtml, siteData);
  checkNickJohnsonFeature(homeHtml, siteData);
  checkTourDates(homeHtml, siteData);
  await checkMobileTourDateCss();
  await checkSetlistImageOrientation(siteData);
  await checkLatestSetlist(homeHtml, siteData);
  checkGuestAnnotations(homeHtml, review2025Html);
  checkNavigation(homeHtml, siteData);
  await checkSongPages(siteData);
  await checkSongLearnBlock(siteData);
  await checkBestGuessSection(siteData);
  await checkLegacyPages(siteData);
  await checkProsePlate(allHtmlFiles, allHtml);
  await checkSongOrigins(allHtmlFiles, allHtml, siteData);
  await checkLyricsChords(allHtmlFiles, allHtml, siteData);
  checkEyebrowAudit(allHtmlFiles, allHtml);
  await checkTourInReviewPages();
  await checkArchiveIndex();
  await checkArchivalDecorations();
  await checkBandFaqPage();
  await checkPredictionLayer(siteData);
  await checkMusicLayer(allHtmlFiles, allHtml);
  await checkCommandPalette(allHtmlFiles, allHtml, siteData);
  await checkLaminateRim();
  await checkSocialCard(homeHtml);
  await checkLocalAssets(allHtml);
  await checkStylesheetCacheBusting(allHtmlFiles, allHtml);
  await checkTastePassRound(homeHtml, siteData, allHtmlFiles, allHtml);

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
  const bowleggedOffenders = [];
  const jamaisVuOffenders = [];
  for (let index = 0; index < files.length; index += 1) {
    if (/Bowlegged Woman,\s*Knock-Kneed Man/i.test(htmlByFile[index])) {
      bowleggedOffenders.push(path.relative(root, files[index]));
    }
    if (/Jamais Vu\s*\(The World Has Changed\)/i.test(htmlByFile[index])) {
      jamaisVuOffenders.push(path.relative(root, files[index]));
    }
  }
  record(
    "Generated HTML uses canonical Bowlegged Woman title",
    bowleggedOffenders.length === 0,
    bowleggedOffenders.slice(0, 10).join("\n")
  );
  record(
    "Generated HTML uses canonical Jamais Vu title",
    jamaisVuOffenders.length === 0,
    jamaisVuOffenders.slice(0, 10).join("\n")
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
  assertIncludes(html, `<h1 class="sr-only">WIDESPREAD PANIC ${siteData.site.year} TOUR</h1>`, "Homepage keeps the tour title for assistive tech");
  for (const anchor of ["song-list", "tour-stats", "shelf", "purgatory", "nick-johnson", "setlists"]) assertIncludes(html, `id="${anchor}"`, `Homepage keeps the #${anchor} section anchor`);
  assertIncludes(html, '<section class="latest-setlist" id="latest-setlist">', "Homepage has top-of-page setlist section");
  assertIncludes(html, '<section class="laminate primary-board" id="song-list">', "Homepage has song-list laminate");
  const boardTitle = [siteData.site?.boardShow?.location, siteData.site?.boardShow?.runLabel].filter(Boolean).join(" ").toUpperCase();
  assertIncludes(html, `<h1>${escapeHtml(boardTitle)}</h1>`, `Song List title matches board show: ${boardTitle}`);

  record("Current tour-stop setlists appear above Song List", indexOf(html, 'id="latest-setlist"') < indexOf(html, 'id="song-list"'));
  record("Sheet key bento sits directly below the Song List", indexOf(html, 'id="song-list"') < indexOf(html, 'id="sheet-key"') && indexOf(html, 'id="sheet-key"') < indexOf(html, 'id="tour-stats"'));
  record("Shelf, Purgatory, and Woodshed bentos share the sheet-key grid below the Song List", indexOf(html, 'id="sheet-key"') < indexOf(html, 'id="shelf"') && indexOf(html, 'id="shelf"') < indexOf(html, 'id="purgatory"') && indexOf(html, 'id="purgatory"') < indexOf(html, 'id="woodshed"') && indexOf(html, 'id="woodshed"') < indexOf(html, 'id="tour-stats"'));
  record("Shelf Watch appears below Tour Stats", indexOf(html, 'id="tour-stats"') < indexOf(html, 'id="shelf-watch"'));
  record("Nick Stats appears below Shelf Watch", indexOf(html, 'id="shelf-watch"') < indexOf(html, 'id="nick-johnson"'));
  record("Older setlists appear below Nick Stats", indexOf(html, 'id="nick-johnson"') < indexOf(html, 'id="setlists"'));

  record("Unique-song total matches the current-tour ledger", siteData.totals?.currentTourSongs === siteData.currentTour?.length);
  record("Tour-play total matches per-song counts", siteData.totals?.currentTourPlays === sum(siteData.currentTour?.map((song) => song.tourCount)));
  record("Shows-played total matches posted setlists", siteData.totals?.postedSetlists === siteData.setlists?.length);
  record("Tour-date total matches the official schedule", siteData.totals?.tourDates === siteData.tourDates?.length);
  const ledger = sectionHtml(html, "song-list");
  record("Song List laminate contains no website-stat ledger", !ledger.includes("board-ledger") && !ledger.includes("songs per show"));

  assertIncludes(html, "Tiny Number", "Sheet key explains Tiny Number");
  assertIncludes(html, "Times played this tour", "Sheet key says tiny numbers are times played this tour");
  assertIncludes(html, "The Woodshed", "Sheet key includes The Woodshed");
  assertIncludes(html, "not yet played with Nick Johnson", "The Woodshed explains Nick Johnson logic");
  record("The Woodshed laminate omits the redundant explanatory count", !sectionHtml(html, "woodshed-sheet").includes("songs not yet played with Nick Johnson"));
  checkMarkerLegend(html, siteData);

  assertCurrentTourSong(html, siteData, "Just Kissed My Baby", "Song List add-on keeps its tour count and play date");
  assertSongHtml(html, "JUST KISSED MY BABY", ["<sup>165</sup>", "05/01/16"], "Shelf bustout keeps prior last-played date");
  assertCurrentTourSong(html, siteData, "Low Rider", "Song List Low Rider keeps its tour count and current-tour date");
  assertSongHtml(html, "LOW RIDER", ["<sup>157</sup>", "11/04/09"], "Shelf Low Rider keeps prior last-played date");
  assertCurrentTourSong(html, siteData, "Room at the Top", "Song List Room At The Top keeps its tour count and current-tour date");
  assertSongHtml(html, "ROOM AT THE TOP", ["<sup>2</sup>", "03/24/24"], "Purgatory Room At The Top keeps prior last-played date");
  assertCurrentTourSong(html, siteData, "Free Somehow", "Song List Free Somehow shows its current tour count", { requireDate: false });
}

function checkTourStats(html, siteData) {
  const feature = sectionHtml(html, "tour-stats");
  const shows = siteData.totals.postedSetlists;
  const plays = siteData.totals.currentTourPlays;
  const songs = (siteData.catalog || [])
    .filter((song) => song.playedThisTour && song.tourCount > 0)
    .sort((left, right) => right.tourCount - left.tourCount || left.title.localeCompare(right.title));
  const average = shows ? (plays / shows).toFixed(1) : "0";

  assertIncludes(feature, "<h2>TOUR STATS</h2>", "Homepage has a separate Tour Stats section");
  for (const [value, label] of [
    [shows, "shows played"],
    [songs.length, "unique songs"],
    [plays, "song plays"],
    [average, "songs per show"]
  ]) assertIncludes(feature, `<strong>${value}</strong><span>${label}</span>`, `Tour Stats reports ${label}`);

  for (const key of ["title", "count", "rarity", "heat", "last"]) {
    assertIncludes(feature, `data-sort="${key}"`, `Tour Stats supports sorting by ${key}`);
  }
  assertIncludes(feature, "WHAT THESE MEAN", "Tour Stats explains its plain-language signals");
  assertIncludes(feature, "Rarity", "Tour Stats labels rarity directly");
  assertIncludes(feature, "Hyper Rare", "Tour Stats explains the game-like rarity ladder");
  assertIncludes(feature, '<span class="rarity-symbol" aria-hidden="true"><svg', "Tour Stats renders card-style rarity symbols as inline SVG");
  assertIncludes(feature, "Last / usual gap", "Tour Stats labels timing with plain numbers");
  assertNotIncludes(feature, "In rotation", "Tour Stats avoids the ambiguous In rotation rarity label");
  assertNotIncludes(feature, "Rotation timing", "Tour Stats avoids the ambiguous Rotation timing label");
  assertIncludes(feature, "It is context, not a prediction", "Timing is not presented as predictive odds");
  assertIncludes(feature, "data-show-filter", "Tour Stats can highlight songs from one selected show");
  assertIncludes(feature, "data-mobile-sort", "Tour Stats has a dedicated mobile sort control");
  for (const type of ["all", "original", "cover"]) assertIncludes(feature, `data-type-filter="${type}"`, `Tour Stats includes the ${type} type filter`);
  assertIncludes(feature, "data-rarity-filter", "Tour Stats offers a multi-select rarity filter");
  record("Rarity filter lists every tier present in the table", [...new Set([...feature.matchAll(/data-rarity-tier="([^"]+)"/g)].map((match) => match[1]))].every((tier) => feature.includes(`<input type="checkbox" value="${tier}" data-rarity-option>`)));
  const rendered = [...feature.matchAll(/<tr data-title="([^"]+)" data-count="(\d+)" data-frequency="(\d+)" data-l100="(\d+)" data-rarity="(\d+)" data-rarity-tier="([^"]+)" data-heat="(\d+)" data-last="([^"]*)" data-type="([^"]+)" data-shows="([^"]*)">/g)]
    .map((match) => ({ title: decodeHtml(match[1]), count: Number(match[2]) }));
  record("Tour Stats includes every played song exactly once", rendered.length === songs.length, `${rendered.length} rendered vs ${songs.length} expected`);
  record("Tour Stats defaults to most played with alphabetical tie-breaking", arraysEqual(rendered.map((song) => song.title), songs.map((song) => song.title.toLowerCase())));
  record("Tour Stats play counts match the ledger", rendered.every((song, index) => song.count === songs[index].tourCount));
  record("Tour Stats does not report scheduled tour dates", !feature.includes("tour dates"));
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

function checkShelfWatch(html, siteData) {
  const cutoff = Number(siteData.rules?.rotationSlpLimit) || 200;
  const window = Number(siteData.rules?.shelfWatchWindow) || 50;
  const limit = Number(siteData.rules?.shelfWatchLimit) || 6;
  const expected = (siteData.catalog || [])
    .filter((song) => song.total > 1
      && !song.playedThisTour
      && song.effectiveSlp >= cutoff - window
      && song.effectiveSlp < cutoff)
    .sort((left, right) => right.effectiveSlp - left.effectiveSlp || left.title.localeCompare(right.title))
    .slice(0, limit);
  const actual = siteData.boards?.shelfWatch || [];
  const feature = sectionHtml(html, "shelf-watch");

  assertIncludes(feature, "<h2>SHELF WATCH</h2>", "Homepage has Shelf Watch");
  record(
    "Shelf Watch is derived from the closest eligible SLP values",
    arraysEqual(actual.map((song) => song.title), expected.map((song) => song.title)),
    actual.map((song) => `${song.title}: ${song.effectiveSlp}`).join("\n")
  );
  record(
    "Shelf Watch excludes played, one-time, and already-shelved songs",
    actual.every((song) => song.total > 1 && !song.playedThisTour && song.effectiveSlp < cutoff),
    actual.filter((song) => song.total <= 1 || song.playedThisTour || song.effectiveSlp >= cutoff).map((song) => song.title).join("\n")
  );

  for (const song of expected) {
    const remaining = cutoff - song.effectiveSlp;
    assertIncludes(feature, `data-song-title="${escapeAttribute(song.title)}" data-slp="${song.effectiveSlp}"`, `Shelf Watch includes ${song.title} at ${song.effectiveSlp} SLP`);
    assertIncludes(feature, `LAST ${song.lastDisplay}`, `Shelf Watch gives ${song.title}'s last-played date`);
    const rowStart = feature.indexOf(`data-song-title="${escapeAttribute(song.title)}"`);
    const rowEnd = (() => { const next = feature.indexOf('<div class="shelf-card', rowStart + 1); return next >= 0 ? next : feature.length; })();
    const row = rowStart >= 0 && rowEnd > rowStart ? feature.slice(rowStart, rowEnd) : "";
    assertIncludes(row, `<p class="n">${remaining}</p>`, `Shelf Watch gives ${song.title}'s distance to Shelf`);
  }
}

function checkNickJohnsonFeature(html, siteData) {
  const feature = sectionHtml(html, "nick-johnson");
  const played = (siteData.catalog || [])
    .filter((song) => song.playedWithNick && song.nickCount > 0)
    .sort((left, right) => right.nickCount - left.nickCount || left.title.localeCompare(right.title));
  const rotation = (siteData.catalog || [])
    .filter((song) => song.effectiveSlp < siteData.rules.rotationSlpLimit || song.playedThisTour)
    .sort((left, right) => right.nickCount - left.nickCount || left.title.localeCompare(right.title));
  const nickShows = (siteData.setlists || []).filter((show) => (show.notes || []).some((note) => /\bnick johnson\b/i.test(note) && /\bguitar\b/i.test(note))).length;
  const nickPlays = sum(played.map((song) => song.nickCount));
  const woodshed = [...(siteData.boards?.woodshedOriginals || []), ...(siteData.boards?.woodshedCovers || [])];

  assertIncludes(feature, "<h2>NICK STATS</h2>", "Homepage has the restrained Nick Stats feature");
  assertIncludes(feature, '<details class="nick-disclosure" open>', "Nick Stats uses one desktop-open disclosure");
  for (const [value, label] of [
    [nickShows, "shows on guitar"],
    [played.length, "unique songs"],
    [nickPlays, "song plays"],
    [woodshed.length, "still in The Woodshed"]
  ]) {
    assertIncludes(feature, `<strong>${value}</strong><span>${label}</span>`, `Nick Johnson summary reports ${label}`);
  }

  assertIncludes(feature, "<h3>MOST PLAYED WITH NICK</h3>", "Nick Johnson feature presents a ranked most-played view");
  const completion = Math.round((played.length / rotation.length) * 100);
  assertIncludes(feature, `<strong>${completion}%</strong><span>of current Song Possibilities played with Nick</span>`, "Nick Johnson feature shows rotation completion");
  assertIncludes(feature, 'class="is-original"', "Nick completion bar separates played originals");
  assertIncludes(feature, 'class="is-cover"', "Nick completion bar separates played covers");
  assertIncludes(feature, `${played.length}/${rotation.length} overall`, "Nick completion bar gives the exact overall count");
  record("Nick Johnson feature is not another laminated song sheet", !feature.includes("nick-played-sheet") && !feature.includes("song-panel"));
  const renderedRanking = [...feature.matchAll(/data-song-title="([^"]+)" data-nick-count="(\d+)"/g)]
    .map((match) => ({ title: decodeHtml(match[1]), count: Number(match[2]) }));
  record(
    "Nick Johnson songs are ranked by plays with alphabetical tie-breaking",
    arraysEqual(renderedRanking.map((song) => song.title), rotation.map((song) => song.title)),
    renderedRanking.slice(0, 20).map((song) => `${song.title}: ${song.count}`).join("\n")
  );
  record(
    "Every Nick Johnson song keeps its per-show play count",
    renderedRanking.length === rotation.length && renderedRanking.every((song, index) => song.count === rotation[index].nickCount),
    `${renderedRanking.length} rendered vs ${rotation.length} expected`
  );
  record("Nick Johnson ranking includes zero-play rotation songs at the bottom", renderedRanking.some((song) => song.count === 0) && renderedRanking.slice(-1)[0]?.count === 0);
  record("The Woodshed contains only songs not yet played with Nick", woodshed.every((song) => !song.playedWithNick), woodshed.filter((song) => song.playedWithNick).map((song) => song.title).join("\n"));
}

// ── Taste-pass round guards ──────────────────────────────────────────────────
// Structural checks so the owner-reported fixes cannot silently revert again.
async function checkTastePassRound(homeHtml, siteData, allHtmlFiles, allHtml) {
  const sl = await readText("dist/stagelight.css").catch(() => "");

  // (1) Popup z-order: a sheet overlay must sit above the sticky header. The
  // header is hidden while a bento sheet is open (bento-open body class).
  record("Bento sheet hides the sticky header while open (popup above nav)",
    /\.bento-open\s+\.site-head\s*\{[^}]*visibility:\s*hidden/.test(sl));
  record("Bento sheet open toggles the bento-open body class",
    homeHtml.includes('classList.add("bento-open")') && homeHtml.includes('classList.remove("bento-open")'));

  // (2) Round-4 features present and wired (accordion, custom show dropdown,
  // stable sort state) — the three the owner reported reverted.
  record("Tour Stats stays a collapsible accordion", homeHtml.includes('class="stats-disclosure"'));
  record("Highlight-a-show stays the custom dark dropdown", homeHtml.includes("data-show-filter-dd") && homeHtml.includes('class="sf-option is-active"'));
  record("Custom show dropdown highlights the selected option when open", /sf-option[^"]*is-active/.test(homeHtml) && homeHtml.includes('classList.toggle("is-active"'));
  record("Tour Stats sort order is tracked as stable state (no reorder on filter)", homeHtml.includes("applyState") && homeHtml.includes("compareRows") && !homeHtml.includes("applyFilters"));

  // (3) Tonight's Odds — the dataset has a show today (07/21 Sacramento).
  record("Dataset has a show today (Tonight's Odds precondition)", Boolean(siteData.site?.isShowDayPreview));
  record("Tonight's Odds data is computed when a show is today", Boolean(siteData.tonightOdds && siteData.tonightOdds.songs?.length));
  record("Tonight's Odds panel is present on the homepage", homeHtml.includes('class="tonight-odds"') && homeHtml.includes("data-tonight-toggle"));
  record("Tonight's Odds carries its entertainment disclaimer", homeHtml.includes("This is just math having fun"));
  record("Tonight's Odds lists ranked songs with heat + tier", (homeHtml.match(/class="tn-row/g) || []).length >= 10);

  // (4) Bottom cross-promo band replaced the stray Get Tickets pill.
  record("Bottom cross-promo band is present", homeHtml.includes('class="cross-promo"') && (homeHtml.match(/class="xp-card/g) || []).length === 2);
  record("Stray standalone Get Tickets pill is gone from the homepage body", !homeHtml.includes('class="ticket-link"'));

  // (5) One dropdown look sitewide — no native <select> on stagelight pages.
  const stagelightSelectPages = allHtmlFiles.filter((file, i) => allHtml[i].includes('class="stagelight"') && allHtml[i].includes("<select"));
  record("No native <select> remains on any Stagelight page", stagelightSelectPages.length === 0, stagelightSelectPages.map((f) => f.replace(distDir, "")).join("\n"));

  // (6) Cross-document view transitions declared + header persistence.
  record("Cross-document View Transitions are declared", /@view-transition\s*\{[^}]*navigation:\s*auto/.test(sl));
  record("Header persists across navigations (view-transition-name)", /view-transition-name:\s*site-header/.test(sl));
  record("View transitions respect prefers-reduced-motion", /prefers-reduced-motion[^}]*view-transition-old\(root\)/s.test(sl) || /view-transition-old\(root\)[^}]*\}\s*\}/.test(sl) && /prefers-reduced-motion/.test(sl));

  // (9) Chords dual-links resolve to real dist files.
  const hub = await readText("dist/lyrics-chords/index.html").catch(() => "");
  const tabHrefs = [...hub.matchAll(/class="lr-tab-chip" href="([^"]+)"/g)].map((m) => m[1]);
  const missingTab = [];
  for (const href of tabHrefs) {
    const ok = await stat(distDir + href).then(() => true).catch(() => false);
    if (!ok) missingTab.push(href);
  }
  record("Lyrics hub renders Tab chips for sibling guitar-tab pages", tabHrefs.length > 0);
  record("Every Tab chip resolves to a real dist page", missingTab.length === 0, missingTab.join("\n"));
}

function checkTourDates(html, siteData) {
  const feature = sectionHtml(html, "tour-dates");
  const upcoming = siteData.tourDates.filter((date) => !date.isPosted).length;
  assertIncludes(feature, `${upcoming} shows ahead`, "Upcoming block summarizes the remaining schedule");
  record("Upcoming block lists every unplayed show once", (feature.match(/<li class="is-upcoming">/g) || []).length === upcoming);
  record("Upcoming block gives every row a clear status", (feature.match(/<em class="up-flag">Upcoming<\/em>/g) || []).length === upcoming);
  record("Upcoming block omits already-posted shows", !feature.includes('<li class="is-posted">') && !feature.includes("Setlist posted"));
  record("Upcoming shows sit inside the Setlists section, below the archive", indexOf(html, 'id="setlists"') < indexOf(html, 'id="tour-dates"') && indexOf(html, '<details class="setlist-archive-panel"') < indexOf(html, 'id="tour-dates"'));
}

async function checkMobileTourDateCss() {
  const styles = await readText("dist/styles.css");
  record(
    "Mobile Tour Dates reserve intrinsic width for the full date",
    /\.tour-dates li\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\);/s.test(styles)
  );
  record(
    "Mobile Tour Date status stays below the venue",
    /\.tour-dates li em\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*3;/s.test(styles)
  );
}

async function checkSetlistImageOrientation(siteData) {
  const failures = [];
  for (const show of siteData.setlists || []) {
    if (!show.image) continue;
    if (!show.image.startsWith("/assets/setlists/")) {
      failures.push(`${show.isoDate}: remote image`);
      continue;
    }
    const filename = path.join(distDir, show.image.replace(/^\//, ""));
    try {
      const dimensions = jpegDimensions(await readFile(filename));
      if (!dimensions || dimensions.width < dimensions.height) {
        failures.push(`${show.isoDate}: ${dimensions ? `${dimensions.width}x${dimensions.height}` : "unreadable"}`);
      }
    } catch {
      failures.push(`${show.isoDate}: missing`);
    }
  }
  record("Every posted 2026 setlist uses a local landscape source image", failures.length === 0, failures.join("\n"));
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return null;
}

async function checkLatestSetlist(html, siteData) {
  const featured = sectionHtml(html, "latest-setlist");
  const featuredShow = siteData.site?.featuredShow || siteData.setlists?.[0];
  const latestShow = siteData.setlists?.[0];
  const heading = `${featuredShow?.date || ""} ${featuredShow?.venue || ""}, ${featuredShow?.location || ""}`;
  if (!siteData.site?.isShowDayPreview) {
    assertIncludes(featured, `datetime="${featuredShow?.isoDate || ""}"`, "Featured-show date matches generated site data");
    assertIncludes(featured, `<h3>${escapeHtml(featuredShow?.location || "")}</h3>`, "Featured-show location matches generated site data");
    assertIncludes(featured, `<p>${escapeHtml(featuredShow?.venue || "")}</p>`, "Featured-show venue matches generated site data");
  }

  const featuredCard = featured.split('<div class="current-stop-setlists">')[0];
  const renderedLabels = [...featuredCard.matchAll(/<div class="sc-row"><span class="sc-label">([^<]+)<\/span><p class="sc-prose">/g)].map((match) => decodeHtml(match[1]));
  if (siteData.site?.isShowDayPreview) {
    record("Show-day setlists have no redundant section label or black rule", !featured.includes("CURRENT TOUR STOP") && !featured.includes('class="section-heading"'));
    const stripStart = featured.indexOf('<details class="next-strip');
    const strip = stripStart >= 0 ? featured.slice(stripStart, featured.indexOf("</details>", stripStart) + "</details>".length) : "";
    record("Tonight appears as a closed strip after the latest run", strip.includes(`datetime="${featuredShow?.isoDate || ""}"`), featuredShow?.isoDate || "");
    record("Tonight's strip has no set rows until songs post", strip.length > 0 && !strip.includes('class="sc-label"'));
    assertIncludes(strip, ">Show Details</a>", "Tonight links to show details");
    record("Homepage contains no Twitch links", !html.includes("twitch.tv") && !html.includes("Twitch"));
    record("Tonight does not advertise a post-show Nugs archive", !strip.includes("Listen at Nugs.net"));
    record("First-visit preview uses its configured venue image", !featuredShow?.image || strip.includes(`src="${escapeHtml(featuredShow.image)}"`), featuredShow?.image || "");
    const completedHeading = `${latestShow?.date || ""} ${latestShow?.venue || ""}, ${latestShow?.location || ""}`;
    record("Latest posted show leads the page on show day", Boolean(cardHtml(featured, escapeHtml(completedHeading))), completedHeading);
    const archiveNow = sectionHtml(html, "setlists");
    record("Latest posted run is not duplicated in the archive", !cardHtml(archiveNow, escapeHtml(completedHeading)), completedHeading);
  } else {
    record(
      "Completed featured setlist has no redundant section label or black rule",
      !featured.includes("LATEST SETLIST") && !featured.includes("CURRENT TOUR STOP") && !featured.includes('class="section-heading"')
    );
    const sourceSegueCount = sum((latestShow?.sets || []).map((set) => (set.songs.match(/\s>\s/g) || []).length));
    const renderedSegueCount = (featured.match(/&gt;/g) || []).length;
    record("Latest setlist preserves every source segue", sourceSegueCount > 0 && renderedSegueCount >= sourceSegueCount, `source=${sourceSegueCount} rendered=${renderedSegueCount}`);

    const sourceLabels = (latestShow?.sets || []).map((set) => set.label === "1" ? "Set 1" : set.label === "2" ? "Set 2" : /^E$/i.test(set.label) ? "Encore" : set.label);
    record("Latest setlist renders one line for every set", arraysEqual(renderedLabels, sourceLabels), `${renderedLabels.join(", ")} vs ${sourceLabels.join(", ")}`);
    const archive = sectionHtml(html, "setlists");
    for (const isoDate of siteData.site?.featuredRunDates || []) {
      const runShow = siteData.setlists.find((show) => show.isoDate === isoDate);
      const runHeading = `${runShow?.date || ""} ${runShow?.venue || ""}, ${runShow?.location || ""}`;
      record(`Featured run includes ${isoDate}`, Boolean(cardHtml(featured, escapeHtml(runHeading))), runHeading);
      record(`Featured run does not duplicate ${isoDate}`, !cardHtml(archive, escapeHtml(runHeading)), runHeading);
    }
  }

  const styles = await readText("dist/styles.css");
  const imageRule = styles.match(/\.setlist-image img\s*\{([^}]*)\}/)?.[1] || "";
  record("Setlist photography preserves its natural landscape frame", /height:\s*auto;/.test(imageRule) && /object-fit:\s*contain;/.test(imageRule) && !/object-fit:\s*cover;|aspect-ratio:/.test(imageRule));
  record("Setlist entries are unframed", /\.setlist-card\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/.test(styles));
  const archive = sectionHtml(html, "setlists");
  assertIncludes(archive, '<details class="setlist-archive-panel" open>', "Older setlists remain visible on desktop");
  assertIncludes(archive, "VIEW OLDER SETLISTS", "Older setlists have one clear mobile disclosure");
  assertIncludes(archive, 'class="setlist-list"', "Older shows use the compact show-index layout");
  assertIncludes(archive, 'aria-label="Listen to', "Shows with audio expose a simple listening action");
  record("Every archived show is individually expandable", (archive.match(/<details class="show-entry[^"]*"/g) || []).length === siteData.setlists.length - (siteData.site.featuredRunDates || []).filter((date) => siteData.setlists.some((show) => show.isoDate === date)).length);
  assertIncludes(html, 'row.classList.toggle("is-selected-show"', "Selected-show songs receive a dedicated highlight state");
  assertIncludes(html, 'rightSelected - leftSelected', "Selected-show songs move ahead of the remaining tour table");
  record("Mobile initialization collapses Nick Stats, Tour Stats, and the older setlist archive", html.includes('.nick-disclosure, .stats-disclosure, .setlist-archive-panel").forEach((panel) => panel.removeAttribute("open"))'));
  record("Mobile initialization leaves every laminated sheet expanded", !html.includes('.song-panel:not(:first-of-type)') && !html.includes('.shelf-board .song-panel') && !html.includes('.purgatory-board .song-panel') && !html.includes('.woodshed-board .song-panel'));

  const bendHeading = "07/11/2026 Hayden Homes Amphitheater, Bend, OR";
  const bend = featured.includes(bendHeading) ? featured : cardHtml(html, bendHeading);
  assertIncludes(bend, 'Chainsaw City<sup class="guest-sup">1</sup>', "Steve Lopez is a guest superscript on Chainsaw City");
  assertIncludes(bend, '<sup class="guest-sup">1</sup> with Steve Lopez on percussion', "Steve Lopez guest note is keyed to the superscript");
  assertIncludes(bend, "[Entire show with Nick Johnson on guitar]", "Nick Johnson full-show note stays bracketed");
  record("Steve Lopez is not inside bracket notes", !/\[[^\]]*Steve Lopez[^\]]*\]/i.test(stripTags(bend)));
  record("No asterisk guest notation remains on the Bend setlist", !/\*\s*with Steve Lopez/i.test(stripTags(bend)));

  const oakland = cardHtml(html, "07/16/2026 Fox Theater, Oakland, CA");
  assertIncludes(oakland, "Airplane &gt; Rebirtha &gt; Space Wrangler", "Oakland I preserves the opening segues");
  assertIncludes(oakland, "Gradle &gt; You Got Yours &gt; Lawyers Guns And Money", "Oakland I preserves the first-set closing segues");
  assertIncludes(oakland, "Mercy &gt; Good Morning Little School Girl &gt; King Baby &gt; Fishwater", "Oakland I preserves the second-set closing segues");
  assertIncludes(oakland, "[Entire show with Nick Johnson on guitar; Last &#39;Time Zones&#39; - 12/30/23, 84 shows]", "Oakland I combines the Nick and LTP notes in one bracket");
}

function checkGuestAnnotations(homeHtml, review2025Html) {
  const bracketLines = [homeHtml, review2025Html]
    .flatMap((html) => [...html.matchAll(/<p class="notes">([\s\S]*?)<\/p>/g)])
    .map((match) => stripTags(match[1]));
  const malformedBracketLines = bracketLines.filter((line) => (line.match(/\[/g) || []).length !== 1 || (line.match(/\]/g) || []).length !== 1);
  record("Every setlist note line uses one bracket pair", malformedBracketLines.length === 0, malformedBracketLines.join("\n"));
  const misorderedNickLines = bracketLines.filter((line) => /Nick Johnson/i.test(line) && !/^\s*\[Entire show with Nick Johnson on guitar(?:;|\])/i.test(line));
  record("Nick Johnson note always leads the bracketed note line", misorderedNickLines.length === 0, misorderedNickLines.join("\n"));

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

async function checkSongPages(siteData) {
  const catalog = siteData.catalog || [];
  const index = await readText("dist/songs/index.html").catch(() => "");
  record("Song Index page is generated", index.length > 0);
  assertIncludes(index, 'id="song-search"', "Song Index carries the client-side search box");
  const rowCount = (index.match(/class="song-row"/g) || []).length;
  record("Song Index lists every catalog song once", rowCount === catalog.length, `${rowCount} rows vs ${catalog.length} songs`);
  assertIncludes(index, `${catalog.length.toLocaleString("en-US")} songs`, "Song Index reports the full catalog count");

  // Client-side multi-select filters (Type / This tour / Has Best Guess) compose
  // with the search box. The controls are real buttons and the rows carry the
  // data-* attributes those filters read.
  assertIncludes(index, 'class="index-toolbar"', "Song Index exposes the filter toolbar");
  for (const type of ["all", "original", "cover"]) assertIncludes(index, `data-type-filter="${type}"`, `Song Index offers the ${type} type filter`);
  assertIncludes(index, "data-tour-filter", "Song Index offers the This-tour filter");
  assertIncludes(index, "data-shelf-filter", "Song Index offers the Shelf filter");
  assertIncludes(index, "data-bestguess-filter", "Song Index offers the Transcribed-lyrics filter");
  record("Song Index rows carry the filter data-* attributes", /class="song-row"[^>]*data-type="[^"]*"[^>]*data-tour="(?:yes|no)"[^>]*data-tier="[a-z]+"[^>]*data-bestguess="(?:yes|no)"/.test(index), "song-row data-type/data-tour/data-tier/data-bestguess present");

  // Owner QA fixes on the Song Index.
  const songIndexCss = await readText("dist/stagelight.css").catch(() => "");

  // FIX 2 — sticky column-header row aligned to the row grid. The header and every
  // row share one --sr-cols template, and the header is sticky under the search bar.
  record("Song Index renders the column-header row (Title/Type/Status/Plays)",
    index.includes('class="song-index-head"') && (index.match(/class="sih-col[^"]*"/g) || []).length === 4,
    "song-index-head with four sih-col cells");
  record("Song Index header + rows share one grid template",
    /body\.stagelight \.songs-main \{[^}]*--sr-cols:/.test(songIndexCss)
    && /body\.stagelight \.song-index-head \{[^}]*grid-template-columns: var\(--sr-cols\)/.test(songIndexCss)
    && /body\.stagelight \.song-row \{[^}]*grid-template-columns: var\(--sr-cols\)/.test(songIndexCss),
    "--sr-cols drives .song-index-head and .song-row");
  record("Song Index column-header row is sticky",
    /body\.stagelight \.song-index-head \{[^}]*position: sticky/.test(songIndexCss),
    "song-index-head is position:sticky");

  // FIX 3 — the "Has Best Guess" jargon chip is renamed to plain language, while
  // the row-level Best Guess badge (matching the song-page section) is kept.
  assertIncludes(index, "Transcribed lyrics", "Song Index chip uses plain language");
  assertNotIncludes(index, "Has Best Guess", "Song Index drops the Has-Best-Guess jargon label");
  assertIncludes(index, 'class="sr-bestguess"', "Song Index keeps the row-level Best Guess badge");

  // FIX 4 — shelved / purgatoried songs show their board status, not a misleading
  // frequency-rarity tier. Rows carry data-tier + a distinct muted label.
  const shelfBoard = [...(siteData.boards?.shelfOriginals || []), ...(siteData.boards?.shelfCovers || [])];
  const purgBoard = [...(siteData.boards?.purgatoryOriginals || []), ...(siteData.boards?.purgatoryCovers || [])];
  const shelfTierCount = (index.match(/data-tier="shelf"/g) || []).length;
  record("Song Index marks shelved songs with data-tier=shelf and a Shelf label",
    shelfTierCount >= 1 && index.includes('class="sr-board sr-board-shelf">Shelf<'),
    `${shelfTierCount} shelf rows`);
  if (purgBoard.length > 0) {
    const purgTierCount = (index.match(/data-tier="purgatory"/g) || []).length;
    record("Song Index marks purgatory songs with data-tier=purgatory and a Purgatory label",
      purgTierCount >= 1 && index.includes('class="sr-board sr-board-purgatory">Purgatory<'),
      `${purgTierCount} purgatory rows`);
  }
  // A specific shelf-board song (not played this tour) resolves to the Shelf status.
  const shelfSample = shelfBoard.find((row) => !row.playedThisTour);
  if (shelfSample) {
    const escTitle = escapeAttribute(shelfSample.title.toLowerCase());
    record(`Shelf song "${shelfSample.title}" shows Shelf status, not a rarity tier`,
      new RegExp(`data-title="${escTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*data-tier="shelf"`).test(index),
      "shelf board song carries data-tier=shelf");
  }

  // FIX 1 — in-page anchor targets clear the fixed/sticky header on landing.
  record("Anchor targets carry a scroll-margin so they clear the fixed header",
    /scroll-margin-top: 96px/.test(songIndexCss)
    && ["#song-list", "#setlists", "#tour-stats"].every((id) => new RegExp(`${id}[,\\s)]`).test(songIndexCss.replace(/\n/g, " "))),
    "scroll-margin-top rule covers the nav anchor ids");

  const songDirs = await readdir(path.join(distDir, "song"), { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).length)
    .catch(() => 0);
  record("Every catalog song has its own history page", songDirs === catalog.length, `${songDirs} pages vs ${catalog.length} songs`);

  // setlist.fm "every performance" log: verifies the render when a cache exists,
  // and that the feature is cleanly dormant (no stale/fake rows) when it doesn't.
  const cacheExists = await stat(path.join(root, "data", "source", "setlistfm-cache.json")).then(() => true).catch(() => false);
  const songFiles = await listFiles(path.join(distDir, "song"), (filePath) => filePath.endsWith("index.html"));
  const perfPages = (await Promise.all(songFiles.map((filePath) => readFile(filePath, "utf8"))))
    .filter((html) => html.includes('class="perf-list"')).length;
  if (cacheExists) {
    record("setlist.fm performance log renders on song pages when a cache is present", perfPages > 0, `${perfPages} pages with a performance log`);
  } else {
    record("setlist.fm performance log stays dormant with no cache (no stale rows)", perfPages === 0, `${perfPages} pages carried performance markup`);
  }

  // spot-check a real page carries the live-history numbers straight from the catalog
  const sample = catalog.find((song) => (song.total || 0) > 1 && (song.total || 0) < 1000) || catalog[0];
  if (sample) {
    const slug = siteData.songSlugMap?.[sample.key] || null;
    const files = await listFiles(path.join(distDir, "song"), (filePath) => filePath.endsWith("index.html"));
    const match = (await Promise.all(files.map(async (filePath) => ({ filePath, html: await readFile(filePath, "utf8") }))))
      .find((page) => new RegExp(`<h1>${sample.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h1>`).test(page.html));
    record("A song history page reflects catalog play totals", Boolean(match) && match.html.includes("lifetime plays") && match.html.includes(sample.total.toLocaleString("en-US")), `${sample.title}: ${sample.total} plays${slug ? ` (/song/${slug}/)` : ""}`);
  }
}

// "Learn It" resource block on song pages: correctly placed, carries the
// external guitarist resources, and never links a dead internal lyrics target.
async function checkSongLearnBlock(siteData) {
  const songFiles = await listFiles(path.join(distDir, "song"), (filePath) => filePath.endsWith("index.html"));
  const pages = await Promise.all(songFiles.map(async (filePath) => ({ filePath, html: await readFile(filePath, "utf8") })));
  record("Song pages generated for the Learn It check", pages.length > 0, `${pages.length} pages`);

  // Placement: the LEARN IT heading sits above the performance log and the
  // "All songs" back-link on a representative page.
  const sample = pages.find((page) => page.filePath.endsWith(path.join("song", "climb-to-safety", "index.html"))) || pages[0];
  if (sample) {
    const learnIdx = indexOf(sample.html, ">LEARN IT<");
    const backIdx = indexOf(sample.html, 'class="song-back"');
    const perfIdx = indexOf(sample.html, "Every performance");
    record("Song page carries the LEARN IT heading", learnIdx >= 0, sample.filePath);
    record("LEARN IT heading sits above the performance log and back link",
      learnIdx >= 0 && learnIdx < backIdx && (perfIdx < 0 || learnIdx < perfIdx),
      `learn=${learnIdx} perf=${perfIdx} back=${backIdx}`);
  }

  // Every song page must offer the Everyday Companion and Songsterr chips.
  const missingEc = pages.filter((page) => !/class="learn-chip[^"]*"[^>]*>Everyday Companion/.test(page.html));
  const missingSongsterr = pages.filter((page) => !page.html.includes("Songsterr tab"));
  record("Every song page carries the Everyday Companion chip", missingEc.length === 0, missingEc.slice(0, 5).map((p) => p.filePath).join("\n"));
  record("Every song page carries the Songsterr tab chip", missingSongsterr.length === 0, missingSongsterr.slice(0, 5).map((p) => p.filePath).join("\n"));

  // Internal "Lyrics on Burnthday" chips must resolve to a real file in dist —
  // never a fabricated or dead internal target.
  const internalHrefs = new Set();
  for (const page of pages) {
    for (const match of page.html.matchAll(/<a class="learn-chip" href="([^"]+)"/g)) internalHrefs.add(match[1]);
  }
  const dead = [];
  for (const href of internalHrefs) {
    if (/^https?:\/\//i.test(href)) { dead.push(`${href} (external — internal chip must be a local path)`); continue; }
    const rel = href.replace(/^\/+/, "");
    const target = href.endsWith("/") ? path.join(distDir, rel, "index.html") : path.join(distDir, rel);
    const ok = await stat(target).then((s) => s.isFile()).catch(() => false);
    if (!ok) dead.push(`${href} -> ${target}`);
  }
  record("Internal Lyrics chips all resolve to real dist files", dead.length === 0, `${internalHrefs.size} distinct internal targets; dead: ${dead.join("; ")}`);
}

function checkNavigation(html, siteData) {
  const expectedMega = ["Home", "Song Possibilities", "Song Index", "Tour Stats", `${siteData.site.year} Setlists`, "The Almanac", "Albums", "Lyrics & Chords", "Song Origins", "Rumors", "Tour In Review", "The Shelf", "About"];
  // Footer is now grouped into three labeled columns; every legacy destination
  // remains present (Privacy moved to the bottom bar, asserted separately).
  const expectedColumnLabels = ["Live", "Songbook", "The Sheet"];
  const expectedFooter = [`${siteData.site.year} Setlists`, "Tour In Review", "Newsletters", "FAQ", "Rumors", "Song Index", "Albums", "Lyrics & Chords", "Song Origins", "The Almanac", "Song List", "The Shelf", "About"];
  const megaNav = linkTexts(sectionByClass(html, "mega-nav"));
  const footerColumns = sectionsByClass(html, "footer-links");
  const footerNav = footerColumns.flatMap((column) => linkTexts(column));
  const footerColumnLabels = footerColumns.map((column) => {
    const match = column.match(/<strong>([\s\S]*?)<\/strong>/);
    return match ? normalizeText(stripTags(match[1])) : "";
  });
  record("Mega menu covers every Burnthday destination plus the homepage sections", arraysEqual(megaNav, expectedMega), megaNav.join(" | "));
  assertIncludes(html, 'aria-controls="mega-menu"', "Homepage menu toggle is wired to the mega menu");
  record("One mega menu serves desktop and mobile", html.includes('id="mega-menu"') && !html.includes('<details class="mobile-nav">'));
  record("Homepage omits the redundant On This Page jump row", !html.includes('class="home-sections"') && !html.includes("ON THIS PAGE"));
  record("Footer navigation is organized around current site destinations", arraysEqual(footerNav, expectedFooter), footerNav.join(" | "));
  record("Footer groups links into exactly three labeled columns", footerColumns.length === 3 && footerColumnLabels.every(Boolean) && arraysEqual(footerColumnLabels, expectedColumnLabels), footerColumnLabels.join(" | "));
  assertIncludes(html, "The working Widespread Panic song list, setlists, and tour data.", "Footer explains what Burnthday is");
  for (const network of ["facebook", "x", "instagram"]) assertIncludes(html, `social-mark ${network}`, `Footer restores the ${network} social mark`);
  for (const network of ["Facebook", "X", "Instagram"]) assertIncludes(sectionByClass(html, "social-links"), `<span>${network}</span>`, `Footer labels the ${network} link`);
  const footerBottom = sectionByClass2(html, "footer-bottom");
  record("Footer keeps the Privacy link in the bottom bar", /href="\/privacy\/"/.test(footerBottom) && /Privacy/.test(stripTags(footerBottom)), footerBottom ? "present" : "no footer-bottom");
  for (const [label, href] of [["setlist.fm", "https://www.setlist.fm/"], ["widespreadpanic.com", "https://widespreadpanic.com/"], ["Everyday Companion", "http://everydaycompanion.com/"]]) {
    assertIncludes(footerBottom, `href="${href}"`, `Footer sources attribution keeps the ${label} link`);
  }
  assertIncludes(footerBottom, 'href="https://gnarlywhal.com"', "Footer keeps the Gnarlywhal site credit");
  assertIncludes(html, `© ${siteData.site.year} Burnthday`, "Footer keeps the Burnthday copyright line");
  assertIncludes(html, "Burnthday's Widespread Panic Spread Sheet", "Footer keeps the Spread Sheet identity line");
}

async function checkLegacyPages(siteData) {
  const [rumors, tourReview, shelf, privacy] = await Promise.all([
    readText("dist/rumors/index.html"),
    readText("dist/tour-in-review/index.html"),
    readText("dist/shelf/index.html"),
    readText("dist/privacy/index.html")
  ]);
  const rumorsText = normalizeText(stripTags(rumors));
  const tourText = normalizeText(stripTags(tourReview));
  const shelfText = normalizeText(stripTags(shelf));
  const privacyText = normalizeText(stripTags(privacy));

  record("Rumors page keeps Alex's real disclaimer copy (not invented)", /100% pure speculation/.test(rumorsText) && /call before you haul/i.test(rumorsText));
  record("Rumors page does not use invented placeholder copy", !/I am not trying to become a rumor mill/i.test(rumorsText));
  record("Rumors page surfaces the current NOLAween and Charlotte rumors", /NOLAween/.test(rumorsText) && /New Orleans, LA/.test(rumorsText) && /Charlotte, NC/.test(rumorsText) && /Heavily rumored/.test(rumorsText));
  record("Rumors page does not copy the AI overview wording verbatim", !/Speculation remains mixed on the band's Halloween plans/i.test(rumorsText));
  record("Tour In Review page uses imported legacy copy", /Burnthday's Widespread Panic Tour In Review/.test(tourText));
  record("Shelf page uses imported shelf copy", /The Shelf/i.test(shelfText) && /Purgatory/i.test(shelfText));
  record("Privacy page accurately identifies GA4", /Google Analytics 4/.test(privacyText) && /does not sell personal information/.test(privacyText));
  record("Privacy page links to Google privacy and opt-out controls", /https:\/\/policies\.google\.com\/privacy/.test(privacy) && /https:\/\/tools\.google\.com\/dlpage\/gaoptout/.test(privacy));
  assertIncludes(shelf, `<h2>Spring ${siteData.site.year} New Additions To The Shelf</h2>`, "Shelf page leads with the current seasonal additions");
  record("Shelf page omits duplicate live counters", !/on The Shelf<\/span>|in Purgatory<\/span>|show cutoff<\/span>/.test(shelf));
  record("Shelf page preserves historical updates after the current additions", indexOf(shelf, `Spring ${siteData.site.year} New Additions To The Shelf`) < indexOf(shelf, "Previous Shelf Updates") && /The Shelf Updated: April 1st, 2019/.test(shelfText));
  // Redesigned /shelf/: a computed stat strip, a designed row list (no lazy
  // bullet dump for the computed shelf), Alex's seasonal notes kept verbatim,
  // and a single H1 with no redundant eyebrow.
  const shelfBoardCount = (siteData.boards?.shelfOriginals?.length || 0) + (siteData.boards?.shelfCovers?.length || 0);
  const shelfBoardLabel = new Intl.NumberFormat("en-US").format(shelfBoardCount);
  record("Shelf page shows a computed stat strip with the live shelf count",
    shelf.includes('class="song-stat-grid"') && shelf.includes(`<strong>${shelfBoardLabel}</strong>`) && /songs shelved/.test(shelf),
    `expected a song-stat tile with ${shelfBoardLabel}`);
  record("Shelf page renders the computed shelf as a designed row list linking to song history",
    shelf.includes('class="shelf-row"') && /class="shelf-row"\s+href="\/song\//.test(shelf),
    "no shelf-row with a /song/ link found");
  const additionsBlock = (() => {
    const start = indexOf(shelf, "New Additions To The Shelf</h2>");
    const end = indexOf(shelf, "Longest Gone");
    return start >= 0 && end > start ? shelf.slice(start, end) : "";
  })();
  record("Shelf page's computed additions are rows, not a bare bullet list",
    Boolean(additionsBlock) && additionsBlock.includes('class="shelf-row"') && !additionsBlock.includes("<li>"),
    "the New Additions block still renders <li> bullets");
  record("Shelf page keeps Alex's seasonal notes verbatim",
    /there's certainly a method to their madness/i.test(shelfText),
    "distinctive verbatim shelf-notes phrase missing");
  record("Shelf page uses a single H1 with no redundant eyebrow",
    (shelf.match(/<h1>/g) || []).length === 1 && !/class="[^"]*eyebrow[^"]*"[^>]*>\s*The Shelf/i.test(shelf),
    "found a duplicate eyebrow echoing the H1");
  record("Primary archive pages omit migration eyebrows", !rumors.includes("<p>The Widespread Panic Spread Sheet</p>") && !tourReview.includes("<p>The Widespread Panic Spread Sheet</p>"));
  for (const [label, html] of [["Rumors", rumors], ["Tour In Review", tourReview], ["The Shelf", shelf], ["Privacy", privacy]]) {
    assertIncludes(html, 'class="stagelight"', `${label} page uses the Stagelight dark shell`);
    assertIncludes(html, 'id="mega-menu"', `${label} page carries the shared mega menu`);
    assertIncludes(html, 'href="/stagelight.css?v=', `${label} page loads the versioned Stagelight stylesheet`);
  }
}

// The "prose plate" is the unified reading-typography system applied to all
// archive-derived body content. It is keyed off a shared `.prose-plate` class on
// the prose container. These checks are structural and non-brittle: they confirm
// the plate class actually reaches a real archive post, a lyrics/chords page and
// a song-origin page, and that the stylesheet defines the plate rules.
async function checkProsePlate(files, htmlByFile) {
  let archivePost = null;
  let lyricsPage = null;
  let originPage = null;
  for (let index = 0; index < files.length; index += 1) {
    const html = htmlByFile[index];
    const rel = path.relative(root, files[index]);
    if (!archivePost && /[\\/](19|20)\d\d[\\/]\d\d[\\/]/.test(files[index]) && html.includes('class="archive-content prose-plate"')) archivePost = rel;
    if (!lyricsPage && html.includes('href="/lyrics-chords/"') && html.includes('class="archive-content prose-plate"')) lyricsPage = rel;
    if (!originPage && files[index].includes(`${path.sep}song-origins${path.sep}`) && html.includes('class="origin-body prose-plate"')) originPage = rel;
  }
  record("An archive post carries the shared prose plate class", Boolean(archivePost), archivePost || "no archive-content prose-plate container found");
  record("A lyrics/chords page carries the shared prose plate class", Boolean(lyricsPage), lyricsPage || "no lyrics page with prose-plate found");
  record("A song-origin page carries the shared prose plate class", Boolean(originPage), originPage || "no origin-body prose-plate container found");
  const css = await readText("dist/stagelight.css");
  record("Stagelight stylesheet defines the prose plate reading system", /body\.stagelight \.prose-plate\b/.test(css) && /--prose-measure/.test(css), "prose plate rules present in stagelight.css");
}

// Song Origins detail template: the designed article that frames Alex's verbatim
// story with computed live data. These checks confirm the chrome (eyebrow,
// breadcrumb, prose plate) plus the "JSON logic" — a stat strip with a real plays
// number and a "Full live history" link that points at a /song/ page that exists.
async function checkSongOrigins(files, htmlByFile, siteData) {
  const originSep = `${path.sep}song-origins${path.sep}`;
  const originPages = [];
  let indexHtml = "";
  for (let i = 0; i < files.length; i += 1) {
    if (!files[i].includes("song-origins")) continue;
    if (files[i].endsWith(`song-origins${path.sep}index.html`)) { indexHtml = htmlByFile[i]; continue; }
    if (files[i].includes(originSep)) originPages.push({ file: files[i], html: htmlByFile[i] });
  }
  record("Song Origins detail pages are generated", originPages.length > 0, `${originPages.length} origin pages`);

  // Every origin page ships the article chrome: SONG ORIGIN eyebrow, a Home ›
  // Song Origins › Title breadcrumb, and the verbatim story in a prose plate.
  const missingEyebrow = originPages.filter((p) => !/class="origin-eyebrow">SONG ORIGIN</.test(p.html));
  record("Every Song Origin page renders the SONG ORIGIN eyebrow", missingEyebrow.length === 0, missingEyebrow.map((p) => path.relative(root, p.file)).join("; "));
  const missingCrumb = originPages.filter((p) => !(/class="crumbs"/.test(p.html) && p.html.includes('href="/song-origins/"') && p.html.includes(">Home</a>")));
  record("Every Song Origin page renders a Home › Song Origins breadcrumb", missingCrumb.length === 0, missingCrumb.map((p) => path.relative(root, p.file)).join("; "));
  const missingPlate = originPages.filter((p) => !p.html.includes('class="origin-body prose-plate"'));
  record("Every Song Origin page carries the verbatim story in a prose plate", missingPlate.length === 0, missingPlate.map((p) => path.relative(root, p.file)).join("; "));

  // The computed stat strip: how many origins matched the catalog. A matched page
  // shows a lifetime-plays number and a working "Full live history" /song/ link.
  const withStrip = originPages.filter((p) => p.html.includes('class="origin-strip"'));
  record("At least one Song Origin joins the catalog and shows a computed stat strip", withStrip.length > 0, `${withStrip.length}/${originPages.length} origins matched the catalog`);

  let stripWithPlays = 0;
  let liveHistoryVerified = 0;
  for (const p of withStrip) {
    if (/<strong>[\d,]+<\/strong><span>lifetime plays/.test(p.html)) stripWithPlays += 1;
    const m = p.html.match(/href="\/song\/([a-z0-9-]+)\/"[^>]*>(?:(?!<\/a>).)*Full live history/);
    if (m) {
      // eslint-disable-next-line no-await-in-loop
      if (await fileExists(path.join("dist", "song", m[1], "index.html"))) liveHistoryVerified += 1;
    }
  }
  record("A matched Song Origin's stat strip shows a lifetime plays number", stripWithPlays > 0, `${stripWithPlays} matched origins show a plays tile`);
  record("A matched Song Origin links Full live history to a real /song/ page in dist", liveHistoryVerified > 0 && liveHistoryVerified === withStrip.filter((p) => p.html.includes("Full live history")).length, `${liveHistoryVerified} verified /song/ targets`);

  // The index still lists every origin.
  const expected = siteData.songOrigins?.totalEntries || 0;
  const cardCount = (indexHtml.match(/class="origin-card"/g) || []).length;
  record("Song Origins index lists every origin", expected > 0 && cardCount === expected, `index has ${cardCount} cards, expected ${expected}`);

  // Curated "kind" surfacing on the index: "fact" entries render as compact cards
  // (title + one-line summary via .origin-card-line), and "trivia" entries are
  // pulled into a "Deep cuts" strip (.origin-deepcuts) of one-liners at the end.
  record("Song Origins index renders a Deep cuts strip and compact fact cards",
    /class="origin-deepcuts"/.test(indexHtml)
      && /data-kind="trivia"/.test(indexHtml)
      && /class="origin-card-line"/.test(indexHtml)
      && /data-kind="fact"/.test(indexHtml),
    "expected an origin-deepcuts strip plus origin-card-line compact fact cards");
  // The quiet acknowledgments line (Ethan Ice for the Relix scans) is surfaced.
  record("Song Origins index surfaces the Special thanks acknowledgment (Ethan Ice)",
    /class="origin-ack"/.test(indexHtml) && /Ethan Ice/.test(indexHtml),
    "expected a Special thanks line naming Ethan Ice");

  // "By the Numbers" panel: the 5 numeric metrics are now COMPUTED live from the
  // setlist.fm performance log (replacing Alex's years-old FB snapshot). His notes,
  // Picks, and resource links stay verbatim. The raw "Label: value" code-dump must
  // be gone from the story body; the stale duplicates (# of times played / First
  // time played) are intentionally NOT surfaced.
  const withPanel = originPages.filter((p) => p.html.includes("BY THE NUMBERS"));
  record("Song Origins render a computed By the Numbers panel", withPanel.length > 0, `${withPanel.length}/${originPages.length} origins got a panel`);
  // The panel is now live, not a snapshot: the "from Burnthday's original post" sub
  // is gone everywhere it once appeared.
  const staleSub = withPanel.filter((p) => /from Burnthday'?s original post/i.test(p.html));
  record("By the Numbers panels no longer say 'from Burnthday's original post'", staleSub.length === 0, staleSub.map((p) => path.relative(root, p.file)).join("; "));

  // Writer/album credit is surfaced UP in the hero for covers (not only at the
  // bottom notes). Climb To Safety is a Jerry Joseph cover with an Author credit.
  const climb = originPages.find((p) => p.file.includes(`song-origins${path.sep}climb-to-safety${path.sep}`));
  if (climb) {
    const headEnd = climb.html.indexOf('class="origin-body');
    const hero = headEnd > 0 ? climb.html.slice(0, headEnd) : climb.html;
    record("A cover origin surfaces the writer credit in the hero", /class="origin-credit"[^>]*>Written by /.test(hero), "writer credit missing from the hero");
  }

  const alg = originPages.find((p) => p.file.includes(`song-origins${path.sep}ain-t-life-grand${path.sep}`));
  record("Ain't Life Grand origin page exists for the By the Numbers check", Boolean(alg), alg ? path.relative(root, alg.file) : "not found");
  if (alg) {
    // The raw stat code-dump is gone from the verbatim story body.
    const bodyStart = alg.html.indexOf('class="origin-body');
    const bodyEnd = alg.html.indexOf('class="origin-numbers"');
    const storyBody = bodyStart >= 0 && bodyEnd > bodyStart ? alg.html.slice(bodyStart, bodyEnd) : alg.html;
    record("Ain't Life Grand story body no longer shows the raw stat code-dump", !/# of times played/.test(storyBody) && !/523/.test(storyBody), "raw '# of times played: 523' dump still present in prose");
    record("Ain't Life Grand By the Numbers panel is present", alg.html.includes("BY THE NUMBERS"));
    // The 5 metrics are COMPUTED, not his stale snapshot: a computed Frequency
    // ("1 in every N.N shows", not his 3.27) and a computed West Virginia lead-in
    // count are present.
    record("Ain't Life Grand Frequency is computed live", /<dt>Frequency<\/dt><dd>1 in every \d+(?:\.\d+)? shows<\/dd>/.test(alg.html) && !alg.html.includes("1 in every 3.27"), "computed Frequency row missing / still stale");
    record("Ain't Life Grand lead-in is computed (West Virginia + a count)", /Most common lead in<\/dt><dd>West Virginia \(\d+ times?\)<\/dd>/.test(alg.html), "computed lead-in row missing");
    record("Ain't Life Grand drought is computed (N shows + date bracket)", /Longest drought<\/dt><dd>\d+ shows \(\d\d\/\d\d\/\d\d &gt; \d\d\/\d\d\/\d\d\)<\/dd>/.test(alg.html), "computed drought row missing");
    // The stale duplicates are dropped (never surfaced in the panel).
    record("Ain't Life Grand panel drops the stale # of times played / First time played", !/# of times played/.test(alg.html) && !alg.html.includes(">First time played<"), "stale duplicate rows leaked into the panel");
    // The computed live strip still shows the accurate plays count.
    record("Ain't Life Grand live strip still shows the computed plays", /<strong>[\d,]+<\/strong><span>lifetime plays/.test(alg.html), "computed lifetime plays tile missing");
    // Picks link straight to Relisten now (un-gated), and panicstream is still stripped.
    record("Ain't Life Grand Picks link to Relisten", /origin-pick-listen" href="https:\/\/relisten\.net\/wsp\/\d{4}\/\d\d\/\d\d"/.test(alg.html), "picks do not link to relisten.net");
    // The breadcrumb trail no longer duplicates the H1 (detail-page crumb dropped).
    const crumbs = alg.html.match(/<nav class="crumbs"[^>]*>[\s\S]*?<\/nav>/)?.[0] || "";
    record("Ain't Life Grand breadcrumb trail does not duplicate the H1", crumbs.includes('href="/song-origins/"') && !/aria-current="page"/.test(crumbs), "breadcrumb still carries the self-referential current crumb");
  }

  // Curated origins (the structured interview/newsletter supplement merged in from
  // branch claude/affectionate-blackwell-b25e75): each renders the enrichment mesh
  // (filed-under cluster chips, Related origins, FAQ) plus FAQPage + MusicComposition
  // JSON-LD, on top of the shared article chrome the universal checks above enforce.
  const clusterPages = originPages.filter((p) => /class="origin-clusters"/.test(p.html));
  record("Curated Song Origins render the enrichment mesh (cluster chips)", clusterPages.length > 0, `${clusterPages.length} origins carry filed-under cluster chips`);
  const relatedPages = originPages.filter((p) => /class="origin-related"/.test(p.html));
  record("Curated Song Origins render a Related origins section", relatedPages.length > 0, `${relatedPages.length} origins carry a related-origins section`);
  const faqSectionPages = originPages.filter((p) => /class="origin-faq"/.test(p.html));
  record("Curated Song Origins render an on-page FAQ section", faqSectionPages.length > 0, `${faqSectionPages.length} origins carry an FAQ section`);

  const north = originPages.find((p) => p.file.includes(`song-origins${path.sep}north${path.sep}`));
  record("A curated origin (North) is generated", Boolean(north), north ? path.relative(root, north.file) : "not found");
  if (north) {
    record("The curated North origin renders clusters, related, and FAQ together", /class="origin-clusters"/.test(north.html) && /class="origin-related"/.test(north.html) && /class="origin-faq"/.test(north.html), "one of clusters/related/FAQ missing");
    // Every Related target must resolve to a real origin page in dist (no dead mesh links).
    const relatedHrefs = [...north.html.matchAll(/class="origin-related-list"[\s\S]*?<\/ul>/g)].flatMap((m) => [...m[0].matchAll(/href="(\/song-origins\/[^"]+\/)"/g)].map((h) => h[1]));
    const deadRelated = relatedHrefs.filter((href) => !files.some((f) => f.endsWith(path.join(href.replace(/^\//, ""), "index.html"))));
    record("Curated Related origin links resolve to real pages in dist", relatedHrefs.length > 0 && deadRelated.length === 0, deadRelated.join("; ") || `${relatedHrefs.length} related links verified`);
    // FAQPage JSON-LD is present and structurally valid (mainEntity of Question/Answer pairs).
    const ldBlocks = [...north.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } });
    const faqLd = ldBlocks.find((b) => b && b["@type"] === "FAQPage");
    const faqValid = Boolean(faqLd) && Array.isArray(faqLd.mainEntity) && faqLd.mainEntity.length > 0 && faqLd.mainEntity.every((q) => q["@type"] === "Question" && q.name && q.acceptedAnswer && q.acceptedAnswer.text);
    record("A curated origin emits valid FAQPage JSON-LD", faqValid, faqLd ? "mainEntity malformed" : "no FAQPage JSON-LD block");
    // Exactly one FAQPage per page (no duplicate/conflicting schema of the same type).
    const faqCount = ldBlocks.filter((b) => b && b["@type"] === "FAQPage").length;
    record("A curated origin carries exactly one FAQPage schema block", faqCount === 1, `${faqCount} FAQPage blocks`);
    // MusicComposition JSON-LD is present and valid (the SEO win the handoff targets).
    const musicLd = ldBlocks.find((b) => b && b["@type"] === "MusicComposition");
    record("A curated origin emits valid MusicComposition JSON-LD", Boolean(musicLd) && Boolean(musicLd.name), musicLd ? "name missing" : "no MusicComposition JSON-LD block");
    // The verbatim compiler body carries attributed quotes with a citation.
    record("A curated origin renders attributed source quotes", /class="origin-quote"[\s\S]*?<cite>/.test(north.html), "no attributed quote with a citation");
  }
}

// Lyrics & Chords: the hub is a searchable, designed index (not a raw link list)
// and lyric subpages carry song-specific framing WITHOUT the verbatim body being
// altered. Verifies the hub search + rows, a known lyric page's eyebrow, its
// computed "Live history" link resolving to a real /song/ page, and that a
// distinctive lyric line survives untouched on the prose plate.
async function checkLyricsChords(files, htmlByFile, siteData) {
  const catalog = siteData?.catalog || [];
  const hub = await readText("dist/lyrics-chords/index.html").catch(() => "");
  record("Lyrics & Chords hub is generated", hub.length > 0);
  assertIncludes(hub, 'id="lyric-search"', "Lyrics & Chords hub carries the client-side search box");
  // The hub now covers the FULL catalog (owner UX decision), one row per song, not
  // just the ~53 songs with an internal transcription.
  const rowCount = (hub.match(/class="lyric-row"/g) || []).length;
  record("Lyrics & Chords hub lists the full catalog", catalog.length > 0 && rowCount === catalog.length, `${rowCount} lyric rows vs ${catalog.length} catalog songs`);
  assertIncludes(hub, "on Burnthday · ", "Lyrics & Chords hub reports songs + on-Burnthday count");
  assertIncludes(hub, " with chords", "Lyrics & Chords hub reports the with-chords count");

  // PART 3: the redundant hub eyebrow (duplicate of the H1 + breadcrumb crumb) is
  // gone. It stays on the categorizing lyric SUBPAGES (checked below).
  record("Lyrics & Chords hub drops the redundant LYRICS & CHORDS eyebrow", !hub.includes('class="archive-eyebrow">LYRICS &amp; CHORDS'), "hub eyebrow should be removed");

  // Internal-transcription rows carry the badge AND link a real dist file; EC rows
  // point at everydaycompanion.com (verified deep link or safe homepage fallback —
  // never a guessed 404). Assert both populations exist and resolve correctly.
  const internalCount = (hub.match(/class="lr-badge lr-badge-internal"/g) || []).length;
  record("Lyrics & Chords hub badges internal transcriptions", internalCount > 0, `${internalCount} Burnthday-transcription rows`);
  // Content-type indicator: internal rows show LYRICS + CHORDS when a chord/tab page
  // exists for the song, else LYRICS. Both populations must be present.
  const chordKind = (hub.match(/class="lr-kind">Lyrics \+ Chords</g) || []).length;
  const lyricsOnlyKind = (hub.match(/class="lr-kind">Lyrics</g) || []).length;
  record("Lyrics & Chords hub shows the LYRICS + CHORDS content-type indicator", chordKind > 0, `${chordKind} rows marked Lyrics + Chords`);
  record("Lyrics & Chords hub shows the LYRICS content-type indicator", lyricsOnlyKind > 0, `${lyricsOnlyKind} rows marked Lyrics-only`);
  record("Every internal row carries a content-type indicator", chordKind + lyricsOnlyKind === internalCount, `${chordKind + lyricsOnlyKind} indicators vs ${internalCount} internal rows`);
  const internalRows = [...hub.matchAll(/<a class="lyric-row" href="([^"]+)"(?![^>]*target)[^>]*data-transcription="yes"/g)].map((m) => m[1]);
  record("Every badged internal row links a real archive page in dist", internalRows.length > 0 && internalRows.every((href) => files.some((f) => f.endsWith(href.replace(/^\//, "").split("/").join(path.sep)))), `${internalRows.length} internal rows checked`);
  const ecRows = [...hub.matchAll(/<a class="lyric-row" href="([^"]+)"[^>]*target="_blank"[^>]*data-transcription="no"/g)].map((m) => m[1]);
  record("Lyrics & Chords hub sends EC rows to everydaycompanion.com", ecRows.length > 0 && ecRows.every((href) => /^https?:\/\/(?:www\.)?everydaycompanion\.com\//.test(href)), `${ecRows.length} EC rows checked`);

  // PART 2: the multi-select filters (Type / Has transcription / Album) compose
  // with the search box; the controls are real and the rows carry the data-*.
  assertIncludes(hub, 'class="index-toolbar"', "Lyrics & Chords hub exposes the filter toolbar");
  assertIncludes(hub, "data-transcription-filter", "Lyrics & Chords hub offers the On Burnthday (source) filter");
  assertIncludes(hub, ">On Burnthday<", "Lyrics & Chords source filter is relabelled 'On Burnthday'");
  assertIncludes(hub, "data-chords-filter", "Lyrics & Chords hub offers the Has chords filter");
  assertIncludes(hub, ">Has chords<", "Lyrics & Chords hub Has-chords filter is labelled");
  assertIncludes(hub, "data-album-filter", "Lyrics & Chords hub offers the album filter");
  for (const type of ["all", "original", "cover"]) assertIncludes(hub, `data-type-filter="${type}"`, `Lyrics & Chords hub offers the ${type} type filter`);
  record("Lyrics & Chords rows carry the filter data-* attributes", /class="lyric-row"[^>]*data-transcription="(?:yes|no)"[^>]*data-haschords="(?:yes|no)"[^>]*data-type="[^"]*"[^>]*data-album="[^"]*"/.test(hub), "lyric-row data-transcription/data-haschords/data-type/data-album present");
  record("Lyrics & Chords hub has internal rows flagged with chords", (hub.match(/data-haschords="yes"/g) || []).length > 0, "no data-haschords=yes rows");

  // Known lyric subpages: KEEP the framing eyebrow (categorizes them into the
  // section), carry a computed crosslink to a real /song/ live-history page, add
  // the "Also on Everyday Companion" cross-reference, and keep a verbatim lyric.
  const knowns = [
    { path: "dist/2023/06/king-baby-lyrics.html", line: "Feed it", song: "/song/king-baby/" },
    { path: "dist/2020/07/life-as-tree-lyrics.html", line: "Daydreams and nightlights", song: "/song/life-as-a-tree/" }
  ];
  let checkedOne = false;
  for (const known of knowns) {
    const html = await readText(known.path).catch(() => "");
    if (!html) continue;
    checkedOne = true;
    assertIncludes(html, 'class="archive-eyebrow">LYRICS &amp; CHORDS', `${known.path} keeps the categorizing LYRICS & CHORDS eyebrow`);
    const liveHref = html.match(/class="origin-xlink" href="(\/song\/[^"]+)"/)?.[1] || "";
    const targetExists = liveHref ? files.some((f) => f.endsWith(path.join(liveHref.replace(/^\//, "").replace(/\/$/, ""), "index.html"))) : false;
    record(`${known.path} links Live history to a real /song/ page in dist`, liveHref === known.song && targetExists, `${liveHref || "no link"} → ${targetExists ? "exists" : "missing"}`);
    // The "Also on Everyday Companion" cross-reference points at everydaycompanion.com.
    const ecHref = html.match(/class="origin-xlink origin-xlink-ext" href="([^"]+)"/)?.[1] || "";
    record(`${known.path} adds the "Also on Everyday Companion" cross-reference`, /^https?:\/\/(?:www\.)?everydaycompanion\.com\//.test(ecHref) && html.includes("Also on Everyday Companion"), ecHref || "no EC cross-ref");
    // Body is verbatim: the distinctive lyric line is present unchanged, on the
    // shared prose plate, and this check never rewrites it.
    assertIncludes(html, 'class="archive-content prose-plate"', `${known.path} keeps the verbatim body on the prose plate`);
    assertIncludes(html, known.line, `${known.path} lyric body is unchanged (distinctive line intact)`);
  }
  record("At least one known lyric page was framing-checked", checkedOne, "king-baby / life-as-tree lyric page present in dist");

  // EC cross-reference is gated on EC actually knowing the song. A lyric page for a
  // song Everyday Companion does not host (exclusive / not in EC's catalog) omits the
  // "Also on Everyday Companion" cross-reference rather than dead-ending at the EC
  // homepage. Welcome To My World has an internal lyric page but no EC entry.
  const exclusive = await readText("dist/2015/09/welcome-to-my-world-lyrics.html").catch(() => "");
  record("A lyric page EC does not host omits the Everyday Companion cross-reference", exclusive.length > 0 && !exclusive.includes("Also on Everyday Companion"), exclusive.length ? "EC cross-ref correctly omitted" : "welcome-to-my-world lyric page missing");
}

// PART 3 audit: redundant eyebrows are removed on HUB/INDEX pages where they merely
// duplicated the H1 + breadcrumb crumb, and categorizing eyebrows are KEPT on DETAIL
// pages where they add information. Scans dist for both populations.
function checkEyebrowAudit(files, htmlByFile) {
  const htmlAt = (needle) => {
    const idx = files.findIndex((file) => file.endsWith(needle.split("/").join(path.sep)));
    return idx === -1 ? "" : htmlByFile[idx];
  };
  const anyMatch = (dirFragment, re) => files.some((file, index) => file.includes(dirFragment) && re.test(htmlByFile[index]));

  // Removed on hubs/indexes (pure duplicates of title + crumb).
  const lyricsHub = htmlAt("lyrics-chords/index.html");
  const songsIndex = htmlAt("songs/index.html");
  const tourHubEyebrow = htmlAt("tour-in-review/index.html");
  const archiveHubEyebrow = htmlAt("archive/index.html");
  record("Lyrics & Chords hub has no duplicate eyebrow", lyricsHub.length > 0 && !lyricsHub.includes('class="archive-eyebrow">LYRICS &amp; CHORDS'), "hub eyebrow removed");
  record("Song Index has no duplicate eyebrow", songsIndex.length > 0 && !/class="[a-z-]*eyebrow"/.test(songsIndex.replace(/class="sc-eyebrow"[^>]*>[^<]*<\/time>/g, "")), "song index carries no page eyebrow");
  record("Tour In Review hub has no duplicate eyebrow", tourHubEyebrow.length > 0 && !/class="[a-z-]*eyebrow"/.test(tourHubEyebrow), "tour hub carries no page eyebrow");
  record("Archive index has no duplicate eyebrow", archiveHubEyebrow.length > 0 && !/class="[a-z-]*eyebrow"/.test(archiveHubEyebrow), "archive index carries no page eyebrow");

  // Kept on detail pages (they categorize — these add information).
  record("Song detail pages keep the categorizing eyebrow", anyMatch(`${path.sep}song${path.sep}`, /class="song-eyebrow"/), "song-eyebrow present on /song/ pages");
  record("Song Origin detail pages keep the SONG ORIGIN eyebrow", anyMatch(`${path.sep}song-origins${path.sep}`, /class="origin-eyebrow">SONG ORIGIN</), "origin-eyebrow present");
  record("Best Guess sections keep the BEST GUESS eyebrow", anyMatch(`${path.sep}song${path.sep}`, /class="bg-eyebrow"[^>]*>BEST GUESS</), "bg-eyebrow present");
  record("Tour In Review detail pages keep the Tour In Review eyebrow", anyMatch(`${path.sep}tour-in-review${path.sep}`, /class="tour-eyebrow">Tour In Review</), "tour-eyebrow present");
  record("Album detail pages keep the Studio Album eyebrow", anyMatch(`${path.sep}albums${path.sep}`, /class="album-eyebrow">Studio Album/), "album-eyebrow present");
  // Lyric SUBPAGES keep their categorizing eyebrow (verified in checkLyricsChords too).
  record("Lyric subpages keep the LYRICS & CHORDS eyebrow", files.some((file, index) => /lyrics\.html$/.test(file) && htmlByFile[index].includes('class="archive-eyebrow">LYRICS &amp; CHORDS')), "lyric subpage eyebrow kept");
}

function checkMarkerLegend(html, siteData) {
  const colors = ["Black", "Green", "Blue", "Red"];
  const legend = siteData.site?.markerLegend || [];
  const latestDates = [...new Set((siteData.setlists || []).map((show) => show.isoDate).filter(Boolean))].slice(0, 4);
  const matchesData = latestDates.every((isoDate, index) => {
    const item = legend[index];
    return item?.color === colors[index] && item?.isoDate === isoDate && Boolean(item?.label);
  });
  const matchesHtml = legend.every((item) => html.includes(item.color) && html.includes(item.label));
  record("Marker legend matches the last four posted shows", matchesData && matchesHtml, JSON.stringify(legend));
}

// The music layer (Song Origins video embeds, official-video WATCH, Relisten links).
// The two data files that light up WATCH and Relisten (song-videos.json,
// relisten-dates.json) are intentionally NOT committed, so QA asserts the DORMANT
// state: the click-to-play facade renders on origin pages (from committed origin
// data), but no WATCH section and no relisten.net link appears anywhere.
async function checkMusicLayer(files, htmlByFile) {
  // Feature 1: at least one Song Origins page renders the lite-embed facade, and it
  // ships the click-to-play affordance (accessible button) + the swap-in script.
  const facadePages = [];
  for (let index = 0; index < files.length; index += 1) {
    if (!files[index].includes(`${path.sep}song-origins${path.sep}`)) continue;
    if (/class="yt-lite"/.test(htmlByFile[index])) facadePages.push(files[index]);
  }
  record("At least one Song Origins page renders the lite YouTube embed facade", facadePages.length >= 1, `${facadePages.length} origin pages with a facade`);
  const facadeSample = facadePages.length ? htmlByFile[files.indexOf(facadePages[0])] : "";
  record("Origin lite-embed facade uses a keyboard-accessible button with a play affordance", /<button[^>]*class="yt-lite-btn"[^>]*aria-label=/.test(facadeSample) && facadeSample.includes("yt-lite-play"), path.relative(root, facadePages[0] || ""));
  record("Origin lite-embed preserves the original link in <noscript>", /<noscript><a href="[^"]*youtu/.test(facadeSample), "noscript fallback link present");
  record("A page with a facade ships the click-to-play swap-in script", facadeSample.includes("yt-lite-frame"), "LITE_EMBED_SCRIPT injected");

  // Feature 2: song-videos.json must NOT be committed — only the documented example.
  record("Real song-videos.json is absent from the repo (dormant by default)", !(await fileExists("data/source/song-videos.json")), "data/source/song-videos.json should not exist");
  record("Documented song-videos.example.json exists and is valid JSON", await isValidJson("data/source/song-videos.example.json"), "data/source/song-videos.example.json");
  const watchOffenders = files.filter((file, index) => /class="song-watch"|id="song-watch-h"/.test(htmlByFile[index])).map((file) => path.relative(root, file));
  record("No WATCH section renders anywhere while song-videos.json is absent", watchOffenders.length === 0, watchOffenders.join("; "));

  // Feature 3: relisten-dates.json IS committed (activated 2026-07-21) — the
  // Relisten layer is live. Assert the cache is valid and the gated links render.
  record("relisten-dates.json is committed and Relisten is active", await fileExists("data/source/relisten-dates.json"), "data/source/relisten-dates.json should exist");
  let relistenDates = [];
  try { relistenDates = JSON.parse(await readFile(path.join(root, "data/source/relisten-dates.json"), "utf8")); } catch { /* recorded below */ }
  record("relisten-dates.json is a non-empty array of ISO dates", Array.isArray(relistenDates) && relistenDates.length > 1000 && relistenDates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), `${Array.isArray(relistenDates) ? relistenDates.length : "invalid"} dates`);
  // Per-performance song-history rows are gated on the cache: with 2000+ dates
  // committed, matching rows must render the perf-relisten Listen link, and every
  // relisten.net link outside origin Picks must be one of those gated links.
  const perfRelistenPages = files.filter((file, index) => /class="perf-relisten"/.test(htmlByFile[index])).length;
  record("Song-history rows render gated Relisten Listen links", perfRelistenPages >= 1, `${perfRelistenPages} pages with perf-relisten links`);
  const relistenOffenders = files.filter((file, index) => {
    const stripped = htmlByFile[index]
      .replace(/<a class="origin-pick-listen" href="https:\/\/relisten\.net\/[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
      .replace(/<a class="perf-relisten" href="https:\/\/relisten\.net\/[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
      .replace(/<a class="sc-chip sc-chip-glass sc-chip-relisten" href="https:\/\/relisten\.net\/[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
      // Porch Songs archival listen links: curated Relisten URLs supplied by the
      // band's own Porch Songs data, rendered on the Tour In Review hub.
      .replace(/<a class="porch-listen" href="https:\/\/relisten\.net\/[^"]*"[^>]*>[\s\S]*?<\/a>/g, "");
    return /relisten\.net/.test(stripped);
  }).map((file) => path.relative(root, file));
  record("relisten.net links render only through the gated Pick, performance-row, show-card, and Porch Songs controls", relistenOffenders.length === 0, relistenOffenders.join("; "));
}

// Global command-palette (⌘K) search. Verifies: the trigger + dialog are on
// every page, the emitted search index is valid/complete/lean, teasers only ride
// on owned song content, and the palette's Relisten "Listen" action stays gated
// to the committed relisten-dates set (extends the Relisten whitelist without
// weakening the existing static-HTML guard, which is unchanged above).
async function checkCommandPalette(files, htmlByFile, siteData) {
  // 1. Trigger + dialog present on EVERY rendered page.
  const missingTrigger = [];
  const missingDialog = [];
  const missingKbd = [];
  for (let i = 0; i < files.length; i += 1) {
    const html = htmlByFile[i];
    if (/name="robots" content="noindex"/i.test(html) && !/class="cmdk"/.test(html)) {
      // 404/noindex pages still carry the standard header; only skip if header absent.
    }
    if (!/data-search-open/.test(html) || !/class="head-search"/.test(html)) missingTrigger.push(path.relative(root, files[i]));
    if (!/id="site-search"/.test(html) || !/role="dialog"/.test(html) || !/id="cmdk-input"/.test(html)) missingDialog.push(path.relative(root, files[i]));
    if (!/aria-keyshortcuts="Meta\+K Control\+K"/.test(html) || !/role="listbox"/.test(html) || !/role="combobox"/.test(html)) missingKbd.push(path.relative(root, files[i]));
  }
  record("Command palette trigger present on every page", missingTrigger.length === 0, `${missingTrigger.length} pages missing trigger: ${missingTrigger.slice(0, 3).join(", ")}`);
  record("Command palette dialog (role=dialog + input) present on every page", missingDialog.length === 0, `${missingDialog.length} pages missing dialog: ${missingDialog.slice(0, 3).join(", ")}`);
  record("Command palette keyboard/ARIA affordances present on every page", missingKbd.length === 0, `${missingKbd.length} pages missing keyboard attrs: ${missingKbd.slice(0, 3).join(", ")}`);

  // 2. search-index.json exists and is valid JSON.
  const exists = await fileExists("dist/data/search-index.json");
  record("search-index.json is emitted", exists, "dist/data/search-index.json should exist");
  if (!exists) return;
  let index = null;
  try { index = JSON.parse(await readFile(path.join(root, "dist/data/search-index.json"), "utf8")); } catch { /* below */ }
  record("search-index.json is a valid non-empty array", Array.isArray(index) && index.length > 0, `parsed: ${Array.isArray(index) ? index.length : "invalid"}`);
  if (!Array.isArray(index)) return;

  // Every record carries the shared shape.
  const malformed = index.filter((r) => !r || typeof r.t !== "string" || typeof r.u !== "string" || typeof r.k !== "string");
  record("Every search record has title (t), url (u), and kind (k)", malformed.length === 0, `${malformed.length} malformed records`);

  const byKind = {};
  for (const r of index) byKind[r.k] = (byKind[r.k] || 0) + 1;

  // 3. Completeness: song/album/tour/origin record counts equal the live page
  // counts (one record per built page); lyrics + archive present and non-empty.
  const dirCount = async (rel) => {
    try { return (await readdir(path.join(distDir, rel), { withFileTypes: true })).filter((e) => e.isDirectory()).length; }
    catch { return 0; }
  };
  const songDirs = await dirCount("song");
  const albumDirs = await dirCount("albums");
  const tourDirs = await dirCount("tour-in-review");
  const originDirs = await dirCount("song-origins");
  record("Search index covers every song page", byKind.song === songDirs && songDirs > 0, `${byKind.song} records vs ${songDirs} /song/ pages`);
  record("Search index covers every album page", byKind.album === albumDirs && albumDirs > 0, `${byKind.album} records vs ${albumDirs} /albums/ pages`);
  record("Search index covers every tour-in-review page", byKind.tour === tourDirs && tourDirs > 0, `${byKind.tour} records vs ${tourDirs} /tour-in-review/ pages`);
  record("Search index covers every song-origin page", byKind.origin === originDirs && originDirs > 0, `${byKind.origin} records vs ${originDirs} /song-origins/ pages`);
  record("Search index includes lyrics and archive records", (byKind.lyrics || 0) > 0 && (byKind.archive || 0) > 0, `lyrics ${byKind.lyrics || 0}, archive ${byKind.archive || 0}`);

  // Overall record count = sum of all six kinds (no stray kinds).
  const expectedTotal = (byKind.song || 0) + (byKind.album || 0) + (byKind.tour || 0) + (byKind.origin || 0) + (byKind.lyrics || 0) + (byKind.archive || 0);
  record("Search index record count equals songs+albums+tours+origins+lyrics+archive", index.length === expectedTotal, `${index.length} total vs ${expectedTotal} summed across kinds`);

  // Payload stays lean.
  const bytes = (await stat(path.join(root, "dist/data/search-index.json"))).size;
  record("search-index.json payload stays lean (< 250KB)", bytes < 250 * 1024, `${(bytes / 1024).toFixed(1)} KB`);

  // 4. Teasers ride only on song records that own lyric content (Best Guess or
  // an internal lyric page).
  const teaseredNonSong = index.filter((r) => r.tz && r.k !== "song");
  record("Teaser lines appear only on song records", teaseredNonSong.length === 0, `${teaseredNonSong.length} non-song records carry a teaser`);
  const teaseredUnowned = index.filter((r) => r.k === "song" && r.tz && !r.bg && !r.ly);
  record("Teaser lines appear only where we own the content (Best Guess or lyric page)", teaseredUnowned.length === 0, `${teaseredUnowned.length} songs teasered without owned content`);
  record("Teaser lines are short (<= 64 chars)", index.every((r) => !r.tz || r.tz.length <= 64), "a teaser exceeds the clamp");

  // 5. Relisten "Listen" quick-action gate: every song li is a well-formed
  // Relisten URL whose date is in the committed relisten-dates.json set. This is
  // the palette's extension of the Relisten whitelist — it must stay gated.
  let relistenDates = new Set();
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "data/source/relisten-dates.json"), "utf8"));
    const list = Array.isArray(parsed) ? parsed : (parsed?.dates || []);
    relistenDates = new Set(list);
  } catch { /* recorded via emptiness below */ }
  const listenRecs = index.filter((r) => r.li);
  const RELISTEN_RE = /^https:\/\/relisten\.net\/wsp\/(\d{4})\/(\d{2})\/(\d{2})$/;
  const badListen = listenRecs.filter((r) => {
    const m = RELISTEN_RE.exec(r.li);
    if (!m || r.k !== "song") return true;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    return !relistenDates.has(iso);
  });
  record("Palette Listen actions are gated Relisten links (song-only, date in relisten-dates.json)", listenRecs.length > 0 && badListen.length === 0, `${listenRecs.length} listen links, ${badListen.length} ungated`);

  // The palette must not smuggle a raw relisten.net literal into static page
  // HTML (its Listen hrefs live in the JSON index and are injected at runtime).
  const staticLeak = files.filter((file, i) => {
    const stripped = htmlByFile[i]
      .replace(/<a class="origin-pick-listen" href="https:\/\/relisten\.net\/[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
      .replace(/<a class="perf-relisten" href="https:\/\/relisten\.net\/[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
      .replace(/<a class="sc-chip sc-chip-glass sc-chip-relisten" href="https:\/\/relisten\.net\/[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
      .replace(/<a class="porch-listen" href="https:\/\/relisten\.net\/[^"]*"[^>]*>[\s\S]*?<\/a>/g, "");
    return /relisten\.net/.test(stripped);
  });
  record("Command palette introduces no un-gated static relisten.net link", staticLeak.length === 0, staticLeak.map((f) => path.relative(root, f)).join("; "));
}

// The laminated-board rim (.laminate::before) and the warm stage-light halo must
// live on ONE pseudo-element. Regression guard for the fixed rim/glow collision:
// the halo shadow now rides the rim's box-shadow, and the old colliding rule with
// its giant `inset: -60px -30px` geometry must be gone.
async function checkLaminateRim() {
  const css = await readText("dist/stagelight.css").catch(() => "");
  record("Laminate rim carries the warm stage-light halo shadow",
    css.includes("rgba(255, 243, 224, 0.09)"),
    "expected the halo box-shadow on .laminate::before");
  record("Colliding board-glow pseudo-element (inset: -60px -30px) is removed",
    !css.includes("inset: -60px -30px"),
    "the rim/glow ::before collision has returned");
}

async function fileExists(relPath) {
  try {
    await stat(path.join(root, relPath));
    return true;
  } catch {
    return false;
  }
}

async function isValidJson(relPath) {
  try {
    JSON.parse(await readFile(path.join(root, relPath), "utf8"));
    return true;
  } catch {
    return false;
  }
}

async function checkSocialCard(homeHtml) {
  // The brand share image must exist in dist and be exactly 1200x630.
  const cardPath = path.join(root, "dist", "assets", "social-card.png");
  let width = 0;
  let height = 0;
  let exists = false;
  try {
    const buf = await readFile(cardPath);
    exists = true;
    // PNG IHDR: width/height are big-endian uint32 at byte offsets 16 and 20.
    if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR") {
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    }
  } catch {
    exists = false;
  }
  record("Social card asset exists (dist/assets/social-card.png)", exists);
  record("Social card is exactly 1200x630", width === 1200 && height === 630, `Got ${width}x${height}`);

  // The homepage (and every non-noindex page via finalizeHtml) must reference it for OG + Twitter.
  assertIncludes(homeHtml, '<meta property="og:image" content="https://burnthday.com/assets/social-card.png">', "Home og:image points at the social card with an absolute https URL");
  assertIncludes(homeHtml, '<meta name="twitter:image" content="https://burnthday.com/assets/social-card.png">', "Home twitter:image points at the social card with an absolute https URL");
  assertIncludes(homeHtml, '<meta name="twitter:card" content="summary_large_image">', "Home declares twitter:card summary_large_image");

  // A representative inner page proves finalizeHtml/renderSocialMeta injects the same card everywhere.
  const songHtml = await readText("dist/songs/index.html");
  assertIncludes(songHtml, 'property="og:image" content="https://burnthday.com/assets/social-card.png"', "Inner page inherits the social card og:image");
  assertIncludes(songHtml, 'name="twitter:image" content="https://burnthday.com/assets/social-card.png"', "Inner page inherits the social card twitter:image");
  assertIncludes(songHtml, 'name="twitter:card" content="summary_large_image"', "Inner page declares twitter:card summary_large_image");
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

// Cache-busting: every stylesheet <link> must carry a ?v=<10-hex> content hash,
// the hash must match the actual built CSS, and _headers must ship the CSS +
// HTML cache rules. This is what stops fresh HTML from pairing with stale CSS
// after a deploy (the "Franken-styling" bug).
async function checkStylesheetCacheBusting(files, htmlByFile) {
  const shortHash = (str) => createHash("sha256").update(String(str), "utf8").digest("hex").slice(0, 10);
  const stagelightHash = shortHash(await readText("dist/stagelight.css"));
  const stylesHash = shortHash(await readText("dist/styles.css"));

  const badStagelight = [];
  const badStyles = [];
  for (let index = 0; index < files.length; index += 1) {
    const html = htmlByFile[index];
    const rel = path.relative(root, files[index]);
    // Any stagelight.css link must be versioned with the correct hash.
    for (const match of html.matchAll(/href="\/stagelight\.css([^"]*)"/g)) {
      if (match[1] !== `?v=${stagelightHash}`) badStagelight.push(`${rel}: ${match[0]}`);
    }
    for (const match of html.matchAll(/href="\/styles\.css([^"]*)"/g)) {
      if (match[1] !== `?v=${stylesHash}`) badStyles.push(`${rel}: ${match[0]}`);
    }
  }
  const stagelightLinkCount = htmlByFile.filter((html) => html.includes("/stagelight.css?v=")).length;
  record("Every page's Stagelight stylesheet link carries a ?v= content hash",
    badStagelight.length === 0 && stagelightLinkCount > 0,
    badStagelight.slice(0, 20).join("\n") || "no versioned stagelight.css links found");
  record("The ?v= hash matches the built stagelight.css content hash",
    /^[0-9a-f]{10}$/.test(stagelightHash) && badStagelight.length === 0,
    `expected ?v=${stagelightHash} on every stagelight.css link`);
  record("Any styles.css link is versioned with the built styles.css content hash",
    badStyles.length === 0,
    badStyles.slice(0, 20).join("\n"));

  const headers = await readText("dist/_headers");
  record("_headers gives stagelight.css an immutable Cache-Control rule",
    /\/stagelight\.css\s*\n\s*Cache-Control: public, max-age=31536000, immutable/.test(headers),
    "missing immutable Cache-Control for /stagelight.css");
  record("_headers gives styles.css an immutable Cache-Control rule",
    /\/styles\.css\s*\n\s*Cache-Control: public, max-age=31536000, immutable/.test(headers),
    "missing immutable Cache-Control for /styles.css");
  record("_headers revalidates HTML on every load via the /* catch-all",
    /\/\*[\s\S]*?Cache-Control: public, max-age=0, must-revalidate/.test(headers),
    "missing must-revalidate Cache-Control on the /* HTML catch-all");
  record("_headers keeps /assets/* immutable after the HTML rule",
    /\/assets\/\*\s*\n\s*Cache-Control: public, max-age=31536000, immutable/.test(headers),
    "assets immutable rule missing or altered");
}

async function checkTourInReviewPages() {
  const dir = path.join(distDir, "tour-in-review");
  const entries = await readdir(dir, { withFileTypes: true });
  const tourDirs = entries.filter((entry) => entry.isDirectory());
  record("Generated tour-in-review pages cover the band's history", tourDirs.length > 90, `found ${tourDirs.length} tour pages`);

  // Same-season legs are merged into one tour (owner's rule): a small break in a
  // season no longer spawns a "Spring Tour II". No "-ii" slug may survive.
  const iiDirs = tourDirs.filter((entry) => /-i{2,}$/i.test(entry.name));
  record("No same-season '-ii' tour slug survives the merge", iiDirs.length === 0,
    iiDirs.length ? `found ${iiDirs.map((d) => d.name).join(", ")}` : "no -ii dirs");

  const sitemapEarly = await readText("dist/sitemap.xml").catch(() => "");
  record("Sitemap carries no '-ii' tour URL", !/tour-in-review\/[^"<]*-ii\//.test(sitemapEarly), "sitemap clean of -ii");

  // Every dead -ii slug must 301 to its merged tour page so shared links survive.
  const redirects = await readText("dist/_redirects").catch(() => "");
  const deadSlugs = [
    "1994-summer-tour-ii", "1996-spring-tour-ii", "1997-fall-tour-ii", "2001-spring-tour-ii",
    "2009-summer-tour-ii", "2011-spring-tour-ii", "2016-fall-tour-ii", "2017-summer-tour-ii",
    "2018-summer-tour-ii", "2020-winter-tour-ii"
  ];
  const redirected = deadSlugs.filter((slug) => redirects.includes(`/tour-in-review/${slug} `) || redirects.includes(`/tour-in-review/${slug}/ `));
  record("Every merged '-ii' tour slug 301-redirects to its surviving page", redirected.length === deadSlugs.length,
    `${redirected.length}/${deadSlugs.length} dead slugs redirected`);

  const fallHtml = await readText("dist/tour-in-review/2010-fall-tour/index.html").catch(() => "");
  record("2010 Fall Tour review page exists", fallHtml.length > 0);
  record("2010 Fall review has a Welcome Back bustout section", fallHtml.includes("Welcome Back"));
  record("2010 Fall review shows an LTP gap label", /LTP\s+\d+/.test(fallHtml));
  record("2010 Fall review has a Most Played heading with a top count", /Most Played \(\d+\)/.test(fallHtml));
  record("2010 Fall review carries the setlist.fm attribution link", fallHtml.includes('href="https://www.setlist.fm/"'));
  const hasLaminate = fallHtml.includes('class="laminate primary-board tour-review-sheet"');
  const hasCountedRow = /class="rotation-song[^"]*has-count/.test(fallHtml);
  const hasHandWriteIn = fallHtml.includes("is-hand-addon");
  record("2010 Fall review renders a laminate sheet with a counted rotation row", hasLaminate && hasCountedRow);
  record("2010 Fall review shows at least one PanicHand hand write-in", hasHandWriteIn);

  const sitemap = await readText("dist/sitemap.xml").catch(() => "");
  record("Sitemap lists data-driven tour-in-review URLs", sitemap.includes("https://burnthday.com/tour-in-review/2010-fall-tour/"));

  const hub = await readText("dist/tour-in-review/index.html").catch(() => "");
  record("Tour In Review hub links the year-grouped tour index", hub.includes('class="tour-index"') && hub.includes('href="/tour-in-review/2010-fall-tour/"'));

  // Redesigned hub: a decade-grouped, filterable index unifying every generated
  // tour with Alex's hand-written reviews (badged, not buried).
  record("Tour In Review hub groups the tour index by decade with a filter",
    hub.includes('class="tour-decade"') && hub.includes("data-decade-filter"),
    "expected decade groups and a decade filter");
  const tourRowCount = (hub.match(/class="tour-row"/g) || []).length;
  record("Tour In Review hub lists the full generated tour index (>=90 links)",
    tourRowCount >= 90, `found ${tourRowCount} tour rows`);
  const writtenBadgeCount = (hub.match(/class="tr-badge"/g) || []).length;
  record("Tour In Review hub badges tours that have a written review",
    writtenBadgeCount > 0 && hub.includes(">Burnthday review</a>"),
    `found ${writtenBadgeCount} written-review badges`);

  // VOICE PILOT: five tours carry a sourced "Tour Notes" section (byline +
  // Sources line). Drafts for the owner's review, rendered from
  // data/source/tour-notes/<slug>.md.
  const pilotSlugs = ["2010-fall-tour", "1998-spring-tour", "2006-summer-tour", "2024-spring-tour", "2025-summer-tour"];
  let notesOk = 0;
  for (const slug of pilotSlugs) {
    const pageHtml = await readText(`dist/tour-in-review/${slug}/index.html`).catch(() => "");
    const hasNotes = pageHtml.includes('class="tour-notes"') && /Notes by\s+Burnthday/.test(pageHtml);
    const hasSources = pageHtml.includes('class="tour-notes-sources"') && /class="tns-label">Sources</.test(pageHtml);
    if (hasNotes && hasSources) notesOk += 1;
    else record(`Pilot Tour Notes render on ${slug}`, false, `notes=${hasNotes} sources=${hasSources}`);
  }
  record("All five Tour Notes voice pilots render a notes section with a Sources line",
    notesOk === pilotSlugs.length, `${notesOk}/${pilotSlugs.length} pilots have Tour Notes + Sources`);

  // The restructured detail page reads editorially: notes/news above the fold,
  // then stats, then the full-width sheet, then a compact logistics strip.
  const orderHtml = await readText("dist/tour-in-review/2010-fall-tour/index.html").catch(() => "");
  const posNews = orderHtml.indexOf('class="tour-news');
  const posStats = orderHtml.indexOf('class="tour-stats-block"');
  const posSheet = orderHtml.indexOf('class="tour-sheet-wrap"');
  const posLog = orderHtml.indexOf('class="tour-logistics"');
  record("Restructured tour page orders news → stats → sheet → logistics",
    posNews > 0 && posNews < posStats && posStats < posSheet && posSheet < posLog,
    `news@${posNews} stats@${posStats} sheet@${posSheet} logistics@${posLog}`);
}

async function checkArchiveIndex() {
  const html = await readText("dist/archive/index.html").catch(() => "");
  record("Archive index groups posts by year",
    html.includes('class="archive-year"') && /class="archive-year-head">\d{4}/.test(html),
    "expected year-headed groups");
  record("Archive index has a client-side title search box",
    html.includes('id="archive-search"') && html.includes("archive-row"),
    "expected an #archive-search input over .archive-row items");
  const archiveRowCount = (html.match(/class="archive-row"/g) || []).length;
  record("Archive index lists every preserved post as a scannable row",
    archiveRowCount > 200, `found ${archiveRowCount} archive rows`);
  record("Archive index uses a single H1 with no duplicate eyebrow",
    (html.match(/<h1>/g) || []).length === 1 && !/class="[a-z-]*eyebrow"/.test(html),
    "expected one H1 and no page eyebrow");
}

// Mikey-era archival layers: the /newsletters/ archive page, plus the Porch Songs
// and Tour Prints decorations on the Tour In Review hub. These verify the data is
// wired in with its required attribution (Internet Archive, per-poster artist link).
async function checkArchivalDecorations() {
  const newsletters = await readText("dist/newsletters/index.html").catch(() => "");
  const hasMoon = newsletters.includes('id="moon-heading"') && /Moon Times/.test(newsletters);
  const hasPanicle = newsletters.includes('id="panicle-heading"') && /The Panicle/.test(newsletters);
  const hasArchiveLink = newsletters.includes('href="https://web.archive.org/');
  record("Newsletters page renders Moon Times + Panicle sections with the Internet Archive attribution link",
    hasMoon && hasPanicle && hasArchiveLink,
    `moon=${hasMoon} panicle=${hasPanicle} archiveLink=${hasArchiveLink}`);

  const hub = await readText("dist/tour-in-review/index.html").catch(() => "");
  const hasPorch = hub.includes('class="tour-porch"') && hub.includes('id="porch-heading"');
  const listenCount = (hub.match(/class="porch-listen"/g) || []).length;
  record("Tour In Review hub renders the Porch Songs section with at least 10 listen links",
    hasPorch && listenCount >= 10, `porch=${hasPorch} listenLinks=${listenCount}`);

  const posterCards = hub.match(/<li class="print-card">[\s\S]*?<\/li>/g) || [];
  let posterBad = 0;
  for (const card of posterCards) {
    const img = card.match(/<img[^>]*\balt="([^"]*)"[^>]*>/);
    const altOk = img && img[1].trim().length > 0;
    const creditLink = card.match(/<a class="print-credit" href="(https:\/\/widespreadpanic\.com[^"]*)"/);
    const imgIndex = card.indexOf("<img");
    const creditIndex = card.indexOf("print-credit");
    if (!altOk || !creditLink || creditIndex < imgIndex) posterBad += 1;
  }
  record("Every rendered tour poster has a nonempty alt and a following widespreadpanic.com attribution link",
    posterCards.length > 0 && posterBad === 0, `posters=${posterCards.length} failing=${posterBad}`);

  const sitemap = await readText("dist/sitemap.xml").catch(() => "");
  record("Newsletters page appears in the sitemap",
    sitemap.includes("https://burnthday.com/newsletters/"), "expected /newsletters/ in sitemap.xml");
}

// Band FAQ page (/faq/): renders the new-fan questions with FAQPage JSON-LD, and
// the three verify:true entries (awaiting human fact-check) are held back entirely.
async function checkBandFaqPage() {
  const faq = await readText("dist/faq/index.html").catch(() => "");
  const ldBlocks = [...faq.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } });
  const faqLd = ldBlocks.find((b) => b && b["@type"] === "FAQPage");
  const questionCount = (faq.match(/<details class="faq-item"/g) || []).length;
  const faqLdValid = Boolean(faqLd) && Array.isArray(faqLd.mainEntity) && faqLd.mainEntity.length >= 9
    && faqLd.mainEntity.every((q) => q["@type"] === "Question" && q.name && q.acceptedAnswer && q.acceptedAnswer.text);
  // All 13 Q&As are published: the formerly verify-held three (lineup, taping,
  // traditions) were fact-checked by Alex + sourced (official site, Relix) 2026-07-21.
  const verifiedQuestions = ["Who's in the band?", "Can I record their shows, and where can I hear live tapes?", "What are Widespread Panic's big traditions?"];
  const missingVerified = verifiedQuestions.filter((q) => !faq.includes(escapeHtml(q)));
  record("Band FAQ page renders with FAQPage JSON-LD and the full verified question set",
    faqLdValid && questionCount >= 12 && missingVerified.length === 0,
    `rendered=${questionCount} faqLd=${Boolean(faqLd)} missing=${missingVerified.join("; ") || "none"}`);

  const sitemap = await readText("dist/sitemap.xml").catch(() => "");
  record("Band FAQ page appears in the sitemap",
    sitemap.includes("https://burnthday.com/faq/"), "expected /faq/ in sitemap.xml");
}

// THE PREDICTION LAYER — the Almanac page, the segue-pair "Travels With" section,
// the sitemap/nav wiring, and (only when a show is today) the odds panel's 🎵
// almanac reason. Pair maths exclude the Jam / Drums and Bass pseudo-songs.
async function checkPredictionLayer(siteData) {
  const almanac = await readText("dist/almanac/index.html").catch(() => "");
  record("The Almanac page (/almanac/) exists with its hero and deck",
    almanac.includes("<h1>The Almanac</h1>") && almanac.includes("class=\"alm-deck\""),
    almanac ? "rendered" : "missing dist/almanac/index.html");

  // The Knockin' Round the Zoo / Thursday reference entry: 115 Thursday plays and
  // a plain-language tier badge (Confirmed).
  record("Almanac shows the Zoo/Thursday entry with 115 and a tier label",
    almanac.includes("115 of 161 lifetime plays are Thursdays") && /alm-badge-confirmed/.test(almanac),
    "expected '115 of 161 lifetime plays are Thursdays' + a Confirmed badge");

  // All four tier labels are present, the 🎵 lyric pull-lines render, and the
  // verbatim Play note carries the — Burnthday attribution.
  const tiers = ["Confirmed", "Vouched", "Watching", "Curiosity"];
  const tiersPresent = tiers.filter((t) => almanac.includes(`>${t}<`) || almanac.includes(`${t} pattern`));
  record("Almanac renders every tier label, a 🎵 lyric pull-line, and a — Burnthday attribution",
    tiersPresent.length === tiers.length && almanac.includes("alm-lyric") && almanac.includes("— Burnthday"),
    `tiers=${tiersPresent.join("/")} lyric=${almanac.includes("alm-lyric")} attrib=${almanac.includes("— Burnthday")}`);

  // The Data Whispers section frames curiosities as data-dredged.
  record("Almanac frames The Data Whispers as data-dredged curiosities",
    almanac.includes("The Data Whispers") && /by chance/i.test(almanac),
    "expected a Data Whispers section with a 'by chance' caveat");

  const sitemap = await readText("dist/sitemap.xml").catch(() => "");
  record("The Almanac appears in the sitemap",
    sitemap.includes("https://burnthday.com/almanac/"), "expected /almanac/ in sitemap.xml");

  // Lifetime segue pairs: Machine → Barstools and Dreamers at 83%, and the pair
  // maths never surface the Jam / Drums and Bass pseudo-songs.
  const machine = await readText("dist/song/machine/index.html").catch(() => "");
  const machineTw = (machine.match(/<section class="song-travels">[\s\S]*?<\/section>/) || [""])[0];
  record("Machine's Travels With shows Barstools and Dreamers — 93% recent and 83% all-time",
    machineTw.includes("Barstools and Dreamers") && /93%/.test(machineTw) && /83% all-time/.test(machineTw),
    `partner=${machineTw.includes("Barstools and Dreamers")} recent93=${/93%/.test(machineTw)} allTime83=${/83% all-time/.test(machineTw)}`);

  // Recent-window validation targets (window 2023-07-29 → 2026-07-18): a song
  // that never reversed (Travelin' Man → The Waker, 100%) and one where recency
  // OVERRIDES lifetime (Stop Breakin' Down Blues now travels with Party At Your
  // Mama's House). Confirms the last-100-show directional miner.
  const twMan = (await readText("dist/song/travelin-man/index.html").catch(() => "")).match(/<section class="song-travels">[\s\S]*?<\/section>/)?.[0] || "";
  record("Travelin' Man's Travels With shows The Waker at 100% (recent window)",
    /The Waker/.test(twMan) && /100%/.test(twMan) && /9 in last 100/.test(twMan),
    `waker=${/The Waker/.test(twMan)} pct=${/100%/.test(twMan)} n=${/9 in last 100/.test(twMan)}`);

  const twStop = (await readText("dist/song/stop-breakin-down-blues/index.html").catch(() => "")).match(/<section class="song-travels">[\s\S]*?<\/section>/)?.[0] || "";
  record("Stop Breakin' Down Blues' Travels With prefers its recent partner (Party At Your Mama's House)",
    /Party At Your Mama/.test(twStop) && /47%/.test(twStop) && /8 in last 100/.test(twStop),
    `partner=${/Party At Your Mama/.test(twStop)} pct=${/47%/.test(twStop)} n=${/8 in last 100/.test(twStop)}`);

  // Pseudo-song exclusion, verified against the rendered artifact: no Travels With
  // partner anywhere may be "Jam" or "Drums and Bass" (the real "Drums" is allowed).
  const songFiles = await listFiles(path.join(distDir, "song"), (f) => f.endsWith("index.html"));
  const songHtml = await Promise.all(songFiles.map((f) => readFile(f, "utf8")));
  const partnerLinks = songHtml.flatMap((h) => [...h.matchAll(/class="tw-partner">\s*(?:<a[^>]*>)?([^<]+)/g)].map((m) => normalizeText(m[1])));
  const pseudoLeak = partnerLinks.filter((name) => name === "Jam" || /^Drums and Bass$/i.test(name));
  record("Segue-pair maps exclude the Jam and Drums and Bass pseudo-songs",
    pseudoLeak.length === 0,
    `partners scanned=${partnerLinks.length} pseudoLeak=${pseudoLeak.join(", ") || "none"}`);

  record("Lifetime segue-pair mining kept the expected number of strong pairs",
    Number(siteData.lifetimePairCount) >= 10,
    `lifetimePairCount=${siteData.lifetimePairCount}`);

  record("Recent-window pair mining ran over the last 100 shows (2023-07-29 → 2026-07-18)",
    siteData.recentWindow && siteData.recentWindow.shows === 100
      && siteData.recentWindow.from === "2023-07-29" && siteData.recentWindow.to === "2026-07-18"
      && Number(siteData.recentPairCount) >= 10,
    `window=${JSON.stringify(siteData.recentWindow)} recentPairCount=${siteData.recentPairCount}`);

  // Odds panel is only present when the dataset has a show today. When it is,
  // an almanac day/date match must surface the 🎵 lyric reason.
  const odds = siteData.tonightOdds;
  if (odds && Array.isArray(odds.songs)) {
    const reasoned = odds.songs.filter((s) => s.reason);
    // A reason should only appear when today matches the entry's day/date. If any
    // almanac entry matches today, at least one row must carry a 🎵 reason.
    const home = await readText("dist/index.html").catch(() => "");
    record("Odds panel surfaces a 🎵 almanac reason when the day matches (show is today)",
      reasoned.length === 0 || (home.includes("tn-reason") && home.includes("🎵")),
      `reasonedRows=${reasoned.length} dow=${odds.dowName}`);
  } else {
    record("Odds panel almanac-reason check skipped — no show today in the dataset", true,
      "tonightOdds is null (conditional, as designed)");
  }
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

function assertCurrentTourSong(html, siteData, title, label, options = {}) {
  const song = (siteData.catalog || []).find((row) => row.title.toLowerCase() === title.toLowerCase());
  const pieces = song ? [`<sup>${song.tourCount}</sup>`] : [];
  if (song && options.requireDate !== false) pieces.push(`(${song.lastDisplay})`);
  const matches = songChunks(sectionHtml(html, "song-list"), title.toUpperCase());
  record(label, Boolean(song) && matches.some((match) => pieces.every((piece) => match.includes(piece))), matches.map((match) => stripTags(match)).join(" | "));
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
  const entryAnchor = html.indexOf(heading);
  if (entryAnchor >= 0) {
    const entryStart = html.lastIndexOf('<details class="show-entry', entryAnchor);
    const entryEnd = html.indexOf("</details>", entryAnchor);
    if (entryStart >= 0 && entryEnd > entryStart) return html.slice(entryStart, entryEnd + "</details>".length);
  }
  const headingIndex = html.indexOf(`<h3>${heading}</h3>`);
  if (headingIndex >= 0) {
    const cardStart = html.lastIndexOf('<article class="setlist-card', headingIndex);
    const featureStart = html.lastIndexOf('<article class="setlist-feature', headingIndex);
    const start = Math.max(cardStart, featureStart);
    const end = html.indexOf("</article>", headingIndex);
    return start >= 0 && end > start ? html.slice(start, end + "</article>".length) : "";
  }

  const [date] = decodeHtml(heading).split(" ");
  const dateMatch = date.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  const year = dateMatch ? (dateMatch[3].length === 2 ? `20${dateMatch[3]}` : dateMatch[3]) : "";
  const isoDate = dateMatch ? `${year}-${dateMatch[1]}-${dateMatch[2]}` : "";
  const semanticDateIndex = isoDate ? html.indexOf(`datetime="${isoDate}"`) : -1;
  if (semanticDateIndex >= 0) {
    const featureStart = html.lastIndexOf('<article class="setlist-feature', semanticDateIndex);
    const cardStart = html.lastIndexOf('<article class="setlist-card', semanticDateIndex);
    const start = Math.max(featureStart, cardStart);
    const end = html.indexOf("</article>", semanticDateIndex);
    if (start >= 0 && end > start) return html.slice(start, end + "</article>".length);
  }
  const archiveStart = html.indexOf('class="setlist-list"');
  const dateIndex = html.indexOf(`>${date}</time>`, Math.max(0, archiveStart));
  if (dateIndex < 0) return "";
  const rowStart = html.lastIndexOf('<details class="setlist-row"', dateIndex);
  const rowEnd = html.indexOf("</details>", dateIndex);
  return rowStart >= 0 && rowEnd > rowStart ? html.slice(rowStart, rowEnd + "</details>".length) : "";
}

// Alex's "Best Guess" lyric transcriptions: the two songs that have a markdown
// file carry the section (with his verbatim words intact and correctly placed),
// a song without a file has none, and the songs index badges the ones that do.
async function checkBestGuessSection(siteData) {
  const wweoh = await readText("dist/song/we-walk-each-other-home/index.html").catch(() => "");
  const cosmic = await readText("dist/song/cosmic-confidante/index.html").catch(() => "");
  const chilly = await readText("dist/song/chilly-water/index.html").catch(() => "");
  const index = await readText("dist/songs/index.html").catch(() => "");

  record("We Walk Each Other Home carries the BEST GUESS section", wweoh.includes('class="song-bestguess"') && wweoh.includes(">BEST GUESS<"));
  record("Cosmic Confidante carries the BEST GUESS section", cosmic.includes('class="song-bestguess"') && cosmic.includes(">BEST GUESS<"));

  // Verbatim words must survive exactly — the preserved EDIT correction and a
  // distinctive lyric line from each transcription.
  record("We Walk Each Other Home keeps the verbatim EDIT correction", wweoh.includes("EDIT: This song is NOT a eulogy"));
  record("We Walk Each Other Home keeps the 'Sticks and bones' lyric", wweoh.includes("Sticks and bones"));
  record("Cosmic Confidante keeps the 'Cosmic confidant' lyric", cosmic.includes("Cosmic confidant"));

  // Placement: the section sits after the album chips and before the performance log.
  const bgIdx = indexOf(wweoh, 'class="song-bestguess"');
  const albumsIdx = indexOf(wweoh, "Appears on");
  const perfIdx = indexOf(wweoh, "Every performance");
  record("BEST GUESS sits after album chips and before the performance log",
    bgIdx >= 0 && (albumsIdx < 0 || albumsIdx < bgIdx) && (perfIdx < 0 || bgIdx < perfIdx),
    `albums=${albumsIdx} bestguess=${bgIdx} perf=${perfIdx}`);

  // A song without a Best Guess file must not sprout a section.
  record("A song without a Best Guess file has no section", chilly.length > 0 && !chilly.includes('class="song-bestguess"'));

  // The songs index badges rows that have a transcription.
  record("Songs index shows the Best Guess badge", index.includes('class="sr-bestguess"'));
}

function sectionByClass(html, className) {
  const start = html.indexOf(`<nav class="${className}"`);
  if (start < 0) return "";
  const end = html.indexOf("</nav>", start);
  return end > start ? html.slice(start, end + "</nav>".length) : "";
}

function sectionsByClass(html, className) {
  const open = `<nav class="${className}"`;
  const out = [];
  let index = html.indexOf(open);
  while (index >= 0) {
    const end = html.indexOf("</nav>", index);
    if (end < 0) break;
    out.push(html.slice(index, end + "</nav>".length));
    index = html.indexOf(open, end + 1);
  }
  return out;
}

// Grab a <div class="X">…</div> by shallow brace-free tag matching for footer bars.
function sectionByClass2(html, className) {
  const start = html.indexOf(`<div class="${className}"`);
  if (start < 0) return "";
  let depth = 0;
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = start;
  let match;
  while ((match = tag.exec(html))) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return html.slice(start, match.index + match[0].length);
    } else {
      depth += 1;
    }
  }
  return html.slice(start);
}

function linkTexts(html) {
  return [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)]
    .map((match) => normalizeText(stripTags(match[1])))
    .filter(Boolean);
}

function assertIncludes(value, expected, label) {
  record(label, String(value).includes(expected), `Missing: ${expected}`);
}

function assertNotIncludes(value, unexpected, label) {
  record(label, !String(value).includes(unexpected), `Unexpected: ${unexpected}`);
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

function sum(values = []) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function readImageDimensions(publicPath) {
  if (!String(publicPath || "").startsWith("/assets/")) return { width: 0, height: 0 };

  try {
    const buffer = await readFile(path.join(distDir, publicPath.replace(/^\/+/, "")));
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
      let offset = 2;
      while (offset + 8 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        offset += 2;
        if (marker === 0xd8 || marker === 0xd9) continue;
        const segmentLength = buffer.readUInt16BE(offset);
        if (startOfFrameMarkers.has(marker)) {
          return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
        }
        if (segmentLength < 2) break;
        offset += segmentLength;
      }
    }
  } catch {
    // Missing or unreadable images fail the caller's dimensions check.
  }

  return { width: 0, height: 0 };
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
