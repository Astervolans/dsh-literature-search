/**
 * Configuration drift guard: the bundle patch, the install script's embedded
 * row, package.json, the schemastery Config, and the plugin icon must all
 * describe the same package.
 *
 * The patch/config half is skipped automatically when the `yaml` dev link is
 * absent; the icon half has no dependencies and always runs.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../lib/index.js';
import { createSuite, assert, isMain } from './harness.mjs';

const root = new URL('../', import.meta.url);
const rootDir = fileURLToPath(root);
const patchText = await readFile(fileURLToPath(new URL('cordis.patch.yml', root)), 'utf8');
const installText = await readFile(fileURLToPath(new URL('install.ps1', root)), 'utf8');
const packageJson = JSON.parse(await readFile(fileURLToPath(new URL('package.json', root)), 'utf8'));

let parseYaml;
try {
	({ parse: parseYaml } = await import('yaml'));
} catch {
	console.log('  skip yaml dev link missing; run setup-dev-links.ps1 for the config drift test');
}

const suite = createSuite('config');

if (parseYaml !== undefined) {
	suite.test('cordis.patch.yml is valid YAML with the expected row', () => {
		const patch = parseYaml(patchText);
		assert.equal(Array.isArray(patch), true);
		const row = patch[0]?.insert?.[0];
		assert.equal(row.id, 'literature-search');
		assert.equal(row.name, packageJson.name);
		assert.equal(row.config.enabled, true);
	});

	suite.test('every Config key is present in the patch row and nothing else', () => {
		const row = parseYaml(patchText)[0].insert[0];
		const declared = Object.keys(Config.dict).sort();
		const patched = Object.keys(row.config).sort();
		assert.deepEqual(patched, declared, 'cordis.patch.yml config keys drifted from Config');
	});

	suite.test("install.ps1's embedded row matches cordis.patch.yml", () => {
		// The managed row lives in a here-string; anchor on `@"` so the `-match`
		// pattern earlier in the script cannot be mistaken for the block.
		const block = /@"\r?\n\s*(# ---- dsh-literature-search[\s\S]*?)\r?\n"@/.exec(installText)?.[1];
		assert.notEqual(block, undefined, 'install.ps1 has no managed YAML block');
		const parsed = parseYaml(block);
		const embedded = parsed[0].insert[0];
		const canonical = parseYaml(patchText)[0].insert[0];
		assert.deepEqual(embedded, canonical, 'install.ps1 row drifted from cordis.patch.yml');
	});

	suite.test('patch row config resolves through the schemastery schema', () => {
		const row = parseYaml(patchText)[0].insert[0];
		const resolved = Config(row.config);
		assert.equal(resolved.pubmedEnabled, true);
		assert.equal(resolved.scholarProvider, 'auto');
		assert.equal(resolved.maxResultsCap, 50);
		assert.equal(resolved.promptOrder, 155);
		assert.equal(resolved.userAgent, '');
	});
}

// ---------------------------------------------------------------------------
// Plugin display icon
//
// `@deepseek-ai/dsh-app-boot`'s `readPluginMeta()` resolves `<name>/package.json`
// through the Node ESM resolver and turns its top-level `icon` into an image data
// URL for the Plugins panel. The rules it enforces are reproduced here, because
// every one of them fails *silently* at runtime: a bad icon keeps the title and
// description and only adds a metadata diagnostic, and a missing or undecodable
// image falls back to the built-in artwork.
// ---------------------------------------------------------------------------

/** Extension -> media type, exactly as the Host's `ICON_MEDIA_TYPES`. */
const ICON_MEDIA_TYPES = new Map([
	['.svg', 'image/svg+xml'],
	['.png', 'image/png'],
	['.jpg', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.webp', 'image/webp']
]);
/** The Host's `MAX_ICON_BYTES`. */
const MAX_ICON_BYTES = 256 * 1024;

suite.test('package.json declares a usable plugin icon', async () => {
	const icon = packageJson.icon;
	assert.equal(typeof icon, 'string', 'the icon is declared at the manifest top level, not under `dsh`');
	assert.doesNotMatch(icon, /^([A-Za-z]:[\\/]|[\\/])/, 'the icon must be a relative path');
	assert.doesNotMatch(icon, /^[A-Za-z][A-Za-z\d+.-]*:/, 'the icon must not be a URL or data URI');

	const extension = extname(icon).toLowerCase();
	assert.equal(ICON_MEDIA_TYPES.has(extension), true, `the icon must be SVG, PNG, JPEG or WebP; got "${extension}"`);

	const absolute = resolve(rootDir, icon);
	const inside = relative(rootDir, absolute);
	assert.equal(inside.startsWith(`..${sep}`) || inside === '..' || inside.startsWith(sep), false, 'the icon must stay inside the package');

	const info = await stat(absolute);
	assert.equal(info.isFile(), true, 'the icon must be a regular file');
	assert.equal(info.size <= MAX_ICON_BYTES, true, `the icon is ${info.size} bytes; the Host rejects anything over 256 KiB`);

	// npm must carry the file, or the installed package has no icon to read.
	const listed = (packageJson.files ?? []).some((entry) => entry === icon || entry === icon.replace(/^\.\//u, ''));
	assert.equal(listed, true, `${icon} must be in package.json#files, or npm will not publish it`);
});

suite.test('the manifest is reachable through exports, and the icon is self-contained', async () => {
	// The reader addresses `${package}/package.json`; an `exports` map that does not
	// open it makes the whole metadata read fail, icon included.
	assert.equal(packageJson.exports['./package.json'], './package.json');

	const icon = packageJson.icon;
	const absolute = resolve(rootDir, icon);
	const info = await stat(absolute);
	if (info.size === 0) return;

	const text = await readFile(absolute, 'utf8');
	if (extname(icon).toLowerCase() !== '.svg') return;

	// A square viewBox: the panel forces the image into a square box with
	// `object-fit: contain`, so a non-square viewBox letterboxes and shrinks.
	const open = /<svg[^>]*>/u.exec(text)?.[0] ?? '';
	const viewBox = /viewBox="([^"]+)"/u.exec(open)?.[1];
	if (viewBox !== undefined) {
		const parts = viewBox.trim().split(/[\s,]+/u).map(Number);
		assert.equal(parts.length, 4, 'viewBox must have four numbers');
		assert.equal(Math.abs(parts[2] - parts[3]) < 1e-6, true, `viewBox must be square; got ${viewBox}`);
	}

	// Rendered as an <img>, so it gets no page CSS, no theme variables, and no
	// external fetches: `currentColor` resolves to black and remote refs never load.
	assert.doesNotMatch(text, /currentColor/u, 'currentColor cannot resolve inside an <img>');
	assert.doesNotMatch(text, /<!DOCTYPE[^>]*\[|<!\w+\s+[^>]*SYSTEM/iu, 'no external DTD reference');
	assert.doesNotMatch(text, /<script\b|<foreignObject\b/u, 'no scripting or HTML islands');
	const external = [...text.matchAll(/xlink:href="([^"]*)"/gu)].map((match) => match[1]).filter((href) => !href.startsWith('#') && !href.startsWith('data:'));
	assert.deepEqual(external, [], 'every reference must be an internal fragment or a data URI');
});

if (isMain(import.meta.url)) {
	const result = await suite.run();
	process.exitCode = result.failed > 0 ? 1 : 0;
}
export default suite;
