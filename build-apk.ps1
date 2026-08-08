# Thakkar Medico App - APK Builder & Multi-Exporter PowerShell Script
param (
    [string]$Type = "release",
    [switch]$Clean,
    [switch]$NoDownloads
)

$scriptPath = Join-Path $PSScriptRoot "scripts\build-apk.js"
$argsList = @($Type)

if ($Clean) { $argsList += "--clean" }
if ($NoDownloads) { $argsList += "--no-downloads" }

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  Thakkar Medico App - APK Builder & Multi-Exporter" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

node $scriptPath @argsList

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] APK Build failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
} else {
    Write-Host "[SUCCESS] APK Build and multi-output distribution complete!" -ForegroundColor Green
}
