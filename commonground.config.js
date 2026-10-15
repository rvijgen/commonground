// Demo configuration for running the framework demo from the repo root:
//
//   npm run demo
//
// One process hosts everything the framework ships: the bundled test-cube
// example app (serveExample), the anchors/mesh API, the cg.sync/cg.status/
// cg.stream socket channels, the in-process dashboard with its alt-screen
// TUI (QUIET_LOGS=1 on a TTY), the generated helper launch page, and NDJSON
// session logs. All settings optional — see docs/server.md for the full
// config reference.
export default {
	space: 'default',
	httpPort: 3001,
	httpsPort: 3002,
	dataDir: 'data',
	certDir: '.certs',

	// Mount the bundled example: /examples, /src, /assets, /node_modules,
	// dist/ at /, and the no-build test-cube page at / and /dev.
	serveExample: true,

	dashboard: {
		title: 'CommonGround Demo',
		headsets: [
			{ id: 1, label: 'Headset 1', color: '#e6533c' },
			{ id: 2, label: 'Headset 2', color: '#3ca9e6' },
			{ id: 3, label: 'Headset 3', color: '#57c785' },
			{ id: 4, label: 'Headset 4', color: '#e6c93c' },
		],
		columns: [
			{ render: (status) => `Status: ${status.enteredImmersion ? 'immersed' : 'not immersed'}` },
			{ render: (status) => `Last action: ${status.lastAction}` },
		],
		// Declares the status shape: derives the default status and the
		// session-log entry (see docs/server.md → statusFields).
		statusFields: { enteredImmersion: 'boolean' },
		connections: ['screen'],
		// Fully generated launch page: CommonGround cert link, Session Logs,
		// Desktop, and per-headset links — port 80, falls back to 3000 when
		// unprivileged.
		helperPage: {},
	},
};
