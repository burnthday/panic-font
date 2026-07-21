// verify-relisten-dates.mjs — build data/source/relisten-dates.json, the array of
// Widespread Panic show dates (YYYY-MM-DD) that have at least one streamable
// recording on archive.org / relisten.net.
//
// WHERE TO RUN THIS
// -----------------
// archive.org must be reachable over the network. The build sandbox / PR-review
// environment has NO outbound web, so DO NOT run it there — it will simply fail to
// fetch. Run it locally or in a CI job that has internet access, commit the
// resulting data/source/relisten-dates.json, and the Relisten links in
// scripts/build.mjs light up automatically: a compact "Listen ↗" on every matching
// song performance-log row, and a "Listen on Relisten" pill on matching homepage
// show cards. No build code change is needed when the file lands. While the file is
// absent (the committed default), the entire Relisten layer stays dormant.
//
//   npm run verify:relisten                 # fetch + write data/source/relisten-dates.json
//   npm run verify:relisten -- --dry-run    # fetch + print, write nothing
//   npm run verify:relisten -- --self-test  # run the transform against the bundled
//                                           # fixture only — no network, for CI/sandbox
//   npm run verify:relisten -- --out /tmp/relisten-dates.json
//
// Output shape (a sorted, de-duplicated array of ISO dates — the SAME shape the
// build loader (loadRelistenDates) reads and the SAME date form as setlist.fm
// perf rows and show.isoDate, so lookups line up exactly):
//   ["1988-02-06", "1995-06-27", "2019-06-21", ...]
//
// Do NOT commit a hand-written / fake relisten-dates.json — an absent file is the
// correct default, and every Relisten link stays hidden.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// archive.org's advancedsearch API. We ask only for the `date` field of every item
// in the WidespreadPanic collection and page through the full result set. `date`
// comes back as an ISO-8601 timestamp (e.g. "1988-02-06T00:00:00Z"); we keep the
// leading calendar day.
const SEARCH_ENDPOINT = "https://archive.org/advancedsearch.php";
const COLLECTION = "WidespreadPanic";
const PAGE_ROWS = 500;

const args = parseArgs(process.argv.slice(2));
const output = args.out || path.join(root, "data", "source", "relisten-dates.json");

async function main() {
  if (args.selfTest) return runSelfTest();

  const dates = new Set();
  let page = 1;
  let expected = Infinity;
  let fetched = 0;

  while (fetched < expected) {
    const { docs, numFound } = await fetchPage(page);
    expected = numFound;
    if (!docs.length) break;
    for (const iso of extractDates(docs)) dates.add(iso);
    fetched += docs.length;
    page += 1;
    if (page > 1000) break; // hard stop against a runaway pager
  }

  const ordered = [...dates].sort();
  if (!ordered.length) {
    throw new Error(
      `No dates parsed from ${COLLECTION} on archive.org. The API response shape ` +
        `may have changed — inspect extractDates(), or run with --self-test.`
    );
  }

  if (args.dryRun) {
    console.log(`[dry-run] scanned ${fetched} items -> ${ordered.length} unique show dates. Nothing written.`);
    for (const iso of ordered.slice(0, 12)) console.log(`  ${iso}`);
    if (ordered.length > 12) console.log(`  … +${ordered.length - 12} more`);
    return;
  }

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  console.log(`Wrote ${ordered.length} Relisten show dates to ${path.relative(root, output)}.`);
}

// The one piece of real logic worth testing without a network: turn a page of
// advancedsearch `docs` into clean, de-duplicated YYYY-MM-DD strings. `date` may be
// a full timestamp, a bare calendar day, or (rarely) an array — normalize them all
// and drop anything that isn't a plausible ISO calendar day.
function extractDates(docs) {
  const out = [];
  for (const doc of docs || []) {
    const raw = Array.isArray(doc?.date) ? doc.date[0] : doc?.date;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw || ""));
    if (!match) continue;
    const iso = `${match[1]}-${match[2]}-${match[3]}`;
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (y < 1980 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) continue;
    out.push(iso);
  }
  return out;
}

async function fetchPage(page) {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("q", `collection:${COLLECTION}`);
  url.searchParams.set("fl[]", "date");
  url.searchParams.set("rows", String(PAGE_ROWS));
  url.searchParams.set("page", String(page));
  url.searchParams.set("output", "json");
  const response = await fetch(url, {
    headers: { "user-agent": "Burnthday static-site Relisten date verifier" }
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  const body = await response.json();
  return {
    docs: body?.response?.docs || [],
    numFound: Number(body?.response?.numFound ?? 0)
  };
}

// Offline confidence check: run the transform against a hand-built fixture that
// mirrors the archive.org response shape (timestamps, bare days, array dates, and
// junk that must be dropped). Exercises extractDates() + the sort/dedupe the writer
// applies, with no network. Exits non-zero on any mismatch.
function runSelfTest() {
  const fixtureDocs = [
    { date: "1988-02-06T00:00:00Z" },
    { date: "2019-06-21T00:00:00Z" },
    { date: "1988-02-06T00:00:00Z" }, // duplicate of the first
    { date: "1995-06-27" }, // bare calendar day
    { date: ["2010-10-31T00:00:00Z", "ignored"] }, // array form
    { date: "not-a-date" }, // junk -> dropped
    { date: "0001-13-40T00:00:00Z" }, // implausible -> dropped
    {} // missing date -> dropped
  ];
  const got = [...new Set(extractDates(fixtureDocs))].sort();
  const want = ["1988-02-06", "1995-06-27", "2010-10-31", "2019-06-21"];
  const ok = got.length === want.length && got.every((value, index) => value === want[index]);
  if (!ok) {
    console.error("[self-test] FAILED");
    console.error(`  expected: ${JSON.stringify(want)}`);
    console.error(`  actual:   ${JSON.stringify(got)}`);
    process.exit(1);
  }
  console.log(`[self-test] OK — transform yields ${got.length} clean dates from ${fixtureDocs.length} fixture docs.`);
}

function parseArgs(values) {
  const parsed = { dryRun: false, selfTest: false, out: "" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--dry-run") parsed.dryRun = true;
    else if (value === "--self-test") parsed.selfTest = true;
    else if (value === "--out") parsed.out = values[++index];
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
