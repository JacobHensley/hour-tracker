// backup.js — drives the standalone Backup & Restore page. It runs on the
// same origin as the app, so it opens the same data automatically. There is
// no login step here; see connect() in firebase.js.

import { connect, exportAll, importAll, currentCounts } from './firebase.js';
import { toIsoDate } from './billing.js';

const $ = (id) => document.getElementById(id);

/** Escapes text for safe interpolation into an innerHTML template. */
function esc(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

/** Paints a status line under a section. */
function status(id, message, kind) {
  $(id).innerHTML = message ? `<div class="status${kind ? ' ' + kind : ''}">${esc(message)}</div>` : '';
}

function triggerDownload(backup, suffix) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `hour-tracker-${toIsoDate(new Date())}${suffix || ''}.json`;
  link.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function refreshCounts() {
  const counts = await currentCounts();
  $('counts').innerHTML = [
    ['Tasks', counts.tasks],
    ['Sessions', counts.sessions],
    ['Invoices', counts.invoices]
  ]
    .map(([label, n]) => `<div class="kv"><span>${label}</span><span>${n}</span></div>`)
    .join('');
  return counts;
}

// ---------- Back up ----------

$('download-btn').onclick = async () => {
  status('export-status', 'Reading…');
  try {
    const backup = await exportAll();
    triggerDownload(backup);
    const { tasks, sessions, invoices } = backup.data;
    status(
      'export-status',
      `Saved ${tasks.length} tasks, ${sessions.length} sessions, ${invoices.length} invoices.`,
      'good'
    );
  } catch (error) {
    status('export-status', 'Backup failed: ' + error.message, 'bad');
  }
};

$('show-btn').onclick = async () => {
  status('export-status', 'Reading…');
  try {
    const out = $('json-out');
    out.value = JSON.stringify(await exportAll(), null, 2);
    out.hidden = false;
    out.select();
    status('export-status', 'Copy this somewhere safe.', 'good');
  } catch (error) {
    status('export-status', 'Backup failed: ' + error.message, 'bad');
  }
};

// ---------- Restore ----------

$('file-input').onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $('json-in').value = await file.text();
  status('restore-status', `Loaded ${file.name}. Choose a mode, then Restore.`);
  disarm();
};

/** Replace is destructive, so the button arms on the first press. */
let armed = false;

function disarm() {
  armed = false;
  $('restore-btn').textContent = 'Restore';
  $('restore-btn').classList.remove('armed');
}

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.onchange = disarm;
}
$('json-in').oninput = disarm;

$('restore-btn').onclick = async () => {
  const raw = $('json-in').value.trim();
  if (!raw) return status('restore-status', 'Choose a file or paste a backup first.', 'bad');

  let backup;
  try {
    backup = JSON.parse(raw);
  } catch {
    return status('restore-status', "That isn't valid JSON.", 'bad');
  }

  const replace = document.querySelector('input[name="mode"]:checked').value === 'replace';

  if (replace && !armed) {
    armed = true;
    $('restore-btn').textContent = 'Confirm replace';
    $('restore-btn').classList.add('armed');
    const counts = await currentCounts();
    return status(
      'restore-status',
      `This deletes ${counts.tasks} tasks, ${counts.sessions} sessions and ${counts.invoices} invoices, then loads the backup. Press again to confirm.`,
      'bad'
    );
  }

  $('restore-btn').disabled = true;
  try {
    if (replace) {
      status('restore-status', 'Saving a safety copy of current data…');
      triggerDownload(await exportAll(), '-before-restore');
    }
    status('restore-status', 'Restoring…');
    const written = await importAll(backup, { replace });
    await refreshCounts();
    status(
      'restore-status',
      `Restored ${written.tasks} tasks, ${written.sessions} sessions, ${written.invoices} invoices.`,
      'good'
    );
  } catch (error) {
    status('restore-status', 'Restore failed: ' + error.message, 'bad');
  } finally {
    $('restore-btn').disabled = false;
    disarm();
  }
};

// ---------- Startup ----------

connect()
  .then(async (dataId) => {
    $('dataid').textContent = 'Data ID: ' + dataId;
    await refreshCounts();
    for (const id of ['download-btn', 'show-btn', 'restore-btn']) $(id).disabled = false;
  })
  .catch((error) => {
    $('counts').innerHTML = '<div class="kv"><span>Status</span><span>Not connected</span></div>';
    status('export-status', 'Could not connect: ' + error.message, 'bad');
  });
