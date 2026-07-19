import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const checks = [];

async function main() {
  const [freshness, siteData, redirects, headers, sitemap, workflow, packageJson, homeHtml, robots, notFoundHtml] = await Promise.all([
    readJson("dist/data/freshness.json"),
    readJson("dist/data/site-data.json"),
    readText("dist/_redirects"),
    readText("dist/_headers"),
    readText("dist/sitemap.xml"),
    readText(".github/workflows/deploy.yml"),
    readJson("package.json"),
    readText("dist/index.html"),
    readText("dist/robots.txt"),
    readText("dist/404.html")
  ]);

  checkFreshness(freshness, siteData);
  await checkCoreRoutes();
  checkRedirects(redirects);
  checkHeaders(headers);
  checkSitemap(sitemap);
  checkAnalyticsAndSeo(homeHtml, robots, notFoundHtml);
  await checkGeneratedMetadata();
  checkAutomation(workflow, packageJson);
  await checkHostnameRedirect();
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

async function checkHostnameRedirect() {
  const source = await readText("functions/[[path]].js");
  record("Hostname redirect targets www.burnthday.com", source.includes('url.hostname === "www.burnthday.com"'));
  record("Hostname redirect uses the canonical apex domain", source.includes('url.hostname = "burnthday.com"'));
  record("Hostname redirect is permanent and preserves the request URL", source.includes("Response.redirect(url.toString(), 301)"));
  record("Apex requests pass through to Pages", source.includes("return context.next()"));
}

function checkFreshness(freshness, siteData) {
  record("Freshness report has generatedAt", isIsoDate(freshness.generatedAt), freshness.generatedAt);
  const year = Number(freshness.site?.year);
  record("Freshness report names its active tour year", Number.isInteger(year) && new RegExp(`Widespread Panic ${year} Tour`).test(freshness.site?.title || ""), JSON.stringify(freshness.site));
  record("Freshness board show matches generated site data", sameShow(freshness.site?.boardShow, siteData.site?.boardShow), JSON.stringify(freshness.site?.boardShow));
  record("Freshness featured show matches generated site data", sameShow(freshness.site?.featuredShow, siteData.site?.featuredShow), JSON.stringify(freshness.site?.featuredShow));
  record("Freshness show-day state matches generated site data", freshness.site?.isShowDayPreview === Boolean(siteData.site?.isShowDayPreview), JSON.stringify(freshness.site));
  record("Freshness latest setlist matches generated site data", sameShow(freshness.site?.latestSetlist, siteData.site?.latestShow), JSON.stringify(freshness.site?.latestSetlist));
  record("Freshness totals match generated tour data", sameTotals(freshness.totals, siteData.totals), JSON.stringify(freshness.totals));
  record("Prior song stats are publish-safe verified data", freshness.integrity?.publishSafePriorStats === true && freshness.integrity?.noUnverifiedEcLagRowsInPublishData === true && freshness.integrity?.priorStatsMissingRows === 0, JSON.stringify(freshness.integrity));
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
    "dist/rumors/index.html",
    "dist/shelf/index.html",
    "dist/tour-in-review/index.html",
    "dist/lyrics-chords/index.html",
    "dist/about/index.html",
    "dist/privacy/index.html",
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
    "/tour-in-review /tour-in-review/ 301",
    "/2025/02/widespread-panic-2025-tour.html /2025/12/widespread-panic-2025-tour-in-review 301",
    "/2025/02/widespread-panic-2025-tour /2025/12/widespread-panic-2025-tour-in-review 301",
    "/search /archive/ 301",
    "/search/* /archive/ 301",
    "/feeds/posts/default /archive/ 301",
    "/feeds/posts/default/* /archive/ 301",
    "/p/rumors /rumors/ 301",
    "/p/rumors.html /rumors/ 301",
    "/p/widespread-panic-dirty-side-down-lyrics /lyrics-chords/ 301",
    "/p/widespread-panic-dirty-side-down-lyrics.html /lyrics-chords/ 301",
    "/p/widespread-panic-song-origins-and /song-origins/ 301",
    "/p/widespread-panic-song-origins-and.html /song-origins/ 301",
    "/p/burnthdays-widespread-panic-tours-in /tour-in-review/ 301",
    "/p/burnthdays-widespread-panic-tours-in.html /tour-in-review/ 301",
    "/p/theshelf /shelf/ 301",
    "/p/theshelf.html /shelf/ 301",
    "/p/about /about/ 301",
    "/p/about.html /about/ 301",
    "/p/privacy /privacy/ 301",
    "/p/privacy.html /privacy/ 301",
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
    "https://burnthday.com/rumors/",
    "https://burnthday.com/lyrics-chords/",
    "https://burnthday.com/tour-in-review/",
    "https://burnthday.com/shelf/",
    "https://burnthday.com/about/",
    "https://burnthday.com/privacy/",
    "https://burnthday.com/2025/12/widespread-panic-2025-tour-in-review"
  ];
  const missing = required.filter((loc) => !sitemap.includes(`<loc>${loc}</loc>`));
  const urlCount = (sitemap.match(/<url>/g) || []).length;
  record("Sitemap includes core public URLs", missing.length === 0, missing.join("\n"));
  record("Sitemap excludes redirected Blogger core URLs", !/<loc>https:\/\/burnthday\.com\/p\/(?:rumors|widespread-panic-dirty-side-down-lyrics|widespread-panic-song-origins-and|burnthdays-widespread-panic-tours-in|theshelf|about|privacy)(?:\.html)?<\/loc>/.test(sitemap), "Redirected /p/ URL found in sitemap");
  record("Sitemap has substantial archive coverage", urlCount >= 250, `urlCount=${urlCount}`);
}

function checkAnalyticsAndSeo(homeHtml, robots, notFoundHtml) {
  record("Homepage installs the Burnthday GA4 stream", /googletagmanager\.com\/gtag\/js\?id=G-R74CMVLLK1/.test(homeHtml) && /gtag\('config', 'G-R74CMVLLK1'\)/.test(homeHtml), "G-R74CMVLLK1");
  record("Homepage has its HTTPS canonical URL", /<link rel="canonical" href="https:\/\/burnthday\.com\/">/.test(homeHtml));
  record("Homepage has social sharing metadata", /property="og:image"/.test(homeHtml) && /name="twitter:card" content="summary_large_image"/.test(homeHtml));
  record("Homepage uses a full-size local social card", /og:image" content="https:\/\/burnthday\.com\/assets\/social-card\.png"/.test(homeHtml) && /og:image:width" content="1200"/.test(homeHtml) && /og:image:height" content="630"/.test(homeHtml));
  record("Homepage identifies Burnthday as a WebSite", /"@type":"WebSite"/.test(homeHtml) && /"url":"https:\/\/burnthday\.com\/"/.test(homeHtml));
  record("Robots file advertises the HTTPS sitemap", robots.includes("Sitemap: https://burnthday.com/sitemap.xml"), robots);
  record("Branded 404 exists and is not indexable", /Page Not Found/.test(notFoundHtml) && /name="robots" content="noindex"/.test(notFoundHtml));
  record("404 does not create an Analytics page view", !/googletagmanager|gtag\('config'/.test(notFoundHtml));
}

async function checkGeneratedMetadata() {
  const files = (await readdir(path.join(root, "dist"), { recursive: true }))
    .filter((file) => file.endsWith(".html"));
  const pages = [];
  const legacyInternalLinks = [];
  for (const file of files) {
    const html = await readText(path.join("dist", file));
    if (/name="robots" content="noindex"/i.test(html)) continue;
    if (/href="(?:https?:\/\/(?:www\.)?burnthday\.com)?\/p\/(?:rumors|widespread-panic-dirty-side-down-lyrics|widespread-panic-song-origins-and|burnthdays-widespread-panic-tours-in|theshelf|about|privacy)(?:\.html)?[\"#?]/.test(html)) {
      legacyInternalLinks.push(file);
    }
    pages.push({
      file,
      title: decodeEntities(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ""),
      description: decodeEntities(html.match(/<meta name="description" content="([^"]*)">/i)?.[1] || ""),
      canonical: html.match(/<link rel="canonical" href="([^"]*)">/i)?.[1] || "",
      socialTitle: html.match(/<meta property="og:title" content="([^"]*)">/i)?.[1] || ""
    });
  }

  const missing = pages.filter((page) => !page.title || !page.description || !page.canonical || !page.socialTitle);
  const oversized = pages.filter((page) => page.title.length > 70 || page.description.length > 155);
  const titles = new Map();
  for (const page of pages) {
    const group = titles.get(page.title) || [];
    group.push(page);
    titles.set(page.title, group);
  }
  const conflictingDuplicates = [...titles.values()].filter((group) => {
    if (group.length < 2) return false;
    return new Set(group.map((page) => page.canonical)).size > 1;
  });

  record("Every indexable page has complete SEO metadata", missing.length === 0, missing.map((page) => page.file).join("\n"));
  record("Generated titles and descriptions fit search result limits", oversized.length === 0, oversized.map((page) => `${page.file}: ${page.title.length}/${page.description.length}`).join("\n"));
  record("Duplicate titles resolve to one canonical URL", conflictingDuplicates.length === 0, conflictingDuplicates.flat().map((page) => `${page.title}: ${page.file}`).join("\n"));
  const bloggerCoreLinks = pages.filter((page) => /\/p\/(?:rumors|widespread-panic-dirty-side-down-lyrics|widespread-panic-song-origins-and|burnthdays-widespread-panic-tours-in|theshelf|about|privacy)(?:\.html)?(?:[\"#?]|$)/.test(page.canonical));
  record("No indexable page uses a Blogger core canonical", bloggerCoreLinks.length === 0, bloggerCoreLinks.map((page) => `${page.file}: ${page.canonical}`).join("\n"));
  record("Generated internal links use clean core routes", legacyInternalLinks.length === 0, legacyInternalLinks.join("\n"));
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function checkAutomation(workflow, packageJson) {
  record("QA script includes production readiness", /validate:production/.test(packageJson.scripts?.qa || ""), packageJson.scripts?.qa || "");
  record("Deploy workflow runs the EC-independent automatic refresh", /npm run refresh:automatic/.test(workflow), workflow);
  record("Scheduled deploy does not require Everyday Companion", !/refresh:strict|import:playstats|import:ec-prior-stats/.test(workflow), workflow);
  record("Automatic refresh stages data before replacing the ledger", /refresh-automatic\.mjs/.test(packageJson.scripts?.["refresh:automatic"] || ""), packageJson.scripts?.["refresh:automatic"] || "");
  record("Publish, verification, and reporting wait for a complete refresh", (workflow.match(/if: steps\.refresh\.outputs\.ready == 'true'/g) || []).length === 4, workflow);
  record("Deploy workflow runs full QA before publishing", /npm run qa/.test(workflow), workflow);
  record("Deploy workflow does not allow critical data imports to fail open", !/continue-on-error:\s*true/.test(workflow), workflow);
  record("Deploy workflow still targets Cloudflare Pages", /pages deploy dist --project-name burnthday/.test(workflow), workflow);
  record("Deploy workflow verifies the live site after publishing", /node scripts\/check-live-site\.mjs/.test(workflow), workflow);
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
