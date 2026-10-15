import { CommonGround } from '../../src/CommonGround.js';
import { Mesh, BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';

const cg = new CommonGround();

// The helper page's "Admin" links add ?admin=1: admin mode unlocks the
// VR control panel (controller menu button) and turns the FPS counter on.
cg.setAdminModeEnabled(new URLSearchParams(location.search).get('admin') === '1');

// Startup look: room mesh on (it makes the shared alignment visible),
// helpers and the VR control panel off until an admin opens the panel.
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
