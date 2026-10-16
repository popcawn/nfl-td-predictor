// 📲 EDGE ALERTS — checks your books' anytime-TD prices for games kicking off soon and pushes the bets Your card would
// make to your phone (ntfy). It never places a bet: each alert carries a link that opens the bet in your book's slip.
//
// Same rule as the app's "🎯 Build my TD picks" (nfl-td-predictor.template.html: consensusFrom / anchorTD / evalBet /
// tierOf / legConfidence / pickPlays — keep them in step): chance = the OTHER books' median implied price, calibrated
// (S.marketAnchor.cal; the model's share is 0 for TDs, so no sim is needed); the price judged is the best among your
// books; tier 'take' (EV > 3%, chance >= 6%, edge <= 22 pts, has history); confidence; 1/4 Kelly; per game the best 3,
// at most 2 per team, one per player. Not run here: weather (the app trims WR/TE/QB confidence x0.9 in bad weather) and
// the whole-day 15% cap. On 2025's real prices this "other books say it's +EV" rule went +58% then -14% across the two
// halves at closing prices — unproven. CLV in the bet log is how to judge it.
//
// Run by .github/workflows/alerts.yml (timer OFF until switched on) or by hand: `node alerts/watch.mjs`.
//   ODDS_API_KEY  The Odds API key (1 credit per game per check; the events list is free)
//   NTFY_TOPIC    your private ntfy channel name (subscribe to it in the ntfy phone app)
//   SYNC_TOKEN    optional: the app's ☁ Sync token (gist scope) -> stakes in dollars from your bankroll, and players
//                 you've already logged are skipped
//   ALERT_MODE    live (default) | dry (check + print, send nothing) | test (send one test alert, no odds, no credits)
//   ALERT_HOURS   only games kicking off within this many hours (default 6)
//   ALERT_BOOKS   your books (default fanduel,draftkings)
//   ALERT_RESERVE stop pulling when the key has fewer credits left than this (default 1000 — the app needs some too)
//   ALERT_MAX     at most this many alerts per run (default 6)
//   ALERT_STATE   your state, e.g. nj — BetMGM and Caesars put it in their bet-slip links (repo variable ALERT_STATE)
//   ALERT_MOCK    a JSON file {events:[...], odds:{eventId: body}} to test without credits or network to The Odds API
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env, MODE = (env.ALERT_MODE || 'live').trim().toLowerCase();
const HOURS = +env.ALERT_HOURS || 6, RESERVE = env.ALERT_RESERVE != null && env.ALERT_RESERVE !== '' ? +env.ALERT_RESERVE : 1000;
const MAX_ALERTS = +env.ALERT_MAX || 6;
const BOOKS = (env.ALERT_BOOKS || 'fanduel,draftkings').split(',').map(s => s.trim()).filter(Boolean);
const NTFY = 'https://ntfy.sh', TOPIC = (env.NTFY_TOPIC || '').trim(), STATE = (env.ALERT_STATE || '').trim().toLowerCase();
const ODDS_API = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl';
const FD_SLIP = 'https://sportsbook.fanduel.com/addToBetslip';
const BOOK_NAMES = { fanduel: 'FanDuel', draftkings: 'DraftKings', betmgm: 'BetMGM', williamhill_us: 'Caesars', espnbet: 'ESPN BET', fanatics: 'Fanatics', betrivers: 'BetRivers' };
const bookName = b => BOOK_NAMES[b] || b;
const BOOK_HOME = { fanatics: 'https://sportsbook.fanatics.com/' };   // no bet-slip link from the API: open the book
const log = (...a) => console.log(...a);

// ---- the app's helpers, copied ----
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const americanToDec = a => { a = +a; if (!a) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / (-a); };
const americanToProb = a => { a = +a; if (!a) return null; return a > 0 ? 100 / (a + 100) : (-a) / ((-a) + 100); };
const logit = p => Math.log(p / (1 - p)), expit = x => 1 / (1 + Math.exp(-x));
const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const normName = s => String(s || '').toLowerCase().replace(/[.'`]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/[^a-z]/g, '').trim();
const fmtAm = v => (v > 0 ? '+' : '') + v;
const pct = p => (p * 100).toFixed(0) + '%';
const probToAm = p => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
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
function legConfidence(o, snapWeeks) {   // the app's, for anytime TDs (no D/ST, no weather)
  let s = 1;
  if (!o.matched) s *= 0.45;
  else {
    const R = { full: 1, rot: 0.85, part: 0.7, qb: 0.8, none: snapWeeks < 2 ? 0.8 : 0.5 }[o.role] ?? 0.7;
    s *= R; s *= clamp(0.6 + 0.4 * (o.games || 0) / 10, 0.6, 1);
  }
  if (o.status === 'Q') s *= 0.75; else if (o.status === 'DBT') s *= 0.45;
  if (o.bimp < 0.06) s *= 0.65; else if (o.bimp < 0.12) s *= 0.85;
  const e = o.edge; if (e > 0.20) s *= 0.55; else if (e > 0.12) s *= 0.75; else if (e > 0.06) s *= 0.9;
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
  if (book === 'betrivers' && STATE && o.link && o.link.includes('{state}')) return o.link.replace('{state}', STATE).replace('{pickType}', 'single').replace('{wagerAmount}', '');   // best guess, like the app
  return null;
}

// ---- I/O ----
const MOCK = env.ALERT_MOCK ? JSON.parse(fs.readFileSync(env.ALERT_MOCK, 'utf8')) : null;
let creditsLeft = null, creditsUsed = 0;
async function oddsGet(url) {
  if (MOCK) { const m = /\/events\/([^/]+)\/odds/.exec(url); creditsUsed += m ? 1 : 0; return m ? MOCK.odds[m[1]] : MOCK.events; }
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
// alerts already sent (ntfy keeps a channel's messages ~12 h): link -> best price alerted, so a bet is alerted once and
// again only if the price gets better
async function sentBefore() {
  const out = new Map(); if (!TOPIC) return out;
  try {
    const r = await fetch(`${NTFY}/${encodeURIComponent(TOPIC)}/json?poll=1&since=12h`); if (!r.ok) return out;
    for (const line of (await r.text()).split('\n')) { if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch (e) { continue; }
      const k = m.click || ((m.tags || []).find(t => t.startsWith('k:')) || ''), am = /TD ([+-]\d+)/.exec(m.title || '');
      if (k && am) out.set(k, Math.max(out.get(k) ?? -Infinity, +am[1])); }
  } catch (e) { log('could not read past alerts:', e.message); }
  return out;
}
// the app's ☁ Sync gist: bankroll now (BANK.amt + settled P/L since) and players you already have open bets on
async function syncState() {
  const tok = (env.SYNC_TOKEN || '').trim(); if (!tok) return null;
  const gh = async p => { const r = await fetch('https://api.github.com' + p, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' } }); if (!r.ok) throw new Error('GitHub ' + r.status); return r.json(); };
  try {
    let hit = null;
    for (let page = 1; page <= 5 && !hit; page++) { const list = await gh(`/gists?per_page=100&page=${page}`); hit = list.find(x => x.files && x.files['nfl-td-sync.json']); if (list.length < 100) break; }
    if (!hit) { log('sync: no nfl-td-sync.json gist for this token'); return null; }
    const g = await gh('/gists/' + hit.id), f = g.files['nfl-td-sync.json'];
    const d = JSON.parse(f.truncated && f.raw_url ? await (await fetch(f.raw_url)).text() : f.content);
    const units = d.bankroll > 0 ? d.bankroll : 100, B = d.bank || {}, bets = d.bets || [];
    const usd = b => b.usd != null ? +b.usd : (B.amt ? (+b.stake || 0) * B.amt / units : null);
    let now = null;
    if (B.amt) { now = B.amt; for (const b of bets) if (b.st > B.at) { const u = usd(b), dec = americanToDec(String(b.odds).replace('+', '')) || 1;
      if (u != null) now += b.result === 'win' ? u * (dec - 1) : b.result === 'loss' ? -u : 0; } now = Math.max(0, now); }
    const open = new Set();
    for (const b of bets) if (b.result === 'pending') { if (b.legs) b.legs.forEach(l => open.add(l.game + '|' + l.key)); else if (b.game && b.key) open.add(b.game + '|' + b.key); }
    return { unitUsd: now != null ? now / units : null, open };
  } catch (e) { log('sync: could not read your bet log —', e.message); return null; }
}
const usdTxt = x => '$' + (x >= 20 ? Math.round(x) : (Math.round(x * 2) / 2).toFixed(Math.round(x * 2) % 2 ? 2 : 0));
const etTime = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET';

async function main() {
  if (MODE !== 'dry' && !TOPIC) throw new Error('NTFY_TOPIC is not set — add it as a repository secret (see README → Edge alerts).');
  if (MODE === 'test') {
    await ntfySend({ title: '✅ NFL edge alerts are connected', message: 'This channel will get a buzz when one of your books prices an anytime TD better than the other books do. Nothing is checked or bet automatically until the timer is switched on.', tags: ['football'], priority: 3 });
    log('test alert sent to your channel (no odds pulled, no credits used)'); return;
  }
  if (!env.ODDS_API_KEY && !MOCK) throw new Error('ODDS_API_KEY is not set — add it as a repository secret.');
  const S = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'nfl-td-snapshot.json'), 'utf8'));
  const MA = S.marketAnchor || {}, cal = MA.fitted && MA.cal ? MA.cal : null, snapWeeks = (S.meta && S.meta.snapWeeks) || 0;
  const abbrOf = name => { const n = String(name || '').toLowerCase(), nick = n.split(' ').pop();
    return S.teamList.find(a => String(S.teams[a].name).toLowerCase() === n) || S.teamList.find(a => String(S.teams[a].name).toLowerCase().split(' ').pop() === nick) || null; };
  const key = encodeURIComponent(env.ODDS_API_KEY || 'mock'), now = Date.now();
  const events = (await oddsGet(`${ODDS_API}/events?apiKey=${key}`))
    .filter(e => { const t = Date.parse(e.commence_time); return t > now && t - now <= HOURS * 3600e3; });
  if (!events.length) { log(`No games kick off in the next ${HOURS} h — nothing pulled, no credits used.`); return; }
  log(`${events.length} game(s) in the next ${HOURS} h; your books: ${BOOKS.map(bookName).join(' + ')}`);
  let inj = new Map(); try { inj = parseInjuries(await (await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries')).json()); } catch (e) { log('injuries unavailable:', e.message); }
  const [sync, sent] = await Promise.all([syncState(), sentBefore()]);
  const alerts = [];
  for (const E of events) {
    if (creditsLeft != null && creditsLeft < RESERVE + 1) { log(`Stopping: ${creditsLeft} credits left, reserve ${RESERVE}.`); break; }
    const away = abbrOf(E.away_team), home = abbrOf(E.home_team); if (!away || !home) continue;
    const gid = away + '@' + home;
    let body; try { body = await oddsGet(`${ODDS_API}/events/${E.id}/odds?apiKey=${key}&regions=us&markets=player_anytime_td&oddsFormat=american&includeLinks=true&includeSids=true`); }
    catch (e) { log(gid, e.message); continue; }
    // per player: your best price (+ its slip link), the other books' implied prices
    const byName = new Map();
    for (const bk of (body && body.bookmakers) || []) for (const m of (bk.markets || [])) if (m.key === 'player_anytime_td') for (const o of (m.outcomes || [])) {
      if (o.name !== 'Yes' || !o.description) continue;
      const t = byName.get(o.description) || { oth: [], mine: [], best: null }; byName.set(o.description, t);
      if (BOOKS.includes(bk.key)) { t.mine.push(americanToProb(o.price)); if (!t.best || o.price > t.best.price || (o.price === t.best.price && BOOKS.indexOf(bk.key) < BOOKS.indexOf(t.best.book))) t.best = { book: bk.key, price: o.price, link: slipLink(bk.key, o) }; }
      else t.oth.push(americanToProb(o.price));
    }
    const roster = [...(S.rosters[away] || []).map(p => ({ ...p, abbr: away })), ...(S.rosters[home] || []).map(p => ({ ...p, abbr: home }))], idx = buildPlayerIndex(roster);
    const cands = [];
    for (const [name, t] of byName) {
      if (!t.best || !t.oth.length) continue;   // no other book = no market to beat (the app never shows an edge there)
      const p = matchPlayer(name, idx); if (!p) continue;
      const status = inj.get(String(p.id)) || 'ACT'; if (status === 'OUT') continue;
      const k = p.abbr + '|' + p.id; if (sync && sync.open.has(gid + '|' + k)) continue;   // you already bet him
      const ip = t.oth.length >= 2 ? median(t.oth) : median(t.oth.concat(t.mine));
      const mp = cal ? expit(cal.a + cal.b * logit(clamp(ip, 0.003, 0.995))) : ip;
      const dec = americanToDec(t.best.price), bimp = americanToProb(t.best.price), ev = mp * (dec - 1) - (1 - mp), edge = mp - bimp;
      if (tierOf(mp, edge, ev, !p.matched) !== 'take') continue;
      const conf = legConfidence({ role: roleOf(p), pos: p.pos, games: p.games, status, matched: p.matched, edge, bimp }, snapWeeks);
      cands.push({ key: k, abbr: p.abbr, name: p.name, game: gid, ko: E.commence_time, ...t.best, mp, ip, ev, edge, conf, nOth: t.oth.length, rk: edge > 0 ? conf * edge / (1 - bimp) : 0 });
    }
    const picks = pickPlays(cands);
    log(`${gid}: ${byName.size} priced, ${cands.length} edge(s), ${picks.length} on the card`);
    alerts.push(...picks);
  }
  alerts.sort((a, b) => b.rk - a.rk);
  let n = 0;
  for (const c of alerts) {
    const id = c.link || 'k:' + c.game + '|' + c.key;
    if (sent.has(id) && sent.get(id) >= c.price) continue;   // already alerted at this price or better
    if (n >= MAX_ALERTS) { log('alert cap reached for this run'); break; }
    const [a, h] = c.game.split('@'), stake = sync && sync.unitUsd ? `${usdTxt(c.stake * sync.unitUsd)} (${c.stake.toFixed(1)}u)` : `${c.stake.toFixed(1)}u (1u = 1% of your bankroll)`;
    const book = bookName(c.book);
    await ntfySend({
      title: `🏈 ${c.name} anytime TD ${fmtAm(c.price)} at ${book}`,
      message: `The other books (${c.nOth}) have him around ${fmtAm(probToAm(c.ip))}; fair chance ${pct(c.mp)} → EV +${(c.ev * 100).toFixed(0)}%.\n` +
        `Bet ${stake}. ${S.teams[a].short} @ ${S.teams[h].short}, ${etTime(c.ko)}.\nCheck the price before you place it — it can move.`,
      tags: c.link ? ['football'] : ['football', id], priority: 4,
      ...(c.link ? { click: c.link, actions: [{ action: 'view', label: `Open in ${book}`, url: c.link, clear: true }] }
        : BOOK_HOME[c.book] ? { actions: [{ action: 'view', label: `Open ${book} (find him)`, url: BOOK_HOME[c.book], clear: true }] } : {})
    });
    n++; log(`alert: ${c.name} ${fmtAm(c.price)} ${book} · EV +${(c.ev * 100).toFixed(1)}% · ${c.stake}u`);
  }
  log(`${n} alert(s) ${MODE === 'dry' ? 'printed' : 'sent'} · credits used ${creditsUsed}${creditsLeft != null ? ` · ${creditsLeft} left` : ''}`);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
