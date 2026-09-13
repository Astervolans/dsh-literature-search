#!/usr/bin/env node
/**
 * Dev-only helper: install the DSH runtime closure the offline test suite
 * imports, straight from npm, and expose it as `node_modules/`.
 *
 *   node tools/fetch-dev-deps.mjs [--dir .dev-deps] [--no-link]
 *
 * `tools/extract-dev-deps.mjs` is the other route: it pulls the same closure
 * out of a local DSH Desktop `resources/app.asar`, which is what
 * setup-dev-links.ps1 uses. This script exists for machines that have no DSH
 * installation — notably CI — where npm is the only source.
 *
 * The plugin itself has zero runtime dependencies; everything installed here
 * is dev-only and is never copied into a DSH profile by install.ps1.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const next = process.argv[index + 1];
	return next === undefined || next.startsWith('--') ? true : next;
}

const devDir = resolve(ROOT, String(flag('dir', '.dev-deps')));
const shouldLink = flag('link', true) !== false;
const manifestPath = join(devDir, 'package.json');

if (!existsSync(manifestPath)) {
	console.error(`missing ${manifestPath} — it pins the DSH runtime versions used by the test suite`);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
mkdirSync(devDir, { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`==> installing the dev closure into ${devDir}`);
// --legacy-peer-deps: the published @deepseek-ai/* release candidates declare a
// peer graph (dsh-agent, dsh-invariants, ...) that does not resolve cleanly on
// its own. The suite only needs the packages listed as real dependencies, so
// peer auto-installation is skipped on purpose.
//
// npm runs with cwd = devDir rather than `--prefix <devDir>`: on Windows the
// command has to go through a shell to reach npm.cmd, and shells mangle an
// argument that contains a space — which a checkout path routinely does.
// The command is a fixed literal (no interpolation), so letting the shell parse
// it is safe, and passing it as one string avoids Node's DEP0190 warning about
// unescaped args with `shell: true`.
const install = spawnSync('npm install --legacy-peer-deps --no-package-lock --no-audit --no-fund', {
	cwd: devDir,
	stdio: 'inherit',
	shell: true,
});
if (install.status !== 0) {
	console.error(`npm install failed (exit ${install.status})`);
	process.exit(install.status ?? 1);
}

const source = join(devDir, 'node_modules');
if (!existsSync(source)) {
	console.error(`npm install produced no ${source}`);
	process.exit(1);
}

if (!shouldLink) {
	console.log(`==> skipped linking; add ${source} to your module resolution manually`);
	process.exit(0);
}

// ESM resolution walks up from lib/index.js to <root>/node_modules, so the
// closure has to be reachable there. A directory symlink (junction on Windows,
// which needs no elevation) is what setup-dev-links.ps1 does too.
const linkPath = join(ROOT, 'node_modules');
if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false })) {
	const stat = lstatSync(linkPath);
	if (stat.isSymbolicLink() || stat.isDirectory()) {
		console.log(`==> clearing ${linkPath}`);
		rmSync(linkPath, { recursive: true, force: true });
	} else {
		console.error(`${linkPath} exists and is not a directory or symlink; remove it first`);
		process.exit(1);
	}
}

symlinkSync(source, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
console.log(`==> linked ${linkPath} -> ${source}`);
console.log('\nDev deps ready. Run: node test/run-all.mjs');
