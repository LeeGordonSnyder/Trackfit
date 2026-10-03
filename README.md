# Trackfit

A personal workout tracker that runs in your browser. Build workouts in a table, pick one at the gym, press **Execute**, and log every set with its weight and how hard it felt. Everything is stored on your device (`localStorage`). There's no account and no server.

## Features

**Building workouts**
- A table of equipment/exercise, sets and reps. Rows can be reordered, added and removed, and exercise names autocomplete from ones you've used before.
- **Timed exercises:** put a time in the Reps column (`45s`, `1:30`, `2m`) and the exercise gets a countdown timer instead of a reps count.
- **Supersets:** tap 🔗 on a row to pair it with the row below. During the workout the app alternates sets between them and only starts the rest timer after each full round.

**At the gym**
- Tap a workout, then **▶ Execute**. Exercises are shown one at a time with a progress bar and a set counter.
- You must enter the weight before a set can be logged (0 for bodyweight). **Set done** has three buttons: **Easy / Medium / Hard**.
- **Warm-up sets:** flip the toggle and the set is logged but doesn't count toward sets, volume or PRs.
- **Auto-increase:** when every working set of an exercise felt Easy, its target goes up next time (+5 lb / +2.5 kg, adjustable). The target is shown with a one-tap **Use** button.
- **PR alerts 🏆** for heaviest weight, best estimated 1-rep max, most bodyweight reps, and longest hold.
- **Plate calculator:** shows which plates go on each side of the bar, with a picture.
- **Exercise notes** ("seat on 4") appear every time you do that exercise.
- Rest timer (+30s / skip, vibrates and beeps when rest ends). The screen stays awake, and a refresh never loses a workout in progress.

**Afterwards**
- A summary showing duration, sets, volume, PRs, your Easy/Medium/Hard breakdown, the "Next time" targets that went up, and a **session note**.
- **History** of every session.
- **Progress:** this week's workouts, week streak 🔥, sets and volume, workouts-per-week chart, and sets per muscle group. Each exercise has a chart (top weight / est. 1RM / volume, or longest hold), PRs, a muscle-group setting and past sessions.

**Your data**
- lb/kg, bar weight, and the auto-increase step in Settings.
- **Google Sheets (live, two-way):** every set goes into the Trackfit sheet seconds after you log it, through an Apps Script in that sheet. On open, the app loads from the sheet, so edits made there show up in the app, and a new phone gets everything back after signing in.
- **Password lock:** the site opens on a lock screen. The password is cell **Z100** of the sheet's Workouts tab, and changing it signs out every device. Details and setup: [`google-sheets/README.md`](google-sheets/README.md).
- Works offline and installs to your home screen (PWA).
- Dark theme with sunset-yellow accents. Fonts: Barlow / Barlow Condensed (SIL Open Font License, bundled in `fonts/`).

## Running it

It's a static site: `index.html`, `styles.css` and `app.js`, with no build step.

- **Locally:** `python3 -m http.server` in this folder, then open http://localhost:8000
- **On your phone:** host it with GitHub Pages (repo Settings → Pages → deploy from this branch). Open the URL in Safari/Chrome and choose *Add to Home Screen*.

> The Google Sheet is the source of truth: the app loads from it on open and sends every change back.
