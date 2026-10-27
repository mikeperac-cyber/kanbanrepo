[CmdletBinding()]
param(
  [string]$Publisher = 'CN=Michael Daniel',
  [string]$Identity = 'KanbanRepoCards',
  [string]$ApplicationId = 'KanbanRepoCards',
  [string]$PublisherDisplayName = 'Michael Daniel',
  [string]$CertificatePath = 'build/dev-cert.pfx',
  [string]$CertificatePassword = 'kanban-dev'
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$env:APPX_PUBLISHER = $Publisher
$env:APPX_IDENTITY = $Identity
$env:APPX_APPLICATION_ID = $ApplicationId
$env:APPX_PUBLISHER_DISPLAY = $PublisherDisplayName

if (Test-Path $CertificatePath) {
  $env:CSC_LINK = (Resolve-Path $CertificatePath).Path
  $env:CSC_KEY_PASSWORD = $CertificatePassword
  Write-Host "Signing APPX with $CertificatePath"
}
else {
  Write-Warning "No certificate found at $CertificatePath."
  Write-Warning 'The APPX will be unsigned and the Store will reject it.'
  Write-Warning 'Run tools/make-dev-cert.ps1 for local testing, or use a CA-issued certificate.'
}

Write-Host ''
Write-Host "Identity  : $Identity"
Write-Host "Publisher : $Publisher"
Write-Host ''

npm run dist:store
