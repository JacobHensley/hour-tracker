// settings.js — the account surfaces: the header avatar and its menu, the
// full-frame "Account & data" screen, and the sign-in screen. Same rules as
// render.js: HTML strings only, no listeners, every control has a data-action.

import { relativeTime, formatBytes } from './billing.js';

/** Escapes text for safe interpolation into an innerHTML template. */
function esc(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

/** The official Google "G", per Google's sign-in branding guidelines: the
 *  four-colour mark, unmodified, on its own light keyline area. */
const GOOGLE_MARK = `
  <svg class="google-mark" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true" focusable="false">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>`;

// ---------- Account identity ----------

/** The letter shown when there is no profile photo. */
function initialOf(account) {
  const source = (account && (account.email || account.displayName)) || '';
  return source ? source[0].toUpperCase() : '?';
}

/** Google's photo when there is one, the email's first letter otherwise. */
function avatarHtml(account, className) {
  if (account && account.photoURL) {
    return `<span class="${className}"><img class="avatar-photo" src="${esc(account.photoURL)}" alt=""></span>`;
  }
  return `<span class="${className}">${esc(initialOf(account))}</span>`;
}

function emailOf(account) {
  if (!account) return 'Not signed in';
  return account.anonymous ? 'No account' : account.email || 'Signed in';
}

function providerOf(account) {
  if (!account) return 'Not signed in';
  return account.anonymous ? 'Local data on this device' : 'Google account';
}

/**
 * The sync line, shared by the account menu and the settings card. Offline is
 * the only state that reads as anything but Synced — pending writes while
 * online clear in milliseconds and aren't worth reporting.
 */
function syncLine(sync) {
  if (!sync || sync.online) {
    return { ok: true, label: 'Synced', when: relativeTime(sync && sync.lastSyncedAt) };
  }
  const queued = sync.pending
    ? `Offline — ${sync.pending} change${sync.pending === 1 ? '' : 's'} queued`
    : 'Offline';
  return { ok: false, label: queued, when: '' };
}

// ---------- Header avatar + account menu ----------

/**
 * Fills the header's `#account-slot`. The `data-popup` marker sits on the
 * wrapper *inside* the slot, not on the slot itself: render() replaces the
 * slot's children, and the outside-click check walks up from the clicked node
 * — which would have no `[data-popup]` ancestor left once it is detached.
 */
export function accountButton(data, ui) {
  const { account, sync } = data;
  const line = syncLine(sync);
  const anonymous = !account || account.anonymous;

  return `
  <span class="pop account-pop" data-popup>
    <button class="avatar" data-action="toggle-account-menu" aria-label="Account">${
      account && account.photoURL
        ? `<img class="avatar-photo" src="${esc(account.photoURL)}" alt="">`
        : esc(initialOf(account))
    }</button>
    <div class="menu account-menu"${ui.accountMenuOpen ? '' : ' hidden'}>
      <div class="account-identity">
        <div class="account-email ellip">${esc(emailOf(account))}</div>
        <div class="account-provider">${esc(providerOf(account))}</div>
      </div>
      <div class="account-sync">
        <span class="sync-dot${line.ok ? '' : ' off'}"></span>
        <span class="sync-label">${esc(line.label)}</span>
        <span class="sync-when">${esc(line.when)}</span>
      </div>
      <div class="account-rows">
        <button class="menu-row account-row" data-action="open-settings">Settings</button>
        ${
          anonymous
            ? '<button class="menu-row account-row" data-action="go-signin">Sign in</button>'
            : '<button class="menu-row account-row" data-action="sign-out">Sign out</button>'
        }
      </div>
    </div>
  </span>`;
}

// ---------- Settings — Account & data ----------

/** `8 tasks, 14 sessions and 2 invoices.` */
function countSentence({ tasks, sessions, invoices }) {
  const part = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `${part(tasks.length, 'task')}, ${part(sessions.length, 'session')} and ${part(invoices.length, 'invoice')}.`;
}

export function settingsScreen(data, ui) {
  const { account, sync } = data;
  const line = syncLine(sync);
  const anonymous = !account || account.anonymous;
  const busy = Boolean(ui.busy);

  const accountCard = `
    <div class="account-card">
      ${avatarHtml(account, 'avatar avatar-lg')}
      <span class="account-card-main">
        <span class="account-card-email ellip">${esc(emailOf(account))}</span>
        <span class="account-card-sync">
          <span class="sync-dot${line.ok ? '' : ' off'}"></span>${esc(
            line.when ? `${line.label} · ${line.when}` : line.label
          )}
        </span>
      </span>
      ${
        anonymous
          ? '<button class="btn-muted-sm" data-action="go-signin">Sign in</button>'
          : '<button class="btn-muted-sm" data-action="sign-out">Sign out</button>'
      }
    </div>`;

  const importBlock = ui.importFileName
    ? `
      <div class="import-chosen">
        <div class="import-file">
          <span class="import-file-name ellip">${esc(ui.importFileName)}</span>
          <span class="import-file-size">${esc(formatBytes(ui.importFileSize))}</span>
        </div>
        <div class="danger-line">This overwrites your current tasks, sessions and invoices.</div>
        <div class="settings-actions">
          <button class="btn-muted-sm" data-action="cancel-import"${busy ? ' disabled' : ''}>Cancel</button>
          <button class="btn-primary-sm" data-action="confirm-import"${busy ? ' disabled' : ''}>${
            ui.busy === 'import' ? 'Restoring…' : 'Replace all data'
          }</button>
        </div>
      </div>`
    : `<button class="dashed-btn import-btn" data-action="pick-import-file"${busy ? ' disabled' : ''}>Choose a backup file</button>`;

  const billTo = `
    <div class="caption settings-caption">BILL TO</div>
    <div class="settings-card">
      <input id="client-name-input" class="input client-input" data-setting="clientName" value="${esc(
        data.settings.clientName || ''
      )}" placeholder="Client name" maxlength="120">
      <div class="settings-row-desc spaced">Appears on every invoice you generate.</div>
    </div>`;

  const backups = `
    <div class="caption settings-caption">BACKUPS</div>
    <div class="settings-card">
      <div class="settings-row">
        <span class="settings-row-main">
          <span class="settings-row-title">Export</span>
          <span class="settings-row-desc">One JSON file with every task, session, invoice and setting.</span>
        </span>
        <button class="btn-soft-sm" data-action="export-backup"${busy ? ' disabled' : ''}>Export</button>
      </div>
      <div class="settings-sub">
        <span class="settings-row-title">Import</span>
        <span class="settings-row-desc">Restoring replaces everything currently in this account.</span>
        ${importBlock}
      </div>
    </div>`;

  const dangerZone = `
    <div class="caption settings-caption">DANGER ZONE</div>
    <div class="settings-card">
      <div class="settings-row">
        <span class="settings-row-main">
          <span class="settings-row-title">Delete all data</span>
          <span class="settings-row-desc">${esc(countSentence(data))}</span>
        </span>
        <button class="btn-danger-sm${ui.confirmDeleteAll ? ' armed' : ''}" data-action="delete-all"${
          busy ? ' disabled' : ''
        }>${ui.busy === 'delete' ? 'Deleting…' : ui.confirmDeleteAll ? 'Confirm' : 'Delete'}</button>
      </div>
      ${
        ui.confirmDeleteAll
          ? '<div class="danger-line spaced">Export a backup first — this cannot be undone.</div>'
          : ''
      }
    </div>`;

  return `
    <div class="screen-top">
      <button class="back-btn" data-action="close-settings" aria-label="Back">‹</button>
      <span class="screen-title">Account &amp; data</span>
    </div>
    <div class="screen-body">
      ${accountCard}
      ${billTo}
      ${backups}
      ${dangerZone}
      ${ui.toast ? `<div class="toast floating settings-toast">${esc(ui.toast)}</div>` : ''}
    </div>
    <input type="file" id="import-file-input" accept="application/json,.json" hidden>`;
}

// ---------- Sign-in ----------

export function signInScreen(ui) {
  // The collision case: this Google account already has its own data, so
  // switching to it leaves the anonymous data on this device behind.
  if (ui.signInConflict) {
    return `
      <div class="signin-title">Already in use</div>
      <div class="signin-copy">${esc(ui.signInConflict)} already has its own data in Hours. Signing in switches to
        it. What's on this device now belongs to no account — once you switch, an exported file is the only way
        back to it.</div>
      <button class="btn-google" data-action="export-backup">Export this device's data first</button>
      <div class="signin-actions">
        <button class="btn-muted-sm" data-action="cancel-signin">Cancel</button>
        <button class="btn-primary-sm" data-action="confirm-signin">Sign in anyway</button>
      </div>
      ${ui.toast ? `<div class="toast floating signin-toast">${esc(ui.toast)}</div>` : ''}`;
  }

  return `
    <div class="signin-title">Hours</div>
    <div class="signin-copy">Track time against tasks, apply your billing rules, and package the work onto invoices.</div>
    <button class="btn-google" data-action="sign-in-google"${ui.busy ? ' disabled' : ''}>
      <span class="google-keyline">${GOOGLE_MARK}</span>${
        ui.busy === 'signin' ? 'Signing in…' : 'Continue with Google'
      }</button>
    <div class="signin-note">Your tasks and sessions sync to your Google account, so the same data follows you
      across devices.</div>
    <button class="signin-skip" data-action="continue-local">Continue without an account</button>
    ${ui.toast ? `<div class="toast floating signin-toast">${esc(ui.toast)}</div>` : ''}`;
}
