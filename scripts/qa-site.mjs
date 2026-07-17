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
  await checkLatestSetlist(homeHtml, siteData);
  checkGuestAnnotations(homeHtml, review2025Html);
  checkNavigation(homeHtml, siteData);
  await checkLegacyPages(siteData);
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
  assertIncludes(html, `<h1>WIDESPREAD PANIC ${siteData.site.year} TOUR</h1>`, "Homepage leads with the tour title");
  for (const label of ["Song Possibilities", "Tour Stats", "The Shelf", "Purgatory", "Nick Stats", "Setlists"]) assertIncludes(sectionByClass(html, "home-trail"), label, `Homepage trail links to ${label}`);
  assertIncludes(html, '<section class="latest-setlist" id="latest-setlist">', "Homepage has top-of-page setlist section");
  assertIncludes(html, '<section class="laminate primary-board" id="song-list">', "Homepage has song-list laminate");
  const boardTitle = [siteData.site?.boardShow?.location, siteData.site?.boardShow?.runLabel].filter(Boolean).join(" ").toUpperCase();
  assertIncludes(html, `<h1>${escapeHtml(boardTitle)}</h1>`, `Song List title matches board show: ${boardTitle}`);

  record("Current tour-stop setlists appear above Song List", indexOf(html, 'id="latest-setlist"') < indexOf(html, 'id="song-list"'));
  record("Sheet key appears below Song List", indexOf(html, 'id="song-list"') < indexOf(html, 'id="sheet-key"'));
  record("Tour Stats appears below the Sheet Key", indexOf(html, 'id="sheet-key"') < indexOf(html, 'id="tour-stats"'));
  record("Shelf Watch appears between Tour Stats and Shelf", indexOf(html, 'id="tour-stats"') < indexOf(html, 'id="shelf-watch"') && indexOf(html, 'id="shelf-watch"') < indexOf(html, 'id="shelf"'));
  record("Shelf and Purgatory appear below Shelf Watch", indexOf(html, 'id="shelf-watch"') < indexOf(html, 'id="shelf"') && indexOf(html, 'id="shelf"') < indexOf(html, 'id="purgatory"'));
  record("The Woodshed appears below Purgatory", indexOf(html, 'id="purgatory"') < indexOf(html, 'id="woodshed"'));
  record("Older setlists appear below The Woodshed", indexOf(html, 'id="woodshed"') < indexOf(html, 'id="setlists"'));

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

  for (const key of ["title", "count", "frequency", "last", "type"]) {
    assertIncludes(feature, `data-sort="${key}"`, `Tour Stats supports sorting by ${key}`);
  }
  const rendered = [...feature.matchAll(/<tr data-title="([^"]+)" data-count="(\d+)" data-frequency="(\d+)" data-last="([^"]*)" data-type="([^"]+)">/g)]
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
    assertIncludes(feature, `last played ${song.lastDisplay}`, `Shelf Watch gives ${song.title}'s last-played date`);
    const rowStart = feature.indexOf(`data-song-title="${escapeAttribute(song.title)}"`);
    const rowEnd = feature.indexOf("</li>", rowStart);
    const row = rowStart >= 0 && rowEnd > rowStart ? feature.slice(rowStart, rowEnd) : "";
    assertIncludes(row, `<strong>${remaining}</strong><span>to Shelf</span>`, `Shelf Watch gives ${song.title}'s distance to Shelf`);
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

  assertIncludes(feature, "<h2>NICK JOHNSON</h2>", "Homepage has the restrained Nick Johnson feature");
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
  assertIncludes(feature, `<strong>${completion}%</strong><span>${played.length} of ${rotation.length} current possibilities played</span>`, "Nick Johnson feature shows rotation completion");
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

async function checkLatestSetlist(html, siteData) {
  const featured = sectionHtml(html, "latest-setlist");
  const featuredShow = siteData.site?.featuredShow || siteData.setlists?.[0];
  const latestShow = siteData.setlists?.[0];
  const heading = `${featuredShow?.date || ""} ${featuredShow?.venue || ""}, ${featuredShow?.location || ""}`;
  if (!siteData.site?.isShowDayPreview) assertIncludes(featured, escapeHtml(heading), "Featured-show heading matches generated site data");

  const featuredCard = featured.split('<div class="current-stop-setlists">')[0];
  const renderedLabels = [...featuredCard.matchAll(/<p><strong>([^<]+):<\/strong>[\s\S]*?<\/p>/g)].map((match) => decodeHtml(match[1]));
  if (siteData.site?.isShowDayPreview) {
    record("Show-day setlists have no redundant section label or black rule", !featured.includes("CURRENT TOUR STOP") && !featured.includes('class="section-heading"'));
    assertIncludes(featured, escapeHtml(heading), "Tonight's blank setlist is featured first");
    record("Tonight's setlist remains blank until songs are posted", renderedLabels.length === 0, renderedLabels.join(", "));
    assertIncludes(featuredCard, ">Show Details</a>", "Tonight links to show details");
    record("Homepage contains no Twitch links", !html.includes("twitch.tv") && !html.includes("Twitch"));
    record("Tonight does not advertise a post-show Nugs archive", !featuredCard.includes("Listen at Nugs.net"));

    const completedHeading = `${latestShow?.date || ""} ${latestShow?.venue || ""}, ${latestShow?.location || ""}`;
    const completedRunShow = cardHtml(featured, escapeHtml(completedHeading));
    record("Latest completed show from the tour stop stays above the Song List", Boolean(completedRunShow), completedHeading);
    record("Top tour-stop show is not duplicated in the lower archive", !cardHtml(sectionHtml(html, "setlists"), escapeHtml(completedHeading)), completedHeading);
    assertIncludes(completedRunShow, ">Official Setlist &amp; Photos</a>", "Completed show identifies the official setlist and photos");
    assertIncludes(completedRunShow, ">Listen at Nugs.net</a>", "Completed show labels the Nugs audio clearly");
    const featuredImages = [...featured.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]);
    record("Tonight and the latest completed show use different photos", featuredImages.length >= 2 && featuredImages[0] !== featuredImages[1], featuredImages.join(" vs "));
  } else {
    assertIncludes(featured, "<h2>LATEST SETLIST</h2>", "Completed featured show is labeled Latest Setlist");
    const sourceSegueCount = sum((latestShow?.sets || []).map((set) => (set.songs.match(/\s>\s/g) || []).length));
    const renderedSegueCount = (featured.match(/&gt;/g) || []).length;
    record("Latest setlist preserves every source segue", sourceSegueCount > 0 && renderedSegueCount >= sourceSegueCount, `source=${sourceSegueCount} rendered=${renderedSegueCount}`);

    const sourceLabels = (latestShow?.sets || []).map((set) => set.label);
    record("Latest setlist renders one line for every set", arraysEqual(renderedLabels, sourceLabels), `${renderedLabels.join(", ")} vs ${sourceLabels.join(", ")}`);
  }

  const styles = await readText("dist/styles.css");
  record("Setlist photography uses a landscape crop", /\.setlist-image img\s*\{[\s\S]*?aspect-ratio:\s*16 \/ 9;[\s\S]*?object-fit:\s*cover;/.test(styles));
  record("Setlist entries are unframed", /\.setlist-card\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/.test(styles));

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

function checkNavigation(html, siteData) {
  const expectedTop = ["Home", "Rumors", "Lyrics & Chords", "Song Origins", "Tour In Review", "The Shelf", "About"];
  const expectedFooter = ["Home", "Rumors", "Lyrics & Chords", "Song Origins", "Tour In Review", "@Burnthday", "About"];
  const topNav = linkTexts(sectionByClass(html, "jump-links"));
  const mobileNav = linkTexts(sectionByClass(html, "mobile-nav-links"));
  const footerNav = linkTexts(sectionByClass(html, "footer-links"));
  record("Top nav matches old Burnthday nav", arraysEqual(topNav, expectedTop), topNav.join(" | "));
  record("Mobile menu matches the complete top navigation", arraysEqual(mobileNav, expectedTop), mobileNav.join(" | "));
  assertIncludes(html, '<details class="mobile-nav">', "Homepage has an accessible mobile navigation menu");
  record("Homepage omits the redundant On This Page jump row", !html.includes('class="home-sections"') && !html.includes("ON THIS PAGE"));
  record("Footer nav matches old Burnthday footer", arraysEqual(footerNav, expectedFooter), footerNav.join(" | "));
  record("Footer intentionally excludes The Shelf", !footerNav.includes("The Shelf"), footerNav.join(" | "));
  assertIncludes(html, "burnthday on Facebook", "Footer includes Facebook text link");
  assertIncludes(html, "burnthday on Twitter", "Footer includes Twitter text link");
  assertIncludes(html, "burnthday on Instagram", "Footer includes Instagram text link");
  assertIncludes(html, "All Rights Reserved. Burnthday", "Footer keeps Burnthday rights line");
  assertIncludes(html, "The Widespread Panic Spread Sheet", "Footer keeps Spread Sheet title");
}

async function checkLegacyPages(siteData) {
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
  assertIncludes(shelf, `<h2>${siteData.site.year} Shelf Update</h2>`, "Shelf page leads with the current generated update");
  assertIncludes(shelf, `${siteData.rules.rotationSlpLimit}</strong><span>show cutoff</span>`, "Shelf page states the active cutoff");
  assertIncludes(shelf, `${siteData.boards.shelfOriginals.length + siteData.boards.shelfCovers.length}</strong><span>on The Shelf</span>`, "Shelf page count matches the generated Shelf");
  assertIncludes(shelf, `${siteData.boards.purgatoryOriginals.length + siteData.boards.purgatoryCovers.length}</strong><span>in Purgatory</span>`, "Shelf page count matches generated Purgatory");
  for (const song of siteData.boards.shelfWatch || []) {
    assertIncludes(shelf, `${song.effectiveSlp} shows since ${song.lastDisplay}`, `Shelf page Watch matches ${song.title}`);
  }
  record("Shelf page preserves the historical updates after the current update", indexOf(shelf, `${siteData.site.year} Shelf Update`) < indexOf(shelf, "Previous Shelf Updates") && /The Shelf Updated: April 1st, 2019/.test(shelfText));
  for (const [label, html] of [["Rumors", rumors], ["Tour In Review", tourReview], ["The Shelf", shelf]]) {
    assertIncludes(html, 'document.querySelectorAll(".jump-links a, .mobile-nav-links a")', `${label} page initializes its active navigation state`);
    assertIncludes(html, 'path === "/index" ? "/" : path', `${label} page normalizes the legacy homepage URL`);
  }
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
  const headingIndex = html.indexOf(`<h3>${heading}</h3>`);
  if (headingIndex < 0) return "";
  const cardStart = html.lastIndexOf('<article class="setlist-card', headingIndex);
  const featureStart = html.lastIndexOf('<article class="setlist-feature', headingIndex);
  const start = Math.max(cardStart, featureStart);
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
