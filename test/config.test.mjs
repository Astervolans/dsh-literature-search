/**
 * Configuration drift guard: the bundle patch, the install script's embedded
 * row, package.json, and the schemastery Config must all describe the same row
 * and the same config keys.
 *
 * Skipped automatically when the `yaml` dev link is absent.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Config } from '../lib/index.js';
import { createSuite, assert, isMain } from './harness.mjs';

const root = new URL('../', import.meta.url);
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

if (isMain(import.meta.url)) {
	const result = await suite.run();
	process.exitCode = result.failed > 0 ? 1 : 0;
}
export default suite;
