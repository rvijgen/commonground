/**
 * CommonGround - WebXR scene persistence library
 * Encapsulates Three.js + RATK setup, drift compensation, session management,
 * VR control panel, and controller handling into a reusable module.
 */

import { ARButton, RealityAccelerator } from 'ratk';
import {
    BoxGeometry,
    Color,
    DataArrayTexture,
    DirectionalLight,
    EdgesGeometry,
    Group,
    HemisphereLight,
    LineBasicMaterial,
    LineSegments,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    MeshStandardMaterial,
    NearestFilter,
    PerspectiveCamera,
    Quaternion,
    Scene,
    ShaderMaterial,
    Vector3,
    Vector4,
    WebGLRenderer,
} from 'three';
import { XRDepthOcclusion } from './XRDepthOcclusion.js';
import { XRDepthOverlay } from './XRDepthOverlay.js';

import { Text } from 'troika-three-text';
import { VRControlPanel } from './VRControlPanel.js';
import { ControllerManager } from './ControllerManager.js';
import { SceneManager } from './Scene.js';
import { MeshFunctions } from './MeshFunctions.js';
import Desktop from './Desktop.js';
import { createSocketConnection, resolveSyncEnabled } from './SocketClient.js';
import { SyncChannel } from './SyncChannel.js';
import { StatusChannel } from './StatusChannel.js';
import { DesktopHud } from './DesktopHud.js';

const DRIFT_POS_THRESHOLD = 0.005; // 5mm
const DRIFT_ROT_THRESHOLD = 0.01;  // ~0.6 degrees

export class CommonGround {
    constructor(options = {}) {
        // Core Three.js
        this.camera = null;
        this.scene = null;
        this.renderer = null;
        this.controls = null;

        // XR quality — set before calling init()
        // foveation: 0 = sharp everywhere, 1 = max foveation (Quest default)
        // framebufferScale: 1.0 = native res, 1.5 = supersampled, 0.5 = half res
        this._xrFoveation = 1;
        this._xrFramebufferScale = 1.0;

        // RATK
        this.ratk = null;

        // Managers
        this.sceneManager = null;
        this.vrControlPanel = null;
        this.controllerManager = null;
        this.meshFunctions = null;
        this.desktop = null;
        this._meshPresentationInitialized = new WeakSet();

        // State
        this.isDesktopMode = true;
        this.roomMeshVisible = true;
        this.sessionstarted = false;
        this._adminModeEnabled = false;

        // Drift compensation
        this.planesInScene = new Group();
        this.centerCube = null;
        this.sceneCube = null;
        this.ceilingHeight = 2.4; // default, updated from detected ceiling

        // User callbacks
        this._onSessionStart = null;
        this._depthOverlay   = null;
        this._depthOcclusion = null;
        this._onSessionEnd = null;
        this._reloadOnProgrammaticSessionEnd = false;
        this._onCeilingHeightChanged = null;

        // Depth occlusion (built-in, enabled via configure())
        this._occlusionEnabled = false;
        this._occlusionMode    = 'prepass'; // 'prepass' | 'shader'
        this._occlusionRangeMeters = Number.isFinite(options.occlusionRangeMeters)
            ? options.occlusionRangeMeters
            : null;
        this._occlusionClearBoxesProvider = null;
        this._overlayEnabled   = false;
        this._prePassMat       = null;
        this._shaderMat        = null;
        /** Public handles — set when occlusion is enabled */
        this.depthOcclusion    = null;
        this.depthOverlay      = null;
        this._ceilingReady = null;
        this._ceilingReadyPromise = new Promise((resolve) => { this._ceilingReady = resolve; });
        this._ceilingDetected = false;

        // Device identifier for per-device anchor namespacing
        this._deviceId = this._resolveDeviceId(options.deviceId);
        console.log('[CommonGround] deviceId:', this._deviceId);
        this._buttonText = 'ENTER COMMONGROUND';

        // Cross-headset channels (socket.io, lazily connected same-origin)
        this._socketPath = typeof options.socketPath === 'string' ? options.socketPath : '/socket.io/';
        this._clientRole = options.clientRole ?? null;
        this._socketConnectionPromise = null;
        this.sync = new SyncChannel(() => this._ensureSocketConnection(), {
            resolveEnabled: () => resolveSyncEnabled(),
        });
        this.status = new StatusChannel(() => this._ensureSocketConnection());

        // Desktop-only DOM overlay (sync toggle + session logs link)
        this._desktopHudEnabled = options.desktopHud !== false;
        this._desktopHud = null;

        // API endpoints (optional override; defaults keep legacy relative behavior)
        this._apiBase = '/api';
        this._anchorsEndpoint = '/api/anchors';
        this._meshEndpoint = '/api/mesh';
        this._setApiConfig(options);

        // Initial visibility config (applied before first render)
        this._initialConfig = { roomMesh: true, helpers: true, menu: true, occlusion: false, occlusionMode: 'prepass' };
    }

    /**
     * Configure initial visibility before calling init().
     * Call this before init() to avoid a visible flash.
     */
    configure({ roomMesh, helpers, menu, occlusion, occlusionMode, overlay, occlusionRangeMeters, apiBase, anchorsEndpoint, meshEndpoint, deviceId, socketPath, clientRole, desktopHud } = {}) {
        if (roomMesh !== undefined) this._initialConfig.roomMesh = roomMesh;
        if (helpers !== undefined) this._initialConfig.helpers = helpers;
        if (menu !== undefined) this._initialConfig.menu = menu;
        if (occlusion !== undefined) this._occlusionEnabled = !!occlusion;
        if (occlusionMode !== undefined) this._occlusionMode = occlusionMode;
        if (overlay !== undefined) this._overlayEnabled = !!overlay;
        if (Number.isFinite(occlusionRangeMeters)) this._occlusionRangeMeters = occlusionRangeMeters;
        if (deviceId !== undefined) this._deviceId = deviceId;
        if (typeof socketPath === 'string' && socketPath.trim()) this._socketPath = socketPath.trim();
        if (clientRole !== undefined) this._clientRole = clientRole;
        if (desktopHud !== undefined) this._desktopHudEnabled = !!desktopHud;
        if (apiBase !== undefined || anchorsEndpoint !== undefined || meshEndpoint !== undefined) {
            this._setApiConfig({ apiBase, anchorsEndpoint, meshEndpoint });
        }
        return this;
    }

    /**
     * Lazily connect to the server's socket.io endpoint (same origin). The
     * client script is loaded from <socketPath>socket.io.js at runtime, so
     * the browser bundle stays socket.io-free at import time.
     */
    _ensureSocketConnection() {
        if (!this._socketConnectionPromise) {
            this._socketConnectionPromise = createSocketConnection({
                socketPath: this._socketPath,
                deviceId: this._deviceId,
                clientRole: this._clientRole,
            });
        }
        return this._socketConnectionPromise;
    }

    _setApiConfig({ apiBase, anchorsEndpoint, meshEndpoint } = {}) {
        if (typeof apiBase === 'string' && apiBase.trim()) {
            this._apiBase = this._normalizeEndpointForPageSecurity(apiBase.trim());
        }

        this._anchorsEndpoint =
            typeof anchorsEndpoint === 'string' && anchorsEndpoint.trim()
                ? this._normalizeEndpointForPageSecurity(anchorsEndpoint.trim())
                : this._joinApiPath(this._apiBase, 'anchors');

        this._meshEndpoint =
            typeof meshEndpoint === 'string' && meshEndpoint.trim()
                ? this._normalizeEndpointForPageSecurity(meshEndpoint.trim())
                : this._joinApiPath(this._apiBase, 'mesh');
    }

    _normalizeEndpointForPageSecurity(endpoint) {
        const value = String(endpoint || '');
        if (typeof window === 'undefined' || window.location?.protocol !== 'https:') {
            return value;
        }
        // Prevent mixed-content fetches when running the app over HTTPS.
        if (/^http:\/\//i.test(value)) {
            return value.replace(/^http:\/\//i, 'https://');
        }
        return value;
    }

    _joinApiPath(base, pathPart) {
        const normalizedBase = String(base || '/api').replace(/\/+$/, '');
        const normalizedPath = String(pathPart || '').replace(/^\/+/, '');
        return `${normalizedBase}/${normalizedPath}`;
    }

    _resolveDeviceId(explicitDeviceId) {
        if (explicitDeviceId !== undefined && explicitDeviceId !== null) {
            const parsedExplicit = Number.parseInt(String(explicitDeviceId), 10);
            return Number.isInteger(parsedExplicit) ? parsedExplicit : 1;
        }

        if (typeof window !== 'undefined' && window.location && typeof window.location.search === 'string') {
            const params = new URLSearchParams(window.location.search);
                const deviceParam = params.get('device')
                    ?? params.get('deviceId')
                    ?? params.get('deviceid')
                    ?? params.get('deviced');
            if (deviceParam !== null) {
                const parsedFromUrl = Number.parseInt(deviceParam, 10);
                if (Number.isInteger(parsedFromUrl)) {
                    return parsedFromUrl;
                }
            }
        }

        return 1;
    }

    /** Returns an anchor storage key namespaced by deviceId when set. */
    _anchorKey(id) {
        return this._deviceId != null ? `device_${this._deviceId}_${id}` : id;
    }

    _anchorsRequestUrl() {
        if (this._deviceId == null) return this._anchorsEndpoint;
        const separator = this._anchorsEndpoint.includes('?') ? '&' : '?';
        return `${this._anchorsEndpoint}${separator}device=${encodeURIComponent(this._deviceId)}`;
    }

    _anchorValue(anchorRefs, id) {
        if (!anchorRefs || typeof anchorRefs !== 'object') return null;
        const namespaced = anchorRefs[this._anchorKey(id)];
        if (namespaced !== undefined) return namespaced;
        return anchorRefs[id] ?? null;
    }

    /**
     * Initialize the CommonGround environment. Call once, await the result.
     */
    async init() {
        this.scene = new Scene();
        this._ensureSocketConnection();
        this._setupCamera();
        this._setupLighting();
        this._setupRenderer();
        await this._setupARButton();
        if (this.isDesktopMode && this._desktopHudEnabled && !this._desktopHud) {
            this._desktopHud = new DesktopHud(this);
        }
        this._setupScene();
        this._setupRATK();
        this._setupOcclusion();

        window.addEventListener('resize', this._onWindowResize.bind(this));
        this._animate();
        this._setupDriftCheck();
        setInterval(this._checkDrift.bind(this), 500);

        // In desktop mode with no mesh data, resolve after a timeout fallback
        if (this.isDesktopMode) {
            setTimeout(() => {
                if (!this._ceilingDetected) {
                    this._ceilingDetected = true;
                    this._ceilingReady();
                }
            }, 3000);
        }

        // Wait until ceiling height is known
        await this._ceilingReadyPromise;

        return this;
    }

    // ── Public API ──────────────────────────────────────────────────────

    /** Add an object to sceneStage */
    addObject(name, mesh, position = new Vector3(0, 0, 0)) {
        return this.sceneManager.addObject(name, mesh, position);
    }

    /** Remove an object from sceneStage */
    removeObject(name) {
        return this.sceneManager.removeObject(name);
    }

    get buttonText() {
        return this._buttonText ?? '';
    }

    set buttonText(value) {
        this._buttonText = value;
        if (this.arButton) this.arButton.innerHTML = value;
    }

    /** Get an object by name */
    getObject(name) {
        return this.sceneManager.getObject(name);
    }

    /** Move an object to a new position */
    moveObject(name, newPosition) {
        return this.sceneManager.moveObject(name, newPosition);
    }

    /** Scale an object */
    scaleObject(name, scale) {
        return this.sceneManager.scaleObject(name, scale);
    }

    /** The Three.js Scene */
    getScene() { return this.scene; }

    /** The Three.js Camera */
    getCamera() { return this.camera; }

    /** The Three.js Renderer */
    getRenderer() { return this.renderer; }

    /** The sceneStage Group (user content lives here) */
    getStage() { return this.sceneManager.sceneStage; }

    /** Current ceiling height in sceneStage local space */
    getCeilingHeight() { return this.ceilingHeight; }

    /** Register a callback for when ceiling height is detected/updated */
    onCeilingHeightChanged(fn) { this._onCeilingHeightChanged = fn; }

    /** Register a callback for XR session start */
    onSessionStart(fn) { this._onSessionStart = fn; }

    /**
     * Register a depth overlay that receives update(frame, referenceSpace)
     * each frame before renderer.render().
     */
    setDepthOverlay(overlay) {
        this._depthOverlay = overlay;
    }

    /**
     * Register a depth occlusion pass that runs a depth pre-pass before
     * renderer.render(), blocking virtual objects behind real-world surfaces.
     */
    setDepthOcclusion(occlusion) {
        this._depthOcclusion = occlusion;
    }

    /** Register a callback for XR session end */
    onSessionEnd(fn) { this._onSessionEnd = fn; }

    // ── Occlusion public API ────────────────────────────────────────────

    /**
     * Returns the material for the given occlusion mode (or the current mode
     * when no argument is passed). Assign this to a mesh's .material property.
     * @param {'prepass'|'shader'} [mode]
     */
    getOcclusionMaterial(mode) {
        const m = mode || this._occlusionMode;
        return m === 'shader' ? this._shaderMat : this._prePassMat;
    }

    /**
     * Switch the active occlusion mode at runtime.
     * @param {'prepass'|'shader'} mode
     * @param {THREE.Mesh|THREE.Mesh[]} [meshes]  Meshes whose .material should be swapped.
     * @returns {THREE.Material} The new material (assign to any additional meshes manually).
     */
    setOcclusionMode(mode, meshes = []) {
        if (mode !== 'prepass' && mode !== 'shader') {
            console.warn('[CommonGround] occlusionMode must be "prepass" or "shader"');
            return;
        }
        this._occlusionMode = mode;
        if (this._depthOcclusion) this._depthOcclusion.setPrePassEnabled(mode === 'prepass');
        const mat = this.getOcclusionMaterial(mode);
        const targets = Array.isArray(meshes) ? meshes : [meshes];
        targets.forEach(m => { if (m) m.material = mat; });
        console.log('[CommonGround] occlusionMode:', mode);
        return mat;
    }

    /**
     * Set the occlusion bias in metres. Applied to both pre-pass and shader.
     * @param {number} meters
     */
    setOcclusionBias(meters) {
        if (this._depthOcclusion) this._depthOcclusion.setPrePassBiasMeters(meters);
        if (this._shaderMat) this._shaderMat.uniforms.uBiasMeters.value = meters;
    }

    /**
     * Enable/disable depth occlusion at runtime.
     * Mirrors the common runtime toggles for XRDepthOcclusion and keeps
     * CommonGround config in sync.
     * @param {boolean} enabled
     * @param {{ occlusionRangeMeters?: number }} [options]
     * @returns {boolean}
     */
    setOcclusionEnabled(enabled, options = {}) {
        const nextEnabled = !!enabled;
        this._occlusionEnabled = nextEnabled;
        const usePrePass = nextEnabled && this._occlusionMode === 'prepass';
        const rangeMeters = Number.isFinite(options.occlusionRangeMeters)
            ? options.occlusionRangeMeters
            : this._occlusionRangeMeters;

        const depthOcc = this._depthOcclusion;
        if (depthOcc) {
            if (typeof depthOcc.setPrePassEnabled === 'function') {
                depthOcc.setPrePassEnabled(usePrePass);
            }
            if (typeof depthOcc.setEnabled === 'function') {
                depthOcc.setEnabled(nextEnabled);
            }
            if (typeof depthOcc.enable === 'function' && nextEnabled) {
                depthOcc.enable();
            }
            if (typeof depthOcc.disable === 'function' && !nextEnabled) {
                depthOcc.disable();
            }

            if (Number.isFinite(rangeMeters) && typeof depthOcc.setGpuPrePassRangeMeters === 'function') {
                depthOcc.setGpuPrePassRangeMeters(usePrePass ? rangeMeters : 0);
            }
            if (nextEnabled && Number.isFinite(rangeMeters) && typeof depthOcc.setGpuShaderRangeMeters === 'function') {
                depthOcc.setGpuShaderRangeMeters(rangeMeters);
            }
            if ('enabled' in depthOcc) {
                depthOcc.enabled = nextEnabled;
            }
        }

        // Keep CommonGround configure state aligned as a fallback.
        this.configure({
            occlusion: nextEnabled,
            occlusionMode: this._occlusionMode,
        });

        return nextEnabled;
    }

    setOcclusionClearBoxes(boxes = []) {
        if (typeof this._depthOcclusion?.setClearBoxes === 'function') {
            this._depthOcclusion.setClearBoxes(boxes);
        }
        return Array.isArray(boxes) ? boxes.length : 0;
    }

    setOcclusionClearBoxesProvider(provider) {
        this._occlusionClearBoxesProvider = typeof provider === 'function' ? provider : null;
        this.refreshOcclusionClearBoxes();
    }

    refreshOcclusionClearBoxes() {
        if (!this._occlusionClearBoxesProvider) {
            return this.setOcclusionClearBoxes([]);
        }
        const clearBoxes = this._occlusionClearBoxesProvider() ?? [];
        return this.setOcclusionClearBoxes(clearBoxes);
    }

    /**
     * Toggle the depth overlay visibility.
     * @returns {boolean} The new overlay state (true = enabled)
     */
    toggleDepthOverlay() {
        if (!this._depthOverlay) return false;
        if (this._depthOverlay._enabled) {
            this._depthOverlay.disable();
            console.log('[CommonGround] Depth overlay disabled');
            return false;
        } else {
            this._depthOverlay.enable();
            console.log('[CommonGround] Depth overlay enabled');
            return true;
        }
    }

    /** Show/hide room mesh (detected planes & meshes) */
    setRoomMeshVisible(visible) {
        const nextVisible = Boolean(visible);
        if (this.vrControlPanel && this.vrControlPanel.callbacks) {
            this.vrControlPanel.callbacks.toggleRoomMeshVisibility(nextVisible);
            return;
        }
        this.roomMeshVisible = nextVisible;
        this._syncRoomMeshPresentation(nextVisible);
    }

    /** Show/hide helpers (red cube, wireframe plane, axes, ceiling grid, plane outlines, centerCube) */
    setHelpersVisible(visible) {
        if (this.vrControlPanel && this.vrControlPanel.callbacks) {
            this.vrControlPanel.callbacks.toggleHelpers(visible);
        }
    }

    /** Show/hide the VR control panel (no-op in desktop mode) */
    setMenuVisible(visible) {
        if (this.vrControlPanel && !this.isDesktopMode) {
            this.vrControlPanel.setVisible(visible, true);
        }
    }

    /** Enable/disable admin-only XR menu handling. This is controlled by the app layer, not CommonGround itself. */
    setAdminModeEnabled(enabled) {
        this._adminModeEnabled = !!enabled;
        if (this.controllerManager) {
            this.controllerManager._updateRightMenuButtons();
        }
        return this._adminModeEnabled;
    }

    get adminModeEnabled() {
        return this._adminModeEnabled;
    }

    // ── Internal setup ──────────────────────────────────────────────────

    _setupCamera() {
        this.camera = new PerspectiveCamera(
            50,
            window.innerWidth / window.innerHeight,
            0.1,
            1000,
        );
        this.camera.position.set(0, 1.6, 3);
    }

    _setupLighting() {
        this.scene.add(new HemisphereLight(0x606060, 0x404040));
        const light = new DirectionalLight(0xffffff);
        light.position.set(1, 1, 1).normalize();
        this.scene.add(light);
    }

    _setupRenderer() {
        this.renderer = new WebGLRenderer({
            alpha: true,
            antialias: true,
            // Disable multiview for XR depth occlusion pre-pass compatibility.
            // With multiview enabled, a non-multiview pre-pass can fail to write
            // valid depth to both eye layers on Quest runtimes.
            multiviewStereo: false,
        });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.xr.enabled = true;
        this.renderer.xr.setFoveation(this._xrFoveation ?? 1);
        this.renderer.xr.setFramebufferScaleFactor(this._xrFramebufferScale ?? 1.0);
        document.body.appendChild(this.renderer.domElement);

        if (this.isDesktopMode) {
            this.desktop = new Desktop(this.camera, this.renderer);
            this.desktop.setupOrbitControls();
            this.controls = this.desktop.controls;
        }

        this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            console.warn('WebGL context lost. Attempting to restore...');
        });
    }

    async _setupARButton() {
        const arButton = document.getElementById('ar-button');
        this.arButton = arButton;
        const webLaunchButton = document.getElementById('web-launch-button');

        if (!navigator.xr) {
            arButton.style.display = 'none';
            webLaunchButton.style.display = 'none';
            this.isDesktopMode = true;
            const canvas = document.querySelector('canvas');
            if (canvas) canvas.style.display = '';
            console.log('Desktop mode detected (no navigator.xr)');
            return;
        }

        try {
            const supported = await navigator.xr.isSessionSupported('immersive-ar');
            if (!supported) {
                console.log('AR not supported, desktop mode confirmed');
                arButton.style.display = 'none';
                webLaunchButton.style.display = 'none';
                this.isDesktopMode = true;
            } else {
                this.isDesktopMode = false;
                console.log('AR supported, VR mode confirmed');
                const canvas = document.querySelector('canvas');
                if (canvas) canvas.style.display = 'none';
            }
        } catch (error) {
            console.log('XR detection failed, assuming desktop mode');
            this.isDesktopMode = true;
            arButton.style.display = 'none';
            webLaunchButton.style.display = 'none';
        }

        webLaunchButton.onclick = () => {
            window.open(
                'https://www.oculus.com/open_url/?url=' +
                    encodeURIComponent(window.location.href),
            );
        };

        // Patch requestSession to inject depthSensing options that RATK's
        // ARButton.convertToARButton silently drops.
        const _origRequest = navigator.xr.requestSession.bind(navigator.xr);
        navigator.xr.requestSession = (mode, init = {}) => {
            if (mode === 'immersive-ar') {
                init = Object.assign({}, init, {
                    depthSensing: {
                        usagePreference: ['cpu-optimized'],
                        dataFormatPreference: ['unsigned-short', 'luminance-alpha'],
                    },
                });
            }
            return _origRequest(mode, init);
        };

        ARButton.convertToARButton(arButton, this.renderer, {
            requiredFeatures: [
                'anchors',
                'plane-detection',
                'mesh-detection',
                'local-floor',
            ],
            optionalFeatures: [
                'depth-sensing',
            ],
            // depthSensing is injected via the requestSession patch above — RATK doesn't forward it from here.
            onUnsupported: () => {
                arButton.style.display = 'none';
                webLaunchButton.style.display = 'block';
                this.isDesktopMode = true;
                const canvas = document.querySelector('canvas');
                if (canvas) canvas.style.display = '';
            },
            onSupported: () => {
                arButton.innerHTML = this._buttonText ?? 'ENTER COMMONGROUND';
            }
        });
    }

    _setupScene() {
        this.sceneManager = new SceneManager();
        this.scene.add(this.sceneManager.getSceneGroup());
        console.log('XR scene content added to Three.js scene');
    }

    _setupRATK() {
        this.ratk = new RealityAccelerator(this.renderer.xr);
        this.ratk.onPlaneAdded = this._handlePlaneAdded.bind(this);
        this.ratk.onMeshAdded = this._handleMeshAdded.bind(this);
        this.scene.add(this.ratk.root);

        this.meshFunctions = new MeshFunctions(this._meshEndpoint);
        this.meshFunctions.setupGlobalFunctions(this.ratk, () => this.isDesktopMode);

        this._setupVRControlPanel();
        this._setupControllerManager();

        if (this.isDesktopMode) {
            this.desktop.loadRoomMeshForDesktop(this.meshFunctions, this.scene, this.roomMeshVisible, this.isDesktopMode)
                .then((geometries) => {
                    this._detectDesktopCeilingHeight(geometries);
                    this._restoreDesktopFromServer();
                });
        }

        if (navigator.xr) {
            this.renderer.xr.addEventListener('sessionstart', () => {
                console.log('XR session started');
                this.renderer.xr.setFoveation(this._xrFoveation ?? 1);
                const _s = this.renderer.xr.getSession();
                console.log('[CG] depthUsage:', _s.depthUsage, '| depthDataFormat:', _s.depthDataFormat);
                if (this.controls) this.controls.enabled = false;
                if (this.controllerManager) this.controllerManager.setupControllerGrips();

                setTimeout(() => {
                    if (!this.sessionstarted) this._startSession();
                }, 500);

                setTimeout(() => {
                    if (this.ratk.planes.size === 0) {
                        this.renderer.xr.getSession().initiateRoomCapture();
                    }
                }, 5000);

                const session = this.renderer.xr.getSession();
                session.addEventListener('visibilitychange', () => {
                    switch (session.visibilityState) {
                        case 'visible':
                            console.log('Headset is on and active.');
                            if (!this.sessionstarted) this._startSession();
                            break;
                        case 'visible-blurred':
                            console.log('Headset is on but user not actively looking.');
                            this._endSession();
                            break;
                        case 'hidden':
                            console.log('Headset is off or session not visible.');
                            this._endSession();
                            break;
                    }
                });

                if (this._onSessionStart) this._onSessionStart();
            });

            this.renderer.xr.addEventListener('sessionend', () => {
                console.log('XR session ended');
                this.sessionstarted = false;
                if (this.controls && this.isDesktopMode) this.controls.enabled = true;
                if (this._onSessionEnd) this._onSessionEnd();
                if (this._reloadOnProgrammaticSessionEnd) {
                    this._reloadOnProgrammaticSessionEnd = false;
                    window.location.reload();
                }
            });

            navigator.xr.addEventListener('visibilitychange', (event) => {
                console.log('XR visibility changed:', event.session.visibilityState);
            });
        } else {
            console.log('Desktop mode - XR event listeners not added');
        }
    }

    _setupVRControlPanel() {
        this.vrControlPanel = VRControlPanel.createControlPanel(
            this.scene,
            this.ratk,
            this.controllerManager,
            (visible) => {
                this.roomMeshVisible = this.meshFunctions.toggleRoomMeshVisibility(visible, this.ratk, this.scene, this.isDesktopMode);
                this._syncRoomMeshPresentation(this.roomMeshVisible);
            },
            (ratk) => VRControlPanel.clearPersistentAnchorData(ratk, this._anchorsEndpoint, this._deviceId),
            this.renderer,
            this.sceneManager,
            this.isDesktopMode,
        );
        // console.log(this.vrControlPanel);
    }

    _applyInitialConfig() {
        const { roomMesh, helpers, menu } = this._initialConfig;
        if (!roomMesh) this.setRoomMeshVisible(false);
        if (!helpers) {
            if (this.vrControlPanel && this.vrControlPanel.callbacks) {
                this.vrControlPanel.callbacks.toggleHelpers(false);
            }
        }
        if (!menu && !this.isDesktopMode) {
            this.vrControlPanel.setVisible(false, true);
        }
    }

    _setupControllerManager() {
        if (!this.isDesktopMode) {
            this.controllerManager = new ControllerManager(
                this.renderer,
                this.scene,
                this.ratk,
                this.vrControlPanel,
                this.sceneManager,
                this._anchorsEndpoint,
                this._deviceId,
                this,
            );
            if (this.vrControlPanel && this.vrControlPanel.callbacks) {
                this.vrControlPanel.callbacks.saveAnchorsToServer = () => {
                    this.meshFunctions.exportRoomMeshToServer(this.ratk, this.isDesktopMode);
                    return this.controllerManager.saveSceneAndPanelAnchors();
                };
            }
        } else {
            console.log('Desktop mode - skipping controller manager setup');
        }
        this._applyInitialConfig();
    }

    // ── Occlusion setup ─────────────────────────────────────────────────

    _setupOcclusion() {
        if (!this._occlusionEnabled) return;
        this._depthOcclusion = new XRDepthOcclusion(this.renderer);
        this._depthOverlay   = new XRDepthOverlay(this.renderer, this.scene);
        this._depthOverlay.setSourcePreference('gpu');
        if (this._overlayEnabled) this._depthOverlay.enable();
        // Public shortcuts
        this.depthOcclusion = this._depthOcclusion;
        this.depthOverlay   = this._depthOverlay;
        // Build both materials; only one is active at a time
        this._prePassMat = this._createPrePassMaterial();
        this._shaderMat  = this._createShaderMaterial();
        // Apply initial mode
        this._depthOcclusion.setPrePassEnabled(this._occlusionMode === 'prepass');
    }

    _createPrePassMaterial() {
        return new MeshStandardMaterial({ color: 0xcccccc, roughness: 0.8, metalness: 0.1 });
    }

    _createShaderMaterial() {
        const placeholderGpuDepthTex = new DataArrayTexture(new Float32Array([0]), 1, 1, 1);
        placeholderGpuDepthTex.minFilter = NearestFilter;
        placeholderGpuDepthTex.magFilter = NearestFilter;
        placeholderGpuDepthTex.needsUpdate = true;

        const depthOcclusion = this._depthOcclusion;

        const mat = new ShaderMaterial({
            uniforms: {
                uGpuDepthTex:    { value: placeholderGpuDepthTex },
                uGpuLayer:       { value: 0 },
                uRawToMeters:    { value: 1.0 },
                uGpuRangeMeters: { value: 5.0 },
                uProj:           { value: new Matrix4() },
                uXRView:         { value: new Matrix4() },
                uUvTransform:    { value: new Matrix4() },
                uViewportPx:     { value: new Vector4(0, 0, 1, 1) },
                uHasDepth:       { value: 0 },
                uBiasMeters:     { value: 0.015 },
                uColor:          { value: new Color(0xcccccc) },
            },
            vertexShader: `
                uniform mat4 uXRView;
                varying float vEyeDepth;
                void main() {
                    vec4 eyePos = uXRView * modelMatrix * vec4(position, 1.0);
                    vEyeDepth = -eyePos.z;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                precision highp float;
                precision highp sampler2DArray;
                uniform sampler2DArray uGpuDepthTex;
                uniform float uGpuLayer;
                uniform float uRawToMeters;
                uniform float uGpuRangeMeters;
                uniform mat4 uProj;
                uniform mat4 uUvTransform;
                uniform vec4 uViewportPx;
                uniform int uHasDepth;
                uniform float uBiasMeters;
                uniform vec3 uColor;
                varying float vEyeDepth;

                float linearizeDepth(float rawDepth, mat4 proj, float fallbackFar) {
                    float m22 = proj[2][2];
                    float m32 = proj[3][2];
                    float nearM = m32 / (m22 - 1.0);
                    float farM  = m32 / (m22 + 1.0);
                    if (!(farM > nearM) || nearM <= 0.0) { nearM = 0.05; farM = fallbackFar; }
                    float zNdc = rawDepth * 2.0 - 1.0;
                    float denom = max(1e-6, farM + nearM - zNdc * (farM - nearM));
                    return (2.0 * nearM * farM) / denom;
                }

                float sampleDepthConservative(vec2 uv, float layer) {
                    ivec3 size = textureSize(uGpuDepthTex, 0);
                    if (size.x <= 0 || size.y <= 0) return 0.0;
                    vec2 c = clamp(uv, vec2(0.0), vec2(1.0));
                    ivec2 base = ivec2(c * vec2(size.xy - ivec2(1)));
                    int l = int(clamp(layer, 0.0, float(max(size.z - 1, 0))));
                    float minRaw = 1.0;
                    bool found = false;
                    for (int oy = -1; oy <= 1; ++oy) {
                        for (int ox = -1; ox <= 1; ++ox) {
                            ivec2 p = clamp(base + ivec2(ox, oy), ivec2(0), size.xy - ivec2(1));
                            float raw = texelFetch(uGpuDepthTex, ivec3(p, l), 0).r;
                            if (raw > 0.0) { minRaw = min(minRaw, raw); found = true; }
                        }
                    }
                    return found ? minRaw : 0.0;
                }

                void main() {
                    if (uHasDepth == 1) {
                        vec2 viewUv = (gl_FragCoord.xy - uViewportPx.xy) / uViewportPx.zw;
                        if (all(greaterThanEqual(viewUv, vec2(0.0))) && all(lessThanEqual(viewUv, vec2(1.0)))) {
                            vec2 depthUv = (uUvTransform * vec4(viewUv, 0.0, 1.0)).xy;
                            float rawDepth = sampleDepthConservative(depthUv, uGpuLayer);
                            float realMeters = linearizeDepth(rawDepth, uProj, uGpuRangeMeters);
                            bool hasDepth = realMeters > 0.01 && realMeters <= (uGpuRangeMeters + 0.5);
                            if (hasDepth && vEyeDepth > realMeters + uBiasMeters) discard;
                        }
                    }
                    gl_FragColor = vec4(uColor, 1.0);
                }
            `,
            depthTest: true,
            depthWrite: true,
        });

        mat.onBeforeRender = (renderer, scene, camera) => {
            depthOcclusion.bindUniformsForCamera(camera, mat.uniforms);
            depthOcclusion.bindGpuDepthTexture(renderer, mat.uniforms.uGpuDepthTex.value);
            const gl = renderer.getContext();
            const vp = gl.getParameter(gl.VIEWPORT);
            const eyeIndex = vp[0] > 0 ? 1 : 0;
            const xrCam = renderer.xr.getCamera();
            const eyeCam = (xrCam?.cameras?.length > eyeIndex) ? xrCam.cameras[eyeIndex] : camera;
            mat.uniforms.uXRView.value.copy(eyeCam.matrixWorldInverse);
        };

        return mat;
    }

    // ── Drift compensation ──────────────────────────────────────────────

    _setupDriftCheck() {
        // console.log('Setting up drift check with center cube');
        const cubeGeom = new BoxGeometry(0.1, 0.1, 0.1);
        const cubeMat = new MeshBasicMaterial({ color: 0xffffff });
        this.centerCube = new Mesh(cubeGeom, cubeMat);
        this.centerCube.name = 'centerCube';
        this.ratk.root.add(this.centerCube);

        this.planesInScene.name = 'planesInScene';
        this.sceneManager.sceneGroup.add(this.planesInScene);

        if (this.controllerManager) {
            this.controllerManager.centerCube = this.centerCube;
        }

        // Apply helpers visibility now that centerCube and planesInScene exist
        if (!this._initialConfig.helpers) {
            this.centerCube.visible = false;
            this.planesInScene.visible = false;
        }
    }

    _checkDrift() {
        // console.log('checking current planes');
        const planeColors = [0x0000ff, 0xff0000, 0x00ff00, 0xffff00, 0xff00ff, 0x00ffff, 0xff8800, 0x888888, 0x8800ff];
        let largestPlane = null;
        let largestArea = 0;
        let count = 0;
        let centerSum = new Vector3();
        const planeColor = planeColors[Math.floor(Math.random() * planeColors.length)];

        this.ratk._planes.forEach((plane) => {
            if (plane && plane.planeMesh && plane.planeMesh.geometry) {
                plane.planeMesh.material.color.setHex(planeColor);
                const geom = plane.planeMesh.geometry;
                const pos = geom.attributes.position;
                const centroid = new Vector3();
                for (let j = 0; j < pos.count; j++) {
                    centroid.x += pos.getX(j);
                    centroid.y += pos.getY(j);
                    centroid.z += pos.getZ(j);
                }
                centroid.divideScalar(pos.count);
                const worldCentroid = plane.planeMesh.localToWorld(centroid.clone());
                centerSum.add(worldCentroid);
                count++;
                const area = (plane.boundingRectangleWidth || 0) * (plane.boundingRectangleHeight || 0);
                if (area > largestArea) {
                    largestArea = area;
                    largestPlane = plane;
                }
            }
        });

        if (count > 0 && largestPlane) {
            const collectiveCenter = centerSum.divideScalar(count);
            this.centerCube.position.copy(collectiveCenter);
            this.centerCube.quaternion.copy(largestPlane.quaternion);
        }
        this._compensateDrift();
        this._updateCeilingGrid();
    }

    _updateCeilingGrid() {
        const ceilingGrid = this.sceneManager.sceneStage.getObjectByName('CeilingGrid');
        if (!ceilingGrid) return;

        // Find a ceiling plane from detected planes
        let ceilingPlane = null;
        let highestY = -Infinity;

        this.ratk._planes.forEach((plane) => {
            if (!plane || !plane.planeMesh) return;
            const worldPos = new Vector3();
            plane.planeMesh.getWorldPosition(worldPos);

            if (plane.semanticLabel === 'ceiling') {
                // Prefer ceiling-labelled planes
                if (!ceilingPlane || ceilingPlane.semanticLabel !== 'ceiling' || worldPos.y > highestY) {
                    ceilingPlane = plane;
                    highestY = worldPos.y;
                }
            } else if (plane.orientation === 'horizontal' && worldPos.y > 1.5) {
                // Fallback: highest horizontal plane above head height
                if (!ceilingPlane || (ceilingPlane.semanticLabel !== 'ceiling' && worldPos.y > highestY)) {
                    ceilingPlane = plane;
                    highestY = worldPos.y;
                }
            }
        });

        if (ceilingPlane) {
            // Convert ceiling world Y to sceneStage local space
            const ceilingWorldPos = new Vector3();
            ceilingPlane.planeMesh.getWorldPosition(ceilingWorldPos);
            this.sceneManager.sceneStage.updateMatrixWorld(true);
            const localPos = this.sceneManager.sceneStage.worldToLocal(ceilingWorldPos.clone());
            ceilingGrid.position.y = localPos.y;
            if (this.ceilingHeight !== localPos.y) {
                this.ceilingHeight = localPos.y;
                if (!this._ceilingDetected) {
                    this._ceilingDetected = true;
                    this._ceilingReady();
                }
                if (this._onCeilingHeightChanged) this._onCeilingHeightChanged(this.ceilingHeight);
            }
        }
    }

    _detectDesktopCeilingHeight(geometries) {
        if (!geometries) return;
        const allPanels = [...(geometries.planes || []), ...(geometries.meshes || [])];
        let highestY = -Infinity;
        let found = false;

        // First pass: look for ceiling-labelled geometry
        allPanels.forEach((item) => {
            if (item.semanticLabel === 'ceiling' && item.geometry) {
                const pos = item.geometry.attributes.position;
                for (let i = 0; i < pos.count; i++) {
                    if (pos.getY(i) > highestY) highestY = pos.getY(i);
                }
                found = true;
            }
        });

        // Fallback: highest vertex above 1.5m from any horizontal-ish plane
        if (!found) {
            allPanels.forEach((item) => {
                if (!item.geometry) return;
                const pos = item.geometry.attributes.position;
                for (let i = 0; i < pos.count; i++) {
                    const y = pos.getY(i);
                    if (y > 1.5 && y > highestY) highestY = y;
                }
            });
            found = highestY > 1.5;
        }

        if (found && highestY > 0) {
            const ceilingGrid = this.sceneManager.sceneStage.getObjectByName('CeilingGrid');
            if (ceilingGrid) ceilingGrid.position.y = highestY;
            this.ceilingHeight = highestY;
            if (!this._ceilingDetected) {
                this._ceilingDetected = true;
                this._ceilingReady();
            }
            if (this._onCeilingHeightChanged) this._onCeilingHeightChanged(this.ceilingHeight);
            // console.log('Desktop: detected ceiling height from mesh data:', highestY.toFixed(3));
        }
    }

    _compensateDrift() {
        if (!this.centerCube || !this.sceneCube) return;

        const worldPosCenter = new Vector3();
        this.centerCube.getWorldPosition(worldPosCenter);
        const worldPosScene = new Vector3();
        this.sceneCube.getWorldPosition(worldPosScene);
        const posDiff = new Vector3().subVectors(worldPosCenter, worldPosScene);

        const worldQuatCenter = new Quaternion();
        this.centerCube.getWorldQuaternion(worldQuatCenter);
        const worldQuatScene = new Quaternion();
        this.sceneCube.getWorldQuaternion(worldQuatScene);
        const quatDiff = worldQuatCenter.clone().multiply(worldQuatScene.clone().invert());

        const posDist = posDiff.length();
        const rotDist = 1.0 - Math.abs(quatDiff.dot(new Quaternion()));

        if (posDist < DRIFT_POS_THRESHOLD && rotDist < DRIFT_ROT_THRESHOLD) return;

        // console.log(`Compensating drift: pos=${posDist.toFixed(4)}m, rot=${rotDist.toFixed(4)}`);
        this.sceneManager.sceneGroup.position.add(posDiff);
        this.sceneManager.sceneGroup.quaternion.premultiply(quatDiff);
    }

    // ── Session management ──────────────────────────────────────────────

    _startSession() {
        const waitForPlanes = () => {
            if (this.ratk._planes.size > 0) {
                this._initSessionWithPlanes();
            } else {
                setTimeout(waitForPlanes, 200);
            }
        };
        waitForPlanes();
        this.sessionstarted = true;
    }

    _initSessionWithPlanes() {
        //console.log('init planes in Scene:', this.ratk._planes.size);
        let largestPlane = null;
        let largestArea = 0;
        let count = 0;
        let centerSum = new Vector3();

        while (this.planesInScene.children.length > 0) {
            const child = this.planesInScene.children[0];
            this.planesInScene.remove(child);
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        }

        const cubeGeom = new BoxGeometry(0.1, 0.1, 0.1);
        const sceneCubeMat = new MeshBasicMaterial({ color: '#0000ff' });
        this.sceneCube = new Mesh(cubeGeom, sceneCubeMat);
        this.sceneCube.name = 'sceneCube';
        this.planesInScene.add(this.sceneCube);

        this.ratk._planes.forEach((plane, i) => {
            //console.log(`Plane ${i}: semanticLabel=${plane.semanticLabel}, orientation=${plane.orientation}, size=${plane.boundingRectangleWidth}x${plane.boundingRectangleHeight}`);
            if (plane && plane.planeMesh && plane.planeMesh.geometry) {
                const edges = new EdgesGeometry(plane.planeMesh.geometry);
                const lineMaterial = new LineBasicMaterial({ color: '#0000ff', linewidth: 5 });
                const line = new LineSegments(edges, lineMaterial);
                line.position.copy(plane.position);
                line.quaternion.copy(plane.quaternion);
                line.renderOrder = 2;
                this.planesInScene.add(line);

                const geom = plane.planeMesh.geometry;
                const pos = geom.attributes.position;
                const centroid = new Vector3();
                for (let j = 0; j < pos.count; j++) {
                    centroid.x += pos.getX(j);
                    centroid.y += pos.getY(j);
                    centroid.z += pos.getZ(j);
                }
                centroid.divideScalar(pos.count);
                const worldCentroid = plane.planeMesh.localToWorld(centroid.clone());
                centerSum.add(worldCentroid);
                count++;

                const area = (plane.boundingRectangleWidth || 0) * (plane.boundingRectangleHeight || 0);
                if (area > largestArea) {
                    largestArea = area;
                    largestPlane = plane;
                }
            }
        });

        if (count > 0 && largestPlane) {
            //console.log('largest plane found:', largestPlane);
            const collectiveCenter = centerSum.divideScalar(count);
            this.sceneCube.position.copy(collectiveCenter);
            this.sceneCube.quaternion.copy(largestPlane.quaternion);
            // Also update centerCube immediately so restoreFromServer has correct centroid
            this.centerCube.position.copy(collectiveCenter);
            this.centerCube.quaternion.copy(largestPlane.quaternion);
            //console.log('set scene cube position:', this.sceneCube.position);
        }
        // console.log(this.planesInScene);

        // Run drift compensation before restore so sceneGroup is aligned
        this._compensateDrift();
        this._restoreFromServer();
    }

    _endSession() {
        console.log('Ending XR session programmatically');
        const session = this.renderer?.xr?.getSession?.();
        if (!session) {
            window.location.reload();
            return;
        }
        if (this._reloadOnProgrammaticSessionEnd) return;
        this._reloadOnProgrammaticSessionEnd = true;
        const fallbackReload = setTimeout(() => {
            if (!this._reloadOnProgrammaticSessionEnd) return;
            this._reloadOnProgrammaticSessionEnd = false;
            window.location.reload();
        }, 1500);
        session.end()
            .then(() => {
                clearTimeout(fallbackReload);
                if (!this._reloadOnProgrammaticSessionEnd) return;
                this._reloadOnProgrammaticSessionEnd = false;
                window.location.reload();
            })
            .catch((error) => {
                clearTimeout(fallbackReload);
                console.error('Failed to end XR session programmatically:', error);
                this._reloadOnProgrammaticSessionEnd = false;
                window.location.reload();
            });
    }

    // ── Server restore ──────────────────────────────────────────────────

    async _getAnchorReferencesFromServer() {
        try {
            const response = await fetch(this._anchorsRequestUrl());
            if (!response.ok) throw new Error(`Anchor reference request failed: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('Failed to fetch anchor references from server:', error);
            return {
                scene_anchor: null,
                control_panel_anchor: null,
                scene_anchor_transform: null,
                control_panel_anchor_transform: null,
            };
        }
    }

    _restoreFromServer() {
        if (!this.centerCube) {
            console.warn('Cannot restore: centerCube not available');
            return;
        }
        // console.log('Restoring positions from server using centroid-relative offsets...');

        this._getAnchorReferencesFromServer().then((anchorRefs) => {
            const centroidWorldPos = new Vector3();
            const centroidWorldQuat = new Quaternion();
            this.centerCube.getWorldPosition(centroidWorldPos);
            this.centerCube.getWorldQuaternion(centroidWorldQuat);

            const sceneOffset = this._anchorValue(anchorRefs, 'scene_anchor_transform');
            if (sceneOffset?.position && sceneOffset?.quaternion) {
                const localOff = new Vector3(sceneOffset.position.x, sceneOffset.position.y, sceneOffset.position.z);
                const localQuatOff = new Quaternion(sceneOffset.quaternion.x, sceneOffset.quaternion.y, sceneOffset.quaternion.z, sceneOffset.quaternion.w);

                const worldPos = localOff.applyQuaternion(centroidWorldQuat).add(centroidWorldPos);
                const worldQuat = centroidWorldQuat.clone().multiply(localQuatOff);

                this.sceneManager.sceneGroup.updateMatrixWorld(true);
                const localPos = this.sceneManager.sceneGroup.worldToLocal(worldPos.clone());
                this.sceneManager.sceneStage.position.copy(localPos);

                const groupWorldQuat = new Quaternion();
                this.sceneManager.sceneGroup.getWorldQuaternion(groupWorldQuat);
                this.sceneManager.sceneStage.quaternion.copy(groupWorldQuat.clone().invert().multiply(worldQuat));
                this.refreshOcclusionClearBoxes();

                // console.log('Restored scene from centroid-relative offset');
            }

            const panelOffset = this._anchorValue(anchorRefs, 'control_panel_anchor_transform');
            if (panelOffset?.position && panelOffset?.quaternion) {
                const localOff = new Vector3(panelOffset.position.x, panelOffset.position.y, panelOffset.position.z);
                const localQuatOff = new Quaternion(panelOffset.quaternion.x, panelOffset.quaternion.y, panelOffset.quaternion.z, panelOffset.quaternion.w);

                const worldPos = localOff.applyQuaternion(centroidWorldQuat.clone()).add(centroidWorldPos.clone());
                const worldQuat = centroidWorldQuat.clone().multiply(localQuatOff);

                this.vrControlPanel.getPanel().position.copy(worldPos);
                this.vrControlPanel.getPanel().quaternion.copy(worldQuat);

                // console.log('Restored panel from centroid-relative offset');
            }
        }).catch((err) => {
            console.error('Failed to restore from server:', err);
        });
    }

    _restoreDesktopFromServer() {
        console.log('Desktop: restoring positions from server...');

        this._getAnchorReferencesFromServer().then((anchorRefs) => {
            const savedCentroid = this._anchorValue(anchorRefs, 'centroid_transform');
            if (!savedCentroid?.position || !savedCentroid?.quaternion) {
                console.warn('Desktop: no saved centroid on server, cannot restore');
                return;
            }

            const centroidPos = new Vector3(savedCentroid.position.x, savedCentroid.position.y, savedCentroid.position.z);
            const centroidQuat = new Quaternion(savedCentroid.quaternion.x, savedCentroid.quaternion.y, savedCentroid.quaternion.z, savedCentroid.quaternion.w);

            // console.log('Desktop: using saved centroid', centroidPos, centroidQuat);

            const sceneOffset = this._anchorValue(anchorRefs, 'scene_anchor_transform');
            if (sceneOffset?.position && sceneOffset?.quaternion) {
                const localOff = new Vector3(sceneOffset.position.x, sceneOffset.position.y, sceneOffset.position.z);
                const localQuatOff = new Quaternion(sceneOffset.quaternion.x, sceneOffset.quaternion.y, sceneOffset.quaternion.z, sceneOffset.quaternion.w);

                const worldPos = localOff.applyQuaternion(centroidQuat.clone()).add(centroidPos.clone());
                const worldQuat = centroidQuat.clone().multiply(localQuatOff);

                this.sceneManager.sceneStage.position.copy(worldPos);
                this.sceneManager.sceneStage.quaternion.copy(worldQuat);
                this.refreshOcclusionClearBoxes();

                if (this.desktop && this.desktop.controls) {
                    this.desktop.controls.target.copy(worldPos);
                    this.desktop.controls.update();
                }

                console.log('Desktop: restored scene from centroid-relative offset', worldPos);
            }

            const panelOffset = this._anchorValue(anchorRefs, 'control_panel_anchor_transform');
            if (panelOffset?.position && panelOffset?.quaternion) {
                const localOff = new Vector3(panelOffset.position.x, panelOffset.position.y, panelOffset.position.z);
                const localQuatOff = new Quaternion(panelOffset.quaternion.x, panelOffset.quaternion.y, panelOffset.quaternion.z, panelOffset.quaternion.w);

                const worldPos = localOff.applyQuaternion(centroidQuat.clone()).add(centroidPos.clone());
                const worldQuat = centroidQuat.clone().multiply(localQuatOff);

                if (this.vrControlPanel) {
                    this.vrControlPanel.getPanel().position.copy(worldPos);
                    this.vrControlPanel.getPanel().quaternion.copy(worldQuat);
                    console.log('Desktop: restored panel from centroid-relative offset', worldPos);
                }
            }
        }).catch((err) => {
            console.error('Desktop: failed to restore from server:', err);
        });
    }

    // ── RATK event handlers ─────────────────────────────────────────────

    _handlePlaneAdded(plane) {
        console.log('new plane added');
        const mesh = plane.planeMesh;
        mesh.material = new MeshBasicMaterial({
            wireframe: true,
            color: Math.random() * 0xffffff,
        });
        mesh.visible = this.roomMeshVisible;
    }

    _handleMeshAdded(mesh) {
        if (!mesh?.meshMesh) return;
        if (this.roomMeshVisible) {
            this._ensureMeshPresentation(mesh);
        }
        mesh.meshMesh.visible = this.roomMeshVisible;
        const semanticLabel = mesh.userData.semanticLabelMesh;
        if (semanticLabel) {
            semanticLabel.visible = this.roomMeshVisible;
        }
    }

    _ensureMeshPresentation(mesh) {
        if (!mesh?.meshMesh) return;
        const meshMesh = mesh.meshMesh;
        if (!this._meshPresentationInitialized.has(mesh)) {
            meshMesh.material = new MeshBasicMaterial({
                wireframe: true,
                color: Math.random() * 0xffffff,
            });
            meshMesh.geometry.computeBoundingBox();

            const semanticLabel = new Text();
            meshMesh.add(semanticLabel);
            semanticLabel.text = mesh.semanticLabel;
            semanticLabel.anchorX = 'center';
            semanticLabel.anchorY = 'bottom';
            semanticLabel.fontSize = 0.1;
            semanticLabel.color = 0x000000;
            semanticLabel.sync();
            semanticLabel.position.y = meshMesh.geometry.boundingBox.max.y;
            mesh.userData.semanticLabelMesh = semanticLabel;
            this._meshPresentationInitialized.add(mesh);
        }
    }

    _syncRoomMeshPresentation(visible) {
        if (!this.ratk?.meshes) return;
        const nextVisible = Boolean(visible);
        this.ratk.meshes.forEach((mesh) => {
            if (nextVisible) {
                this._ensureMeshPresentation(mesh);
            }
            if (mesh?.meshMesh) {
                mesh.meshMesh.visible = nextVisible;
            }
            const semanticLabel = mesh?.userData?.semanticLabelMesh;
            if (semanticLabel) {
                semanticLabel.visible = nextVisible;
            }
        });
    }

    // ── Render loop ─────────────────────────────────────────────────────

    _animate() {
        this.renderer.setAnimationLoop(this._render.bind(this));
    }

    _render(time, frame) {
        if (this.controls && this.controls.enabled) {
            this.controls.update();
        }

        // Depth occlusion: upload sensor depth each frame, then hook the pre-pass
        // into scene.onBeforeRender so it fires AFTER Three.js has bound its XR
        // render target (WebGLMultiviewRenderTarget) but BEFORE any draw calls.
        // If called before renderer.render() the XR framebuffer isn't bound yet.
        if (frame && this._depthOcclusion) {
            const refSpace = this.renderer.xr.getReferenceSpace();
            if (refSpace) {
                this._depthOcclusion.update(frame, refSpace);
            }
        }

        // Install/remove pre-pass hook on the scene.
        // Default path is shader-only occlusion; pre-pass is opt-in because on
        // some runtimes it can write mismatched depth and cap occlusion range.
        if (this._depthOcclusion && this._depthOcclusion.isPrePassEnabled()) {
            const occ = this._depthOcclusion;
            // Default to clearing depth each frame; if pre-pass writes valid
            // sensor depth this frame, keep it by disabling the depth clear.
            this.renderer.autoClearDepth = true;
            this.scene.onBeforeRender = () => {
                const ran = occ.renderPrePass();
                this.renderer.autoClearDepth = !ran;
            };
        } else {
            this.scene.onBeforeRender = () => {};
            this.renderer.autoClearDepth = true;
        }

        try {
            this.ratk.update();
            this._updateSemanticLabels();
            this.renderer.render(this.scene, this.camera);
        } catch (error) {
            console.error('Error during render loop:', error);
        } finally {
            // Always restore autoClearDepth so non-XR frames behave normally.
            this.renderer.autoClearDepth = true;
        }

        // Update FPS counter only while the panel is visible
        if (
            this.vrControlPanel
            && typeof this.vrControlPanel.updateFpsCounter === 'function'
            && typeof this.vrControlPanel.isVisible === 'function'
            && this.vrControlPanel.isVisible()
        ) {
            this.vrControlPanel.updateFpsCounter();
        }

        // Debug depth overlay AFTER renderer.render() — raw GL calls and
        // resetState() here cannot corrupt the submitted frame.
        if (frame && this._depthOverlay) {
            const refSpace = this.renderer.xr.getReferenceSpace();
            if (refSpace) this._depthOverlay.update(frame, refSpace);
        }

        // Pre-pass uses raw WebGL calls before scene rendering. Sync Three.js
        // renderer state cache at end-of-frame (safe point) so next frame
        // starts from a clean state, matching the stabilization observed when
        // depth overlay is enabled.
        if (this._depthOcclusion && this._depthOcclusion.isPrePassEnabled()) {
            this.renderer.resetState();
        }

        if (this.controllerManager) {
            this.controllerManager.handlePendingAnchors(this._buildAnchorMarker.bind(this));
            this.controllerManager.update();
        }
    }

    _buildAnchorMarker(anchor, isRecovered) {
        const geometry = new BoxGeometry(0.05, 0.05, 0.05);
        const material = new MeshBasicMaterial({
            color: isRecovered ? 0xff0000 : 0x00ff00,
        });
        const cube = new Mesh(geometry, material);
        anchor.add(cube);
        console.log(
            `anchor created (id: ${anchor.anchorID}, isPersistent: ${anchor.isPersistent}, isRecovered: ${isRecovered})`,
        );
    }

    _updateSemanticLabels() {
        this.ratk.meshes.forEach((mesh) => {
            const semanticLabel = mesh.userData.semanticLabelMesh;
            if (!semanticLabel) {
                return;
            }
            if (mesh.meshMesh?.visible === false || semanticLabel.visible === false) {
                return;
            }
            if (semanticLabel) {
                semanticLabel.lookAt(this.camera.position);
            }
        });
    }

    _onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
}