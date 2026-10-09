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
  OFF-BOARD: every pull checks this game's open logged bets — prop gone or line moved / TD player missing -> `b.offBoard`;
  the card drops them into Left off (it used to keep their logged rank and say "bet"), planFor ignores them, the log row
  shows ⚠ off FanDuel. A later pull that finds them again clears it. Don't raise either share without a new real-price test that wins both halves. Refit: `DUMP_BT=1` build
  (restore shipped files with git checkout) -> `--go` / `--props --go` -> `analyze` / `analyze-props` -> build.
  Raw prices (market_hist/, market_td_*.json, market_props_*.json) and bt_*.json stay local.
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
- Commits end with the Co-Authored-By line from the session's instructions.
