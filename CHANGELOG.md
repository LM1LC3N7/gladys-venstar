# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Venstar ColorTouch and Explorer thermostats over their documented local API
  (HTTP, or HTTPS with Digest authentication): one Gladys device with the room
  temperature, humidity, outdoor temperature, heating and cooling setpoints,
  mode, fan, fan running, operating state, status and alerts (air filter).
- Commands off by default ("Allow the commands"): decided on a fresh read, the
  option checked again right before the write, confirmed only by a read back,
  "sent, without confirmation" otherwise; setpoints bounded (heating 5-30 °C,
  cooling 16-35 °C, and the thermostat's limits), refused outside; the stop
  (mode off) never blocked, possible right after a restart, written again when
  a start sent before it answered after it.
- HTTPS: the certificate pinned at the first connection (kept in `/data`
  before the password leaves), checked before every request; a new
  certificate or another thermostat at the address accepted only by "Accept
  the change" in two clicks.
- Credentials refused: reads stopped, never retried by themselves (a salted
  fingerprint of the refused pair in `/data`); a PIN refused is never sent
  again until it changes; HTTP 429 / 5xx pause every read (1 min to 6 h).
- Reads never sooner than the interval (the last attempt kept in `/data`),
  bounded answers, 300 states per minute at most, transport badge, "Test the
  connection" button.
- Documentation in English and French, third-party notices for
  venstarcolortouch (MIT).

[Unreleased]: https://github.com/LM1LC3N7/gladys-venstar/commits/main
