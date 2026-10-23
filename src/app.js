// -----------------------------------------------------------------------------
// The integration: the Venstar thermostat at the address typed in the
// configuration, one read every poll interval (GET /, /query/info,
// /query/sensors, /query/alerts on one connection), its Gladys device and
// states, the transport badge, the "Test the connection" and "Accept the
// change" buttons, and the commands (setpoints, mode, fan), refused unless
// the configuration allows them. index.js only wires the SDK.
//
// Reads are never sooner than the interval: the time of the last attempt is
// kept in /data (written before the read, at most once a minute) and a
// restart, a reconnection to Gladys, the Discovery tab, a configuration saved
// unchanged or the test button never read again before it is due. A read or
// a command answer that arrives after a restart (an older configuration)
// publishes nothing and sets no status (the generation is checked after each
// await).
//
// HTTPS: the certificate is pinned at the first connection (kept in /data
// before the password leaves) and checked on every connection before any
// byte is written; another certificate stops everything until the user
// accepts exactly the one shown ("Accept the change", two clicks). The user
// name and password are never sent over plain HTTP.
//
// Refusals: a user name or password refused stops the reads for good (a
// salted fingerprint of the refused pair kept in /data, never of a good one);
// new credentials or "Test the connection" (at most once per interval) try
// again; never an automatic retry. A PIN refused keeps the commands refused
// until it changes. HTTP 429 / 5xx pause every read (1 min to 6 h, kept in
// /data); the commands wait too, except the stop.
//
// The commands follow the rules learnt on the previous modules:
//   - decided on a fresh read (GET / and /query/info, on the connection of
//     the command), never on the state kept in memory; refused when a value
//     it needs is unknown, or when another thermostat answers;
//   - the "Allow the commands" option is checked on arrival and again right
//     before the write; written within 3.5 s of the click or refused unsent;
//   - confirmed only by a read back equal to what was asked (by 4.3 s), else
//     "sent, without confirmation", a guard and one more read 5 s later;
//   - the ack never waits for a publication to Gladys;
//   - setpoints bounded (heating 5-30 °C / 41-86 °F, cooling 16-35 °C /
//     61-95 °F, and the thermostat's own limits), refused outside, never
//     brought into range; the other setpoint is written back exactly as read;
//   - one command at a time; the stop (mode "off") is never refused for that,
//     nor for a pause or a refusal kept in /data: it cancels a command not
//     written yet, runs on its own connection, is never skipped as "already
//     off", needs no read before it (it rewrites the setpoints read when it
//     can, else sends the mode alone) and works after a restart before the
//     first read. A start written before a stop whose answer comes after it
//     makes the stop be written again (reaffirmed).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { LIMITS, SECOND, SETPOINT_BOUNDS, TIMINGS, VENSTAR } from './constants.js';
import {
  apiUnitOf,
  buildDevice,
  commandValue,
  convertExact,
  deviceIdOf,
  deviceIds,
  filterAlert,
  offers,
  parseDeviceId,
  parseFeatureId,
  roundSetpoint,
  thermostatStates,
} from './devices.js';
import { ERRORS, T, age, both, describe, errorReason, join, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { emptyTarget, fileStore, normalizeMemory, secretHash, serializeMemory } from './store.js';
import { Session } from './venstar/client.js';
import { ERROR_KINDS, VenstarError, notSent, openConnection } from './venstar/http.js';
import {
  apiUnit,
  parseAlerts,
  parseControlAnswer,
  parseInfo,
  parseRoot,
  parseSensors,
} from './venstar/model.js';

/** The thermostat of the configuration, as nothing was read yet. */
const freshThermostat = (config) => ({
  target: `${config.secure ? 'https' : 'http'}://${config.key}`,
  key: config.key,
  id: deviceIdOf(config.key),
  /** The last good read: { root, info, unit, sensors, alerts }. */
  snapshot: undefined,
  /** The features ever seen (a feature never leaves Discovery once seen). */
  shape: { humidity: false, outdoor: false, filter: false, alerts: false },
  online: undefined,
  /** Why the values are not shown: undefined, or { kind, ... }. */
  problem: undefined,
  reason: undefined,
  failures: 0,
  wait: undefined,
  nextAt: 0,
  timer: undefined,
  running: undefined,
  followUp: undefined,
});

/** A refusal shown to the user (the message of the command error). */
class Refusal extends Error {}

export class VenstarApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'venstar' }),
    open = openConnection,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.open = open;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now(), TIMINGS.pauseMax);
    this.thermostat = undefined;
    this.generation = 0;
    this.started = false;
    this.lifecycle = Promise.resolve();
    this.latestAllow = undefined;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    this.pendingAccept = undefined;
    /** The start / setpoint / fan command in flight: { cancelled, sentSeq }. */
    this.inFlight = undefined;
    /** The stops in flight. */
    this.stops = [];
    /** `${field}:${kind}` -> { from, expected, moved, until }: sent, not seen yet. */
    this.guards = new Map();
    /** Every write gets a number in its beforeSend; the last stop written keeps its own. */
    this.writeSeq = 0;
    this.lastStopSeq = 0;
    /** A stop to write again: { until, running }. */
    this.reaffirm = undefined;
    /** The exact time of the last read attempt, per target (memory only). */
    this.readAt = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Starts, connections and configuration changes run one after the other. */
  serialized(fn) {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  start(raw = {}) {
    this.disableAtOnce(raw);
    return this.serialized(() => this.doStart(raw));
  }

  connected(raw = {}) {
    this.disableAtOnce(raw);
    return this.serialized(() => this.doConnected(raw));
  }

  configUpdated(raw = {}) {
    this.disableAtOnce(raw);
    return this.serialized(() => this.doConfigUpdated(raw));
  }

  /** Commands turned off apply at once, before the queue; turning them on waits its turn. */
  disableAtOnce(raw) {
    this.latestAllow = normalizeConfig(raw).allowCommands;
    if (!this.latestAllow && this.config.allowCommands) {
      this.config = { ...this.config, allowCommands: false };
      this.logger.info('Venstar commands disabled');
    }
  }

  /** A configuration taken from the queue never turns back on commands turned off later. */
  configOf(raw) {
    const config = normalizeConfig(raw);
    return this.latestAllow === false ? { ...config, allowCommands: false } : config;
  }

  async doStart(raw) {
    this.stop();
    const generation = this.generation;
    this.config = this.configOf(raw);
    await this.thermostat?.running?.catch(() => {});
    const loaded = await this.store.load().catch(() => null);
    if (generation !== this.generation) {
      return;
    }
    // A restart inside the process keeps the salt and what /data may lag behind on.
    const known = this.memory;
    this.memory = normalizeMemory(loaded, this.now(), TIMINGS.pauseMax);
    if (!loaded) {
      this.memory.salt = known.salt;
    }
    this.thermostat = this.config.key ? freshThermostat(this.config) : undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.pendingAccept = undefined;
    this.publisher.start();
    await this.publishAll(generation);
    const t = this.thermostat;
    if (!t) {
      return;
    }
    const memory = this.targetMemory(t);
    if (this.credentialsRefused()) {
      // Never an automatic retry: new credentials or the test button.
      t.problem = { kind: 'refused' };
      await this.publishAll(generation);
      return;
    }
    // The first read: never sooner than the interval after the last attempt.
    // Read back from /data only (a container restart), the time may be up to
    // a minute old: then at least a minute after it.
    const exact = this.readAt.get(t.target);
    const attemptAt = exact ?? memory.attemptAt;
    const wait = exact !== undefined ? this.interval : Math.max(this.interval, TIMINGS.attemptSave);
    const due = attemptAt > 0 ? attemptAt + wait : 0;
    this.schedule(t, Math.max(0, due - this.now(), memory.pausedUntil - this.now()));
  }

  stop() {
    this.generation += 1;
    if (this.thermostat) {
      this.clearTimers(this.thermostat);
    }
    this.publisher.stop();
  }

  clearTimers(t) {
    if (t.timer) {
      this.timers.clearTimeout(t.timer);
      t.timer = undefined;
    }
    if (t.followUp) {
      this.timers.clearTimeout(t.followUp);
      t.followUp = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badges) and the
   * last states, without reading the thermostat again.
   */
  async doConnected(raw) {
    if (!this.started) {
      this.started = true;
      await this.doStart(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.doStart(raw);
      return;
    }
    this.config = this.configOf(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll(this.generation);
  }

  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      next.key !== this.config.key ||
      next.secure !== this.config.secure ||
      next.pollInterval !== this.config.pollInterval ||
      JSON.stringify(next.credentials ?? null) !== JSON.stringify(this.config.credentials ?? null)
    );
  }

  /** New address, HTTPS, credentials or interval restart; the rest applies at once. */
  async doConfigUpdated(raw) {
    if (this.needsRestart(raw)) {
      await this.doStart(raw);
      return;
    }
    const previous = this.config;
    this.config = this.configOf(raw);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`Venstar commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language) {
      this.published = undefined;
    }
    await this.publishAll(this.generation);
  }

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  // --- /data -------------------------------------------------------------------

  targetMemory(t = this.thermostat) {
    let entry = this.memory.targets.get(t.target);
    if (!entry) {
      // 4 targets at most: the oldest other one goes.
      if (this.memory.targets.size >= 4) {
        const other = [...this.memory.targets.keys()].find((k) => k !== t.target);
        this.memory.targets.delete(other);
      }
      entry = emptyTarget();
      this.memory.targets.set(t.target, entry);
    }
    return entry;
  }

  /** Saves the memory; resolves false when /data refused it. */
  async saveMemory() {
    try {
      await this.store.save(serializeMemory(this.memory));
      return true;
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err?.code ?? 'error'}`);
      return false;
    }
  }

  credentialsHash() {
    const c = this.config.credentials;
    return secretHash(this.memory.salt, 'credentials', c?.username ?? '', c?.password ?? '');
  }

  pinHash() {
    return secretHash(this.memory.salt, 'pin', this.config.pin ?? '');
  }

  /** Whether the user name and password of the configuration were refused (kept in /data). */
  credentialsRefused(t = this.thermostat) {
    const memory = t ? this.memory.targets.get(t.target) : undefined;
    return Boolean(
      memory?.refusedCredentials && memory.refusedCredentials === this.credentialsHash(),
    );
  }

  pinRefused(t = this.thermostat) {
    const memory = t ? this.memory.targets.get(t.target) : undefined;
    return Boolean(this.config.pin && memory?.refusedPin && memory.refusedPin === this.pinHash());
  }

  paused(t = this.thermostat) {
    const memory = t ? this.memory.targets.get(t.target) : undefined;
    return (memory?.pausedUntil ?? 0) > this.now();
  }

  // --- Sessions ----------------------------------------------------------------

  /**
   * A session with the thermostat. `generation`: a read or a start command,
   * given up when the configuration changed; null for a stop (never refused
   * for a configuration saved meanwhile, as long as the address is the same).
   */
  session(t, generation) {
    return new Session({
      address: this.config.address,
      secure: this.config.secure,
      credentials: this.config.credentials,
      open: this.open,
      checkCertificate: (fingerprint) => this.trust(fingerprint, t, generation),
    });
  }

  /**
   * The certificate of a new connection, checked BEFORE anything is written:
   * the pin of the address, or, at the first connection, pinned now (kept in
   * /data before the password leaves). Another one is refused, and kept for
   * "Accept the change".
   */
  async trust(fingerprint, t, generation) {
    const stale = () =>
      new VenstarError(ERROR_KINDS.STALE, 'The configuration changed', { notSent: true });
    if (
      (generation !== null && generation !== this.generation) ||
      this.thermostat?.target !== t.target
    ) {
      throw stale();
    }
    const memory = this.targetMemory(t);
    if (memory.certificate && memory.certificate !== fingerprint) {
      if (memory.refusedCertificate !== fingerprint) {
        memory.refusedCertificate = fingerprint;
        this.logger.warn('Venstar: the certificate of the thermostat changed, nothing sent to it');
        await this.saveMemory();
      }
      throw new VenstarError(ERROR_KINDS.CERTIFICATE, 'The certificate changed', {
        notSent: true,
        fingerprint,
      });
    }
    if (memory.refusedCertificate) {
      // The pinned certificate is back: nothing to accept any more.
      memory.refusedCertificate = undefined;
      await this.saveMemory();
    }
    if (!memory.certificate) {
      memory.certificate = fingerprint;
      // The first pin must be in /data before the password leaves: otherwise
      // a restart would trust whatever answers next.
      if (!(await this.saveMemory())) {
        memory.certificate = undefined;
        throw new VenstarError(ERROR_KINDS.STORAGE, '/data not writable', { notSent: true });
      }
      this.logger.info('Venstar: certificate of the thermostat pinned (first connection)');
    }
    if (generation !== null && generation !== this.generation) {
      throw stale();
    }
  }

  /**
   * Whether the thermostat that answers is the one kept for the address:
   * 'ok', 'other' (another model, type or name) or 'unknown' (a value
   * unreadable this time: not "another thermostat").
   */
  identity(t, root, info) {
    const kept = this.memory.targets.get(t.target)?.identity;
    if (!root || !root.model) {
      return 'unknown';
    }
    if (!kept) {
      return 'ok';
    }
    if (kept.model !== root.model || (kept.type && root.type && kept.type !== root.type)) {
      return 'other';
    }
    if (kept.name !== undefined) {
      if (info?.name === undefined) {
        return 'unknown';
      }
      if (info.name !== kept.name) {
        return 'other';
      }
    }
    return 'ok';
  }

  // --- Polling -----------------------------------------------------------------

  current(t) {
    return this.thermostat === t;
  }

  schedule(t, delay) {
    if (t.timer) {
      this.timers.clearTimeout(t.timer);
      t.timer = undefined;
    }
    if (!this.current(t)) {
      return;
    }
    const wait = Math.max(
      0,
      delay ?? (t.online === false ? (t.wait ?? this.interval) : this.interval),
    );
    const generation = this.generation;
    t.nextAt = this.now() + wait;
    t.timer = this.timers.setTimeout(() => {
      t.timer = undefined;
      if (generation === this.generation && this.current(t)) {
        this.tick(t).catch(() => this.logger.error('Venstar refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick(t, { force = false } = {}) {
    if (!this.current(t)) {
      return Promise.resolve();
    }
    if (!t.running) {
      t.running = this.run(t, { force }).finally(() => {
        t.running = undefined;
      });
    }
    return t.running;
  }

  async run(t, { force }) {
    const generation = this.generation;
    if (t.timer) {
      this.timers.clearTimeout(t.timer);
      t.timer = undefined;
    }
    const memory = this.targetMemory(t);
    if (this.credentialsRefused(t) && !force) {
      t.problem = { kind: 'refused' };
      await this.publishAll(generation);
      return;
    }
    if (this.paused(t)) {
      this.schedule(t, memory.pausedUntil - this.now());
      await this.publishAll(generation);
      return;
    }
    // The attempt is kept before the read: exactly in memory, in /data at most once a minute.
    this.readAt.set(t.target, this.now());
    if (this.now() - memory.attemptAt >= TIMINGS.attemptSave) {
      memory.attemptAt = this.now();
      await this.saveMemory();
      if (generation !== this.generation) {
        return;
      }
    }
    t.nextAt = this.now() + this.interval;
    let next;
    try {
      const read = await this.read(t, generation);
      if (generation !== this.generation || !this.current(t)) {
        return;
      }
      next = await this.applyRead(t, read);
    } catch (err) {
      if (generation !== this.generation || !this.current(t)) {
        return;
      }
      next = await this.failed(t, err);
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll(generation);
    if (generation !== this.generation) {
      return;
    }
    if (next !== null) {
      this.schedule(t, next);
    }
    if (this.reaffirm && !this.reaffirm.running && this.now() < this.reaffirm.until) {
      this.reaffirmStop();
    }
  }

  /** One session: the identity, the info, then the sensors and alerts (secondary). */
  async read(t, generation) {
    const deadline = this.now() + TIMINGS.pollBudget;
    const timeoutMs = () => Math.max(1, Math.min(TIMINGS.requestTimeout, deadline - this.now()));
    const session = this.session(t, generation);
    try {
      const root = parseRoot(await session.request({ path: '/', timeoutMs }));
      if (!root) {
        throw new VenstarError(ERROR_KINDS.PROTOCOL, 'Not a Venstar answer');
      }
      if (!root.supported) {
        return { root };
      }
      const info = parseInfo(await session.request({ path: '/query/info', timeoutMs }), root);
      // A failure of a secondary endpoint never stops the main values.
      const secondary = async (path, parse) => {
        try {
          return parse(await session.request({ path, timeoutMs }));
        } catch (err) {
          if (
            [ERROR_KINDS.HTTP, ERROR_KINDS.PROTOCOL, ERROR_KINDS.TIMEOUT].includes(err.kind) ||
            (err.kind === ERROR_KINDS.BUSY && err.status !== 429 && err.status !== 503)
          ) {
            this.logger.debug(`Venstar ${path}: ${errorReason(err)}`);
            return undefined;
          }
          throw err;
        }
      };
      const sensors = await secondary('/query/sensors', parseSensors);
      const alerts = await secondary('/query/alerts', parseAlerts);
      return { root, info, sensors, alerts };
    } finally {
      session.close();
    }
  }

  /** A good answer: the identity, then the values. Resolves the next delay. */
  async applyRead(t, { root, info, sensors, alerts }) {
    const memory = this.targetMemory(t);
    t.online = true;
    t.failures = 0;
    t.wait = undefined;
    t.reason = undefined;
    let save = false;
    if (memory.refusedCredentials) {
      // The first success clears a refusal (the test button, new credentials).
      memory.refusedCredentials = undefined;
      save = true;
    }
    if (!root.supported) {
      t.problem = { kind: 'unsupported', version: root.apiVer };
    } else {
      const check = this.identity(t, root, info);
      const seen = { model: root.model, type: root.type, name: info.name };
      if (check === 'other') {
        if (JSON.stringify(memory.refusedIdentity) !== JSON.stringify(seen)) {
          memory.refusedIdentity = seen;
          save = true;
          this.logger.warn('Venstar: another thermostat answers at this address');
        }
        t.problem = { kind: 'other', identity: seen };
      } else if (check === 'unknown') {
        t.problem = { kind: 'identity' };
      } else {
        if (!memory.identity) {
          memory.identity = seen;
          save = true;
        }
        if (memory.refusedIdentity) {
          memory.refusedIdentity = undefined;
          save = true;
        }
        const unit = apiUnit(root, info);
        if (!unit) {
          t.problem = { kind: 'unit' };
        } else {
          t.problem = undefined;
          t.snapshot = {
            root,
            info,
            unit,
            sensors: sensors ?? { humidity: undefined, outdoor: undefined },
            alerts,
          };
          t.shape.humidity ||= sensors?.humidity !== undefined;
          t.shape.outdoor ||= sensors?.outdoor !== undefined;
          t.shape.alerts ||= alerts !== undefined;
          t.shape.filter ||= Boolean(filterAlert(alerts));
          this.observe(t);
        }
      }
    }
    if (save) {
      await this.saveMemory();
    }
    return undefined;
  }

  /** A failed read. Resolves the next delay, or null (no automatic retry). */
  async failed(t, err) {
    const memory = this.targetMemory(t);
    t.online = false;
    t.reason = errorReason(err);
    if (err?.kind === ERROR_KINDS.AUTH || err?.kind === ERROR_KINDS.AUTH_NEEDED) {
      // Final: the salted fingerprint of what was refused, never retried by itself.
      memory.refusedCredentials = this.credentialsHash();
      await this.saveMemory();
      t.problem = { kind: 'refused' };
      this.logger.warn('Venstar: credentials refused or missing; not tried again by itself');
      return null;
    }
    if (err?.kind === ERROR_KINDS.CERTIFICATE) {
      t.problem = { kind: 'certificate' };
      return this.interval;
    }
    if (err?.kind === ERROR_KINDS.STORAGE) {
      t.problem = { kind: 'storage' };
    } else if (err?.kind !== ERROR_KINDS.BUSY) {
      t.problem = undefined;
    }
    if (err?.kind === ERROR_KINDS.BUSY) {
      const delay = await this.pause(t, err);
      this.logger.warn(
        `Venstar: ${errorReason(err)}; reads paused for ${Math.round(delay / 1000)} s`,
      );
      return delay;
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(t.failures, TIMINGS.backoff.length - 1)],
    );
    t.failures += 1;
    t.wait = wait;
    this.logger.warn(`Venstar: ${t.reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** HTTP 429 / 5xx met on any path: every read (and start command) waits, across restarts. */
  async pause(t, err) {
    const memory = this.targetMemory(t);
    const delay = Math.max(
      this.interval,
      Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, err.retryAfter ?? TIMINGS.pauseMin)),
    );
    memory.pausedUntil = Math.max(memory.pausedUntil, this.now() + delay);
    await this.saveMemory();
    return memory.pausedUntil - this.now();
  }

  // --- Gladys --------------------------------------------------------------------

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  createdFeatures() {
    const map = new Map();
    for (const d of this.gladys.devices ?? []) {
      for (const f of d?.features ?? []) {
        if (typeof f?.external_id === 'string') {
          map.set(f.external_id, f);
        }
      }
    }
    return map;
  }

  /** Whether the values of the last read are current (identity checked, read at the last poll). */
  live(t = this.thermostat) {
    return Boolean(t?.online === true && !t.problem && t.snapshot);
  }

  async publishAll(generation) {
    if (generation !== this.generation) {
      return;
    }
    await this.publishDevices(generation);
    this.queueStates();
    await this.flush();
    await this.publishBadge(generation);
    await this.updateStatus(generation);
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The snapshot with every feature ever seen (a feature never leaves Discovery). */
  shaped(t) {
    const s = t.snapshot;
    return {
      ...s,
      sensors: {
        humidity: s.sensors.humidity ?? (t.shape.humidity ? 0 : undefined),
        outdoor: s.sensors.outdoor ?? (t.shape.outdoor ? 0 : undefined),
      },
      alerts:
        s.alerts ??
        (t.shape.alerts
          ? t.shape.filter
            ? [{ name: 'Air Filter', active: false }]
            : []
          : undefined),
    };
  }

  buildDevices() {
    const t = this.thermostat;
    if (!t?.snapshot || t.problem?.kind === 'other') {
      return [];
    }
    return [
      buildDevice(this.gladys, t.id, this.shaped(t), {
        language: this.config.language,
        created: this.createdDevice(deviceIds(this.gladys, t.id).device),
      }),
    ];
  }

  async publishDevices(generation) {
    const devices = this.buildDevices();
    if (devices.length === 0 || generation !== this.generation) {
      return;
    }
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered device failed: ${err.message}`);
    }
  }

  queueStates(created = this.createdFeatures()) {
    const t = this.thermostat;
    if (!this.live(t)) {
      return;
    }
    const ids = deviceIds(this.gladys, t.id);
    for (const { device_feature_external_id: id, ...value } of thermostatStates(
      ids,
      t.snapshot,
      created,
      this.config.language,
    )) {
      this.publisher.push(id, value);
    }
  }

  async publishBadge(generation) {
    const t = this.thermostat;
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const id = parseDeviceId(device?.external_id);
      if (!id || deviceIds(this.gladys, id).device !== device.external_id) {
        continue;
      }
      if (t && id === t.id && t.online === undefined && !t.problem) {
        continue;
      }
      entries.push({
        external_id: device.external_id,
        transport:
          t && id === t.id && this.live(t)
            ? DEVICE_TRANSPORTS.LOCAL
            : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge || generation !== this.generation) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  async setStatus(generation, connected, message) {
    if (generation !== this.generation) {
      return;
    }
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async updateStatus(generation = this.generation) {
    const [connected, message] = this.statusText();
    await this.setStatus(generation, connected, message);
  }

  /** The connection status of the configuration screen. */
  statusText() {
    if (this.config.invalidAddress) {
      return [false, join(T.invalidAddress(this.config.invalidAddress), T.noAddress)];
    }
    const t = this.thermostat;
    if (!t) {
      return [false, T.noAddress];
    }
    const notes = [];
    if (this.config.pinInvalid) {
      notes.push(T.pinInvalid);
    }
    if (this.pinRefused(t)) {
      notes.push(T.pinRefused);
    }
    const memory = this.memory.targets.get(t.target);
    const kind = t.problem?.kind;
    let main;
    if (kind === 'refused') {
      main =
        this.config.secure && this.config.credentials && t.reason !== 'a password is asked'
          ? T.refused
          : T.authNeeded;
    } else if (kind === 'certificate') {
      main = T.certificateChanged(memory?.refusedCertificate ?? '?');
    } else if (kind === 'storage') {
      main = T.storage;
    } else if (this.paused(t)) {
      main = T.busy(age(memory.pausedUntil - this.now()));
    } else if (kind === 'other') {
      main = T.otherThermostat(t.problem.identity);
    } else if (kind === 'identity') {
      main = T.identityUnknown;
    } else if (kind === 'unsupported') {
      main = T.unsupported(t.problem.version);
    } else if (kind === 'unit') {
      main = T.unitUnknown;
    } else if (t.online === false) {
      main = T.unreachable(t.reason ?? 'error', age(Math.max(0, t.nextAt - this.now())));
    } else if (t.online === undefined) {
      main = T.connecting;
    } else {
      return [true, join(T.connected(t.snapshot?.info.name, t.snapshot?.root.model), ...notes)];
    }
    return [false, join(main, ...notes)];
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      if (typeof f?.external_id === 'string') {
        created.set(f.external_id, f);
      }
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge(this.generation);
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices(this.generation);
  }

  // --- Configuration buttons -----------------------------------------------------

  async testConnection() {
    const t = this.thermostat;
    if (!t) {
      return this.statusText()[1];
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      return join(T.test.cooldown, this.statusText()[1]);
    }
    this.lastTestAt = this.now();
    // Read now only when the read is due: never sooner than the interval.
    const memory = this.targetMemory(t);
    const last = this.readAt.get(t.target) ?? memory.attemptAt;
    const refused = this.credentialsRefused(t);
    const dueAt = refused ? last + this.interval : t.nextAt;
    let task;
    if (t.running) {
      task = t.running;
    } else if (dueAt > this.now() || this.paused(t)) {
      const wait = Math.max(dueAt, this.paused(t) ? memory.pausedUntil : 0) - this.now();
      return join(this.statusText()[1], T.test.waiting(age(wait)));
    } else {
      // After a refusal: one try with what is configured; it clears the refusal only on success.
      task = this.tick(t, { force: refused });
    }
    let timer;
    await Promise.race([
      task,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(resolve, TIMINGS.testAnswerBy);
      }),
    ]);
    this.timers.clearTimeout(timer);
    return this.statusText()[1];
  }

  /**
   * "Accept the change", in two clicks: the first one shows the whole
   * fingerprint refused and the other identity met, and accepts nothing; a
   * second one within 60 s accepts exactly what was shown, if it is still
   * what was refused. The next scheduled read shows the thermostat (never
   * sooner than the interval).
   */
  async acceptChange() {
    const t = this.thermostat;
    const memory = t ? this.memory.targets.get(t.target) : undefined;
    const what = {
      certificate: memory?.refusedCertificate,
      identity: memory?.refusedIdentity,
    };
    if (!what.certificate && !what.identity) {
      this.pendingAccept = undefined;
      return T.accept.nothing;
    }
    const key = JSON.stringify(what);
    const pending = this.pendingAccept;
    const now = this.now();
    if (
      !pending ||
      pending.key !== key ||
      now - pending.at > TIMINGS.acceptConfirm ||
      now < pending.at
    ) {
      this.pendingAccept = { key, at: now };
      const parts = [];
      if (what.certificate) {
        parts.push(both(`certificate ${what.certificate}`, `certificat ${what.certificate}`));
      }
      if (what.identity) {
        parts.push(
          both(`thermostat ${describe(what.identity)}`, `thermostat ${describe(what.identity)}`),
        );
      }
      return T.accept.confirm(join(...parts));
    }
    this.pendingAccept = undefined;
    if (what.certificate) {
      memory.certificate = what.certificate;
      memory.refusedCertificate = undefined;
    }
    if (what.identity) {
      memory.identity = what.identity;
      memory.refusedIdentity = undefined;
      // The device of the address shows this thermostat from now on.
      t.snapshot = undefined;
    }
    t.problem = undefined;
    await this.saveMemory();
    this.logger.info('Venstar: the change was accepted by the user');
    await this.publishAll(this.generation);
    return T.accept.done;
  }

  // --- Commands ------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target) {
      throw this.refusal(ERRORS.readOnly);
    }
    const change = commandValue(target.key, value);
    if (change === undefined) {
      throw this.refusal(
        ['heat-setpoint', 'cool-setpoint', 'mode', 'fan-mode'].includes(target.key)
          ? ERRORS.badValue
          : ERRORS.readOnly,
      );
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    const t = this.thermostat;
    if (!t || target.id !== t.id) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    // The unit of the feature as created in Gladys: the value is in it.
    const featureUnit =
      this.createdFeatures().get(feature.external_id)?.unit ?? feature?.unit ?? undefined;
    if (change.setpoint) {
      const bounds = SETPOINT_BOUNDS[change.setpoint][featureUnit];
      if (!bounds) {
        throw this.refusal(ERRORS.unknownUnit);
      }
      // The bounds on the value asked, before any conversion or rounding.
      if (change.asked < bounds.min || change.asked > bounds.max) {
        throw this.refusal(ERRORS.outOfRange(bounds.min, bounds.max, featureUnit));
      }
    }
    if (change.mode === VENSTAR.MODE.OFF) {
      // A stop cancels the command not written yet; never refused for it.
      if (this.inFlight) {
        this.inFlight.cancelled = true;
      }
      return this.queueStop(t, received);
    }
    if (this.inFlight || this.stops.length > 0) {
      throw this.refusal(ERRORS.stillRunning);
    }
    if (this.paused(t)) {
      throw this.refusal(ERRORS.busy);
    }
    if (this.credentialsRefused(t)) {
      throw this.refusal(ERRORS.credentialsRefused);
    }
    if (this.pinRefused(t)) {
      throw this.refusal(ERRORS.pinRefused);
    }
    const entry = { cancelled: false, sentSeq: undefined };
    this.inFlight = entry;
    try {
      return await this.command(t, change, { received, entry, featureUnit });
    } finally {
      if (this.inFlight === entry) {
        this.inFlight = undefined;
      }
    }
  }

  /** The refusal of a failure met before anything was written. */
  readRefusal(err) {
    if (err instanceof Refusal) {
      return err;
    }
    switch (err?.kind) {
      case ERROR_KINDS.LATE:
        return this.refusal(ERRORS.tooSlow);
      case ERROR_KINDS.CERTIFICATE:
        return this.refusal(ERRORS.certificate);
      case ERROR_KINDS.AUTH:
      case ERROR_KINDS.AUTH_NEEDED:
        return this.refusal(ERRORS.credentialsRefused);
      case ERROR_KINDS.BUSY:
        return this.refusal(ERRORS.busy);
      case ERROR_KINDS.STALE:
        return this.refusal(ERRORS.unknownDevice);
      default:
        return this.refusal(ERRORS.unknownState(errorReason(err)));
    }
  }

  /** A pause met by a command applies to every read; never a refusal of the reads (lot 11). */
  async shared(t, err) {
    if (err?.kind === ERROR_KINDS.BUSY && this.current(t)) {
      await this.pause(t, err);
      await this.updateStatus(this.generation);
    }
  }

  /** A state read by a command: kept and shown when the thermostat is the device's. */
  applyCommandRead(t, root, info, generation) {
    if (generation !== this.generation || !this.current(t) || !t.snapshot) {
      return;
    }
    const unit = apiUnit(root, info);
    if (unit !== t.snapshot.unit || this.identity(t, root, info) !== 'ok') {
      return;
    }
    t.snapshot = { ...t.snapshot, root, info };
    this.observe(t);
    // Shown in the background: the ack never waits for Gladys.
    this.publishAll(generation).catch((err) =>
      this.logger.warn(`Publishing failed: ${err.message}`),
    );
  }

  async command(t, change, { received, entry, featureUnit }) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const until = (by) => () => Math.max(1, Math.min(TIMINGS.requestTimeout, by - this.now()));
    const session = this.session(t, generation);
    try {
      let root;
      let info;
      try {
        root = parseRoot(await session.request({ path: '/', timeoutMs: until(sendBy) }));
        if (!root?.supported) {
          throw new VenstarError(ERROR_KINDS.PROTOCOL, 'Not a supported Venstar answer');
        }
        info = parseInfo(
          await session.request({ path: '/query/info', timeoutMs: until(sendBy) }),
          root,
        );
      } catch (err) {
        await this.shared(t, err);
        if (this.now() >= sendBy && err?.kind === ERROR_KINDS.TIMEOUT) {
          throw this.refusal(ERRORS.tooSlow);
        }
        throw this.readRefusal(err);
      }
      if (generation !== this.generation) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      const check = this.identity(t, root, info);
      if (check !== 'ok') {
        throw this.refusal(check === 'other' ? ERRORS.otherThermostat : ERRORS.identityUnknown);
      }
      const unit = apiUnit(root, info);
      if (!unit) {
        throw this.refusal(ERRORS.incompleteState);
      }
      this.applyCommandRead(t, root, info, generation);
      const plan = this.plan(change, info, unit, featureUnit);
      if (!plan) {
        // Already so: nothing sent.
        return;
      }
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(plan.form)) {
        form.set(key, String(value));
      }
      if (this.config.pin) {
        form.set('pin', this.config.pin);
      }
      this.logger.info(`Venstar: ${Object.keys(plan.form).join(', ')} -> sent`);
      let answer;
      try {
        answer = await session.request({
          method: 'POST',
          path: '/control',
          body: form.toString(),
          timeoutMs: until(answerBy),
          beforeSend: () => this.beforeSend(generation, entry, sendBy),
        });
      } catch (err) {
        if (err?.beforeSend) {
          throw err;
        }
        await this.shared(t, err);
        if (notSent(err)) {
          if (err.kind === ERROR_KINDS.HTTP) {
            throw this.refusal(ERRORS.refused);
          }
          throw err.kind === ERROR_KINDS.LATE
            ? this.refusal(ERRORS.tooSlow)
            : err.kind === ERROR_KINDS.BUSY ||
                err.kind === ERROR_KINDS.AUTH ||
                err.kind === ERROR_KINDS.AUTH_NEEDED ||
                err.kind === ERROR_KINDS.CERTIFICATE
              ? this.readRefusal(err)
              : this.refusal(ERRORS.notSent(errorReason(err)));
        }
        // A silence or a closed connection after the write: it may have been applied.
        this.unconfirmed(t, plan, entry);
        throw this.refusal(ERRORS.sentUnconfirmed(errorReason(err)));
      }
      const result = parseControlAnswer(answer);
      if (!result.ok) {
        if (result.pin && this.config.pin) {
          await this.keepPinRefused(t);
          throw this.refusal(ERRORS.refusedPin);
        }
        throw this.refusal(ERRORS.refused);
      }
      if (this.supersededBy(entry)) {
        throw this.refusal(ERRORS.superseded);
      }
      // Confirmed only by the state read back.
      let back;
      try {
        back = parseInfo(
          await session.request({ path: '/query/info', timeoutMs: until(answerBy) }),
          root,
        );
      } catch (err) {
        this.unconfirmed(t, plan, entry);
        throw this.refusal(ERRORS.sentUnconfirmed(errorReason(err)));
      }
      this.applyCommandRead(t, root, back, generation);
      if (this.supersededBy(entry)) {
        throw this.refusal(ERRORS.superseded);
      }
      if (!this.same(plan.field, back[plan.field], plan.expected)) {
        this.unconfirmed(t, plan, entry);
        throw this.refusal(ERRORS.sentUnconfirmed('state not changed yet'));
      }
      this.guards.delete(plan.guard);
    } finally {
      session.close();
    }
  }

  /** The checks right before the write, on the latest configuration. */
  beforeSend(generation, entry, sendBy) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (entry.cancelled) {
      throw this.refusal(ERRORS.cancelled);
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    // Only a request that really leaves counts as written (lot 13).
    this.writeSeq += 1;
    entry.sentSeq = this.writeSeq;
  }

  /**
   * A start written before a stop that was written while it was in flight:
   * the thermostat may have taken them in the other order. The stop is
   * written again, and the start reported as overtaken.
   */
  supersededBy(entry) {
    if (entry.sentSeq !== undefined && this.lastStopSeq > entry.sentSeq) {
      this.requestReaffirm();
      return true;
    }
    return false;
  }

  unconfirmed(t, plan, entry) {
    if (this.supersededBy(entry)) {
      return;
    }
    this.guard(plan);
    this.scheduleFollowUp(t);
  }

  async keepPinRefused(t) {
    const memory = this.targetMemory(t);
    memory.refusedPin = this.pinHash();
    await this.saveMemory();
    this.logger.warn('Venstar: the PIN was refused; commands refused until it changes');
    await this.updateStatus(this.generation);
  }

  /**
   * What to write: { form, field, expected, guard }, or null when the
   * thermostat already shows it (and no guard says a previous command may
   * still change it).
   */
  plan(change, info, unit, featureUnit) {
    const can = offers(info.availableModes);
    if (change.fan !== undefined) {
      if (info.fan === undefined) {
        throw this.refusal(ERRORS.incompleteState);
      }
      const guard = 'fan:wake';
      if (info.fan === change.fan && !this.guardActive(guard)) {
        return null;
      }
      return {
        form: { fan: change.fan },
        field: 'fan',
        expected: change.fan,
        guard,
        from: info.fan,
      };
    }
    if (info.heat === undefined || info.cool === undefined) {
      throw this.refusal(ERRORS.incompleteState);
    }
    if (change.mode !== undefined) {
      const name = { 1: 'heat', 2: 'cool', 3: 'auto' }[change.mode];
      if (!can[name]) {
        throw this.refusal(ERRORS.modeUnavailable);
      }
      if (change.mode === VENSTAR.MODE.AUTO) {
        this.checkDeadband(info, info.heat, info.cool, unit);
      }
      const guard = 'mode:wake';
      if (info.mode === change.mode && !this.guardActive(guard)) {
        return null;
      }
      // venstarcolortouch set_mode: the mode with both setpoints, written back exactly as read.
      return {
        form: { mode: change.mode, heattemp: info.heat, cooltemp: info.cool },
        field: 'mode',
        expected: change.mode,
        guard,
        from: info.mode,
      };
    }
    // A setpoint: converted from the unit of the feature, rounded to the thermostat's step.
    const from = apiUnitOf(featureUnit);
    if (!from) {
      throw this.refusal(ERRORS.unknownUnit);
    }
    const value = roundSetpoint(convertExact(change.asked, from, unit), unit);
    const heatKind = change.setpoint === 'heat';
    if (!(heatKind ? can.heat : can.cool)) {
      throw this.refusal(ERRORS.modeUnavailable);
    }
    const [min, max] = heatKind ? [info.heatMin, info.heatMax] : [info.coolMin, info.coolMax];
    if (min === undefined || max === undefined) {
      throw this.refusal(ERRORS.incompleteState);
    }
    if (value < min - 1e-6 || value > max + 1e-6) {
      throw this.refusal(ERRORS.outOfLimits(min, max, unit));
    }
    const heat = heatKind ? value : info.heat;
    const cool = heatKind ? info.cool : value;
    if (info.mode === VENSTAR.MODE.AUTO) {
      this.checkDeadband(info, heat, cool, unit);
    }
    const field = heatKind ? 'heat' : 'cool';
    const guard = `${field}:wake`;
    if (this.same(field, info[field], value) && !this.guardActive(guard)) {
      return null;
    }
    return {
      form: { heattemp: heat, cooltemp: cool },
      field,
      expected: value,
      guard,
      from: info[field],
    };
  }

  /** venstarcolortouch set_setpoints: in auto, heat + setpointdelta must not pass cool. */
  checkDeadband(info, heat, cool, unit) {
    if (info.delta === undefined) {
      throw this.refusal(ERRORS.incompleteState);
    }
    if (heat + info.delta > cool + 1e-6) {
      throw this.refusal(ERRORS.deadband(info.delta, unit));
    }
  }

  same(field, a, b) {
    if (field === 'heat' || field === 'cool') {
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.05;
    }
    return a === b;
  }

  // --- Stops ---------------------------------------------------------------------

  /**
   * A stop (mode off) runs at once on its own connection, whatever runs
   * already (3 at most; one more joins the latest). Never refused for a
   * command in flight, a pause, a refusal kept in /data or a configuration
   * saved meanwhile.
   */
  queueStop(t, received) {
    if (this.stops.length >= LIMITS.stops) {
      return this.stops.at(-1);
    }
    const run = this.runStop(t, received, { internal: false }).finally(() => {
      this.stops = this.stops.filter((s) => s !== run);
    });
    this.stops.push(run);
    return run;
  }

  async runStop(t, received, { internal }) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    // The read before the stop only gets the time that leaves room for the write.
    const readUntil = () =>
      Math.max(1, Math.min(TIMINGS.requestTimeout, sendBy - 1_200 - this.now()));
    const until = (by) => () => Math.max(1, Math.min(TIMINGS.requestTimeout, by - this.now()));
    const session = this.session(t, null);
    let seq;
    try {
      // The setpoints, to write them back exactly (venstarcolortouch set_mode);
      // in doubt (no answer in time), the mode alone: the stop always leaves.
      let root;
      let info;
      try {
        root = parseRoot(await session.request({ path: '/', timeoutMs: readUntil }));
        if (root?.supported) {
          if (this.identity(t, root, undefined) === 'other') {
            throw this.refusal(ERRORS.otherThermostat);
          }
          info = parseInfo(
            await session.request({ path: '/query/info', timeoutMs: readUntil }),
            root,
          );
          if (this.identity(t, root, info) === 'other') {
            throw this.refusal(ERRORS.otherThermostat);
          }
        }
      } catch (err) {
        if (err instanceof Refusal || err?.kind === ERROR_KINDS.CERTIFICATE) {
          throw this.readRefusal(err);
        }
        if (err?.kind === ERROR_KINDS.STORAGE || err?.kind === ERROR_KINDS.STALE) {
          throw this.readRefusal(err);
        }
        await this.shared(t, err);
        info = undefined;
      }
      const form = new URLSearchParams();
      form.set('mode', String(VENSTAR.MODE.OFF));
      if (info?.heat !== undefined && info?.cool !== undefined) {
        form.set('heattemp', String(info.heat));
        form.set('cooltemp', String(info.cool));
      }
      if (this.config.pin) {
        form.set('pin', this.config.pin);
      }
      this.logger.info(`Venstar: mode off -> sent${internal ? ' again' : ''}`);
      let answer;
      try {
        answer = await session.request({
          method: 'POST',
          path: '/control',
          body: form.toString(),
          timeoutMs: until(answerBy),
          beforeSend: () => {
            if (!internal && !this.config.allowCommands) {
              throw this.refusal(ERRORS.disabled);
            }
            if (this.now() > sendBy) {
              throw this.refusal(ERRORS.tooSlow);
            }
            this.writeSeq += 1;
            seq = this.writeSeq;
            this.lastStopSeq = seq;
          },
        });
      } catch (err) {
        if (err?.beforeSend) {
          throw err;
        }
        await this.shared(t, err);
        if (notSent(err)) {
          throw err.kind === ERROR_KINDS.HTTP
            ? this.refusal(ERRORS.refused)
            : err.kind === ERROR_KINDS.LATE
              ? this.refusal(ERRORS.tooSlow)
              : [ERROR_KINDS.AUTH, ERROR_KINDS.AUTH_NEEDED, ERROR_KINDS.CERTIFICATE].includes(
                    err.kind,
                  )
                ? this.readRefusal(err)
                : this.refusal(ERRORS.notSent(errorReason(err)));
        }
        this.stopUnconfirmed(t, info);
        throw this.refusal(ERRORS.sentUnconfirmed(errorReason(err)));
      }
      const result = parseControlAnswer(answer);
      if (!result.ok) {
        if (result.pin && this.config.pin) {
          await this.keepPinRefused(t);
          throw this.refusal(ERRORS.refusedPin);
        }
        throw this.refusal(ERRORS.refused);
      }
      let back;
      try {
        back = parseInfo(
          await session.request({ path: '/query/info', timeoutMs: until(answerBy) }),
          root,
        );
      } catch (err) {
        this.stopUnconfirmed(t, info);
        throw this.refusal(ERRORS.sentUnconfirmed(errorReason(err)));
      }
      if (root?.supported) {
        this.applyCommandRead(t, root, back, this.generation);
      }
      if (back.mode !== VENSTAR.MODE.OFF) {
        this.stopUnconfirmed(t, info);
        throw this.refusal(ERRORS.sentUnconfirmed('state not changed yet'));
      }
      this.guards.delete('mode:stop');
      this.guards.delete('mode:wake');
    } finally {
      session.close();
    }
  }

  stopUnconfirmed(t, info) {
    this.guard({ guard: 'mode:stop', from: info?.mode, expected: VENSTAR.MODE.OFF });
    this.scheduleFollowUp(t);
  }

  /** The stop is written again, now and, if that fails, at the next reads (90 s at most). */
  requestReaffirm() {
    this.reaffirm = { until: this.now() + TIMINGS.reaffirm, running: false };
    this.reaffirmStop();
  }

  reaffirmStop() {
    const t = this.thermostat;
    const reaffirm = this.reaffirm;
    if (!t || !reaffirm || reaffirm.running) {
      return;
    }
    reaffirm.running = true;
    this.runStop(t, this.now(), { internal: true })
      .then(() => {
        if (this.reaffirm === reaffirm) {
          this.reaffirm = undefined;
        }
      })
      .catch((err) => {
        // Kept: the next read tries again, until the reaffirmation expires.
        this.logger.warn(`Venstar: the stop could not be written again: ${err.message}`);
        if (this.now() >= reaffirm.until && this.reaffirm === reaffirm) {
          this.reaffirm = undefined;
        }
      })
      .finally(() => {
        reaffirm.running = false;
      });
  }

  /** One read a few seconds after a command that was not confirmed (never two at once). */
  scheduleFollowUp(t) {
    if (t.followUp || !this.current(t)) {
      return;
    }
    const generation = this.generation;
    t.followUp = this.timers.setTimeout(() => {
      t.followUp = undefined;
      if (generation === this.generation && this.current(t) && !this.paused(t)) {
        this.tick(t).catch(() => this.logger.error('Venstar refresh failed'));
      }
    }, TIMINGS.followUp);
  }

  // --- Guards --------------------------------------------------------------------

  /**
   * After a command that may have been applied, until the thermostat shows
   * it: a new command is always sent, never answered "already so". The start
   * value is kept: a read equal to it lifts nothing until a move was seen.
   * Guards are kept per kind (start or stop), never in one slot.
   */
  guard({ guard, from, expected }) {
    this.guards.set(guard, { from, expected, moved: false, until: this.now() + TIMINGS.guard });
  }

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read, through the guards: never lifted on an unknown value. */
  observe(t) {
    const info = t.snapshot?.info;
    if (!info) {
      return;
    }
    for (const key of [...this.guards.keys()]) {
      if (!this.guardActive(key)) {
        continue;
      }
      const field = key.split(':')[0];
      const value = info[field];
      if (value === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (guard.from !== undefined && !this.same(field, value, guard.from)) {
        guard.moved = true;
      }
      if (
        this.same(field, value, guard.expected) &&
        (guard.moved || guard.from === undefined || this.same(field, guard.from, guard.expected))
      ) {
        this.guards.delete(key);
      }
    }
  }
}
