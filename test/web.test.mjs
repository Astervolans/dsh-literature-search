/**
 * HTTP surface tests for the Settings → Plugins card: the
 * `/plugin/literature-search` route tree, run against fake request/response
 * objects and fake settings/credentials services — no DSH host, no network.
 */
import { ROUTE_PREFIX, SETTINGS_NS, collectFacts, handleRequest, mountHttp, slotRef } from '../lib/web.js';
import { createSuite, assert, isMain } from './harness.mjs';

/** Build a fake Node request that replays `body` then ends. */
function fakeRequest({ method = 'GET', url = '/', body, headers = {} }) {
	const listeners = new Map();
	const req = {
		method,
		url,
		headers,
		on(event, handler) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(handler);
			return req;
		},
		destroy() {}
	};
	queueMicrotask(() => {
		if (body !== undefined) for (const handler of listeners.get('data') ?? []) handler(Buffer.from(body));
		for (const handler of listeners.get('end') ?? []) handler();
	});
	return req;
}

/** Build a fake Node response that records status, headers and body. */
function fakeResponse() {
	const state = { status: 0, headers: {}, body: '', headersSent: false, destroyed: false };
	return {
		state,
		writeHead(status, headers) {
			state.status = status;
			state.headers = headers ?? {};
			state.headersSent = true;
		},
		end(chunk) {
			if (chunk !== undefined) state.body += String(chunk);
			state.headersSent = true;
		},
		destroy() {
			state.destroyed = true;
		},
		get headersSent() {
			return state.headersSent;
		}
	};
}

/** Invoke one route and decode the JSON body. */
async function call(deps, options, prefix = ROUTE_PREFIX) {
	const req = fakeRequest({ ...options, url: `${prefix}${options.url ?? '/'}` });
	const res = fakeResponse();
	await handleRequest(req, res, deps);
	let json;
	try {
		json = JSON.parse(res.state.body);
	} catch {
		json = undefined;
	}
	return { status: res.state.status, json, raw: res.state.body };
}

/** Settings stand-in with one namespace and revision fencing. */
function fakeSettings({ conflict = false } = {}) {
	const updates = [];
	let revision = 3;
	return {
		updates,
		describe() {
			return [
				{
					ns: SETTINGS_NS,
					revision,
					value: { scholarProvider: 'auto', pubmedApiKeyEnv: 'NCBI_API_KEY', scholarSerpApiKeyEnv: 'SERPAPI_API_KEY' },
					base: {},
					user: {},
					applies: 'live',
					secrets: [{ path: ['pubmedApiKey'], set: false }]
				}
			];
		},
		async update(ns, patch, expectedRevision) {
			updates.push({ ns, patch, expectedRevision });
			if (conflict) {
				const error = new Error('conflict');
				error.name = 'SettingsConflictError';
				error.code = 'SETTINGS_CONFLICT';
				error.actual = 9;
				throw error;
			}
			revision += 1;
			return undefined;
		}
	};
}

/** Credentials stand-in recording writes. */
function fakeCredentials() {
	const calls = [];
	const values = new Map();
	return {
		calls,
		async describe(ref) {
			return values.has(ref) ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true };
		},
		async resolve(ref) {
			return values.get(ref) === undefined ? undefined : { value: values.get(ref) };
		},
		async set(ref, value) {
			calls.push({ op: 'set', ref, value });
			values.set(ref, value);
		},
		async unset(ref) {
			calls.push({ op: 'unset', ref });
			values.delete(ref);
		}
	};
}

/** Runtime stand-in whose probes can be made to fail. */
function fakeRuntime({ pubmedResult = 'ok', scholarResult = 'ok' } = {}) {
	const calls = [];
	const config = {
		pubmedEnabled: true,
		scholarEnabled: true,
		pubmedBaseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
		scholarProvider: 'auto',
		scholarBaseUrl: 'https://scholar.google.com',
		pubmedApiKeyEnv: 'NCBI_API_KEY',
		scholarSerpApiKeyEnv: 'SERPAPI_API_KEY',
		pubmedRateLimitMs: 0,
		pubmedApiKey: '',
		scholarSerpApiKey: ''
	};
	return {
		calls,
		config: () => config,
		async pubmed() {
			calls.push('pubmed');
			if (pubmedResult !== 'ok') throw new Error(pubmedResult);
			return { search: async () => ({ total: 25683, pmids: ['1'] }) };
		},
		async scholar() {
			calls.push('scholar');
			if (scholarResult !== 'ok') throw new Error(scholarResult);
			return {
				backend: async () => 'html',
				search: async () => ({ papers: [{ id: 'a' }, { id: 'b' }] })
			};
		}
	};
}

const suite = createSuite('web routes');

suite.test('slotRef maps slots to configured refs and rejects bad names', () => {
	const config = { pubmedApiKeyEnv: 'NCBI_API_KEY', scholarSerpApiKeyEnv: 'SERPAPI_API_KEY' };
	assert.equal(slotRef(config, 'pubmed').ref, 'NCBI_API_KEY');
	assert.equal(slotRef(config, 'scholar').ref, 'SERPAPI_API_KEY');
	assert.equal(slotRef(config, 'nope'), undefined);
	assert.equal(slotRef({ pubmedApiKeyEnv: 'not a ref' }, 'pubmed'), undefined);
});

suite.test('GET /config returns the redacted descriptor plus facts', async () => {
	const settings = fakeSettings();
	const credentials = fakeCredentials();
	const runtime = fakeRuntime();
	const result = await call(
		{ services: () => ({ settings, credentials }), runtime, defaults: {}, version: '0.1.0' },
		{ method: 'GET', url: '/config' }
	);
	assert.equal(result.status, 200);
	assert.equal(result.json.ok, true);
	assert.equal(result.json.namespace, SETTINGS_NS);
	assert.equal(result.json.revision, 3);
	assert.equal(result.json.secrets.length, 1);
	assert.equal(result.json.facts.credentials.length, 2);
	assert.equal(result.json.facts.credentials[0].slot, 'pubmed');
	assert.equal(result.json.facts.credentials[0].configured, false);
	assert.deepEqual(result.json.schemaHints.providers, ['auto', 'serpapi', 'html']);
	assert.equal(result.json.schemaHints.restartKeys.includes('scholarEnabled'), true);
});

suite.test('POST /config forwards the patch with revision fencing', async () => {
	const settings = fakeSettings();
	const deps = { services: () => ({ settings, credentials: fakeCredentials() }), runtime: fakeRuntime(), defaults: {}, version: '0.1.0' };
	const ok = await call(deps, { method: 'POST', url: '/config', body: JSON.stringify({ patch: { scholarProvider: 'serpapi' }, expectedRevision: 3 }) });
	assert.equal(ok.status, 200);
	assert.equal(ok.json.ok, true);
	assert.deepEqual(settings.updates[0], { ns: SETTINGS_NS, patch: { scholarProvider: 'serpapi' }, expectedRevision: 3 });

	const missing = await call(deps, { method: 'POST', url: '/config', body: JSON.stringify({}) });
	assert.equal(missing.status, 400);
	assert.match(missing.json.error, /missing patch/);

	const bad = await call(deps, { method: 'POST', url: '/config', body: 'not json' });
	assert.equal(bad.status, 400);
});

suite.test('POST /config reports a revision conflict as 409', async () => {
	const settings = fakeSettings({ conflict: true });
	const result = await call(
		{ services: () => ({ settings, credentials: fakeCredentials() }), runtime: fakeRuntime(), defaults: {}, version: '0.1.0' },
		{ method: 'POST', url: '/config', body: JSON.stringify({ patch: { abstractMaxChars: 200 }, expectedRevision: 1 }) }
	);
	assert.equal(result.status, 409);
	assert.equal(result.json.conflict, true);
	assert.equal(result.json.currentRevision, 9);
});

suite.test('POST /credential writes and clears the configured refs only', async () => {
	const credentials = fakeCredentials();
	const deps = { services: () => ({ settings: fakeSettings(), credentials }), runtime: fakeRuntime(), defaults: {}, version: '0.1.0' };

	const saved = await call(deps, { method: 'POST', url: '/credential', body: JSON.stringify({ slot: 'scholar', value: '  serp-key  ' }) });
	assert.equal(saved.status, 200);
	assert.equal(saved.json.ref, 'SERPAPI_API_KEY');
	assert.deepEqual(credentials.calls[0], { op: 'set', ref: 'SERPAPI_API_KEY', value: 'serp-key' });

	const cleared = await call(deps, { method: 'POST', url: '/credential', body: JSON.stringify({ slot: 'pubmed', clear: true }) });
	assert.equal(cleared.status, 200);
	assert.deepEqual(credentials.calls[1], { op: 'unset', ref: 'NCBI_API_KEY' });

	const unknown = await call(deps, { method: 'POST', url: '/credential', body: JSON.stringify({ slot: 'evil', value: 'x' }) });
	assert.equal(unknown.status, 400);

	const empty = await call(deps, { method: 'POST', url: '/credential', body: JSON.stringify({ slot: 'pubmed', value: '   ' }) });
	assert.equal(empty.status, 400);
	assert.equal(credentials.calls.length, 2);
});

suite.test('POST /test probes both backends and reports failures with a hint', async () => {
	const ok = await call(
		{ services: () => ({ settings: fakeSettings(), credentials: fakeCredentials() }), runtime: fakeRuntime(), defaults: {}, version: '0.1.0' },
		{ method: 'POST', url: '/test', body: JSON.stringify({ target: 'all' }) }
	);
	assert.equal(ok.status, 200);
	assert.equal(ok.json.ok, true);
	assert.deepEqual(ok.json.results.map((entry) => entry.target), ['pubmed', 'scholar']);
	assert.match(ok.json.results[0].detail, /E-utilities OK/);
	assert.match(ok.json.results[1].detail, /html backend OK/);

	const failing = await call(
		{
			services: () => ({ settings: fakeSettings(), credentials: fakeCredentials() }),
			runtime: fakeRuntime({ scholarResult: 'network failure talking to scholar.google.com: fetch failed' }),
			defaults: {},
			version: '0.1.0'
		},
		{ method: 'POST', url: '/test', body: JSON.stringify({ target: 'scholar' }) }
	);
	assert.equal(failing.status, 200);
	assert.equal(failing.json.ok, false);
	assert.equal(failing.json.results[0].ok, false);
	assert.match(failing.json.results[0].hint, /SerpApi key or point scholarProvider/);
});

suite.test('GET / reports health without touching a backend', async () => {
	const runtime = fakeRuntime();
	const result = await call({ services: () => ({ settings: fakeSettings(), credentials: fakeCredentials() }), runtime, defaults: {}, version: '9.9.9' }, { method: 'GET', url: '/' });
	assert.equal(result.status, 200);
	assert.equal(result.json.plugin, 'dsh-literature-search');
	assert.equal(result.json.version, '9.9.9');
	assert.deepEqual(runtime.calls, []);
});

suite.test('origin, method and availability guards', async () => {
	const deps = { services: () => ({ settings: fakeSettings(), credentials: fakeCredentials() }), runtime: fakeRuntime(), webServer: { host: '127.0.0.1', port: 43120 }, defaults: {}, version: '0.1.0' };
	const foreign = await call(deps, { method: 'GET', url: '/config', headers: { origin: 'http://evil.example' } });
	assert.equal(foreign.status, 403);
	const sameOrigin = await call(deps, { method: 'GET', url: '/config', headers: { origin: 'http://127.0.0.1:43120' } });
	assert.equal(sameOrigin.status, 200);

	// Preflights carry the caller origin, so a foreign one is refused before the
	// OPTIONS branch — that is what keeps cross-origin callers out entirely.
	const foreignPreflight = await call(deps, { method: 'OPTIONS', url: '/config', headers: { origin: 'http://evil.example' } });
	assert.equal(foreignPreflight.status, 403);
	const sameOriginPreflight = await call(deps, { method: 'OPTIONS', url: '/config', headers: { origin: 'http://127.0.0.1:43120' } });
	assert.equal(sameOriginPreflight.status, 204);
	const barePreflight = await call(deps, { method: 'OPTIONS', url: '/config' });
	assert.equal(barePreflight.status, 204);

	const unknown = await call(deps, { method: 'GET', url: '/nope' });
	assert.equal(unknown.status, 404);

	const noSettings = await call({ services: () => ({ credentials: fakeCredentials() }), runtime: fakeRuntime(), defaults: {}, version: '0.1.0' }, { method: 'GET', url: '/config' });
	assert.equal(noSettings.status, 503);
});

suite.test('mountHttp registers the prefix route on the host web server', () => {
	const registered = [];
	const ctx = {
		webServer: {
			host: '127.0.0.1',
			port: 3080,
			register(route) {
				registered.push(route);
				return () => {};
			}
		},
		effect(fn) {
			const disposer = fn();
			return () => {
				if (typeof disposer === 'function') disposer();
			};
		}
	};
	mountHttp(ctx, { services: () => ({}), runtime: fakeRuntime(), defaults: {}, version: '0.1.0' });
	assert.equal(registered.length, 1);
	assert.equal(registered[0].kind, 'prefix');
	assert.equal(registered[0].path, ROUTE_PREFIX);
	assert.equal(typeof registered[0].handler, 'function');
});

suite.test('collectFacts reports credential source and inline keys', async () => {
	const credentials = fakeCredentials();
	await credentials.set('NCBI_API_KEY', 'abc');
	const facts = await collectFacts(
		{ pubmedApiKeyEnv: 'NCBI_API_KEY', scholarSerpApiKeyEnv: 'SERPAPI_API_KEY', scholarSerpApiKey: 'inline', pubmedEnabled: true, scholarEnabled: true },
		{ credentials }
	);
	assert.equal(facts.credentialsService, true);
	// Slot 1: stored, and both probes agree.
	assert.equal(facts.credentials[0].configured, true);
	assert.equal(facts.credentials[0].source, 'file');
	assert.equal(facts.credentials[0].resolveFound, true);
	assert.equal(facts.credentials[0].describeRaw.configured, true);
	// Slot 2: nothing stored, but an inline settings key counts as configured.
	assert.equal(facts.credentials[1].configured, true);
	assert.equal(facts.credentials[1].source, 'settings-inline');
	assert.equal(facts.credentials[1].inlineConfigured, true);
	assert.equal(facts.credentials[1].describeRaw.configured, false);
	assert.equal(facts.credentials[1].resolveFound, false);
});

suite.test('collectFacts reports a value that describe denies', async () => {
	// A seam that resolves a value while reporting it unconfigured must still read
	// as configured — that mismatch is exactly what hides a key from the card.
	const credentials = {
		async describe() {
			return { configured: false, writable: true };
		},
		async resolve() {
			return { value: 'present', source: 'file' };
		}
	};
	const facts = await collectFacts({ pubmedApiKeyEnv: 'NCBI_API_KEY', scholarSerpApiKeyEnv: 'SERPAPI_API_KEY' }, { credentials });
	assert.equal(facts.credentials[0].configured, true);
	assert.equal(facts.credentials[0].source, 'file');
	assert.equal(facts.credentials[0].describeRaw.configured, false);
	assert.equal(facts.credentials[0].resolveFound, true);
});

suite.test('collectFacts surfaces a throwing seam instead of hiding it', async () => {
	const credentials = {
		async describe() {
			throw new Error('describe boom');
		},
		async resolve() {
			throw new Error('resolve boom');
		}
	};
	const facts = await collectFacts({ pubmedApiKeyEnv: 'NCBI_API_KEY', scholarSerpApiKeyEnv: 'SERPAPI_API_KEY' }, { credentials });
	assert.equal(facts.credentials[0].configured, false);
	assert.match(facts.credentials[0].describeError, /describe boom/);
});

suite.test('collectFacts works without a credentials service', async () => {
	const facts = await collectFacts({ pubmedApiKeyEnv: 'NCBI_API_KEY', scholarSerpApiKeyEnv: 'SERPAPI_API_KEY' }, {});
	assert.equal(facts.credentialsService, false);
	assert.equal(facts.credentials[0].configured, false);
	assert.equal(facts.credentials[0].ref, 'NCBI_API_KEY');
	assert.equal(facts.credentials[0].describeRaw, null);
});

suite.test('POST /credential falls back to the settings secret without a credentials service', async () => {
	const settings = fakeSettings();
	const result = await call(
		{ services: () => ({ settings }), runtime: fakeRuntime(), defaults: {}, version: '0.1.0' },
		{ method: 'POST', url: '/credential', body: JSON.stringify({ slot: 'scholar', value: 'fallback-key' }) }
	);
	assert.equal(result.status, 200);
	assert.equal(result.json.ok, true);
	assert.equal(result.json.mode, 'settings');
	assert.deepEqual(settings.updates[0].patch, { scholarSerpApiKey: 'fallback-key' });
});

if (isMain(import.meta.url)) {
	const result = await suite.run();
	process.exitCode = result.failed > 0 ? 1 : 0;
}
export default suite;
