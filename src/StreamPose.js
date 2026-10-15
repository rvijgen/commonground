import { Quaternion } from 'three';

const stageQuaternion = new Quaternion();

/**
 * Maps a cg:pose into the receiver's world space. Poses are expressed
 * RELATIVE to the sender's sceneStage (see StreamChannel); the receiver
 * maps them back through its own sceneStage world transform, so content-
 * relative placement is preserved regardless of each side's anchor offset:
 * outPosition = M_recv * inv(M_send) * senderCameraPos, and likewise
 * outQuaternion = q_recv * inv(q_send) * senderCameraQuat.
 *
 * position/quaternion are the raw wire values ({x,y,z} / {x,y,z,w});
 * outPosition/outQuaternion are caller-provided Vector3/Quaternion targets.
 * Without a sceneStage the pose passes through unmapped.
 */
export function mapStreamPoseToWorld(sceneStage, position, quaternion, outPosition, outQuaternion) {
	outPosition.set(Number(position?.x) || 0, Number(position?.y) || 0, Number(position?.z) || 0);
	outQuaternion.set(
		Number(quaternion?.x) || 0,
		Number(quaternion?.y) || 0,
		Number(quaternion?.z) || 0,
		Number(quaternion?.w) || 1,
	);
	if (!sceneStage) return;
	outPosition.applyMatrix4(sceneStage.matrixWorld);
	outQuaternion.premultiply(sceneStage.getWorldQuaternion(stageQuaternion));
}
