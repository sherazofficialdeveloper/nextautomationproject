const { execSync } = require('child_process');
const start = Date.now();
const ps = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*acc_130_chrome*' } | Select-Object -ExpandProperty ProcessId`;
const enc = Buffer.from(ps, 'utf16le').toString('base64');
try {
  const out = execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${enc}`, { timeout: 3000 }).toString().trim();
  console.log('Filtered query took:', Date.now() - start, 'ms, found:', out || 'none');
} catch (e) {
  console.error('Err:', e.message);
}

