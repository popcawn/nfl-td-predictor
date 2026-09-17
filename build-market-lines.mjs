#!/usr/bin/env node
/*
 * build-market-lines.mjs
 * -------------------------------------------------------------------------
 * Scrapes ESPN's free historical "Anytime Touchdown Scorer" board (the set of
 * players the sportsbook actually made an anytime-TD market on) for a sample of
 * a season's games, and writes market_lines_<season>.json keyed by nflverse
 * game_id. build-nfl-td-snapshot.mjs picks this up and reports the model's
 * calibration restricted to the market's player universe (lines, not prices).
 *
 * ESPN exposes the LINE (target 0.5 = 1+ TD) but NOT the price, so this is a
 * "who did the book price" comparison, not a "beat the odds" comparison.
 *
 * Usage:
 *   node build-market-lines.mjs                 # season 2025, ~45 games sampled
 *   node build-market-lines.mjs 2025 60         # season, sample size
 *   FORCE=1 node build-market-lines.mjs         # ignore cache
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEASON = +(process.argv[2]) || 2025;
const SAMPLE = +(process.argv[3]) || 45;
// ESPN BET's prop board (incl. anytime TD) is archived only through ~wk13; later
// weeks fall back to a game-lines-only provider. Cap the scrape to weeks with data.
const MAXWEEK = +(process.env.MAXWEEK) || 18;
const PROVIDER = 58; // ESPN BET
const START_PAGE = 22; // anytime-TD (type 31) block sits deep; skip the front pages
const CACHE_DIR = process.env.NFL_CACHE_DIR ||
  path.join(process.env.TEMP || process.env.TMP || '/tmp', 'nflverse_cache');
const OUT = path.join(__dirname, `market_lines_${SEASON}.json`);
const ESPN2NFL = { WSH: 'WAS', LAR: 'LA' };
const nfl = a => ESPN2NFL[a] || a;

// curl handles gzip/redirects/UA that raw https.get does not for ESPN's site API
function gj(url, tries = 3) {
  for (let i = 0; i <= tries; i++) {
    try { return Promise.resolve(JSON.parse(execFileSync('curl', ['-sL', '--fail', '-m', '30', url], { encoding: 'utf8', maxBuffer: 1 << 26 }))); }
    catch (e) { if (i === tries) return Promise.reject(e); }
  }
}
function splitCSV(line){const o=[];let c='',q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(q){if(ch==='"'){if(line[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===','){o.push(c);c='';}else c+=ch;}}o.push(c);return o;}
const normName = s => String(s||'').toLowerCase().replace(/[.'`]/g,'').replace(/\b(jr|sr|ii|iii|iv|v)\b/g,'').replace(/[^a-z]/g,'').trim();

async function loadRosterMap() {
  const url = `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${SEASON}.csv`;
  const dest = path.join(CACHE_DIR, `roster_${SEASON}.csv`);
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    execFileSync('curl', ['-sL', '--fail', '-m', '120', '-o', dest, url], { stdio: 'ignore' });
  }
  const espn2gsis = new Map(), name2gsis = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(dest), crlfDelay: Infinity });
  let ix = null;
  for await (const line of rl) {
    if (ix === null) { const h = splitCSV(line); ix = {}; h.forEach((c, i) => { ix[c] = i; }); continue; }
    if (!line) continue;
    const f = splitCSV(line);
    const g = f[ix.gsis_id], e = f[ix.espn_id], nm = f[ix.full_name];
    if (g) { if (e) espn2gsis.set(String(e), g); if (nm && !name2gsis.has(normName(nm))) name2gsis.set(normName(nm), g); }
  }
  return { espn2gsis, name2gsis };
}

async function eventsForWeek(week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${SEASON}&seasontype=2&week=${week}`;
  const j = await gj(url);
  return (j.events || []).map(ev => {
    const comp = ev.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    return { id: ev.id, week, home: nfl(home.team.abbreviation), away: nfl(away.team.abbreviation) };
  });
}

async function anytimeBoard(eventId) {
  const base = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${eventId}/competitions/${eventId}/odds/${PROVIDER}/propBets`;
  const ids = new Set(); let collected = false;
  for (let p = START_PAGE; p <= 48; p++) {
    let j; try { j = await gj(`${base}?limit=25&page=${p}`); } catch { continue; }
    const items = j.items || [];
    if (!items.length) break;
    const types = items.map(x => x.type && +x.type.id).filter(Boolean);
    for (const it of items) {
      if (it.type && it.type.id === '31' && it.current && it.current.target && it.current.target.value === 0.5) {
        const m = it.athlete && it.athlete.$ref.match(/athletes\/(\d+)/); if (m) ids.add(m[1]);
      }
    }
    if (types.some(t => t === 31)) collected = true;
    if (collected && types.length && Math.min(...types) > 31) break; // walked past the block
  }
  // fallback: block was before START_PAGE (small slate) -> rescan from 1
  if (!ids.size) {
    for (let p = 1; p < START_PAGE; p++) {
      let j; try { j = await gj(`${base}?limit=25&page=${p}`); } catch { continue; }
      for (const it of (j.items || [])) if (it.type && it.type.id === '31' && it.current && it.current.target && it.current.target.value === 0.5) {
        const m = it.athlete && it.athlete.$ref.match(/athletes\/(\d+)/); if (m) ids.add(m[1]);
      }
    }
  }
  return [...ids];
}

(async function main() {
  if (fs.existsSync(OUT) && !process.env.FORCE) { console.log(`${OUT} exists (FORCE=1 to rebuild)`); return; }
  console.log(`\n=== market anytime-TD board scrape (${SEASON}) ===`);
  const { espn2gsis, name2gsis } = await loadRosterMap();
  console.log(`roster id map: ${espn2gsis.size} espn ids`);

  // gather all REG events, then sample evenly across weeks
  let all = [];
  for (let w = 1; w <= MAXWEEK; w++) { try { all = all.concat(await eventsForWeek(w)); } catch {} }
  all.sort((a, b) => a.week - b.week);
  const stride = Math.max(1, Math.round(all.length / SAMPLE));
  const sample = all.filter((_, i) => i % stride === 0).slice(0, SAMPLE);
  console.log(`${all.length} games found; scraping ${sample.length} (stride ${stride}) ...`);

  const out = {};
  let done = 0;
  for (const g of sample) {
    const espnIds = await anytimeBoard(g.id);
    const gsis = [];
    for (const eid of espnIds) { const gg = espn2gsis.get(String(eid)); if (gg) gsis.push(gg); }
    const gid = `${SEASON}_${String(g.week).padStart(2, '0')}_${g.away}_${g.home}`;
    out[gid] = { event: g.id, week: g.week, away: g.away, home: g.home, listed: espnIds.length, market: gsis };
    done++;
    if (done % 5 === 0 || done === sample.length) console.log(`  ${done}/${sample.length}  ${gid}: ${espnIds.length} listed / ${gsis.length} id-mapped`);
  }
  const meta = { season: SEASON, provider: 'ESPN BET (id 58)', scrapedAt: new Date().toISOString(), games: Object.keys(out).length };
  fs.writeFileSync(OUT, JSON.stringify({ meta, games: out }));
  console.log(`wrote ${OUT} (${meta.games} games)\n=== done ===`);
})().catch(e => { console.error('SCRAPE FAILED:', e); process.exit(1); });
