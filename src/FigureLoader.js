import { Box3, Group, Vector3 } from 'three';

/**
 * Loads an FBX figure and normalizes it into a Group whose origin is the
 * figure's feet-center, so callers can place the group (or a clone of it)
 * directly at a ground position. FBX exports are often in centimeters: a
 * figure taller than 10 raw units is assumed to be cm and scaled to meters.
 * Materials are forced matte — the bundled figure otherwise renders glossy.
 * FBXLoader produces MeshPhongMaterial, so specular/shininess are zeroed in
 * addition to metalness/roughness (which only exist on MeshStandardMaterial).
 *
 * Shared by the desktop origin reference figure (Desktop.loadReferenceFigure)
 * and the per-headset cg.stream figures (StreamFigures).
 */
export async function loadFigureTemplate(url) {
	const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
	const model = await new FBXLoader().loadAsync(url);
	model.traverse((obj) => {
		if (!obj.isMesh || !obj.material) return;
		const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
		for (const material of materials) {
			if (!material) continue;
			if ('metalness' in material) material.metalness = 0;
			if ('roughness' in material) material.roughness = 1;
			if ('shininess' in material) material.shininess = 0;
			if (material.specular) material.specular.setScalar(0);
			material.needsUpdate = true;
		}
	});
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
