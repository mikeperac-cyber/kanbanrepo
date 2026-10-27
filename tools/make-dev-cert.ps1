[CmdletBinding()]
param(
  [string]$Subject = 'CN=Michael Daniel',
  [string]$Password = 'kanban-dev',
  [string]$PfxPath = 'build/dev-cert.pfx'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Creating/using a self-signed code-signing certificate for local APPX testing."

$cert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $cert) {
  $cert = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $Subject `
    -KeyUsage DigitalSignature `
    -FriendlyName 'Kanban Repo Cards development signing' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddYears(2) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
  Write-Host "Created certificate $($cert.Thumbprint)"
}
else {
  Write-Host "Reusing certificate $($cert.Thumbprint)"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PfxPath) | Out-Null
$secure = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $PfxPath -Password $secure | Out-Null

$cerPath = [System.IO.Path]::ChangeExtension($PfxPath, '.cer')
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

Write-Host ''
Write-Host "PFX : $PfxPath"
Write-Host "CER : $cerPath"
Write-Host ''
Write-Host 'To install the development package locally, trust the certificate first:'
Write-Host "  Import-Certificate -FilePath `"$cerPath`" -CertStoreLocation Cert:\CurrentUser\TrustedPeople"
Write-Host ''
Write-Host 'Then install:'
Write-Host '  Add-AppxPackage -Path dist\Kanban-Repo-Cards-1.4.0-x64.appx'
