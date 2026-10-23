// -----------------------------------------------------------------------------
// A fake Venstar thermostat behind the `open` transport of the app: the
// documented local API (GET /, /query/info, /query/sensors, /query/alerts,
// POST /control), optional Digest authentication, an optional screen PIN,
// a certificate fingerprint for HTTPS, and knobs for the failures. Answers
// come after `latency` ms of the (mocked) timers.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { VenstarError, ERROR_KINDS } from '../../src/venstar/http.js';

export const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);
export const HOST = '192.168.1.20';
export const FP1 = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(
  ':',
);
export const FP2 = Array.from({ length: 32 }, (_, i) => (i + 100).toString(16).toUpperCase()).join(
  ':',
);

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const md5 = (text) => createHash('md5').update(text).digest('hex');

export function thermostat(overrides = {}) {
  return {
    root: { api_ver: 7, type: 'residential', model: 'COLORTOUCH', firmware: '6.10' },
    info: {
      name: 'Upstairs',
      mode: 1,
      state: 1,
      fan: 0,
      fanstate: 1,
      tempunits: 1,
      schedule: 0,
      away: 0,
      spacetemp: 20.5,
      heattemp: 21,
      cooltemp: 25,
      heattempmin: 4.5,
      heattempmax: 32,
      cooltempmin: 10,
      cooltempmax: 37,
      setpointdelta: 2,
      availablemodes: 0,
      hum_setpoint: 30,
      dehum_setpoint: 60,
      ...(overrides.info ?? {}),
    },
    sensors: overrides.sensors ?? {
      sensors: [
        { name: 'Thermostat', type: 'Local', temp: 20.5, hum: 41 },
        { name: 'Outdoor', type: 'Outdoor', temp: 3.5 },
      ],
    },
    alerts: overrides.alerts ?? {
      alerts: [
        { name: 'Air Filter', active: false },
        { name: 'UV Lamp', active: false },
        { name: 'Service', active: false },
      ],
    },
    auth: overrides.auth,
    pin: overrides.pin,
    fingerprint: overrides.fingerprint ?? FP1,
    ...(overrides.root ? { root: overrides.root } : {}),
  };
}

/**
 * The fake network. `t.unreachable`: nothing answers; `t.latency`: ms before
 * each answer; `t.silent`: a set of "METHOD path" left unanswered; `t.status`:
 * "METHOD path" -> an HTTP status (with `t.headers`); `t.ignoreControl`:
 * /control answers success without applying.
 */
export function fakeNetwork(device = thermostat()) {
  const net = {
    device,
    connections: 0,
    requests: [],
    opened: [],
    unreachable: false,
    latency: 0,
    /** "METHOD path" -> ms before its answer (overrides `latency`). */
    delays: new Map(),
    silent: new Set(),
    status: new Map(),
    headers: {},
    ignoreControl: false,
    nonce: 'n0',
    open({ host, port, secure, timeoutMs }) {
      net.opened.push({ host, port, secure });
      if (net.unreachable) {
        return new Promise((_, reject) =>
          setTimeout(
            () => reject(new VenstarError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout')),
            Math.min(timeoutMs, 1000),
          ),
        );
      }
      net.connections += 1;
      return Promise.resolve(net.connection(secure));
    },
    connection(secure) {
      let closed = false;
      return {
        fingerprint: secure ? net.device.fingerprint : undefined,
        get closed() {
          return closed;
        },
        close() {
          closed = true;
        },
        request({ method = 'GET', path, headers = {}, body, timeoutMs, beforeSend }) {
          return new Promise((resolve, reject) => {
            if (closed) {
              reject(new VenstarError(ERROR_KINDS.CLOSED, 'Connection closed', { notSent: true }));
              return;
            }
            try {
              beforeSend?.();
            } catch (err) {
              reject(Object.assign(err, { notSent: true, beforeSend: true }));
              return;
            }
            const entry = { method, path, body, auth: Boolean(headers.Authorization), secure };
            net.requests.push(entry);
            const key = `${method} ${path}`;
            const timer = setTimeout(
              () => {
                closed = true;
                reject(new VenstarError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout'));
              },
              Math.max(1, timeoutMs),
            );
            if (net.silent.has(key)) {
              return;
            }
            const answer = () => {
              clearTimeout(timer);
              if (closed) {
                return;
              }
              resolve(net.answer(method, path, headers, body));
            };
            const delay = net.delays.get(key) ?? net.latency;
            if (delay > 0) {
              setTimeout(answer, delay);
            } else {
              answer();
            }
          });
        },
      };
    },
    answer(method, path, headers, body) {
      const key = `${method} ${path}`;
      if (net.status.has(key)) {
        return { status: net.status.get(key), headers: net.headers, body: '' };
      }
      const auth = net.device.auth;
      if (auth) {
        const header = headers.Authorization;
        const challenge = {
          status: 401,
          headers: {
            'www-authenticate': `Digest realm="venstar", nonce="${net.nonce}", qop="auth"`,
          },
          body: '',
        };
        if (!header) {
          return challenge;
        }
        const fields = Object.fromEntries(
          [...header.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]),
        );
        const ha1 = md5(`${fields.username}:venstar:${auth.password}`);
        const ha2 = md5(`${method}:${path}`);
        const expected = md5(`${ha1}:${net.nonce}:${fields.nc}:${fields.cnonce}:auth:${ha2}`);
        if (
          fields.username !== auth.username ||
          fields.nonce !== net.nonce ||
          fields.response !== expected
        ) {
          return challenge;
        }
      }
      const json = (value) => ({ status: 200, headers: {}, body: JSON.stringify(value) });
      const d = net.device;
      if (method === 'GET' && path === '/') return json(d.root);
      if (method === 'GET' && path === '/query/info') return json(d.info);
      if (method === 'GET' && path === '/query/sensors') return json(d.sensors);
      if (method === 'GET' && path === '/query/alerts') return json(d.alerts);
      if (method === 'POST' && path === '/control') {
        const form = Object.fromEntries(new URLSearchParams(body ?? ''));
        if (d.pin && form.pin !== d.pin) {
          return json({ error: true, reason: 'Invalid PIN' });
        }
        if (form.heattemp !== undefined || form.cooltemp !== undefined) {
          if (form.heattemp === undefined || form.cooltemp === undefined) {
            return json({ error: true, reason: 'Both Setpoints are required' });
          }
        }
        if (!net.ignoreControl) {
          if (form.mode !== undefined) d.info.mode = Number(form.mode);
          if (form.fan !== undefined) d.info.fan = Number(form.fan);
          if (form.heattemp !== undefined) d.info.heattemp = Number(form.heattemp);
          if (form.cooltemp !== undefined) d.info.cooltemp = Number(form.cooltemp);
        }
        return json({ success: true });
      }
      return { status: 404, headers: {}, body: '' };
    },
    /** The requests of a path, by method. */
    paths() {
      return net.requests.map((r) => `${r.method} ${r.path}`);
    },
    controls() {
      return net.requests
        .filter((r) => r.method === 'POST')
        .map((r) => Object.fromEntries(new URLSearchParams(r.body)));
    },
  };
  return net;
}
