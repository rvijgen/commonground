# Commonground

Create a shared Mixed Reality Experience using Open Standards. 
Commonground is a multi-user **mixed-reality (passthrough)** WebXR framework for persistent, room-aware scene placement, built on Three.js + RATK. Multiple Mixed Reality headsets (Like Meta Quest) join the same hybrid space: each headset sees the same virtual object at the same position in physical space. User actions (like picking up an object) are synchronised across headsets. A web dashboard shows the scene and the realtime position of users in the space, streams the view from the headsets and logs session time and custom events.

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

`npm run demo` runs the bundled example project (`examples/test-cube/`). It starts the commonground server and opens the Dashboard in a new browser window.

- Open the ip address that is shown in the dashboard on the headset to view the quicklaunch menu. Click "Setup Headset 1" to align the scene in physical space. Once Aligned, click "Save Anchors" and exit Immersion. Now you can click "Headset 1" from the quicklaunch menu and find the scene where you aligned it. Repeat for headsets 2,3,4 etc.

- In the web dashboard you can see the users move through the space once they entered immersion. Click the 'headsets' tab to view the headsets attached to the project (4 headsets by default). See if they have been anchored in physical space or clear the anchor to reset. Click 'View' to see a stream from the headset in real time. Use the spaces tab to set up alignment for additional spaces. The 'Session' tab allows you to set synchronisation (user actions are synced accross devices) and streaming (User positions and views are streamed to the dashboard). Both are enabled by default. Click 'Session Log' to see a visual log of user session lengths and custom events.

- Use commonground.config.js to set the number of headsets, color coding and custom events.

- Copy the test-cube example to start a new project and run with npm run 'project-name'

## Documentation

- [docs/server.md](docs/server.md) — running and embedding the server, spaces, the anchors/mesh API, the socket relay and the `commonground serve` CLI config
- [docs/client.md](docs/client.md) — the `CommonGround` client library: sync/status/stream channels, desktop mode, occlusion and the API reference
- [docs/dashboard.md](docs/dashboard.md) — the terminal dashboard, session logs and the helper launch page

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for noncommercial use with attribution. See [LICENSE](LICENSE).
