'use strict';

// Optional desktop toast for spin watch. On WSL this asks Windows PowerShell to
// show a native toast through the built-in WinRT notification API (no modules
// to install). The process is spawned detached and unref'd so the hook never
// waits for it. Clicking the toast opens the Attention Brief filtered to spin.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const POWERSHELL = '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
// Windows PowerShell's own AppUserModelID: always registered, so the toast shows
// without creating a Start-menu shortcut.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const xml = value => String(value == null ? '' : value).replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
const psString = value => `'${String(value).replace(/'/g, "''")}'`;

function toastContent({ source, repo, title, level, reasons, test = false }) {
  const tool = source === 'claude' ? 'Claude Code' : 'Codex';
  const heading = `${test ? '[TEST] ' : ''}Spin ${level === 'alert' ? 'alert' : 'watch'}: ${tool}${repo ? ` · ${repo}` : ''}`;
  const lines = [String(title || 'Untitled session').slice(0, 90), (reasons || []).slice(0, 3).join(' · ').slice(0, 180) || 'Sustained churn-like pattern'];
  if (test) lines[1] = `This is a test notification from burnboard spin watch. ${lines[1]}`.slice(0, 200);
  return { heading, lines };
}
function toastXml(content, url) {
  return `<toast activationType="protocol" launch="${xml(url)}" duration="long"><visual><binding template="ToastGeneric">`
    + `<text>${xml(content.heading)}</text><text>${xml(content.lines[0])}</text><text>${xml(content.lines[1])}</text>`
    + `</binding></visual><actions><action content="Open Attention Brief" activationType="protocol" arguments="${xml(url)}"/></actions></toast>`;
}
function script(toast) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$doc.LoadXml(${psString(toast)})`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psString(APP_ID)}).Show($toast)`,
  ].join('\n');
}
function briefUrl(dashboardUrl) { return `${(dashboardUrl || 'http://localhost:4317').replace(/\/$/, '')}/#running?attention=spin`; }

// Returns { shown: boolean, reason } without waiting for PowerShell.
function showToast(details, { dashboardUrl, powershell = process.env.BURNBOARD_SPIN_POWERSHELL || POWERSHELL, dryRun = false } = {}) {
  const content = toastContent(details);
  const body = script(toastXml(content, briefUrl(dashboardUrl)));
  if (dryRun) return { shown: false, reason: 'dry run', content, script: body };
  if (!fs.existsSync(powershell)) return { shown: false, reason: `PowerShell not found at ${powershell}`, content };
  const encoded = Buffer.from(body, 'utf16le').toString('base64');
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return { shown: true, content };
}

module.exports = { showToast, toastContent, toastXml, briefUrl, POWERSHELL, APP_ID };
