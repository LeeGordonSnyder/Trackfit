# Trackfit

A personal workout tracker that runs in your browser. Build workouts in a table, pick one at the gym, press **Execute**, and log every set with its weight and how hard it felt. Everything is stored on your device (`localStorage`). There are no accounts and no server.

## Features

- **Workout builder:** a table of equipment/exercise, sets and reps. Reorder, add and remove rows, and exercise names autocomplete from ones you've used before.
- **Workout list:** tap a workout to preview it, then **▶ Execute**. You can also Edit, Duplicate or Delete it.
- **Guided execution:** one exercise at a time, with a progress bar and a set counter.
  - You must enter the weight before a set can be logged (enter 0 for bodyweight).
  - **Set done** has three buttons: **Easy / Medium / Hard**. Each logs the weight, reps and difficulty, then moves the set counter forward.
  - The weight carries over to your next set. Reps are prefilled from the target.
  - **"Last time" hint:** your previous sets for that exercise, plus a suggestion (go heavier if everything felt easy, hold if something felt hard).
  - Rest timer after each set (+30s / skip, vibrates and beeps when rest ends).
  - The screen stays awake while a workout is running. A workout in progress survives a refresh or closing the tab.
- **Summary and history:** duration, set count, total volume, and your Easy/Medium/Hard breakdown per session.
- **Settings:** lb/kg, rest timer length, and JSON **export/import backup**.
- Works offline and can be installed to your home screen (PWA).

## Running it

It's a static site: `index.html`, `styles.css` and `app.js`, with no build step.

- **Locally:** `python3 -m http.server` in this folder, then open http://localhost:8000
- **On your phone:** host it with GitHub Pages (Settings → Pages → deploy from this branch). Then open the URL in Safari/Chrome and choose *Add to Home Screen*.

> Data lives in the browser you use it in. Use **Settings → Export backup** now and then. Clearing site data or switching browsers or phones starts you fresh until you import a backup.
