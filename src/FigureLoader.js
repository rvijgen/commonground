import { Box3, Group, Vector3 } from 'three';

/**
 * Loads an FBX figure and normalizes it into a Group whose origin is the
 * figure's feet-center, so callers can place the group (or a clone of it)
 * directly at a ground position. FBX exports are often in centimeters: a
 * figure taller than 10 raw units is assumed to be cm and scaled to meters.
 *
 * Shared by the desktop origin reference figure (Desktop.loadReferenceFigure)
 * and the per-headset cg.stream figures (StreamFigures).
 */
export async function loadFigureTemplate(url) {
	const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
	const model = await new FBXLoader().loadAsync(url);
	const rawHeight = new Box3().setFromObject(model).getSize(new Vector3()).y;
	if (rawHeight > 10) model.scale.setScalar(0.01);
	const wrapper = new Group();
	wrapper.add(model);
	const box = new Box3().setFromObject(wrapper);
	const center = box.getCenter(new Vector3());
	model.position.x -= center.x;
	model.position.z -= center.z;
	model.position.y -= box.min.y;
	return wrapper;
}
