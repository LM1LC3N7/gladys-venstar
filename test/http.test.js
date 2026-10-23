// -----------------------------------------------------------------------------
// The transport against REAL local servers on the loopback (plain HTTP and
// HTTPS with a self-signed certificate): one connection per session, the
// certificate checked before any byte is written, the Digest answer on the
// verified connection only, bounded answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Session, retryAfterMs } from '../src/venstar/client.js';
import { digestHeader, parseChallenge } from '../src/venstar/digest.js';
import { AnswerParser, ERROR_KINDS, VenstarError, openConnection } from '../src/venstar/http.js';
import { selfSigned } from './helpers/selfSigned.js';

const md5 = (text) => createHash('md5').update(text).digest('hex');
const ROOT = { api_ver: 7, type: 'residential', model: 'COLORTOUCH', firmware: '6.10' };

/** A local thermostat: counts its connections and requests; Digest when `auth`. */
async function server(t, { secure = false, auth, handler } = {}) {
  const { key, cert } = selfSigned('venstar', 1);
  const stats = { connections: 0, requests: [], authorizations: [] };
  const onRequest = (req, res) => {
    stats.requests.push(`${req.method} ${req.url}`);
    stats.authorizations.push(req.headers.authorization);
    if (auth) {
      const header = req.headers.authorization ?? '';
      const f = Object.fromEntries(
        [...header.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]),
      );
      const ha1 = md5(`${auth.username}:venstar:${auth.password}`);
      const expected = md5(
        `${ha1}:abc:${f.nc}:${f.cnonce}:auth:${md5(`${req.method}:${req.url}`)}`,
      );
      if (f.response !== expected) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Digest realm="venstar", nonce="abc", qop="auth"',
        });
        res.end();
        return;
      }
    }
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ROOT));
  };
  const srv = secure ? https.createServer({ key, cert }, onRequest) : http.createServer(onRequest);
  srv.on(secure ? 'secureConnection' : 'connection', () => {
    stats.connections += 1;
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    srv.closeAllConnections?.();
    srv.close();
  });
  return {
    port: srv.address().port,
    stats,
    fingerprint: new X509Certificate(cert).fingerprint256,
  };
}

const timeoutMs = () => 2000;

test('plain HTTP: the requests of a session share one connection, no Authorization', async (t) => {
  const s = await server(t);
  const session = new Session({
    address: { host: '127.0.0.1', port: s.port },
    secure: false,
    credentials: { username: 'admin', password: 'pw' },
    checkCertificate: async () => assert.fail('no certificate on plain HTTP'),
  });
  assert.deepEqual(await session.request({ path: '/', timeoutMs }), ROOT);
  assert.deepEqual(await session.request({ path: '/query/info', timeoutMs }), ROOT);
  session.close();
  assert.equal(s.stats.connections, 1);
  assert.deepEqual(s.stats.requests, ['GET /', 'GET /query/info']);
  assert.ok(s.stats.authorizations.every((a) => a === undefined));
});

test('plain HTTP asking a password: AUTH_NEEDED, the password never sent', async (t) => {
  const s = await server(t, { auth: { username: 'admin', password: 'pw' } });
  const session = new Session({
    address: { host: '127.0.0.1', port: s.port },
    secure: false,
    credentials: { username: 'admin', password: 'pw' },
  });
  await assert.rejects(session.request({ path: '/', timeoutMs }), {
    kind: ERROR_KINDS.AUTH_NEEDED,
  });
  session.close();
  assert.ok(s.stats.authorizations.every((a) => a === undefined));
});

test('HTTPS: the certificate checked first, Digest on the same connection', async (t) => {
  const s = await server(t, { secure: true, auth: { username: 'admin', password: 'pw' } });
  const seen = [];
  const session = new Session({
    address: { host: '127.0.0.1', port: s.port },
    secure: true,
    credentials: { username: 'admin', password: 'pw' },
    checkCertificate: async (fingerprint) => {
      // Nothing was written before the check.
      assert.equal(s.stats.requests.length, 0);
      seen.push(fingerprint);
    },
  });
  assert.deepEqual(await session.request({ path: '/', timeoutMs }), ROOT);
  assert.deepEqual(await session.request({ path: '/query/info', timeoutMs }), ROOT);
  session.close();
  assert.deepEqual(seen, [s.fingerprint]);
  assert.equal(s.stats.connections, 1);
  assert.deepEqual(s.stats.requests, ['GET /', 'GET /', 'GET /query/info']);
  assert.equal(s.stats.authorizations[0], undefined);
  assert.match(s.stats.authorizations[1], /^Digest /);
  assert.match(s.stats.authorizations[2], /nc=00000002/);
});

test('HTTPS: a refused certificate means not one byte written', async (t) => {
  const s = await server(t, { secure: true });
  const session = new Session({
    address: { host: '127.0.0.1', port: s.port },
    secure: true,
    credentials: { username: 'admin', password: 'pw' },
    checkCertificate: async (fingerprint) => {
      throw new VenstarError(ERROR_KINDS.CERTIFICATE, 'changed', { notSent: true, fingerprint });
    },
  });
  await assert.rejects(session.request({ path: '/', timeoutMs }), {
    kind: ERROR_KINDS.CERTIFICATE,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.stats.requests.length, 0);
});

test('HTTPS: a wrong password is AUTH, after one answer to the challenge', async (t) => {
  const s = await server(t, { secure: true, auth: { username: 'admin', password: 'pw' } });
  const session = new Session({
    address: { host: '127.0.0.1', port: s.port },
    secure: true,
    credentials: { username: 'admin', password: 'nope' },
    checkCertificate: async () => {},
  });
  await assert.rejects(session.request({ path: '/', timeoutMs }), { kind: ERROR_KINDS.AUTH });
  session.close();
  assert.equal(s.stats.requests.length, 2);
});

test('an answer too large, a 429 with Retry-After, a body that is not JSON', async (t) => {
  let mode = 'big';
  const s = await server(t, {
    handler: (req, res) => {
      if (mode === 'big') {
        res.writeHead(200);
        res.end('x'.repeat(40 * 1024));
      } else if (mode === 'busy') {
        res.writeHead(429, { 'Retry-After': '120' });
        res.end();
      } else {
        res.writeHead(200);
        res.end('<html>');
      }
    },
  });
  const open = () => new Session({ address: { host: '127.0.0.1', port: s.port }, secure: false });
  await assert.rejects(open().request({ path: '/', timeoutMs }), { kind: ERROR_KINDS.PROTOCOL });
  mode = 'busy';
  await assert.rejects(open().request({ path: '/', timeoutMs }), {
    kind: ERROR_KINDS.BUSY,
    retryAfter: 120_000,
  });
  mode = 'html';
  await assert.rejects(open().request({ path: '/', timeoutMs }), { kind: ERROR_KINDS.PROTOCOL });
});

test('nothing listening: UNREACHABLE, marked not sent', async () => {
  await assert.rejects(
    openConnection({ host: '127.0.0.1', port: 1, secure: false, timeoutMs: 2000 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && !/127\.0\.0\.1/.test(err.message),
  );
});

test('the parser: fragmented head, chunked body, interim answers, bounded', () => {
  const p = new AnswerParser();
  const text =
    'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{"a"\r\n3\r\n:1}\r\n0\r\n\r\n';
  let done = false;
  for (const byte of Buffer.from(text)) {
    done = p.push(Buffer.from([byte]));
  }
  assert.ok(done);
  assert.deepEqual(p.result().body, '{"a":1}');
  const big = new AnswerParser({ maxBytes: 10 });
  assert.throws(() => big.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n')), {
    kind: ERROR_KINDS.PROTOCOL,
  });
  const header = new AnswerParser({ headerBytes: 64 });
  assert.throws(() => header.push(Buffer.from(`HTTP/1.1 200 OK\r\nX: ${'y'.repeat(100)}`)), {
    kind: ERROR_KINDS.PROTOCOL,
  });
  // A header named like an Object.prototype key is only a key; "__proto__" is refused.
  const proto = new AnswerParser();
  proto.push(Buffer.from('HTTP/1.1 200 OK\r\nconstructor: x\r\nContent-Length: 0\r\n\r\n'));
  assert.equal(Object.getPrototypeOf(proto.result().headers), null);
  assert.throws(
    () => new AnswerParser().push(Buffer.from('HTTP/1.1 200 OK\r\n__proto__: x\r\n\r\n')),
    { kind: ERROR_KINDS.PROTOCOL },
  );
});

test('Digest: challenge read strictly, header answered as RFC 7616', () => {
  assert.equal(parseChallenge('Basic realm="x"'), undefined);
  assert.equal(parseChallenge('Digest realm="a\\"b", nonce="n"'), undefined);
  assert.equal(parseChallenge('Digest realm="x", nonce="n", algorithm=SHA-256'), undefined);
  const challenge = parseChallenge('Digest realm="venstar", nonce="abc", qop="auth,auth-int"');
  const header = digestHeader({
    username: 'admin',
    password: 'pw',
    method: 'GET',
    uri: '/',
    challenge,
    count: 1,
    cnonce: 'c0ffee',
  });
  const ha1 = md5('admin:venstar:pw');
  const response = md5(`${ha1}:abc:00000001:c0ffee:auth:${md5('GET:/')}`);
  assert.match(header, new RegExp(`response="${response}"`));
  const legacy = digestHeader({
    username: 'admin',
    password: 'pw',
    method: 'GET',
    uri: '/',
    challenge: parseChallenge('Digest realm="venstar", nonce="abc"'),
    count: 1,
  });
  assert.match(legacy, new RegExp(`response="${md5(`${ha1}:abc:${md5('GET:/')}`)}"`));
  assert.doesNotMatch(legacy, /qop/);
});

test('Retry-After: seconds, or a date against the thermostat clock only', () => {
  assert.equal(retryAfterMs({ 'retry-after': '30' }), 30_000);
  assert.equal(
    retryAfterMs({
      'retry-after': 'Wed, 21 Oct 2026 07:30:00 GMT',
      date: 'Wed, 21 Oct 2026 07:28:00 GMT',
    }),
    120_000,
  );
  assert.equal(retryAfterMs({ 'retry-after': 'Wed, 21 Oct 2026 07:30:00 GMT' }), undefined);
});
