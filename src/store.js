// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), readable by the container user only (0600), in one file
// rewritten as it changes (temporary file, fsync, rename):
//   venstar-state.json:
//     salt          random, for the fingerprints of refused secrets below;
//     targets       per address typed ("http://192.168.1.20", "https://…"),
//                   4 at most:
//       attemptAt          the time of the last read attempt (written before
//                          the read, at most once a minute: a restart never
//                          reads sooner than the interval);
//       certificate        the SHA-256 fingerprint of the certificate pinned
//                          at the first HTTPS connection (written before the
//                          password leaves);
//       refusedCertificate the last other certificate met, for "Accept the
//                          change";
//       identity           the model, type and name read the first time (the
//                          name completed at the first read showing it; a
//                          thermostat swapped at the address is told apart);
//       refusedIdentity    the last other identity met, for "Accept the change";
//       refusedCredentials a salted fingerprint of the user name and password
//                          answered 401 to a fresh Digest challenge (cleared at
//                          the first success);
//       pinRefused         a simple marker (no fingerprint: a 4-digit PIN is
//                          too easy to find back from one), cleared when the
//                          PIN changes or a command with it succeeds;
//       pinTag             with it, ONE hex character of a salted SHA-256 of
//                          the refused PIN: tells a PIN changed while the
//                          container was stopped (15 times out of 16), far
//                          too little to find a PIN back;
//       pausedUntil        the end of a pause after HTTP 429 / 5xx.
// Never a password, a PIN or a user name in clear.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { normalizeFingerprint } from './venstar/http.js';

export const STATE_FILE = '/data/venstar-state.json';
const MAX_TARGETS = 4;

const TARGET = /^https?:\/\/[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const HASH = /^[0-9a-f]{64}$/;
const SALT = /^[0-9a-f]{32}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A file written whole or not at all: temporary file, fsync, rename. */
async function writeDurably(path, text) {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 64 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(() => writeDurably(path, text));
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trips as the file; `failing` refuses every save. */
export function memoryStore(initial = null, { failing = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** A salted fingerprint of a refused secret (never stored for an accepted one). */
export const secretHash = (salt, ...parts) =>
  createHash('sha256')
    .update(`${salt}\u0000${parts.join('\u0000')}`, 'utf8')
    .digest('hex');

const identityOf = (value) => {
  if (!isObject(value)) {
    return undefined;
  }
  const field = (key) => {
    const v = own(value, key);
    return typeof v === 'string' && v.length <= 40 ? v : undefined;
  };
  const model = field('model');
  return model === undefined ? undefined : { model, type: field('type'), name: field('name') };
};

export const emptyTarget = () => ({
  attemptAt: 0,
  certificate: undefined,
  refusedCertificate: undefined,
  identity: undefined,
  refusedIdentity: undefined,
  refusedCredentials: undefined,
  pinRefused: false,
  pinTag: undefined,
  pausedUntil: 0,
});

/**
 * The persisted state, repaired and bounded: only known keys of the expected
 * shape (never an inherited or `__proto__` key). A time "in the future" (a
 * clock set back) counts as now; a pause is at most 6 h from now.
 */
export function normalizeMemory(raw, now, maxPause) {
  const salt = own(raw, 'salt');
  const targets = new Map();
  const rawTargets = own(raw, 'targets');
  if (isObject(rawTargets)) {
    for (const key of Object.keys(rawTargets).slice(0, MAX_TARGETS * 2)) {
      const entry = own(rawTargets, key);
      if (!TARGET.test(key) || !isObject(entry) || targets.size >= MAX_TARGETS) {
        continue;
      }
      const attemptAt = own(entry, 'attemptAt');
      const pausedUntil = own(entry, 'pausedUntil');
      const hash = (k) => {
        const v = own(entry, k);
        return typeof v === 'string' && HASH.test(v) ? v : undefined;
      };
      targets.set(key, {
        attemptAt: Number.isFinite(attemptAt) && attemptAt > 0 ? Math.min(attemptAt, now) : 0,
        certificate: normalizeFingerprint(own(entry, 'certificate')),
        refusedCertificate: normalizeFingerprint(own(entry, 'refusedCertificate')),
        identity: identityOf(own(entry, 'identity')),
        refusedIdentity: identityOf(own(entry, 'refusedIdentity')),
        refusedCredentials: hash('refusedCredentials'),
        pinRefused: own(entry, 'pinRefused') === true,
        pinTag:
          typeof own(entry, 'pinTag') === 'string' && /^[0-9a-f]$/.test(own(entry, 'pinTag'))
            ? own(entry, 'pinTag')
            : undefined,
        pausedUntil:
          Number.isFinite(pausedUntil) && pausedUntil > now
            ? Math.min(pausedUntil, now + maxPause)
            : 0,
      });
    }
  }
  return {
    salt: typeof salt === 'string' && SALT.test(salt) ? salt : randomBytes(16).toString('hex'),
    targets,
  };
}

/** The persisted form (plain objects of validated keys only). */
export function serializeMemory(memory) {
  const targets = {};
  for (const [key, t] of memory.targets) {
    const entry = { attemptAt: t.attemptAt };
    for (const field of [
      'certificate',
      'refusedCertificate',
      'identity',
      'refusedIdentity',
      'refusedCredentials',
    ]) {
      if (t[field] !== undefined) {
        entry[field] = t[field];
      }
    }
    if (t.pinRefused) {
      entry.pinRefused = true;
      if (t.pinTag !== undefined) {
        entry.pinTag = t.pinTag;
      }
    }
    if (t.pausedUntil > 0) {
      entry.pausedUntil = t.pausedUntil;
    }
    targets[key] = entry;
  }
  return { salt: memory.salt, targets };
}
