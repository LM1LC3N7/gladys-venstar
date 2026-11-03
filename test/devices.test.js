// -----------------------------------------------------------------------------
// Every feature of every device the module can build passes the Gladys model
// (t_device_feature): a null min or max makes Gladys answer HTTP 422 and
// refuse the whole thermostat when the user adds it (the fan list had none
// up to 0.1.1). The SDK's fake Gladys does not check it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { FEATURES } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';
import { assertCoreDevice } from './helpers/coreFeature.js';

const gladys = createFakeGladys();
const ID = '192-168-1-50';
const ALERTS = [
  undefined,
  [],
  [
    { name: 'Air Filter', active: true },
    { name: 'Service', active: false },
  ],
];
const LIMITS = [
  {},
  { heatMin: 35, heatMax: 99, coolMin: 35, coolMax: 99 },
  { heatMin: 2, heatMax: 37, coolMin: 2, coolMax: 37 },
];

/** Every snapshot shape: units, mode sets, sensors, alerts, limits, names and firmware. */
function* everySnapshot() {
  for (const unit of ['C', 'F']) {
    for (const availableModes of [undefined, 0, 1, 2, 3, 9]) {
      for (const humidity of [undefined, 40]) {
        for (const outdoor of [undefined, 12]) {
          for (const alerts of ALERTS) {
            for (const limits of LIMITS) {
              for (const [name, root] of [
                ['Hall', { model: 'T7900', firmware: [6, 1] }],
                [undefined, { model: 'COLORTOUCH (LEGACY)' }],
              ]) {
                yield {
                  unit,
                  info: { name, availableModes, ...limits },
                  sensors: { humidity, outdoor },
                  alerts,
                  root,
                };
              }
            }
          }
        }
      }
    }
  }
}

test('every feature of every buildable thermostat has what the Gladys model needs', () => {
  let devices = 0;
  for (const snapshot of everySnapshot()) {
    for (const language of ['en', 'fr']) {
      const where = `${JSON.stringify(snapshot)}/${language}`;
      const device = buildDevice(gladys, ID, snapshot, { language });
      assertCoreDevice(device, where);
      // Rebuilt over the device as Gladys created it: the kept features too.
      const again = buildDevice(
        gladys,
        ID,
        { ...snapshot, alerts: [] },
        { language, created: device },
      );
      assertCoreDevice(again, `${where} created`);
      devices += 2;
    }
  }
  assert.equal(devices, 2 * 6 * 2 * 2 * ALERTS.length * LIMITS.length * 2 * 2 * 2);
});

test('the fan list has min 0 and max 0, like the other text/select features of Gladys', () => {
  const snapshot = { unit: 'F', info: {}, sensors: {}, root: { model: 'T7900' } };
  const device = buildDevice(gladys, ID, snapshot, { language: 'fr' });
  const fan = device.features.find((f) => f.external_id.endsWith(`:${FEATURES.FAN}`));
  assert.deepEqual([fan.category, fan.type, fan.min, fan.max], ['text', 'select', 0, 0]);
});
