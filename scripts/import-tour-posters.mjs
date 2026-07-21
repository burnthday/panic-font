import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Import Widespread Panic TOUR prints (not per-show gig posters) from the
 * band's official poster archive sitemap (widespreadpanic.com/posters-sitemap.xml).
 * Each tour has one commissioned print; the sitemap pairs the poster page with
 * its image and the slug encodes year + tour + artist. Output maps a poster to
 * each tour so Tour-in-Review can show the print, credited to its artist, with
 * a link back to the official archive.
 *
 * Output: data/source/tour-posters.json
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const OUT = path.join(root, "data", "source", "tour-posters.json");
const SITEMAP = "https://widespreadpanic.com/posters-sitemap.xml";

const TOUR_WORDS = /tour|generic|run|nye|halloween|new-year|panic-en-la-playa|playa|acoustic|wood|horde|carolinas-invasion|allman-bros-cobill|germany/;
const SEASONS = { spring: "Spring", summer: "Summer", fall: "Fall", winter: "Winter" };

async function main() {
  const res = await fetch(SITEMAP, { headers: { "User-Agent": UA } });
  const xml = await res.text();
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];

  const seen = new Set();
  const posters = [];
  for (const b of blocks) {
    const loc = b.match(/<loc>([^<]+)<\/loc>/)?.[1];
    const image = b.match(/<image:loc>([^<]+)<\/image:loc>/)?.[1] || null;
    if (!loc) continue;
    const slug = loc.replace(/\/$/, "").split("/").pop();
    if (!/^(19|20)\d{2}-[a-z]/.test(slug)) continue;      // must be year + word
    if (/^(19|20)\d{2}-\d{2}-\d{2}/.test(slug)) continue;  // skip per-show gig posters
    if (!TOUR_WORDS.test(slug)) continue;                  // must read as a tour print
    if (seen.has(slug)) continue;
    seen.add(slug);
    posters.push(parse(slug, loc, image));
  }
  posters.sort((a, b) => (a.tourSort).localeCompare(b.tourSort));

  const payload = {
    importedAt: new Date().toISOString(),
    description:
      "Widespread Panic tour prints (one commissioned poster per tour), harvested from the band's official poster archive sitemap. Not per-show gig posters. Each entry: year, tour, artist credit, image URL, and a link back to the official page. Attribution required: credit the poster artist; link back; do not present the art as your own.",
    source: { publisher: "widespreadpanic.com/posters (official)", note: "Poster art © the credited artists. Display with credit + link-back." },
    count: posters.length,
    posters
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${posters.length} tour prints to ${path.relative(root, OUT)}.`);
  const withArtist = posters.filter((p) => p.artist).length;
  const mikey = posters.filter((p) => Number(p.year) <= 2002).length;
  console.log(`  with artist credit: ${withArtist} | Mikey-era (<=2002): ${mikey} | with image: ${posters.filter((p) => p.image).length}`);
}

function parse(slug, loc, image) {
  const year = slug.match(/^((19|20)\d{2})/)[1];
  let rest = slug.replace(/^((19|20)\d{2})-/, "");
  const season = Object.keys(SEASONS).find((s) => rest.includes(s));

  // strip tour descriptors + trailing variant number -> what's left is the artist slug
  const artistSlug = rest
    .replace(/\b(spring|summer|fall|winter)\b/g, " ")
    .replace(/\b(tour|generic|run|nye|halloween|new-year|acoustic|wood|horde|invasion|carolinas|allman-bros-cobill|cobill|germany|panic-en-la-playa|playa)\b/g, " ")
    .replace(/-?\d{1,2}$/, " ")
    .replace(/[-\s]+/g, " ").trim();
  const artist = artistSlug && artistSlug !== "generic" ? formatArtist(artistSlug) : null;

  // human tour label
  const special = /horde/.test(slug) ? "HORDE Tour"
    : /germany/.test(slug) ? "Germany Tour"
    : /wood/.test(slug) ? "Wood Tour"
    : /carolinas-invasion/.test(slug) ? "Carolinas Invasion Tour"
    : /allman-bros-cobill/.test(slug) ? "Allman Brothers Co-Bill Tour"
    : /panic-en-la-playa|playa/.test(slug) ? "Panic en la Playa"
    : null;
  const tour = special ? `${year} ${special}` : `${year} ${season ? SEASONS[season] : "Tour"}${season ? " Tour" : ""}`.replace(/\s+/g, " ").trim();
  const tourSort = `${year}-${season ? { spring: 1, summer: 2, fall: 3, winter: 4 }[season] : 0}`;

  return { year, tour, tourSort, season: season ? SEASONS[season] : null, artist, image, sourceUrl: loc };
}

function formatArtist(s) {
  return s.split(" ").map((w) => (w.length === 1 ? `${w.toUpperCase()}.` : w.replace(/\b\w/g, (c) => c.toUpperCase())))
    .join(" ").replace(/\bJ\. T\./g, "J.T.").replace(/\s+/g, " ").trim();
}

main().catch((e) => { console.error(e); process.exit(1); });
