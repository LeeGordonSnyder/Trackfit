# Trackfit → Google Sheets (live)

Trackfit can send everything to your own Google Sheet, live. A set appears a couple of seconds after you tap Easy / Medium / Hard. A workout in progress shows in **Sessions** as "In progress" with a blank END until you finish it. If you discard it, its rows are removed.

Sending goes through a small Google Apps Script (`Code.gs`) that's attached to your sheet and runs under your Google account. Nothing goes through anyone else's server. The site is password-locked, and the password lives in the sheet (see below).

## Setup

1. Open your sheet and go to **Extensions → Apps Script**. Replace everything in `Code.gs` with this folder's [`Code.gs`](Code.gs), then press **Save**.
2. Run **setup** once and allow access. It creates the tabs: SetLog, Sessions, Workouts and Exercises.
3. Type a password into cell **Z100** of the **Workouts** tab.
4. Deploy it. The web app's URL is built into Trackfit (`SHEET_URL` in `app.js`), so keep that same deployment:
   - **First time:** go to **Deploy → New deployment → Web app**, with execute as **Me** and access for **Anyone**. Then put the new URL in `SHEET_URL`.
   - **After changing `Code.gs`:** go to **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

## Password

- Trackfit opens on a lock screen. The password is whatever is in **Workouts!Z100**.
- The app never stores or sends the password itself, only its SHA-256 hash. The script hashes Z100 the same way and compares the two.
- Every request without the right hash is refused. That's what protects the sheet, because the web app URL can be found in the page source of a public site.
- **To change it,** edit Z100. Every device is asked for the new password the next time it reaches the sheet. Sets logged in the meantime stay on the phone and are sent after you sign in again.
- An empty Z100 refuses everything.
- After 20 wrong passwords in 10 minutes, the script pauses all sign-ins for 10 minutes.
- The script only writes in Trackfit's own columns and never adds or deletes whole rows, so Z100 and anything else to the right stays where it is.
- Anyone who can view the sheet can see Z100. You can hide column Z if you like (right-click → Hide column).

## Tabs

Each row is matched on its first column. Existing rows are updated in place, new ones are added, and rows for things you deleted in the app are removed. Only Trackfit's own columns are written. Cells further right are never touched, but they stay on their row number, so they won't follow a Trackfit row if rows above it are removed.

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
