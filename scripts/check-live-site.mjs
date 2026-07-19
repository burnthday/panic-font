import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const origin = process.env.SITE_ORIGIN || "https://burnthday.com";
const expected = JSON.parse(await readFile(path.join(root, "dist", "data", "freshness.json"), "utf8"));
const attempts = Number(process.env.HEALTH_CHECK_ATTEMPTS || 6);

let lastError;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await verifyLiveSite();
    console.log(`Production health check passed for ${origin}.`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < attempts) await wait(attempt * 3000);
  }
}

throw lastError;

async function verifyLiveSite() {
  const [home, freshness, sitemap, robots, socialCard] = await Promise.all([
    fetchRequired("/", "text"),
    fetchRequired("/data/freshness.json", "json"),
    fetchRequired("/sitemap.xml", "text"),
    fetchRequired("/robots.txt", "text"),
    fetchRequired("/assets/social-card.png", "response")
  ]);

  assert(home.includes(`<title>${expected.site.title} by Burnthday</title>`), "Homepage title does not match the generated build");
  assert(home.includes('<link rel="canonical" href="https://burnthday.com/">'), "Homepage canonical is missing");
  assert(home.includes('https://burnthday.com/assets/social-card.png'), "Homepage social card is missing");
  assert(freshness.generatedAt === expected.generatedAt, "Live freshness report does not match this deployment");
  assert(sitemap.includes("https://burnthday.com/"), "Sitemap is missing the canonical homepage");
  assert(robots.includes("https://burnthday.com/sitemap.xml"), "Robots file is missing the sitemap");
  assert((socialCard.headers.get("content-type") || "").startsWith("image/png"), "Social card is not served as PNG");
}

async function fetchRequired(pathname, mode) {
  const response = await fetch(new URL(pathname, origin), { redirect: "follow" });
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
  if (mode === "json") return response.json();
  if (mode === "text") return response.text();
  return response;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
