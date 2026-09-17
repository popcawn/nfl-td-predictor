# 🏈 NFL Anytime-TD Simulator

A standalone, single-file web app that predicts **anytime-touchdown scorers** for any
NFL matchup. Plug in two teams + the Vegas total/spread, and it runs a 10,000-game Monte
Carlo simulation to produce each player's **anytime-TD %**, **fair American odds**, first-TD
and 2+-TD probabilities, plus a **fair-odds / EV calculator** with a TAKE / PASS verdict —
same spirit as a UFC fight simulator, adapted into an NFL player-prop model.

`nfl-td-predictor.html` is fully self-contained (data + logos embedded as base64) and runs
**offline** — just double-click it. No server, no internet needed at run time.

**Four priceable markets:** a Pricing-market toggle (**Anytime / 1st TD / Last TD / 2+ TD**) above the
table re-points the Fair / Book / Edge / EV / Verdict columns at whichever market you choose; each market
remembers its own entered odds. All four probability columns are shown for reference.

**Weather is automatic.** Pick the two teams and the app reads the **home stadium** — dome games show
"indoor · no weather" (wind zeroed); outdoor games fetch the **live game-day forecast** (wind + temp) from
[Open-Meteo](https://open-meteo.com) (free, no key) for that stadium at the scheduled kickoff, and fill the
wind in for you. The stadium table and the current-week schedule are baked into the snapshot, so dome/outdoor
detection works fully offline; only the live wind/temp needs internet (it falls back to manual entry when
offline). You can still override the wind by hand for a what-if.

**No typing prices one by one:** paste your sportsbook's board into the ⚡ box and hit **Apply**
(or Ctrl/Cmd+Enter). It understands **FanDuel-style stacked blocks** — a player name followed by the
Anytime / 1st / Last prices on their own lines — and fills all three of those markets in one go:
```
Jahmyr Gibbs
-330      ← Anytime
+360      ← 1st TD
+410      ← Last TD
```
A single price per name (e.g. `Josh Allen +150`) fills whichever market is currently selected — use that
for FanDuel's separate **2+ TD** board (select 2+ TD first, then paste). Names are fuzzy-matched
(unicode minus, bare numbers, fractional/decimal, `EVEN`, abbreviated names, `Buffalo Defense`); the
result line says which markets were filled and lists anything it couldn't match. Pick the two teams in
the matchup first so the paste has rows to fill. It fuzzy-matches names to players
and fills every row at once — understands `Josh Allen +150`, multi-space, `-110`, unicode minus
`−140`, bare numbers (`260`→+260), fractional (`11/4`), decimal, `EVEN`, abbreviated names
(`P. Mahomes`), and `Bills D/ST +450`. Header lines are ignored; anything it can't match is
listed back to you. **Clear** wipes all odds.

## Files
| File | What it is |
|---|---|
| **`nfl-td-predictor.html`** | The deliverable. Open in any browser, works offline. |
| **`build-nfl-td-snapshot.mjs`** | Node build script that refreshes the data snapshot. |
| `build-market-lines.mjs` | Optional: scrapes ESPN's historical anytime-TD boards for the market-universe backtest. |
| `market_lines_<season>.json` | Cached output of the above (which players the book priced, per game). |
| `nfl-td-predictor.template.html` | UI + model source (build injects the snapshot into it). |
| `nfl-td-snapshot.json` | The compact data snapshot (also embedded in the HTML). |

## Refreshing the data
```bash
node build-nfl-td-snapshot.mjs                 # default seasons (2024, 2025, 2026)
node build-nfl-td-snapshot.mjs 2023 2024 2025  # custom seasons
SKIP_LOGOS=1 node build-nfl-td-snapshot.mjs    # faster, skip the 32 logo downloads
```
Requires Node 18+ and `curl`. First run downloads ~185 MB of play-by-play (cached after).
Re-run it during the season to pick up current rosters, injuries, and form.

## Data sources
- **[nflverse](https://github.com/nflverse/nflverse-data) play-by-play** — primary source for
  every player/team rate (goal-line carries, red-zone targets, air yards, realized TD rates,
  team run/pass TD splits, red-zone efficiency, defense allowed, return TDs). Also carries the
  **real closing total/spread** used by the backtest.
- **ESPN** unofficial API — current rosters, positions, jersey #, **injury status**, team
  colors and logos (downloaded and embedded as base64 so the file stays offline).
- Players are joined between ESPN and play-by-play by **ID** (`espn_id ↔ gsis_id` from the
  nflverse roster), not by name — PBP abbreviates names (`J.Allen`), so ID matching is exact.

## The model (two stages)
**Stage 1 — how many TDs each team scores.** Each team's expected offensive TDs are anchored
to its **Vegas implied team total** (`total/2 ± spread/2`) × an empirical TD-per-point ratio,
then reshaped (not re-leveled) by red-zone efficiency vs the opponent's red-zone defense — this
shifts the TD-vs-FG mix without double-counting the market total. Team TD counts are drawn from
a **negative-binomial** (realistic overdispersion vs a plain Poisson).

**Stage 2 — who scores them.** Each team's TDs split into rushing vs passing by team tendency,
funneled by the opponent's rush/pass TD-allowed profile and by **game script** (favorites run
more near the goal line → lead RB; underdogs throw more, incl. garbage time → WRs), plus a mild
wind effect. Each rushing TD is assigned to a ball-carrier weighted by goal-line carries / rush
role (**rushing QBs included** — Allen/Hurts/Jackson types), each passing TD to a receiver
weighted by red-zone targets / target share / air yards / TD rate. A **single-starter constraint**
keeps a backup QB from outranking the starter.

**Defense / special teams.** A per-team Poisson for pick-6 / fumble-return / kick-punt-return
TDs, from each team's recent non-offensive TD rate.

Player rates are **recency-weighted** across seasons and **shrunk** toward zero for small samples.

## Honesty & calibration
The model is **backtested out-of-sample**: for each game of the test season it predicts every
player's anytime-TD probability using **only prior-season rates + that season's games *before*
the game in question**, anchored to the **real closing line** — no leakage, no hardcoded outcomes.
It mirrors exactly how the live model blends last season + season-to-date, so the calibration
number describes the shipped model. Reported in the UI:

- **Brier score ≈ 0.153** vs a 0.166 base-rate baseline (~7.5% skill) — this is a *probabilistic*
  score, not an "accuracy %", because anytime-TD is inherently probabilistic.
- **Log loss ≈ 0.48**, and a reliability curve that tracks the diagonal (predicted 14/24/34/44/54%
  → actual 15/23/32/42/50%).

### Market-universe backtest (lines, not prices)
Run `node build-market-lines.mjs` (defaults: 2025, ~45 games; `MAXWEEK=13 node build-market-lines.mjs 2025 60`
for a fuller sample). It scrapes ESPN BET's historical **"Anytime Touchdown Scorer"** boards — the exact
set of players the sportsbook made an anytime-TD market on each game — and caches them. The next
`node build-nfl-td-snapshot.mjs` then reports a second calibration line: the model's Brier restricted to
**only the players the book priced**, plus what fraction of players who actually scored the book had listed.

Latest run (60 games, 2025 wk 1–13): **Brier 0.1514** on 1,056 priced players (base-rate baseline 0.1649),
and the book listed **94% of players who actually scored**. Two honest caveats: (1) ESPN exposes the
anytime-TD *line*, **not the price**, so this is a *calibration + coverage* check against the market's
player universe — **not** a "beats the odds / positive-EV" result. A true price comparison needs a paid
odds feed (e.g. the-odds-api's historical `player_anytime_td`). (2) ESPN BET's prop board is only archived
through ~week 13; later weeks fall back to a game-lines-only provider.

**Where the edge is (and isn't):** star players' anytime lines are efficient — the market nails
the obvious guys. Real edge lives in **role players, injury-driven role changes** (a backup
becoming the goal-line back), and **game-script mismatches**. The app flags a model-vs-market gap
that's *too* large as a likely missed inactive → PASS, and reminds you that same-team scorers are
**positively correlated** (a same-game parlay, not independent edges).

**Estimate-grade until inactives lock.** A player ruled OUT scores zero TDs, so props with
questionable players are estimates until game-day actives confirm (~90 min before kickoff). Set
each player's status (ACT / Q / DBT / OUT) in the table to update on the fly.

*Not betting advice.*
