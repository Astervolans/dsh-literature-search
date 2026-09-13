/**
 * Extract the DSH packages this plugin's test suite needs out of a packaged
 * app.asar, so `node test/run-all.mjs` runs without a pnpm install and without
 * depending on the profile layout (which changes between DSH releases).
 *
 *   node tools/extract-dev-deps.mjs [--asar <path>] [--out <dir>]
 *
 * The scan starts from the packages the plugin imports directly and follows the
 * bare specifiers found in every extracted file's source, so the output is the
 * actual runtime closure — not the whole @deepseek-ai scope.
 */
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
/** Read `--name value`, falling back to a default. */
function flag(name, fallback) {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const asarPath = resolve(flag('asar', 'D:\\DSH Desktop\\resources\\app.asar'));
const outDir = resolve(flag('out', '.dev-deps'));
/** Extra roots for a one-off probe (`--also a,b`); the closure scan does the rest. */
const extraSeeds = String(flag('also', ''))
	.split(',')
	.map((entry) => entry.trim())
	.filter((entry) => entry.length > 0);
/** Packages the plugin itself imports (plus the test-only YAML parser). */
const SEEDS = ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', 'yaml', ...extraSeeds];

/** Bare specifier -> package name. */
function packageOf(specifier) {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Parse the asar header of a Chromium-pickle archive. */
async function openAsar(path) {
	const handle = await open(path, 'r');
	const sizeBuf = Buffer.alloc(8);
	await handle.read(sizeBuf, 0, 8, 0);
	const headerSize = sizeBuf.readUInt32LE(4);
	const headerBuf = Buffer.alloc(headerSize);
	await handle.read(headerBuf, 0, headerSize, 8);
	const headerText = headerBuf.toString('utf8');
	const header = JSON.parse(headerText.slice(headerText.indexOf('{')).replace(/\0+$/, ''));
	return { handle, header, baseOffset: 8 + headerSize };
}

/** Walk the header tree to one entry. */
function entryOf(header, path) {
	let node = header;
	for (const segment of path.split('/').filter((part) => part.length > 0)) {
		node = node.files?.[segment];
		if (node === undefined) return undefined;
	}
	return node;
}

const asar = await openAsar(asarPath);
if (entryOf(asar.header, 'node_modules') === undefined) throw new Error(`${asarPath} has no node_modules`);

const extracted = new Set();
const missing = new Set();
/** Relative paths of every file written, for the second (specifier) pass. */
const written = [];

/** Copy one file entry out of the archive. */
async function writeEntry(entry, target) {
	const buffer = Buffer.alloc(entry.size);
	await asar.handle.read(buffer, 0, entry.size, asar.baseOffset + Number(entry.offset));
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, buffer);
}

/** Copy a whole package directory (skipping source maps) and return its files. */
async function extractPackage(packageName) {
	const packageRoot = `node_modules/${packageName}`;
	const node = entryOf(asar.header, packageRoot);
	if (node === undefined || node.files === undefined) {
		missing.add(packageName);
		return [];
	}
	const files = [];
	const walk = async (dirNode, relative) => {
		for (const [name, child] of Object.entries(dirNode.files)) {
			const nextRelative = relative === '' ? name : `${relative}/${name}`;
			if (child.files !== undefined) {
				await walk(child, nextRelative);
				continue;
			}
			if (nextRelative.endsWith('.map')) continue;
			await writeEntry(child, join(outDir, packageRoot, nextRelative));
			files.push(join(outDir, packageRoot, nextRelative));
		}
	};
	await walk(node, '');
	extracted.add(packageName);
	return files;
}

const queue = [...SEEDS];
while (queue.length > 0) {
	const packageName = queue.shift();
	if (extracted.has(packageName)) continue;
	const files = await extractPackage(packageName);
	for (const file of files) {
		if (!/\.(js|mjs|cjs)$/.test(file)) continue;
		written.push(file);
	}
}

// Second pass: follow the bare specifiers inside every extracted JS file until
// the closure is complete.
let scanned = 0;
while (scanned < written.length) {
	const file = written[scanned];
	scanned += 1;
	const source = await readFile(file, 'utf8');
	const specifiers = new Set();
	for (const pattern of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
		let match;
		while ((match = pattern.exec(source)) !== null) specifiers.add(match[1]);
	}
	for (const specifier of specifiers) {
		if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('file:')) continue;
		const packageName = packageOf(specifier);
		if (extracted.has(packageName) || queue.includes(packageName) || missing.has(packageName)) continue;
		if (entryOf(asar.header, `node_modules/${packageName}`) === undefined) continue;
		queue.push(packageName);
	}
	while (queue.length > 0) {
		const packageName = queue.shift();
		if (extracted.has(packageName)) continue;
		const files = await extractPackage(packageName);
		for (const file of files) {
			if (/\.(js|mjs|cjs)$/.test(file)) written.push(file);
		}
	}
}

await asar.handle.close();

console.log(`extracted ${extracted.size} package(s) into ${outDir}:`);
console.log([...extracted].sort().join('\n'));
if (missing.size > 0) {
	console.log(`\nnot present in the archive (skipped): ${[...missing].join(', ')}`);
}
if (!existsSync(join(outDir, 'node_modules', '@deepseek-ai', 'dsh-tools'))) {
	console.log('\nWARNING: @deepseek-ai/dsh-tools was not extracted; check --asar.');
}
