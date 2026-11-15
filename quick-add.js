'use strict';

(() => {
  const input = document.getElementById('qa-input');
  const addBtn = document.getElementById('qa-add');
  const status = document.getElementById('qa-status');
  const columnSelect = document.getElementById('qa-column');
  const LS_KEY = 'kanban-quick-add.column';

  const isHttpUrl = (value) => /^https?:\/\/\S+$/i.test(value);

  async function loadColumns() {
    if (columnSelect.options.length > 0) return;
    try {
      const columns = await window.kanbanQuickAdd.getColumns();
      if (!Array.isArray(columns) || columns.length === 0) throw new Error('no columns yet');
      const saved = localStorage.getItem(LS_KEY) || columns[0].id;
      columnSelect.textContent = '';
      for (const col of columns) {
        const option = document.createElement('option');
        option.value = col.id;
        option.textContent = col.label;
        columnSelect.appendChild(option);
      }
      columnSelect.value = columns.some((col) => col.id === saved) ? saved : columns[0].id;
    } catch {
      // Main board window is not ready yet — retry for up to ~4 seconds.
      window.setTimeout(loadColumns, 500);
    }
  }

  function parseUrls(raw) {
    const seen = new Set();
    const urls = [];
    for (const chunk of String(raw ?? '').split(/[\s\r\n]+/)) {
      const clean = chunk.trim().replace(/[),;."']+$/g, '');
      if (isHttpUrl(clean) && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        urls.push(clean);
      }
    }
    return urls;
  }

  async function add() {
    const urls = parseUrls(input.value);
    if (urls.length === 0) {
      status.textContent = 'Paste an http(s) repo URL first.';
      status.classList.add('qa-error');
      input.focus();
      return;
    }
    const columnId = columnSelect.value;
    localStorage.setItem(LS_KEY, columnId);
    addBtn.disabled = true;
    status.classList.remove('qa-error');
    status.textContent = 'Adding\u2026';
    try {
      const result = await window.kanbanQuickAdd.sendUrls(urls, columnId);
      if (result && result.ok) {
        const parts = [];
        if (result.added) parts.push(`\u2713 ${result.added} added to ${result.columnLabel}`);
        if (result.duplicates) parts.push(`${result.duplicates} already on the board`);
        status.textContent = parts.join(' \u00b7 ') || 'Nothing to add';
        input.value = '';
      } else {
        status.textContent = (result && result.error) || 'Could not reach the board.';
        status.classList.add('qa-error');
      }
    } catch (error) {
      status.textContent = (error && error.message) || 'Could not reach the board.';
      status.classList.add('qa-error');
    } finally {
      addBtn.disabled = false;
      input.focus();
    }
  }

  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      add();
    }
  });
  columnSelect.addEventListener('change', () => localStorage.setItem(LS_KEY, columnSelect.value));
  document.getElementById('qa-close').addEventListener('click', () => window.kanbanQuickAdd.close());

  loadColumns();
  window.setTimeout(() => input.focus(), 60);
})();
