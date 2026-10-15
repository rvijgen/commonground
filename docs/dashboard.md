# Dashboard

`commonground/dashboard` generalizes the terminal operations dashboard:
it renders an alt-screen status table, appends NDJSON session summaries, and
serves a headset launch helper page. It can either spawn child server
processes and scrape their log lines (classic mode), or run in-process fed
by a socket relay's `onLog` (what `commonground serve` uses).

```js
import { runDashboard } from 'commonground/dashboard';

runDashboard({
	title: 'My App Dashboard',
	headsets: [
		{ id: 1, label: 'Headset 1', color: '#ff4902' },  // hex ('#ff4902'/'#f40') or ANSI escape
		{ id: 2, label: 'Headset 2', color: null },
	],
	columns: [{ render: (status) => `Intro step: ${status.introductionStep ?? 0}` }],
	createDefaultStatus: () => ({ introductionStep: 0, enteredImmersion: false }),
	applyStatusState: (status, state) => ({ ...status, ...state }),   // default
	hasEnteredImmersion: (state) => Boolean(state.enteredImmersion),  // default
	summarizeSession: null,             // optional custom NDJSON entry builder
	processes: [                          // optional; omit for in-process mode
		{ name: 'my-server', command: process.execPath, args: ['./server.js'] },
	],
	handleSignals: true,                  // false when the host manages shutdown
	sessionLogFile: './data/logs/headset-sessions.ndjson',
	helperPage: {
		port: 80, fallbackPort: 3000,
		title: 'Quest Links', heading: 'Headset Launch', description: '...',
		links: [{ label: 'Screen', href: 'https://{host}:3004/screen' }],
		headsetLinks: [
			{ label: 'Headset {id}', href: 'https://{host}:3004?deviceid={id}' },
			{ label: 'Headset {id} Sync', href: 'https://{host}:3004?deviceid={id}&sync=1' },
		],
	},
});
```

Child processes must print the scraped line formats to stdout:
`[socket:<label>] connected|disconnected client <id>` and
`[status] {"deviceId":<id>,"action":"...","state":{...},"at":<ms>}`
(exactly what `attachSocketRelay` emits). In-process mode wires those same
lines directly: `attachSocketRelay(servers, { onLog: dashboard.writeLogLine })`.

The alt-screen TUI is enabled when `QUIET_LOGS=1` and stdout is a TTY;
otherwise child logs pass through while parsing/session logging stay active.

In TUI mode the frame is the only thing written to the terminal, and it
always redraws in place: repaints happen only on the `refreshMs` cadence
(log lines never trigger a repaint, so a burst of status events — e.g.
per-pointer-move updates — cannot flood the terminal), recent-log lines are
truncated to the terminal width, and the log area is capped to the remaining
screen rows (overflow is summarized as `... N older log line(s) hidden`).
Notices such as `[dashboard] Session #N started for headset <id>` go to the
TUI's recent-log area rather than raw stdout; in non-TUI mode they are
printed to stdout as before. `commonground serve` also routes the server's
own informational lines — listen banners, mount notices, anchor/mesh save
confirmations — through the same sink (`createServer({ onLog })`), so once
the alt screen is active nothing writes raw to the terminal; lines emitted
before the dashboard exists (e.g. app-mount notices) still print to the
normal screen first. Non-TUI/verbose mode prints everything exactly as
before. `toSessionMsEvents(history, sessionStartMs)` is exported for
building session-relative NDJSON histories.
