#!/usr/bin/env node
/*
 * build-nfl-td-snapshot.mjs
 * -------------------------------------------------------------------------
 * Refreshes the offline data snapshot for nfl-td-predictor.html.
 *
 * Pipeline:
 *   1. Download nflverse play-by-play CSVs (default 2024, 2025, 2026) to a
 *      cache dir. These are the primary source for every player/team rate.
 *   2. Stream-parse them, computing:
 *        - per-team offensive profile  (off TDs/gm, run/pass TD split,
 *          pace, red-zone TD%)
 *        - per-team defensive profile  (TDs allowed/gm, RZ TD% allowed,
 *          rush vs pass TD funnel, non-offensive/return TD rate)
 *        - per-player opportunity scores (goal-line carries <=5, RZ targets,
 *          air yards, realized rush/rec TD rate), recency-weighted + shrunk
 *   3. Pull ESPN for current rosters, positions, jersey #, injury status,
 *      team colors and logo URLs.
 *   4. Download the 32 team logos and embed them as base64 data URIs so the
 *      final HTML is fully offline.
 *   5. Run an honest out-of-sample backtest: train rates on the earliest
 *      full season, predict every game of the next season using ONLY that
 *      prior data + the real closing Vegas total/spread, and score the
 *      anytime-TD predictions with Brier score + log loss (vs a base-rate
 *      baseline). No leakage, no hardcoded outcomes.
 *   6. Inject the compact snapshot into nfl-td-predictor.template.html ->
 *      nfl-td-predictor.html.
 *
 * Usage:
 *   node build-nfl-td-snapshot.mjs                 # default seasons
 *   node build-nfl-td-snapshot.mjs 2023 2024 2025  # custom seasons
 *   SKIP_LOGOS=1 node build-nfl-td-snapshot.mjs    # faster, no logo embed
 *
 * No npm dependencies. Requires Node 18+ and curl on PATH.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const argSeasons = process.argv.slice(2).map(Number).filter(n => n >= 1999 && n <= 2100);
const SEASONS = argSeasons.length ? argSeasons : [2024, 2025, 2026];
const TRAIN_SEASON = SEASONS[0];                 // backtest trains on the oldest season...
const TEST_SEASON = SEASONS[1] || SEASONS[0];    // ...and tests on the next one
const CACHE_DIR = process.env.NFL_CACHE_DIR ||
  path.join(process.env.TEMP || process.env.TMP || '/tmp', 'nflverse_cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const SHRINK_GAMES = 4;        // pseudo-games of zero blended into every per-game rate
const SIM_META = { nsims: 10000 };
// team TD overdispersion (gamma-Poisson) — MUST match the live sim's NB_SIZE in the
// template. Thinning a gamma-Poisson team count by a fixed player share yields another
// gamma-Poisson with the same size, so a player's anytime prob is exactly
// 1 - (1 + exp/NB_SIZE)^(-NB_SIZE). The backtest uses this so it measures the SHIPPED
// model, not a Poisson approximation that ran ~1-4pt hot on high-usage players.
const NB_SIZE = 6;
const nbAnytime = exp => 1 - Math.pow(1 + exp / NB_SIZE, -NB_SIZE);

// The model's tunable choices — read by BOTH the live player scores and the backtest, so the
// calibration number always describes exactly what ships (the reshape and Poisson/NB episodes
// were both live/backtest drift). Each switch is picked by the backtest variant grid:
//   BT_EXPERIMENTS=1 node build-nfl-td-snapshot.mjs
// The template reads MODEL (shipped in the snapshot) to turn its matching live adjustments on/off.
const MODEL = {
  noKneel: true,      // drop QB kneel-downs from carry volume (logged as rushes, never score)       [helps H1+H2]
  floor: 'prior',     // thin-history players get the position prior, like live. (The old 'touch' floor
                      //   used whether he touched the ball in THIS game — in-game info the app never has.)
  funnel: false,      // opponent run/pass TD-allowed funnel on the run/pass split                    [hurt H1+H2]
  script: false,      // spread-driven game script (favorites run) on the run/pass split             [hurt H1+H2]
  weather: true,      // wind / rain / snow lean-run on the run/pass split                           [helps H1+H2]
  posMF: false,       // opponent TDs-allowed-by-position matchup multiplier (shown, not applied)    [hurt H1+H2]
  kappa: 'emp',       // offensive TDs per point of closing total, measured off real lines
  wPrior: 0.3,        // last season's weight vs this season's (live season weights = wPrior^age)
  qbCarry: 1,         // QB scaling of the carry-volume term (QBs are calibrated once non-running games count)
  eps: 0.01,          // small universal score floor — a non-leaky hedge against a zero channel
  posPow: 0.5,        // matchup exponent, only if posMF is re-enabled
  shrinkPrior: true,  // shrink thin samples toward the position-shaped prior instead of toward zero
  ps: 0.5,            // strength of that prior
  snapFull: 0.35,     // snap share at which the role weight reaches 1
  snapFloor: 0.2,     // minimum role weight for a player with any snaps
  qbSnapExempt: true, // the starting QB skips the snap weight (he plays every snap)
  snap: 'hybrid',     // snap-share role weight: min(1,max(0.2,snap/35%)); no snaps yet = unknown in the
                      //   first 2 weeks, then ~0 (likely scratch). The old 0-at-5% curve hurt accuracy.
};
// season recency weights for the live blend, derived from the backtested wPrior (current = 1)
const SEASON_WEIGHT = {};
for (const yr of SEASONS) SEASON_WEIGHT[yr] = Math.pow(MODEL.wPrior, Math.max(...SEASONS) - yr);
// position priors for players with no play-by-play history (same values the live roster uses)
const PRIOR = { RB: { rush: 0.055, rec: 0.03 }, FB: { rush: 0.02, rec: 0.012 }, WR: { rush: 0.004, rec: 0.045 }, TE: { rush: 0.002, rec: 0.035 }, QB: { rush: 0.035, rec: 0 } };

// ESPN abbr -> nflverse abbr
const ESPN2NFL = { WSH: 'WAS', LAR: 'LA' };
const nflAbbr = a => ESPN2NFL[a] || a;

// Home stadiums: dome = climate-controlled (fixed or retractable roof -> no weather),
// lat/lon for the live weather lookup. Roof types are stable year to year.
const STADIUMS = {
  ARI: { name: 'State Farm Stadium', dome: true, lat: 33.5277, lon: -112.2626 },
  ATL: { name: 'Mercedes-Benz Stadium', dome: true, lat: 33.7554, lon: -84.4008 },
  BAL: { name: 'M&T Bank Stadium', dome: false, lat: 39.2780, lon: -76.6227 },
  BUF: { name: 'Highmark Stadium', dome: false, lat: 42.7738, lon: -78.7870 },
  CAR: { name: 'Bank of America Stadium', dome: false, lat: 35.2258, lon: -80.8528 },
  CHI: { name: 'Soldier Field', dome: false, lat: 41.8623, lon: -87.6167 },
  CIN: { name: 'Paycor Stadium', dome: false, lat: 39.0955, lon: -84.5161 },
  CLE: { name: 'Huntington Bank Field', dome: false, lat: 41.5061, lon: -81.6995 },
  DAL: { name: 'AT&T Stadium', dome: true, lat: 32.7473, lon: -97.0945 },
  DEN: { name: 'Empower Field at Mile High', dome: false, lat: 39.7439, lon: -105.0201 },
  DET: { name: 'Ford Field', dome: true, lat: 42.3400, lon: -83.0456 },
  GB: { name: 'Lambeau Field', dome: false, lat: 44.5013, lon: -88.0622 },
  HOU: { name: 'NRG Stadium', dome: true, lat: 29.6847, lon: -95.4107 },
  IND: { name: 'Lucas Oil Stadium', dome: true, lat: 39.7601, lon: -86.1639 },
  JAX: { name: 'EverBank Stadium', dome: false, lat: 30.3239, lon: -81.6373 },
  KC: { name: 'Arrowhead Stadium', dome: false, lat: 39.0489, lon: -94.4839 },
  LV: { name: 'Allegiant Stadium', dome: true, lat: 36.0909, lon: -115.1833 },
  LAC: { name: 'SoFi Stadium', dome: true, lat: 33.9535, lon: -118.3392 },
  LA: { name: 'SoFi Stadium', dome: true, lat: 33.9535, lon: -118.3392 },
  MIA: { name: 'Hard Rock Stadium', dome: false, lat: 25.9580, lon: -80.2389 },
  MIN: { name: 'U.S. Bank Stadium', dome: true, lat: 44.9736, lon: -93.2575 },
  NE: { name: 'Gillette Stadium', dome: false, lat: 42.0909, lon: -71.2643 },
  NO: { name: 'Caesars Superdome', dome: true, lat: 29.9511, lon: -90.0812 },
  NYG: { name: 'MetLife Stadium', dome: false, lat: 40.8135, lon: -74.0745 },
  NYJ: { name: 'MetLife Stadium', dome: false, lat: 40.8135, lon: -74.0745 },
  PHI: { name: 'Lincoln Financial Field', dome: false, lat: 39.9008, lon: -75.1675 },
  PIT: { name: 'Acrisure Stadium', dome: false, lat: 40.4468, lon: -80.0158 },
  SF: { name: "Levi's Stadium", dome: false, lat: 37.4030, lon: -121.9698 },
  SEA: { name: 'Lumen Field', dome: false, lat: 47.5952, lon: -122.3316 },
  TB: { name: 'Raymond James Stadium', dome: false, lat: 27.9759, lon: -82.5033 },
  TEN: { name: 'Nissan Stadium', dome: false, lat: 36.1665, lon: -86.7713 },
  WAS: { name: 'Northwest Stadium', dome: false, lat: 38.9076, lon: -76.8645 },
};

// ----------------------------------------------------------------------------
// Small utilities
// ----------------------------------------------------------------------------
const log = (...a) => console.log(...a);
const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const isTrue = v => v === '1' || v === 'TRUE' || v === 'True' || v === 'true';
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z]/g, '')
    .trim();
}
function curlToFile(url, dest) {
  execFileSync('curl', ['-sL', '--fail', '-m', '600', '-o', dest, url], { stdio: 'ignore' });
}
function curlJson(url) {
  const r = spawnSync('curl', ['-sL', '--fail', '-m', '90', url], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('curl failed: ' + url);
  return JSON.parse(r.stdout);
}
function curlBase64(url) {
  const r = spawnSync('curl', ['-sL', '--fail', '-m', '60', url], { encoding: 'buffer', maxBuffer: 1 << 26 });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) return null;
  return r.stdout.toString('base64');
}

// Quote-aware CSV line splitter (handles "" escapes and quoted commas).
function splitCSV(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ----------------------------------------------------------------------------
// Accumulators
// ----------------------------------------------------------------------------
// team offense/defense, keyed by "TEAM|SEASON"
const teamOff = new Map();   // {games:Set, offTD, rushTD, passTD, offPlays, rzTrips, rzTD}
const teamDef = new Map();   // {games:Set, tdAllow, rushTDallow, passTDallow, rzTripsAllow, rzTDallow, returnTDfor, byPos}
const players = new Map();   // pid -> {name, seasons:{s:{games:Set,rushAtt,kneel,rushTD,glCarry,tgt,recTD,rzTgt,airY,passAtt}}}

function teamOffRec(team, season) {
  const k = team + '|' + season;
  let r = teamOff.get(k);
  if (!r) { r = { games: new Set(), offTD: 0, rushTD: 0, passTD: 0, offPlays: 0, rzTrips: 0, rzTD: 0, give: 0 }; teamOff.set(k, r); }
  return r;
}
function teamDefRec(team, season) {
  const k = team + '|' + season;
  let r = teamDef.get(k);
  if (!r) { r = { games: new Set(), tdAllow: 0, rushTDallow: 0, passTDallow: 0, rzTripsAllow: 0, rzTDallow: 0, returnTDfor: 0, stTDfor: 0, byPos: { RB: 0, WR: 0, TE: 0, QB: 0 } }; teamDef.set(k, r); }
  return r;
}
// gsis_id -> scoring-position bucket, and the ESPN<->gsis id maps (filled by loadRosters)
const gsis2pos = new Map(), espn2gsis = new Map(), name2gsis = new Map(), pfr2gsis = new Map();
const snapByGsis = new Map();   // gsis -> {snapPct (recency-wtd), lastPct, lastWk} for the current season
let snapWeeks = 0;              // weeks of current-season snap data available
function posBucket(p) { p = (p || '').toUpperCase(); if (p === 'RB' || p === 'FB' || p === 'HB') return 'RB'; if (p === 'WR') return 'WR'; if (p === 'TE') return 'TE'; if (p === 'QB') return 'QB'; return null; }
function playerRec(pid, name, season) {
  let p = players.get(pid);
  if (!p) { p = { name, seasons: {} }; players.set(pid, p); }
  if (name && (!p.name || name.length > p.name.length)) p.name = name;
  if (!p.seasons[season]) p.seasons[season] = { games: new Set(), rushAtt: 0, kneel: 0, rushTD: 0, glCarry: 0, tgt: 0, recTD: 0, rzTgt: 0, airY: 0, passAtt: 0 };
  return p.seasons[season];
}

// league totals (for conversion-rate constants). kneel = QB kneel-downs, which nflverse
// records as rush attempts but are not scoring opportunities.
const league = { gl5carry: 0, gl5td: 0, rzTgt: 0, rzTgtTD: 0, tgt: 0, tgtTD: 0, offTD: 0, rushAtt: 0, kneel: 0, rushTDtot: 0, airYtot: 0 };
// kick/punt returns per player per season -> who gets credited when a return goes for a TD
const returns = new Map();   // gsis -> {season: returns}
// every REG game's closing line + offensive TDs per side (all seasons) -> empirical kappa
const gameLines = new Map();   // gid -> {season, total, spread, homeTD, awayTD}

// load nflverse rosters (newest first) -> espn<->gsis id maps + gsis->position.
// Positions must be known BEFORE parsing PBP so we can bucket each TD scorer.
async function loadRosters() {
  const curSeason = Math.max(...SEASONS);
  for (const s of [...SEASONS].sort((a, b) => b - a)) {
    const rurl = `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${s}.csv`;
    const rdest = path.join(CACHE_DIR, `roster_${s}.csv`);
    // refresh the current season's roster weekly (new signings/rookies); cache prior seasons
    try { if (s === curSeason || !fs.existsSync(rdest) || fs.statSync(rdest).size < 1000) curlToFile(rurl, rdest); } catch { }
    const rl = readline.createInterface({ input: fs.createReadStream(rdest), crlfDelay: Infinity });
    let ix = null;
    for await (const line of rl) {
      if (ix === null) { const h = splitCSV(line); ix = {}; h.forEach((c, i) => { ix[c] = i; }); continue; }
      if (!line) continue;
      const f = splitCSV(line);
      const gsis = f[ix.gsis_id]; if (!gsis) continue;
      const espn = f[ix.espn_id], full = f[ix.full_name], pos = f[ix.position], pfr = f[ix.pfr_id];
      if (espn && !espn2gsis.has(String(espn))) espn2gsis.set(String(espn), gsis);
      if (full) { const nn = normName(full); if (!name2gsis.has(nn)) name2gsis.set(nn, gsis); }
      if (pfr && !pfr2gsis.has(pfr)) pfr2gsis.set(pfr, gsis);
      const bk = posBucket(pos); if (bk && !gsis2pos.has(gsis)) gsis2pos.set(gsis, bk);
    }
  }
  log(`  roster maps: ${espn2gsis.size} espn ids, ${name2gsis.size} names, ${gsis2pos.size} positions, ${pfr2gsis.size} pfr`);
}

// current-season offensive snap share per player (role signal): recency-weighted mean
// of weekly offense_pct, plus the most recent week. Refreshed weekly like the PBP.
async function loadSnaps() {
  const season = Math.max(...SEASONS);
  const url = `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${season}.csv`;
  const dest = path.join(CACHE_DIR, `snaps_${season}.csv`);
  try { curlToFile(url, dest); } catch { log('  ! snap counts unavailable (skipping role signal)'); return; }
  const rl = readline.createInterface({ input: fs.createReadStream(dest), crlfDelay: Infinity });
  let ix = null;
  const agg = new Map();   // gsis -> {sumW, sumWP, lastWk, lastPct}
  for await (const line of rl) {
    if (ix === null) { const h = splitCSV(line); ix = {}; h.forEach((c, i) => { ix[c] = i; }); continue; }
    if (!line) continue;
    const f = splitCSV(line);
    const gsis = pfr2gsis.get(f[ix.pfr_player_id]); if (!gsis) continue;
    const wk = +f[ix.week]; if (!(wk > 0)) continue;
    let pct = num(f[ix.offense_pct]); if (pct > 1) pct /= 100;   // normalize to 0..1
    let a = agg.get(gsis); if (!a) { a = { sumW: 0, sumWP: 0, lastWk: 0, lastPct: 0 }; agg.set(gsis, a); }
    a.sumW += wk; a.sumWP += wk * pct;                            // recency weight = week number
    if (wk > a.lastWk) { a.lastWk = wk; a.lastPct = pct; }
  }
  for (const [g, a] of agg) { snapByGsis.set(g, { snapPct: +(a.sumWP / a.sumW).toFixed(3), lastPct: +a.lastPct.toFixed(3), lastWk: a.lastWk }); if (a.lastWk > snapWeeks) snapWeeks = a.lastWk; }
  log(`  snap counts: ${snapByGsis.size} players with ${season} snaps`);
}
// weekly offense snap % for a past season (gsis -> Map(week -> pct)), so the backtest can apply the
// live snap-share role weight using only the weeks BEFORE each game (leak-free)
async function loadSnapsWeekly(season) {
  const url = `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${season}.csv`;
  const dest = path.join(CACHE_DIR, `snaps_${season}.csv`);
  try { if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) curlToFile(url, dest); } catch { return null; }
  const out = new Map(); let ix = null;
  const rl = readline.createInterface({ input: fs.createReadStream(dest), crlfDelay: Infinity });
  for await (const line of rl) {
    if (ix === null) { const h = splitCSV(line); ix = {}; h.forEach((c, i) => { ix[c] = i; }); continue; }
    if (!line) continue;
    const f = splitCSV(line), gsis = pfr2gsis.get(f[ix.pfr_player_id]); if (!gsis) continue;
    if (f[ix.game_type] && f[ix.game_type] !== 'REG') continue;
    const wk = +f[ix.week]; if (!(wk > 0)) continue;
    let pct = num(f[ix.offense_pct]); if (pct > 1) pct /= 100;
    let m = out.get(gsis); if (!m) { m = new Map(); out.set(gsis, m); } m.set(wk, pct);
  }
  return out;
}

// backtest capture (TEST_SEASON games) + rolling weekly accumulators for an
// honest, leakage-free within-season prior (mirrors how the live model blends
// prior season + season-to-date).
const btGames = new Map();  // gameId -> {home,away,week,total,spread,wind,outdoor,precip, side:{home:Map,away:Map}, scored:Set}
const pw = new Map();       // pid -> Map(week -> {g,rushAtt,kneel,rushTD,glCarry,tgt,rzTgt,recTD,airY})
const tw = new Map();       // team -> Map(week -> {rushTD,passTD,g:Set})          (offense)
const dw = new Map();       // team -> Map(week -> {rushA,passA,byPos,g:Set})       (defense allowed)
function pwRec(pid, wk) {
  let m = pw.get(pid); if (!m) { m = new Map(); pw.set(pid, m); }
  let r = m.get(wk); if (!r) { r = { g: 0, rushAtt: 0, kneel: 0, rushTD: 0, glCarry: 0, tgt: 0, rzTgt: 0, recTD: 0, airY: 0 }; m.set(wk, r); }
  return r;
}
function twRec(team, wk) {
  let m = tw.get(team); if (!m) { m = new Map(); tw.set(team, m); }
  let r = m.get(wk); if (!r) { r = { rushTD: 0, passTD: 0, give: 0, dst: 0, g: new Set() }; m.set(wk, r); }
  return r;
}
function dwRec(team, wk) {
  let m = dw.get(team); if (!m) { m = new Map(); dw.set(team, m); }
  let r = m.get(wk); if (!r) { r = { rushA: 0, passA: 0, byPos: { RB: 0, WR: 0, TE: 0, QB: 0 }, g: new Set() }; m.set(wk, r); }
  return r;
}

// drive-level red-zone tracking (per game+drive): min yardline reached, whether TD
const driveState = new Map(); // key game|drive -> {off, def, minYL, td}

// ----------------------------------------------------------------------------
// Parse one season's PBP
// ----------------------------------------------------------------------------
async function parseSeason(season) {
  const url = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv`;
  const dest = path.join(CACHE_DIR, `pbp_${season}.csv`);
  // The current (newest) season gains games weekly, so ALWAYS re-download it;
  // completed prior seasons are static and safe to cache.
  const isCurrent = season === Math.max(...SEASONS);
  if (isCurrent || !fs.existsSync(dest) || fs.statSync(dest).size < 1000) {
    log(`  downloading ${season} PBP${isCurrent ? ' (current season — refreshed every run)' : ''} ...`);
    try { curlToFile(url, dest); }
    catch {
      if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) log(`  ! ${season} refresh failed; using cached copy`);
      else { log(`  ! ${season} PBP not available, skipping`); return false; }
    }
  }
  log(`  parsing ${season} (${(fs.statSync(dest).size / 1e6).toFixed(0)} MB) ...`);

  const rl = readline.createInterface({ input: fs.createReadStream(dest), crlfDelay: Infinity });
  let idx = null;
  let rows = 0;
  for await (const line of rl) {
    if (idx === null) {
      const hdr = splitCSV(line);
      idx = {};
      hdr.forEach((h, i) => { idx[h] = i; });
      continue;
    }
    if (!line) continue;
    const f = splitCSV(line);
    rows++;
    const stype = f[idx.season_type];
    if (stype !== 'REG' && stype !== 'POST') continue;

    const gid = f[idx.game_id];
    const home = f[idx.home_team];
    const away = f[idx.away_team];
    const pos = f[idx.posteam];
    const def = f[idx.defteam];
    const playType = f[idx.play_type];
    const yl = num(f[idx.yardline_100]);
    const rushTD = isTrue(f[idx.rush_touchdown]);
    const passTD = isTrue(f[idx.pass_touchdown]);
    const retTD = isTrue(f[idx.return_touchdown]);
    const isRush = isTrue(f[idx.rush_attempt]);
    const isPass = isTrue(f[idx.pass_attempt]);
    const kneel = isRush && isTrue(f[idx.qb_kneel]);   // kneel-downs are logged as rushes; not real carries
    const drive = f[idx.drive];

    // ---- per-game closing line + offensive TDs (every REG game, every season) ----
    if (stype === 'REG' && gid) {
      let gl = gameLines.get(gid);
      if (!gl) { gl = { season, total: num(f[idx.total_line]), spread: num(f[idx.spread_line]), homeTD: 0, awayTD: 0 }; gameLines.set(gid, gl); }
      if ((rushTD || passTD) && pos) { if (pos === home) gl.homeTD++; else if (pos === away) gl.awayTD++; }
    }

    // ---- drive-level red-zone bookkeeping ----
    if (pos && drive) {
      const dk = gid + '|' + drive;
      let ds = driveState.get(dk);
      if (!ds) { ds = { off: pos, def, minYL: 99, td: false }; driveState.set(dk, ds); }
      if (yl > 0 && yl < ds.minYL) ds.minYL = yl;
      if (rushTD || passTD) ds.td = true;
    }

    // ---- team offense ----
    if (pos) {
      const to = teamOffRec(pos, season);
      to.games.add(gid);
      if (isRush || isPass) to.offPlays++;
      if (rushTD) { to.offTD++; to.rushTD++; }
      if (passTD) { to.offTD++; to.passTD++; }
      if (isTrue(f[idx.interception]) || isTrue(f[idx.fumble_lost])) to.give++;   // giveaways -> opponent D/ST TD chances
      const td = teamDefRec(def, season);
      td.games.add(gid);
      if (rushTD) { td.tdAllow++; td.rushTDallow++; }
      if (passTD) { td.tdAllow++; td.passTDallow++; }
      if (rushTD || passTD) { const bk = gsis2pos.get(f[idx.td_player_id]); if (bk) td.byPos[bk]++; }
    }
    // Non-offensive TDs, split the way books settle them: a pick-6 / fumble return on a scrimmage play pays
    // the DEFENSE prop; a kick/punt return TD pays the RETURNER's player prop, not the defense.
    const scrim = playType === 'pass' || playType === 'run' || playType === 'qb_kneel' || playType === 'qb_spike';
    if (retTD) {
      const tt = f[idx.td_team];
      if (tt) { if (scrim) teamDefRec(tt, season).returnTDfor++; else teamDefRec(tt, season).stTDfor++; }
    }
    if (playType === 'kickoff' || playType === 'punt') for (const rid of [f[idx.kickoff_returner_player_id], f[idx.punt_returner_player_id]]) if (rid) {
      let m = returns.get(rid); if (!m) { m = {}; returns.set(rid, m); } m[season] = (m[season] || 0) + 1; }

    // ---- league conversion constants ----
    if (isRush) { league.rushAtt++; if (kneel) league.kneel++; if (rushTD) league.rushTDtot++; }
    if (isRush && yl > 0 && yl <= 5) { league.gl5carry++; if (rushTD) league.gl5td++; }
    if (isPass) {
      const tgtId = f[idx.receiver_player_id];
      if (tgtId) {
        league.tgt++; if (passTD) league.tgtTD++;
        league.airYtot += Math.max(0, num(f[idx.air_yards]));   // downfield-target volume
        if (yl > 0 && yl <= 20) { league.rzTgt++; if (passTD) league.rzTgtTD++; }
      }
    }
    if (rushTD || passTD) league.offTD++;

    // ---- player accumulation ----
    const rId = f[idx.rusher_player_id];
    if (rId && isRush) {
      const pr = playerRec(rId, f[idx.rusher_player_name], season);
      pr.games.add(gid);
      pr.rushAtt++;
      if (kneel) pr.kneel++;
      if (yl > 0 && yl <= 5) pr.glCarry++;
      if (rushTD && f[idx.td_player_id] === rId) pr.rushTD++;
    }
    const cId = f[idx.receiver_player_id];
    if (cId && isPass) {
      const pc = playerRec(cId, f[idx.receiver_player_name], season);
      pc.games.add(gid);
      pc.tgt++;
      pc.airY += Math.max(0, num(f[idx.air_yards]));
      if (yl > 0 && yl <= 20) pc.rzTgt++;
      if (passTD && f[idx.td_player_id] === cId) pc.recTD++;
    }
    const qId = f[idx.passer_player_id];
    if (qId && isPass) playerRec(qId, f[idx.passer_player_name], season).passAtt++;

    // ---- backtest capture for TEST_SEASON ----
    if (season === TEST_SEASON && stype === 'REG') {
      const wk = +f[idx.week];
      let g = btGames.get(gid);
      if (!g) {
        const roof = (f[idx.roof] || '').toLowerCase(), wx = (f[idx.weather] || '').toLowerCase();
        g = { home, away, week: wk, total: num(f[idx.total_line]), spread: num(f[idx.spread_line]),
              outdoor: roof === 'outdoors' || roof === 'open', wind: num(f[idx.wind]),
              precip: /snow/.test(wx) ? 'snow' : /rain|shower|drizzle|storm/.test(wx) ? 'rain' : 'none',
              side: { home: new Map(), away: new Map() }, scored: new Set(), dst: { home: 0, away: 0 } };
        btGames.set(gid, g);
      }
      if (retTD && (playType === 'pass' || playType === 'run' || playType === 'qb_kneel' || playType === 'qb_spike')) { const tt = f[idx.td_team]; if (tt === home) g.dst.home++; else if (tt === away) g.dst.away++; if (tt) twRec(tt, wk).dst++; }
      const which = pos === home ? 'home' : pos === away ? 'away' : null;
      if (which) {
        const m = g.side[which];
        if (rId && isRush && !kneel) { const e = m.get(rId) || { rush: 0, rec: 0, name: f[idx.rusher_player_name] }; e.rush++; m.set(rId, e); }
        if (cId && isPass) { const e = m.get(cId) || { rush: 0, rec: 0, name: f[idx.receiver_player_name] }; e.rec++; m.set(cId, e); }
        // the QB who dropped back is a candidate even if he never ran — otherwise the backtest
        // only scores QBs in games where they rushed, and QB anytime overrating goes unpenalized
        if (qId && isPass) { const e = m.get(qId) || { rush: 0, rec: 0, name: f[idx.passer_player_name] }; m.set(qId, e); }
        const twk = twRec(pos, wk); if (rushTD) twk.rushTD++; if (passTD) twk.passTD++; twk.g.add(gid);
        if (isTrue(f[idx.interception]) || isTrue(f[idx.fumble_lost])) twk.give++;
        const dwk = dwRec(def, wk); dwk.g.add(gid);
        if (rushTD) dwk.rushA++; if (passTD) dwk.passA++;
        if (rushTD || passTD) { const bk = gsis2pos.get(f[idx.td_player_id]); if (bk) dwk.byPos[bk]++; }
      }
      if (rId && isRush) { const r = pwRec(rId, wk); r.g = 1; r.rushAtt++; if (kneel) r.kneel++; if (yl > 0 && yl <= 5) r.glCarry++; if (rushTD && f[idx.td_player_id] === rId) r.rushTD++; }
      if (cId && isPass) { const r = pwRec(cId, wk); r.g = 1; r.tgt++; r.airY += Math.max(0, num(f[idx.air_yards])); if (yl > 0 && yl <= 20) r.rzTgt++; if (passTD && f[idx.td_player_id] === cId) r.recTD++; }
      const tdp = f[idx.td_player_id];
      if (tdp && (rushTD || passTD)) g.scored.add(tdp);
    }
  }
  return true;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
(async function main() {
  log(`\n=== NFL anytime-TD snapshot build ===`);
  log(`seasons: ${SEASONS.join(', ')}  |  backtest train ${TRAIN_SEASON} -> test ${TEST_SEASON}`);

  await loadRosters();   // positions must be ready before we bucket TD scorers
  await loadSnaps();     // current-season snap share (role signal), needs pfr2gsis from loadRosters
  const gotSeasons = [];
  for (const s of SEASONS) if (await parseSeason(s)) gotSeasons.push(s);
  if (!gotSeasons.length) throw new Error('no PBP seasons parsed');

  // red-zone trips per team+season from driveState (season = nflverse game_id prefix "YYYY_WW_AWAY_HOME")
  for (const [dk, ds] of driveState) {
    const season = +dk.slice(0, 4);
    if (!SEASON_WEIGHT[season]) continue;
    if (ds.minYL <= 20) {
      const to = teamOffRec(ds.off, season); to.rzTrips++; if (ds.td) to.rzTD++;
      const td = teamDefRec(ds.def, season); td.rzTripsAllow++; if (ds.td) td.rzTDallow++;
    }
  }

  // league conversion constants
  const GLCONV = league.gl5carry ? league.gl5td / league.gl5carry : 0.5;      // P(TD | inside-5 carry)
  const RZTGTCONV = league.rzTgt ? league.rzTgtTD / league.rzTgt : 0.19;      // P(TD | RZ target)
  const TGTTD = league.tgt ? league.tgtTD / league.tgt : 0.05;               // P(TD | target)
  const rushAttFor = noKneel => league.rushAtt - (noKneel ? league.kneel : 0);
  const RUSHTDATT = rushAttFor(MODEL.noKneel) ? league.rushTDtot / rushAttFor(MODEL.noKneel) : 0.023; // P(TD | real carry)
  const AIRYDTD = league.airYtot ? league.tgtTD / league.airYtot : 0.0009;      // rec TD per downfield air yard — depth/deep-target signal

  // league off TD/gm. IMPORTANT: use only FULL seasons (>=200 team-games ~= >6 gm/team);
  // the newest season can be 1-2 weeks in and would badly skew any rate.
  const seasonGames = {};
  for (const [k, r] of teamOff) { const s = +k.split('|')[1]; seasonGames[s] = (seasonGames[s] || 0) + r.games.size; }
  const fullSeasons = gotSeasons.filter(s => (seasonGames[s] || 0) >= 200);
  const kSeasons = fullSeasons.length ? fullSeasons : gotSeasons;
  let kOffTD = 0, kGames = 0;
  for (const [k, r] of teamOff) if (kSeasons.includes(+k.split('|')[1])) { kOffTD += r.offTD; kGames += r.games.size; }
  const leagueOffTDpg = kGames ? kOffTD / kGames : 2.45;
  // kappa = offensive TDs per point of IMPLIED total. 'emp' measures it directly off the closing
  // lines (sum of offensive TDs / sum of closing totals over the given seasons' games); 'heur' is the
  // older league-TD-rate / 22.9-ppg approximation. The backtest derives its kappa from the TRAIN
  // season only, so no test-season information leaks into the calibration number.
  const LEAGUE_PPG = 22.9;
  function offTDpgFor(seasons) { let td = 0, g = 0; for (const [k, r] of teamOff) if (seasons.includes(+k.split('|')[1])) { td += r.offTD; g += r.games.size; } return g ? td / g : 2.45; }
  function kappaFor(mode, seasons) {
    if (mode === 'heur') return offTDpgFor(seasons) / LEAGUE_PPG;
    let td = 0, pts = 0;
    for (const g of gameLines.values()) if (seasons.includes(g.season) && g.total > 20) { td += g.homeTD + g.awayTD; pts += g.total; }
    return pts ? td / pts : offTDpgFor(seasons) / LEAGUE_PPG;
  }
  const KAPPA = kappaFor(MODEL.kappa, kSeasons);
  log(`  kappa: emp=${kappaFor('emp', kSeasons).toFixed(4)} heur=${kappaFor('heur', kSeasons).toFixed(4)} -> using ${MODEL.kappa}; QB kneels excluded from carries: ${league.kneel} (${(league.kneel / league.rushAtt * 100).toFixed(1)}% of rush attempts)`);

  // D/ST (return) TDs and offensive giveaways per team-game, over full seasons
  let retTot = 0, stTot = 0, retGames = 0, giveTot = 0, giveGames = 0;
  for (const [k, r] of teamDef) if (kSeasons.includes(+k.split('|')[1])) { retTot += r.returnTDfor; stTot += r.stTDfor; retGames += r.games.size; }
  for (const [k, r] of teamOff) if (kSeasons.includes(+k.split('|')[1])) { giveTot += r.give; giveGames += r.games.size; }
  const LEAGUE_NONOFF_TD_PG = retGames ? retTot / retGames : 0.083;   // DEFENSIVE TDs per team-game
  const LEAGUE_ST_TD_PG = retGames ? stTot / retGames : 0.03;          // kick/punt return TDs per team-game
  const LEAGUE_GIVE_PG = giveGames ? giveTot / giveGames : 1.3;
  // DEFENSE TD model (defensive TDs only — books settle kick/punt return TDs on the returner), checked on 2024
  // AND 2025 (both leak-free; slope 0.05-0.07 / giveaway exp 0.75-1.5 beat league average in both seasons): a defense's OWN return-TD history
  // barely repeats year to year (r=0.20; the fit gave it zero weight), while the game line and the
  // opponent's turnover rate do predict it. rate = base * e^(slope * points favored by) * (oppGive/league)^giveExp
  const DST_MODEL = { base: +LEAGUE_NONOFF_TD_PG.toFixed(4), slope: 0.06, giveExp: 1, leagueGive: +LEAGUE_GIVE_PG.toFixed(4), shrinkGames: 8,
    stBase: +LEAGUE_ST_TD_PG.toFixed(4) };   // special-teams TDs: league rate (a team's own rate is noise, r=0.09), credited to returners

  log(`  non-offensive TDs per team-game: defense ${LEAGUE_NONOFF_TD_PG.toFixed(3)}, special-teams returns ${LEAGUE_ST_TD_PG.toFixed(3)} (${(LEAGUE_ST_TD_PG / (LEAGUE_NONOFF_TD_PG + LEAGUE_ST_TD_PG) * 100).toFixed(0)}% of non-offensive TDs go to returners, not the defense prop)`);
  log(`  league constants: GLconv=${GLCONV.toFixed(3)} RZtgtTD=${RZTGTCONV.toFixed(3)} tgtTD=${TGTTD.toFixed(3)} offTD/gm=${leagueOffTDpg.toFixed(2)} kappa=${KAPPA.toFixed(4)} nonoffTD/gm=${LEAGUE_NONOFF_TD_PG.toFixed(3)}`);

  // -------- per-team blended profiles --------
  const teamProfiles = {};   // abbr -> {offTDpg, rushShare, pacePlays, rzTDpct, def:{...}}
  const allTeams = new Set();
  for (const k of teamOff.keys()) allTeams.add(k.split('|')[0]);
  for (const k of teamDef.keys()) allTeams.add(k.split('|')[0]);
  for (const team of allTeams) {
    let wOffTD = 0, wRushTD = 0, wPassTD = 0, wPlays = 0, wG = 0, wRzTrips = 0, wRzTD = 0, wGive = 0;
    let wTdAllow = 0, wRushAllow = 0, wPassAllow = 0, wRzTripsA = 0, wRzTDA = 0, wGD = 0;
    const wByPos = { RB: 0, WR: 0, TE: 0, QB: 0 };
    for (const s of gotSeasons) {
      const w = SEASON_WEIGHT[s];
      const o = teamOff.get(team + '|' + s);
      if (o) { const g = o.games.size; wG += w * g; wOffTD += w * o.offTD; wRushTD += w * o.rushTD; wPassTD += w * o.passTD; wPlays += w * o.offPlays; wRzTrips += w * o.rzTrips; wRzTD += w * o.rzTD; wGive += w * o.give; }
      const d = teamDef.get(team + '|' + s);
      if (d) { const g = d.games.size; wGD += w * g; wTdAllow += w * d.tdAllow; wRushAllow += w * d.rushTDallow; wPassAllow += w * d.passTDallow; wRzTripsA += w * d.rzTripsAllow; wRzTDA += w * d.rzTDallow; for (const k of ['RB', 'WR', 'TE', 'QB']) wByPos[k] += w * d.byPos[k]; }
    }
    if (wG < 1 && wGD < 1) continue;
    const rushPass = (wRushTD + wPassTD) || 1;
    const rushAllowTot = (wRushAllow + wPassAllow) || 1;
    teamProfiles[team] = {
      offTDpg: wG ? wOffTD / wG : leagueOffTDpg,
      rushShare: (wRushTD + 0.5) / (rushPass + 1),             // team run/pass TD split (shrunk)
      pacePlays: wG ? wPlays / wG : 63,
      rzTDpct: wRzTrips ? wRzTD / wRzTrips : 0.55,
      // offensive giveaways/gm, shrunk toward league — drives the OPPONENT's D/ST TD chance
      giveawayPg: +((wGive + DST_MODEL.shrinkGames * LEAGUE_GIVE_PG) / (wG + DST_MODEL.shrinkGames)).toFixed(3),
      def: {
        tdAllowPg: wGD ? wTdAllow / wGD : leagueOffTDpg,
        rushAllowShare: (wRushAllow + 0.5) / (rushAllowTot + 1),
        rzTDpctAllow: wRzTripsA ? wRzTDA / wRzTripsA : 0.55,
        // TDs allowed per game by scorer position — where this defense is weak
        byPos: {
          RB: +(wGD ? wByPos.RB / wGD : 0).toFixed(3),
          WR: +(wGD ? wByPos.WR / wGD : 0).toFixed(3),
          TE: +(wGD ? wByPos.TE / wGD : 0).toFixed(3),
          QB: +(wGD ? wByPos.QB / wGD : 0).toFixed(3),
        },
      },
    };
  }
  // league-average TDs allowed per team-game by position (baseline for "weak vs").
  // Average the per-team RECENCY-WEIGHTED rates so the baseline is on the same footing
  // as each team's def.byPos (using the unweighted flat total here biased every defense).
  const leagueByPos = {};
  for (const k of ['RB', 'WR', 'TE', 'QB']) {
    let sum = 0, n = 0;
    for (const t of Object.values(teamProfiles)) if (t.def && t.def.byPos) { sum += t.def.byPos[k]; n++; }
    leagueByPos[k] = +(n ? sum / n : 0).toFixed(3);
  }
  log(`  league TD/gm allowed by pos: RB ${leagueByPos.RB} WR ${leagueByPos.WR} TE ${leagueByPos.TE} QB ${leagueByPos.QB}`);

  // -------- per-player blended scores --------
  function playerScore(p, bk) {
    let wG = 0, wRushTD = 0, wGL = 0, wRecTD = 0, wRzTgt = 0, wTgt = 0, wAir = 0, wRushAtt = 0;
    for (const s of gotSeasons) {
      const rec = p.seasons[s]; if (!rec) continue;
      const w = SEASON_WEIGHT[s];
      const g = rec.games.size;
      wG += w * g; wRushTD += w * rec.rushTD; wGL += w * rec.glCarry; wRecTD += w * rec.recTD;
      wRzTgt += w * rec.rzTgt; wTgt += w * rec.tgt; wAir += w * rec.airY;
      wRushAtt += w * (rec.rushAtt - (MODEL.noKneel ? rec.kneel : 0));
    }
    const denom = wG + SHRINK_GAMES;     // shrink per-game rates toward 0 with pseudo-games
    const rushTDpg = wRushTD / denom, glPg = wGL / denom, recTDpg = wRecTD / denom;
    const rzTgtPg = wRzTgt / denom, tgtPg = wTgt / denom, airPg = wAir / denom, rushAttPg = wRushAtt / denom;
    // opportunity-weighted: lean more on stable usage (goal-line carries, carry volume,
    // RZ + overall target share) and less on noisy realized TDs.
    // same as the backtest: shrink thin samples toward the position prior (not zero) + a small floor
    const pr = PRIOR[bk] || { rush: 0.01, rec: 0.01 }, sp = MODEL.shrinkPrior ? MODEL.ps * SHRINK_GAMES / denom : 0;
    const rushScore = 0.40 * rushTDpg + 0.40 * (glPg * GLCONV) + 0.20 * (rushAttPg * RUSHTDATT) * (bk === 'QB' ? MODEL.qbCarry : 1) + pr.rush * sp + MODEL.eps;
    const recScore = 0.35 * recTDpg + 0.35 * (rzTgtPg * RZTGTCONV) + 0.20 * (tgtPg * TGTTD) + 0.10 * (Math.max(0, airPg) * AIRYDTD) + pr.rec * sp + MODEL.eps;
    return { rushScore, recScore, games: wG, glPg, rzTgtPg, rushTDpg, recTDpg };
  }
  const playerScores = new Map();
  for (const [pid, p] of players) playerScores.set(pid, { name: p.name, ...playerScore(p, gsis2pos.get(pid)) });

  // ==========================================================================
  // BACKTEST (rolling, leakage-free): for each TEST_SEASON week W, predict every game using
  // ONLY last season (TRAIN_SEASON) + TEST_SEASON weeks < W, anchored to that game's real
  // closing total/spread. It reproduces the LIVE model's whole pipeline — kappa, NB anytime,
  // the run/pass split with the same opponent-funnel / game-script / weather terms, and the
  // positional matchup multiplier — gated by the same MODEL switches the app reads. kappa and
  // the matchup baseline come from the train season only, so nothing from the test season
  // leaks in. Candidate set: players who touched the ball in that game ('touched' — like
  // knowing the actives) or also everyone who'd played for the team earlier in the season
  // ('roster' — knows nothing about this week's actives, so it's the pessimistic bound).
  // ==========================================================================
  const btSnaps = await loadSnapsWeekly(TEST_SEASON);   // weekly snap % for the live role-weight check
  const CLIP = 1e-4, W_CUR = 1.0;
  const trainTeamDef = team => teamDef.get(team + '|' + TRAIN_SEASON);
  const trainLeagueByPos = (() => {
    const out = {}; for (const k of ['RB', 'WR', 'TE', 'QB']) { let s = 0, n = 0;
      for (const [key, d] of teamDef) if (+key.split('|')[1] === TRAIN_SEASON && d.games.size) { s += d.byPos[k] / d.games.size; n++; }
      out[k] = n ? s / n : 0.01; } return out; })();
  const weeks = [...new Set([...btGames.values()].map(g => g.week))].filter(w => w > 0).sort((a, b) => a - b);

  function runBacktest(o) {
    const wP = o.wPrior;
    const K = kappaFor(o.kappa, [TRAIN_SEASON]);
    const rtdAtt = league.rushTDtot / (rushAttFor(o.noKneel) || 1);
    const run = new Map(), runTeam = new Map(), runDef = new Map(), seen = new Map(), snapRun = new Map();
    function score(pid, bk) {
      const p = players.get(pid), s0 = p && p.seasons[TRAIN_SEASON], r = run.get(pid);
      if (!s0 && !r) return null;
      const mix = (a, b) => (s0 ? a : 0) * wP + (r ? b : 0) * W_CUR;
      const d = mix(s0 && s0.games.size, r && r.g) + SHRINK_GAMES;
      const ra = mix(s0 && (s0.rushAtt - (o.noKneel ? s0.kneel : 0)), r && (r.rushAtt - (o.noKneel ? r.kneel : 0)));
      // shrink thin samples toward a position-shaped prior instead of toward zero
      const pr = PRIOR[bk] || { rush: 0.01, rec: 0.01 }, sp = o.shrinkPrior ? o.ps * SHRINK_GAMES / d : 0;
      return {
        rushA: 0.40 * mix(s0 && s0.rushTD, r && r.rushTD) / d + 0.40 * (mix(s0 && s0.glCarry, r && r.glCarry) / d) * GLCONV + pr.rush * sp,
        carry: 0.20 * (ra / d) * rtdAtt,   // carry-volume term, split out so a QB factor can scale it
        rec: 0.35 * mix(s0 && s0.recTD, r && r.recTD) / d + 0.35 * (mix(s0 && s0.rzTgt, r && r.rzTgt) / d) * RZTGTCONV
           + 0.20 * (mix(s0 && s0.tgt, r && r.tgt) / d) * TGTTD + 0.10 * (Math.max(0, mix(s0 && s0.airY, r && r.airY)) / d) * AIRYDTD + pr.rec * sp,
      };
    }
    function teamSplit(team) {
      const t0 = teamOff.get(team + '|' + TRAIN_SEASON), r = runTeam.get(team);
      const rt = (t0 ? t0.rushTD : 0) * wP + (r ? r.rushTD : 0) * W_CUR, pt = (t0 ? t0.passTD : 0) * wP + (r ? r.passTD : 0) * W_CUR;
      return (rt + 0.5) / (rt + pt + 1);
    }
    function defProfile(team) {   // leak-free opponent profile: last season + this season's weeks < W
      const d0 = trainTeamDef(team), r = runDef.get(team);
      const ra = (d0 ? d0.rushTDallow : 0) * wP + (r ? r.rushA : 0) * W_CUR, pa = (d0 ? d0.passTDallow : 0) * wP + (r ? r.passA : 0) * W_CUR;
      const g = (d0 ? d0.games.size : 0) * wP + (r ? r.g : 0) * W_CUR;
      const byPos = {}; for (const k of ['RB', 'WR', 'TE', 'QB']) byPos[k] = g ? ((d0 ? d0.byPos[k] : 0) * wP + (r ? r.byPos[k] : 0) * W_CUR) / g : trainLeagueByPos[k];
      return { rushAllowShare: (ra + 0.5) / (ra + pa + 1), byPos };
    }
    function fold(wk) {
      for (const [pid, m] of pw) { const w = m.get(wk); if (!w) continue;
        let a = run.get(pid); if (!a) { a = { g: 0, rushAtt: 0, kneel: 0, rushTD: 0, glCarry: 0, tgt: 0, rzTgt: 0, recTD: 0, airY: 0 }; run.set(pid, a); }
        for (const k in a) a[k] += w[k] || 0; }
      for (const [team, m] of tw) { const w = m.get(wk); if (!w) continue;
        let a = runTeam.get(team); if (!a) { a = { rushTD: 0, passTD: 0 }; runTeam.set(team, a); } a.rushTD += w.rushTD; a.passTD += w.passTD; }
      for (const [team, m] of dw) { const w = m.get(wk); if (!w) continue;
        let a = runDef.get(team); if (!a) { a = { rushA: 0, passA: 0, g: 0, byPos: { RB: 0, WR: 0, TE: 0, QB: 0 } }; runDef.set(team, a); }
        a.rushA += w.rushA; a.passA += w.passA; a.g += w.g.size; for (const k in a.byPos) a.byPos[k] += w.byPos[k]; }
      if (btSnaps) for (const [pid, m] of btSnaps) { const v = m.get(wk); if (v == null) continue;   // recency weight = week #, like live
        let a = snapRun.get(pid); if (!a) { a = { sw: 0, swp: 0 }; snapRun.set(pid, a); } a.sw += wk; a.swp += wk * v; }
    }
    const acc = { n: 0, brier: 0, ll: 0, pos: 0, sumP: 0 }, bins = Array.from({ length: 10 }, () => ({ n: 0, y: 0, p: 0 })), rows = [];
    for (const wk of weeks) {
      const scoreWk = !o.wk || (wk >= o.wk[0] && wk <= o.wk[1]);   // optional scoring window (all weeks still fold)
      const games = [...btGames.entries()].filter(([, g]) => g.week === wk && g.total > 20 && g.total < 80);
      for (const [gid, g] of games) {
        for (const side of ['home', 'away']) {
          const team = side === 'home' ? g.home : g.away, opp = side === 'home' ? g.away : g.home;
          if (!scoreWk) { let st = seen.get(team); if (!st) { st = new Set(); seen.set(team, st); } for (const pid of g.side[side].keys()) st.add(pid); continue; }
          const margin = side === 'home' ? g.spread : -g.spread;          // spread_line > 0 = home favored
          const expOff = Math.max(0.4, (g.total / 2 + margin / 2) * K);
          const od = defProfile(opp);
          let rs = teamSplit(team);                                        // same run/pass split as live teamExpectations()
          if (o.funnel) rs += 0.25 * (od.rushAllowShare - 0.5);
          if (o.script) rs += Math.max(-0.10, Math.min(0.12, 0.012 * margin));
          if (o.weather && g.outdoor) { if (g.wind > 12) rs += Math.min(0.09, (g.wind - 12) * 0.005); rs += g.precip === 'snow' ? 0.05 : g.precip === 'rain' ? 0.03 : 0; }
          rs = Math.max(0.24, Math.min(0.80, rs));
          const touched = g.side[side];
          const cands = new Map(touched);
          if (o.cand === 'roster') for (const pid of (seen.get(team) || [])) if (!cands.has(pid)) cands.set(pid, { rush: 0, rec: 0 });
          if (!cands.size) continue;
          let sumR = 0, sumC = 0;
          const pl = [...cands.entries()].map(([pid, use]) => {
            const bk = gsis2pos.get(pid), s = score(pid, bk);
            const qf = bk === 'QB' ? o.qbCarry : 1;
            let r, c;
            if (o.floor === 'touch') { r = (s ? s.rushA + s.carry * qf : 0) + (use.rush > 0 ? 0.02 : 0); c = (s ? s.rec : 0) + (use.rec > 0 ? 0.02 : 0); }
            else { const pr = PRIOR[bk] || { rush: 0.01, rec: 0.01 }; r = (s ? s.rushA + s.carry * qf : pr.rush) + o.eps; c = (s ? s.rec : pr.rec) + o.eps; }
            if (o.snap && (bk !== 'QB' || !o.qbSnapExempt)) { const a = snapRun.get(pid), has = a && a.sw, eff = has ? a.swp / a.sw : 0;
              let mf;
              if (o.snap === 'soft') mf = has ? Math.max(0.2, Math.min(1, eff / 0.35)) : 1;          // unknown = full; floor 0.2
              else if (o.snap === 'hybrid') mf = has ? Math.max(o.snapFloor, Math.min(1, eff / o.snapFull)) : (wk <= 2 ? 1 : 0.05);  // no snaps 2+ weeks in = likely scratch
              else { mf = Math.max(0, Math.min(1, (eff - 0.05) / 0.30)); if (mf < 0.05 && (r + c) > 0.05) mf = 0.05; }   // live snapMF
              r *= mf; c *= mf; }
            if (o.posMF && bk) { const mf = Math.pow(Math.max(0.55, Math.min(1.6, od.byPos[bk] / (trainLeagueByPos[bk] || 0.01))), o.posPow); r *= mf; c *= mf; }
            const sa = snapRun.get(pid); sumR += r; sumC += c; return { pid, r, c, bk, se: sa && sa.sw ? sa.swp / sa.sw : null };
          });
          for (const x of pl) {
            const exp = (sumR ? expOff * rs * x.r / sumR : 0) + (sumC ? expOff * (1 - rs) * x.c / sumC : 0);
            const p = Math.min(1 - CLIP, Math.max(CLIP, nbAnytime(exp)));   // NB anytime = exact live-sim prob
            const y = g.scored.has(x.pid) ? 1 : 0;
            acc.n++; acc.pos += y; acc.sumP += p; acc.brier += (p - y) ** 2; acc.ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
            const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.y += y; b.p += p;
            rows.push({ g: gid, pid: x.pid, p, y, bk: x.bk, se: x.se, wk });
          }
          let st = seen.get(team); if (!st) { st = new Set(); seen.set(team, st); }
          for (const pid of touched.keys()) st.add(pid);   // visible to LATER weeks only (used after this week's games)
        }
      }
      fold(wk);   // only now does week wk become visible to later weeks
    }
    const base = acc.n ? acc.pos / acc.n : 0.22;
    return {
      rows,
      summary: {
        n: acc.n, brier: acc.n ? acc.brier / acc.n : null, logloss: acc.n ? acc.ll / acc.n : null,
        baselineBrier: base * (1 - base), baseRate: base, meanPred: acc.n ? acc.sumP / acc.n : null, kappa: K,
        reliability: bins.filter(b => b.n >= 20).map(b => ({ pred: +(b.p / b.n).toFixed(3), actual: +(b.y / b.n).toFixed(3), n: b.n })),
      },
    };
  }

  // Role tier from prior-week snap share (same cut-points the app uses). The backtest showed the sim
  // over-rates rotational players and QBs and under-rates full-timers; roleFactors() measures
  // actual/predicted per tier so the app can recalibrate its displayed probabilities.
  const roleTier = r => r.bk === 'QB' ? 'qb' : r.se == null ? 'none' : r.se >= 0.6 ? 'full' : r.se >= 0.35 ? 'rot' : 'part';
  function roleFactors(rows) {
    const t = {}; for (const r of rows) { const k = roleTier(r); const a = t[k] || (t[k] = { n: 0, p: 0, y: 0 }); a.n++; a.p += r.p; a.y += r.y; }
    const f = {}; for (const [k, a] of Object.entries(t)) f[k] = a.n >= 150 && a.p > 0 ? +Math.max(0.75, Math.min(1.25, a.y / a.p)).toFixed(3) : 1;
    return f;
  }
  function byPosCal(rows) {   // per-position calibration: mean predicted vs actual scoring rate
    const t = {}; for (const r of rows) { const k = r.bk || '?'; const a = t[k] || (t[k] = { n: 0, p: 0, y: 0 }); a.n++; a.p += r.p; a.y += r.y; }
    return Object.entries(t).map(([k, a]) => `${k} ${(a.p / a.n * 100).toFixed(1)}->${(a.y / a.n * 100).toFixed(1)}%(${a.n})`).join('  ');
  }
  if (process.env.BT_EXPERIMENTS) {
    // Validation harness: flip each MODEL switch and score weeks 1-9 (H1) and 10-18 (H2) separately.
    // A change earns its place only if it helps on BOTH halves (so it isn't fitted to one stretch).
    const H1 = [1, 9], H2 = [10, 22], cur = { ...MODEL, cand: 'touched' };
    const bri = (o, wk) => runBacktest({ ...o, wk }).summary.brier;
    const flips = [['noKneel', !MODEL.noKneel], ['floor', MODEL.floor === 'prior' ? 'touch' : 'prior'], ['funnel', !MODEL.funnel],
      ['script', !MODEL.script], ['weather', !MODEL.weather], ['posMF', !MODEL.posMF], ['kappa', MODEL.kappa === 'emp' ? 'heur' : 'emp'],
      ['shrinkPrior', !MODEL.shrinkPrior], ['snap', MODEL.snap ? false : 'hybrid'], ['wPrior', MODEL.wPrior === 0.3 ? 0.6 : 0.3], ['eps', MODEL.eps ? 0 : 0.01], ['qbCarry', MODEL.qbCarry === 1 ? 0.5 : 1], ['qbCarry', 0.7], ['qbSnapExempt', !MODEL.qbSnapExempt]];
    const h1 = bri(cur, H1), h2 = bri(cur, H2);
    const sg = d => (d >= 0 ? '+' : '') + d.toFixed(5);
    log(`\n  --- MODEL switch check (current: H1 ${h1.toFixed(5)}  H2 ${h2.toFixed(5)}; negative = the flip is better) ---`);
    for (const [k, v] of flips) {
      // snap's job is suppressing players who won't play, which only exists in the roster set
      const b = k === 'snap' ? { ...cur, cand: 'roster' } : cur, o = { ...b, [k]: v };
      const d1 = bri(o, H1) - bri(b, H1), d2 = bri(o, H2) - bri(b, H2);
      log(`  ${(k + ' -> ' + v + (k === 'snap' ? ' [roster]' : '')).padEnd(24)} H1 ${sg(d1)}  H2 ${sg(d2)}${d1 < 0 && d2 < 0 ? '   <-- better on both halves' : ''}`); }
    log(`  by position (pred->actual): ${byPosCal(runBacktest(cur).rows)}`);
    // calibration by ROLE (prior-week snap share): are part-time players' probabilities trustworthy?
    const tierOf = r => r.bk === 'QB' ? 'QB' : r.se == null ? 'no snap data' : r.se >= 0.6 ? 'full-time 60%+' : r.se >= 0.35 ? 'rotational 35-60%' : 'part-time <35%';
    const calTier = rows => { const t = {}; for (const r of rows) { const k = tierOf(r); const a = t[k] || (t[k] = { n: 0, p: 0, y: 0, b: 0 }); a.n++; a.p += r.p; a.y += r.y; a.b += (r.p - r.y) ** 2; }
      return Object.entries(t).map(([k, a]) => { const pr = a.p / a.n, ac = a.y / a.n, se = Math.sqrt(ac * (1 - ac) / a.n);
        return `    ${k.padEnd(20)} n ${String(a.n).padStart(5)}  pred ${(pr * 100).toFixed(1).padStart(5)}%  actual ${(ac * 100).toFixed(1).padStart(5)}%  gap ${((ac - pr) * 100 >= 0 ? '+' : '') + ((ac - pr) * 100).toFixed(1)} pts (${((ac - pr) / (se || 1)).toFixed(1)} SE)`; }).join('\n'); };
    // Cross-fit the role recalibration: learn per-role factors on one half, apply to the other.
    for (const cand of ['touched', 'roster']) {
      const a = runBacktest({ ...cur, cand, wk: H1 }).rows, b = runBacktest({ ...cur, cand, wk: H2 }).rows;
      const br = rows => rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length;
      const apply = (rows, f) => rows.map(r => ({ ...r, p: Math.min(0.97, r.p * (f[roleTier(r)] || 1)) }));
      const fa = roleFactors(a), fb = roleFactors(b);
      const only = f => ({ rot: Math.min(1, f.rot || 1), qb: Math.min(1, f.qb || 1) });   // stable, down-only part
      log(`  recalibration cross-fit [${cand}]: H2 ${br(b).toFixed(5)} -> all ${br(apply(b, fa)).toFixed(5)} | rot+qb ${br(apply(b, only(fa))).toFixed(5)} (factors from H1)   H1 ${br(a).toFixed(5)} -> all ${br(apply(a, fb)).toFixed(5)} | rot+qb ${br(apply(a, only(fb))).toFixed(5)} (factors from H2)`);
      log(`    factors H1: ${JSON.stringify(fa)}   H2: ${JSON.stringify(fb)}`);
    }
    log(`  calibration by role, touched set:\n${calTier(runBacktest(cur).rows)}`);
    log(`  calibration by role, roster set (players who may not play):\n${calTier(runBacktest({ ...cur, cand: 'roster' }).rows)}`);
    for (const q of [0.5, 0.7]) log(`  by position, qbCarry ${q}: ${byPosCal(runBacktest({ ...cur, qbCarry: q }).rows)}`);
    log(`  by position, QB not snap-exempt: ${byPosCal(runBacktest({ ...cur, qbSnapExempt: false }).rows)}\n`);
  }

  const mainBT = runBacktest({ ...MODEL, cand: 'touched' });
  const rosterRows = runBacktest({ ...MODEL, cand: 'roster' }).rows;
  // ROLE RECALIBRATION. The sim over-rates rotational players (35-60% snaps) and QBs; cross-fitting
  // (factors learned on one half, applied to the other) improved the held-out half in all 4 checks,
  // while also correcting full-/part-time didn't hold up. So only that stable, down-only part ships:
  // the app multiplies those players' probabilities by the measured actual/predicted ratio.
  const calFrom = (tRows, rRows) => { const ft = roleFactors(tRows), fr = roleFactors(rRows);
    const avg = k => Math.min(1, ((ft[k] || 1) + (fr[k] || 1)) / 2); return { rot: +avg('rot').toFixed(3), qb: +avg('qb').toFixed(3) }; };
  const ROLE_CAL = calFrom(mainBT.rows, rosterRows);   // full-season fit, shipped to the app
  const recal = (r, f) => ({ ...r, p: Math.min(0.97, r.p * (roleTier(r) === 'rot' ? f.rot : roleTier(r) === 'qb' ? f.qb : 1)) });
  // the headline is scored honestly: each half is recalibrated with factors learned on the OTHER half
  const half = (rows, h) => rows.filter(r => h === 1 ? r.wk <= 9 : r.wk >= 10);
  const fH1 = calFrom(half(mainBT.rows, 1), half(rosterRows, 1)), fH2 = calFrom(half(mainBT.rows, 2), half(rosterRows, 2));
  const btRows = mainBT.rows.map(r => recal(r, r.wk <= 9 ? fH2 : fH1));
  function summarize(rows) {
    let n = 0, b = 0, ll = 0, pos = 0, sp = 0; const bins = Array.from({ length: 10 }, () => ({ n: 0, y: 0, p: 0 }));
    for (const r of rows) { const p = Math.min(1 - CLIP, Math.max(CLIP, r.p)); n++; pos += r.y; sp += p; b += (p - r.y) ** 2; ll += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
      const bb = bins[Math.min(9, Math.floor(p * 10))]; bb.n++; bb.y += r.y; bb.p += p; }
    const base = n ? pos / n : 0.22;
    return { n, brier: b / n, logloss: ll / n, baselineBrier: base * (1 - base), baseRate: base, meanPred: sp / n,
      reliability: bins.filter(x => x.n >= 20).map(x => ({ pred: +(x.p / x.n).toFixed(3), actual: +(x.y / x.n).toFixed(3), n: x.n })) };
  }
  const baseRate = mainBT.summary.baseRate;
  const backtest = {
    trainSeason: TRAIN_SEASON, testSeason: TEST_SEASON, method: 'rolling within-season, real closing lines',
    ...summarize(btRows), kappa: mainBT.summary.kappa, rawBrier: mainBT.summary.brier, roleCal: ROLE_CAL, model: MODEL,
  };
  const skill = s => ((1 - s.brier / s.baselineBrier) * 100).toFixed(1) + '%';
  log(`  backtest: N=${backtest.n} Brier=${backtest.brier?.toFixed(4)} (baseline ${backtest.baselineBrier.toFixed(4)}, skill ${skill(backtest)}; before role recalibration ${mainBT.summary.brier.toFixed(4)}) logloss=${backtest.logloss?.toFixed(4)} meanPred=${(backtest.meanPred*100).toFixed(1)}% base=${(baseRate*100).toFixed(1)}%`);
  log(`  role recalibration shipped: rotational x${ROLE_CAL.rot}, QB x${ROLE_CAL.qb} (cross-fit halves: H1 ${JSON.stringify(fH1)} H2 ${JSON.stringify(fH2)})`);
  log(`  reliability: ` + backtest.reliability.map(b => `${(b.pred*100)|0}->${(b.actual*100)|0}%(${b.n})`).join(' '));
  log(`  by position (pred->actual): ${byPosCal(btRows)}`);

  // ---- D/ST backtest (rolling, leak-free, TEST season): the shipped D/ST model vs giving every defense
  // the league average vs the old own-history rate. Base + league giveaway rate from the TRAIN season only.
  const dstBacktest = (() => {
    let tg = 0, tgive = 0, tret = 0;
    for (const [k, r] of teamOff) if (+k.split('|')[1] === TRAIN_SEASON) { tg += r.games.size; tgive += r.give; }
    for (const [k, r] of teamDef) if (+k.split('|')[1] === TRAIN_SEASON) tret += r.returnTDfor;
    const base = tret / tg, lg = tgive / tg, wP = MODEL.wPrior, zero = { g: 0, give: 0, dst: 0 };
    const run = new Map();   // team -> TEST-season weeks already played
    const acc = { n: 0, y: 0, bNew: 0, bBase: 0, bOld: 0 }, pts = [];
    for (const wk of weeks) {
      for (const g of [...btGames.values()].filter(g => g.week === wk && g.total > 20)) for (const side of ['home', 'away']) {
        const me = side === 'home' ? g.home : g.away, opp = side === 'home' ? g.away : g.home, margin = side === 'home' ? g.spread : -g.spread;
        const oo = teamOff.get(opp + '|' + TRAIN_SEASON), ro = run.get(opp) || zero;
        const oppGive = ((oo ? oo.give : 0) * wP + ro.give + DST_MODEL.shrinkGames * lg) / ((oo ? oo.games.size : 0) * wP + ro.g + DST_MODEL.shrinkGames);
        const pNew = 1 - Math.exp(-base * Math.exp(DST_MODEL.slope * margin) * Math.pow(oppGive / lg, DST_MODEL.giveExp));
        const md = teamDef.get(me + '|' + TRAIN_SEASON), rm = run.get(me) || zero;
        const mg = (md ? md.games.size : 0) * wP + rm.g, mret = (md ? md.returnTDfor : 0) * wP + rm.dst;
        const pOld = 1 - Math.exp(-Math.max(0.05, Math.min(0.7, mg ? mret / mg : base)));   // what the sim used to do
        const pBase = 1 - Math.exp(-base), y = g.dst[side] > 0 ? 1 : 0;
        acc.n++; acc.y += y; acc.bNew += (pNew - y) ** 2; acc.bBase += (pBase - y) ** 2; acc.bOld += (pOld - y) ** 2; pts.push({ p: pNew, y });
      }
      for (const [team, m] of tw) { const w = m.get(wk); if (!w) continue; const a = run.get(team) || { g: 0, give: 0, dst: 0 }; a.g += w.g.size; a.give += w.give; a.dst += w.dst; run.set(team, a); }
    }
    pts.sort((a, b) => a.p - b.p); const n3 = Math.floor(pts.length / 3);
    const third = sl => ({ pred: +(sl.reduce((t, x) => t + x.p, 0) / sl.length).toFixed(3), actual: +(sl.reduce((t, x) => t + x.y, 0) / sl.length).toFixed(3), n: sl.length });
    return { n: acc.n, rate: +(acc.y / acc.n).toFixed(3), brier: acc.bNew / acc.n, baselineBrier: acc.bBase / acc.n, oldBrier: acc.bOld / acc.n,
      thirds: [third(pts.slice(0, n3)), third(pts.slice(n3, 2 * n3)), third(pts.slice(2 * n3))] };
  })();
  log(`  D/ST backtest: N=${dstBacktest.n} Brier ${dstBacktest.brier.toFixed(5)} vs league-average ${dstBacktest.baselineBrier.toFixed(5)} vs old own-history ${dstBacktest.oldBrier.toFixed(5)}; by third (pred->actual): ` +
    dstBacktest.thirds.map(t => `${(t.pred * 100).toFixed(1)}->${(t.actual * 100).toFixed(1)}%`).join(' '));

  // ---- market-universe backtest: restrict to players the sportsbook actually
  // priced an anytime-TD market on (ESPN BET boards). LINES, not prices — so this
  // is "is the model calibrated on the book's player set, and does it find the
  // same live players?", not "does it beat the odds". ----
  let marketBacktest = null;
  const mlPath = path.join(__dirname, `market_lines_${TEST_SEASON}.json`);
  if (fs.existsSync(mlPath)) {
    const ml = JSON.parse(fs.readFileSync(mlPath, 'utf8'));
    const mkt = ml.games || {};
    const sampled = new Set(Object.keys(mkt).filter(g => btGames.has(g) && (mkt[g].market || []).length));
    const mktSet = {}; for (const g of sampled) mktSet[g] = new Set(mkt[g].market);
    const mb = { n: 0, brier: 0, ll: 0, pos: 0, sumP: 0 };
    const mbins = Array.from({ length: 10 }, () => ({ n: 0, y: 0, p: 0 }));
    let scorers = 0, scorersListed = 0, allN = 0, allBrier = 0, listedTot = 0;
    for (const g of sampled) listedTot += mktSet[g].size;
    for (const r of btRows) {
      if (!sampled.has(r.g)) continue;
      allN++; allBrier += (r.p - r.y) ** 2;
      if (r.y === 1) { scorers++; if (mktSet[r.g].has(r.pid)) scorersListed++; }
      if (mktSet[r.g].has(r.pid)) {
        const p = Math.min(1 - CLIP, Math.max(CLIP, r.p));
        mb.n++; mb.pos += r.y; mb.sumP += p;
        mb.brier += (p - r.y) ** 2; mb.ll += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
        const b = mbins[Math.min(9, Math.floor(p * 10))]; b.n++; b.y += r.y; b.p += p;
      }
    }
    const baseM = mb.n ? mb.pos / mb.n : 0;
    marketBacktest = {
      provider: (ml.meta && ml.meta.provider) || 'ESPN', season: TEST_SEASON, weeks: '1–13',
      games: sampled.size, nMarketRows: mb.n,
      brier: mb.n ? mb.brier / mb.n : null,
      logloss: mb.n ? mb.ll / mb.n : null,
      baselineBrier: baseM * (1 - baseM),
      baseRate: baseM,
      meanPred: mb.n ? mb.sumP / mb.n : null,
      marketRecall: scorers ? scorersListed / scorers : null,   // % of actual scorers the book had listed
      avgListedPerGame: sampled.size ? listedTot / sampled.size : null,
      allCandBrier: allN ? allBrier / allN : null,               // same games, no market filter (contrast)
      reliability: mbins.filter(b => b.n >= 15).map(b => ({ pred: +(b.p / b.n).toFixed(3), actual: +(b.y / b.n).toFixed(3), n: b.n })),
      note: 'ESPN exposes the anytime-TD LINE (which players were priced), not the price; this is a calibration/coverage check vs the market universe, not a price/EV comparison.',
    };
    log(`  market backtest: ${marketBacktest.games} games, ${mb.n} priced-player rows, Brier=${marketBacktest.brier.toFixed(4)} (baseline ${marketBacktest.baselineBrier.toFixed(4)}), baseRate=${(baseM*100).toFixed(1)}%, scorer recall=${(marketBacktest.marketRecall*100).toFixed(1)}%`);
    log(`  market reliability: ` + marketBacktest.reliability.map(b => `${(b.pred*100)|0}->${(b.actual*100)|0}%(${b.n})`).join(' '));
  } else {
    log(`  (no ${path.basename(mlPath)} — run build-market-lines.mjs to add a market-universe backtest)`);
  }

  // ==========================================================================
  // ESPN: teams, colors, logos, rosters, injuries
  // ==========================================================================
  // (espn2gsis / name2gsis / gsis2pos already loaded by loadRosters at the top)
  log(`  pulling ESPN teams / rosters / injuries ...`);
  const espnTeams = curlJson('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams')
    .sports[0].leagues[0].teams.map(t => t.team);

  // current-week schedule (kickoff time + per-game indoor flag) so the app can pull
  // the game-day forecast for the right stadium and hour
  let schedule = [];
  try {
    const sb = curlJson('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
    schedule = (sb.events || []).map(e => {
      const c = e.competitions[0];
      const h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
      // current line so the app can auto-fill total/spread/favorite (prevents wrong-favorite input errors)
      const o = (c.odds || [])[0] || {};
      const total = (o.overUnder != null && +o.overUnder > 20) ? +o.overUnder : null;
      let fav = null, spread = null;
      const m = o.details && o.details.match(/([A-Z]{2,3})\s*(-?\d+(?:\.\d)?)/);
      if (m) { fav = nflAbbr(m[1]); spread = Math.abs(+m[2]); }
      if (!fav) { if (o.homeTeamOdds && o.homeTeamOdds.favorite) fav = nflAbbr(h.team.abbreviation); else if (o.awayTeamOdds && o.awayTeamOdds.favorite) fav = nflAbbr(a.team.abbreviation); if (spread == null && o.spread != null) spread = Math.abs(+o.spread); }
      return { home: nflAbbr(h.team.abbreviation), away: nflAbbr(a.team.abbreviation), kickoff: e.date, indoor: !!(c.venue && c.venue.indoor), venue: (c.venue && c.venue.fullName) || '', total, fav, spread };
    });
    log(`  schedule: ${schedule.length} games this week`);
  } catch { log('  ! schedule fetch failed'); }

  const teamsOut = {};   // nflAbbr -> {id,abbr,name,color,alt,logo(base64)}
  const rostersOut = {}; // nflAbbr -> [player rows]
  const SKILL = new Set(['QB', 'RB', 'FB', 'WR', 'TE']);

  for (const t of espnTeams) {
    const abbr = nflAbbr(t.abbreviation);
    const prof = teamProfiles[abbr] || teamProfiles[t.abbreviation];
    let logo64 = null;
    if (!process.env.SKIP_LOGOS) {
      const href = (t.logos && t.logos[0] && t.logos[0].href) || `https://a.espncdn.com/i/teamlogos/nfl/500/${t.abbreviation.toLowerCase()}.png`;
      const b64 = curlBase64(href);
      if (b64) logo64 = 'data:image/png;base64,' + b64;
    }
    teamsOut[abbr] = {
      id: t.id, abbr, name: t.displayName, short: t.shortDisplayName,
      color: '#' + (t.color || '444444'), alt: '#' + (t.alternateColor || '888888'), logo: logo64,
    };

    let roster;
    try { roster = curlJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${t.id}/roster`); }
    catch { log(`    ! roster failed for ${abbr}`); continue; }
    const rows = [];
    for (const grp of (roster.athletes || [])) {
      const groupOut = grp.position === 'injuredReserveOrOut';
      for (const a of (grp.items || [])) {
        const pos = a.position && a.position.abbreviation;
        if (!SKILL.has(pos)) continue;
        // injury status
        let status = 'ACT';
        if (groupOut) status = 'OUT';
        const injs = a.injuries || [];
        if (injs.length) {
          const st = (injs[0].status || (injs[0].type && injs[0].type.description) || '').toLowerCase();
          if (/out|injured reserve|\bir\b/.test(st)) status = 'OUT';
          else if (/doubt/.test(st)) status = 'DBT';   // must match the template's status codes (ACT/Q/DBT/OUT)
          else if (/quest/.test(st)) status = 'Q';
        }
        // join to PBP scores by ID (exact); fall back to normalized name
        const gsis = espn2gsis.get(String(a.id)) || name2gsis.get(normName(a.fullName));
        const sc = gsis ? playerScores.get(gsis) : null;
        // replacement-level position priors (PRIOR, top of file) so unmatched rookies aren't invisible at 0%
        const pr = PRIOR[pos] || { rush: 0, rec: 0 };
        const snap = gsis ? snapByGsis.get(gsis) : null;   // current-season role
        rows.push({
          id: a.id, name: a.fullName, pos, jersey: a.jersey || '', status,
          rushScore: +(sc ? sc.rushScore : pr.rush + MODEL.eps).toFixed(5),
          recScore: +(sc ? sc.recScore : pr.rec + MODEL.eps).toFixed(5),
          games: sc ? +sc.games.toFixed(1) : 0,
          glPg: sc ? +sc.glPg.toFixed(3) : 0,
          rzTgtPg: sc ? +sc.rzTgtPg.toFixed(3) : 0,
          rushTDpg: sc ? +sc.rushTDpg.toFixed(3) : 0,
          recTDpg: sc ? +sc.recTDpg.toFixed(3) : 0,
          matched: !!sc,
          snapPct: snap ? snap.snapPct : null,     // null = no snaps recorded this season
          snapLast: snap ? snap.lastPct : null,    // most recent week's offensive snap %
          // kick/punt returns, recency-weighted: the app splits special-teams TDs by each player's share
          ret: +(gsis && returns.get(gsis) ? Object.entries(returns.get(gsis)).reduce((a, [yr, n]) => a + (SEASON_WEIGHT[+yr] || 0) * n, 0) : 0).toFixed(2),
        });
      }
    }
    // Single-starter constraint for QB (a mobile QB2 would otherwise outrank the real starter on
    // rushing-TD weight). Backups are discounted in the app, not here — see below.
    // Presumed starter = the QB actually PLAYING most (recent snap share), then games, then score.
    // Snap share beats "most games" because a high-games QB can be a stale/blended backup (e.g. a
    // mid-season addition) who never took a snap for this team.
    const qbSnap = q => (q.snapPct != null ? q.snapPct : (q.snapLast != null ? q.snapLast : 0));
    const qbs = rows.filter(r => r.pos === 'QB')
      .sort((a, b) => (qbSnap(b) - qbSnap(a)) || (b.games - a.games) || ((b.rushScore + b.recScore) - (a.rushScore + a.recScore)));
    // Ship FULL QB scores plus a presumed-starter flag; the APP applies the single-starter
    // discount to whoever ISN'T the chosen starter. That way a QB swap — injury OR a benching
    // like Penix starting over Rush — is reflected live by picking the starter, using that QB's
    // OWN production, instead of being frozen to whoever started the most games at build time.
    qbs.forEach((q, i) => { q.starterQB = (i === 0); if (i > 0) q.backupQB = true; });
    // sort by combined scoring weight so the UI shows the meaningful players first
    rows.sort((a, b) => (b.rushScore + b.recScore) - (a.rushScore + a.recScore));
    rostersOut[abbr] = rows;
  }

  // build ordered team list (only teams we have both profile + roster for)
  const teamList = Object.keys(teamsOut)
    .filter(a => teamProfiles[a] && rostersOut[a])
    .sort();

  // attach profiles keyed by abbr for teams we ship
  const profilesOut = {};
  for (const a of teamList) profilesOut[a] = teamProfiles[a];

  // ==========================================================================
  // Snapshot
  // ==========================================================================
  const snapshot = {
    meta: {
      builtAt: new Date().toISOString(),
      seasons: gotSeasons,
      seasonWeights: SEASON_WEIGHT,
      source: 'nflverse play-by-play + ESPN rosters/injuries/logos',
      nsims: SIM_META.nsims,
      snapWeeks,
    },
    constants: { GLCONV, RZTGTCONV, TGTTD, RUSHTDATT, AIRYDTD, KAPPA, leagueOffTDpg, LEAGUE_NONOFF_TD_PG, baseRate, leagueByPos, MODEL, DST_MODEL },
    teams: teamsOut,
    teamList,
    profiles: profilesOut,
    rosters: rostersOut,
    stadiums: STADIUMS,
    schedule,
    backtest,
    dstBacktest,
    marketBacktest,
  };

  const jsonPath = path.join(__dirname, 'nfl-td-snapshot.json');
  fs.writeFileSync(jsonPath, JSON.stringify(snapshot));
  log(`  wrote ${jsonPath} (${(fs.statSync(jsonPath).size / 1e6).toFixed(2)} MB)`);

  // inject into template
  const tplPath = path.join(__dirname, 'nfl-td-predictor.template.html');
  const outPath = path.join(__dirname, 'nfl-td-predictor.html');
  if (fs.existsSync(tplPath)) {
    const tpl = fs.readFileSync(tplPath, 'utf8');
    const injected = tpl.replace('/*__SNAPSHOT__*/', () =>
      'window.__SNAPSHOT__ = ' + JSON.stringify(snapshot) + ';');
    fs.writeFileSync(outPath, injected);
    log(`  wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(2)} MB)`);
  } else {
    log(`  ! template not found (${tplPath}); wrote JSON only.`);
  }

  log(`  teams shipped: ${teamList.length}, players: ${Object.values(rostersOut).reduce((a, r) => a + r.length, 0)}`);
  log(`=== done ===\n`);
})().catch(e => { console.error('BUILD FAILED:', e); process.exit(1); });
