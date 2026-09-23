import path from 'node:path';

const MAX_FILENAME_LENGTH = 200;

/**
 * Reduce a client-supplied filename to a safe basename: no directories, no control or reserved
 * characters, no leading dots. The result is only ever used as a display name for Telegram —
 * files are written to disk under server-generated names — but we sanitize defensively anyway.
 */
export function sanitizeFilename(input: string | undefined | null, fallback = 'backup.bin'): string {
  if (!input) return fallback;
  let name = input.normalize('NFKC');
  name = name.split(/[\\/]/).pop() ?? '';
  name = name
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!name || name === '.' || name === '..') return fallback;
  if (name.length > MAX_FILENAME_LENGTH) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  return name;
}

/** Guard against path traversal: the resolved path must stay inside `baseDir`. */
export function resolveInside(baseDir: string, fileName: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, fileName);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Path escapes base directory');
  }
  return resolved;
}
