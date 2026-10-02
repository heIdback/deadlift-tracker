// v27 — the "Export for analysis" card on the Profile screen.
//
// Flow: choose range → "Prepare file" (reads data, shows what is inside) →
// Download / Share / Copy question. The "last analysis" marker only moves
// forward after Download or a completed Share — preparing alone changes nothing.
import { prepareAnalysisExport, readAnalysisMarker, markAnalysisExported } from '../services/analysisExportService.js';
import { RANGE_MODE, ANALYSIS_PROMPT, analysisFilename } from '../utils/analysisExport.js';
import { downloadJson } from '../utils/download.js';
import { escapeHtml } from '../utils/dom.js';
import { formatDate } from '../utils/dates.js';

const OFFLINE_MESSAGE = "You're offline — connect to the internet to prepare the file.";

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function analysisCardHtml(profile) {
  const marker = readAnalysisMarker(profile);
  const hasMarker = marker.throughMillis > 0;
  const last = hasMarker
    ? `Last analysis covered training up to ${escapeHtml(formatDate(marker.throughMillis))}.`
    : 'No analysis exported yet — the first file will contain everything.';
  return `
      <div class="card" id="analysis-card">
        <h3>Export for analysis</h3>
        <p class="text-muted">Makes one file with your workouts, bodyweight, 1RM history and goal, ready to send to Claude for a progress review. It contains no email or account details.</p>
        <p class="text-muted" id="analysis-last">${last}</p>
        <div class="analysis-range" role="radiogroup" aria-label="What to include">
          <label class="analysis-option"><input type="radio" name="analysis-range" value="${RANGE_MODE.SINCE_LAST}"${hasMarker ? ' checked' : ' disabled'}> New since last analysis</label>
          <label class="analysis-option"><input type="radio" name="analysis-range" value="${RANGE_MODE.ALL}"${hasMarker ? '' : ' checked'}> Everything</label>
        </div>
        <div class="btn-stack">
          <button type="button" class="btn btn-secondary" id="analysis-prepare-btn">Prepare file</button>
        </div>
        <div id="analysis-result" hidden></div>
        <p class="form-status" id="analysis-status" role="status"></p>
      </div>`;
}

export function wireAnalysisCard(root, { uid, profile }) {
  const card = root.querySelector('#analysis-card');
  if (!card) return;
  const prepareBtn = card.querySelector('#analysis-prepare-btn');
  const result = card.querySelector('#analysis-result');
  const status = card.querySelector('#analysis-status');
  const lastLine = card.querySelector('#analysis-last');
  const selectedMode = () => card.querySelector('input[name="analysis-range"]:checked')?.value ?? RANGE_MODE.ALL;

  let prepared = null; // {data, json, throughMillis, marker, filename}
  let busy = false;

  function clearResult() {
    prepared = null;
    result.hidden = true;
    result.innerHTML = '';
    status.textContent = '';
  }
  card.querySelectorAll('input[name="analysis-range"]').forEach((r) => r.addEventListener('change', clearResult));

  function noteExported(where) {
    if (!prepared) return;
    markAnalysisExported(uid, prepared.throughMillis, prepared.marker.throughMillis);
    if (prepared.throughMillis) {
      lastLine.textContent = `Last analysis covered training up to ${formatDate(prepared.throughMillis)}.`;
      status.textContent = `${where} Marked as analysed up to ${formatDate(prepared.throughMillis)}.`;
      // Next "Prepare" re-reads the profile; keep this card's own radio state sensible.
      const sinceRadio = card.querySelector(`input[value="${RANGE_MODE.SINCE_LAST}"]`);
      if (sinceRadio) sinceRadio.disabled = false;
    } else {
      status.textContent = where;
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(ANALYSIS_PROMPT);
      status.textContent = 'Question copied — paste it into Claude together with the file.';
    } catch {
      let box = result.querySelector('#analysis-prompt-text');
      if (!box) {
        box = document.createElement('textarea');
        box.id = 'analysis-prompt-text';
        box.readOnly = true;
        box.rows = 8;
        box.className = 'analysis-prompt-text';
        result.appendChild(box);
      }
      box.value = ANALYSIS_PROMPT;
      box.focus();
      box.select();
      status.textContent = 'Copy this text by hand and paste it into Claude together with the file.';
    }
  }

  function renderReady(p) {
    const d = p.data.range;
    const empty = d.workouts === 0 && d.newBodyweightEntries === 0;
    if (empty) {
      const since = p.marker.throughMillis ? ` since ${formatDate(p.marker.throughMillis)}` : '';
      result.innerHTML = `<p class="text-muted">Nothing new${escapeHtml(since)}. Choose “Everything” if you want a file anyway.</p>`;
      result.hidden = false;
      return;
    }
    const parts = [`${d.workouts} workout${d.workouts === 1 ? '' : 's'}`];
    if (d.skippedWorkouts) parts[0] += ` (${d.skippedWorkouts} skipped)`;
    parts.push(`${d.newBodyweightEntries} bodyweight entr${d.newBodyweightEntries === 1 ? 'y' : 'ies'}`);
    result.innerHTML = `
      <div class="card-notice">
        <p><strong>File ready:</strong> ${escapeHtml(parts.join(', '))} · ${escapeHtml(formatSize(p.bytes))}</p>
        ${d.historyMayBeTruncated ? '<p class="text-muted">Your history is very long, so the oldest entries may not be included in the trends.</p>' : ''}
      </div>
      <div class="btn-stack">
        <button type="button" class="btn btn-primary" id="analysis-download-btn">Download file</button>
        ${p.canShare ? '<button type="button" class="btn btn-secondary" id="analysis-share-btn">Share…</button>' : ''}
        <button type="button" class="btn btn-secondary" id="analysis-copy-btn">Copy question for Claude</button>
      </div>
      <p class="text-muted">“Last analysis” moves forward when you download or share the file.</p>`;
    result.hidden = false;

    result.querySelector('#analysis-download-btn').addEventListener('click', () => {
      downloadJson(p.filename, p.data);
      noteExported('Downloaded.');
    });
    result.querySelector('#analysis-copy-btn').addEventListener('click', copyPrompt);
    // Share. Phones differ in what they let a web page hand to another app, so
    // the file goes out as plain text (.txt) — the one type every share sheet
    // accepts — and if that is still refused, a second button shares the same
    // content as message text instead. Download always works as the last resort.
    const SHARE_TITLE = 'Deadlift Tracker — analysis export';
    async function runShare(payload, doneMessage) {
      try {
        await navigator.share(payload);
        noteExported(doneMessage);
        return true;
      } catch (err) {
        if (err?.name === 'AbortError') { status.textContent = 'Share cancelled — nothing was marked as analysed.'; return false; }
        console.error(err);
        status.textContent = `Could not share (${err?.name ?? 'error'}: ${err?.message ?? 'unknown'}). Try “Share as text”, or use Download.`;
        offerTextShare();
        return false;
      }
    }
    function offerTextShare() {
      if (typeof navigator.share !== 'function' || p.bytes > 400000 || result.querySelector('#analysis-share-text-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary';
      btn.id = 'analysis-share-text-btn';
      btn.textContent = 'Share as text';
      btn.addEventListener('click', () => runShare({ title: SHARE_TITLE, text: `${ANALYSIS_PROMPT}\n\n${p.json}` }, 'Shared as text.'));
      result.querySelector('.btn-stack').appendChild(btn);
    }
    result.querySelector('#analysis-share-btn')?.addEventListener('click', () => runShare({ files: [p.file], title: SHARE_TITLE }, 'Shared.'));
    // Phones without file sharing at all can still share the content as text.
    if (!p.canShare) offerTextShare();
  }

  prepareBtn.addEventListener('click', async () => {
    if (busy) return;
    if (!navigator.onLine) { status.textContent = OFFLINE_MESSAGE; return; }
    busy = true;
    prepareBtn.disabled = true;
    clearResult();
    status.textContent = 'Preparing…';
    try {
      const mode = selectedMode();
      const p = await prepareAnalysisExport(uid, { mode });
      p.filename = analysisFilename();
      // Built now, so the later Share click starts straight away (the browser
      // only allows sharing right after a tap).
      try {
        p.file = new File([p.json], p.filename.replace(/\.json$/, '.txt'), { type: 'text/plain' });
        p.canShare = typeof navigator.canShare === 'function' && typeof navigator.share === 'function'
          && navigator.canShare({ files: [p.file] });
      } catch { p.canShare = false; }
      prepared = p;
      status.textContent = '';
      renderReady(p);
    } catch (err) {
      console.error(err);
      status.textContent = `Could not prepare the file: ${err.message}`;
    } finally {
      busy = false;
      prepareBtn.disabled = false;
    }
  });

  // `profile` is only used for the initial render; Prepare always re-reads fresh data.
  void profile;
}
