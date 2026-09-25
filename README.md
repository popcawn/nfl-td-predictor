# 🏈 NFL Anytime-TD Simulator

A standalone, single-file web app that predicts **anytime-touchdown scorers** for any NFL matchup.
Pick a game and it runs a 10,000-game Monte Carlo simulation to produce each player's **anytime-TD %**,
**1st-TD / Last-TD / 2+-TD** probabilities and **fair American odds**, plus an **EV calculator** with a
TAKE / PASS verdict, a same-game **parlay picker**, a **cross-game parlay slip** and a **bet log with CLV**.

`nfl-td-predictor.html` is fully self-contained (data + logos embedded as base64) and runs **offline** —
just double-click it. Live extras (today's line, injuries, forecast) load when online and fall back
silently to the baked snapshot when not.

## Using it
- **This week's games** — one dropdown sets both teams, the line and the stadium. The app opens on the next
  game to kick off. If you pick two teams by hand the wrong way round, it warns you and offers a one-click flip
  (home/away changes the stadium, weather and the implied-points split).
- **Live every visit** — the current **total, spread, favorite** and **injury status** are pulled from ESPN each
  time you open the app or switch games (the snapshot can be days old; lines and injury reports aren't).
- **Starting QB** — each team column has a 🎙️ Starting QB picker for benchings the data doesn't know about yet
  (e.g. a backup named the starter midweek). If the starter is ruled OUT, the next QB up is promoted automatically.
- **Weather** — domes and roofed stadiums are indoor (a curated roof table wins over ESPN's venue flag); outdoor
  games pull the [Open-Meteo](https://open-meteo.com) forecast at kickoff: condition (clear / cloudy / rain /
  snow / storm), temperature and wind.
- **Your card** — the answer to "what do I bet?". Right under the paste box: a short list of bets in order, each with a
  stake in units of your bankroll, plus why everything else was skipped. Ranked by **Kelly** (edge relative to the price),
  not EV% — EV% always floats the longest shots to the top. ¼-Kelly stakes, at most 2 plays and 4% of bankroll per team
  (same-team scorers win and lose together). One click logs the whole card to the bet log. Card picks get a ★ in the table.
- **Four priceable markets** — the Anytime / 1st TD / Last TD / 2+ TD toggle re-points Fair / Book / Edge /
  EV / Verdict; each market remembers its own odds.
- **Paste the board** into the ⚡ box (Ctrl/Cmd+Enter). FanDuel-style stacked blocks fill three markets at once:
  ```
  Jahmyr Gibbs
  -330      ← Anytime
  +360      ← 1st TD
  +410      ← Last TD
  ```
  One price per name (`Josh Allen +150`) fills the selected market — use that for the separate 2+ TD board.
  Names are fuzzy-matched (abbreviations, suffixes, `Bills D/ST`); unicode minus, fractional, decimal and
  `EVEN` prices are understood; anything unmatched is listed back. Switching games clears the board.
- **Parlays** — the same-game picker ranks combos by a conservative EV (the worse of independent and
  simulated-correlation EV); enter your book's actual SGP price for the real number. The **cross-game slip**
  collects legs across games (independent legs, so books pay full odds and the EV is real) and persists.
- **Bet log & CLV** — log any bet (the sim's TD props or your own props), enter the closing line and result;
  it tracks CLV, ROI and a live calibration check (hits the model expected vs hits you got). Re-running the
  sim with the same inputs gives the same numbers (seeded simulation), so a verdict can't flip on noise.

## Files
| File | What it is |
|---|---|
| **`nfl-td-predictor.html`** | The deliverable. Open in any browser. |
| **`build-nfl-td-snapshot.mjs`** | Node build script: refreshes the data snapshot and runs the backtest. |
| `build-market-lines.mjs` | Optional: scrapes ESPN's historical anytime-TD boards for the market-universe check. |
| `market_lines_<season>.json` | Cached output of the above (which players the book priced, per game). |
| `nfl-td-predictor.template.html` | UI + model source (the build injects the snapshot into it). |
| `nfl-td-snapshot.json` | The compact data snapshot (also embedded in the HTML). |
| `refresh.bat` | Runs the build and logs to `refresh.log` (for a weekly scheduled task). |

## Refreshing the data
```bash
node build-nfl-td-snapshot.mjs                    # default seasons (2024, 2025, 2026)
node build-nfl-td-snapshot.mjs 2023 2024 2025     # custom seasons
SKIP_LOGOS=1 node build-nfl-td-snapshot.mjs       # faster, skip the 32 logo downloads
BT_EXPERIMENTS=1 node build-nfl-td-snapshot.mjs   # also run the model-switch validation harness
```
Requires Node 18+ and `curl`. First run downloads ~200 MB of play-by-play (cached; the current season is
re-downloaded every run). Weekly is enough — lines and injuries refresh live in the app.

## Data sources
- **[nflverse](https://github.com/nflverse/nflverse-data)** — play-by-play (every player/team rate, plus the
  real closing total/spread and game weather used by the backtest), rosters (ID joins, positions) and snap counts.
- **ESPN** unofficial API — rosters, injury status, colors/logos, this week's schedule and lines.
- Players are joined ESPN ↔ play-by-play by **ID** (`espn_id ↔ gsis_id`), never by name.

## The model
**Stage 1 — how many TDs each team scores.** Expected offensive TDs = the team's **Vegas implied total**
(`total/2 ± spread/2`) × **κ**, the offensive-TDs-per-point rate measured directly off real closing lines.
Team TD counts are **negative-binomial** (realistic overdispersion). Nothing else moves the level — the market
total already prices the matchup, weather, QB, etc.

**Stage 2 — who scores them.** Each TD is rushing or passing by the team's recency-weighted run/pass TD split,
nudged toward the run in **wind, rain or snow**. Rushing TDs go to ball carriers by goal-line carries, carry
volume and TD rate (QB kneel-downs excluded); passing TDs to receivers by red-zone targets, target share, air
yards and TD rate. Thin samples shrink toward a **position-shaped prior**, a small floor keeps every active
player's odds above zero, and weights are scaled by **snap share** (full at 35%+, never below 20% for a real
role; no snaps two-plus weeks in = a scratch). Only the chosen **starting QB** carries full weight.

**Defense / special teams.** Each D/ST's TD count is Poisson with rate = league average (~0.12/game)
× e^(0.06 × points it's favored by) × (opponent's giveaways per game ÷ league average). A favorite's defense scores
more because the other side is trailing and throwing; a turnover-prone offense feeds it. A defense's own return-TD
history is **not** used: it barely repeats year to year (r = 0.20; special-teams returns r = 0.09). The weights were fit
on 2024 and tested on the unseen 2025 season: Brier 0.0983 vs 0.0996 for giving every defense the league average — the
old history-based rate scored 0.1029, worse than average, with its "hot" defenses scoring *less* often than its "cold" ones.

**Seasons** are weighted 1.0 (current) / 0.3 (last) / 0.09 (two ago) — the current season counts heavily,
so early-season numbers react to hot starts (as the backtest does too).

## Honesty & calibration
The backtest replays the **exact live model** — same κ, NB counts, run/pass rules, shrinkage and snap weighting —
on every 2025 game, using only 2024 data plus 2025 weeks *before* each game, anchored to the real closing
line. κ and every baseline come from the training season only; no in-game information is used. It scores the
players who got a touch in each game (plus the QB who dropped back), i.e. as if you knew the actives.

- **Brier 0.1502** vs a 0.1642 base-rate baseline → **8.5% skill**; log loss 0.475; reliability on the diagonal
  (predicted 14 / 24 / 34 / 44 / 53 / 63% → actual 15 / 24 / 35 / 44 / 53 / 63%).
- **Role calibration.** By snap share, the raw sim over-rated **rotational players (35–60% snaps)** by ~2.6 pts and
  **QBs** by ~1.5–2 pts. Correcting only those two tiers (×0.874 and ×0.846, down-only) improved the held-out half in
  all four cross-fits (learn on weeks 1–9, test on 10–18 and vice versa); correcting full-/part-time players did not
  hold up, so it isn't applied. The headline Brier is scored cross-fitted, never on the data the factors came from.
  (Stretching the snap curve instead closed the gaps but made overall accuracy worse — wrong lever.)

**Every model switch had to earn its place.** `BT_EXPERIMENTS=1` flips each switch and scores weeks 1–9 and
10–18 separately; a change stays only if it helps on **both** halves. Kept: kneel exclusion, weather,
empirical κ, position-shaped shrinkage, the small floor, heavier current-season weighting, and snap weighting
(judged on a roster-wide candidate set, since its job is suppressing players who won't play). **Removed
because they made predictions worse:** a spread-driven game-script adjustment, an opponent run/pass funnel,
and the defense-vs-position matchup nudge (the weak-spot table is still shown as context). An earlier version
of this backtest also gave every player who touched the ball in *that* game a small bonus — information the
app never has — which flattered its number; that leak is gone and the honest model still scores better.

### Market-universe check (lines, not prices)
`node build-market-lines.mjs` scrapes ESPN BET's historical "Anytime Touchdown Scorer" boards (2025, wk 1–13).
Restricted to exactly the players the book priced: **Brier 0.1490** on 1,065 players (baseline 0.1639), and the
book listed **94% of actual scorers**. ESPN exposes the line, **not the price**, so this is a calibration and
coverage check — not a beat-the-odds result. A price comparison needs a paid odds feed.

**Where the edge is (and isn't).** The model tracks the market about as well as the market prices itself —
it's a lead generator, not a line-beater. Edge, when it exists, lives in speed (repricing after injury news
before the book moves), line shopping, and promos/boosts. The log's CLV column is how you find out.

**Estimate-grade until inactives lock** (~90 min before kickoff): set statuses as the inactive list drops.

*Not betting advice.*
