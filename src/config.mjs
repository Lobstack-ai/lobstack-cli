/**
 * Where the key lives, and why it lives there.
 *
 * `~/.lobstack/config.json`, mode 0600, created with mode 0700 on the
 * directory. Not an environment variable in a dotfile the user has to remember
 * to gitignore, and not a keychain — a keychain would be better and it would
 * also mean a native dependency, which would mean `npx lobstack` stops being
 * instant. LOBSTACK_API_KEY still wins when set, because CI has no home
 * directory worth writing to.
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.lobstack');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** The host that answers without a redirect. See the note in `resolveBase`. */
export const DEFAULT_BASE = 'https://www.lobstack.ai';

export function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(next) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  // mkdir's mode is masked by umask, and writeFile's mode is ignored when the
  // file already exists. Both are silent, and both leave a credential
  // world-readable, so set them again explicitly.
  try {
    chmodSync(CONFIG_DIR, 0o700);
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* Windows has no POSIX modes; the ACL default is per-user already */
  }
}

export function resolveKey() {
  return process.env.LOBSTACK_API_KEY || readConfig().key || null;
}

/**
 * Normalise a base URL, and refuse the one that silently breaks auth.
 *
 * `lobstack.ai` 307s to `www.lobstack.ai`, and RFC 9110 requires a client to
 * drop `Authorization` across a host change. A user who types the bare apex
 * here gets "missing credentials" while holding a perfectly good key — which is
 * exactly the failure that made the Gateway look broken for three months. So it
 * is corrected, out loud, rather than honoured.
 */
export function resolveBase(explicit) {
  const raw = explicit || process.env.LOBSTACK_BASE_URL || readConfig().baseUrl || DEFAULT_BASE;
  const url = new URL(raw);
  if (url.hostname === 'lobstack.ai') {
    url.hostname = 'www.lobstack.ai';
    return { base: url.origin, corrected: true };
  }
  return { base: url.origin.replace(/\/+$/, ''), corrected: false };
}

export const gatewayUrl = (base, path) => `${base}/api/gateway/v1${path}`;
