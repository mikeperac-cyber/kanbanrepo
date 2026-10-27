'use strict';

/**
 * End-to-end smoke test.
 *
 * Launches the real Electron app with an isolated profile, drives it over the
 * Chrome DevTools Protocol, verifies the board's behaviour and persistence,
 * captures screenshots, and fails on any renderer console error.
 *
 *   npm run smoke
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 9333);
const OUT_DIR = path.join(ROOT, 'dist');
const SHOT = path.join(OUT_DIR, 'smoke.png');
const SHOT_LIGHT = path.join(OUT_DIR, 'smoke-light.png');
const STORAGE_KEY = 'kanban-repo-cards.state.v3';
const LEGACY_STATE_KEY = 'kanban-repo-cards.state.v2';
const THEME_KEY = 'kanban-repo-cards.theme';
const CARD_NAMES = ['michaeldaniel', 'mikeperac', 'michaeld', 'mikelb'];

const electronBinary = require('electron');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Electron spawns renderer and GPU children; on Windows a plain kill() leaves
// them alive holding the debugging port, so the next run would drive a stale
// window instead of the fresh one.
function killAppTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail !== undefined && !ok ? `  -> ${detail}` : ''}`);
}

async function waitFor(fn, { timeout = 15000, interval = 150 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  throw lastError || new Error('waitFor timed out');
}

async function getPageTarget() {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`DevTools target not found: ${lastError ? lastError.message : 'timeout'}`);
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-smoke-'));
  const electronLog = [];

  const child = spawn(electronBinary, [ROOT, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      KANBAN_USERDATA: userDataDir,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (chunk) => electronLog.push(chunk.toString()));
  child.stderr.on('data', (chunk) => electronLog.push(chunk.toString()));

  let ws;
  try {
    const target = await getPageTarget();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('Could not connect to DevTools'));
    });

    let nextId = 1;
    const pending = new Map();
    const consoleErrors = [];

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        consoleErrors.push(details.exception?.description || details.text || 'Uncaught exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(
          message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')
        );
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        consoleErrors.push(message.params.entry.text);
      }
    };

    const send = (method, params = {}) => {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description || result.exceptionDetails.text
        );
      }
      return result.result.value;
    };

    const waitForBoard = async () => {
      await waitFor(async () => {
        const state = await evaluate(
          `({
            ready: document.readyState,
            columns: document.querySelectorAll('.column').length,
            tiles: document.querySelectorAll('.account-tile').length
          })`
        );
        return state.ready === 'complete' && state.columns === 4 && state.tiles === 5;
      });
      await delay(250);
    };

    const reload = async () => {
      await send('Page.reload', { ignoreCache: true });
      await waitForBoard();
    };

    const readState = () =>
      evaluate(`JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null')`);

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitForBoard();

    // ---- 1. Shell and layout ------------------------------------------
    const shell = await evaluate(`(() => {
      const columns = [...document.querySelectorAll('.column')];
      const tiles = [...document.querySelectorAll('.account-tile')];
      return {
        columnTitles: columns.map((column) => column.querySelector('.column-title').textContent),
        columnIds: columns.map((column) => column.dataset.cardId),
        accents: columns.map((column) =>
          [...column.classList].find((name) => name.startsWith('accent-')) || ''
        ),
        columns: columns.length,
        gridColumns: getComputedStyle(document.getElementById('board')).gridTemplateColumns
          .split(' ')
          .filter(Boolean).length,
        tileNames: tiles.map((tile) => tile.querySelector('.account-name').textContent),
        tiles: tiles.length,
        tileCounts: tiles.map((tile) => tile.querySelector('.account-count').textContent),
        tileSubs: tiles.map((tile) => tile.querySelector('.account-sub').textContent),
        sidebarTitle: document.querySelector('.sidebar-title')?.textContent ?? '',
        addInputs: columns.filter((column) => column.querySelector('.add-input')).length,
        accountNotes: columns.filter(
          (column) => column.querySelector('.note')?.getAttribute('contenteditable') === 'plaintext-only'
        ).length,
        repoLists: columns.filter((column) => column.querySelector('.repo-list')).length,
        emptyLabels: columns.map((column) => column.querySelector('.empty')?.textContent.trim() ?? ''),
        hint: document.querySelector('.footer-hint')?.textContent ?? '',
        tagBarHidden: document.getElementById('tag-bar').hidden,
        dialogOpen: document.getElementById('repo-dialog').open,
        colorPopHidden: document.getElementById('card-color-pop').hidden,
        colorButtons: document.querySelectorAll('.column-color').length,
        pinnedPressed: document.getElementById('pinned-toggle').getAttribute('aria-pressed'),
        pinnedLabel: document.getElementById('pinned-toggle').textContent.trim(),
        total: document.getElementById('repo-total').textContent,
      };
    })()`);

    check('four columns are rendered', shell.columns === 4, shell.columns);
    check(
      'columns are named after the four accounts',
      JSON.stringify(shell.columnTitles) === JSON.stringify(CARD_NAMES),
      JSON.stringify(shell.columnTitles)
    );
    check(
      'each column has its own accent',
      new Set(shell.accents).size === 4 && shell.accents.every(Boolean),
      JSON.stringify(shell.accents)
    );
    check('board lays out four grid columns', shell.gridColumns === 4, shell.gridColumns);
    check(
      'sidebar lists the four accounts plus an all-accounts tile',
      shell.tiles === 5 &&
        JSON.stringify(shell.tileNames) === JSON.stringify(['All accounts', ...CARD_NAMES]),
      JSON.stringify(shell.tileNames)
    );
    check('sidebar is labelled as an account panel', /account/i.test(shell.sidebarTitle), shell.sidebarTitle);
    check(
      'sidebar shows a live repo count per account',
      shell.tileCounts.every((count) => count === '0'),
      JSON.stringify(shell.tileCounts)
    );
    check(
      'sidebar explains the pin state per account',
      shell.tileSubs.slice(1).every((sub) => sub === 'No pinned repos'),
      JSON.stringify(shell.tileSubs)
    );
    check(
      'the all-accounts tile explains it shows the full board',
      shell.tileSubs[0] === 'Full board',
      shell.tileSubs[0]
    );
    check('each column has an add-repo input', shell.addInputs === 4, shell.addInputs);
    check('each column has an account note field', shell.accountNotes === 4, shell.accountNotes);
    check('each column has a repo list', shell.repoLists === 4, shell.repoLists);
    check(
      'empty columns show the empty state',
      shell.emptyLabels.every((label) => /no repos yet/i.test(label)),
      JSON.stringify(shell.emptyLabels)
    );
    check('footer teaches drag & drop', /drag/i.test(shell.hint), shell.hint);
    check('tag filter bar is hidden until tags exist', shell.tagBarHidden === true);
    check('repo details dialog starts closed', shell.dialogOpen === false);
    check('column color popover starts closed', shell.colorPopHidden === true);
    check('every column exposes a color control', shell.colorButtons === 4, shell.colorButtons);
    check(
      'pinned-only filter starts switched off',
      shell.pinnedPressed === 'false' && /pinned only/i.test(shell.pinnedLabel),
      `${shell.pinnedPressed} / ${shell.pinnedLabel}`
    );
    check('the global counter starts at zero', shell.total === '0 repos', shell.total);

    // ---- 2. Adding repo URLs -------------------------------------------
    await evaluate(`(() => {
      const column = document.querySelector('.column[data-card-id="michaeldaniel"]');
      const input = column.querySelector('.add-input');
      input.value = 'https://github.com/microsoft/vscode';
      column.querySelector('.add-form').requestSubmit();
      return true;
    })()`);
    await delay(400);
    await evaluate(`(() => {
      const column = document.querySelector('.column[data-card-id="michaeldaniel"]');
      const input = column.querySelector('.add-input');
      input.value = 'github.com/electron/electron';
      column.querySelector('.add-form').requestSubmit();
      return true;
    })()`);
    await delay(700);

    const added = await evaluate(`(() => {
      const column = document.querySelector('.column[data-card-id="michaeldaniel"]');
      const rows = [...column.querySelectorAll('.repo')];
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const repos = stored?.cards?.michaeldaniel?.repos ?? [];
      return {
        rows: rows.length,
        urls: rows.map((row) => row.querySelector('.repo-title').textContent),
        titles: rows.map((row) => row.querySelector('.repo-title').textContent),
        badge: column.querySelector('.count-badge').textContent,
        total: document.getElementById('repo-total').textContent,
        version: stored?.version,
        repos,
        colors: rows.map((row) => getComputedStyle(row).getPropertyValue('--repo-color').trim()),
        hasColor: rows.map((row) => row.classList.contains('has-color')),
        rowHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
        noteInputs: rows.filter((row) => row.querySelector('.repo-note-input')).length,
        detailsClosed: rows.every((row) => row.querySelector('.repo-detail').hidden),
        grips: rows.filter((row) => row.querySelector('.repo-grip')).length,
      };
    })()`);

    check('two repo rows appear in the first column', added.rows === 2, added.rows);
    check(
      'links are displayed as friendly host/path text',
      added.urls.some((text) => text.includes('github.com/microsoft/vscode')) &&
        added.urls.some((text) => text.includes('github.com/electron/electron')),
      JSON.stringify(added.urls)
    );
    check(
      'bare domains are normalised to https://',
      added.repos[1]?.url === 'https://github.com/electron/electron',
      added.repos[1]?.url
    );
    check(
      'column badge and global counter update',
      added.badge === '2' && added.total === '2 repos',
      `${added.badge} / ${added.total}`
    );
    check(
      'new links are persisted as v3 repo objects',
      added.version === 3 &&
        added.repos.length === 2 &&
        typeof added.repos[0].id === 'string' &&
        added.repos[0].url === 'https://github.com/microsoft/vscode',
      JSON.stringify(added.repos)
    );
    check(
      'repos stay neutral until a colour is chosen',
      added.colors.every((color) => color === '') && added.hasColor.every((value) => value === false),
      JSON.stringify({ colors: added.colors, hasColor: added.hasColor })
    );
    check(
      'each row carries a grip, a note field and a collapsed detail panel',
      added.grips === 2 && added.noteInputs === 2 && added.detailsClosed === true,
      JSON.stringify({ grips: added.grips, noteInputs: added.noteInputs, detailsClosed: added.detailsClosed })
    );
    check(
      'repo rows stay compact',
      added.rowHeights.every((height) => height > 0 && height < 140),
      JSON.stringify(added.rowHeights)
    );

    // Identify the two rows by URL so later steps never depend on sort order.
    const ids = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.column[data-card-id="michaeldaniel"] .repo')];
      const find = (fragment) => {
        const row = rows.find((item) => item.querySelector('.repo-title').textContent.includes(fragment));
        return row ? row.dataset.repoId : '';
      };
      return { primary: find('microsoft/vscode'), secondary: find('electron/electron') };
    })()`);
    const repoId = ids.primary;
    const otherRepoId = ids.secondary;
    const repoUrl = 'https://github.com/microsoft/vscode';

    // ---- 3. Duplicate and invalid input --------------------------------
    const feedback = await evaluate(`(() => {
      const column = document.querySelector('.column[data-card-id="michaeldaniel"]');
      const input = column.querySelector('.add-input');

      input.value = 'https://github.com/microsoft/vscode/';
      column.querySelector('.add-form').requestSubmit();
      const duplicateToast = document.getElementById('toast').textContent;

      input.value = 'not a repository link';
      column.querySelector('.add-form').requestSubmit();

      return {
        rows: column.querySelectorAll('.repo').length,
        duplicateToast,
        invalid: input.classList.contains('invalid'),
        invalidToast: document.getElementById('toast').textContent,
      };
    })()`);

    check('duplicate links are rejected', feedback.rows === 2, feedback.rows);
    check(
      'duplicate feedback explains the problem',
      /already/i.test(feedback.duplicateToast),
      feedback.duplicateToast
    );
    check('invalid input is flagged', feedback.invalid === true, feedback.invalid);
    check(
      'invalid input explains the expected URL',
      /valid/i.test(feedback.invalidToast),
      feedback.invalidToast
    );

    // ---- 4. One-line note field ----------------------------------------
    await evaluate(`(() => {
      const input = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"] .repo-note-input'
      );
      input.focus();
      input.value = 'Track the VS Code extension work here.';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
      return true;
    })()`);
    await delay(700);

    const noteState = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const repo = stored?.cards?.michaeldaniel?.repos?.find((entry) => entry.id === '${repoId}');
      return {
        visible: document.querySelector(
          '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"] .repo-note-input'
        ).value,
        stored: repo?.note ?? '',
        detailHidden: document.querySelector(
          '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"] .repo-detail'
        ).hidden,
      };
    })()`);

    check(
      'the one-line note field is always visible and persisted',
      noteState.visible === 'Track the VS Code extension work here.' &&
        noteState.stored === noteState.visible,
      JSON.stringify(noteState)
    );
    check('the checklist panel stays collapsed until asked for', noteState.detailHidden === true);

    const focusKept = await evaluate(`(() => {
      const tile = document.querySelector('.account-tile[data-card-id="michaeldaniel"]');
      tile.click();
      const active = document.activeElement;
      const snapshot = {
        key: active?.dataset?.focusKey ?? '',
        value: active?.value ?? '',
      };
      document.querySelector('.account-tile[data-card-id="michaeldaniel"]').click();
      return snapshot;
    })()`);
    check(
      'editing one row keeps focus in place across a re-render',
      focusKept.key === `note:${repoId}` &&
        focusKept.value === 'Track the VS Code extension work here.',
      JSON.stringify(focusKept)
    );

    // ---- 5. Account note ------------------------------------------------
    await evaluate(`(() => {
      const note = document.querySelector('.column[data-card-id="michaeldaniel"] .note');
      note.textContent = 'Personal work account';
      note.dispatchEvent(new InputEvent('input', { bubbles: true }));
      note.dispatchEvent(new FocusEvent('blur'));
      return true;
    })()`);
    await delay(700);

    const accountNote = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      return {
        text: document.querySelector('.column[data-card-id="michaeldaniel"] .note').textContent,
        stored: stored?.cards?.michaeldaniel?.note ?? '',
      };
    })()`);
    check(
      'the account note is editable and persisted',
      accountNote.text === 'Personal work account' && accountNote.stored === 'Personal work account',
      JSON.stringify(accountNote)
    );

    // ---- 6. Theme toggle -------------------------------------------------
    const theme = await evaluate(`(() => {
      const root = document.documentElement;
      const before =
        root.dataset.theme ||
        (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      document.getElementById('theme-toggle').click();
      return {
        before,
        after: root.dataset.theme,
        saved: localStorage.getItem('${THEME_KEY}'),
        label: document.getElementById('theme-toggle').getAttribute('aria-label'),
      };
    })()`);
    check(
      'theme toggle switches and remembers the choice',
      theme.after !== theme.before && theme.saved === theme.after,
      JSON.stringify(theme)
    );
    check('theme button exposes an action label', /switch to/i.test(theme.label), theme.label);

    // ---- 7. Repo details dialog -----------------------------------------
    const dialog = await evaluate(`(() => {
      const row = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"]'
      );
      row.querySelector('.repo-edit').click();
      const dialog = document.getElementById('repo-dialog');
      return {
        open: dialog.open,
        url: document.getElementById('repo-url').value,
        label: document.getElementById('repo-label').value,
        tags: document.getElementById('repo-tags').value,
        priority: document.getElementById('repo-priority').value,
        swatches: document.querySelectorAll('#repo-swatches .swatch').length,
        hasAuto: Boolean(document.querySelector('#repo-swatches .swatch.is-auto')),
        customColor: Boolean(document.getElementById('repo-color-input')),
      };
    })()`);
    check('edit button opens the details dialog', dialog.open === true);
    check(
      'dialog is pre-filled from the repo',
      dialog.url === repoUrl && dialog.label === '' && dialog.tags === '' && dialog.priority === 'medium',
      JSON.stringify(dialog)
    );
    check(
      'dialog offers an auto option plus the full palette',
      dialog.swatches === 10 && dialog.hasAuto && dialog.customColor,
      `${dialog.swatches} swatches / auto=${dialog.hasAuto}`
    );

    await evaluate(`(() => {
      document.getElementById('repo-label').value = 'VS Code';
      document.getElementById('repo-tags').value = 'work, editor';
      document.getElementById('repo-priority').value = 'high';
      document.querySelector('#repo-swatches .swatch[data-color="#ec4899"]').click();
      document.getElementById('repo-form').requestSubmit();
      return true;
    })()`);
    await delay(700);

    const labelled = await evaluate(`(() => {
      const row = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"]'
      );
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const repo = stored?.cards?.michaeldaniel?.repos?.find((entry) => entry.id === '${repoId}');
      return {
        dialogOpen: document.getElementById('repo-dialog').open,
        name: row.querySelector('.repo-title').textContent,
        urlLine: row.querySelector('.repo-url')?.textContent ?? '',
        plainUrlHidden: !document.querySelector(
          '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${otherRepoId}' + '"] .repo-url'
        ),
        chips: [...row.querySelectorAll('.tag-chip')].map((chip) => chip.dataset.tag),
        colorVar: getComputedStyle(row).getPropertyValue('--repo-color').trim(),
        hasColor: row.classList.contains('has-color'),
        badges: [...row.querySelectorAll('.repo-badge')].map((badge) => badge.textContent),
        repo,
        tagBarHidden: document.getElementById('tag-bar').hidden,
        filterTags: [...document.querySelectorAll('.tag-filter')].map((chip) => chip.dataset.tag),
        suggestions: [...document.querySelectorAll('#tag-suggestions option')].map((opt) => opt.value),
        badge: document.querySelector('.column[data-card-id="michaeldaniel"] .count-badge').textContent,
        total: document.getElementById('repo-total').textContent,
      };
    })()`);

    check('saving details closes the dialog', labelled.dialogOpen === false);
    check('custom label becomes the repo title', labelled.name === 'VS Code', labelled.name);
    check(
      'the URL stays visible under the label',
      labelled.urlLine.includes('github.com/microsoft/vscode'),
      labelled.urlLine
    );
    check(
      'an unlabelled repo does not repeat its link on the meta line',
      labelled.plainUrlHidden === true,
      JSON.stringify(labelled.plainUrlHidden)
    );
    check(
      'tags render as chips on the repo',
      JSON.stringify(labelled.chips) === JSON.stringify(['work', 'editor']),
      JSON.stringify(labelled.chips)
    );
    check(
      'a manual repo colour is applied and persisted',
      labelled.colorVar === '#ec4899' && labelled.hasColor && labelled.repo?.color === '#ec4899',
      `${labelled.colorVar} / ${labelled.repo?.color}`
    );
    check(
      'label, tags and priority are persisted',
      labelled.repo?.label === 'VS Code' &&
        JSON.stringify(labelled.repo?.tags) === JSON.stringify(['work', 'editor']) &&
        labelled.repo?.priority === 'high',
      JSON.stringify(labelled.repo)
    );
    check(
      'priority shows up as a badge',
      labelled.badges.includes('High'),
      JSON.stringify(labelled.badges)
    );
    check(
      'tag bar lists every tag with suggestions',
      labelled.tagBarHidden === false &&
        JSON.stringify(labelled.filterTags) === JSON.stringify(['editor', 'work']) &&
        JSON.stringify(labelled.suggestions) === JSON.stringify(['editor', 'work']),
      `${JSON.stringify(labelled.filterTags)} / ${JSON.stringify(labelled.suggestions)}`
    );
    check(
      'counts still reflect all repos after tagging',
      labelled.badge === '2' && labelled.total === '2 repos',
      `${labelled.badge} / ${labelled.total}`
    );

    // ---- 8. Column color popover ----------------------------------------
    await evaluate(`(() => {
      document.querySelector('.column[data-card-id="michaeldaniel"] .column-color').click();
      return true;
    })()`);
    await delay(150);

    const pop = await evaluate(`(() => {
      const el = document.getElementById('card-color-pop');
      const rect = el.getBoundingClientRect();
      return {
        hidden: el.hidden,
        swatches: el.querySelectorAll('.swatch').length,
        inViewport:
          rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      };
    })()`);
    check(
      'column color popover opens near the column',
      pop.hidden === false && pop.swatches === 10,
      JSON.stringify(pop)
    );
    check('column color popover stays inside the window', pop.inViewport === true, JSON.stringify(pop));

    await evaluate(`(() => {
      document.querySelector('#card-swatches .swatch[data-color="#22c55e"]').click();
      return true;
    })()`);
    await delay(600);

    const columnColor = await evaluate(`(() => {
      const column = document.querySelector('.column[data-card-id="michaeldaniel"]');
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      return {
        hidden: document.getElementById('card-color-pop').hidden,
        accent: column.style.getPropertyValue('--column-accent').trim(),
        stored: stored?.cards?.michaeldaniel?.color ?? null,
      };
    })()`);
    check(
      'choosing a column colour applies and saves it',
      columnColor.hidden === true &&
        columnColor.accent === '#22c55e' &&
        columnColor.stored === '#22c55e',
      JSON.stringify(columnColor)
    );

    await evaluate(`(() => {
      document.querySelector('.column[data-card-id="michaeldaniel"] .column-color').click();
      document.querySelector('#card-swatches .swatch.is-auto').click();
      return true;
    })()`);
    await delay(600);

    const columnAuto = await evaluate(`(() => {
      const column = document.querySelector('.column[data-card-id="michaeldaniel"]');
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      return {
        accent: column.style.getPropertyValue('--column-accent').trim(),
        stored: stored?.cards?.michaeldaniel?.color ?? null,
      };
    })()`);
    check(
      'the auto option restores the default accent',
      columnAuto.accent === '' && columnAuto.stored === null,
      JSON.stringify(columnAuto)
    );

    // ---- 9. Pinning and the pinned-only filter ---------------------------
    await evaluate(`(() => {
      document
        .querySelector('.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"] .repo-star')
        .click();
      return true;
    })()`);
    await delay(600);

    const pinned = await evaluate(`(() => {
      const row = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"]'
      );
      const tile = document.querySelector('.account-tile[data-card-id="michaeldaniel"]');
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const repo = stored?.cards?.michaeldaniel?.repos?.find((entry) => entry.id === '${repoId}');
      return {
        pressed: row.querySelector('.repo-star').getAttribute('aria-pressed'),
        starred: row.querySelector('.repo-star').classList.contains('is-pinned'),
        stored: Boolean(repo?.pinned),
        sub: tile.querySelector('.account-sub').textContent,
      };
    })()`);
    check(
      'the star pins a repo',
      pinned.pressed === 'true' && pinned.starred && pinned.stored,
      JSON.stringify(pinned)
    );
    check(
      'the sidebar counts pinned repos',
      /1 pinned/.test(pinned.sub),
      pinned.sub
    );

    await evaluate(`document.getElementById('pinned-toggle').click()`);
    await delay(600);

    const pinnedOnly = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.repo')];
      return {
        rows: rows.length,
        pressed: document.getElementById('pinned-toggle').getAttribute('aria-pressed'),
        total: document.getElementById('repo-total').textContent,
        emptyLabels: [...document.querySelectorAll('.empty')].map((node) => node.textContent.trim()),
      };
    })()`);
    check(
      'the pinned-only filter hides unpinned repos',
      pinnedOnly.rows === 1 && pinnedOnly.pressed === 'true',
      JSON.stringify(pinnedOnly)
    );
    check(
      'the pinned-only filter updates the counter',
      pinnedOnly.total === '1 of 2 repos',
      pinnedOnly.total
    );
    check(
      'columns with no repos keep the empty state while filtering',
      pinnedOnly.emptyLabels.length === 3 &&
        pinnedOnly.emptyLabels.every((label) => /no repos yet/i.test(label)),
      JSON.stringify(pinnedOnly.emptyLabels)
    );

    await evaluate(`document.getElementById('pinned-toggle').click()`);
    await delay(600);

    const unpinned = await evaluate(`({
      rows: document.querySelectorAll('.repo').length,
      total: document.getElementById('repo-total').textContent
    })`);
    check(
      'clearing the pinned filter restores every repo',
      unpinned.rows === 2 && unpinned.total === '2 repos',
      JSON.stringify(unpinned)
    );

    // ---- 10. Sidebar account views ---------------------------------------
    await evaluate(`document.querySelector('.account-tile[data-card-id="mikeperac"]').click()`);
    await delay(400);

    const focusState = await evaluate(`(() => {
      const columns = [...document.querySelectorAll('.column')];
      const tile = document.querySelector('.account-tile[data-card-id="mikeperac"]');
      const allTile = document.getElementById('all-accounts');
      return {
        focused: columns.filter((column) => column.classList.contains('is-focused')).map(
          (column) => column.dataset.cardId
        ),
        visible: columns.filter((column) => !column.hidden).map((column) => column.dataset.cardId),
        tileFocused: tile.classList.contains('is-focused'),
        tilePressed: tile.getAttribute('aria-pressed'),
        allFocused: allTile.classList.contains('is-focused'),
        allPressed: allTile.getAttribute('aria-pressed'),
        single: document.getElementById('board').classList.contains('is-single'),
        gridColumns: getComputedStyle(document.getElementById('board')).gridTemplateColumns
          .split(' ')
          .filter(Boolean).length,
      };
    })()`);
    check(
      'clicking an account focuses its column',
      JSON.stringify(focusState.focused) === JSON.stringify(['mikeperac']) &&
        focusState.tileFocused &&
        focusState.tilePressed === 'true',
      JSON.stringify(focusState)
    );
    check(
      'the other accounts are hidden from the board',
      JSON.stringify(focusState.visible) === JSON.stringify(['mikeperac']),
      JSON.stringify(focusState.visible)
    );
    check(
      'the focused account takes the whole board width',
      focusState.single && focusState.gridColumns === 1,
      JSON.stringify(focusState)
    );
    check(
      'the all-accounts tile yields to the focused account',
      focusState.allFocused === false && focusState.allPressed === 'false',
      JSON.stringify(focusState)
    );

    await evaluate(`document.getElementById('all-accounts').click()`);
    await delay(400);

    const allState = await evaluate(`(() => {
      const columns = [...document.querySelectorAll('.column')];
      const allTile = document.getElementById('all-accounts');
      return {
        visible: columns.filter((column) => !column.hidden).map((column) => column.dataset.cardId),
        focused: columns.filter((column) => column.classList.contains('is-focused')).length,
        allFocused: allTile.classList.contains('is-focused'),
        allPressed: allTile.getAttribute('aria-pressed'),
        single: document.getElementById('board').classList.contains('is-single'),
        gridColumns: getComputedStyle(document.getElementById('board')).gridTemplateColumns
          .split(' ')
          .filter(Boolean).length,
      };
    })()`);
    check(
      'the all-accounts tile restores every column',
      JSON.stringify(allState.visible) === JSON.stringify(CARD_NAMES) &&
        allState.focused === 0 &&
        allState.single === false &&
        allState.gridColumns === 4,
      JSON.stringify(allState)
    );
    check(
      'the all-accounts tile is marked as the current view',
      allState.allFocused && allState.allPressed === 'true',
      JSON.stringify(allState)
    );

    await evaluate(`document.querySelector('.account-tile[data-card-id="mikeperac"]').click()`);
    await delay(400);
    await evaluate(`document.querySelector('.account-tile[data-card-id="mikeperac"]').click()`);
    await delay(400);

    const focusCleared = await evaluate(`({
      visible: [...document.querySelectorAll('.column')].filter((column) => !column.hidden).length,
      focused: document.querySelectorAll('.column.is-focused').length,
      single: document.getElementById('board').classList.contains('is-single')
    })`);
    check(
      'clicking the focused account again restores every column',
      focusCleared.visible === 4 && focusCleared.focused === 0 && focusCleared.single === false,
      JSON.stringify(focusCleared)
    );

    // ---- 11. Expand in place --------------------------------------------
    await evaluate(`(() => {
      document
        .querySelector('.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"] .repo-expand')
        .click();
      return true;
    })()`);
    await delay(400);

    const expanded = await evaluate(`(() => {
      const row = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"]'
      );
      const detail = row.querySelector('.repo-detail');
      return {
        hidden: detail.hidden,
        open: row.classList.contains('is-open'),
        pressed: row.querySelector('.repo-expand').getAttribute('aria-expanded'),
        todos: row.querySelectorAll('.repo-todo').length,
        todoEmpty: row.querySelector('.todo-empty').hidden,
        count: row.querySelector('.todo-count').textContent,
        hasFullNote: Boolean(row.querySelector('.repo-note-full')),
      };
    })()`);
    check(
      'expanding a repo reveals its checklist and notes',
      expanded.hidden === false && expanded.open && expanded.hasFullNote,
      JSON.stringify(expanded)
    );
    check(
      'the expand control reports its state',
      expanded.pressed === 'true',
      expanded.pressed
    );
    check(
      'an empty checklist explains itself',
      expanded.todos === 0 && expanded.todoEmpty === false && expanded.count === '0/0',
      JSON.stringify(expanded)
    );

    await evaluate(`(() => {
      const row = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"]'
      );
      const input = row.querySelector('.todo-input');
      input.value = 'Write the extension manifest';
      row.querySelector('.todo-form').requestSubmit();
      return true;
    })()`);
    await delay(500);

    const todoState = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const repo = stored?.cards?.michaeldaniel?.repos?.find((entry) => entry.id === '${repoId}');
      const row = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"]'
      );
      return {
        todos: repo?.todos?.length ?? 0,
        text: repo?.todos?.[0]?.text ?? '',
        rows: row.querySelectorAll('.repo-todo').length,
        count: row.querySelector('.todo-count').textContent,
        badge: row.querySelector('.repo-tasks')?.textContent ?? '',
      };
    })()`);
    check(
      'checklist items are added and persisted',
      todoState.todos === 1 &&
        todoState.text === 'Write the extension manifest' &&
        todoState.rows === 1,
      JSON.stringify(todoState)
    );
    check(
      'the checklist counter reflects the new task',
      todoState.count === '0/1' && todoState.badge === '0/1',
      `${todoState.count} / ${todoState.badge}`
    );

    await evaluate(`(() => {
      const row = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"]'
      );
      row.querySelector('.repo-todo input[type="checkbox"]').click();
      return true;
    })()`);
    await delay(500);

    const doneState = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const repo = stored?.cards?.michaeldaniel?.repos?.find((entry) => entry.id === '${repoId}');
      const row = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"]'
      );
      return {
        done: Boolean(repo?.todos?.[0]?.done),
        count: row.querySelector('.todo-count').textContent,
        badge: row.querySelector('.repo-tasks')?.textContent ?? '',
        checked: row.querySelector('.repo-todo input[type="checkbox"]').checked,
      };
    })()`);
    check(
      'ticking a task updates the counters',
      doneState.done && doneState.checked && doneState.count === '1/1' && doneState.badge === '1/1',
      JSON.stringify(doneState)
    );

    await evaluate(`(() => {
      const row = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"] .repo-note-full'
      );
      row.value = 'Headline only\\nSecond line stays in the full note';
      row.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    })()`);
    await delay(500);

    const noteSplit = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const repo = stored?.cards?.michaeldaniel?.repos?.find((entry) => entry.id === '${repoId}');
      return {
        stored: repo?.note ?? '',
        headline: document.querySelector(
          '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"] .repo-note-input'
        ).value,
      };
    })()`);
    check(
      'the one-line field shows only the first line of a note',
      noteSplit.headline === 'Headline only',
      noteSplit.headline
    );
    check(
      'the full note keeps every line',
      noteSplit.stored === 'Headline only\nSecond line stays in the full note',
      JSON.stringify(noteSplit.stored)
    );

    await evaluate(`(() => {
      const other = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${otherRepoId}' + '"]'
      );
      other.querySelector('.repo-expand').click();
      return true;
    })()`);
    await delay(400);

    const singleOpen = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.column[data-card-id="michaeldaniel"] .repo')];
      return {
        open: rows.filter((row) => !row.querySelector('.repo-detail').hidden).length,
        openIds: rows.filter((row) => !row.querySelector('.repo-detail').hidden).map(
          (row) => row.dataset.repoId
        ),
      };
    })()`);
    check(
      'only one repo expands per column',
      singleOpen.open === 1 && singleOpen.openIds[0] === otherRepoId,
      JSON.stringify(singleOpen)
    );

    // ---- 12. Archiving ----------------------------------------------------
    await evaluate(`(() => {
      document
        .querySelector('.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${otherRepoId}' + '"] .repo-archive')
        .click();
      return true;
    })()`);
    await delay(600);

    const archived = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const repo = stored?.cards?.michaeldaniel?.repos?.find((entry) => entry.id === '${otherRepoId}');
      return {
        stored: Boolean(repo?.archived),
        visible: document.querySelectorAll('.column[data-card-id="michaeldaniel"] .repo').length,
        total: document.getElementById('repo-total').textContent,
        label: document.getElementById('archive-toggle').textContent.trim(),
      };
    })()`);
    check(
      'archived repos leave the column by default',
      archived.stored && archived.visible === 1 && archived.total === '1 repo',
      JSON.stringify(archived)
    );
    check(
      'the archive toggle offers to show them again',
      /show archived/i.test(archived.label),
      archived.label
    );

    await evaluate(`document.getElementById('archive-toggle').click()`);
    await delay(600);

    const shownArchived = await evaluate(`(() => {
      const row = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${otherRepoId}' + '"]'
      );
      return {
        visible: document.querySelectorAll('.column[data-card-id="michaeldaniel"] .repo').length,
        badge: row?.querySelector('.repo-archived-badge')?.textContent ?? '',
        arrowFlipped:
          row?.querySelector('.repo-archive')?.classList.contains('is-archived') ?? false,
        total: document.getElementById('repo-total').textContent,
      };
    })()`);
    check(
      'archived repos come back with a badge',
      shownArchived.visible === 2 &&
        shownArchived.badge === 'Archived' &&
        shownArchived.arrowFlipped,
      JSON.stringify(shownArchived)
    );
    check(
      'the counter never exceeds the real repo count',
      shownArchived.total === '2 repos',
      shownArchived.total
    );

    await evaluate(`(() => {
      document
        .querySelector('.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${otherRepoId}' + '"] .repo-archive')
        .click();
      return true;
    })()`);
    await delay(500);

    await evaluate(`document.getElementById('archive-toggle').click()`);
    await delay(500);

    const restored = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const repo = stored?.cards?.michaeldaniel?.repos?.find((entry) => entry.id === '${otherRepoId}');
      return {
        archived: Boolean(repo?.archived),
        visible: document.querySelectorAll('.column[data-card-id="michaeldaniel"] .repo').length,
        total: document.getElementById('repo-total').textContent,
      };
    })()`);
    check(
      'a restored repo comes back to the column',
      !restored.archived && restored.visible === 2 && restored.total === '2 repos',
      JSON.stringify(restored)
    );

    // ---- 13. Drag and drop ------------------------------------------------
    const moved = await evaluate(`(() => {
      const source = document.querySelector(
        '.column[data-card-id="michaeldaniel"] .repo[data-repo-id="' + '${repoId}' + '"] .repo-grip'
      );
      const target = document.querySelector('.column[data-card-id="mikeperac"]');
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      target.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
      return {
        source: document.querySelectorAll('.column[data-card-id="michaeldaniel"] .repo').length,
        target: document.querySelectorAll('.column[data-card-id="mikeperac"] .repo').length,
        toast: document.getElementById('toast').textContent,
      };
    })()`);
    await delay(600);

    const movedState = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      return {
        inTarget: (stored?.cards?.mikeperac?.repos ?? []).map((repo) => repo.id),
        inSource: (stored?.cards?.michaeldaniel?.repos ?? []).map((repo) => repo.id),
        note: (stored?.cards?.mikeperac?.repos ?? [])[0]?.note ?? '',
        pinned: Boolean((stored?.cards?.mikeperac?.repos ?? [])[0]?.pinned),
        todos: ((stored?.cards?.mikeperac?.repos ?? [])[0]?.todos ?? []).length,
      };
    })()`);
    check(
      'dragging a repo moves it to another column',
      moved.source === 1 && moved.target === 1 && movedState.inTarget.includes(repoId),
      `${moved.source} → ${moved.target} ${JSON.stringify(movedState.inTarget)}`
    );
    check(
      'a moved repo keeps its note, pin and checklist',
      movedState.note.includes('Headline only') &&
        movedState.pinned &&
        movedState.todos === 1,
      JSON.stringify(movedState)
    );

    const dropped = await evaluate(`(() => {
      const target = document.querySelector('.column[data-card-id="mikelb"]');
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'https://github.com/facebook/react');
      target.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
      const labelled = target.classList.contains('drop-target');
      target.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
      return {
        labelled,
        rows: document.querySelectorAll('.column[data-card-id="mikelb"] .repo').length,
        url: document.querySelector('.column[data-card-id="mikelb"] .repo-url')?.textContent ?? '',
      };
    })()`);
    await delay(600);

    const droppedState = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      return {
        urls: (stored?.cards?.mikelb?.repos ?? []).map((repo) => repo.url),
        total: document.getElementById('repo-total').textContent,
      };
    })()`);
    check(
      'dropping a link onto a column adds the repo',
      dropped.labelled &&
        dropped.rows === 1 &&
        droppedState.urls[0] === 'https://github.com/facebook/react',
      JSON.stringify(droppedState.urls)
    );

    await evaluate(`document.getElementById('pinned-toggle').click()`);
    await delay(600);

    const pinnedElsewhere = await evaluate(`(() => ({
      rows: document.querySelectorAll('.repo').length,
      emptyLabels: [...document.querySelectorAll('.empty')].map((node) => node.textContent.trim())
    }))()`);
    check(
      'columns whose repos are all unpinned say so',
      pinnedElsewhere.rows === 1 &&
        pinnedElsewhere.emptyLabels.length === 3 &&
        pinnedElsewhere.emptyLabels.filter((label) => /nothing pinned/i.test(label)).length === 2 &&
        pinnedElsewhere.emptyLabels.filter((label) => /no repos yet/i.test(label)).length === 1,
      JSON.stringify(pinnedElsewhere.emptyLabels)
    );

    await evaluate(`document.getElementById('pinned-toggle').click()`);
    await delay(600);

    // ---- 14. Search --------------------------------------------------------
    await evaluate(`(() => {
      const search = document.getElementById('repo-search');
      search.value = 'electron';
      search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
      return true;
    })()`);
    await delay(600);

    const searched = await evaluate(`({
      rows: document.querySelectorAll('.repo').length,
      total: document.getElementById('repo-total').textContent
    })`);
    check(
      'search narrows the board down',
      searched.rows === 1 && /of 3 repos/.test(searched.total),
      JSON.stringify(searched)
    );

    await evaluate(`(() => {
      const search = document.getElementById('repo-search');
      search.value = '';
      search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return true;
    })()`);
    await delay(600);

    const cleared = await evaluate(`({
      rows: document.querySelectorAll('.repo').length,
      total: document.getElementById('repo-total').textContent
    })`);
    check(
      'clearing the search restores the board',
      cleared.rows === 3 && cleared.total === '3 repos',
      JSON.stringify(cleared)
    );

    // ---- 15. Persistence across a reload ----------------------------------
    await reload();

    const reloaded = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const moved = stored?.cards?.mikeperac?.repos?.[0];
      return {
        version: stored?.version,
        repos: stored ? Object.values(stored.cards).reduce((sum, card) => sum + card.repos.length, 0) : 0,
        note: moved?.note ?? '',
        pinned: Boolean(moved?.pinned),
        todos: (moved?.todos ?? []).length,
        rows: document.querySelectorAll('.repo').length,
        columns: document.querySelectorAll('.column').length,
        tiles: document.querySelectorAll('.account-tile').length,
        sidebarCount: document
          .querySelector('.account-tile[data-card-id="mikeperac"] .account-count')
          ?.textContent ?? '',
        total: document.getElementById('repo-total').textContent,
      };
    })()`);
    check(
      'the board survives a reload',
      reloaded.version === 3 &&
        reloaded.repos === 3 &&
        reloaded.rows === 3 &&
        reloaded.columns === 4 &&
        reloaded.tiles === 5 &&
        reloaded.total === '3 repos',
      JSON.stringify(reloaded)
    );
    check(
      'notes, pins and checklists survive a reload',
      reloaded.note.includes('Headline only') && reloaded.pinned && reloaded.todos === 1,
      JSON.stringify(reloaded)
    );
    check(
      'the sidebar counts survive a reload',
      reloaded.sidebarCount === '1',
      reloaded.sidebarCount
    );

    // ---- 16. Screenshots ----------------------------------------------------
    await evaluate(`(() => {
      document.documentElement.dataset.theme = 'dark';
      localStorage.setItem('${THEME_KEY}', 'dark');
      return true;
    })()`);
    await delay(250);
    const darkShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(darkShot.data, 'base64'));

    await evaluate(`(() => {
      document.documentElement.dataset.theme = 'light';
      localStorage.setItem('${THEME_KEY}', 'light');
      return true;
    })()`);
    await delay(250);
    const lightShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT_LIGHT, Buffer.from(lightShot.data, 'base64'));
    check('screenshots are captured', fs.existsSync(SHOT) && fs.existsSync(SHOT_LIGHT));

    // ---- 17. Migration from the v2 state ------------------------------------
    await evaluate(`(() => {
      localStorage.removeItem('${STORAGE_KEY}');
      localStorage.setItem(
        '${LEGACY_STATE_KEY}',
        JSON.stringify({
          version: 2,
          cards: {
            michaeldaniel: {
              note: 'legacy card note',
              color: '#ef4444',
              repos: [
                {
                  id: 'legacyrepo01',
                  url: 'https://github.com/legacy/one',
                  label: 'Legacy One',
                  tags: ['old'],
                  color: '#123456'
                }
              ]
            }
          }
        })
      );
      return true;
    })()`);
    await reload();

    const migrated = await evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || 'null');
      const repo = stored?.cards?.michaeldaniel?.repos?.[0];
      return {
        version: stored?.version,
        label: repo?.label ?? '',
        url: repo?.url ?? '',
        tags: JSON.stringify(repo?.tags ?? []),
        color: repo?.color ?? '',
        note: stored?.cards?.michaeldaniel?.note ?? '',
        columnColor: stored?.cards?.michaeldaniel?.color ?? '',
        rows: document.querySelectorAll('.repo').length,
        titles: [...document.querySelectorAll('.repo-title')].map((node) => node.textContent),
      };
    })()`);
    check(
      'a v2 state migrates into the v3 shape',
      migrated.version === 3 &&
        migrated.label === 'Legacy One' &&
        migrated.url === 'https://github.com/legacy/one' &&
        migrated.tags === JSON.stringify(['old']) &&
        migrated.color === '#123456',
      JSON.stringify(migrated)
    );
    check(
      'the migrated card note and column colour are kept',
      migrated.note === 'legacy card note' && migrated.columnColor === '#ef4444',
      JSON.stringify(migrated)
    );
    check(
      'the migrated repo shows up on the board',
      migrated.rows === 1 && migrated.titles[0] === 'Legacy One',
      JSON.stringify(migrated.titles)
    );

    // ---- 18. Console cleanliness ----------------------------------------------
    check(
      'the renderer logs no console errors',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 5).join(' | ')
    );

    const state = await readState();
    check('the persisted state is readable at the end', state && state.version === 3);

    console.log(`\n${results.length - failures}/${results.length} checks passed`);
    if (failures) {
      console.log('\nFailures:');
      for (const result of results.filter((entry) => !entry.ok)) {
        console.log(`  - ${result.name}${result.detail ? `  -> ${result.detail}` : ''}`);
      }
    }
  } catch (error) {
    failures += 1;
    console.error(`\nSmoke test crashed: ${error.stack || error.message}`);
    if (electronLog.length) console.error(electronLog.join('').slice(-4000));
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    killAppTree(child);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  process.exit(failures ? 1 : 0);
}

main();
