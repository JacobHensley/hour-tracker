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

/** Days before today that the session log covers by default (a two-week window). */
const DEFAULT_RANGE_DAYS = 13;

/** Timer sessions shorter than this round down to 0 minutes and are discarded. */
const MIN_LOGGABLE_MINUTES = 1;

const CLOCK_TICK_MS = 1000;

// ---------- DOM helpers ----------

const $ = (id) => document.getElementById(id);

/** Escapes text for safe interpolation into an innerHTML template. */
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function showError(message) {
  $('error-box').innerHTML = message ? `<div class="error">${escapeHtml(message)}</div>` : '';
}

function clearError() {
  showError('');
}

// ---------- Formatting helpers ----------

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

function todayIso() {
  return toIsoDate(new Date());
}

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
let fromDate = daysAgoIso(DEFAULT_RANGE_DAYS);
let tickHandle = null;

/** @returns {{ taskId: string, startedAt: number } | null} */
function getActiveTimer() {
  try {
    return JSON.parse(localStorage.getItem(TIMER_STORAGE_KEY));
  } catch {
    return null;
  }
}

function setActiveTimer(timer) {
  if (timer) {
    localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(timer));
  } else {
    localStorage.removeItem(TIMER_STORAGE_KEY);
  }
}

// ---------- Firestore references ----------

const tasksCol = () => collection(db, 'users', userId, 'tasks');
const sessionsCol = () => collection(db, 'users', userId, 'sessions');

// ---------- Tasks ----------

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
    await setDoc(doc(tasksCol(), id), { name, createdAt: Date.now() });
  } catch (error) {
    showError('Could not add task: ' + error.message);
  }
}

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

function findTaskName(id) {
  const task = tasks.find((candidate) => candidate.id === id);
  return task ? task.name : null;
}

// ---------- Sessions ----------

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

async function deleteSession(id) {
  try {
    await deleteDoc(doc(sessionsCol(), id));
  } catch (error) {
    showError('Could not delete session: ' + error.message);
  }
}

// ---------- Timer ----------

function startTimer() {
  selectedTaskId = $('task-select').value;
  if (!selectedTaskId) {
    showError('Pick a task first.');
    return;
  }
  clearError();

  setActiveTimer({ taskId: selectedTaskId, startedAt: Date.now() });
  render();
}

async function stopTimer() {
  const activeTimer = getActiveTimer();
  if (!activeTimer) return;

  const elapsedSeconds = (Date.now() - activeTimer.startedAt) / 1000;
  const minutes = Math.round(elapsedSeconds / 60); // nearest minute
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

function tick() {
  const activeTimer = getActiveTimer();
  if (!activeTimer) return;

  const clock = $('clock');
  if (clock) {
    clock.textContent = formatClock(Math.floor((Date.now() - activeTimer.startedAt) / 1000));
  }
}

/** Runs the clock only while a timer is active. */
function ensureTicking() {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  if (getActiveTimer()) {
    tickHandle = setInterval(tick, CLOCK_TICK_MS);
  }
}

// ---------- Rendering ----------

function render() {
  const activeTimer = getActiveTimer();

  $('today-label').textContent = formatDate(todayIso());
  renderTaskList();
  renderTaskSelect(activeTimer);
  renderTimerControls(activeTimer);
  renderDateInputs();
  renderSessionLog();
}

function renderTaskList() {
  const taskList = $('task-list');

  if (tasks.length === 0) {
    taskList.innerHTML = '<div class="empty">No tasks yet — add one above to start logging time against it.</div>';
    return;
  }

  taskList.innerHTML = tasks
    .map((task) => (task.id === editingTaskId ? taskEditRowHtml(task) : taskRowHtml(task)))
    .join('');

  focusTaskEditInput();
}

function taskRowHtml(task) {
  return `
    <li class="task-item">
      <span class="task-name">${escapeHtml(task.name)}</span>
      <span class="task-right">
        <button class="btn-ghost" data-action="edit" data-id="${task.id}" aria-label="Rename">✎</button>
        <button class="btn-ghost danger" data-action="delete" data-id="${task.id}" aria-label="Delete">🗑</button>
      </span>
    </li>`;
}

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

function renderTaskSelect(activeTimer) {
  const select = $('task-select');
  const activeTaskId = activeTimer ? activeTimer.taskId : selectedTaskId;

  select.innerHTML =
    '<option value="">Select task…</option>' +
    tasks
      .map(
        (task) =>
          `<option value="${task.id}"${task.id === activeTaskId ? ' selected' : ''}>${escapeHtml(task.name)}</option>`
      )
      .join('');

  // Don't let the task change mid-session.
  select.disabled = Boolean(activeTimer);
}

function renderTimerControls(activeTimer) {
  const timerBtn = $('timer-btn');
  const clock = $('clock');

  if (activeTimer) {
    timerBtn.textContent = 'Stop';
    timerBtn.className = 'btn-warn';
    timerBtn.onclick = stopTimer;
    clock.classList.add('live');
    tick();
  } else {
    timerBtn.textContent = 'Start';
    timerBtn.className = 'btn-accent';
    timerBtn.onclick = startTimer;
    clock.classList.remove('live');
    clock.textContent = '00:00:00';
  }

  ensureTicking();
}

function renderDateInputs() {
  const today = todayIso();

  const manualDate = $('manual-date');
  if (!manualDate.value) manualDate.value = today;
  manualDate.max = today;

  const rangeStart = $('from-date');
  rangeStart.value = fromDate;
  rangeStart.max = today;
}

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
