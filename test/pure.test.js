// -----------------------------------------------------------------------------
// The pure parts: the answers read strictly, the unit rule of the reference,
// the configuration, the external ids, the conversions, /data repaired.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';
import {
  commandValue,
  convert,
  deviceIdOf,
  parseFeatureId,
  roundSetpoint,
  setpointRange,
} from '../src/devices.js';
import { normalizeMemory, secretHash, serializeMemory } from '../src/store.js';
import {
  apiUnit,
  parseAlerts,
  parseControlAnswer,
  parseInfo,
  parseRoot,
  parseSensors,
} from '../src/venstar/model.js';

test('GET /: the API version, the model defaults of the reference', () => {
  assert.deepEqual(
    parseRoot({ api_ver: 7, type: 'residential', model: 'T7900', firmware: '6.1' }),
    {
      apiVer: 7,
      supported: true,
      type: 'residential',
      model: 'T7900',
      firmware: [6, 1],
    },
  );
  assert.equal(parseRoot({ api_ver: 5, type: 'residential' }).model, 'COLORTOUCH (LEGACY)');
  assert.equal(parseRoot({ api_ver: 5, type: 'commercial' }).model, 'COLORTOUCH');
  assert.equal(parseRoot({ api_ver: 2 }).supported, false);
  assert.equal(parseRoot({ model: 'x' }), undefined);
  assert.equal(parseRoot(JSON.parse('{"__proto__": {"api_ver": 7}}')), undefined);
});

test('the unit of the API, as venstarcolortouch decides it', () => {
  const info = (tempUnits, heatMax) => ({ tempUnits, heatMax });
  const root = (model, firmware) => ({ model, firmware });
  assert.equal(apiUnit(root('T2000', [5, 10]), info(0, 90)), 'C');
  assert.equal(apiUnit(root('T2000', [5, 28]), info(0, 90)), 'F');
  assert.equal(apiUnit(root('COLORTOUCH', [6, 0]), info(1, 32)), 'C');
  assert.equal(apiUnit(root('COLORTOUCH', [6, 0]), info(undefined, 32)), undefined);
  assert.equal(apiUnit(root('OTHER', [6, 0]), info(1, 99)), 'F');
  assert.equal(apiUnit(root('OTHER', [6, 0]), info(0, 32)), 'C');
});

test('/query/info: only values of the expected type and range', () => {
  const info = parseInfo(
    {
      name: 'Up\u0000stairs',
      mode: 7,
      state: 1,
      fan: '1',
      heattemp: 21,
      cooltemp: 'x',
      setpointdelta: 2,
      availablemodes: 0,
      hum_setpoint: 30,
      dehum_setpoint: 55,
      hum_active: 99,
    },
    { apiVer: 5, type: 'residential' },
  );
  assert.equal(info.name, 'Upstairs');
  assert.equal(info.mode, undefined);
  assert.equal(info.fan, undefined);
  assert.equal(info.cool, undefined);
  assert.equal(info.heat, 21);
  // The swapped humidity fields of residential API-v5 units.
  assert.equal(info.humSetpoint, 55);
  assert.equal(info.dehumSetpoint, 99);
});

test('sensors, alerts and the control answer', () => {
  assert.deepEqual(
    parseSensors({
      sensors: [
        { name: 'Thermostat', temp: 20, hum: 40 },
        { name: 'Outdoor', temp: -3 },
        { name: 'Remote', type: 'Remote', temp: 19 },
      ],
    }),
    { humidity: 40, outdoor: -3 },
  );
  assert.deepEqual(parseSensors({ sensors: 'x' }), { humidity: undefined, outdoor: undefined });
  assert.deepEqual(parseAlerts({ alerts: [{ name: 'Air Filter', active: true }, { name: 1 }] }), [
    { name: 'Air Filter', active: true },
  ]);
  assert.equal(parseAlerts({}), undefined);
  assert.deepEqual(parseControlAnswer({ success: true }), { ok: true });
  assert.deepEqual(parseControlAnswer({ error: true, reason: 'Invalid PIN' }), {
    ok: false,
    pin: true,
  });
  assert.deepEqual(parseControlAnswer({ error: true, reason: 'Both Setpoints are required' }), {
    ok: false,
    pin: false,
  });
});

test('the configuration: address, HTTPS port, PIN, strict options', () => {
  assert.deepEqual(parseAddress('192.168.1.20'), { host: '192.168.1.20', port: 80 });
  assert.deepEqual(parseAddress('http://thermostat.lan:8080/x'), {
    host: 'thermostat.lan',
    port: 8080,
  });
  assert.deepEqual(parseAddress('192.168.1.20', true), { host: '192.168.1.20', port: 443 });
  assert.equal(parseAddress('999.1.1'), undefined);
  assert.equal(parseAddress('a@b'), undefined);
  const c = normalizeConfig({
    address: '192.168.1.20',
    use_https: 'true',
    username: ' admin ',
    password: 'pw',
    pin: '12',
    allow_commands: 'yes',
    poll_interval: 5,
  });
  assert.equal(c.key, '192.168.1.20');
  assert.equal(c.secure, true);
  assert.deepEqual(c.credentials, { username: 'admin', password: 'pw' });
  assert.equal(c.pin, '0012');
  assert.equal(c.allowCommands, false);
  assert.equal(c.pollInterval, 30);
  assert.equal(normalizeConfig({ pin: '12345' }).pinInvalid, true);
  assert.equal(normalizeConfig({ address: 'bad host!' }).invalidAddress, 'bad host!');
});

test('external ids: the frozen address rule', () => {
  assert.equal(deviceIdOf('192.168.1.20'), '192-168-1-20');
  assert.equal(deviceIdOf('Thermostat.lan:8080'), 'thermostat-lan-8080');
  assert.deepEqual(parseFeatureId('ext:sel:venstar:192-168-1-20:heat-setpoint'), {
    id: '192-168-1-20',
    key: 'heat-setpoint',
  });
  assert.equal(parseFeatureId('ext:sel:venstar:192-168-1-20:nope'), undefined);
});

test('commands: strict values, conversions, rounding, bounds', () => {
  assert.deepEqual(commandValue('mode', 0), { mode: 0 });
  assert.equal(commandValue('mode', 4), undefined);
  assert.deepEqual(commandValue('fan-mode', 'on'), { fan: 1 });
  assert.equal(commandValue('fan-mode', 1), undefined);
  assert.equal(commandValue('heat-setpoint', null), undefined);
  assert.equal(commandValue('heat-setpoint', ''), undefined);
  assert.equal(commandValue('temperature', 20), undefined);
  assert.deepEqual(commandValue('cool-setpoint', '24.5'), { setpoint: 'cool', asked: 24.5 });
  assert.equal(convert(70, 'F', 'C'), 21.1);
  assert.equal(roundSetpoint(21.26, 'C'), 21.5);
  assert.equal(roundSetpoint(70.4, 'F'), 70);
  assert.deepEqual(setpointRange('heat', 'C', 4.5, 32), { min: 5, max: 30 });
  assert.deepEqual(setpointRange('cool', 'F', 65, undefined), { min: 65, max: 95 });
});

test('/data: repaired, bounded, never a secret in clear', () => {
  const now = Date.UTC(2026, 9, 20);
  const memory = normalizeMemory(
    {
      salt: '0123456789abcdef0123456789abcdef',
      targets: {
        'http://192.168.1.20': {
          attemptAt: now + 1e9,
          pausedUntil: now + 1e12,
          certificate: 'nope',
          refusedCredentials: 'f'.repeat(64),
          identity: { model: 'COLORTOUCH', name: 'Up' },
        },
        'javascript:alert(1)': { attemptAt: 1 },
        __proto__: { attemptAt: 1 },
      },
    },
    now,
    6 * 3600_000,
  );
  const target = memory.targets.get('http://192.168.1.20');
  assert.equal(target.attemptAt, now);
  assert.equal(target.pausedUntil, now + 6 * 3600_000);
  assert.equal(target.certificate, undefined);
  assert.equal(memory.targets.size, 1);
  const hash = secretHash(memory.salt, 'credentials', 'admin', 'pw');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, secretHash('f'.repeat(32), 'credentials', 'admin', 'pw'));
  assert.doesNotMatch(JSON.stringify(serializeMemory(memory)), /"pw"|admin/);
});
