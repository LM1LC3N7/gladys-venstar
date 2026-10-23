// -----------------------------------------------------------------------------
// The answers of the Venstar local API, read strictly (pure). Only known keys
// of the expected type are taken (own keys only: an inherited or `__proto__`
// key is never read); a value of another type, out of range or missing is
// `undefined` ("unknown"), never a default.
//
// Ported from venstarcolortouch (MIT, hpeyerl): the minimum API version (3),
// the model defaults of `login()`, the unit rule of `update_info()` (T2xxx /
// T3xxx before firmware 5.28 always in °C; the listed models in the display
// unit; another model in °F when its heating maximum is 40 or more), the
// swapped humidity fields of residential API-v5 units, the sensor types.
// -----------------------------------------------------------------------------

import { LIMITS, VENSTAR } from '../constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A finite number, else undefined. */
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
/** An integer among the values allowed, else undefined. */
const among = (value, allowed) =>
  Number.isInteger(value) && allowed.includes(value) ? value : undefined;
/** A short printable text, else undefined. */
export function text(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.textLength);
}

/** A JSON body of the thermostat, or a PROTOCOL failure. */
export function parseJson(body) {
  try {
    const json = JSON.parse(body);
    return isObject(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/** "5.28" -> [5, 28]; undefined when unreadable. */
export function firmwareOf(value) {
  const match = /^(\d{1,3})\.(\d{1,3})/.exec(typeof value === 'string' ? value : '');
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/**
 * GET / -> { apiVer, type, model, firmware }, or undefined when it is not a
 * Venstar API answer. `supported` is false below the minimum API version.
 */
export function parseRoot(json) {
  const apiVer = finite(own(json, 'api_ver'));
  if (apiVer === undefined) {
    return undefined;
  }
  const type = text(own(json, 'type'))?.toLowerCase();
  let model = text(own(json, 'model'));
  let firmware = firmwareOf(own(json, 'firmware')) ?? [0, 0];
  if (model === undefined) {
    // venstarcolortouch login(): no model given -> a ColorTouch; residential
    // API-v5 units without it are legacy T5900 (firmware 4.08).
    model = 'COLORTOUCH';
    if (apiVer === 5 && type !== 'commercial') {
      model = 'COLORTOUCH (LEGACY)';
      firmware = [4, 8];
    }
  }
  return {
    apiVer,
    supported: apiVer >= VENSTAR.MIN_API_VER,
    type,
    model: model.toUpperCase(),
    firmware,
  };
}

/** The setpoint and limit fields of /query/info, finite and plausible in either unit. */
const temperature = (value) => {
  const n = finite(value);
  return n !== undefined && n > -60 && n < 150 ? n : undefined;
};

/** GET /query/info -> the state of the thermostat. */
export function parseInfo(json, root) {
  const read = (key) => own(json, key);
  const legacy = root?.apiVer === 5 && root?.type !== 'commercial';
  // Residential API-v5 units report the humidity setpoints in swapped fields.
  const humSetpointKey = legacy ? 'dehum_setpoint' : 'hum_setpoint';
  const dehumSetpointKey = legacy ? 'hum_active' : 'dehum_setpoint';
  const percent = (value) => {
    const n = finite(value);
    return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
  };
  return {
    name: text(read('name')),
    mode: among(read('mode'), Object.values(VENSTAR.MODE)),
    state: among(read('state'), Object.values(VENSTAR.STATE)),
    fan: among(read('fan'), Object.values(VENSTAR.FAN)),
    fanState: among(read('fanstate'), [0, 1]),
    tempUnits: among(read('tempunits'), Object.values(VENSTAR.TEMPUNITS)),
    heat: temperature(read('heattemp')),
    cool: temperature(read('cooltemp')),
    heatMin: temperature(read('heattempmin')),
    heatMax: temperature(read('heattempmax')),
    coolMin: temperature(read('cooltempmin')),
    coolMax: temperature(read('cooltempmax')),
    delta: (() => {
      const n = finite(read('setpointdelta'));
      return n !== undefined && n >= 0 && n <= 20 ? n : undefined;
    })(),
    spaceTemp: temperature(read('spacetemp')),
    availableModes: among(read('availablemodes'), Object.values(VENSTAR.AVAILABLE)),
    schedule: among(read('schedule'), [0, 1]),
    away: among(read('away'), [0, 1]),
    humSetpoint: percent(read(humSetpointKey)),
    dehumSetpoint: percent(read(dehumSetpointKey)),
  };
}

/**
 * The unit of the temperatures of the API ('C' or 'F'), as venstarcolortouch
 * decides it; undefined when it cannot be told.
 */
export function apiUnit(root, info) {
  if (!root || !info) {
    return undefined;
  }
  const model = root.model;
  const display =
    info.tempUnits === VENSTAR.TEMPUNITS.C
      ? 'C'
      : info.tempUnits === VENSTAR.TEMPUNITS.F
        ? 'F'
        : undefined;
  const t2t3 = model.startsWith('T2') || model.startsWith('T3');
  if (t2t3 && before(root.firmware, VENSTAR.UNIT_BUG_FIX)) {
    return 'C';
  }
  if (VENSTAR.DISPLAY_UNIT_MODELS.includes(model) || t2t3) {
    return display;
  }
  if (info.heatMax === undefined) {
    return undefined;
  }
  return info.heatMax >= 40 ? 'F' : 'C';
}

/**
 * GET /query/sensors -> { humidity, outdoor }: the indoor humidity of the
 * thermostat's own sensor, the temperature of an outdoor sensor when one is
 * listed. A sensor without a type is told by its name, as venstarcolortouch.
 */
export function parseSensors(json) {
  const list = own(json, 'sensors');
  const out = { humidity: undefined, outdoor: undefined };
  if (!Array.isArray(list)) {
    return out;
  }
  for (const sensor of list.slice(0, LIMITS.sensors)) {
    const name = text(own(sensor, 'name'));
    const type = text(own(sensor, 'type')) ?? (name === 'Thermostat' ? 'Local' : name);
    if (type === 'Local' && out.humidity === undefined) {
      const hum = finite(own(sensor, 'hum'));
      out.humidity = hum !== undefined && hum >= 0 && hum <= 100 ? hum : undefined;
    } else if (type === 'Outdoor' && out.outdoor === undefined) {
      out.outdoor = temperature(own(sensor, 'temp'));
    }
  }
  return out;
}

/** GET /query/alerts -> [{ name, active }] (bounded), or undefined when unreadable. */
export function parseAlerts(json) {
  const list = own(json, 'alerts');
  if (!Array.isArray(list)) {
    return undefined;
  }
  const alerts = [];
  for (const alert of list.slice(0, LIMITS.alerts)) {
    const name = text(own(alert, 'name'));
    const active = own(alert, 'active');
    if (name !== undefined && typeof active === 'boolean') {
      alerts.push({ name, active });
    }
  }
  return alerts;
}

/**
 * The answer of POST /control: { ok: true }, or { ok: false, pin } when the
 * thermostat refused (`pin`: its reason names the PIN). The reason itself is
 * never kept (it is not shown nor logged).
 */
export function parseControlAnswer(json) {
  if (own(json, 'success') === true) {
    return { ok: true };
  }
  const reason = typeof own(json, 'reason') === 'string' ? own(json, 'reason').slice(0, 200) : '';
  return { ok: false, pin: /\bpin\b/i.test(reason) };
}
