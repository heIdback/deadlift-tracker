// ─────────────────────────────────────────────────────────────────────────
// Phase 5A — offline app-shell service worker.
//
// Scope: this file lives at the REPO ROOT (not under js/) specifically so
// its default registration scope covers the whole app, including on a
// GitHub Pages project-page subpath — a service worker's default scope is
// "the directory it's served from", so registering it from anywhere deeper
// (e.g. js/sw.js) would silently fail to control the app's own root
// requests/navigations.
//
// What this file does NOT do: it never touches Firestore's own request/
// response traffic (RPC/REST calls to firestore.googleapis.com or similar),
// Google Identity/OAuth endpoints, or Google Fonts — those are all
// cross-origin from this app and are left completely unintercepted (see the
// `fetch` handler below). Firestore's OWN offline persistence
// (js/core/firebase.js's persistentLocalCache) is what makes user data
// available offline; this file is responsible only for the static
// application shell (HTML/CSS/JS/manifest/icons/program template) plus the
// three pinned Firebase SDK CDN URLs the app boots from (see
// FIREBASE_CDN_URLS below) — never for anything containing a token, a
// session, or another user's data.
// ─────────────────────────────────────────────────────────────────────────

// Bump this string on any release that changes which files the shell needs
// (a new/removed/renamed module, a changed CSS/HTML file, a new icon, etc.)
// to force every client to fetch a fresh copy of everything on next visit —
// see `activate` below, which deletes every OTHER cache whose name starts
// with CACHE_PREFIX, and js/core/pwa.js, which is what actually offers the
// resulting update to the person instead of applying it silently mid-use.
//
// v1 -> v2 (Phase 5A correction pass): v1 could precache a REDIRECTED
// Response for the navigation fallback (see precacheCanonicalIndexHtml
// below for the full root-cause explanation), which Chrome refuses to
// return to a navigation FetchEvent ("a redirected response was used for a
// request whose redirect mode is not 'follow'") — breaking offline
// refresh entirely. Bumping the version here is what makes activate()
// remove that broken v1 cache from browsers that already installed it,
// rather than leaving them stuck on it.
//
// v2 -> v3 (Phase 5A correction pass 2): this correction changes the
// CONTENT of js/core/access.js, js/core/router.js and js/views/pending.js
// — all three are same-origin modules listed in SHELL_MODULES below, so
// under this file's cache-first same-origin strategy a browser that
// already installed the v2 cache would otherwise go on being served the
// OLD (hanging-offline) versions of those exact files forever, since
// cache-first never re-checks the network for a hit. Bumping the version
// is what makes activate() drop the stale v2 cache and install a v3 cache
// containing the corrected files, so already-installed browsers actually
// receive this fix rather than being stuck on the bug it corrects.
//
// v3 -> v4 (Phase 5A correction pass 3): this correction changes the
// CONTENT of js/services/workoutService.js, js/services/programService.js,
// js/views/home.js and js/views/workout.js — all four are same-origin
// shell modules (SHELL_MODULES below), served cache-first. Same reasoning
// as v2 -> v3: without bumping, an already-installed v3 browser would keep
// being served the OLD (hanging-on-offline-Start) versions of these files
// forever, since cache-first never re-checks the network for a hit.
//
// v4 -> v5 (Phase 5A correction pass 4): this correction changes the
// CONTENT of js/views/workout.js only (adds a visibilitychange/pagehide
// autosave flush and an honest offline "will sync" autosave label — see
// this pass's report for the full root-cause analysis of why offline set
// edits could fail to survive an F5). workout.js is a same-origin shell
// module (SHELL_MODULES below), served cache-first. Same reasoning as
// every prior bump: without it, an already-installed v4 browser would keep
// being served the OLD (loss-prone) version of this file forever, since
// cache-first never re-checks the network for a hit.
//
// v5 -> v6 (Phase 5A correction pass 5): this correction changes the
// CONTENT of js/views/workout.js AND js/services/workoutService.js — both
// same-origin shell modules (SHELL_MODULES below), served cache-first.
// Pass 4's fix (above) still let the real Firestore write Promise stay
// pending until backend acknowledgement, which a real browser test proved
// leaves the autosave label stuck on "Saving…" indefinitely while offline
// (see this pass's report for the corrected firebase-js-sdk 10.13.0
// semantics). The fix replaces the "await the write's own Promise" signal
// with an onSnapshot/hasPendingWrites-based local-status listener
// (workoutService.js's new subscribeToWorkoutLocalStatus) and stops
// runSave from awaiting that Promise at all. Same reasoning as every prior
// bump: without it, an already-installed v5 browser would keep being
// served the OLD (stuck-on-"Saving…") versions of these files forever,
// since cache-first never re-checks the network for a hit.
//
// v6 -> v7 (Phase 5A correction pass 6): this correction changes the
// CONTENT of js/services/workoutService.js, js/services/userService.js,
// js/services/programService.js, and js/services/measurementService.js,
// and ADDS a brand-new same-origin shell module,
// js/utils/firestoreRead.js — all now listed in SHELL_MODULES below. A
// real-browser test proved that navigating Workout -> Home in-app while
// offline left Home stuck on "Loading dashboard…" indefinitely: several of
// Home's own reads (getUserProfile, getPrimaryProgramContext's
// getActiveProgramRun/getProgram, getProgramDays, plus two dashboard-stat
// reads and reconcileLegacyProgramPosition's query) were plain,
// online-preferring getDoc()/getDocs() calls with zero offline handling —
// unlike workoutService.js's OWN workout reads, fixed for this exact
// pattern back in correction pass 3. The fix routes all of them through a
// newly-shared getDocSafe/getDocsSafe helper (js/utils/firestoreRead.js)
// so they fall back to Firestore's local cache offline instead of hanging.
// Same reasoning as every prior bump: without it, an already-installed v6
// browser would keep being served the OLD (hanging) versions of these
// files, AND would 404 trying to fetch the new firestoreRead.js module
// from a stale cache that never precached it, since cache-first never
// re-checks the network for a hit or a miss.
// v7 -> v8 (Phase 5A correction pass 7): this correction changes the
// CONTENT of js/services/workoutService.js only — a same-origin shell
// module (SHELL_MODULES below), served cache-first. Root cause: shared
// helper finalizeInProgressWorkout (used by BOTH finishWorkout and
// skipWorkout) directly `await batch.commit()`'d the Finish/Skip lifecycle
// batch — that Promise is gated on backend acknowledgement exactly like any
// other Firestore write (same class of bug pass 5 already fixed for the
// per-set autosave write, never re-examined here), which a real-browser
// test proved leaves the UI stuck on "Finishing…"/"Skipping…" indefinitely
// while offline. The fix lets batch.commit() settle in the background
// (only `.catch()`-ing a genuine failure) and instead awaits a new
// waitForLocalWorkoutPatch() helper — a one-shot onSnapshot/
// includeMetadataChanges listener on the workout doc — to detect "this
// atomic two-document batch is now safely applied to the local cache",
// which WriteBatch's own documented local-atomicity guarantee makes
// sufficient proof the programRun half of the same batch is applied too.
// listCompletedWorkouts (History's list source) was also switched from a
// plain getDocs to the shared getDocsSafe helper (pass 6), so History no
// longer hangs offline right after an offline Finish/Skip. Same reasoning
// as every prior bump: without it, an already-installed v7 browser would
// keep being served the OLD (hangs-on-"Finishing…"/"Skipping…") version of
// this file forever, since cache-first never re-checks the network for a
// hit.
// v8 -> v9 (Phase 5A correction pass 8): this correction changes the
// CONTENT of js/services/workoutService.js, js/services/programService.js,
// js/views/home.js, and js/views/workout.js — all four are same-origin
// shell modules (SHELL_MODULES below), served cache-first. Root cause: a
// brand-new offline Start had the SAME await-a-backend-ack-gated-Promise
// bug class as pass 7's Finish/Skip fix, in FOUR separate places —
// startOrResumeWorkout's own `await batch.commit()`, startProgramRun's own
// `await setDoc(...)` (the never-started-run branch), resolveActiveWorkout's
// stale-activeWorkoutId-pointer `await updateDoc(...)`, and
// reconcileLegacyProgramPosition's own `await trackWrite(() =>
// updateDoc(...))` — any of which a real-browser test proved could leave
// the Start button stuck on "Starting…" indefinitely offline, sometimes
// before the lifter ever saw a START button at all (the latter two run at
// Home/Workout MOUNT time, not just on click). All four now let their
// write settle in the background and detect "safely local" via a one-shot
// onSnapshot instead (or, for reconcileLegacyProgramPosition, don't need to
// wait on anything at all — see workoutService.js's own doc comment). Also
// closes a same-tab double-Start race (js/views/home.js's and
// js/views/workout.js's Start buttons now check `btn.disabled` explicitly,
// and workoutService.js/programService.js each add an in-flight-Promise
// guard) that could otherwise create two workout documents for one click.
// Same reasoning as every prior bump: without it, an already-installed v8
// browser would keep being served the OLD (hangs-on-"Starting…"/
// duplicate-start-prone) versions of these files forever, since cache-first
// never re-checks the network for a hit.
//
// CORRECTION PASS 9: v9's fix (above) still hung on "Starting…" in a real
// offline browser — Pass 8's `waitForLocalDocToExist` awaited a freshly
// registered `onSnapshot` on a brand-new, never-before-watched document to
// prove the Start batch had landed locally, and this project's fake-
// Firestore test doubles cannot exercise the real Firebase Web SDK at all,
// so they could not have (and did not) rule out that listener being
// unreliable for exactly this shape of case while offline. Root-cause-level
// fix this time: stop depending on any Firestore read-back at all for
// Start's own control flow — `batch.commit()`/`setDoc()` are invoked
// (never awaited) and both `startOrResumeWorkout` and `startProgramRun`
// return immediately, built from data already held in memory. The
// `onSnapshot` listener is kept only as a non-blocking, logged diagnostic.
// Also adds permanent `[START]`-tagged checkpoint logging across the whole
// click-to-mount path (home.js, workout.js, workoutService.js,
// programService.js) so a future real-browser failure can be pinpointed
// exactly, without guessing. Bumped for the same reason as every prior
// version: cache-first serving means an already-installed v9 browser would
// otherwise keep the old, still-hanging code forever.
//
// CORRECTION PASS 10: with Pass 9's Start fix now CONFIRMED accepted in a
// real offline browser, the SAME failure shape turned up on Finish/Skip: a
// real offline "Finish Anyway" (existing, already-in-progress workout, 1 of
// 28 sets logged) hung on "Finishing…" forever. Root cause was
// `finalizeInProgressWorkout`'s own `await waitForLocalWorkoutPatch(ref,
// workoutPatch)` (js/services/workoutService.js) — a freshly-registered
// `onSnapshot` wait used to prove the Finish/Skip batch's local application,
// structurally the same onSnapshot-wait shape Pass 9 already fixed for
// Start, just on an EXISTING document instead of a brand-new one. Same
// fix, same reasoning: `workoutPatch`/`runPatch` are already known in
// memory, so `batch.commit()` is invoked (never awaited) and
// finalizeInProgressWorkout — used by both `finishWorkout` and
// `skipWorkout` — returns immediately; `waitForLocalWorkoutPatch` is kept
// only as a non-blocking, logged diagnostic. Also adds permanent
// `[FINISH]`-tagged checkpoint logging across js/views/workout.js and
// js/services/workoutService.js's Finish/Skip path. Only
// js/views/workout.js and js/services/workoutService.js changed content
// this pass (js/views/home.js and js/services/programService.js are
// untouched — Pass 9's Start fix in those two files is unaffected). Bumped
// for the same reason as every prior version: cache-first serving means an
// already-installed v10 browser would otherwise keep the old,
// still-hanging Finish/Skip code forever.
//
// PHASE 5A — FINAL RESPONSIVE / PWA POLISH: real-device testing (Samsung
// Galaxy S25+, 384px and a 320px stress test) found the 7-item bottom nav's
// labels crowding/overlapping at 320px. Fixed with a narrow-viewport-only
// (<=340px) CSS rule that visually hides nav labels while keeping icons and
// accessible names (css/base.css — see its own comment on `.nav-item` for
// the full reasoning); 384px+ and desktop are unaffected. Also added the
// modern `mobile-web-app-capable` meta tag to index.html (Chrome console
// deprecation warning) alongside, not instead of, the existing apple-*
// tags. Both css/base.css and index.html are precached shell assets (see
// SHELL_STATIC_ASSETS below), so bumped for the same reason as every prior
// version: cache-first serving means an already-installed v11 browser
// would otherwise keep serving the old, cramped-at-320px CSS and the old
// index.html without the modern meta tag, indefinitely.
//
// PHASE 5A — FINAL BASELINE CHECKPOINT: v12 -> v13 is a VERSION-ALIGNMENT
// bump only — no shell asset changed content between v12 and v13. This
// pass's own real-Chrome update-flow acceptance test (Application ->
// Service Workers -> Update; new worker "waiting to activate"; the app's
// own "Update available. Reload" banner; Reload activates it; repeated
// once more for a clean final cycle) was performed directly against a
// deployed copy that was manually relabeled v12 -> v13-test -> v13 during
// that test, and PASSED at v13 (final active worker #4652 in Chrome's own
// DevTools). This source tree still said v12 at the start of this
// checkpoint — that mismatch is the one discrepancy this checkpoint found
// and is correcting here, so a fresh install from this exact source
// computes the SAME cache name (`deadlift-tracker-shell-v13`) the
// real-browser update flow already verified end-to-end, rather than
// silently reverting to the untested v12 label. See this pass's own report
// for the full discrepancy writeup.
//
// PHASE 5B, PACKAGE 1 (PR model + detection + 1RM separation): v13 -> v14
// is a genuine content bump, NOT alignment-only — this package adds a new
// precached module (js/utils/prAnalytics.js, now listed in SHELL_MODULES
// below) and changes the CONTENT of three already-precached shell files
// (js/utils/progressAnalytics.js gains three additional exports; js/views/
// history.js and js/views/progress.js both gain PR display code;
// css/views.css gains the new .badge-pr/.pr-detail-list/.pr-recent-list/
// .pr-suggestion rules) — under this file's own cache-first policy, an
// already-installed client would otherwise keep serving the OLD versions
// of all of those forever. No unrelated file's content changed this pass.
//
// PHASE 5B, PACKAGE 1 — REAL-BROWSER ACCEPTANCE CORRECTION: v14 -> v15,
// again a genuine content bump. Real-Chrome/Firebase testing of v14 found
// two semantic UI bugs: (1) the Progress "Current vs. Tested/Estimated"
// suggestion called a first-ever Baseline result a "PR" whenever it
// happened to exceed Current 1RM; (2) the Progress "Estimated 1RM" chart
// (js/utils/progressAnalytics.js's estimated1RMSeries) had no lower rep
// bound, so a workout containing only a completed single showed that
// single's own weight as an "estimate". Both are fixed by content changes
// to already-precached shell files: js/utils/progressAnalytics.js (new
// shared isEstimated1RMEligible predicate + estimated1RMSeries fix),
// js/utils/prAnalytics.js (reuses that shared predicate instead of its own
// inline copy; new latestEventOfType helper), and js/views/progress.js
// (suggestion wording now Baseline/PR-aware). No unrelated file's content
// changed in this correction.
//
// v16 — Phase 5B, Package 2 ("Tested PR -> Current 1RM action"): content
// changed in js/views/progress.js (adds the confirmation-gated
// Update-Current-1RM action + a live online/offline listener),
// js/services/userService.js (doc-comment only: documents the new
// `source: 'tested_pr'` value; no logic change), and css/views.css
// (doc-comment only on .pr-suggestion; no new rules, no logic change). No
// other file's content changed for this package.
//
// v17 — Phase 5C, Package 1 ("Interactive charts + 1RM History +
// bodyweight context + e1RM explanation"): a genuine content bump. Adds ONE
// new precached module (js/utils/maxHistoryAnalytics.js — the pure
// bodyweight-association/ratio/Current-1RM-History-row helper, now listed
// in SHELL_MODULES below) and changes the CONTENT of three already-
// precached shell files: js/utils/progressAnalytics.js (chart series now
// carry tooltip source metadata; new computeYAxisTicks Y-axis helper;
// toMillis exported for reuse), js/views/progress.js (the four Progress
// charts are now interactive — Y-axis, hover/focus/tap tooltips, larger
// invisible hit targets — plus the new "Current 1RM History" section and
// the "About Estimated 1RM" explanation block), and css/views.css (new
// .chart-wrap/.chart-gridline/.chart-tick-label/.chart-hit/.chart-tooltip/
// .history-table rules). No other file's content changed for this package;
// no workout lifecycle, PR/1RM computation, or offline-write code path was
// touched (see this package's own delivery report).
//
// v18 — Phase 5C, Final UX / Production Polish pass: a genuine content
// bump, both already-precached shell modules (no new file added, no file
// removed from SHELL_MODULES):
//   - js/views/progress.js — Current 1RM History's ratio cell now renders
//     the "×" suffix (e.g. "1.17×" instead of "1.17"); the underlying
//     ratio calculation is unchanged.
//   - js/utils/workoutSnapshot.js — added a narrow, display-layer-only
//     normalization so Day 3's SGDL accessory shows the clean label
//     "Snatch-Grip Deadlift" instead of the legacy imported wording
//     ("Deficit / Snatch-grip Deadlift" / "Deficit / Snatch Deadlift") for
//     any workout STARTED after this change. Historical, already-created
//     workout snapshots are immutable and keep showing exactly what they
//     always showed; data/program.deadlift-8wk.json itself is untouched.
// No other file's content changed in this pass (css/views.css was audited
// and needed no change — see this pass's own report); no workout
// lifecycle, PR/1RM computation, or offline-write code path was touched.
//
// v19 — Final production cleanup + controlled owner clean reset pass: a
// genuine content bump.
//   - js/utils/workoutSnapshot.js — added a second, narrow display-layer
//     suppression (alongside v18's SGDL label fix, same function) that
//     drops any prescription `notes` string matching a small set of
//     internal-provenance markers (e.g. "user confirmed", "import-
//     mapping.json", "source wording") so internal dev/import notes baked
//     into a small number of program entries are never shown to the end
//     user, while every other, legitimate training note passes through
//     completely unchanged. Historical, already-created workout snapshots
//     are immutable and unaffected; data/program.deadlift-8wk.json itself
//     is untouched.
//   - js/views/profile.js, js/views/nutrition.js,
//     js/views/programDayEditor.js — three small internal-jargon/dev-
//     wording fixes to user-facing text (no behavior change).
//   - js/services/ownerCleanResetService.js — ADDED, and listed in
//     SHELL_MODULES below FOR AS LONG AS IT EXISTS. This is a TEMPORARY,
//     admin-only, one-time maintenance module (statically imported by
//     js/views/profile.js) that lets the app's owner/admin account move
//     from development/test data to a clean real-usage baseline; it can
//     only ever target `auth.currentUser.uid`, requires an online
//     connection and explicit typed confirmation, and is documented in
//     full in this pass's own delivery report, including the exact two
//     files to delete and the exact SHELL_MODULES line to remove once the
//     real, one-time reset has been run and verified (at which point this
//     entry must be removed and the version bumped again).
// No other file's content changed in this pass; no workout lifecycle,
// PR/1RM computation, or offline-write code path was touched.
//
// v20 — FINAL v1 production build: removes the v19 temporary maintenance
// tool now that the real, one-time owner clean reset has been run and
// manually verified in the real application. This bump REMOVES a
// precached asset, so it is a genuine content bump like every prior one:
//   - js/services/ownerCleanResetService.js — DELETED outright, and its
//     entry REMOVED from SHELL_MODULES below. The final v20 module graph
//     contains no reference to this file anywhere.
//   - js/views/profile.js — the entire "Owner Clean Reset (TEMPORARY —
//     admin only)" card, its confirm/result render states, its RESET
//     confirmation input, its event wiring, and its import of the now-
//     deleted service were all removed. No other Profile functionality
//     (Backup & Data, Restore My Data, Current 1RM/Bodyweight forms) was
//     touched.
// A companion audit (this pass's own report) confirmed History/Progress/
// PR/1RM/bodyweight data were ALREADY user-wide, never active-program-
// scoped — listCompletedWorkouts, listBodyweightHistory, getMaxHistory,
// and every progressAnalytics.js/prAnalytics.js function take a plain
// array with no programId filter anywhere, and setActiveProgram
// (programSwitchService.js) only ever writes to `programRuns` documents,
// never to workouts/measurements/maxes. No production code changed as a
// result of that audit — see the report for the full evidence and the new
// automated multi-program regression test that proves it. Same reasoning
// as every prior bump: without it, an already-installed v19 browser would
// keep serving the OLD shell (still containing and referencing the
// now-deleted temporary reset module) forever, since cache-first never
// re-checks the network for a hit.
//
// v21 — Home "Workouts This Week" correction. No precached asset was added
// or removed; the bump ships changed module content:
//   - js/services/workoutService.js — countCompletedSince now counts only
//     workouts whose resolveCompletionState (the same resolver History
//     uses) is 'complete' or 'partial'; skipped / not_logged / in_progress
//     are excluded.
//   - js/views/home.js — "This Week" is the current calendar week, Monday
//     00:00 local time through now, instead of a rolling 7 days.
// Without the bump an installed v20 browser would keep serving the old
// modules, since cache-first never re-checks the network for a hit.
//
// v23 — same app (1.1.0), cache bump only: several v22 builds were handed
// out under the same cache name; a browser that installed an earlier v22
// would otherwise keep serving its old modules (cache-first). Forces every
// device onto the current Program Import + Admin Reset + stale-device guard.
//
// v22 — app version 1.1.0 (config/app.config.js APP_META.version):
//   - Program Import (JSON + CSV): new js/utils/programImport.js (pure
//     parse/validate) and js/views/programImport.js (Program → Import
//     Program), plus programService.importProgram (one all-or-nothing
//     transaction that never overwrites an existing program id).
//   - Actual-set logging: new js/utils/setLogging.js (per-set status
//     completed/modified/failed/skipped, additive `status` field) and
//     js/components/setResult.js (shared set UI for the live logger and
//     History's existing edit mode).
//   - heldback branding (APP_META publisher; login byline, footer, Profile).
//   - Program Import accepts flat warm-up ramps ({type:'sets'}); the Day
//     editor keeps them read-only and intact.
//   - Admin "Reset training data": js/views/adminReset.js +
//     js/services/adminResetService.js (lazy-loaded from Admin → user). The
//     reset runs server-side (Cloud Function `adminResetUserFitness`); its
//     Functions SDK + network call are never cached (not in the lists below).
//   - Stale-device guard after an admin reset: js/services/trainingGenerationService.js
//     + js/utils/trainingGeneration.js (static imports of the app's write services).
//   - '#/import' (dead route) now redirects to Program Import; Home shows
//     "Week N / <program's own week count>" instead of a hard-coded 8.
//   - Precache fix: js/utils/exportFlatten.js is reachable (profile.js →
//     exportService.js re-export) and is now listed below; the old comment
//     calling it dead code was wrong, so Profile could fail to load offline.
const CACHE_VERSION = 'v23';
const CACHE_PREFIX = 'deadlift-tracker-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

// Every local module reachable from js/app.js's static import graph plus
// every route in config/app.config.js's ROUTES table (including the 404
// view), transitively, per a real graph-walking audit re-run against the
// exact current source tree (not hand-maintained/guessed) — see this
// phase's final report for the audit method and its full output. (v22:
// re-audited; every reachable local module is listed, including
// js/utils/exportFlatten.js, which an earlier audit had missed.)
//
// NOTE (v22): config/app.config.js's ROUTES table used to map '/import' to
// a js/views/import.js that never existed. It now maps to js/views/program.js,
// which redirects '#/import' to '#/program?import=1' (Program Import).
const SHELL_MODULES = [
  'config/app.config.js',
  'js/app.js',
  'js/components/navigation.js',
  'js/components/setResult.js',
  'js/core/access.js',
  'js/core/auth.js',
  'js/core/firebase.js',
  'js/core/pwa.js',
  'js/core/router.js',
  'js/core/sync-status.js',
  'js/services/accessAdminService.js',
  'js/services/adminInsightsService.js',
  'js/services/adminResetService.js',
  'js/services/exportService.js',
  'js/services/measurementService.js',
  'js/services/programEditService.js',
  'js/services/programService.js',
  'js/services/programSwitchService.js',
  'js/services/restoreService.js',
  'js/services/trainingGenerationService.js',
  'js/services/userService.js',
  'js/services/workoutService.js',
  'js/utils/adminStats.js',
  'js/utils/calculations.js',
  'js/utils/csv.js',
  'js/utils/dates.js',
  'js/utils/dom.js',
  'js/utils/download.js',
  'js/utils/exerciseOrdering.js',
  'js/utils/exportFlatten.js',
  'js/utils/exportSerialize.js',
  'js/utils/firestoreRead.js',
  'js/utils/maxHistoryAnalytics.js',
  'js/utils/offlineError.js',
  'js/utils/programDisplay.js',
  'js/utils/programEditModel.js',
  'js/utils/programImport.js',
  'js/utils/programProgress.js',
  'js/utils/programSwitch.js',
  'js/utils/prAnalytics.js',
  'js/utils/progressAnalytics.js',
  'js/utils/requiredLifts.js',
  'js/utils/restorePlan.js',
  'js/utils/setLogging.js',
  'js/utils/starterProgram.js',
  'js/utils/trainingGeneration.js',
  'js/utils/validation.js',
  'js/utils/workoutCompletion.js',
  'js/utils/workoutSnapshot.js',
  'js/views/admin.js',
  'js/views/adminReset.js',
  'js/views/adminUserDetail.js',
  'js/views/disabled.js',
  'js/views/history.js',
  'js/views/home.js',
  'js/views/login.js',
  'js/views/notFound.js',
  'js/views/nutrition.js',
  'js/views/onboarding.js',
  'js/views/pending.js',
  'js/views/profile.js',
  'js/views/program.js',
  'js/views/programDayEditor.js',
  'js/views/programImport.js',
  'js/views/progress.js',
  'js/views/workout.js',
];

// Non-JS local shell assets: the manifest, every stylesheet, both icons,
// and the seed-program JSON (fetched at runtime by
// js/services/programService.js's seedDeadliftProgramForUser via
// `fetch(new URL('../../data/program.deadlift-8wk.json', import.meta.url))`
// — i.e. this exact repo-root-relative path). Caching this file does not
// modify it in any way; data/program.deadlift-8wk.json remains a protected,
// untouched file (see the final report).
//
// './index.html' — the navigation fallback — is DELIBERATELY NOT listed
// here; it is precached separately by precacheCanonicalIndexHtml (below),
// which needs to do more than a plain fetch-and-store for it. Likewise
// './' (the bare repo-root URL) is deliberately NOT precached as its own
// entry at all anymore — see precacheCanonicalIndexHtml's comment for why.
const SHELL_STATIC_ASSETS = [
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './css/tokens.css',
  './css/base.css',
  './css/components.css',
  './css/views.css',
  './data/program.deadlift-8wk.json',
];

// The ENTIRE app's Firebase SDK surface is exactly these 3 pinned,
// version-locked CDN URLs (js/core/firebase.js, auth.js, access.js, and 9
// service files all import from one of these three, never anything else —
// confirmed by a project-wide grep as part of this phase's investigation).
// Vendoring local copies was considered and rejected for this codebase: it
// would require rewriting import specifiers across 10+ files and a working
// package-registry/build step this project deliberately doesn't have.
// Instead, since the URLs are version-pinned (10.13.0 is never overwritten
// in place by the CDN) they are effectively immutable, so precaching them
// exactly like a local vendored copy — and serving them cache-first
// thereafter (see the fetch handler) — gives the same offline-boot
// guarantee without any build step, new dependency, or import rewrite.
// gstatic.com serves these with proper CORS headers, so the cached
// response is a normal, inspectable 'cors' response, not an opaque one.
const FIREBASE_CDN_URLS = [
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js',
];

const PRECACHE_URLS = [...SHELL_MODULES, ...SHELL_STATIC_ASSETS, ...FIREBASE_CDN_URLS];

/**
 * Phase 5A correction pass — root cause of the offline-refresh failure this
 * fixes:
 *
 * `cache.addAll(['./', './index.html', ...])` fetches each URL and stores
 * WHATEVER Response comes back, byte-for-byte, including its internal
 * `redirected` flag. Depending on how the app is served (this was
 * reproduced with `npx serve .`, and can also happen on some static hosts'
 * trailing-slash/clean-URL normalization), a request for the bare origin
 * root can come back as a Response whose `redirected` flag is `true` (the
 * browser's own `fetch()` transparently followed a redirect to get there).
 * Cache Storage preserves that flag exactly. Later, when that CACHED
 * Response is returned via `event.respondWith()` for a real navigation
 * FetchEvent, Chrome refuses it outright: "a redirected response was used
 * for a request whose redirect mode is not 'follow'" — the request never
 * reaches any usable page, and offline F5 fails with ERR_FAILED.
 *
 * The fix: never store index.html (the only Response this SW ever hands
 * back to a navigation) as whatever redirect-flavored Response `fetch()`
 * happens to return. Fetch it, then read its body and reconstruct a PLAIN
 * `new Response(...)` from scratch — a freshly constructed Response is
 * never "redirected" by definition, regardless of how the original bytes
 * were obtained. That reconstructed, guaranteed-safe Response is the ONLY
 * thing ever cached under the './index.html' key, and the ONLY thing the
 * navigation fallback (below) ever returns.
 *
 * './' itself is no longer precached as a separate entry at all: it added
 * no value (a navigation to './' falls back to this same './index.html'
 * entry regardless — see networkFirstNavigation below) and was the exact
 * entry implicated in reproducing this bug, so removing it is also simply
 * one less redirect-prone URL for a static host's own quirks to trip over.
 */
async function precacheCanonicalIndexHtml(cache) {
  const response = await fetch('./index.html');
  if (!response || !response.ok) throw new Error('failed to fetch ./index.html for precaching');
  const body = await response.blob();
  const safeResponse = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  await cache.put('./index.html', safeResponse);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(PRECACHE_URLS);
      await precacheCanonicalIndexHtml(cache);
    }),
    // Deliberately NOT wrapped in try/catch: both `cache.addAll` and
    // `precacheCanonicalIndexHtml` reject on any failure (a missing asset,
    // a bad index.html fetch), which rejects this whole promise, which
    // makes the browser mark this install FAILED — whatever service
    // worker (if any) was previously controlling the page keeps doing so.
    // This is the "fail visibly/logically rather than activate an
    // incomplete shell" behavior this phase requires — an incomplete or
    // unsafe precache is never silently accepted.
    //
    // Deliberately does NOT call self.skipWaiting() here — a newly
    // installed worker is meant to sit in the "waiting" state until the
    // person explicitly accepts the update banner (js/core/pwa.js posts
    // {type:'SKIP_WAITING'} only after that click). Calling it here would
    // let a new shell version take over an already-open, possibly
    // mid-workout tab without asking first, which Phase 5A explicitly
    // rules out.
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
        // Only OUR OWN prefixed shell caches are ever touched here — an
        // obsolete `deadlift-tracker-shell-v0` from a previous release is
        // removed; any other, unrelated cache (there are none today, but
        // this guards against ever accidentally deleting one added later
        // for an unrelated purpose) is left completely alone.
      ))
      .then(() => self.clients.claim()),
      // clients.claim() only has any practical effect once this worker has
      // actually reached 'activated' — which, per the skipWaiting note
      // above, only happens after the person's explicit "Reload" click. It
      // is what lets that click's reload actually pick up the new worker
      // (by firing 'controllerchange' for the already-open tab) instead of
      // silently doing nothing until a future manual reload.
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

/**
 * Navigation requests (loading/refreshing the app itself): network-first,
 * with the precached shell as an offline fallback. This is the strategy
 * that lets BOTH halves of the Phase 5A requirement hold at once — an
 * online visit always gets the live, current index.html straight from the
 * network (never a stale precached copy), while an offline refresh still
 * successfully loads the app shell from cache instead of failing outright.
 */
async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    // Every navigation — 'http://host/', 'http://host/#/home', or any other
    // hash route (the fragment never reaches the server, and this app is a
    // pure client-side hash router) — falls back to this SAME precached,
    // guaranteed-non-redirected './index.html' entry. See
    // precacheCanonicalIndexHtml above for why it's safe to return here.
    const cache = await caches.open(CACHE_NAME);
    return await cache.match('./index.html');
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // never intercept writes of any kind, on any origin

  if (FIREBASE_CDN_URLS.includes(request.url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    // Every other cross-origin GET — Google Fonts, Firestore's own RPC/
    // REST traffic, Google Identity/OAuth endpoints, a user's Google
    // profile-photo image, etc. — is left completely unintercepted. This
    // is deliberate and is the entire reason those requests can never be
    // indiscriminately cached, exposed to another origin, or made to look
    // like this app's own cached data: this service worker simply never
    // sees a chance to touch them.
    return;
  }

  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // Any other same-origin GET is one of this app's own precached static
  // shell assets (a JS module, a stylesheet, the manifest, an icon, or the
  // seed-program JSON) — cache-first, since the exact set this SW needs is
  // already fully precached under this cache version; a genuinely new
  // asset that was never precached (should not happen for a versioned
  // release, but handled defensively) falls through to a live network
  // fetch and is cached for next time.
  event.respondWith(cacheFirst(request));
});
