# gladys-venstar

Unofficial [Gladys Assistant](https://gladysassistant.com) external
integration for **Venstar ColorTouch and Explorer** Wi-Fi thermostats: room
temperature, humidity, outdoor temperature, heating and cooling setpoints,
mode, fan, operating state and alerts, over the documented local API of the
thermostat (HTTP, or HTTPS with Digest authentication and a pinned
certificate). No cloud. Commands are off by default.

Never tested with a real device. Not affiliated with Venstar.

- User guide: [English](docs/en.md), [français](docs/fr.md)
- Logic ported from
  [venstarcolortouch](https://github.com/hpeyerl/venstar_colortouch) (MIT):
  see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- Changes: [CHANGELOG.md](CHANGELOG.md); decisions and next steps:
  [TODO.md](TODO.md)

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm audit --omit=dev
npx --yes github:GladysAssistant/integration-store .
```

`src/app.js` holds the integration (reads, device, commands), `src/venstar/`
the transport (one connection per session, TLS pin, Digest) and the API
answers, `src/handlers.js` the SDK wiring shared with the end-to-end tests
(`test/app.test.js`, against the SDK's fake Gladys and a fake thermostat;
`test/http.test.js` against real local HTTP and HTTPS servers). See
[CLAUDE.md](CLAUDE.md) for the project rules.

## License

Apache License 2.0, see [LICENSE](LICENSE).
