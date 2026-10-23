// -----------------------------------------------------------------------------
// The thermostat -> one Gladys device and its states, and the change a
// Gladys command asks for (pure).
//
// Identifier rule (frozen, it fixes the external ids):
//   `ext:<selector>:venstar:<address>`
//   <address>: the address typed in the configuration, lower case, letters
//     and digits, every other character as "-" ("192.168.1.20" ->
//     "192-168-1-20", "thermostat.lan:8080" -> "thermostat-lan-8080"); the
//     port only when it is not the default one (80, or 443 with HTTPS), so
//     turning HTTPS on keeps the same device. The local API gives no serial
//     number nor MAC address: the device follows the address (give the
//     thermostat a fixed address in the router); the identity read at the
//     address (model, type, name) is checked at every read and command.
// The feature keys and the option values are published forever.
//
// Never a `switch` nor a writable `binary`: the core hands every switch to
// the voice assistants, MCP and the "turn everything off" scene actions. The
// mode is `thermostat/mode` (off, heating, cooling, auto), the setpoints
// `thermostat/target-temperature` (heating) and
// `air-conditioning/target-temperature` (cooling), the fan a `text/select`.
//
// Units: the features take the unit of the thermostat's API (°F or °C, both
// listed by the core for these categories) when they are created; a value is
// always converted to the unit of the feature as it was CREATED in Gladys.
// A device published again never loses a feature: those of the device
// already created are kept as they were created.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  COMMAND_FEATURES,
  DEVICE_TYPE,
  FEATURES,
  SETPOINT_BOUNDS,
  SETPOINT_STEP,
  THERMOSTAT_MODE,
  THERMOSTAT_OPERATING_STATE,
  VENSTAR,
} from './constants.js';
import {
  DEVICE_NAME,
  FAN_NAMES,
  FEATURE_NAMES,
  MODE_NAMES,
  NO_ALERT,
  STATE_NAMES,
  word,
} from './i18n.js';

/** The id part of the external ids, from the address key (frozen rule above). */
export const deviceIdOf = (key) =>
  String(key ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

export const deviceIds = (gladys, id) => gladys.externalIds(DEVICE_TYPE, id);

export const KEYS = Object.values(FEATURES);

/** The id and feature key of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = /:venstar:([a-z0-9-]{1,80}):([a-z-]{1,40})$/.exec(externalId);
  return match && KEYS.includes(match[2]) ? { id: match[1], key: match[2] } : undefined;
}

/** The id of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:venstar:([a-z0-9-]{1,80})$/.exec(String(externalId ?? '').slice(0, 300));
  return match ? match[1] : undefined;
}

/** The Gladys unit of a thermostat unit ('C' / 'F'), and back. */
export const gladysUnit = (unit) => (unit === 'C' ? U.CELSIUS : U.FAHRENHEIT);
export const apiUnitOf = (unit) =>
  unit === U.CELSIUS ? 'C' : unit === U.FAHRENHEIT ? 'F' : undefined;

/** A temperature from one unit ('C' / 'F') to another, exactly (no rounding). */
export function convertExact(value, from, to) {
  if (!Number.isFinite(value) || !from || !to) {
    return undefined;
  }
  if (from === to) {
    return value;
  }
  return from === 'F' ? ((value - 32) * 5) / 9 : (value * 9) / 5 + 32;
}

/** A temperature for a state: converted, to 0.1 degree. */
export function convert(value, from, to) {
  const v = convertExact(value, from, to);
  return v === undefined ? undefined : Math.round(v * 10) / 10;
}

/** What the thermostat offers, from `availablemodes` (unknown: all). */
export function offers(available) {
  switch (available) {
    case VENSTAR.AVAILABLE.HEAT_COOL:
      return { heat: true, cool: true, auto: false };
    case VENSTAR.AVAILABLE.HEAT:
      return { heat: true, cool: false, auto: false };
    case VENSTAR.AVAILABLE.COOL:
      return { heat: false, cool: true, auto: false };
    default:
      return { heat: true, cool: true, auto: true };
  }
}

/** Venstar mode <-> Gladys THERMOSTAT_MODE (the same numbers, kept explicit). */
export const MODE_MAP = [
  ['off', VENSTAR.MODE.OFF, THERMOSTAT_MODE.OFF],
  ['heat', VENSTAR.MODE.HEAT, THERMOSTAT_MODE.HEATING],
  ['cool', VENSTAR.MODE.COOL, THERMOSTAT_MODE.COOLING],
  ['auto', VENSTAR.MODE.AUTO, THERMOSTAT_MODE.AUTO],
];
export const FAN_MAP = [
  ['auto', VENSTAR.FAN.AUTO],
  ['on', VENSTAR.FAN.ON],
];

const command = (definition) => ({
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...definition,
});
const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const words = () =>
  sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });

/** The bounds of a setpoint feature, in the API unit: ours within the thermostat's limits. */
export function setpointRange(kind, unit, min, max) {
  const bounds = SETPOINT_BOUNDS[kind][gladysUnit(unit)];
  const low = Number.isFinite(min) ? Math.max(bounds.min, Math.min(min, bounds.max)) : bounds.min;
  const high = Number.isFinite(max) ? Math.min(bounds.max, Math.max(max, bounds.min)) : bounds.max;
  return { min: low, max: Math.max(low, high) };
}

/** The filter alert, when the thermostat lists one. */
export const filterAlert = (alerts) => (alerts ?? []).find((a) => /filter/i.test(a.name));

/** The features of a thermostat read, by key, in display order. */
export function definitions(snapshot, language) {
  const { unit, info, sensors, alerts } = snapshot;
  const temperatureUnit = gladysUnit(unit);
  const can = offers(info.availableModes);
  const defs = {};
  defs[FEATURES.TEMPERATURE] = sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: temperatureUnit,
    min: unit === 'C' ? -20 : -4,
    max: unit === 'C' ? 60 : 140,
  });
  if (sensors.humidity !== undefined) {
    defs[FEATURES.HUMIDITY] = sensor({
      category: C.HUMIDITY_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.PERCENT,
      min: 0,
      max: 100,
    });
  }
  if (sensors.outdoor !== undefined) {
    // A probe: the core keeps it out of the temperature of the room.
    defs[FEATURES.OUTDOOR] = sensor({
      category: C.TEMPERATURE_SENSOR,
      type: T.TEMPERATURE_SENSOR.PROBE,
      unit: temperatureUnit,
      min: unit === 'C' ? -50 : -58,
      max: unit === 'C' ? 60 : 140,
    });
  }
  // Commands, refused unless the user allowed them (`allow_commands`, off by
  // default): read_only is fixed when the device is created, so the
  // permission is checked at each command instead.
  if (can.heat) {
    defs[FEATURES.HEAT_SETPOINT] = command({
      category: C.THERMOSTAT,
      type: T.THERMOSTAT.TARGET_TEMPERATURE,
      unit: temperatureUnit,
      ...setpointRange('heat', unit, info.heatMin, info.heatMax),
    });
  }
  if (can.cool) {
    defs[FEATURES.COOL_SETPOINT] = command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.TARGET_TEMPERATURE,
      unit: temperatureUnit,
      ...setpointRange('cool', unit, info.coolMin, info.coolMax),
    });
  }
  const modes = MODE_MAP.filter(([name]) => name === 'off' || can[name]);
  defs[FEATURES.MODE] = command({
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.MODE,
    min: THERMOSTAT_MODE.OFF,
    max: Math.max(...modes.map(([, , value]) => value)),
    supported_options: modes.map(([name, , value], index) => ({
      value,
      label: word(MODE_NAMES[name], language),
      sort_order: index,
    })),
  });
  defs[FEATURES.FAN] = command({
    category: C.TEXT,
    type: T.TEXT.SELECT,
    keep_history: false,
    supported_options: FAN_MAP.map(([name], index) => ({
      value: name,
      label: word(FAN_NAMES[name], language),
      sort_order: index,
    })),
  });
  defs[FEATURES.FAN_RUNNING] = sensor({
    category: C.UNKNOWN,
    type: T.UNKNOWN.UNKNOWN,
    min: 0,
    max: 1,
  });
  defs[FEATURES.OPERATING_STATE] = sensor({
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.OPERATING_STATE,
    min: THERMOSTAT_OPERATING_STATE.IDLE,
    max: THERMOSTAT_OPERATING_STATE.COOLING,
  });
  defs[FEATURES.STATUS] = words();
  if (filterAlert(alerts)) {
    defs[FEATURES.FILTER] = sensor({
      category: C.UNKNOWN,
      type: T.UNKNOWN.UNKNOWN,
      min: 0,
      max: 1,
    });
  }
  if (alerts !== undefined) {
    defs[FEATURES.ALERTS] = words();
  }
  return defs;
}

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

/**
 * The device of the thermostat. `created`: the device already created in
 * Gladys: each of its features is kept as it was created (category, type,
 * unit, bounds and options are fixed in Gladys: a change marks the device
 * "structure changed", and "Update" would destroy the history); new features
 * are added after them.
 */
export function buildDevice(gladys, id, snapshot, { language, created }) {
  const ids = deviceIds(gladys, id);
  const defs = definitions(snapshot, language);
  const params = [{ name: 'model', value: snapshot.root.model }];
  if (snapshot.root.firmware) {
    params.push({ name: 'firmware', value: snapshot.root.firmware.join('.') });
  }
  const built = {
    name: word(DEVICE_NAME(snapshot.info.name), language),
    external_id: ids.device,
    model: `Venstar ${snapshot.root.model}`.slice(0, 60),
    should_poll: false,
    features: Object.entries(defs).map(([key, def]) => ({
      name: word(FEATURE_NAMES[key], language),
      external_id: ids.feature(key),
      ...def,
    })),
    params,
  };
  if (!created || !Array.isArray(created.features)) {
    return built;
  }
  const fresh = new Map(built.features.map((f) => [f.external_id, f]));
  const kept = created.features
    .filter((f) => typeof f?.external_id === 'string')
    .map((f) => {
      const entry = Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      );
      entry.name = fresh.get(f.external_id)?.name ?? f.name;
      return entry;
    });
  const known = new Set(kept.map((f) => f.external_id));
  return {
    ...built,
    features: [...kept, ...built.features.filter((f) => !known.has(f.external_id))],
  };
}

/**
 * The current values, each in the unit of the feature as created (`created`:
 * featureId -> feature). Unknown values are left out, never sent as
 * undefined or NaN.
 */
export function thermostatStates(ids, snapshot, created, language) {
  const { unit, info, sensors, alerts } = snapshot;
  const states = [];
  const add = (key, value) => {
    const id = ids.feature(key);
    if (value !== undefined && value !== null && created.has(id)) {
      states.push({ device_feature_external_id: id, ...value });
    }
  };
  const number = (n) => (Number.isFinite(n) ? { state: n } : undefined);
  const temperatureOf = (key, value) => {
    const target = apiUnitOf(created.get(ids.feature(key))?.unit);
    return number(convert(value, unit, target));
  };
  add(FEATURES.TEMPERATURE, temperatureOf(FEATURES.TEMPERATURE, info.spaceTemp));
  add(FEATURES.HUMIDITY, number(sensors.humidity));
  add(FEATURES.OUTDOOR, temperatureOf(FEATURES.OUTDOOR, sensors.outdoor));
  add(FEATURES.HEAT_SETPOINT, temperatureOf(FEATURES.HEAT_SETPOINT, info.heat));
  add(FEATURES.COOL_SETPOINT, temperatureOf(FEATURES.COOL_SETPOINT, info.cool));
  add(FEATURES.MODE, number(MODE_MAP.find((row) => row[1] === info.mode)?.[2]));
  const fan = FAN_MAP.find((row) => row[1] === info.fan)?.[0];
  add(FEATURES.FAN, fan === undefined ? undefined : { text: fan });
  add(FEATURES.FAN_RUNNING, number(info.fanState));
  // Lockout and error are no operating state of the core: only the status text shows them.
  const operating = {
    [VENSTAR.STATE.IDLE]: THERMOSTAT_OPERATING_STATE.IDLE,
    [VENSTAR.STATE.HEATING]: THERMOSTAT_OPERATING_STATE.HEATING,
    [VENSTAR.STATE.COOLING]: THERMOSTAT_OPERATING_STATE.COOLING,
  }[info.state];
  add(FEATURES.OPERATING_STATE, number(operating));
  add(
    FEATURES.STATUS,
    STATE_NAMES[info.state] ? { text: word(STATE_NAMES[info.state], language) } : undefined,
  );
  if (alerts !== undefined) {
    const filter = filterAlert(alerts);
    add(FEATURES.FILTER, filter ? { state: filter.active ? 1 : 0 } : undefined);
    const active = alerts.filter((a) => a.active).map((a) => a.name);
    add(FEATURES.ALERTS, {
      text: active.length > 0 ? active.join(', ').slice(0, 200) : word(NO_ALERT, language),
    });
  }
  return states;
}

/** A command value, strictly: a finite number, or a text that is exactly one. */
export function strictNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(?:\.\d{1,3})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The change a command asks, checked on its own (before any read), or
 * undefined when the value is not one the feature takes:
 *   { setpoint: 'heat' | 'cool', asked }  (asked: in the unit of the feature)
 *   { mode: 0..3 }                         (the Venstar mode)
 *   { fan: 0 | 1 }
 */
export function commandValue(key, value) {
  if (!COMMAND_FEATURES.includes(key)) {
    return undefined;
  }
  if (key === FEATURES.FAN) {
    const fan = FAN_MAP.find((row) => row[0] === value)?.[1];
    return fan === undefined ? undefined : { fan };
  }
  const n = strictNumber(value);
  if (n === undefined) {
    return undefined;
  }
  if (key === FEATURES.MODE) {
    const mode = MODE_MAP.find((row) => row[2] === n)?.[1];
    return mode === undefined ? undefined : { mode };
  }
  return { setpoint: key === FEATURES.HEAT_SETPOINT ? 'heat' : 'cool', asked: n };
}

/** A setpoint in the API unit, rounded to the thermostat's step (0.5 °C, 1 °F). */
export function roundSetpoint(value, unit) {
  const step = SETPOINT_STEP[unit];
  return Number((Math.round(value / step) * step).toFixed(2));
}
