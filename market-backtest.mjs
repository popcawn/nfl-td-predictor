#!/usr/bin/env node
// Score the TD model against REAL sportsbook prices.
//
// Fetches every US book's anytime-TD prices for a season from The Odds API's historical endpoint (paid plans only),
// joins them with the model's leak-free predictions and the actual results, then compares the model, the market and
// blends of the two on both halves of the season — accuracy AND flat-stake ROI at FanDuel's price — and writes
// market_anchor.json, which the build ships to the app (the market-anchor weight + the fitted market calibration).
//
//   node market-backtest.mjs                dry run: what it would fetch and roughly what it costs
//   node market-backtest.mjs --go           fetch (cached in market_hist/, never bought twice) + compile market_td_<season>.json
//   node market-backtest.mjs analyze        score it and write market_anchor.json
//       (first: DUMP_BT=1 node build-nfl-td-snapshot.mjs  -> bt_rows_<season>.json, the model's predictions)
//   options: --season 2025   --snaps close,early   (close = 10 min before kickoff, early = 6 h before)
//
// PLAYER PROPS (receiving + rushing yards, closing lines, regular season):
//   node market-backtest.mjs --props         dry run;  add --go to fetch -> market_props_<season>.json
//   node market-backtest.mjs analyze-props   score vs bt_props_<season>.json (same DUMP_BT build) -> market_anchor.json .props
//
// Key: env ODDS_API_KEY, or a .odds-key file here or in ../ufc-fight-simulator. Raw prices stay local (gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SEASON = +opt('--season', 2025), SNAPS = opt('--snaps', 'close,early').split(',');
const OFFSET = { close: 10 * 60e3, early: 6 * 3600e3 };
const CACHE = path.join(DIR, 'market_hist', String(SEASON));
const API = 'https://api.the-odds-api.com/v4/historical/sports/americanfootball_nfl';
const OPENER = { 2023: '2023-09-07', 2024: '2024-09-05', 2025: '2025-09-04', 2026: '2026-09-10' };
const TEAM = { 'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL', 'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR',
  'Chicago Bears': 'CHI', 'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL', 'Denver Broncos': 'DEN', 'Detroit Lions': 'DET',
  'Green Bay Packers': 'GB', 'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX', 'Kansas City Chiefs': 'KC',
  'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC', 'Los Angeles Rams': 'LA', 'Miami Dolphins': 'MIA', 'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG', 'New York Jets': 'NYJ', 'Philadelphia Eagles': 'PHI',
  'Pittsburgh Steelers': 'PIT', 'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB', 'Tennessee Titans': 'TEN',
  'Washington Commanders': 'WAS' };
const readIf = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const ip = a => a > 0 ? 100 / (a + 100) : -a / (-a + 100);
const dec = a => a > 0 ? 1 + a / 100 : 1 + 100 / -a;
const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const logit = p => Math.log(p / (1 - p)), expit = x => 1 / (1 + Math.exp(-x)), cl = p => Math.min(0.995, Math.max(0.003, p));

// ---------------------------------------------------------------- fetch
async function get(url) {
  for (let t = 1; ; t++) {
    const r = await fetch(url);
    if (r.status === 429 && t < 6) { await sleep(2000 * t); continue; }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`${r.status} ${body.error_code || ''} ${body.message || ''}`); e.status = r.status; e.code = body.error_code; throw e; }
    return { body, left: r.headers.get('x-requests-remaining'), cost: r.headers.get('x-requests-last') };
  }
}
async function cached(file, url) {
  const p = path.join(CACHE, file); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  const { body, left, cost } = await get(url); fs.writeFileSync(p, JSON.stringify(body));
  process.stdout.write(`  ${file}  (cost ${cost}, ${left} left)\n`); await sleep(250); return body;
}
async function fetchSeason(go) {
  const key = process.env.ODDS_API_KEY || readIf(path.join(DIR, '.odds-key')) || readIf(path.join(DIR, '..', 'ufc-fight-simulator', '.odds-key'));
  if (!OPENER[SEASON]) throw new Error(`no opener date for ${SEASON}`);
  const weeks = []; for (let t = Date.parse(OPENER[SEASON] + 'T12:00:00Z'); t < Date.parse(`${SEASON + 1}-01-10T00:00:00Z`); t += 7 * 864e5) weeks.push(new Date(t).toISOString().replace('.000', ''));
  const est = 272 * SNAPS.length * 10 + weeks.length;
  console.log(`season ${SEASON}: ${weeks.length} weekly event lists + ~272 games x ${SNAPS.length} snapshot(s) (${SNAPS.join(', ')}) x 10 credits`);
  console.log(`estimated cost ~${est.toLocaleString()} credits (historical = 10x a live call; cached files are never re-bought)`);
  if (!go) { console.log('dry run — add --go to fetch'); return; }
  if (!key) throw new Error('no Odds API key: set ODDS_API_KEY or put it in .odds-key');
  fs.mkdirSync(CACHE, { recursive: true });
  const events = new Map();
  try {
    for (const w of weeks) {
      const b = await cached(`events_${w.slice(0, 10)}.json`, `${API}/events?apiKey=${key}&date=${w}`);
      const t0 = Date.parse(w);
      for (const e of (b.data || [])) { const t = Date.parse(e.commence_time); if (t >= t0 && t < t0 + 7 * 864e5 && TEAM[e.home_team] && TEAM[e.away_team]) events.set(e.id, e); }
    }
    console.log(`${events.size} games found`);
    for (const e of events.values()) for (const sn of SNAPS) {
      const at = new Date(Date.parse(e.commence_time) - OFFSET[sn]).toISOString().replace('.000', '');
      await cached(`${e.id}_${sn}.json`, `${API}/events/${e.id}/odds?apiKey=${key}&date=${at}&regions=us&markets=player_anytime_td&oddsFormat=american`);
    }
  } catch (err) {
    if (err.code === 'HISTORICAL_UNAVAILABLE_ON_FREE_USAGE_PLAN') { console.log('\nHistorical prices need a paid Odds API plan — upgrade at the-odds-api.com, then run again (nothing was charged).'); return; }
    throw err;
  }
  compile([...events.values()]);
}
function compile(evs) {
  const games = [], books = new Set();
  for (const e of evs) {
    const g = { id: e.id, commence: e.commence_time, home: TEAM[e.home_team], away: TEAM[e.away_team], snaps: {} };
    for (const sn of SNAPS) {
      const p = path.join(CACHE, `${e.id}_${sn}.json`); if (!fs.existsSync(p)) continue;
      const b = JSON.parse(fs.readFileSync(p, 'utf8')), d = b.data || {}, prices = {};
      for (const bk of (d.bookmakers || [])) for (const m of (bk.markets || [])) if (m.key === 'player_anytime_td')
        for (const o of m.outcomes) if (o.name === 'Yes') { (prices[bk.key] = prices[bk.key] || {})[o.description] = o.price; books.add(bk.key); }
      g.snaps[sn] = { ts: b.timestamp, prices };
    }
    games.push(g);
  }
  const out = path.join(DIR, `market_td_${SEASON}.json`);
  fs.writeFileSync(out, JSON.stringify({ season: SEASON, builtAt: new Date().toISOString(), books: [...books], games }));
  console.log(`wrote ${path.basename(out)}: ${games.length} games, books ${[...books].join(', ')}`);
}

// ---------------------------------------------------------------- analyze
function fitLogit(xs, ys) {   // y ~ a + b*x by Newton steps (tiny, no deps)
  let a = 0, b = 1;
  for (let it = 0; it < 60; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < xs.length; i++) { const p = expit(a + b * xs[i]), w = p * (1 - p), e = ys[i] - p; g0 += e; g1 += e * xs[i]; h00 += w; h01 += w * xs[i]; h11 += w * xs[i] * xs[i]; }
    const det = h00 * h11 - h01 * h01; if (!(det > 0)) break;
    const da = (h11 * g0 - h01 * g1) / det, db = (h00 * g1 - h01 * g0) / det; a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return { a, b };
}
// 95% bootstrap range of a mean (seeded, so reruns print the same numbers)
function boot(xs) { if (xs.length < 5) return [null, null]; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, rs = [];
  for (let i = 0; i < 2000; i++) { let t = 0; for (let j = 0; j < xs.length; j++) t += xs[Math.floor(rnd() * xs.length)]; rs.push(t / xs.length); }
  rs.sort((a, b) => a - b); return [rs[50], rs[1949]]; }
function analyze() {
  const bt = JSON.parse(fs.readFileSync(path.join(DIR, `bt_rows_${SEASON}.json`), 'utf8'));
  const mk = JSON.parse(fs.readFileSync(path.join(DIR, `market_td_${SEASON}.json`), 'utf8'));
  const gidOf = new Map(Object.entries(bt.games).map(([gid, g]) => [g.away + '@' + g.home, gid]));
  // names matched within each game's own rows: full name first, then last name + first initial ("Gabe"/"Gabriel Davis")
  const lastKey = n => { const t = String(n).replace(/\b(Jr|Sr|II|III|IV|V)\b\.?/g, '').trim().split(/\s+/); return norm(t[t.length - 1]) + '|' + norm(t[0]).slice(0, 1); };
  const gameIdx = new Map();
  for (const r of bt.rows) { const n = bt.names[r.pid]; if (!n) continue;
    const gi = gameIdx.get(r.g) || gameIdx.set(r.g, { full: new Map(), last: new Map() }).get(r.g);
    gi.full.set(norm(n), r); const lk = lastKey(n); gi.last.set(lk, gi.last.has(lk) ? null : r); }   // null = ambiguous
  const rowFor = (gid, n) => { const gi = gameIdx.get(gid); return gi && (gi.full.get(norm(n)) || gi.last.get(lastKey(n)) || null); };
  const W = [0, 0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const report = { season: SEASON, snaps: {} };
  let ship = null;
  for (const sn of SNAPS) {
    // join: every priced, ACTIVE player-game the model also priced
    const J = []; let priced = 0, noModel = 0;
    for (const g of mk.games) {
      const gid = gidOf.get(g.away + '@' + g.home), S = g.snaps[sn]; if (!gid || !S) continue;
      const names = new Set(); for (const b of Object.values(S.prices)) for (const n of Object.keys(b)) names.add(n);
      const rows = [];
      for (const n of names) {
        const fd = S.prices.fanduel && S.prices.fanduel[n], oth = Object.entries(S.prices).filter(([k]) => k !== 'fanduel').map(([, b]) => b[n]).filter(v => v != null).map(ip);
        const ipc = oth.length >= 2 ? median(oth) : median(oth.concat(fd != null ? [ip(fd)] : [])); if (ipc == null) continue;
        priced++;
        const r = rowFor(gid, n);
        if (!r) { noModel++; continue; }
        if (!r.active) continue;   // didn't play: a void bet, not a loss
        rows.push({ gid, wk: r.wk, p: r.p, y: r.y, fd, ipc });
      }
      // the app's interim rule: market shape at the model's level (sum over the players both price)
      const sp = rows.reduce((a, r) => a + r.p, 0), si = rows.reduce((a, r) => a + r.ipc, 0);
      for (const r of rows) { r.interim = si > 0 ? cl(r.ipc * sp / si) : r.ipc; J.push(r); }
    }
    const H = h => J.filter(r => h === 1 ? r.wk <= 9 : r.wk >= 10);
    const brier = (rows, f) => rows.reduce((a, r) => a + (f(r) - r.y) ** 2, 0) / rows.length;
    const res = { n: J.length, priced, noModel, halves: {} };
    // market calibration cross-fit: learned on one half, scored on the other
    const cal = { 1: fitLogit(H(2).map(r => logit(cl(r.ipc))), H(2).map(r => r.y)), 2: fitLogit(H(1).map(r => logit(cl(r.ipc))), H(1).map(r => r.y)) };
    const best = { 1: null, 2: null };
    // flat 1u at FanDuel's price whenever a probability says EV > 3%; 'every' = bet all of FanDuel's prices (the house edge)
    const roiOn = (R, f) => { const pl = []; for (const r of R) { if (r.fd == null) continue; const d = dec(r.fd); if (f(r) * d - 1 <= 0.03) continue; pl.push(r.y ? d - 1 : -1); }
      const [lo, hi] = boot(pl); return { bets: pl.length, roi: pl.length ? pl.reduce((a, b) => a + b, 0) / pl.length : null, lo, hi }; };
    const mcalH = r => { const c = cal[r.wk <= 9 ? 1 : 2]; return cl(expit(c.a + c.b * logit(cl(r.ipc)))); };   // cross-fit calibration per row
    const strategies = { every: () => 1, model: r => r.p, market: mcalH, interim035: r => expit(0.65 * logit(r.interim) + 0.35 * logit(cl(r.p))),
      'blend0.2': r => expit(0.8 * logit(mcalH(r)) + 0.2 * logit(cl(r.p))), 'blend0.35': r => expit(0.65 * logit(mcalH(r)) + 0.35 * logit(cl(r.p))) };
    for (const h of [1, 2]) {
      const R = H(h), c = cal[h], mcal = r => cl(expit(c.a + c.b * logit(cl(r.ipc))));
      const out = { n: R.length, base: R.reduce((a, r) => a + r.y, 0) / R.length,
        model: brier(R, r => r.p), marketRaw: brier(R, r => cl(r.ipc)), marketCal: brier(R, mcal),
        interim035: brier(R, r => expit(0.65 * logit(r.interim) + 0.35 * logit(cl(r.p)))), blend: {} };
      for (const w of W) out.blend[w] = brier(R, r => expit((1 - w) * logit(mcal(r)) + w * logit(cl(r.p))));
      out.bets = Object.fromEntries(Object.entries(strategies).map(([k, f]) => [k, roiOn(R, f)]));
      best[h] = W.reduce((b, w) => out.blend[w] < out.blend[b] ? w : b, 0);
      res.halves[h] = out;
    }
    // ship from the closing snapshot: w chosen on one half must hold on the other
    const wFull = W.reduce((b, w) => (res.halves[1].blend[w] + res.halves[2].blend[w]) < (res.halves[1].blend[b] + res.halves[2].blend[b]) ? w : b, 0);
    res.wBest = { h1: best[1], h2: best[2], both: wFull };
    res.betsPooled = Object.fromEntries(Object.entries(strategies).map(([k, f]) => [k, roiOn(J, f)]));
    report.snaps[sn] = res;
    if (sn === 'close' || !ship) { const cf = fitLogit(J.map(r => logit(cl(r.ipc))), J.map(r => r.y)); ship = { w: wFull, cal: { a: +cf.a.toFixed(4), b: +cf.b.toFixed(4) }, fitted: true, season: SEASON, n: J.length, snap: sn }; }
    // print
    const f5 = x => x == null ? '—' : x.toFixed(5), pc = x => x == null ? '—' : (x * 100).toFixed(1) + '%';
    console.log(`\n=== ${sn} snapshot: ${J.length} active priced player-games (priced ${priced}, no model row ${noModel}) ===`);
    for (const h of [1, 2]) { const o = res.halves[h];
      console.log(`  ${h === 1 ? 'wks 1-9 ' : 'wks 10+ '} n=${o.n} base ${pc(o.base)} | Brier model ${f5(o.model)}  market raw ${f5(o.marketRaw)}  market calibrated ${f5(o.marketCal)}  interim app blend ${f5(o.interim035)}`);
      console.log(`           blends (model share w): ` + W.map(w => `${w}:${f5(o.blend[w])}`).join(' '));
      console.log(`           ROI at FanDuel, EV>3% flat 1u: ` + Object.entries(o.bets).map(([k, v]) => `${k} ${v.bets} bets ${pc(v.roi)}`).join(' | ')); }
    console.log('  ROI both halves, 95% range:  ' + Object.entries(res.betsPooled).map(([k, v]) => `${k} ${v.bets} bets ${pc(v.roi)} [${pc(v.lo)}..${pc(v.hi)}]`).join('\n                              '));
    console.log(`  best model share: H1 ${best[1]}, H2 ${best[2]}, both halves ${wFull}`);
    // where model and market disagree: bucket by the books' implied chance (vig in), compare the model's average
    res.buckets = [[0, .1], [.1, .2], [.2, .3], [.3, .45], [.45, .6], [.6, 1]].map(([lo, hi]) => { const R = J.filter(r => r.ipc >= lo && r.ipc < hi), m = f => R.reduce((a, r) => a + f(r), 0) / (R.length || 1);
      return { lo, hi, n: R.length, books: m(r => r.ipc), model: m(r => r.p), actual: m(r => r.y) }; });
    console.log('  by the books\' implied chance:  ' + res.buckets.map(b => `${pc(b.lo)}-${pc(b.hi)} n=${b.n} books ${pc(b.books)} model ${pc(b.model)} actual ${pc(b.actual)}`).join('\n                                 '));
  }
  const outFile = path.join(DIR, 'market_anchor.json');
  fs.writeFileSync(outFile, JSON.stringify({ builtAt: new Date().toISOString(), report, app: ship }, null, 1));
  console.log(`\nwrote market_anchor.json — the app will use model share ${ship.w} and the fitted market calibration after the next build`);
}

// ================================================================ PLAYER PROPS
const PROP_MKTS = { player_reception_yds: 'recyd', player_rush_yds: 'ryd' };
const keyOf = () => process.env.ODDS_API_KEY || readIf(path.join(DIR, '.odds-key')) || readIf(path.join(DIR, '..', 'ufc-fight-simulator', '.odds-key'));
async function fetchProps(go) {
  // the weekly event lists were cached by the TD run (free to re-read); regular season only (the model's props
  // backtest has no playoff games)
  const files = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter(f => f.startsWith('events_')) : [];
  if (!files.length) throw new Error('run the TD fetch first (it caches the weekly event lists)');
  const regEnd = Date.parse(`${SEASON + 1}-01-08T00:00:00Z`), events = new Map();
  for (const fl of files) {
    const b = JSON.parse(fs.readFileSync(path.join(CACHE, fl), 'utf8')), t0 = Date.parse(fl.slice(7, 17) + 'T12:00:00Z');
    for (const e of (b.data || [])) { const t = Date.parse(e.commence_time); if (t >= t0 && t < t0 + 7 * 864e5 && t < regEnd && TEAM[e.home_team] && TEAM[e.away_team]) events.set(e.id, e); }
  }
  const nm = Object.keys(PROP_MKTS).length, todo = [...events.values()].filter(e => !fs.existsSync(path.join(CACHE, `${e.id}_props_close.json`)));
  console.log(`props: ${events.size} regular-season games, ${todo.length} not cached yet x ${nm} markets x 10 credits = ~${(todo.length * nm * 10).toLocaleString()} credits`);
  if (!go) { console.log('dry run — add --go to fetch'); return; }
  const key = keyOf(); if (!key) throw new Error('no Odds API key');
  for (const e of events.values()) {
    const at = new Date(Date.parse(e.commence_time) - OFFSET.close).toISOString().replace('.000', '');
    await cached(`${e.id}_props_close.json`, `${API}/events/${e.id}/odds?apiKey=${key}&date=${at}&regions=us&markets=${Object.keys(PROP_MKTS).join(',')}&oddsFormat=american`);
  }
  const games = [];
  for (const e of events.values()) {
    const b = JSON.parse(fs.readFileSync(path.join(CACHE, `${e.id}_props_close.json`), 'utf8')), d = b.data || {}, books = {};
    for (const bk of (d.bookmakers || [])) for (const m of (bk.markets || [])) {
      const st = PROP_MKTS[m.key]; if (!st) continue;
      const pairs = {};
      for (const o of m.outcomes) { if (o.point == null || (o.name !== 'Over' && o.name !== 'Under')) continue; const k = o.description + '|' + o.point;
        (pairs[k] = pairs[k] || { name: o.description, line: +o.point })[o.name === 'Over' ? 'O' : 'U'] = o.price; }
      for (const p of Object.values(pairs)) {
        if (p.O == null || p.U == null) continue;
        const bs = (books[bk.key] = books[bk.key] || {}), ss = (bs[st] = bs[st] || {});
        (ss[p.name] = ss[p.name] || []).push({ line: p.line, O: p.O, U: p.U });
      }
    }
    games.push({ id: e.id, commence: e.commence_time, home: TEAM[e.home_team], away: TEAM[e.away_team], ts: b.timestamp, books });
  }
  const out = path.join(DIR, `market_props_${SEASON}.json`);
  fs.writeFileSync(out, JSON.stringify({ season: SEASON, builtAt: new Date().toISOString(), games }));
  console.log(`wrote ${path.basename(out)}: ${games.length} games`);
}
// P(stat > line) — identical to propPOver() in the build and the app
const propPOver = (tab, mu, L) => {
  if (!(mu > 0)) return 0;
  let bk = tab.edges.findIndex(e => mu <= e); if (bk < 0) bk = tab.q.length - 1;
  const q = tab.q[bk], n = q.length, x = L / mu;
  if (x < q[0]) return 1; if (x >= q[n - 1]) return 0;
  let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (q[m] <= x) lo = m; else hi = m - 1; }
  return 1 - (lo + (q[lo + 1] > q[lo] ? (x - q[lo]) / (q[lo + 1] - q[lo]) : 0)) / (n - 1);
};
function analyzeProps() {
  const bt = JSON.parse(fs.readFileSync(path.join(DIR, `bt_props_${SEASON}.json`), 'utf8'));
  const mk = JSON.parse(fs.readFileSync(path.join(DIR, `market_props_${SEASON}.json`), 'utf8'));
  const gidOf = new Map(Object.entries(bt.games).map(([gid, g]) => [g.away + '@' + g.home, gid]));
  const lastKey = n => { const t = String(n).replace(/\b(Jr|Sr|II|III|IV|V)\b\.?/g, '').trim().split(/\s+/); return norm(t[t.length - 1]) + '|' + norm(t[0]).slice(0, 1); };
  const W = [0, 0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const f5 = x => x == null ? '—' : x.toFixed(5), pc = x => x == null ? '—' : (x * 100).toFixed(1) + '%';
  const devig = (O, U) => ip(O) / (ip(O) + ip(U));
  const report = { season: SEASON, stats: {} }, wAll = { 1: {}, 2: {} }, wCal = { 1: {}, 2: {} }; let nAll = 0;
  for (const [st, B] of Object.entries(bt.stats)) {
    if (!Object.values(PROP_MKTS).includes(st)) continue;
    const idx = new Map();   // gid -> names of this stat's rows (full name, then last name + first initial)
    for (const r of B.rows) {
      const n = bt.names[r.pid]; if (!n) continue;
      const gi = idx.get(r.g) || idx.set(r.g, { full: new Map(), last: new Map() }).get(r.g);
      gi.full.set(norm(n), r); const lk = lastKey(n); gi.last.set(lk, gi.last.has(lk) ? null : r);
    }
    const J = [], J2 = []; let fdRows = 0, noOther = 0, noModel = 0, pushes = 0;
    for (const g of mk.games) {
      const gid = gidOf.get(g.away + '@' + g.home), fd = g.books.fanduel && g.books.fanduel[st]; if (!gid || !fd) continue;
      const gi = idx.get(gid);
      for (const [name, arr] of Object.entries(fd)) {
        // FanDuel's main line = its most 50/50 one (some books list alternates in the same market)
        const main = arr.slice().sort((a, b) => Math.abs(devig(a.O, a.U) - 0.5) - Math.abs(devig(b.O, b.U) - 0.5))[0];
        fdRows++;
        const r = gi && (gi.full.get(norm(name)) || gi.last.get(lastKey(name)));
        if (!r) { noModel++; continue; }   // didn't play (void) or not in the model's population
        if (r.y === main.line) { pushes++; continue; }
        const h = r.wk <= 9 ? 1 : 2, pAt = L => propPOver(B.tabs[h], r.mu, L);
        const oth = [], near = [];   // the app's consensus: other books at FanDuel's exact line, each de-vigged
        for (const [bk, m] of Object.entries(g.books)) {
          if (bk === 'fanduel' || !m[st] || !m[st][name]) continue;
          const x = m[st][name].find(z => z.line === main.line); if (x) { oth.push(devig(x.O, x.U)); continue; }
          // no exact match: the app's fallback — that book's nearest line within max(2.5, 12%), moved to FanDuel's line
          // by the model's own distribution (the same translation the bet log uses for a moved closing line)
          const tol = Math.max(2.5, 0.12 * main.line), y2 = m[st][name].filter(z => Math.abs(z.line - main.line) <= tol).sort((a, b) => Math.abs(a.line - main.line) - Math.abs(b.line - main.line))[0];
          if (y2) near.push(devig(y2.O, y2.U) + pAt(main.line) - pAt(y2.line));
        }
        const row = { wk: r.wk, h, line: main.line, mu: r.mu, y: r.y > main.line ? 1 : 0, pm: cl(pAt(main.line)), O: main.O, U: main.U, fdP: devig(main.O, main.U) };
        if (oth.length) J.push({ ...row, pc: cl(median(oth)), nb: oth.length });
        else { noOther++; if (near.length) J2.push({ ...row, pc: cl(median(near)), nb: near.length }); }
      }
    }
    const H = h => J.filter(r => r.h === h), brier = (R, f) => R.reduce((a, r) => a + (f(r) - r.y) ** 2, 0) / R.length;
    const blend = (r, w) => expit((1 - w) * logit(r.pc) + w * logit(r.pm));
    const roiOn = (R, f) => {
      const pl = [];
      for (const r of R) { const p = f(r); for (const [pp, price, win] of [[p, r.O, r.y === 1], [1 - p, r.U, r.y === 0]]) { const d = dec(price); if (pp * d - 1 > 0.03) pl.push(win ? d - 1 : -1); } }
      const [lo, hi] = boot(pl); return { bets: pl.length, roi: pl.length ? pl.reduce((a, b) => a + b, 0) / pl.length : null, lo, hi };
    };
    // books shade yardage lines toward the over: calibrate their de-vigged P(over), learned on the OTHER half (cross-fit)
    const cals = { 1: fitLogit(H(2).map(r => logit(r.pc)), H(2).map(r => r.y)), 2: fitLogit(H(1).map(r => logit(r.pc)), H(1).map(r => r.y)) };
    const pcal = r => cl(expit(cals[r.h].a + cals[r.h].b * logit(r.pc))), cblend = (r, w) => expit((1 - w) * logit(pcal(r)) + w * logit(r.pm));
    const strategies = { 'every over': () => 0.999, 'every under': () => 0.001, model: r => r.pm, market: r => r.pc, interim035: r => blend(r, 0.35),
      'blend0.1': r => blend(r, 0.1), 'blend0.2': r => blend(r, 0.2), 'blend0.5': r => blend(r, 0.5), 'cal market': pcal, 'cal+0.1': r => cblend(r, 0.1), 'cal+0.2': r => cblend(r, 0.2) };
    const res = { fdRows, noOther, noModel, pushes, n: J.length, halves: {} };
    console.log(`\n=== ${st}: ${J.length} FanDuel main lines with another book at the same line (FanDuel lines ${fdRows}; no other book at that line ${noOther}; no model row ${noModel}; pushes ${pushes}) ===`);
    for (const h of [1, 2]) {
      const R = H(h), o = { n: R.length, overRate: R.reduce((a, r) => a + r.y, 0) / R.length, model: brier(R, r => r.pm), market: brier(R, r => r.pc), fanduel: brier(R, r => r.fdP), blend: {} };
      for (const w of W) { o.blend[w] = brier(R, r => blend(r, w)); wAll[h][w] = (wAll[h][w] || 0) + o.blend[w] * R.length; }
      o.calBlend = {}; for (const w of W) { o.calBlend[w] = brier(R, r => cblend(r, w)); wCal[h][w] = (wCal[h][w] || 0) + o.calBlend[w] * R.length; }
      console.log(`           calibrated books (cross-fit a=${cals[h].a.toFixed(3)} b=${cals[h].b.toFixed(3)}) + model share w: ` + W.slice(0, 6).map(w => `${w}:${f5(o.calBlend[w])}`).join(' '));
      o.bets = Object.fromEntries(Object.entries(strategies).map(([k, f2]) => [k, roiOn(R, f2)]));
      res.halves[h] = o;
      console.log(`  ${h === 1 ? 'wks 1-9 ' : 'wks 10+ '} n=${o.n} over rate ${pc(o.overRate)} | Brier model ${f5(o.model)}  other books ${f5(o.market)}  FanDuel's own ${f5(o.fanduel)}`);
      console.log(`           blends (model share w): ` + W.map(w => `${w}:${f5(o.blend[w])}`).join(' '));
      console.log(`           ROI at FanDuel, EV>3% flat 1u: ` + Object.entries(o.bets).map(([k, v]) => `${k} ${v.bets} bets ${pc(v.roi)}`).join(' | '));
    }
    nAll += J.length;
    res.betsPooled = Object.fromEntries(Object.entries(strategies).map(([k, f2]) => [k, roiOn(J, f2)]));
    console.log('  ROI both halves, 95% range:  ' + Object.entries(res.betsPooled).map(([k, v]) => `${k} ${v.bets} bets ${pc(v.roi)} [${pc(v.lo)}..${pc(v.hi)}]`).join('\n                              '));
    // where they disagree: model minus books, bucketed — who was right?
    res.disagree = [[-1, -0.15], [-0.15, -0.05], [-0.05, 0.05], [0.05, 0.15], [0.15, 1]].map(([lo, hi]) => {
      const R = J.filter(r => r.pm - r.pc >= lo && r.pm - r.pc < hi), m = f2 => R.reduce((a, r) => a + f2(r), 0) / (R.length || 1);
      return { lo, hi, n: R.length, market: m(r => r.pc), model: m(r => r.pm), actual: m(r => r.y) };
    });
    console.log('  model minus books, P(over):  ' + res.disagree.map(b => `${pc(b.lo)}..${pc(b.hi)} n=${b.n} books ${pc(b.market)} model ${pc(b.model)} actual ${pc(b.actual)}`).join('\n                              '));
    // FanDuel lines no other book matched: is the nearby-line consensus (moved by the model) still better than the model?
    res.nearby = {};
    for (const h of [1, 2]) { const R = J2.filter(r => r.h === h); if (R.length < 30) continue;
      res.nearby[h] = { n: R.length, model: brier(R, r => r.pm), nearbyBooks: brier(R, r => r.pc), fanduel: brier(R, r => r.fdP), blend01: brier(R, r => blend(r, 0.1)) };
      const o = res.nearby[h]; console.log(`  no exact match, ${h === 1 ? 'wks 1-9 ' : 'wks 10+ '} n=${o.n} | Brier model ${f5(o.model)}  nearby books moved to FD's line ${f5(o.nearbyBooks)}  w=0.1 ${f5(o.blend01)}  FanDuel's own ${f5(o.fanduel)}`); }
    report.stats[st] = res;
  }
  // one weight for the app's props (both stats pooled, weighted by rows): the share best summed over both halves
  const tot = w => (wAll[1][w] || 0) + (wAll[2][w] || 0);
  const best = h => W.reduce((b, w) => wAll[h][w] < wAll[h][b] ? w : b, 0), wFull = W.reduce((b, w) => tot(w) < tot(b) ? w : b, 0);
  console.log(`\nbest model share for props: H1 ${best(1)}, H2 ${best(2)}, both halves ${wFull}`);
  const file = path.join(DIR, 'market_anchor.json'), cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  cur.propsReport = report; cur.props = { w: wFull, fitted: true, season: SEASON, n: nAll, stats: Object.keys(report.stats), wHalves: { h1: best(1), h2: best(2) } };
  fs.writeFileSync(file, JSON.stringify(cur, null, 1));
  console.log(`wrote market_anchor.json .props — model share ${wFull} for props after the next build`);
}

const cmd = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a) && a !== opt('--snaps', '_'));
if (cmd === 'analyze') analyze();
else if (cmd === 'analyze-props') analyzeProps();
else if (args.includes('--props')) fetchProps(args.includes('--go')).catch(e => { console.error('failed:', e.message); process.exit(1); });
else fetchSeason(args.includes('--go')).catch(e => { console.error('failed:', e.message); process.exit(1); });
