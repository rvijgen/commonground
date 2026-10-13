import { createServer } from './index.js';

// Minimal CLI arg parsing (--flag value and --flag=value), no dependencies.
function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) continue;
		const eq = arg.indexOf('=');
		if (eq !== -1) {
			args[arg.slice(2, eq)] = arg.slice(eq + 1);
		} else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
			args[arg.slice(2)] = argv[++i];
		} else {
			args[arg.slice(2)] = true;
		}
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
	console.log('Usage: node server/server.js [--space <spaceId>] [--data-dir <dir>] [--http-port <port>] [--https-port <port>]');
	console.log('');
	console.log('Serves the CommonGround anchor/mesh API plus the bundled example app.');
	console.log('Data is stored per space at <data-dir>/spaces/<spaceId>/ (default space: "default").');
	process.exit(0);
}

const server = await createServer({
	spaceId: args.space || 'default',
	dataDir: args['data-dir'],
	httpPort: args['http-port'] ? Number(args['http-port']) : undefined,
	httpsPort: args['https-port'] ? Number(args['https-port']) : undefined,
	serveExample: true,
});

server.listen();
