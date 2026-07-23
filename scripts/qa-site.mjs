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
  await checkNickJohnsonFeature(homeHtml, siteData);
  checkTourDates(homeHtml, siteData);
  await checkUpcomingBackdrop(homeHtml);
  await checkMobileTourDateCss();
  await checkMobilePassCss();
  await checkSetlistImageOrientation(siteData);
  await checkLatestSetlist(homeHtml, siteData);
  await checkFontLoading(allHtmlFiles, allHtml);
  await checkHeroTransitionEngine(homeHtml);
  checkRivieraDisplaySweep(allHtmlFiles, allHtml);
  checkGuestAnnotations(homeHtml, review2025Html);
  await checkEveryInternalLinkResolves(allHtmlFiles, allHtml);
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
  await checkFaqAccordions();
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
  assertIncludes(html, '<section class="home-hero" id="latest-setlist"', "Homepage has a dedicated top-of-page hero section");
  assertIncludes(html, '<section class="laminate primary-board" id="song-list">', "Homepage has song-list laminate");
  // Board header drops the comma ("SACRAMENTO CA", Alex round 5).
  const boardTitle = [siteData.site?.boardShow?.location?.replace(",", ""), siteData.site?.boardShow?.runLabel].filter(Boolean).join(" ").toUpperCase();
  assertIncludes(html, `<h1>${escapeHtml(boardTitle)}</h1>`, `Song List title matches board show: ${boardTitle}`);

  record("Current tour-stop setlists appear above Song List", indexOf(html, 'id="latest-setlist"') < indexOf(html, 'id="song-list"'));
  record("Sheet key bento sits directly below the Song List", indexOf(html, 'id="song-list"') < indexOf(html, 'id="sheet-key"') && indexOf(html, 'id="sheet-key"') < indexOf(html, 'id="tour-stats"'));
  record("Shelf, Purgatory, and Woodshed bentos share the sheet-key grid below the Song List", indexOf(html, 'id="sheet-key"') < indexOf(html, 'id="shelf"') && indexOf(html, 'id="shelf"') < indexOf(html, 'id="purgatory"') && indexOf(html, 'id="purgatory"') < indexOf(html, 'id="woodshed"') && indexOf(html, 'id="woodshed"') < indexOf(html, 'id="tour-stats"'));
  record("From the stage: one cinematic featured video between Nick stats and the 2026 setlists (our photo poster, click-to-play, zero shipped iframes)",
    indexOf(html, 'id="nick-johnson"') < indexOf(html, 'id="from-the-stage"') && indexOf(html, 'id="from-the-stage"') < indexOf(html, 'id="setlists"')
    && sectionHtml(html, "from-the-stage").includes('data-video-id="mdKVMEjrqRQ"')
    && sectionHtml(html, "from-the-stage").includes("/assets/from-the-stage-poster.jpg")
    && sectionHtml(html, "from-the-stage").includes("Photo: Andy Tennille")
    && sectionHtml(html, "from-the-stage").includes("<b>Official videos from the stage</b>")
    && !sectionHtml(html, "from-the-stage").includes("2026 tour \u00b7")
    && !sectionHtml(html, "from-the-stage").includes("<iframe")
    && !sectionHtml(html, "from-the-stage").includes("i.ytimg.com")
    && sectionHtml(html, "from-the-stage").includes("youtube-nocookie.com/embed/")
    && sectionHtml(html, "from-the-stage").includes('class="sc-chip sc-chip-glass fs-yt"'));
  record("Shelf Watch appears below Tour Stats", indexOf(html, 'id="tour-stats"') < indexOf(html, 'id="shelf-watch"'));
  record("Nick Stats appears below Shelf Watch", indexOf(html, 'id="shelf-watch"') < indexOf(html, 'id="nick-johnson"'));
  record("Older setlists appear below Nick Stats", indexOf(html, 'id="nick-johnson"') < indexOf(html, 'id="setlists"'));

  record("Unique-song total matches the current-tour ledger", siteData.totals?.currentTourSongs === siteData.currentTour?.length);
  record("Tour-play total matches per-song counts", siteData.totals?.currentTourPlays === sum(siteData.currentTour?.map((song) => song.tourCount)));
  record("Shows-played total matches posted setlists", siteData.totals?.postedSetlists === siteData.setlists?.length);
  record("Tour-date total matches the official schedule", siteData.totals?.tourDates === siteData.tourDates?.length);
  const ledger = sectionHtml(html, "song-list");
  record("Song List laminate contains no website-stat ledger", !ledger.includes("board-ledger") && !ledger.includes("songs per show"));

  assertIncludes(html, "The tiny number beside a song counts its plays this tour", "Sheet key explains the tiny number");
  assertIncludes(html, "the last 4 shows marked out in colors", "Board intro line explains the marker color code");
  assertIncludes(html, "The Woodshed", "Sheet key includes The Woodshed");
  record("The Woodshed explains the Nick Johnson logic", html.includes("The Woodshed lists rotation songs") && html.includes("hasn&#39;t played yet") || html.includes("The Woodshed lists rotation songs"), "Woodshed Ramp column present");
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

  // The outer accordion is gone: the section is always open, headed by a compact
  // Two-tone headline (renamed back to Tour stats, Alex 7/23), lede lines gone,
  // no disclosure/summary/chevron.
  assertNotIncludes(feature, "stats-disclosure", "Tour stats has no outer accordion wrapper");
  assertIncludes(feature, '<b>Tour stats follows the songs on tour</b>', "Tour stats leads with the two-tone headline");
  record("Tour stats intro has no lede filler or Dork branding",
    !feature.includes("ds-title") && !feature.includes("rabbit hole") && !feature.includes("Dork stats"));

  // Summary stats: ONE horizontal rail (single surface, four equal columns), not
  // the old four-tile bento and not the Nick section's .nick-stat tiles.
  assertIncludes(feature, '<div class="stats-rail"', "Dork stats summary is a single horizontal rail");
  assertNotIncludes(feature, "data-metrics", "Dork stats drops the four-tile metric bento");
  assertNotIncludes(feature, "nick-stat", "Dork stats rail does not reuse the Nick .nick-stat tiles");
  record("Dork stats rail has exactly four stat columns", (feature.match(/<div class="stat-col">/g) || []).length === 4);
  for (const [value, label] of [
    [shows, "shows played"],
    [songs.length, "unique songs"],
    [plays, "song plays"],
    [average, "songs per show"]
  ]) assertIncludes(feature, `<strong>${value}</strong><span>${label}</span>`, `Dork stats reports ${label}`);

  for (const key of ["title", "count", "rarity", "heat", "last"]) {
    assertIncludes(feature, `data-sort="${key}"`, `Tour Stats supports sorting by ${key}`);
  }
  assertIncludes(feature, 'class="th-tip-pop', "Tour Stats explains its signals via column hover tips");
  assertIncludes(feature, "Rarity", "Tour Stats labels rarity directly");
  assertIncludes(feature, "Hyper Rare", "Tour Stats explains the game-like rarity ladder");
  assertIncludes(feature, '<span class="rarity-symbol" aria-hidden="true"><svg', "Tour Stats renders card-style rarity symbols as inline SVG");
  assertIncludes(feature, "Last / usual gap", "Tour Stats labels timing with plain numbers");
  assertNotIncludes(feature, "In rotation", "Tour Stats avoids the ambiguous In rotation rarity label");
  assertNotIncludes(feature, "Rotation timing", "Tour Stats avoids the ambiguous Rotation timing label");
  assertIncludes(feature, "not a prediction", "Timing is not presented as predictive odds");
  assertIncludes(feature, "data-show-filter", "Tour Stats can highlight songs from one selected show");
  assertIncludes(feature, "data-mobile-sort", "Tour Stats has a dedicated mobile sort control");
  for (const type of ["all", "original", "cover"]) assertIncludes(feature, `data-type-filter="${type}"`, `Tour Stats includes the ${type} type filter`);
  assertIncludes(feature, "data-rarity-filter", "Tour Stats offers a multi-select rarity filter");
  record("Rarity filter lists every tier present in the table", [...new Set([...feature.matchAll(/data-rarity-tier="([^"]+)"/g)].map((match) => match[1]))].every((tier) => feature.includes(`<input type="checkbox" value="${tier}" data-rarity-option>`)));
  const rendered = [...feature.matchAll(/<tr data-title="([^"]+)" data-count="(\d+)" data-frequency="(\d+)" data-l100="(\d+)" data-rarity="(\d+)" data-rarity-tier="([^"]+)" data-heat="(\d+)" data-last="([^"]*)" data-type="([^"]+)" data-shows="([^"]*)"(?: data-lastfour="[^"]*")? data-played="yes">/g)]
    .map((match) => ({ title: decodeHtml(match[1]), count: Number(match[2]) }));
  record("Tour Stats includes every played song exactly once", rendered.length === songs.length, `${rendered.length} rendered vs ${songs.length} expected`);
  record("Tour Stats defaults to most played with alphabetical tie-breaking", arraysEqual(rendered.map((song) => song.title), songs.map((song) => song.title.toLowerCase())));
  record("Tour Stats play counts match the ledger", rendered.every((song, index) => song.count === songs[index].tourCount));
  record("Tour Stats does not report scheduled tour dates", !feature.includes("tour dates"));

  // (Change 1) Color-coded last-four rail: rows played in one of the last four shows
  // carry data-lastfour with the show's marker color, and render one rail segment each.
  const legendColors = (siteData.site?.markerLegend || []).filter((mark) => mark.isoDate).map((mark) => mark.color.toLowerCase());
  const railMatches = [...feature.matchAll(/data-lastfour="([^"]+)"/g)].map((match) => match[1].split(","));
  record("Tour Stats marks last-four appearances with a color rail", railMatches.length > 0, `${railMatches.length} rows carry a last-four rail`);
  record("Last-four rail colors come from the marker legend", railMatches.every((colors) => colors.length > 0 && colors.every((color) => legendColors.includes(color))));
  const railSegTotal = (feature.match(/<i class="rail-(?:black|blue|green|red)"><\/i>/g) || []).length;
  const railDeclTotal = railMatches.reduce((total, colors) => total + colors.length, 0);
  record("Rail segments match declared last-four appearances", railSegTotal === railDeclTotal && railSegTotal > 0, `${railSegTotal} segments vs ${railDeclTotal} declared`);

  // (Change 3) Not-played toggle: the not-played songs render as hidden data-played="no"
  // rows in the same tbody; played rows are data-played="yes". A chip toggles between them.
  assertIncludes(feature, "data-notplayed-toggle", "Tour Stats offers a Not-played toggle chip");
  const notPlayed = [...(siteData.boards?.rotationOriginals || []), ...(siteData.boards?.rotationCovers || [])].filter((song) => !song.playedThisTour);
  const notPlayedRows = [...feature.matchAll(/<tr [^>]*data-played="no"[^>]*>/g)].map((match) => match[0]);
  record("Not-played songs render as hidden data-played=no rows", notPlayedRows.length === notPlayed.length && notPlayedRows.every((tr) => / hidden>/.test(tr)), `${notPlayedRows.length} not-played rows vs ${notPlayed.length} expected`);
  const playedRows = [...feature.matchAll(/<tr [^>]*data-played="yes"[^>]*>/g)];
  record("Played songs render as visible data-played=yes rows", playedRows.length === songs.length && playedRows.every((match) => !/ hidden>/.test(match[0])), `${playedRows.length} played rows vs ${songs.length} expected`);

  // Consolidated-pass toolbar: renamed not-played label, a Find-a-song search at the
  // right end, the marker-color dot in the Highlight control, and a computed
  // "Explore all N songs" expand affordance with the bounded-scroll markup.
  assertIncludes(feature, ">Not played this tour<", "Not-played toggle uses the full 'Not played this tour' label");
  assertIncludes(feature, "data-song-search", "Dork stats has a Find-a-song text search");
  assertIncludes(feature, 'placeholder="Find a song"', "Find-a-song search carries its mono placeholder");
  assertIncludes(feature, "data-show-filter-dot", "Highlight control surfaces the selected show's marker color as a dot");
  assertIncludes(feature, "data-applied-filters", "Dork stats has an applied-filter row container");
  assertIncludes(feature, `data-expand-label="Explore all ${new Intl.NumberFormat("en-US").format(songs.length)} songs"`, "Expand control computes 'Explore all N songs'");
  assertIncludes(feature, 'data-collapse-label="Show fewer"', "Expand control collapses back to 'Show fewer'");
  assertIncludes(feature, 'class="tour-table-wrap is-capped" data-table-scroll', "Table wrap stays a capped scroll container for the bounded expand");
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

  assertIncludes(feature, "<b>Shelf Watch</b> tracks songs nearing", "Homepage has the Shelf Watch rail with its one-sentence header");
  record("Shelf Watch rail has paired arrows and no tooltip/helper chrome",
    feature.includes("data-sw-prev") && feature.includes("data-sw-next") && !feature.includes("th-tip") && !feature.includes("SLP \u2014"),
    "arrows present, tooltip removed");
  record("Shelf Watch cards carry the archival photos with one credit line",
    (feature.match(/class="sw-img"/g) || []).length >= 4 && feature.includes("Photos by") && feature.includes("Josh Timmermans") && feature.includes("/assets/shelf-watch/") && feature.includes("widespreadpanic.com/galleries"),
    "photo backgrounds + single linked credit");
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
    const rowStart = feature.indexOf(`data-song-title="${escapeAttribute(song.title)}"`);
    const rowEnd = (() => { const next = feature.indexOf('data-song-title="', rowStart + 20); return next >= 0 ? next : feature.length; })();
    const row = rowStart >= 0 && rowEnd > rowStart ? feature.slice(rowStart, rowEnd) : "";
    assertIncludes(row, `hasn&rsquo;t been played since`, `Shelf Watch gives ${song.title}'s plain-language last-played line`);
    assertIncludes(row, `<span class="sw-n">${remaining}</span>`, `Shelf Watch gives ${song.title}'s distance to Shelf`);
    assertIncludes(row, `til the shelf`, `Shelf Watch pairs ${song.title}'s number with the full phrase`);
  }
}

async function checkNickJohnsonFeature(html, siteData) {
  const feature = sectionHtml(html, "nick-johnson");
  const sl = await readText("dist/stagelight.css").catch(() => "");
  const fmt = (value) => new Intl.NumberFormat("en-US").format(value);
  const played = (siteData.catalog || [])
    .filter((song) => song.playedWithNick && song.nickCount > 0);
  const rotation = (siteData.catalog || [])
    .filter((song) => song.effectiveSlp < siteData.rules.rotationSlpLimit || song.playedThisTour);
  const nickShows = (siteData.setlists || []).filter((show) => (show.notes || []).some((note) => /\bnick johnson\b/i.test(note) && /\bguitar\b/i.test(note))).length;
  const nickPlays = sum(played.map((song) => song.nickCount));
  const woodshed = [...(siteData.boards?.woodshedOriginals || []), ...(siteData.boards?.woodshedCovers || [])];
  const playedPct = rotation.length ? Math.round((played.length / rotation.length) * 100) : 0;

  // Section is always open now: no accordion wrapper and no "Nick stats" heading.
  record("Nick feature drops the accordion wrapper and heading",
    !feature.includes("nick-disclosure") && !feature.includes("<h2>Nick stats</h2>") && !feature.includes("<details class=\"nick-disclosure"),
    "no nick-disclosure / summary heading");

  // Headline unchanged: Shelf-Watch two-tone lead + computed show count.
  assertIncludes(feature, 'class="sw-lead nick-headline"', "Nick headline reuses the Shelf Watch two-tone headline style");
  assertIncludes(feature, '<b>Nick Johnson has played just over half</b>', "Headline lead is the white bolded phrase");
  assertIncludes(feature, `${fmt(nickShows)} shows. Here`, "Headline carries the computed show count");
  record("Headline has no coral accent spans", !feature.includes("nick-accent"), "coral accents removed");
  assertIncludes(feature, "most likely to come next", "Headline keeps the exact closing copy");

  // Left panel now LEADS with the 50% primary statistic, then the quieter
  // "PLAYED of ROTATION songs in rotation played with Nick" line, three bars, three tiles.
  assertIncludes(feature, 'class="nick-panel nick-bento"', "Nick feature groups the summary into one glass bento panel");
  assertIncludes(feature, `<div class="nick-lead"><strong>${playedPct}%</strong></div>`, "Panel leads with the 50% primary statistic");
  assertIncludes(feature, `${fmt(played.length)} of ${fmt(rotation.length)} songs in rotation played with Nick`, "Panel caption gives the computed of-312 line");
  assertIncludes(feature, 'class="is-overall"', "Nick has a dedicated overall progress bar");
  assertIncludes(feature, 'class="is-original"', "Nick completion bar separates played originals");
  assertIncludes(feature, 'class="is-cover"', "Nick completion bar separates played covers");
  assertIncludes(feature, `${played.length}/${rotation.length}`, "Nick overall bar gives the exact overall count");
  for (const [value, label] of [
    [nickShows, "shows"],
    [nickPlays, "song plays"],
    [woodshed.length, "in the Woodshed"]
  ]) {
    assertIncludes(feature, `<strong>${fmt(value)}</strong><span>${label}</span>`, `Panel tile reports ${label}`);
  }
  record("Nick totals render as the three tour-stats tiles (no 4-tile block, no stats-through note)",
    feature.includes('class="data-metrics nick-tiles"') && !feature.includes("nick-summary") && !feature.includes("Stats current through"),
    "nick-tiles present, old blocks gone");

  // LAYOUT (Alex, 7/23): the three tour totals sit BESIDE the headline at the top of
  // the left column, and the bento below holds the rig on the left with the 50%,
  // its caption and the three bars on the right. One bento, not two panels.
  record("The three tour totals sit beside the headline, above the bento (not inside it)",
    /<div class="nick-head-row">\s*<h2 class="sw-lead nick-headline">[\s\S]*?<\/h2>\s*<div class="data-metrics nick-tiles"[\s\S]*?<\/div>\s*<\/div>\s*<div class="nick-panel nick-bento">/.test(feature)
      && feature.indexOf('class="data-metrics nick-tiles"') < feature.indexOf('class="nick-panel nick-bento"'),
    "nick-head-row wraps headline + tiles, and closes before the bento opens");
  record("Bento splits into the rig art on the left and the 50% / caption / bars on the right",
    /<div class="nick-panel nick-bento">[\s\S]*?<div class="nick-bento-art">[\s\S]*?<\/div>\s*<div class="nick-bento-figures">\s*<div class="nick-lead">/.test(feature)
      && /<div class="nick-bento-figures">[\s\S]*?class="nick-caption"[\s\S]*?class="nick-bars"/.test(feature),
    "nick-bento-art precedes nick-bento-figures, figures hold lead/caption/bars");
  record("Stagelight CSS lays the head row and the bento out as two-column grids",
    /body\.stagelight \.nick-head-row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1\.55fr\) minmax\(0, 1fr\)/.test(sl)
      && /body\.stagelight \.nick-bento\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1\.9fr\) minmax\(0, 1fr\)/.test(sl),
    "head-row + bento grid templates present");

  // BENTO ATMOSPHERE (Alex, 7/23): an ambient low-intensity version of the footer
  // "ALL THE WAY FROM ATHENS GA" tie-dye washing the panel. It must sit BEHIND the
  // content and hold still under reduced motion.
  assertIncludes(feature, '<span class="nick-atmo" aria-hidden="true"></span>', "Bento ships a decorative atmosphere layer, hidden from assistive tech");
  record("Bento atmosphere reuses the Athens tie-dye hue run, sits behind the content, and is blurred to a wash",
    /body\.stagelight \.nick-atmo\s*\{[^}]*z-index:\s*0/.test(sl)
      && /body\.stagelight \.nick-atmo\s*\{[^}]*linear-gradient\(100deg, rgba\(212,81,79,[\d.]+\)[^}]*rgba\(96,165,210,[\d.]+\)[^}]*rgba\(201,163,95,[\d.]+\)/.test(sl)
      && /body\.stagelight \.nick-atmo\s*\{[^}]*filter:\s*blur\(/.test(sl)
      && /body\.stagelight \.nick-bento > \*\s*\{[^}]*z-index:\s*1/.test(sl)
      && /body\.stagelight \.nick-bento\s*\{[^}]*overflow:\s*hidden/.test(sl),
    "atmo layer behind content, Athens hue run, blurred, clipped by the panel");
  record("Bento atmosphere animates by default and holds still under prefers-reduced-motion",
    /body\.stagelight \.nick-atmo\s*\{[^}]*animation:\s*nick-atmo-drift/.test(sl)
      && /@keyframes nick-atmo-drift/.test(sl)
      && /@media \(prefers-reduced-motion: reduce\)\s*\{\s*body\.stagelight \.nick-atmo\s*\{\s*animation:\s*none/.test(sl),
    "nick-atmo-drift keyframes + reduced-motion still");

  // Living poster (rig) in the Nick panel: synthetic starfield canvas BEHIND a
  // knocked-out plate img, gear-light fx canvas above. Backing is TRANSPARENT (no
  // solid fill, no grade/sheen framing) so the glass panel reads through the sky.
  // The plate is a FILE reference (never a multi-MB inline data URI); the compact
  // dot table is inlined into this one page. rAF + timeout fallback + reduced still.
  record("Nick panel ships the living rig poster (starfield canvas behind a knocked-out plate)",
    /class="living-poster lp-rig" data-living="lp\d+"/.test(feature)
    && feature.includes('class="lp-layer lp-starfield"')
    && feature.includes('class="lp-layer lp-plate" alt="" src="/assets/living/nick-plate.webp"')
    && feature.includes('class="lp-layer lp-fx"'),
    "living rig stack present with plate referenced as a file");
  record("Living poster drops the demo grade/sheen framing layers (no panel-like frame)",
    !feature.includes("lp-grade") && !feature.includes("lp-sheen"),
    "grade/sheen framing removed from the rig markup");
  record("Nick living plate stays a file reference, not an inline data URI",
    !/lp-plate[^>]*src="data:/.test(feature),
    "no inline plate data URI on homepage");
  record("Nick living runtime has rAF + timeout fallback and a reduced-motion still",
    feature.includes("data-living=\"lp") && feature.includes("requestAnimationFrame")
    && feature.includes("setTimeout(boot") && /prefers-reduced-motion/.test(feature),
    "rig runtime animation-safe");
  // Rig popup retag (7/23): hotspots are colored by OWNER (Mikey's/Jimmy's/Nick's),
  // never by a "Confirmed"/"assumed" scheme — that scheme stamped "Confirmed" on
  // AI-conflated claims about a real person's gear. soundcity is pinned to jimmy
  // because the exact conflation that shipped was "Mikey's Sound City" (Premier
  // Guitar documents it as Herring's dry cab, and Mikey never had one).
  // polytune + green are pinned to nick: they were nearly cut as AI photo-reads
  // until Alex produced a Red Rocks frame showing both on Nick's board.
  record("Rig legend is the three-owner read (Mikey's / Jimmy's / Nick's)",
    /<div class="rig-legend">\s*<span class="rig-mikey"><i><\/i>Mikey's<\/span>\s*<span class="rig-jimmy"><i><\/i>Jimmy's<\/span>\s*<span class="rig-nick"><i><\/i>Nick's<\/span>/.test(html),
    "three owner legend entries, in order");
  record("Rig popup carries no Confirmed/assumed scheme anywhere",
    !/rig-(?:tag|spot)[^>]*is-assumed/.test(html) && !/rl-conf|rl-assumed/.test(html)
    && !/<span class="rig-tag[^"]*">Confirmed</.test(html),
    "owner classes only — no is-assumed, no rl-conf/rl-assumed, no Confirmed tag");
  record("Sound City is owned by Jimmy (the Mikey conflation must not return)",
    /data-tip="soundcity"/.test(html) && /class="rig-spot rig-jimmy"[^>]*aria-label="Sound City 4x12"/.test(html)
    && /id="rig-tip-soundcity"><span class="rig-tag rig-jimmy">/.test(html)
    && !/Mikey's original cabinet/.test(html),
    "soundcity spot + tip both carry rig-jimmy; old caption gone");
  record("PolyTune and the green box stay, owned by Nick (Red Rocks frame, 7/23)",
    /id="rig-tip-polytune"><span class="rig-tag rig-nick">/.test(html)
    && /id="rig-tip-green"><span class="rig-tag rig-nick">/.test(html),
    "both Red Rocks-verified pedals present as Nick's");
  record("Rig owner colors are tokens, not hardcoded rgb",
    /body\.stagelight \.rig-mikey \{ --c: 201,163,95; \}/.test(sl)
    && /body\.stagelight \.rig-jimmy \{ --c: 94,158,210; \}/.test(sl)
    && /body\.stagelight \.rig-nick \{ --c: 242,242,240; \}/.test(sl)
    && /\.rig-spot \{[^}]*rgba\(var\(--c\), 0\.22\)/.test(sl),
    "--c triples defined per owner; spot derives from rgba(var(--c))");
  record("Living poster canvas backing is transparent (starfield clears each frame; no solid stage fill)",
    /body\.stagelight \.lp-stage\s*\{[^}]*background:\s*transparent/.test(sl)
    && feature.includes("sctx.clearRect(0, 0, W, H)")
    && !/body\.stagelight \.lp-stage\s*\{[^}]*background:\s*#/.test(sl),
    "lp-stage transparent + starfield clearRect present");
  record("Stagelight CSS defines the living poster layers + reduced-motion still",
    /body\.stagelight \.lp-stage\b/.test(sl) && /body\.stagelight \.lp-starfield\b/.test(sl)
    && /body\.stagelight \.lp-plate\b/.test(sl) && /body\.stagelight \.lp-fx\b/.test(sl)
    && /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.living-poster[\s\S]*?animation: none/.test(sl),
    "living poster CSS + reduced-motion present");
  // Atmosphere wash is contained to the header (no overhang onto content cards below).
  record("Poster-header atmosphere wash is clipped to the header wrapper (no overhang)",
    /body\.stagelight \.ph-wrap\s*\{[^}]*overflow:\s*hidden/.test(sl)
    && /body\.stagelight \.ph-wrap\s*\{[^}]*contain:\s*layout paint style/.test(sl)
    && /body\.stagelight \.ph-atmos\s*\{[^}]*inset:\s*-15% -15% 0 -15%/.test(sl)
    && /body\.stagelight \.ph-atmos::before\s*\{[^}]*mask-image:\s*linear-gradient\(#000 55%, transparent 82%\)/.test(sl),
    "ph-wrap clips + atmos bottom-flush + faded before edge");

  assertIncludes(feature, 'class="nick-ranking" data-view="next"', "Nick Johnson feature presents a ranked most-likely-next view with a per-view column set");

  // Every rotation song ships in the DOM carrying the full facet set (type, nick count,
  // eligibility, Heat, gap, played state).
  const facetRows = [...feature.matchAll(/<li class="nick-row[^>]*data-type="(?:original|cover)"[^>]*data-nick-count="\d+"[^>]*data-eligible="[01]"[^>]*data-heat="\d+"[^>]*data-slp="\d+"[^>]*data-played="(?:yes|no)"/g)];
  record(
    "Nick ranking rows carry type, nick-count, eligibility, Heat, and gap facets",
    facetRows.length === rotation.length,
    `${facetRows.length} faceted rows vs ${rotation.length} expected`
  );

  // Per-song play count integrity: every rotation song present with the right nickCount.
  const renderedByTitle = new Map(
    [...feature.matchAll(/data-song-title="([^"]+)"[^>]*data-nick-count="(\d+)"/g)]
      .map((match) => [decodeHtml(match[1]), Number(match[2])])
  );
  const countMismatches = rotation.filter((song) => renderedByTitle.get(song.title) !== song.nickCount);
  record(
    "Every rotation song is present with its correct play count",
    renderedByTitle.size === rotation.length && countMismatches.length === 0,
    countMismatches.slice(0, 10).map((song) => `${song.title}: ${renderedByTitle.get(song.title)} vs ${song.nickCount}`).join("\n")
  );

  // TYPE IS A FILTER, NOT A COLUMN (Alex, 7/23: "we definitely don't need original
  // or cover"). The per-row Type cell, its chip and its sortable header are gone
  // from every view; type survives only as the data-type facet the filter reads.
  record("No Type cell, chip or sortable Type header survives in any row or view",
    !feature.includes('class="nick-type"') && !/class="nick-chip is-(?:original|cover)"/.test(feature)
      && !feature.includes('data-nick-col="type"') && !feature.includes("nrh-type")
      && !feature.includes(">ORIGINAL<") && !feature.includes(">COVER<"),
    "nick-type / nick-chip / nrh-type / data-nick-col=type all absent");
  record("Type still ships as a per-row data facet so the All/Originals/Covers filter keeps working",
    (feature.match(/data-type="(?:original|cover)"/g) || []).length === rotation.length,
    `${(feature.match(/data-type="(?:original|cover)"/g) || []).length} data-type facets vs ${rotation.length} rows`);

  // Type SEGMENTED CONTROL (exact Tour Stats pattern, own data hook), all three options.
  assertIncludes(feature, '<div class="type-filter" role="group"', "Type segmented control uses the Tour Stats type-filter pattern");
  for (const [value, label] of [["all", "All"], ["original", "Originals"], ["cover", "Covers"]]) {
    assertIncludes(feature, `data-nick-type="${value}">${label}<`, `Type control has the ${label} option`);
  }

  // Sortable column headers with shared-state markup. Per-view column set: next/woodshed
  // carry Plays/Gap/Last/Heat (.nx), the played view carries Nick plays/Last-with-Nick (.pv).
  // Columns are Song | Plays | Gap | Last played | Heat for next/woodshed (plus the
  // narrow rank number), and Song | Nick plays | Last played with Nick for the
  // played view. Type is deliberately NOT in this list.
  for (const col of ["title", "plays", "gap", "last", "heat", "nickplays", "nicklast"]) {
    assertIncludes(feature, `data-nick-col="${col}"`, `Ranking header sorts by ${col} on click`);
  }
  assertIncludes(feature, '<span class="nrh-col nrh-rank" aria-hidden="true">#</span>', "Expanded table keeps the narrow rank-number column");
  assertIncludes(feature, 'class="nrh-col nrh-sort nrh-heat nx is-sorted" data-nick-col="heat"', "Heat is the default-active sortable header (shared sort state, active arrow shown)");
  assertIncludes(feature, 'class="nrh-arr"', "Sort headers carry a shared active-arrow affordance");
  record("Per-view columns present: Heat cells (.nx) and played-view cells (.pv)",
    /class="nick-score tn-heat nx /.test(feature) && feature.includes('class="nick-nickplays pv"') && feature.includes('class="nick-nicklast pv"'),
    "nick-score .nx + nick-nickplays/.nick-nicklast .pv present");

  // Heat is a bare 0-100 digit (tier carried by the nk-* class color only — the
  // HOT/WARM words were stripped 7/23, Alex: overloaded), NEVER a percent sign.
  const scoreCells = [...feature.matchAll(/class="nick-score tn-heat nx (nk-\w+)"><b>(\d+)<\/b>/g)];
  record(
    "Heat renders as a bare digit score with a tier class, no tier word, no percent sign",
    scoreCells.length === rotation.length && scoreCells.every((match) => /^nk-(hot|warm|long)$/.test(match[1]) && Number(match[2]) >= 0 && Number(match[2]) <= 100) && !/<b>\d+%<\/b>/.test(feature) && !feature.includes('class="nick-score tn-heat nx nk-hot"><span class="tn-tier">'),
    `${scoreCells.length} score cells`
  );

  // View dropdown stays; the DESKTOP Sort dropdown is removed; a mobile-only Sort select remains.
  assertIncludes(feature, 'data-nick-view-dd', "Nick ranking renders the View dropdown");
  record("Desktop Sort dropdown is gone (header sorting replaces it)", !feature.includes("data-nick-sort-dd"), "data-nick-sort-dd removed");
  record("A mobile-only Sort select is present, wrapped in .mobile-sort",
    /<div class="mobile-sort">[\s\S]*?data-nick-mobile-sort/.test(feature),
    "data-nick-mobile-sort inside .mobile-sort");
  record("Old Show dropdown is gone", !feature.includes("data-nick-show-dd"), "data-nick-show-dd removed");

  // Songbook expands into a BOUNDED scroll wrap (sticky header) with a sticky Show-fewer
  // control — reuses the tour-stats capped-wrap + stats-expand treatment. The wrap ships
  // in its collapsed preview state (is-preview) so the six-row default paints pre-JS.
  assertIncludes(feature, 'class="nick-ranking-wrap is-preview" data-nick-scroll', "Ranking sits inside the bounded-scroll wrap, collapsed-preview by default");
  assertIncludes(feature, 'class="stats-expand" aria-expanded="false" data-nick-songbook', "Songbook button uses the stats-expand treatment");
  assertIncludes(feature, "Explore Nick&#39;s full songbook", "Songbook button carries the songbook copy");

  // Collapsed preview presentation: a three-column Song / Why now / Heat read. The
  // "Why now" cell ships server-side (built from each row's own gap/cadence/recent-100
  // facets) for next/woodshed, with a Nick-history equivalent (.pv) for the played view.
  assertIncludes(feature, '<span class="nrh-col nrh-why" aria-hidden="true">Why now</span>', "Preview header carries the Why now column label");
  record("Every ranking row ships both server-side Why-now cells (next/woodshed .nx + played .pv)",
    (feature.match(/class="nick-why nx"/g) || []).length === rotation.length
      && (feature.match(/class="nick-why-nick pv"/g) || []).length === rotation.length,
    "one .nick-why and one .nick-why-nick per row");
  record("Why-now copy is built from the row facets (gap gone · usual cadence · recent-100 plays)",
    /class="nick-why nx">[^<]*play[^<]* in the last 100</.test(feature)
      && /class="nick-why nx">[^<]*shows? gone/.test(feature),
    "expected the computed Why-now sentence");
  record("Preview stylesheet drives the three-column Song / Why now / Heat grid and hides the expanded-only cells",
    /\.nick-ranking-wrap\.is-preview\b[\s\S]*?grid-template-columns/.test(sl)
      && /\.nick-ranking-wrap\.is-preview[\s\S]*?\.nick-rank[\s\S]*?display:\s*none/.test(sl),
    "is-preview grid + hidden rank/plays/gap/last rules present");

  // SORTING WORKS COLLAPSED (Alex, 7/23: "if you do not click the button on the
  // bottom, then the sorting area at the top doesn't work"). The preview used to
  // kill pointer events on the headers and hide their arrows, so the header looked
  // live but did nothing until the songbook was expanded. One shared sort state
  // spans collapsed and expanded — the click handler is bound once, not per state.
  record("Column headers sort in the COLLAPSED preview too (pointer events live, arrows visible)",
    /\.nick-ranking-wrap\.is-preview \.nrh-sort\s*\{[^}]*pointer-events:\s*auto/.test(sl)
      && !/\.nick-ranking-wrap\.is-preview \.nrh-sort\s*\{[^}]*pointer-events:\s*none/.test(sl)
      && /\.nick-ranking-wrap\.is-preview \.nrh-arr\s*\{[^}]*display:\s*inline/.test(sl)
      && !/\.nick-ranking-wrap\.is-preview \.nrh-arr\s*\{[^}]*display:\s*none/.test(sl),
    "is-preview no longer disables the sort headers");
  record("Sorting is one shared state: the header click handler is bound once and re-applies in either state",
    /querySelectorAll\("\[data-nick-col\]"\)\.forEach\(\(btn\) => btn\.addEventListener\("click"/.test(html)
      && /is-preview", !expanded/.test(html),
    "single delegated header binding + preview class driven by expanded flag");
  record("Inactive sort arrows stay hidden until hover or focus; the active column keeps its arrow",
    /body\.stagelight \.nrh-arr\s*\{[^}]*opacity:\s*0/.test(sl)
      && /body\.stagelight \.nrh-sort:hover \.nrh-arr, body\.stagelight \.nrh-sort:focus-visible \.nrh-arr\s*\{[^}]*opacity/.test(sl)
      && /body\.stagelight \.nrh-sort\.is-sorted \.nrh-arr\s*\{[^}]*opacity:\s*1/.test(sl),
    "arrow affordance rules intact");

  // SONG TITLES NEVER TRUNCATE (Alex, 7/23). Dropping Type freed the width; long
  // titles wrap instead of ellipsing, in the preview AND the expanded table.
  record("Song titles wrap instead of truncating in both the preview and the expanded table",
    /body\.stagelight \.nick-song strong\s*\{[^}]*white-space:\s*normal/.test(sl)
      && !/body\.stagelight \.nick-song strong\s*\{[^}]*text-overflow:\s*ellipsis/.test(sl)
      && /body\.stagelight \.nick-ranking-wrap\.is-preview \.nick-song strong\s*\{[^}]*white-space:\s*normal/.test(sl),
    "no ellipsis on .nick-song strong in either state");

  // The control row matches the house pill pattern exactly by reusing .data-toolbar
  // (the Tour Stats / Dork stats toolbar) rather than a Nick-only control shape.
  record("Nick control row reuses the house data-toolbar shell (same pill treatment as Tour Stats)",
    /class="data-toolbar nick-controls(?: filter-drawer)?"/.test(feature)
      && /body\.stagelight \.nick-two-col \.nick-controls\s*\{\s*margin:\s*0 0 14px;\s*\}/.test(sl),
    "data-toolbar class present, Nick override reduced to margin only");

  // The two columns finish level: the left column is a flex stack whose bento
  // absorbs the slack, and the grid row stretches both sides to the same height.
  record("Left and right columns are laid out to finish at the same height",
    /body\.stagelight \.nick-two-col\s*\{[^}]*align-items:\s*stretch/.test(sl)
      && /body\.stagelight \.nick-two-col \.nick-left\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/.test(sl)
      && /body\.stagelight \.nick-two-col \.nick-left \.nick-bento\s*\{[^}]*flex:\s*1 1 auto/.test(sl),
    "stretch + flex-column left + growing bento");

  // Default "most likely next" view: only ELIGIBLE songs are visible, exactly the top
  // six, every visible row eligible + slp > 4, and no visible row is a one-off (total<=1).
  const allRows = [...feature.matchAll(/<li class="nick-row[^>]*>/g)].map((match) => match[0]);
  const visibleRows = allRows.filter((li) => !/ hidden>/.test(li));
  const eligibleRows = allRows.filter((li) => /data-eligible="1"/.test(li));
  // Preview depth: raised 9 -> 10 so the collapsed songbook fills the right column
  // beside the taller left stack without ever producing a scrollbar.
  const NICK_PREVIEW_ROWS = 10;
  const expectedVisible = Math.min(NICK_PREVIEW_ROWS, eligibleRows.length);
  record(
    "Non-eligible songs ship hidden by default",
    allRows.filter((li) => /data-eligible="0"/.test(li)).every((li) => / hidden>/.test(li)),
    "every non-eligible row hidden"
  );
  record(
    `Exactly the top ${NICK_PREVIEW_ROWS} eligible most-likely-next rows are visible by default`,
    visibleRows.length === expectedVisible && visibleRows.every((li) => {
      const slp = li.match(/data-slp="(\d+)"/);
      return /data-eligible="1"/.test(li) && slp && Number(slp[1]) > 4;
    }),
    `${visibleRows.length} visible vs ${expectedVisible} expected`
  );
  record(
    "Eligibility floor: no visible top row is a one-off (data-total >= 2)",
    visibleRows.every((li) => { const t = li.match(/data-total="(\d+)"/); return t && Number(t[1]) > 1; }),
    "no data-total<=1 in the visible pool"
  );
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

  // (1b) Strike layering (Phase B): overlapping show-colours are separate,
  // stacked physical strokes (one <span> each), blended normally (not multiply),
  // ordered oldest->newest so the most recent show (black #131313) paints LAST.
  record("Strike marker ink uses normal blend so stacked show-colours stay physical strokes",
    /\.marker-ink\s*\{[^}]*mix-blend-mode:\s*normal/.test(sl));
  const strikeClusters = [...homeHtml.matchAll(/(?:<span class="marker-mask[^>]*"[^>]*><span class="marker-ink"><\/span><\/span>)+/g)].map((m) => m[0]);
  const multiColorStrikes = strikeClusters
    .map((c) => [...c.matchAll(/--mc:(#[0-9a-fA-F]{3,6})/g)].map((x) => x[1].toLowerCase()))
    .filter((cols) => cols.length >= 2);
  // Zero multi-colour clusters is legitimate (a window where no song repeated
  // across the last four shows — e.g. 7/16-7/21/26); when they exist, black last.
  record("Overlapping strikes (when present) stack oldest->newest with black (most recent) on top; strikes render at all",
    strikeClusters.length > 0 && multiColorStrikes.every((cols) => cols[cols.length - 1] === "#131313"));

  // (1c) Hand-ink arrow flourish between the sheet and the explanations: one SVG,
  // two draw-on paths, IntersectionObserver at threshold 0.35, reduced-motion safe.
  // Four Garrie-style arrows (one per explanatory column), each with line +
  // pressure + head paths at its own tilt, drawing in a left-to-right sequence.
  record("Four hand-ink arrows lead the explanatory columns (line/press/head paths, unique tilts, staggered draw)",
    (homeHtml.match(/class="sheet-arrow"/g) || []).length === 4
    && (homeHtml.match(/class="sa-line"/g) || []).length === 4
    && (homeHtml.match(/class="sa-press"/g) || []).length === 4
    && (homeHtml.match(/class="sa-head"/g) || []).length === 4
    && new Set([...homeHtml.matchAll(/--ar:([-\d.]+deg)/g)].map((m) => m[1])).size === 4
    && homeHtml.includes("--ad:420ms"));
  record("Arrow draws on via IntersectionObserver (threshold 0.35) with reduced-motion fallback",
    homeHtml.includes("threshold: 0.35") && homeHtml.includes('classList.add("armed")') && /prefers-reduced-motion/.test(homeHtml) && /\.sheet-arrow[^{]*\{[^}]*stroke-dashoffset:\s*0/.test(sl));

  // (1d) Bento scrawl reads as ONE sheet split into three aligned layers, each
  // masked to a vertical zone with a distinct blur/opacity tier; card group lifted.
  record("Scrawl stays one aria-hidden component holding three aligned layers",
    /<div class="sheet-scrawl" aria-hidden="true"><div class="ss-layer ss-behind">/.test(homeHtml)
      && homeHtml.includes('class="ss-layer ss-above"') && homeHtml.includes('class="ss-layer ss-below"'));
  record("The three scrawl zones carry distinct blur tiers (heavy behind, light above, clearest below)",
    /\.ss-behind\s*\{[^}]*blur\(6\.5px\)/.test(sl) && /\.ss-above\s*\{[^}]*blur\(3\.2px\)/.test(sl) && /\.ss-below\s*\{[^}]*blur\(1px\)/.test(sl));
  record("Card group is lifted 72px so setlist shows above the card tops",
    /\.bento-region\s+\.bento-grid\s*\{[^}]*translateY\(-72px\)/.test(sl));

  // (2) Consolidated pass: the Dork stats accordion is REMOVED (section always open),
  // while the custom show dropdown + stable sort state stay wired.
  record("Dork stats section drops the outer accordion (always open)", !homeHtml.includes('class="stats-disclosure"'));
  record("Highlight-a-show stays the custom dark dropdown", homeHtml.includes("data-show-filter-dd") && homeHtml.includes('class="sf-option is-active"'));
  record("Custom show dropdown highlights the selected option when open", /sf-option[^"]*is-active/.test(homeHtml) && homeHtml.includes('classList.toggle("is-active"'));
  record("Dork stats sort order is tracked as stable state (no reorder on filter)", homeHtml.includes("applyState") && homeHtml.includes("compareRows") && !homeHtml.includes("applyFilters"));
  record("Dork stats applied-filter row offers a Clear all reset", homeHtml.includes("data-af-clear") && homeHtml.includes("resetAll"));

  // (3) Tonight's Odds — the dataset has a show today (07/21 Sacramento). Now its own
  // accordion, CLOSED by default, with a real top-three teaser on the closed bar.
  record("Dataset has a show today (Tonight's Odds precondition)", Boolean(siteData.site?.isShowDayPreview));
  record("Tonight's Odds data is computed when a show is today", Boolean(siteData.tonightOdds && siteData.tonightOdds.songs?.length));
  record("Tonight's Odds panel is present on the homepage", homeHtml.includes('class="tonight-odds"') && homeHtml.includes("data-tonight-toggle"));
  record("Tonight's Odds is closed by default (no is-open in markup, opened via JS)", homeHtml.includes('class="tonight-odds" data-tonight>') && !homeHtml.includes('class="tonight-odds is-open"'));
  record("Tonight's Odds title is the lowercase-o 'Tonight's odds'", homeHtml.includes(">Tonight's odds</span>"));
  if (siteData.tonightOdds && siteData.tonightOdds.songs?.length) {
    const top = siteData.tonightOdds.songs.slice(0, 3);
    const expected = top.map((song) => `${song.title} ${song.heat}`).join(" · ");
    // The closed-bar full teaser lists the real top-three titles + heat, in order.
    const full = (homeHtml.match(/<span class="tn-teaser-full">([^<]*)<\/span>/) || [])[1] || "";
    record("Tonight's Odds teaser previews the real top-three predictions in order",
      decodeHtml(full) === expected,
      `teaser="${decodeHtml(full)}" expected="${expected}"`);
    if (siteData.tonightOdds.city) {
      record("Tonight's Odds shows the city as a quiet secondary line", homeHtml.includes(`class="tn-city"`) && homeHtml.includes(siteData.tonightOdds.city));
    }
  }
  record("Tonight's Odds carries its entertainment disclaimer", homeHtml.includes("This is just math having fun"));
  record("Tonight's Odds lists ranked songs with heat + tier", (homeHtml.match(/class="tn-row/g) || []).length >= 10);

  // (4) Bottom cross-promo band replaced the stray Get Tickets pill.
  record("Bottom cross-promo band is present", homeHtml.includes('class="cross-promo"') && (homeHtml.match(/class="xp-card/g) || []).length === 2);
  // Owner standing rule: community cards carry ONE display line only (no eyebrow /
  // subheadline stack) and use the shared bc-open rounded-square affordance, not a
  // circular arrow. Guard the rework so a future pass can't reintroduce the stack.
  record("Community cards carry a single display line (no eyebrow/subheadline stack)",
    (homeHtml.match(/class="xp-title"/g) || []).length === 2
    && !homeHtml.includes('class="xp-eyebrow"') && !homeHtml.includes('class="xp-desc"'),
    "xp-eyebrow / xp-desc must not return; two xp-title lines only");
  record("Community cards use the bc-open rounded-square affordance (not xp-arrow)",
    (homeHtml.match(/class="xp-card[^"]*"[^>]*>[\s\S]*?class="bc-open"/g) || []).length === 2
    && !homeHtml.includes('class="xp-arrow"'),
    "each xp-card carries a bc-open; the circular xp-arrow is gone");
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
  const tabHrefs = [...hub.matchAll(/<a class="lr-tab" href="([^"]+)"/g)].map((m) => m[1]);
  const missingTab = [];
  for (const href of tabHrefs) {
    const ok = await stat(distDir + href).then(() => true).catch(() => false);
    if (!ok) missingTab.push(href);
  }
  record("Lyrics hub renders Tab links for sibling guitar-tab pages", tabHrefs.length > 0);
  record("Every Tab link resolves to a real dist page", missingTab.length === 0, missingTab.join("\n"));
  // EC chords fallback: rows without a hosted tab link to the song's exact
  // Everyday Companion page (never a search URL); dashes only where EC has nothing.
  const ecTabHrefs = [...hub.matchAll(/<a class="lr-tab lr-tab-ec" href="([^"]+)"/g)].map((m) => m[1]);
  const badEc = ecTabHrefs.filter((h) => !/^https:\/\/everydaycompanion\.com\/.+\.asp$/.test(h) || /search/i.test(h));
  record("EC chords fallback links exist and outnumber hosted tabs", ecTabHrefs.length > tabHrefs.length);
  record("Every EC chords fallback is a direct everydaycompanion.com song page, never a search", badEc.length === 0, badEc.join("\n"));

  // (10) Every internal song link on the homepage resolves to a real dist page.
  const home = await readText("dist/index.html").catch(() => "");
  const songHrefs = [...new Set([...home.matchAll(/href="(\/songs?\/[a-z0-9-]+\/)"/g)].map((m) => m[1]))];
  const missingSong = [];
  for (const href of songHrefs) {
    const ok = await stat(distDir + href + "index.html").then(() => true).catch(() => false);
    if (!ok) missingSong.push(href);
  }
  record("Homepage song links exist", songHrefs.length > 0);
  record("Every homepage song link resolves to a real dist page", missingSong.length === 0, missingSong.join("\n"));
}

function checkTourDates(html, siteData) {
  const feature = sectionHtml(html, "tour-dates");
  const upcoming = siteData.tourDates.filter((date) => !date.isPosted).length;
  assertIncludes(feature, `${upcoming} shows ahead`, "Upcoming block summarizes the remaining schedule");
  record("Upcoming block lists every unplayed show once", (feature.match(/<li class="is-upcoming">/g) || []).length === upcoming);
  // Every upcoming row carries a Get Tickets link to that show's official page
  // (falls back to the Upcoming flag only when a show has no sourceUrl).
  record("Upcoming block gives every row a Get Tickets link or status flag",
    ((feature.match(/class="up-tickets"/g) || []).length + (feature.match(/<em class="up-flag">Upcoming<\/em>/g) || []).length) === upcoming
    && (feature.match(/class="up-tickets" href="https:\/\/widespreadpanic\.com\/shows\//g) || []).length > 0);
  assertIncludes(feature, 'href="https://widespreadpanic.com/tour"', "Upcoming block links the official tour page");
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

// Mobile pass (2026-07-21) — guards for the 375/431px fixes so they can't silently
// regress: song-page performance rows must be allowed to shrink below min-content
// (they overflowed the viewport), the Tour Stats signal columns keep a real
// min-width inside the sideways-scrolling capped table (a legacy card-layout rule
// zeroed it and crushed RARITY/HEAT into tall stacks), album-detail track stats
// stack under the title instead of overlapping it, and the lyrics-hub header drops
// its TAB track at phone widths so SONG/PLAYS line up with the rows.
async function checkMobilePassCss() {
  const css = await readText("dist/stagelight.css").catch(() => "");
  record("Song-page performance list column can shrink (no viewport overflow)",
    /body\.stagelight \.perf-list \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(css),
    "perf-list uses minmax(0,1fr) so has-relisten rows never push past 375px");
  record("Tour Stats signal columns keep min-width inside the mobile scroll table",
    /body\.stagelight \.tour-table \.signal-cell \{ min-width: 150px; \}/.test(css),
    "560px media block restores .signal-cell min-width for the capped table");
  record("Album tracks stack the sheet/plays stat under the title on mobile",
    /body\.stagelight \.album-track \.track-stat \{ grid-column: 2; grid-row: 2;/.test(css),
    "560px media block moves .track-stat to its own row");
  // Mobile lyrics hub collapses to SONG | LYRICS | PLAYS: ARTIST/ALBUM/TAB drop out
  // (header + rows together) and the words/plays cells re-anchor to tracks 2/3 so the
  // header labels stay aligned with the rows. One shared --lr-cols per breakpoint.
  record("Lyrics hub collapses to SONG | LYRICS | PLAYS at phone widths",
    /body\.stagelight \.lr-artist, body\.stagelight \.lr-sub, body\.stagelight \.lr-tab,\s*body\.stagelight \.lh-artist, body\.stagelight \.lh-album, body\.stagelight \.lh-tab \{ display: none; \}/.test(css)
      && /body\.stagelight \.lr-words \{ grid-column: 2; \}/.test(css)
      && /body\.stagelight \.lr-plays \{ grid-column: 3; \}/.test(css),
    "mobile lyric hub hides ARTIST/ALBUM/TAB and re-anchors words/plays");
  record("Lyrics hub header and rows share one --lr-cols grid template",
    /body\.stagelight \.lyrics-list, body\.stagelight \.lyric-head \{ --lr-cols:/.test(css),
    "header + rows must resolve identical column edges");
  // (Change 1) Last-four rail defines all four canonical marker colors.
  record("Tour Stats last-four rail defines the four marker colors",
    /\.lf-rail \.rail-black \{ color: #2e2e30;/.test(css)
      && /\.rail-blue \{ color: #465692;/.test(css)
      && /\.rail-green \{ color: #47866a;/.test(css)
      && /\.rail-red \{ color: #d4514f;/.test(css),
    "rail-black/blue/green/red map to the marker hexes");
  // (Change 2) Capped table gets a clean inset, rounded, auto-styled scrollbar.
  record("Capped table styles a clean inset scrollbar with a rounded corner",
    /\.tour-table-wrap\.is-capped \{[^}]*border-radius:/.test(css)
      && /\.tour-table-wrap\.is-capped::-webkit-scrollbar \{ width: 8px;/.test(css)
      && /::-webkit-scrollbar-thumb \{[^}]*border-radius: 8px;[^}]*background-clip: content-box;/.test(css),
    "border-radius on the wrap + thin inset webkit scrollbar thumb");
}

// Feature 2 — the homepage UPCOMING board carries a full-bleed live-show backdrop
// (Andy Tennille) behind a dark overlay, a quiet visible photo credit (band policy),
// and the asset actually ships to dist.
async function checkUpcomingBackdrop(homeHtml) {
  const css = await readText("dist/stagelight.css").catch(() => "");
  record("Upcoming section references the Tennille backdrop asset",
    /body\.stagelight \.upcoming-dates::before \{[^}]*url\("\/assets\/upcoming-bg-andy-tennille\.jpg"\)/.test(css),
    "upcoming-dates::before background-image points at the shipped jpg");
  record("Upcoming backdrop sits under a dark overlay gradient so text keeps contrast",
    /body\.stagelight \.upcoming-dates::before \{[^}]*linear-gradient\([^)]*rgba\(/.test(css),
    "overlay gradient layered over the image");
  record("Upcoming section shows a visible photographer credit",
    homeHtml.includes('class="upcoming-credit">Photo: Andy Tennille'),
    "Photo: Andy Tennille credit rendered in the upcoming board");
  let assetOk = false;
  try { assetOk = (await stat(path.join(distDir, "assets", "upcoming-bg-andy-tennille.jpg"))).isFile(); } catch { assetOk = false; }
  record("Upcoming backdrop asset ships to dist", assetOk, "dist/assets/upcoming-bg-andy-tennille.jpg exists");
}

// Feature 3 — both FAQ surfaces (/faq/ .faq-item and About .about-faq-item) share
// one accordion treatment: a chevron that rotates 180deg on open plus a smooth
// ::details-content open/close with graceful degradation on older browsers.
async function checkFaqAccordions() {
  const css = await readText("dist/stagelight.css").catch(() => "");
  const faqHtml = await readText("dist/faq/index.html").catch(() => "");
  const aboutHtml = await readText("dist/about/index.html").catch(() => "");
  // Selectors are comma-grouped in the shared rule, so assert each surface's
  // selector is present AND the grouped rule body carries the right values.
  const chevronBody = /body\.stagelight \.(?:faq-item|about-faq-item) > summary::after \{[^}]*transform: rotate\(45deg\)[^}]*transition: transform/.test(css)
    && /\[open\] > summary::after \{ transform: rotate\(225deg\); \}/.test(css);
  const detailsBody = /body\.stagelight \.(?:faq-item|about-faq-item)::details-content \{[^}]*block-size: 0[^}]*transition: content-visibility [^}]*block-size 0\.25s/.test(css)
    && /\[open\]::details-content \{ block-size: auto; \}/.test(css);
  for (const [sel, label] of [[".faq-item", "/faq/ page"], [".about-faq-item", "About page"]]) {
    record(`FAQ accordion (${label}) has a rotating chevron on its summary`,
      css.includes(`body.stagelight ${sel} > summary::after`)
      && css.includes(`body.stagelight ${sel}[open] > summary::after`)
      && chevronBody,
      `${sel} chevron rotates 45deg -> 225deg (180deg) on open`);
    record(`FAQ accordion (${label}) animates open/close via ::details-content`,
      css.includes(`body.stagelight ${sel}::details-content`)
      && css.includes(`body.stagelight ${sel}[open]::details-content`)
      && detailsBody,
      `${sel}::details-content transitions block-size 0 -> auto`);
  }
  record("FAQ accordions enable keyword size interpolation for the animation",
    /:root \{ interpolate-size: allow-keywords; \}/.test(css),
    "interpolate-size: allow-keywords on :root");
  record("Both FAQ surfaces render details/summary items and load the shared stylesheet",
    faqHtml.includes('class="faq-item"') && faqHtml.includes("stagelight.css")
    && aboutHtml.includes('class="about-faq-item"') && aboutHtml.includes("stagelight.css"),
    "faq-item + about-faq-item present and both pages link stagelight.css");
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
  const posted = siteData.setlists || [];
  const feat = posted[0];
  const css = await readText("dist/stagelight.css").catch(() => "");

  // The full run (contiguous same-venue posted shows) mirrors the build's scan.
  const runShows = [];
  for (const show of posted) {
    if (show.venue === feat?.venue && show.location === feat?.location) runShows.push(show);
    else break;
  }
  const nightShows = runShows.slice(1);

  // ---- Sticky home section nav (breadcrumbs) ----
  assertIncludes(html, '<nav class="home-nav" aria-label="Jump to a section">', "Homepage has a section nav");
  record("Section nav sits above the hero", indexOf(html, 'class="home-nav"') >= 0 && indexOf(html, 'class="home-nav"') < indexOf(html, 'id="latest-setlist"'));
  assertIncludes(html, '<a href="/#song-list" data-nav-section="song-list">Song possibilities</a>', "Section nav links to Song possibilities");
  assertIncludes(html, '<a href="/#tour-stats" data-nav-section="tour-stats">Tour stats</a>', "Section nav links to Tour stats");
  assertIncludes(html, `<a href="/#setlists" data-nav-section="setlists">${siteData.site.year} setlists</a>`, "Section nav links to the year setlists");

  // ---- Single hero: the latest posted show, no variants, no swap bento ----
  const heroCount = (html.match(/<section class="home-hero/g) || []).length;
  record("Homepage shows exactly one hero (dedicated section, not the setlist card, no bento)", heroCount === 1 && !featured.includes("data-hero-id") && !featured.includes("bento-row") && !featured.includes("night-card") && !featured.includes('class="show-entry') && !featured.includes('class="sc-chev'), `home-hero sections=${heroCount}`);

  const heroCard = featured;
  const afterHero = html.indexOf(featured) >= 0 ? html.slice(html.indexOf(featured) + featured.length) : html;
  const stripStart = afterHero.indexOf('<details class="next-strip');
  const strip = stripStart >= 0 ? afterHero.slice(stripStart, afterHero.indexOf("</details>", stripStart) + "</details>".length) : "";

  assertIncludes(heroCard, `datetime="${feat?.isoDate || ""}"`, "Hero date matches generated site data");
  assertIncludes(heroCard, `<h2 class="sc-city">${escapeHtml(displayLocation(feat?.location || ""))}</h2>`, "Hero city matches generated site data (short display form)");
  assertIncludes(heroCard, '<span class="sc-venue">', "Hero shows the venue line");
  record("Hero keeps a full-bleed blurred backdrop with one layer per view",
    heroCard.includes('<div class="hero-bg"') && heroCard.includes('hero-bg-layer is-active')
    && (!feat?.image || new RegExp(`hero-bg-layer is-active" data-view-bg="${feat.isoDate}"`).test(heroCard)),
    feat?.image || "");
  record("Hero frames the sharp photo top-right in the lockup", !feat?.image || /<figure class="hero-photo"[ >]/.test(heroCard), feat?.image || "");
  const heroOnly = heroCard.slice(heroCard.indexOf('<section class="home-hero'), heroCard.indexOf('</section>') + '</section>'.length);
  record("Hero is a section, not the collapsible setlist card", heroOnly.startsWith('<section class="home-hero') && !heroOnly.includes('class="show-entry') && !heroOnly.includes('sc-chev'), "no card chrome (the inner Song-stats <details> is fine)");
  record("Hero keeps the listen links", !feat?.streamUrl || heroCard.includes("nugs.net"));

  // ---- The setlist lives in the hero (labels + segues; active view only) ----
  const musicSlotStart = heroOnly.indexOf('hero-music-slot');
  const musicActiveStart = heroOnly.indexOf('<div class="hv is-active"', musicSlotStart);
  const musicNextView = heroOnly.indexOf('<div class="hv"', musicActiveStart + 1);
  const activeMusic = heroOnly.slice(musicActiveStart, musicNextView > 0 ? musicNextView : undefined);
  const renderedLabels = [...activeMusic.matchAll(/<div class="sc-row"><span class="sc-label">([^<]+)<\/span><p class="sc-prose">/g)].map((match) => decodeHtml(match[1]));
  const sourceSets = (feat?.sets || []).filter((set) => (set.songTitles || []).length || (set.songs || "").trim());
  const sourceSegueCount = sum(sourceSets.map((set) => (set.songs.match(/\s>\s/g) || []).length));
  const renderedSegueCount = (heroCard.match(/&gt;/g) || []).length;
  record("Hero setlist preserves every source segue", sourceSegueCount > 0 && renderedSegueCount >= sourceSegueCount, `source=${sourceSegueCount} rendered=${renderedSegueCount}`);
  const sourceLabels = sourceSets.map((set) => set.label === "1" ? "Set 1" : set.label === "2" ? "Set 2" : /^E$/i.test(set.label) ? "Encore" : set.label);
  record("Hero renders one line for every set", arraysEqual(renderedLabels, sourceLabels), `${renderedLabels.join(", ")} vs ${sourceLabels.join(", ")}`);

  // ---- Right-rail: ticker + run-night cards + upcoming card + all-setlists ----
  record("Hero right rail carries the highlights ticker with a doubled crawl track",
    heroOnly.includes('class="hero-ticker"') && heroOnly.includes('class="tk-track"'), "hero-ticker present");
  const runNights = (siteData.setlists || []).slice(1).filter((entry) => entry.venue === feat?.venue && entry.location === feat?.location);
  for (const night of runNights) {
    assertIncludes(heroOnly, `data-view="${night.isoDate}"`, `Hero carries a full view for run night ${night.isoDate}`);
    assertIncludes(html, `id="setlist-${night.isoDate}"`, `Feed card carries the #setlist-${night.isoDate} anchor`);
  }
  record("Cards are flat glass (photo backdrops reverted per owner)", !/data-view-btn="[^"]+"[^>]*style="background-image/.test(heroOnly), "no card background-image");
  record("Rail is three fixed slots (two context + upcoming pinned last), no pinned-latest card",
    heroOnly.includes('data-card-slot="a"') && heroOnly.includes('data-card-slot="b"') && !heroOnly.includes('data-card-slot="latest"') && heroOnly.includes("hero-card-upcoming") && heroOnly.includes('id="hero-card-meta"'),
    "slots a/b + upcoming + card meta present, latest slot gone");
  // Rail context = the two posted shows immediately preceding the active (default:
  // featured) view chronologically, run-mates INCLUDED (owner decision 2026-07-22).
  // Default markup is active-on-featured, so slots a/b = posted[1] + posted[2].
  const expectedContext = (siteData.setlists || []).slice(1, 3).map((entry) => entry.isoDate);
  const slotIsos = [...heroOnly.matchAll(/data-card-slot="[ab]"[^>]*data-view-btn="([^"]+)"/g)].map((m) => m[1]);
  record("Rail context rows are the two shows immediately preceding the featured view",
    slotIsos.length === expectedContext.length && slotIsos.every((iso, i) => iso === expectedContext[i]),
    JSON.stringify({ slotIsos, expectedContext }));
  // History context rows are flat (.hero-row), the pinned upcoming stays a full dashed bento card.
  const contextRowsFlat = [...heroOnly.matchAll(/data-card-slot="[ab]"/g)].length === 2
    && (heroOnly.match(/class="hero-card hero-row"/g) || []).length === 2;
  record("Rail context rows carry the flat hero-row class (not a permanent card)", contextRowsFlat,
    (heroOnly.match(/class="hero-card hero-row"/g) || []).length + " flat rows");
  record("Pinned upcoming card keeps its full dashed bento treatment (not a flat row)",
    /class="hero-card hero-card-upcoming"/.test(heroOnly) && !/hero-card-upcoming[^>]*hero-row/.test(heroOnly)
    && css.includes("body.stagelight .hero-card-upcoming { border-style: dashed"),
    "hero-card-upcoming full card present");
  // No Photos chip in the hero — it moved to the quiet "Show photos" tertiary link.
  record("Hero drops the outlined Photos chip in favor of a quiet Show photos link",
    !heroOnly.includes(">Photos</a>") && (!feat?.sourceUrl || heroOnly.includes("Show photos")),
    feat?.sourceUrl ? "Show photos link expected" : "no sourceUrl on featured");
  record("Hero Show photos tertiary link uses the featured show's source URL when present",
    !feat?.sourceUrl || heroOnly.includes(`class="link-quiet sc-photos-link" href="${escapeHtml(feat.sourceUrl)}"`),
    feat?.sourceUrl || "no sourceUrl");
  // Framed bento photo (owner rejected the flush-top / right-bleed / left-blur
   // treatment): radius + border restored, left-edge mask + bleed margins gone.
  record("Hero photo is a framed bento (radius + border), no left-edge mask or bleed",
    /body\.stagelight \.hero-photo \{[^}]*border-radius: var\(--sl-r-md\)[^}]*border: 1px solid var\(--sl-line\)/.test(css)
    && !/mask-image: linear-gradient\(90deg, transparent 0, #000 24px\)/.test(css)
    && !/hero-media-slot \{[^}]*margin-right: calc\(-1 \* var\(--hero-pad\)\)/.test(css),
    "framed photo, no mask/bleed");
  record("Tinted paint stroke still supplies the left column atmosphere",
    css.includes(".hero-brush") && heroOnly.includes('class="hero-brush"')
    && css.includes("--hero-glow-strong") && html.includes("--hero-glow-strong"));
  record("Date pager has working prev/next wiring, wraps, and shows no count",
    heroOnly.includes("data-page-prev") && heroOnly.includes("data-page-next") && !heroOnly.includes("hero-page-count")
    && html.includes('[data-page-prev]') && html.includes("% order.length"),
    "pager buttons + wrap-around handler present, count removed");
  record("Hero right rail closes with the quiet all-setlists link",
    heroOnly.includes('class="link-quiet hero-all"') && heroOnly.includes(`All ${siteData.site.year} setlists`), "link-quiet hero-all present");
  record("Song stats expands in place: trigger button + per-view panel with rarity symbols + shimmer ring",
    heroOnly.includes("data-stats-open") && new RegExp(`id="hero-stats-panel-${feat?.isoDate}"`).test(heroOnly) && heroOnly.includes('class="hero-media"')
    && heroOnly.includes('class="ltp-list"') && /hero-stats-panel[\s\S]*?rarity-symbol/.test(heroOnly) && heroOnly.includes('class="hsb-ring"'),
    "stats button + in-place panel + rarity symbols + ring present");
  const preview = siteData.site?.isShowDayPreview ? siteData.site.featuredShow : null;
  const upcoming = preview || (siteData.tourDates || []).find((entry) => !entry.isPosted && entry.isoDate > (feat?.isoDate || ""));
  if (upcoming) {
    record("Upcoming show appears as a card in the hero right rail", heroOnly.includes("hero-card-upcoming"), upcoming.isoDate || "");
    assertIncludes(heroOnly, `datetime="${upcoming.isoDate || ""}"`, "Upcoming card shows the next scheduled date");
    if (preview) {
      record("Upcoming card flags tonight's live show", heroOnly.includes("ns-flag is-tonight"), upcoming.isoDate || "");
    } else {
      record("Upcoming card flags the next scheduled show", heroOnly.includes('class="ns-flag"') && !heroOnly.includes("is-tonight"), upcoming.isoDate || "");
    }
  }
  record("Upcoming view features the official stream links (nugs / Twitch / YouTube)",
    heroOnly.includes("https://nugs.net/widespreadpanic") && heroOnly.includes("https://twitch.tv/widespreadpanichq") && heroOnly.includes("youtube.com/user/WidespreadPanicMusic"),
    "official stream links present");
  record("Twitch appears only as the official widespreadpanichq channel", !html.replace(/twitch\.tv\/widespreadpanichq/g, "").includes("twitch.tv"), "no stray twitch links");

  // ---- Old hero-swap / bento scaffolding is fully gone ----
  record(
    "Hero has no retired heading, variants, or swap bento",
    !featured.includes("latest-heading") && !featured.includes("Latest show") && !featured.includes('class="section-heading"') && !featured.includes("hero-shell") && !featured.includes("hero-variant") && !featured.includes("bento-row")
  );

  // ---- Every posted show is in the feed, featured included (Alex round 6):
  // the newest leads full-width when the count is odd ----
  const runArchive = sectionHtml(html, "setlists");
  record("Featured show appears in the feed as a card",
    new RegExp(`id="setlist-${feat?.isoDate}"`).test(runArchive), feat?.isoDate || "");
  record("Odd feed count promotes the newest card to the full-width lead",
    (siteData.setlists.length % 2 === 0) || runArchive.includes('class="show-entry is-lead'), `${siteData.setlists.length} posted`);
  for (const show of nightShows) {
    const runHeading = `${show.date || ""} ${show.venue || ""}, ${displayLocation(show.location || "")}`;
    record(`Run night ${show.isoDate} flows back into the setlist feed`, Boolean(cardHtml(runArchive, escapeHtml(runHeading))), runHeading);
  }

  // ---- Sticky nav CSS: rides up with the header on scroll-down ----
  const styles = await readText("dist/styles.css");
  record("Section nav is fixed under the site header and hidden by default (no reserved space)",
    /\.home-nav \{[^}]*position: fixed[^}]*top: 66px[^}]*opacity: 0[^}]*pointer-events: none/.test(styles)
    && /body\.stagelight \{ --sl-breadcrumb-h: 0px; \}/.test(styles));
  record("Section nav reveals once scrolled past the hero (crumb-on) and rides to top:0 when the header hides",
    /body\.stagelight\.crumb-on \.home-nav \{ opacity: 1; transform: none; pointer-events: auto; \}/.test(styles)
    && /body\.stagelight\.nav-hidden \.home-nav \{ top: 0; \}/.test(styles)
    && /classList\.toggle\("crumb-on", y > 400\)/.test(html));
  record("Section nav highlights the active section", html.includes('data-nav-section') && html.includes('.home-nav') && html.includes('IntersectionObserver'));
  record("Latest-show hero keeps its blurred backdrop when open", /\.show-entry\.is-latest\[open\] \.sc-bg img \{[^}]*blur\(/.test(styles));
  const imageRule = styles.match(/\.setlist-image img\s*\{([^}]*)\}/)?.[1] || "";
  record("Setlist photography preserves its natural landscape frame", /height:\s*auto;/.test(imageRule) && /object-fit:\s*contain;/.test(imageRule) && !/object-fit:\s*cover;|aspect-ratio:/.test(imageRule));
  record("Setlist entries are unframed", /\.setlist-card\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/.test(styles));
  const archive = sectionHtml(html, "setlists");
  assertIncludes(archive, '<details class="setlist-archive-panel" open>', "Older setlists remain visible on desktop");
  assertIncludes(archive, "VIEW OLDER SETLISTS", "Older setlists have one clear mobile disclosure");
  assertIncludes(archive, 'class="setlist-list"', "Older shows use the compact show-index layout");
  assertIncludes(archive, 'aria-label="Listen to', "Shows with audio expose a simple listening action");
  record("Every posted show is individually expandable in the feed", (archive.match(/<details class="show-entry[^"]*"/g) || []).length === siteData.setlists.length);
  assertIncludes(html, 'row.classList.toggle("is-selected-show"', "Selected-show songs receive a dedicated highlight state");
  assertIncludes(html, 'rightSelected - leftSelected', "Selected-show songs move ahead of the remaining tour table");
  record("Mobile initialization collapses the older setlist archive (Dork stats no longer an accordion)", html.includes('.setlist-archive-panel").forEach((panel) => panel.removeAttribute("open"))'));
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

  const playa = cardHtml(homeHtml, "01/23/2026 Hard Rock Hotel Riviera Maya, Riviera Maya, MX");
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

  // Owner rework: the old pill/chip status toggles (This tour / Shelf / Purgatory) are
  // REPLACED by two custom-select dropdowns — a STATUS select (All songs default /
  // this tour / The Shelf / Purgatory) and a RARITY select (All rarities default /
  // every tier). Type stays a 3-button group. Both dropdowns reuse the sitewide
  // [data-cs] custom-select. The rows carry the data-* axes the filters + sort read.
  assertIncludes(index, 'class="index-toolbar"', "Song Index exposes the filter toolbar");
  for (const type of ["all", "original", "cover"]) assertIncludes(index, `data-type-filter="${type}"`, `Song Index offers the ${type} type filter`);
  assertNotIncludes(index, "data-tour-filter", "Song Index drops the old This-tour pill toggle");
  assertNotIncludes(index, "data-shelf-filter", "Song Index drops the old Shelf pill toggle");
  assertNotIncludes(index, "data-purgatory-filter", "Song Index drops the old Purgatory pill toggle");
  assertNotIncludes(index, "data-bestguess-filter", "Song Index drops the old Best-Guess toggle");
  record("Song Index STATUS is a custom-select dropdown defaulting to All songs",
    /data-cs data-cs-managed data-status-filter data-value=""/.test(index)
    && index.includes('data-cs-value>All songs<')
    && index.includes('data-value="tour">') && index.includes('data-value="shelf">') && index.includes('data-value="purgatory">'),
    "data-status-filter custom-select present with All songs default + tour/shelf/purgatory options");
  // Rarity is ONE checkbox, not an eight-option menu (Alex 7/22: kill the pill
  // overload — the Rarity column already sorts). Unchecked by default.
  record("Song Index RARITY is a single unchecked 'Rare and up' checkbox, not a dropdown",
    /<label class="index-check"><input type="checkbox" data-rare-filter> Rare and up<\/label>/.test(index)
    && !index.includes("data-rarity-filter")
    && !index.includes("All rarities"),
    "data-rare-filter checkbox present and the tier dropdown is gone");
  record("Song Index rarity checkbox filters the rare tiers and nothing else",
    /RARE_TIERS = \["rare", "ultra", "hyper", "bustout", "mega"\]/.test(index)
    && /!rareOnly \|\| RARE_TIERS\.includes\(row\.dataset\.rarityTier\)/.test(index),
    "rareOnly gate reads the row's rarity tier against the rare set");
  record("Song Index rows carry the filter + sort data-* attributes",
    /class="song-row-wrap"[^>]*data-type="[^"]*"[^>]*data-tour="(?:yes|no)"[^>]*data-tier="[a-z]+"[^>]*data-status="[0-2]"[^>]*data-rarity="-?\d+"[^>]*data-rarity-tier="[a-z]*"[^>]*data-plays="\d+"/.test(index),
    "song-row-wrap carries data-type/data-tour/data-tier/data-status/data-rarity/data-rarity-tier/data-plays");

  // Owner QA fixes on the Song Index.
  const songIndexCss = await readText("dist/stagelight.css").catch(() => "");

  // FIX 2 — sticky column-header row aligned to the row grid. The header and every
  // row share one --sr-cols template, and the header is sticky under the search bar.
  record("Song Index renders the column-header row (Title/Type/Status/Rarity/Links/Plays)",
    index.includes('class="song-index-head"') && (index.match(/class="sih-col[^"]*"/g) || []).length === 6
    && index.includes('data-sort="status" aria-sort="none">Status ')
    && index.includes('data-sort="rarity" aria-sort="none">Rarity ')
    && !index.includes('sih-tour')
    && index.includes('class="sih-col sih-more">Links<'),
    "song-index-head with six cells: Title/Type/Status/Rarity/Links/Plays (More renamed Links)");
  // Owner rework: every column header is a sort button (mirrors the Lyrics & Chords hub),
  // Title A-Z is the default (aria-sort=ascending), and the LINKS column is a plain label.
  record("Song Index column headers are sort buttons with Title as the A-Z default",
    index.includes('data-sort="title" aria-sort="ascending">Title ')
    && ["title", "type", "status", "rarity", "plays"].every((key) => index.includes(`data-sort="${key}"`))
    && !/data-sort="(?:more|links)"/.test(index),
    "five sortable headers (Title default ascending); Links stays a non-sortable label");
  record("Song Index sort buttons carry the sih-sort styling hook",
    /body\.stagelight button\.sih-sort \{/.test(songIndexCss),
    "button.sih-sort has a CSS home");
  // Owner QA: the LINKS chips share the header's left edge — the header and the row
  // wrapper both carry the same horizontal padding so the grid tracks line up.
  record("Song Index aligns the Links chips left with the header (shared padding)",
    /body\.stagelight \.song-row-wrap \{[^}]*padding: 0 10px/.test(songIndexCss)
    && /body\.stagelight \.song-row \{[^}]*padding: 14px 0/.test(songIndexCss),
    "song-row-wrap and song-index-head share horizontal padding; row content sits flush");
  // The blanket `main > *:not(...)` rule (position:relative, higher specificity) out-specifies
  // the plain .song-search / .song-index-head sticky rules and flattens them to relative — the
  // top offsets then displace them and they overlap/ghost. A matching-specificity explicit
  // selector re-asserts sticky WITHOUT touching the blanket. Guard it so the fix can't vanish.
  record("Song Index sticky stack is re-asserted above the blanket position:relative rule",
    /body\.stagelight main\.archive-main\.songs-main > \.song-search[\s\S]{0,220}position: sticky/.test(songIndexCss)
    && /body\.stagelight main\.archive-main\.songs-main > \.song-index-head/.test(songIndexCss)
    && /body\.stagelight main\.archive-main\.songs-main > \.lyric-head/.test(songIndexCss),
    "explicit main.archive-main.songs-main sticky repair present for search + column heads");
  // Athens strip rework: SOLID WHITE line fill + a brand-color tie-dye clipped to the LEFT
  // CORNER (first letters) only, using coral/teal/gold and NO magenta, seated on the footer,
  // sliding up from behind the footer line on scroll. Guard the white fill (0.92, not the old
  // 0.14 quiet ink), the corner brand palette, the absence of magenta, and the drift keyframes.
  record("Athens strip uses the solid-white line fill + left-corner brand tie-dye (coral/teal/gold, no magenta)",
    /@keyframes athens-tiedye/.test(songIndexCss)
    && /body\.stagelight \.athens-strip span \{[\s\S]{0,460}rgba\(242,242,240,0\.92\)[\s\S]{0,200}background-clip: text/.test(songIndexCss)
    && /body\.stagelight \.athens-strip span \{[\s\S]{0,460}#d4514f/.test(songIndexCss)
    && /body\.stagelight \.athens-strip span \{[\s\S]{0,460}rgba\(96,165,210,1\)/.test(songIndexCss)
    && /body\.stagelight \.athens-strip span \{[\s\S]{0,460}#c9a35f/.test(songIndexCss)
    && !/body\.stagelight \.athens-strip span \{[\s\S]{0,460}#c65db8/.test(songIndexCss),
    "athens-strip span carries the solid-white + corner brand tie-dye fill, no magenta, drift keyframes");
  // The JS slide-up was replaced 2026-07-23 with a scroll-driven CSS reveal: the
  // line wipes on like a stage light and the footer unrolls downward from it. The
  // point of the rewrite is the failure mode — a JS reveal must HIDE the footer and
  // trust a later event to restore it, and if that event never fires the footer is
  // invisible on every page (the preview pane, which throttles timers, observers and
  // rAF, could not verify it fired). Scroll-driven animation degrades to the finished
  // state instead. Assert BOTH the motion and, crucially, that nothing hides the
  // footer outside the @supports/no-reduced-motion guard.
  record("Athens reveal is scroll-driven CSS with no JS and no way to leave the footer hidden",
    /@supports \(animation-timeline: view\(\)\)/.test(songIndexCss)
    && /animation-timeline: view\(\)/.test(songIndexCss)
    && /@keyframes sl-athens-sweep/.test(songIndexCss)
    && /@keyframes sl-foot-unroll/.test(songIndexCss)
    && /@keyframes sl-foot-settle/.test(songIndexCss)
    && !songIndexCss.includes("athens-strip.will-reveal")
    // every hiding declaration must live inside the @supports + no-preference block
    && !/^body\.stagelight \.site-foot-inner \{[^}]*clip-path: inset\(0 0 100%/m.test(songIndexCss)
    && /body\.stagelight \.site-foot \{[^}]*margin-top: 0/.test(songIndexCss),
    "scroll-driven sweep + unroll keyframes present, no JS reveal classes, nothing hides the footer unconditionally");
  record("Athens line is oversized and cropped by its own band, never the page",
    /\.athens-strip span \{[\s\S]{0,200}font-size: clamp\(38px, 7\.3vw, 190px\)/.test(songIndexCss)
    && /body\.stagelight \.athens-strip \{[^}]*overflow: hidden/.test(songIndexCss),
    "oversized clamp with the band clipping the overhang (no horizontal page scroll)");
  record("Song Index header + rows share one grid template",
    /body\.stagelight \.songs-main \{[^}]*--sr-cols:/.test(songIndexCss)
    && /body\.stagelight \.song-index-head \{[^}]*grid-template-columns: var\(--sr-cols\)/.test(songIndexCss)
    && /body\.stagelight \.song-row \{[^}]*grid-template-columns: var\(--sr-cols\)/.test(songIndexCss),
    "--sr-cols drives .song-index-head and .song-row");
  record("Song Index column-header row is sticky",
    /body\.stagelight \.song-index-head \{[^}]*position: sticky/.test(songIndexCss),
    "song-index-head is position:sticky");

  // Feature 1 — per-row resource links (Origin / Lyrics / Tab). The row is one big
  // <a>, so these MUST be REAL sibling anchors (nested anchors are invalid HTML),
  // living in the reserved .sr-resources column, each independently tabbable with an
  // aria-label. Origin + Lyrics light up on a data join; Tab (Songsterr) is universal.
  const originChipCount = (index.match(/class="sr-chip" href="\/song-origins\//g) || []).length;
  record("Song Index rows expose Song Origin resource links (30+)", originChipCount >= 30, `${originChipCount} rows link a song origin`);
  const lyricsChipCount = (index.match(/aria-label="[^"]*lyrics and chords"/g) || []).length;
  record("Song Index rows expose lyrics/chords resource links", lyricsChipCount >= 1, `${lyricsChipCount} rows link a lyrics/chords page`);
  // Chords chips deep-link the song's own Everyday Companion page. Songsterr SEARCH
  // links were removed sitewide 7/23 (Alex: half-way links are worse than nothing).
  const chordChipCount = (index.match(/aria-label="[^"]*chords on Everyday Companion"/g) || []).length;
  record("Song Index rows expose Everyday Companion chords links (500+)", chordChipCount >= 500, `${chordChipCount} rows link EC chords`);
  record("Song Index resource links are real, separate anchors (not nested inside the row link)",
    index.includes('class="sr-resources"><a class="sr-chip')
    && !/<a class="song-row"[^>]*>(?:(?!<\/a>)[\s\S])*?<a\b/.test(index),
    "the .song-row anchor closes before the sibling .sr-resources links");
  record("Song Index chords link opens in a new tab safely and carries an aria-label",
    /class="sr-chip sr-chip-ext" href="https:\/\/everydaycompanion\.com\/[^"]*\.asp" target="_blank" rel="noopener noreferrer" aria-label="/.test(index),
    "sr-chip-ext has target=_blank + rel=noopener + aria-label");
  record("Song Index resource column has a CSS home and hides on mobile",
    /body\.stagelight \.sr-resources \{[^}]*grid-column: 5/.test(songIndexCss)
    && /@media \(max-width: 640px\)[\s\S]*?body\.stagelight \.sr-resources \{ display: none/.test(songIndexCss),
    "sr-resources sits in the reserved column (5) and is hidden <=640px");

  // The Best Guess concept is retired from the Song Index: no jargon chip and no
  // row-level badge (Alex: "that's dumb" / remove Best Guess entirely).
  assertNotIncludes(index, "Transcribed lyrics", "Song Index drops the Transcribed-lyrics chip");
  assertNotIncludes(index, "Has Best Guess", "Song Index drops the Has-Best-Guess jargon label");
  assertNotIncludes(index, 'class="sr-bestguess"', "Song Index drops the row-level Best Guess badge");

  // STATUS and RARITY are now two separate columns (owner feedback). STATUS is the
  // board state pill (In Rotation / Shelf / Purgatory); RARITY is the frequency tier,
  // shown only for In-Rotation songs (Shelf/Purgatory suppress it as a muted dash so a
  // parked song never reads as rare-when-played). Rows carry data-tier = board slug.
  const shelfBoard = [...(siteData.boards?.shelfOriginals || []), ...(siteData.boards?.shelfCovers || [])];
  const purgBoard = [...(siteData.boards?.purgatoryOriginals || []), ...(siteData.boards?.purgatoryCovers || [])];
  record("Song Index STATUS and RARITY are two distinct columns",
    index.includes('class="sr-status-cell">') && index.includes('class="sr-rarity">')
    && !index.includes('class="sr-tour">'),
    "sr-status-cell / sr-rarity cells present; sr-tour column removed");
  const rotationTierCount = (index.match(/data-tier="rotation"/g) || []).length;
  record("Song Index marks in-rotation songs with data-tier=rotation and an In Rotation label",
    rotationTierCount >= 1 && index.includes('class="sr-status sr-status-rotation">In Rotation<'),
    `${rotationTierCount} in-rotation rows`);
  const shelfTierCount = (index.match(/data-tier="shelf"/g) || []).length;
  record("Song Index marks shelved songs with data-tier=shelf and a Shelf label",
    shelfTierCount >= 1 && index.includes('class="sr-status sr-status-shelf">Shelf<'),
    `${shelfTierCount} shelf rows`);
  if (purgBoard.length > 0) {
    const purgTierCount = (index.match(/data-tier="purgatory"/g) || []).length;
    record("Song Index marks purgatory songs with data-tier=purgatory and a Purgatory label",
      purgTierCount >= 1 && index.includes('class="sr-status sr-status-purgatory">Purgatory<'),
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

  // Every song page must offer the Everyday Companion chip, deep-linked to that
  // song's own EC page. The Songsterr SEARCH chip was removed 7/23 (Alex: half-way
  // links are worse than nothing) — assert its absence at equal strength.
  const missingEc = pages.filter((page) => !/class="learn-chip[^"]*"[^>]*>Everyday Companion/.test(page.html));
  const missingSongsterr = pages.filter((page) => page.html.includes("Songsterr"));
  record("Every song page carries the Everyday Companion chip", missingEc.length === 0, missingEc.slice(0, 5).map((p) => p.filePath).join("\n"));
  record("No song page carries a Songsterr search chip", missingSongsterr.length === 0, missingSongsterr.slice(0, 5).map((p) => p.filePath).join("\n"));

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
  const expectedMega = ["Home", "Song Possibilities", "Song Index", "Tour Stats", `${siteData.site.year} Setlists`, "Albums", "Lyrics & Chords", "Song Origins", "Rumors", "Tour In Review", "The Shelf", "About"];
  // Footer is now grouped into three labeled columns; every legacy destination
  // remains present (Privacy moved to the bottom bar, asserted separately).
  const expectedColumnLabels = ["Live", "Songbook", "The Sheet"];
  const expectedFooter = [`${siteData.site.year} Setlists`, "Tour In Review", "FAQ", "Rumors", "Song Index", "Albums", "Lyrics & Chords", "Song Origins", "Song List", "The Shelf", "About"];
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
  assertIncludes(html, "Burnthday's Panic Spread Sheet", "Footer keeps the Spread Sheet identity line");
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
  // Deck is Alex's own line, carried over from the legacy page's "what the boys had
  // cooking up on tour" opener. Guard still proves the page uses his words, not
  // invented product copy; it just tracks the phrase he actually kept.
  record("Tour In Review deck keeps Alex's own legacy phrasing", /what the boys had cooking/i.test(tourText));
  record("Shelf page uses imported shelf copy", /The Shelf/i.test(shelfText) && /Purgatory/i.test(shelfText));
  record("Privacy page accurately identifies GA4", /Google Analytics 4/.test(privacyText) && /does not sell personal information/.test(privacyText));
  record("Privacy page links to Google privacy and opt-out controls", /https:\/\/policies\.google\.com\/privacy/.test(privacy) && /https:\/\/tools\.google\.com\/dlpage\/gaoptout/.test(privacy));
  assertIncludes(shelf, `<h2>New to the Shelf</h2>`, "Shelf page leads with the current seasonal additions");
  record("Shelf page omits duplicate live counters", !/on The Shelf<\/span>|in Purgatory<\/span>|show cutoff<\/span>/.test(shelf));

  // Dated Shelf updates moved off the main page onto their own archive page. The main
  // page must NOT carry any dated update; the archive page must carry them all, verbatim
  // and reverse-chronological, with the standard page chrome and one quiet link back.
  const shelfUpdates = await readText("dist/shelf/updates/index.html").catch(() => "");
  const shelfUpdatesText = normalizeText(stripTags(shelfUpdates));
  record("Main Shelf page no longer carries the dated Shelf updates",
    !/Shelf Updated:/.test(shelfText) && !/Previous Shelf Updates/.test(shelf) && !/there's certainly a method to their madness/i.test(shelfText),
    "a dated update or the legacy notes block is still on the main Shelf page");
  record("Main Shelf page links out to the updates archive with the site's quiet-link pattern",
    /class="link-quiet" href="\/shelf\/updates\/">Browse previous Shelf updates/.test(shelf),
    "the quiet Browse-previous-updates link is missing");
  record("The Shelf updates archive page exists and preserves the dated updates verbatim, newest first",
    Boolean(shelfUpdates)
      && /there's certainly a method to their madness/i.test(shelfUpdatesText)
      && (shelfUpdates.match(/Shelf Updated:/g) || []).length >= 3
      && indexOf(shelfUpdatesText, "The Shelf Updated: April 1st, 2019") < indexOf(shelfUpdatesText, "The Shelf Updated: January 24th, 2012"),
    "updates archive missing, incomplete, or out of reverse-chronological order");
  record("The Shelf updates archive inherits the standard page chrome (nav, breadcrumb, footer)",
    shelfUpdates.includes('class="stagelight"') && shelfUpdates.includes('id="mega-menu"') && /class="crumbs"/.test(shelfUpdates) && /<a href="\/shelf\/">The Shelf<\/a>/.test(shelfUpdates),
    "updates archive is missing shared chrome or the Shelf breadcrumb");
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
    const start = indexOf(shelf, "New to the Shelf</h2>");
    const end = indexOf(shelf, "<h2>Longest gone</h2>");
    return start >= 0 && end > start ? shelf.slice(start, end) : "";
  })();
  record("Shelf page's computed additions are rows, not a bare bullet list",
    Boolean(additionsBlock) && additionsBlock.includes('class="shelf-row"') && !additionsBlock.includes("<li>"),
    "the New Additions block still renders <li> bullets");
  record("The Shelf updates archive keeps Alex's seasonal notes verbatim",
    /there's certainly a method to their madness/i.test(shelfUpdatesText),
    "distinctive verbatim shelf-notes phrase missing from the updates archive");
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

  // The unified Song Origins header replaces the static ~200px knockout PNG with
  // the living A-frame: synthetic starfield canvas BEHIND the sky-knocked-out
  // plate (true alpha), whisper candle-flame + moon-glint fx canvas above. The
  // plate is a FILE reference; the compact dot table is inlined into this one page.
  const soCss = await readText("dist/stagelight.css").catch(() => "");
  record("Song Origins header ships the living A-frame poster in place of the static knockout img",
    /class="ph-poster is-living"/.test(indexHtml)
    && /class="living-poster lp-aframe" data-living="lp\d+"/.test(indexHtml)
    && indexHtml.includes('class="lp-layer lp-starfield"')
    && indexHtml.includes('class="lp-layer lp-plate" alt="" src="/assets/living/song-origins-plate.webp"')
    && indexHtml.includes('class="lp-layer lp-fx"')
    && !/class="ph-poster"[^>]*>\s*<span class="ph-halo"[^>]*>\s*<picture>/.test(indexHtml),
    "living aframe stack present, static picture replaced");
  record("Song Origins living plate stays a file reference, not an inline data URI",
    !/lp-plate[^>]*src="data:/.test(indexHtml),
    "no inline plate data URI on song-origins");
  record("Song Origins living runtime has rAF + timeout fallback and a reduced-motion still",
    indexHtml.includes("requestAnimationFrame") && indexHtml.includes("setTimeout(boot")
    && /prefers-reduced-motion/.test(indexHtml),
    "aframe runtime animation-safe");
  record("Song Origins living header float is disabled under reduced motion",
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ph-poster\.is-living \.living-poster[\s\S]*?animation: none/.test(soCss),
    "reduced-motion kills the header float");

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
  // Intent is the CREDIT, not one phrasing — the deck is Alex's copy and can be
  // reworded. Guard on the attribution surviving, not the exact sentence.
  record("Lyrics & Chords hub credits Everyday Companion for untranscribed songs",
    /links? out to Everyday Companion/.test(hub), "hub must credit EC for untranscribed songs");

  // PART 3: the redundant hub eyebrow (duplicate of the H1 + breadcrumb crumb) is
  // gone. It stays on the categorizing lyric SUBPAGES (checked below).
  record("Lyrics & Chords hub drops the redundant LYRICS & CHORDS eyebrow", !hub.includes('class="archive-eyebrow">LYRICS &amp; CHORDS'), "hub eyebrow should be removed");

  // Internal-transcription rows carry the badge AND link a real dist file; EC rows
  // point at everydaycompanion.com (verified deep link or safe homepage fallback —
  // never a guessed 404). Assert both populations exist and resolve correctly.
  const internalCount = (hub.match(/data-transcription="yes"/g) || []).length;
  record("Lyrics & Chords hub badges internal transcriptions", internalCount > 0, `${internalCount} Burnthday-transcription rows`);
  // Content-type indicator: internal rows show LYRICS + CHORDS when a chord/tab page
  // exists for the song, else LYRICS. Both populations must be present.
  const chordKind = (hub.match(/class="lr-words">Lyrics \+ chords</g) || []).length;
  const lyricsOnlyKind = (hub.match(/class="lr-words">Lyrics<\/span>/g) || []).length;
  record("Lyrics hub rows carry no source-name pills", !/lr-badge/.test(hub) && !/Burnthday transcription/.test(hub), "source pills should be gone");
  // Header row: six columns — SONG | ARTIST | ALBUM | LYRICS | TAB | PLAYS — with the
  // sortable ones rendered as buttons (SONG, ARTIST, LYRICS, TAB, PLAYS = 5 sort keys).
  record("Lyrics hub renders a sticky six-column header row", /class="lyric-head"/.test(hub) && (hub.match(/class="lh-col/g) || []).length === 6, "lyric-head with 6 columns");
  const sortButtons = (hub.match(/class="lh-col lh-sort[^"]*" data-sort="[^"]+"/g) || []);
  record("Lyrics hub column headers are sortable buttons", sortButtons.length === 5, `${sortButtons.length} sortable headers (expect SONG/ARTIST/LYRICS/TAB/PLAYS)`);
  for (const key of ["title", "artist", "transcription", "hastab", "plays"]) {
    assertIncludes(hub, `data-sort="${key}"`, `Lyrics hub offers the ${key} column sort`);
  }
  // LYRICS and TAB columns are adjacent (the Lyrics sort header immediately precedes
  // the Tab sort header in the head row).
  record("Lyrics hub places the LYRICS and TAB columns adjacent",
    indexOf(hub, 'data-sort="transcription"') < indexOf(hub, 'data-sort="hastab"')
      && indexOf(hub, 'data-sort="hastab"') < indexOf(hub, 'data-sort="plays"'),
    "Lyrics header must sit immediately before Tab, before Plays");
  record("Lyrics & Chords hub shows the LYRICS + CHORDS content-type indicator", chordKind > 0, `${chordKind} rows marked Lyrics + Chords`);
  record("Lyrics & Chords hub shows the LYRICS content-type indicator", lyricsOnlyKind > 0, `${lyricsOnlyKind} rows marked Lyrics-only`);
  record("Every internal row carries a content-type indicator", chordKind + lyricsOnlyKind === internalCount, `${chordKind + lyricsOnlyKind} indicators vs ${internalCount} internal rows`);
  // Facets/sort keys ride on the wrapper now; internal rows (data-transcription="yes")
  // link a real archive page, EC rows (data-transcription="no") open everydaycompanion.com.
  const internalRows = [...hub.matchAll(/<div class="lyric-row-wrap"[^>]*data-transcription="yes"[^>]*>\s*<a class="lyric-row" href="([^"]+)"/g)].map((m) => m[1]);
  record("Every internal transcription row links a real archive page in dist", internalRows.length > 0 && internalRows.every((href) => files.some((f) => f.endsWith(href.replace(/^\//, "").split("/").join(path.sep)))), `${internalRows.length} internal rows checked`);
  const ecRows = [...hub.matchAll(/<div class="lyric-row-wrap"[^>]*data-transcription="no"[^>]*>\s*<a class="lyric-row" href="([^"]+)"[^>]*target="_blank"/g)].map((m) => m[1]);
  record("Lyrics & Chords hub sends EC rows to everydaycompanion.com", ecRows.length > 0 && ecRows.every((href) => /^https?:\/\/(?:www\.)?everydaycompanion\.com\//.test(href)), `${ecRows.length} EC rows checked`);
  // ARTIST column: only COVERS with curated origin data carry an attribution; it is a
  // real string on the wrapper (data-artist), never invented. Populated rows exist and
  // are strictly fewer than the catalog (most songs have no curated attribution).
  const artistRows = (hub.match(/data-artist="[^"]+"/g) || []).length;
  record("Lyrics hub attributes covers with curated origin data (no invented artists)", artistRows > 0 && artistRows < rowCount, `${artistRows} rows carry an artist attribution`);

  // PART 2: the multi-select filters (Type / Has transcription / Album) compose
  // with the search box; the controls are real and the rows carry the data-*.
  assertIncludes(hub, 'class="index-toolbar"', "Lyrics & Chords hub exposes the filter toolbar");
  assertNotIncludes(hub, "data-transcription-filter", "Lyrics & Chords drops the On Burnthday (source) filter");
  assertNotIncludes(hub, ">On Burnthday<", "Lyrics & Chords drops the 'On Burnthday' selector");
  assertIncludes(hub, "data-chords-filter", "Lyrics & Chords hub offers the Has chords filter");
  record("Lyrics & Chords hub Has-chords + Has-tab are real checkboxes",
    /<label class="index-check"><input type="checkbox" data-chords-filter> Has chords<\/label>/.test(hub)
    && /<label class="index-check"><input type="checkbox" data-tab-filter> Has tab<\/label>/.test(hub),
    "index-check labels wrap checkbox inputs for Has chords / Has tab");
  assertIncludes(hub, "data-album-filter", "Lyrics & Chords hub offers the album filter");
  for (const type of ["all", "original", "cover"]) assertIncludes(hub, `data-type-filter="${type}"`, `Lyrics & Chords hub offers the ${type} type filter`);
  record("Lyrics & Chords rows carry the filter + sort data-* attributes", /class="lyric-row-wrap"[^>]*data-transcription="(?:yes|no)"[^>]*data-haschords="(?:yes|no)"[^>]*data-hastab="(?:yes|no)"[^>]*data-type="[^"]*"[^>]*data-album="[^"]*"[^>]*data-plays="\d+"/.test(hub), "lyric-row-wrap data-transcription/haschords/hastab/type/album/plays present");
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
    assertNotIncludes(html, 'class="archive-eyebrow">LYRICS &amp; CHORDS', `${known.path} drops the redundant LYRICS & CHORDS eyebrow`);
    const liveHref = html.match(/class="origin-xlink" href="(\/song\/[^"]+)"/)?.[1] || "";
    const targetExists = liveHref ? files.some((f) => f.endsWith(path.join(liveHref.replace(/^\//, "").replace(/\/$/, ""), "index.html"))) : false;
    record(`${known.path} links Live history to a real /song/ page in dist`, liveHref === known.song && targetExists, `${liveHref || "no link"} → ${targetExists ? "exists" : "missing"}`);
    // The "Also on Everyday Companion" cross-reference has been removed from lyric pages.
    record(`${known.path} drops the "Also on Everyday Companion" cross-reference`, !html.includes("Also on Everyday Companion"), html.includes("Also on Everyday Companion") ? "EC cross-ref still present" : "EC cross-ref removed");
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
  record("Song detail pages drop the redundant type eyebrow", !anyMatch(`${path.sep}song${path.sep}`, /class="song-eyebrow"/), "song-eyebrow removed from /song/ pages (type still in the facts list)");
  record("Song Origin detail pages keep the SONG ORIGIN eyebrow", anyMatch(`${path.sep}song-origins${path.sep}`, /class="origin-eyebrow">SONG ORIGIN</), "origin-eyebrow present");
  record("Best Guess sections keep the BEST GUESS eyebrow", anyMatch(`${path.sep}song${path.sep}`, /class="bg-eyebrow"[^>]*>BEST GUESS</), "bg-eyebrow present");
  record("Tour In Review detail pages keep the Tour In Review eyebrow", anyMatch(`${path.sep}tour-in-review${path.sep}`, /class="tour-eyebrow">Tour In Review</), "tour-eyebrow present");
  record("Album detail pages omit the Studio Album eyebrow (removed per owner)", !anyMatch(`${path.sep}albums${path.sep}`, /class="album-eyebrow"/), "eyebrow should not render");
  // Lyric SUBPAGES keep their categorizing eyebrow (verified in checkLyricsChords too).
  record("Lyric subpages drop the redundant LYRICS & CHORDS eyebrow", !files.some((file, index) => /lyrics\.html$/.test(file) && htmlByFile[index].includes('class="archive-eyebrow">LYRICS &amp; CHORDS')), "lyric subpage eyebrow removed");

  // ---- Unified subpage header system (crumbs -> h1 -> page-deck -> hairline) ----
  // The FAQ and About headers had eyebrow stacks; they are deleted per the owner
  // rule against eyebrow+headline+subheadline stacks.
  const faqPage = htmlAt("faq/index.html");
  const aboutPage = htmlAt("about/index.html");
  record("FAQ header drops the eyebrow stack", faqPage.length > 0 && !faqPage.includes('class="faq-eyebrow"'), "faq-eyebrow must be gone");
  record("About header drops the eyebrow stack", aboutPage.length > 0 && !aboutPage.includes('class="archive-eyebrow"'), "archive-eyebrow must be gone");
  record("Song Origins index retires the off-system origin-hero header", htmlAt("song-origins/index.html").length > 0 && !htmlAt("song-origins/index.html").includes('class="origin-hero"'), "origin-hero header should be replaced by the unified header");
  record("Rumors retires the off-system page-graphic-title header", htmlAt("rumors/index.html").length > 0 && !htmlAt("rumors/index.html").includes('class="page-graphic-title"'), "page-graphic-title should be replaced by the unified header");

  // Four of the five poster subpages carry their static tour-poster <img> — the
  // knocked-out (true-alpha) art so it floats on the page with no black box behind
  // it, faded at every edge. Song Origins is the exception: its poster spot is the
  // living A-frame stack (checked at full strength in checkSongOrigins).
  // The guard checks the <img> tag itself (not any reference — the weak version
  // passed on a halo url and let a half-reverted build ship) and asserts nothing
  // paints a black backing (no halo span, no black-pool ::before marker).
  const posterPages = [
    ["faq/index.html", "about"],
    ["shelf/index.html", "the-shelf"],
    ["tour-in-review/index.html", "tour-in-review"],
    ["rumors/index.html", "rumors"]
  ];
  for (const [page, poster] of posterPages) {
    const html = htmlAt(page);
    record(`${page} carries the ${poster} knocked-out poster (floats, no black box)`,
      html.length > 0 && html.includes('class="ph-poster"')
        && html.includes(`<img src="/assets/posters/${poster}-knockout.png"`)
        && !html.includes('ph-halo'),
      `expected ph-poster <img src="/assets/posters/${poster}-knockout.png"> and no black backing`);
  }
  {
    const html = htmlAt("song-origins/index.html");
    record("song-origins/index.html upgrades its poster spot to the living A-frame plate",
      html.length > 0 && html.includes('class="ph-poster is-living"')
      && html.includes("/assets/living/song-origins-plate.webp")
      && !html.includes("song-origins-knockout"),
      "expected ph-poster is-living with the living plate, static knockout retired");
  }

  // Every subpage header uses the ONE shared deck class (the fix that stops the
  // mono-uppercase default from leaking into full deck sentences).
  const deckPages = [
    "about/index.html", "lyrics-chords/index.html", "songs/index.html", "albums/index.html",
    "archive/index.html", "faq/index.html", "rumors/index.html", "shelf/index.html",
    "tour-in-review/index.html", "song-origins/index.html", "pages/index.html"
  ];
  for (const page of deckPages) {
    const html = htmlAt(page);
    record(`${page} header uses the unified page-deck class`,
      html.length > 0 && html.includes('class="page-deck"'),
      "page-deck missing from the subpage header");
  }
  // The retired per-page deck classes must not resurface anywhere.
  const deadDeckClass = /class="(songs-deck|albums-deck|shelf-deck|tour-hub-deck|archive-hub-deck|alm-deck|faq-deck)"/;
  record("Retired per-page deck classes are gone from all pages",
    !files.some((file, index) => deadDeckClass.test(htmlByFile[index])),
    "a legacy deck class (songs-deck/albums-deck/shelf-deck/tour-hub-deck/archive-hub-deck/alm-deck/faq-deck) is still rendered");
}

function checkMarkerLegend(html, siteData) {
  const colors = ["Black", "Blue", "Green", "Red"];
  const legend = siteData.site?.markerLegend || [];
  const latestDates = [...new Set((siteData.setlists || []).map((show) => show.isoDate).filter(Boolean))].slice(0, 4);
  const matchesData = latestDates.every((isoDate, index) => {
    const item = legend[index];
    return item?.color === colors[index] && item?.isoDate === isoDate && Boolean(item?.label);
  });
  // The color key renders as four intro marker swipes (bi-swipe), each carrying
  // its show's short date; the four canon marker colors all appear as --mc values.
  const swipeCount = (html.match(/class="bi-swipe"/g) || []).length;
  const swipeColors = ["#26262b", "#465692", "#47866a", "#d4514f"].every((hex) => html.includes(`class="bi-swipe" style="--mc:${hex}`));
  const matchesHtml = legend.every((item) => html.includes(`data-date="${item.isoDate}"`)) && swipeCount === legend.length && swipeColors;
  record("Marker swipes in the board intro match the last four posted shows", matchesData && matchesHtml, JSON.stringify(legend));
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
  const perfRelistenPages = files.filter((file, index) => /class="perf"><a href="https:\/\/relisten\.net\/[^"]*"[^>]*>[\s\S]*?class="perf-listen"/.test(htmlByFile[index])).length;
  record("Song-history rows render gated Relisten Listen links", perfRelistenPages >= 1, `${perfRelistenPages} pages with perf-row Listen links`);
  const relistenOffenders = files.filter((file, index) => {
    const stripped = htmlByFile[index]
      .replace(/<a class="origin-pick-listen" href="https:\/\/relisten\.net\/[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")
      .replace(/<li class="perf"><a href="https:\/\/relisten\.net\/[^"]*"[^>]*aria-label="Listen to [^"]*"[^>]*>[\s\S]*?<\/a><\/li>/g, "")
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
      .replace(/<li class="perf"><a href="https:\/\/relisten\.net\/[^"]*"[^>]*aria-label="Listen to [^"]*"[^>]*>[\s\S]*?<\/a><\/li>/g, "")
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
  // Newsletters parked (removed from nav + site 2026-07-22). The page is no longer
  // generated and must not be linked anywhere.
  const newsletters = await readText("dist/newsletters/index.html").catch(() => "");
  record("Newsletters page is parked (not generated)", newsletters === "", "dist/newsletters/index.html absent");

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
  record("Newsletters page is absent from the sitemap (parked)",
    !sitemap.includes("https://burnthday.com/newsletters/"), "/newsletters/ correctly absent from sitemap.xml");
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
  // The Almanac is parked (hidden from the site 2026-07-22; code kept to restore).
  const almanac = await readText("dist/almanac/index.html").catch(() => "");
  record("The Almanac page is parked (not generated)", almanac === "", "dist/almanac/index.html absent");
  const sitemap = await readText("dist/sitemap.xml").catch(() => "");
  record("The Almanac is absent from the sitemap (parked)",
    !sitemap.includes("https://burnthday.com/almanac/"), "/almanac/ correctly absent from sitemap.xml");

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

  // Dynamic on purpose: the window must END at the newest posted show, whatever
  // that is — a hardcoded date here broke the first post-show sync (2026-07-23).
  const newestPosted = siteData.setlists?.[0]?.isoDate || "";
  record("Recent-window pair mining ran over the last 100 shows ending at the newest posted show",
    siteData.recentWindow && siteData.recentWindow.shows === 100
      && siteData.recentWindow.to === newestPosted
      && siteData.recentWindow.from < siteData.recentWindow.to
      && Number(siteData.recentPairCount) >= 10,
    `window=${JSON.stringify(siteData.recentWindow)} newestPosted=${newestPosted} recentPairCount=${siteData.recentPairCount}`);

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
  // The heading can also appear inside the hero's stacked views, so walk every
  // occurrence until one sits inside a real .show-entry feed card.
  let entryAnchor = html.indexOf(heading);
  while (entryAnchor >= 0) {
    const entryStart = html.lastIndexOf('<details class="show-entry', entryAnchor);
    const entryEnd = html.indexOf("</details>", entryAnchor);
    if (entryStart >= 0 && entryEnd > entryStart && html.indexOf("</details>", entryStart) >= entryAnchor) {
      return html.slice(entryStart, entryEnd + "</details>".length);
    }
    entryAnchor = html.indexOf(heading, entryAnchor + 1);
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
  record("Songs index drops the Best Guess badge", !index.includes('class="sr-bestguess"'));
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

// ---- Font loading: preloads for every critical face + metric-matched fallbacks ----
async function checkFontLoading(files, htmlByFile) {
  const preloads = [
    "geist-latin-wght-normal.woff2",
    "bricolage-grotesque-latin-wght-normal.woff2",
    "geist-mono-latin-wght-normal.woff2",
    "milkrun.woff2"
  ];
  // Every page's <head> preloads all critical variable faces.
  const missing = [];
  for (let i = 0; i < files.length; i += 1) {
    const head = htmlByFile[i].slice(0, htmlByFile[i].indexOf("</head>") + 1);
    for (const font of preloads) {
      if (!head.includes(`rel="preload" href="/assets/${font}" as="font"`)) {
        missing.push(`${path.relative(root, files[i])} :: ${font}`);
        break;
      }
    }
  }
  record("Every page preloads all critical variable font faces (geist, bricolage, geist-mono, milkrun)",
    missing.length === 0, missing.slice(0, 8).join("\n"));

  // Both stylesheets ship the metric-matched fallback faces + font-display: swap.
  for (const sheet of ["styles.css", "stagelight.css"]) {
    const css = await readText(`dist/${sheet}`).catch(() => "");
    for (const family of ["Geist Fallback", "Bricolage Fallback", "Geist Mono Fallback"]) {
      const face = new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*"${family.replace(/ /g, " ")}"[^}]*size-adjust:[^}]*\\}`);
      record(`${sheet} defines the ${family} metric-matched @font-face (size-adjust + overrides)`,
        face.test(css) && new RegExp(`"${family}"[^}]*ascent-override`).test(css));
    }
    // font-display: swap on the real faces.
    record(`${sheet} keeps font-display: swap on the webfont faces`,
      (css.match(/font-display:\s*swap/g) || []).length >= 5);
    // The stacks actually reference the fallback families (so the swap uses them).
    record(`${sheet} wires the fallback families into the font stacks`,
      css.includes('"Geist", "Geist Fallback"') && css.includes('"Bricolage", "Bricolage Fallback"') && css.includes('"Geist Mono", "Geist Mono Fallback"'));
  }
}

// ---- Hero transition engine: crossfade + height continuity + queue + prefetch ----
async function checkHeroTransitionEngine(homeHtml) {
  const css = await readText("dist/stagelight.css").catch(() => "");
  // CSS scaffolding for the crossfade/height engine.
  record("Hero swap clips slots and tweens ONLY the section height (slide engine v2)",
    /body\.stagelight \.hero-slot \{ position: relative; \}/.test(css)
    && /body\.stagelight \.hero-slot\.is-swapping \{ overflow: hidden; \}/.test(css)
    && !/hero-slot\.is-swapping \{[^}]*transition: height/.test(css)
    && !/home-hero\.is-swapping \{ transition: height/.test(css),
    "no height transitions anywhere - the stage is locked");
  record("Hero views slide horizontally with direction (photos crossfade in place)",
    /body\.stagelight \.hv \{ transition: opacity 0\.28s cubic-bezier\(0\.22,1,0\.36,1\), transform 0\.28s/.test(css)
    && css.includes(".hv.is-leaving { position: absolute")
    && /\.hv\.is-enter-next \{ opacity: 0; transform: translateX\(28px\); \}/.test(css)
    && /\.hv\.is-enter-prev \{ opacity: 0; transform: translateX\(-28px\); \}/.test(css)
    && /\.hv\.is-leave-next \{ opacity: 0; transform: translateX\(-22px\); \}/.test(css)
    && /hero-media-slot \.hv\.is-enter-next[^}]*transform: none/.test(css),
    "horizontal slide classes + media crossfade exception present");
  record("Pager arrows are position-stable (lockwrap top-aligned, never re-centered)",
    /body\.stagelight \.hero-lockwrap \{[^}]*align-self: start/.test(css) && !/hero-lockwrap \{[^}]*align-self: center/.test(css),
    "lockwrap align-self start");
  // Two column wrappers, not a 2x2 grid: row 2 sits a FIXED gap below row 1 so the
  // music slot can never overlap Set 1 (short screens) or leave a giant gap (tall).
  record("Hero uses two column wrappers with a fixed music-slot gap (no negative margin, no vh coupling)",
    homeHtml.includes('class="hero-left"') && homeHtml.includes('class="hero-right"')
    && /body\.stagelight \.hero-left, body\.stagelight \.hero-right \{[^}]*display: flex/.test(css)
    && /body\.stagelight \.hero-music-slot \{ margin-top: 28px; \}/.test(css)
    && !/hero-music-slot \{[^}]*margin-top: -61px/.test(css)
    && !/hero-inner \{[^}]*grid-template-rows: auto/.test(css),
    "hero-left/right wrappers + fixed 28px music gap, no -61px / grid-rows");
  record("Hero column gutter widened to 88px",
    /body\.stagelight \.hero-inner \{[^}]*column-gap: 88px/.test(css),
    "88px column-gap");
  record("Reduced motion disables the hero view transitions",
    /@media \(prefers-reduced-motion: reduce\) \{\s*body\.stagelight \.hv \{ transition: none/.test(css),
    "reduced-motion guard present");
  record("Hero background layer crossfade settles just after the content (0.5s)",
    /body\.stagelight \.hero-bg img \{[^}]*transition: opacity 0\.5s ease/.test(css));
  // JS engine wiring (the inline hero modal script rides in the homepage HTML).
  record("Hero swap does a no-blank-frame crossfade (absolute is-leaving snapshot + in-flow incoming)",
    homeHtml.includes('classList.add("is-leaving")') && homeHtml.includes('classList.add(enterCls)')
    && homeHtml.includes('.hv[data-view="'),
    "is-leaving + enter-class swap present");
  // Heights stay intrinsic from first paint with zero JS — but only the LONGEST few
  // views per slot stay in layout to hold the slot open (hv-hold). Keeping all ~29
  // stacked cost 11.4ms median / 28ms worst on every forced layout versus 1.3ms,
  // blowing the 60fps budget and stuttering every hero transition. The rest are
  // display:none. Assert: grid stacking, holders laid out invisibly, non-holders
  // fully out of layout, no JS locking, and that holders actually exist.
  record("Hero slots grid-stack views so heights are intrinsic from first paint (no JS locking, no load shift)",
    /hero-lock-slot, body\.stagelight \.hero-music-slot, body\.stagelight \.hero-ticker-slot \{ display: grid; \}/.test(css)
    && css.includes("grid-area: 1 / 1")
    && /hero-ticker-slot > \.hv\[hidden\] \{ display: none; \}/.test(css)
    && /hero-ticker-slot > \.hv-hold\[hidden\] \{ display: block; visibility: hidden; pointer-events: none; \}/.test(css)
    && !homeHtml.includes("lockStage"));
  const holders = (homeHtml.match(/class="hv hv-hold"/g) || []).length;
  record("Only a bounded set of height-holder views stays in layout",
    holders >= 3 && holders <= 20,
    `${holders} hv-hold views (all other hidden views are display:none)`);
  record("Hero gates the swap on decoded target imagery, capped so slow networks never block",
    homeHtml.includes("readyImages") && homeHtml.includes("img.decode()") && homeHtml.includes("setTimeout(res, 350)"),
    "readyImages decode race present");
  record("Hero warms adjacent (prev/next) view imagery after each swap",
    homeHtml.includes("warmView") && homeHtml.includes("finishSwap") && /swapOrder\[\(at \+ 1\)/.test(homeHtml),
    "adjacent prefetch present");
  record("Hero uses last-wins queueing instead of dropping rapid clicks",
    homeHtml.includes("queuedIso") && /if \(swapping\) \{ queuedIso = iso; return; \}/.test(homeHtml)
    && !homeHtml.includes("if (swapping) return;"),
    "last-wins queue present, click-drop removed");
  record("Hero swap direction is derived from ISO order (next rises, prev settles)",
    homeHtml.includes('dir = iso > fromIso ? "next" : "prev"'),
    "direction logic present");
}

// ---- Riviera Maya display sweep: "Quintana Roo" label never reaches the user ----
function checkRivieraDisplaySweep(files, htmlByFile) {
  // No location-LABEL form ("..., Quintana Roo[, MEX]") anywhere in dist HTML.
  const labelLeaks = [];
  const bareLeaks = [];
  for (let i = 0; i < files.length; i += 1) {
    const rel = path.relative(root, files[i]);
    const html = htmlByFile[i];
    if (/,\s*Quintana Roo/i.test(html)) labelLeaks.push(rel);
    if (/Quintana Roo/.test(html)) bareLeaks.push(rel);
  }
  record("No location-label 'Quintana Roo' form survives in any dist HTML (sweep to 'MX')",
    labelLeaks.length === 0, labelLeaks.slice(0, 10).join("\n"));
  // The homepage (hero + feed) is fully swept — zero 'Quintana Roo' of any kind,
  // and it positively shows the short display form.
  const home = htmlByFile[files.findIndex((f) => path.relative(root, f) === "dist/index.html")] || "";
  record("Homepage carries zero 'Quintana Roo' and shows the 'Riviera Maya, MX' display form",
    !/Quintana Roo/.test(home) && home.includes("Riviera Maya, MX"),
    "homepage swept");
  // Any residual bare mention is allowed ONLY as dated editorial prose inside the
  // historical Tour-In-Review / archive namespaces (verbatim imported blog copy).
  const disallowed = bareLeaks.filter((rel) => !/^dist\/(tour-in-review|20\d\d)\//.test(rel));
  record("Any remaining 'Quintana Roo' lives only in historical editorial prose (archive/tour-in-review)",
    disallowed.length === 0, disallowed.slice(0, 10).join("\n"));
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

// Mirror of build.mjs displayLocation: the short display form for long Mexican
// state labels. Kept in lockstep so guards assert the exact rendered strings.
function displayLocation(location) {
  return String(location || "").replace(/,\s*Quintana Roo(?:,?\s*(?:MEX|MX|Mexico))?/gi, ", MX");
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

// Sitewide dead-link sweep. Every internal href/src on every built page must
// resolve to a real file, honouring the same fallbacks the host applies:
// extension-less .html, directory index.html, percent-decoding, and _redirects.
// Added after Shelf Watch + ticker shipped 312 links to /songs/<slug>/ when the
// song pages live at /song/<slug>/ — a whole class of 404 no guard was watching.
async function checkEveryInternalLinkResolves(files, htmls) {
  let redirectSources = new Set();
  try {
    const raw = await readText("dist/_redirects");
    redirectSources = new Set(raw.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean).map((v) => v.replace(/\/$/, "")));
  } catch {}
  const resolves = async (href) => {
    const clean = safeDecodePath(href.split("#")[0].split("?")[0]);
    if (!clean.startsWith("/") || clean.startsWith("//")) return true;
    const candidates = [clean, clean + ".html", clean.replace(/\/$/, "") + ".html", clean.replace(/\/$/, "") + "/index.html"];
    for (const candidate of candidates) {
      const ok = await stat(distDir + candidate).then((s) => s.isFile()).catch(() => false);
      if (ok) return true;
    }
    return redirectSources.has(clean.replace(/\/$/, ""));
  };
  const seen = new Map();
  htmls.forEach((html, index) => {
    // data-* attributes are inert payloads (dead social widgets in archived
    // posts), so anchor the match to a real href=/src= attribute boundary.
    for (const match of html.matchAll(/(?:^|[\s"'])(?:href|src)="(\/[^"]*)"/g)) {
      if (!seen.has(match[1])) seen.set(match[1], files[index].replace(distDir, ""));
    }
  });
  const broken = [];
  for (const [href, from] of seen) {
    if (!(await resolves(href))) broken.push(`${href} <- ${from}`);
  }
  record("Sitewide: every internal link and asset resolves", broken.length === 0, broken.slice(0, 20).join("\n"));
  record("Sitewide link sweep covers the whole build", seen.size > 500 && htmls.length > 900, `${seen.size} unique targets across ${htmls.length} pages`);
  // The blanket `main > *` stacking rule was dismantled 2026-07-23 after five
  // documented bugs (it restyled every main child and silently out-specified any
  // component that positions itself). .hero-echo now sits at z-index:-1, which is
  // the only thing the blanket was ever really for. Both halves are asserted here
  // so neither can regress: the blanket must not return, and the echo must stay
  // negative (at z-index >= 0 it would cover the content that follows it).
  const sl = await readText("dist/stagelight.css").catch(() => "");
  // The blanket is BACK (restored 2026-07-23 while a motion regression is isolated).
  // If it is ever dismantled again, the exclusions are what keep self-positioning
  // components alive — assert they are all present.
  record("Blanket stacking rule keeps every self-positioning exclusion",
    /main > \*:not\(\.hero-echo\):not\(\.bento-panel\):not\(\.home-nav\) \{ position: relative; z-index: 1; \}/.test(sl),
    "blanket excludes .hero-echo, .bento-panel and .home-nav");
  record("Song Index sticky bars stay asserted above the blanket",
    /main > \.song-search\.song-search\.song-search \{ position: sticky; z-index: 12; \}/.test(sl)
    && /main > \.index-toolbar\.index-toolbar\.index-toolbar \{ z-index: 30; \}/.test(sl),
    "sticky search bar and filter toolbar out-specify the blanket");
  // Half-way links are worse than nothing (Alex, 7/23): no search-URL stand-ins
  // anywhere — every outbound music link must land on the exact song.
  record("No Songsterr search URL survives anywhere in the build",
    !htmls.some((html) => /songsterr\.com\/\?pattern=/i.test(html)),
    "zero songsterr.com/?pattern= links sitewide");
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
