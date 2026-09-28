// ─────────────────────────────────────────────────────────────────────────
// Tiny browser-download helper (Phase 3D). Plain Blob + temporary <a>
// click — the standard, dependency-free way to trigger a file save from
// client-side JS; works on desktop and on mobile browsers that support
// downloads at all (iOS Safari note is in the README, since some older iOS
// Safari versions open the file in a new tab/viewer instead of a native
// "Save to Files" prompt — that's a browser/OS behavior this code can't
// change, not a bug here).
// ─────────────────────────────────────────────────────────────────────────

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke shortly after — not immediately, so Safari has a chance to
  // actually start the download from the blob: URL first.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  triggerDownload(blob, filename);
}

export function downloadCsv(filename, csvText) {
  // UTF-8 BOM so Excel (Windows) detects UTF-8 correctly instead of
  // misreading accented characters in e.g. a logged note.
  const blob = new Blob(['﻿' + csvText], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, filename);
}
