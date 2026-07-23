// scripts/nick-model-backtest.mjs
// ─────────────────────────────────────────────────────────────────────────────
// DEV-ONLY analysis tool. Walk-forward validation of the "Most likely next"
// Nick-model that powers renderNickRanking() in scripts/build.mjs. NOT wired into
// the site build; run by hand:  node scripts/nick-model-backtest.mjs
//
// It reads the full setlist.fm history (data/source/setlistfm-cache.json, ~3,100
// shows with setlists) and, for each of the last N shows, rebuilds song stats
// from *earlier shows only* (no leakage), generates the eligible "not recently
// played" candidate pool, ranks it three ways, and scores each ranking against
// what the band actually played that night:
//
//   • nick-model     — the real two-stage model (recent-rotation strength +
//                      empirical due-percentile + very-recent boost + shrinkage)
//   • recent-freq     — baseline: rank the same pool by recent play frequency only
//   • overdue-ratio   — baseline: rank the same pool by currentGap / medianGap only
//
// Metrics per model: Top-5 hit rate, Top-10 hit rate, Mean Reciprocal Rank.
// Fully deterministic — no Date.now(), no Math.random(). The model function below
// is a byte-for-byte duplicate of nickHeatModel() in scripts/build.mjs; keep them
// in sync (the spec explicitly permits import-or-duplicate).
// ─────────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── title normalization (duplicated from build.mjs, kept minimal) ────────────
const NORMALIZED_TITLE_ALIASES = {
  bowleggedwomanknockkneedman: "bowleggedwoman",
  conradthecaterpillar: "conrad",
  cosmicconfidant: "cosmicconfidante",
  fixintodieblues: "fixintodie",
  goodmorningschoolgirl: "goodmorninglittleschoolgirl",
  heroesdavidbowie: "heroesdb",
  imjustanoldchunkofcoalbutimgonnabeadiamondsomeday: "chunkofcoal",
  jamaisvutheworldhaschanged: "jamaisvu",
  juncopartnerworthlessman: "juncopartner",
  knockinaroundthezoo: "knockingroundthezoo",
  knockinroundthezoo: "knockingroundthezoo",
  nobodysfault: "nobodysfaultbutmine",
  runnindownadream: "runningdownadream",
  seethatmygraveiskeptclean: "onekindfavor",
  shecaughtthekatyandleftmeamuletoride: "shecaughtthekaty",
  theheathen: "heathen",
  thelowsparkofhighheeledboys: "lowsparkofhighheeledboys",
  thismustbetheplacenavemelody: "thismustbetheplacenaivemelody",
  wrm: "wurm"
};
function normalizeTitle(title) {
  const base = String(title || "")
    .replace(/\s+/g, " ").trim()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/×/g, "x")
    .replace(/&/g, "and")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return NORMALIZED_TITLE_ALIASES[base] || base;
}
function isPseudoSong(key) {
  return key === "jam" || key === "drumsandbass" || key === "drumsbass";
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE MODEL  (duplicate of nickHeatModel in build.mjs — keep in sync)
// ═══════════════════════════════════════════════════════════════════════════
// Inputs:
//   entries: [{ key, playedIdx:[ascending show indices], total, nickCount, currentGap }]
//   N:       number of shows in the history window (playedIdx are 0..N-1)
//   opts:    { applyNickGate, weights:{recent,due,boost}, shrinkK }
// Returns Map(key -> {
//   eligible, heat(0-100), raw, c20,c50,c100,c200, strengthRaw, duePct, medianGap,
//   currentGap, overdueRatio
// }). Heat is normalized across ALL entries (comparative ranking, never a %).
function median(sorted) {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function nickHeatModel(entries, N, opts = {}) {
  const weights = opts.weights || { recent: 0.55, due: 0.35, boost: 0.1 };
  const shrinkK = opts.shrinkK ?? 5;
  const applyNickGate = Boolean(opts.applyNickGate);

  const rows = entries.map((entry) => {
    const idx = entry.playedIdx;
    const n = idx.length;
    const countFrom = (lo) => { let c = 0; for (let k = idx.length - 1; k >= 0 && idx[k] >= lo; k -= 1) c += 1; return c; };
    const c20 = countFrom(N - 20);
    const c50 = countFrom(N - 50);
    const c100 = countFrom(N - 100);
    const c200 = countFrom(N - 200);
    const c51_100 = c100 - c50;
    const c101_200 = c200 - c100;
    const strengthRaw = 3 * c50 + 2 * c51_100 + 1 * c101_200;
    // Empirical gap distribution from this song's own history (show-index units).
    const gaps = [];
    for (let k = 1; k < idx.length; k += 1) gaps.push(idx[k] - idx[k - 1]);
    gaps.sort((a, b) => a - b);
    const medianGap = gaps.length ? median(gaps) : null;
    const currentGap = Number.isFinite(entry.currentGap) ? entry.currentGap : (n ? N - 1 - idx[idx.length - 1] : N);
    // due = percentile of the current gap within the song's own gap distribution.
    const duePct = gaps.length ? gaps.filter((g) => g <= currentGap).length / gaps.length : 0;
    const overdueRatio = medianGap ? currentGap / medianGap : 0;

    // Stage 1 eligibility (the "Most likely next" pool).
    const total = Number.isFinite(entry.total) ? entry.total : n;
    const gateA = applyNickGate ? entry.nickCount === 0 : true;
    const gateB = currentGap > 4;
    const gateC = c100 >= 3 || c200 >= 5 || c50 >= 2;
    const bothWithin150 = n === 2 && idx.every((i) => i >= N - 150);
    const gateD = total > 1 && n > 1 && (n !== 2 || bothWithin150);
    const eligible = gateA && gateB && gateC && gateD;

    return { key: entry.key, n, c20, c50, c100, c200, c51_100, c101_200, strengthRaw, medianGap, currentGap, duePct, overdueRatio, total, eligible };
  });

  const maxStrength = Math.max(1, ...rows.map((r) => r.strengthRaw));
  const maxC20 = Math.max(1, ...rows.map((r) => r.c20));
  rows.forEach((r) => {
    const recentStrength = r.strengthRaw / maxStrength;
    const boost = r.c20 / maxC20;
    r.raw = weights.recent * recentStrength + weights.due * r.duePct + weights.boost * boost;
  });
  // Reliability shrinkage: pull each raw toward the pool mean by n/(n+k),
  // n = meaningful recent appearances (c200). Low-evidence songs regress to middle.
  const meanRaw = rows.reduce((s, r) => s + r.raw, 0) / (rows.length || 1);
  rows.forEach((r) => {
    const nMeaningful = r.c200;
    r.shrunk = meanRaw + (r.raw - meanRaw) * (nMeaningful / (nMeaningful + shrinkK));
  });
  // Heat is normalized (min-max) over a display pool so it reads as a comparative
  // 0-100 ranking within the songs that actually show a Heat column. Ranking ORDER
  // is invariant to the pool choice, so backtest metrics are unaffected.
  const heatPool = typeof opts.heatPool === "function" ? rows.filter((r) => opts.heatPool(r)) : rows;
  const poolVals = (heatPool.length ? heatPool : rows).map((r) => r.shrunk);
  const minS = Math.min(...poolVals);
  const maxS = Math.max(...poolVals);
  const span = maxS - minS || 1;
  const out = new Map();
  rows.forEach((r) => {
    r.heat = Math.max(0, Math.min(100, Math.round(2 + ((r.shrunk - minS) / span) * 98)));
    out.set(r.key, r);
  });
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  DATA LOADING + WALK-FORWARD HARNESS
// ═══════════════════════════════════════════════════════════════════════════
async function loadShows() {
  const cache = JSON.parse(await readFile(path.join(root, "data", "source", "setlistfm-cache.json"), "utf8"));
  return (cache.shows || [])
    .filter((s) => s?.date && Array.isArray(s.songs) && s.songs.length)
    .map((s) => ({
      date: s.date,
      keys: [...new Set(s.songs.map((song) => normalizeTitle(song.name)).filter((k) => k && !isPseudoSong(k)))]
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Build the entries[] the model consumes from the first `upto` shows (exclusive).
function buildEntries(shows, upto) {
  const idxByKey = new Map();
  for (let i = 0; i < upto; i += 1) {
    for (const key of shows[i].keys) {
      if (!idxByKey.has(key)) idxByKey.set(key, []);
      idxByKey.get(key).push(i);
    }
  }
  const entries = [];
  for (const [key, playedIdx] of idxByKey) {
    entries.push({ key, playedIdx, total: playedIdx.length, nickCount: 0, currentGap: upto - 1 - playedIdx[playedIdx.length - 1] });
  }
  return entries;
}

function rankEligible(model, keyFn) {
  const eligible = [...model.values()].filter((r) => r.eligible);
  return eligible.sort((a, b) => keyFn(b) - keyFn(a) || a.key.localeCompare(b.key)).map((r) => r.key);
}

function scoreRunWeighted(shows, testCount, weights) {
  const N = shows.length;
  const start = Math.max(1, N - testCount);
  let n = 0, top5 = 0, top10 = 0, rrSum = 0;
  for (let i = start; i < N; i += 1) {
    const heat = nickHeatModel(buildEntries(shows, i), i, { applyNickGate: false, weights });
    const ranked = rankEligible(heat, (r) => r.heat);
    const actual = new Set(shows[i].keys);
    const eligibleSet = new Set(ranked);
    const positives = [...actual].filter((k) => eligibleSet.has(k));
    if (!positives.length && !ranked.length) continue;
    n += 1;
    const t5 = new Set(ranked.slice(0, 5)); const t10 = new Set(ranked.slice(0, 10));
    if (positives.some((k) => t5.has(k))) top5 += 1;
    if (positives.some((k) => t10.has(k))) top10 += 1;
    let rr = 0; for (let r = 0; r < ranked.length; r += 1) { if (actual.has(ranked[r])) { rr = 1 / (r + 1); break; } }
    rrSum += rr;
  }
  return { top5: top5 / n, top10: top10 / n, mrr: rrSum / n };
}

function scoreRun(shows, testCount, ranker) {
  const N = shows.length;
  const start = Math.max(1, N - testCount);
  let n = 0, top5 = 0, top10 = 0, rrSum = 0;
  for (let i = start; i < N; i += 1) {
    const model = buildEntries(shows, i);
    const heat = nickHeatModel(model, i, { applyNickGate: false });
    const ranked = ranker(heat);
    const actual = new Set(shows[i].keys);
    // Positives = songs actually played at show i that were in the eligible pool.
    const eligibleSet = new Set(ranked);
    const positives = [...actual].filter((k) => eligibleSet.has(k));
    if (!positives.length && !ranked.length) continue; // nothing predictable
    n += 1;
    const top5set = new Set(ranked.slice(0, 5));
    const top10set = new Set(ranked.slice(0, 10));
    if (positives.some((k) => top5set.has(k))) top5 += 1;
    if (positives.some((k) => top10set.has(k))) top10 += 1;
    // MRR: reciprocal rank of the first predicted song that actually played.
    let rr = 0;
    for (let r = 0; r < ranked.length; r += 1) { if (actual.has(ranked[r])) { rr = 1 / (r + 1); break; } }
    rrSum += rr;
  }
  return { shows: n, top5: top5 / n, top10: top10 / n, mrr: rrSum / n };
}

function pct(x) { return (x * 100).toFixed(1) + "%"; }
function fmtRow(label, r) {
  return `${label.padEnd(16)} ${pct(r.top5).padStart(8)} ${pct(r.top10).padStart(9)} ${r.mrr.toFixed(3).padStart(7)}`;
}

async function main() {
  const shows = await loadShows();
  const TEST = 100;
  const N = shows.length;

  // The real model: rank eligible pool by Heat (which already fuses the signals).
  const nickModel = (heat) => rankEligible(heat, (r) => r.heat);
  // Baseline (a): recent-frequency only — rank eligible by recent play strength.
  const recentFreq = (heat) => rankEligible(heat, (r) => r.strengthRaw + r.c100 * 0.001);
  // Baseline (b): overdue-ratio only — rank eligible by currentGap / medianGap.
  const overdueRatio = (heat) => rankEligible(heat, (r) => r.overdueRatio);

  if (process.env.NICK_SWEEP) {
    console.log("\nWeight sweep (recent/due/boost) — Top5 / Top10 / MRR:");
    const grid = [];
    for (let re = 0.4; re <= 0.75; re += 0.05) {
      for (let du = 0.1; du <= 0.45; du += 0.05) {
        const bo = 1 - re - du;
        if (bo < 0 || bo > 0.25) continue;
        const w = { recent: re, due: du, boost: bo };
        const r = scoreRunWeighted(shows, TEST, w);
        grid.push({ w, r, sum: r.top5 + r.top10 + r.mrr });
      }
    }
    grid.sort((a, b) => b.sum - a.sum);
    for (const g of grid.slice(0, 12)) {
      console.log(`  ${g.w.recent.toFixed(2)}/${g.w.due.toFixed(2)}/${g.w.boost.toFixed(2)}  ${pct(g.r.top5)} ${pct(g.r.top10)} ${g.r.mrr.toFixed(3)}`);
    }
    console.log("");
  }

  const rNick = scoreRun(shows, TEST, nickModel);
  const rFreq = scoreRun(shows, TEST, recentFreq);
  const rOver = scoreRun(shows, TEST, overdueRatio);

  console.log(`\nWalk-forward backtest — last ${TEST} shows of ${N} (chronological, no leakage)`);
  console.log(`Eligible-pool "next played" prediction. Scored shows: ${rNick.shows}\n`);
  console.log("model".padEnd(16) + "    Top-5    Top-10     MRR");
  console.log("-".repeat(48));
  console.log(fmtRow("nick-model", rNick));
  console.log(fmtRow("recent-freq", rFreq));
  console.log(fmtRow("overdue-ratio", rOver));
  console.log("");

  // ── Current top-10 sanity check (full history, real Nick gate) ──────────────
  const siteData = JSON.parse(await readFile(path.join(root, "dist", "data", "site-data.json"), "utf8"));
  const rotation = (siteData.catalog || []).filter((s) => s.effectiveSlp < siteData.rules.rotationSlpLimit || s.playedThisTour);
  const idxByKey = new Map();
  shows.forEach((show, i) => { for (const key of show.keys) { if (!idxByKey.has(key)) idxByKey.set(key, []); idxByKey.get(key).push(i); } });
  const entries = rotation.map((s) => ({
    key: s.key,
    playedIdx: idxByKey.get(s.key) || [],
    total: s.total,
    nickCount: s.nickCount,
    currentGap: s.effectiveSlp
  }));
  const nickByKey = new Map(rotation.map((s) => [s.key, s.nickCount]));
  const heat = nickHeatModel(entries, shows.length, { applyNickGate: true, heatPool: (r) => (nickByKey.get(r.key) || 0) === 0 });
  const byKey = new Map(rotation.map((s) => [s.key, s]));
  const top = [...heat.values()].filter((r) => r.eligible).sort((a, b) => b.heat - a.heat).slice(0, 12);
  console.log("Current LIVE top-12 (eligible, real Nick gate) — Heat, gap/usual, plays:\n");
  console.log("Heat  Song".padEnd(38) + "Type       gap/usual   L100  ever");
  console.log("-".repeat(78));
  for (const r of top) {
    const s = byKey.get(r.key);
    const usual = r.medianGap != null ? r.medianGap.toFixed(1) : "—";
    console.log(
      String(r.heat).padStart(3) + "   " +
      (s.title.length > 28 ? s.title.slice(0, 27) + "…" : s.title).padEnd(30) +
      (s.type || "").padEnd(10) + " " +
      `${r.currentGap}/${usual}`.padStart(9) + "   " +
      String(r.c100).padStart(4) + "  " + String(s.total).padStart(4)
    );
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); });
