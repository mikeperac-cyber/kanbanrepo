# Microsoft Store readiness

This project is packaged as a **Desktop Bridge (full-trust) MSIX/APPX** app,
which is the supported way to ship an Electron application in the Microsoft
Store. The `appx` target is wired up in `electron-builder.config.js`.

`npm run dist:store` produces a Store-uploadable package:

```
dist/Kanban-Repo-Cards-1.4.0-x64.appx
```

The NSIS `.exe` (`npm run dist:exe`) is the separate download/installer build.

---

## 1. Already handled in this project

| Requirement | Status |
| --- | --- |
| MSIX/APPX packaging target | ✅ electron-builder `appx` target |
| Desktop Bridge / full trust | ✅ `runFullTrust` is added automatically |
| No admin rights needed | ✅ `requestedExecutionLevel: asInvoker` |
| Sandboxed renderer | ✅ `sandbox: true`, `contextIsolation: true`, no Node in UI |
| Strict CSP, no remote content | ✅ `default-src 'none'`, local assets only |
| Permissions | ✅ all device permission requests denied |
| Store-managed updates | ✅ no Squirrel/electron-updater, no update metadata |
| No writes to install directory | ✅ data lives in the user profile |
| Store tiles + logos + splash | ✅ `build/appx/*`, `build/icon.ico` |
| Store build detection | ✅ `process.windowsStore` shows a "Microsoft Store" badge |
| Telemetry / PII | ✅ no telemetry; board data stays local; GitHub import is user-triggered |
| Minimum OS declared | ✅ Windows 10 1809 (10.0.17763.0), tested to 10.0.26100.0 |
| Architecture | x64 (add `arm64` to `win.target[0].arch` if needed) |

## 2. Values only you can supply

These come from **Partner Center → your app → Product management → Product
identity**. They must match the package exactly or ingestion fails.

| Value | Where it is used | Default in this repo |
| --- | --- | --- |
| `Package/Identity/Name` | `appx.identityName` | `KanbanRepoCards` |
| `Package/Identity/Publisher` | `appx.publisher` (must equal cert subject) | `CN=Michael Daniel` |
| `Package/Properties/PublisherDisplayName` | `appx.publisherDisplayName` | `Michael Daniel` |
| `Package/Applications/Application/@Id` | `appx.applicationId` | `KanbanRepoCards` |

Override them without editing files:

```powershell
$env:APPX_IDENTITY          = '12345Michael.KanbanRepoCards'
$env:APPX_PUBLISHER         = 'CN=1A2B3C4D-1111-2222-3333-444455556666'
$env:APPX_PUBLISHER_DISPLAY = 'Michael Daniel'
$env:APPX_APPLICATION_ID    = 'KanbanRepoCards'
```

`applicationId` stays human-readable (letters/digits, must start with a letter).
`identityName` and `publisher` are the two values that must match Partner Center
verbatim.

## 3. Signing

Store submissions must be signed with a code-signing certificate whose subject
matches `appx.publisher`. Microsoft re-signs the package for distribution, but
the uploaded package still has to be validly signed.

**For local testing only**, create a self-signed certificate:

```powershell
npm run cert:dev
# writes build/dev-cert.pfx and build/dev-cert.cer
```

Trust it for the current user, then install the package:

```powershell
Import-Certificate -FilePath build/dev-cert.cer -CertStoreLocation Cert:\CurrentUser\TrustedPeople
Add-AppxPackage -Path dist\Kanban-Repo-Cards-1.4.0-x64.appx
```

**For submission**, use a certificate from a trusted CA (DigiCert, Sectigo,
SSL.com, Azure Trusted Signing, etc.) and point the build scripts at it:

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-store.ps1 `
  -CertificatePath C:\path\to\store-signing.pfx `
  -CertificatePassword 'pfx-password'
```

`tools/build-store.ps1` sets the Store identity and certificate environment
variables (`APPX_*`, `CSC_LINK`, `CSC_KEY_PASSWORD`) and runs the build. The
installer has an equivalent wrapper: `tools/build-installer.ps1`.

Signing runs through `tools/sign-windows.js`, which calls the Windows SDK's
`signtool.exe` because electron-builder's bundled winCodeSign 2.6.0 signtool
crashes on current Windows builds. Install the Windows 10/11 SDK, or set
`SIGNTOOL_PATH` to an existing `signtool.exe`.

Do **not** commit a real `.pfx`.

> A self-signed certificate is fine for local `Add-AppxPackage` testing after you
> trust it, but use a CA-issued certificate for the actual Store upload.

> `signtool verify /pa` reports "not trusted by the trust provider" for the
> self-signed dev certificate even after importing it into `TrustedPeople` —
> that store authorises package installation, not Authenticode chain building.
> Use `Get-AuthenticodeSignature` to confirm the signer and timestamp.

## 4. Build & verify

```powershell
npm ci
npm run smoke                                   # 97 checks, writes dist/smoke.png
powershell -File tools\build-installer.ps1      # signed NSIS .exe
powershell -File tools\build-store.ps1          # signed .appx
```

Without the wrappers (`npm run dist:exe` / `npm run dist:store`) the artifacts
are unsigned unless `CSC_LINK` and `CSC_KEY_PASSWORD` are already set.

If the build stops with `EBUSY: resource busy or locked` on
`resources\default_app.asar`, an editor or file indexer is holding files open
inside the workspace. Build to a directory outside it and copy the artifacts
back:

```powershell
$out = "$env:TEMP\kanban-build"
npx electron-builder --win nsis --config electron-builder.config.js --config.directories.output=$out
Copy-Item "$out\Kanban-Repo-Cards-Setup-*.exe" dist\
```

Test the MSIX on a clean Windows 10 1809+ / Windows 11 machine:

```powershell
Add-AppxPackage -Path dist\Kanban-Repo-Cards-1.4.0-x64.appx
```

Launch it from the Start menu (not from the dist folder), verify add/remove,
drag between columns, notes, theme, restart persistence, and uninstall.

## 5. Partner Center submission checklist

- [ ] Reserve the app name in Partner Center.
- [ ] Copy **Product identity** values into `APPX_*` environment variables.
- [ ] Set a real signing certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`).
- [ ] Bump `version` in `package.json` for every submission (must increase).
- [ ] `npm run smoke` passes.
- [ ] `npm run dist:store` succeeds and the `.appx` installs on a clean VM.
- [ ] Capture at least one screenshot (1366 × 768 or larger, PNG, no alpha).
- [ ] Store listing: description, short description, keywords, category
      (Productivity), support contact.
- [ ] Privacy policy URL — disclose that manual GitHub import sends the selected
      public username to GitHub; no board content or notes are sent.
- [ ] Age rating questionnaire (no user-generated content, no ads, no purchases).
- [ ] Pricing & availability (free, all markets).
- [ ] Submit the `.appx` (or `.msixupload`) from `dist/` as the package.
- [ ] Complete the "Notes for certification" field: mention it is an Electron
      Desktop Bridge app, data is local, and GitHub import runs only on request.
- [ ] Wait for certification; Store signs and distributes the package.

## 6. Electron-specific notes

- **Updates**: MSIX apps are updated by the Store. There is no auto-updater in
  this app and `electronUpdaterAware: false` is set, so no `app-update.yml` is
  emitted. Do not add `electron-updater` to the Store build.
- **Full trust**: Desktop Bridge apps declare `runFullTrust`; this is expected
  for Electron and is added automatically by electron-builder.
- **Working directory**: never write beside the executable (MSIX installs are
  read-only and virtualized). This app only uses the user profile.
- **Single instance**: `requestSingleInstanceLock()` keeps one window.
- **AppUserModelID**: set only for the standalone build, so the MSIX keeps the
  package identity's AUMID for correct Start-menu/taskbar behaviour.
- **`process.windowsStore`**: `true` in the packaged Store app; the header shows
  a "Microsoft Store" badge.
- **ARM64**: Electron 45 supports Windows on ARM. To ship it, add
  `{ target: 'appx', arch: ['arm64'] }` to `win.target` and build on an arm64
  host or with cross-arch tooling.

## 7. Privacy statement (copy/paste)

> Kanban Repo Cards contains no analytics, advertising, or third-party tracking.
> Repository URLs, notes, and checklist items are stored in the app's local
> profile. When you choose Import on an account column, the app sends that public
> GitHub username to GitHub's API to retrieve public repository links. It does
> not send your board contents or notes.

## 8. Known constraints

- APPX packaging is Windows-only.
- The Store package is x64 by default; the NSIS installer is x64 as well.
- Store ingestion validates the publisher/distinguished name; a mismatch is the
  most common rejection reason.
- `.appx`, `.appxbundle`, `.msix`, `.msixbundle`, `.appxupload` and
  `.msixupload` are accepted by Partner Center for desktop apps. This project
  emits `.appx`.
