import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const checks = [];

async function main() {
  const [freshness, siteData, redirects, headers, sitemap, workflow, packageJson] = await Promise.all([
    readJson("dist/data/freshness.json"),
    readJson("dist/data/site-data.json"),
    readText("dist/_redirects"),
    readText("dist/_headers"),
    readText("dist/sitemap.xml"),
    readText(".github/workflows/deploy.yml"),
    readJson("package.json")
  ]);

  checkFreshness(freshness, siteData);
  await checkCoreRoutes();
  checkRedirects(redirects);
  checkHeaders(headers);
  checkSitemap(sitemap);
  checkAutomation(workflow, packageJson);
  await checkNoLocalSecretFiles();

  const failed = checks.filter((check) => !check.passed);
  for (const check of checks) {
    const prefix = check.passed ? "PASS" : "FAIL";
    console.log(`${prefix} ${check.label}`);
    if (!check.passed && check.detail) console.log(`  ${check.detail}`);
  }
  console.log(`\nProduction readiness: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

function checkFreshness(freshness, siteData) {
  record("Freshness report has generatedAt", isIsoDate(freshness.generatedAt), freshness.generatedAt);
  record("Freshness report names 2026 tour", freshness.site?.year === 2026 && /Widespread Panic 2026 Tour/.test(freshness.site?.title || ""), JSON.stringify(freshness.site));
  record("Freshness board show matches generated site data", sameShow(freshness.site?.boardShow, siteData.site?.boardShow), JSON.stringify(freshness.site?.boardShow));
  record("Freshness latest setlist matches generated site data", sameShow(freshness.site?.latestSetlist, siteData.site?.latestShow), JSON.stringify(freshness.site?.latestSetlist));
  record("Freshness totals match generated tour data", sameTotals(freshness.totals, siteData.totals), JSON.stringify(freshness.totals));
  record("Prior song stats are strict publish data", freshness.integrity?.strictPriorStats === true && freshness.integrity?.noEcLagRowsInPublishData === true && freshness.integrity?.priorStatsMissingRows === 0, JSON.stringify(freshness.integrity));
  record("Freshness report documents operator commands", Boolean(freshness.commands?.localQa && freshness.commands?.postShowLocal && freshness.commands?.automaticPublishRefresh && freshness.commands?.strictReconcile), JSON.stringify(freshness.commands));
}

function sameShow(left, right) {
  return Boolean(left && right) && ["isoDate", "venue", "location", "runLabel"].every((key) => (left[key] || "") === (right[key] || ""));
}

function sameTotals(left, right) {
  return Boolean(left && right) && ["currentTourSongs", "currentTourPlays", "postedSetlists", "tourDates"].every((key) => left[key] === right[key]);
}

async function checkCoreRoutes() {
  const required = [
    "dist/index.html",
    "dist/p/rumors.html",
    "dist/p/theshelf.html",
    "dist/p/burnthdays-widespread-panic-tours-in.html",
    "dist/p/widespread-panic-song-origins-and.html",
    "dist/p/widespread-panic-dirty-side-down-lyrics.html",
    "dist/p/about.html",
    "dist/song-origins/index.html",
    "dist/tour-in-review/index.html",
    "dist/archive/index.html"
  ];
  const missing = [];
  for (const file of required) {
    try {
      await access(path.join(root, file));
    } catch {
      missing.push(file);
    }
  }
  record("Core legacy and generated routes exist", missing.length === 0, missing.join("\n"));
}

function checkRedirects(redirects) {
  const required = [
    "/tour-in-review /p/burnthdays-widespread-panic-tours-in 301",
    "/tour-in-review/ /p/burnthdays-widespread-panic-tours-in 301",
    "/2025/02/widespread-panic-2025-tour.html /2025/12/widespread-panic-2025-tour-in-review 301",
    "/2025/02/widespread-panic-2025-tour /2025/12/widespread-panic-2025-tour-in-review 301",
    "/search /archive/ 301",
    "/search/* /archive/ 301",
    "/feeds/posts/default /archive/ 301",
    "/feeds/posts/default/* /archive/ 301",
    "/p/:slug.html /p/:slug 301",
    "/:year/:month/:slug.html /:year/:month/:slug 301"
  ];
  const missing = required.filter((line) => !redirects.includes(line));
  record("Redirects preserve important Blogger and SEO routes", missing.length === 0, missing.join("\n"));
}

function checkHeaders(headers) {
  record("Security headers are present", ["X-Content-Type-Options: nosniff", "Referrer-Policy: strict-origin-when-cross-origin", "Permissions-Policy:"].every((line) => headers.includes(line)), headers);
  record("Data files are short-cache for automation freshness", /\/data\/\*\s+Cache-Control: public, max-age=300/s.test(headers), headers);
  record("Assets are immutable-cacheable", /\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/s.test(headers), headers);
}

function checkSitemap(sitemap) {
  const required = [
    "https://burnthday.com/",
    "https://burnthday.com/archive/",
    "https://burnthday.com/song-origins/",
    "https://burnthday.com/2025/12/widespread-panic-2025-tour-in-review"
  ];
  const missing = required.filter((loc) => !sitemap.includes(`<loc>${loc}</loc>`));
  const urlCount = (sitemap.match(/<url>/g) || []).length;
  record("Sitemap includes core public URLs", missing.length === 0, missing.join("\n"));
  record("Sitemap has substantial archive coverage", urlCount >= 250, `urlCount=${urlCount}`);
}

function checkAutomation(workflow, packageJson) {
  record("QA script includes production readiness", /validate:production/.test(packageJson.scripts?.qa || ""), packageJson.scripts?.qa || "");
  record("Deploy workflow runs the EC-independent automatic refresh", /npm run refresh:automatic/.test(workflow), workflow);
  record("Scheduled deploy does not require Everyday Companion", !/refresh:strict|import:playstats|import:ec-prior-stats/.test(workflow), workflow);
  record("Automatic refresh stages data before replacing the ledger", /refresh-automatic\.mjs/.test(packageJson.scripts?.["refresh:automatic"] || ""), packageJson.scripts?.["refresh:automatic"] || "");
  record("QA and deploy wait for a complete refresh", (workflow.match(/if: steps\.refresh\.outputs\.ready == 'true'/g) || []).length === 2, workflow);
  record("Deploy workflow runs full QA before publishing", /npm run qa/.test(workflow), workflow);
  record("Deploy workflow does not allow critical data imports to fail open", !/continue-on-error:\s*true/.test(workflow), workflow);
  record("Deploy workflow still targets Cloudflare Pages", /pages deploy dist --project-name burnthday/.test(workflow), workflow);
  record("Deploy workflow reads the Cloudflare token from GitHub Secrets", /apiToken:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/.test(workflow), workflow);
  record("Deploy workflow pins current Wrangler and the Pages account", /accountId:\s*bb75082c91976ca06b7f958041f91239/.test(workflow) && /wranglerVersion:\s*4\.111\.0/.test(workflow), workflow);
}

async function checkNoLocalSecretFiles() {
  const secretCandidates = [".env", ".env.local", ".env.production", "credentials.json", "service-account.json"];
  const present = [];
  for (const candidate of secretCandidates) {
    try {
      const info = await stat(path.join(root, candidate));
      if (info.isFile()) present.push(candidate);
    } catch {
      // File absent is what we want.
    }
  }
  record("No local secret files are present in repo root", present.length === 0, present.join("\n"));
}

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function record(label, passed, detail = "") {
  checks.push({ label, passed: Boolean(passed), detail });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
