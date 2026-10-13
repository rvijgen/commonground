import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export default class Desktop {
  constructor(camera, renderer) {
    this.camera = camera;
    this.renderer = renderer;
    this.controls = null;
  }

  /**
   * Sets up orbit controls for desktop navigation
   */
  setupOrbitControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);

    // Configure controls
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.enableRotate = true;

    // Set reasonable limits
    this.controls.maxDistance = 10;
    this.controls.minDistance = 0.5;
    this.controls.maxPolarAngle = Math.PI; // Allow full rotation

    // Position camera for better initial view
    this.camera.position.set(2, 1.6, 2);
    this.controls.target.set(0, 1, 0);
    this.controls.update();

    // console.log('Orbit controls enabled for desktop mode');
  }

  /**
   * Re-center the view on a point, keeping the current camera distance
   * and viewing angle so the target ends up in the middle of the frame.
   */
  focusOn(point) {
    if (!this.controls) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.copy(point);
    this.camera.position.copy(point).add(offset);
    this.controls.update();
  }

  /**
   * Load room mesh data for desktop viewing
   */
  async loadRoomMeshForDesktop(meshFunctions, scene, roomMeshVisible, isDesktopMode) {
    try {
      const geometries = await meshFunctions.loadRoomMeshForDesktop();
      meshFunctions.addRoomMeshToScene(geometries, scene, roomMeshVisible, isDesktopMode);
    //   console.log('Room mesh loaded successfully for desktop viewing');
      return geometries;
    } catch (error) {
    //   console.log('No room mesh data available for desktop viewing:', error);
      return null;
    }
  }
}