# Pools — BTTS Goal Rush & Classic Pools Predictor

A personal, no-backend web app that runs the full Poisson / Dixon-Coles engine
(v3) for **Lottotech Goal Rush (BTTS)** and **Classic Pools**, straight in
your browser — works on desktop and phone, hosted free on GitHub Pages.

Nothing leaves your device: there's no server, no analytics, no account.
Everything you paste in is processed locally in JavaScript and saved to your
browser's local storage.

---

## 1 · Put this online (one-time setup)

You need a free GitHub account.

1. Go to [github.com/new](https://github.com/new) and create a new repository
   — call it something like `pools` (public, no README/license needed, this
   folder already has one).
2. On your computer, open a terminal in this folder and run:

   ```bash
   git init
   git add .
   git commit -m "Initial commit — Pools predictor"
   git branch -M main
   git remote add origin https://github.com/<your-username>/pools.git
   git push -u origin main
   ```

3. On GitHub, open the repo → **Settings → Pages**. Under "Build and
   deployment", set **Source: Deploy from a branch**, **Branch: main**,
   folder **/ (root)**. Save.
4. Wait ~1 minute, then refresh that Pages settings screen — it'll show your
   live URL, something like:

   ```
   https://<your-username>.github.io/pools/
   ```

5. Open that URL on your phone, add it to your home screen (Safari/Chrome →
   Share → "Add to Home Screen") and it behaves like a lightweight app icon.

No build step, no npm install — it's plain HTML/CSS/JS, so any future edit
you push to `main` goes live automatically within a minute.

---

## 2 · How to use it day to day

This mirrors the workflow already described in `07_DATA_PIPELINE.md`:
you (or Gemini, on your behalf) collect raw stats and paste them in; the app
does the maths.

1. **Research** — for the fixtures on your coupon, get each team's venue-split
   goals: home team's GF/GA *at home*, away team's GF/GA *away*, matches
   played. SoccerStats, FotMob/FBref and WinDrawWin search snippets are the
   sources that have actually worked (see the Data pipeline notes tab in the
   app). Never let Gemini hand you a BTTS percentage directly — raw numbers
   only.
2. **Paste** — format it as the JSON template (download it from the app, or
   see `07_DATA_PIPELINE.md`) and paste into the "Paste the board" box on the
   Goal Rush or Classic Pools tab. Do this for the **whole board** (all ~35 /
   ~49 matches), not just your shortlist — the scarcity/reward read and the
   league ranking both need the full picture.
3. **Read the recap table** — ranked by calibrated probability, with filter
   flags and a DROP/SAFE/watch verdict per leg, plus a league-ranking table
   showing which leagues on this board carry the most weight.
4. **Build the slip** — auto-pick or tick legs by hand. The app enforces nothing;
   it just tells you, honestly, whether your slip clears the discipline gate
   (≥8 legs at ≥65%, P(≥7/8) ≥15% conservative) or whether skipping is the
   right call.
5. **Save the ticket**, play it on Lottotech.
6. **Once matches are FT**, go to History & Calibration, paste the results
   JSON for that ticket, and grade it. This builds your own failure log and
   calibration table automatically — over time you'll see whether your 70%
   calls are actually landing ~70% of the time, and which leagues are
   over/under-performing their prior.

## 3 · Backup / syncing between phone and computer

There is no cloud sync. Local storage is per-browser, per-device. Use
**Backup → Export backup (.json)** after a session, then **Import backup**
on the other device to bring it up to date. Do this before switching devices
if you want continuity — otherwise each device just keeps its own history,
which is also a perfectly fine way to use it.

## 4 · What's under the hood

| File | Purpose |
|---|---|
| `index.html` | Page structure, five tabs |
| `css/style.css` | Mobile-first styling |
| `js/engine.js` | Poisson, Dixon-Coles 9×9 matrix, Bayesian shrinkage, zero-blend correction, humility blend, all BTTS filters (AWAY/BLOWOUT/F1/F2/F3), Classic Pools filters (GAP/XG/00/RUNAWAY), Poisson-binomial slip maths, correlated Monte Carlo — a direct JS port of `02_ENGINE_v3.py` |
| `js/data.js` | League base rates/priors, engine settings defaults, payout economics & Classic Pools reference tables — from `04_LEAGUE_BASE_RATES.md`, `05_PAYOUT_ECONOMICS.md`, `06_CLASSIC_POOLS.md`, `08_BTTS_DataStore_MASTER.json` |
| `js/storage.js` | LocalStorage persistence + JSON export/import |
| `js/app.js` | All UI wiring |

The three things the whole archive keeps coming back to, still true here:

1. **The away attack is the binding constraint on BTTS.** Below 0.80 GF/game
   away → hard drop, no matter how good the rest of the profile looks.
2. **Reward comes from board-wide scarcity**, not from a coupon merely
   containing a few hard legs — the app reads this from the *whole* board,
   not your shortlist.
3. **Skipping a coupon is a valid output.** The discipline gate will tell you
   to skip, and it will be right more often than it's wrong.

## 5 · Local testing (optional)

ES modules don't load over `file://`. To preview before pushing, serve the
folder locally:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## 6 · Editing later

- League priors and engine constants (ρ, shrinkage k, humility w, safe
  threshold, Classic Pools GAP/XG/00 thresholds, etc.) are all editable
  in-app under **Leagues & Settings** — no code changes needed to recalibrate.
- If you want to change the visual design or add a feature, `js/app.js` is
  the file that wires the DOM; `js/engine.js` is the only file that should
  ever need a maths change.
