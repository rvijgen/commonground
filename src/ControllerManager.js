import {
    BufferGeometry,
    Line,
    Mesh,
    MeshBasicMaterial,
    SphereGeometry,
    Vector3,
    Quaternion,
    Raycaster,
} from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';

const RIGHT_MENU_BUTTON_INDICES = [3, 4, 5];
const RIGHT_OVERLAY_BUTTON_INDEX = 5; // Additional button for overlay toggle

const XR_MODEL_WARN_SUPPRESSED_TOKENS = [
    'Could not find menu_pressed_min in the model',
];

let xrModelWarnFilterInstalled = false;

function installXrModelWarnFilter() {
    if (xrModelWarnFilterInstalled) return;
    const originalWarn = console.warn.bind(console);
    console.warn = (...args) => {
        const firstArg = String(args?.[0] ?? '');
        const shouldSuppress = XR_MODEL_WARN_SUPPRESSED_TOKENS.some((token) => firstArg.includes(token));
        if (shouldSuppress) return;
        originalWarn(...args);
    };
    xrModelWarnFilterInstalled = true;
}

export class ControllerManager {
    constructor(renderer, scene, ratk, vrControlPanel, sceneManager = null, anchorsEndpoint = '/api/anchors', deviceId = null, commonGround = null) {
        installXrModelWarnFilter();

        this.renderer = renderer;
        this.scene = scene;
        this.ratk = ratk;
        this.vrControlPanel = vrControlPanel;
        this.sceneManager = sceneManager;
        this.anchorsEndpoint = anchorsEndpoint || '/api/anchors';
        const parsedDeviceId = Number.parseInt(String(deviceId), 10);
        this.deviceId = Number.isInteger(parsedDeviceId) ? parsedDeviceId : null;
        this.commonGround = commonGround;
        
        this.leftController = null;
        this.rightController = null;
        this.rightInputSource = null;
        this.leftBeamLine = null;
        this.rightBeamLine = null;
        this._leftBeamLength = 1.0;
        this._rightBeamLength = 1.0;
        this.leftMenuButtonWasPressed = false;
        this.rightMenuButtonWasPressed = false;
        this.rightOverlayButtonWasPressed = false;
        this.pendingAnchorQueue = [];
        this.pendingAnchorCreateInFlight = false;
        this.centerCube = null;
        
        // Create raycaster for scene object detection
        this.raycaster = new Raycaster();

    // Anchor dragging state
    this.anchorIsGrabbed = false;
    this.anchorGrabController = null;
    this.anchorGrabbed = null;
    this.anchorGrabOffset = new Vector3();
    this.anchorInitialControllerMatrix = null;
    this.anchorInitialAnchorMatrix = null;
    this.anchorHover = null;
    this.isPointingAtPanel = null;
    this._beamDefaultLength = 1.0;
        this._leftBeamLength = this._beamDefaultLength;
        this._rightBeamLength = this._beamDefaultLength;
        
        this.setupControllers();
    }

    _anchorKey(id) {
        return this.deviceId != null ? `device_${this.deviceId}_${id}` : id;
    }

    _anchorsRequestUrl() {
        if (this.deviceId == null) return this.anchorsEndpoint;
        const separator = this.anchorsEndpoint.includes('?') ? '&' : '?';
        return `${this.anchorsEndpoint}${separator}device=${encodeURIComponent(this.deviceId)}`;
    }

    _anchorValue(anchorRefs, id) {
        if (!anchorRefs || typeof anchorRefs !== 'object') return null;
        const namespaced = anchorRefs[this._anchorKey(id)];
        if (namespaced !== undefined) return namespaced;
        return anchorRefs[id] ?? null;
    }

    /**
     * Sets up the XR controllers and their event listeners.
     */
    setupControllers() {
        // Left controller (controller 0)
        this.leftController = this.renderer.xr.getController(0);
        this.leftController.addEventListener('connected', this.handleLeftControllerConnected.bind(this));
        this.leftController.addEventListener('disconnected', this.handleLeftControllerDisconnected.bind(this));
        this.scene.add(this.leftController);

        // Right controller (controller 1) - for control panel
        this.rightController = this.renderer.xr.getController(1);
        this.rightController.addEventListener('connected', this.handleRightControllerConnected.bind(this));
        this.rightController.addEventListener('selectstart', this.handleRightSelectStart.bind(this));
        this.rightController.addEventListener('selectend', this.handleRightSelectEnd.bind(this));
        this.rightController.addEventListener('squeezestart', this.handleRightSqueezeStart.bind(this));
        this.rightController.addEventListener('squeezeend', this.handleRightSqueezeEnd.bind(this));
        this.scene.add(this.rightController);

        // Add lines to both controllers
        const geometry = new BufferGeometry().setFromPoints([
            new Vector3(0, 0, 0),
            new Vector3(0, 0, -1),
        ]);
        
        const leftLine = new Line(geometry);
        leftLine.userData.isControllerBeam = true;
        this.leftController.add(leftLine);
        this.leftBeamLine = leftLine;
        
        const rightLine = new Line(geometry);
        rightLine.userData.isControllerBeam = true;
        this.rightController.add(rightLine);
        this.rightBeamLine = rightLine;
    }

    setBeamLengthForController(controller, distance) {
        const safeDistance = Number.isFinite(distance)
            ? Math.max(0.01, distance)
            : this._beamDefaultLength;
        if (controller === this.leftController) {
            this._leftBeamLength = safeDistance;
            return;
        }
        if (controller === this.rightController) {
            this._rightBeamLength = safeDistance;
        }
    }

    setBeamLengthForHandedness(handedness, distance) {
        const safeDistance = Number.isFinite(distance)
            ? Math.max(0.01, distance)
            : this._beamDefaultLength;
        if (handedness === 'left') {
            this._leftBeamLength = safeDistance;
            return;
        }
        if (handedness === 'right') {
            this._rightBeamLength = safeDistance;
        }
    }

    resetBeamLengthForController(controller) {
        this.setBeamLengthForController(controller, this._beamDefaultLength);
    }

    resetBeamLengthForHandedness(handedness) {
        this.setBeamLengthForHandedness(handedness, this._beamDefaultLength);
    }

    _applyBeamLengths() {
        if (this.leftBeamLine) {
            this.leftBeamLine.scale.z = this._leftBeamLength;
        }
        if (this.rightBeamLine) {
            this.rightBeamLine.scale.z = this._rightBeamLength;
        }
    }

    /**
     * Sets up the controller grips after XR session has started.
     * 
     * Work around a controller profile/model race in XRControllerModelFactory
     * (assetUrl can be null during rapid connect/disconnect on some runtimes).
     */
    setupControllerGrips() {
        try {
            const controllerModelFactory = new XRControllerModelFactory();
            
            // Left controller grip
            const leftControllerGrip = this.renderer.xr.getControllerGrip(0);
            leftControllerGrip.add(
                controllerModelFactory.createControllerModel(leftControllerGrip),
            );
            this.scene.add(leftControllerGrip);
            
            // Right controller grip
            const rightControllerGrip = this.renderer.xr.getControllerGrip(1);
            rightControllerGrip.add(
                controllerModelFactory.createControllerModel(rightControllerGrip),
            );
            this.scene.add(rightControllerGrip);
        } catch (error) {
            console.warn('Failed to set up controller grips:', error.message);
            // Silently fail - controller grips are optional; beams will still work
        }
    }

    /**
     * LEFT CONTROLLER HANDLERS
     */

    /**
     * Handles left controller connection events.
     */
    handleLeftControllerConnected(event) {
        void event;
    }

    /**
     * Handles left controller disconnection events.
     */
    handleLeftControllerDisconnected() {
    }

    /**
     * RIGHT CONTROLLER HANDLERS (for control panel)
     */

    /**
     * Handles right controller connection events.
     */
    handleRightControllerConnected(event) {
        this.rightInputSource = event?.data || null;
        console.log('Right controller connected');
    }

    handleRightControllerDisconnected() {
        this.rightInputSource = null;
        this.rightMenuButtonWasPressed = false;
    }

    /**
     * Check if controller is pointing at scene objects (like the cube)
     */
    isPointingAtSceneObjects(controller) {
        if (!this.sceneManager || !controller) return false;
        
        // Set up raycaster from controller
        const tempMatrix = controller.matrixWorld;
        const origin = new Vector3().setFromMatrixPosition(tempMatrix);
        const direction = new Vector3(0, 0, -1).transformDirection(tempMatrix);
        this.raycaster.set(origin, direction);
        
        // Only raycast against the red cube (grab point)
        const redCube = this.sceneManager.sceneStage.getObjectByName('RegularRedCube');
        if (!redCube) return false;
        const intersects = this.raycaster.intersectObject(redCube, false);
        
        if (intersects.length > 0) {
            console.log('Pointing at scene object:', intersects[0].object.name || 'unnamed object');
            return true;
        }
        
        return false;
    }

    /**
     * Handles 'selectstart' event for the right controller (trigger - context-aware interaction).
     */
    handleRightSelectStart() {
        console.log('Right controller trigger pressed');
        // First check if we're pointing at the VR control panel
        if (this.vrControlPanel && this.vrControlPanel.getPanel().visible) {
            const panelInteractionConsumed = this.vrControlPanel.handleControllerSelect(this.rightController);
            this.isPointingAtPanel = panelInteractionConsumed || this.vrControlPanel.isGrabbed;
            if (this.isPointingAtPanel) {
                if (this.vrControlPanel.isGrabbed) {
                    console.log('Started grabbing panel with trigger');
                } else {
                    console.log('Interacted with panel button');
                }
                return;
            }
        }

        

        
        const isPointingAtSceneObject = this.isPointingAtSceneObjects(this.rightController);
        if (isPointingAtSceneObject && this.sceneManager && !this.sceneManager.isSceneGrabbed()) {
            this.sceneManager.startGrab(this.rightController);
            return;
        }

        console.log('Not pointing at any scene objects or anchors - no action');
    }

    /**
     * Handles 'selectend' event for the right controller (trigger release)
     */
    handleRightSelectEnd() {
        // Release panel grab
        if (this.vrControlPanel && this.vrControlPanel.getPanel().visible) {
            this.vrControlPanel.handleControllerRelease(this.rightController);
        }
        // Release scene grab
        if (this.sceneManager && !this.vrControlPanel?.isGrabbed) {
            this.sceneManager.stopGrab(this.ratk);
        }
        this.isPointingAtPanel = false;
        
    }

    /**
     * Handles 'squeezestart' event for the right controller (grip - toggle panel visibility).
     */
    handleRightSqueezeStart() {
        // Reserved for app-level squeeze interactions.
        console.log('Right controller squeeze start');
    }

    /**
     * Handles 'squeezeend' event for the right controller (not used anymore).
     */
    handleRightSqueezeEnd() {
        //console.log('Right controller squeeze end');
    }

    _isAdminModeEnabled() {
        return !!this.commonGround?.adminModeEnabled;
    }

    _getGamepadButtonsForHandedness(handedness) {
        const session = this.renderer?.xr?.getSession?.();
        const inputSource =
            handedness === 'left'
                ? this.leftController?.userData?.inputSource ||
                    Array.from(session?.inputSources || []).find(
                        (source) => source && source.handedness === 'left' && source.gamepad,
                    ) || null
                : this.rightInputSource || this.rightController?.userData?.inputSource ||
                    Array.from(session?.inputSources || []).find(
                        (source) => source && source.handedness === 'right' && source.gamepad,
                    ) || null;

        return inputSource?.gamepad?.buttons || null;
    }

    _updateRightMenuButtons() {
        const adminEnabled = this._isAdminModeEnabled();

        if (!adminEnabled) {
            this.leftMenuButtonWasPressed = false;
            this.rightMenuButtonWasPressed = false;
            return;
        }

        for (const handedness of ['left', 'right']) {
            const buttons = this._getGamepadButtonsForHandedness(handedness);
            if (!buttons) continue;

            const pressedNow = RIGHT_MENU_BUTTON_INDICES.some((index) => !!buttons[index]?.pressed);
            const previousPress = handedness === 'left' ? this.leftMenuButtonWasPressed : this.rightMenuButtonWasPressed;
            const pressedEdge = pressedNow && !previousPress;

            if (pressedEdge && this.vrControlPanel) {
                this.vrControlPanel.toggle();
            }

            if (handedness === 'left') {
                this.leftMenuButtonWasPressed = pressedNow;
            } else {
                this.rightMenuButtonWasPressed = pressedNow;
            }
        }
    }

    _updateRightOverlayButton() {
        if (!this._isAdminModeEnabled()) {
            this.rightOverlayButtonWasPressed = false;
            return;
        }

        let inputSource = this.rightInputSource || this.rightController?.userData?.inputSource || null;
        if (!inputSource) {
            const session = this.renderer?.xr?.getSession?.();
            if (session?.inputSources) {
                inputSource = Array.from(session.inputSources).find(
                    (source) => source && source.handedness === 'right' && source.gamepad,
                ) || null;
            }
        }

        const buttons = inputSource?.gamepad?.buttons;
        if (!buttons) return;
        if (buttons.length <= RIGHT_OVERLAY_BUTTON_INDEX) return;

        const pressedNow = !!buttons[RIGHT_OVERLAY_BUTTON_INDEX]?.pressed;
        const pressedEdge = pressedNow && !this.rightOverlayButtonWasPressed;

        if (pressedEdge) {
            if (this.commonGround) {
                this.commonGround.toggleDepthOverlay();
            }
        }

        this.rightOverlayButtonWasPressed = pressedNow;
    }

    /**
     * Handles the creation of anchors based on pending data.
     */
    async getAnchorReferencesFromServer() {
        try {
            const response = await fetch(this._anchorsRequestUrl());
            if (!response.ok) {
                throw new Error(`Anchor fetch failed: ${response.status}`);
            }
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

    async saveAnchorTransformToServer(id, position, quaternion) {
        try {
            const transformKey = `${id}_transform`;
            const transformValue = {
                position: { x: position.x, y: position.y, z: position.z },
                quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
            };
            const payload = {
                [transformKey]: transformValue,
            };

            const response = await fetch(this._anchorsRequestUrl(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`Anchor transform save failed: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to save anchor transform to server:', error);
            throw error;
        }
    }

    async saveAnchorReferenceToServer(id, anchorID) {
        try {
            const payload = { [id]: anchorID };
            const response = await fetch(this._anchorsRequestUrl(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`Anchor save failed: ${response.status}`);
            }
        } catch (error) {
            console.error('Failed to save anchor reference to server:', error);
            throw error;
        }
    }

    async removePreviousAnchorValue(id) {
        const allAnchors = Array.from(this.ratk.anchors);
        const anchorRefs = await this.getAnchorReferencesFromServer();
        const anchorUUID = this._anchorValue(anchorRefs, id);

        if (!anchorUUID) {
            return;
        }

        for (const anchor of allAnchors) {
            if (anchor.anchorID === anchorUUID) {
                await this.ratk.deleteAnchor(anchor);
                break;
            }
        }
    }

    async createOrReplacePersistentAnchor(anchorData, buildAnchorMarker = null) {
        // createAnchor must be started synchronously (before any await) so that
        // createAnchorFromTransform captures xrManager.getFrame() while the XR
        // frame is still active. Awaiting anything first lets Three.js clear
        // xrFrame = null before we reach this call.
        const anchorPromise = this.ratk.createAnchor(
            anchorData.position,
            anchorData.quaternion,
            true,
        );

        // Deletion and other async work can safely happen after frame capture.
        if (anchorData.id) {
            await this.removePreviousAnchorValue(anchorData.id);
        }

        const anchor = await anchorPromise;

        if (anchorData.id) {
            await this.saveAnchorReferenceToServer(anchorData.id, anchor.anchorID);
        } else if (buildAnchorMarker) {
            buildAnchorMarker(anchor, false);
        }

        return anchor;
    }

    handlePendingAnchors(buildAnchorMarker) {
        if (this.pendingAnchorCreateInFlight || this.pendingAnchorQueue.length === 0) {
            return;
        }

        const anchorData = this.pendingAnchorQueue.shift();
        this.pendingAnchorCreateInFlight = true;

        (async () => {
            try {
                console.log('Handling pending anchor data:', anchorData);

                console.log(`Creating anchor. Current count: ${this.ratk.anchors.size}`);
                console.log('Pending anchor data:', anchorData);

                const anchor = await this.createOrReplacePersistentAnchor(anchorData, buildAnchorMarker);

                console.log('Anchor created:', anchor);
                console.log(`Anchor created successfully. New count: ${this.ratk.anchors.size}`);
            } catch (error) {
                console.error('Failed to create anchor:', error);

                if (error.message.includes('Maximum number of anchors reached')) {
                    console.error('Anchor limit reached. Try these steps:');
                    console.error('1. Use "Clear Anchors" to remove current anchors');
                    console.error('2. Use "Clear Persistent Data" to remove stored data');
                    console.error('3. Restart the XR session');
                    console.error(`Current visible anchors: ${this.ratk.anchors.size}`);
                }
            } finally {
                this.pendingAnchorCreateInFlight = false;
            }
        })();
    }

    /**
     * Update control panel interactions
     */
    updateControlPanel() {
        if (this.vrControlPanel && this.rightController && this.vrControlPanel.getPanel().visible) {
            this.vrControlPanel.checkIntersections(this.rightController);
            // Note: updateGrab() is now called in the main update() method
        }
    }

    /**
     * Get the left controller instance
     */
    getLeftController() {
        return this.leftController;
    }

    /**
     * Get the right controller instance
     */
    getRightController() {
        return this.rightController;
    }
    saveMenuPosition(){
        if (!this.centerCube) {
            console.warn('Cannot save panel position: centerCube not available');
            return;
        }
        const centroidWorldPos = new Vector3();
        const centroidWorldQuat = new Quaternion();
        this.centerCube.getWorldPosition(centroidWorldPos);
        this.centerCube.getWorldQuaternion(centroidWorldQuat);

        const panelWorldPos = new Vector3();
        const panelWorldQuat = new Quaternion();
        this.vrControlPanel.getPanel().getWorldPosition(panelWorldPos);
        this.vrControlPanel.getPanel().getWorldQuaternion(panelWorldQuat);

        // Compute offset in centroid's local frame (rotation-invariant)
        const worldOffset = panelWorldPos.sub(centroidWorldPos);
        const centroidInvQuat = centroidWorldQuat.clone().invert();
        const localOffset = worldOffset.applyQuaternion(centroidInvQuat);
        const localQuatOffset = centroidInvQuat.multiply(panelWorldQuat);

        return this.saveAnchorTransformToServer('control_panel_anchor', localOffset, localQuatOffset);
    }
    saveScenePosition() {
        if (!this.centerCube) {
            console.warn('Cannot save scene position: centerCube not available');
            return;
        }
        const centroidWorldPos = new Vector3();
        const centroidWorldQuat = new Quaternion();
        this.centerCube.getWorldPosition(centroidWorldPos);
        this.centerCube.getWorldQuaternion(centroidWorldQuat);

        const stageWorldPos = new Vector3();
        const stageWorldQuat = new Quaternion();
        this.sceneManager.sceneStage.getWorldPosition(stageWorldPos);
        this.sceneManager.sceneStage.getWorldQuaternion(stageWorldQuat);

        // Compute offset in centroid's local frame (rotation-invariant)
        const worldOffset = stageWorldPos.sub(centroidWorldPos);
        const centroidInvQuat = centroidWorldQuat.clone().invert();
        const localOffset = worldOffset.applyQuaternion(centroidInvQuat);
        const localQuatOffset = centroidInvQuat.multiply(stageWorldQuat);

        return this.saveAnchorTransformToServer('scene_anchor', localOffset, localQuatOffset);
    }

    async saveSceneAndPanelAnchors() {
        if (!this.vrControlPanel || !this.sceneManager) {
            console.warn('Cannot save: scene manager or control panel unavailable');
            return { success: false, message: 'Scene manager or control panel unavailable' };
        }
        if (!this.centerCube) {
            console.warn('Cannot save: centerCube not available yet (wait for planes)');
            return { success: false, message: 'Planes not detected yet' };
        }

        try {
            await this.saveMenuPosition();
            await this.saveScenePosition();

            // Save the centroid itself so desktop mode can use the exact same reference frame
            const centroidWorldPos = new Vector3();
            const centroidWorldQuat = new Quaternion();
            this.centerCube.getWorldPosition(centroidWorldPos);
            this.centerCube.getWorldQuaternion(centroidWorldQuat);
            await this.saveAnchorTransformToServer('centroid', centroidWorldPos, centroidWorldQuat);

            console.log('Scene + control panel centroid-relative offsets saved');
            return { success: true, message: 'Centroid-relative offsets saved' };
        } catch (err) {
            console.error('Failed to save anchors:', err);
            return { success: false, message: 'Failed to save: ' + err.message };
        }
    }

    /**
     * Update method to be called in the render loop
     */
    update() {
        this._updateRightMenuButtons();
        this._updateRightOverlayButton();
        this._applyBeamLengths();

        // Update scene grab movement
        if (this.sceneManager) {
            this.sceneManager.updateGrab();
        }
        // Update VR control panel grab movement
        if (this.vrControlPanel) {
            this.vrControlPanel.updateGrab();
        }
        // Anchor hover feedback
        const prevHover = this.anchorHover;
        this.anchorHover = this.getIntersectedAnchor(this.rightController);
        if (prevHover && prevHover !== this.anchorHover && prevHover.children[0] && prevHover.children[0].material) {
            // Restore color if no longer hovered or grabbed
            if (!this.anchorIsGrabbed || prevHover !== this.anchorGrabbed) {
                prevHover.children[0].material.color.setHex(0x0000ff); // blue default
            }
        }
        if (this.anchorHover && this.anchorHover.children[0] && this.anchorHover.children[0].material) {
            if (!this.anchorIsGrabbed || this.anchorHover !== this.anchorGrabbed) {
                this.anchorHover.children[0].material.color.setHex(0xff8800); // orange on hover
            }
        }
        // Update anchor dragging (grab logic similar to panel/scene)
        if (this.anchorIsGrabbed && this.anchorGrabController && this.anchorGrabbed) {
            const currentControllerMatrix = this.anchorGrabController.matrixWorld.clone();
            const deltaMatrix = currentControllerMatrix.clone().multiply(this.anchorInitialControllerMatrix.clone().invert());
            const newAnchorMatrix = deltaMatrix.clone().multiply(this.anchorInitialAnchorMatrix);
            // Convert newAnchorMatrix to local space of anchor's parent
            const parent = this.anchorGrabbed.parent;
            let prevPos = this.anchorGrabbed.position.clone();
            if (parent) {
                const parentInv = parent.matrixWorld.clone().invert();
                const localMatrix = parentInv.multiply(newAnchorMatrix);
                this.anchorGrabbed.position.setFromMatrixPosition(localMatrix);
                this.anchorGrabbed.quaternion.setFromRotationMatrix(localMatrix);
            } else {
                this.anchorGrabbed.position.setFromMatrixPosition(newAnchorMatrix);
                this.anchorGrabbed.quaternion.setFromRotationMatrix(newAnchorMatrix);
            }
            // Ensure transform is applied
            this.anchorGrabbed.updateMatrixWorld(true);
            // Debug log
            if (!this.anchorGrabbed.position.equals(prevPos)) {
                console.log('[Anchor Drag] Anchor', this.anchorGrabbed.anchorID, 'moved to', this.anchorGrabbed.position.toArray(), 'parent:', this.anchorGrabbed.parent ? this.anchorGrabbed.parent.name : 'none');
            } else {
                console.log('[Anchor Drag] Anchor', this.anchorGrabbed.anchorID, 'DID NOT MOVE. Position:', this.anchorGrabbed.position.toArray(), 'parent:', this.anchorGrabbed.parent ? this.anchorGrabbed.parent.name : 'none');
            }
        }
    }
    /**
     * Returns the anchor intersected by the controller's ray, if any
     */
    getIntersectedAnchor(controller) {
        if (!this.ratk || !this.ratk.anchors || !controller) return null;
        // Set up raycaster from controller
        const tempMatrix = controller.matrixWorld;
        const origin = new Vector3().setFromMatrixPosition(tempMatrix);
        const direction = new Vector3(0, 0, -1).transformDirection(tempMatrix);
        this.raycaster.set(origin, direction);
        // Intersect with anchor meshes
        const anchors = Array.from(this.ratk.anchors);
        const anchorMeshes = anchors.map(a => a.children[0]).filter(Boolean);
        const intersects = this.raycaster.intersectObjects(anchorMeshes, false);
        if (intersects.length > 0) {
            // Find the anchor that owns the mesh
            const mesh = intersects[0].object;
            return anchors.find(a => a.children[0] === mesh) || null;
        }
        return null;
    }
}