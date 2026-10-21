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
  game still to kick off × pickedMarkets (a game pulled within freshMs reuses BOARDS), each priced by gameOptions() (the card's
  candidate + pickPlays rule, extracted from computeTopPlays — Your card = gameOptions() then drawn) on a temporary LAST built
  from simGame (its own injuries + forecast: CTX_BADWX / CTX_WIND feed confFor / propConfidence) and fillBoard(L, d, gid) (the
  pull into any game's maps; fillGameFromOdds = fillBoard(LAST…) + screen). WEEK (nfltd_week) = picks across games ->
  renderWeek (status line, grouped by game, NEW tags, log + open links). LAST is always restored in finally.
  Same day: parlay picker prices each combo at ONE book (parlayAt; legs shown at that book's prices) + 📲 Open link;
  bet log: P/L pill per week (no "season so far"), CLV red when negative, a prop line that moved AGAINST the bet red, "≈ price
  at your line" inline; 🏆 best sportsbook (all sports) in the summary + Insights table; top bar = pot · bets · open · $ on this game.

## Gotchas
- In Git Bash, `node -e "..."` containing JS template-literal backticks gets mangled by command substitution —
  use the Edit tool or put the script in a file. `python` may be a Store stub that hangs.
- Browser storage (bet log, slip, bankroll) is per machine and per address. **☁ Sync** (bet log toolbar) merges it
  across PCs through a secret gist (`nfl-td-sync.json`) using a gist-scope token the user pastes into each browser.
  Records carry `mt`; deletions are tombstones (`nfltd_tomb`); `saveBets()/saveSlip()` stamp changes automatically,
  so any new code that edits bets/slip must go through them. Never put a token in the repo. Export / Import still work.
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
  only a prop FanDuel dropped entirely -> `b.offBoard` (card drops it, planFor ignores it, log shows ⚠). A MOVED LINE IS
  NEVER off-board. applyClose() = closeView + write closeOdds/closeEst. Don't raise either share without a new real-price test that wins both halves. Refit: `DUMP_BT=1` build
  (restore shipped files with git checkout) -> `--go` / `--props --go` -> `analyze` / `analyze-props` -> build.
  Raw prices (market_hist/, market_td_*.json, market_props_*.json) and bt_*.json stay local.
  GOTCHA: `node market-backtest.mjs analyze` REWRITES market_anchor.json and drops its props section (props.w) — after
  using it just to read numbers, `git checkout -- market_anchor.json` (happened 2026-10-15, caught before commit).
- 🎉 FUN PICKS (2026-10-05, user wants TD action despite no edge): `buildSlate` also collects every FanDuel anytime price in
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
  `parseOdds()` and `applyClose()` are shared by live pulls, manual Pull closing prices and history.
- BET LOG LAYOUT (2026-10-12, user: "a lot going on, simplify it" + "condense by week"): renderBets() = .logsum summary +
  details.weekgrp (Tue->Mon local weeks by b.ko||b.ts; newest/any-open week open; label "Week N" from b.wk) -> details.gamegrp
  (LOGOPEN keys: 'W'+weekStart, game+'#'+weekStart; trim button keeps data-g=game) -> 7-column rows with inline tags
  (🎉, ★ stake / cut, ⚠ off FanDuel, ⏱ lead). Everything else is static HTML under details#logMore (#betInsights is filled by
  renderBets: scoreboard + "When you bet" table by lead time, TIMING_KIND prop|td|all). Bets carry `ko` (kickoff) and `wk`:
  koStamp(game) at log time (SCHED + CUR_WK), back-filled by autoSettle from ESPN events for older bets (koX = not found).
  Parlay picker = details#parlaySec, collapsed by default; computeParlays() returns early while closed and runs on open;
  open state in nfltd_parlayopen; #jumpNav links open a <details> target.
- NO "CUT" ON LOGGED BETS (2026-10-15, user: "the cut in logged picks"): a logged bet is already placed, so the log no
  longer tags bets "cut", shows "N to cut" or a Trim banner, and Your card no longer shows "didn't make the cut / ✂ Trim"
  (trimLog is gone). The log still marks the bets the card rule would pick with ★ + suggested stake (planFor/PLANS).
  WEEK TALLY: every week summary has a .wktally line — Spent (every stake, open included) · Won/lost (settled net) · still
  riding · season so far (cumulative spent + net up to that week); the top summary says Spent and Won/lost too.
- 📲 EDGE ALERTS (2026-10-15, user asked for phone notifications, then "yes" to building it with the timer off):
  `alerts/watch.mjs` (Node 20, no deps) run by `.github/workflows/alerts.yml` — workflow_dispatch modes test|dry|live, the
  `schedule:` (*/5) is COMMENTED OUT until the user says to switch it on (credits: ~5K/month at 6 h window). It mirrors
  the slate's TD rule WITHOUT the sim (TD_W = 0): other books' median implied (app's consensusFrom incl. the <2-books
  fallback) -> S.marketAnchor.cal -> evalBet/tierOf 'take' -> legConfidence (no weather) -> pickPlays (3/game, 2/team,
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
- MULTI-BOOK (2026-10-13, "search DraftKings + FanDuel for best odds"): myBooks() = ODDSCFG.books (FanDuel always first,
  default + DraftKings). parseOdds() -> best price among YOUR books per TD selection / per prop side at the primary
  (FanDuel's) line, each with a TICKET {b, o, m?, s?, alt:{book:ticket}} filed as FD#<market>#<key> (name kept for
  compatibility); a book with a different prop line -> d.propsX -> pm.books[] -> its own candidates (side(...,x)). tkFor()
  only trusts a ticket while the box still holds that price. consensusFrom() excludes YOUR books (6 others typically).
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
