# Deadlift Tracker

A personal training dashboard and workout logger, built as a static site
(vanilla JS + Firebase) so it can be hosted for free on GitHub Pages. It
replaces a Google Sheets–based deadlift program while staying architected
for multiple users, multiple programs, and future features (nutrition,
progress photos, coach/client relationships, etc.) without a rewrite.

**Status:** Firebase/auth/Firestore foundation, navigation, dashboard, the
three-layer workout model (template → programRun → immutable snapshot)
with idempotent Start/Resume and automatic programRun advancement, an
interactive mobile-first per-set logger with autosave, an admin-approval
access-control layer (see §7a), automatic new-user onboarding — a starter
program installs itself and the user is asked for their starting 1RMs,
with no Excel/Google Sheet/manual-import step required (see §15a) — a
free, manual JSON/CSV "Backup My Data" export, a read-only Admin
Dashboard/User Detail, and "Restore My Data" from that same JSON backup
(Phase 3F — see §7b's "Restore semantics" for exactly what restore does
and does not do) are all built.
Progression/PR detection/analytics (Phase 4) and the full in-browser
spreadsheet importer (Phase 5) are not yet built; their placeholder
screens say so.

---

## 1. Project overview

- **Frontend:** HTML5 + CSS3 + vanilla JS (ES modules), no build step, no
  framework.
- **Backend:** Firebase Authentication (Google Sign-In) + Cloud Firestore.
- **Hosting:** static files, deployable as-is to GitHub Pages.
- **Why no framework:** the app is small enough that a hash router and a
  handful of view modules cover it, and it keeps the project trivially
  hostable and easy to reason about for someone who isn't a full-time
  frontend developer.

## 2. Architecture

```
Browser (ES modules)
 ├─ js/core         Firebase init, auth, hash router, sync indicator
 ├─ js/services      Firestore reads/writes, one file per domain
 ├─ js/views         one module per screen, dynamically imported by the router
 ├─ js/components     shared UI (navigation shell)
 ├─ js/utils          pure functions — no Firebase imports
 └─ config/app.config.js   the ONE place for app name, Firebase config, defaults
        │
        ▼
Cloud Firestore (users/{uid}/...)      Firebase Authentication (Google)
```

Every user's data lives under `users/{uid}/...`. Firestore Security Rules
(see §7) are the actual enforcement — the frontend never relies on hiding
UI to keep data private.

**Three-layer workout model** (per the original requirement that changing a
template must never change history):

1. **Template** — `users/{uid}/programs/{programId}` + its `days`
   subcollection. Defines exercises, sets/reps, and load either as a fixed
   kg or a %1RM reference.
2. **Planned** — `users/{uid}/programRuns/{runId}`. Tracks which week/day
   you're currently on for a given program run. Targets are computed live
   from the template + your *current* 1RM, so nothing needs to be
   regenerated when a 1RM changes.
3. **Completed log** — `users/{uid}/workouts/{workoutId}`. Snapshots the
   exercise names, the calculation basis (e.g. "85% of 180 kg"), and every
   set actually performed, at the moment the workout was started/logged.
   Editing the template or your current 1RM later never touches this.

## 3. Folder structure

```
index.html                  single entry point (hash routing)
css/
  tokens.css                 color/type/spacing variables (dark theme)
  base.css                   reset, layout shell, nav
  components.css             buttons, cards, forms, stat grid
  views.css                  per-view tweaks
config/
  app.config.js               app name, Firebase config, defaults, routes — edit here
js/
  app.js                      bootstraps the shell + router
  core/
    firebase.js                Firebase init + Firestore offline persistence
    auth.js                     Google sign-in/out, auth state
    router.js                   hash router
    sync-status.js              online/offline/syncing indicator
  services/
    userService.js              profile, settings, 1RM history
    programService.js           program templates, seeding, programRuns
    workoutService.js           workout session queries (Phase 3 completes writes)
    measurementService.js       bodyweight logging
  views/
    login.js, home.js, profile.js, workout.js, history.js, progress.js,
    nutrition.js, notFound.js   (workout/history/progress are Phase 3/4 placeholders)
  components/
    navigation.js                bottom nav (mobile) / sidebar (desktop)
  utils/
    calculations.js              %1RM resolution, rounding, Epley e1RM, volume
    dates.js, validation.js
data/
  import-mapping.json           every documented spreadsheet correction/alias
  program.deadlift-8wk.json     the generated, reviewable program
scripts/
  generate_program.py           regenerates program.deadlift-8wk.json from the source xlsx
firestore.rules
firestore.indexes.json      composite indexes required by current queries (see §7)
firebase.json                points the Firebase CLI at the two files above
README.md
```

## 4. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Name it (e.g. `deadlift-tracker`). Google Analytics is optional — skip it for a personal app.
3. Once created, click the **`</>`** (web) icon to register a web app. Skip Firebase Hosting (you're using GitHub Pages).
4. Copy the `firebaseConfig` object it shows you.

## 5. Enable Google Authentication

1. Console → **Build → Authentication → Get started**.
2. **Sign-in method** tab → enable **Google**. Pick a support email.
3. Still on Authentication, go to **Settings → Authorized domains** and add:
   - `localhost` (usually already there, for local testing)
   - `USERNAME.github.io` (your GitHub Pages domain, once you know it — see §13)

## 6. Create Firestore

1. Console → **Build → Firestore Database → Create database**.
2. Start in **production mode** (the security rules in this repo are what actually protect the data — production mode just means Firebase doesn't add its own permissive default).
3. Pick a region close to you.

## 7. Deploy Firestore Security Rules and composite indexes

Install the Firebase CLI once:

```bash
npm install -g firebase-tools
firebase login
```

This repo already includes `firebase.json` (pointing at `firestore.rules` and
`firestore.indexes.json`), so you don't need to run the interactive
`firebase init` wizard — just associate the CLI with your project once:

```bash
firebase use --add          # pick your project, give it an alias like "default"
firebase deploy --only firestore:rules,firestore:indexes
```

You can also paste `firestore.rules` directly into **Firestore → Rules** in
the console and click **Publish** — no CLI needed for rules alone. Indexes,
however, are much easier to manage via `firestore.indexes.json` and the CLI
than by manually clicking the one-off links Firebase prints in the browser
console the first time each query runs — those links create the index for
you, but nothing records that it's now a permanent project requirement.
`firestore.indexes.json` is that permanent record; **re-run the deploy
command above whenever a new composite index is needed** (e.g. as Phase 3
adds new workout-history queries).

**What the rules do:** every read/write under `users/{uid}/...` requires
`request.auth.uid == uid` **AND** that caller's own `access/{uid}` record has
`status == 'approved'` (see §6a — authentication alone does not grant
access). 1RM history (`maxes`) is append-only (no update/delete) so a past
calculation basis can never be silently rewritten. Workout rules are
explicit about the one allowed lifecycle: create as `in_progress` or
`completed`; update only `in_progress → in_progress` (an autosave) or
`in_progress → completed` (finishing); delete only while still
`in_progress`. Once `completed`, a workout is permanent — no client update
or delete is accepted. Separately, `access/{uid}` itself only lets a normal
user create their own minimal pending request and read their own record —
approving/disabling anyone (including re-enabling) requires an already-
approved `role == 'admin'` caller; a normal user can never approve
themselves or grant themselves the admin role, even by editing their own
document directly.

**Composite indexes currently required** (all five are in
`firestore.indexes.json`):

| Collection | Fields | Used by |
|---|---|---|
| `workouts` | `status` ASC, `startedAt` DESC | resume-in-progress check |
| `workouts` | `status` ASC, `finishedAt` DESC | latest completed workout |
| `workouts` | `status` ASC, `finishedAt` ASC | "completed this week" count (range filter) |
| `workouts` | `status` ASC, `programId` ASC, `week` ASC, `dayOrder` ASC | legacy-position reconciliation lookup |
| `measurements` | `type` ASC, `date` DESC | latest bodyweight |

Single-field queries (`getActiveProgramRun`, `getProgramDays`,
`getMaxHistory`) don't need a composite index — Firestore indexes every
field individually by default.

## 7a. Access control: bootstrap the first admin (one-time)

Google Sign-In alone no longer grants access. Every signed-in user needs an
`access/{uid}` document with `status: 'approved'` before they can read or
write any fitness data (`users/{uid}/...`) — enforced by the rules above,
not just the app's UI. A brand-new Google user gets a `pending` record
created automatically on first sign-in and sees a "waiting for approval"
screen; an admin then approves them from the in-app **Admin** tab.

That creates a chicken-and-egg problem for the very first admin: nothing in
the client ever grants the `admin` role, on purpose (see `firestore.rules` —
a user can never approve themselves or escalate their own role). The fix is
a one-time manual step in the Firebase console, which is not subject to
these rules at all (console access is governed by your Firebase project
permissions, not Firestore Security Rules):

1. Firebase Console → **Firestore Database → Data**.
2. Find your **uid**: open the existing `users` collection — your account's
   existing document ID *is* your uid (you already have exactly one, from
   before this phase).
3. Create a new top-level collection named `access` (if it doesn't exist
   yet) and add a document with that **exact uid** as its document ID.
4. Give it these fields:
   - `uid` (string) — the same uid
   - `email` (string) — your Google account email
   - `displayName` (string) — your name (optional, cosmetic only)
   - `photoURL` (string) — optional, can be left blank
   - `status` (string) = `"approved"`
   - `role` (string) = `"admin"`
   - `approvedAt` (timestamp) — any value, e.g. the console's "current date" picker
   - `approvedBy` (string) — e.g. `"bootstrap"`
5. Deploy the rules in this repo (`firebase deploy --only
   firestore:rules,firestore:indexes` — see §7) **before or immediately
   after** this step. Until both the bootstrap doc and the new rules exist
   together, the account is either fully locked out (rules deployed, no
   bootstrap doc yet) or unprotected (bootstrap doc exists, old rules still
   live) — the window is only as long as it takes you to do both steps.
6. Deploy the updated app files (GitHub Pages). Sign in as yourself — you
   should land straight in the app with an **Admin** tab, no pending screen.

After this one-time step, all further approvals/disables happen entirely
through the in-app Admin screen — there is no ongoing "first user becomes
admin" mechanism, by design.

**This does not touch, delete, or re-seed any existing data.** Your
existing `users/{uid}` document (program, programRun, workouts, maxes,
bodyweight, settings) is untouched by creating the `access/{uid}` document —
they're separate top-level collections. The next time you sign in as the
now-approved admin, `ensureUserProfile` runs its normal "already exists, just
bump `lastLoginAt`" path, exactly as it always has.

## 7b. Backup & Recovery

**Decision (Phase 3E): no paid or automated cloud backup infrastructure is
used.** An earlier draft of this section documented a Firestore Scheduled
Backups + `gcloud` setup; that has been deliberately removed in favor of a
**free, manual, user-triggered backup model**. If you're looking at an
older copy of this project with a `scripts/backup/` folder full of
`gcloud` scripts, those are gone — delete them if you still have them.

**The current model, in one sentence:** the JSON export already built for
Profile → Backup & Data (Phase 3D) *is* the canonical backup format. There
is currently no server-side, automatic, scheduled, or admin-triggered
backup running anywhere — backups exist only when a user downloads one.

### How backups work today

Every approved user has a **Backup & Data** card on their Profile screen
with:

- **Backup My Data (JSON)** — the canonical, complete backup of that
  user's own data. This is the file to keep safe; it's the one shape
  **Restore My Data** (Phase 3F — see "Restore semantics" below) reads.
- **Export Workouts CSV**, **Export Measurements CSV**, **Export Max
  History CSV** — supplemental exports for viewing or analysis in a
  spreadsheet app (Excel/Sheets/Numbers). These are for *humans reading
  the data*, not for restoring it — they deliberately don't carry the full
  nested shape (immutable snapshot structure, schemaVersion, restore
  invariants, etc.) that the JSON backup does.

Each button downloads a file straight to the device's normal downloads
location — there's nothing to configure, no billing, no cloud project
setup, and nothing running in the background. See `js/services/
exportService.js`, `js/utils/exportFlatten.js`, and `js/utils/csv.js` for
the implementation — they're small and heavily commented.

**What this means in practice:**

- Backups are **user-initiated only**. If a user never taps "Backup My
  Data," no backup of their data exists anywhere outside the live
  Firestore database itself.
- There is **no automatic, scheduled, or admin-side backup** of any kind.
  If you want defense against database loss/corruption beyond what
  Firestore itself already guarantees (durable, replicated storage), that
  is a deliberate scope decision for a future phase, not something this
  app currently does.
- **"Restore My Data" exists (Phase 3F)** — see "Restore semantics" below
  for exactly what it does and does not do; it is not a byte-exact
  replacement of everything in the account.

### JSON backup schema (schemaVersion: 1)

Unchanged in shape from Phase 3D (still `schemaVersion: 1` — a Phase 3D
backup file and a Phase 3E backup file are both valid, compatible files):
`{ schemaVersion, exportedAt, exportedBy, app, consistencyNote,
restoreInvariants, account, profile, programs: [{ ...fields, days: [...] }],
programRuns, workouts, maxHistory, measurements, records,
progressionSuggestions, nutrition }`. See the Phase 3D report / `js/
services/exportService.js` for the full field-by-field shape, timestamp
representation, and numeric-field guarantees.

**Since Phase 3E: `restoreInvariants`** — the export embeds, as plain text
inside the JSON file itself, the constraints the restore implementation
(Phase 3F — see "Restore semantics" below) follows. These are also
documented in `exportService.js`'s module comment. In short:

1. A restore writes only into the **currently authenticated** user's own
   `users/{uid}/...` namespace — **never** a uid read from the backup
   file. `exportedBy.uid` is provenance (whose backup this originally
   was), never a write target.
2. A restore **never** creates, deletes, or otherwise touches a Firebase
   Auth user — identity/authentication is out of scope for a Firestore-
   data restore.
3. A restore **never** changes the authenticated user's own uid.
4. A restore **never** restores `role`/`status`/admin privileges, or any
   other access-control authority, from the backup's `account` block.
   That block is informational-only (it already excludes
   `approvedBy`/`disabledBy` — see `exportService.js`'s
   `fetchAccountRecord`); role/status is governed exclusively by the live
   `/access/{uid}` document and `firestore.rules`, never by a JSON file a
   user could hand-edit.

**Why this matters:** a backup file is something a user can open in a
text editor. Without these invariants enforced in code — not just
documented — a restore feature could be tricked (by an edited file) into
writing to another uid's data, or into self-granting `role: "admin"` — the
same class of privilege-escalation-via-client-input that firestore.rules'
`/access/{uid}` create/update rules (§7a) already guard against for the
live app. `js/utils/restorePlan.js`/`js/services/restoreService.js`
(Phase 3F — see "Restore semantics" below) are that enforcement: every
invariant above is a structural test assertion against those files, not
just a comment.

### Restore semantics (Phase 3F)

Profile → **Restore My Data (JSON)** reads one of your own "Backup My
Data" files back into Firestore, enforcing every invariant above in code
(`js/utils/restorePlan.js` — pure/testable — and `js/services/
restoreService.js` — the Firestore I/O). It is **not** a byte-exact
"delete everything, recreate from the file" operation, and the UI does
not claim it is. Two of firestore.rules' existing data-integrity
guarantees (§7a) are deliberately never weakened to make restore more
"complete":

- **`maxes` (1RM history) is append-only** (`allow update, delete: if
  false`) — restore only ever *adds* a backup's history entries that
  aren't already present; it never deletes an existing one. Your
  `currentMaxes` cache (Profile's "Current 1RM values") *is* fully
  overwritten to match the backup, so the values you actually train
  against are always correct even though the underlying history list is
  additive-only.
- **A completed workout is permanent** (cannot be updated or deleted once
  `status: 'completed'`) — restore leaves any completed workout already in
  your account untouched if it isn't in the backup, and skips (rather than
  overwrites) one that already exists with a matching id. An in-progress
  workout not in the backup, or with a different id, is replaced normally.

Everything else the backup contains — programs, program days,
programRuns, measurements — is fully replaced to match the backup exactly
(any existing document absent from the backup is removed). `/access/{uid}`
(role/status/admin) is never read or written by restore, matching
invariant 4 above. The in-app confirmation screen and success message
describe this in plain language before and after every restore; see
`js/views/profile.js`.

### CSV exports

Same three CSVs as Phase 3D (Workouts — one row per logged **set**,
Measurements, Max History), RFC-4180-correct escaping, unchanged. These
are explicitly **not** the backup format — they're flattened/lossy by
design (e.g. a workout's full nested snapshot structure doesn't round-trip
through a flat CSV row) and exist purely so the data is easy to open and
look at in a spreadsheet.

## 8. Firebase web configuration

Open `config/app.config.js` and replace the placeholder `FIREBASE_CONFIG`
object with the one copied in step 4:

```js
export const FIREBASE_CONFIG = {
  apiKey: '...',
  authDomain: '...',
  projectId: '...',
  storageBucket: '...',
  messagingSenderId: '...',
  appId: '...',
};
```

This file is the **only** place Firebase config or the app name should
appear. These values are safe to be public in client-side code — they
identify your project, they don't grant access. Access control is the
Security Rules in §7.

## 9. Local development

No build step, but ES modules and `fetch()` need to be served over
`http://`, not opened as a `file://` URL. Any static file server works:

```bash
cd deadlift-tracker
python3 -m http.server 8080
# or: npx serve .
```

Visit `http://localhost:8080`. Sign in with Google — this creates your
`users/{uid}` profile document automatically on first login.

## 10. Google Sheet import (how it actually works)

The spreadsheet is **not** read live by the running app. It was converted
**once**, offline, into `data/program.deadlift-8wk.json` by
`scripts/generate_program.py`, and every non-literal interpretation (unit
corrections, exercise-name merges, ambiguous prescriptions) is recorded in
`data/import-mapping.json` so it stays auditable and editable rather than
buried in parser code.

To regenerate it (e.g. after fixing something in `import-mapping.json`):

```bash
cd scripts
python3 generate_program.py \
  --source /path/to/Deadlift_210_220_Final.xlsx \
  --mapping ../data/import-mapping.json \
  --out ../data/program.deadlift-8wk.json
```

The script prints any `importReviewFlags` it produced — items it
deliberately did **not** guess about, e.g. whether "Deficit / Snatch-grip
Deadlift" on Day 3 is the same movement as Day 1's block-programmed SGDL.

**Getting it into Firestore (as of Phase 3E): fully automatic, not a
manual upload.** There is no "Import" button in the app anymore — see
§15a for the automatic new-user onboarding flow that installs this exact
JSON as a user-owned program the moment someone signs in approved with no
program yet. The underlying installer (`seedDeadliftProgramForUser` in
`js/services/programService.js`) still reads this JSON and writes it to
`users/{uid}/programs/...` using the signed-in user's own authenticated
session — no admin SDK or service account needed, and it's blocked from
touching any other user's data by the same security rules as everything
else — it's just triggered automatically now instead of from a Profile
button.

A full in-browser importer (upload any `.xlsx`, get a live preview, fix
flagged items in the UI) is planned for Phase 5, for adding/authoring a
*second* program — not needed for the packaged starter program covered
here.

## 11. GitHub repository setup

```bash
cd deadlift-tracker
git init
git add .
git commit -m "Phase 2: Firebase foundation, auth, dashboard, program import"
git branch -M main
git remote add origin https://github.com/USERNAME/REPOSITORY.git
git push -u origin main
```

Add a `.gitignore` with at least:
```
.DS_Store
node_modules/
```

Your real `FIREBASE_CONFIG` values in `config/app.config.js` are fine to
commit — see the note in §8.

## 12. GitHub Pages deployment

1. Repository → **Settings → Pages**.
2. **Source:** Deploy from a branch → branch `main`, folder `/ (root)`.
3. Save. Your app will be live at `https://USERNAME.github.io/REPOSITORY/`.

The app already accounts for not being hosted at the domain root:
- `index.html` uses **relative** paths (`css/...`, `js/...`).
- Routing is **hash-based** (`#/home`, `#/workout`, …), so a full page
  refresh on any screen still works — GitHub Pages serves `index.html` for
  the base path and the hash is resolved client-side, with no server
  rewrite rules needed.

## 13. Add the GitHub Pages domain to Firebase Authentication

Back in Firebase Console → **Authentication → Settings → Authorized
domains → Add domain**, add exactly:

```
USERNAME.github.io
```

(not the full path with `/REPOSITORY/` — just the domain). Without this,
Google Sign-In will fail with an `auth/unauthorized-domain` error once
you're not on `localhost` anymore.

## 14. Firestore schema (current)

```
users/{uid}
  uid, displayName, email, photoURL, createdAt, lastLoginAt, schemaVersion
  settings: { units, rounding: {barbell, dumbbell, machine, bodyweight} }
  trainingProfile: { bodyweight, height, trainingGoal }
  currentMaxes: { [exerciseId]: { kg, kind, updatedAt } }   // cache only

users/{uid}/maxes/{id}                 append-only 1RM history
  exerciseId, kg, kind ('tested'|'training'), effectiveDate, source

users/{uid}/programs/{programId}       template (layer 1)
  name, sourceFile, roundingRules, weeks[], exerciseLibrary[], importReviewFlags[]
  version?, importSource? ('json'|'csv'), importedAt?, notes?, decisionRules[]?  // v1.1, optional

users/{uid}/programs/{programId}/days/{dayId}
  order, name, sections: { warmup, main[], accessory[], cooldown }

users/{uid}/programRuns/{runId}        planned (layer 2)
  programId, startDate, current: {week, dayOrder}, status, overrides{}

users/{uid}/workouts/{workoutId}       completed log (layer 3) — Phase 3 writes these
  status, runId, program/week/day name snapshots, startedAt, finishedAt,
  durationSec, exercises: { entryId: {...sets[]} }
  sets[]: plannedKg, plannedReps (frozen plan), actualKg, actualReps, rpe, note,
          completed, completedAt, status? ('completed'|'modified'|'failed'|'skipped') // v1.1

users/{uid}/records/{exerciseId}       derived PR cache — Phase 4
users/{uid}/progressionSuggestions/{id}  — Phase 4
users/{uid}/measurements/{id}          type, value, unit, date, note
users/{uid}/nutrition/{date}           reserved, unused in v1
```

## 15. How to create additional workout programs

**v1.1: use Program → Import Program** (JSON or CSV) — see §20. The
notes below describe the older, code-level route.

Nothing about the schema is deadlift-specific. To add a second program:

1. Build (or generate) a program JSON matching the shape in
   `data/program.deadlift-8wk.json` — `weeks[]`, `days[]`, each day's
   `sections.main/accessory` items using a `load` of type `percent`,
   `percentRange`, `fixed`, `sets`, `bodyweight`, or `none`.
2. Call `seedDeadliftProgramForUser`-style logic (generalize it to
   `seedProgramForUser(uid, jsonPath)` — it's already written generically,
   just named for this first program) pointing at the new JSON.
3. The dashboard's `listPrograms()` already returns every program a user
   has; Phase 3+ can add a program switcher once there's more than one to
   choose between.

## 15a. Automatic new-user onboarding (Phase 3E)

New users don't touch the original Excel workbook, a Google Sheet, or an
"Import" button — there isn't one anymore. The flow is fully automatic:

1. **Sign-in and approval work exactly as before** (§7a) — Google
   Sign-In, then an admin approves the pending request.
2. **The moment a user's access is confirmed `approved`**
   (`js/core/access.js`), and only then, two things happen automatically,
   before the app's normal screens render:
   - `ensureStarterProgramForUser` (`js/services/programService.js`)
     checks whether this user has **any** program or programRun at all.
     If they have neither, it installs a **user-owned copy** of the
     built-in Deadlift Focused 8-Week program (the same normalized JSON
     described in §10 — nothing is recreated by hand, nothing goes back
     to the original spreadsheet) under `users/{uid}/programs/...`, and
     creates its first programRun positioned at Week 1 / the first
     actual ordered training day (read from the template's own `order`
     values — never a hardcoded day count, so this works unchanged if
     the packaged program's day structure ever changes). If the user
     already has ANY program (this starter or otherwise), this step does
     nothing at all.
   - `getMissingRequiredMaxes` (`js/services/userService.js`) checks
     which of the four lifts the starter program needs a working 1RM for
     — Deadlift, Back Squat, Romanian Deadlift, Bench Press (OHP is
     never included) — the user doesn't have a `currentMaxes` value for
     yet.
3. **If any of those four are missing**, the user sees a short one-time
   onboarding screen (`js/views/onboarding.js`) asking only for the
   missing ones — never re-asking for a value already set, whether that
   value came from onboarding, a manual Profile edit, or (for an
   existing pre-3E account) however it was originally entered. Saving
   uses the exact same `recordOneRepMax` path Profile's own "Current 1RM
   values" form uses (a `maxes` history entry plus the `currentMaxes`
   cache update) — no parallel storage model. The screen is gated the
   same way the pending/disabled screens are: whatever route was
   requested, this is what renders until it's resolved.
4. **Once all four are present**, the app proceeds to Home/Workout/etc.
   normally — the gate simply stops re-triggering.

**Idempotency:** a refresh, a slow network, or two tabs racing on first
sign-in cannot create a duplicate starter program or a duplicate
programRun. The program keeps its usual deterministic id (the installer
upserts, never duplicates); the programRun uses a fixed id
(`starter-run`) rather than an auto-generated one, so two concurrent
calls can only ever upsert the *same* two documents, never create a
second one. See the docstring on `ensureStarterProgramForUser` for the
full reasoning.

**What is never seeded automatically:** the packaged program JSON's
`currentOneRepMaxesAtImport` field (Deadlift 205 / Back Squat 160 /
Romanian Deadlift 130 / Bench Press 130 in the current file) is the
*original importing user's own* historical 1RM data, kept in the file as
a record of what that first import looked like — it is never copied into
a new user's `currentMaxes` (a bug present in the pre-3E "Import"/"Update
imported program" buttons' seeding logic, fixed as part of this phase)
and never used as a dashboard display fallback either. A brand-new user
always sees their own entered values, or a plain "—", never someone
else's numbers.

**Existing users are completely unaffected.** Any account that already
has a program (everyone who used the app before this phase) has
`existingPrograms.length > 0`, so `ensureStarterProgramForUser` returns
immediately without writing anything, and `getMissingRequiredMaxes`
already returns an empty list for anyone with all four values on file —
both add nothing but one cheap read per sign-in for such an account.

## 16. Future development ideas

Already accounted for in the schema so these don't require breaking
changes: multiple concurrent programs, a visual program builder, custom
user-defined exercises (the exercise library is per-user, not global),
full nutrition tracking (`nutrition/{date}` reserved), progress photos and
body measurements (`measurements` isn't bodyweight-only), training
readiness/RPE trends, and coach/client relationships (would add a
`coachUid` reference and rules allowing a second uid read access to a
specific athlete's data). Personal CSV/JSON export is now built (§7b); a
matching "Import My Data" feature, built on the same schemaVersion-ed
export shape, is a natural future addition but is explicitly out of scope
for this phase.

---

## Known limitations (current)

- Per-set logging has no rest timer and no "previous performance"
  comparison yet — both are deferred, along with PR detection and
  progression suggestions (Phase 4).
- History and Progress screens are still placeholders (Phase 4).
- Finishing the final workout of the final week sets `programCompleted:
  true` on the programRun (see §14) but there's no dedicated "program
  complete" screen yet — Home/Workout degrade to showing `days[0]` or `—`.
  Manual repeat/skip/move controls (`advanceProgramRun`) exist in
  `programService.js` but aren't wired to any UI yet.
- Autosave writes the whole `exercises` array per save (Firestore has no
  per-array-element update); debounced for typed fields, immediate for
  completion taps and for the one-time backfill of any workout started
  before per-set logging existed.
- **Access control is enforced by Firestore rules, but only verified by
  static/manual inspection here — not by an actual emulator or browser run**
  (no Firebase Emulator was available in this environment). Run the browser
  smoke-test sequence from the Phase 3C access-control report before
  trusting this in production with a second real user.
- **There is no automated/scheduled backup of any kind (§7b, by
  deliberate Phase 3E decision)** — a user's own "Backup My Data" JSON
  download is the only backup that exists, and only once they've actually
  tapped that button. If that's not enough protection for your situation,
  building an automated mechanism is a deliberate future decision to make,
  not something silently covered already.
- The personal JSON/CSV export (§7b, Profile → Backup & Data) was
  validated with pure/static tests (serialization, CSV escaping, row
  flattening) against hand-built sample data, not against a live Firestore
  project or in an actual browser — see the Phase 3D report for exactly
  which tests were run.
- **Restore (§7b "Restore semantics") is implemented but deliberately not a
  byte-exact replace**: 1RM history is additive-only and a completed
  workout already in your account is always preserved, even if it isn't in
  the backup being restored — see §7b for exactly what is and isn't
  replaced, and why. It was validated with pure/structural tests (backup
  validation, restore planning, immutability/preservation behavior — see
  the Phase 3F report) against hand-built fixtures, not against a live
  Firestore project or in an actual browser (no Firebase Emulator was
  available in this environment).
- A device that cached "approved" access before being disabled, then goes
  fully offline, can still browse its locally-cached fitness data until it
  next reconnects (any writes queued in that window are rejected by the
  rules once sync resumes, but reads of already-cached data are not
  retroactively hidden). Inherent to any offline-first client + server-
  enforced-rules design; not fixed in this phase.
- Authoring a **second** program still means hand-building a JSON file
  (§15) — there's no in-browser `.xlsx` upload with live preview yet
  (Phase 5). The **starter** program (§15a) no longer needs any of that:
  it installs itself automatically for a new user.
- Three spreadsheet prescriptions are explicitly unresolved by design —
  see `data/import-mapping.json` → `ambiguousPrescriptions`, and the
  dashboard/profile screens surface them as review flags.
- New-user onboarding (§15a) was validated with pure/static tests
  (existing-user skip, new-user install, idempotency reasoning, no
  Marko's-maxes leakage, partial-maxes handling) against hand-built data,
  not against a live Firestore project or in an actual browser — see the
  Phase 3E report for exactly which tests were run.
- Single-tab Firestore persistence: if you open the app in two browser tabs
  at once, only one stays live-synced. Fine for solo use; documented here
  in case that changes.

---

## 17. Phase 5A baseline checkpoint (frozen before Phase 5B)

This section records the exact, real-Chrome-accepted state of the app at
the close of Phase 5A ("PWA + reliable offline workout mode"), immediately
before Phase 5B ("Workout Intelligence" — PR detection, tested/current/
estimated 1RM separation, trends, suggestions) begins. Nothing described
here is speculative — every line was manually verified in a real Chrome
browser against the real Firebase project, not merely by this project's own
automated test suites (which use hand-written Firestore test doubles with
no network path to a real backend — see below).

**Service worker / cache**: `sw.js`'s `CACHE_VERSION` is **v13**. v13 is a
version-alignment bump only (no shell asset differs in content from v12) —
it exists so a fresh install computes the same cache name a real-Chrome
update-flow test already exercised end-to-end: existing worker active ->
`sw.js` changed -> new worker appears "waiting to activate" -> the app's own
"Update available. Reload" banner appears -> clicking Reload activates the
new worker -> app loads normally, with no manual `skipWaiting()` or cache
clearing needed. Do not bump this version again unless a precached shell
asset's content genuinely changes.

**Offline workout lifecycle** (Correction Passes 5–10) — real-browser
accepted for all four terminal states:
- fresh offline Start (does not hang on "Starting…"; survives offline F5;
  Home -> Resume works offline; reconnect syncs; no duplicate workout)
- fresh offline Partial Finish (some but not all sets logged)
- fresh offline explicit Skip (with a reason, correctly distinguished from
  a zero-set Not Logged in History)
- fresh offline zero-set Finish ("Not Logged", correctly distinguished from
  an explicit Skip)

All four: terminal state applies exactly once, program position advances
exactly once, `activeWorkoutId` clears exactly once, no duplicate workout,
survives offline F5, reconnect does not advance a second time. The
underlying architecture (see `js/services/workoutService.js`'s own doc
comments on `startOrResumeWorkout`/`finalizeInProgressWorkout`) never
depends on a Firestore write's own Promise or on any specific `onSnapshot`
listener behavior for correctness — both are backend-ack-gated and/or
unverified against the real SDK from this project's sandboxed test
environment, so control flow uses only data already known in memory.
**This architecture must not be changed casually** — see those functions'
own doc comments before touching either one.

**Responsive layout**: real-device tested (Samsung Galaxy S25+) at 384x830
and a 320x830 stress test. The one issue found — 7-item bottom-nav label
crowding at 320px — is fixed via a `@media (max-width: 340px)` rule in
`css/base.css` that visually hides (not `display:none`) nav labels while
keeping icons, accessible names, and active-state indication; 384px and
wider, and the 900px+ desktop sidebar layout, are unaffected.

**PWA**: manifest-driven installability confirmed in real Chrome (name,
short name, standalone display, portrait orientation, 192/512px icons,
address-bar "Install" action). The modern `mobile-web-app-capable` meta tag
is present in `index.html` alongside (not replacing) the existing
`apple-mobile-web-app-*` tags. Firestore persistence is
`persistentLocalCache` + `persistentSingleTabManager` — unchanged, by
deliberate choice (see §"Known limitations" above); a persistence-fallback
warning when multiple tabs/windows are open is this configuration's own
documented, expected trade-off, not a defect.

**Deferred to final pre-publish acceptance** (not yet tested, do not treat
as accepted):
- actual PWA installation and standalone-window launch
- final GitHub Pages deployment/subpath behavior
- final production-URL installability
- final `manifest.webmanifest` `id` decision (depends on the final
  deployment URL — do not guess it before then)

**Future task — owner-account clean-reset (not implemented)**: before the
owner begins real training use, a controlled clean-start capability is
needed to: remove test workout/history/progress data; remove test
measurements if requested; reset the program run's `current` position to
Week 1 / the first day; clear any stale `activeWorkoutId`; preserve
authentication/access/admin role; preserve the desired program/template;
preserve current 1RMs unless explicitly choosing otherwise; and avoid
orphaned documents or an inconsistent programRun state. This should be a
safe, explicit, confirmation-gated destructive operation implemented in the
app itself — **not** a manual Firestore console deletion spree — and is
intentionally deferred to its own future task rather than bundled into this
checkpoint.

**Phase 5B, Package 1** ("PR Model + Detection + 1RM Separation") has now
been implemented on top of this baseline — see the next section. The rest
of Phase 5B (deeper trend visualizations, an explicit confirmation-gated
"Update Current 1RM" action, any further Progress redesign) remains
deferred to a future package.

## 18. Phase 5B, Package 1 — PR detection + Current/Tested/Estimated 1RM separation

**Domain model** (`js/utils/prAnalytics.js`, pure/Firebase-free, same
architectural split as `progressAnalytics.js`): three distinct concepts,
never conflated —
- **Current 1RM** — the existing, 100% user-controlled programming max
  (`users/{uid}.currentMaxes`, written only via
  `js/services/userService.js`'s `recordOneRepMax`). Completely untouched
  by this package: nothing added or changed here ever calls it,
  `prAnalytics.js` has no Firebase import at all, and program prescriptions
  still resolve exactly as before.
- **Tested/Actual PR** — derived from actually-lifted, completed working
  sets only. A true single (`actualReps === 1`) is a **Tested 1RM PR**
  candidate; any weight at any rep count can be a **Weight PR**; a specific
  rep count (e.g. every 8-rep set ever done) has its own independent
  **Rep PR** category.
- **Estimated 1RM** — Epley, reusing the exact existing
  `calculations.js`/`progressAnalytics.js` formula and rep cap
  (`EST_1RM_MAX_REPS`, ≤12), computed ONLY from multi-rep sets
  (`reps` in `[2, 12]`) — true singles are deliberately excluded from this
  category and folded entirely into Tested 1RM instead, so the exact same
  set can never produce both an "Estimated" and a "Tested" badge for what
  was actually a real, not estimated, lift.

**Baseline vs. PR**: the very first qualifying value in any category (per
exercise, per category — Weight/Tested/Estimated/each individual rep count
all baseline independently) is a **Baseline**, never a PR; a strictly
higher later value in that same category is a **PR**; equal or lower
produces no event. A workout is compared only against STRICTLY EARLIER
workouts, so a workout can never be judged against its own sets, and
several improving sets within one workout collapse into exactly one event
(the workout's own best qualifying set).

**Exercise identity**: grouped by the existing `exerciseId` schema field
only (never a display-name string match) — reuses the same identity rule
`progressAnalytics.js`'s per-exercise series already established, so
Deadlift/Romanian Deadlift/Snatch-Grip Deadlift/Deficit Deadlift/Back Squat
etc. can never be accidentally combined.

**No second mutable PR database**: every PR/Baseline event is derived
fresh from whatever completed-workout documents are already fetched
(`listCompletedWorkouts`) — no new Firestore collection, no write path, no
stored PR flag on any set/workout. Editing a completed workout within its
existing edit window (`updateCompletedWorkoutLog`) is reflected the very
next time this recomputes, because there is nothing stored to go stale.

**Offline**: purely read/derive/display — no write was added anywhere on
the offline Finish/Skip/Start critical path (`workoutService.js` is
untouched by this package). History and Progress compute PR events from
data they already fetch through the existing offline-safe `getDocsSafe`
path; a computation failure is caught and logged, never blocking the rest
of either screen from rendering.

**UI**:
- History list: a compact `PR`/`N PRs` badge (`.badge-pr`, using the
  previously-unused `--pr-glow` token from `css/tokens.css`) — counts only
  genuine PR events, never Baselines.
- History detail: one line per PR established in that workout, e.g.
  "Deadlift — Tested 1RM PR: 210 kg" / "Bench Press — 8-rep PR: 105 kg × 8"
  / "Deadlift — Estimated 1RM PR: 209 kg (from 190 kg × 3)" — Tested vs.
  Estimated is unambiguous in the text itself, never color-only.
- Progress: a Current 1RM / Best Tested 1RM / Best Estimated 1RM summary
  row (reuses the existing `.stat-grid`/`.stat-card` layout, no new CSS
  layout invented) per selected exercise, a passive text-only suggestion
  when a Tested/Estimated result exceeds the on-file Current 1RM (no
  "Update Current 1RM" action button in this package — deliberately
  deferred to control scope), and a short "Recent PRs" list. Progress now
  reads `currentMaxes` (via the existing `getUserProfile`) for DISPLAY
  only — still zero mutation capability anywhere in this file.

**Files changed**: `js/utils/prAnalytics.js` (new), `js/utils/
progressAnalytics.js` (3 existing internal helpers exported for reuse, no
behavior change), `js/views/history.js`, `js/views/progress.js`,
`css/views.css` (new `.badge-pr`/`.pr-detail-list`/`.pr-recent-list`/
`.pr-suggestion` rules only), `sw.js` (new module added to the precache
list; `CACHE_VERSION` bumped `v13` → `v14` — a genuine content change, not
alignment-only). No protected file touched.

**Test coverage**: a new `test_phase5b.mjs` (31 checks at initial delivery,
43 after the correction below) covers every case this package's own spec
required — Baseline vs. PR, equal/lower singles, multi-rep Estimated PR,
rep-specific PR, warmup/incomplete/skipped/not-logged exclusion,
partial-workout inclusion, same-workout collapsing, inactive-program
history inclusion, edited-workout recomputation, Current 1RM never
auto-mutating, no OHP introduced, and malformed/legacy data safely ignored
— plus the full pre-existing Phase 5A regression suite (`test_phase5a.mjs`,
76 checks) was re-run and passes unchanged.

### Real-browser acceptance correction (cache v14 → v15)

Real Chrome/Firebase acceptance of the initial Package 1 delivery (above)
found two semantic bugs, both now fixed:

1. **Progress suggestion wording**: it called a first-ever Tested/Estimated
   result a "PR" whenever it merely exceeded Current 1RM — but a first-ever
   result can be a *Baseline* (no prior history to beat) while still
   numerically exceeding Current 1RM (e.g. Current 1RM 40 kg, first-ever
   Bench single 55×1 — a Baseline, not a PR). The suggestion now reads the
   SAME `kind` (`'baseline'` | `'pr'`) the History badge/detail already use
   (via `prAnalytics.js`'s new `latestEventOfType`) and words itself
   accordingly: "New tested PR: 100 kg…" only for a genuine PR, "Best
   tested 1RM is 55 kg…" (neutral, still informative, never hidden) for a
   Baseline that exceeds Current 1RM.
2. **Estimated 1RM chart eligibility gap**: `progressAnalytics.js`'s
   `estimated1RMSeries` (the Progress chart) had no LOWER rep bound — only
   `reps <= EST_1RM_MAX_REPS` — so a workout containing only a completed
   single showed that single's own weight as an "estimate" (Epley
   special-cases reps===1 to return the weight unchanged), contradicting
   Package 1's own domain model even though the "Best Estimated 1RM"
   summary card and the PR engine already had the correct `reps >= 2`
   bound. Consolidated: a single shared `isEstimated1RMEligible(set)`
   predicate now lives in `progressAnalytics.js` and is reused by both that
   file's own `estimated1RMSeries` and `prAnalytics.js`'s PR
   engine/`bestEstimatedOneRepMax` — the rep-range rule now exists in
   exactly one place. Top Weight is unaffected (a single still counts
   there, correctly).

Files touched by this correction: `js/utils/progressAnalytics.js`,
`js/utils/prAnalytics.js`, `js/views/progress.js`, `sw.js` (cache
`v14` → `v15`). No protected file touched. `test_phase5b.mjs` grew from 31
to 43 checks (the 12 new ones cover both bugs plus the no-duplicate-
eligibility-rule/no-circular-import architectural requirement); the full
Phase 5A regression suite and all Package-1 exec/browser suites were
re-run and remain unchanged.

### Package 2 — Tested PR → Current 1RM action + Intelligence UX completion (cache v15 → v16)

Adds the ONE action Package 1 deliberately deferred: adopting an
already-Tested result as the new Current 1RM, with an explicit
confirmation step — never automatic.

**The action**: on Progress, when the selected exercise's Best Tested 1RM
exceeds its Current 1RM (`currentKg != null && testedEvent.value >
currentKg`), a button appears next to the existing passive suggestion:
"Update Current 1RM to 210 kg". This is allowed whether that Tested result
is classified as a Baseline or a genuine PR (adopting a real completed
single as a programming max isn't about whether it broke a prior record) —
only the informational wording above it stays Baseline/PR-aware, exactly
as Package 1 left it. **Estimated results stay passive-only text in this
package too** — no action is ever offered from an Estimated excess.

**Confirmation, never automatic**: clicking the button opens an inline
panel — "Update Deadlift Current 1RM? 205 kg → 210 kg. Future
percentage-based prescriptions will use the new Current 1RM. Existing,
in-progress, and completed workout snapshots will not change." — with
Cancel/Update buttons (`.btn-stack`, the same vertical pattern
`history.js`'s edit-mode Cancel/Save already uses). Cancel performs zero
writes.

**Write mechanism — reused, not forked**: Confirm calls the EXACT same
`recordOneRepMax(uid, { exerciseId, kg, kind, source })` Profile's own
"Save maxes" button already calls — no second Current-1RM storage path, no
direct `users/{uid}` field patch, no bypass of the append-only
`users/{uid}/maxes` history. `kind: 'tested'` (an already-documented enum
value, describing a genuinely tested result, as opposed to Profile's
manual `kind: 'training'` edits) and `source: 'tested_pr'` (a new but
schema-compatible free-text value — `firestore.rules`' `maxes` subcollection
rule has no enum restriction on either field, confirmed by reading the
actual rule, so no rules change was needed or made).

**Snapshot immutability & future programming effect**: proven with pure
unit tests directly against `js/utils/workoutSnapshot.js`'s
`resolvePrescription`/`buildResolvedExerciseList` — both are pure functions
of whatever `currentMaxes` object is passed in at call time, so (a) an
already-resolved exercise entry never changes even when the SAME
`currentMaxes` object is mutated afterward (proving an existing/
in-progress/completed workout's stored snapshot can never retroactively
change), and (b) a fresh call with the updated `currentMaxes` picks up the
new value (proving only a future, not-yet-started workout is affected).
This is the same architectural guarantee Package 1's own audit already
established (a snapshot is resolved once, at Start time, never
re-resolved) — Package 2 adds tests that prove it directly rather than
just re-stating it.

**Offline behavior — deliberately blocked, not redesigned**:
`recordOneRepMax` was audited and confirmed to have never been given the
zero-wait/offline-safe treatment Phase 5A gave workout Start/Finish/Skip
(it's a plain sequential `await addDoc(...)` then `await updateDoc(...)`
inside `trackWrite`, which only observes a write's settlement — it doesn't
change how/when the write's own promise resolves). Attempting it offline
would hang exactly like the pre-Phase-5A bugs this project already fixed
elsewhere. Per the spec's own two sanctioned choices, this package BLOCKS
the action while offline rather than redesigning `recordOneRepMax`'s
persistence: the button disables itself and shows "Updating Current 1RM
requires an internet connection." A live `window.addEventListener('online'
/ 'offline', …)` listener — registered in `progress.js`'s `mount()` and
torn down via the return value `js/core/router.js`'s existing (previously
unused by any view) mount-returns-unmount-function convention already
supports — keeps this reactive with no reload required in either
direction. Proven with a real Playwright browser test that forces the
underlying fake Firestore write-promise to behave exactly like the real
SDK does offline (stays pending until reconnect) and confirms zero writes
ever reach the store during the whole offline excursion.

**Failure/retry/duplicate-guard**: every button in the confirm panel is
disabled synchronously before `recordOneRepMax` is awaited (blocks a
double-click from producing two writes); a failed write leaves the old
Current 1RM completely untouched, shows "Error: …", and re-enables the
buttons for a retry; a successful write mutates the in-memory
`currentMaxes` object in place (Package 1's own "reflect the save locally
without a re-fetch" convention, borrowed from `history.js`'s edit-mode
save) and re-renders the whole exercise section immediately — the action
disappears with no gap and no manual reload, exactly as the spec's example
describes.

**Access safety**: unchanged — every write already went through
`recordOneRepMax(uid, …)` with `uid` always `getCurrentUser().uid`, and
`firestore.rules`' `users/{uid}` / `maxes` rules are already uid-scoped
with no field-level restriction to add.

**Audit finding (spec section 17)**: no other Phase 5B gap was found.
Package 1 plus this package's one action covers everything the original
Phase 5B goals called for; nothing else was invented.

**Deferred, documented only — NOT implemented in this package**: a future
Progress 2.0 pass should add desktop hover/focus and mobile tap-to-show/
tap-elsewhere-to-dismiss tooltips on the Estimated 1RM, Top Weight,
Training Volume, and Bodyweight chart points (each point already carries
an SVG `<title>` — visible to a screen reader/native browser tooltip today,
but not a designed tap/hover interaction), plus a more useful Y-axis
scale/reference values than the current auto-fit range. No chart-rendering
code was touched in this package.

**UI location**: kept next to the existing Current/Tested comparison on
Progress (the same `.pr-suggestion` box, reused, no new CSS layout
invented) — never in Profile, never cluttering History with an update
button (History stays evidence/record; Progress is where the decision is
made). Verified at a real 320px viewport with the confirm panel open (the
busiest state) — no horizontal overflow.

**Files changed**: `js/views/progress.js` (the action, its confirm panel,
the write/refresh cycle, the offline listener), `js/services/
userService.js` (doc-comment only — documents the new `source: 'tested_pr'`
value; `recordOneRepMax` itself is byte-for-byte unmodified in behavior),
`css/views.css` (doc-comment only on `.pr-suggestion`; no new rules),
`sw.js` (`CACHE_VERSION` `v15` → `v16` — progress.js/userService.js/
views.css content changed; no new file added to `SHELL_MODULES`). No
protected file touched.

**Test coverage**: a new `test_phase5b_package2.mjs` (21 pure-exec checks —
Baseline/PR-independent gating, snapshot immutability + future-programming
effect against the real `workoutSnapshot.js`, no-OHP, single-call-site/
correct-params architecture checks, cache version) plus a new real-Chromium
Playwright suite, `run_progress_package2_browser_test.mjs` (35 checks —
button visibility across all the required Best-Tested-vs-Current
combinations, Baseline vs. PR wording, cancel/confirm, the actual write +
immediate refresh, append-only history preservation, uid-scoping, failure
+ retry, duplicate-click guarding, live offline block/re-enable with zero
writes throughout, and 320px overflow). Building this suite surfaced and
fixed one latent gap in the project's own `fake-firestore.js` test double
(never previously exercised by any earlier suite): its `updateDoc` did a
naive shallow merge instead of real Firestore's dotted-field-path nested
merge, which `recordOneRepMax`'s `currentMaxes.${exerciseId}` update
depends on — fixed generically in the test double only, confirmed (by
temporarily reverting it) to be pre-existing and unrelated to any of this
project's other browser suites, all of which remain green. The full Phase
5A regression suite (76 checks), the full Phase 5B Package 1 + correction
suite (43 checks), and every other project exec suite (`history_exec_test`,
the loader-based `exec_test_5a`/`exec_access2`/`exec_start3` suites) were
re-run and remain unchanged.

## 19. Phase 5C, Package 1 — Interactive charts + 1RM History + bodyweight context + e1RM explanation (cache v16 → v17)

Progress's four trend charts (Estimated 1RM, Top Weight, Training Volume,
Bodyweight) went from static, non-interactive SVGs to interactive ones with
a real Y-axis, and Progress gained two new sections: **Current 1RM
History** (bodyweight-associated, ratio-annotated) and a small **About
Estimated 1RM** explanation. No workout lifecycle, PR/1RM computation
logic, offline-write behavior, or Package 2's own Update-Current-1RM
action changed at all — every regression check for those (see the
Testing section below) still passes unchanged.

**Chart interaction architecture** (`js/views/progress.js`): each chart
point now renders as a pair of SVG circles — a small, still purely
cosmetic `r="3"` visible dot (unchanged look from Phase 4), and a much
larger `r="12"` transparent, focusable `.chart-hit` circle layered on top
of it (`tabindex="0"`, `role="img"`, a real `aria-label`). Real hover
(`mouseenter`/`mouseleave`), real keyboard focus (`focus`/`blur`), and a
tap/click all drive one shared `wireChartTooltip()` per chart:
- Hover and focus always show/update the tooltip for whichever point is
  targeted and hide it again on leave/blur (never left stuck open) — the
  same content is reachable both ways, so nothing is hover-only.
- A tap/click PINS the tooltip: it stays open after the pointer/finger
  lifts (there is no real "hover" state on a touch device to leave), and
  tapping a *different* point on the same chart immediately moves the
  pinned tooltip to that point's own values.
- Dismissal is a single `document`-level "outside click" listener per
  chart, deliberately **not** using `stopPropagation()` on the hit
  circle's own click handler — a tap on chart B's point is allowed to keep
  bubbling to `document`, so chart A's own listener still sees it and
  correctly dismisses chart A's pinned tooltip too. This was the one
  subtle design decision in this package: an early draft that called
  `stopPropagation()` would have left a stale tooltip open on every OTHER
  chart once you'd tapped into a second one — verified in the browser
  suite ("tapping a point on a DIFFERENT chart dismisses the first
  chart's own pinned tooltip").
No native HTML `title` attribute is used anywhere for this — the spec's
own stated reason still holds: a touch device has no hover to trigger it.

**Tooltip content per chart** (spec section 3 — real underlying values,
never reverse-engineered from pixel positions): each chart's own point
objects now carry the real source data alongside the plotted `value` —
`workoutId` always, plus `sourceKg`/`sourceReps` for Top Weight and
Estimated 1RM (the exact set the plotted number came from). Four small
per-metric builder functions (`estimatedTooltipInfo`/`topWeightTooltipInfo`/
`volumeTooltipInfo`/`bodyweightTooltipInfo`) turn one point into
`{title, lines[], aria}` — e.g. Estimated 1RM's tooltip reads "132 kg" /
"from 120 kg × 3" with an aria-label of "Feb 5, 2026, Estimated 1RM 132
kilograms, from 120 kilograms for 3 reps", matching the spec's own worked
example format exactly (verified in the browser suite against real
seeded data, not just the wording pattern).

**Y-axis / reference scale** (spec section 4): `js/utils/
progressAnalytics.js` gained `computeYAxisTicks(values, {targetCount=4})`,
a "nice numbers" (Talbot/Heckbert-style) algorithm that snaps a tick step
to 1/2/5×10ⁿ so ticks land on round, readable values instead of the raw
data's own arbitrary min/max — restrained to roughly 3-5 gridlines, never
forced to start at 0 (a tightly-clustered series like bodyweight or a
high-plateau Current 1RM keeps its own useful resolution instead of being
crushed toward a 0-based axis), and pads a perfectly flat or single-point
series symmetrically rather than dividing by zero. `buildSparklinePoints`
now accepts this same `{yMin, yMax}` so the plotted line and the Y-axis
gridlines always share **one identical scale** — they are never
independently computed. Tick labels compact large numbers ("4.2k" instead
of "4,200") without repeating the unit on every one of 3-5 labels.
Verified in both the pure-exec suite (flat/single/narrow/large-range
series) and the browser suite (gridline count restrained to 3-8, tick
labels genuinely distinct, no overflow at 320px/384px).

**Touch targets** (spec section 5): the visible dot never grew — only the
invisible `.chart-hit` circle did (`r=12` vs the dot's `r=3`), so the
chart's visual density is exactly what it was in Phase 4, while the
actual clickable/tappable area is far more forgiving.

**Accessibility** (spec section 6): every hit circle carries its own
`aria-label` built from the real underlying values (see the worked
example above), plus `role="img"` and `tabindex="0"` so the chart is
fully keyboard-reachable via Tab, one point at a time, with the exact same
content Tab-focus and mouse-hover both produce — never noisier or
sparser for assistive technology than for a sighted mouse user.

**Current 1RM History** (`js/utils/maxHistoryAnalytics.js`, new, pure/
Firebase-free file — spec sections 7-11): reuses `js/services/
userService.js`'s existing, already-shipped `getMaxHistory` query (the
append-only `users/{uid}/maxes` history Package 2's own
Update-Current-1RM action, and Profile's manual "Save maxes" button
before it, already write to) as its **only** source. This module has no
import path to `js/utils/prAnalytics.js` at all — a Tested PR or an
Estimated 1RM value cannot reach this list structurally, not merely by a
filter that could be forgotten (verified in the pure-exec suite by
grepping the actual import statements, comment-stripped). `js/views/
progress.js`'s new `wireCurrentMaxHistory()` fetches this per exercise
(the one genuinely async piece of an otherwise fully in-memory render),
shows a small loading placeholder, and renders newest-first with a
"Show all (N)" toggle once there are more than 5 rows — no pagination
infrastructure, per the spec's own instruction not to build one unless
truly necessary. A `<table>` is deliberately **not** used; like this
codebase's existing `.set-table`/`.set-row` (the workout logger), it's a
CSS-Grid div layout instead, so column widths are guaranteed to fit a
320px card with no horizontal scroll — a real native `<table>`'s auto
layout offers no such guarantee.

**Bodyweight association rule** (spec section 8, implemented as
`associateBodyweightAtOrBefore(timestamp, bodyweightRecords)` — a pure,
independently-tested function): for each historical Current 1RM entry at
timestamp T, uses the most recent bodyweight measurement with
`timestamp <= T` — inclusive of an exact match, never a measurement from
after T (verified with a same-day case and an after-only case), and never
interpolated between a before- and an after-measurement (verified with a
case where an interpolating implementation would have produced a visibly
different, wrong number). Malformed bodyweight values (non-numeric, zero,
negative) and malformed timestamps are silently ignored rather than
corrupting the "most recent" comparison; a malformed 1RM entry timestamp
itself simply cannot be associated against anything. No qualifying
measurement at all displays as "—", never a fabricated number — verified
in the browser suite against a real Current 1RM entry that predates every
seeded bodyweight record.

**Strength/bodyweight ratio** (spec section 9,
`strengthToBodyweightRatio(kg, bodyweightKg)`): `kg ÷ bodyweightKg`, shown
to two decimals, `null`/"—" whenever either side is missing or non-positive
— never a fabricated or zero ratio. Descriptive only: this function
returns a plain number and nothing in this package ranks, scores, or
classifies it, and it is computed exclusively from Current 1RM values,
never Estimated 1RM (structurally impossible here — this module never
receives Estimated data in the first place, see above).

**Legacy / missing-history handling** (spec section 11): an account whose
Current 1RM predates this feature (no matching `users/{uid}/maxes`
document at all) sees a plain "No Current 1RM history recorded yet for
&lt;exercise&gt;." message — verified in the browser suite with a real
seeded exercise that has a Current 1RM but zero history docs. No fake
date or row is ever invented to populate the table.

**No manual F5 required**: Package 2's Update-Current-1RM action already
called `rerender()` on success; this package's `wireCurrentMaxHistory()`
being invoked fresh on every `renderExerciseSection()` call means an
adopted Current 1RM shows up as the newest History row immediately, with
no navigation and no reload — verified end-to-end in the browser suite
(confirm the action → wait on the store, not a timer → assert the new row
is present with a real, correctly-parsed date).

**About Estimated 1RM** (spec section 13): one small, collapsed-by-default
`<details>` block at the bottom of Progress, using the real
`epleyEstimate1RM` function (the exact same one every actual Estimated 1RM
chart point already goes through) to compute its own worked example
("100 kg × 5 reps → an estimated 116.7 kg 1RM") — this can never silently
drift out of sync with the real formula or its rounding, because it isn't
a second, hand-typed copy of either.

**Chart analytics data shape** (spec section 16): `perWorkoutSeries` (the
one shared point-builder every chart series already goes through) now
normalizes a `reduceSets` callback's return value — either a plain number
(100% backward compatible with the one pre-existing caller, Training
Volume) or a `{value, ...meta}` object (Top Weight, Estimated 1RM) — into
one point shape, `{date, workoutId, value, ...meta}`. Purely additive:
every previously-passing test and consumer is unaffected, and analytics/
data-preparation remains fully separate from DOM rendering (`js/utils/
progressAnalytics.js` has no `progress.js` import, and never will,
because the dependency only runs the other way).

**No external chart library was added** (spec section 17) — every chart
is still hand-built inline SVG (`<polyline>`/`<circle>`/`<text>`), exactly
as Phase 4 established; this package only extended `js/views/progress.js`
and `js/utils/progressAnalytics.js`'s existing rendering/analytics, never
introduced a new dependency. Verified in the browser suite (no
`chart.js`/`d3`/`highcharts`-shaped `<script src>` on the page) and by
inspecting `package.json`.

**Real-browser mobile targets**: tested at both 384px (Samsung Galaxy
S25+ CSS width) and the 320px stress width, in each case with a chart
tooltip actually open (the busiest state) — no horizontal overflow of the
document or body, and the tooltip element itself never spills past the
viewport edge. The Phase 5A bottom nav is untouched by this package (no
file it lives in was edited).

**Files changed**: `js/utils/progressAnalytics.js` (chart series carry
tooltip source metadata; new `computeYAxisTicks`/`niceNumber`/`niceRange`
Y-axis helpers; `buildSparklinePoints` accepts an explicit `{yMin,yMax}`
and spreads point metadata through; `toMillis` exported for reuse), new
`js/utils/maxHistoryAnalytics.js` (bodyweight association, ratio, Current
1RM History row-building — pure, fully unit-tested), `js/views/
progress.js` (interactive chart rendering + tooltip wiring, the Current
1RM History section, the About Estimated 1RM block), `css/views.css`
(new `.chart-wrap`/`.chart-gridline`/`.chart-tick-label`/`.chart-hit`/
`.chart-tooltip`/`.history-table`/`.history-row` rules), `sw.js`
(`CACHE_VERSION` `v16` → `v17` — precached-content changes above, plus
`js/utils/maxHistoryAnalytics.js` newly added to `SHELL_MODULES`). No
protected file touched, and no Firebase deploy is required (no
`firestore.rules`/`firestore.indexes.json` change).

**Test coverage**: a new `test_phase5c_package1.mjs` (32 pure-exec checks
— all 11 of the spec's own bodyweight-association/ratio cases, newest-
first ordering, no-fabrication on empty input, the "no import path to
prAnalytics.js" source-discipline check, `computeYAxisTicks` edge cases
for flat/single/narrow/large-magnitude series, tooltip-metadata
correctness for Top Weight/Estimated 1RM/`buildSparklinePoints`, a
completed-single exclusion check, an explicit-`{yMin,yMax}`-honored check,
a no-external-chart-library check, and a protected-files spot check)
plus a new real-Chromium Playwright suite,
`run_progress_phase5c_browser_test.mjs` (39 checks — tooltip content and
aria-label wording for all four chart types against real seeded data,
hover-then-mouseleave, keyboard focus/blur parity with hover, mobile tap
open/move-to-another-point/dismiss-on-outside-tap, cross-chart pinned-
tooltip dismissal, Y-axis gridline count and tick-label distinctness per
chart, 320px/384px containment with a tooltip open, full Current 1RM
History behavior — ordering, per-entry bodyweight association, ratio,
the "—" no-qualifying-measurement case, "Show all" — the legacy no-
history message, the live no-reload-needed update after Package 2's own
action, the About Estimated 1RM block's real worked-example text, and the
no-external-library check). Building this suite's browser harness
surfaced and fixed one further latent gap in the project's own shared
`fake-firestore.js` test double (same class of issue as Package 2's own
dotted-field-path fix, same fixture file): a document field written via
the fake's own `serverTimestamp()` came back from a read as a plain
`{at:N}` object rather than something with a real `.toDate()` method, so
any app code reading such a field (this package's own
`effectiveDate`-driven History rows, via `progressAnalytics.js`'s
`toMillis`/`dates.js`'s `formatDate`, both of which already special-case
`typeof date?.toDate === 'function'`) would have silently rendered
"Invalid Date"/0 instead of the real value — invisible before this
package because nothing built prior to it ever read/sorted/formatted a
`serverTimestamp()`-written field back out. Fixed generically in the test
double only (`docSnap`'s `data()` now re-wraps that exact shape with a
real `.toDate()`), confirmed by temporarily reverting it and re-running
both `run_autosave4_browser_test.mjs` (its one pre-existing timeout
failure reproduced identically with the fix removed) and
`run_homenav6_browser_test.mjs` (its one pre-existing timing-flake
failure also reproduced identically) to be pre-existing and unrelated,
then restored. The full Phase 5A regression suite (76 checks), the full
Phase 5B Package 1 + correction suite (43 checks), the Package 2 suite
(21 pure-exec + 35 browser checks, all still green against the updated
source), and every other project exec suite (`history_exec_test`, the
loader-based `exec_test_5a`/`exec_access2`/`exec_start3` suites) were
re-run and remain unchanged.


## 20. v1.1 (app 1.1.0, cache v22) — Program Import, actual-set logging, heldback branding

### Program Import (Program → Import Program)
Choose a `.json` or `.csv` file → it is parsed and validated in the browser
(`js/utils/programImport.js`, nothing written) → a preview shows name,
version, id, weeks (deload/PR weeks), days and their exercises, load types,
which %-loads need a 1RM you don't have yet, and rounding → **Import Program**
writes it in ONE Firestore transaction (`programService.importProgram`).

- It only ever **adds** `users/{uid}/programs/{newId}` + its `days`. Workouts,
  1RM history, bodyweight, programRuns, the profile and every existing
  program are never read-modified. The new program is not activated;
  choose **Set Active** when ready.
- An existing program id is **never overwritten**: the preview asks for a
  new id first, and the transaction re-checks at write time.
- Any validation error blocks the whole file (no partial import); errors
  name the row / week / day / exercise.
- Untrusted input: whitelisted fields only; ownership/access fields (`uid`,
  `role`, `status`, `permissions`, …) are rejected; ids are strict slugs
  (no Firestore path injection); text is length-capped and always rendered
  escaped. A "Backup My Data" file is recognized and pointed to Restore.
- Not Backup/Restore: Program Import adds one training program; Restore
  restores an account backup.

**JSON** is the native format — the same shape as
`data/program.deadlift-8wk.json` (flat, `week-percent-range` and
`block-driven` entries, warm-up ramps, RPE, notes). Optional `version`;
`programId` is accepted as an alias of `id`. The packaged program itself is
a valid import file and produces identical workouts.

**Accepted JSON (everything else is ignored with a warning; ownership/access
fields are an error):**

```text
{
  schemaVersion?: 1,
  id | programId: slug            // lowercase a-z 0-9 '-', ≤ 64; derived from name if absent
  name: text ≤120,  version?: text|number ≤40,  sourceFile?: text ≤120,  generatedBy?: text,
  currentOneRepMaxesAtImport?: { exerciseId: kg }   // stored for reference only — NEVER applied to your 1RMs
  notes?: text ≤2000,  decisionRules?: text[] (≤30, each ≤300),
  roundingRules?: { barbell, dumbbell, machine, bodyweight: 0–50 },
  exerciseLibrary?: [{ id: slug, name, aliases?: text[], cue?: text }],
  weeks: [{ week: 1..N (no gaps), isDeload?, isPrAttempt?, cycle?,
            focusFromOverview?, deadliftNotesFromBlock?, notes? }],   // "_x" keys = comments, dropped
  days: [{ id?: slug, order: 1–99 unique, name: text ≤80,
           sections: { warmup?: {source?, text}, cooldown?: {source?, text},
                       main?: Entry[], accessory?: Entry[] } }]       // ≥1 exercise per day
}
Load  = {type:'none'} | {type:'bodyweight'} | {type:'fixed', kg:0–500, perHand?, note?}
      | {type:'percent', percent:0<p≤3, of?: slug} | {type:'percentRange', min, max, of?}
      | {type:'sets', sets:[{kg, reps}] ≤15}   // flat entries only: explicit warm-up ramp, fixed kg
Entry (flat)  = { exerciseId, displayName, sets 1–50, reps?: n | {min,max}, durationSec?,
                  load?: Load, notes?, rpe?: 0–10, rir?: 0–10, weeks: [week…] }
Entry ('week-percent-range') = { exerciseId, displayName, structure,
                  weeklyVariants: [{ week, load: percent|percentRange }],
                  setsReps: { "<week>": "4x5" | "3x6-8" } }
Entry ('block-driven') = { exerciseId, displayName, structure, weeklyVariants: [{
                  week, isDeload?, isPrAttempt?, notes?,
                  topSingle?|backoff?|sgdl?: { sets (0/null = not this week), reps?,
                             load: percent, note?, sourceWeightKgAtImport? (topSingle) },
                  warmupSets?: [{ kg, reps }] (≤15) }] }
```

**Program-level notes & decision rules (JSON only):** optional `notes`
(text, ≤ 2000 chars) and `decisionRules` (list of ≤ 30 texts, ≤ 300 chars
each), shown on the Program screen. Plain text — never interpreted.

**CSV** — one row per exercise, per day, per week. Identical prescriptions
across weeks are merged into one entry. Column names are case-insensitive.

> **CSV limitation (by design):** CSV produces *flat* entries only — fixed
> kg, % of 1RM, % range, bodyweight, timed holds, rep ranges, RPE/RIR,
> notes. These are **JSON-only**: `block-driven` lifts (top single + backoff
> + snatch-grip + 1RM-scaled warm-up ramp), `week-percent-range` blocks,
> the exercise library/cues, and program `notes`/`decisionRules`. Programs
> like the built-in Deadlift program must be imported as JSON.

| Column | Req. | Meaning |
|---|---|---|
| programId | ✓ | lowercase-hyphen id, same on every row |
| programName | ✓ | same on every row (may be blank after the first) |
| version | | label, e.g. `2` |
| week | ✓ | 1, 2, 3… no gaps |
| deload / prAttempt | | `true` on that week's rows |
| dayOrder | ✓ | 1, 2, 3… |
| dayName | ✓ | same for a dayOrder in every week |
| dayId | | optional stable id (else generated) |
| section | | `main` (default) or `accessory` |
| exerciseOrder | ✓ | position in the day |
| exerciseId | ✓ | e.g. `deadlift` — links 1RMs/progress |
| exerciseName | ✓ | shown in the app |
| sets | ✓ | 1–50 |
| reps | | `5` or `6-8`; blank for timed holds |
| durationSec | | seconds per set |
| loadType | ✓ | `none` \| `bodyweight` \| `fixed` \| `percent` \| `percentRange` |
| loadValue | | fixed: kg · percent: `75` · percentRange: `70-75` |
| loadUnit | | `kg`, `kg/hand`, or `%` |
| percentOf | | exerciseId whose 1RM a % uses (default: itself) |
| rpe / rir | | targets, 0–10 |
| notes | | shown with the exercise |

`restSec` is not part of this app's program model (rest is a global
setting) and is ignored with a warning. A template is downloadable from the
import screen.

### Actual-set logging
Each set row keeps the frozen plan (`plannedKg`/`plannedReps`) and the
actual result (`actualKg`/`actualReps`, prefilled to the plan). New optional
`status`: **completed** (as planned), **modified** (weight/reps changed —
derived automatically), **failed** (explicit; achieved values recorded; an
untouched rep count is cleared so a failed set can't claim the planned
reps), **skipped** (explicit; not performed). Plus actual `rpe` and `note`.

- Logger: tap ✓ as before; edit weight/reps if different; **⋯** opens
  Failed / Skip set / RPE / note.
- A failed set does not fail the workout (still "complete"); a skipped set
  makes it "partial".
- History shows set-by-set actuals, with "Planned …" when different; the
  existing Edit Workout mode has the same controls.
- Performance analytics (Progress charts, PRs, e1RM, volume) use only
  **completed** and **modified** sets, with their actual values. **Failed**
  and **skipped** sets are kept in the workout and shown in History, but
  never produce a performance or e1RM point — even with actual weight/reps
  entered. Stored 1RMs never change automatically.
- Corrections: `updateCompletedWorkoutLog` now also rejects any change to
  plan/identity data **inside** `exercises` (Rules can't inspect arrays).
- **No migration, `schemaVersion` stays 1**: the field is additive and
  optional; old sets resolve their status from their own values.

### Firestore rules
Unchanged. The only new writes are a new program (+days) under the owner's
own `programs/` — already owner-only — and the new set fields inside
`exercises`, which the existing workout rules already treat as actual
logging data. `tests/rules/` pins these protections against the emulator.

### Canonical Deadlift 210 (7-Week Block)
`tests/fixtures/program.deadlift-210-7wk.json` (read-only, SHA-256 pinned in
the tests) imports with no errors or warnings, is stored identical to the
file, and all 7 × 4 = 28 generated workouts are verified field by field
(`tests/unit/deadlift210Canonical.test.mjs`).

Stored but **not displayed** anywhere in the app today (pre-existing UI
scope, unchanged): week `focusFromOverview` / `deadliftNotesFromBlock`,
day warm-up/cool-down `text`, exercise-library `cue`s, `generatedBy`,
`currentOneRepMaxesAtImport` (shown only in the import preview).

**Target RPE:** a flat entry's `rpe` (e.g. Deadlift W1–W5 RPE 6–8) is copied
into new workout snapshots as `exercises[].prescribed.targetRpe` (only when
the program has one) and shown as "Target RPE n" in the workout preview,
the live logger and History. It is prescription metadata only — never the
set's actual `rpe`, and not used by completion state, PRs, e1RM, volume,
top weight, Current 1RM or Progress. Snapshots created before this change
are not rewritten. Block-driven RPE/test instructions stay in `notes`.

The Program day editor shows a flat warm-up ramp read-only and always keeps
it exactly as stored.

### Other
- `#/import` (an old placeholder route whose view never existed) now
  redirects to Program → Import Program.
- Home shows "Week N / <the program's own number of weeks>" (was a
  hard-coded "/ 8").

### Admin → Reset training data (Cloud Function)
Admin → open a user → **Reset training data…**. Firestore rules give admins
read-only access to other users and are **unchanged**, so the reset runs on the
server: callable function `adminResetUserFitness` (`functions/`, Admin SDK).

- **Server checks:** signed in; caller's `/access` doc is `approved` + `admin`
  (never a client-sent role); target uid well-formed and has an `/access` doc;
  payload is exactly `{targetUid, confirmation}`; `confirmation` equals
  `RESET <target email>` (or `RESET <uid>` with no email). A per-target lock
  (`adminResets/{uid}`) refuses a second concurrent reset.
- **Removed:** all workouts (any status), `maxes` (1RM history), `measurements`,
  `records`, `progressionSuggestions`, all `programRuns`; profile
  `currentMaxes` → `{}` (the user re-enters the 4 required 1RMs at next sign-in,
  exactly like a new account; import-time 1RMs are never used).
- **Kept:** Auth user, `/access` (status/role), profile identity/settings/
  training profile, every program incl. imported ones, nutrition, global config.
- **Program:** the active program stays active as a new run
  `reset-run-<generation>` at Week 1 / first day. No active program → none is started.
- **Not atomic** (Firestore batches ≤ 500 writes). Deletes go in bounded batches;
  the profile/program step is last; the server re-verifies that everything is
  empty before reporting success. Any failure → "did NOT complete"; running it
  again is idempotent and finishes the job. Each run writes `adminAudit/{id}`
  (admin uid, target uid, time, result, counts — no secrets).

**Stale devices (open tab, offline phone, cached app).** Every successful
reset gives the user a new *training generation*: `users/{uid}.trainingGeneration`
(random token) plus a sentinel doc
`users/{uid}/progressionSuggestions/__training-generation-<token>`, swapped in
the reset's final batch. Every client write of training state — Start,
autosave, Finish, Skip, set/RPE corrections, current-1RM saves, bodyweight,
program-run position/switch — is committed as a batch that also `update()`s
the device's own generation sentinel (`js/services/trainingGenerationService.js`).
After a reset that sentinel is gone, so **Firestore rejects the whole batch on
the server**, including writes queued offline and replayed later or after a
refresh. The device then checks the generation (on boot, reconnect, tab focus,
navigation, or any rejected write), refuses further training writes, shows
"Your training data was reset by an admin. Loading your fresh start…", drops
its local workout marker and reloads from the server. No rules change.
Backups never include sentinels; restore never deletes or recreates one.
Known residual: a device whose *only* session on this version was offline has
no confirmed sentinel yet; until it has been online once, its queued 1RM and
bodyweight writes are unguarded (workout and run writes are still rejected,
because the reset deleted their documents).

**Deploy (new, separate step — the hosting workflow is unchanged):** requires
the Blaze plan. Once: `cd functions && npm install`. Then, when the function
changes: `firebase deploy --only functions`. Hosting still deploys with
`firebase deploy --only hosting:production`.

### Tests
See `tests/README.md`. `tests/rules/` needs the Firebase emulator (Java +
firebase-tools); it skips itself otherwise and has **not** been run in the
sandbox this was built in.
