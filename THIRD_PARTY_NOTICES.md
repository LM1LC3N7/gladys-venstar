# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## venstarcolortouch

<https://github.com/hpeyerl/venstar_colortouch> (package `venstarcolortouch`,
version 0.22, read on the default branch), the library of the Home Assistant
`venstar` integration. MIT License (`LICENSE` of the repository):

```
MIT License

Copyright (c) 2017 Herb Peyerl <free-as-in@beer.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## What was ported

From `src/venstarcolortouch/venstarcolortouch.py`, in `src/venstar/model.js`,
`src/venstar/client.js` and `src/app.js`: the endpoints `/`, `/query/info`,
`/query/sensors`, `/query/alerts` and `POST /control` (form encoded); the
minimum API version 3; the model defaults of `login()` (no model: a
ColorTouch; residential API-v5 units without it: a legacy T5900 with
firmware 4.08); the unit rule of `update_info()` (T2xxx / T3xxx before
firmware 5.28 always in °C, the listed models in the display unit, another
model in °F when its heating maximum is 40 or more); the swapped humidity
setpoint fields of residential API-v5 units; the sensor types and names
(`Thermostat` / `Local`, `Outdoor`); the mode, state and fan values; the rule
of `/control` (a mode is written with both setpoints, a setpoint with both,
the fan alone) and the auto-mode check of `set_setpoints()` (heating plus
`setpointdelta` not above cooling); the PIN padded to 4 digits; HTTP Digest
authentication for HTTPS.

Changed: one connection carries the requests of one read or one command;
answers are bounded in bytes and time and read strictly (a value of another
type is unknown, never a default); HTTPS checks a certificate pinned at the
first connection (the library does not verify it at all); the password is
never sent over plain HTTP; the PIN is sent in the form of the POST only
(never in the URL); commands are off by default, decided on a fresh read,
confirmed only by a read back, never retried; setpoints are bounded and
written back exactly as read; settings (`/settings`: units, away, schedule,
humidity setpoints, setpoint limits) are not written.

## Code reused from the same author

`src/venstar/http.js` is adapted from LM1LC3N7/gladys-alfen, `src/venstar/digest.js`
from LM1LC3N7/gladys-slide, `test/helpers/selfSigned.js` from
LM1LC3N7/gladys-huum (same author, Apache-2.0).
