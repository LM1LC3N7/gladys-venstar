// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password and
// the PIN stay in this object only: never logged, never written to /data.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { POLL_INTERVAL } from './constants.js';
import { safeCredential } from './venstar/digest.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  use_https: false,
  username: '',
  password: '',
  pin: '',
  allow_commands: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address typed by the user: an IPv4 address or a host name, with an
 * optional port (80, or 443 with HTTPS, by default).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid.
 */
export function parseAddress(raw, secure = false) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '');
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:@]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? (secure ? 443 : 80) : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

/** The address as the ids and /data name it: "192.168.1.20", or "host:8080" with a port. */
export const addressKey = ({ host, port }, secure) =>
  port === (secure ? 443 : 80) ? host : `${host}:${port}`;

/** Only `true` (or the text "true") turns an option on: anything else, missing included, is off. */
const strictTrue = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const secure = strictTrue(c.use_https);
  const typed = String(c.address ?? '').trim();
  const address = parseAddress(typed, secure);
  const username = typeof c.username === 'string' ? c.username.trim().slice(0, 64) : '';
  const password = typeof c.password === 'string' ? c.password.slice(0, 128) : '';
  // The PIN of the thermostat's screen lock: 1 to 4 digits, sent as 4 (venstarcolortouch zfill).
  const pinText = String(c.pin ?? '').trim();
  const pin = /^\d{1,4}$/.test(pinText) ? pinText.padStart(4, '0') : undefined;
  const interval = Number(c.poll_interval);
  return {
    address,
    key: address ? addressKey(address, secure) : undefined,
    /** What was typed and is not a valid address (shown in the status). */
    invalidAddress: typed !== '' && !address ? typed.slice(0, 60) : undefined,
    secure,
    credentials: username !== '' && password !== '' ? { username, password } : undefined,
    /** A user name that cannot go into the Digest header (a quote, a backslash…). */
    usernameInvalid: username !== '' && !safeCredential(username),
    pin,
    pinInvalid: pinText !== '' && pin === undefined,
    allowCommands: strictTrue(c.allow_commands),
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
