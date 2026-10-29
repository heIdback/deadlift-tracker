# Tests

Automated tests for Deadlift Tracker. They are **not** deployed (`firebase.json`
→ `hosting.ignore` has `tests/**`) and don't change how the app runs.

```sh
sh tests/run-all.sh          # everything below, from the project root
```

| Folder | What | Needs |
|---|---|---|
| `unit/` | pure logic in `js/utils/` (`node --test tests/unit/*.test.mjs`) | Node 20+ |
| `service/` | the real `js/services/*` against an in-memory Firestore (`node --import ./tests/support/register.mjs --test tests/service/*.test.mjs`) | Node 20+ |
| `browser/` | the whole app in Chromium, clicking through screens (`node --test --test-concurrency=1 tests/browser/*.test.mjs`) | Playwright: `npm i -D playwright` then `npx playwright install chromium` |
| `support/precache-audit.mjs` | every module the app imports is precached by `sw.js` | Node |

**What they are not:** `tests/fakes/` is a stand-in for the Firebase SDK (in
memory, no network). It does **not** run `firestore.rules`, and it can't show
how the real SDK behaves offline or with slow networks. Changes to rules are
checked by hand (or with the Firebase emulator, which needs Java).

`fixtures/program.deadlift-210-7wk.json` is a copy of the Deadlift 210 program
used as test data.
