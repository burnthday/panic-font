import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const year = process.env.TOUR_YEAR || String(new Date().getFullYear());
const destination = path.join(root, "data", "source", `setlists-${year}.json`);
const tempDir = await mkdtemp(path.join(os.tmpdir(), "burnthday-refresh-"));
const officialFile = path.join(tempDir, `setlists-${year}-official.json`);
const enrichedFile = path.join(tempDir, `setlists-${year}-enriched.json`);
const transitionStatusFile = path.join(tempDir, "transition-status.json");

try {
  await runNode("scripts/import-official-setlists.mjs", ["--year", year, "--out", officialFile]);

  const current = JSON.parse(await readFile(destination, "utf8"));
  const candidate = JSON.parse(await readFile(officialFile, "utf8"));
  const today = dateInTimeZone(new Date(), "America/Los_Angeles");
  const deferred = candidate.setlists.filter((show) => show.isoDate >= today);
  candidate.setlists = candidate.setlists.filter((show) => show.isoDate < today);

  assertNoRegression(current, candidate);
  await writeFile(officialFile, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");

  if (deferred.length) {
    console.log(`Deferred ${deferred.length} same-day or future setlist(s): ${deferred.map(showLabel).join(", ")}`);
  }

  const transitionResult = await runNode(
    "scripts/enrich-setlist-transitions.mjs",
    ["--year", year, "--in", officialFile, "--out", enrichedFile, "--status-file", transitionStatusFile, "--require-all"],
    { allowedExitCodes: [75] }
  );

  if (transitionResult.exitCode === 75) {
    const status = JSON.parse(await readFile(transitionStatusFile, "utf8"));
    console.log("Automatic refresh is holding the last complete dataset until transition metadata is ready.");
    for (const miss of status.misses || []) console.log(`- ${miss}`);
    await writeGithubOutputs({ ready: "false", updated: "false", reason: "transition-source-not-ready" });
    process.exitCode = 0;
  } else {
    const nextPayload = JSON.parse(await readFile(enrichedFile, "utf8"));
    preserveVerifiedTransitionSources(current, nextPayload);
    const nextText = `${JSON.stringify(nextPayload, null, 2)}\n`;
    const currentText = await readFile(destination, "utf8");
    const updated = comparableJson(nextText) !== comparableJson(currentText);
    if (updated) {
      const pendingFile = `${destination}.pending`;
      await writeFile(pendingFile, nextText, "utf8");
      await rename(pendingFile, destination);
    }
    console.log(`Automatic refresh accepted ${candidate.setlists.length} complete ${year} setlists${updated ? " with data changes" : ""}.`);
    await writeGithubOutputs({ ready: "true", updated: String(updated), reason: "complete" });
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function runNode(script, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      env: process.env,
      stdio: "inherit"
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const exitCode = code ?? 1;
      if (exitCode === 0 || options.allowedExitCodes?.includes(exitCode)) {
        resolve({ exitCode, signal });
      } else {
        reject(new Error(`${script} exited with ${signal ? `signal ${signal}` : `status ${exitCode}`}`));
      }
    });
  });
}

function assertNoRegression(current, candidate) {
  const candidateDates = new Set(candidate.setlists.map((show) => show.isoDate));
  const missingDates = current.setlists
    .map((show) => show.isoDate)
    .filter((isoDate) => isoDate && !candidateDates.has(isoDate));

  if (missingDates.length) {
    throw new Error(`Official import omitted previously published setlist(s): ${missingDates.join(", ")}`);
  }
  if ((candidate.tourDates || []).length < (current.tourDates || []).length) {
    throw new Error(`Official import reduced tour dates from ${current.tourDates.length} to ${candidate.tourDates.length}.`);
  }
}

function preserveVerifiedTransitionSources(current, candidate) {
  const currentByDate = new Map((current.setlists || []).map((show) => [show.isoDate, show]));
  for (const show of candidate.setlists || []) {
    const previous = currentByDate.get(show.isoDate);
    if (!previous || setDisplay(previous) !== setDisplay(show)) continue;
    show.transitionSourceUrl = previous.transitionSourceUrl || show.transitionSourceUrl;
    show.transitionSourceTitle = previous.transitionSourceTitle || show.transitionSourceTitle;
  }
}

function setDisplay(show) {
  return JSON.stringify((show.sets || []).map((set) => ({ label: set.label, songs: set.songs, songTitles: set.songTitles })));
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function showLabel(show) {
  return `${show.isoDate} ${show.location}`.trim();
}

function comparableJson(text) {
  const payload = JSON.parse(text);
  delete payload.importedAt;
  if (payload.transitionSource) delete payload.transitionSource.importedAt;
  return JSON.stringify(payload);
}

async function writeGithubOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
  await writeFile(process.env.GITHUB_OUTPUT, `${lines}\n`, { flag: "a" });
}
