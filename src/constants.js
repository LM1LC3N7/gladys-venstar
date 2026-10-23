// -----------------------------------------------------------------------------
// Venstar constants, manifest keys, limits and timings.
//
// A Venstar ColorTouch or Explorer thermostat serves a documented local API
// (developer.venstar.com), as venstarcolortouch (MIT, 0.22) and the Home
// Assistant "venstar" integration use it:
//   GET  /                the API version, type, model and firmware
//   GET  /query/info      mode, state, fan, setpoints, limits, name, units
//   GET  /query/sensors   the sensors (indoor humidity, outdoor temperature)
//   GET  /query/alerts    the alerts (air filter, UV lamp, service)
//   POST /control         mode, fan, heattemp + cooltemp (form encoded)
// Plain HTTP by default; HTTPS with HTTP Digest authentication when the
// thermostat's "Basic Auth" is on (a self-signed certificate: pinned here).
// -----------------------------------------------------------------------------

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  OUTDOOR: 'outdoor-temperature',
  HEAT_SETPOINT: 'heat-setpoint',
  COOL_SETPOINT: 'cool-setpoint',
  MODE: 'mode',
  FAN: 'fan-mode',
  FAN_RUNNING: 'fan-running',
  OPERATING_STATE: 'operating-state',
  STATUS: 'status',
  FILTER: 'filter-alert',
  ALERTS: 'alerts',
};

export const COMMAND_FEATURES = [
  FEATURES.HEAT_SETPOINT,
  FEATURES.COOL_SETPOINT,
  FEATURES.MODE,
  FEATURES.FAN,
];

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  ACCEPT_CHANGE: 'accept_change',
};

/** The device type of the external ids: `ext:<selector>:venstar:<id>`. */
export const DEVICE_TYPE = 'venstar';

/** Gladys core values (server/utils/constants.js; the SDK does not export them). */
export const THERMOSTAT_MODE = { OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 };
export const THERMOSTAT_OPERATING_STATE = { IDLE: 0, HEATING: 1, COOLING: 2 };

/** The Venstar API values (venstarcolortouch.py). */
export const VENSTAR = {
  MIN_API_VER: 3,
  MODE: { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 },
  STATE: { IDLE: 0, HEATING: 1, COOLING: 2, LOCKOUT: 3, ERROR: 4 },
  FAN: { AUTO: 0, ON: 1 },
  TEMPUNITS: { F: 0, C: 1 },
  /** availablemodes: 0 all, 1 heat/cool (no auto), 2 heat only, 3 cool only. */
  AVAILABLE: { ALL: 0, HEAT_COOL: 1, HEAT: 2, COOL: 3 },
  /** Firmware from which T2xxx / T3xxx report the display unit (venstarcolortouch). */
  UNIT_BUG_FIX: [5, 28],
  /** Models whose API unit is the display unit (venstarcolortouch update_info). */
  DISPLAY_UNIT_MODELS: [
    'VYG-4900-VEN',
    'VYG-4800-VEN',
    'VYG-3800',
    'VYG-3900',
    'COLORTOUCH',
    'TOUCHSCREEN',
  ],
};

/**
 * The setpoints Gladys may send, in the unit of the feature, checked on the
 * raw value before any conversion or rounding: refused outside, never brought
 * into range. The thermostat's own limits are checked after, in its unit.
 */
export const SETPOINT_BOUNDS = {
  heat: { celsius: { min: 5, max: 30 }, fahrenheit: { min: 41, max: 86 } },
  cool: { celsius: { min: 16, max: 35 }, fahrenheit: { min: 61, max: 95 } },
};

/** The step of a setpoint written: 0.5 °C, 1 °F. */
export const SETPOINT_STEP = { C: 0.5, F: 1 };

export const POLL_INTERVAL = { min: 30, max: 600, default: 60 };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** One answer of the thermostat (an info answer is under 1 KB). */
  responseBytes: 32 * 1024,
  headerBytes: 8 * 1024,
  /** The Digest challenge read from the network. */
  challengeBytes: 1024,
  /** Sensors and alerts kept from one answer. */
  sensors: 16,
  alerts: 16,
  /** Longest text kept from an answer (names, models, alert names). */
  textLength: 40,
  /** Stop sessions at once. */
  stops: 3,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** The whole poll (connection and the four requests). */
  pollBudget: 20 * SECOND,
  /** One request of a poll (venstarcolortouch: the timeout given, 5 s in Home Assistant). */
  requestTimeout: 5 * SECOND,
  connectTimeout: 5 * SECOND,
  /** Failed reads: 1, 2, 5, then 10 minutes, never shorter than the interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE],
  /** HTTP 429 or 5xx: every read paused (Retry-After when given), within these bounds. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** The time of the last attempt is written to /data at most this often. */
  attemptSave: MINUTE,
  /** The "Test the connection" button: at most this often, answered within 25 s (timeout 30 s). */
  testCooldown: 10 * SECOND,
  testAnswerBy: 25 * SECOND,
  /** "Accept the change": the second click within this time takes what the first one showed. */
  acceptConfirm: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): written by 3.5 s after the click
   * or refused unsent; the answer and the read back are awaited until 4.3 s,
   * after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** One read of the state after a command that was not confirmed. */
  followUp: 5 * SECOND,
  /** A command not confirmed keeps its guard until the state shows it, or 90 s. */
  guard: 90 * SECOND,
  /** A stop to write again (a start sent before it answered after it): tried within this time. */
  reaffirm: 90 * SECOND,
};
