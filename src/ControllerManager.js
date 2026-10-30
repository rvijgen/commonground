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
        this.centerCube = null;

        // Create raycaster for scene object detection
        this.raycaster = new Raycaster();

    this.isPointingAtPanel = null;
    this._beamDefaultLength = 1.0;
        this._leftBeamLength = this._beamDefaultLength;
        this._rightBeamLength = this._beamDefaultLength;
        
        this.setupControllers();
    }

    _anchorsRequestUrl() {
        if (this.deviceId == null) return this.anchorsEndpoint;
        const separator = this.anchorsEndpoint.includes('?') ? '&' : '?';
        return `${this.anchorsEndpoint}${separator}device=${encodeURIComponent(this.deviceId)}`;
    }

    /**
     * Sets up the XR controllers and their event listeners.
     *
     * WebXR hands out controller indices in connection order, so index 0 is
     * NOT necessarily the left controller and index 1 is NOT necessarily the
     * right one (e.g. when only one controller is awake it always lands on
     * index 0). Roles are therefore resolved from inputSource.handedness in
     * _handleControllerConnected, and the select/squeeze handlers ignore
     * events from controllers that are known to be left-handed.
     */
    setupControllers() {
        this.leftController = this.renderer.xr.getController(0);
        this.rightController = this.renderer.xr.getController(1);

        for (const controller of [this.leftController, this.rightController]) {
            controller.addEventListener('connected', (event) => this._handleControllerConnected(controller, event));
            controller.addEventListener('disconnected', () => this._handleControllerDisconnected(controller));
            controller.addEventListener('selectstart', this.handleRightSelectStart.bind(this));
            controller.addEventListener('selectend', this.handleRightSelectEnd.bind(this));
            controller.addEventListener('squeezestart', this.handleRightSqueezeStart.bind(this));
            controller.addEventListener('squeezeend', this.handleRightSqueezeEnd.bind(this));
            this.scene.add(controller);
        }

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

    /**
     * Tracks the input source on the controller object and remembers the
     * right-handed source for gamepad button polling.
     */
    _handleControllerConnected(controller, event) {
        const inputSource = event?.data || null;
        controller.userData.inputSource = inputSource;
        if (inputSource?.handedness === 'right') {
            this.rightInputSource = inputSource;
            console.log('Right controller connected');
        }
    }

    _handleControllerDisconnected(controller) {
        if (this.rightInputSource && controller.userData.inputSource === this.rightInputSource) {
            this.rightInputSource = null;
            this.rightMenuButtonWasPressed = false;
        }
        controller.userData.inputSource = null;
    }

    /**
     * True when the controller is the right-handed one. Controllers whose
     * input source has not been seen yet (no 'connected' event) are allowed
     * through, preserving the legacy index-based behavior.
     */
    _isRightInteractionController(controller) {
        const handedness = controller?.userData?.inputSource?.handedness;
        return !handedness || handedness === 'right';
    }

    /**
     * The controller object currently carrying the right-handed input source,
     * falling back to the index-1 object when handedness is unknown.
     */
    _getRightInteractionController() {
        for (const controller of [this.rightController, this.leftController]) {
            if (controller?.userData?.inputSource?.handedness === 'right') return controller;
        }
        return this.rightController;
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
    handleRightSelectStart(event) {
        const controller = event?.target || this._getRightInteractionController();
        if (!this._isRightInteractionController(controller)) return;
        console.log('Right controller trigger pressed');
        // First check if we're pointing at the VR control panel
        if (this.vrControlPanel && this.vrControlPanel.getPanel().visible) {
            const panelInteractionConsumed = this.vrControlPanel.handleControllerSelect(controller);
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




        const isPointingAtSceneObject = this.isPointingAtSceneObjects(controller);
        if (isPointingAtSceneObject && this.sceneManager && !this.sceneManager.isSceneGrabbed()) {
            this.sceneManager.startGrab(controller);
            return;
        }

        console.log('Not pointing at any scene objects or anchors - no action');
    }

    /**
     * Handles 'selectend' event for the right controller (trigger release)
     */
    handleRightSelectEnd(event) {
        const controller = event?.target || this._getRightInteractionController();
        if (!this._isRightInteractionController(controller)) return;
        // Release panel grab
        if (this.vrControlPanel && this.vrControlPanel.getPanel().visible) {
            this.vrControlPanel.handleControllerRelease(controller);
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
    handleRightSqueezeStart(event) {
        const controller = event?.target || this._getRightInteractionController();
        if (!this._isRightInteractionController(controller)) return;
        // Reserved for app-level squeeze interactions.
        console.log('Right controller squeeze start');
    }

    /**
     * Handles 'squeezeend' event for the right controller (not used anymore).
     */
    handleRightSqueezeEnd(event) {
        const controller = event?.target || this._getRightInteractionController();
        if (!this._isRightInteractionController(controller)) return;
        //console.log('Right controller squeeze end');
    }

    _isAdminModeEnabled() {
        return !!this.commonGround?.adminModeEnabled;
    }

    _getInputSourceForHandedness(handedness) {
        if (handedness === 'right' && this.rightInputSource) {
            return this.rightInputSource;
        }
        const fromControllers = [this.leftController, this.rightController]
            .map((controller) => controller?.userData?.inputSource)
            .find((source) => source && source.handedness === handedness && source.gamepad);
        if (fromControllers) return fromControllers;
        const session = this.renderer?.xr?.getSession?.();
        return Array.from(session?.inputSources || []).find(
            (source) => source && source.handedness === handedness && source.gamepad,
        ) || null;
    }

    _getGamepadButtonsForHandedness(handedness) {
        return this._getInputSourceForHandedness(handedness)?.gamepad?.buttons || null;
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

        const inputSource = this._getInputSourceForHandedness('right');

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

    /**
     * Update control panel interactions
     */
    updateControlPanel() {
        const controller = this._getRightInteractionController();
        if (this.vrControlPanel && controller && this.vrControlPanel.getPanel().visible) {
            this.vrControlPanel.checkIntersections(controller);
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
    }
}