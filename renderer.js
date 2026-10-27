'use strict';

/* ============================================================
   Kanban Repo Cards — renderer
   Data model (v3) adds repo notes, task lists, pinning and due dates.
   v2 and prototype states are migrated on load.

   Board layout: an account sidebar on the left, four repo columns
   on the right. Each repo is a compact row; its checklist and full
   note open in place underneath.
   ============================================================ */

const CARD_DEFS = [
  { id: 'michaeldaniel', label: 'michaeldaniel', accent: 'indigo' },
  { id: 'mikeperac', label: 'mikeperac', accent: 'violet' },
  { id: 'michaeld', label: 'michaeld', accent: 'sky' },
  { id: 'mikelb', label: 'mikelb', accent: 'teal' },
];

const ACCENT_HEX = {
  indigo: '#6366f1',
  violet: '#7c3aed',
  sky: '#0284c7',
  teal: '#0f766e',
};

const STORAGE_KEY = 'kanban-repo-cards.state.v3';
const LEGACY_STATE_KEY = 'kanban-repo-cards.state.v2';
const OLDER_STATE_KEY = 'kanban-repo-cards.state.v1';
const THEME_KEY = 'kanban-repo-cards.theme';

const PALETTE = [
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Amber', hex: '#eab308' },
  { name: 'Green', hex: '#22c55e' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Sky', hex: '#0ea5e9' },
  { name: 'Slate', hex: '#64748b' },
];

const MAX_TAGS = 6;
const MAX_TAG_LENGTH = 20;
const MAX_NOTE_LENGTH = 5000;
const MAX_TODO_LENGTH = 180;

const bridge = window.api ?? {
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener');
    return { ok: true };
  },
  appInfo: async () => ({ version: '1.4.0', store: false }),
  fetchGithubRepos: async () => [],
};

let state;
let view = { searchQuery: '', sortBy: 'pinnedFirst', showArchived: false, pinnedOnly: false };
let activeTag = null;
let editing = null; // { cardId, repoId }
let pendingRepoColor = null;
let cardColorCardId = null;
let openCardId = null; // single-account view; null shows every column
let migratedFromLegacy = false;
let saveTimer = null;
let dirty = false;
let toastTimer = null;
let dragData = null;

function nowIso() {
  return new Date().toISOString();
}

function newTodoId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/* ---------- Persistence ---------- */

function emptyState() {
  const cards = {};
  for (const def of CARD_DEFS) {
    cards[def.id] = { note: '', color: null, repos: [] };
  }
  return { version: 3, view: { ...view }, cards };
}

function newRepoId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `repo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function sanitizeHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

function parseTags(raw) {
  const seen = new Set();
  const tags = [];
  for (const part of String(raw ?? '').split(',')) {
    let tag = part
      .trim()
      .replace(/^#+/, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!tag) continue;
    tag = tag.slice(0, MAX_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function sanitizeRepo(incoming) {
  const raw = typeof incoming === 'string' ? { url: incoming } : incoming;
  if (!raw || typeof raw !== 'object') return null;

  const url = normalizeUrl(typeof raw.url === 'string' ? raw.url : '');
  if (!url) return null;

  return {
    id:
      typeof raw.id === 'string' && /^[a-z0-9_-]{4,80}$/i.test(raw.id)
        ? raw.id
        : newRepoId(),
    url,
    label:
      typeof raw.label === 'string'
        ? raw.label.trim().replace(/\s+/g, ' ').slice(0, 60)
        : '',
    tags: Array.isArray(raw.tags)
      ? parseTags(raw.tags.filter((tag) => typeof tag === 'string').join(','))
      : [],
    color: sanitizeHex(raw.color),
    pinned: Boolean(raw.pinned),
    archived: Boolean(raw.archived),
    priority: raw.priority === 'low' || raw.priority === 'high' ? raw.priority : 'medium',
    dueDate: typeof raw.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dueDate) ? raw.dueDate : '',
    note: typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE_LENGTH) : '',
    todos: Array.isArray(raw.todos)
      ? raw.todos
          .filter((todo) => todo && typeof todo.text === 'string')
          .slice(0, 100)
          .map((todo) => ({
            id: typeof todo.id === 'string' ? todo.id : newTodoId(),
            text: todo.text.trim().slice(0, MAX_TODO_LENGTH),
            done: Boolean(todo.done),
            createdAt: typeof todo.createdAt === 'string' ? todo.createdAt : nowIso(),
          }))
      : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
}

function sanitizeState(raw) {
  const next = emptyState();
  if (!raw || typeof raw !== 'object' || !raw.cards || typeof raw.cards !== 'object') {
    return next;
  }

  if (raw.view && typeof raw.view === 'object') {
    next.view = {
      ...next.view,
      searchQuery: typeof raw.view.searchQuery === 'string' ? raw.view.searchQuery.slice(0, 120) : '',
      sortBy: ['pinnedFirst', 'recentlyUpdated', 'oldest', 'name'].includes(raw.view.sortBy)
        ? raw.view.sortBy
        : 'pinnedFirst',
      showArchived: Boolean(raw.view.showArchived),
      pinnedOnly: Boolean(raw.view.pinnedOnly),
    };
  }

  for (const def of CARD_DEFS) {
    const incoming = raw.cards[def.id];
    if (!incoming || typeof incoming !== 'object') continue;

    if (typeof incoming.note === 'string') next.cards[def.id].note = incoming.note.slice(0, MAX_NOTE_LENGTH);
    next.cards[def.id].color = sanitizeHex(incoming.color);

    // v2 uses `repos`; v1 used `urls: string[]`.
    const source = Array.isArray(incoming.repos)
      ? incoming.repos
      : Array.isArray(incoming.urls)
        ? incoming.urls
        : [];

    const seenUrls = new Set();
    const seenIds = new Set();
    for (const item of source) {
      const repo = sanitizeRepo(item);
      if (!repo) continue;
      const urlKey = repo.url.toLowerCase().replace(/\/+$/, '');
      if (seenUrls.has(urlKey)) continue;
      seenUrls.add(urlKey);
      if (seenIds.has(repo.id)) repo.id = newRepoId();
      seenIds.add(repo.id);
      next.cards[def.id].repos.push(repo);
    }
  }

  return next;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeState(JSON.parse(raw));
  } catch {
    /* fall through to migration / empty state */
  }

  // Migrate v2 repository cards while keeping card notes, colors, labels and tags.
  try {
    const legacy = localStorage.getItem(LEGACY_STATE_KEY);
    if (legacy) {
      migratedFromLegacy = true;
      return sanitizeState(JSON.parse(legacy));
    }
  } catch {
    /* ignore malformed v2 state */
  }

  // v1 full-state key: urls: string[].
  try {
    const older = localStorage.getItem(OLDER_STATE_KEY);
    if (older) {
      migratedFromLegacy = true;
      return sanitizeState(JSON.parse(older));
    }
  } catch {
    /* ignore malformed v1 state */
  }

  // Original prototype: urls_<id> / note_<id> keys.
  const migrated = emptyState();
  let found = false;
  for (const def of CARD_DEFS) {
    try {
      const urlsRaw = localStorage.getItem(`urls_${def.id}`);
      const noteRaw = localStorage.getItem(`note_${def.id}`);
      if (urlsRaw) {
        const urls = JSON.parse(urlsRaw);
        if (Array.isArray(urls)) {
          migrated.cards[def.id].repos = urls
            .map((url) => sanitizeRepo(url))
            .filter(Boolean);
          found = true;
        }
      }
      if (noteRaw) {
        migrated.cards[def.id].note = noteRaw.slice(0, MAX_NOTE_LENGTH);
        found = true;
      }
    } catch {
      /* ignore malformed legacy entry */
    }
  }
  migratedFromLegacy = found;
  return migrated;
}

/* ---------- DOM ---------- */

const board = document.getElementById('board');
const columnTemplate = document.getElementById('column-template');
const repoTemplate = document.getElementById('repo-template');
const accountList = document.getElementById('account-list');
const totalEl = document.getElementById('repo-total');
const statusEl = document.getElementById('save-status');
const versionEl = document.getElementById('version-label');
const toastEl = document.getElementById('toast');
const storeBadge = document.getElementById('store-badge');
const themeBtn = document.getElementById('theme-toggle');
const tagBar = document.getElementById('tag-bar');
const tagBarList = document.getElementById('tag-bar-list');
const tagClear = document.getElementById('tag-clear');
const tagSuggestions = document.getElementById('tag-suggestions');
const repoSearch = document.getElementById('repo-search');
const repoSort = document.getElementById('repo-sort');
const archiveToggle = document.getElementById('archive-toggle');
const pinnedToggle = document.getElementById('pinned-toggle');
const allAccountsBtn = document.getElementById('all-accounts');
const allAccountsCount = document.getElementById('all-accounts-count');

const repoDialog = document.getElementById('repo-dialog');
const repoForm = document.getElementById('repo-form');
const repoDialogSub = document.getElementById('repo-dialog-sub');
const repoUrlInput = document.getElementById('repo-url');
const repoLabelInput = document.getElementById('repo-label');
const repoTagsInput = document.getElementById('repo-tags');
const repoPriorityInput = document.getElementById('repo-priority');
const repoDueInput = document.getElementById('repo-due');
const repoSwatches = document.getElementById('repo-swatches');
const repoColorInput = document.getElementById('repo-color-input');
const repoColorHex = document.getElementById('repo-color-hex');
const repoDialogClose = document.getElementById('repo-dialog-close');
const repoCancel = document.getElementById('repo-cancel');

const cardColorPop = document.getElementById('card-color-pop');
const cardSwatches = document.getElementById('card-swatches');
const cardColorInput = document.getElementById('card-color-input');
const cardColorHex = document.getElementById('card-color-hex');
const cardColorClose = document.getElementById('card-color-close');

const refs = new Map();

/* ---------- Helpers ---------- */

const sameUrl = (a, b) =>
  a.trim().toLowerCase().replace(/\/+$/, '') === b.trim().toLowerCase().replace(/\/+$/, '');

function normalizeUrl(rawValue) {
  if (typeof rawValue !== 'string') return null;
  let value = rawValue.trim();
  if (!value || /\s/.test(value)) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (!hasScheme) {
    // Accept "github.com/owner/repo" and turn it into a URL.
    if (!/^[^\s/]+\.[^\s/]+/.test(value)) return null;
    value = `https://${value}`;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

function prettifyUrl(value) {
  try {
    const url = new URL(value);
    const host = url.host.replace(/^www\./, '');
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${host}${pathname}${url.search}`;
  } catch {
    return value;
  }
}

function repoDisplayName(repo) {
  return repo.label || prettifyUrl(repo.url);
}

function noteHeadline(note) {
  const value = String(note ?? '');
  const breakAt = value.indexOf('\n');
  return breakAt === -1 ? value : value.slice(0, breakAt);
}

// The one-line field edits the note's first line and keeps the rest intact.
function setNoteHeadline(repo, value) {
  const note = String(repo.note ?? '');
  const breakAt = note.indexOf('\n');
  const rest = breakAt === -1 ? '' : note.slice(breakAt);
  repo.note = `${value}${rest}`.slice(0, MAX_NOTE_LENGTH);
}

function hexToRgba(hex, alpha) {
  const value = sanitizeHex(hex);
  if (!value) return `rgba(99, 102, 241, ${alpha})`;
  const r = parseInt(value.slice(1, 3), 16);
  const g = parseInt(value.slice(3, 5), 16);
  const b = parseInt(value.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function tagsMatch(repo) {
  if (!activeTag) return true;
  return repo.tags.some((tag) => tag.toLowerCase() === activeTag.toLowerCase());
}

function repoMatchesFilters(repo) {
  if (!view.showArchived && repo.archived) return false;
  if (view.pinnedOnly && !repo.pinned) return false;
  if (!tagsMatch(repo)) return false;
  const query = view.searchQuery.trim().toLowerCase();
  if (!query) return true;
  const searchable = [
    repo.label,
    repo.url,
    repo.note,
    repo.priority,
    ...repo.tags,
    ...repo.todos.map((todo) => todo.text),
  ]
    .join(' ')
    .toLowerCase();
  return searchable.includes(query);
}

function makeRepoRecord(url, extra = {}) {
  const timestamp = nowIso();
  return {
    id: newRepoId(),
    url,
    label: '',
    tags: [],
    color: null,
    pinned: false,
    archived: false,
    priority: 'medium',
    dueDate: '',
    note: '',
    todos: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  };
}

function priorityLabel(priority) {
  return { low: 'Low', medium: 'Medium', high: 'High' }[priority] || 'Medium';
}

function formatDueDate(dateValue) {
  if (!dateValue) return '';
  const [year, month, day] = dateValue.split('-').map(Number);
  if (!year || !month || !day) return dateValue;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function localDateIso() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

function findRepo(cardId, repoId) {
  return state.cards[cardId]?.repos.find((repo) => repo.id === repoId) ?? null;
}

function setStatus(text, stateName = 'saved') {
  statusEl.textContent = text;
  statusEl.dataset.state = stateName;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2300);
}

async function openUrl(url) {
  try {
    const result = await bridge.openExternal(url);
    if (result && result.ok === false) showToast('Could not open that link');
  } catch {
    showToast('Could not open that link');
  }
}

/* ---------- Focus and scroll preservation ---------- */

function attrValue(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.dataset || !el.dataset.focusKey) return null;
  return {
    key: el.dataset.focusKey,
    start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
    end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
  };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const el = document.querySelector(`[data-focus-key="${attrValue(snapshot.key)}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (snapshot.start !== null && typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(snapshot.start, snapshot.end);
    } catch {
      /* not a text field */
    }
  }
}

/* ---------- Rendering ---------- */

function createTagChip(tag) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'tag-chip';
  chip.dataset.tag = tag;
  chip.textContent = `#${tag}`;
  chip.title = `Filter by #${tag}`;
  chip.addEventListener('click', (event) => {
    event.stopPropagation();
    setActiveTag(tag);
  });
  return chip;
}

function createRepoRow(cardId, repo) {
  const entry = refs.get(cardId);
  const row = repoTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.repoId = repo.id;
  row.setAttribute('role', 'listitem');

  if (repo.color) {
    row.classList.add('has-color');
    row.style.setProperty('--repo-color', repo.color);
  }

  const name = repoDisplayName(repo);
  const open = row.querySelector('.repo-title');
  open.textContent = name;
  open.title = repo.url;
  open.setAttribute('aria-label', `Open ${name}`);
  open.addEventListener('click', () => openUrl(repo.url));

  const grip = row.querySelector('.repo-grip');
  grip.setAttribute('aria-label', `Drag ${name} to another column`);
  grip.draggable = true;
  grip.addEventListener('dragstart', (event) => {
    dragData = { cardId, repoId: repo.id };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-kanban-repo', JSON.stringify(dragData));
    event.dataTransfer.setData('text/plain', repo.url);
    row.classList.add('dragging');
    document.body.classList.add('is-dragging');
  });
  grip.addEventListener('dragend', () => {
    dragData = null;
    row.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    clearAllDropStates();
  });

  const star = row.querySelector('.repo-star');
  star.classList.toggle('is-pinned', repo.pinned);
  star.title = repo.pinned ? 'Unpin repository' : 'Pin repository';
  star.setAttribute('aria-label', star.title);
  star.setAttribute('aria-pressed', String(repo.pinned));
  star.addEventListener('click', () => toggleRepoPin(cardId, repo.id));

  const expand = row.querySelector('.repo-expand');
  expand.setAttribute('aria-label', 'Show checklist and notes');

  const edit = row.querySelector('.repo-edit');
  edit.title = 'Edit label, tags, priority, due date and color';
  edit.setAttribute('aria-label', `Edit details for ${name}`);
  edit.addEventListener('click', () => openRepoDialog(cardId, repo.id));

  const archive = row.querySelector('.repo-archive');
  archive.classList.toggle('is-archived', repo.archived);
  archive.title = repo.archived ? 'Restore repository' : 'Archive repository';
  archive.setAttribute('aria-label', archive.title);
  archive.addEventListener('click', () => toggleRepoArchive(cardId, repo.id));

  const remove = row.querySelector('.repo-remove');
  remove.title = 'Remove this repo';
  remove.setAttribute('aria-label', `Remove ${name}`);
  remove.addEventListener('click', () => removeRepo(cardId, repo.id));

  // Meta line: URL, tags, badges.
  const urlText = row.querySelector('.repo-url');
  if (repo.label) {
    urlText.textContent = prettifyUrl(repo.url);
    urlText.title = repo.url;
  } else {
    // The title already shows the link, so repeating it would waste a line.
    urlText.remove();
  }

  const tagsWrap = row.querySelector('.repo-tags');
  for (const tag of repo.tags) tagsWrap.appendChild(createTagChip(tag));

  const badges = row.querySelector('.repo-badges');
  if (repo.priority !== 'medium') {
    const priority = document.createElement('span');
    priority.className = `repo-badge priority-${repo.priority}`;
    priority.textContent = priorityLabel(repo.priority);
    badges.appendChild(priority);
  }

  if (repo.todos.length) {
    const done = repo.todos.filter((todo) => todo.done).length;
    const tasks = document.createElement('span');
    tasks.className = 'repo-badge repo-tasks';
    tasks.textContent = `${done}/${repo.todos.length}`;
    tasks.title = `${done} of ${repo.todos.length} tasks done`;
    badges.appendChild(tasks);
  }

  if (repo.dueDate) {
    const overdue = repo.dueDate < localDateIso();
    const due = document.createElement('span');
    due.className = `repo-badge repo-due ${overdue ? 'is-overdue' : ''}`;
    due.textContent = `${overdue ? 'Overdue ' : 'Due '}${formatDueDate(repo.dueDate)}`;
    badges.appendChild(due);
  }

  if (repo.archived) {
    const archived = document.createElement('span');
    archived.className = 'repo-badge repo-archived-badge';
    archived.textContent = 'Archived';
    badges.appendChild(archived);
  }

  // One-line note field — always visible.
  const noteInput = row.querySelector('.repo-note-input');
  noteInput.value = noteHeadline(repo.note);
  noteInput.placeholder = 'Add a note…';
  noteInput.setAttribute('aria-label', `Note for ${name}`);
  noteInput.dataset.focusKey = `note:${repo.id}`;
  noteInput.addEventListener('input', () => {
    setNoteHeadline(repo, noteInput.value);
    repo.updatedAt = nowIso();
    scheduleSave();
  });
  noteInput.addEventListener('blur', persistNow);

  // Expanded detail: checklist + full note.
  const detail = row.querySelector('.repo-detail');
  const isOpen = Boolean(entry?.expanded.has(repo.id));
  detail.hidden = !isOpen;
  row.classList.toggle('is-open', isOpen);
  expand.setAttribute('aria-expanded', String(isOpen));
  expand.setAttribute('aria-label', isOpen ? 'Hide checklist and notes' : 'Show checklist and notes');

  if (isOpen) {
    const todoCount = row.querySelector('.todo-count');
    const todoList = row.querySelector('.todo-list');
    const todoEmpty = row.querySelector('.todo-empty');
    const todoForm = row.querySelector('.todo-form');
    const todoInput = row.querySelector('.todo-input');
    const fullNote = row.querySelector('.repo-note-full');

    const done = repo.todos.filter((todo) => todo.done).length;
    todoCount.textContent = `${done}/${repo.todos.length}`;
    todoEmpty.hidden = repo.todos.length > 0;

    for (const todo of repo.todos) {
      const item = document.createElement('li');
      item.className = `repo-todo ${todo.done ? 'is-done' : ''}`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = todo.done;
      checkbox.setAttribute('aria-label', `Mark ${todo.text} ${todo.done ? 'not done' : 'done'}`);
      checkbox.addEventListener('change', () => toggleTodo(cardId, repo.id, todo.id));
      const label = document.createElement('span');
      label.textContent = todo.text;
      const deleteTodo = document.createElement('button');
      deleteTodo.type = 'button';
      deleteTodo.className = 'todo-delete';
      deleteTodo.textContent = '×';
      deleteTodo.title = 'Delete task';
      deleteTodo.setAttribute('aria-label', `Delete task: ${todo.text}`);
      deleteTodo.addEventListener('click', () => removeTodo(cardId, repo.id, todo.id));
      item.append(checkbox, label, deleteTodo);
      todoList.appendChild(item);
    }

    todoInput.dataset.focusKey = `todo:${repo.id}`;
    todoInput.setAttribute('aria-label', `Add a checklist item for ${name}`);
    todoForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (addTodo(cardId, repo.id, todoInput.value)) {
        renderColumn(cardId);
        scheduleSave();
        window.setTimeout(() => {
          board.querySelector(`[data-repo-id="${attrValue(repo.id)}"] .todo-input`)?.focus();
        }, 0);
      }
    });

    fullNote.value = repo.note;
    fullNote.maxLength = MAX_NOTE_LENGTH;
    fullNote.dataset.focusKey = `notefull:${repo.id}`;
    fullNote.setAttribute('aria-label', `Full notes for ${name}`);
    fullNote.addEventListener('input', () => {
      repo.note = fullNote.value.slice(0, MAX_NOTE_LENGTH);
      repo.updatedAt = nowIso();
      noteInput.value = noteHeadline(repo.note);
      scheduleSave();
    });
    fullNote.addEventListener('blur', persistNow);
  }

  expand.addEventListener('click', () => toggleRepoExpanded(cardId, repo.id));
  row.addEventListener('click', (event) => {
    if (event.target.closest('button, input, textarea, .repo-note')) return;
    toggleRepoExpanded(cardId, repo.id);
  });

  return row;
}

function sortRepos(list) {
  if (view.sortBy === 'pinnedFirst') {
    list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  } else if (view.sortBy === 'recentlyUpdated') {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } else if (view.sortBy === 'oldest') {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } else {
    list.sort((a, b) => repoDisplayName(a).localeCompare(repoDisplayName(b)));
  }
}

function emptyText(cardId) {
  const repos = state.cards[cardId].repos;
  if (!repos.length) return 'No repos yet · paste a link above';
  if (!view.showArchived && repos.every((repo) => repo.archived)) return 'All repos are archived';
  if (view.pinnedOnly && !repos.some((repo) => repo.pinned)) return 'Nothing pinned here yet';
  return 'No repos match these filters';
}

function renderColumn(cardId) {
  const entry = refs.get(cardId);
  if (!entry) return;

  const repos = state.cards[cardId].repos;
  const visible = repos.filter(repoMatchesFilters);
  sortRepos(visible);

  const scrollTop = entry.list.scrollTop;
  entry.list.textContent = '';

  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText(cardId);
    entry.list.appendChild(empty);
  } else {
    for (const repo of visible) entry.list.appendChild(createRepoRow(cardId, repo));
  }
  entry.list.scrollTop = scrollTop;

  const activeCount = repos.filter((repo) => view.showArchived || !repo.archived).length;
  entry.badge.textContent = visible.length === activeCount ? String(activeCount) : `${visible.length}/${activeCount}`;
  entry.badge.classList.toggle('is-empty', activeCount === 0);
  entry.badge.title = `${visible.length} shown · ${repos.length} total repos on this column`;

  entry.node.hidden = Boolean(openCardId) && openCardId !== cardId;
  entry.node.classList.toggle('is-focused', openCardId === cardId);
}

function accountSubText(pinned, overdue) {
  const parts = [];
  if (pinned) parts.push(`${pinned} pinned`);
  if (overdue) parts.push(`${overdue} overdue`);
  return parts.length ? parts.join(' · ') : 'No pinned repos';
}

function renderSidebar() {
  accountList.textContent = '';

  let allLive = 0;
  for (const def of CARD_DEFS) {
    allLive += state.cards[def.id].repos.filter((repo) => !repo.archived).length;
  }
  allAccountsCount.textContent = String(allLive);
  allAccountsBtn.classList.toggle('is-focused', openCardId === null);
  allAccountsBtn.setAttribute('aria-pressed', String(openCardId === null));

  for (const def of CARD_DEFS) {
    const repos = state.cards[def.id].repos;
    const live = repos.filter((repo) => !repo.archived);
    const pinned = live.filter((repo) => repo.pinned).length;
    const overdue = live.filter((repo) => repo.dueDate && repo.dueDate < localDateIso()).length;

    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'account-tile';
    tile.dataset.cardId = def.id;
    tile.dataset.focusKey = `account:${def.id}`;
    tile.classList.toggle('is-focused', openCardId === def.id);
    tile.setAttribute('aria-pressed', String(openCardId === def.id));
    tile.style.setProperty('--tile-accent', ACCENT_HEX[def.accent]);
    tile.title = `Open ${def.label}`;

    const dot = document.createElement('span');
    dot.className = 'account-dot';
    const name = document.createElement('span');
    name.className = 'account-name';
    name.textContent = def.label;
    const count = document.createElement('span');
    count.className = 'account-count';
    count.textContent = String(live.length);
    const sub = document.createElement('span');
    sub.className = 'account-sub';
    sub.textContent = accountSubText(pinned, overdue);

    tile.append(dot, name, count, sub);
    tile.addEventListener('click', () => openAccount(def.id));
    accountList.appendChild(tile);
  }
}

function updateTotals() {
  let total = 0;
  let visible = 0;
  for (const def of CARD_DEFS) {
    const repos = state.cards[def.id].repos;
    total += repos.length;
    visible += repos.filter(repoMatchesFilters).length;
  }

  const filtering = Boolean(view.searchQuery.trim()) || Boolean(activeTag) || view.pinnedOnly;
  if (filtering) {
    totalEl.textContent = `${visible} of ${total} repos`;
    totalEl.title = 'Repositories matching the current filters';
  } else {
    totalEl.textContent = `${visible} repo${visible === 1 ? '' : 's'}`;
    totalEl.title = '';
  }
}

function collectTags() {
  const map = new Map();
  for (const def of CARD_DEFS) {
    for (const repo of state.cards[def.id].repos) {
      for (const tag of repo.tags) {
        const key = tag.toLowerCase();
        const existing = map.get(key);
        if (existing) existing.count += 1;
        else map.set(key, { tag, count: 1 });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

function renderTagBar() {
  const tags = collectTags();

  if (activeTag && !tags.some((entry) => entry.tag.toLowerCase() === activeTag.toLowerCase())) {
    activeTag = null;
  }

  tagBar.hidden = tags.length === 0 && !activeTag;
  tagBarList.textContent = '';

  for (const entry of tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-filter';
    chip.dataset.tag = entry.tag;
    chip.setAttribute(
      'aria-pressed',
      String(Boolean(activeTag) && activeTag.toLowerCase() === entry.tag.toLowerCase())
    );
    chip.title = `Show only repos tagged #${entry.tag}`;

    const name = document.createElement('span');
    name.textContent = `#${entry.tag}`;
    const count = document.createElement('span');
    count.className = 'tag-filter-count';
    count.textContent = String(entry.count);

    chip.append(name, count);
    chip.addEventListener('click', () => setActiveTag(entry.tag));
    tagBarList.appendChild(chip);
  }

  tagClear.hidden = !activeTag;
}

function renderTagSuggestions() {
  tagSuggestions.textContent = '';
  for (const entry of collectTags()) {
    const option = document.createElement('option');
    option.value = entry.tag;
    tagSuggestions.appendChild(option);
  }
}

function renderAll() {
  const focus = captureFocus();
  for (const def of CARD_DEFS) renderColumn(def.id);
  renderSidebar();
  updateTotals();
  renderTagBar();
  renderTagSuggestions();
  board.classList.toggle('is-single', Boolean(openCardId));
  archiveToggle.setAttribute('aria-pressed', String(view.showArchived));
  archiveToggle.textContent = view.showArchived ? 'Hide archived' : 'Show archived';
  pinnedToggle.setAttribute('aria-pressed', String(view.pinnedOnly));
  restoreFocus(focus);
}

function setActiveTag(tag) {
  const same = Boolean(activeTag) && activeTag.toLowerCase() === String(tag).toLowerCase();
  activeTag = same ? null : tag;
  renderAll();
  if (activeTag) showToast(`Filtering by #${activeTag}`);
  else if (same) showToast('Filter cleared');
}

function openAccount(cardId) {
  openCardId = openCardId === cardId ? null : cardId;
  renderAll();
}

function showAllAccounts() {
  openCardId = null;
  renderAll();
}
/* ---------- Mutations ---------- */

function handleAdd(event, def) {
  event.preventDefault();
  const entry = refs.get(def.id);
  const url = normalizeUrl(entry.input.value);

  if (!url) {
    entry.input.classList.add('invalid');
    entry.input.focus();
    showToast('Enter a valid http:// or https:// repo URL');
    window.setTimeout(() => entry.input.classList.remove('invalid'), 420);
    return;
  }

  const repos = state.cards[def.id].repos;
  if (repos.some((repo) => sameUrl(repo.url, url))) {
    showToast('That repo is already on this column');
    entry.input.select();
    return;
  }

  repos.push(makeRepoRecord(url));
  entry.input.value = '';
  entry.input.focus();
  renderAll();
  scheduleSave();

  if (activeTag) showToast(`Added to ${def.label} — clear the #${activeTag} filter to see it`);
  else showToast(`Added to ${def.label}`);
}

function removeRepo(cardId, repoId) {
  const def = CARD_DEFS.find((item) => item.id === cardId);
  const repos = state.cards[cardId].repos;
  const index = repos.findIndex((repo) => repo.id === repoId);
  if (!def || index === -1) return;

  repos.splice(index, 1);
  refs.get(cardId)?.expanded.delete(repoId);
  renderAll();
  scheduleSave();
  showToast(`Removed from ${def.label}`);
}

function toggleRepoPin(cardId, repoId) {
  const repo = findRepo(cardId, repoId);
  if (!repo) return;
  repo.pinned = !repo.pinned;
  repo.updatedAt = nowIso();
  renderAll();
  scheduleSave();
  showToast(repo.pinned ? 'Repository pinned' : 'Repository unpinned');
}

function toggleRepoArchive(cardId, repoId) {
  const repo = findRepo(cardId, repoId);
  if (!repo) return;
  repo.archived = !repo.archived;
  repo.updatedAt = nowIso();
  renderAll();
  scheduleSave();
  showToast(repo.archived ? 'Repository archived' : 'Repository restored');
}

function toggleRepoExpanded(cardId, repoId) {
  const entry = refs.get(cardId);
  if (!entry) return;
  if (entry.expanded.has(repoId)) entry.expanded.delete(repoId);
  else {
    entry.expanded.clear();
    entry.expanded.add(repoId);
  }
  renderColumn(cardId);
}

function addTodo(cardId, repoId, rawText) {
  const repo = findRepo(cardId, repoId);
  const text = String(rawText ?? '').trim().slice(0, MAX_TODO_LENGTH);
  if (!repo || !text) return false;
  if (repo.todos.length >= 100) {
    showToast('A repository can have up to 100 checklist items');
    return false;
  }
  repo.todos.push({ id: newTodoId(), text, done: false, createdAt: nowIso() });
  repo.updatedAt = nowIso();
  return true;
}

function toggleTodo(cardId, repoId, todoId) {
  const repo = findRepo(cardId, repoId);
  const todo = repo?.todos.find((entry) => entry.id === todoId);
  if (!repo || !todo) return;
  todo.done = !todo.done;
  repo.updatedAt = nowIso();
  renderColumn(cardId);
  scheduleSave();
}

function removeTodo(cardId, repoId, todoId) {
  const repo = findRepo(cardId, repoId);
  if (!repo) return;
  repo.todos = repo.todos.filter((todo) => todo.id !== todoId);
  repo.updatedAt = nowIso();
  renderColumn(cardId);
  scheduleSave();
}

async function importGithubRepos(cardId, button) {
  if (button.disabled) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading…';
  setStatus('Fetching public repositories…', 'saving');

  try {
    const remoteRepos = await bridge.fetchGithubRepos(cardId);
    if (!Array.isArray(remoteRepos)) throw new Error('GitHub returned an unexpected response');

    const repos = state.cards[cardId].repos;
    let added = 0;
    for (const remote of remoteRepos) {
      const url = normalizeUrl(typeof remote?.html_url === 'string' ? remote.html_url : '');
      if (!url || repos.some((repo) => sameUrl(repo.url, url))) continue;
      const created = typeof remote.created_at === 'string' ? remote.created_at : nowIso();
      const updated = typeof remote.pushed_at === 'string' ? remote.pushed_at : nowIso();
      repos.push(
        makeRepoRecord(url, {
          label: typeof remote.name === 'string' ? remote.name.slice(0, 60) : '',
          createdAt: created,
          updatedAt: updated,
        })
      );
      added += 1;
    }

    renderAll();
    scheduleSave();
    showToast(added ? `Imported ${added} new repos. Existing notes were kept.` : 'No new public repos found');
  } catch (error) {
    showToast(`GitHub import failed: ${error.message || 'check your connection and try again'}`);
    setStatus('Import failed', 'error');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/* ---------- Drag & drop ---------- */

function clearDropState(node) {
  node.classList.remove('drop-target');
  delete node.dataset.dropLabel;
}

function clearAllDropStates() {
  board.querySelectorAll('.column.drop-target').forEach((node) => clearDropState(node));
}

function handleDragOver(event, def, node) {
  if (dragData) {
    if (dragData.cardId === def.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    node.dataset.dropLabel = 'Drop to move here';
  } else {
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (!types.includes('text/uri-list') && !types.includes('text/plain')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    node.dataset.dropLabel = 'Drop to add link';
  }
  node.classList.add('drop-target');
}

function handleDrop(event, def, node) {
  event.preventDefault();
  clearDropState(node);
  const targetRepos = state.cards[def.id].repos;
  const payload = dragData;
  dragData = null;

  if (payload) {
    if (payload.cardId === def.id) return;
    const sourceRepos = state.cards[payload.cardId].repos;
    const index = sourceRepos.findIndex((repo) => repo.id === payload.repoId);
    if (index === -1) return;
    const repo = sourceRepos[index];
    if (targetRepos.some((existing) => sameUrl(existing.url, repo.url))) {
      showToast('That repo is already on this column');
      return;
    }

    sourceRepos.splice(index, 1);
    targetRepos.push(repo);
    refs.get(payload.cardId)?.expanded.delete(payload.repoId);
    renderAll();
    scheduleSave();

    if (activeTag && !tagsMatch(repo)) {
      showToast(`Moved to ${def.label} — it does not match #${activeTag}`);
    } else {
      showToast(`Moved to ${def.label}`);
    }
    return;
  }

  const raw =
    event.dataTransfer.getData('text/uri-list') ||
    event.dataTransfer.getData('text/plain') ||
    '';
  const candidate = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  const url = normalizeUrl(candidate || '');
  if (!url) {
    showToast('Drop an http(s) link to add it');
    return;
  }
  if (targetRepos.some((existing) => sameUrl(existing.url, url))) {
    showToast('That repo is already on this column');
    return;
  }

  targetRepos.push(makeRepoRecord(url));
  renderAll();
  scheduleSave();
  showToast(`Added to ${def.label}`);
}

/* ---------- Repo details dialog ---------- */

function buildSwatches(container, selectedHex, onPick) {
  container.textContent = '';
  const options = [{ name: 'Auto', hex: null }, ...PALETTE];

  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.color = option.hex ?? '';
    button.title = option.name;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', option.name);
    button.setAttribute('aria-checked', String((selectedHex || null) === option.hex));

    if (option.hex) {
      button.style.setProperty('--swatch', option.hex);
    } else {
      button.classList.add('is-auto');
    }

    button.addEventListener('click', () => onPick(option.hex));
    container.appendChild(button);
  }
}

function refreshRepoColorUi() {
  buildSwatches(repoSwatches, pendingRepoColor, (hex) => {
    pendingRepoColor = hex;
    refreshRepoColorUi();
  });
  repoColorInput.value = pendingRepoColor || PALETTE[0].hex;
  repoColorHex.textContent = pendingRepoColor ? pendingRepoColor.toUpperCase() : 'Auto';
}

function openRepoDialog(cardId, repoId) {
  const repo = findRepo(cardId, repoId);
  if (!repo) return;

  editing = { cardId, repoId };
  pendingRepoColor = repo.color;

  const def = CARD_DEFS.find((item) => item.id === cardId);
  repoDialogSub.textContent = `${def.label} · ${prettifyUrl(repo.url)}`;
  repoUrlInput.value = repo.url;
  repoUrlInput.classList.remove('invalid');
  repoLabelInput.value = repo.label;
  repoTagsInput.value = repo.tags.join(', ');
  repoPriorityInput.value = repo.priority;
  repoDueInput.value = repo.dueDate || '';

  refreshRepoColorUi();
  repoDialog.showModal();
  window.setTimeout(() => repoLabelInput.focus(), 30);
}

function saveRepoDetails(event) {
  event.preventDefault();
  if (!editing) return;

  const { cardId, repoId } = editing;
  const repo = findRepo(cardId, repoId);
  if (!repo) {
    repoDialog.close();
    return;
  }

  const url = normalizeUrl(repoUrlInput.value);
  if (!url) {
    repoUrlInput.classList.add('invalid');
    repoUrlInput.focus();
    showToast('Enter a valid http:// or https:// repo URL');
    return;
  }

  const repos = state.cards[cardId].repos;
  if (repos.some((other) => other.id !== repo.id && sameUrl(other.url, url))) {
    showToast('That repo is already on this column');
    repoUrlInput.select();
    return;
  }

  repo.url = url;
  repo.label = repoLabelInput.value.trim().replace(/\s+/g, ' ').slice(0, 60);
  repo.tags = parseTags(repoTagsInput.value);
  repo.color = pendingRepoColor;
  repo.priority = ['low', 'medium', 'high'].includes(repoPriorityInput.value)
    ? repoPriorityInput.value
    : 'medium';
  repo.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(repoDueInput.value) ? repoDueInput.value : '';
  repo.updatedAt = nowIso();

  repoDialog.close();
  renderAll();
  scheduleSave();
  showToast('Repo details saved');
}

function wireRepoDialog() {
  repoForm.addEventListener('submit', saveRepoDetails);
  repoDialogClose.addEventListener('click', () => repoDialog.close());
  repoCancel.addEventListener('click', () => repoDialog.close());
  repoDialog.addEventListener('close', () => {
    editing = null;
  });

  repoUrlInput.addEventListener('input', () => repoUrlInput.classList.remove('invalid'));

  repoColorInput.addEventListener('input', () => {
    const hex = sanitizeHex(repoColorInput.value);
    if (!hex) return;
    pendingRepoColor = hex;
    refreshRepoColorUi();
  });
}

/* ---------- Column color popover ---------- */

function closeCardColorPop() {
  cardColorPop.hidden = true;
  cardColorCardId = null;
}

function applyCardColor(cardId, hex) {
  state.cards[cardId].color = hex;
  const node = refs.get(cardId)?.node;
  if (node) {
    if (hex) {
      node.style.setProperty('--column-accent', hex);
      node.style.setProperty('--column-accent-soft', hexToRgba(hex, 0.16));
    } else {
      node.style.removeProperty('--column-accent');
      node.style.removeProperty('--column-accent-soft');
    }
  }
  scheduleSave();
}

function refreshCardColorUi(cardId) {
  const current = state.cards[cardId].color;

  buildSwatches(cardSwatches, current, (hex) => {
    applyCardColor(cardId, hex);
    refreshCardColorUi(cardId);
    closeCardColorPop();
  });

  cardColorInput.value = current || PALETTE[0].hex;
  cardColorHex.textContent = current ? current.toUpperCase() : 'Auto';
}

function positionCardColorPop(anchor) {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = cardColorPop.offsetWidth || 232;

  let left = rect.right - width;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

  let top = rect.bottom + 8;
  const height = cardColorPop.offsetHeight;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - height - 8);
  }

  cardColorPop.style.left = `${Math.round(left)}px`;
  cardColorPop.style.top = `${Math.round(top)}px`;
}

function openCardColorPop(cardId, anchor) {
  if (cardColorCardId === cardId && !cardColorPop.hidden) {
    closeCardColorPop();
    return;
  }

  cardColorCardId = cardId;
  cardColorPop.hidden = false;
  refreshCardColorUi(cardId);
  positionCardColorPop(anchor);
  anchor.focus();
}

function wireCardColorPop() {
  cardColorClose.addEventListener('click', closeCardColorPop);

  cardColorInput.addEventListener('input', () => {
    if (!cardColorCardId) return;
    const hex = sanitizeHex(cardColorInput.value);
    if (!hex) return;
    applyCardColor(cardColorCardId, hex);
    refreshCardColorUi(cardColorCardId);
  });

  cardColorInput.addEventListener('change', () => {
    if (!cardColorCardId) return;
    closeCardColorPop();
    showToast('Column color saved');
  });

  document.addEventListener('pointerdown', (event) => {
    if (cardColorPop.hidden) return;
    if (cardColorPop.contains(event.target) || event.target.closest?.('.column-color')) return;
    closeCardColorPop();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !cardColorPop.hidden) {
      event.preventDefault();
      closeCardColorPop();
    }
  });

  window.addEventListener('resize', closeCardColorPop);
}

/* ---------- Saving ---------- */

function persistNow() {
  window.clearTimeout(saveTimer);
  saveTimer = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    dirty = false;
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setStatus(`Saved · ${stamp}`, 'saved');
  } catch {
    setStatus('Not saved', 'error');
    showToast('Could not save — local storage is full');
  }
}

function scheduleSave() {
  dirty = true;
  setStatus('Saving…', 'saving');
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persistNow, 400);
}

/* ---------- Theme ---------- */

function effectiveTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'light' || explicit === 'dark') return explicit;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function syncThemeButton() {
  const label = effectiveTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  themeBtn.setAttribute('aria-label', label);
  themeBtn.title = label;
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.dataset.theme = saved;
  }
  syncThemeButton();

  themeBtn.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    syncThemeButton();
  });

  window
    .matchMedia('(prefers-color-scheme: light)')
    .addEventListener('change', syncThemeButton);
}

/* ---------- App info ---------- */

async function initAppInfo() {
  try {
    const info = await bridge.appInfo();
    if (info && info.version) versionEl.textContent = `v${info.version}`;
    if (info && info.store) storeBadge.hidden = false;
  } catch {
    /* keep defaults */
  }
}

/* ---------- Boot ---------- */

function buildColumns() {
  for (const def of CARD_DEFS) {
    const node = columnTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.cardId = def.id;
    node.classList.add(`accent-${def.accent}`);

    const title = node.querySelector('.column-title');
    title.id = `column-title-${def.id}`;
    title.textContent = def.label;
    node.setAttribute('aria-labelledby', title.id);

    const colorBtn = node.querySelector('.column-color');
    colorBtn.setAttribute('aria-label', `Change color of ${def.label}`);
    colorBtn.addEventListener('click', () => openCardColorPop(def.id, colorBtn));

    const importBtn = node.querySelector('.column-import');
    importBtn.setAttribute('aria-label', `Import public repositories for ${def.label} from GitHub`);
    importBtn.addEventListener('click', () => importGithubRepos(def.id, importBtn));

    const list = node.querySelector('.repo-list');
    list.setAttribute('aria-label', `Repository links for ${def.label}`);

    const form = node.querySelector('.add-form');
    const input = node.querySelector('.add-input');
    input.setAttribute('aria-label', `Add a repository URL to ${def.label}`);
    input.dataset.focusKey = `add:${def.id}`;
    input.addEventListener('input', () => input.classList.remove('invalid'));

    const note = node.querySelector('.note');
    note.setAttribute('aria-label', `Note for ${def.label}`);
    note.textContent = state.cards[def.id].note;

    form.addEventListener('submit', (event) => handleAdd(event, def));

    note.addEventListener('input', () => {
      state.cards[def.id].note = note.textContent.slice(0, MAX_NOTE_LENGTH);
      scheduleSave();
    });
    note.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        note.blur();
      }
    });
    note.addEventListener('blur', () => {
      state.cards[def.id].note = note.textContent.slice(0, MAX_NOTE_LENGTH);
      persistNow();
    });

    node.addEventListener('dragover', (event) => handleDragOver(event, def, node));
    node.addEventListener('dragleave', (event) => {
      if (!node.contains(event.relatedTarget)) clearDropState(node);
    });
    node.addEventListener('drop', (event) => handleDrop(event, def, node));

    board.appendChild(node);
    refs.set(def.id, {
      node,
      list,
      form,
      input,
      note,
      badge: node.querySelector('.count-badge'),
      expanded: new Set(),
    });

    if (state.cards[def.id].color) {
      node.style.setProperty('--column-accent', state.cards[def.id].color);
      node.style.setProperty('--column-accent-soft', hexToRgba(state.cards[def.id].color, 0.16));
    }
  }
}

function init() {
  state = loadState();
  view = state.view;
  repoSearch.value = view.searchQuery;
  repoSort.value = view.sortBy;
  initTheme();
  buildColumns();
  renderAll();
  wireRepoDialog();
  wireCardColorPop();

  if (migratedFromLegacy) persistNow();

  initAppInfo();

  tagClear.addEventListener('click', () => {
    activeTag = null;
    renderAll();
    showToast('Filter cleared');
  });

  repoSearch.addEventListener('input', () => {
    view.searchQuery = repoSearch.value;
    renderAll();
    scheduleSave();
  });

  repoSort.addEventListener('change', () => {
    view.sortBy = repoSort.value;
    renderAll();
    scheduleSave();
  });

  archiveToggle.addEventListener('click', () => {
    view.showArchived = !view.showArchived;
    renderAll();
    scheduleSave();
  });

  pinnedToggle.addEventListener('click', () => {
    view.pinnedOnly = !view.pinnedOnly;
    renderAll();
    scheduleSave();
    showToast(view.pinnedOnly ? 'Showing pinned repos only' : 'Showing all repos');
  });

  allAccountsBtn.addEventListener('click', () => {
    if (openCardId === null) return;
    showAllAccounts();
    showToast('Showing every account');
  });

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      repoSearch.focus();
      repoSearch.select();
      return;
    }

    if (event.key === 'Escape' && document.activeElement === repoSearch && repoSearch.value) {
      repoSearch.value = '';
      view.searchQuery = '';
      renderAll();
      scheduleSave();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      refs.get(CARD_DEFS[0].id)?.input.focus();
    }
  });

  // Never let the window navigate to a dropped file/link.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  window.addEventListener('beforeunload', () => {
    // Only flush pending edits; otherwise leave storage alone so an
    // externally seeded state (tests, imports) is not overwritten on reload.
    if (!dirty && !saveTimer) return;
    window.clearTimeout(saveTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* best effort */
    }
  });
}

init();
