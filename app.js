/* ============================================================
   TaskFlow — Advanced To-Do App
   app.js  |  Vanilla JavaScript
   ============================================================ */

'use strict';

const SUPABASE_URL = 'https://prrkslwtfmttmaxemuql.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBycmtzbHd0Zm10dG1heGVtdXFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMTg2NjIsImV4cCI6MjA5OTc5NDY2Mn0.er9c7dUt5NbzY7KmKZ_qf_gkkVhbc0lgxLRahtXr928';
let supabase = null;
try {
  if (window.supabase) {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  } else {
    console.warn("Supabase CDN failed to load.");
  }
} catch(e) {
  console.error("Supabase init error:", e);
}

/* ============================================================
   STATE
   ============================================================ */
const state = {
  tasks: [],            // All tasks
  currentUser: null,    // Logged-in username
  activeCategory: 'all',
  activePriority: 'all',
  searchQuery: '',
  sortBy: 'created',
  editingId: null,      // Task being edited in modal
  pomodoroId: null,     // Task tied to pomodoro
  streak: 0,
  lastStreakDate: null,
  _deadlineNotified: new Set(), // prevent repeat toasts in session
};

/* Pomodoro state */
const pomo = {
  interval: null,
  timeLeft: 25 * 60,   // seconds
  sessions: 0,
  running: false,
  TOTAL: 25 * 60,
};

/* Calendar state */
const calState = {
  year:  new Date().getFullYear(),
  month: new Date().getMonth(), // 0-indexed
  selectedDay: null,
};

/* Subtasks being built in the modal */
let modalSubtasks = [];

/* Drag-and-drop */
let dragSrcId = null;

/* Confetti */
let confettiTimer = null;
let confettiDone = false; // fire only once per "all complete" event

/* ============================================================
   CONSTANTS
   ============================================================ */
const PRIORITY_ORDER  = { critical: 0, high: 1, medium: 2, low: 3 };
const CAT_ICONS       = { work: '💼', personal: '🏠', shopping: '🛒', health: '💪', other: '📌' };
const CIRCUM_SMALL    = 2 * Math.PI * 50;   // ≈ 314  (stats ring, r=50)
const CIRCUM_POMO     = 2 * Math.PI * 85;   // ≈ 534  (pomodoro ring, r=85)
const MONTH_NAMES     = ['January','February','March','April','May','June',
                         'July','August','September','October','November','December'];

/* ============================================================
   UTILS
   ============================================================ */
/** Generate a random ID */
const uid = () => '_' + Math.random().toString(36).slice(2, 11);

/** Today as a locale date string for streak comparison */
const todayStr = () => new Date().toDateString();

/**
 * Safely escape HTML to prevent XSS.
 * Only used when inserting user content into innerHTML.
 */
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Format an ISO date string to a short locale string */
function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Is this date in the past? */
const isOverdue = (iso) => iso && new Date(iso) < new Date();

/** Is this date within 24 h in the future? */
const isSoon = (iso) => {
  if (!iso) return false;
  const diff = new Date(iso) - Date.now();
  return diff > 0 && diff < 86_400_000;
};

/* ============================================================
   SUPABASE PERSISTENCE
   ============================================================ */
async function saveData() {
  if (!state.currentUser) return;
  
  // We save streak in local storage for simplicity, tasks go to supabase
  const u = state.currentUser;
  localStorage.setItem(`tf_streak_${u}`, JSON.stringify({
    streak: state.streak,
    lastStreakDate: state.lastStreakDate,
  }));
}

async function loadData() {
  if (!state.currentUser) return;
  const u = state.currentUser;
  
  try {
    const s = localStorage.getItem(`tf_streak_${u}`);
    if (s) {
      const { streak, lastStreakDate } = JSON.parse(s);
      state.streak = streak;
      state.lastStreakDate = lastStreakDate;
    } else {
      state.streak = 0;
      state.lastStreakDate = null;
    }
    
    // Fetch from Supabase
    const { data, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    
    state.tasks = data.map(t => ({
      id: t.id,
      title: t.title,
      notes: t.notes,
      category: t.category,
      priority: t.priority,
      due: t.due,
      recurring: t.recurring,
      subtasks: t.subtasks || [],
      completed: t.completed,
      completedAt: t.completed_at,
      createdAt: t.created_at
    }));
    
  } catch (err) {
    console.error("Error loading tasks", err);
    state.tasks = [];
  }
}

/* ============================================================
   RECURRING TASK REFRESH
   Resets completed recurring tasks when their period has elapsed.
   ============================================================ */
function refreshRecurring() {
  const now = new Date();
  state.tasks.forEach(task => {
    if (!task.completed || task.recurring === 'none') return;
    const completed = new Date(task.completedAt);
    let reset = false;

    if (task.recurring === 'daily') {
      reset = completed.toDateString() !== now.toDateString();
    } else if (task.recurring === 'weekly') {
      reset = (now - completed) / 86_400_000 >= 7;
    } else if (task.recurring === 'monthly') {
      reset = completed.getMonth() !== now.getMonth() ||
              completed.getFullYear() !== now.getFullYear();
    }

    if (reset) {
      task.completed   = false;
      task.completedAt = null;
      task.subtasks.forEach(s => (s.done = false));
    }
  });
}

/* ============================================================
   FILTERED & SORTED TASK LIST
   ============================================================ */
function filteredTasks() {
  let list = [...state.tasks];

  if (state.activeCategory !== 'all')
    list = list.filter(t => t.category === state.activeCategory);

  if (state.activePriority !== 'all')
    list = list.filter(t => t.priority === state.activePriority);

  if (state.searchQuery.trim()) {
    const q = state.searchQuery.toLowerCase();
    list = list.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t.notes && t.notes.toLowerCase().includes(q)) ||
      t.subtasks.some(s => s.text.toLowerCase().includes(q))
    );
  }

  list.sort((a, b) => {
    switch (state.sortBy) {
      case 'due':
        if (!a.due && !b.due) return 0;
        if (!a.due) return 1;
        if (!b.due) return -1;
        return new Date(a.due) - new Date(b.due);
      case 'priority':
        return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      case 'name':
        return a.title.localeCompare(b.title);
      default: // 'created'
        return new Date(b.createdAt) - new Date(a.createdAt);
    }
  });

  return list;
}

/* ============================================================
   STATS & STREAK
   ============================================================ */
function updateStats() {
  // Tasks created today
  const today = todayStr();
  const todayTasks = state.tasks.filter(t => new Date(t.createdAt).toDateString() === today);
  const todayDone  = todayTasks.filter(t => t.completed).length;
  const todayTotal = todayTasks.length;
  const pct = todayTotal > 0 ? Math.round((todayDone / todayTotal) * 100) : 0;

  // Progress ring (r=50, circumference ≈ 314)
  const offset = CIRCUM_SMALL - (pct / 100) * CIRCUM_SMALL;
  document.getElementById('progress-ring-fill').style.strokeDashoffset = offset;
  document.getElementById('completion-pct').textContent = pct + '%';

  // Numbers
  const total   = state.tasks.length;
  const done    = state.tasks.filter(t => t.completed).length;
  const pending = total - done;
  document.getElementById('stat-total').textContent   = total;
  document.getElementById('stat-done').textContent    = done;
  document.getElementById('stat-pending').textContent = pending;
  document.getElementById('stat-streak').textContent  = '🔥 ' + state.streak;

  // Category counts
  ['all','work','personal','shopping','health','other'].forEach(cat => {
    const count = cat === 'all'
      ? state.tasks.length
      : state.tasks.filter(t => t.category === cat).length;
    const el = document.getElementById('count-' + cat);
    if (el) el.textContent = count;
  });

  // Streak
  if (todayTotal > 0 && todayDone === todayTotal) {
    if (state.lastStreakDate !== today) {
      const yesterday = new Date(Date.now() - 86_400_000).toDateString();
      state.streak = state.lastStreakDate === yesterday ? state.streak + 1 : 1;
      state.lastStreakDate = today;
      saveData();
    }
    // Confetti — fire only once per page session when all tasks complete
    if (!confettiDone) {
      confettiDone = true;
      showConfetti();
      showToast('All tasks done! Amazing! 🎉', 'success', '🎊');
    }
  } else {
    confettiDone = false; // reset so it fires again next time
  }
}

/* ============================================================
   RENDER
   ============================================================ */
function render() {
  const list      = document.getElementById('task-list');
  const emptyEl   = document.getElementById('empty-state');
  const tasks     = filteredTasks();

  if (tasks.length === 0) {
    list.innerHTML = '';
    emptyEl.classList.remove('hidden');
    emptyEl.removeAttribute('aria-hidden');
  } else {
    emptyEl.classList.add('hidden');
    emptyEl.setAttribute('aria-hidden', 'true');
    list.innerHTML = tasks.map(buildTaskCard).join('');
    bindCardEvents();
  }

  updateStats();
  if (!document.getElementById('calendar-view').classList.contains('hidden')) renderCalendar();
}

/* Build the HTML string for a single task card */
function buildTaskCard(task) {
  const subTotal = task.subtasks.length;
  const subDone  = task.subtasks.filter(s => s.done).length;
  const subPct   = subTotal > 0 ? (subDone / subTotal) * 100 : 0;

  const dateStr    = fmtDate(task.due);
  const overdueCls = !task.completed && isOverdue(task.due) ? 'overdue' : '';
  const soonCls    = !task.completed && isSoon(task.due)    ? 'soon'    : '';
  const dueClass   = overdueCls || soonCls;
  const duePrefix  = overdueCls ? '⚠️ ' : soonCls ? '⏰ ' : '📅 ';

  return /* html */`
<div class="task-card ${task.completed ? 'completed' : ''} ${overdueCls}"
     data-id="${esc(task.id)}"
     data-priority="${esc(task.priority)}"
     role="listitem"
     draggable="true"
     aria-label="${esc(task.title)}">

  <div class="task-main">
    <input type="checkbox" class="task-checkbox" data-id="${esc(task.id)}"
           ${task.completed ? 'checked' : ''}
           aria-label="Mark '${esc(task.title)}' as ${task.completed ? 'incomplete' : 'complete'}" />

    <div class="task-body">
      <div class="task-title-row">
        <span class="task-title">${esc(task.title)}</span>
        <span class="p-badge ${esc(task.priority)}">${esc(task.priority)}</span>
        ${task.recurring !== 'none' ? `<span class="recur-badge">🔁 ${esc(task.recurring)}</span>` : ''}
      </div>

      <div class="task-meta">
        <span class="task-cat">${CAT_ICONS[task.category] || ''} ${esc(task.category)}</span>
        ${dateStr ? `<span class="task-due ${dueClass}">${duePrefix}${esc(dateStr)}</span>` : ''}
        ${subTotal > 0 ? `<span class="task-cat">${subDone}/${subTotal} sub-tasks</span>` : ''}
      </div>

      ${task.notes ? `<div class="task-notes-preview">${esc(task.notes)}</div>` : ''}
    </div>

    <div class="task-actions">
      ${task.notes ? `<button class="task-btn expand" data-id="${esc(task.id)}" title="Toggle notes">📝</button>` : ''}
      <button class="task-btn pomo"   data-id="${esc(task.id)}" title="Pomodoro timer">🍅</button>
      <button class="task-btn edit"   data-id="${esc(task.id)}" title="Edit task">✏️</button>
      <button class="task-btn delete" data-id="${esc(task.id)}" title="Delete task">🗑️</button>
    </div>
  </div>

  ${task.notes ? `<div class="task-notes-full" id="notes-${esc(task.id)}">${esc(task.notes)}</div>` : ''}

  ${subTotal > 0 ? `
  <div class="subtasks-wrap">
    <div class="subtask-bar">
      <div class="subtask-bar-fill" style="width:${subPct}%"></div>
    </div>
    <ul class="subtask-list-view">
      ${task.subtasks.map((s, i) => `
      <li class="subtask-row ${s.done ? 'done' : ''}" data-task-id="${esc(task.id)}" data-idx="${i}">
        <input type="checkbox" class="sub-chk" data-task-id="${esc(task.id)}" data-idx="${i}"
               ${s.done ? 'checked' : ''}
               aria-label="${esc(s.text)}" />
        <span>${esc(s.text)}</span>
        <button class="subtask-row-del" data-task-id="${esc(task.id)}" data-idx="${i}" title="Remove">✕</button>
      </li>`).join('')}
    </ul>
  </div>` : ''}
</div>`;
}

/* ============================================================
   EVENT DELEGATION — CARD EVENTS
   ============================================================ */
function bindCardEvents() {
  const list = document.getElementById('task-list');

  list.querySelectorAll('.task-checkbox').forEach(cb =>
    cb.addEventListener('change', e => toggleTask(e.target.dataset.id))
  );

  list.querySelectorAll('.task-btn.edit').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); openEditModal(btn.dataset.id); })
  );

  list.querySelectorAll('.task-btn.delete').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); deleteTask(btn.dataset.id); })
  );

  list.querySelectorAll('.task-btn.expand').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById('notes-' + btn.dataset.id)?.classList.toggle('open');
    })
  );

  list.querySelectorAll('.task-btn.pomo').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); openPomodoro(btn.dataset.id); })
  );

  list.querySelectorAll('.sub-chk').forEach(cb =>
    cb.addEventListener('change', e =>
      toggleSubtask(e.target.dataset.taskId, +e.target.dataset.idx)
    )
  );

  list.querySelectorAll('.subtask-row-del').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteSubtask(btn.dataset.taskId, +btn.dataset.idx);
    })
  );

  // Drag and drop
  list.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('dragstart',  onDragStart);
    card.addEventListener('dragover',   onDragOver);
    card.addEventListener('dragleave',  onDragLeave);
    card.addEventListener('drop',       onDrop);
    card.addEventListener('dragend',    onDragEnd);
  });
}

/* ============================================================
   TASK CRUD (SUPABASE)
   ============================================================ */
async function createTask(data) {
  const task = {
    title:       data.title.trim(),
    notes:       (data.notes || '').trim(),
    category:    data.category  || 'other',
    priority:    data.priority  || 'medium',
    due:         data.due       || null,
    recurring:   data.recurring || 'none',
    subtasks:    data.subtasks  || [],
    completed:   false,
    completed_at: null,
    user_id:     state.currentUser // Using UUID from auth
  };
  
  const { data: insertedData, error } = await supabase.from('tasks').insert([task]).select();
  
  if (error) {
    showToast('Error creating task', 'error', '⚠️');
    return;
  }
  
  const dbTask = insertedData[0];
  state.tasks.unshift({
    id: dbTask.id,
    title: dbTask.title,
    notes: dbTask.notes,
    category: dbTask.category,
    priority: dbTask.priority,
    due: dbTask.due,
    recurring: dbTask.recurring,
    subtasks: dbTask.subtasks,
    completed: dbTask.completed,
    completedAt: dbTask.completed_at,
    createdAt: dbTask.created_at
  });
  
  await saveData();
  render();
  showToast('Task added!', 'success', '✅');
}

async function updateTask(id, data) {
  const idx = state.tasks.findIndex(t => t.id === id);
  if (idx === -1) return;
  
  const updatePayload = {
    title: data.title,
    notes: data.notes,
    category: data.category,
    priority: data.priority,
    due: data.due,
    recurring: data.recurring,
    subtasks: data.subtasks
  };

  const { error } = await supabase.from('tasks').update(updatePayload).eq('id', id);
  
  if (error) {
    showToast('Error updating task', 'error', '⚠️');
    return;
  }

  state.tasks[idx] = { ...state.tasks[idx], ...data };
  await saveData();
  render();
  showToast('Task updated!', 'info', '✏️');
}

async function deleteTask(id) {
  const card = document.querySelector(`.task-card[data-id="${CSS.escape(id)}"]`);
  
  const finishDelete = async () => {
    state.tasks = state.tasks.filter(t => t.id !== id);
    await supabase.from('tasks').delete().eq('id', id);
    await saveData();
    render();
    showToast('Task deleted', 'error', '🗑️');
  };
  
  if (card) {
    card.classList.add('deleting');
    card.addEventListener('animationend', finishDelete, { once: true });
  } else {
    finishDelete();
  }
}

async function toggleTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  
  task.completed   = !task.completed;
  task.completedAt = task.completed ? new Date().toISOString() : null;
  
  const { error } = await supabase.from('tasks').update({
    completed: task.completed,
    completed_at: task.completedAt
  }).eq('id', id);
  
  await saveData();
  render();
  if (task.completed)
    showToast(`"${task.title.slice(0, 28)}…" done!`, 'success', '🎉');
}

async function toggleSubtask(taskId, idx) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task?.subtasks[idx]) return;
  
  task.subtasks[idx].done = !task.subtasks[idx].done;
  
  await supabase.from('tasks').update({ subtasks: task.subtasks }).eq('id', taskId);
  
  await saveData();
  render();
}

async function deleteSubtask(taskId, idx) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  
  task.subtasks.splice(idx, 1);
  await supabase.from('tasks').update({ subtasks: task.subtasks }).eq('id', taskId);
  
  await saveData();
  render();
}

/* ============================================================
   ADD / EDIT MODAL
   ============================================================ */
function openAddModal() {
  state.editingId = null;
  modalSubtasks   = [];
  document.getElementById('modal-title').textContent = 'New Task';
  document.getElementById('task-title').value    = '';
  document.getElementById('task-notes').value    = '';
  document.getElementById('task-category').value = 'work';
  document.getElementById('task-priority').value = 'medium';
  document.getElementById('task-due').value      = '';
  document.getElementById('task-recurring').value= 'none';
  renderModalSubtasks();
  document.getElementById('task-modal').hidden = false;
  requestAnimationFrame(() => document.getElementById('task-title').focus());
}

function openEditModal(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  state.editingId  = id;
  modalSubtasks    = task.subtasks.map(s => ({ ...s }));

  document.getElementById('modal-title').textContent = 'Edit Task';
  document.getElementById('task-title').value    = task.title;
  document.getElementById('task-notes').value    = task.notes || '';
  document.getElementById('task-category').value = task.category;
  document.getElementById('task-priority').value = task.priority;
  document.getElementById('task-due').value      = task.due
    ? new Date(task.due).toISOString().slice(0, 16) : '';
  document.getElementById('task-recurring').value= task.recurring;
  renderModalSubtasks();
  document.getElementById('task-modal').hidden = false;
  requestAnimationFrame(() => document.getElementById('task-title').focus());
}

function closeModal() {
  document.getElementById('task-modal').hidden = true;
  state.editingId = null;
  modalSubtasks   = [];
}

function saveModal() {
  const titleEl = document.getElementById('task-title');
  const title   = titleEl.value.trim();

  if (!title) {
    titleEl.classList.add('error');
    titleEl.focus();
    setTimeout(() => titleEl.classList.remove('error'), 1600);
    showToast('Task title is required', 'error', '⚠️');
    return;
  }

  const dueVal = document.getElementById('task-due').value;

  const data = {
    title,
    notes:     document.getElementById('task-notes').value,
    category:  document.getElementById('task-category').value,
    priority:  document.getElementById('task-priority').value,
    due:       dueVal ? new Date(dueVal).toISOString() : null,
    recurring: document.getElementById('task-recurring').value,
    subtasks:  modalSubtasks,
  };

  if (state.editingId) {
    updateTask(state.editingId, data);
  } else {
    createTask(data);
  }
  closeModal();
}

function renderModalSubtasks() {
  const list = document.getElementById('modal-subtask-list');
  list.innerHTML = modalSubtasks.map((s, i) => /* html */`
    <li class="modal-sub-item">
      <span>${esc(s.text)}</span>
      <button class="modal-sub-del" data-idx="${i}" type="button" aria-label="Remove sub-task">✕</button>
    </li>
  `).join('');

  list.querySelectorAll('.modal-sub-del').forEach(btn =>
    btn.addEventListener('click', () => {
      modalSubtasks.splice(+btn.dataset.idx, 1);
      renderModalSubtasks();
    })
  );
}

function addModalSubtask() {
  const input = document.getElementById('subtask-input');
  const text  = input.value.trim();
  if (!text) return;
  modalSubtasks.push({ text, done: false });
  input.value = '';
  renderModalSubtasks();
  input.focus();
}

/* ============================================================
   DRAG AND DROP
   ============================================================ */
function onDragStart(e) {
  dragSrcId = e.currentTarget.dataset.id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragSrcId);
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.task-card').forEach(c => c.classList.remove('drag-over'));
}
function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const targetId = e.currentTarget.dataset.id;
  if (!dragSrcId || dragSrcId === targetId) return;

  const srcIdx = state.tasks.findIndex(t => t.id === dragSrcId);
  const tgtIdx = state.tasks.findIndex(t => t.id === targetId);
  if (srcIdx === -1 || tgtIdx === -1) return;

  const [removed] = state.tasks.splice(srcIdx, 1);
  state.tasks.splice(tgtIdx, 0, removed);
  saveData();
  render();
}

/* ============================================================
   POMODORO TIMER
   ============================================================ */
function openPomodoro(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  state.pomodoroId = taskId;
  document.getElementById('pomo-task-name').textContent = task.title;
  resetPomo();
  document.getElementById('pomodoro-modal').hidden = false;
}

function closePomodoro() {
  clearInterval(pomo.interval);
  pomo.running = false;
  document.getElementById('pomodoro-modal').hidden = true;
}

function startPomo() {
  if (pomo.running) return;
  pomo.running  = true;
  pomo.interval = setInterval(() => {
    pomo.timeLeft--;
    updatePomoDisplay();
    if (pomo.timeLeft <= 0) {
      clearInterval(pomo.interval);
      pomo.running = false;
      pomo.sessions++;
      document.getElementById('pomo-sessions').textContent =
        `Sessions completed: ${pomo.sessions}`;
      showToast('Pomodoro done! Take a break 🎉', 'success', '🍅');
      resetPomo();
    }
  }, 1000);
}

function pausePomo() {
  clearInterval(pomo.interval);
  pomo.running = false;
}

function resetPomo() {
  clearInterval(pomo.interval);
  pomo.running  = false;
  pomo.timeLeft = pomo.TOTAL;
  updatePomoDisplay();
}

function updatePomoDisplay() {
  const m = String(Math.floor(pomo.timeLeft / 60)).padStart(2, '0');
  const s = String(pomo.timeLeft % 60).padStart(2, '0');
  document.getElementById('pomo-time').textContent = `${m}:${s}`;

  // Drain ring: at full time offset=0, at 0 offset=circumference
  const progress = pomo.timeLeft / pomo.TOTAL;
  const offset   = CIRCUM_POMO * (1 - progress);
  document.getElementById('pomo-ring-fill').style.strokeDashoffset = offset;
}

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */
function showToast(msg, type = 'info', icon = 'ℹ️', duration = 3200) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  // Use textContent for safety; icon is a hardcoded emoji from our own code
  el.innerHTML = `<span class="toast-icon" aria-hidden="true">${icon}</span>`;
  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-msg';
  msgSpan.textContent = msg;
  el.appendChild(msgSpan);
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('hiding');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

/* ============================================================
   DEADLINE CHECKER  (runs every 60 s)
   ============================================================ */
function checkDeadlines() {
  state.tasks.forEach(task => {
    if (!task.completed && isSoon(task.due) && !state._deadlineNotified.has(task.id)) {
      state._deadlineNotified.add(task.id);
      showToast(`"${task.title.slice(0,28)}" is due soon!`, 'warning', '⏰');
    }
  });
}

/* ============================================================
   CONFETTI  (canvas-based)
   ============================================================ */
function showConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  const ctx    = canvas.getContext('2d');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  const pieces = Array.from({ length: 140 }, () => ({
    x:    Math.random() * canvas.width,
    y:    Math.random() * canvas.height - canvas.height,
    r:    Math.random() * 7 + 3,
    d:    Math.random() * 100 + 10,
    color:`hsl(${Math.floor(Math.random()*360)},75%,60%)`,
    tilt: Math.random() * 10 - 10,
    tiltInc: Math.random() * 0.07 + 0.04,
    tiltAngle: 0,
  }));

  let frame = 0;
  if (confettiTimer) clearInterval(confettiTimer);

  confettiTimer = setInterval(() => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    frame++;
    pieces.forEach(p => {
      p.tiltAngle += p.tiltInc;
      p.y   += (Math.cos(frame / 20 + p.d) + 2.2 + p.r / 2) * 0.9;
      p.tilt = Math.sin(p.tiltAngle) * 14;
      ctx.beginPath();
      ctx.lineWidth   = p.r;
      ctx.strokeStyle = p.color;
      ctx.moveTo(p.x + p.tilt + p.r / 3, p.y);
      ctx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r / 5);
      ctx.stroke();
    });
    if (frame > 220) {
      clearInterval(confettiTimer);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, 16);
}

/* ============================================================
   EXPORT
   ============================================================ */
/* ============================================================
   AUTH — Supabase User Management
   ============================================================ */

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-wrapper').style.display  = '';
}
function showAuth() {
  document.getElementById('app-wrapper').style.display  = 'none';
  document.getElementById('auth-screen').style.display  = '';
}
function setAuthError(formId, msg) {
  const el = document.getElementById(formId + '-error');
  if (el) el.textContent = msg;
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  setAuthError('login', '');

  if (!username || !password) {
    setAuthError('login', 'Please fill in all fields.'); return;
  }
  
  if (!supabase) {
    setAuthError('login', 'Supabase backend failed to load. Check your internet or adblocker.');
    return;
  }
  
  // Use email for supabase login (username + @taskflow.com)
  const email = username.includes('@') ? username : `${username}@taskflow.com`;

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email,
    password: password,
  });

  if (error) { setAuthError('login', error.message); return; }

  state.currentUser = data.user.id;
  await loadData();
  refreshRecurring();
  updateUserBadge(username);
  showApp();
  render();
  startDeadlineChecker();
  showToast(`Welcome back! 👋`, 'success', '👋');
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm  = document.getElementById('reg-confirm').value;
  setAuthError('register', '');

  if (!username || !password || !confirm) {
    setAuthError('register', 'Please fill in all fields.'); return;
  }
  if (password.length < 6) {
    setAuthError('register', 'Password must be at least 6 characters.'); return;
  }
  if (password !== confirm) {
    setAuthError('register', 'Passwords do not match.'); return;
  }

  const email = username.includes('@') ? username : `${username}@taskflow.com`;

  const { data, error } = await supabase.auth.signUp({
    email: email,
    password: password,
  });

  if (error) { 
    setAuthError('register', error.message); 
    return; 
  }
  
  if (!data.user) {
    setAuthError('register', 'Could not create account. User might already exist.');
    return;
  }
  
  if (!data.session) {
    setAuthError('register', 'Account created! Please check your email to confirm your account. (If you used a fake email, you MUST disable Email Confirmations in your Supabase Dashboard).');
    return;
  }

  state.currentUser = data.user.id;
  state.tasks = []; state.streak = 0; state.lastStreakDate = null;
  await saveData();
  updateUserBadge(username);
  showApp();
  render();
  startDeadlineChecker();
  showToast(`Account created! Welcome! 🎉`, 'success', '🎉');
}

async function handleLogout() {
  await supabase.auth.signOut();
  state.currentUser = null;
  state.tasks = []; state.streak = 0; state.lastStreakDate = null;
  state._deadlineNotified = new Set();
  confettiDone = false;
  showAuth();
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.auth-tab[data-tab="login"]').classList.add('active');
  document.getElementById('login-form').style.display    = '';
  document.getElementById('register-form').style.display = 'none';
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  setAuthError('login', '');
  showToast('Signed out. See you soon!', 'info', '👋');
}

function updateUserBadge(email) {
  const name = email ? email.split('@')[0] : 'User';
  document.getElementById('user-name').textContent   = name;
  document.getElementById('user-avatar').textContent = name.charAt(0).toUpperCase();
}


/* ---- Auth tab switching ---- */
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => {
      t.classList.remove('active'); t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active'); tab.setAttribute('aria-selected', 'true');
    const target = tab.dataset.tab;
    document.getElementById('login-form').style.display    = target === 'login'    ? '' : 'none';
    document.getElementById('register-form').style.display = target === 'register' ? '' : 'none';
    setAuthError('login', ''); setAuthError('register', '');
  });
});

/* ---- Password visibility toggles ---- */
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const isHidden = input.type === 'password';
    input.type   = isHidden ? 'text' : 'password';
    btn.textContent = isHidden ? '🙈' : '👁';
  });
});

document.getElementById('login-form').addEventListener('submit', handleLogin);
document.getElementById('register-form').addEventListener('submit', handleRegister);
document.getElementById('btn-logout').addEventListener('click', handleLogout);

/* ============================================================
   EXPORT
   ============================================================ */
document.getElementById('export-json').addEventListener('click', () => {
  const json = JSON.stringify(state.tasks, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: `taskflow-${Date.now()}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
  showToast('Tasks exported as JSON', 'success', '📄');
});

document.getElementById('export-pdf').addEventListener('click', () => {
  const rows = state.tasks.map(t => {
    const sub = t.subtasks.length
      ? '\n   Sub-tasks:\n' + t.subtasks.map(s => `     [${s.done?'x':' '}] ${s.text}`).join('\n')
      : '';
    const due = t.due ? ` | Due: ${fmtDate(t.due)}` : '';
    const notes = t.notes ? `\n   Notes: ${t.notes}` : '';
    return `[${t.completed?'✓':' '}] ${t.title}  (${t.priority})  [${t.category}]${due}${notes}${sub}`;
  }).join('\n\n');

  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><title>TaskFlow Export</title>
<style>
  body{font-family:Arial,sans-serif;padding:2rem 3rem;color:#1e293b;max-width:860px;margin:auto}
  h1{color:#6366f1;margin-bottom:.5rem}
  p.sub{color:#94a3b8;font-size:.85rem;margin-bottom:1.5rem}
  pre{white-space:pre-wrap;font-size:.85rem;line-height:1.8;background:#f8fafc;padding:1.5rem;border-radius:8px;border:1px solid #e2e8f0}
  footer{margin-top:2rem;font-size:.72rem;color:#94a3b8}
</style></head><body>
<h1>✦ TaskFlow Export</h1>
<p class="sub">Exported: ${new Date().toLocaleString()} &nbsp;|&nbsp; Total: ${state.tasks.length} tasks</p>
<pre>${rows.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
<footer>Generated by TaskFlow</footer>
</body></html>`;

  const win = window.open('', '_blank');
  if (!win) { showToast('Allow popups to export PDF', 'warning', '⚠️'); return; }
  win.document.write(html);
  win.document.close();
  // Give the browser a moment to render before opening print dialog
  setTimeout(() => win.print(), 600);
  showToast('PDF print dialog opened', 'info', '📑');
});

/* ============================================================
   THEME TOGGLE
   ============================================================ */
function initTheme() {
  const saved = localStorage.getItem('tf_theme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('#theme-toggle .theme-icon').textContent =
    theme === 'dark' ? '🌙' : '☀️';
  localStorage.setItem('tf_theme', theme);
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

/* ============================================================
   KEYBOARD SHORTCUTS
   ============================================================ */
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName.toLowerCase();
  const inField = ['input','textarea','select'].includes(tag);
  const taskModalOpen = !document.getElementById('task-modal').hidden;

  // N — open new task modal
  if (!inField && !taskModalOpen && e.key === 'n') {
    e.preventDefault();
    openAddModal();
    return;
  }

  // Ctrl/Cmd + F — focus search
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    document.getElementById('search-input').focus();
    return;
  }

  // Escape — close modals
  if (e.key === 'Escape') {
    if (!document.getElementById('task-modal').hidden)     closeModal();
    if (!document.getElementById('pomodoro-modal').hidden) closePomodoro();
    return;
  }

  // Enter in task modal (not textarea) — save
  if (e.key === 'Enter' && taskModalOpen && tag !== 'textarea') {
    e.preventDefault();
    saveModal();
  }
});

/* ============================================================
   MODAL BINDINGS
   ============================================================ */
document.getElementById('add-task-btn').addEventListener('click', openAddModal);
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-save').addEventListener('click', saveModal);
document.getElementById('add-subtask-btn').addEventListener('click', addModalSubtask);

document.getElementById('subtask-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addModalSubtask(); }
});

// Close modal by clicking backdrop
document.getElementById('task-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('task-modal')) closeModal();
});

/* ============================================================
   POMODORO BINDINGS
   ============================================================ */
document.getElementById('pomodoro-close').addEventListener('click', closePomodoro);
document.getElementById('pomo-start').addEventListener('click', startPomo);
document.getElementById('pomo-pause').addEventListener('click', pausePomo);
document.getElementById('pomo-reset').addEventListener('click', resetPomo);

document.getElementById('pomodoro-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('pomodoro-modal')) closePomodoro();
});

/* ============================================================
   FILTER & SEARCH BINDINGS
   ============================================================ */
document.getElementById('search-input').addEventListener('input', e => {
  state.searchQuery = e.target.value;
  render();
});

document.getElementById('cat-list').addEventListener('click', e => {
  const item = e.target.closest('.cat-item');
  if (!item) return;
  document.querySelectorAll('.cat-item').forEach(el => {
    el.classList.remove('active');
    el.setAttribute('aria-pressed', 'false');
  });
  item.classList.add('active');
  item.setAttribute('aria-pressed', 'true');
  state.activeCategory = item.dataset.cat;
  render();
});

// Keyboard accessibility for category list
document.getElementById('cat-list').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.target.closest('.cat-item')?.click();
  }
});

document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => {
      c.classList.remove('active');
      c.setAttribute('aria-pressed', 'false');
    });
    chip.classList.add('active');
    chip.setAttribute('aria-pressed', 'true');
    state.activePriority = chip.dataset.priority;
    render();
  });
});

document.getElementById('sort-select').addEventListener('change', e => {
  state.sortBy = e.target.value;
  render();
});

/* ============================================================
   SIDEBAR MOBILE TOGGLE
   ============================================================ */
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('visible');
});

document.getElementById('sidebar-overlay').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
});

/* ============================================================
   CALENDAR VIEW
   ============================================================ */
function renderCalendar() {
  const { year, month } = calState;
  document.getElementById('cal-month-title').textContent = `${MONTH_NAMES[month]} ${year}`;

  // Build due-date map: "YYYY-MM-DD" → [task, ...]
  const dayMap = {};
  state.tasks.forEach(task => {
    if (!task.due) return;
    const d   = new Date(task.due);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    (dayMap[key] = dayMap[key] || []).push(task);
  });

  const firstDow    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today       = new Date();

  let html = '';
  for (let i = 0; i < firstDow; i++) html += `<div class="cal-day empty"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const km  = String(month + 1).padStart(2, '0');
    const kd  = String(day).padStart(2, '0');
    const key = `${year}-${km}-${kd}`;
    const tasks   = dayMap[key] || [];
    const count   = tasks.length;
    const doneCnt = tasks.filter(t => t.completed).length;

    const isToday = today.getFullYear() === year &&
                    today.getMonth()    === month &&
                    today.getDate()     === day;
    const isSelected = calState.selectedDay === key;

    let occ = 0;
    if      (count >= 7) occ = 4;
    else if (count >= 5) occ = 3;
    else if (count >= 3) occ = 2;
    else if (count >= 1) occ = 1;

    const dots = tasks.slice(0, 4).map(t =>
      `<span class="cal-dot ${t.completed ? 'done' : esc(t.priority)}" title="${esc(t.title)}"></span>`
    ).join('');

    html += `
<div class="cal-day occ-${occ}${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}"
     data-date="${key}" role="gridcell" tabindex="0"
     aria-label="${day} ${MONTH_NAMES[month]}, ${count} task${count !== 1 ? 's' : ''}${isToday ? ', today' : ''}">
  <span class="cal-day-num">${day}</span>
  ${count > 0 ? `<div class="cal-dots">${dots}${count > 4 ? `<span class="cal-more">+${count - 4}</span>` : ''}</div>` : ''}
  ${count > 0 ? `<span class="cal-count">${doneCnt}/${count}</span>` : ''}
</div>`;
  }

  document.getElementById('cal-grid').innerHTML = html;

  document.getElementById('cal-grid').querySelectorAll('.cal-day').forEach(cell => {
    cell.addEventListener('click',   () => selectCalDay(cell.dataset.date));
    cell.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCalDay(cell.dataset.date); }
    });
  });

  renderCalDayDetail(
    calState.selectedDay,
    calState.selectedDay ? (dayMap[calState.selectedDay] || []) : null
  );
}

function selectCalDay(dateKey) {
  calState.selectedDay = calState.selectedDay === dateKey ? null : dateKey;
  renderCalendar();
}

function renderCalDayDetail(dateKey, tasks) {
  const detail = document.getElementById('cal-day-detail');
  if (!dateKey) {
    detail.innerHTML = '<p class="cal-detail-empty">Click a day to see its tasks.</p>';
    return;
  }
  const [y, m, d] = dateKey.split('-');
  const dateLabel  = new Date(+y, +m - 1, +d).toLocaleDateString(undefined,
    { weekday: 'long', month: 'long', day: 'numeric' });

  if (!tasks || !tasks.length) {
    detail.innerHTML = `
      <div class="cal-detail-header">
        <span class="cal-detail-date">${dateLabel}</span>
        <span class="cal-detail-summary">No tasks due</span>
      </div>`;
    return;
  }

  const doneCnt = tasks.filter(t => t.completed).length;
  detail.innerHTML = `
    <div class="cal-detail-header">
      <span class="cal-detail-date">${dateLabel}</span>
      <span class="cal-detail-summary">${doneCnt}/${tasks.length} done</span>
    </div>
    <ul class="cal-detail-list">
      ${tasks.map(t => `
        <li class="cal-detail-item${t.completed ? ' done' : ''}${!t.completed && isOverdue(t.due) ? ' overdue' : ''}">
          <span class="cal-detail-dot ${esc(t.priority)}"></span>
          <span class="cal-detail-title">${esc(t.title)}</span>
          <span class="p-badge ${esc(t.priority)}" style="font-size:0.6rem;padding:0.1rem 0.35rem">${esc(t.priority)}</span>
          ${t.completed ? '<span class="cal-detail-check">✓</span>' : ''}
        </li>
      `).join('')}
    </ul>`;
}

/* ============================================================
   VIEW TOGGLE
   ============================================================ */
document.getElementById('view-tasks').addEventListener('click', () => {
  document.getElementById('view-tasks').classList.add('active');
  document.getElementById('view-tasks').setAttribute('aria-pressed', 'true');
  document.getElementById('view-calendar').classList.remove('active');
  document.getElementById('view-calendar').setAttribute('aria-pressed', 'false');
  document.querySelector('.filter-bar').classList.remove('hidden');
  document.querySelector('.task-list-wrapper').classList.remove('hidden');
  document.getElementById('calendar-view').classList.add('hidden');
});

document.getElementById('view-calendar').addEventListener('click', () => {
  document.getElementById('view-calendar').classList.add('active');
  document.getElementById('view-calendar').setAttribute('aria-pressed', 'true');
  document.getElementById('view-tasks').classList.remove('active');
  document.getElementById('view-tasks').setAttribute('aria-pressed', 'false');
  document.querySelector('.filter-bar').classList.add('hidden');
  document.querySelector('.task-list-wrapper').classList.add('hidden');
  document.getElementById('calendar-view').classList.remove('hidden');
  renderCalendar();
});

document.getElementById('cal-prev').addEventListener('click', () => {
  calState.month--;
  if (calState.month < 0) { calState.month = 11; calState.year--; }
  calState.selectedDay = null;
  renderCalendar();
});

document.getElementById('cal-next').addEventListener('click', () => {
  calState.month++;
  if (calState.month > 11) { calState.month = 0; calState.year++; }
  calState.selectedDay = null;
  renderCalendar();
});

/* ============================================================
   RESIZE — update confetti canvas size
   ============================================================ */
window.addEventListener('resize', () => {
  const canvas = document.getElementById('confetti-canvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
});

/* ============================================================
   INIT
   ============================================================ */
let _deadlineCheckerStarted = false;
function startDeadlineChecker() {
  if (_deadlineCheckerStarted) return;
  _deadlineCheckerStarted = true;
  setInterval(checkDeadlines, 60_000);
  checkDeadlines();
}

async function init() {
  initTheme();
  
  if (!supabase) {
    console.error("Supabase not available");
    showAuth();
    return;
  }
  
  try {
    const { data: { session } } = await supabase.auth.getSession();
  
  if (session && session.user) {
    state.currentUser = session.user.id;
    await loadData();
    refreshRecurring();
    updateUserBadge(session.user.email);
    showApp();
    render();
    startDeadlineChecker();
    showToast('Press N to add a task · Ctrl+F to search', 'info', '⌨️', 4500);
  } else {
    showAuth();
    requestAnimationFrame(() => document.getElementById('login-username')?.focus());
  }
  } catch(e) {
    console.error("Session error:", e);
    showAuth();
  }
}

init();
