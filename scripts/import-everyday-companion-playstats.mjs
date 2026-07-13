import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const sourceUrl = args.url || "https://everydaycompanion.com/playstats/playstats.asp";
const output = args.out || path.join(root, "data", "source", "everyday-companion-playstats.json");

async function main() {
  const html = await fetchText(sourceUrl);
  const rows = parsePlaystats(html);

  if (!rows.length) throw new Error("Everyday Companion playstats import returned no rows.");

  const payload = {
    source: "Everyday Companion",
    sourceUrl,
    importedAt: new Date().toISOString(),
    rows
  };

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Imported ${rows.length} Everyday Companion playstats rows to ${path.relative(root, output)}.`);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "Burnthday static-site playstats importer" }
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  return response.text();
}

function parsePlaystats(html) {
  const rows = [];

  for (const rowMatch of String(html || "").matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => cleanText(match[1]));
    if (cells.length !== 6 || !cells[0] || !/^\d+$/.test(cells[3])) continue;

    rows.push({
      title: cells[0],
      first: cells[1],
      last: cells[2],
      total: toNumber(cells[3]),
      l100: toNumber(cells[4]),
      slp: toNumber(cells[5])
    });
  }

  return rows;
}

function cleanText(value) {
  return decodeHtml(stripTags(value)).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
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

function toNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--url") parsed.url = values[++index];
    else if (value === "--out") parsed.out = values[++index];
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
