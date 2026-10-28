import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFolder, pickerCommands } from '../src/folder-picker.js';

test('each platform opens its own folder dialog with a fixed command', () => {
  assert.equal(pickerCommands('win32')[0][0], 'powershell.exe');
  assert.equal(pickerCommands('darwin')[0][0], 'osascript');
  assert.deepEqual(pickerCommands('linux').map(([file]) => file), ['zenity', 'kdialog']);
});

test('the chosen folder comes back, a cancel is null, and a missing dialog falls through or explains', async () => {
  const say = (stdout, error = null) => async () => ({ stdout, error });
  assert.equal(await pickFolder({ platform: 'win32', run: say('C:\\code\\clinic\\decisions\r\n') }), 'C:\\code\\clinic\\decisions');
  assert.equal(await pickFolder({ platform: 'darwin', run: say('/Users/u/code/decisions/\n') }), '/Users/u/code/decisions', 'the trailing slash goes');
  assert.equal(await pickFolder({ platform: 'win32', run: say('C:\\') }), 'C:\\', 'except on a drive root');
  assert.equal(await pickFolder({ platform: 'darwin', run: say('') }), null, 'cancel');
  const tried = [];
  const linux = async (file) => { tried.push(file); return file === 'zenity' ? { stdout: '', error: { code: 'ENOENT' } } : { stdout: '/home/u/decisions\n', error: null }; };
  assert.equal(await pickFolder({ platform: 'linux', run: linux }), '/home/u/decisions');
  assert.deepEqual(tried, ['zenity', 'kdialog'], 'zenity missing, kdialog used');
  await assert.rejects(pickFolder({ platform: 'linux', run: say('', { code: 'ENOENT' }) }), (e) => e.status === 501 && /Type the folder path/.test(e.message));
});


test('folder picker distinguishes cancellation from timeouts and launch failures', async () => {
  const run = (error, stderr = '', stdout = '') => async () => ({ error, stderr, stdout });
  for (const platform of ['win32', 'darwin', 'linux']) {
    await assert.rejects(pickFolder({ platform, run: run({ killed: true, signal: 'SIGTERM' }) }),
      (e) => e.status === 504 && /timed out.*Type the folder path/i.test(e.message));
    await assert.rejects(pickFolder({ platform, run: run({ code: 'EACCES' }) }),
      (e) => e.status === 503 && /Type the folder path/.test(e.message));
  }
  assert.equal(await pickFolder({ platform: 'linux', run: run({ code: 1 }) }), null, 'documented cancel status');
  await assert.rejects(pickFolder({ platform: 'linux', run: run({ code: 1 }, 'cannot open display') }), /Type the folder path/);
  await assert.rejects(pickFolder({ platform: 'darwin', run: run({ code: 1 }, 'execution error') }), /Type the folder path/);
  await assert.rejects(pickFolder({ platform: 'win32', run: run({ code: 1 }, '', 'partial output') }), /Type the folder path/);
});
