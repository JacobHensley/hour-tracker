import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  writeBatch,
  getDocs,
  query,
  where
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ============================================================
// PASTE YOUR FIREBASE CONFIG HERE (Project settings → General →
// Your apps → SDK setup and configuration → Config).
// This config is safe to commit publicly — access control is
// enforced by Firestore security rules, not by hiding this.
// ============================================================
const firebaseConfig = {
  apiKey: 'AIzaSyDs-H4grv6Ti6UKTL0JHG_8FvP08vV-9bg',
  authDomain: 'hour-tracker-ce485.firebaseapp.com',
  projectId: 'hour-tracker-ce485',
  storageBucket: 'hour-tracker-ce485.firebasestorage.app',
  messagingSenderId: '388018522367',
  appId: '1:388018522367:web:2766da98af7809d3f6e4ca',
  measurementId: 'G-V5REBHBGPY'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Offline persistence: app keeps working with no connection; Firestore
// queues writes and syncs when back online.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() })
});

// ---------- Constants ----------

/** The running timer stays device-local on purpose: it's transient state,
 *  and syncing a live clock across devices adds complexity without value. */
const TIMER_STORAGE_KEY = 'hour-tracker-active-timer';

/** Where the task filter selection is remembered between visits. */
const FILTER_STORAGE_KEY = 'hour-tracker-status-filter';

/** Days before today that the session log covers by default (a two-week window). */
const DEFAULT_RANGE_DAYS = 13;

/** Timer sessions shorter than this round down to 0 minutes and are discarded. */
const MIN_LOGGABLE_MINUTES = 1;

const CLOCK_TICK_MS = 1000;

/** Task workflow states, in the order they appear in the dropdown. */
const TASK_STATUSES = ['Not started', 'In Progress', 'Paused', 'Complete', 'Billed'];

/** Applied to new tasks, and to tasks created before statuses existed. */
const DEFAULT_TASK_STATUS = TASK_STATUSES[0];


// ---------- DOM helpers ----------

/** Shorthand for document.getElementById. */
const $ = (id) => document.getElementById(id);

/** Escapes text for safe interpolation into an innerHTML template. */
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

/** Shows an error banner above the app, or clears it when given no message. */
function showError(message) {
  $('error-box').innerHTML = message ? `<div class="error">${escapeHtml(message)}</div>` : '';
}

/** Hides the error banner. */
function clearError() {
  showError('');
}

// ---------- Formatting helpers ----------

/** Generates a unique id for a new Firestore document. */
function createId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Formats a Date as `YYYY-MM-DD` in local time (not UTC, unlike toISOString). */
function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Returns today's date as `YYYY-MM-DD`. */
function todayIso() {
  return toIsoDate(new Date());
}

/** Returns the date `days` before today as `YYYY-MM-DD`. */
function daysAgoIso(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toIsoDate(date);
}

/** `2026-08-10` → `Mon, Aug 10` */
function formatDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
}

/** `95` → `1h 35m` */
function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** `3661` → `01:01:01` */
function formatClock(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

// ---------- State ----------

let userId = null;
let tasks = []; // { id, name, createdAt }
let sessions = []; // { id, taskId, taskName, date, minutes, createdAt }
let selectedTaskId = '';
let editingTaskId = null;
let taskStatusFilter = loadStatusFilter(); // statuses currently ticked in the filter
let fromDate = daysAgoIso(DEFAULT_RANGE_DAYS);
let tickHandle = null;

/**
 * The stored timer is `{ taskId, accumulatedMs, startedAt }`. `accumulatedMs` is
 * time banked by earlier run segments; `startedAt` is when the current segment
 * began, or null while paused. Elapsed time is the sum of the two.
 */

/** Reads the active timer from localStorage, or null if there isn't one. */
function getActiveTimer() {
  try {
    return JSON.parse(localStorage.getItem(TIMER_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Saves the running timer to localStorage, or clears it when passed null. */
function setActiveTimer(timer) {
  if (timer) {
    localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(timer));
  } else {
    localStorage.removeItem(TIMER_STORAGE_KEY);
  }
}

/** Total elapsed milliseconds for a timer, including time banked before any pauses. */
function elapsedMs(timer) {
  // Timers saved before pause existed have no accumulatedMs; they read as 0.
  const banked = timer.accumulatedMs || 0;
  return timer.startedAt ? banked + (Date.now() - timer.startedAt) : banked;
}

/** True when a timer exists but its clock is currently frozen. */
function isTimerPaused(timer) {
  return Boolean(timer) && !timer.startedAt;
}

/** Reads the saved filter selection, defaulting to showing every status. */
function loadStatusFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY));
    if (!Array.isArray(saved)) return new Set(TASK_STATUSES);

    // Ignore anything that is no longer a real status.
    return new Set(saved.filter((status) => TASK_STATUSES.includes(status)));
  } catch {
    return new Set(TASK_STATUSES);
  }
}

/** Remembers the filter selection so it survives a reload. */
function saveStatusFilter() {
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify([...taskStatusFilter]));
}

// ---------- Firestore references ----------

/** References the signed-in user's tasks collection. */
const tasksCol = () => collection(db, 'users', userId, 'tasks');
/** References the signed-in user's sessions collection. */
const sessionsCol = () => collection(db, 'users', userId, 'sessions');

// ---------- Tasks ----------

/** Adds the task named in the input, rejecting duplicate names. */
async function addTask() {
  const input = $('new-task-input');
  const name = input.value.trim();
  if (!name) return;

  if (tasks.some((task) => task.name.toLowerCase() === name.toLowerCase())) {
    showError(`Task "${name}" already exists.`);
    return;
  }
  clearError();

  const id = createId();
  input.value = '';
  if (!selectedTaskId) selectedTaskId = id;

  try {
    await setDoc(doc(tasksCol(), id), { name, status: DEFAULT_TASK_STATUS, createdAt: Date.now() });
  } catch (error) {
    showError('Could not add task: ' + error.message);
  }
}

/** A task's status, treating tasks saved before the field existed as the default. */
function taskStatus(task) {
  return task.status || DEFAULT_TASK_STATUS;
}

/** True when a task's status is ticked in the filter. */
function matchesStatusFilter(task) {
  return taskStatusFilter.has(taskStatus(task));
}

/** Changes a task's workflow status. */
async function setTaskStatus(id, status) {
  if (!TASK_STATUSES.includes(status)) return;

  try {
    await updateDoc(doc(tasksCol(), id), { status });
  } catch (error) {
    showError('Could not update status: ' + error.message);
  }
}

/** Renames a task and rewrites the taskName snapshot on all of its sessions. */
async function saveTaskEdit(id) {
  const input = $('edit-input-' + id);
  const name = input.value.trim();
  if (!name) return;

  editingTaskId = null;

  try {
    await updateDoc(doc(tasksCol(), id), { name });

    // Keep session snapshots in sync with the rename.
    const snapshot = await getDocs(query(sessionsCol(), where('taskId', '==', id)));
    if (!snapshot.empty) {
      const batch = writeBatch(db);
      snapshot.forEach((session) => batch.update(session.ref, { taskName: name }));
      await batch.commit();
    }
  } catch (error) {
    showError('Could not rename task: ' + error.message);
  }
}

/** Deletes a task, unless its timer is currently running. */
async function deleteTask(id) {
  const activeTimer = getActiveTimer();
  if (activeTimer && activeTimer.taskId === id) {
    showError('Stop the timer before deleting its task.');
    return;
  }
  clearError();

  if (selectedTaskId === id) selectedTaskId = '';

  try {
    // Sessions keep their taskName snapshot so history stays intact.
    await deleteDoc(doc(tasksCol(), id));
  } catch (error) {
    showError('Could not delete task: ' + error.message);
  }
}

/** Looks up a task's current name by id, or null if it no longer exists. */
function findTaskName(id) {
  const task = tasks.find((candidate) => candidate.id === id);
  return task ? task.name : null;
}

// ---------- Sessions ----------

/** Writes one session, snapshotting the task's name at the time. */
async function logSession(taskId, date, minutes) {
  const id = createId();
  try {
    await setDoc(doc(sessionsCol(), id), {
      taskId,
      taskName: findTaskName(taskId) || 'Unknown task',
      date,
      minutes,
      createdAt: Date.now()
    });
  } catch (error) {
    showError('Could not log session: ' + error.message);
  }
}

/** Logs a session from the manual minutes and date inputs. */
async function addManualSession() {
  selectedTaskId = $('task-select').value;
  if (!selectedTaskId) {
    showError('Pick a task first.');
    return;
  }

  const minutes = Math.round(parseFloat($('manual-minutes').value));
  if (!minutes || minutes <= 0) {
    showError('Enter minutes greater than 0.');
    return;
  }
  clearError();

  await logSession(selectedTaskId, $('manual-date').value || todayIso(), minutes);
  $('manual-minutes').value = '';
}

/** Deletes one logged session. */
async function deleteSession(id) {
  try {
    await deleteDoc(doc(sessionsCol(), id));
  } catch (error) {
    showError('Could not delete session: ' + error.message);
  }
}

// ---------- Timer ----------

/** Starts the timer for the selected task. */
function startTimer() {
  selectedTaskId = $('task-select').value;
  if (!selectedTaskId) {
    showError('Pick a task first.');
    return;
  }
  clearError();

  setActiveTimer({ taskId: selectedTaskId, accumulatedMs: 0, startedAt: Date.now() });
  render();
}

/** Freezes the clock, banking the time run so far. */
function pauseTimer() {
  const activeTimer = getActiveTimer();
  if (!activeTimer || isTimerPaused(activeTimer)) return;

  setActiveTimer({ ...activeTimer, accumulatedMs: elapsedMs(activeTimer), startedAt: null });
  render();
}

/** Restarts the clock from the banked time. */
function resumeTimer() {
  const activeTimer = getActiveTimer();
  if (!activeTimer || !isTimerPaused(activeTimer)) return;

  setActiveTimer({ ...activeTimer, startedAt: Date.now() });
  render();
}

/** Stops the timer and logs the elapsed time, discarding sub-minute sessions. */
async function stopTimer() {
  const activeTimer = getActiveTimer();
  if (!activeTimer) return;

  const minutes = Math.round(elapsedMs(activeTimer) / 60000); // nearest minute
  setActiveTimer(null);

  if (minutes < MIN_LOGGABLE_MINUTES) {
    showError('Session under 30 seconds — not logged.');
    render();
    return;
  }
  clearError();

  await logSession(activeTimer.taskId, todayIso(), minutes);
  render();
}

/** Repaints the clock from the running timer's start time. */
function tick() {
  const activeTimer = getActiveTimer();
  if (!activeTimer) return;

  const clock = $('clock');
  if (clock) {
    clock.textContent = formatClock(Math.floor(elapsedMs(activeTimer) / 1000));
  }
}

/** Runs the clock only while a timer is active and unpaused. */
function ensureTicking() {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }

  const activeTimer = getActiveTimer();
  if (activeTimer && !isTimerPaused(activeTimer)) {
    tickHandle = setInterval(tick, CLOCK_TICK_MS);
  }
}

// ---------- Rendering ----------

/** Redraws the whole UI from the current state. */
function render() {
  const activeTimer = getActiveTimer();

  $('today-label').textContent = formatDate(todayIso());
  renderStatusFilter();
  renderTaskList();
  renderTaskSelect(activeTimer);
  renderTimerControls(activeTimer);
  renderDateInputs();
  renderSessionLog();
}

/** Draws the task list, or an empty-state message when there are none. */
function renderTaskList() {
  const taskList = $('task-list');

  if (tasks.length === 0) {
    taskList.innerHTML = '<div class="empty">No tasks yet — add one above to start logging time against it.</div>';
    return;
  }

  const visible = tasks.filter(matchesStatusFilter);

  if (visible.length === 0) {
    taskList.innerHTML = '<div class="empty">No tasks match the current filter.</div>';
    return;
  }

  taskList.innerHTML = visible
    .map((task) => (task.id === editingTaskId ? taskEditRowHtml(task) : taskRowHtml(task)))
    .join('');

  focusTaskEditInput();
}

/** Builds the markup for one task row. */
function taskRowHtml(task) {
  return `
    <li class="task-item">
      <span class="task-name">${escapeHtml(task.name)}</span>
      <span class="task-right">
        ${taskStatusSelectHtml(task)}
        <button class="btn-ghost" data-action="edit" data-id="${task.id}" aria-label="Rename">✎</button>
        <button class="btn-ghost danger" data-action="delete" data-id="${task.id}" aria-label="Delete">🗑</button>
      </span>
    </li>`;
}

/** Builds the status dropdown for one task row. */
function taskStatusSelectHtml(task) {
  const current = taskStatus(task);
  const options = TASK_STATUSES.map(
    (status) => `<option value="${status}"${status === current ? ' selected' : ''}>${status}</option>`
  ).join('');

  return `<select class="task-status" data-status-for="${task.id}" aria-label="Status">${options}</select>`;
}

/** Builds the markup for a task row in rename mode. */
function taskEditRowHtml(task) {
  return `
    <li class="task-item edit-row">
      <input id="edit-input-${task.id}" value="${escapeHtml(task.name)}" />
      <span class="task-right">
        <button class="btn-ghost" data-action="save" data-id="${task.id}" aria-label="Save">✓</button>
        <button class="btn-ghost" data-action="cancel" aria-label="Cancel">✕</button>
      </span>
    </li>`;
}

/** Focuses the rename input that was just rendered, and lets Enter submit it. */
function focusTaskEditInput() {
  if (!editingTaskId) return;

  const input = $('edit-input-' + editingTaskId);
  if (!input) return;

  input.focus();
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveTaskEdit(editingTaskId);
  });
}

/** Fills the task dropdown, locking it while a timer runs. */
/** Summarizes the ticked statuses for the filter button's label. */
function statusFilterLabel() {
  if (taskStatusFilter.size === TASK_STATUSES.length) return 'All';
  if (taskStatusFilter.size === 0) return 'None';
  if (taskStatusFilter.size === 1) return [...taskStatusFilter][0];
  return `${taskStatusFilter.size} selected`;
}

/** Builds the checkbox list inside the filter popup. */
function statusFilterPanelHtml() {
  const allTicked = taskStatusFilter.size === TASK_STATUSES.length;

  const options = TASK_STATUSES.map(
    (status) => `
      <label class="filter-option">
        <input type="checkbox" data-status="${status}"${taskStatusFilter.has(status) ? ' checked' : ''} />
        ${status}
      </label>`
  ).join('');

  return `
    <label class="filter-option">
      <input type="checkbox" data-select-all${allTicked ? ' checked' : ''} />
      All
    </label>
    <div class="filter-divider"></div>
    ${options}`;
}

/** Repaints the filter button label and the popup's checkboxes. */
function renderStatusFilter() {
  $('status-filter-btn').textContent = statusFilterLabel();
  $('status-filter-panel').innerHTML = statusFilterPanelHtml();
}

/** Opens or closes the filter popup; with no argument, flips it. */
function toggleStatusFilter(open) {
  const panel = $('status-filter-panel');
  const shouldOpen = open ?? panel.hidden;

  panel.hidden = !shouldOpen;
  $('status-filter-btn').setAttribute('aria-expanded', String(shouldOpen));
}

function renderTaskSelect(activeTimer) {
  const select = $('task-select');
  const activeTaskId = activeTimer ? activeTimer.taskId : selectedTaskId;

  // The filter applies here too, but a running timer's task always stays
  // listed so the dropdown never contradicts what's actually being timed.
  const selectable = tasks.filter(
    (task) => matchesStatusFilter(task) || (activeTimer && task.id === activeTimer.taskId)
  );

  select.innerHTML =
    '<option value="">Select task…</option>' +
    selectable
      .map(
        (task) =>
          `<option value="${task.id}"${task.id === activeTaskId ? ' selected' : ''}>${escapeHtml(task.name)}</option>`
      )
      .join('');

  // Don't let the task change mid-session.
  select.disabled = Boolean(activeTimer);
}

/** Switches the button and clock between their start and stop states. */
function renderTimerControls(activeTimer) {
  const timerBtn = $('timer-btn');
  const pauseBtn = $('pause-btn');
  const clock = $('clock');

  if (activeTimer) {
    const paused = isTimerPaused(activeTimer);

    timerBtn.textContent = 'Stop';
    timerBtn.className = 'btn-warn';
    timerBtn.onclick = stopTimer;

    pauseBtn.hidden = false;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.className = paused ? 'btn-accent' : 'btn-muted';
    pauseBtn.onclick = paused ? resumeTimer : pauseTimer;

    // The clock only reads as "live" while it's actually counting.
    clock.classList.toggle('live', !paused);
    tick();
  } else {
    timerBtn.textContent = 'Start';
    timerBtn.className = 'btn-accent';
    timerBtn.onclick = startTimer;

    pauseBtn.hidden = true;

    clock.classList.remove('live');
    clock.textContent = '00:00:00';
  }

  ensureTicking();
}

/** Syncs the date inputs to current state and caps them at today. */
function renderDateInputs() {
  const today = todayIso();

  const manualDate = $('manual-date');
  if (!manualDate.value) manualDate.value = today;
  manualDate.max = today;

  const rangeStart = $('from-date');
  rangeStart.value = fromDate;
  rangeStart.max = today;
}

/** Draws the sessions in range, grouped by day, followed by the summary. */
function renderSessionLog() {
  const logContainer = $('log-container');
  const today = todayIso();

  // Newest day first; within a day, most recently created first.
  const visible = sessions
    .filter((session) => session.date >= fromDate && session.date <= today)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

  if (visible.length === 0) {
    logContainer.innerHTML = '<div class="empty">No sessions in this range.</div>';
    return;
  }

  logContainer.innerHTML = dayBlocksHtml(visible) + summaryHtml(visible);
}

/** Groups sessions by date and builds one dated block per day. */
function dayBlocksHtml(visibleSessions) {
  const sessionsByDate = new Map();
  for (const session of visibleSessions) {
    if (!sessionsByDate.has(session.date)) sessionsByDate.set(session.date, []);
    sessionsByDate.get(session.date).push(session);
  }

  return [...sessionsByDate.entries()]
    .map(([date, daySessions]) => {
      const rows = daySessions.map(sessionRowHtml).join('');
      return `
        <div class="day-block">
          <div class="day-label">${formatDate(date)}</div>
          <ul class="task-list">${rows}</ul>
        </div>`;
    })
    .join('');
}

/** Builds the markup for one session row. */
function sessionRowHtml(session) {
  return `
    <li class="session-item">
      <span class="session-task">${escapeHtml(session.taskName)}</span>
      <span class="session-right">
        <span class="mono">${formatMinutes(session.minutes)}</span>
        <button
          class="btn-ghost danger"
          data-action="delete-session"
          data-id="${session.id}"
          aria-label="Delete session"
        >🗑</button>
      </span>
    </li>`;
}

/** Builds the per-task totals and grand total for the visible range. */
function summaryHtml(visibleSessions) {
  const minutesByTask = new Map();
  for (const session of visibleSessions) {
    minutesByTask.set(session.taskName, (minutesByTask.get(session.taskName) || 0) + session.minutes);
  }

  const rows = [...minutesByTask.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([name, minutes]) =>
        `<div class="summary-item">
           <span>${escapeHtml(name)}</span>
           <span class="val mono">${formatMinutes(minutes)}</span>
         </div>`
    )
    .join('');

  const totalMinutes = visibleSessions.reduce((sum, session) => sum + session.minutes, 0);

  return `
    <div class="summary-box">
      <div class="summary-title mono">SUMMARY · ${formatDate(fromDate)} → today</div>
      ${rows}
      <div class="summary-total">
        <span>Total</span>
        <span class="val">${formatMinutes(totalMinutes)}</span>
      </div>
    </div>`;
}

// ---------- Events ----------

$('add-task-btn').onclick = addTask;
$('manual-log-btn').onclick = addManualSession;

$('new-task-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addTask();
});

$('task-select').addEventListener('change', (event) => {
  selectedTaskId = event.target.value;
});

$('from-date').addEventListener('change', (event) => {
  fromDate = event.target.value;
  render();
});

// Rendered rows are replaced on every render, so their buttons are handled
// by delegation on the containers instead of per-element listeners.
$('task-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const { action, id } = button.dataset;
  if (action === 'edit') {
    editingTaskId = id;
    render();
  } else if (action === 'cancel') {
    editingTaskId = null;
    render();
  } else if (action === 'save') {
    saveTaskEdit(id);
  } else if (action === 'delete') {
    deleteTask(id);
  }
});

$('status-filter-btn').addEventListener('click', () => toggleStatusFilter());

$('status-filter-panel').addEventListener('change', (event) => {
  const box = event.target;

  if (box.hasAttribute('data-select-all')) {
    taskStatusFilter = box.checked ? new Set(TASK_STATUSES) : new Set();
  } else if (box.dataset.status) {
    if (box.checked) taskStatusFilter.add(box.dataset.status);
    else taskStatusFilter.delete(box.dataset.status);
  } else {
    return;
  }

  saveStatusFilter();
  render();
});

// A click anywhere outside the popup, or Escape, dismisses it.
document.addEventListener('click', (event) => {
  if (!event.target.closest('#status-filter-btn, #status-filter-panel')) toggleStatusFilter(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') toggleStatusFilter(false);
});

$('task-list').addEventListener('change', (event) => {
  const select = event.target.closest('[data-status-for]');
  if (select) setTaskStatus(select.dataset.statusFor, select.value);
});

$('log-container').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="delete-session"]');
  if (button) deleteSession(button.dataset.id);
});

window.addEventListener('online', () => $('sync-dot').classList.add('online'));
window.addEventListener('offline', () => $('sync-dot').classList.remove('online'));

// ---------- Startup ----------

/** Live-syncs tasks and sessions for the signed-in user. */
function subscribe() {
  onSnapshot(
    tasksCol(),
    (snapshot) => {
      tasks = snapshot.docs
        .map((task) => ({ id: task.id, ...task.data() }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      render();
    },
    (error) => showError('Task sync error: ' + error.message)
  );

  onSnapshot(
    sessionsCol(),
    (snapshot) => {
      sessions = snapshot.docs.map((session) => ({ id: session.id, ...session.data() }));
      render();
    },
    (error) => showError('Session sync error: ' + error.message)
  );
}

onAuthStateChanged(auth, (user) => {
  if (!user) return;

  userId = user.uid;
  $('loading').hidden = true;
  $('app').hidden = false;
  $('sync-dot').classList.add('online');
  subscribe();
  render();
});

signInAnonymously(auth).catch((error) => {
  $('loading').textContent =
    'Could not connect: ' + error.message + ' — check that Anonymous auth is enabled in the Firebase console.';
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
