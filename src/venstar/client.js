// -----------------------------------------------------------------------------
// One session with the thermostat: the connection (opened again if the
// thermostat closed it, 3 at most per session), the certificate checked on
// every connection BEFORE anything is written, the Digest answer to a 401
// (HTTPS only: never a password over plain HTTP), and the JSON of the answer.
// Every request has its own time limit; a command passes `beforeSend`, run
// right before its bytes are written (and again before an authenticated
// retry). The answers are bounded (http.js); nothing of an answer is ever put
// in an error message.
// -----------------------------------------------------------------------------

import { digestHeader, parseChallenge, safeCredential } from './digest.js';
import { ERROR_KINDS, VenstarError, openConnection } from './http.js';
import { parseJson } from './model.js';

const MAX_CONNECTIONS = 3;

/**
 * The delay a 429 / 503 asks for, in ms: seconds, or an HTTP date compared
 * with the thermostat's own `Date` header (never with our clock); undefined
 * when neither can be read.
 */
export function retryAfterMs(headers) {
  const value = String(headers?.['retry-after'] ?? '').trim();
  if (/^\d{1,7}$/.test(value)) {
    return Number(value) * 1000;
  }
  const at = Date.parse(value);
  const date = Date.parse(String(headers?.date ?? ''));
  if (Number.isFinite(at) && Number.isFinite(date)) {
    return Math.max(0, at - date);
  }
  return undefined;
}

export class Session {
  /**
   * @param {object} options
   * @param {{ host: string, port: number }} options.address
   * @param {boolean} options.secure HTTPS
   * @param {{ username: string, password: string } | undefined} options.credentials
   * @param {(fingerprint: string) => Promise<void>} options.checkCertificate throws to refuse
   * @param {Function} [options.open] the transport (tests inject a fake thermostat)
   */
  constructor({ address, secure, credentials, checkCertificate, open = openConnection }) {
    this.address = address;
    this.secure = secure;
    this.credentials =
      secure &&
      credentials &&
      safeCredential(credentials.username) &&
      safeCredential(credentials.password) &&
      credentials.username !== ''
        ? credentials
        : undefined;
    this.checkCertificate = checkCertificate;
    this.open = open;
    this.connection = undefined;
    this.opened = 0;
    this.challenge = undefined;
    this.count = 0;
    this.closed = false;
  }

  close() {
    this.closed = true;
    this.connection?.close();
    this.connection = undefined;
  }

  /** The connection of the session, opened (and its certificate checked) if needed. */
  async connect(timeoutMs) {
    if (this.closed) {
      throw new VenstarError(ERROR_KINDS.ABORTED, 'Session closed', { notSent: true });
    }
    if (this.connection && !this.connection.closed) {
      return this.connection;
    }
    if (this.opened >= MAX_CONNECTIONS) {
      throw new VenstarError(ERROR_KINDS.PROTOCOL, 'Too many connections', { notSent: true });
    }
    this.opened += 1;
    const connection = await this.open({
      host: this.address.host,
      port: this.address.port,
      secure: this.secure,
      timeoutMs,
    });
    if (this.closed) {
      connection.close();
      throw new VenstarError(ERROR_KINDS.ABORTED, 'Session closed', { notSent: true });
    }
    if (this.secure) {
      try {
        await this.checkCertificate(connection.fingerprint);
      } catch (err) {
        connection.close();
        throw err;
      }
    }
    this.connection = connection;
    return connection;
  }

  authorization(method, path) {
    if (!this.challenge || !this.credentials) {
      return undefined;
    }
    this.count += 1;
    return digestHeader({
      username: this.credentials.username,
      password: this.credentials.password,
      method,
      uri: path,
      challenge: this.challenge,
      count: this.count,
    });
  }

  /**
   * One request; resolves the JSON object of a 200 answer.
   * @param {{ method?: string, path: string, body?: string, timeoutMs: () => number,
   *   beforeSend?: () => void }} options `timeoutMs` is read before each step
   */
  async request({ method = 'GET', path, body, timeoutMs, beforeSend }) {
    let answer;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connection = await this.connect(timeoutMs());
      const authorization = this.authorization(method, path);
      answer = await connection.request({
        method,
        path,
        body,
        headers: authorization ? { Authorization: authorization } : {},
        timeoutMs: timeoutMs(),
        beforeSend,
      });
      if (answer.status !== 401) {
        break;
      }
      // A 401 is an answer: the request was not applied.
      const challenge = parseChallenge(answer.headers?.['www-authenticate']);
      if (!challenge || !this.credentials) {
        throw new VenstarError(ERROR_KINDS.AUTH_NEEDED, 'A password is asked', {
          notSent: true,
          status: 401,
        });
      }
      const stale = String(challenge.get('stale') ?? '').toLowerCase() === 'true';
      if (authorization && !stale) {
        throw new VenstarError(ERROR_KINDS.AUTH, 'Credentials refused', {
          notSent: true,
          status: 401,
        });
      }
      this.challenge = challenge;
      this.count = 0;
    }
    const { status, headers } = answer;
    if (status === 401) {
      throw new VenstarError(ERROR_KINDS.AUTH, 'Credentials refused', {
        notSent: true,
        status: 401,
      });
    }
    if (status === 429 || (status >= 500 && status <= 599)) {
      // 429 and 503 say the request was not taken; another 5xx may have been applied.
      throw new VenstarError(ERROR_KINDS.BUSY, `HTTP ${status}`, {
        notSent: status === 429 || status === 503,
        status,
        retryAfter: retryAfterMs(headers),
      });
    }
    if (status !== 200) {
      // A 403 may come from a PIN or a lock: not a refused password.
      throw new VenstarError(ERROR_KINDS.HTTP, `HTTP ${status}`, {
        status,
        notSent: status >= 300 && status < 500,
      });
    }
    const json = parseJson(answer.body);
    if (!json) {
      throw new VenstarError(ERROR_KINDS.PROTOCOL, 'Not a JSON object');
    }
    return json;
  }
}
