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
  await checkTourInReviewPages();
  await checkMusicLayer(allHtmlFiles, allHtml);
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

function checkTourDates(html, siteData) {
  const feature = sectionHtml(html, "tour-dates");
  const upcoming = siteData.tourDates.filter((date) => !date.isPosted).length;
  assertIncludes(feature, `${upcoming} shows ahead`, "Upcoming block summarizes the remaining schedule");
  record("Upcoming block lists every unplayed show once", (feature.match(/<li class="is-upcoming">/g) || []).length === upcoming);
  record("Upcoming block gives every row a clear status", (feature.match(/<em>Upcoming<\/em>/g) || []).length === upcoming);
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
  const expectedMega = ["Home", "Song Possibilities", "Song Index", "Tour Stats", "Setlists", "Albums", "Lyrics & Chords", "Song Origins", "Rumors", "Tour In Review", "The Shelf", "About"];
  // Footer is now grouped into three labeled columns; every legacy destination
  // remains present (Privacy moved to the bottom bar, asserted separately).
  const expectedColumnLabels = ["Live", "Songbook", "The Sheet"];
  const expectedFooter = ["Setlists", "Tour In Review", "Rumors", "Song Index", "Albums", "Lyrics & Chords", "Song Origins", "Song List", "The Shelf", "About"];
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
  assertIncludes(html, `© ${siteData.site.year} Burnthday. All rights reserved.`, "Footer keeps the modern Burnthday rights line");
  assertIncludes(html, "The Widespread Panic Spread Sheet", "Footer keeps Spread Sheet title");
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

  record("Rumors page uses imported legacy copy", /2025 Rumors:/.test(rumorsText) && /100% pure speculation/.test(rumorsText));
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
  record("Primary archive pages omit migration eyebrows", !rumors.includes("<p>The Widespread Panic Spread Sheet</p>") && !tourReview.includes("<p>The Widespread Panic Spread Sheet</p>"));
  for (const [label, html] of [["Rumors", rumors], ["Tour In Review", tourReview], ["The Shelf", shelf], ["Privacy", privacy]]) {
    assertIncludes(html, 'class="stagelight"', `${label} page uses the Stagelight dark shell`);
    assertIncludes(html, 'id="mega-menu"', `${label} page carries the shared mega menu`);
    assertIncludes(html, 'href="/stagelight.css"', `${label} page loads the Stagelight stylesheet`);
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

  // Feature 3: relisten-dates.json must NOT be committed — Relisten stays dormant.
  record("relisten-dates.json is absent from the repo (dormant by default)", !(await fileExists("data/source/relisten-dates.json")), "data/source/relisten-dates.json should not exist");
  const relistenOffenders = files.filter((file, index) => /relisten\.net/.test(htmlByFile[index])).map((file) => path.relative(root, file));
  record("No relisten.net links render anywhere while relisten-dates.json is absent", relistenOffenders.length === 0, relistenOffenders.join("; "));
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

async function checkTourInReviewPages() {
  const dir = path.join(distDir, "tour-in-review");
  const entries = await readdir(dir, { withFileTypes: true });
  const tourDirs = entries.filter((entry) => entry.isDirectory());
  record("Generated tour-in-review pages cover the band's history", tourDirs.length > 90, `found ${tourDirs.length} tour pages`);

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
