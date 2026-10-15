# Run from project root: web_Conji_native_2.0
$ErrorActionPreference = "Stop"

Write-Host "[1/3] Removing BOM from JSON files..."
Get-ChildItem -Recurse -Include *.json -File |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\.npm-cache\\' } |
  ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      [System.IO.File]::WriteAllBytes($_.FullName, $bytes[3..($bytes.Length - 1)])
      Write-Host "Removed BOM:" $_.FullName
    }
  }

Write-Host "[2/3] Checking buttons..."
node scripts\check-buttons.mjs

Write-Host "[3/3] Building web app..."
Push-Location apps\web
npm run build
Pop-Location
