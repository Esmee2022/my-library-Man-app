$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host 'Installing the locked mobile dependencies...'
npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    throw 'Dependency installation failed. Check mobile/package.json and mobile/package-lock.json.'
}

Write-Host 'Starting the Android preview APK build on EAS...'
npx.cmd eas-cli@latest build --platform android --profile preview
if ($LASTEXITCODE -ne 0) {
    throw 'EAS Android build failed. Open the build URL printed above for the detailed logs.'
}
