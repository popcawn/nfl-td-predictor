# NFL Anytime-TD Simulator — working notes

Single-file HTML app (`nfl-td-predictor.html`) + a Node build (`build-nfl-td-snapshot.mjs`) that bakes nflverse
play-by-play and ESPN data into it. Live copy: https://popcawn.github.io/nfl-td-predictor/ (GitHub Pages, `main`).
See README.md for what the model does and how it was validated.

## Where things happen
- **Edit** `nfl-td-predictor.template.html` (UI + live model) and `build-nfl-td-snapshot.mjs` (data + backtest).
  Never hand-edit `nfl-td-predictor.html` / `nfl-td-snapshot.json` — the build regenerates both.
- **Data refresh** runs on GitHub Actions (`.github/workflows/refresh.yml`, daily 10:37 UTC) and commits the rebuilt
  files. So **`git pull` before starting work** on any machine, or pushes will conflict on those two files.
- The game slate, lines, injuries and weather refresh live inside the app from ESPN / Open-Meteo on every visit.
  ESPN's default scoreboard keeps LAST week's finished games until midweek — both the build and the app
  (`fetchActiveWeek`) move to next week once every game on it is final. Neutral-site games (London etc.) geocode
  ESPN's venue city for weather instead of using the home team's stadium.

## Build / dev loop
- Full build: `node build-nfl-td-snapshot.mjs` (Node 18+, `curl`). First run on a machine downloads ~200 MB into
  `%TEMP%\nflverse_cache` (override with `NFL_CACHE_DIR`). `SKIP_LOGOS=1` skips the logo downloads.
- Template-only change: re-inject the existing snapshot instead of rebuilding —
  replace `/*__SNAPSHOT__*/` in the template with `window.__SNAPSHOT__ = <contents of nfl-td-snapshot.json>;`
  and write `nfl-td-predictor.html` (then parse-check each `<script>` with `new Function`).
- Test in a browser over http (a tiny local static server), not `file://` — the browser pane blocks file URLs.

## Rules for model changes (learned the hard way)
- One `MODEL` config in the build drives BOTH the live player scores and `runBacktest()`, and ships as `C.MODEL`
  for the template. Any change to how probabilities are computed must go through it; live-only tweaks drift from
  what was validated (this happened twice: a red-zone reshape and a Poisson/NB mismatch).
- Validate with `BT_EXPERIMENTS=1 node build-nfl-td-snapshot.mjs`: it flips each switch and scores weeks 1–9 and
  10–18 separately. Keep a change only if it helps on **both** halves. Don't tune to one season (per-position gaps of
  1–2 standard errors are noise).
- Backtests must be leak-free: only data from before each game; kappa/baselines from the train season.
- Things tested and removed because they hurt out-of-sample: game-script, opponent run/pass funnel, the
  defense-vs-position matchup nudge (shown, not applied), the old snap curve, a defense's own TD history.
- 2026-10-05, user asked to favour RBs ("RBs dominating TDs"): the data disagreed. 2026 wks 1-4 rush share of TDs 36.0%
  (2024-25: 38.7/38.6%), RB share 33.4% (35.6/37.1%), weekly RB share swung 25-42% (noise). Tested on 2025 halves AND
  2026 wks 1-4 (`node build-nfl-td-snapshot.mjs 2025 2026` = train 2025 / test 2026; props crash on an in-progress
  test season, the TD harness prints first): blanket RB boost x1.1/x1.2 and an in-season league-trend switch
  (MODEL.trend, K=100/250/600) both WORSE on 2026 -> not shipped. `BT_WEEKLY=1` prints Brier + by-position per week.
- Defense props = **defensive TDs only** (books don't count special teams); kick/punt return TDs are credited to
  returners. Role calibration (rotational ×~0.87, QB ×~0.85) is cross-fitted — don't extend it without re-testing.

## Player props (PROP_MODEL in the build; propMu/propSides in the template)
- Stats: rec, recyd, ryd, rryd, pyd. Pass TDs (ptd) stay in the backtest but `offered:false` — edge vs a season
  average was a hair and the top bucket was miscalibrated (87%->76%).
- Per-stat K (shrink pseudo-games) came from a sweep with the population PINNED (`popK`) — the first sweep let K change
  who got scored. rec/recyd K=1, rryd 2, ryd 3, pyd 8. recyd's snap factor is borderline (loses H1 by 0.0003).
- Passing props = the starter only (played >= 50% of snaps), history = his starts only (`qbStartHist`), floor 0.
- `propPOver()` exists in BOTH files (build + template); keep them identical. Tables are 201-quantile compressed
  actual/projection ratios in 4 projection-size buckets, fit on the test season — what ships is what was scored.
- Live inputs per rostered player: `pp = {g, cg, sf, w:{stat: weighted per-game}, avg}`; the app applies snap + context.
- Prop confidence/tier (`propConfidence`, `propTier`) are reasoned, not fitted — same caveat as legConfidence.
- TD + prop JOINT model (same-game parlays): build ships `propModel.cond[stat]` = actual/projection quantiles split by
  whether he scored (pyd: team passing TDs 0/1/2+), 2 projection buckets; each stat ships only if "TD & over / TD &
  under" (pyd: over given team pass TDs) beat independence on BOTH halves (all 5 did, 2026-09-29). simulate() records
  `passT` per sim; the picker's joint = product of each leg's own probability x the sim's correlation lift
  (legVec/jointOf), so TD-only combos equal the old role-calibrated joint.

## Look (2026-10-19, user: "its a little dark. Modernize the site … markets in the background … just a pull odds and the bets across all games with click-to-open links" → "light default, apply it to all three")
- One look for all three apps (+ the front door): light theme by default, 🌙 dim (`sims_theme` in localStorage — one setting for the
  whole site; a head script sets it before first paint). Fonts: Inter (text), Space Grotesk (headings), JetBrains Mono (odds,
  money) from Google Fonts; base 16px. Colors are CSS variables redefined under `:root[data-theme="dim"]` — never hardcode a
  dark-only color (team names as text go through teamText(), which is theme-aware).
- Sticky top bar (`#topbar`): brand → popcawn.github.io, sport pills, the pot as stat boxes (renderPotChip: bankroll ·
  this week = every sport's bets settled since Monday · bets · open · this game), light/dim button, then the tabs (`#dtabs`).
  Phones keep the bottom bar (`#mtabbar`); showTab() keeps both in step. Sticky offsets use --navh = top bar height.
- Tabs at EVERY width now (sections carry data-m): picks = ⚡ Bets (Pull all games hero + week cards, then My TD picks), game = 🏈 the open game (controls, markets; Price + Your card in the side column ≥1200px), bets = 📓 Bet log (slip + log; bankroll beside), more = ⋯ (model accuracy, team profiles, notes). The jump bar is hidden; goTo() switches to the section's tab.
- The first tab is a big pull button (.hero) and the bets as cards (betCard(): name, market, price + book, Bet $, chance bar
  vs the price's chance, EV, an Open-on-<book> link). The internals (pulls, card rules, staking, log) did not change.
- Name: PROP SIM (tab title, brand, front door; user 2026-10-19). Switching sports must feel seamless: links go STRAIGHT to
  `<repo>/<repo>.html` — never the folder (its index.html is only a redirect for old links/bookmarks, and linking it
  flashed a page between sports). How a switch works (recorded frame by frame in a throwaway headless Chrome, 2026-10-19 — the user still saw a flash
  NBA -> NFL): `@view-transition{navigation:auto}` with NO animation (a 160 ms cross-fade showed both pages at once) and
  no separate top-bar layer (its see-through background let the old tabs show for a frame), so the page you leave stays
  on screen until the next is fully drawn, then they swap in one frame (~100 ms into NFL). Speculation rules PRERENDER
  the other sports on hover; `opened()` holds everything that spends or writes (odds pulls — NFL fetchGameOdds, NBA/NHL
  apiGet — settling, closes, gist sync) until the page is actually opened. `sims_chip` = the last pot boxes, shown
  instantly. Fonts are self-hosted on popcawn.github.io/fonts (preloaded, `font-display: optional` — no late re-draw of
  the text). NBA / NHL also open with the last slate + injuries this browser saw (`*_slate`, `*_inj`), refreshed from
  ESPN a moment later, so the date line and tonight's bets don't pop in. Test harness idea: Chrome --headless=new +
  CDP Page.startScreencast, with a normal user agent (ESPN doesn't answer HeadlessChrome).
- First paint waits for the app to draw itself: `<link rel="expect" href="#sims-ready" blocking="render">` in the head and
  `<i id="sims-ready" hidden>` right AFTER the main script (keep it last in body), so a sport switch fades from one finished
  page to the next instead of showing a half-drawn one.
- NFL page weight: the snapshot embedded 32 team logos at 500 px (1.8 MB of a 2.9 MB page — the user still saw a flash going
  NBA -> NFL). The build now embeds 80 px logos from ESPN's image combiner (~4 KB each; the app shows them at 22-40 px):
  page ~0.86 MB. Don't embed full-size images in the snapshot.
- The ⚡ Bets list draws ONLY new bets (user, 2026-10-21: "logged bets shouldnt be shown. Only new bets"); the status line
  still counts the logged ones ("· 1 already in your log") and the log has them. Your card (NFL game tab) still shows both.
- The ⚡ Bets list is grouped BY SPORTSBOOK (user, 2026-10-21: "doesnt need to stacked. or even seperated by game … if
  anything seperate by book"): FanDuel, DraftKings, BetMGM, Caesars, Fanatics; each section is one grid of cards with an
  "Open all N on <book>" button, and each card names its game and start time. Fanatics (no slip link) opens its home page.
- ✕ Skip + "bet at X or better" (user, 2026-10-21: FanDuel showed +104 for a +114 card bet — "should it be a removed
  button … when i recheck for bets it doesnt pop up again"): each card has ✕ Skip (SKIP map in localStorage *_skip, key
  game|player|stat, kept 4 days NBA/NHL, 8 NFL) — the bet stays hidden through re-pulls; "↩ Bring back" under the list undoes
  it. floorPrice() = the worst price that still passes the card's rule (EV > 3%; NBA/NHL also 1.5 points of edge), shown
  as "bet at +110 or better" so the user can compare with the slip. NFL: Your card on the game tab ignores skips.
- GOTCHA (2026-10-21): many functions here are ONE line. Never add a // comment in the middle of a line — everything after it
  is commented out. A note added after logBet's first check hid `const k=unitUsd();` and every 📓 log button threw
  "k is not defined". Put notes on their own line above.
- ↩ UNDO A LOG (2026-10-31, user: "create a button that undo log bets if i accidently click log bets"): every bet a click
  logs calls noteLogged(id) (NFL: logBetFrom, the manual add form, logParlay; NBA/NHL: logBet). One click = one batch
  (gathered with setTimeout 0) -> pop-up #undoBar "📓 Logged N bets · ↩ Undo · ✕" for 30 s, above the phone tab bar.
  undoLog() takes the batch's still-open bets out through saveBets (sync tombstones, like the log's ✕); a newer click
  replaces the pop-up. ANY NEW WAY TO LOG A BET MUST CALL noteLogged.
- 📱 PHONE STATS TABLES (2026-11-01, user screenshot: the Log tab slid sideways on a phone): a stats table with more
  columns than fit 390px gets class "pcards" and labelCells(container) after it is drawn — under 760px each row becomes a
  small card (name on top, 3-column grid of numbers, each with its column name from data-l above it). Used by By
  sportsbook, Background bets and NFL's When you bet. A NEW WIDE TABLE MUST DO THE SAME or sit in a .scroll box, never
  widen the page.
- ⏱ MID-GAME SETTLING (2026-11-01, user: "are you able to settle bets mid game?" → "yes"): espnEventsFor marks `live`
  (state 'in'); a game being played goes through legLive() (liveCache, cleared each run; finals stay in evCache). Only what
  can't change: anytime / 2+ TD once scored, a defense TD, 1st TD once ANYONE has scored, receptions past the line.
  YARDS WAIT FOR THE FINAL — they can go back down (a loss on a run or catch); so do last TD, voids, blocked kicks. A parlay
  settles mid-game when a leg has lost (final or live) or every leg has already won; otherwise it waits.
  It carries b.mid=1 (log icon ⏱, b.auto "… mid-game") until the game is final; then autoSettle checks it again
  against the final box score (a stat correction flips it — note "N mid-game results changed at the final") and drops mid.
  A result set by hand deletes mid, so it is never touched again. Settle runs on open + every 10 min while the app is
  open (ESPN, free). Tested 2026-11-01 with a mocked ESPN (live -> final, incl. a correction) and once on a real live game.
- Priced list: the ✓ on a logged bet takes it back OUT of the log (user, 2026-10-21: "i cant remove a logged bet") — hover
  reads "✕ remove", a confirm names the bet, then it is deleted like the bet log's ✕ (a sync tombstone, so other devices drop it).
- 🎯 TD picks at ONE book (user, 2026-10-21: "this selection of bets should all come from one book … decide which book based
  on best prices"): buildSlate re-prices every candidate at each of your books (the ticket's alt map), runs pickPlays per game
  there, and keeps the book whose best N add up to the most conf-adjusted Kelly (SLATE.book; header "all at <book>").
- NO CAPS (user, 2026-10-21: "no cap" → "no cap on nhl or nba either"): no week cap on ⚡ Pull all games and no day cap on
  the TD picks (SLATE_CAP removed). Bets are still sized one by one (¼ Kelly, MAX_PER_TEAM, 4% team cap); the TD-picks
  parlay stays ≤ 1%. Don't re-add a total cap unless the user asks.
- PARLAYS: FANDUEL / DRAFTKINGS ONLY (user, 2026-10-21: "betmgm is weird with their parlay rules … straight bets are ok to be
  used from betmgm. im only referring to parlay picks"): PARLAY_BOOKS / parlayBooks() in parlayAt() — the parlay picker and the
  TD picks' parlay of the day. Straight bets (TD and props) still use every one of your books, BetMGM included.
- Bet log tables FIT their column — no sideways scroll bar (user, 2026-10-21: "remove the scroll bar"): table.logtbl lets the bet
  and the close / CLV cell wrap (odds, stake, result, P/L stay on one line). Don't put white-space:nowrap back on those cells.
- Bet log tidy (user, 2026-10-21): "52 bets · 52 open" reads "52 open bets" (cnt()); NBA/NHL bet lines drop the game (it is on
  hover); a TO WIN column (profit if it wins, to the cent) and "could win $X" on the week / night / game summaries. Stakes are
  LOGGED AS SHOWN (roundUsd(): whole $ from $20, half-dollars from $1, cents below) — before, the card showed $1.50 but the log
  kept e.g. $1.73, so P/L and To win didn't match the book. Bets logged before this keep their old amounts.
- One-time stake fix (2026-10-21, user: "a 2 bet at +100 wins $2 not 1.97"): bets logged before "logged as shown" are rounded to
  what the card showed (flag *_usdround; NFL only touches app-logged bets — book / legs / mktP / rawP / fun — never a hand-typed
  stake), stamped mt so Sync spreads it. The log's stake shows exactUsd(): the usual format for round amounts, else cents.
- BetMGM STAKES ARE TYPED BY THE USER (2026-10-26, final — user: "i dont want the average. i want each respective ... just
  open all with a click and i fill it in"). Every bet keeps its own stake on the card; BetMGM links carry NO stake (single or
  open-all), one "Open all N on BetMGM" per book group. History: 10-25 a stake in a multi-bet link filled ONE amount on every
  bet (stake=2,3 filled nothing) -> one button per stake amount; 10-26 too many buttons -> a shared average stake; the user
  rejected the average, and BetMGM turned &stake=0.78 into $0.50. Don't bring back link stakes or shared stakes.
- BetMGM links = the bet slip on their SITE (a single bet's &stake= filled in on the user's iPhone
  2026-10-22: bet + stake filled in Safari). The user asked for the APP; nothing opens it from a link on their phone: /en/sportsapp/
  addresses (the only ones Apple's app-site-association lists) opened Safari, betmgm.onelink.me app links opened the App Store, and
  BetMGM publishes no private link type. Don't re-try those; a guessed custom scheme was offered, not tried.

## The user
- Bets FanDuel props, pastes boards in FanDuel's stacked format, builds cross-game parlays.
- Wants a clear answer to "what do I bet": the **Your card** panel (Kelly-ranked, ¼-Kelly, team caps) is the
  primary surface — keep new decision features there. Be honest that the model tracks the market; CLV in the bet
  log is how edge gets proven.

## Decision features (heuristic, not backtested)
- `legConfidence()` scores each pick 0–1; adjusted prob = book + conf × (model − book), so adjusted EV = conf × EV.
  Card stakes and the slip both use it. Its weights are reasoned, NOT fitted — there are no historical prices to fit
  them. Don't present them as validated; revisit once the bet log has enough settled bets.
- 2+ TD market (checked 2026-09-28 via BT_EXPERIMENTS): calibrated overall, but predictions ~24% landed ~18-19%.
  A top-end correction held in the touched set (x0.83-0.86 both halves) but flipped in the roster set, so the
  PROBABILITY is unchanged; confidence applies x0.8 to 2+ picks >=15% instead. Re-test with more seasons.
- Only the card is a bet list. ONE rule, `pickPlays()`, picks a game's bets for BOTH Your card and the bet log's per-game
  plan: conf-adjusted Kelly order, one per player, ≤ MAX_PER_TEAM per team, ≤ maxPerGame() (select, default 3) per game,
  ¼ Kelly with a 4% team cap. The card's options = priced takes + PENDING logged bets for the game (a logged bet keeps
  its rank in `rk`), so "log every edge, then ✂ Trim" and "paste everything, read the card" give the same answer.
  Card picks show "★ BET x.xu"; other +EV rows a neutral "edge" badge with the reason on hover (SKIPWHY). Background:
  the user read every green TAKE as "bet it" and logged 13 bets / 22.6u on one game.
- ONE BET PER PLAYER PER STAT (2026-10-20, user: "the line got bet up but i rather not take the same stat for the same
  player" — A.J. Brown rec yds under 70.5 logged, then under 71.5 at BetMGM showed as NEW): `heldSameStat(game, c)` —
  a pending prop on the same player and stat (`statOf()` = 'P|recyd', any side or line) keeps that stat. It is off the
  card's options and listed under "Left off" ("you already bet … — one bet per stat"), dropped from the ⚡ week list, and
  logBetFrom() refuses it. TD markets (anytime / 1st / last / 2+) are each their own stat, as before.
- Layout (sportsbook): `.book` grid = `.bmain` (Markets panel, teams, parlays, slip, log) + `.bslip` sticky sidebar
  (paste box + Your card) at ≥1200px. Markets = renderMarkets(): tabs MTAB ('all' = ★ Priced board, 'td', or a prop stat),
  two team columns (container query on .bmain), price boxes .mcell; decorateMarkets() recolours boxes from CANDS/CARD
  without re-rendering (typing keeps focus). The old TD / props / defense tables are gone; renderPlayers() = render +
  computeTopPlays(), renderDST/renderProps are no-ops. One paste box (props detected by Over/Under; headerless prop
  boards → best-fitting stat, rush+rec must win by 1.5×, or the #propDefault select); prices kept per game in
  `nfltd_boards` (5 days); bet log grouped by game (details.gamegrp, open state in LOGOPEN).
  The user once thought prop categories "reset" — they didn't; only one category was visible at a time.
- The slip optimizer maximises Kelly log-growth over subsets (one leg per game, ≤6 legs, top 10 legs), never EV%.
  Don't count total/spread/weather in confidence — they already drive the probability.

## One site, one pot (2026-10-16, user: "combine all into one sim … make them like the nfl sim … one pot")
- 🧹 STORAGE GUARD (2026-11-05, user: "yes add the cleanup"): one site = ONE ~5 MB localStorage for all three apps, and
  the user's PC Chrome was full (4.4 MB of odds caches: nfltd_boards, nbap_boards, nfltd_slatepx, nhlp_boards), so every
  write that grew a key failed silently. The same guard code sits in all three templates (keep it identical): `lsSave()`
  (every lsW, plus the NFL bets / slip / lsSet) on a failed write first drops the odds any app can tell are stale
  (`staleOdds`), then the oldest third of the rest (any app's), and retries up to 4 times. Own trims: NFL boards 6 h after
  kickoff, off this week's schedule a day after the pull, 5+ days (`trimBoards`; 1.5 s after load and on every save); NFL
  slate prices after 20 min (`trimPx` — only pxFresh reads them); NBA/NHL boards 6 h after the start (pulls store `ko`)
  or a day after a pull without one (`keepBoard`; at load and on every pull). Tested in real Chrome at the 5 MiB cap
  (full store -> stale odds dropped first, an upcoming game's board kept, settings saved). Never add bets / bank /
  settings keys to CACHE_KEYS.
- The NFL, NBA and NHL apps are separate repos on ONE site (popcawn.github.io), so they share one browser storage. Each
  page has a sport switcher (🏈 · 🏀 · 🏒, relative links ../<repo>/) and a 💰 pot chip.
- ONE POT: `nfltd_bank` {amt, at, mt} is the bankroll for all three; bankNow() = amt + the dollar P/L of EVERY sport's bets
  settled after `at` (`allBets()` reads nfltd_bets / nbap_bets / nhlp_bets). Typing a balance in any app writes nfltd_bank
  (with mt). A `storage` listener redraws when another tab changes it. The NBA / NHL apps' own *_bank keys are only a
  fallback for old data.
- ☁ SYNC: the NFL app owns the token + secret gist (`nfltd_sync` {token, gistId}); the NBA / NHL apps reuse them and
  write their OWN file in that gist (nba-sync.json / nhl-sync.json: bets + tombstones + the pot), merged like the NFL
  app's (mt newest wins, tombstones). If no token: "☁ Sync: set up in 🏈 NFL".
- NBA / NHL bet log = the NFL layout: weeks (Mon→Sun) with the money line (spent · won/lost · still riding · season so
  far) -> nights (collapsed; tonight's marked 📍) -> bets.

- ⚡ PULL ALL GAMES (2026-10-19, user: "adopt the NHL sim pull … all games remaining that week"): #weekSec / pullAllGames() — every
  game still to kick off × pickedMarkets, EVERY PRESS FRESH since 2026-11-07 (user: "when i pull odds manually it doesn refresh but when i click pull all fresh, bets will pop up" — it reused a game's BOARDS for freshMs, 1-3 h, while the phone alerts check every 15 min; the 11-05 "↻ pull all fresh" button is gone, don't bring the reuse back; freshMs now only gates the auto-pull when you open a game, and pullOdds puts PULLED back when its prices went nowhere: switched games -> old value, failed -> retry in 5 min). pullAllGames(Set of ids) = only those games ["↻ price" on a bet card, ~1 game × markets], the rest reused as-is, WEEK.at kept), each priced by gameOptions() (the card's
  candidate + pickPlays rule, extracted from computeTopPlays — Your card = gameOptions() then drawn) on a temporary LAST built
  from simGame (its own injuries + forecast: CTX_BADWX / CTX_WIND feed confFor / propConfidence) and fillBoard(L, d, gid) (the
  pull into any game's maps; fillGameFromOdds = fillBoard(LAST…) + screen). WEEK (nfltd_week) = picks across games ->
  renderWeek (status line, grouped by game, NEW tags, log + open links). LAST is always restored in finally.
  Same day: parlay picker prices each combo at ONE book (parlayAt; legs shown at that book's prices) + 📲 Open link;
  bet log: P/L pill per week (no "season so far"), CLV red when negative, a prop line that moved AGAINST the bet red, "≈ price
  at your line" inline; 🏆 best sportsbook (all sports) in the summary + Insights table; top bar = pot · bets · open · $ on this game.

- FULL RUN-THROUGH 2026-11-07 (user: "run through full sim and find bugs"; local copy, mocked odds, 0 credits; 15 graded test
  bets on JAX@BAL all right). Fixed: (1) the slip's ➕ Add leg / Best pick (priceableLegs) and a TD bet logged by hand (addBet)
  used the MODEL ALONE (p[market]); they now take lastAnchors() like gameOptions — any new place that prices a TD bet must too
  (the slip showed Darius Cooper +600 at EV +18% while the card had −10%). (2) floorPrice ("bet at X or better", app + alerts,
  identical) also applies the MIN_STAKE sizing rule with the bet's confidence. (3) money display: fmtUsd's half-dollar steps are
  for SUGGESTED stakes only — balances, won/lost, riding, spent, the unit and every total use exactUsd (cents unless round),
  totals = stakesTxt (sum of each bet's rounded dollars); the card's "✓ in log at $X" compares dollars (loggedDiffers).
  (4) importData stamps st on a result it fills in. (5) paste parser: a lone "E" is a name initial (E.J.), not EVEN.
- SECOND RUN-THROUGH 2026-11-07 (user: "check for bugs again"; mocked odds, 0 credits). Fixed: (1) A PULL REPLACES THE MARKETS
  IT ASKED FOR — fetchGameOdds sets d.asked; fillBoard first drops those markets' tickets (FD#…) and other-book consensus, then
  a player your books priced last pull but not in this one loses his price (bookMap / propMap). Before: Tyler Goodson's rush+rec
  under stayed on the card (and in ⚡ Pull all games) after every book took the line down, and a consensus that vanished (only
  your book left) stayed the anchor. Prices you pasted or typed (no ticket), pasted ladders (alts) and markets not asked for
  stay. RULE: anything new a pull writes into bookMap / propMap must add its key to `got`, or the next pull deletes it.
  (2) "Left off: edge gone after role calibration" is only shown when true — a market-anchored TD bet re-checks with
  blendP(mkt, mpRaw, TD_W) (TD_W 0: calibration can't move it; Ferguson / Prescott / Jones said it wrongly). (3) nearestHourIdx
  (app + alerts) = -1 when no forecast hour is within 3 h of kickoff: the 7-day forecast's LAST hour (up to a day early) stood
  in for games a week out (the alerts look 168 h ahead); setWeather says "no forecast for kickoff yet" / "already kicked off".
  (4) setWeather zeroes the wind box for an outdoor game (the last game's wind carried over while the forecast loaded, and
  stayed when it failed). (5) alerts/watch.mjs repeats: betId = the title minus price and book, so the best price hopping to
  another of your books — even a worse one — no longer buzzes again (FanDuel +140 alerted, then DraftKings +130); cache.sent
  {id: {p, ko}} keeps alerts until kickoff (ntfy forgets after 12 h, so a bet alerted days early buzzed every 12 h). Tested
  old vs new script with a local ntfy stand-in: old = both repeats, new = none, a better price (+160) still alerts.
  Checked OK: snapshot (32 teams, no dup ids / names, no NaN, QB/RB/WR/TE everywhere), ESPN lines (NYG really -3 at PHI),
  workflows (alerts concurrency group, cache keys, refresh rebase), sim tallies.

## Gotchas
- In Git Bash, `node -e "..."` containing JS template-literal backticks gets mangled by command substitution —
  use the Edit tool or put the script in a file. `python` may be a Store stub that hangs.
- Browser storage (bet log, slip, bankroll) is per machine and per address. **☁ Sync** (bet log toolbar) merges it
  across PCs through a secret gist (`nfl-td-sync.json`) using a gist-scope token the user pastes into each browser.
  Records carry `mt`; deletions are tombstones (`nfltd_tomb`); `saveBets()/saveSlip()` stamp changes automatically,
  so any new code that edits bets/slip must go through them. Never put a token in the repo. Export / Import still work.
- ☁ SYNC KEY ACROSS WINDOWS (2026-11-03, user: "same pc two separate windows, one needs key and has it"): every window of the
  site shares `nfltd_sync`, but each held its own copy of SYNC in memory and wrote ALL of it back after every sync. The old key
  expired (last good sync Oct 29); the user pasted a new key in one window, and a window opened earlier kept failing with the
  old key and wrote it back over the new one. Now only Connect / Stop write the key (`putSyncCfg`); routine saves
  (`saveSyncCfg`: last, err, gistId) skip when the stored key isn't this window's; `adoptSyncToken()` takes up the stored key
  before every sync, on focus and on the `storage` event. 401 reads "key rejected (expired or deleted)"; a 403/429 with
  rate-limit headers reads "GitHub is limiting requests" instead of blaming the key. NBA / NHL read the key fresh each sync
  (never write it), so they were fine. Windows still running the old code must be reloaded once.
- ESPN calls in the build retry (curlJsonRetry); a team whose roster still fails is rebuilt from the PREVIOUS
  snapshot's player list, and the build throws (no files written, the bot commits nothing) if any team is still missing.
  A one-off ESPN failure dropped PIT on 2026-10-01 and blanked the app. Test with `FAIL_ROSTER=PIT`. The app also skips
  scheduled games whose team isn't in `S.teamList`.
- FanDuel odds come from The Odds API IN THE BROWSER (CORS is open; x-requests-remaining is exposed): key in localStorage
  `nfltd_oddskey` (the user's UFC-sim key, in ufc-fight-simulator/.odds-key — never commit it or type it into a page).
  /events is free; /events/{id}/odds costs 1 credit per market per game. 2+ TD = player_tds_over at point 1.5. Settings
  `nfltd_oddscfg` (td 4 / props 5 credits, auto-pull, reserve 150), `nfltd_pulled` = last pull per game (20-min guard).
  The free 500/month is shared with the UFC scanner (~370/month) — the reserve protects it. Test with a mocked fetch.
- `simGame()` is the one model entry point (no DOM): run() and the slate picker (`buildSlate`) both call it — a refactor
  test showed identical fair odds for all players before/after. teamExpectations/confFor take an optional wx/badWx so
  off-screen games use their own forecast. The user gets overwhelmed by options: the slate gives ONLY the best N picks +
  one parlay; keep it that short.
- MARKET ANCHOR + REAL-PRICE TEST (2026-10-05). Pulls use `regions=us` (same credits, all books). `consensusFrom()` =
  median of the OTHER books (TD implied prob; props de-vigged P(over)); FanDuel's price is what's judged.
  `market-backtest.mjs` (paid key in .odds-key, gitignored; 5,569 credits for 2025 close+6h) scored 6,002 active priced
  anytime player-games: calibrated consensus beat the model on BOTH halves (Brier .1393/.1254 vs .1440/.1299); best model
  share w = 0 / 0.1; model far too flat vs books (books 65% -> actual 59%, model 47%). ROI (EV>3%, flat): every FD price
  -8.7%; model +3.4% [-21,+30] while claiming +45% EV; consensus -2%; blends + only via a few +4000 hits in wks 1-9.
  PROPS (rec yds + rush yds, close, 272 games, 5,440 credits; DUMP_BT also writes bt_props_<season>.json = mu + cross-fit
  tables per row): model Brier .2657/.2567 rec, .2737/.2757 rush vs books ~.250 — WORSE than a coin flip at the books'
  line; best model share 0.1 (both halves). Every FD over -12.3% rec / -8.3% rush (CIs exclude 0); unders ~break-even;
  model picks ~0. Calibrating the books' over-lean helped rec, hurt rush -> not applied. Nearby-line fallback (other
  books' nearest line within max(2.5,12%), moved by the model's distribution) beat the model both halves -> `propCons()`.
  => App: TD_W = S.marketAnchor.w (0) for ALL TD markets (anytime adds cal; 1st/last/2+ use the model-level rescale,
  untested); PROP_W = S.marketAnchor.props.w (0.1) for all props (rec/rryd/pyd by analogy). No consensus = "model only"
  on the card ONLY when FanDuel has no two-way price either (2026-10-09: a lone FanDuel price is now the anchor — props
  = FD's own over/under de-vigged + 10% model; TD = FD's implied through the anytime cal / model-level rescale; checked on
  ALL 2025 FD main lines: FD-own+10% beat the model alone both halves for rec+rush yds (model alone flagged ~3,200 "edges"
  at -0.7/-0.8%); FD-own TD Brier = other books'. Candidates carry `mktSrc` 'books'|'fd'; labels say "FD" vs "mkt").
  PULL vs OPEN BETS (rewritten 2026-10-12, user: "props that go down are considered off FanDuel instead of prop lowered
  for CLV"): `closeView(b,d)` = FanDuel's price for a logged bet AT ITS OWN LINE (exact, or the nearest line translated with
  the model's distribution; null = not offered). Still offered -> `b.cur={q,l,o,t}` (live CLV in the log: "▼64.5 ≈+10.8%");
  only a prop FanDuel dropped entirely -> `b.offBoard` (card drops it, log shows ⚠). A MOVED LINE IS
  NEVER off-board. applyClose() = closeView + write closeOdds/closeEst. Don't raise either share without a new real-price test that wins both halves. Refit: `DUMP_BT=1` build
  (restore shipped files with git checkout) -> `--go` / `--props --go` -> `analyze` / `analyze-props` -> build.
  Raw prices (market_hist/, market_td_*.json, market_props_*.json) and bt_*.json stay local.
  GOTCHA: `node market-backtest.mjs analyze` REWRITES market_anchor.json and drops its props section (props.w) — after
  using it just to read numbers, `git checkout -- market_anchor.json` (happened 2026-10-15, caught before commit).
- CONSENSUS FIX (2026-11-05, user: "if you are only pricing two books for odds isnt that bad" -> "yes run the test and switch it"):
  consensusFrom() judged your books only against books that AREN'T yours; with all five of yours on (since 10-24) that left
  BetRivers / BetOnline / Bovada, and two odd ones faked a +65% edge (Brandin Cooks LV@SF: +200/+215 there, FD/DK/CZR/FAN
  +450..+525). Now TD = median implied of EVERY book except your best-priced one (the price judged); alerts/watch.mjs
  matches. Test (scratch cons-test.mjs on market_td_2025 + bt_rows_2025, 8 books, 5,964 active player-games, calibration
  cross-fit by half): Brier better BOTH halves at the close (.13908/.12536 vs .13921/.12540) and 6 h out (.13980/.12725 vs
  .13988/.12739); flat EV>3% ROI close +5.3% (969 bets) vs +1.3% (1,027), 6 h out +23.7% vs +6.6% (ROI CIs ~±30%: noise);
  bets only the old rule took -26.8% (256, close). PROPS tested the same day (scratch props-test.mjs, market_props_2025 +
  bt_props_2025, FanDuel's main line; only ~3 books post that exact line): every-book-but-the-two-you'd-bet vs books-not-yours
  — receiving yards better both halves (.24980/.25064 vs .25000/.25071), rushing yards WORSE both halves on shared lines
  (.24998/.24949 vs .24975/.24902); pooled shared lines half 2 a tie (.25000 vs .24999) -> props NOT switched (still books
  that aren't yours).
- 🎉 FUN PICKS — SECTION REMOVED 2026-11-01 (user: "remove fun picks section. but keep td section to find best td prices"): the
  box under 🎯 My TD picks (list, games/theme filters, ⚡ check/refresh, log + open buttons, fun parlay) is gone from renderSlate;
  the TD picks + parlay of the day are unchanged. buildSlate still fills SLATE.funPool / SLATE.fun (pickFun, priceFunGames,
  refun are now unused) and old 🎉 bets keep their tag and running total in the log. Don't bring it back unless asked.
  History, as built: `buildSlate` also collects every FanDuel anytime price in
  FUN_BAND [+100,+400) (not OUT/DBT, not already a real pick), sorted by the sim's EV only as a tiebreak, 1 per game (2nd
  pass: other team), flat FUN_STAKE 0.5u; fun parlay = the 2 likeliest (mp) from different games, 0.2u. Evidence (2025
  market_td + bt_rows, active players): +100..+400 -1%/-9% by half, +400..+1500 -18..-24% both halves, <+100 ~-11%;
  "best price vs other books" and model-EV ordering inside the band did NOT reliably help (model-EV thirds -10/+2/+2%,
  then -7/-8/-8%). Logged fun bets carry `fun:true`: pendingFor() skips them (card + plan + Trim), the log shows 🎉 and a
  separate running total. Keep the honesty copy ("not an edge").
  2026-10-08: the user bet the same player 2-3 times (rebuilds re-suggest players; parlays reuse the picks). `betOnSet()` =
  players with an open bet (log, parlay legs incl.) or in the slip: fun picks skip them; slate rows show "✓ already bet"
  instead of a stake; both parlays say they reuse the same players. renderSlate now runs after loadBets/loadSlip and on
  every saveBets/saveSlip (guarded: SLATE is declared later in the script).
  FIX of that fix (same day, user asked "smarter or dumber?"): skipping logged players made every rebuild REFILL fun picks
  with 5 new names = unlimited -EV betting. Now fun bets already logged for the slate's games keep their slots (✓) and
  count toward N; only empty slots fill; a logged fun parlay stays the fun parlay (parlayLogged hides the log buttons).
  betOnSet() is a Map log|slip: slip shows "✓ in your slip" (a plan, not a bet).
  FUN FILTERS (2026-10-15, user: "single game picks, 1pm slate only, 4pm games only, 1pm+4pm slate, themed picks"): the
  per-game pricing is `slateGame(g, injMap)` (shared by buildSlate and priceFunGames). SLATE.funPool = every in-band
  option seen, SLATE.funGames = gid -> priced-at; `pickFun(pool, n, realKeys)` applies FUNF (nfltd_funf: win
  all|1pm|4pm|early|night|game, game, theme) and stores the filter in SLATE.fun.F; `refun()` re-picks on a select change
  (no credits). Windows by Eastern time (`etSlot`): Sun 12-15h = 1pm, Sun 15-19h = 4pm, >=19h any day = night, else
  (London, Saturday) only under all/one game. Themes: pos RB/WR/TE/QB from S.rosters, dog/fav from SCHED fav+spread,
  home/road (not neutral sites), shootout = week's top-third totals, div = hard-coded NFL_DIV. Unpriced games in a window
  -> "⚡ Check N more games" (priceFunGames; 'all' never offers it); >45-min-old prices -> "↻ Refresh". One game =
  alternate teams, no fun parlay (books price SGPs themselves). Pool entries for games a build didn't re-price carry
  over until kickoff. Logged fun bets keep their slots only if they fit the filter and kicked off < 4 h ago.
- FANDUEL BET-SLIP LINKS (2026-10-07): pulls add `includeLinks=true&includeSids=true` (no extra credits — checked: 2 markets
  = 2 credits). Each FD outcome has link `https://sportsbook.fanduel.com/addToBetslip?marketId=42.x&selectionId=y` + sid;
  `fdSelOf()` keeps {m,s}; filed in LAST.mktMap as `FD#<market>#<key>` (saved with the board; props market =
  propMktKey). Slip legs snapshot `fd` in addLeg; slate picks/fun picks carry fd. `fdButton(legs,label)` builds ONE link —
  several legs use indexed pairs marketId[i]/selectionId[i] (the common tool format; NOT documented by The Odds API, and
  the built-in browser blocks sportsbook sites, so it was never opened here — if the user reports only one leg landing,
  fall back to the per-leg FD↗ links). Legs without ids (pasted, or pulled BEFORE links existed — the user hit this
  on day one: "i dont see it") get real buttons, not grey text: slip = `linkSlipLegs()` "🔗 Get FanDuel links for N legs ·
  ~C credits" (pulls only the needed markets per game, matches by name / side+line / DST team); card = `.fdpull` (delegated
  click -> pullOdds); slate = "Build my TD picks again".
- 🤖 AUTO-SETTLE + CLOSES (2026-10-08): `autoSettle()` (5 s after load, then every 5 min, ESPN at most every 10 min; manual
  "Settle now"). ESPN REFUSES scoreboard date RANGES (400) — `espnEventsFor` queries ?seasontype&week for the active week
  and back to the oldest open bet (max 4). Per final event: summary box score (td = rush+rec+KR+PR TD + max(INT,def) TD;
  rec/recyd/ryd/pyd), scoringPlays touchdowns in order (scorer = text before "N Yd"; def = interception|fumble return;
  blocked -> by hand), core API competitor roster `didNotPlay` -> push (FanDuel void). Bet key TEAM|espnId matches ESPN
  athlete ids directly. Only result==="pending" is touched; a manual change deletes b.auto. Slate parlays now store
  `legs`. Closes: `autoLiveCloses` (<15 min to kickoff, live, 1/market) and `autoHistCloses` (after kickoff, historical
  events 1 + event odds 10/market, bookmakers=fanduel, snapshot kickoff-5min; free plan -> nfltd_histoff pause 3 days);
  each game once (nfltd_closed). Tested on IND@WAS 2026-10-04: 13/13 bets settled right; history close matched FD.
  NOT ON THE ROSTER (2026-11-03, user: "for the settle by hands, I assume they are push" — RJ Harvey anytime, on IR, sat as
  ✋): a player in neither the box score nor either game-day roster settles on the same name in his team's box score (an id
  mix-up), else PUSH "<ESPN injury status> — did not play, void" — only when BOTH rosters loaded (`R.rostersAll`); a
  failed roster leaves it by hand. A parlay with a void leg still goes by hand (the book reprices it). ✋ / 🤖 / ⏱ reasons
  open on a TAP (.whytap -> .whytxt under the result; phones have no hover). Tested in Node on KC@DEN 401873033 (scratch
  test pulls legResult / espnResult out of the template): IR -> push, wrong id + right name graded, one roster missing ->
  by hand, normal win / loss unchanged.
  `parseOdds()` and `applyClose()` are shared by live pulls, manual Pull closing prices and history.
- BET LOG LAYOUT (2026-10-12, user: "a lot going on, simplify it" + "condense by week"): renderBets() = .logsum summary +
  details.weekgrp (Tue->Mon local weeks by b.ko||b.ts; newest/any-open week open; label "Week N" from b.wk) -> details.gamegrp
  (LOGOPEN keys: 'W'+weekStart, game+'#'+weekStart; trim button keeps data-g=game) -> 7-column rows with inline tags
  (🎉, ⚠ off FanDuel; the ⏱ lead tag was removed 2026-10-24 — user: "remove the timing tag and run that data in the background": every bet still stores ts + ko, the ⏱ When you bet table stays in ⚙ More → Insights, and Claude can read it on request). Everything else is static HTML under details#logMore (#betInsights is filled by
  renderBets: scoreboard + "When you bet" table by lead time, TIMING_KIND prop|td|all). Bets carry `ko` (kickoff) and `wk`:
  koStamp(game) at log time (SCHED + CUR_WK), back-filled by autoSettle from ESPN events for older bets (koX = not found).
  Parlay picker = details#parlaySec, collapsed by default; computeParlays() returns early while closed and runs on open;
  open state in nfltd_parlayopen; #jumpNav links open a <details> target.
- NO "CUT" ON LOGGED BETS (2026-10-15, user: "the cut in logged picks"): a logged bet is already placed, so the log no
  longer tags bets "cut", shows "N to cut" or a Trim banner, and Your card no longer shows "didn't make the cut / ✂ Trim"
  (trimLog is gone). The ★ + suggested stake on open bets (planFor/PLANS, which re-ran pickPlays — 2/team, best 3/game, 4% team cap — over every open bet at today's bankroll) and its green rowtake highlight were REMOVED 2026-10-24 (user: "the stake and suggested is off" — ★ $4.50 next to a $5.50 stake): a placed bet's stake can't change, so the log shows only what was bet. Don't bring back a recomputed stake for logged bets.
  WEEK TALLY: every week summary has a .wktally line — Spent (every stake, open included) · Won/lost (settled net) · still
  riding · season so far (cumulative spent + net up to that week); the top summary says Spent and Won/lost too.
- 📲 EDGE ALERTS — LIVE since 2026-11-05 (user: "lets set up the phone alerts" -> "i want to catch all nfl bets"): every game on
  the board (ALERT_HOURS 168, ALERT_MAX 20, all 5 books) every 30 min via an outside timer (cron-job.org -> workflow_dispatch
  API, fine-grained token with Actions read+write on this repo); GitHub's own cron is a 2-hour backup (this account's timers
  run hours late). ~20K credits/month. Phone: ntfy; FanDuel + DraftKings links open the apps, BetMGM / Caesars the website.
  BANKROLL (same day, user: "make the alerts follow my bankroll" + "give dollar amounts not units"): syncState() reads all three
  sports' sync files (one pot: bank = BANK.amt + every sport's settled P/L since BANK.at; riding = every sport's open bets) and
  applies the app's fitRoom to the run's new alerts (biggest $ first, the rest wait; off when BANK.lim === false); stakes in
  dollars only (units only without SYNC_TOKEN). Test: ALERT_SYNC_MOCK (local stand-in for the gist files) + ALERT_MOCK, dry.
- 📲 ALERTS + PROPS (2026-11-06, user: "ntfy is only sending td picks"): watch.mjs now prices the five props the app pulls
  (player_receptions / reception_yds / rush_yds / rush_reception_yds / pass_yds) with COPIES of propPOver / propMedian / propMu /
  propSides / propCons / propConfidence / propTier and the props half of parseOdds + consensusFrom + fillBoard, and runs
  gameCard() = the app's gameOptions() (prop dups at two lines, heldSameStat, open bets from the sync gist as options with
  their stored rk, pickPlays). TD part unchanged except: cleanName before matchPlayer, baked status fallback, bad-weather
  confidence, the anchorTD 4-row minimum. ESPN scoreboard (this week + next) gives lines; Open-Meteo the forecast (gameWeather).
  VERIFIED 2026-11-06 against the app itself: a throwaway copy of nfl-td-predictor.html with a helper injected before the main
  IIFE's closing `})();` (window.__T(body, gid, {bets, W}) = pullAllGames' per-game code: simGame + parseOdds + fillBoard +
  gameOptions) on DAL@IND, GB@NE, NYG@PHI real pulls (+ 8 test bets, forced 20 mph wind): every shared candidate's odds / mp /
  ev / conf / tier / kelly / dup identical, same picks; only difference = defense TDs (sim-only, not alerted, nor 1st/last/2+).
  The one mismatch found and fixed: propCons breaks an exact distance tie by insertion order, and consensusFrom inserts a line
  key when ANY book (yours too) posts it — watch.mjs now gives every book's line a slot (yours without a vote). Re-run that
  comparison after changing any of the copied functions (ALERT_DUMP writes the alert side's candidates).
  CADENCE + CACHE: TD every run; props per game by hours to kickoff (PROP_EVERY: <=6 h every run, <=24 h 55 min, <=72 h
  175 min, else 355 min). alerts.yml restores/saves `alerts-cache/` (actions/cache, key per run, restore-keys prefix): each
  game's last prop candidates (slim), when pulled, forecasts (2 h), lastRun, sent (alert ids until kickoff — see SECOND
  RUN-THROUGH). Between prop checks the cached props hold card
  slots but are NEVER alerted (stale: true); dry runs never write the cache; ALERT_MAX cut-offs reset that game's t -> props
  re-pulled next run. The 2-hour GitHub `schedule` backup exits when lastRun < 25 min (ALERT_TRIGGER). Props pause below
  ALERT_PROP_RESERVE (10,000). Alert ids: click link, else the title minus its price (old 'k:' tags still read).
  QUIET HOURS (same day, user: "stops running at 10pm est, then starts back up at 6am est"): ALERT_QUIET '22-6' (Eastern,
  Intl America/New_York, DST-safe) -> live runs exit before any pull; dry / test ignore it. The cache is saved only when a live
  run wrote it (saveCache appends saved=true to GITHUB_OUTPUT; the save step is `if: steps.check.outputs.saved == 'true'`).
  Credit simulation (scratch cadence-sim.mjs: typical week, TD posted 6 days out, props 4; same PROP_EVERY): per day 24 h /
  quiet = 15 min 2,030 / 1,440 · 30 min 1,230 / 870 · 60 min 830 / 570. The user asked about 15 min + quiet hours (~43K a
  month): the interval lives in their cron-job.org job — the script needs no change for 15 min (PROP_EVERY thresholds 55 /
  175 / 355 still mean hourly / 3 h / 6 h; the backup timer's 25-min rule still stands it down).
  Tests (no credits, nothing to the real channel): ALERT_MOCK (filters markets like the API, 1 credit per market returned),
  ALERT_SYNC_MOCK, ALERT_NOW, ALERT_NTFY=http://localhost:<port> (a tiny POST/`/json` stand-in), ALERT_DEBUG / ALERT_DUMP.
- 📲 EDGE ALERTS (2026-10-15, user asked for phone notifications, then "yes" to building it with the timer off):
  `alerts/watch.mjs` (Node 20, no deps) run by `.github/workflows/alerts.yml` — workflow_dispatch modes test|dry|live, the
  `schedule:` (*/5) is COMMENTED OUT until the user says to switch it on (credits: ~5K/month at 6 h window). It mirrors
  the slate's TD rule WITHOUT the sim (TD_W = 0): median implied of every book except the one you'd bet (app's
  consensusFrom since 2026-11-05) -> S.marketAnchor.cal -> evalBet/tierOf 'take' -> legConfidence (no weather) -> pickPlays (3/game, 2/team,
  ¼ Kelly). Keep it in step when those change. Secrets the USER adds: ODDS_API_KEY, NTFY_TOPIC (private ntfy.sh
  channel), optional SYNC_TOKEN (reads the ☁ Sync gist: bankroll -> $ stakes, open bets -> skipped). Dedupe = polls the
  ntfy channel's last 12 h (click link + "TD +price" in the title); re-alerts only on a better price. Stops below
  ALERT_RESERVE (1000) credits. Test without credits: ALERT_MOCK=<{events, odds}> ALERT_MODE=dry (scratch mock maker
  pattern: fake 6 books, FD/DK generous on a few players). It never places bets — the user was told books ban bots.
- PHONE LAYOUT (2026-10-16, user: "too much scrolling and information on phone screen"): at <=760px a fixed bottom tab bar
  (#mtabbar: Bets · Game · Log · More — data-t picks · game · bets · more) shows one tab at a time; since 2026-10-19 the
  tabs work at EVERY width (desktop: #dtabs in the top bar — see "Look"). tagMobile() (JS, at startup) sets data-m on each
  section (h2 + its next sibling via pair()); CSS hides [data-m] not matching body[data-mtab]. Picks = Pull all games +
  My TD picks; Game = game picker + Price + Your card + Markets + Parlay picker; Bets = Bankroll + Slip + Bet log; More =
  model accuracy, team profiles, notes, footer. NEW SECTIONS NEED A data-m TAG or they show on every phone tab. goTo(id)
  switches to the target's tab before scrolling (use it instead of scrollIntoView for cross-section jumps). Phones also:
  jump bar hidden, team/line/weather inputs behind ✏️ (#ctlToggle, body.ctlopen), Markets one team at a time (MTEAM,
  .mteamsw, .mgrid.one-away|one-home). Tab kept in nfltd_mtab (default picks).
  Same day: bet-log GAMES start collapsed; the paste box is a collapsed details#pasteBox (⚡ Pull is the main path, paste
  = free fallback); closing lines split — AUTO.close (live, <15 min to kickoff, 1 credit/bet type) stays on, AUTO.hist
  (after kickoff from history, 10 credits/bet type) is OPT-IN (#autoHistChk), to save credits.
- 💰 BANKROLL $ (2026-10-13): BANK={amt,at,mt} (nfltd_bank, synced + exported). bankNow() = amt + dollar P/L of bets with
  b.st (settled-at, stamped by autoSettle and the result select) > BANK.at; unitUsd() = bankNow()/getBankroll() (the old
  units box is a hidden field = 100, so 1u = 1%). stakeTxt(u) / betStakeTxt(b) render every stake ($ when a bankroll is
  set, else units); bets store `usd` at log time (usdStamp). Typing a new balance = setBank() resets the base. The log
  (stake, P/L, totals, ROI) switches to dollars via usdOn/mny.
- ALL FIVE BOOKS BY DEFAULT (2026-10-24, user: "is it intentional to have betmgm turned off for nba" — no): the book list is saved per device and a new device started with FanDuel + DraftKings only (the user's desktop had all five; the phone likely not). Default is now FD, DK, BetMGM, Caesars, Fanatics; a device that saved fewer gets the rest added ONCE (`nfltd_oddscfg.booksV2`, kept by the settings save); unticking after that sticks. Don't drop books from the default: the real-price test found the NBA edge in shopping all five.
- BANKROLL LIMIT (2026-10-26, user said yes to the plan — "whatever profits the most money"): the $ on open bets across NFL/NBA/NHL (one pot, allBets()) never goes above bankNow(). fitRoom(list, usdOf) takes new bets biggest $ first; the rest wait (card note 💰 "$X of your $Y bankroll in play · N more bets wait for room", Priced verdict 💰 no room; NFL: week list + TD picks, fun picks and parlays exempt). Held/logged bets already count as riding. A season simulation said a HALF-bankroll limit cost growth for almost no safety — keep it at the full bankroll. Logging by hand from Priced / the game card isn't limited. ON/OFF SWITCH (2026-11-01, user: "create a on/off toggle for bankroll limit"): ☑ 💰 Bankroll limit (#limitChk) under the bankroll box, default ON. Off = BANK.lim===false — it lives IN the pot (nfltd_bank), so it is one switch for NFL/NBA/NHL, rides in ☁ Sync with the pot, and typing a new balance keeps it (setBank / the bankUsd handler copy lim). fitRoom() lets every bet through when off (no 💰 notes, no "no room"). renderLimit() runs from renderBank().
- MULTI-BOOK (2026-10-13, "search DraftKings + FanDuel for best odds"): myBooks() = ODDSCFG.books (FanDuel always first,
  default + DraftKings). parseOdds() -> best price among YOUR books per TD selection / per prop side at the primary
  (FanDuel's) line, each with a TICKET {b, o, m?, s?, alt:{book:ticket}} filed as FD#<market>#<key> (name kept for
  compatibility); a book with a different prop line -> d.propsX -> pm.books[] -> its own candidates (side(...,x)). tkFor()
  only trusts a ticket while the box still holds that price. consensusFrom() TD = every book except your best-priced one
  (2026-11-05; it used to exclude ALL your books, which left ~3 once all five were on — see CONSENSUS FIX).
  Candidates/bets/slip legs carry `book`; d.byBook[book] is that book's own board -> closeView()/applyClose use the
  bet's book (history pulls bookmakers=myBooks). Links: bookLink() — FanDuel addToBetslip, DraftKings ?outcomes=sid+sid
  (API gives the single-leg form; the '+' join is the common format, unverified like FanDuel's multi-leg); other books'
  links need {state} -> not linked. fdButton() makes one button per book; parlayAt()/parlayButton() price a parlay at the
  ONE book that has every leg and pays most ("at DraftKings it pays +1475"). 2025 check: better of FD/DK on anytime =
  +3.3% payout, every-bet ROI -8.7% -> -5.5% (both halves), fun band -5.5% -> -3.9%.
  BETMGM + CAESARS LINKS (2026-10-16, real pull with includeLinks): MGM outcome link =
  https://sports.{state}.betmgm.com/en/sports?options=<event sid>-<market id>-<option sid>&type=Single (tkOf keeps the options
  token as t.g — older MGM tickets lack it, one re-pull fixes); Caesars = https://sportsbook.caesars.com/us/{state}/bet/betslip?
  selectionIds=<sid>. {state} = ODDSCFG.state (#oddsState, lowercase). needsState(t) -> "📍 Pick your state" button instead of
  a re-pull. Multi-leg: comma-joined (MGM type=Combo for parlays) — UNVERIFIED like FD/DK. Fanatics returns no links -> "place it in the
  Fanatics app". BETRIVERS: built a guessed link, then REMOVED the same day (user: "not available
  in my state") — BOOK_CHOICES (the selectable books) leaves it out, so a saved config listing it is ignored; BetRivers still
  counts in the other-books consensus.
  FANATICS: the API gives NO links (only sids) and no format is documented anywhere (searched 2026-10-16) -> BOOK_HOME
  fallback (the API guide's own last resort): "🔎 Fanatics: find <player>" opens sportsbook.fanatics.com; parlays "Build it on
  Fanatics". us2-region books (theScore/ESPN BET, Hard Rock, Fliff, Bally, betPARX) are NOT pulled: regions=us,us2 doubles credits.
  CREDITS: per-market switches (ODDSCFG.mk, mkOn/pickedMarkets) and freshMs() (20 min <3h to kickoff, 1h <24h, else 3h).
  On 2026-10-13 the 20K plan had 2,180 left: ~11K went to the two one-off backtests, the app itself burned ~850/day
  (9 credits per game opened + history closes at 10/market) — tell the user before adding anything that pulls more.
- ★ PRICED TABLE FIT (2026-10-14, user screenshot: rows spilled under the sidebar after book tags + $ stakes were added):
  #boardTable is sized by CONTAINER queries on .bmain (the sidebar takes 360px; .bmain tops out ~1110px), never by the
  window: 7px cell padding, .betcol may wrap, Fair (.hidecol) hidden <=1180 (so in practice always — it is on hover of
  Chance), .pos/logos <=900, .confcol <=760 where #boardScroll also scrolls sideways. "Model" header -> "Chance" (it is the
  market-anchored number). "✓ logged" moved onto the log button. Measure table vs #boardScroll width after adding anything
  to a row. SAME BET AT TWO BOOKS: a prop side at two lines is one bet — computeTopPlays marks the worse offer c.dup
  (plain {book,market,odds,held}; winner = logged one, else higher EV) and the winner c.also; dups are off the card, hidden
  from the Priced list (kept row shows "+1 line", details on hover) and explained under Left off.
- Commits end with the Co-Authored-By line from the session's instructions.
