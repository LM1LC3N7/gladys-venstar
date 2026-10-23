# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "stop"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # regenerate cover.png (800x534)
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js), before connect()
src/handlers.js                   the SDK handlers, shared with the end-to-end tests
src/app.js                        the integration: reads, device, states, badge, commands, buttons
src/venstar/http.js               one connection (plain or TLS) per session, bounded HTTP/1.1
src/venstar/digest.js             HTTP Digest (MD5) challenge and answer
src/venstar/client.js             a session: certificate check, Digest retry, JSON, 429/5xx
src/venstar/model.js              the API answers read strictly, the unit rule (pure)
src/devices.js                    the thermostat -> one Gladys device; external ids (frozen rule)
src/publisher.js                  states to Gladys within 300 per minute
src/store.js                      /data: last attempt, certificate pin, identity, refusals, pause
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       runtime texts (English and French)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test: fake Gladys + fake thermostat, real local HTTP(S) servers
scripts/cover.mjs                 generates cover.png (800x534, plain Node)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

Logic ported from venstarcolortouch (MIT): keep `THIRD_PARTY_NOTICES.md` up
to date. Commands stay off by default; the stop (mode off) is never blocked.
Never a `switch` nor a writable `binary`. Reads are never sooner than the
interval. The password is never sent over plain HTTP, nor before the
certificate is pinned in `/data`. No secret in logs, `/data`, statuses or
errors (only salted fingerprints of REFUSED secrets).

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`. Here the local API gives no serial
  number: the id is the address typed (frozen rule in `src/devices.js`).
  Gladys keys devices, their history, scenes and dashboards on them: changing
  one creates a new device and orphans the old one. The same goes for every
  key users store: manifest `config_schema`, `actions`, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords, PINs or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, actions): change both sides together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. A secret
  field is "kept by Gladys in its database, never shown again": Gladys does
  not protect it otherwise (`test/encoding.test.js` checks the wording).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network beyond the loopback.
