# Brain Smart Training

Personal PWA for the Muse 2 headband (Web Bluetooth, Chrome on Android): live EEG,
band power, PPG heart rate, motion, session recording to CSV. No build step.

## Conventions

- Code and comments: English. UI text: Portuguese (pt-BR). Talk to the user in Portuguese.
- Documentation for the user (`README.md`) is in Portuguese.

## Layout

- `js/protocol.js` — BLE UUIDs, commands, packet decoders
- `js/muse.js` — Web Bluetooth client (auto-reconnect)
- `js/dsp.js` — FFT, band power, filters, signal quality, heart rate
- `js/recorder.js` — recorder (samples placed by packet index) and CSV
- `js/chart.js`, `js/main.js` — charts and screen
- `tests/` — unit tests for the pure logic

## Commands

- `npm test`, `npm start` (http://localhost:8000)

## Deploy

Push to `main` → `.github/workflows/pages.yml` runs tests and deploys to GitHub Pages
(enable Settings › Pages › Source: GitHub Actions). Bump `CACHE` in `sw.js` when files change.
