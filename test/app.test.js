// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake thermostat behind `open`. Timers and Date are mocked: the
// tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { VenstarApp } from '../src/app.js';
import { ACTIONS, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FP1, FP2, HOST, NOW, fakeNetwork, settle, thermostat } from './helpers/fakeVenstar.js';

const CONFIG = { address: HOST };
const ALLOWED = { address: HOST, allow_commands: true };
const DEVICE = 'ext:test-integration:venstar:192-168-1-20';
const feature = (key) => `${DEVICE}:${key}`;

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

async function setup(
  t,
  { config = CONFIG, net = fakeNetwork(), store = memoryStore(), create = true, logs = [] } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new VenstarApp({
    gladys,
    logger: recorder(logs),
    open: (options) => net.open(options),
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  const advance = async (ms, step = 100) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  const connecting = gladys.connect();
  await settle();
  await advance(2 * SECOND);
  await connecting;
  t.after(() => app.stop());
  if (create) {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await settle();
  }
  const send = async (key, value, { wait = 6 * SECOND } = {}) => {
    const d = gladys.fake.devices.find((x) => x.external_id === DEVICE);
    const target = d.features.find((f) => f.external_id === feature(key));
    const ack = gladys.fake.setValue(d, target, value);
    await settle();
    await advance(wait);
    return ack;
  };
  return { gladys, app, net, store, advance, logs, send };
}

const last = (gladys, key) => gladys.fake.lastState(feature(key));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const failure = (ack) => ack.error ?? ack.data?.error ?? ack.message ?? JSON.stringify(ack);
const ok = (ack) => ack.success !== false && !ack.error;

test('without an address, the status asks for it and nothing is opened', async (t) => {
  const net = fakeNetwork();
  const { gladys } = await setup(t, { config: {}, net });
  assert.equal(net.opened.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(net.opened.length, 0);
});

test('first read: one connection, the device keyed by the address, its states', async (t) => {
  const net = fakeNetwork();
  const { gladys } = await setup(t, { net });
  assert.equal(net.connections, 1);
  assert.deepEqual(net.paths(), [
    'GET /',
    'GET /query/info',
    'GET /query/sensors',
    'GET /query/alerts',
  ]);
  const [d] = gladys.fake.discoveredDevices;
  assert.equal(d.external_id, DEVICE);
  assert.deepEqual(
    d.features.map((f) => f.external_id.split(':').at(-1)),
    [
      'temperature',
      'humidity',
      'outdoor-temperature',
      'heat-setpoint',
      'cool-setpoint',
      'mode',
      'fan-mode',
      'fan-running',
      'operating-state',
      'status',
      'filter-alert',
      'alerts',
    ],
  );
  for (const f of d.features) {
    assert.notEqual(f.category, 'switch', 'never a switch');
    assert.ok(!(f.type === 'binary' && f.read_only === false), 'never a writable binary');
    if (f.unit && f.category !== 'humidity-sensor') {
      assert.equal(f.unit, 'celsius');
    }
  }
  const heat = d.features.find((f) => f.external_id === feature('heat-setpoint'));
  assert.deepEqual([heat.min, heat.max], [5, 30]);
  assert.equal(last(gladys, 'temperature'), 20.5);
  assert.equal(last(gladys, 'humidity'), 41);
  assert.equal(last(gladys, 'outdoor-temperature'), 3.5);
  assert.equal(last(gladys, 'heat-setpoint'), 21);
  assert.equal(last(gladys, 'cool-setpoint'), 25);
  assert.equal(last(gladys, 'mode'), 1);
  assert.equal(last(gladys, 'fan-mode'), 'auto');
  assert.equal(last(gladys, 'fan-running'), 1);
  assert.equal(last(gladys, 'operating-state'), 1);
  assert.equal(last(gladys, 'status'), 'Chauffe');
  assert.equal(last(gladys, 'filter-alert'), 0);
  assert.equal(last(gladys, 'alerts'), 'Aucune');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /Connected to "Upstairs" \(COLORTOUCH\)/);
  assert.equal(gladys.fake.transports.at(-1)?.transport, DEVICE_TRANSPORTS.LOCAL);
  for (const s of gladys.fake.states) {
    assert.ok(s.state === undefined || Number.isFinite(s.state));
  }
});

test('a thermostat in °F: the features in °F, the bounds in °F', async (t) => {
  const net = fakeNetwork(
    thermostat({
      info: {
        tempunits: 0,
        spacetemp: 70,
        heattemp: 68,
        cooltemp: 76,
        heattempmin: 35,
        heattempmax: 99,
        cooltempmin: 35,
        cooltempmax: 99,
      },
    }),
  );
  const { gladys } = await setup(t, { net });
  const [d] = gladys.fake.discoveredDevices;
  const heat = d.features.find((f) => f.external_id === feature('heat-setpoint'));
  assert.equal(heat.unit, 'fahrenheit');
  assert.deepEqual([heat.min, heat.max], [41, 86]);
  assert.equal(last(gladys, 'heat-setpoint'), 68);
});

test('reads every interval only; a restart waits for the rest of the interval', async (t) => {
  const store = memoryStore();
  const net = fakeNetwork();
  const { advance } = await setup(t, { net, store });
  assert.equal(net.connections, 1);
  await advance(30 * SECOND);
  assert.equal(net.connections, 1);
  await advance(31 * SECOND);
  assert.equal(net.connections, 2);
  const saved = store.data.targets['http://192.168.1.20'].attemptAt;
  assert.ok(saved > 0);
  t.mock.timers.reset();
  // A new process 10 s later: no read before a minute after the attempt kept.
  const net2 = fakeNetwork();
  const store2 = memoryStore(store.data);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: saved + 10 * SECOND });
  const gladys = createFakeGladys({ config: CONFIG });
  const app = new VenstarApp({
    gladys,
    logger: recorder([]),
    open: (o) => net2.open(o),
    now: () => Date.now(),
    store: store2,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  const connecting = gladys.connect();
  await settle();
  for (let i = 0; i < 20; i += 1) {
    t.mock.timers.tick(100);
    await settle();
  }
  await connecting;
  assert.equal(net2.connections, 0);
  for (let i = 0; i < 600; i += 1) {
    t.mock.timers.tick(100);
    await settle(5);
  }
  assert.equal(net2.connections, 1);
});

test('a reconnection to Gladys republishes the status and Discovery without reading', async (t) => {
  const net = fakeNetwork();
  const { gladys, app } = await setup(t, { net });
  const before = gladys.fake.connectionStatuses.length;
  const discovered = gladys.fake.requests.filter((r) => r.path === '/discovered_device').length;
  await app.connected(CONFIG);
  await settle();
  assert.equal(net.connections, 1);
  assert.ok(gladys.fake.connectionStatuses.length > before);
  assert.ok(
    gladys.fake.requests.filter((r) => r.path === '/discovered_device').length > discovered,
  );
});

test('commands are off by default: refused, nothing sent', async (t) => {
  const net = fakeNetwork();
  const { send } = await setup(t, { net });
  const count = net.requests.length;
  for (const [key, value] of [
    ['heat-setpoint', 22],
    ['mode', 0],
    ['fan-mode', 'on'],
  ]) {
    const ack = await send(key, value);
    assert.ok(!ok(ack), key);
    assert.match(failure(ack), /désactivées/);
  }
  assert.equal(net.requests.length, count);
});

test('a heating setpoint: fresh read, both setpoints written, confirmed by the read back', async (t) => {
  const net = fakeNetwork();
  const { gladys, send } = await setup(t, { config: ALLOWED, net });
  net.requests.length = 0;
  const ack = await send('heat-setpoint', 22.5);
  assert.ok(ok(ack), failure(ack));
  assert.deepEqual(net.paths(), ['GET /', 'GET /query/info', 'POST /control', 'GET /query/info']);
  assert.deepEqual(net.controls(), [{ heattemp: '22.5', cooltemp: '25' }]);
  await settle();
  assert.equal(last(gladys, 'heat-setpoint'), 22.5);
});

test('setpoints out of bounds are refused before anything is read', async (t) => {
  const net = fakeNetwork();
  const { send } = await setup(t, { config: ALLOWED, net });
  net.requests.length = 0;
  for (const [key, value] of [
    ['heat-setpoint', 31],
    ['heat-setpoint', 4],
    ['cool-setpoint', 36],
    ['heat-setpoint', '22abc'],
    ['heat-setpoint', true],
  ]) {
    const ack = await send(key, value);
    assert.ok(!ok(ack), `${key} ${value}`);
  }
  assert.equal(net.requests.length, 0);
});

test('auto mode: the deadband is checked, never moved', async (t) => {
  const net = fakeNetwork(thermostat({ info: { mode: 3 } }));
  const { send } = await setup(t, { config: ALLOWED, net });
  const ack = await send('heat-setpoint', 24);
  assert.ok(!ok(ack));
  assert.match(failure(ack), /auto/);
  assert.deepEqual(net.controls(), []);
});

test('the stop: never skipped as already off, setpoints written back as read', async (t) => {
  const net = fakeNetwork(thermostat({ info: { mode: 0 } }));
  const { send } = await setup(t, { config: ALLOWED, net });
  const ack = await send('mode', 0);
  assert.ok(ok(ack), failure(ack));
  assert.deepEqual(net.controls(), [{ mode: '0', heattemp: '21', cooltemp: '25' }]);
});

test('a start already so is not sent; an unavailable mode is refused', async (t) => {
  const net = fakeNetwork(thermostat({ info: { availablemodes: 2 } }));
  const { gladys, send } = await setup(t, { config: ALLOWED, net });
  const [d] = gladys.fake.discoveredDevices;
  const mode = d.features.find((f) => f.external_id === feature('mode'));
  assert.deepEqual(
    mode.supported_options.map((o) => o.value),
    [0, 1],
  );
  assert.equal(
    d.features.some((f) => f.external_id === feature('cool-setpoint')),
    false,
  );
  assert.ok(ok(await send('mode', 1)));
  assert.ok(!ok(await send('mode', 2)));
  assert.deepEqual(net.controls(), []);
});

test('a stop cancels a start not written yet, and is not held back by it', async (t) => {
  const net = fakeNetwork();
  const { gladys, advance } = await setup(t, { config: ALLOWED, net });
  net.delays.set('GET /query/info', 1500);
  const d = gladys.fake.devices.find((x) => x.external_id === DEVICE);
  const f = (key) => d.features.find((x) => x.external_id === feature(key));
  const start = gladys.fake.setValue(d, f('mode'), 3);
  await advance(300);
  net.delays.delete('GET /query/info');
  const stop = gladys.fake.setValue(d, f('mode'), 0);
  await advance(6 * SECOND);
  const [a, b] = await Promise.all([start, stop]);
  assert.ok(!ok(a));
  assert.match(failure(a), /Annulée/);
  assert.ok(ok(b), failure(b));
  assert.deepEqual(
    net.controls().map((c) => c.mode),
    ['0'],
  );
});

test('a start written before a stop and answered after it: the stop is written again', async (t) => {
  const net = fakeNetwork(thermostat({ info: { mode: 0 } }));
  const { gladys, advance } = await setup(t, { config: ALLOWED, net });
  net.delays.set('POST /control', 1500);
  const d = gladys.fake.devices.find((x) => x.external_id === DEVICE);
  const f = (key) => d.features.find((x) => x.external_id === feature(key));
  const start = gladys.fake.setValue(d, f('mode'), 1);
  await advance(200);
  assert.equal(net.controls().length, 1);
  net.delays.set('POST /control', 0);
  const stop = gladys.fake.setValue(d, f('mode'), 0);
  await advance(8 * SECOND);
  const [a, b] = await Promise.all([start, stop]);
  assert.ok(ok(b), failure(b));
  assert.ok(!ok(a));
  assert.match(failure(a), /arrêt/);
  assert.deepEqual(
    net.controls().map((c) => c.mode),
    ['1', '0', '0'],
  );
  assert.equal(net.device.info.mode, 0);
});

test('not applied: "sent, without confirmation", one read 5 s later', async (t) => {
  const net = fakeNetwork();
  const { send, advance } = await setup(t, { config: ALLOWED, net });
  net.ignoreControl = true;
  const connections = net.connections;
  const ack = await send('heat-setpoint', 23, { wait: 500 });
  assert.ok(!ok(await ack));
  assert.match(failure(await ack), /sans confirmation/);
  await advance(6 * SECOND);
  assert.equal(net.connections, connections + 2);
});

test('the option turned off while a command reads: nothing written', async (t) => {
  const net = fakeNetwork();
  const { gladys, advance } = await setup(t, { config: ALLOWED, net });
  net.delays.set('GET /query/info', 1000);
  const d = gladys.fake.devices.find((x) => x.external_id === DEVICE);
  const target = d.features.find((x) => x.external_id === feature('heat-setpoint'));
  const ack = gladys.fake.setValue(d, target, 23);
  await advance(200);
  await gladys.fake.configUpdated(CONFIG);
  await advance(5 * SECOND);
  assert.ok(!ok(await ack));
  assert.deepEqual(net.controls(), []);
});

test('a slow thermostat: refused unsent after 3.5 s', async (t) => {
  const net = fakeNetwork();
  const { send } = await setup(t, { config: ALLOWED, net });
  net.delays.set('GET /query/info', 3_000);
  net.delays.set('GET /', 1_000);
  const ack = await send('heat-setpoint', 23);
  assert.ok(!ok(ack));
  assert.deepEqual(net.controls(), []);
});

test('HTTPS: the certificate pinned before the password leaves; another one stops everything', async (t) => {
  const device = thermostat({ auth: { username: 'admin', password: 's3cret-pw' } });
  const net = fakeNetwork(device);
  const store = memoryStore();
  const logs = [];
  const config = {
    address: HOST,
    use_https: true,
    username: 'admin',
    password: 's3cret-pw',
    pin: '1234',
  };
  const { gladys, advance } = await setup(t, { config, net, store, logs });
  assert.equal(store.data.targets['https://192.168.1.20'].certificate, FP1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(net.requests.some((r) => r.auth));
  assert.ok(net.opened.every((o) => o.secure && o.port === 443));
  // The thermostat now shows another certificate: nothing is written to it.
  device.fingerprint = FP2;
  const count = net.requests.length;
  await advance(61 * SECOND);
  assert.equal(net.requests.length, count);
  assert.match(message(gladys).en, new RegExp(FP2));
  assert.equal(gladys.fake.connectionStatus.connected, false);
  // Two clicks accept exactly the fingerprint shown.
  const first = await gladys.fake.action(ACTIONS.ACCEPT_CHANGE);
  assert.match(first.data.message.en, new RegExp(FP2));
  assert.equal(store.data.targets['https://192.168.1.20'].certificate, FP1);
  const second = await gladys.fake.action(ACTIONS.ACCEPT_CHANGE);
  assert.match(second.data.message.en, /Accepted/);
  assert.equal(store.data.targets['https://192.168.1.20'].certificate, FP2);
  await advance(61 * SECOND);
  assert.ok(net.requests.length > count);
  const text = JSON.stringify(store.data) + logs.join('\n');
  assert.doesNotMatch(text, /s3cret-pw|1234|admin/);
});

test('credentials refused: kept in /data, never retried by itself; the test button tries once', async (t) => {
  const device = thermostat({ auth: { username: 'admin', password: 'right' } });
  const net = fakeNetwork(device);
  const store = memoryStore();
  const config = { address: HOST, use_https: true, username: 'admin', password: 'wrong' };
  const { gladys, advance } = await setup(t, { config, net, store });
  const target = store.data.targets['https://192.168.1.20'];
  assert.match(target.refusedCredentials, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(store.data), /wrong|right/);
  assert.match(message(gladys).en, /refused the user name or the password/);
  const count = net.requests.length;
  await advance(10 * MINUTE, 1000);
  assert.equal(net.requests.length, count);
  // The button: one try (the interval since the last attempt has passed).
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.ok(net.requests.length > count);
  assert.match(ack.data.message.en, /refused/);
  // Right credentials: the refusal is lifted at the first success.
  device.auth.password = 'wrong';
  await advance(2 * MINUTE, 1000);
  await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await settle();
  assert.equal(store.data.targets['https://192.168.1.20'].refusedCredentials, undefined);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('plain HTTP: a password is never sent, the status says to turn HTTPS on', async (t) => {
  const net = fakeNetwork(thermostat({ auth: { username: 'admin', password: 'x' } }));
  const { gladys } = await setup(t, {
    config: { address: HOST, username: 'admin', password: 'x' },
    net,
  });
  assert.ok(net.requests.every((r) => !r.auth));
  assert.match(message(gladys).en, /turn on HTTPS/);
});

test('HTTP 429: every read paused (kept in /data); the stop still leaves, once', async (t) => {
  const net = fakeNetwork();
  const store = memoryStore();
  const { gladys, advance, send } = await setup(t, { config: ALLOWED, net, store });
  net.status.set('GET /', 429);
  net.headers = { 'retry-after': '600' };
  await advance(61 * SECOND);
  const target = store.data.targets['http://192.168.1.20'];
  assert.ok(target.pausedUntil >= NOW + 600 * SECOND);
  assert.match(message(gladys).en, /paused/);
  const count = net.requests.length;
  await advance(5 * MINUTE, 1000);
  assert.equal(net.requests.length, count);
  const start = await send('mode', 3);
  assert.match(failure(start), /attendre/);
  assert.equal(net.requests.length, count);
  // The stop: its read is answered 429, the mode is sent alone, once.
  const stop = await send('mode', 0);
  assert.ok(ok(stop), failure(stop));
  assert.deepEqual(net.controls(), [{ mode: '0' }]);
});

test('another thermostat at the address: values hidden, commands refused, accepted in two clicks', async (t) => {
  const net = fakeNetwork();
  const { gladys, advance, send } = await setup(t, { config: ALLOWED, net });
  net.device.info.name = 'Basement';
  net.device.info.spacetemp = 15;
  await advance(61 * SECOND);
  assert.match(message(gladys).en, /Another thermostat/);
  assert.equal(last(gladys, 'temperature'), 20.5);
  const ack = await send('heat-setpoint', 22);
  assert.match(failure(ack), /autre thermostat/);
  assert.deepEqual(net.controls(), []);
  await gladys.fake.action(ACTIONS.ACCEPT_CHANGE);
  await gladys.fake.action(ACTIONS.ACCEPT_CHANGE);
  await advance(61 * SECOND);
  assert.equal(last(gladys, 'temperature'), 15);
});

test('a PIN refused: kept refused, the next start not sent; a stop still tries', async (t) => {
  const net = fakeNetwork(thermostat({ pin: '1111' }));
  const store = memoryStore();
  const { send } = await setup(t, { config: { ...ALLOWED, pin: '2222' }, net, store });
  const first = await send('heat-setpoint', 22);
  assert.match(failure(first), /PIN/);
  assert.match(store.data.targets['http://192.168.1.20'].refusedPin, /^[0-9a-f]{64}$/);
  const posts = net.controls().length;
  const second = await send('heat-setpoint', 23);
  assert.match(failure(second), /PIN/);
  assert.equal(net.controls().length, posts);
  await send('mode', 0);
  assert.equal(net.controls().length, posts + 1);
  assert.doesNotMatch(JSON.stringify(store.data), /2222/);
});

test('a secondary endpoint failing never stops the main values', async (t) => {
  const net = fakeNetwork();
  net.status.set('GET /query/alerts', 500);
  const { gladys } = await setup(t, { net });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(last(gladys, 'temperature'), 20.5);
});

test('an unreachable thermostat: backoff, never sooner than the interval', async (t) => {
  const net = fakeNetwork();
  net.unreachable = true;
  const { gladys, advance } = await setup(t, { net });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).en, /does not answer/);
  const tries = net.opened.length;
  await advance(59 * SECOND, 1000);
  assert.equal(net.opened.length, tries);
});
