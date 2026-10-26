import fs from 'node:fs';
import path from 'node:path';

/**
 * Records the cg:pose / cg:status event stream to an NDJSON file so a
 * session can be replayed later (server/replay.js). One JSON event per
 * line, `t` = ms since recording start:
 *
 *   {"t":1250,"kind":"pose","deviceId":1,"position":{...},"quaternion":{...}}
 *   {"t":1300,"kind":"status","deviceId":1,"state":{"enteredImmersion":true}}
 *
 * Typical use: record one headset per run (`--save walk1`), then replay
 * several recordings at once to simulate a multi-headset session.
 */
export function startStreamRecorder({ filePath, logLine = () => {} }) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	// Never append to an existing recording: two sessions in one file replay
	// as one interleaved track (timestamps restart per session). Auto-uniquify
	// instead of overwriting, so no recording is ever lost.
	if (fs.existsSync(filePath)) {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const ext = path.extname(filePath);
		const uniquePath = path.join(path.dirname(filePath), `${path.basename(filePath, ext)}-${stamp}${ext}`);
		logLine(`[record] ${filePath} already exists — recording to ${uniquePath} instead`);
		filePath = uniquePath;
	}
	const startedAt = Date.now();
	let eventCount = 0;
	let writeErrorLogged = false;

	function write(kind, deviceId, fields) {
		const line = JSON.stringify({ t: Date.now() - startedAt, kind, deviceId, ...fields });
		try {
			fs.appendFileSync(filePath, `${line}\n`, 'utf8');
			eventCount += 1;
		} catch (error) {
			// Poses arrive at ~10 Hz per headset — report a failing file once.
			if (!writeErrorLogged) {
				writeErrorLogged = true;
				logLine(`[record] failed to write ${filePath}: ${error?.message || error}`);
			}
		}
	}

	logLine(`[record] recording stream to ${filePath}`);

	return {
		filePath,
		// Relay tap: every forwarded cg:pose message.
		onPose(message) {
			if (!message || message.deviceId == null) return;
			write('pose', message.deviceId, { position: message.position, quaternion: message.quaternion });
		},
		// Relay tap: every cg:status summary (carries the full merged state).
		onStatus(summary) {
			if (!summary || summary.deviceId == null) return;
			write('status', summary.deviceId, { state: summary.state });
		},
		eventCount: () => eventCount,
		close() {
			logLine(`[record] stopped — ${eventCount} events written to ${filePath}`);
		},
	};
}
