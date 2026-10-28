// The operating system's own folder dialog, opened by the local server so the board can offer a
// "Choose…" button: a page cannot learn a real folder path from the browser's own picker. Nothing
// from a request reaches the command line; the commands below are fixed.
import { execFile } from 'node:child_process';

const PROMPT = 'Choose a folder for the decision record';
const WINDOWS = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  // an invisible topmost owner keeps the dialog in front of the browser instead of behind it
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  `$dialog.Description = '${PROMPT}'`,
  '$dialog.ShowNewFolderButton = $true',
  "if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.SelectedPath) }",
].join('; ');

// The candidates for one platform, tried in order until one exists.
export function pickerCommands(platform = process.platform) {
  if (platform === 'win32') return [['powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', WINDOWS]]];
  if (platform === 'darwin') return [['osascript', ['-e', `try\n  return POSIX path of (choose folder with prompt "${PROMPT}")\non error message number code\n  if code is -128 then return ""\n  error message number code\nend try`]]];
  return [['zenity', ['--file-selection', '--directory', `--title=${PROMPT}`]], ['kdialog', ['--getexistingdirectory', '.', '--title', PROMPT]]];
}

const execute = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 10 * 60_000, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

// The chosen folder, or null when the person cancels. Throws when this machine has no dialog to
// offer, with what to do instead.
export async function pickFolder({ platform = process.platform, run = execute } = {}) {
  for (const [file, args] of pickerCommands(platform)) {
    const { error, stdout = '', stderr = '' } = await run(file, args);
    if (error?.code === 'ENOENT') continue; // not installed: try the next one
    if (error?.killed) throw Object.assign(new Error('The folder dialog timed out. Type the folder path instead.'), { status: 504 });
    // Windows cancels with empty successful output; AppleScript handles -128 above. The Linux
    // pickers use status 1 for cancellation. Display or execution failures carry stderr.
    const cancelled = ['zenity', 'kdialog'].includes(file) && error?.code === 1 && !stderr.trim() && !stdout.trim();
    if (error && !cancelled) throw Object.assign(new Error('The folder dialog could not open or finish. Type the folder path instead.'), { status: 503 });
    const out = stdout.trim();
    if (!out) return null;
    // drop a trailing separator (macOS adds one), except on a drive or filesystem root
    return /^([A-Za-z]:)?[\\/]$/.test(out) ? out : out.replace(/[\\/]+$/, '');
  }
  throw Object.assign(new Error('No folder dialog is available on this machine. Type the folder path instead.'), { status: 501 });
}
