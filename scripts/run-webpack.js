import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mode = process.argv[2] || 'build';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeMajor = Number(process.versions.node.split('.')[0]);

const webpackBin = require.resolve('webpack/bin/webpack.js', { paths: [root] });
const args = [];

// Node 22+ may need a localStorage backing file for HtmlWebpackPlugin evaluation.
if (nodeMajor >= 22) {
	args.push('--localstorage-file=.localstorage');
}

args.push(webpackBin);

if (mode === 'serve') {
	args.push('serve');
} else if (mode !== 'build') {
	console.error('Unknown mode. Use "build" or "serve".');
	process.exit(1);
}

const child = spawn(process.execPath, args, {
	cwd: root,
	stdio: 'inherit',
	env: process.env,
});

child.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code || 0);
});
