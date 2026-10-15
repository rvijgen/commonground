# Commonground

Commonground is a multi-user **mixed-reality (passthrough)** WebXR framework for persistent, room-aware scene placement, built on Three.js + RATK. Multiple Meta Quest headsets join the same physical room: each headset stores and retrieves anchor points through a shared server, so every headset — and a desktop spectator view — sees the same virtual objects at the same physical positions, blended into the real room.

## What it does

- **Shared spatial anchors** — anchor transforms and room meshes are stored per physical *space* on the server. Every headset that enters a space restores the scene at the same real-world position. Multiple spaces (room scans) are supported and switchable at runtime.
- **One server for everything** — `commonground serve` hosts your app's files, the anchor/mesh API, the socket relay, session logs and the dashboard in a single process. No app-specific server code needed.
- **Cross-headset channels** — `cg.sync` (generic events relayed to every other headset), `cg.status` (per-device status merge store feeding dashboards and logs), and `cg.stream` (live headset poses at ~10 Hz).
- **Desktop spectator view** — any browser shows the room mesh and placed content, with a HUD offering Headsets (presence, session time, status, anchor state), Spaces (select/create) and Session (sync/stream toggles, session log) tabs. While streaming, each immersed headset appears as a tinted human figure at its real position.
- **Terminal dashboard** — an alt-screen TUI with per-headset status columns, session timing and NDJSON session logging, plus a generated helper page that gives every headset (and the desktop view) a launch link.
- **Configurable occlusion** — virtual content is realistically hidden behind real walls and furniture using the headset's depth sensing, with prepass/shader modes, per-object clear boxes, an adjustable bias and a debug depth overlay.
- **In-headset tooling** — a VR control panel for grabbing and placing the scene, and an FPS counter.
- **No build step required** — the client library is plain ES modules, served to your app with an import map; bundling is optional.

![Screenshot](assets/commonground.png)

## Quick start

```bash
git clone https://github.com/rvijgen/commonground.git
cd commonground
npm install
npm run server
```

This starts the framework server (anchors/mesh API + socket channels) **and** serves the bundled test-cube example — no build step involved. Open `https://<your-machine>:3002/` on a desktop browser (accept the self-signed dev certificate) for the spectator view — or open the same URL on a Meta Quest and tap **Enter Commonground** to step into the same scene in XR.

## Documentation

- [docs/server.md](docs/server.md) — running and embedding the server, spaces, the anchors/mesh API, the socket relay and the `commonground serve` CLI config
- [docs/client.md](docs/client.md) — the `CommonGround` client library: sync/status/stream channels, desktop mode, occlusion and the API reference
- [docs/dashboard.md](docs/dashboard.md) — the terminal dashboard, session logs and the helper launch page
- [examples/test-cube/](examples/test-cube/) — the minimal example app

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for noncommercial use with attribution. See [LICENSE](LICENSE).
