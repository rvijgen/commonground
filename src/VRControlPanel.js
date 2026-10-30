import {
    BoxGeometry,
    Euler,
    Group,
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    Raycaster,
    Vector3,
    Quaternion,
    Matrix4,
} from 'three';
import { Text } from 'troika-three-text';

/**
 * Base VR Control Panel class for creating interactive UI elements in VR space
 */
export class VRControlPanel {
    constructor(options = {}) {
        this.panel = new Group();
        this.controls = [];
        this.position = options.position || new Vector3(-1, 1.5, -0.5);
        this.width = options.width || 0.8;
        this.height = options.height || 0.6;
        this.backgroundColor = options.backgroundColor || 0x333333;
        this.raycaster = new Raycaster();

        // Grab/move functionality
        this.isGrabbed = false;
        this.grabController = null;
        this.grabOffset = new Vector3();
        this.grabRotationOffset = new Quaternion();
        this.initialControllerMatrix = new Matrix4();
        this.initialPanelMatrix = new Matrix4();
        this.defaultTitleText = 'VR Controls - Grab to Move';
        this.statusRestoreTimer = null;
        this.desktopStatusNode = null;


        // FPS Counter
        this.fps = 0;
        this._lastFpsUpdate = performance.now();
        this._frameCount = 0;
        this.fpsText = null;
        this.desktopFpsNode = null;

        this.setupPanel();
        this.panel.position.copy(this.position);
    }

    /**
     * Static factory method to create and configure a VR Control Panel
     */
    static createControlPanel(scene, ratk, controllerManager, toggleRoomMeshVisibility, renderer, sceneManager, isDesktopMode = null) {
        // Use provided mode or fallback to simple detection
        let isDesktop;
        if (isDesktopMode !== null) {
            isDesktop = isDesktopMode;
            console.log('VRControlPanel using provided mode:', isDesktop ? 'desktop' : 'VR');
        } else {
            // Fallback detection (simplified)
            isDesktop = !renderer.xr.isPresenting && !renderer.xr.getSession();
            console.log('VRControlPanel using fallback detection:', isDesktop ? 'desktop' : 'VR');
        }

        const vrControlPanel = new VRControlPanel({
            position: new Vector3(0.5, 1.2, -0.8),
            width: 0.6,
            height: 0.5,
        });

        // Track the intended mode
        vrControlPanel.isDesktopMode = isDesktop;
        vrControlPanel.isInitialized = false;

        // Desktop mode gets no control panel UI — the panel is a VR scene
        // placement tool, and desktop controls live in the DesktopHud. The
        // instance still carries the callbacks used by helper/menu config.

        // Store callbacks for desktop use
        vrControlPanel.callbacks = {
            toggleRoomMeshVisibility,
            saveAnchorsToServer: () => controllerManager?.saveSceneAndPanelAnchors(),
            toggleHelpers: (visible) => {
                if (sceneManager) {
                    // Toggle planesInScene (thick blue lines + sceneCube)
                    const planesGroup = sceneManager.sceneGroup.getObjectByName('planesInScene');
                    if (planesGroup) planesGroup.visible = visible;
                    // Toggle helper objects in sceneStage
                    const helperNames = ['WireframePlane', 'RegularRedCube', 'AxesHelper', 'CeilingGrid'];
                    helperNames.forEach(name => {
                        const obj = sceneManager.sceneStage.getObjectByName(name);
                        if (obj) obj.visible = visible;
                    });
                    // Toggle axis labels (Text objects with X/Y/Z)
                    sceneManager.sceneStage.children.forEach(child => {
                        if (child.text === 'X' || child.text === 'Y' || child.text === 'Z') {
                            child.visible = visible;
                        }
                    });
                    // Toggle centerCube (lives in ratk.root, not sceneGroup)
                    const centerCube = scene.getObjectByName('centerCube');
                    if (centerCube) centerCube.visible = visible;
                }
            },
            alignToFloor: () => {
                if (!ratk || !sceneManager) return;
                // Find the best floor plane: prefer semanticLabel 'floor', else largest horizontal plane
                let floorPlane = null;
                let largestArea = 0;
                ratk._planes.forEach((plane) => {
                    if (plane.orientation === 'horizontal' || plane.semanticLabel === 'floor') {
                        const area = (plane.boundingRectangleWidth || 0) * (plane.boundingRectangleHeight || 0);
                        if (plane.semanticLabel === 'floor') {
                            // Floor-labelled planes always win if larger than current floor pick
                            if (!floorPlane || floorPlane.semanticLabel !== 'floor' || area > largestArea) {
                                floorPlane = plane;
                                largestArea = area;
                            }
                        } else if (!floorPlane || floorPlane.semanticLabel !== 'floor') {
                            if (area > largestArea) {
                                floorPlane = plane;
                                largestArea = area;
                            }
                        }
                    }
                });
                if (!floorPlane) {
                    console.warn('Align to floor: no horizontal/floor plane found');
                    return;
                }
                // Get floor world Y and orientation
                const floorWorldPos = new Vector3();
                floorPlane.planeMesh.getWorldPosition(floorWorldPos);
                // Strip pitch/roll from sceneStage, keep yaw only
                const euler = new Euler().setFromQuaternion(sceneManager.sceneStage.quaternion, 'YXZ');
                euler.x = 0;
                euler.z = 0;
                sceneManager.sceneStage.quaternion.setFromEuler(euler);
                // Set Y to floor height (in sceneGroup local space)
                sceneManager.sceneGroup.updateMatrixWorld(true);
                const localFloor = sceneManager.sceneGroup.worldToLocal(floorWorldPos.clone());
                sceneManager.sceneStage.position.y = localFloor.y;
                console.log('Aligned sceneStage to floor at y=' + localFloor.y.toFixed(3));
            },
            exportRoomMesh: async () => {
                if (window.exportRoomMeshToServer) {
                    try {
                        const result = await window.exportRoomMeshToServer();
                        return result;
                    } catch (error) {
                        console.error('Export failed:', error);
                        return { error: error.message };
                    }
                } else {
                    console.log('Room mesh export not available');
                    return Promise.resolve({ error: 'Export function not available' });
                }
            },
            debugScene: () => {
                if (sceneManager) {
                    console.log('=== SCENE DEBUG INFO ===');
                    console.log(sceneManager.getSceneStats());
                }
            }
        };

        if (!isDesktop) {
            // VR mode - create 3D panel
            vrControlPanel.addToggle('Room Mesh', false, (state) => {
                toggleRoomMeshVisibility(state);
                console.log('Room mesh toggled:', state);
            });

            vrControlPanel.addToggle('Show Helpers', false, (state) => {
                vrControlPanel.callbacks.toggleHelpers(state);
                console.log('Helpers visibility toggled:', state);
            });

            vrControlPanel.addButton('Export Mesh', async () => {
                try {
                    console.log('Starting room mesh export...');
                    const result = await vrControlPanel.callbacks.exportRoomMesh();
                    if (result.error) {
                        console.error('Room mesh export failed:', result.error);
                    } else {
                        console.log('Room mesh export completed:', result);
                    }
                } catch (error) {
                    console.error('Room mesh export failed:', error);
                }
            });

            vrControlPanel.addButton('Save Anchors', async () => {
                console.log('Saving scene/control-panel anchors to server...');
                vrControlPanel.showStatusMessage('Saving anchors...', 'info');
                const result = await vrControlPanel.callbacks.saveAnchorsToServer?.();
                if (result?.success) {
                    vrControlPanel.showStatusMessage('Anchors saved', 'success');
                } else {
                    vrControlPanel.showStatusMessage(result?.message || 'Failed to save anchors', 'error');
                }
            });

            vrControlPanel.addButton('Align to Floor', () => {
                vrControlPanel.callbacks.alignToFloor();
            });

            vrControlPanel.addButton('Debug Scene', () => {
                vrControlPanel.callbacks.debugScene();
            });

            sceneManager.sceneGroup.add(vrControlPanel.getPanel());
            // Force visibility to true and log the result
            vrControlPanel.panel.visible = true;
            console.log(`VR Control Panel added to scene. Initial visibility: ${vrControlPanel.panel.visible}`);
        }

        console.log('Control Panel created for', isDesktop ? 'desktop' : 'VR');
        return vrControlPanel;
    }

    /**
     * Setup desktop HTML overlay
     */
    setupDesktopOverlay() {
        this.desktopOverlay = document.createElement('div');
        this.desktopOverlay.id = 'desktop-control-panel';
        this.desktopOverlay.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            width: 250px;
            background: rgba(51, 51, 51, 0.9);
            border: 1px solid #666;
            border-radius: 8px;
            padding: 15px;
            font-family: Arial, sans-serif;
            color: white;
            z-index: 1000;
            backdrop-filter: blur(5px);
        `;

        const title = document.createElement('h3');
        title.textContent = 'Controls';
        title.style.cssText = `
            margin: 0 0 15px 0;
            font-size: 16px;
            text-align: center;
            border-bottom: 1px solid #666;
            padding-bottom: 8px;
        `;
        this.desktopOverlay.appendChild(title);

        document.body.appendChild(this.desktopOverlay);
    }

    /**
     * Create desktop toggle control
     */
    createDesktopToggle(label, initialState, callback) {
        const container = document.createElement('div');
        container.style.cssText = `
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        `;

        const labelEl = document.createElement('label');
        labelEl.textContent = label;
        labelEl.style.cssText = `
            font-size: 14px;
            cursor: pointer;
        `;

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = initialState;
        toggle.style.cssText = `
            width: 18px;
            height: 18px;
            cursor: pointer;
        `;

        toggle.addEventListener('change', (e) => {
            callback(e.target.checked);
        });

        labelEl.addEventListener('click', () => {
            toggle.checked = !toggle.checked;
            callback(toggle.checked);
        });

        container.appendChild(labelEl);
        container.appendChild(toggle);

        return container;
    }

    /**
     * Create desktop button control
     */
    createDesktopButton(label, callback) {
        const button = document.createElement('button');
        button.textContent = label;
        button.style.cssText = `
            width: 100%;
            padding: 8px 12px;
            margin-bottom: 8px;
            background: #4444ff;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background-color 0.2s;
        `;

        button.addEventListener('mouseenter', () => {
            button.style.backgroundColor = '#6666ff';
        });

        button.addEventListener('mouseleave', () => {
            button.style.backgroundColor = '#4444ff';
        });

        button.addEventListener('click', callback);

        return button;
    }

    setupPanel() {
        // Create background panel (this will be grabbable)
        const backgroundGeometry = new PlaneGeometry(this.width, this.height);
        const backgroundMaterial = new MeshBasicMaterial({
            color: this.backgroundColor,
            transparent: true,
            opacity: 0.8,
        });
        this.background = new Mesh(backgroundGeometry, backgroundMaterial);
        this.panel.add(this.background);

        // Add title bar (grabbable area)
        const titleBarGeometry = new PlaneGeometry(this.width, 0.1);
        const titleBarMaterial = new MeshBasicMaterial({
            color: 0x444444,
            transparent: true,
            opacity: 0.9,
        });
        this.titleBar = new Mesh(titleBarGeometry, titleBarMaterial);
        this.titleBar.position.set(0, this.height / 2 - 0.05, 0.001);
        this.panel.add(this.titleBar);

        // Add title
        this.title = new Text();
        this.title.text = this.defaultTitleText;
        this.title.fontSize = 0.04;
        this.title.color = 0xffffff;
        this.title.anchorX = 'center';
        this.title.anchorY = 'center';
        this.title.position.set(0, this.height / 2 - 0.05, 0.002);
        this.title.sync();
        this.panel.add(this.title);

        // Add FPS text (VR mode)
        this.fpsText = new Text();
        this.fpsText.text = 'FPS: 0';
        this.fpsText.fontSize = 0.03;
        this.fpsText.color = 0x36d399;
        this.fpsText.anchorX = 'right';
        this.fpsText.anchorY = 'top';
        this.fpsText.position.set(this.width / 2 - 0.04, this.height / 2, 0.002);
        this.fpsText.sync();
        this.panel.add(this.fpsText);
    }

    /**
     * Add a toggle button to the panel
     */
    addToggle(label, initialState = false, callback = null) {
        const yPosition = (this.height / 2 - 0.15) - (this.controls.length * 0.07);

        const toggle = new VRToggle({
            label,
            state: initialState,
            position: new Vector3(-this.width / 4, yPosition, 0.001),
            callback,
        });

        this.panel.add(toggle.group);
        this.controls.push(toggle);
        return toggle;
    }

    /**
     * Add a button to the panel
     */
    addButton(label, callback = null) {
        const yPosition = (this.height / 2 - 0.15) - (this.controls.length * 0.07);

        const button = new VRButton({
            label,
            position: new Vector3(-this.width / 4, yPosition, 0.001),
            callback,
        });

        this.panel.add(button.group);
        this.controls.push(button);
        return button;
    }

    /**
     * Check for controller intersections with controls using raycasting
     */
    checkIntersections(controller) {
        // Get controller's world position and direction
        const tempMatrix = controller.matrixWorld;
        const origin = new Vector3().setFromMatrixPosition(tempMatrix);
        const direction = new Vector3(0, 0, -1).transformDirection(tempMatrix);

        this.raycaster.set(origin, direction);

        // Check title bar for grabbing
        const titleBarIntersects = this.raycaster.intersectObject(this.titleBar);
        if (titleBarIntersects.length > 0) {
            this.titleBar.material.opacity = 1.0;
            this.title.text = 'VR Controls - Grab to Move (Hover)';
            this.title.sync();
        } else {
            this.titleBar.material.opacity = 0.9;
            if (!this.isGrabbed) {
                this.title.text = this.defaultTitleText;
                this.title.sync();
            }
        }

        // Check controls only if not grabbed
        if (!this.isGrabbed) {
            this.controls.forEach(control => {
                control.checkIntersection(this.raycaster);
            });
        }

        return titleBarIntersects.length > 0;
    }

    /**
     * Start grabbing the panel
     */
    startGrab(controller) {
        if (this.isGrabbed) return;

        this.isGrabbed = true;
        this.grabController = controller;

        // Calculate grab offset
        const controllerWorldPos = new Vector3().setFromMatrixPosition(controller.matrixWorld);
        const panelWorldPos = new Vector3().setFromMatrixPosition(this.panel.matrixWorld);
        this.grabOffset.subVectors(panelWorldPos, controllerWorldPos);

        // Store initial matrices for rotation
        this.initialControllerMatrix.copy(controller.matrixWorld);
        this.initialPanelMatrix.copy(this.panel.matrixWorld);

        // Visual feedback
        this.background.material.color.setHex(0x555555);
        this.title.text = 'VR Controls - Moving...';
        this.title.sync();

        console.log('Panel grabbed');
    }

    /**
     * Stop grabbing the panel
     */
    stopGrab() {
        if (!this.isGrabbed) return;

        this.isGrabbed = false;
        this.grabController = null;

        // Reset visual feedback
        this.background.material.color.setHex(this.backgroundColor);
        this.title.text = this.defaultTitleText;
        this.title.sync();

        console.log('Panel released');
    }

    /**
     * Update panel position and rotation when grabbed
     */
    updateGrab() {
        if (!this.isGrabbed || !this.grabController) return;

        // Calculate the current controller transform
        const currentControllerMatrix = this.grabController.matrixWorld.clone();

        // Calculate the relative transform from initial to current controller position
        const deltaMatrix = currentControllerMatrix.clone().multiply(this.initialControllerMatrix.clone().invert());

        // Apply this transform to the initial panel position to get the new position
        const newPanelMatrix = deltaMatrix.clone().multiply(this.initialPanelMatrix);

        // Convert panel position to parent's local space to prevent the panel
        // jumping around when dragging.
        const parent = this.panel.parent;
        if (parent) {
            parent.updateMatrixWorld(true);
            const parentInverse = parent.matrixWorld.clone().invert();
            const localMatrix = parentInverse.multiply(newPanelMatrix);
            this.panel.position.setFromMatrixPosition(localMatrix);
            this.panel.quaternion.setFromRotationMatrix(localMatrix);
        } else {
            this.panel.position.setFromMatrixPosition(newPanelMatrix);
            this.panel.quaternion.setFromRotationMatrix(newPanelMatrix);
        }
    }

    /**
     * Handle controller select events
     */
    handleControllerSelect(controller) {
        // Check if clicking on title bar to grab
        const titleBarIntersects = this.checkIntersections(controller);

        if (titleBarIntersects && !this.isGrabbed) {
            this.startGrab(controller);
            return true; // Consumed the event
        }

        // Otherwise, check controls
        let didActivateControl = false;
        if (!this.isGrabbed) {
            this.controls.forEach(control => {
                if (control.isHovered) {
                    control.activate();
                    didActivateControl = true;
                }
            });
        }

        return didActivateControl;
    }

    /**
     * Handle controller release events
     */
    handleControllerRelease(controller) {
        if (this.isGrabbed && this.grabController === controller) {
            this.stopGrab();
        }
    }

    /**
     * Get the panel group for adding to scene
     */
    getPanel() {
        return this.panel;
    }

    /**
     * Set panel visibility with protection against unwanted toggles
     */
    setVisible(visible, forceChange = false) {
        console.log(`VRControlPanel.setVisible called with: ${visible}, mode: ${this.isDesktopMode ? 'desktop' : 'VR'}, force: ${forceChange}`);

        if (this.desktopOverlay && this.isDesktopMode) {
            // Protect desktop overlay from being hidden repeatedly
            if (!visible && this.isInitialized && !forceChange) {
                console.log('Ignoring repeated attempt to hide desktop overlay');
                return;
            }
            this.desktopOverlay.style.display = visible ? 'block' : 'none';
            console.log(`Desktop overlay visibility set to: ${visible ? 'block' : 'none'}`);
            if (visible) {
                this.isInitialized = true;
            }
        } else if (this.panel && !this.isDesktopMode) {
            this.panel.visible = visible;
            console.log(`VR panel visibility set to: ${visible}, forced: ${forceChange}`);
        } else {
            console.log('Mode mismatch - panel type does not match detected mode');
        }
    }

    /**
     * Toggle panel visibility (for user-initiated changes)
     */
    toggle() {
        const currentVisibility = this.isVisible();
        this.setVisible(!currentVisibility, true); // Force the change
        console.log(`Panel toggled to: ${!currentVisibility}`);
        return !currentVisibility;
    }

    /**
     * Get current visibility state
     */
    isVisible() {
        if (this.desktopOverlay) {
            return this.desktopOverlay.style.display !== 'none';
        } else if (this.panel) {
            return this.panel.visible;
        }
        return false;
    }

    showStatusMessage(message, type = 'info', durationMs = 2500) {
        if (this.desktopOverlay && this.isDesktopMode) {
            if (!this.desktopStatusNode) {
                this.desktopStatusNode = document.createElement('div');
                this.desktopStatusNode.style.cssText = `
                    margin: 10px 0;
                    padding: 8px;
                    border-radius: 4px;
                    font-size: 13px;
                    text-align: center;
                    font-weight: 600;
                    background: rgba(30, 30, 30, 0.8);
                    border: 1px solid #666;
                `;
                this.desktopOverlay.appendChild(this.desktopStatusNode);
            }

            const color = type === 'success' ? '#36d399' : (type === 'error' ? '#f87272' : '#f3f4f6');
            this.desktopStatusNode.style.color = color;
            this.desktopStatusNode.textContent = message;

            if (this.statusRestoreTimer) {
                clearTimeout(this.statusRestoreTimer);
            }
            this.statusRestoreTimer = setTimeout(() => {
                if (this.desktopStatusNode) {
                    this.desktopStatusNode.textContent = '';
                }
            }, durationMs);
            return;
        }

        if (this.title) {
            const colorHex = type === 'success' ? 0x36d399 : (type === 'error' ? 0xf87272 : 0xffffff);
            this.title.text = message;
            this.title.color = colorHex;
            this.title.sync();

            if (this.statusRestoreTimer) {
                clearTimeout(this.statusRestoreTimer);
            }
            this.statusRestoreTimer = setTimeout(() => {
                if (this.title && !this.isGrabbed) {
                    this.title.text = this.defaultTitleText;
                    this.title.color = 0xffffff;
                    this.title.sync();
                }
            }, durationMs);
        }
    }
    /**
     * Call this method every frame to update the FPS counter
     */
    updateFpsCounter() {
        this._frameCount++;
        const now = performance.now();
        if (now - this._lastFpsUpdate > 500) {
            this.fps = Math.round((this._frameCount * 1000) / (now - this._lastFpsUpdate));
            this._lastFpsUpdate = now;
            this._frameCount = 0;
            // Update VR text
            if (this.fpsText) {
                this.fpsText.text = `FPS: ${this.fps}`;
                this.fpsText.sync();
            }
            // Update desktop overlay
            if (this.desktopFpsNode) {
                this.desktopFpsNode.textContent = `FPS: ${this.fps}`;
            }
        }
    }

    /**
     * Clean up desktop overlay when not needed
     */
    destroy() {
        if (this.desktopOverlay && this.desktopOverlay.parentNode) {
            this.desktopOverlay.parentNode.removeChild(this.desktopOverlay);
        }
    }

    /**
     * Setup desktop controls for the panel
     */
    setupDesktopControls() {
        if (!this.desktopOverlay) return;

        // Room Mesh Toggle
        const roomMeshContainer = this.createDesktopToggle('Room Mesh', true, (checked) => {
            this.callbacks.toggleRoomMeshVisibility(checked);
            console.log('Room mesh toggled:', checked);
        });
        this.desktopOverlay.appendChild(roomMeshContainer);

        // Show Helpers Toggle
        const sceneContainer = this.createDesktopToggle('Show Helpers', true, (checked) => {
            this.callbacks.toggleHelpers(checked);
            console.log('Helpers visibility toggled:', checked);
        });
        this.desktopOverlay.appendChild(sceneContainer);

        // Clear Anchors Button
        const saveAnchorsBtn = this.createDesktopButton('Save Anchors', async () => {
            console.log('Saving scene/control-panel anchors to server...');
            this.showStatusMessage('Saving anchors...', 'info');
            const result = await this.callbacks.saveAnchorsToServer?.();
            if (result?.success) {
                this.showStatusMessage('Anchors saved', 'success');
            } else {
                this.showStatusMessage(result?.message || 'Failed to save anchors', 'error');
            }
        });
        this.desktopOverlay.appendChild(saveAnchorsBtn);

        // Align to Floor Button
        const alignFloorBtn = this.createDesktopButton('Align to Floor', () => {
            this.callbacks.alignToFloor();
        });
        this.desktopOverlay.appendChild(alignFloorBtn);

        // Debug Scene Button
        const debugSceneBtn = this.createDesktopButton('Debug Scene', () => {
            this.callbacks.debugScene();
        });
        this.desktopOverlay.appendChild(debugSceneBtn);

        // Export Room Mesh Button (only show in VR mode)
        if (!this.isDesktopMode) {
            const exportBtn = this.createDesktopButton('Export Room Mesh', async () => {
                try {
                    console.log('Starting room mesh export...');
                    const result = await this.callbacks.exportRoomMesh();
                    if (result.error) {
                        console.error('Room mesh export failed:', result.error);
                    } else {
                        console.log('Room mesh export completed:', result);
                    }
                } catch (error) {
                    console.error('Room mesh export failed:', error);
                }
            });
            this.desktopOverlay.appendChild(exportBtn);
        }

        // Show the overlay
        this.setVisible(true);
    }
}

/**
 * VR Toggle control class
 */
export class VRToggle {
    constructor(options = {}) {
        this.group = new Group();
        this.label = options.label || 'Toggle';
        this.state = options.state || false;
        this.callback = options.callback;
        this.position = options.position || new Vector3(0, 0, 0);
        this.isHovered = false;
        this.interactables = [];

        this.setupToggle();
        this.group.position.copy(this.position);
    }

    setupToggle() {
        const bgGeometry = new BoxGeometry(0.08, 0.04, 0.01);
        const bgMaterial = new MeshBasicMaterial({
            color: this.state ? 0x00ff00 : 0xff0000,
            transparent: true,
            opacity: 0.8,
        });
        this.toggleBackground = new Mesh(bgGeometry, bgMaterial);
        this.group.add(this.toggleBackground);
        this.interactables.push(this.toggleBackground);

        const switchGeometry = new BoxGeometry(0.02, 0.03, 0.012);
        const switchMaterial = new MeshBasicMaterial({ color: 0xffffff });
        this.toggleSwitch = new Mesh(switchGeometry, switchMaterial);
        this.toggleSwitch.position.x = this.state ? 0.02 : -0.02;
        this.group.add(this.toggleSwitch);

        this.labelText = new Text();
        this.labelText.text = this.label;
        this.labelText.fontSize = 0.03;
        this.labelText.color = 0xffffff;
        this.labelText.anchorX = 'left';
        this.labelText.anchorY = 'middle';
        this.labelText.position.set(0.06, 0, 0.006);
        this.labelText.sync();
        this.group.add(this.labelText);
    }

    checkIntersection(raycaster) {
        const intersects = raycaster.intersectObjects(this.interactables);
        const wasHovered = this.isHovered;
        this.isHovered = intersects.length > 0;

        if (this.isHovered !== wasHovered) {
            this.toggleBackground.material.opacity = this.isHovered ? 1.0 : 0.8;
        }
    }

    activate() {
        this.setState(!this.state);
        if (this.callback) {
            this.callback(this.state);
        }
    }

    setState(newState) {
        this.state = newState;
        this.toggleBackground.material.color.setHex(this.state ? 0x00ff00 : 0xff0000);
        this.toggleSwitch.position.x = this.state ? 0.02 : -0.02;
    }
}

export class VRButton {
    constructor(options = {}) {
        this.group = new Group();
        this.label = options.label || 'Button';
        this.callback = options.callback;
        this.position = options.position || new Vector3(0, 0, 0);
        this.isHovered = false;
        this.interactables = [];

        this.setupButton();
        this.group.position.copy(this.position);
    }

    setupButton() {
        const bgGeometry = new BoxGeometry(0.15, 0.05, 0.01);
        const bgMaterial = new MeshBasicMaterial({
            color: 0x4444ff,
            transparent: true,
            opacity: 0.8,
        });
        this.buttonBackground = new Mesh(bgGeometry, bgMaterial);
        this.group.add(this.buttonBackground);
        this.interactables.push(this.buttonBackground);

        this.labelText = new Text();
        this.labelText.text = this.label;
        this.labelText.fontSize = 0.02;
        this.labelText.color = 0xffffff;
        this.labelText.anchorX = 'center';
        this.labelText.anchorY = 'middle';
        this.labelText.position.set(0, 0, 0.006);
        this.labelText.sync();
        this.group.add(this.labelText);
    }

    checkIntersection(raycaster) {
        const intersects = raycaster.intersectObjects(this.interactables);
        const wasHovered = this.isHovered;
        this.isHovered = intersects.length > 0;

        if (this.isHovered !== wasHovered) {
            this.buttonBackground.material.opacity = this.isHovered ? 1.0 : 0.8;
            this.buttonBackground.material.color.setHex(this.isHovered ? 0x6666ff : 0x4444ff);
        }
    }

    activate() {
        if (this.callback) {
            this.callback();
        }
    }
}
