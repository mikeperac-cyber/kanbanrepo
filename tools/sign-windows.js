'use strict';

/**
 * electron-builder custom Windows signing hook.
 *
 * electron-builder 26 ships winCodeSign 2.6.0, whose bundled signtool.exe
 * crashes on current Windows builds with:
 *   "SignTool Error: A required function is not present."
 *
 * The Windows SDK's own signtool.exe is installed on virtually every build
 * machine that can produce an APPX, so this hook routes signing through it
 * instead. It reuses electron-builder's own argument builder, which means
 * CSC_LINK / CSC_KEY_PASSWORD, signtoolOptions, timestamps and hash algorithms
 * all keep working exactly as documented.
 *
 * Configured via:
 *   win.signtoolOptions.sign = './tools/sign-windows.js'
 *
 * Optional environment overrides:
 *   SIGNTOOL_PATH       explicit path to signtool.exe
 *   SIGNTOOL_TIMEOUT    per-signing timeout in ms (default 10 minutes)
 *   ELECTRON_BUILDER_OFFLINE=true   skip timestamping
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isFile(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Sort Windows 10 SDK version folders newest-first (10.0.26100.0 > 10.0.22621.0). */
function byVersionDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function findSystemSigntool() {
  if (isFile(process.env.SIGNTOOL_PATH)) return process.env.SIGNTOOL_PATH;

  const archDirs = ['x64', 'x86', 'arm64'];
  const kitsBins = [
    process.env.WINDOWS_KITS_BIN,
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Windows Kits', '10', 'bin'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Windows Kits', '10', 'bin'),
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
  ].filter(Boolean);

  for (const bin of kitsBins) {
    let versions;
    try {
      versions = fs.readdirSync(bin).filter((name) => /^10\.\d+\.\d+\.\d+$/.test(name));
    } catch {
      continue;
    }
    versions.sort(byVersionDesc);
    for (const version of versions) {
      for (const archDir of archDirs) {
        const candidate = path.join(bin, version, archDir, 'signtool.exe');
        if (isFile(candidate)) return candidate;
      }
    }
  }

  // Last resort: whatever is on PATH.
  const pathEntries = (process.env.PATH || process.env.Path || '').split(path.delimiter);
  for (const entry of pathEntries) {
    const candidate = path.join(entry.replace(/^"|"$/g, ''), 'signtool.exe');
    if (isFile(candidate)) return candidate;
  }

  return null;
}

function run(tool, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      tool,
      args,
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (!error) {
          resolve();
          return;
        }
        const detail = (stderr || stdout || error.message || '').trim();
        const wrapped = new Error(`signtool failed (${error.code ?? 'error'}): ${detail}`);
        wrapped.transient =
          /timestamp server|No certificates were found|being used by another process|network/i.test(
            detail
          );
        reject(wrapped);
      }
    );
  });
}

/**
 * @param {import('app-builder-lib').CustomWindowsSignTaskConfiguration} configuration
 */
async function sign(configuration) {
  const tool = findSystemSigntool();
  if (!tool) {
    throw new Error(
      'No usable signtool.exe found. Install the Windows 10/11 SDK (which provides ' +
        'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\<version>\\x64\\signtool.exe) ' +
        'or set the SIGNTOOL_PATH environment variable.'
    );
  }

  const args = configuration.computeSignToolArgs(true);
  const timeout = Number(process.env.SIGNTOOL_TIMEOUT) || 10 * 60 * 1000;
  const file = configuration.path;

  console.log(`  • signing ${path.basename(file)} with ${tool}`);

  // Timestamp servers are the usual source of flakiness; retry those (and file
  // locks), but never retry a bad certificate or malformed arguments.
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await run(tool, args, timeout);
      return;
    } catch (error) {
      if (!error.transient || attempt === attempts) throw error;
      const pause = attempt * 5000;
      console.warn(`  • signing retry ${attempt}/${attempts - 1} in ${pause / 1000}s: ${error.message}`);
      await delay(pause);
    }
  }
}

module.exports = sign;
module.exports.sign = sign;
module.exports.findSystemSigntool = findSystemSigntool;
