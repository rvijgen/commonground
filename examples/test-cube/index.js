import { CommonGround } from '../../src/CommonGround.js';
import { Mesh, BoxGeometry, Vector3 } from 'three';

const cg = new CommonGround();
cg.configure({roomMesh: false, helpers: false, menu: false, occlusion: true, occlusionMode: 'prepass', overlay: true });

cg.init().then(() => {
	
	const h = cg.getCeilingHeight();
	const cube = new Mesh(
		new BoxGeometry(0.2, h, 0.2),
		cg.getOcclusionMaterial(),
	);
	cube.frustumCulled = false;
	cg.addObject('myCube', cube, new Vector3(0, h / 2, 0));
});
