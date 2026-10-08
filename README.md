# 🏈 NFL Anytime-TD Simulator

A standalone, single-file web app that predicts **anytime-touchdown scorers** for any NFL matchup.
Pick a game and it runs a 10,000-game Monte Carlo simulation to produce each player's **anytime-TD %**,
**1st-TD / Last-TD / 2+-TD** probabilities and **fair American odds**, plus an **EV calculator** with a
TAKE / PASS verdict, a same-game **parlay picker**, a **cross-game parlay slip** and a **bet log with CLV** —
plus **player props** (receptions, receiving / rushing / rush+rec / passing yards) priced against your book's over/unders.

`nfl-td-predictor.html` is fully self-contained (data + logos embedded as base64) and runs **offline** —
just double-click it. Live extras (today's line, injuries, forecast) load when online and fall back
silently to the baked snapshot when not.

## On any PC or phone
- **Just use it:** open **https://popcawn.github.io/nfl-td-predictor/** — nothing to install. The data is rebuilt on
  GitHub every morning (`.github/workflows/refresh.yml`); the game slate, lines, injuries and weather refresh live
  on every visit. A local copy of the file only updates after `git pull`, so use this address on every PC.
- **Same log on every PC:** hit **☁ Sync** in the bet log and paste a GitHub token with only the *gist* permission
  (the panel links straight to it). Your log, slip and bankroll then live in a private gist and merge across every
  PC you connect — edits, settled results and deletions all carry over. Without sync, each browser keeps its own copy.
- **Your bet log / slip / bankroll** are saved in the browser you use, per machine. Move them with **⬇ Export** /
  **⬆ Import** in the Bet log panel (imports merge — no duplicates; a settled result or closing line wins over a pending
  copy). Tip: always use the Pages link rather than the local file, so each machine has one place to look.
- **Work on the code:** install [Git](https://git-scm.com) and [Node 18+](https://nodejs.org), then
  `git clone https://github.com/popcawn/nfl-td-predictor.git`. Run `git pull` before each session (the refresh bot
  commits data twice a week). `CLAUDE.md` carries the project notes for Claude Code on any machine.

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
- **Sportsbook layout** — on a wide screen the paste box and **Your card** sit in a right-hand **bet slip** that stays in
  view while you browse the markets; on a phone they stack above. A sticky jump bar (Price · Card · Markets · Teams & QBs
  · Parlays · Slip · Log) keeps every section one click away, and the game controls fit on one row.
- **Markets** — one panel for everything: tabs for **TD scorer** (anytime / 1st / last / 2+, with each team's defense
  at the bottom), **Receptions**, **Rec yds**, **Rush yds**, **Rush + Rec** and **Pass yds**, plus **★ Priced** (every
  price you've entered, card picks first). Both teams side by side, one compact row per player, one price box per bet:
  it shows the model's fair odds until you enter the book's, then the model's chance and EV — green **★ BET** = on your
  card, outlined = an edge that didn't make the card (hover for why), dashed = ⚠ too good to trust. Tabs show how many
  prices you've entered; the deep bench sits behind "+N more".
- **🎯 My TD picks** — the low-effort way to bet: one click checks every game of the next game day (or the rest of the
  week) — ESPN injuries, live lines, kickoff weather, FanDuel's anytime prices (1 odds credit per game, reused for 20
  min) — runs each game's simulation and returns only the best few anytime-TD bets across all games (3 / 5 / 8) with
  stakes, plus one cross-game parlay. Same picking rule as Your card; the whole day (parlay included, parlay ≤ 1%) is
  capped at 15% of bankroll. One click logs the picks or the parlay, or sends the parlay to the slip; click a pick to
  open its game.
- **🎉 Fun picks** (under My TD picks) — for TD bets you'll make anyway: anytime TDs priced **+100 to +400**, one per
  game, a flat 0.5u each, plus a 2-leg fun parlay (the two likeliest, 0.2u). On 2025's real FanDuel prices that range lost
  about 5% of the money bet (wks 1–9 −1%, 10–18 −9%) while +400 to +1500 lost about 20% in both halves and heavy
  favourites about 11%. Ordering inside the range (the other books, the model, shortest price) never reliably helped, so
  the range is the rule. Logged fun bets are tagged 🎉, kept out of Your card and the log's plan, and get their own running
  total. **Not an edge** — they lose a little over time, by design.
- **⚡ Pull FanDuel odds** — with a [The Odds API](https://the-odds-api.com) key saved under *odds settings*, one click (or
  automatically when you open a game) fills FanDuel's current prices for that game: TD scorer markets (4 credits per game)
  and/or player props (5 credits). Auto-pulls stop below a credit reserve so other apps on the same key keep working;
  the free plan has 500 credits a month. In the bet log, **⚡ Pull closing prices** fills Close on every open bet before
  kickoff (moved prop lines are estimated, ≈). The key stays in your browser. A pull returns **every US book** for the
  same credits; FanDuel's price is what you bet, and the other books set the starting chance (see *Market anchor*).
- **📲 Open on FanDuel** — pulled prices carry FanDuel's own selection ids, so the slip (all legs, or each suggested
  parlay), Your card and My TD picks have buttons that open those bets straight in FanDuel's bet slip (the FanDuel app on a
  phone), plus a small FD↗ link per slip leg. Legs whose prices were pasted rather than pulled have no ids — they're listed
  as "to add by hand". Always check the price in FanDuel before betting; it may have moved.
- **Price this game** — ONE paste box for every market: TD boards (stacked Anytime / 1st / Last, or one price per name
  for the market picked under the box) and player-prop boards (Over / Under lines, detected automatically). Paste one
  market at a time; chips show what's priced (× clears one market). Prices are kept **per game** — switch games and
  come back, or reload, and they're still there (for a few days).
- **Your card** — the answer to "what do I bet?": the best plays in the game (**Max per game**, default 3; at most 2 per
  team and one per player), ranked by confidence-adjusted **Kelly** (edge relative to the price, not EV%), ¼-Kelly
  stakes with 4% of bankroll per team. It looks at everything you've priced **and** everything already in your log for
  the game, so you can log every edge as you go and it (or the log) tells you which to keep. Only card picks read
  **★ BET** in the tables; other +EV rows read **edge** (hover for why they didn't make it).
- **★ Priced** (Markets tab) — TD and prop prices together in one list: card picks first, then the other edges (no-edge
  prices hidden unless you tick the box), each with 📓 log / ➕ slip buttons and a "📓 Log every edge" button.
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
  `EVEN` prices are understood; anything unmatched is listed back.
- **Confidence + slip optimizer** — every pick gets a **confidence score** (how much of the model's edge to believe: role
  reliability from the backtest, history, injury status, market type, distance from the book; total/spread/weather already
  shape the probability so they aren't counted twice). The edge is scaled by it (adjusted EV = confidence × EV). Hit
  **➕ add these to slip** on each game's card; the slip keeps the best leg per game, drops started games, and picks the
  parlay that **grows a bankroll fastest** (Kelly growth), not the highest EV% — plus a bigger-payout option and an honest
  comparison with betting the same legs as singles (usually 2–3× faster growth). Confidence weights are a reasoned
  heuristic, not fitted (no historical prices exist to fit them); the bet log's CLV is how they get checked.
- **Parlays** — the same-game picker mixes 🏈 TD legs and 📈 prop legs (filter: at least one TD / TD + prop mix / TD
  only / any) and ranks combos by a conservative EV (the worse of independent and simulated-correlation EV); enter your
  book's actual SGP price for the real number. Prop legs move with each simulated game's TD outcome: a player's yards
  and catches run higher when he scores, and a QB's passing yards with his team's passing TDs. Tested on every 2025
  game, "he scores and goes over / under" came out more accurate than treating the legs as independent, on both
  halves, for all five props — so "TD + his own over" shows as legs that cash together, and "TD + his own under" as
  legs that fight each other. The **cross-game slip**
  collects legs across games (independent legs, so books pay full odds and the EV is real) and persists.
- **Player props** — paste the book's over/unders into the same box (FanDuel stacked `Name / O 64.5 / -114 / U 64.5 / -114`,
  one-line `O 64.5 -114 U 64.5 -114`, or ladder rungs `60+ +120`); headers like "Receiving Yards" route each block to
  its prop, so a whole props page can go in at once (TD / attempts / longest markets are skipped). Without a header the
  lines decide the market (or pick it under the paste box). Each row shows the
  **model line** (its 50/50 number), season average, P(over), fair odds, the better side's EV and a confidence score;
  priced props join **Your card**, the slip and the log. Passing props only list tonight's starting QB.
- **🤖 Auto-settle + closing lines** (bet log) — once a game is final, ESPN's box score settles every pending bet on it:
  anytime / 1st / last / 2+ TD, defense TDs, the five yardage props, and parlays logged from My TD picks (a void leg is
  left for you, since FanDuel reprices it). A player ESPN lists as "did not play" is a void (push). Free, no key; a result
  you set by hand is never changed (🤖 marks auto results, ✋ ones it couldn't decide). **Close** fills itself: FanDuel's
  live price if the app is open in the 15 min before kickoff (1 credit per market), otherwise FanDuel's price 5 min before
  kickoff from The Odds API's history after the game starts (paid plans; 1 + 10 credits per market per game). Both are
  checkboxes in the log; **🤖 Settle now** runs it on demand.
- **Bet log by game** — each game has its own section (open games first). For open games the log applies the
  same rule as the card: the best bets read **★ BET** with a suggested stake, the rest **cut**, and **✂ Trim** removes
  the cuts and sets the stakes in one click.
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
| `market-backtest.mjs` | Historical-price test (paid Odds API plan): fits the market-anchor weight → `market_anchor.json`. |
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

**Defense.** Only **defensive TDs** (pick-6, fumble return) — books pay the defense prop on those, while a kick or
punt return TD pays the **returner's** player prop. Defensive TD rate = league average (~8.6% a game) × e^(0.06 × points
favored by) × (opponent's giveaways per game ÷ league average): a favorite's defense scores more because the other side is
trailing and throwing, and a turnover-prone offense feeds it. A defense's own TD history isn't used — it barely repeats
year to year (r = 0.20). Those weights beat the league average in **both** 2024 and 2025 (each scored leak-free); the old
history-based rate was worse than average in both. **Special-teams return TDs** (~3.2% a game, 27% of non-offensive TDs)
happen at the league rate and are credited to each team's returners by their share of recent returns (↩ in the table), so
they count toward that player's anytime / 1st / last TD odds.

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

### Player props
Projection = recency-weighted per-game average (this season, last season at 0.3×) shrunk toward a position prior,
× recent snap share vs his norm (receptions, receiving yds), × tonight's implied team total vs his offense's norm
(receiving, rush+rec, passing yds). Over/under chances come from the **empirical spread of real outcomes around
projections of that size** (learned out-of-sample), not an assumed bell curve. Tested on every 2025 game using only
earlier data (population = players who actually played; passing = the starter), with outcome tables cross-fitted
between halves:

| Prop | Brier wk 1–9 / 10–18 | Plain season average | Predicted → actual over rate |
|---|---|---|---|
| Receptions | 0.158 / 0.156 | 0.170 / 0.164 | 29→29% · 50→50% · 70→71% |
| Receiving yds | 0.185 / 0.177 | 0.197 / 0.186 | 29→29% · 50→50% · 70→71% |
| Rushing yds | 0.173 / 0.178 | 0.189 / 0.185 | 29→29% · 49→49% · 70→71% |
| Rush + rec yds | 0.188 / 0.184 | 0.202 / 0.193 | 30→30% · 50→51% · 69→68% |
| Passing yds | 0.218 / 0.205 | 0.229 / 0.234 | 13→19% · 50→53% · 70→66% (tails a bit hot) |

Every choice (snap vs plain average, the Vegas context, how hard to shrink) was kept only if it won both halves.
Passing yards want heavy shrinkage (single-game passing is noisy next to real QB differences) and use only games
the QB started. **Pass TDs are not offered**: they beat a season average by a hair and their top bucket ran 87%→76%.
This proves the projections are accurate and calibrated — **not** that they beat the book's line (no historical prop
prices to test against). Prop books mostly move the line, not the price, so the log estimates CLV for a moved line
from the model's own distribution (marked ≈).

### Market-universe check (lines, not prices)
`node build-market-lines.mjs` scrapes ESPN BET's historical "Anytime Touchdown Scorer" boards (2025, wk 1–13).
Restricted to exactly the players the book priced: **Brier 0.1490** on 1,065 players (baseline 0.1639), and the
book listed **94% of actual scorers**. ESPN exposes the line, **not the price**, so this is a calibration and
coverage check — not a beat-the-odds result. A price comparison needs a paid odds feed.

### Real prices: the books vs the model (anytime TD, every 2025 game)
`market-backtest.mjs` pulled every US book's anytime-TD prices for all of 2025 from The Odds API's historical feed
(8 books incl. FanDuel; 10 minutes and 6 hours before kickoff) and scored them against the model's leak-free
predictions — 6,002 priced player-games of players who played.

| Closing prices | Brier wk 1–9 | Brier wk 10–18 |
|---|---|---|
| Model | 0.1440 | 0.1299 |
| Other books' median (raw) | 0.1397 | 0.1266 |
| Other books, calibrated | **0.1393** | **0.1254** |
| Books + 35% model (the interim app rule) | 0.1420 | 0.1283 |

**The books are more accurate than the model, on both halves, and mixing the model in doesn't help** (best model share
0 in weeks 1–9, 0.1 in 10–18). The reason is the shape: grouped by the books' implied chance —

| Books imply | Books | Model | Actually scored |
|---|---|---|---|
| 0–10% | 6% | 5% | 5% |
| 20–30% | 24% | 16% | 21% |
| 30–45% | 37% | 25% | 35% |
| 45–60% | 52% | 35% | 42% |
| 60%+ | 65% | 47% | 59% |

The model gets each game's TD count right but spreads it too flat: it underrates every featured scorer, so its
"edges" were backups and second tight ends. **Betting returns** (flat 1u at FanDuel's price whenever a probability said
EV > 3%, both halves, 95% range): every FanDuel price **−8.7%** [−16, −1] — that's the house edge; the model's picks
+3.4% [−21, +30] on 1,019 bets although it claimed +45% EV; the books' consensus (line shopping) −2.0% [−43, +48];
blends +30–40% but only from a few +4000 long shots in weeks 1–9 (weeks 10–18 lost). **Nothing showed a proven edge.**

### Real prices: player props (receiving + rushing yards, every 2025 game)
Same test at the close for every regular-season game: FanDuel's main line, the other books at that same line
(de-vigged), and the model's P(over) from the props backtest (cross-fitted tables, games he played).

| Closing lines | Rec yds wk 1–9 / 10–18 | Rush yds wk 1–9 / 10–18 |
|---|---|---|
| Lines scored | 1,196 / 1,198 | 557 / 597 |
| Model | 0.2657 / 0.2567 | 0.2737 / 0.2757 |
| Other books | 0.2499 / 0.2503 | 0.2506 / 0.2485 |
| Books + 10% model | **0.2496 / 0.2494** | **0.2506 / 0.2478** |

A coin flip at the line scores 0.25, so **the model alone was worse than a coin flip at the books' lines**: it is
accurate around its own projection (the props table above) but far too sure when it disagrees with the line. When it
said 15+ points more likely over than the books, the over hit 55% (rec) / 48% (rush); the model had said 71% / 75%.
A 10% model share was the best mix, a hair better than the books alone on both halves.

**Overs lose.** Overs hit only 46% (rec yds) and 48% (rush yds) while the books price them as 50/50: betting every
FanDuel over lost **−12.3%** [−16, −8] on rec yds and **−8.3%** [−14, −3] on rush yds. Every under: +1.6% [−2, +5] and
−2.7% [−8, +3] — about break-even. The model's picks: +0.7% [−4, +5] (rec) / −1.0% [−7, +5] (rush), mostly because it
leans under. Correcting the books' own over-lean (a calibration) helped rec yds but hurt rush yds, so it isn't applied.
When no other book posted FanDuel's exact line (16% of lines), their nearest line moved to FanDuel's by the model's own
distribution still beat the model on both halves — the app uses that fallback.

**What the app does with it.**
- **Anytime TD:** the bet chance is the other books' consensus, calibrated (`logit p = −0.198 + 1.006·logit(median
  implied)`, which removes their cut). Bets appear only when FanDuel's price is clearly longer than every other book's.
- **1st / last / 2+ TD:** not tested, same lesson applied: the books' consensus (rescaled to the model's game total, since
  these prices are one-sided), no model share.
- **Props:** the books' de-vigged consensus + 10% model. Receptions, rush + rec and passing yards weren't tested; they
  use the same 10% by analogy.
- **No other-book prices** (a pasted board, or nothing pulled): the model alone, flagged **model only** on the card.

```bash
DUMP_BT=1 node build-nfl-td-snapshot.mjs     # writes bt_rows_2025.json (leak-free model predictions); then git checkout the shipped files
node market-backtest.mjs                     # dry run: estimated credits (~5,500 for 2025)
node market-backtest.mjs --go                # fetch (cached in market_hist/, gitignored) — needs a paid Odds API key in .odds-key
node market-backtest.mjs analyze             # → market_anchor.json, which the next build ships into the app
node market-backtest.mjs --props --go        # rec + rush yds closing lines (~5,440 credits)
node market-backtest.mjs analyze-props       # → market_anchor.json .props
```
Raw paid price data stays local (gitignored); only the summary (`market_anchor.json`) is committed.

**Where the edge is (and isn't).** On anytime TD the market beats the model (above) —
it's a lead generator, not a line-beater. Edge, when it exists, lives in speed (repricing after injury news
before the book moves), line shopping, and promos/boosts. The log's CLV column is how you find out.

**Estimate-grade until inactives lock** (~90 min before kickoff): set statuses as the inactive list drops.

*Not betting advice.*
