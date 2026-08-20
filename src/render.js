// render.js — rebuilds the UI from data + ui state. No Firebase and no event
// listeners here: every interactive element carries a data-action attribute
// that app.js handles by delegation. The 200ms clock tick updates only the
// [data-clock] text nodes, so open popups and input focus survive it.

import {
  STATUS_ORDER,
  normalizeStatus,
  minutesFor,
  billedMinutesFor,
  amountFor,
  ruleAmount,
  money,
  formatMinutes,
  formatClock,
  timerElapsedMs,
  todayIso,
  shortDate,
  longDate
} from './billing.js';
import { accountButton, settingsScreen } from './settings.js';
import { docScreen } from './invoice-doc.js';

const $ = (id) => document.getElementById(id);

/** Escapes text for safe interpolation into an innerHTML template. */
function esc(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

const STATUS_CLASS = {
  'Not started': 'not-started',
  'In Progress': 'in-progress',
  Paused: 'paused',
  Complete: 'complete',
  Billed: 'billed'
};

const taskCount = (n) => `${n} task${n === 1 ? '' : 's'}`;

export function render(data, ui, timer) {
  const d = derive(data, ui);
  // Rebuilding innerHTML destroys the focused input, so a snapshot or an
  // expiring toast arriving mid-edit would silently revert what you typed.
  const typing = captureFocus();

  $('account-slot').innerHTML = accountButton(data, ui);
  $('chip-rail').innerHTML = chipsHtml(d, ui);
  $('scroll-body').innerHTML =
    ui.bucket === 'unbilled' ? unbilledView(d, ui, timer) : invoiceView(d, ui);
  $('bottom-slot').innerHTML = bottomSlot(d, ui, timer);

  // The settings surface sits over the app, which keeps its scroll position,
  // selection and running timer underneath. The document surface layers the
  // same way, one level higher.
  const settings = $('settings-screen');
  settings.hidden = ui.screen !== 'settings';
  settings.innerHTML = settings.hidden ? '' : settingsScreen(data, ui);

  const doc = $('doc-screen');
  doc.hidden = ui.screen !== 'doc';
  doc.innerHTML = doc.hidden ? '' : docScreen(data, ui, data.account);

  restoreFocus(typing);
}

/** Snapshots the focused input's value and caret so render() can put them back. */
function captureFocus() {
  const el = document.activeElement;
  if (!el || el.tagName !== 'INPUT' || !el.id) return null;
  return { id: el.id, value: el.value, start: el.selectionStart, end: el.selectionEnd };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const el = document.getElementById(snapshot.id);
  if (!el) return;

  el.value = snapshot.value;
  el.focus();
  try {
    el.setSelectionRange(snapshot.start, snapshot.end);
  } catch {
    // Number inputs don't expose a selection range; focus alone is enough.
  }
}

/** Computes shared derived values and drops ui references to things that no
 *  longer exist (deleted invoices, billed/deleted tasks, deleted sessions). */
function derive(data, ui) {
  const { tasks, sessions, invoices, settings } = data;

  const unbilled = tasks
    .filter((t) => !t.invoiceId)
    .map((t) => ({ ...t, status: normalizeStatus(t) }))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  if (ui.bucket !== 'unbilled' && !invoices.some((i) => i.id === ui.bucket)) {
    ui.bucket = 'unbilled';
    // The document belongs to an invoice; with none selected there is nothing
    // for it to show, so it closes rather than going blank.
    if (ui.screen === 'doc') ui.screen = 'app';
  }
  ui.selected = ui.selected.filter((id) => unbilled.some((t) => t.id === id));
  if (!unbilled.some((t) => t.id === ui.trackTaskId)) {
    ui.trackTaskId = unbilled.length ? unbilled[0].id : '';
  }
  if (ui.editSession && !sessions.some((s) => s.id === ui.editSession)) {
    ui.editSession = null;
    ui.editTaskMenu = false;
  }
  if (ui.editTask && !unbilled.some((t) => t.id === ui.editTask)) {
    ui.editTask = null;
  }
  if (ui.confirmDeleteTask !== ui.editTask) {
    ui.confirmDeleteTask = null;
  }

  const raw = (task) => minutesFor(sessions, task.id);
  const billed = (task) => billedMinutesFor(task, raw(task), settings, ui.showBillable);
  const amount = (task) => amountFor(task, raw(task), settings, ui.showBillable);

  const inv = ui.bucket === 'unbilled' ? null : invoices.find((i) => i.id === ui.bucket);
  const invTasks = inv ? tasks.filter((t) => t.invoiceId === inv.id) : [];

  return { tasks, sessions, invoices, settings, unbilled, raw, billed, amount, inv, invTasks };
}

function taskNameOf(d, session) {
  const task = d.tasks.find((t) => t.id === session.taskId);
  return task ? task.name : session.taskName || 'Unknown task';
}

// ---------- Chip rail ----------

function chipsHtml(d, ui) {
  const chips = [
    { id: 'unbilled', label: `Unbilled · ${d.unbilled.length}` },
    ...d.invoices.map((i) => ({ id: i.id, label: i.number + (i.paid ? ' ✓' : '') }))
  ].map(
    (c) =>
      `<button class="chip${ui.bucket === c.id ? ' active' : ''}" data-action="bucket" data-id="${c.id}">${esc(c.label)}</button>`
  );
  chips.push('<button class="chip chip-new" data-action="new-invoice">+ New</button>');
  return chips.join('');
}

// ---------- View A — Unbilled ----------

function unbilledView(d, ui, timer) {
  return (
    timerCard(d, ui, timer) +
    manualRow() +
    summaryCard(d, ui) +
    tasksSection(d, ui) +
    sessionLog(d, ui)
  );
}

function timerCard(d, ui, timer) {
  const paused = Boolean(timer && timer.pausedAt);
  const running = Boolean(timer && !paused);
  const elapsed = timer ? timerElapsedMs(timer, Date.now()) : 0;
  const caption = timer ? (paused ? 'PAUSED' : 'TRACKING') : 'TIMER';
  const activeTaskId = timer ? timer.taskId : ui.trackTaskId;
  const activeTask = d.tasks.find((t) => t.id === activeTaskId);
  const menuOpen = ui.trackMenuOpen && !timer;

  const choices =
    d.unbilled
      .map(
        (t) => `
        <button class="menu-row" data-action="pick-track" data-id="${t.id}">
          <span class="dot dot-${STATUS_CLASS[t.status]}"></span>
          <span class="menu-label ellip${t.id === activeTaskId ? ' current' : ''}">${esc(t.name)}</span>
          <span class="menu-check">${t.id === activeTaskId ? '✓' : ''}</span>
        </button>`
      )
      .join('') || '<div class="menu-empty">No unbilled tasks — add one below.</div>';

  return `
  <div class="card timer-card">
    <div class="timer-caption${running ? ' live' : ''}">${caption}</div>
    <div class="clock${running ? ' live' : ''}" data-clock>${formatClock(Math.round(elapsed / 1000))}</div>
    <span class="pop block-pop" data-popup>
      <button class="task-select${timer ? ' locked' : ''}" data-action="toggle-track-menu">${esc(activeTask ? activeTask.name : 'Pick a task')}<span class="select-caret">▾</span></button>
      <div class="menu full-menu"${menuOpen ? '' : ' hidden'}>${choices}</div>
    </span>
    ${ui.toast ? `<div class="toast">${esc(ui.toast)}</div>` : ''}
    <div class="timer-actions">
      ${timer ? `<button class="btn-pause" data-action="pause-btn">${paused ? 'Resume' : 'Pause'}</button>` : ''}
      <button class="btn-timer${running ? ' running' : ''}" data-action="timer-btn">${timer ? 'Stop & log' : 'Start'}</button>
    </div>
  </div>`;
}

function manualRow() {
  return `
  <div class="manual-row">
    <span class="manual-label">Log manually</span>
    <input type="number" min="1" placeholder="min" id="manual-minutes" class="input grow" inputmode="numeric">
    <button class="btn-log" data-action="log-manual">Log</button>
  </div>`;
}

function summaryCard(d, ui) {
  const { settings, unbilled } = d;
  const totalRaw = unbilled.reduce((sum, t) => sum + d.raw(t), 0);
  const totalBilled = unbilled.reduce((sum, t) => sum + d.billed(t), 0);
  const totalAmount = unbilled.reduce((sum, t) => sum + d.amount(t), 0);

  const minsBy = (status) =>
    unbilled.filter((t) => t.status === status).reduce((sum, t) => sum + d.raw(t), 0);
  const pct = (m) => (totalRaw ? (m / totalRaw) * 100 : 0).toFixed(1) + '%';
  const activeMins = minsBy('In Progress') + minsBy('Complete');
  const pausedMins = minsBy('Paused');

  const meta =
    `${taskCount(unbilled.length)} · ${formatMinutes(totalRaw)} logged` +
    (ui.showBillable && totalBilled !== totalRaw ? ` → ${formatMinutes(totalBilled)} billable` : '') +
    ` @ ${money(Number(settings.rate) || 0)}/hr`;

  return `
  <div class="card summary-card">
    <div class="row-between">
      <span class="caption">UNBILLED</span>
      <span class="rate-field">$<input type="number" min="0" value="${esc(String(settings.rate))}" data-setting="rate" class="mini-input rate-input" inputmode="decimal">/hr</span>
    </div>
    <div class="big-money">${money(totalAmount)}</div>
    <div class="meta">${esc(meta)}</div>
    <div class="rules-block">
      <div class="row-between">
        <span class="micro-caption">BILLING RULES</span>
        <button class="billable-toggle${ui.showBillable ? ' on' : ''}" data-action="toggle-billable">${ui.showBillable ? 'AS BILLED' : 'AS LOGGED'}</button>
      </div>
      <div class="rules-inputs">
        <span class="rule-field">min <input type="number" min="0" step="0.5" value="${esc(String(settings.minHours))}" data-setting="minHours" class="mini-input" inputmode="decimal">h</span>
        <span class="rule-field">max <input type="number" min="0" step="0.5" value="${esc(String(settings.maxHours))}" data-setting="maxHours" class="mini-input" inputmode="decimal">h</span>
      </div>
    </div>
    <div class="status-bar">
      <span class="seg seg-active" style="width:${pct(activeMins)}"></span>
      <span class="seg seg-paused" style="width:${pct(pausedMins)}"></span>
      <span class="seg seg-idle" style="width:${pct(Math.max(0, totalRaw - activeMins - pausedMins))}"></span>
    </div>
  </div>`;
}

function tasksSection(d, ui) {
  const shown = d.unbilled.filter((t) => ui.statusFilter.includes(t.status));
  const filtered = ui.statusFilter.length !== STATUS_ORDER.length;

  const filterRows = STATUS_ORDER.map((status) => {
    const on = ui.statusFilter.includes(status);
    const count = d.unbilled.filter((t) => t.status === status).length;
    return `
      <button class="menu-row check-row" data-action="toggle-status-filter" data-status="${status}">
        <span class="checkbox${on ? ' on' : ''}">${on ? '✓' : ''}</span>
        <span class="check-label">${status}</span>
        <span class="check-count">${count}</span>
      </button>`;
  }).join('');

  const header = `
  <div class="tasks-header">
    <span class="caption">TASKS</span>
    <span class="tasks-tools">
      <span class="selected-label${ui.selected.length ? ' on' : ''}">${ui.selected.length ? ui.selected.length + ' selected' : 'tap to select'}</span>
      <span class="pop" data-popup>
        <button class="filter-btn${filtered ? ' on' : ''}" data-action="toggle-filter">${filtered ? 'Filter · ' + ui.statusFilter.length : 'Filter'}</button>
        <div class="menu filter-menu"${ui.filterOpen ? '' : ' hidden'}>
          ${filterRows}
          <button class="show-all" data-action="all-statuses">Show all</button>
        </div>
      </span>
    </span>
  </div>`;

  return (
    header +
    `<ul class="task-list">${shown.map((t) => taskCard(t, d, ui)).join('')}</ul>` +
    (shown.length ? '' : '<div class="empty-note">No tasks match this filter.</div>') +
    newTaskBlock(ui)
  );
}

function taskCard(t, d, ui) {
  const selected = ui.selected.includes(t.id);
  const editing = ui.editTask === t.id;
  const rawMinutes = d.raw(t);
  const billedMinutes = d.billed(t);
  const adjusted = billedMinutes !== rawMinutes;

  const statusRows = STATUS_ORDER.map(
    (status) => `
    <button class="menu-row" data-action="set-status" data-id="${t.id}" data-status="${status}">
      <span class="dot dot-${STATUS_CLASS[status]}"></span>
      <span class="menu-label${t.status === status ? ' current' : ''}">${status}</span>
      <span class="menu-check">${t.status === status ? '✓' : ''}</span>
    </button>`
  ).join('');

  // The card itself opens the editor (closest('[data-action]') still resolves
  // the checkbox, status pill, Delete and Save first), so the name is inert.
  const nameBlock = editing
    ? `<input id="edit-task-name" class="input grow small task-name-input" value="${esc(t.name)}" maxlength="120">`
    : `<div class="task-name">${esc(t.name)}</div>`;

  const sessionCount = d.sessions.filter((s) => s.taskId === t.id).length;
  const confirming = ui.confirmDeleteTask === t.id;
  // Shown only once Delete is armed, so nothing sits between the status row
  // and the buttons until the warning is actually relevant.
  const deleteHint = confirming
    ? `<div class="delete-hint">${
        sessionCount
          ? `Also deletes ${sessionCount} logged session${sessionCount === 1 ? '' : 's'}.`
          : 'No logged sessions to lose.'
      }</div>`
    : '';

  const editor = editing
    ? `
    <div class="task-editor">
      ${deleteHint}
      <div class="task-edit-row">
        <button class="btn-danger-sm${confirming ? ' armed' : ''}" data-action="delete-task" data-id="${t.id}">${confirming ? 'Confirm delete' : 'Delete'}</button>
        <button class="btn-primary-sm" data-action="save-task" data-id="${t.id}">Save</button>
      </div>
    </div>`
    : '';

  return `
  <li class="task-card${selected ? ' selected' : ''}${editing ? ' editing' : ''}" data-action="open-task-editor" data-id="${t.id}">
    <div class="task-row">
      <button class="checkbox task-check${selected ? ' on' : ''}" data-action="select-task" data-id="${t.id}">${selected ? '✓' : ''}</button>
      <div class="task-main">
        ${nameBlock}
        <div class="task-bottom">
          <span class="pop" data-popup>
            <button class="pill pill-btn st-${STATUS_CLASS[t.status]}" data-action="open-status-menu" data-id="${t.id}">${t.status}<span class="pill-caret">▾</span></button>
            <div class="menu status-menu"${ui.statusMenuFor === t.id ? '' : ' hidden'}>${statusRows}</div>
          </span>
          <span class="task-figures">
            <span class="${adjusted ? 'struck' : ''}">${formatMinutes(rawMinutes)}</span>
            ${adjusted ? `<span class="adj">→ ${formatMinutes(billedMinutes)}</span>` : ''}
            <strong class="amount">${money(d.amount(t))}</strong>
          </span>
        </div>
        ${editor}
      </div>
    </div>
  </li>`;
}

/** Not in the design prototype (its data was seeded): a minimal task creator
 *  styled after the invoice view's dashed add button. */
function newTaskBlock(ui) {
  if (!ui.newTaskOpen) {
    return '<button class="dashed-btn new-task-btn" data-action="toggle-new-task">+ New task</button>';
  }
  return `
  <div class="new-task-row">
    <input id="new-task-name" class="input grow" placeholder="Task name" maxlength="120">
    <button class="btn-primary-sm" data-action="create-task">Add</button>
    <button class="btn-muted-sm" data-action="toggle-new-task">Cancel</button>
  </div>`;
}

function sessionLog(d, ui) {
  const unbilledIds = new Set(d.unbilled.map((t) => t.id));
  const rows = d.sessions.filter((s) => unbilledIds.has(s.taskId));

  let body;
  if (!rows.length) {
    body = '<div class="empty-note slim">No unbilled sessions.</div>';
  } else {
    const byDate = new Map();
    for (const session of rows) {
      // Sessions arrive sorted newest-date first, newest-created first.
      if (!byDate.has(session.date)) byDate.set(session.date, []);
      byDate.get(session.date).push(session);
    }
    body = [...byDate.entries()]
      .map(
        ([date, list]) => `
      <div class="day-block">
        <div class="day-head">
          <span>${longDate(date)}</span>
          <span class="day-total">${formatMinutes(list.reduce((sum, s) => sum + s.minutes, 0))}</span>
        </div>
        <div class="day-rows">${list.map((s) => sessionRow(s, d, ui)).join('')}</div>
      </div>`
      )
      .join('');
  }

  return `<div class="log-section">
    <div class="row-between log-head">
      <span class="caption">SESSION LOG</span>
      <span class="today">${esc(longDate(todayIso()))}</span>
    </div>
    ${body}
  </div>`;
}

function sessionRow(session, d, ui) {
  const editing = ui.editSession === session.id;

  let editor = '';
  if (editing) {
    const choices = d.unbilled
      .map(
        (t) => `
        <button class="menu-row" data-action="move-session" data-id="${session.id}" data-task="${t.id}">
          <span class="menu-label ellip${t.id === session.taskId ? ' current' : ''}">${esc(t.name)}</span>
          <span class="menu-check">${t.id === session.taskId ? '✓' : ''}</span>
        </button>`
      )
      .join('');
    editor = `
    <div class="session-editor">
      <span class="pop block-pop" data-popup>
        <button class="move-btn" data-action="toggle-session-task-menu">Move to task<span class="move-caret">▾</span></button>
        <div class="menu full-menu near"${ui.editTaskMenu ? '' : ' hidden'}>${choices}</div>
      </span>
      <div class="session-edit-row">
        <input type="number" min="1" id="edit-minutes" class="input grow small" value="${session.minutes}" inputmode="numeric">
        <span class="unit">min</span>
        <button class="btn-danger-sm" data-action="delete-session" data-id="${session.id}">Delete</button>
        <button class="btn-primary-sm" data-action="save-session" data-id="${session.id}">Save</button>
      </div>
    </div>`;
  }

  return `
  <div class="session-row${editing ? ' editing' : ''}">
    <button class="session-head" data-action="open-session" data-id="${session.id}">
      <span class="session-name ellip">${esc(taskNameOf(d, session))}</span>
      <span class="session-dur">${formatMinutes(session.minutes)}</span>
    </button>
    ${editor}
  </div>`;
}

// ---------- View B — Invoice ----------

function invoiceView(d, ui) {
  const inv = d.inv;
  const { settings } = d;
  const invMinutes = d.invTasks.reduce((sum, t) => sum + d.raw(t), 0);
  const invBilled = d.invTasks.reduce((sum, t) => sum + d.billed(t), 0);
  const invAmount = d.invTasks.reduce((sum, t) => sum + d.amount(t), 0);
  const state = inv.paid ? 'PAID' : inv.issued ? 'SENT' : 'DRAFT';

  const meta =
    `${taskCount(d.invTasks.length)} · ${formatMinutes(invMinutes)} logged` +
    (invBilled !== invMinutes ? ` → ${formatMinutes(invBilled)} billable` : '') +
    (inv.issued ? ` · issued ${shortDate(inv.issued)}` : '');

  const stateRows = ['DRAFT', 'SENT', 'PAID']
    .map(
      (value) => `
      <button class="menu-row" data-action="set-inv-state" data-state="${value}">
        <span class="menu-label state-label${value === state ? ' current' : ''}">${value}</span>
        <span class="menu-check">${value === state ? '✓' : ''}</span>
      </button>`
    )
    .join('');

  const effRate = invMinutes > 0 ? invAmount / (invMinutes / 60) : 0;
  // Not ready still means clickable — the tap is how the button explains
  // which of the two prerequisites is missing.
  const docReady = Boolean((settings.clientName || '').trim() && d.invTasks.length);

  const summary = `
  <div class="card inv-card">
    <div class="row-between">
      <span class="inv-title-wrap">
        <span class="inv-number">${esc(inv.number)}</span>
        <button class="edit-chip" data-action="toggle-inv-edit">Edit</button>
      </span>
      <span class="pop" data-popup>
        <button class="state-pill state-${state.toLowerCase()}" data-action="open-state-menu">${state}<span class="pill-caret">▾</span></button>
        <div class="menu state-menu"${ui.stateMenuOpen ? '' : ' hidden'}>${stateRows}</div>
      </span>
    </div>
    ${
      ui.invEditOpen
        ? `
    <div class="inv-edit">
      <div class="inv-edit-row">
        <input id="inv-number-input" class="input grow small" value="${esc(inv.number)}" maxlength="60">
        <button class="btn-danger-sm" data-action="delete-invoice">Delete</button>
        <button class="btn-primary-sm" data-action="save-invoice">Save</button>
      </div>
      <div class="hint">Deleting returns its tasks to unbilled.</div>
    </div>`
        : ''
    }
    <div class="big-money">${money(invAmount)}</div>
    <div class="meta">${esc(meta)}</div>
    ${
      invMinutes > 0
        ? `
    <div class="eff-rate row-between">
      <span class="micro-caption">EFFECTIVE RATE</span>
      <span class="eff-value ${effRate >= (Number(settings.rate) || 0) ? 'good' : 'bad'}">${money(effRate)}/hr</span>
    </div>`
        : ''
    }
    <div class="generate-block">
      <button class="btn-generate${docReady ? ' ready' : ''}" data-action="open-doc">View invoice</button>
    </div>
  </div>`;

  const cards = d.invTasks
    .map((t) => {
      const rawMinutes = d.raw(t);
      const billedMinutes = d.billed(t);
      const adjusted = billedMinutes !== rawMinutes;
      return `
    <li class="task-card">
      <div class="task-name">${esc(t.name)}</div>
      <div class="task-bottom">
        <span class="pill st-billed">Billed</span>
        <span class="task-figures">
          <span class="${adjusted ? 'struck' : ''}">${formatMinutes(rawMinutes)}</span>
          ${adjusted ? `<span class="adj">→ ${formatMinutes(billedMinutes)}</span>` : ''}
          <strong class="amount">${money(d.amount(t))}</strong>
          <button class="remove-btn" data-action="remove-inv-task" data-id="${t.id}" aria-label="Remove from invoice">×</button>
        </span>
      </div>
    </li>`;
    })
    .join('');

  const addChoices =
    d.unbilled
      .map(
        (t) => `
        <button class="menu-row" data-action="add-task-to-invoice" data-id="${t.id}">
          <span class="dot dot-${STATUS_CLASS[t.status]}"></span>
          <span class="menu-label ellip">${esc(t.name)}</span>
          <span class="menu-hours">${formatMinutes(d.raw(t))}</span>
        </button>`
      )
      .join('') || '<div class="menu-empty">Nothing unbilled left.</div>';

  const invSessions = d.sessions.filter((s) => d.invTasks.some((t) => t.id === s.taskId));
  const sessionRows = invSessions
    .map(
      (s) => `
      <div class="inv-session-row">
        <span class="inv-session-left">
          <span class="inv-session-date">${shortDate(s.date)}</span>
          <span class="inv-session-name ellip">${esc(taskNameOf(d, s))}</span>
        </span>
        <span class="inv-session-dur">${formatMinutes(s.minutes)}</span>
      </div>`
    )
    .join('');

  return (
    summary +
    '<div class="caption block-caption">TASKS ON THIS INVOICE</div>' +
    `<ul class="task-list">${cards}</ul>` +
    (d.invTasks.length ? '' : '<div class="empty-note">No tasks yet — add one below.</div>') +
    `<span class="pop block-pop add-pop" data-popup>
      <button class="dashed-btn" data-action="toggle-add-menu">+ Add unbilled task</button>
      <div class="menu full-menu"${ui.addMenuOpen ? '' : ' hidden'}>${addChoices}</div>
    </span>` +
    `<div class="inv-sessions">
      <div class="row-between inv-sessions-head">
        <span class="caption">SESSIONS ON THIS INVOICE</span>
        <button class="toggle-chip" data-action="toggle-sessions">${ui.sessionsOpen ? 'Hide' : 'Show'}</button>
      </div>
      ${ui.sessionsOpen ? sessionRows || '<div class="empty-note slim">Nothing billed yet.</div>' : ''}
    </div>`
  );
}

// ---------- Bottom slot ----------

function bottomSlot(d, ui, timer) {
  const onUnbilled = ui.bucket === 'unbilled';
  let out = '';

  // The design renders toasts inside the timer card, which only exists on the
  // Unbilled view — on invoices they float here instead.
  if (!onUnbilled && ui.toast) {
    out += `<div class="toast floating">${esc(ui.toast)}</div>`;
  }

  if (onUnbilled && ui.selected.length) {
    const total = ui.selected.reduce(
      (sum, id) => sum + ruleAmount(minutesFor(d.sessions, id), d.settings),
      0
    );
    out += `<button class="bill-bar" data-action="bill-selected">Bill ${taskCount(ui.selected.length)} · ${money(total)}</button>`;
  } else if (!onUnbilled && timer) {
    const paused = Boolean(timer.pausedAt);
    const task = d.tasks.find((t) => t.id === timer.taskId);
    const elapsed = timerElapsedMs(timer, Date.now());
    out += `
    <div class="timer-bar">
      <div class="timer-bar-left">
        <div class="timer-caption bar${paused ? '' : ' live'}">${paused ? 'PAUSED' : 'TRACKING'}</div>
        <div class="timer-bar-name ellip">${esc(task ? task.name : 'Unknown task')}</div>
      </div>
      <div class="timer-bar-right">
        <span class="timer-bar-clock${paused ? '' : ' live'}" data-clock>${formatClock(Math.round(elapsed / 1000))}</span>
        <button class="round-btn" data-action="timer-btn" aria-label="Stop and log">■</button>
      </div>
    </div>`;
  }

  return out;
}
