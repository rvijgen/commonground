import { Box3, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadFigureTemplate } from './FigureLoader.js';

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
   * Frame the whole scene: aim the orbit target at the scene's bounding
   * box center and place the camera (along the current view direction)
   * at the exact distance where every box corner lands inside both FOV
   * frustums, plus a small margin. Raises maxDistance when the fit needs
   * more than the default zoom range.
   */
  frameScene(scene, { padding = 1.1 } = {}) {
    if (!this.controls || !scene) return;
    const box = new Box3().setFromObject(scene);
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    if (![size.x, size.y, size.z].every((v) => Number.isFinite(v)) || box.min.equals(box.max)) return;

    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() === 0) direction.set(1, 0.6, 1);
    direction.normalize();

    // Camera basis for a camera at center + direction * D looking at center.
    const upHint = Math.abs(direction.y) > 0.99 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
    const right = new Vector3().crossVectors(direction, upHint).normalize();
    const up = new Vector3().crossVectors(right, direction).normalize();

    const verticalFov = (this.camera.fov * Math.PI) / 180;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * (this.camera.aspect || 1));
    const tanV = Math.tan(verticalFov / 2);
    const tanH = Math.tan(horizontalFov / 2);

    // For each corner: D must satisfy |x'| <= tanH * (D - zDepth) and
    // |y'| <= tanV * (D - zDepth) — solve for the largest required D.
    let distance = 0;
    const rel = new Vector3();
    for (let i = 0; i < 8; i++) {
      rel.set(
        (i & 1) ? box.max.x : box.min.x,
        (i & 2) ? box.max.y : box.min.y,
        (i & 4) ? box.max.z : box.min.z,
      ).sub(center);
      const depth = rel.dot(direction);
      distance = Math.max(
        distance,
        Math.abs(rel.dot(right)) / tanH + depth,
        Math.abs(rel.dot(up)) / tanV + depth,
      );
    }
    distance = Math.max(distance * padding, this.controls.minDistance || 0.5);

    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.controls.maxDistance = Math.max(this.controls.maxDistance, distance * 1.5);
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

  /**
   * Load a reference figure (default: bundled user1.fbx) and stand it at
   * the scene origin, so the desktop view has a human-scale orientation
   * cue at its center. Shares the load/normalize helper (cm → m scaling,
   * feet at the group origin) with the cg.stream headset figures.
   */
  async loadReferenceFigure(scene, url) {
    try {
      const figure = await loadFigureTemplate(url);
      scene.add(figure);
      return figure;
    } catch (error) {
      console.warn('Desktop reference figure failed to load:', error);
      return null;
    }
  }
}