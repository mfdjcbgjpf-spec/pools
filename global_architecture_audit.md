# Pools — Global Scale Technical Audit

Audit of the current `engine.js` implementation against the target Python/Postgres/ML architecture, plus a structured plan for the four areas requested.

**Starting point matters.** `engine.js` already implements Dixon-Coles (`dcMatrix`, with the four-cell low-score correction), Bayesian shrinkage toward league priors (`shrink`), venue-split lambdas, a humility blend, and a correlated Monte Carlo slip model (`correlatedMC`) that most public tipster sites don't bother with — they publish independent per-match probabilities and let you do the parlay math wrong yourself. That's a genuine edge already. What's missing relative to the brief: no time-decay on the shrinkage weight `n` (a match from August counts the same as one from last week), `rho` is a fixed constant rather than fitted, there's no ELO layer at all, and everything lives in flat JSON rather than a queryable schema. The plan below is written as an upgrade path from *this* system, not a rewrite.

---

## 1. Global Database Architecture & Schema

### Core schema (PostgreSQL)

```sql
-- Confederations: UEFA, CONMEBOL, CONCACAF, AFC, CAF, OFC
CREATE TABLE confederations (
    id          SMALLSERIAL PRIMARY KEY,
    code        TEXT UNIQUE NOT NULL,      -- 'UEFA', 'CONMEBOL', ...
    name        TEXT NOT NULL
);

CREATE TABLE countries (
    id              SMALLSERIAL PRIMARY KEY,
    iso_code        CHAR(3) UNIQUE,
    name            TEXT NOT NULL,
    confederation_id SMALLINT REFERENCES confederations(id)
);

CREATE TYPE competition_type AS ENUM (
    'domestic_league', 'domestic_cup', 'continental_club',
    'international_national', 'friendly'
);

CREATE TABLE competitions (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    country_id      SMALLINT REFERENCES countries(id),        -- NULL for continental/international
    confederation_id SMALLINT REFERENCES confederations(id),
    type            competition_type NOT NULL,
    tier            SMALLINT,              -- 1 = top flight, 2 = second tier, etc. NULL for cups/continental
    neutral_venue   BOOLEAN DEFAULT FALSE  -- tournaments (World Cup, Copa América) vs home/away leagues
);

CREATE TABLE seasons (
    id              SERIAL PRIMARY KEY,
    competition_id  INT REFERENCES competitions(id),
    label           TEXT NOT NULL,          -- '2025-26', '2024'
    start_date      DATE,
    end_date        DATE,
    UNIQUE (competition_id, label)
);

CREATE TABLE teams (
    id              SERIAL PRIMARY KEY,
    canonical_name  TEXT NOT NULL,
    country_id      SMALLINT REFERENCES countries(id),
    founded_year    SMALLINT,
    external_ids    JSONB DEFAULT '{}'      -- {"thesportsdb": "133602", "openfootball": "..."}
);

-- Solves fuzzy-matching collisions (e.g. the Australian NPL name-clash problem):
-- every known spelling/alias resolves to one team_id, so lookups never guess.
CREATE TABLE team_aliases (
    id          SERIAL PRIMARY KEY,
    team_id     INT REFERENCES teams(id),
    alias       TEXT NOT NULL,
    source      TEXT,                       -- 'openfootball', 'thesportsdb', 'manual'
    UNIQUE (alias, source)
);

-- THE key join table: a team's presence in a given season+competition.
-- This is what lets a club sit in both its domestic league AND a continental
-- competition in the same season without either polluting the other's stats.
CREATE TABLE team_season_registrations (
    id              SERIAL PRIMARY KEY,
    team_id         INT REFERENCES teams(id),
    season_id       INT REFERENCES seasons(id),
    UNIQUE (team_id, season_id)
);

CREATE TABLE fixtures (
    id              BIGSERIAL PRIMARY KEY,
    season_id       INT REFERENCES seasons(id),
    home_team_id    INT REFERENCES teams(id),
    away_team_id    INT REFERENCES teams(id),
    kickoff_utc     TIMESTAMPTZ,
    venue_neutral   BOOLEAN DEFAULT FALSE,   -- inherited from competitions.neutral_venue but overridable (e.g. CL final)
    round           TEXT,
    status          TEXT DEFAULT 'scheduled', -- scheduled, played, awarded, postponed
    ht_home INT, ht_away INT,
    ft_home INT, ft_away INT,
    et_home INT, et_away INT,
    pen_home INT, pen_away INT
);

CREATE TABLE match_events (
    id          BIGSERIAL PRIMARY KEY,
    fixture_id  BIGINT REFERENCES fixtures(id),
    team_id     INT REFERENCES teams(id),
    minute      SMALLINT,
    event_type  TEXT,       -- 'goal', 'red_card', 'penalty_miss', ...
    player_ref  TEXT        -- free text; don't force a players table until you actually have lineup data
);

-- Ratings are scoped, not global — this is the answer to question 1b below.
CREATE TYPE rating_scope AS ENUM ('domestic', 'continental', 'international', 'global');

CREATE TABLE team_ratings (
    id              BIGSERIAL PRIMARY KEY,
    team_id         INT REFERENCES teams(id),
    scope           rating_scope NOT NULL,
    as_of_date      DATE NOT NULL,
    elo             NUMERIC(7,2),
    attack_rating   NUMERIC(6,4),   -- from DC/Poisson fit, relative to league mean = 1.0
    defense_rating  NUMERIC(6,4),
    rho             NUMERIC(6,4),   -- fitted DC low-score correlation for the team's competition context
    n_matches       INT,            -- effective (decay-weighted) sample size backing this rating
    UNIQUE (team_id, scope, as_of_date)
);

CREATE INDEX idx_fixtures_teams_date ON fixtures (home_team_id, away_team_id, kickoff_utc);
CREATE INDEX idx_ratings_lookup ON team_ratings (team_id, scope, as_of_date DESC);
```

### Handling teams across domestic + continental competitions

Two mistakes are easy to make here: pooling all of a team's matches into one rating (a Champions League thrashing distorts league form) or hard-siloing everything (losing the fact that continental form *is* signal about current quality). The fix is the `rating_scope` enum above plus a blending step at *read* time, not write time:

1. Every fixture belongs to exactly one `competition`, which has a `type`. Ratings are computed and stored per `(team_id, scope)`, where scope collapses `domestic_league` → `domestic`, `continental_club` → `continental`, `international_national` + `friendly` → `international`.
2. When you need a single number for a specific upcoming fixture, blend scopes with weights that depend on the fixture's own competition type: a domestic league fixture uses `0.85 * domestic + 0.15 * continental` (continental form nudges the number but doesn't dominate); a Champions League fixture inverts that. This is the same shrinkage pattern already in `engine.js`'s `shrink()` — you're just shrinking toward a *sibling scope* instead of a league prior.
3. `n_matches` (decay-weighted, see §2) naturally down-weights a scope with few matches — a team that's just qualified for its first continental campaign won't get a continental rating that overrides ten years of domestic data.
4. Never join `team_season_registrations` to compute domestic-only stats without filtering on the competition's `type` — the registration table tells you *which* competitions a team is in this season, the fixtures' own competition type tells you which bucket each result belongs in.

---

## 2. Advanced BTTS Modeling Beyond Basic Poisson

`engine.js` already runs Dixon-Coles, not naive independent Poisson — the `dcMatrix` function applies the standard four-cell correction (`τ(0,0)`, `τ(0,1)`, `τ(1,0)`, `τ(1,1)`) that inflates/deflates the low-score cells to fix the independence assumption's known failure mode. Two things are worth upgrading:

**A. Fit `rho` instead of hardcoding it.** Currently `rho` comes from `settings.rho` as a flat constant applied to every league. Dixon & Coles' original method fits it per competition via maximum likelihood over historical scorelines:

```python
import numpy as np
from scipy.optimize import minimize
from scipy.stats import poisson

def dc_tau(x, y, lam_h, lam_a, rho):
    if x == 0 and y == 0: return 1 - lam_h * lam_a * rho
    if x == 0 and y == 1: return 1 + lam_h * rho
    if x == 1 and y == 0: return 1 + lam_a * rho
    if x == 1 and y == 1: return 1 - rho
    return 1.0

def neg_log_likelihood(params, matches, team_idx):
    n_teams = len(team_idx)
    attack, defense = params[:n_teams], params[n_teams:2*n_teams]
    home_adv, rho = params[-2], params[-1]
    ll = 0.0
    for m in matches:
        i, j = team_idx[m.home], team_idx[m.away]
        lam_h = np.exp(attack[i] - defense[j] + home_adv)
        lam_a = np.exp(attack[j] - defense[i])
        tau = dc_tau(m.hg, m.ag, lam_h, lam_a, rho)
        ll += (np.log(max(tau, 1e-10))
               + poisson.logpmf(m.hg, lam_h)
               + poisson.logpmf(m.ag, lam_a))
    return -ll
```

Fit this **offline in Python, per league, on a schedule** (nightly/weekly), then push only the fitted scalars (`rho`, attack/defense ratings) down to the JSON files `engine.js` already consumes. You keep the fast client-side JS engine exactly as-is; the intelligence upgrade happens in what feeds it, not in the browser.

**B. Time-decay the shrinkage weight, not just match count.** Right now `n` in `shrink(x, prior, n, k)` is a flat count — a result from the first week of the season counts identically to last weekend. Replace it with an exponentially-weighted effective sample size and mean:

```python
def decayed_stats(matches, half_life_days, as_of_date):
    xi = np.log(2) / half_life_days
    weights = np.array([np.exp(-xi * (as_of_date - m.date).days) for m in matches])
    values = np.array([m.stat for m in matches])
    n_eff = weights.sum()
    x_weighted = (weights * values).sum() / n_eff
    return x_weighted, n_eff
```

Feed `x_weighted` and `n_eff` into the existing `shrink()` call unchanged — this is a drop-in replacement for how `m.hgf`/`m.n` are computed upstream, no engine.js logic changes needed. The half-life should **not** be one global constant: a weekly top-flight league can use a short half-life (60–90 days, so it reacts to a form dip within half a season) because it has enough matches to still leave a decent `n_eff`; a data-sparse lower division or an annual international tournament needs a long half-life (365+ days) or `n_eff` collapses to near-zero and the shrinkage term `k*prior` swamps everything, which defeats the purpose. Tie the half-life to the competition's match frequency, not a single sitewide default.

**C. Bivariate Poisson as the next step up, if you want it.** Dixon-Coles patches four cells; the Karlis & Ntzoufras bivariate Poisson model instead decomposes home/away goals as `X = Z1 + Z3`, `Y = Z2 + Z3` where `Z3 ~ Poisson(λ3)` is a shared component representing match-level factors (pace, referee strictness, weather) that push both teams' goal counts the same direction. This gives correlation across the *whole* matrix instead of just the low-score corner, and is a more honest model of *why* goals correlate. It costs you an EM fit (three lambdas instead of two, no closed form) — worth it once you have enough volume that the four-cell DC patch is visibly the accuracy bottleneck, not before. Given you're already running DC well, I'd treat this as a Phase 2 item, not a Phase 1 blocker.

---

## 3. Upgrading 1X2 Pools to Machine Learning

### Top 15 engineered features

1. **Elo differential** (home Elo − away Elo, home-advantage-adjusted) — still the single strongest 1X2 predictor in the literature; everything else is refinement around it.
2. **Elo momentum** — rolling Elo delta over the last 5 and last 10 matches, separately (captures whether a team is trending up/down independent of absolute level).
3. **Rolling goal-difference form** — last 5/10 matches, venue-split (home matches only for home form, away only for away).
4. **DC/Poisson lambda differential** — feed the *output* of your existing `computeModel()` (`lh - la`) in as a feature. This is the stacking move: let the ML model learn how much to trust the statistical model's own signal rather than re-deriving it from raw stats.
5. **Rest days** since each team's last competitive fixture.
6. **Fixture congestion** — matches played in the trailing 14 days, per team (captures squad fatigue from cup/continental overlap).
7. **Travel distance** — great-circle km since the away team's last fixture (matters more in continental competition and large countries like Brazil/Australia than in compact European leagues).
8. **Head-to-head decayed record** — last 5 meetings, BTTS rate and 1X2 outcome, exponentially weighted (recent meetings count more; a 5-year-old result shouldn't carry equal weight).
9. **League base rates as context features** — the competition's own home-win %, draw %, BTTS % (lets one global model implicitly learn "this league draws a lot" without needing a separate model per league).
10. **Team quality percentile within its own competition** — normalizes Elo across leagues of very different absolute scale (see cross-league calibration below).
11. **Stakes/importance flag** — derived from league position + games remaining (relegation six-pointer, title decider, dead rubber) — proxy this from table position deltas if you don't have a betting-market importance feed.
12. **Market-implied probability**, if you have an odds feed — the single highest-value feature available, but only use **pre-match closing odds**; never anything time-stamped after kickoff, or you leak the outcome.
13. **Squad rotation proxy** — % of last match's starting XI retained, only where lineup data exists; make this optional, not required (see §4).
14. **Shrinkage confidence** (`n_eff` from §2B) as a feature — teaches the model to widen its own uncertainty on thin-data teams instead of overfitting to noise.
15. **Scope-blended rating gap** (§1's domestic/continental blend, home minus away) — captures a team that's over-performing domestically but exposed by weaker continental form, or vice versa.

Train gradient-boosted trees (LightGBM is the right default for this size of tabular data — faster than XGBoost at comparable accuracy, and its native categorical handling is convenient for `league_id`/`competition_type`), with a multiclass softmax head for Home/Draw/Away rather than three separate binary models — a joint model keeps the three probabilities coherent (summing to 1) without post-hoc renormalization.

### Cross-league ELO when teams rarely meet

The honest answer is you can't get true global comparability from within-league results alone — a league with zero inter-league matches is a closed system with an unconstrained additive offset (everyone could be shifted up 200 points and every result would still be perfectly explained). You need bridge matches:

- **Continental club competitions are your primary bridge.** Champions League, Copa Libertadores, AFC Champions League, CAF Champions League — every match in these is a direct link between two otherwise-separate domestic rating pools. Run a joint Elo update across *all* competitions simultaneously (one global rating per team, updated by every match regardless of competition) rather than maintaining fully separate domestic Elo pools — the continental matches are exactly what pins the pools together on a common scale.
- **International tournaments as a secondary bridge**, at the *league-strength* level rather than club level: aggregate how a country's clubs' export talent performs in international duty, or more simply, borrow the approach UEFA already uses for its own club coefficients — compute a per-league strength multiplier from that league's teams' aggregate continental results (wins/draws/losses weighted by opponent league), then apply it as a scale correction when comparing two teams whose leagues have few or no direct connecting matches.
- **Model this explicitly as a graph problem, not a hope.** Build a graph where nodes are leagues and edges are inter-league fixture counts (continental competition matches). If two leagues you're trying to compare are in the same connected component with reasonable edge weight, a joint Elo fit is trustworthy. If they're weakly connected or disconnected, don't force a precise comparison — fall back to shrinking both toward their confederation-level prior and widen your uncertainty/confidence output accordingly rather than asserting false precision. This is the same principle as the AU NPL matching problem from earlier: better to flag "insufficient bridge data" than confidently produce a wrong number.
- **Refit periodically, not continuously.** A full joint Elo refit after each round of continental fixtures (not after every single match) keeps the cross-league scale stable; refitting on every match lets a single upset over-correct the whole system's relative calibration.

---

## 4. Data Quality & Missing Data in Smaller Leagues

**Tiered feature availability, not a single feature set.** Define explicit tiers based on what a competition actually reports:

- Tier A (top European leagues, some continental competitions): full — xG, shots, cards, lineups.
- Tier B (most professional leagues worldwide): scores, cards, corners, no xG.
- Tier C (lower divisions, some international/regional competitions — much of what got added to Pools this session, e.g. Gold Cup 2013, AFCON group stage): final score only.

**Let tree models handle missingness natively rather than imputing.** LightGBM/XGBoost both learn an optimal default split direction for `NaN` during training — leave xG-dependent features as true `NaN` for Tier B/C matches rather than filling with 0 or a league mean. Filling with 0 tells the model "this team recorded zero shots," which is a real (and wrong) signal, not an absence of one. Filling with a league mean silently understates uncertainty. A `NaN`, correctly handled, lets the split logic route those rows based on the features that *are* available.

**Cascade the feature set instead of dropping the match.** For a Tier C fixture, fall back through: xG differential (unavailable) → shots differential (unavailable) → goals-for/against rolling form (available) → league base rate (always available). Rather than branching model architecture per tier, add a `data_tier` categorical feature and let the single model learn tier-conditional behavior — this also lets it learn that Tier C predictions should sit closer to the league base rate, which is exactly the humility-blend principle already in `engine.js`'s `evaluateBTTS`.

**Scale shrinkage `k` to data sparsity, not a fixed constant.** `engine.js`'s `shrink(x, prior, n, k)` currently uses one `k` across leagues. For thin leagues, estimate `k` empirically from the *variance* of team stats within that competition (moment-matching: leagues where team quality is genuinely more homogeneous need less shrinkage; leagues with wild variance and few matches need more) rather than hand-tuning one global value that's a compromise between the Premier League and a 6-match international group stage.

**Surface confidence, don't hide it.** `engine.js` already has a `flags` array pattern (`'away'`, `'blow'`, `'f1'`, `'f2'`, `'f3'`) used to gate/warn on specific risk conditions. Extend this with a `data_confidence` flag derived from `n_eff` (§2B) + data tier + whether `rho`/decay parameters were fitted or fell back to a confederation default. A Tier C, low-`n_eff`, ungated prediction should visibly read as lower-confidence to the end user rather than presenting identical formatting to a Tier A Premier League prediction backed by hundreds of decayed matches — this is arguably a bigger differentiator than raw accuracy, since most public tipster models present every number with equal, unearned confidence.

---

## What actually differentiates this from a typical prediction site

Most public models: independent Poisson (no DC correction), single global shrinkage constant if any, no correlation-aware multi-leg math, and every prediction displayed with the same unwarranted confidence regardless of data depth. This system already beats that baseline on three of those four points. The highest-leverage next moves, in order: (1) fit `rho` and decay half-life per competition instead of hardcoding them — cheap, no architecture change, pure data-pipeline work; (2) add the scope-blended rating layer so continental/domestic form stop contaminating each other; (3) stack the existing DC engine's own output as an ML feature rather than replacing it — you keep the interpretable, already-working statistical core and let the ML layer catch what it structurally can't (fatigue, travel, stakes), instead of throwing away a working model to chase a black box.

### Suggested phasing

1. **Now, no infra change**: Python nightly job fits `rho`, decay-weighted `n`/stats, and confederation-level league-strength multipliers per league; pushes updated JSON that `engine.js` already knows how to consume. Zero client-side changes.
2. **When query complexity outgrows flat JSON** (cross-league joins, alias resolution, scope-blended ratings): stand up the Postgres schema above, populate it from the same openfootball/API sources already in use, and have the nightly job read from/write to it instead of hand-built JSON merges.
3. **Once the DB and decay/rho pipeline are stable**: layer the LightGBM 1X2 model on top, using DC engine output as a feature (item 4 in the top-15 list) rather than a separate, competing system.
