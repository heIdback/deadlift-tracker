/**
 * Escapes a value for safe interpolation into an innerHTML template string.
 * Used anywhere Firebase/user-controlled data (display name, email, program
 * names, imported spreadsheet text, etc.) is inserted into markup, per the
 * Phase 2 hardening pass — prefer textContent/DOM properties where
 * practical, and use this where a template-string approach is kept.
 */
export function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow http(s) URLs through to an `src`/`href` attribute. */
export function safeUrl(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

/**
 * Phase 4 polish item (was left over from Phase 3F): a Google profile photo
 * URL can go bad (expired, revoked, blocked) even though it looked valid
 * when the access record was written, and the bare `<img>` tag Admin
 * list/User Detail already render for it then falls back to the browser's
 * own broken-image icon — never intended as UI. Call this once, right
 * after setting `root.innerHTML`, on any root that may contain
 * `<img data-avatar ...>` elements; it swaps each one that actually fails
 * to load for a small neutral silhouette instead, matching the image's own
 * width/height so layout doesn't jump. Purely a rendering nicety — it does
 * not touch the underlying `photoURL` value or any Firestore data.
 */
export function wireAvatarFallbacks(root) {
  root.querySelectorAll('img[data-avatar]').forEach((img) => {
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.className = `${img.className} avatar-fallback`.trim();
      span.setAttribute('aria-hidden', 'true');
      if (img.width) span.style.width = `${img.width}px`;
      if (img.height) span.style.height = `${img.height}px`;
      span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/>'
        + '<path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>';
      img.replaceWith(span);
    }, { once: true });
  });
}
