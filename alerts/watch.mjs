// 📲 EDGE ALERTS — checks your books' NFL prices (anytime TD + the five player props the app prices: receptions, receiving,
// rushing, rush+rec and passing yards) for every game on the board and pushes the bets Your card would make to your phone
// (ntfy). It never places a bet: each alert carries a link that opens the bet in your book's slip.
//
// Same rule as the app's ⚡ Pull all games / Your card (nfl-td-predictor.template.html: parseOdds / consensusFrom / anchorTD /
// propCandidates / propCons / propEval / propConfidence / legConfidence / gameOptions / pickPlays — keep them in step):
//   anytime TD: chance = the median implied price of every book except the one you'd bet, calibrated (S.marketAnchor.cal; the
//     model's share is 0 for TDs, so no sim is needed); the price judged = the best among your books; tier 'take' (EV > 3%,
//     chance >= 6%, edge <= 22 pts, has history); the app's confidence (role, history, status, long odds, gap, bad weather).
//   props (since 2026-11-06, user: "ntfy is only sending td picks"): your books' main lines (each book's most balanced
//     over/under; the line = FanDuel's when it lists him), your best price per side; chance = the median de-vigged price of the
//     books that AREN'T yours at that line (no such line: their nearest within max(2.5, 12%), moved by the model's own
//     distribution; none at all: that line's own over/under), blended 10% with the model (S.propModel: weighted per-game stat
//     x snap factor x game context from the live total / spread); tier 'take' (EV > 3%, edge <= 15 pts, EV <= 60%); the app's
//     prop confidence (history, status, role change, usage floor, passing yds, wind).
//   card: the same prop side at two lines = one bet (the better one); one bet per player per stat you already hold; your open
//     bets on the game (from ☁ Sync) compete for the same slots; best 3 per game, at most 2 per team, one per player; 1/4 Kelly
//     on the confidence-adjusted edge, 4% team cap.
// Not here (they need the app's Monte Carlo sim): 1st / last / 2+ TD and defense TDs.
//
// Credits: 1 per market per game that has prices (a market no book has posted yet is free). Anytime TD: every run. Props (5
// markets): every run within 6 h of kickoff, hourly within 24 h, every 3 h within 72 h, every 6 h before that (PROP_EVERY);
// between checks the card keeps the game's last prop prices (ALERT_CACHE, carried from run to run by the workflow's
// actions/cache) so a TD never takes a slot a better prop holds. Only freshly pulled prices are alerted. Props pause below
// ALERT_PROP_RESERVE credits left; everything stops below ALERT_RESERVE.
// Evidence: on 2025's real prices the TD rule went +18% / +2% by half at closing prices; for props the other books beat the
// model (a 10% model share was the best blend on both halves), but this props rule has no ROI test — unproven. CLV in the bet
// log is how to judge both.
//
// Run by .github/workflows/alerts.yml or by hand: `node alerts/watch.mjs`.
//   ODDS_API_KEY  The Odds API key (the events list is free)
//   NTFY_TOPIC    your private ntfy channel name (subscribe to it in the ntfy phone app)
//   SYNC_TOKEN    optional: the app's ☁ Sync token (gist scope) -> stakes in dollars from your bankroll, and your open bets join
//                 the card (a bet you already hold is never alerted)
//   ALERT_MODE    live (default) | dry (check + print, send nothing, cache untouched) | test (one test alert, no odds, no credits)
//   ALERT_HOURS   only games kicking off within this many hours (default 6)
//   ALERT_BOOKS   your books (default fanduel,draftkings)
//   ALERT_PROPS   on (default) | off — check player props too
//   ALERT_RESERVE stop pulling when the key has fewer credits left than this (default 1000 — the app needs some too)
//   ALERT_PROP_RESERVE no props when fewer credits are left than this (default 10000)
//   ALERT_MAX     at most this many alerts per run (default 6)
//   ALERT_STATE   your state, e.g. nj — BetMGM and Caesars put it in their bet-slip links (repo variable ALERT_STATE)
//   ALERT_CACHE   a JSON file kept between runs: each game's last prop prices + when they were pulled, forecasts, the last run
//   ALERT_TRIGGER the GitHub event; 'schedule' = the 2-hour backup timer, which does nothing when a run happened < 25 min ago
//   ALERT_QUIET   quiet hours in Eastern time, e.g. 22-6 = live runs from 10 PM to 6 AM check nothing (dry / test still run)
//   ALERT_MOCK    a JSON file {events:[...], odds:{eventId: body}} to test without credits or network to The Odds API
//   ALERT_SYNC_MOCK a JSON file standing in for the ☁ Sync gist's nfl-td-sync / nba-sync / nhl-sync files (tests)
//   ALERT_NOW     tests: pretend it is this time (ISO)
//   ALERT_NTFY    tests: another ntfy server (default https://ntfy.sh)
//   ALERT_DEBUG   1 = print every priced bet of every game
//   ALERT_DUMP    tests: write every game's priced bets (and its line / forecast) to this JSON file
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env, MODE = (env.ALERT_MODE || 'live').trim().toLowerCase();
const num = (v, d) => v != null && String(v).trim() !== '' && !isNaN(+v) ? +v : d;
const HOURS = num(env.ALERT_HOURS, 6), RESERVE = num(env.ALERT_RESERVE, 1000), PROP_RESERVE = num(env.ALERT_PROP_RESERVE, 10000);
const MAX_ALERTS = num(env.ALERT_MAX, 6), PROPS_ON = (env.ALERT_PROPS || 'on').trim().toLowerCase() !== 'off', DEBUG = !!env.ALERT_DEBUG;
const BOOKS = (env.ALERT_BOOKS || 'fanduel,draftkings').split(',').map(s => s.trim()).filter(Boolean);
const NTFY = (env.ALERT_NTFY || 'https://ntfy.sh').replace(/\/+$/, ''), TOPIC = (env.NTFY_TOPIC || '').trim(), STATE = (env.ALERT_STATE || '').trim().toLowerCase();
const CACHE_FILE = (env.ALERT_CACHE || '').trim(), TRIGGER = (env.ALERT_TRIGGER || '').trim();
const NOW = env.ALERT_NOW ? Date.parse(env.ALERT_NOW) : Date.now();
const ODDS_API = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl';
const FD_SLIP = 'https://sportsbook.fanduel.com/addToBetslip';
const BOOK_NAMES = { fanduel: 'FanDuel', draftkings: 'DraftKings', betmgm: 'BetMGM', williamhill_us: 'Caesars', espnbet: 'ESPN BET', fanatics: 'Fanatics', betrivers: 'BetRivers' };
const bookName = b => BOOK_NAMES[b] || b;
const BOOK_HOME = { fanatics: 'https://sportsbook.fanatics.com/' };   // no bet-slip link from the API: open the book
const OA_PROP = { player_receptions: 'rec', player_reception_yds: 'recyd', player_rush_yds: 'ryd', player_rush_reception_yds: 'rryd', player_pass_yds: 'pyd' };
const PROP_NAME = { rec: 'receptions', recyd: 'rec yds', ryd: 'rush yds', rryd: 'rush+rec yds', pyd: 'pass yds' };
const PROP_UNIT = { rec: 'catches', recyd: 'yds', ryd: 'yds', rryd: 'yds', pyd: 'yds' };
// minutes between prop checks of a game, by hours to its kickoff (anytime TD: every run). Runs come every 30 min, so 55 =
// every other run (hourly), 175 = every 6th (3 h), 355 = every 12th (6 h)
const PROP_EVERY = h => h <= 6 ? 0 : h <= 24 ? 55 : h <= 72 ? 175 : 355;
// QUIET HOURS, Eastern time (2026-11-06, user: "stops running at 10pm est, then starts back up at 6am est"): ALERT_QUIET '22-6' =
// live runs from 22:00 to 05:59 ET check nothing (no credits, no buzz). No NFL game kicks off then; the 6 AM run re-checks
// every game whose props are due. Simulated: ~30% fewer credits (30-min timer: ~870/day instead of ~1,230)
const QUIET = (m => m ? [+m[1], +m[2]] : null)(/^(\d{1,2})\s*-\s*(\d{1,2})$/.exec((env.ALERT_QUIET || '').trim()));
const etHour = ms => +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)) % 24;
const isQuiet = ms => { if (!QUIET) return false; const h = etHour(ms), [a, b] = QUIET; return a > b ? (h >= a || h < b) : (h >= a && h < b); };
const log = (...a) => console.log(...a);

// ---- the app's helpers, copied ----
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const americanToDec = a => { a = +a; if (!a) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / (-a); };
const americanToProb = a => { a = +a; if (!a) return null; return a > 0 ? 100 / (a + 100) : (-a) / ((-a) + 100); };
const logit = p => Math.log(p / (1 - p)), expit = x => 1 / (1 + Math.exp(-x));
const blendP = (mkt, model, w) => expit((1 - w) * logit(clamp(mkt, 0.003, 0.995)) + w * logit(clamp(model, 0.003, 0.995)));
const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const normName = s => String(s || '').toLowerCase().replace(/[.'`]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z]/g, '').trim();
const fmtAm = v => (v > 0 ? '+' : '') + v;
const pct = p => (p * 100).toFixed(0) + '%';
const probToAm = p => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
const evalBet = (mp, price) => { const dec = americanToDec(price), bimp = americanToProb(price); if (!dec || mp == null) return null; return { ev: mp * (dec - 1) - (1 - mp), edge: mp - bimp, bimp, dec }; };
// the worst price that still clears the card's EV bar AND still sizes (¼ Kelly on the confidence-adjusted edge reaches
// MIN_STAKE, else the card drops it as "edge too thin to size") — app: floorPrice, keep identical (2026-11-07)
const floorPrice = (p, conf) => { if (!(p > 0 && p < 1)) return null; const k = conf > 0 ? MIN_STAKE / KELLY_FRAC / conf : 0; if (k && !(p > k)) return null;
  const d = Math.max(1.03 / p, k ? (1 - k) / (p - k) : 0) + 1e-9; return d >= 2 ? '+' + Math.ceil((d - 1) * 100) : '-' + Math.floor(100 / (d - 1)); };
function cleanName(s) {
  return String(s)
    .replace(/[+\-−–—]\s?\d{2,6}/g, ' ').replace(/\b\d+\s*\/\s*\d+\b/g, ' ')
    .replace(/\b\d+\.\d{1,3}\b/g, ' ').replace(/\bE(?:VEN)?S?\b/gi, ' ')
    .replace(/\b(QB|RB|FB|WR|TE|K|DEF|DST)\b/gi, ' ').replace(/\bD\/?ST\b/gi, ' ')
    .replace(/\b(ARI|ATL|BAL|BUF|CAR|CHI|CIN|CLE|DAL|DEN|DET|GB|HOU|IND|JAX|KC|LV|LAC|LAR|LA|MIA|MIN|NE|NO|NYG|NYJ|PHI|PIT|SF|SEA|TB|TEN|WAS|WSH)\b/g, ' ')
    .replace(/\b(anytime|touchdown|to score|scorer|player|market|odds)\b/gi, ' ')
    .replace(/\d{2,6}/g, ' ').replace(/[|•·,]/g, ' ').replace(/\s+/g, ' ').trim();
}
function buildPlayerIndex(all) {
  const byFull = new Map(), byIL = new Map(), byLast = new Map();
  const push = (m, k, p) => { if (!k) return; let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(p); };
  for (const p of all) {
    const parts = p.name.trim().split(/\s+/).filter(Boolean);
    let li = parts.length - 1; if (li > 0 && /^(jr|sr|ii|iii|iv|v)\.?$/i.test(parts[li])) li--;
    const last = normName(parts[li]);
    byFull.set(normName(p.name), p); push(byIL, (parts[0][0] || '').toLowerCase() + last, p); push(byLast, last, p);
    if (li >= 1) push(byLast, normName(parts[li - 1] + parts[li]), p);
  }
  return { byFull, byIL, byLast };
}
function matchPlayer(raw, idx) {
  const n = normName(raw); if (idx.byFull.has(n)) return idx.byFull.get(n);
  const toks = raw.trim().split(/\s+/).filter(Boolean); if (!toks.length) return null;
  let li = toks.length - 1; if (li > 0 && /^(jr|sr|ii|iii|iv|v)\.?$/i.test(toks[li])) li--;
  const last = normName(toks[li]), il = (toks[0][0] || '').toLowerCase() + last;
  if (idx.byIL.get(il) && idx.byIL.get(il).length === 1) return idx.byIL.get(il)[0];
  if (idx.byLast.get(last) && idx.byLast.get(last).length === 1) return idx.byLast.get(last)[0];
  if (li >= 1) { const l2 = normName(toks[li - 1] + toks[li]); if (idx.byLast.get(l2) && idx.byLast.get(l2).length === 1) return idx.byLast.get(l2)[0]; }
  return null;
}
function tierOf(mp, edge, ev, prior) {
  if (ev <= 0.03) return 'pass';
  if (mp < 0.06 || prior) return 'dart';
  if (edge > 0.22 || ev > 1.0) return 'flag';
  return 'take';
}
const roleOf = p => p.pos === 'QB' ? 'qb' : p.snapPct == null ? 'none' : p.snapPct >= 0.6 ? 'full' : p.snapPct >= 0.35 ? 'rot' : 'part';
function legConfidence(o, snapWeeks) {   // the app's, for anytime TDs (no D/ST)
  let s = 1;
  if (!o.matched) s *= 0.45;
  else {
    const R = { full: 1, rot: 0.85, part: 0.7, qb: 0.8, none: snapWeeks < 2 ? 0.8 : 0.5 }[o.role] ?? 0.7;
    s *= R; s *= clamp(0.6 + 0.4 * (o.games || 0) / 10, 0.6, 1);
  }
  if (o.status === 'Q') s *= 0.75; else if (o.status === 'DBT') s *= 0.45;
  if (o.bimp < 0.06) s *= 0.65; else if (o.bimp < 0.12) s *= 0.85;
  const e = o.edge; if (e > 0.20) s *= 0.55; else if (e > 0.12) s *= 0.75; else if (e > 0.06) s *= 0.9;
  if (o.badWx && /^(WR|TE|QB)$/.test(o.pos || '')) s *= 0.9;
  s = clamp(s, 0.1, 1);
  return +s.toFixed(2);
}
const KELLY_FRAC = 0.25, TEAM_CAP = 0.04, MIN_STAKE = 0.005, MAX_PER_TEAM = 2, MAX_PER_GAME = 3;
function pickPlays(cands) {   // the app's per-game rule; stakes in units (bankroll = 100)
  const bank = 100, picks = [], byPlayer = new Set(), perTeam = {};
  for (const c of cands.slice().sort((a, b) => b.rk - a.rk)) {
    if (!(c.rk > 0) || byPlayer.has(c.key) || (perTeam[c.abbr] || 0) >= MAX_PER_TEAM || picks.length >= MAX_PER_GAME) continue;
    const stake = KELLY_FRAC * c.rk * bank; if (stake < MIN_STAKE * bank) continue;
    c.stake = stake; picks.push(c); byPlayer.add(c.key); perTeam[c.abbr] = (perTeam[c.abbr] || 0) + 1;
  }
  for (const t of Object.keys(perTeam)) { const L = picks.filter(c => c.abbr === t), tot = L.reduce((a, c) => a + c.stake, 0), cap = TEAM_CAP * bank;
    if (tot > cap) L.forEach(c => { c.stake *= cap / tot; }); }
  picks.forEach(c => c.stake = Math.round(c.stake * 10) / 10);
  return picks;
}
function parseInjuries(inj) {
  const m = new Map();
  for (const tm of (inj.injuries || [])) for (const it of (tm.injuries || [])) { const id = it.athlete && it.athlete.id; if (!id) continue;
    const st = String(it.status || (it.type && it.type.description) || '').toLowerCase(); let code = null;
    if (/out|injured reserve|\bir\b|\bpup\b|suspend|inactive/.test(st)) code = 'OUT';
    else if (/doubt/.test(st)) code = 'DBT'; else if (/quest/.test(st)) code = 'Q'; else if (/active|probable|available|healthy/.test(st)) code = 'ACT';
    if (code) m.set(String(id), code);
  }
  return m;
}
function slipLink(book, o) {   // the app's bookLink() for one outcome
  if (book === 'fanduel') { const m = o.link && /marketId[^=]*=([^&]+)/.exec(o.link), sel = o.sid || ((/selectionId[^=]*=([^&]+)/.exec(o.link || '') || [])[1]);
    return m && sel ? `${FD_SLIP}?marketId=${encodeURIComponent(decodeURIComponent(m[1]))}&selectionId=${encodeURIComponent(sel)}` : null; }
  if (book === 'draftkings') return o.sid ? 'https://sportsbook.draftkings.com/?outcomes=' + encodeURIComponent(o.sid) : null;
  if ((book === 'betmgm' || book === 'williamhill_us') && STATE && o.link && o.link.includes('{state}')) return o.link.replace('{state}', STATE);   // the API's link, with your state in it
  return null;
}
const statOf = m => typeof m === 'string' && m.startsWith('P|') ? m.split('|').slice(0, 2).join('|') : m;
const isProp = m => typeof m === 'string' && m.startsWith('P|');
const teamOfKey = k => { k = String(k || ''); return k.startsWith('DST|') ? k.slice(4) : k.split('|')[0]; };
const betRank = b => { if (typeof b.rk === 'number') return b.rk; const d = americanToDec(String(b.odds).replace(/[−–—]/g, '-').replace('+', '')), p = b.modelProb; if (!d || p == null) return 0; return 0.7 * Math.max(0, (p * d - 1) / (d - 1)); };

// ---- the app's prop model (propPOver / propMedian / propMu / propSides / propCons / propConfidence / propTier), copied ----
let S = null, PM = null, PSTAT = [], PROP_W = 0.1;
function propPOver(tab, mu, L) {   // P(stat > line) — the build's and the template's propPOver
  if (!(mu > 0)) return 0;
  let bk = tab.edges.findIndex(e => mu <= e); if (bk < 0) bk = tab.q.length - 1;
  const q = tab.q[bk], n = q.length, x = L / mu;
  if (x < q[0]) return 1; if (x >= q[n - 1]) return 0;
  let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (q[m] <= x) lo = m; else hi = m - 1; }
  return 1 - (lo + (q[lo + 1] > q[lo] ? (x - q[lo]) / (q[lo + 1] - q[lo]) : 0)) / (n - 1);
}
function propMedian(mu, s) { const tab = PM.tables[s]; let bk = tab.edges.findIndex(e => mu <= e); if (bk < 0) bk = tab.q.length - 1; const q = tab.q[bk]; return mu * q[(q.length - 1) >> 1]; }
function propMu(p, s, G) {   // expected stat tonight; G = {away, home, imp:{away, home}}
  if (!PM || !PM.tables[s] || !p.pp || !p.pp.w || p.pp.w[s] == null) return null;
  if (p.pos === 'QB' && !p._isStarterQB) return null;
  const st = PM.stats[s]; let mu = p.pp.w[s] * (st.method === 'snap' ? (p.pp.sf || 1) : 1);
  if (st.ctx) { const away = p._abbr === G.away, mine = away ? G.imp.away : G.imp.home, theirs = away ? G.imp.home : G.imp.away;
    const norm = (PM.teamImp && PM.teamImp[p._abbr] != null) ? PM.teamImp[p._abbr] : 22.5;
    mu *= Math.exp(st.ctx.a * (mine - norm) + st.ctx.b * (mine - theirs)); }
  return mu > 0 ? mu : null;
}
function propSides(mu, s, L) {   // a whole-number line can push: each side's chance is conditional on no push
  if (!(mu > 0) || !(L >= 0) || !PM.tables[s]) return null;
  const tab = PM.tables[s], cl = v => clamp(v, 0.01, 0.99);
  if (Number.isInteger(L)) { const o = propPOver(tab, mu, L + 0.5), u = 1 - propPOver(tab, mu, L - 0.5), t = o + u; return t > 0 ? { over: cl(o / t), under: cl(u / t), push: 1 - t } : null; }
  const o = propPOver(tab, mu, L); return { over: cl(o), under: cl(1 - o), push: 0 };
}
// other books' de-vigged P(over) at this line (o = {line: p}); none there: the nearest line within max(2.5, 12%) moved by the
// model's distribution
function propCons(o, s, line, mu) {
  if (!o) return null; if (o[line] != null) return o[line];
  const tol = Math.max(2.5, 0.12 * line); let best = null;
  for (const k of Object.keys(o)) { const L2 = +k; if (Math.abs(L2 - line) <= tol && (best == null || Math.abs(L2 - line) < Math.abs(best - line))) best = L2; }
  if (best == null) return null; const a = propSides(mu, s, line), b = propSides(mu, s, best); if (!a || !b) return null;
  return clamp(o[best] + a.over - b.over, 0.02, 0.98);
}
function propConfidence(p, s, r, mu, wind) {
  let c = 1; const pp = p.pp || {}, g = pp.g || 0, st = PM.stats[s];
  if (!g) c *= 0.45; else c *= clamp(0.55 + 0.45 * g / 8, 0.55, 1);
  if (p._status === 'Q') c *= 0.75; else if (p._status === 'DBT') c *= 0.45;
  if (st.method === 'snap' && pp.sf && (pp.sf < 0.75 || pp.sf > 1.35)) c *= 0.85;
  if (mu != null && st.floor && pp.w && pp.w[s] < st.floor) c *= 0.75;
  if (s === 'pyd') c *= 0.85;
  if (s !== 'ryd' && wind >= 15) c *= 0.85;
  const e = r.edge;
  if (e > 0.15) c *= 0.55; else if (e > 0.09) c *= 0.75; else if (e > 0.05) c *= 0.9;
  c = clamp(c, 0.1, 1);
  return +c.toFixed(2);
}
const propTier = r => r.ev <= 0.03 ? 'pass' : (r.edge > 0.15 || r.ev > 0.6) ? 'flag' : 'take';

// ---- the app's game context: starting QB, roster statuses, implied points, ESPN lines, forecast ----
function starterQBId(abbr, statusOf) {   // the flagged starter unless he's OUT, then the next QB by snaps, then games
  const qbs = (S.rosters[abbr] || []).filter(p => p.pos === 'QB');
  const pick = qbs.find(q => q.starterQB) || qbs[0];
  if (pick && statusOf(pick) !== 'OUT') return pick.id;
  const next = qbs.filter(q => statusOf(q) !== 'OUT').sort((a, b) => ((b.snapPct || 0) - (a.snapPct || 0)) || (b.games - a.games))[0];
  return next ? next.id : (pick ? pick.id : null);
}
function rosterOf(abbr, statusOf) {
  const sid = String(starterQBId(abbr, statusOf));
  return (S.rosters[abbr] || []).map(p => ({ ...p, _abbr: abbr, _key: abbr + '|' + p.id, _status: statusOf(p), _isStarterQB: p.pos === 'QB' && String(p.id) === sid }));
}
function impliedPoints(total, spreadPts, favAbbr, home) { const sh = favAbbr === home ? +spreadPts : -spreadPts; return { home: total / 2 + sh / 2, away: total / 2 - sh / 2 }; }
// ESPN events -> the shape the build bakes into S.schedule (the app's schedFromESPN)
function schedFromESPN(sb, idToAbbr) {
  const out = [];
  for (const e of (sb.events || [])) { const c = e.competitions && e.competitions[0]; if (!c) continue;
    const side = {}; for (const x of (c.competitors || [])) { const ab = idToAbbr[String(x.team && x.team.id)]; if (ab) side[x.homeAway] = { ab, espn: x.team.abbreviation }; }
    if (!side.home || !side.away) continue;
    const o = (c.odds || [])[0] || {}, total = (o.overUnder != null && +o.overUnder > 20) ? +o.overUnder : null;
    let fav = (o.homeTeamOdds && o.homeTeamOdds.favorite) ? side.home.ab : (o.awayTeamOdds && o.awayTeamOdds.favorite) ? side.away.ab : null, spread = null;
    const m = o.details && o.details.match(/([A-Z]{2,3})\s*(-?\d+(?:\.\d)?)/);
    if (m) { spread = Math.abs(+m[2]); if (!fav) fav = m[1] === side.home.espn ? side.home.ab : m[1] === side.away.espn ? side.away.ab : null; }
    if (spread == null && o.spread != null && !isNaN(o.spread)) spread = Math.abs(+o.spread);
    out.push({ home: side.home.ab, away: side.away.ab, kickoff: e.date, indoor: !!(c.venue && c.venue.indoor), venue: (c.venue && c.venue.fullName) || '', total, fav, spread,
      neutral: !!c.neutralSite, city: (c.venue && c.venue.address && c.venue.address.city) || '' });
  }
  return out;
}
async function espnSchedule() {   // this week's games and next week's (the window can reach past this week)
  const SB = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', get = async q => (await fetch(SB + q)).json();
  const idToAbbr = {}; for (const a of S.teamList) { const t = S.teams[a]; if (t && t.id != null) idToAbbr[String(t.id)] = a; }
  try {
    const sb = await get(''), weeks = [sb];
    if (sb.week && sb.season) { let nx = await get(`?seasontype=${sb.season.type}&week=${sb.week.number + 1}`);
      if (!(nx.events || []).length && sb.season.type === 2) nx = await get('?seasontype=3&week=1');
      weeks.push(nx); }
    return weeks.flatMap(w => schedFromESPN(w, idToAbbr));
  } catch (e) { log('ESPN schedule unavailable (lines fall back to the snapshot):', e.message); return []; }
}
function nearestHourIdx(times, whenMs) { const t = whenMs / 1000; let best = -1, bd = Infinity; for (let i = 0; i < times.length; i++) { const d = Math.abs(times[i] - t); if (d < bd) { bd = d; best = i; } } return best; }
const wxPrecip = c => { c = +c; return (c >= 71 && c <= 77) || c === 85 || c === 86 ? 'snow' : c >= 95 || (c >= 51 && c <= 67) || (c >= 80 && c <= 82) ? 'rain' : 'none'; };
async function gameWeather(g) {   // the app's gameWeather: {outdoor, wind (mph), bad}
  const st = g.neutral ? null : ((S.stadiums && S.stadiums[g.home]) || null), indoor = g.neutral ? !!g.indoor : !!((st && st.dome) || g.indoor);
  const calm = { outdoor: !indoor, wind: 0, bad: false };
  if (indoor) return calm;
  try {
    let loc = st;
    if (!loc && g.city) { const gj = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(g.city)}&count=1`)).json(); const r = gj.results && gj.results[0]; if (r) loc = { lat: r.latitude, lon: r.longitude }; }
    if (!loc) return calm;
    const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&hourly=wind_speed_10m,precipitation_probability,weather_code&wind_speed_unit=mph&timeformat=unixtime&forecast_days=7`)).json();
    const i = nearestHourIdx(j.hourly.time, new Date(g.kickoff).getTime()); if (i < 0) return calm;
    const wind = Math.round(j.hourly.wind_speed_10m[i]), pp = j.hourly.precipitation_probability[i] || 0, precip = wxPrecip(j.hourly.weather_code[i]);
    return { outdoor: true, wind, bad: wind >= 15 || (pp >= 50 && precip !== 'none') };
  } catch (e) { return calm; }
}

// ---- pricing one game's pull ----
// anytime TD (the app's parseOdds + consensusFrom + anchorTD): per player your best price and every other book's implied chance
function tdCandidates(body, idx, wx, cal, snapWeeks) {
  const byName = new Map();
  for (const bk of (body && body.bookmakers) || []) for (const m of (bk.markets || [])) if (m.key === 'player_anytime_td') for (const o of (m.outcomes || [])) {
    if (o.name !== 'Yes' || !o.description) continue;
    const t = byName.get(o.description) || { all: [], best: null }; byName.set(o.description, t); t.all.push({ book: bk.key, p: americanToProb(o.price) });
    if (BOOKS.includes(bk.key)) { if (!t.best || o.price > t.best.price || (o.price === t.best.price && BOOKS.indexOf(bk.key) < BOOKS.indexOf(t.best.book))) t.best = { book: bk.key, price: o.price, link: slipLink(bk.key, o) }; }
  }
  const rows = [];
  for (const [name, t] of byName) { if (!t.best) continue; const p = matchPlayer(cleanName(name), idx); if (!p || p._status === 'OUT') continue;
    // every book but the one you'd bet; no other book = your own price (the app's anchor then never shows an edge)
    const loo = t.all.filter(x => x.book !== t.best.book).map(x => x.p);
    rows.push({ p, t, ip: loo.length ? median(loo) : americanToProb(t.best.price), nOth: loo.length }); }
  if (rows.length < 4) return { cands: [], n: byName.size };   // too few prices to read the market (the app falls back to its sim)
  const cands = rows.map(({ p, t, ip, nOth }) => {
    const mp = cal ? expit(cal.a + cal.b * logit(clamp(ip, 0.003, 0.995))) : ip, r = evalBet(mp, t.best.price);
    const conf = legConfidence({ role: roleOf(p), pos: p.pos, games: p.games, status: p._status, matched: p.matched, edge: r.edge, bimp: r.bimp, badWx: wx.bad }, snapWeeks);
    return { key: p._key, abbr: p._abbr, name: p.name, market: 'anytime', price: t.best.price, book: t.best.book, link: t.best.link, mp, ip, nOth, ...r, conf,
      tier: tierOf(mp, r.edge, r.ev, !p.matched), rk: r.edge > 0 ? conf * r.edge / (1 - r.bimp) : 0 };
  });
  return { cands, n: byName.size };
}
// props (the app's parseOdds + consensusFrom + fillBoard + propCandidates + propEval)
function propCandidates(body, idx, G, wind) {
  const mineAll = {}, cons = {};
  for (const bk of (body && body.bookmakers) || []) { const mine = BOOKS.includes(bk.key);
    for (const m of (bk.markets || [])) { const s = OA_PROP[m.key]; if (!s) continue;
      const pairs = {};
      for (const o of (m.outcomes || [])) { if (o.point == null) continue;
        if (mine && (o.name === 'Over' || o.name === 'Under')) { const N = (mineAll[s] = mineAll[s] || {}); (N[o.description] = N[o.description] || []).push({ b: bk.key, side: o.name === 'Over' ? 'O' : 'U', line: +o.point, price: o.price, o }); }
        const k = o.description + '|' + o.point; (pairs[k] = pairs[k] || { name: o.description, line: +o.point })[o.name === 'Over' ? 'O' : 'U'] = o.price; }
      // every book's lines get a slot in the order the app meets them (yours too, without a vote): two other-book lines
      // equally far from yours are a tie that the first-met line wins in the app's propCons
      for (const q of Object.values(pairs)) { if (q.O == null || q.U == null) continue; const io = americanToProb(q.O), iu = americanToProb(q.U);
        const C = (cons[s] = cons[s] || {}), L = (C[q.name] = C[q.name] || {}); L[q.line] = L[q.line] || []; if (!mine) L[q.line].push(io / (io + iu)); }
    } }
  // other books' consensus per player and stat: {line: median P(over)} and how many books
  const consFor = new Map();
  for (const [s, C] of Object.entries(cons)) for (const [name, lines] of Object.entries(C)) { const p = matchPlayer(cleanName(name), idx); if (!p) continue;
    const k = s + '|' + p._key, o = consFor.get(k) || { p: {}, n: {} }; consFor.set(k, o);
    for (const [l, xs] of Object.entries(lines)) if (xs.length) { o.p[l] = median(xs); o.n[l] = xs.length; } }
  const out = [], rank = b => BOOKS.indexOf(b);
  for (const [s, N] of Object.entries(mineAll)) for (const [name, arr] of Object.entries(N)) {
    if (!PSTAT.includes(s)) continue;
    // each of your books' main line = its most balanced over/under; the line shown = the first of your books that lists him
    const mainOf = b => { let best = null; const A = arr.filter(x => x.b === b);
      for (const L of new Set(A.map(x => x.line))) { const O = A.find(x => x.line === L && x.side === 'O'), U = A.find(x => x.line === L && x.side === 'U'); if (!O || !U) continue;
        const d = Math.abs(americanToProb(O.price) - americanToProb(U.price)); if (!best || d < best.d) best = { d, line: L, O, U }; }
      return best; };
    const mains = BOOKS.map(b => [b, mainOf(b)]).filter(x => x[1]); if (!mains.length) continue;
    const P = mains[0][1], main = { line: P.line };
    for (const sd of ['O', 'U']) main[sd] = mains.filter(([, m]) => m.line === P.line).map(([, m]) => m[sd]).sort((x, y) => (y.price - x.price) || (rank(x.b) - rank(y.b)))[0];
    const p = matchPlayer(cleanName(name), idx); if (!p || p._status === 'OUT') continue;
    const mu = propMu(p, s, G); if (mu == null) continue;
    const med = propMedian(mu, s), cf = consFor.get(s + '|' + p._key) || null;
    // off = the outcome you'd bet; two = that line's over + under (the market when no other book posts anything near it)
    const side = (sd, line, off, two) => {
      const pr = propSides(mu, s, line); if (!pr) return;
      const model = sd === 'O' ? pr.over : pr.under; let mo = propCons(cf && cf.p, s, line, mu), src = mo != null ? (cf.p[line] != null ? 'books' : 'near') : null;
      if (mo == null && two) { const io = americanToProb(two.O.price), iu = americanToProb(two.U.price); if (io > 0 && iu > 0) { mo = io / (io + iu); src = 'own'; } }
      const mkt = mo != null ? (sd === 'O' ? mo : 1 - mo) : null, mp = mkt != null ? blendP(mkt, model, PROP_W) : model, r = evalBet(mp, off.price); if (!r) return;
      const conf = propConfidence(p, s, r, mu, wind);
      out.push({ key: p._key, abbr: p._abbr, name: p.name, market: `P|${s}|${sd}|${line}`, price: off.price, book: off.b, link: slipLink(off.b, off.o), mp, model, mkt, src,
        nOth: src === 'books' ? cf.n[line] : 0, ...r, conf, tier: propTier(r), rk: r.edge > 0 ? conf * r.edge / (1 - r.bimp) : 0, prop: { s, side: sd, line, mu, med } });
    };
    side('O', main.line, main.O, main); side('U', main.line, main.U, main);
    for (const [b, m] of mains) if (m.line !== P.line) { side('O', m.line, m.O, m); side('U', m.line, m.U, m); }   // another of your books' own line
  }
  return out;
}
// the app's gameOptions(): this game's priced bets + your open bets on it -> the card
function gameCard(cand, logged) {
  const heldSameStat = c => isProp(c.market) ? logged.find(b => b.key === c.key && b.market !== c.market && statOf(b.market) === statOf(c.market)) || null : null;
  // the same prop side at two of your books (different lines) is ONE bet: the one in your log, else the higher EV
  const sideOf = c => isProp(c.market) ? c.key + '|' + c.market.split('|').slice(0, 3).join('|') : null, mine = new Set(logged.map(b => b.key + '|' + b.market)), best = new Map();
  const beats = (a, b) => { const la = mine.has(a.key + '|' + a.market), lb = mine.has(b.key + '|' + b.market); return la !== lb ? la : a.ev > b.ev; };
  for (const c of cand) { delete c.dup; const g = sideOf(c); if (g && (!best.has(g) || beats(c, best.get(g)))) best.set(g, c); }
  for (const c of cand) { const g = sideOf(c), b = g && best.get(g); if (b && b !== c) c.dup = true; }
  const now = new Map(cand.map(c => [c.key + '|' + c.market, c]));
  const opts = cand.filter(c => c.tier === 'take' && !c.dup && !heldSameStat(c)).map(c => ({ ...c, bet: logged.find(b => b.key === c.key && b.market === c.market) || null }));
  for (const b of logged) {
    if (opts.some(o => o.key === b.key && o.market === b.market)) continue;
    const c = now.get(b.key + '|' + b.market);   // priced now but no longer a take -> it holds no slot
    if (!c && b.offBoard) continue;
    opts.push({ ...(c || { key: b.key, abbr: teamOfKey(b.key), name: b.player, market: b.market, price: b.odds, mp: b.modelProb }), rk: c ? 0 : betRank(b), bet: b });
  }
  const edges = cand.filter(c => c.tier === 'take' && !c.dup).length;
  return { picks: pickPlays(opts), edges };
}

// ---- I/O ----
const MOCK = env.ALERT_MOCK ? JSON.parse(fs.readFileSync(env.ALERT_MOCK, 'utf8')) : null;
let creditsLeft = null, creditsUsed = 0;
const DUMP = {};
async function oddsGet(url) {
  if (MOCK) {   // like the real API: only the markets asked for, 1 credit per market that has prices
    const m = /\/events\/([^/]+)\/odds/.exec(url); if (!m) return MOCK.events;
    const want = new Set(((/[?&]markets=([^&]+)/.exec(url) || [])[1] || '').split(',')), body = JSON.parse(JSON.stringify(MOCK.odds[m[1]] || { bookmakers: [] })), got = new Set();
    for (const bk of body.bookmakers || []) { bk.markets = (bk.markets || []).filter(x => want.has(x.key)); bk.markets.forEach(x => got.add(x.key)); }
    body.bookmakers = (body.bookmakers || []).filter(bk => bk.markets.length);
    creditsUsed += got.size; return body;
  }
  const r = await fetch(url);
  const rem = r.headers.get('x-requests-remaining'), last = r.headers.get('x-requests-last');
  if (rem != null) creditsLeft = +rem; if (last != null) creditsUsed += +last;
  if (!r.ok) throw new Error(`The Odds API ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
async function ntfySend(msg) {
  if (MODE === 'dry') { log('  [dry run — not sent]', JSON.stringify(msg)); return; }
  const r = await fetch(NTFY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: TOPIC, ...msg }) });
  if (!r.ok) throw new Error(`ntfy ${r.status}: ${(await r.text()).slice(0, 160)}`);
}
// alerts already sent (ntfy keeps a channel's messages ~12 h): bet id -> best price alerted, so a bet is alerted once and again
// only if the price gets better. Id = the bet-slip link, else the title without its price (older alerts: a 'k:' tag)
const PRICE_RE = /\s([+-]\d{3,5}) at /;
const titleId = t => 't:' + String(t || '').replace(PRICE_RE, ' at ');
async function sentBefore() {
  const out = new Map(); if (!TOPIC) return out;
  try {
    const r = await fetch(`${NTFY}/${encodeURIComponent(TOPIC)}/json?poll=1&since=12h`); if (!r.ok) return out;
    for (const line of (await r.text()).split('\n')) { if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch (e) { continue; }
      const am = PRICE_RE.exec(m.title || ''); if (!am) continue;
      const ids = [m.click, ...(m.tags || []).filter(t => t.startsWith('k:')), titleId(m.title)].filter(Boolean);
      for (const k of ids) out.set(k, Math.max(out.get(k) ?? -Infinity, +am[1])); }
  } catch (e) { log('could not read past alerts:', e.message); }
  return out;
}
// the app's ☁ Sync gist — ONE POT like the app (2026-11-05, user: "make the alerts follow my bankroll"): bankroll now =
// BANK.amt + the dollar P/L of every sport's bets settled since (NFL nfl-td-sync.json, NBA nba-sync.json, NHL nhl-sync.json),
// the money riding on every sport's open bets, the limit switch (BANK.lim === false = off), and your open NFL bets (they join
// each game's card, like the app's).
// ALERT_SYNC_MOCK = a local JSON {"nfl-td-sync.json": {...}, "nba-sync.json": {...}, "nhl-sync.json": {...}} for tests.
const SYNC_FILES = ['nfl-td-sync.json', 'nba-sync.json', 'nhl-sync.json'];
function potFrom(files) {
  const d = files['nfl-td-sync.json']; if (!d) return null;
  const units = d.bankroll > 0 ? d.bankroll : 100, B = d.bank || {};
  const all = SYNC_FILES.flatMap(f => (files[f] && files[f].bets) || []);
  const usd = b => b.usd != null ? +b.usd : (B.amt ? (+b.stake || 0) * B.amt / units : null);
  let bank = null;
  if (B.amt) { bank = B.amt; for (const b of all) if (b.st > B.at) { const u = usd(b), dec = americanToDec(String(b.odds).replace('+', '')) || 1;
    if (u != null) bank += b.result === 'win' ? u * (dec - 1) : b.result === 'loss' ? -u : 0; } bank = Math.max(0, bank); }
  const riding = all.filter(b => b.result === 'pending').reduce((a, b) => a + (usd(b) || 0), 0);
  // the app's pendingFor(): open bets the model priced (not custom, not fun, not parlays)
  const nflOpen = (d.bets || []).filter(b => b.result === 'pending' && b.game && b.key && !b.legs && b.market && b.market !== 'custom' && b.modelProb != null && !b.fun);
  return { unitUsd: bank != null ? bank / units : null, nflOpen, bank, riding, lim: B.lim !== false };
}
async function syncState() {
  if (env.ALERT_SYNC_MOCK) return potFrom(JSON.parse(fs.readFileSync(env.ALERT_SYNC_MOCK, 'utf8')));
  const tok = (env.SYNC_TOKEN || '').trim(); if (!tok) return null;
  const gh = async p => { const r = await fetch('https://api.github.com' + p, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' } }); if (!r.ok) throw new Error('GitHub ' + r.status); return r.json(); };
  try {
    let hit = null;
    for (let page = 1; page <= 5 && !hit; page++) { const list = await gh(`/gists?per_page=100&page=${page}`); hit = list.find(x => x.files && x.files['nfl-td-sync.json']); if (list.length < 100) break; }
    if (!hit) { log('sync: no nfl-td-sync.json gist for this token'); return null; }
    const g = await gh('/gists/' + hit.id), files = {};
    for (const name of SYNC_FILES) { const f = g.files[name]; if (!f) continue;
      try { files[name] = JSON.parse(f.truncated && f.raw_url ? await (await fetch(f.raw_url)).text() : f.content); } catch (e) { log(`sync: ${name} unreadable`); } }
    return potFrom(files);
  } catch (e) { log('sync: could not read your bet log —', e.message); return null; }
}
// the run-to-run memory (ALERT_CACHE): {lastRun, games: {gid: {t: props pulled at, ko, props: [...]}}, wx: {gid: {t, w}}}
function loadCache() {
  try { if (CACHE_FILE && fs.existsSync(CACHE_FILE)) { const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); return { lastRun: c.lastRun || null, games: c.games || {}, wx: c.wx || {} }; } }
  catch (e) { log('cache unreadable — starting fresh:', e.message); }
  return { lastRun: null, games: {}, wx: {} };
}
function saveCache(c) {
  if (!CACHE_FILE || MODE !== 'live') return;   // a dry run must not make the next live run think its props are fresh
  for (const [g, x] of Object.entries(c.games)) if (!(Date.parse(x.ko) > NOW) || !(NOW - x.t < 12 * 3600e3)) delete c.games[g];
  for (const [g, x] of Object.entries(c.wx)) if (!(NOW - x.t < 3 * 3600e3)) delete c.wx[g];
  fs.mkdirSync(path.dirname(path.resolve(CACHE_FILE)), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, 'saved=true\n');   // the workflow keeps the cache only when it changed
}
const r4 = x => typeof x === 'number' ? Math.round(x * 1e4) / 1e4 : x;
const slimProp = c => ({ key: c.key, abbr: c.abbr, name: c.name, market: c.market, price: c.price, book: c.book, mp: r4(c.mp), ev: r4(c.ev), edge: r4(c.edge), bimp: r4(c.bimp), conf: c.conf, tier: c.tier, rk: r4(c.rk) });
const usdTxt = x => '$' + (x >= 20 ? Math.round(x) : (Math.round(x * 2) / 2).toFixed(Math.round(x * 2) % 2 ? 2 : 0));
const etTime = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET';

async function main() {
  if (CACHE_FILE) fs.mkdirSync(path.dirname(path.resolve(CACHE_FILE)), { recursive: true });   // the workflow saves this folder after every run
  if (MODE !== 'dry' && !TOPIC) throw new Error('NTFY_TOPIC is not set — add it as a repository secret (see README → Edge alerts).');
  if (MODE === 'test') {
    await ntfySend({ title: '✅ NFL edge alerts are connected', message: 'This channel gets a buzz when one of your books prices an anytime TD or a player prop (receptions, receiving / rushing / rush+rec / passing yards) better than the other books do.', tags: ['football'], priority: 3 });
    log('test alert sent to your channel (no odds pulled, no credits used)'); return;
  }
  if (MODE === 'live' && isQuiet(NOW)) { log(`Quiet hours (${QUIET[0]}:00–${QUIET[1]}:00 Eastern) — nothing checked, no credits used.`); return; }
  if (!env.ODDS_API_KEY && !MOCK) throw new Error('ODDS_API_KEY is not set — add it as a repository secret.');
  S = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'nfl-td-snapshot.json'), 'utf8'));
  const MA = S.marketAnchor || {}, cal = MA.fitted && MA.cal ? MA.cal : null, snapWeeks = (S.meta && S.meta.snapWeeks) || 0;
  PM = S.propModel || null; PSTAT = PM ? Object.keys(PM.stats).filter(s => PM.stats[s].offered) : [];
  PROP_W = MA.props && MA.props.fitted && MA.props.w != null ? MA.props.w : 0.1;
  const cache = loadCache();
  if (TRIGGER === 'schedule' && MODE === 'live' && cache.lastRun && NOW - cache.lastRun < 25 * 60e3) {
    log(`Backup timer: the 30-minute timer ran ${Math.round((NOW - cache.lastRun) / 60e3)} min ago — nothing to do, no credits used.`); return; }
  const abbrOf = name => { const n = String(name || '').toLowerCase(), nick = n.split(' ').pop();
    return S.teamList.find(a => String(S.teams[a].name).toLowerCase() === n) || S.teamList.find(a => String(S.teams[a].name).toLowerCase().split(' ').pop() === nick) || null; };
  const key = encodeURIComponent(env.ODDS_API_KEY || 'mock');
  const events = (await oddsGet(`${ODDS_API}/events?apiKey=${key}`))
    .filter(e => { const t = Date.parse(e.commence_time); return t > NOW && t - NOW <= HOURS * 3600e3; });
  if (!events.length) { log(`No games kick off in the next ${HOURS} h — nothing pulled, no credits used.`); cache.lastRun = NOW; saveCache(cache); return; }
  log(`${events.length} game(s) in the next ${HOURS} h; your books: ${BOOKS.map(bookName).join(' + ')}${PROPS_ON && PM ? '' : ' · props OFF'}`);
  let inj = new Map(); try { inj = parseInjuries(await (await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries')).json()); } catch (e) { log('injuries unavailable:', e.message); }
  const [sync, sent, sched] = await Promise.all([syncState(), sentBefore(), espnSchedule()]);
  const statusOf = p => inj.get(String(p.id)) || p.status || 'ACT';
  const alerts = [], freshGames = new Set();
  for (const E of events) {
    if (creditsLeft != null && creditsLeft < RESERVE + 6) { log(`Stopping: ${creditsLeft} credits left, reserve ${RESERVE}.`); break; }
    const a0 = abbrOf(E.away_team), h0 = abbrOf(E.home_team); if (!a0 || !h0) continue;
    const find = L => L.find(g => g.away === a0 && g.home === h0) || L.find(g => g.away === h0 && g.home === a0);   // a neutral site can flip home / away
    const g = find(sched) || find(S.schedule || []) || { away: a0, home: h0, kickoff: E.commence_time, total: null, spread: null, fav: null, indoor: false, neutral: false, city: '' };
    const away = g.away, home = g.home, gid = away + '@' + home, hrs = (Date.parse(E.commence_time) - NOW) / 3.6e6;
    const C = cache.games[gid], propsOk = PROPS_ON && !!PM && !(creditsLeft != null && creditsLeft < PROP_RESERVE);
    const propsDue = propsOk && (!C || NOW - C.t >= PROP_EVERY(hrs) * 60e3);
    const markets = ['player_anytime_td', ...(propsDue ? Object.keys(OA_PROP) : [])];
    let body; try { body = await oddsGet(`${ODDS_API}/events/${E.id}/odds?apiKey=${key}&regions=us&markets=${markets.join(',')}&oddsFormat=american&includeLinks=true&includeSids=true`); }
    catch (e) { log(gid, e.message); continue; }
    const roster = [...rosterOf(away, statusOf), ...rosterOf(home, statusOf)], idx = buildPlayerIndex(roster);
    let wx = cache.wx[gid] && NOW - cache.wx[gid].t < 2 * 3600e3 ? cache.wx[gid].w : null;
    if (!wx) { wx = await gameWeather({ ...g, kickoff: E.commence_time }); cache.wx[gid] = { t: NOW, w: wx }; }
    const td = tdCandidates(body, idx, wx, cal, snapWeeks);
    let props = [], propNote = '';
    if (propsDue) {
      const imp = impliedPoints(g.total || 44.5, Math.abs(g.spread || 0), g.fav || home, home);
      props = propCandidates(body, idx, { away, home, imp }, wx.outdoor ? wx.wind : 0);
      cache.games[gid] = { t: NOW, ko: E.commence_time, props: props.map(slimProp) }; freshGames.add(gid);
      propNote = `${props.length} prop prices`;
    } else if (C) {   // between prop checks: the last prop prices hold their places on the card (never alerted from here)
      const out = new Set(roster.filter(p => p._status === 'OUT').map(p => p._key));
      props = C.props.filter(c => !out.has(c.key)).map(c => ({ ...c, stale: true }));
      propNote = `${props.length} prop prices from ${Math.round((NOW - C.t) / 60e3)} min ago`;
    } else propNote = propsOk ? 'props not checked' : 'props off';
    const logged = sync ? sync.nflOpen.filter(b => b.game === gid) : [];
    const { picks, edges } = gameCard(td.cands.concat(props), logged);
    const newPicks = picks.filter(c => !c.bet && !c.stale).map(c => ({ ...c, game: gid, ko: E.commence_time }));
    const nHeld = picks.filter(c => c.bet).length, nOld = picks.filter(c => c.stale && !c.bet).length;
    log(`${gid}: ${td.n} TD prices · ${propNote} · ${edges} edge(s) · ${picks.length} on the card` +
      (nHeld || nOld ? ` (${[nHeld ? nHeld + ' in your log' : '', nOld ? nOld + ' from the last prop check' : ''].filter(Boolean).join(', ')})` : ''));
    if (env.ALERT_DUMP) DUMP[gid] = { g, wx, cands: td.cands.concat(props).map(c => ({ ...c, link: undefined })), picks: picks.map(c => c.name + ' ' + c.market) };
    if (DEBUG) for (const c of td.cands.concat(props).filter(c => c.tier !== 'pass').sort((x, y) => y.rk - x.rk))
      log(`   ${c.tier.padEnd(4)} ${c.name} ${c.market} ${fmtAm(c.price)} ${c.book} · chance ${(c.mp * 100).toFixed(1)}% · EV ${(c.ev * 100).toFixed(1)}% · conf ${c.conf} · rank ${c.rk.toFixed(4)}${c.dup ? ' · dup' : ''}${c.stale ? ' · cached' : ''}`);
    alerts.push(...newPicks);
  }
  const idOf = c => c.link || (c.market === 'anytime' ? 'k:' + c.game + '|' + c.key : 'k:' + c.game + '|' + c.key + '|' + c.market);
  const titleOf = c => { const book = bookName(c.book);
    if (!isProp(c.market)) return `🏈 ${c.name} anytime TD ${fmtAm(c.price)} at ${book}`;
    const { s, side, line } = c.prop; return `📈 ${c.name} ${PROP_NAME[s]} ${side === 'O' ? 'over' : 'under'} ${line} ${fmtAm(c.price)} at ${book}`; };
  const usdOf = c => sync && sync.unitUsd ? Math.round(c.stake * sync.unitUsd * 2) / 2 : null;
  const seen = c => { const ids = [idOf(c), titleId(titleOf(c))]; return ids.some(k => sent.has(k) && sent.get(k) >= c.price); };
  let fresh = alerts.filter(c => !seen(c));   // not yet alerted at this price or better
  // 💰 BANKROLL LIMIT (the app's fitRoom): money on open bets across NFL, NBA and NHL never goes above your bankroll — new
  // bets take the room biggest $ first; the rest wait (no alert) until settled bets free some up. Off when the app's limit is off.
  if (sync && sync.lim && sync.bank != null && sync.unitUsd) {
    let left = sync.bank - sync.riding; const fit = [], wait = [];
    for (const c of fresh.slice().sort((a, b) => usdOf(b) - usdOf(a))) { if (usdOf(c) <= left + 1e-9) { fit.push(c); left -= usdOf(c); } else wait.push(c); }
    log(`bankroll: ${usdTxt(sync.riding)} of ${usdTxt(sync.bank)} in play · ${fit.length} new bet(s) fit${wait.length ? `, ${wait.length} wait for room (${wait.map(c => c.name).join(', ')})` : ''}`);
    fresh = fit;
  } else if (!sync) log('bankroll: unknown (no SYNC_TOKEN) — every bet alerted, stakes in units');
  fresh.sort((a, b) => b.rk - a.rk);
  let n = 0;
  for (const c of fresh) {
    if (n >= MAX_ALERTS) {   // the rest go next run: a game whose props weren't sent is checked again then
      log(`alert cap reached for this run — ${fresh.length - n} more next run`);
      for (const x of fresh.slice(n)) if (isProp(x.market) && cache.games[x.game]) cache.games[x.game].t = 0;
      break; }
    const [a, h] = c.game.split('@'), stake = usdOf(c) != null ? usdTxt(usdOf(c)) : `${c.stake.toFixed(1)}u (1u = 1% of your bankroll)`;
    const book = bookName(c.book), floor = floorPrice(c.mp, c.conf), when = `${S.teams[a].short} @ ${S.teams[h].short}, ${etTime(c.ko)}`;
    let why;
    if (!isProp(c.market)) why = `The other books (${c.nOth}) have him around ${fmtAm(probToAm(c.ip))}; fair chance ${pct(c.mp)} → EV +${(c.ev * 100).toFixed(0)}%.`;
    else { const { s, med } = c.prop, proj = `${med.toFixed(s === 'rec' ? 1 : 0)} ${PROP_UNIT[s]}`;
      why = (c.src === 'books' ? `The other books (${c.nOth}) make it ${pct(c.mkt)}` : c.src === 'near' ? `The other books' nearest line makes it about ${pct(c.mkt)}`
        : c.src === 'own' ? `No other book posts this line; its own over/under makes it ${pct(c.mkt)}` : `No market price — the model alone`) +
        `; the model projects ${proj} → fair chance ${pct(c.mp)}, EV +${(c.ev * 100).toFixed(0)}%.`; }
    await ntfySend({
      title: titleOf(c),
      message: `${why}\nBet ${stake}. ${when}.\n${floor ? `Still a bet at ${floor} or better — check` : 'Check'} the price before you place it.`,
      tags: [isProp(c.market) ? 'chart_with_upwards_trend' : 'football'], priority: 4,
      ...(c.link ? { click: c.link, actions: [{ action: 'view', label: `Open in ${book}`, url: c.link, clear: true }] }
        : BOOK_HOME[c.book] ? { actions: [{ action: 'view', label: `Open ${book} (find him)`, url: BOOK_HOME[c.book], clear: true }] } : {})
    });
    n++; log(`alert: ${titleOf(c)} · EV +${(c.ev * 100).toFixed(1)}% · ${stake}`);
  }
  cache.lastRun = NOW; saveCache(cache);
  if (env.ALERT_DUMP) fs.writeFileSync(env.ALERT_DUMP, JSON.stringify(DUMP, null, 1));
  log(`${n} alert(s) ${MODE === 'dry' ? 'printed' : 'sent'} · props checked for ${freshGames.size} game(s) · credits used ${creditsUsed}${creditsLeft != null ? ` · ${creditsLeft} left` : ''}`);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
