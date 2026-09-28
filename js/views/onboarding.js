// New-user 1RM onboarding (Phase 3E). Rendered by router.js directly, the
// same way pending.js/disabled.js are, whenever the signed-in user is
// approved but core/access.js's onboarding check found one or more of the
// starter program's required lifts missing a currentMaxes entry. Whatever
// hash the user is sitting on or types manually, this is what actually
// renders until it's resolved — see core/access.js for why, and
// firestore.rules for what actually enforces per-user data isolation
// regardless of this screen.
import { getCurrentUser, signOut } from '../core/auth.js';
import { recheckAccess } from '../core/access.js';
import { recordOneRepMax } from '../services/userService.js';
import { REQUIRED_STARTER_LIFTS } from '../utils/requiredLifts.js';
import { isValidWeight } from '../utils/validation.js';
import { escapeHtml } from '../utils/dom.js';

export async function mount(root, { missingLiftIds = [] } = {}) {
  const user = getCurrentUser();
  // Only ask for what's actually missing (Part F: "If some maxes already
  // exist, preserve them and only require missing required values") —
  // this list is recomputed by access.js on every resolution, so a value
  // saved here never gets asked for again.
  const liftsToAsk = REQUIRED_STARTER_LIFTS.filter((l) => missingLiftIds.includes(l.id));

  root.innerHTML = `
    <div class="access-screen">
      <div class="access-card">
        <h1 class="access-title">One quick step</h1>
        <p class="access-body">
          Your training program calculates every working weight from your current
          1-rep max. Enter what you can — an honest current or recent estimate is
          fine, and you can update any of these any time from Profile.
        </p>
        <form id="onboarding-maxes-form" class="form-grid">
          ${liftsToAsk.map((l) => `
            <label class="field">
              <span>${escapeHtml(l.label)} (kg)</span>
              <input type="number" inputmode="decimal" step="0.5" min="0" max="500"
                name="${l.id}" placeholder="e.g. 100" required>
            </label>`).join('')}
        </form>
        <button type="button" class="btn btn-primary btn-large" id="save-onboarding-btn">Save and continue</button>
        <button type="button" class="btn btn-secondary" id="signout-btn">Sign out</button>
        <p class="form-status" id="onboarding-status" role="status"></p>
      </div>
    </div>`;

  root.querySelector('#save-onboarding-btn').addEventListener('click', async (e) => {
    const btn = e.target;
    const status = root.querySelector('#onboarding-status');
    const form = root.querySelector('#onboarding-maxes-form');
    btn.disabled = true;
    status.textContent = 'Saving…';
    try {
      for (const l of liftsToAsk) {
        const kg = Number(form.elements[l.id].value);
        if (!isValidWeight(kg)) throw new Error(`Enter a valid weight for ${l.label}.`);
        // Same max service/history architecture Profile's own 1RM form
        // uses (records a maxes/{id} history entry AND updates the
        // currentMaxes cache) — no parallel storage model for onboarding.
        await recordOneRepMax(user.uid, { exerciseId: l.id, kg, kind: 'training', source: 'manual' });
      }
      status.textContent = 'Saved — continuing…';
      // Re-runs access resolution: recomputes the missing-maxes list (now
      // empty) and broadcasts the new state. router.js and app.js are both
      // subscribed to that broadcast, so THAT is what actually moves the
      // user into the app — nothing to navigate manually here.
      await recheckAccess(user);
    } catch (err) {
      console.error(err);
      status.textContent = `Error: ${err.message}`;
      btn.disabled = false;
    }
  });

  root.querySelector('#signout-btn').addEventListener('click', async () => {
    if (confirm('Sign out?')) await signOut();
  });
}
