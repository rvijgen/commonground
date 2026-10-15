import { CommonGround } from '../../src/CommonGround.js';
import { Mesh, BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';

const cg = new CommonGround();

cg.init().then(() => {
	// A 1×1×1 m cube resting on the floor at the scene origin.
	const cube = new Mesh(
		new BoxGeometry(1, 1, 1),
		new MeshBasicMaterial({ color: 0x2e7cf6 }),
	);
	cg.addObject('cube', cube, new Vector3(0, 0.5, 0));
});
