# TODO

## Decisions

- Version 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag: the first patch release gives 0.1.1.
  The manifest test checks the form and the agreement, never a fixed value.
- Reference: venstarcolortouch 0.22 (MIT, Herb Peyerl; LICENSE read in the
  repository), used by the Home Assistant `venstar` integration. Logic ported
  to JavaScript, no Python dependency; notice in `THIRD_PARTY_NOTICES.md`,
  copied into the image.
- Neighbour modules followed: LM1LC3N7/gladys-nexia (thermostat features:
  `thermostat/target-temperature` for heating, `air-conditioning/target-temperature`
  for cooling, `thermostat/mode`, the fan as `text/select`, never a switch)
  and LM1LC3N7/gladys-coolmasternet (local polling, publisher, store, guards,
  stop lane rules). Transport adapted from gladys-alfen (one TLS connection,
  pin checked before any write), Digest from gladys-slide.
- One thermostat per installation in this milestone (one address, one set of
  credentials, one PIN). Several thermostats: see "Next".
- Identifier rule (frozen, documented in `src/devices.js` and the docs):
  `venstar:<address>`, the address typed with every non-alphanumeric
  character as "-", the port only when not the default (80 / 443: turning
  HTTPS on keeps the device). The local API gives no serial number nor MAC.
- Identity: model and type of `GET /` and the name of `/query/info`, kept in
  `/data` at the first read, checked at every read and before every command.
  Another model, type or name = "another thermostat" (values hidden, commands
  refused); a name unreadable this time = "unknown", not another thermostat.
  A renamed thermostat is accepted with "Accept the change" (two clicks).
  A name missing at the first read is completed at the first read showing it
  (same model and type), then compared; until then the commands other than
  the stop are refused (two thermostats of the same model are told apart by
  their name only: the docs ask for distinct names). Review 1, I3.
- HTTPS: certificate pinned at the first connection (SHA-256 fingerprint in
  `/data`, written before the password leaves; `/data` not writable = nothing
  sent), checked on every connection before any byte; another certificate =
  nothing sent, its fingerprint shown, accepted only by "Accept the change"
  (first click shows, second within 60 s pins exactly that). Never relearned
  by a saved configuration.
- Credentials only over HTTPS (Digest, MD5, qop auth or none). A 401 over
  plain HTTP = "turn on HTTPS". A 401 on a nonce reused from an earlier
  request (single-use or expired nonces, `stale` or not) is answered once with
  the new challenge, as `requests.HTTPDigestAuth`; only a refused answer to a
  fresh challenge (or a second stale one) is a refusal (review 1, B1). A
  refusal (or a password asked and none usable) is final: a salted SHA-256 of
  the refused pair in `/data` (cleared at the first success), no automatic
  retry; new credentials or "Test the connection" (at most once per interval)
  try again. A 401 answer to a write is not a write: its number is given back
  (`rejected`), so it never counts as a start or a stop written.
- The password may hold any character (it is only hashed); a user name with a
  quote, a backslash or a control character cannot go into the header: the
  status says so (review 1, M3).
- PIN: 1 to 4 digits, padded to 4 (as the reference), sent only in the POST
  form (in clear without HTTPS: documented). A `/control` answer whose reason
  names the PIN keeps a simple marker in `/data` (no fingerprint: 10^4 tries
  would find a 4-digit PIN back; review 1, M1), cleared when the PIN changes
  or a command with it succeeds: later start/setpoint/fan commands are
  refused unsent until then; the stop still tries once. With the marker, ONE
  hex character of a salted SHA-256 of the refused PIN (`pinTag`): a PIN
  changed while the container was stopped lifts the marker at the next start
  (15 times out of 16); about 625 PINs of 10 000 share each value, so it does
  not give the PIN back (approval, m3).
- Secret fields (password, PIN) have no `default` in the manifest: the store
  refuses one ("not allowed for secret fields"); an absent value is empty in
  the code (`test/manifest.test.js` forbids a default on a secret field).
- 429 and 5xx: a pause of 1 min to 6 h (Retry-After in seconds, or a date
  compared with the thermostat's own `Date` header), never shorter than the
  interval, kept in `/data`. A 5xx other than 503 on `/query/sensors` or
  `/query/alerts` is ignored (secondary endpoints never stop the main values).
- Commands: off by default; checked on arrival and in `beforeSend` right
  before the write; written within 3.5 s of the click; the answer and the read
  back awaited until 4.3 s; confirmed only by a read back equal to the value
  asked; otherwise "sent, without confirmation", a guard (90 s, per kind:
  `mode:wake`, `mode:stop`, `heat:wake`…) and one read 5 s later.
- Setpoints checked on the raw value in the unit of the created feature
  (heating 5-30 °C / 41-86 °F, cooling 16-35 °C / 61-95 °F), then converted to
  the thermostat's unit, rounded to 0.5 °C / 1 °F, checked against its own
  limits (unknown limits = refused) and, in auto mode, against
  `setpointdelta` (refused, never moved). The other setpoint is written back
  exactly as read (the API needs both). While a guard says a setpoint command
  not confirmed yet may still change the other setpoint, a setpoint or mode
  command is refused ("previous command not confirmed yet") rather than
  writing the old value over it (review 1, I1). "Already so" needs no guard
  of either kind (`wake` or `stop`) on the field (review 1, I2).
- Mode off = the protective command: never refused for a command in flight,
  a pause, a credentials or PIN refusal kept in `/data`, nor a configuration
  saved meanwhile; cancels a start not written yet; own connection (3 stops
  at most at once, one more joins the latest); never skipped as "already
  off"; its read is limited so the write still fits (setpoints written back
  when read, else the mode alone: in doubt the stop leaves); refused only
  when the option is off, another thermostat answers or the certificate
  changed. A start written before a stop and answered after it is reported
  overtaken and the stop is written again (reaffirmed, retried at the next
  reads for 90 s). A start never confirmed before a stop (guard `mode:wake`)
  arms a watch: for 90 s, a read showing the thermostat on writes the stop
  again (review 1, M4); a newer start the thermostat ACCEPTED ends any watch
  or reaffirmation set before it (a refused one does not; approval, m2), and
  turning the commands off ends them at once (approval, m1). The stop writes back the setpoint a setpoint command not
  confirmed yet asked (never refused for it, never undoing it).
- The option "Allow the commands" turned off applies at once (before the
  configuration queue); a stop checks it too (as gladys-coolmasternet).
  Approved at review 1: turning a heating off is not harmless (frost, cold),
  and read only must stay read only. Documented in the docs and the manifest.
- A stop is refused when another thermostat answers (renaming it on its
  screen is enough) or the certificate changed, until "Accept the change":
  documented.
- Units: the features take the API unit (°C or °F, both listed by the core
  for temperature-sensor, thermostat and air-conditioning) when created;
  states always converted to the unit of the feature as created.
- The fan: `text/select` (auto / on), behind the option like the others; the
  fan running and the filter alert as `unknown/unknown` 0/1 (read only), the
  status and alerts as text.
- Lockout and error states have no core operating state: only the status
  text shows them (the operating state is not published then).
- Reads: every interval (60 s default, 30-600), the time of the attempt kept
  exactly in memory and in `/data` at most once a minute (before the read);
  a container restart waits at least a minute after it. Failures back off
  1, 2, 5, 10 min (never under the interval).

## Next

- Several thermostats (one address each, per-address credentials and PIN).
- The away mode (residential) as a preset, the schedule, the humidity
  setpoints (`/settings`), the runtimes.
- Discovery by SSDP (`venstar:thermostat:ecp`): needs network discovery from
  the container.
- Check on a real thermostat: that `mode=0` alone is accepted (the stop sends
  it when the setpoints could not be read), the PIN error text, keep-alive on
  the local API, the Digest parameters of the "Basic Auth" mode, the outdoor
  sensor listed when none is wired.
- Check on a real thermostat whether its server takes two connections at
  once: a read and a stop (or a command) may each open one at the same time;
  an embedded server serving one connection at a time could delay the stop
  (review 1, M6). If so: one connection at a time, the stop first.

## Not verified

- Never tested with a real device.
- No end-to-end test in a container (Docker not installed on the dev PC).
- The store validator was not run by the development agent.
