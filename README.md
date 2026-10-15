# Commonground

Create a shared Mixed Reality Experience using Open Standards. 
Commonground is a multi-user **mixed-reality (passthrough)** WebXR framework for persistent, room-aware scene placement, built on Three.js + RATK. Multiple Mixed Reality headsets (Like Meta Quest) join the same physical room: each headset sees the same virtual object at the same position in physical space. A desktop view shows the scene and the realtime position of users in the space, allows you to see what users see and logs session time and custom events.

![Screenshot](assets/commonground.png)

## What it does

- **Shared spacial Anchorings** — Set a spatial anchor once for each headset. Supports multiple spaces. 
- **One server for everything** — `commonground serve` hosts your app's files, the anchor/mesh API, the socket relay, session logs and the dashboard in a single process. No app-specific server code needed.
- **Cross-headset channels** — `cg.sync` (generic events relayed to every other headset), `cg.status` (per-device status merge store feeding dashboards and logs), and `cg.stream` (live headset poses at ~10 Hz).
- **Desktop spectator view** — any browser shows the room mesh and placed content, with a HUD offering Headsets (presence, session time, status, anchor state), Spaces (select/create) and Session (sync/stream toggles, session log) tabs. While streaming, each immersed headset appears as a human (color coded) figure at its real position.
- **Terminal dashboard** — an alt-screen TUI with per-headset status columns, session timing and NDJSON session logging, plus a generated helper page that gives every headset (and the desktop view) a launch link.
- **Configurable occlusion** — virtual content is realistically hidden behind real walls and furniture using the headset's depth sensing, with prepass/shader modes, per-object clear boxes, an adjustable bias and a debug depth overlay.
- **In-headset tooling** — a VR control panel for grabbing and placing the scene, and an FPS counter.
- **No build step required** — the client library is plain ES modules, served to your app with an import map; bundling is optional.

## Quick start

```bash
git clone https://github.com/rvijgen/commonground.git
cd commonground
npm install
npm run demo
```

`npm run demo` is the full experience in one process: the bundled test-cube
example, the anchors/mesh API + socket channels, the alt-screen terminal
dashboard (per-headset status, session timing), the generated helper launch
page, and NDJSON session logs. The dashboard tells you the helper-page URL
(port 80, or 3000 when unprivileged) — open it on a desktop or a Headset (like Meta Quest)
and pick a link, or go straight to `https://<your-machine>:3002/` (accept
the self-signed dev certificate) for the desktop spectator view with the
Headsets/Spaces/Session HUD. `npm run server` does the same thing;
`npm run server:bare` is the minimal variant (API + example only, no
dashboard).

## Documentation

- [docs/server.md](docs/server.md) — running and embedding the server, spaces, the anchors/mesh API, the socket relay and the `commonground serve` CLI config
- [docs/client.md](docs/client.md) — the `CommonGround` client library: sync/status/stream channels, desktop mode, occlusion and the API reference
- [docs/dashboard.md](docs/dashboard.md) — the terminal dashboard, session logs and the helper launch page
- [examples/test-cube/](examples/test-cube/) — the minimal example app

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for noncommercial use with attribution. See [LICENSE](LICENSE).
