// ─────────────────────────────────────────────────────────────────────────
// Pure decision logic for the automatic new-user starter installer (Phase
// 3E), split out from services/programService.js (which does the actual
// Firestore reads/writes) so the two things this feature must never get
// wrong — "should we touch this account at all?" and "where does Week 1
// actually start?" — can be unit-tested directly, without a database, the
// same way js/utils/programProgress.js already does for program
// advancement.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Should ensureStarterProgramForUser install anything for this account?
 * Only when the user has NO program at all AND NO active programRun — see
 * ensureStarterProgramForUser's docstring for why "any program" (not "this
 * specific starter program") is the check: a user with a different program
 * already must never get a second one silently added, and a user with
 * this exact starter program already must never get reinitialized either.
 */
export function shouldInstallStarterProgram({ existingProgramsCount, hasActiveRun }) {
  return existingProgramsCount === 0 && !hasActiveRun;
}

/**
 * Picks the starter run's initial position from the template's ACTUAL
 * ordered days — never a hardcoded day-order value — matching the same
 * "never assume a day count" principle computeNextPosition (Phase 3C)
 * already uses for program advancement. `days` must already be sorted by
 * `order` ascending (getProgramDays's query already does this); this
 * function is defensive and re-derives the minimum anyway, so it stays
 * correct even if a future caller passes an unsorted list.
 * Returns null if there are no days at all (an empty/malformed template),
 * which the caller treats as "nothing to position, don't install".
 */
export function pickStarterPosition(days) {
  if (!days || days.length === 0) return null;
  const firstDay = [...days].sort((a, b) => a.order - b.order)[0];
  return { week: 1, dayOrder: firstDay.order };
}
