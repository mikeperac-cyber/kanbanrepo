'use strict';

const pkg = require('./package.json');

/**
 * Microsoft Store identity.
 *
 * These four values must match what Partner Center shows under
 * "Product identity" for the reserved app name:
 *   - identityName        -> Package/Identity/Name
 *   - publisher           -> Package/Identity/Publisher  (CN=...)
 *   - publisherDisplayName-> Package/Properties/PublisherDisplayName
 *   - applicationId       -> Package/Applications/Application/@Id
 *
 * They can be overridden without editing this file:
 *   APPX_IDENTITY, APPX_PUBLISHER, APPX_PUBLISHER_DISPLAY, APPX_APPLICATION_ID
 */
const PUBLISHER = process.env.APPX_PUBLISHER || 'CN=Michael Daniel';
const IDENTITY = process.env.APPX_IDENTITY || 'KanbanRepoCards';
const APPLICATION_ID = process.env.APPX_APPLICATION_ID || 'KanbanRepoCards';
const PUBLISHER_DISPLAY = process.env.APPX_PUBLISHER_DISPLAY || 'Michael Daniel';

const winConfig = {
  target: [{ target: 'nsis', arch: ['x64'] }],
  icon: 'build/icon.ico',
  requestedExecutionLevel: 'asInvoker',
};

// The custom SDK signtool hook requires a certificate. Leave it out for the
// documented unsigned build; the signing wrappers set CSC_LINK when needed.
if (process.env.CSC_LINK || process.env.WIN_CSC_LINK) {
  winConfig.signtoolOptions = {
    // Route signed builds through the Windows SDK; electron-builder's bundled
    // signtool fails on current Windows builds.
    sign: './tools/sign-windows.js',
    signingHashAlgorithms: ['sha256'],
  };
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.mikedaniel.kanbanrepocards',
  productName: pkg.productName,
  copyright: `Copyright \u00a9 ${new Date().getFullYear()} Michael Daniel`,

  directories: {
    output: 'dist',
    buildResources: 'build',
  },

  asar: true,
  compression: 'maximum',

  files: [
    'main.js',
    'preload.js',
    'renderer.js',
    'index.html',
    'style.css',
    'assets/**/*',
    'package.json',
  ],

  // The taskbar/window icon cannot be read from inside the asar archive.
  extraResources: [{ from: 'build/icon.ico', to: 'icon.ico' }],

  win: winConfig,

  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: pkg.productName,
    uninstallDisplayName: pkg.productName,
    deleteAppDataOnUninstall: false,
    artifactName: 'Kanban-Repo-Cards-Setup-${version}.${ext}',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico',
  },

  appx: {
    identityName: IDENTITY,
    applicationId: APPLICATION_ID,
    publisher: PUBLISHER,
    publisherDisplayName: PUBLISHER_DISPLAY,
    displayName: pkg.productName,
    backgroundColor: '#080d18',
    showNameOnTiles: true,
    languages: ['en-US'],
    minVersion: '10.0.17763.0',
    maxVersionTested: '10.0.26100.0',
    // The Store owns updates for MSIX; do not generate electron-updater metadata.
    electronUpdaterAware: false,
    artifactName: 'Kanban-Repo-Cards-${version}-${arch}.${ext}',
  },
};
