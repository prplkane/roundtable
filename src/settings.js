// Preserve unreadable settings until the user repairs them and restarts the server.
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function createSettingsStore(file, { onError = () => {} } = {}) {
  let value = {}, unreadable = false;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a settings object.');
  } catch (error) {
    value = {};
    if (error.code !== 'ENOENT') { unreadable = true; onError(error); }
  }
  return {
    value,
    save(next) {
      if (unreadable) throw Object.assign(new Error(`${path.basename(file)} was unreadable at startup. Restore it and restart before saving; the original has not been changed.`), { code: 'SETTINGS_UNREADABLE', status: 409 });
      if (existsSync(file) && statSync(file).isDirectory()) throw Object.assign(new Error('The settings target is a directory.'), { code: 'EISDIR' });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600, flush: true });
        renameSync(temporary, file);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    },
  };
}
