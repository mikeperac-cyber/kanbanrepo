[CmdletBinding()]
param(
  [string]$CertificatePath = 'build/dev-cert.pfx',
  [string]$CertificatePassword = 'kanban-dev'
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (Test-Path $CertificatePath) {
  $env:CSC_LINK = (Resolve-Path $CertificatePath).Path
  $env:CSC_KEY_PASSWORD = $CertificatePassword
  Write-Host "Signing the installer with $CertificatePath"
}
else {
  Write-Warning "No certificate found at $CertificatePath."
  Write-Warning 'The installer will be unsigned.'
  Write-Warning 'Use a CA-issued certificate for distribution, or run tools/make-dev-cert.ps1 for local testing.'
}

Write-Host ''
npm run dist:exe
