import { NAV_ITEMS, APP_META } from '../../config/app.config.js';
import { getSyncStatus, onSyncStatusChange } from '../core/sync-status.js';
import { signOut } from '../core/auth.js';

const ICONS = {
  home: '<path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  dumbbell: '<path d="M4 9v6M2 10v4M20 9v6M22 10v4M7 8v8M17 8v8M7 12h10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  chart: '<path d="M4 20V10M11 20V4M18 20v-7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>',
  admin: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/>',
  // Phase 4: a simple ordered-list glyph for the new Program tab — distinct
  // from Workout's dumbbell so the two aren't confused in the bottom nav.
  program: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
};

function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

/**
 * `accessRecord` is the current user's own `/access/{uid}` record (always
 * present and `status === 'approved'` by the time this renders — see
 * app.js). The Admin tab is appended only for `role === 'admin'`; this is a
 * UX convenience, not the security boundary — firestore.rules is what
 * actually protects the admin route/data (see router.js and firestore.rules).
 */
export function renderShell(accessRecord) {
  const navItems = accessRecord?.role === 'admin'
    ? [...NAV_ITEMS, { route: '/admin', label: 'Admin', icon: 'admin' }]
    : NAV_ITEMS;

  return `
    <header class="app-header">
      <span class="app-name">${APP_META.name}</span>
      <span class="sync-indicator" id="sync-indicator" role="status" aria-live="polite"></span>
      <button class="icon-button" id="sign-out-btn" aria-label="Sign out">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
      </button>
    </header>
    <main id="view-outlet" class="view-outlet" tabindex="-1"></main>
    <nav class="bottom-nav" aria-label="Primary">
      ${navItems.map((item) => `
        <a href="#${item.route}" class="nav-item" data-route="${item.route}">
          ${iconSvg(item.icon)}
          <span>${item.label}</span>
        </a>`).join('')}
    </nav>
  `;
}

export function initShellBehavior() {
  document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
    if (confirm('Sign out?')) await signOut();
  });

  const indicator = document.getElementById('sync-indicator');
  onSyncStatusChange((status) => {
    if (!indicator) return;
    indicator.textContent = status === 'offline' ? 'Offline' : status === 'syncing' ? 'Syncing…' : 'Online';
    indicator.dataset.status = status;
  });

  const updateActiveNav = () => {
    const current = location.hash.replace(/^#/, '') || '/';
    document.querySelectorAll('.nav-item').forEach((a) => {
      a.classList.toggle('is-active', a.dataset.route === current);
    });
  };
  document.addEventListener('route:changed', updateActiveNav);
  updateActiveNav();
}
