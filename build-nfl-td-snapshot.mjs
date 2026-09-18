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
// recency weights applied to each season when blending live rates
const SEASON_WEIGHT = {};
{
  const maxS = Math.max(...SEASONS);
  for (const s of SEASONS) {
    const age = maxS - s;                        // 0 = newest
    SEASON_WEIGHT[s] = age === 0 ? 1.5 : age === 1 ? 1.0 : Math.max(0.25, 0.5 / age);
  }
}
const CACHE_DIR = process.env.NFL_CACHE_DIR ||
  path.join(process.env.TEMP || process.env.TMP || '/tmp', 'nflverse_cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const SHRINK_GAMES = 4;        // pseudo-games of zero blended into every per-game rate
const SIM_META = { nsims: 10000 };

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
const teamOff = new Map();   // {games:Set, offTD, rushTD, passTD, offPlays, points, rzTrips, rzTD}
const teamDef = new Map();   // {games:Set, tdAllow, rushTDallow, passTDallow, rzTripsAllow, rzTDallow, returnTDfor}
const players = new Map();   // pid -> {name, seasons:{s:{games:Set,rushAtt,rushTD,glCarry,tgt,rec,recTD,rzTgt,airY,passAtt}}}

function teamOffRec(team, season) {
  const k = team + '|' + season;
  let r = teamOff.get(k);
  if (!r) { r = { games: new Set(), offTD: 0, rushTD: 0, passTD: 0, offPlays: 0, points: 0, rzTrips: 0, rzTD: 0 }; teamOff.set(k, r); }
  return r;
}
function teamDefRec(team, season) {
  const k = team + '|' + season;
  let r = teamDef.get(k);
  if (!r) { r = { games: new Set(), tdAllow: 0, rushTDallow: 0, passTDallow: 0, rzTripsAllow: 0, rzTDallow: 0, returnTDfor: 0, byPos: { RB: 0, WR: 0, TE: 0, QB: 0 } }; teamDef.set(k, r); }
  return r;
}
// gsis_id -> scoring-position bucket, and the ESPN<->gsis id maps (filled by loadRosters)
const gsis2pos = new Map(), espn2gsis = new Map(), name2gsis = new Map(), pfr2gsis = new Map();
const snapByGsis = new Map();   // gsis -> {snapPct (recency-wtd), lastPct, lastWk} for the current season
function posBucket(p) { p = (p || '').toUpperCase(); if (p === 'RB' || p === 'FB' || p === 'HB') return 'RB'; if (p === 'WR') return 'WR'; if (p === 'TE') return 'TE'; if (p === 'QB') return 'QB'; return null; }
function playerRec(pid, name, season) {
  let p = players.get(pid);
  if (!p) { p = { name, seasons: {} }; players.set(pid, p); }
  if (name && (!p.name || name.length > p.name.length)) p.name = name;
  if (!p.seasons[season]) p.seasons[season] = { games: new Set(), rushAtt: 0, rushTD: 0, glCarry: 0, tgt: 0, rec: 0, recTD: 0, rzTgt: 0, airY: 0, passAtt: 0 };
  return p.seasons[season];
}

// league totals (for conversion-rate constants)
const league = { gl5carry: 0, gl5td: 0, rzTgt: 0, rzTgtTD: 0, tgt: 0, tgtTD: 0, offTD: 0, teamGames: new Set(), points: 0, returnTD: 0, spreadResid: 0, spreadN: 0, byPos: { RB: 0, WR: 0, TE: 0, QB: 0 }, rushAtt: 0, rushTDtot: 0, airYtot: 0 };

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
  for (const [g, a] of agg) snapByGsis.set(g, { snapPct: +(a.sumWP / a.sumW).toFixed(3), lastPct: +a.lastPct.toFixed(3), lastWk: a.lastWk });
  log(`  snap counts: ${snapByGsis.size} players with ${season} snaps`);
}

// backtest capture (TEST_SEASON games) + rolling weekly accumulators for an
// honest, leakage-free within-season prior (mirrors how the live model blends
// prior season + season-to-date).
const btGames = new Map();  // gameId -> {home,away,week,total,spread, side:{home:Map,away:Map}, scored:Set}
const pw = new Map();       // pid -> Map(week -> {g,rushAtt,rushTD,glCarry,tgt,rzTgt,recTD})
const tw = new Map();       // team -> Map(week -> {rushTD,passTD,g:Set})
function pwRec(pid, wk) {
  let m = pw.get(pid); if (!m) { m = new Map(); pw.set(pid, m); }
  let r = m.get(wk); if (!r) { r = { g: 0, rushAtt: 0, rushTD: 0, glCarry: 0, tgt: 0, rzTgt: 0, recTD: 0, airY: 0 }; m.set(wk, r); }
  return r;
}
function twRec(team, wk) {
  let m = tw.get(team); if (!m) { m = new Map(); tw.set(team, m); }
  let r = m.get(wk); if (!r) { r = { rushTD: 0, passTD: 0, g: new Set() }; m.set(wk, r); }
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
    const drive = f[idx.drive];

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
      const td = teamDefRec(def, season);
      td.games.add(gid);
      if (rushTD) { td.tdAllow++; td.rushTDallow++; }
      if (passTD) { td.tdAllow++; td.passTDallow++; }
      if (rushTD || passTD) { const bk = gsis2pos.get(f[idx.td_player_id]); if (bk) { td.byPos[bk]++; league.byPos[bk]++; } }
    }
    // non-offensive/return TD credited to the team that returned it (td_team on return plays)
    if (retTD) {
      const tt = f[idx.td_team];
      if (tt) teamDefRec(tt, season).returnTDfor++;
      league.returnTD++;
    }

    // ---- league conversion constants ----
    if (isRush) { league.rushAtt++; if (rushTD) league.rushTDtot++; }
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
      if (yl > 0 && yl <= 5) pr.glCarry++;
      if (rushTD && f[idx.td_player_id] === rId) pr.rushTD++;
    }
    const cId = f[idx.receiver_player_id];
    if (cId && isPass) {
      const pc = playerRec(cId, f[idx.receiver_player_name], season);
      pc.games.add(gid);
      pc.tgt++;
      pc.airY += Math.max(0, num(f[idx.air_yards]));
      if (isTrue(f[idx.complete_pass])) pc.rec++;
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
        g = { home, away, week: wk, total: num(f[idx.total_line]), spread: num(f[idx.spread_line]),
              side: { home: new Map(), away: new Map() }, scored: new Set() };
        btGames.set(gid, g);
      }
      const which = pos === home ? 'home' : pos === away ? 'away' : null;
      if (which) {
        const m = g.side[which];
        if (rId && isRush) { const e = m.get(rId) || { rush: 0, rec: 0, name: f[idx.rusher_player_name] }; e.rush++; m.set(rId, e); }
        if (cId && isPass) { const e = m.get(cId) || { rush: 0, rec: 0, name: f[idx.receiver_player_name] }; e.rec++; m.set(cId, e); }
        const twk = twRec(pos, wk); if (rushTD) twk.rushTD++; if (passTD) twk.passTD++; twk.g.add(gid);
      }
      if (rId && isRush) { const r = pwRec(rId, wk); r.g = 1; r.rushAtt++; if (yl > 0 && yl <= 5) r.glCarry++; if (rushTD && f[idx.td_player_id] === rId) r.rushTD++; }
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

  // finalize red-zone trips from driveState
  for (const ds of driveState.values()) {
    if (ds.minYL <= 20) {
      // find season via any team record? store on team offense/defense using... need season.
    }
  }
  // Re-derive RZ trips per team+season: recompute from driveState requires season; instead
  // count here using the game id season prefix (nflverse game_id = "YYYY_WW_AWAY_HOME").
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
  const RUSHTDATT = league.rushAtt ? league.rushTDtot / league.rushAtt : 0.023; // P(TD | rush attempt) — carry-volume signal
  const AIRYDTD = league.airYtot ? league.tgtTD / league.airYtot : 0.0009;      // rec TD per downfield air yard — depth/deep-target signal

  // league off TD/gm for the kappa (points -> off TD) map.
  // IMPORTANT: use only FULL seasons (>=200 team-games ~= >6 gm/team); the newest
  // season can be 1-2 weeks in and would badly inflate the rate.
  const seasonGames = {};
  for (const [k, r] of teamOff) { const s = +k.split('|')[1]; seasonGames[s] = (seasonGames[s] || 0) + r.games.size; }
  const fullSeasons = gotSeasons.filter(s => (seasonGames[s] || 0) >= 200);
  const kSeasons = fullSeasons.length ? fullSeasons : gotSeasons;
  let kOffTD = 0, kGames = 0;
  for (const [k, r] of teamOff) if (kSeasons.includes(+k.split('|')[1])) { kOffTD += r.offTD; kGames += r.games.size; }
  const leagueOffTDpg = kGames ? kOffTD / kGames : 2.45;
  // implied points per team ~ actual PPG; approximate league PPG from off TDs (7 pts) + ~1.6 FG*3
  // but better: derive from a stable constant blend. Use points-per-offTD ~ league scoring structure.
  // kappa = offTD per implied point. Empirically ~2.5 offTD / ~23.5 pts.
  const LEAGUE_PPG = 22.9; // stable league scoring baseline (pts/team/gm), used only to set kappa
  const KAPPA = leagueOffTDpg / LEAGUE_PPG;

  // non-offensive TD per team per game (for def/ST Poisson)
  let retTot = 0, retGames = 0;
  for (const [k, r] of teamDef) { retTot += r.returnTDfor; retGames += r.games.size; }
  const LEAGUE_NONOFF_TD_PG = retGames ? retTot / retGames : 0.14;

  log(`  league constants: GLconv=${GLCONV.toFixed(3)} RZtgtTD=${RZTGTCONV.toFixed(3)} tgtTD=${TGTTD.toFixed(3)} offTD/gm=${leagueOffTDpg.toFixed(2)} kappa=${KAPPA.toFixed(4)} nonoffTD/gm=${LEAGUE_NONOFF_TD_PG.toFixed(3)}`);

  // -------- per-team blended profiles --------
  const teamProfiles = {};   // abbr -> {offTDpg, rushShare, pacePlays, rzTDpct, def:{...}}
  const allTeams = new Set();
  for (const k of teamOff.keys()) allTeams.add(k.split('|')[0]);
  for (const k of teamDef.keys()) allTeams.add(k.split('|')[0]);
  for (const team of allTeams) {
    let wOffTD = 0, wRushTD = 0, wPassTD = 0, wPlays = 0, wG = 0, wRzTrips = 0, wRzTD = 0;
    let wTdAllow = 0, wRushAllow = 0, wPassAllow = 0, wRzTripsA = 0, wRzTDA = 0, wRetFor = 0, wGD = 0;
    const wByPos = { RB: 0, WR: 0, TE: 0, QB: 0 };
    for (const s of gotSeasons) {
      const w = SEASON_WEIGHT[s];
      const o = teamOff.get(team + '|' + s);
      if (o) { const g = o.games.size; wG += w * g; wOffTD += w * o.offTD; wRushTD += w * o.rushTD; wPassTD += w * o.passTD; wPlays += w * o.offPlays; wRzTrips += w * o.rzTrips; wRzTD += w * o.rzTD; }
      const d = teamDef.get(team + '|' + s);
      if (d) { const g = d.games.size; wGD += w * g; wTdAllow += w * d.tdAllow; wRushAllow += w * d.rushTDallow; wPassAllow += w * d.passTDallow; wRzTripsA += w * d.rzTripsAllow; wRzTDA += w * d.rzTDallow; wRetFor += w * d.returnTDfor; for (const k of ['RB', 'WR', 'TE', 'QB']) wByPos[k] += w * d.byPos[k]; }
    }
    if (wG < 1 && wGD < 1) continue;
    const rushPass = (wRushTD + wPassTD) || 1;
    const rushAllowTot = (wRushAllow + wPassAllow) || 1;
    teamProfiles[team] = {
      offTDpg: wG ? wOffTD / wG : leagueOffTDpg,
      rushShare: (wRushTD + 0.5) / (rushPass + 1),             // team run/pass TD split (shrunk)
      pacePlays: wG ? wPlays / wG : 63,
      rzTDpct: wRzTrips ? wRzTD / wRzTrips : 0.55,
      def: {
        tdAllowPg: wGD ? wTdAllow / wGD : leagueOffTDpg,
        rushAllowShare: (wRushAllow + 0.5) / (rushAllowTot + 1),
        rzTDpctAllow: wRzTripsA ? wRzTDA / wRzTripsA : 0.55,
        nonOffTDpg: wGD ? wRetFor / wGD : LEAGUE_NONOFF_TD_PG,
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
  const LEAGUE_RZ_TDPCT = 0.55;   // league-average red-zone TD% used for the TD-vs-FG reshape

  // -------- per-player blended scores --------
  function playerScore(p) {
    let wG = 0, wRushTD = 0, wGL = 0, wRecTD = 0, wRzTgt = 0, wTgt = 0, wAir = 0, wRushAtt = 0, wPassAtt = 0, wRec = 0;
    for (const s of gotSeasons) {
      const rec = p.seasons[s]; if (!rec) continue;
      const w = SEASON_WEIGHT[s];
      const g = rec.games.size;
      wG += w * g; wRushTD += w * rec.rushTD; wGL += w * rec.glCarry; wRecTD += w * rec.recTD;
      wRzTgt += w * rec.rzTgt; wTgt += w * rec.tgt; wAir += w * rec.airY; wRushAtt += w * rec.rushAtt;
      wPassAtt += w * rec.passAtt; wRec += w * rec.rec;
    }
    const denom = wG + SHRINK_GAMES;     // shrink per-game rates toward 0 with pseudo-games
    const rushTDpg = wRushTD / denom, glPg = wGL / denom, recTDpg = wRecTD / denom;
    const rzTgtPg = wRzTgt / denom, tgtPg = wTgt / denom, airPg = wAir / denom, rushAttPg = wRushAtt / denom;
    // opportunity-weighted: lean more on stable usage (goal-line carries, carry volume,
    // RZ + overall target share) and less on noisy realized TDs.
    const rushScore = 0.40 * rushTDpg + 0.40 * (glPg * GLCONV) + 0.20 * (rushAttPg * RUSHTDATT);
    const recScore = 0.35 * recTDpg + 0.35 * (rzTgtPg * RZTGTCONV) + 0.20 * (tgtPg * TGTTD) + 0.10 * (Math.max(0, airPg) * AIRYDTD);
    return {
      rushScore, recScore, games: wG,
      isQB: wPassAtt > wRushAtt * 1.5 && wPassAtt > 20,
      glPg, rzTgtPg, tgtPg, rushAttPg, airPg, rushTDpg, recTDpg,
    };
  }
  const playerScores = new Map();
  for (const [pid, p] of players) playerScores.set(pid, { name: p.name, ...playerScore(p) });

  // ==========================================================================
  // BACKTEST (rolling, leakage-free): for each TEST_SEASON week W, predict every
  // game using ONLY prior-season (TRAIN_SEASON) rates + TEST_SEASON weeks < W,
  // anchored to that game's real closing total/spread. This mirrors exactly how
  // the shipped model blends last season + season-to-date, so the calibration
  // number describes the live model, not a weaker proxy.
  // ==========================================================================
  const W_PRIOR = 0.6, W_CUR = 1.0;            // recency weights: prior season vs season-to-date
  const run25 = new Map();                     // pid -> running {g,rushAtt,rushTD,glCarry,tgt,rzTgt,recTD}
  const runTeam = new Map();                   // team -> running {rushTD,passTD,g}
  function candScore(pid) {
    const p = players.get(pid);
    const s24 = p && p.seasons[TRAIN_SEASON];
    const r = run25.get(pid);
    if (!s24 && !r) return null;
    const g24 = s24 ? s24.games.size : 0;
    const g = g24 * W_PRIOR + (r ? r.g : 0) * W_CUR;
    const rushTD = (s24 ? s24.rushTD : 0) * W_PRIOR + (r ? r.rushTD : 0) * W_CUR;
    const glCar = (s24 ? s24.glCarry : 0) * W_PRIOR + (r ? r.glCarry : 0) * W_CUR;
    const recTD = (s24 ? s24.recTD : 0) * W_PRIOR + (r ? r.recTD : 0) * W_CUR;
    const rzTgt = (s24 ? s24.rzTgt : 0) * W_PRIOR + (r ? r.rzTgt : 0) * W_CUR;
    const tgt = (s24 ? s24.tgt : 0) * W_PRIOR + (r ? r.tgt : 0) * W_CUR;
    const rushAtt = (s24 ? s24.rushAtt : 0) * W_PRIOR + (r ? r.rushAtt : 0) * W_CUR;
    const airY = (s24 ? s24.airY : 0) * W_PRIOR + (r ? r.airY : 0) * W_CUR;
    const d = g + SHRINK_GAMES;
    return {
      rushScore: 0.40 * (rushTD / d) + 0.40 * ((glCar / d) * GLCONV) + 0.20 * ((rushAtt / d) * RUSHTDATT),
      recScore: 0.35 * (recTD / d) + 0.35 * ((rzTgt / d) * RZTGTCONV) + 0.20 * ((tgt / d) * TGTTD) + 0.10 * ((Math.max(0, airY) / d) * AIRYDTD),
    };
  }
  function candTeamSplit(team) {
    const o = teamOff.get(team + '|' + TRAIN_SEASON);
    const r = runTeam.get(team);
    const rt = (o ? o.rushTD : 0) * W_PRIOR + (r ? r.rushTD : 0) * W_CUR;
    const pt = (o ? o.passTD : 0) * W_PRIOR + (r ? r.passTD : 0) * W_CUR;
    return (rt + 0.5) / (rt + pt + 1);
  }
  function foldWeek(wk) {
    for (const [pid, m] of pw) { const w = m.get(wk); if (!w) continue;
      let a = run25.get(pid); if (!a) { a = { g: 0, rushAtt: 0, rushTD: 0, glCarry: 0, tgt: 0, rzTgt: 0, recTD: 0, airY: 0 }; run25.set(pid, a); }
      a.g += w.g; a.rushAtt += w.rushAtt; a.rushTD += w.rushTD; a.glCarry += w.glCarry; a.tgt += w.tgt; a.rzTgt += w.rzTgt; a.recTD += w.recTD; a.airY += w.airY; }
    for (const [team, m] of tw) { const w = m.get(wk); if (!w) continue;
      let a = runTeam.get(team); if (!a) { a = { rushTD: 0, passTD: 0 }; runTeam.set(team, a); }
      a.rushTD += w.rushTD; a.passTD += w.passTD; }
  }

  const bt = { n: 0, brier: 0, ll: 0, positives: 0, sumP: 0 };
  const bins = Array.from({ length: 10 }, () => ({ n: 0, y: 0, p: 0 }));
  const btRows = [];   // per player-game predictions, for re-slicing by market universe
  const CLIP = 1e-4, RUSH_FLOOR = 0.02, REC_FLOOR = 0.02;
  const weeks = [...new Set([...btGames.values()].map(g => g.week))].filter(w => w > 0).sort((a, b) => a - b);
  for (const wk of weeks) {
    const games = [...btGames.entries()].filter(([, g]) => g.week === wk && g.total > 20 && g.total < 80);
    for (const [gid, g] of games) {
      const impHome = g.total / 2 + g.spread / 2;
      const impAway = g.total / 2 - g.spread / 2;
      for (const side of ['home', 'away']) {
        const team = side === 'home' ? g.home : g.away;
        const imp = side === 'home' ? impHome : impAway;
        const expOff = Math.max(0.4, imp * KAPPA);
        const rushShare = candTeamSplit(team);
        const rushPart = expOff * rushShare, passPart = expOff * (1 - rushShare);
        const cand = [...g.side[side].entries()];
        if (!cand.length) continue;
        let sumR = 0, sumC = 0;
        const rows = cand.map(([pid, use]) => {
          const ts = candScore(pid);
          const rs = (ts ? ts.rushScore : 0) + (use.rush > 0 ? RUSH_FLOOR : 0);
          const cs = (ts ? ts.recScore : 0) + (use.rec > 0 ? REC_FLOOR : 0);
          sumR += rs; sumC += cs; return { pid, rs, cs };
        });
        for (const r of rows) {
          const exp = (sumR ? rushPart * r.rs / sumR : 0) + (sumC ? passPart * r.cs / sumC : 0);
          let p = Math.min(1 - CLIP, Math.max(CLIP, 1 - Math.exp(-exp)));
          const y = g.scored.has(r.pid) ? 1 : 0;
          bt.n++; bt.positives += y; bt.sumP += p;
          bt.brier += (p - y) ** 2;
          bt.ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
          const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.y += y; b.p += p;
          btRows.push({ g: gid, pid: r.pid, p, y });
        }
      }
    }
    foldWeek(wk);   // only now does week wk become visible to later weeks
  }
  const baseRate = bt.n ? bt.positives / bt.n : 0.22;
  const backtest = {
    trainSeason: TRAIN_SEASON, testSeason: TEST_SEASON, method: 'rolling within-season, real closing lines',
    n: bt.n,
    brier: bt.n ? bt.brier / bt.n : null,
    logloss: bt.n ? bt.ll / bt.n : null,
    baselineBrier: baseRate * (1 - baseRate),
    baseRate,
    meanPred: bt.n ? bt.sumP / bt.n : null,
    reliability: bins.filter(b => b.n >= 20).map(b => ({ pred: +(b.p / b.n).toFixed(3), actual: +(b.y / b.n).toFixed(3), n: b.n })),
  };
  log(`  backtest: N=${bt.n} Brier=${backtest.brier?.toFixed(4)} (baseline ${backtest.baselineBrier.toFixed(4)}) logloss=${backtest.logloss?.toFixed(4)} meanPred=${(backtest.meanPred*100).toFixed(1)}% base=${(baseRate*100).toFixed(1)}%`);
  log(`  reliability: ` + backtest.reliability.map(b => `${(b.pred*100)|0}->${(b.actual*100)|0}%(${b.n})`).join(' '));

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
      return { home: nflAbbr(h.team.abbreviation), away: nflAbbr(a.team.abbreviation), kickoff: e.date, indoor: !!(c.venue && c.venue.indoor), venue: (c.venue && c.venue.fullName) || '' };
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
          else if (/doubt/.test(st)) status = 'DOUBT';
          else if (/quest/.test(st)) status = 'Q';
        }
        // join to PBP scores by ID (exact); fall back to normalized name
        const gsis = espn2gsis.get(String(a.id)) || name2gsis.get(normName(a.fullName));
        const sc = gsis ? playerScores.get(gsis) : null;
        // replacement-level priors so unmatched rookies aren't invisible at 0%
        const PRIOR = { RB: { rush: 0.055, rec: 0.03 }, FB: { rush: 0.02, rec: 0.012 }, WR: { rush: 0.004, rec: 0.045 }, TE: { rush: 0.002, rec: 0.035 }, QB: { rush: 0.035, rec: 0 } };
        const pr = PRIOR[pos] || { rush: 0, rec: 0 };
        const snap = gsis ? snapByGsis.get(gsis) : null;   // current-season role
        rows.push({
          id: a.id, name: a.fullName, pos, jersey: a.jersey || '', status,
          rushScore: sc ? +sc.rushScore.toFixed(5) : pr.rush,
          recScore: sc ? +sc.recScore.toFixed(5) : pr.rec,
          games: sc ? +sc.games.toFixed(1) : 0,
          glPg: sc ? +sc.glPg.toFixed(3) : 0,
          rzTgtPg: sc ? +sc.rzTgtPg.toFixed(3) : 0,
          rushTDpg: sc ? +sc.rushTDpg.toFixed(3) : 0,
          recTDpg: sc ? +sc.recTDpg.toFixed(3) : 0,
          matched: !!sc,
          snapPct: snap ? snap.snapPct : null,     // null = no snaps recorded this season
          snapLast: snap ? snap.lastPct : null,    // most recent week's offensive snap %
        });
      }
    }
    // Single-starter constraint for QB: only the presumed starter (most games,
    // then highest score) carries full rushing/receiving weight. Backup QBs are
    // heavily discounted since they don't play unless the starter is out (the
    // user can flip a starter to OUT to promote the backup). Without this, a
    // mobile QB2 can outrank the actual starter on rushing-TD weight.
    const qbs = rows.filter(r => r.pos === 'QB')
      .sort((a, b) => (b.games - a.games) || ((b.rushScore + b.recScore) - (a.rushScore + a.recScore)));
    qbs.forEach((q, i) => {
      if (i > 0) { q.rushScore = +(q.rushScore * 0.06).toFixed(5); q.recScore = +(q.recScore * 0.06).toFixed(5); q.backupQB = true; }
    });
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
    },
    constants: { GLCONV, RZTGTCONV, TGTTD, KAPPA, leagueOffTDpg, LEAGUE_PPG, LEAGUE_NONOFF_TD_PG, LEAGUE_RZ_TDPCT, baseRate, leagueByPos },
    teams: teamsOut,
    teamList,
    profiles: profilesOut,
    rosters: rostersOut,
    stadiums: STADIUMS,
    schedule,
    backtest,
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
