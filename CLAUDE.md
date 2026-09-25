# NFL Anytime-TD Simulator — working notes

Single-file HTML app (`nfl-td-predictor.html`) + a Node build (`build-nfl-td-snapshot.mjs`) that bakes nflverse
play-by-play and ESPN data into it. Live copy: https://popcawn.github.io/nfl-td-predictor/ (GitHub Pages, `main`).
See README.md for what the model does and how it was validated.

## Where things happen
- **Edit** `nfl-td-predictor.template.html` (UI + live model) and `build-nfl-td-snapshot.mjs` (data + backtest).
  Never hand-edit `nfl-td-predictor.html` / `nfl-td-snapshot.json` — the build regenerates both.
- **Data refresh** runs on GitHub Actions (`.github/workflows/refresh.yml`, Tue + Fri) and commits the rebuilt
  files. So **`git pull` before starting work** on any machine, or pushes will conflict on those two files.
- Lines, injuries and weather refresh live inside the app from ESPN / Open-Meteo on every visit.

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
- Defense props = **defensive TDs only** (books don't count special teams); kick/punt return TDs are credited to
  returners. Role calibration (rotational ×~0.87, QB ×~0.85) is cross-fitted — don't extend it without re-testing.

## The user
- Bets FanDuel props, pastes boards in FanDuel's stacked format, builds cross-game parlays.
- Wants a clear answer to "what do I bet": the **Your card** panel (Kelly-ranked, ¼-Kelly, team caps) is the
  primary surface — keep new decision features there. Be honest that the model tracks the market; CLV in the bet
  log is how edge gets proven.

## Gotchas
- In Git Bash, `node -e "..."` containing JS template-literal backticks gets mangled by command substitution —
  use the Edit tool or put the script in a file. `python` may be a Store stub that hangs.
- Browser storage (bet log, slip, bankroll) is per machine and per address; use Export / Import to move it.
- Commits end with the Co-Authored-By line from the session's instructions.
