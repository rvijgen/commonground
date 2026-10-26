import fs from 'node:fs';

/**
 * Replays stream recordings (server/recorder.js) as simulated headsets,
 * driving the relay's simulation API on the recorded timing. Each file
 * becomes one headset: deviceIds are assigned by file order (1..N), so a
 * set of one-headset recordings replays as a multi-headset session.
 *
 * Connect → events on recorded timing → disconnect at end of track. The
 * simulation emits the same log lines and broadcasts as real headsets, so
 * the dashboard, session logs, api/headsets and desktop stream figures
 * behave exactly as during a live session.
 */

// A recording may contain events from several devices (multi-headset run);
// a replayed file stands for ONE headset, so the dominant track (the
// deviceId with the most pose events) is used.
function loadTrack(filePath, logLine) {
	let text;
	try {
		text = fs.readFileSync(filePath, 'utf8');
	} catch (error) {
		logLine(`[replay] cannot read ${filePath}: ${error?.message || error}`);
		return null;
	}
	const byDevice = new Map(); // deviceId → { poses, events }
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event;
		try {
			event = JSON.parse(trimmed);
		} catch (_) {
			continue; // tolerate a truncated last line (killed mid-write)
		}
		const deviceId = Number(event?.deviceId);
		const t = Number(event?.t);
		if (!Number.isInteger(deviceId) || !Number.isFinite(t)) continue;
		if (event.kind !== 'pose' && event.kind !== 'status') continue;
		let track = byDevice.get(deviceId);
		if (!track) {
			track = { poses: 0, events: [] };
			byDevice.set(deviceId, track);
		}
		if (event.kind === 'pose') track.poses += 1;
		track.events.push(event);
	}
	let best = null;
	for (const track of byDevice.values()) {
		if (!best || track.poses > best.poses) best = track;
	}
	if (!best || best.events.length === 0) return null;
	// A file with a timestamp regression is two sessions appended together
	// (a pre-uniquify --save rerun). Sorting would interleave them into one
	// glitching track, so keep only the first session and say so. Check in
	// file order, BEFORE sorting.
	for (let i = 1; i < best.events.length; i++) {
		if (best.events[i].t < best.events[i - 1].t) {
			logLine(`[replay] ${filePath}: timestamps restart at event ${i + 1} — file holds multiple sessions, replaying only the first`);
			best.events.length = i;
			break;
		}
	}
	best.events.sort((a, b) => a.t - b.t);
	return best.events;
}

export function startStreamReplay({ relay, files, logLine = () => {}, startDelayMs = 2000, endGraceMs = 500 }) {
	const simulation = relay?.simulation;
	if (!simulation) {
		logLine('[replay] relay exposes no simulation API — replay disabled');
		return null;
	}

	const timers = [];
	let finishedTracks = 0;
	const tracks = [];
	files.forEach((filePath, index) => {
		const events = loadTrack(filePath, logLine);
		if (!events) {
			logLine(`[replay] ${filePath}: no usable events, skipped`);
			return;
		}
		tracks.push({ deviceId: index + 1, filePath, events });
	});
	if (tracks.length === 0) {
		logLine('[replay] no recordings to replay');
		return null;
	}

	function stop() {
		for (const timer of timers) clearTimeout(timer);
		for (const track of tracks) simulation.disconnect(track.deviceId);
	}

	const startTimer = setTimeout(() => {
		for (const track of tracks) {
			const lastT = track.events[track.events.length - 1].t;
			logLine(`[replay] headset ${track.deviceId} ← ${track.filePath} (${track.events.length} events, ${(lastT / 1000).toFixed(1)}s)`);
			simulation.connect(track.deviceId);
			for (const event of track.events) {
				timers.push(setTimeout(() => {
					if (event.kind === 'pose') {
						simulation.pose(track.deviceId, event.position, event.quaternion);
					} else {
						simulation.status(track.deviceId, event.state);
					}
				}, event.t));
			}
			timers.push(setTimeout(() => {
				simulation.disconnect(track.deviceId);
				finishedTracks += 1;
				if (finishedTracks === tracks.length) {
					logLine('[replay] all recordings finished');
				}
			}, lastT + endGraceMs));
		}
	}, startDelayMs);
	timers.push(startTimer);

	logLine(`[replay] starting in ${(startDelayMs / 1000).toFixed(0)}s — ${tracks.length} recording(s)`);
	return { stop, tracks: tracks.map((track) => ({ deviceId: track.deviceId, filePath: track.filePath })) };
}
