import { CommonGround } from 'commonground';
import { Group, Mesh, BoxGeometry, EdgesGeometry, LineSegments, LineBasicMaterial, MeshBasicMaterial, AdditiveBlending, Vector3 } from 'three';

const cg = new CommonGround();

// The helper page's "Admin" links add ?admin=1: admin mode unlocks the
// VR control panel (controller menu button) and turns the FPS counter on.
cg.setAdminModeEnabled(new URLSearchParams(location.search).get('admin') === '1');

// Startup look: VR control panel hidden until an admin opens it (room
// mesh and helpers already default to off; toggle them from the panel).
cg.configure({ menu: false });

cg.init().then(() => {
	// A 1×1×1 m glowing white outline cube resting on the floor at the
	// scene origin: bright edges plus a faint additive fill for the glow.
	const geometry = new BoxGeometry(1, 1, 1);
	const cube = new Group();
	cube.add(new LineSegments(
		new EdgesGeometry(geometry),
		new LineBasicMaterial({ color: 0xffffff }),
	));
	cube.add(new Mesh(
		geometry,
		new MeshBasicMaterial({
			color: 0xffffff,
			transparent: true,
			opacity: 0.06,
			blending: AdditiveBlending,
			depthWrite: false,
		}),
	));
	cg.addObject('cube', cube, new Vector3(0, 0.5, 0));

	// Show the cg.sync channel: every other client hears the cube was added.
	cg.sync.emit('demo-cube-added', { position: [0, 0.5, 0] });
});
