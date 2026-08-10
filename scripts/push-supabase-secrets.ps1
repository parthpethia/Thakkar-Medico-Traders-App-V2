# =============================================================================
# Push Supabase Secrets & Deploy Edge Functions Script
# Reads secrets dynamically from .env file (Safe for GitHub push)
# =============================================================================

param(
  [string]$AccessToken = $env:SUPABASE_ACCESS_TOKEN,
  [string]$ProjectRef = "glsedwmswfhnmvuabrbh"
)

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Supabase Secrets & Edge Functions Deployment Tool" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

if (-not $AccessToken) {
  Write-Host "Please enter your Supabase Personal Access Token (from https://supabase.com/dashboard/account/tokens):" -ForegroundColor Yellow
  $AccessToken = Read-Host -Prompt "Access Token (sbp_...)"
}

if (-not $AccessToken) {
  Write-Error "Supabase Access Token is required to authenticate with Supabase API."
  exit 1
}

$env:SUPABASE_ACCESS_TOKEN = $AccessToken

# Load .env file
$envPath = Join-Path $PSScriptRoot "..\.env"
if (-not (Test-Path $envPath)) {
  Write-Error "Could not find .env file at $envPath"
  exit 1
}

Write-Host "`n1. Setting Supabase Edge Function Secrets from .env for project: $ProjectRef..." -ForegroundColor Green

npx supabase secrets set --project-ref $ProjectRef --env-file $envPath

if ($LASTEXITCODE -eq 0) {
  Write-Host "✅ Secrets successfully synced to Supabase project $ProjectRef!" -ForegroundColor Green
} else {
  Write-Host "⚠️ Error syncing secrets via CLI. Please verify your access token permissions." -ForegroundColor Red
}

Write-Host "`n2. Deploying Edge Functions..." -ForegroundColor Green

$functions = @(
  "extract-invoice",
  "batch-geocode-fallback-locations",
  "create-razorpay-order",
  "razorpay-webhook",
  "send-delivery-otp",
  "notify-order-status",
  "notify-canary-alert",
  "detect-pin-drift",
  "generate-invoice",
  "generate-statement"
)

foreach ($fn in $functions) {
  Write-Host "  -> Deploying $fn..." -ForegroundColor Cyan
  npx supabase functions deploy $fn --project-ref $ProjectRef --no-verify-jwt
}

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "  Deployment Completed!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
