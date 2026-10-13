#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDashboard } from './index.js';

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

if (args.help || !args.config) {
	console.log('Usage: node dashboard/cli.js --config <path-to-config-module>');
	console.log('');
	console.log('The config module must export the runDashboard config as its default export.');
	process.exit(args.help ? 0 : 1);
}

const configPath = path.resolve(process.cwd(), String(args.config));
const configModule = await import(pathToFileURL(configPath).href);
const config = configModule.default ?? configModule;

runDashboard(config);
