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
- MARKET ANCHOR (2026-10-05, user picked it after the model kept "finding" edges on backups): pulls use `regions=us`
  (same credits, all books). `consensusFrom()` = median of the OTHER books (TD implied prob; props de-vigged P(over)),
  FanDuel's price is what's judged. `anchorTD()`: fair = consensus × Σmodel/Σconsensus over players both price (needs ≥4),
  then `blendP` = expit((1−w)·logit(fair) + w·logit(model)), interim w=0.35 (NOT fitted). Candidates carry
  `mp` (blended), `model`, `mkt`; LAST.mktMap is saved in BOARDS. DST isn't anchored. `S.marketAnchor` (from
  market_anchor.json via the build) overrides w and adds cal {a,b}: fair = expit(a + b·logit(consensus ip)).
  `market-backtest.mjs` needs a PAID Odds API plan (historical endpoints; ~5,460 credits for 2025 close+early) — the user
  must buy it; ask before spending. Flow: `DUMP_BT=1` build (writes bt_rows_<season>.json; restore the shipped files
  with git checkout) → `--go` → `analyze` → rebuild. Raw prices (market_hist/, market_td_*.json) stay gitignored.
- Commits end with the Co-Authored-By line from the session's instructions.
