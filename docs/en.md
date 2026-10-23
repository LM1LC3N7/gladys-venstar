# Venstar

Unofficial integration for **Venstar ColorTouch and Explorer** Wi-Fi
thermostats, through the documented local API of the thermostat, on your own
network. No cloud, no account.

**Never tested with a real device**: it follows the public API documentation
and the venstarcolortouch library (used by Home Assistant). Not affiliated
with Venstar.

## What you get

One Gladys device for the thermostat, with:

- the room temperature, the indoor humidity (when the thermostat measures it)
  and the outdoor temperature (when an outdoor sensor is wired);
- the heating setpoint and the cooling setpoint;
- the mode: off, heating, cooling, auto (only the modes the thermostat
  offers);
- the fan: auto or always on, and whether it runs;
- the operating state (idle, heating, cooling) and a status text (also
  lockout and error);
- the alerts: the air filter alert as a 0/1 value, and the list of active
  alerts (air filter, UV lamp, service).

The temperatures are in the unit of the thermostat (°C or °F) when the device
is added; values are always converted to the unit of each feature as it was
created.

## Configuration

1. On the thermostat, turn on the **local API** in its Wi-Fi settings.
2. In your router, give the thermostat a **fixed IP address**. The Gladys
   device follows this address: if it changes, a new device appears.
3. In the **Configuration** tab of the integration, enter the address and
   save. The thermostat is read at once (then every minute by default), and
   appears in the **Discovery** tab: add it.

If the thermostat's **"Basic Auth"** is on, turn on **HTTPS** and enter its
user name and password. The password is kept by Gladys in its database,
never shown again, and sent only to the thermostat over HTTPS: never over
plain HTTP. At the first HTTPS connection the certificate of the thermostat
(self-signed) is pinned (its SHA-256 fingerprint kept in `/data`); if it
changes later, nothing is sent any more and the status shows the new
fingerprint. If you replaced or reset the thermostat, click **Accept the
change** twice (the first click shows what will be accepted, the second one
within 60 s accepts exactly that).

If the thermostat's screen is locked by a **PIN**, enter it: it is sent with
each command. A PIN refused by the thermostat is never sent again until you
change it.

## Commands

**Off by default.** Turn on **Allow the commands** to let Gladys change the
mode, the fan and the setpoints. Then:

- a command is decided on a fresh read of the thermostat, never on a value in
  memory, and refused if a value it needs is unknown;
- the setpoints are refused (never brought into range) outside heating 5 to
  30 °C (41 to 86 °F) and cooling 16 to 35 °C (61 to 95 °F), and outside the
  limits of the thermostat; in auto mode the cooling setpoint must stay at
  least the thermostat's deadband above the heating one; the other setpoint
  is written back exactly as read;
- a command is written within 3.5 s of the click, or refused without being
  sent; it is confirmed only when the thermostat shows the value asked,
  otherwise Gladys says "sent, without confirmation" and reads again 5 s
  later;
- **turning the thermostat off** (mode off) is never refused because
  another command runs, because of a pause or a refusal kept in memory: it
  cancels a command not yet written, and is written even when the thermostat
  already shows off. Another start command waits until it is done.

The mode is a thermostat mode, never a switch: a "turn everything off" of a
voice assistant or a scene does not reach it.

## Reading

The thermostat is read every **refresh interval** (60 s by default, 30 s at
least), never sooner: a restart, a reconnection, the Discovery tab, a saved
configuration or the test button wait for the interval. When the thermostat
does not answer, the next tries are spaced (1, 2, 5, then 10 minutes). When
it answers "busy" (HTTP 429 or 5xx), every read pauses (1 minute to 6 hours,
kept across restarts).

A user name or password refused by the thermostat stops the reads: no
automatic retry. Change them, or click **Test the connection** (one try, at
most once per interval).

Another thermostat answering at the address (another model, or another name)
is shown in the status: its values are not shown and commands are refused.
If it is the same one (renamed), click **Accept the change** twice.

## Limits

- One thermostat per installation of the integration.
- The away mode, the schedule, the humidity setpoints and the runtimes are not
  shown yet.
- No discovery on the network: enter the address.
- Never tested with a real device.

## Privacy

Everything stays on your network. `/data` keeps the time of the last read,
the certificate fingerprint, the model and name of the thermostat, the end of
a pause, and salted fingerprints of a refused password or PIN (never of the
good ones, never the values themselves).
