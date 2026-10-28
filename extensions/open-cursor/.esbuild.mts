/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Builds the extension host bundle and the webview bundles. Picked up by Code-OSS's
 *  build (build/lib/extensions.ts looks for `.esbuild.mts`). `--watch` for development.
 *--------------------------------------------------------------------------------------------*/
import * as esbuild from 'esbuild';
import * as path from 'node:path';

const root = import.meta.dirname;
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const host: esbuild.BuildOptions = {
	entryPoints: {
		extension: path.join(root, 'src/extension.ts'),
		// Stdio MCP server that Claude Code calls for permission prompts (see src/cliAgents).
		permissionServer: path.join(root, 'src/cliAgents/permissionServer.ts'),
	},
	outdir: path.join(root, 'dist'),
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	external: ['vscode'],
	sourcemap: true,
	minify: !dev,
	logLevel: 'info',
};

const webview: esbuild.BuildOptions = {
	entryPoints: {
		chat: path.join(root, 'webview/src/chat/main.tsx'),
		settings: path.join(root, 'webview/src/settings/main.tsx'),
		free: path.join(root, 'webview/src/free/main.tsx'),
	},
	outdir: path.join(root, 'dist/webview'),
	bundle: true,
	platform: 'browser',
	format: 'iife',
	target: 'es2022',
	jsx: 'automatic',
	sourcemap: dev,
	minify: !dev,
	loader: { '.svg': 'text', '.woff2': 'dataurl' },
	define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
	logLevel: 'info',
};

if (watch) {
	const ctxs = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
	await Promise.all(ctxs.map(c => c.watch()));
} else {
	await Promise.all([esbuild.build(host), esbuild.build(webview)]);
}
