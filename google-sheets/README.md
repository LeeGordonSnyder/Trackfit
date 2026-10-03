# Trackfit → Google Sheets (live)

Trackfit can send everything to your own Google Sheet, live. A set appears a couple of seconds after you tap Easy / Medium / Hard. A workout in progress shows in **Sessions** as "In progress" with a blank END until you finish it. If you discard it, its rows are removed.

Sending goes through a small Google Apps Script (`Code.gs`) that's attached to your sheet and runs under your Google account. Nothing goes through anyone else's server.

## One-time setup (about 2 minutes)

1. Open your sheet and go to **Extensions → Apps Script**.
2. Delete what's in `Code.gs`, paste in this folder's [`Code.gs`](Code.gs), and press **Save**.
3. Pick **setup** in the function dropdown and press **Run**. Allow access when Google asks. This creates the tabs (SetLog, Sessions, Workouts, Exercises). The **Execution log** then shows your **key**: copy it.
4. Go to **Deploy → New deployment**, choose the gear icon → **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone

   Press **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. In Trackfit, open **Settings → Google Sheets**, paste the URL and the key, and press **Connect & send**.

"Anyone" means anyone who has the URL can reach the script. The script ignores every request that doesn't carry your key. If the key ever leaks, run **resetKey** in the editor and paste the new key into Trackfit.

**Changed `Code.gs` later?** Go to **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

## Tabs

Each row is matched on its first column. Existing rows are updated in place, new ones are added, and rows for things you deleted in the app are removed. You can add your own columns to the right of the Trackfit columns (formulas, comments) and they'll be left alone.

| Tab | One row per | Columns |
|---|---|---|
| **SetLog** | set | ID, DATE, SESSION ID, WORKOUT, EXERCISE, MUSCLE, SET #, WARM-UP, WEIGHT, UNIT, REPS, SECONDS, DIFFICULTY, EST 1RM, VOLUME, PR, SUPERSET, TIMESTAMP |
| **Sessions** | workout done | ID, DATE, WORKOUT, START, END, DURATION (MIN), EXERCISES, WORKING SETS, VOLUME, UNIT, PRS, EASY, MEDIUM, HARD, NEXT TIME, NOTE, TIMESTAMP |
| **Workouts** | exercise in a saved workout | ID, WORKOUT ID, WORKOUT, ORDER, EXERCISE, SETS, REPS, TIMED, SUPERSET WITH NEXT, UPDATED |
| **Exercises** | exercise | EXERCISE, MUSCLE, NOTE, BEST WEIGHT, BEST EST 1RM, LONGEST HOLD (S), TARGET WEIGHT, UNIT, TARGET REASON, LAST DONE, SESSIONS, UPDATED |

Notes on the columns:
- `SET #` is blank for warm-ups.
- `VOLUME` is weight × reps for working sets.
- `EST 1RM` = weight × (1 + reps ÷ 30).
- Weights are in the `UNIT` of that row.

## Offline

If the phone has no signal, Trackfit remembers there are unsent changes. It sends them as soon as you're back online or the next time you open the app.
