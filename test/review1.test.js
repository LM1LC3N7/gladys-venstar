// Review 1 scenarios (xhigh, taken into the repository): the REAL app
// (handlers + VenstarApp + real transport) against the SDK's fake Gladys and
// REAL local HTTP / HTTPS servers. The assertions state the behaviour after
// the fixes of review 1 (B1, I1, I2, I3, M4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { VenstarApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { selfSigned } from './helpers/selfSigned.js';

const md5 = (t) => createHash('md5').update(t).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return false;
}

function baseInfo() {
  return {
    name: 'Upstairs',
    mode: 1,
    state: 1,
    fan: 0,
    fanstate: 1,
    tempunits: 1,
    spacetemp: 20.5,
    heattemp: 21,
    cooltemp: 25,
    heattempmin: 4.5,
    heattempmax: 32,
    cooltempmin: 10,
    cooltempmax: 37,
    setpointdelta: 2,
    availablemodes: 0,
  };
}

/** A real Venstar-like server. digest: 'reuse' | 'single'. */
async function venstar(t, opts = {}) {
  const { secure = false, auth, digest = 'reuse', pin, applyDelay = 0 } = opts;
  const pair = opts.cert ?? selfSigned('venstar', 1);
  const s = {
    connections: 0,
    requests: [],
    root: { api_ver: 7, type: 'residential', model: 'COLORTOUCH', firmware: '6.10' },
    info: { ...baseInfo(), ...(opts.info ?? {}) },
    handler: opts.handler,
    nonces: new Set(['n0']),
    counter: 0,
  };
  const challenge = (res) => {
    let nonce = 'n0';
    if (digest === 'single') {
      s.counter += 1;
      nonce = `n${s.counter}`;
      s.nonces.add(nonce);
    }
    res.writeHead(401, {
      'WWW-Authenticate': `Digest realm="venstar", nonce="${nonce}", qop="auth"`,
    });
    res.end();
  };
  const onRequest = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      s.requests.push({
        method: req.method,
        url: req.url,
        body,
        authorization: req.headers.authorization,
      });
      if (auth) {
        const h = req.headers.authorization ?? '';
        const f = Object.fromEntries(
          [...h.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]),
        );
        const ha1 = md5(`${auth.username}:venstar:${auth.password}`);
        const exp = md5(
          `${ha1}:${f.nonce}:${f.nc}:${f.cnonce}:auth:${md5(`${req.method}:${req.url}`)}`,
        );
        if (!h || f.response !== exp || f.username !== auth.username || !s.nonces.has(f.nonce)) {
          challenge(res);
          return;
        }
        if (digest === 'single') s.nonces.delete(f.nonce);
      }
      if (s.handler && s.handler(req, res, body) === true) return;
      const json = (v) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (req.url === '/') return json(s.root);
      if (req.url === '/query/info') return json(s.info);
      if (req.url === '/query/sensors')
        return json({ sensors: [{ name: 'Thermostat', type: 'Local', temp: 20.5, hum: 40 }] });
      if (req.url === '/query/alerts')
        return json({ alerts: [{ name: 'Air Filter', active: false }] });
      if (req.method === 'POST' && req.url === '/control') {
        const form = Object.fromEntries(new URLSearchParams(body));
        if (pin && form.pin !== pin) return json({ error: true, reason: 'Invalid PIN' });
        const apply = () => {
          if (form.mode !== undefined) s.info.mode = Number(form.mode);
          if (form.fan !== undefined) s.info.fan = Number(form.fan);
          if (form.heattemp !== undefined) s.info.heattemp = Number(form.heattemp);
          if (form.cooltemp !== undefined) s.info.cooltemp = Number(form.cooltemp);
        };
        if (applyDelay > 0) setTimeout(apply, applyDelay);
        else apply();
        return json({ success: true });
      }
      res.writeHead(404);
      res.end();
    });
  };
  const srv = secure
    ? https.createServer({ key: pair.key, cert: pair.cert }, onRequest)
    : http.createServer(onRequest);
  srv.keepAliveTimeout = 30_000;
  srv.on('connection', () => (s.connections += 1));
  await new Promise((r) => srv.listen(opts.port ?? 0, '127.0.0.1', r));
  s.port = srv.address().port;
  s.fingerprint = new X509Certificate(pair.cert).fingerprint256;
  s.close = () =>
    new Promise((r) => {
      srv.closeAllConnections?.();
      srv.close(() => r());
    });
  t.after(() => s.close());
  return s;
}

async function start(t, config, { store = memoryStore(), logs = [] } = {}) {
  const gladys = createFakeGladys({ config });
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l} ${a.map(String).join(' ')}`),
    ]),
  );
  const app = new VenstarApp({ gladys, logger, store });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  return { gladys, app, store, logs };
}

async function created(gladys) {
  assert.ok(await until(() => gladys.fake.discoveredDevices.length > 0), 'device discovered');
  const d = gladys.fake.discoveredDevices[0];
  await gladys.fake.deviceCreated(d);
  return gladys.fake.devices.find((x) => x.external_id === d.external_id);
}
const feat = (d, key) => d.features.find((f) => f.external_id.endsWith(`:${key}`));
const errorOf = (ack) => ack?.error ?? ack?.data?.error ?? '';

test('R1 HTTPS + Digest (reusable nonce) + PIN: one TCP connection per session, PIN only in the POST body, nothing in logs or /data', async (t) => {
  const s = await venstar(t, {
    secure: true,
    auth: { username: 'admin', password: 'S3cr3t!' },
    pin: '0042',
  });
  const logs = [];
  const { gladys, store } = await start(
    t,
    {
      address: `127.0.0.1:${s.port}`,
      use_https: true,
      username: 'admin',
      password: 'S3cr3t!',
      pin: '42',
      allow_commands: true,
    },
    { logs },
  );
  const d = await created(gladys);
  const readConnections = s.connections;
  assert.equal(readConnections, 1, 'the read used one TCP connection');
  const ack = await gladys.fake.setValue(d, feat(d, 'heat-setpoint'), 22);
  assert.equal(errorOf(ack), '', JSON.stringify(ack));
  assert.equal(s.info.heattemp, 22);
  assert.equal(s.connections, 2, 'the command used one more TCP connection');
  for (const r of s.requests) assert.ok(!/pin|0042/i.test(r.url), `PIN in URL ${r.url}`);
  const post = s.requests.filter((r) => r.method === 'POST' && r.authorization);
  assert.match(post.at(-1).body, /pin=0042/);
  const all =
    logs.join('\n') + JSON.stringify(store.data) + JSON.stringify(gladys.fake.connectionStatus);
  assert.ok(!/S3cr3t|0042/.test(all), 'secret leaked');
  assert.equal(store.data.targets[`https://127.0.0.1:${s.port}`].certificate, s.fingerprint);
});

test('R2 HTTPS Digest with single-use nonces (no stale=true): the right password is never refused', async (t) => {
  const s = await venstar(t, {
    secure: true,
    auth: { username: 'admin', password: 'good' },
    digest: 'single',
  });
  const { gladys, app, store } = await start(t, {
    address: `127.0.0.1:${s.port}`,
    use_https: true,
    username: 'admin',
    password: 'good',
  });
  await until(() => app.thermostat?.online !== undefined || app.thermostat?.problem);
  await sleep(200);
  const target = store.data?.targets?.[`https://127.0.0.1:${s.port}`];
  console.log(
    'R2 requests',
    s.requests.map((r) => `${r.method} ${r.url} ${r.authorization ? 'auth' : '-'}`),
  );
  console.log(
    'R2 problem',
    app.thermostat.problem,
    'refusedCredentials',
    target?.refusedCredentials,
    'timer',
    Boolean(app.thermostat.timer),
  );
  console.log('R2 status', gladys.fake.connectionStatus?.message?.en);
  // What we expect from a correct client (venstarcolortouch via requests retries a 401 once with the new challenge):
  assert.notEqual(app.thermostat.problem?.kind, 'refused', 'BUG: good password refused for good');
  assert.equal(target?.refusedCredentials, undefined, 'never a fingerprint of the right password');
  assert.equal(app.thermostat.online, true);
});

test('R2c HTTPS Digest: a wrong password is refused after one answer to a fresh challenge', async (t) => {
  const s = await venstar(t, {
    secure: true,
    auth: { username: 'admin', password: 'good' },
    digest: 'single',
  });
  const { app, store } = await start(t, {
    address: `127.0.0.1:${s.port}`,
    use_https: true,
    username: 'admin',
    password: 'bad',
  });
  assert.ok(await until(() => app.thermostat?.problem?.kind === 'refused'));
  assert.match(
    store.data.targets[`https://127.0.0.1:${s.port}`].refusedCredentials,
    /^[0-9a-f]{64}$/,
  );
  assert.equal(s.requests.length, 2, 'one try without, one answer to the challenge');
  assert.equal(app.thermostat.timer, undefined, 'no automatic retry');
});

test('R3 plain HTTP asking a password: never the password, final refusal without timer', async (t) => {
  const s = await venstar(t, { auth: { username: 'admin', password: 'pw' } });
  const { app } = await start(t, {
    address: `127.0.0.1:${s.port}`,
    username: 'admin',
    password: 'pw',
  });
  await until(() => app.thermostat?.problem?.kind === 'refused');
  assert.equal(app.thermostat.problem.kind, 'refused');
  assert.ok(s.requests.every((r) => !r.authorization));
  assert.equal(app.thermostat.timer, undefined, 'no automatic retry');
});

test('R4 a setpoint not yet applied is REWRITTEN by the next command (other setpoint / mode written back as read)', async (t) => {
  const s = await venstar(t, { applyDelay: 1500 });
  const { gladys } = await start(t, { address: `127.0.0.1:${s.port}`, allow_commands: true });
  const d = await created(gladys);
  const a1 = await gladys.fake.setValue(d, feat(d, 'heat-setpoint'), 23);
  console.log('R4 heat ack', errorOf(a1));
  const a2 = await gladys.fake.setValue(d, feat(d, 'cool-setpoint'), 27);
  console.log('R4 cool ack', errorOf(a2));
  await sleep(2000);
  console.log(
    'R4 posts',
    s.requests.filter((r) => r.method === 'POST').map((r) => r.body),
  );
  console.log('R4 final heat', s.info.heattemp, 'cool', s.info.cooltemp);
  assert.equal(
    s.info.heattemp,
    23,
    'BUG: the heating setpoint asked was overwritten by the old value',
  );
  assert.match(errorOf(a2), /pas encore confirmée/);
  assert.equal(s.requests.filter((r) => r.method === 'POST').length, 1);
});

test('R5 stop: refused when commands are off (nothing sent); sent during a persisted 429 pause', async (t) => {
  const s = await venstar(t);
  const { gladys, app, store } = await start(t, { address: `127.0.0.1:${s.port}` });
  const d = await created(gladys);
  const before = s.requests.length;
  const off = await gladys.fake.setValue(d, feat(d, 'mode'), 0);
  assert.match(errorOf(off), /désactivées|disabled/);
  assert.equal(s.requests.length, before);
  // Allow, then pause the reads by a 429.
  await gladys.fake.configUpdated({ address: `127.0.0.1:${s.port}`, allow_commands: true });
  const memory = app.memory.targets.get(`http://127.0.0.1:${s.port}`);
  memory.pausedUntil = Date.now() + 3_600_000;
  const heat = await gladys.fake.setValue(d, feat(d, 'mode'), 2);
  assert.match(errorOf(heat), /attendre|wait/);
  const stop = await gladys.fake.setValue(d, feat(d, 'mode'), 0);
  assert.equal(errorOf(stop), '');
  assert.equal(s.info.mode, 0);
  assert.ok(store);
});

test('R6 identity: first read without a name -> another thermostat of the same model later is accepted silently', async (t) => {
  const s = await venstar(t, { info: { name: undefined } });
  const { gladys, app } = await start(t, { address: `127.0.0.1:${s.port}`, allow_commands: true });
  const d = await created(gladys);
  // DHCP swap: another ColorTouch, named "Downstairs", now answers at the address.
  s.info = { ...baseInfo(), name: 'Downstairs', heattemp: 18 };
  const ack = await gladys.fake.setValue(d, feat(d, 'heat-setpoint'), 24);
  console.log(
    'R6 ack',
    errorOf(ack),
    'identity kept',
    app.memory.targets.get(`http://127.0.0.1:${s.port}`).identity,
  );
  assert.notEqual(s.info.heattemp, 24, 'WEAK: command applied to another thermostat');
  assert.match(errorOf(ack), /nom et son modèle/);
});

test('R6b identity: a name missing at the first read is completed at the next one, then compared', async (t) => {
  const s = await venstar(t, { info: { name: undefined } });
  const { gladys, app } = await start(t, { address: `127.0.0.1:${s.port}`, allow_commands: true });
  const d = await created(gladys);
  s.info.name = 'Upstairs';
  await app.tick(app.thermostat, { force: true });
  assert.equal(app.memory.targets.get(`http://127.0.0.1:${s.port}`).identity.name, 'Upstairs');
  const good = await gladys.fake.setValue(d, feat(d, 'heat-setpoint'), 22);
  assert.equal(errorOf(good), '');
  s.info = { ...baseInfo(), name: 'Downstairs' };
  const other = await gladys.fake.setValue(d, feat(d, 'heat-setpoint'), 24);
  assert.match(errorOf(other), /autre thermostat/);
});

test('R7 rename on the thermostat screen: the stop is refused until "Accept the change" twice', async (t) => {
  const s = await venstar(t);
  const { gladys } = await start(t, { address: `127.0.0.1:${s.port}`, allow_commands: true });
  const d = await created(gladys);
  s.info.name = 'Living room';
  const stop = await gladys.fake.setValue(d, feat(d, 'mode'), 0);
  // Documented choice: another name = another thermostat, the stop included.
  assert.match(errorOf(stop), /autre thermostat/);
  assert.equal(s.info.mode, 1);
});

test('R8 HTTPS certificate swapped at the same port: nothing written, stop refused, accept pins exactly the one shown', async (t) => {
  const s1 = await venstar(t, { secure: true });
  const port = s1.port;
  const { gladys, app } = await start(t, {
    address: `127.0.0.1:${port}`,
    use_https: true,
    allow_commands: true,
  });
  const d = await created(gladys);
  await s1.close();
  const s2 = await venstar(t, { secure: true, port, cert: selfSigned('evil', 2) });
  const stop = await gladys.fake.setValue(d, feat(d, 'mode'), 0);
  assert.match(errorOf(stop), /certificat|certificate/);
  assert.equal(s2.requests.length, 0, 'not one request to the new certificate');
  const first = await gladys.fake.action('accept_change');
  assert.match(JSON.stringify(first), new RegExp(s2.fingerprint.slice(0, 20)));
  await gladys.fake.action('accept_change');
  assert.equal(app.memory.targets.get(`https://127.0.0.1:${port}`).certificate, s2.fingerprint);
});

test('R9 hostile answers: slow drip, huge chunk, deep JSON, header flood -> bounded, no crash', async (t) => {
  let mode = 'drip';
  const s = await venstar(t, {
    handler: (req, res) => {
      if (req.url !== '/') return false;
      const sock = res.socket;
      if (mode === 'drip') {
        sock.write('HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n');
        return true;
      }
      if (mode === 'chunk') {
        sock.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nfffffff\r\n');
        sock.write('x'.repeat(40000));
        return true;
      }
      if (mode === 'deep') {
        const body = '['.repeat(30000);
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
        return true;
      }
      if (mode === 'headers') {
        sock.write('HTTP/1.1 200 OK\r\n');
        for (let i = 0; i < 2000; i += 1) sock.write(`X-${i}: ${'a'.repeat(50)}\r\n`);
        return true;
      }
      return false;
    },
  });
  const { app } = await start(t, { address: `127.0.0.1:${s.port}` });
  for (const m of ['drip', 'chunk', 'deep', 'headers']) {
    mode = m;
    const th = app.thermostat;
    th.online = undefined;
    const t0 = Date.now();
    await app.tick(th, { force: true });
    console.log(`R9 ${m}: ${Date.now() - t0} ms, online=${th.online}, reason=${th.reason}`);
    assert.equal(th.online, false);
    assert.ok(Date.now() - t0 < 21_000);
  }
});

test('R10 POST /control answered 500 / 302: sent-without-confirmation vs refused, pause applies to reads', async (t) => {
  let status = 500;
  const s = await venstar(t, {
    handler: (req, res) => {
      if (req.method === 'POST') {
        res.writeHead(status, status === 302 ? { Location: 'http://x/' } : {});
        res.end();
        return true;
      }
      return false;
    },
  });
  const { gladys, app } = await start(t, { address: `127.0.0.1:${s.port}`, allow_commands: true });
  const d = await created(gladys);
  const a = await gladys.fake.setValue(d, feat(d, 'heat-setpoint'), 22);
  console.log('R10 500:', errorOf(a), 'paused', app.paused());
  app.memory.targets.get(`http://127.0.0.1:${s.port}`).pausedUntil = 0;
  status = 302;
  const b = await gladys.fake.setValue(d, feat(d, 'heat-setpoint'), 22);
  console.log('R10 302:', errorOf(b));
});

test('R11 a stop overtaking a start: start written first answers late -> the stop is written again', async (t) => {
  const s = await venstar(t, {
    handler: (req, res, body) => {
      if (req.method === 'POST' && /mode=1/.test(body)) {
        setTimeout(() => {
          s.info.mode = 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"success":true}');
        }, 800);
        return true;
      }
      return false;
    },
    info: { mode: 0 },
  });
  const { gladys } = await start(t, { address: `127.0.0.1:${s.port}`, allow_commands: true });
  const d = await created(gladys);
  const startAck = gladys.fake.setValue(d, feat(d, 'mode'), 1);
  await until(() => s.requests.some((r) => r.method === 'POST'));
  const stopAck = await gladys.fake.setValue(d, feat(d, 'mode'), 0);
  console.log('R11 stop', errorOf(stopAck), 'start', errorOf(await startAck));
  await until(() => s.info.mode === 0, 3000);
  console.log(
    'R11 posts',
    s.requests.filter((r) => r.method === 'POST').map((r) => r.body),
  );
  assert.equal(s.info.mode, 0, 'heating relaunched');
});

test('R2b single-use nonces: the STOP itself fails (credentials refused)', async (t) => {
  const s = await venstar(t, {
    secure: true,
    auth: { username: 'admin', password: 'good' },
    digest: 'single',
  });
  const store = memoryStore();
  // Pretend the first reads were fine: start with a pinned certificate and a kept identity.
  const { gladys, app } = await start(
    t,
    {
      address: `127.0.0.1:${s.port}`,
      use_https: true,
      username: 'admin',
      password: 'good',
      allow_commands: true,
    },
    { store },
  );
  await until(() => app.thermostat?.problem?.kind === 'refused');
  // Even without the refusal: a stop is a 2- to 4-request session.
  const d = { external_id: 'ext:test-integration:venstar:127-0-0-1-' + s.port, features: [] };
  const n = s.requests.length;
  const ack = await gladys.fake.setValue(
    d,
    { external_id: `${d.external_id}:mode`, unit: null },
    0,
  );
  console.log(
    'R2b stop:',
    errorOf(ack),
    'requests',
    s.requests.slice(n).map((r) => `${r.method} ${r.url} ${r.authorization ? 'auth' : '-'}`),
  );
  assert.equal(errorOf(ack), '', 'the stop goes through single-use nonces');
  assert.equal(s.info.mode, 0);
});

test('R12 real slow drip: one byte every 300 ms -> the read ends within the request timeout', async (t) => {
  const s = await venstar(t, {
    handler: (req, res) => {
      if (req.url !== '/') return false;
      const sock = res.socket;
      sock.write('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n');
      const timer = setInterval(
        () => (sock.destroyed ? clearInterval(timer) : sock.write('x')),
        300,
      );
      return true;
    },
  });
  const { app } = await start(t, { address: `127.0.0.1:${s.port}` });
  const t0 = Date.now();
  await until(() => app.thermostat?.online === false, 8000);
  console.log(
    `R12 drip ended after ${Date.now() - t0} ms, reason=${app.thermostat.reason}, next in ${Math.round((app.thermostat.nextAt - Date.now()) / 1000)} s`,
  );
  assert.equal(app.thermostat.online, false);
});

test('R13 stop when /query/info never answers: the mode alone is written in time', async (t) => {
  let silent = false;
  const s = await venstar(t, { handler: (req) => silent && req.url === '/query/info' });
  const { gladys } = await start(t, { address: `127.0.0.1:${s.port}`, allow_commands: true });
  const d = await created(gladys);
  silent = true;
  const t0 = Date.now();
  const ack = await gladys.fake.setValue(d, feat(d, 'mode'), 0);
  console.log(
    `R13 stop in ${Date.now() - t0} ms:`,
    errorOf(ack),
    s.requests.filter((r) => r.method === 'POST').map((r) => r.body),
  );
});

test('R14 rhythm: connected again, scan, config saved unchanged, test button -> no read before the interval', async (t) => {
  const s = await venstar(t);
  const cfg = { address: `127.0.0.1:${s.port}`, allow_commands: true };
  const { gladys, app } = await start(t, cfg);
  await created(gladys);
  const n = s.requests.filter((r) => r.url === '/').length;
  await app.connected(cfg);
  await gladys.fake.scanRequest();
  await gladys.fake.configUpdated({ ...cfg, pin: '1234' });
  await gladys.fake.configUpdated({ ...cfg, language: 'en' });
  const test1 = await gladys.fake.action('test_connection');
  await sleep(200);
  console.log('R14 test button:', JSON.stringify(test1.data?.message?.en ?? test1));
  assert.equal(s.requests.filter((r) => r.url === '/').length, n);
});

test('R15 PIN refused: start refused unsent afterwards, the stop sends the refused PIN once, reaffirm bounded', async (t) => {
  const s = await venstar(t, { pin: '1111' });
  const { gladys } = await start(t, {
    address: `127.0.0.1:${s.port}`,
    allow_commands: true,
    pin: '2222',
  });
  const d = await created(gladys);
  const a = await gladys.fake.setValue(d, feat(d, 'heat-setpoint'), 22);
  console.log('R15 first:', errorOf(a));
  const n = s.requests.filter((r) => r.method === 'POST').length;
  const b = await gladys.fake.setValue(d, feat(d, 'heat-setpoint'), 22);
  console.log(
    'R15 second:',
    errorOf(b),
    'posts',
    s.requests.filter((r) => r.method === 'POST').length - n,
  );
  const c = await gladys.fake.setValue(d, feat(d, 'mode'), 0);
  console.log(
    'R15 stop:',
    errorOf(c),
    'posts',
    s.requests.filter((r) => r.method === 'POST').length - n,
  );
});

test('R16 unconfirmed stop, then "heat": the start is written (never "already so" under a stop guard)', async (t) => {
  const s = await venstar(t, { applyDelay: 1500 });
  const { gladys } = await start(t, { address: `127.0.0.1:${s.port}`, allow_commands: true });
  const d = await created(gladys);
  const stop = await gladys.fake.setValue(d, feat(d, 'mode'), 0);
  const heat = await gladys.fake.setValue(d, feat(d, 'mode'), 1);
  await sleep(2000);
  console.log(
    'R16 stop:',
    errorOf(stop),
    '| heat:',
    JSON.stringify(errorOf(heat)),
    '| posts',
    s.requests.filter((r) => r.method === 'POST').map((r) => r.body),
    '| final mode',
    s.info.mode,
  );
  assert.ok(errorOf(heat) === '' || /sans confirmation/.test(errorOf(heat)), errorOf(heat));
  assert.deepEqual(
    s.requests
      .filter((r) => r.method === 'POST')
      .map((r) => new URLSearchParams(r.body).get('mode')),
    ['0', '1'],
  );
  assert.equal(s.info.mode, 1, 'the latest command (heat) wins');
});

test('M4 a start never confirmed before a stop: the stop is written again if a read shows on', async (t) => {
  const s = await venstar(t, { info: { mode: 0 } });
  const { gladys, app } = await start(t, { address: `127.0.0.1:${s.port}`, allow_commands: true });
  const d = await created(gladys);
  // The start is answered but not applied (yet).
  s.handler = (req, res) => {
    if (req.method === 'POST' && req.url === '/control') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"success":true}');
      return true;
    }
    return false;
  };
  const startAck = await gladys.fake.setValue(d, feat(d, 'mode'), 1);
  assert.match(errorOf(startAck), /sans confirmation/);
  s.handler = undefined;
  const stopAck = await gladys.fake.setValue(d, feat(d, 'mode'), 0);
  assert.equal(errorOf(stopAck), '');
  assert.equal(app.reaffirm?.watch, true);
  // The thermostat takes the old start late: the next read writes the stop again.
  s.info.mode = 1;
  await app.tick(app.thermostat, { force: true });
  assert.ok(await until(() => s.info.mode === 0, 3000));
});
