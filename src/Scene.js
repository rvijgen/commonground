import { Text } from 'troika-three-text';
import {
    BoxGeometry,
    Mesh,
    MeshLambertMaterial,
    MeshBasicMaterial,
    Group,
    GridHelper,
    Vector3,
    Matrix4,
    Quaternion,
    PlaneGeometry,
    AxesHelper
} from 'three';


/**
 * Scene manager for XR content - manages all 3D objects that will be placed in the XR environment
 */
export class SceneManager {
    constructor() {
        this.sceneGroup = new Group();
        this.sceneStage = new Group();
        this.sceneGroup.name = 'XRSceneContent';
        this.objects = new Map();
        // Grab/move functionality similar to VRControlPanel
        this.isGrabbed = false;
        this.grabController = null;
        this.grabOffset = new Vector3();
        this.grabRotationOffset = new Quaternion();
        this.pointCloudLoader = null; // Store reference for LOD updates
        // console.log('SceneManager initialized');
        this.setupInitialScene();
    }

    /**
     * Sets up the initial scene with default objects
     */
    setupInitialScene() {
        // Just create the regular scene objects, no anchor logic
        this.createRegularScene();
        
    }
    addSceneComponent(componentName){
        if (componentName === 'videoTest') {
            this.sceneStage.add(this.VideoTest.init());
        }
        if (componentName === 'pointCloudLoader') {
            this.pointCloudLoader = new PointCloudLoader();
            this.pointCloudLoader.load('/api/proxy/pointcloud', {
                pointSize: 0.02, // Slightly larger points for better visibility in VR
                color: 0xff0000,
                useClusterColors: true, // Use cluster colors for better visual distinction
                maxPoints: 700000 // Limit points for VR performance
            }).then(points => {
                points.name = 'LoadedPointCloud';
                this.addObject('LoadedPointCloud', points, new Vector3(0, 0, -1));
                console.log('Point cloud added to scene');
            }).catch(error => {
                console.error('Error loading point cloud:', error);
            });
        }
    }
    /**
     * Creates regular (non-anchor) scene objects as fallback
     */
    createRegularScene() {
        this.sceneStage.name = "sceneStage"
        this.sceneGroup.add(this.sceneStage);
        // console.log('Creating regular scene objects');
        // Create a 1x1 wireframe plane
        const planeGeometry = new PlaneGeometry(1, 1);
        const planeMaterial = new MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
        });
        const wireframePlane = new Mesh(planeGeometry, planeMaterial);
        wireframePlane.name = 'WireframePlane';
        wireframePlane.position.set(0, 0, 0);
        wireframePlane.rotation.x = -Math.PI / 2;
        this.sceneStage.add(wireframePlane);
        // Create the red cube
        const geometry = new BoxGeometry(0.1, 0.1, 0.1);
        const material = new MeshLambertMaterial({ 
            color: 0xff0000, // Red color
            transparent: false,
        });
        const redCube = new Mesh(geometry, material);
        redCube.name = 'RegularRedCube';
        redCube.position.set(0, 0, 0);
        this.sceneStage.add(redCube);

        // Add XYZ axes helper (red=X, green=Y, blue=Z)
        const axesHelper = new AxesHelper(0.5);
        axesHelper.name = 'AxesHelper';
        this.sceneStage.add(axesHelper);

        // Add axis labels
        const axisLabels = [
            { text: 'X', color: 0xff0000, position: [0.55, 0, 0] },
            { text: 'Y', color: 0x00ff00, position: [0, 0.55, 0] },
            { text: 'Z', color: 0x0000ff, position: [0, 0, 0.55] },
        ];
        axisLabels.forEach(({ text, color, position }) => {
            const label = new Text();
            label.text = text;
            label.fontSize = 0.05;
            label.color = color;
            label.anchorX = 'center';
            label.anchorY = 'middle';
            label.position.set(...position);
            label.sync();
            this.sceneStage.add(label);
        });

        // Ceiling grid
        const ceilingGrid = new GridHelper(4, 20, 0x444488, 0x333366);
        ceilingGrid.name = 'CeilingGrid';
        ceilingGrid.position.set(0, 2.4, 0); // Default height, updated dynamically from detected ceiling
        this.sceneStage.add(ceilingGrid);

    }

    /**
     * Add a new object to the scene
     */
    addObject(name, mesh, position = new Vector3(0, 0, 0)) {
        mesh.position.copy(position);
        mesh.name = name;
        this.sceneStage.add(mesh);
        this.objects.set(name, mesh);
        // console.log(`Added object '${name}' to scene at position:`, position);
    }

    /**
     * Remove an object from the scene
     */
    removeObject(name) {
        const object = this.objects.get(name);
        if (object) {
            this.sceneStage.remove(object);
            this.objects.delete(name);
            
            // Clean up geometry and material
            if (object.geometry) object.geometry.dispose();
            if (object.material) {
                if (Array.isArray(object.material)) {
                    object.material.forEach(mat => mat.dispose());
                } else {
                    object.material.dispose();
                }
            }
            
            console.log(`Removed object '${name}' from scene`);
            return true;
        }
        console.warn(`Object '${name}' not found in scene`);
        return false;
    }

    /**
     * Get an object by name
     */
    getObject(name) {
        return this.objects.get(name);
    }

    /**
     * Move an object to a new position
     */
    moveObject(name, newPosition) {
        const object = this.objects.get(name);
        if (object) {
            object.position.copy(newPosition);
            console.log(`Moved object '${name}' to position:`, newPosition);
            return true;
        }
        console.warn(`Object '${name}' not found in scene`);
        return false;
    }

    /**
     * Scale an object
     */
    scaleObject(name, scale) {
        const object = this.objects.get(name);
        if (object) {
            if (typeof scale === 'number') {
                object.scale.setScalar(scale);
            } else {
                object.scale.copy(scale);
            }
            console.log(`Scaled object '${name}' to:`, object.scale);
            return true;
        }
        console.warn(`Object '${name}' not found in scene`);
        return false;
    }

    /**
     * Toggle visibility of an object
     */
    toggleObjectVisibility(name) {
        const object = this.objects.get(name);
        if (object) {
            object.visible = !object.visible;
            console.log(`Object '${name}' visibility:`, object.visible);
            return object.visible;
        }
        console.warn(`Object '${name}' not found in scene`);
        return false;
    }

    /**
     * Set visibility of all scene objects
     */
    setSceneVisibility(visible) {
        this.sceneGroup.visible = visible;
        console.log('Scene visibility set to:', visible);
    }

    /**
     * Get the scene group to add to the Three.js scene
     */
    getSceneGroup() {
        return this.sceneGroup;
    }
    getStageGroup() {
        return this.sceneGroup.getObjectByName("sceneStage");
    }

    /**
     * Get all object names
     */
    getObjectNames() {
        return Array.from(this.objects.keys());
    }

    /**
     * Get scene statistics
     */
    getSceneStats() {
        return {
            objectCount: this.objects.size,
            objects: this.getObjectNames(),
            visible: this.sceneGroup.visible
        };
    }

    /**
     * Clean up all scene objects
     */
    dispose() {
        this.objects.forEach((object, name) => {
            this.removeObject(name);
        });
        console.log('Scene disposed');
    }

    /**
     * Start grabbing the scene group
     */
    startGrab(controller) {
        console.log('SceneManager: startGrab called', {
            isGrabbed: this.isGrabbed,
            controller: !!controller
        });
        if (this.isGrabbed) {
            console.log('SceneManager: Already grabbed, returning');
            return;
        }
        if (!controller) {
            console.log('SceneManager: No controller provided');
            return;
        }
        this.isGrabbed = true;
        this.grabController = controller;

        // Calculate world transforms
        const controllerWorldPos = new Vector3().setFromMatrixPosition(controller.matrixWorld);
        const controllerWorldQuat = new Quaternion().setFromRotationMatrix(controller.matrixWorld);

        this.sceneStage.updateMatrixWorld(true);
        const stageWorldPos = new Vector3().setFromMatrixPosition(this.sceneStage.matrixWorld);
        const stageWorldQuat = new Quaternion().setFromRotationMatrix(this.sceneStage.matrixWorld);

        // Offset from controller to stage, in world space
        this.grabOffset = stageWorldPos.clone().sub(controllerWorldPos);
        // Rotation offset: controllerInverse * stageQuat
        this.grabRotationOffset = controllerWorldQuat.clone().invert().multiply(stageWorldQuat);

        console.log('SceneManager: Grab started, offset:', this.grabOffset);
    }

    /**
     * Stop grabbing the scene group
     */
    stopGrab(ratk=null) {
        if (!this.isGrabbed) return;
        this.isGrabbed = false;
        this.grabController = null;
        console.log('Scene released');
    }

    /**
     * Update scene position and rotation when grabbed
     */
    updateGrab() {
        if (!this.isGrabbed || !this.grabController) return;

        const controllerWorldPos = new Vector3().setFromMatrixPosition(this.grabController.matrixWorld);
        const controllerWorldQuat = new Quaternion().setFromRotationMatrix(this.grabController.matrixWorld);

        // Desired world position/rotation of sceneStage
        const targetWorldPos = controllerWorldPos.clone().add(this.grabOffset);
        const targetWorldQuat = controllerWorldQuat.clone().multiply(this.grabRotationOffset);

        // Convert world -> sceneGroup local space
        this.sceneGroup.updateMatrixWorld(true);
        const localPos = this.sceneGroup.worldToLocal(targetWorldPos);
        const groupWorldQuat = new Quaternion();
        this.sceneGroup.getWorldQuaternion(groupWorldQuat);
        const localQuat = groupWorldQuat.clone().invert().multiply(targetWorldQuat);

        this.sceneStage.position.copy(localPos);
        this.sceneStage.quaternion.copy(localQuat);
    }

    /**
     * Check if the scene is currently being grabbed
     */
    isSceneGrabbed() {
        return this.isGrabbed;
    }

    /**
     * Update scene components (call this in the render loop)
     * @param {Camera} camera - Three.js camera for LOD calculations
     */
    update(camera) {
        // Update point cloud LOD based on camera distance
        if (this.pointCloudLoader && camera) {
            this.pointCloudLoader.updateLOD(camera);
        }
    }
}