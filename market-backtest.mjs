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
function analyze() {
  const bt = JSON.parse(fs.readFileSync(path.join(DIR, `bt_rows_${SEASON}.json`), 'utf8'));
  const mk = JSON.parse(fs.readFileSync(path.join(DIR, `market_td_${SEASON}.json`), 'utf8'));
  const gidOf = new Map(Object.entries(bt.games).map(([gid, g]) => [g.away + '@' + g.home, gid]));
  const nameIdx = new Map(); for (const [pid, n] of Object.entries(bt.names)) nameIdx.set(norm(n), pid);
  const rowOf = new Map(bt.rows.map(r => [r.g + '|' + r.pid, r]));
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
        const pid = nameIdx.get(norm(n)), r = pid && rowOf.get(gid + '|' + pid);
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
    for (const h of [1, 2]) {
      const R = H(h), c = cal[h], mcal = r => cl(expit(c.a + c.b * logit(cl(r.ipc))));
      const out = { n: R.length, base: R.reduce((a, r) => a + r.y, 0) / R.length,
        model: brier(R, r => r.p), marketRaw: brier(R, r => cl(r.ipc)), marketCal: brier(R, mcal),
        interim035: brier(R, r => expit(0.65 * logit(r.interim) + 0.35 * logit(cl(r.p)))), blend: {} };
      for (const w of W) out.blend[w] = brier(R, r => expit((1 - w) * logit(mcal(r)) + w * logit(cl(r.p))));
      // flat 1u bets at FanDuel's price when the probability says EV > 3%
      const roi = f => { let n = 0, pl = 0; for (const r of R) { if (r.fd == null) continue; const p = f(r), d = dec(r.fd); if (p * d - 1 <= 0.03) continue; n++; pl += r.y ? d - 1 : -1; } return { bets: n, roi: n ? pl / n : null }; };
      out.bets = { model: roi(r => r.p), marketCal: roi(mcal), interim035: roi(r => expit(0.65 * logit(r.interim) + 0.35 * logit(cl(r.p)))) };
      for (const w of [0.2, 0.35, 0.5]) out.bets['blend' + w] = roi(r => expit((1 - w) * logit(mcal(r)) + w * logit(cl(r.p))));
      best[h] = W.reduce((b, w) => out.blend[w] < out.blend[b] ? w : b, 0);
      res.halves[h] = out;
    }
    // ship from the closing snapshot: w chosen on one half must hold on the other
    const wFull = W.reduce((b, w) => (res.halves[1].blend[w] + res.halves[2].blend[w]) < (res.halves[1].blend[b] + res.halves[2].blend[b]) ? w : b, 0);
    res.wBest = { h1: best[1], h2: best[2], both: wFull };
    report.snaps[sn] = res;
    if (sn === 'close' || !ship) { const cf = fitLogit(J.map(r => logit(cl(r.ipc))), J.map(r => r.y)); ship = { w: wFull, cal: { a: +cf.a.toFixed(4), b: +cf.b.toFixed(4) }, fitted: true, season: SEASON, n: J.length, snap: sn }; }
    // print
    const f5 = x => x == null ? '—' : x.toFixed(5), pc = x => x == null ? '—' : (x * 100).toFixed(1) + '%';
    console.log(`\n=== ${sn} snapshot: ${J.length} active priced player-games (priced ${priced}, no model row ${noModel}) ===`);
    for (const h of [1, 2]) { const o = res.halves[h];
      console.log(`  ${h === 1 ? 'wks 1-9 ' : 'wks 10+ '} n=${o.n} base ${pc(o.base)} | Brier model ${f5(o.model)}  market raw ${f5(o.marketRaw)}  market calibrated ${f5(o.marketCal)}  interim app blend ${f5(o.interim035)}`);
      console.log(`           blends (model share w): ` + W.map(w => `${w}:${f5(o.blend[w])}`).join(' '));
      console.log(`           ROI at FanDuel, EV>3% flat 1u: ` + Object.entries(o.bets).map(([k, v]) => `${k} ${v.bets} bets ${pc(v.roi)}`).join(' | ')); }
    console.log(`  best model share: H1 ${best[1]}, H2 ${best[2]}, both halves ${wFull}`);
  }
  const outFile = path.join(DIR, 'market_anchor.json');
  fs.writeFileSync(outFile, JSON.stringify({ builtAt: new Date().toISOString(), report, app: ship }, null, 1));
  console.log(`\nwrote market_anchor.json — the app will use model share ${ship.w} and the fitted market calibration after the next build`);
}

const cmd = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a) && a !== opt('--snaps', '_'));
if (cmd === 'analyze') analyze();
else fetchSeason(args.includes('--go')).catch(e => { console.error('failed:', e.message); process.exit(1); });
