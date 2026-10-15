# Client library

The client library is plain ES modules. When the app is served by
`commonground serve` (or `createServer`), the package's `src/` is mounted at
`/commonground/src` and three/ratk at `/commonground/node_modules`, so an
import map is all an app needs — no build step.

## Example usage

This mirrors the `examples/test-cube/` entrypoint.

```js
import { CommonGround } from 'commonground';
import { Mesh, BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';

const cg = new CommonGround();

// The helper page's "Admin" links add ?admin=1: admin mode unlocks the
// VR control panel (controller menu button) and turns the FPS counter on.
cg.setAdminModeEnabled(new URLSearchParams(location.search).get('admin') === '1');

// Startup look: room mesh on, helpers and the VR control panel off.
cg.configure({ roomMesh: true, helpers: false, menu: false });

cg.init().then(() => {
	// A 1×1×1 m cube resting on the floor at the scene origin.
	const cube = new Mesh(
		new BoxGeometry(1, 1, 1),
		new MeshBasicMaterial({ color: 0x2e7cf6 }),
	);
	cg.addObject('cube', cube, new Vector3(0, 0.5, 0));

	// Stamp immersion so dashboard session timing and HUD indicators work.
	cg.onSessionStart(() => cg.status.update({ enteredImmersion: true }));

	// Show the cg.sync channel: every other client hears the cube was added.
	cg.sync.emit('demo-cube-added', { position: [0, 0.5, 0] });
});
```

`configure()` before `init()` adjusts startup visibility and features —
e.g. `cg.configure({ roomMesh: false, helpers: false, menu: false,
occlusion: true, occlusionMode: 'prepass' })`.

## Cross-headset channels (`cg.sync` / `cg.status` / `cg.stream`)

Every `CommonGround` instance carries three socket channels. The socket.io
client script is loaded lazily from the same origin
(`/socket.io/socket.io.js`) at first use — the import graph stays
socket.io-free, and apps that run without a server simply no-op. The
deviceId comes from the page URL (`?deviceId=`/`?deviceid=`/`?deviced=`),
matching the server-side parsing; spectator pages pass
`new CommonGround({ clientRole: 'screen' })` (or `configure({ clientRole })`).
`socketPath` can be overridden the same way for proxied deployments.

```js
// cg.sync — generic cross-headset events. Every OTHER headset receives
// them (no self-echo); screen-role clients receive but cannot emit.
cg.sync.emit('tileGrab', { tileIndex: 3, matrix: [...] });
const off = cg.sync.on('tileGrab', (payload, { deviceId, at }) => {
	// payload as sent; deviceId/at stamped by the server
});

// cg.status — client-computed, server-remembered status. Partial updates
// are shallow-merged per device on the server, broadcast to screens, and
// fed to the dashboard/session logs.
cg.status.update({ enteredImmersion: true });
cg.status.update({ tileDraggedCount: 3 });   // merges with the above
cg.status.onStatus(({ deviceId, state, at }) => { /* spectator pages */ });

// cg.stream — one shared "stream headset poses" toggle (server-side state,
// default off). Any non-screen client may flip it; the new state is
// broadcast to every client and pushed to late joiners on connect. While
// on, immersed pages (renderer.xr.isPresenting) send their camera world
// pose at ~10 Hz from the render loop — desktops never present, so they
// never send. Screen-role clients receive state/poses but cannot emit.
cg.stream.setEnabled(true);
cg.stream.enabled;                            // last state from the server
cg.stream.onEnabledChange((enabled) => {});
cg.stream.onPose(({ deviceId, position, quaternion, at }) => {});

// cg:watch — per-device watcher registration (desktop mirror windows).
// The server ref-counts watchers per device and broadcasts
// { deviceId, watchers } on every change; late joiners get the current
// state on connect. A WATCHED headset sends poses even while the shared
// toggle is off; poses are still fanned out to all clients, so
// StreamFigures (figures only while the toggle is on) is unaffected.
// Screen-role clients receive watch state but cannot (un)watch.
cg.stream.setWatching(deviceId, true);        // …false to unwatch
cg.stream.onWatch(({ deviceId, watchers }) => {});
cg.stream.isWatched(deviceId);                // sender-side send condition
```

Wire formats (server-relayed, no app server code needed): `cg:sync` carries
`{ type, payload, deviceId, at }`; `cg:status` carries partial state objects
upstream and `{ deviceId, state, at }` downstream; `cg:stream` carries
`{ enabled }` both ways; `cg:watch` carries `{ deviceId, watching }`
upstream and `{ deviceId, watchers }` downstream; `cg:pose` carries a
sceneStage-relative `{ position: {x,y,z}, quaternion: {x,y,z,w} }` upstream
(deviceId/at stamped by the server — the payload's deviceId is never
trusted) and downstream. `cg:pose` is forwarded only while streaming is on
OR the sending device is watched, and is **never logged** — at ~10 Hz per
headset it would flood the log sink / dashboard TUI. Emits
made before the socket connects are queued and flushed on connect (poses
are ephemeral and simply dropped instead). Server-side the toggle is
readable via `relay.stream.enabled()` and watcher counts via
`relay.watch.count(deviceId)`; the built-in channel can be disabled
with `attachSocketRelay(..., { stream: false })`.

Poses are expressed **relative to the sender's `sceneStage`** — the object
the anchor restore positions — so a receiver maps them back through its own
`sceneStage` and figures/views land correctly regardless of each side's
anchor offset.

### Runtime sync participation: `cg.sync.enabled`

A get/settable boolean switching this client's sync participation without a
reload. While `false`, `emit()` is a silent no-op (dropped, not queued — any
queued pre-connect messages are discarded) and incoming sync events are not
delivered to handlers. `cg.sync.onEnabledChange(fn)` subscribes to changes.

The initial value resolves at startup in this order:

1. the page's own URL param — `?sync=1` / `?sync=0` (case-tolerant, also
   true/false/on/off)
2. the server-provided default — `syncDefault` in createServer options /
   `commonground.config.js` (`commonground serve --sync` / `--no-sync`),
   fetched lazily from `api/client-config` (relative, subpath-safe)
3. `true`

```js
cg.sync.enabled = false;                          // stop participating
const offEnabled = cg.sync.onEnabledChange((on) => console.log('sync:', on));
```

## Desktop mode: HUD and control panel

In desktop mode the VR control panel is never shown (it is a VR scene
placement tool; its callbacks still drive `helpers`/`menu` config). Instead,
desktop mode gets a framework-owned DOM overlay top-right — a tab bar
(**Headsets | Spaces | Session**) with a persistent **Helpers** toggle
(`setHelpersVisible()`, the same helper set the VR control panel toggles in
XR) — that stays out of OrbitControls' way and uses relative URLs so
subpath-served pages keep working. Disable it with
`configure({ desktopHud: false })`. VR behavior is unchanged.

- **Headsets** (default): one card per project headset with presence +
  ticking session time (starts on immersion enter, like the CLI dashboard),
  the dashboard `columns` strings rendered as lines
  (falling back to raw `status key: value` when no columns are configured),
  the anchor state of the currently selected space, a Clear button
  (`DELETE api/anchors?device=N`), and a **View** button (disabled while
  the headset is offline) toggling a "view from headset" mirror window —
  see below. Data comes from `GET api/headsets`
  (polled ~2s, plus refreshes on `cg.status` updates); presence, immersion
  and the merged status come from the socket relay (`relay.presence` /
  `relay.immersion` / `relay.coreStatus`).
- **Spaces**: the current space, a Select button per existing space, and an
  add-new-space row (`GET/POST api/spaces`, `POST api/spaces/select`).
  Selecting a space re-points the server's AnchorStore at
  `<dataDir>/spaces/<name>/` and broadcasts `cg:space`; connected headsets
  re-run their server anchor restore without a reload, and the Headsets
  tab's anchor state refers to the newly selected space.
- **Session**: the sync on/off toggle (`cg.sync.enabled`, runtime switch),
  the **Stream** toggle (`cg.stream`, shared server-side switch, default
  off), and a Session Log button that opens the integrated viewer
  (`commonground/logs`) in an iframe overlay (X, ESC or backdrop click to
  close).

The desktop orbit camera is framed automatically once the initial content
loads: it fits the app's placed content (the SceneManager group, visible
geometry only — room mesh, RATK planes and hidden helpers are excluded) in
the window. Apps with late-loading content can re-frame with
`cg.frameDesktopView()` after their content is added.

### Stream figures

While Stream is on, every immersed headset sends its (sceneStage-relative)
camera pose (~10 Hz) and the desktop page shows one human figure per
configured headset — the bundled FBX (`assets/user1.fbx`) cloned with
`SkeletonUtils.clone`, tinted with the headset's `color` from
`api/client-config`, with a matte (non-metallic) finish. Figures stand with
their feet at `(x, 0, z)` and yaw-only orientation (a standing figure
doesn't pitch/roll with the head), stay hidden until the first pose, and
are hidden again when no pose arrives for ~1s — poses stop when immersion
ends, the page reloads, or the headset disconnects, so there are no
parking positions and the app configures nothing.

The `desktopFigure` constructor/`configure()` option selects the figure
template URL (default `'commonground/assets/user1.fbx'`); `false` disables
the figures. Figures taller than 10 raw units are assumed to be exported in
centimeters and scaled to meters.

### Desktop floor plane

Desktop mode adds a subtle ground reference under the content: a 7×7 m
black plane at 20% opacity (`'DesktopFloorPlane'`), child of the sceneStage
so the desktop anchor restore positions it with the content, raised 5 mm
with polygonOffset to avoid z-fighting the room mesh floor. Never added in
XR sessions.

### Headset mirror windows ("View from headset")

The View button on a Headsets card opens a floating window on the desktop
page that renders the SAME three.js scene from that headset's point of
view — strictly via the streamed pose, no video feed. Opening a window
registers a `cg:watch` on the headset, so it sends poses even while the
shared Stream toggle is off; closing unwatches (the server ref-counts
watchers, so several desktop pages can watch the same headset). One window
per headset; draggable by the title bar (kept inside the viewport), title
bar shows the headset name and its configured color dot.

The window's camera is a mono `PerspectiveCamera` (fov ~95, near 0.05)
driven by the sceneStage-relative pose mapped to world space and applied
directly (full orientation, not the yaw-only figure placement), smoothed
per frame (position lerp / quaternion slerp at ~12/s so 10 Hz updates look
continuous; the first pose snaps). Rendering reuses the main
WebGLRenderer: per frame, each open window with a fresh pose is rendered
into the canvas rectangle behind its div via
setViewport/setScissor(+setScissorTest), and the full-canvas
viewport/scissor state is restored afterwards so the main orbit view is
unaffected. When no pose arrives for ~1.5 s the window shows a dim "not
immersed" placeholder instead of a frozen frame.

### Session log viewer

The integrated session log viewer lives at `GET /commonground/logs` (title
via `sessionLogTitle`, default 'Session Logs'), backed by
`GET /commonground/api/session-logs`. It lists sessions with durations, a
per-session bar chart, and expandable timelines built from any status
history arrays.

## FPS counter

`FPSCounter` is a small canvas-texture plane (250 ms sampling) attached to
the active camera, so it shows both in XR and in the desktop orbit view —
the desktop counterpart of the DesktopHud living in the same corner of the
experience. CommonGround drives it from its render loop; no external frame
bus needed.

Configured via constructor option or `configure({ fpsCounter })` with values
`true | false | 'auto'` (default `'auto'`): `'auto'` follows admin mode —
the counter is on while `adminModeEnabled` is true and tracks runtime
`setAdminModeEnabled()` calls. An explicit `setFpsCounterEnabled(bool)`
overrides `'auto'` until the next `configure({ fpsCounter })`.

```js
cg.configure({ fpsCounter: 'auto' });  // follow admin mode (default)
cg.setFpsCounterEnabled(true);         // explicit runtime override
cg.getFpsCounterEnabled();             // → effective boolean
```

## Scene accessors

- `getCeilingHeight()`: returns the current ceiling height estimate.

## Event hooks

- `onCeilingHeightChanged(fn)`: registers a callback for ceiling-height updates.
- `onSessionStart(fn)`: registers a callback for XR session start.
- `onSessionEnd(fn)`: registers a callback for XR session end.
- `setDepthOverlay(overlay)`: registers an `XRDepthOverlay` instance.
- `setDepthOcclusion(occlusion)`: registers an `XRDepthOcclusion` instance.

## Occlusion controls

- `getOcclusionMaterial(mode)`: returns the material for `prepass` or `shader` occlusion.
- `setOcclusionMode(mode, meshes)`: switches the active occlusion mode and optionally swaps materials on meshes.
- `setOcclusionBias(meters)`: updates the occlusion bias in meters.
- `setOcclusionEnabled(enabled, options)`: enables or disables depth occlusion at runtime.
- `setOcclusionClearBoxes(boxes)`: sets the clear boxes used by the occlusion pass.
- `setOcclusionClearBoxesProvider(provider)`: registers a provider function for clear boxes.
- `refreshOcclusionClearBoxes()`: re-evaluates clear boxes from the configured provider.
- `toggleDepthOverlay()`: toggles the depth overlay and returns the new enabled state.

## Visibility helpers

- `setRoomMeshVisible(visible)`: shows or hides detected room mesh content.
- `setHelpersVisible(visible)`: shows or hides helper objects such as axes, grids, and debug cubes. Also wired to the Helpers checkbox in the desktop HUD. Helpers start hidden by default; pass `configure({ helpers: true })` to show them at startup.
- `helpersVisible`: getter for the current helpers visibility state.
- `setMenuVisible(visible)`: shows or hides the VR control panel when XR mode is active.

## Properties

- `buttonText`: gets or sets the AR button label.
- `depthOcclusion`: public handle to the active occlusion instance when occlusion is enabled.
- `depthOverlay`: public handle to the active overlay instance when occlusion is enabled.
