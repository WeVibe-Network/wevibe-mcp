import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function _blacklist_file(): string {
  const envPath = process.env.WEVIBE_BLACKLIST_PATH;
  if (envPath) return envPath;
  return join(homedir(), '.wevibe', 'blacklist.json');
}

function _blacklist_dir(): string {
  const envPath = process.env.WEVIBE_BLACKLIST_PATH;
  if (envPath) return join(envPath, '..');
  return join(homedir(), '.wevibe');
}

function _load(): Set<string> {
  const file = _blacklist_file();
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      return new Set(data);
    } catch {
      return new Set();
    }
  }
  return new Set();
}

function _save(ids: Set<string>): void {
  mkdirSync(_blacklist_dir(), { recursive: true });
  writeFileSync(_blacklist_file(), JSON.stringify(sorted([...ids]), null, 2));
}

function sorted(arr: string[]): string[] {
  return arr.sort((a, b) => a.localeCompare(b));
}

export function is_blacklisted(pack_id: string): boolean {
  return _load().has(pack_id);
}

export function add_to_blacklist(pack_id: string): boolean {
  const ids = _load();
  if (ids.has(pack_id)) {
    return false;
  }
  ids.add(pack_id);
  _save(ids);
  return true;
}

export function filter_blacklisted(memories: Array<{ pack_id?: string }>): Array<{ pack_id?: string }> {
  const blacklisted = _load();
  if (blacklisted.size === 0) {
    return memories;
  }
  return memories.filter((m) => !blacklisted.has(m.pack_id ?? ''));
}

export function get_blacklist(): string[] {
  return [..._load()];
}
