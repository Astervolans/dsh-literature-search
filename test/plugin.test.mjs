/**
 * Plugin-contract and end-to-end tool tests with a stubbed network.
 *
 * Verifies the Cordis contract (`name`/`inject`/`Config`/`apply`), that every
 * tool registers with a valid schema, and that the real execute + render path
 * produces the expected envelope for PubMed (esearch -> esummary -> efetch ->
 * elink) and Google Scholar (SerpApi JSON and HTML) without touching the
 * network.
 *
 * Needs the dev links from setup-dev-links.ps1 so @deepseek-ai/dsh-tools and
 * @deepseek-ai/schemastery resolve.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import * as plugin from '../lib/index.js';
import { createSuite, assert, isMain } from './harness.mjs';

/**
 * Enforce the same contract the DSH runtime enforces: every execute result must
 * validate against the tool's own (closed) output schema.
 */
function assertOutput(tool, value) {
	const violations = validateJsonSchemaValue(tool.output.schema, value, '');
	assert.deepEqual(violations, [], `${tool.name} output violations: ${violations.join('; ')}`);
}

const medlineFixture = await readFile(fileURLToPath(new URL('./fixtures/medline-sample.txt', import.meta.url)), 'utf8');
const scholarHtml = await readFile(fileURLToPath(new URL('./fixtures/scholar-sample.html', import.meta.url)), 'utf8');
const serpApiFixture = await readFile(fileURLToPath(new URL('./fixtures/serpapi-sample.json', import.meta.url)), 'utf8');

/** Fresh plugin context that records registrations and optional services. */
function stubContext(services = {}) {
	const tools = new Map();
	const sections = [];
	const store = new Map(Object.entries(services));
	/** Child contexts handed to `ctx.inject` callbacks carry the named services. */
	const child = (names) => {
		const injected = { effect: (fn) => disposer(fn()) };
		for (const name of names) injected[name] = store.get(name);
		return injected;
	};
	return {
		tools: {
			register(definition) {
				if (tools.has(definition.name)) throw new Error(`duplicate tool registration: ${definition.name}`);
				tools.set(definition.name, definition);
			}
		},
		systemPrompt: {
			section(section) {
				sections.push(section);
			}
		},
		get(name) {
			return store.get(name);
		},
		inject(names, callback) {
			if (names.every((name) => store.has(name))) callback(child(names));
			return () => {};
		},
		effect(fn) {
			return disposer(fn());
		},
		logger: { warn() {} },
		toolsByName: tools,
		sections,
		services: store
	};
}

/** Wrap an effect return value as a disposer. */
function disposer(value) {
	return () => {
		if (typeof value === 'function') value();
	};
}

/**
 * Build the entry config the way a DSH 2.x host hands it to `apply`.
 *
 * Every `meta.volatile` field resolves to a cosmokit volatile reference, so the
 * plugin has to unwrap it on each read for a settings write to be visible
 * without a restart. `store` stands in for the host's live values and is what
 * the fake settings service mutates on `update`.
 * @param {object} values - entry config overrides.
 * @returns {{ refs: object, store: object }} the reference view and the live store.
 */
function volatileConfig(values) {
	const store = { ...plugin.Config(values) };
	const refs = {};
	for (const [key, value] of Object.entries(store)) refs[key] = { get: () => store[key] };
	return { refs, store };
}

/**
 * Minimal DSH 2.x settings service: a page per profile entry id, no `register`.
 *
 * The real service derives the page from the plugin's exported `Config` and
 * reports it under the owning entry's id, so `update` writes straight into the
 * live store (which is what the host does to the volatile references).
 * @param {{ ns: string, store: object }} entry - the page this service exposes.
 */
function fakeSettings(entry) {
	const watchers = [];
	let revision = 0;
	return {
		/** Present only so a regression that calls it is loud rather than silent. */
		register() {
			throw new Error('ctx.settings.register must not be called: DSH 2.x removed it');
		},
		describe(options) {
			const value = { ...entry.store };
			if (options?.redactSecrets === true) {
				value.pubmedApiKey = undefined;
				value.scholarSerpApiKey = undefined;
			}
			return [
				{
					ns: entry.ns,
					revision,
					value,
					base: {},
					user: {},
					applies: 'live',
					secrets: [{ path: ['pubmedApiKey'], set: false }]
				}
			];
		},
		async update(ns, patch, expectedRevision) {
			if (ns !== entry.ns) throw new Error(`unknown settings namespace "${ns}"`);
			if (expectedRevision !== undefined && expectedRevision !== revision) {
				const error = new Error('settings conflict');
				error.name = 'SettingsConflictError';
				error.code = 'SETTINGS_CONFLICT';
				error.actual = revision;
				throw error;
			}
			revision += 1;
			Object.assign(entry.store, patch);
			for (const watcher of watchers) watcher(patch);
		},
		revision: () => revision
	};
}

/**
 * Mount one plugin instance against a host-like settings service.
 * @param {object} [services] - extra services (credentials, webServer, …).
 * @param {object} [config] - entry config overrides.
 * @returns {{ ctx: object, settings: object, refs: object, store: object }} the wiring.
 */
function mountPlugin(services = {}, config = {}) {
	const { refs, store } = volatileConfig(config);
	const settings = fakeSettings({ ns: plugin.SETTINGS_NS, store });
	const ctx = stubContext({ ...services, settings });
	plugin.apply(ctx, refs);
	return { ctx, settings, refs, store };
}

/** Minimal credentials service that records writes. */
function fakeCredentials() {
	const values = new Map();
	const calls = [];
	return {
		calls,
		async resolve(ref) {
			const value = values.get(ref);
			return value === undefined ? undefined : { value, source: 'file' };
		},
		async describe(ref) {
			return values.has(ref) ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true };
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

/** Minimal web server that records the routes a plugin mounts. */
function fakeWebServer() {
	const routes = [];
	return {
		host: '127.0.0.1',
		port: 3080,
		routes,
		register(route) {
			routes.push(route);
			return () => {};
		}
	};
}

/** Minimal E-utilities + Scholar responses keyed by URL fragment. */
const ESARCH = {
	header: { type: 'esearch', version: '0.3' },
	esearchresult: { count: '25683', retmax: '2', retstart: '0', idlist: ['33301246', '33449100'] }
};

const ESUMMARY = {
	header: { type: 'esummary', version: '0.3' },
	result: {
		uids: ['33301246', '33449100'],
		33301246: {
			uid: '33301246',
			title: 'Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine.',
			authors: [{ name: 'Polack FP' }, { name: 'Thomas SJ' }],
			pubdate: '2020 Dec 31',
			fulljournalname: 'The New England journal of medicine',
			volume: '383',
			issue: '27',
			pages: '2603-2615',
			pubtype: ['Journal Article'],
			articleids: [
				{ idtype: 'doi', value: '10.1056/NEJMoa2034577' },
				{ idtype: 'pmc', value: 'PMC7745181' }
			]
		},
		33449100: {
			uid: '33449100',
			title: 'CRISPR/Cas9 and base editing in cancer.',
			authors: [{ name: 'Renz J' }, { name: 'Herold MJ' }],
			pubdate: '2021 Jan 15',
			fulljournalname: 'Biochemical Society transactions',
			articleids: [{ idtype: 'doi', value: '10.1042/BST20200550' }]
		}
	}
};

const ELINK = {
	linksets: [
		{
			dbfrom: 'pubmed',
			ids: ['33301246'],
			linksetdbs: [{ dbto: 'pubmed', linkname: 'pubmed_pubmed', links: ['33301246', '33449100'] }]
		}
	]
};

/** Replace global fetch for the duration of `fn`. */
async function withStubbedFetch(routes, fn) {
	const original = globalThis.fetch;
	const seen = [];
	globalThis.fetch = async (url) => {
		const href = String(url);
		seen.push(href);
		for (const [fragment, payload] of routes) {
			if (href.includes(fragment)) {
				const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
				return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
			}
		}
		return new Response(`no stub for ${href}`, { status: 404 });
	};
	try {
		return await fn(seen);
	} finally {
		globalThis.fetch = original;
	}
}

const routes = [
	['esearch.fcgi', ESARCH],
	['esummary.fcgi', ESUMMARY],
	['efetch.fcgi', medlineFixture],
	['elink.fcgi', ELINK],
	['/scholar?', scholarHtml],
	['serpapi.com/search.json', serpApiFixture]
];

const suite = createSuite('plugin');

suite.test('exposes the cordis contract and registers five tools', () => {
	assert.equal(plugin.name, 'literature-search');
	assert.deepEqual(plugin.inject, ['tools', 'systemPrompt']);
	assert.equal(typeof plugin.apply, 'function');
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({}));
	assert.deepEqual([...ctx.toolsByName.keys()].sort(), ['pubmed_paper', 'pubmed_related', 'pubmed_search', 'scholar_cite', 'scholar_search']);
	assert.equal(ctx.sections.length, 1);
	assert.equal(ctx.sections[0].name, 'tool:literature-search');
	assert.equal(ctx.sections[0].order, 155);
	assert.match(ctx.sections[0].text, /pubmed_search/);
	assert.match(ctx.sections[0].text, /scholar_search/);
});

suite.test('every tool exposes a closed output schema and declared parameters', () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({}));
	for (const [toolName, definition] of ctx.toolsByName) {
		assert.equal(definition.parameters.type, 'object', `${toolName} parameters root`);
		assert.equal(definition.output.schema.type, 'object', `${toolName} output root`);
		assert.equal(definition.output.schema.additionalProperties, false, `${toolName} output must be closed`);
		assert.equal(typeof definition.output.render, 'function', `${toolName} render`);
		assert.equal(typeof definition.execute, 'function', `${toolName} execute`);
	}
	const search = ctx.toolsByName.get('pubmed_search');
	assert.deepEqual(search.parameters.required, ['query']);
	assert.deepEqual(search.parameters.properties.sort.enum, ['relevance', 'pub_date', 'Author', 'JournalName']);
});

suite.test('pubmed_search runs esearch + esummary + efetch and returns the envelope', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({ pubmedEmail: 'dev@example.com', abstractMaxChars: 200 }));
	const tool = ctx.toolsByName.get('pubmed_search');
	const value = await withStubbedFetch(routes, () => tool.execute({ query: 'CRISPR base editing', max_results: 2 }, { signal: undefined }));
	assert.equal(value.source, 'pubmed');
	assert.equal(value.query, 'CRISPR base editing');
	assert.equal(value.total, 25683);
	assert.equal(value.returned, 2);
	assert.equal(value.offset, 0);
	assert.equal(value.truncated, true);
	assert.equal(value.nextOffset, 2);
	const [first, second] = value.papers;
	assert.equal(first.pmid, '33301246');
	assert.equal(first.doi, '10.1056/NEJMoa2034577');
	assert.equal(first.pmcid, 'PMC7745181');
	assert.equal(first.year, 2020);
	assert.match(first.abstract, /^BACKGROUND:/);
	assert.equal(first.meshTerms.includes('COVID-19'), true);
	assert.equal(second.title, 'CRISPR/Cas9 and base editing in cancer.');
	assertOutput(tool, value);
	const text = tool.output.render({}, value)[0].text;
	assert.match(text, /PubMed search: "CRISPR base editing"/);
	assert.match(text, /25,683 total matches/);
	assert.match(text, /PMID: 33301246/);
});

suite.test('pubmed_search honours with_abstract=false (no efetch request)', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({}));
	const tool = ctx.toolsByName.get('pubmed_search');
	await withStubbedFetch(routes, async (seen) => {
		const value = await tool.execute({ query: 'test', with_abstract: false }, { signal: undefined });
		assert.equal(seen.some((url) => url.includes('efetch.fcgi')), false);
		assert.equal(value.papers[0].abstract, undefined);
		assert.equal(value.papers[0].doi, '10.1056/NEJMoa2034577');
		assertOutput(tool, value);
	});
});

suite.test('pubmed_paper returns full detail plus references', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({}));
	const tool = ctx.toolsByName.get('pubmed_paper');
	const value = await withStubbedFetch(routes, () => tool.execute({ pmid: '33301246' }, { signal: undefined }));
	assert.equal(value.source, 'pubmed');
	assert.equal(value.paper.pmid, '33301246');
	assert.equal(value.paper.venue, 'The New England journal of medicine');
	assert.deepEqual(value.paper.publicationTypes, ['Clinical Trial, Phase III', 'Journal Article', 'Randomized Controlled Trial']);
	assert.equal(value.references.length, 1);
	assertOutput(tool, value);
	const text = tool.output.render({}, value)[0].text;
	assert.match(text, /PubMed record: Safety and Efficacy/);
	assert.match(text, /References \(1\)/);
});

suite.test('pubmed_paper rejects a non-numeric pmid', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({}));
	const tool = ctx.toolsByName.get('pubmed_paper');
	await assert.rejects(() => tool.execute({ pmid: 'not-a-pmid' }, { signal: undefined }), /numeric PubMed identifier/);
});

suite.test('pubmed_related walks elink and resolves the summaries', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({}));
	const tool = ctx.toolsByName.get('pubmed_related');
	const value = await withStubbedFetch(routes, () => tool.execute({ pmid: '33301246', max_results: 5 }, { signal: undefined }));
	assert.equal(value.papers.length, 1);
	assert.equal(value.papers[0].pmid, '33449100');
	assertOutput(tool, value);
	assert.match(tool.output.render({}, value)[0].text, /PubMed related search/);
});

suite.test('pubmed_search rejects bad dates and inverted ranges', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({}));
	const tool = ctx.toolsByName.get('pubmed_search');
	await assert.rejects(() => tool.execute({ query: 'x', min_date: 'yesterday' }, { signal: undefined }), /min_date must be YYYY/);
	await assert.rejects(() => tool.execute({ query: 'x', min_date: '2024', max_date: '2020' }, { signal: undefined }), /must not be later/);
});

suite.test('scholar_search parses the HTML backend and reports truncation', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({ scholarProvider: 'html' }));
	const tool = ctx.toolsByName.get('scholar_search');
	const value = await withStubbedFetch(routes, () => tool.execute({ query: 'CRISPR base editing', max_results: 3 }, { signal: undefined }));
	assert.equal(value.source, 'google-scholar');
	assert.equal(value.papers.length, 3);
	assert.equal(value.papers[0].title, 'Attention is all you need');
	assert.equal(value.papers[0].citationCount, 120543);
	assert.equal(value.papers[0].pdfUrl, 'https://example.org/vaswani2017.pdf');
	assertOutput(tool, value);
	const text = tool.output.render({}, value)[0].text;
	assert.match(text, /Google Scholar search/);
	assert.match(text, /cited by 120543/);
});

suite.test('scholar_search uses SerpApi when a key resolves', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({ scholarProvider: 'auto', scholarSerpApiKey: 'test-key' }));
	const tool = ctx.toolsByName.get('scholar_search');
	await withStubbedFetch(routes, async (seen) => {
		const value = await tool.execute({ query: 'CRISPR base editing' }, { signal: undefined });
		assert.equal(seen.some((url) => url.includes('serpapi.com/search.json')), true);
		assert.equal(seen.some((url) => url.includes('/scholar?')), false);
		assert.equal(value.papers[0].resultId, 'abc123xyz');
		assert.equal(value.papers[0].venue, 'Nature');
		assert.equal(value.papers[0].citationCount, 3120);
		assertOutput(tool, value);
	});
});

suite.test('scholar_cite formats citation styles from SerpApi', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({ scholarSerpApiKey: 'test-key' }));
	const tool = ctx.toolsByName.get('scholar_cite');
	const citePayload = {
		citations: [
			{ title: 'MLA', snippet: 'Komor, Alexis C., et al. "Programmable editing." Nature, 2016.' },
			{ title: 'APA', snippet: 'Komor, A. C., et al. (2016). Programmable editing. Nature.' }
		],
		links: [{ name: 'BibTeX', link: 'https://scholar.googleusercontent.com/scholar.bib?q=info:abc' }]
	};
	await withStubbedFetch([['serpapi.com/search.json', citePayload]], async () => {
		const value = await tool.execute({ result_id: 'abc123xyz' }, { signal: undefined });
		assert.equal(value.references.length, 3);
		assertOutput(tool, value);
		assert.match(value.references[0], /^MLA: Komor/);
		assert.match(tool.output.render({}, value)[0].text, /Google Scholar citations/);
	});
});

suite.test('scholar_cite explains that HTML mode has no citation API', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({ scholarProvider: 'html' }));
	const tool = ctx.toolsByName.get('scholar_cite');
	await assert.rejects(() => tool.execute({ result_id: 'abc' }, { signal: undefined }), /needs scholarProvider "serpapi"/);
});

suite.test('scholarProvider=serpapi without a key fails with guidance', async () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({ scholarProvider: 'serpapi' }));
	const tool = ctx.toolsByName.get('scholar_search');
	await assert.rejects(() => tool.execute({ query: 'x' }, { signal: undefined }), /no key was found/);
});

suite.test('config validation rejects impossible limits and bad providers', () => {
	const ctx = stubContext();
	assert.throws(() => plugin.apply(ctx, plugin.Config({ defaultMaxResults: 10, maxResultsCap: 5 })), /must not exceed maxResultsCap/);
	assert.throws(() => plugin.apply(ctx, plugin.Config({ scholarProvider: 'bing' })), /scholarProvider must be one of/);
	assert.throws(() => plugin.apply(ctx, plugin.Config({ pubmedBaseUrl: 'not a url' })), /is not a valid URL/);
	assert.throws(() => plugin.apply(ctx, plugin.Config({ toolTimeoutMs: 0 })), /toolTimeoutMs must be a positive integer/);
});

suite.test('enabled=false registers nothing', () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({ enabled: false }));
	assert.equal(ctx.toolsByName.size, 0);
	assert.equal(ctx.sections.length, 0);
});

suite.test('capabilities can be disabled independently', () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({ scholarEnabled: false }));
	assert.deepEqual([...ctx.toolsByName.keys()].sort(), ['pubmed_paper', 'pubmed_related', 'pubmed_search']);
	assert.match(ctx.sections[0].text, /PubMed tools/);
	assert.doesNotMatch(ctx.sections[0].text, /Google Scholar tools/);
});

suite.test('the exported schema marks every field volatile so the host builds a page', () => {
	// DSH only offers a plugin a settings page when its Config carries at least
	// one `meta.volatile` field; a schema without them silently has no page at all.
	const fields = Object.entries(plugin.Config.dict ?? {});
	assert.equal(fields.length > 0, true, 'the Config schema must declare fields');
	const plain = fields.filter(([, field]) => field.meta?.volatile !== true).map(([key]) => key);
	assert.deepEqual(plain, [], `fields missing meta.volatile: ${plain.join(', ')}`);
});

suite.test('a settings service without register mounts the routes and exposes the page', () => {
	const credentials = fakeCredentials();
	const webServer = fakeWebServer();
	// fakeSettings throws if `register` is called: DSH 2.x removed the method and
	// an unguarded call aborts the whole plugin activation.
	const { ctx, settings } = mountPlugin({ credentials, webServer }, { pubmedEmail: 'dev@example.com' });
	const descriptor = settings.describe({ redactSecrets: true })[0];
	assert.equal(descriptor.ns, plugin.SETTINGS_NS);
	assert.equal(descriptor.value.scholarProvider, 'auto');
	assert.equal(descriptor.value.pubmedEmail, 'dev@example.com');
	assert.equal(ctx.toolsByName.size, 5);
	assert.equal(webServer.routes.length, 1);
	assert.equal(webServer.routes[0].kind, 'prefix');
	assert.equal(webServer.routes[0].path, plugin.ROUTE_PREFIX);
});

suite.test('the settings namespace follows the profile entry id', () => {
	// The host keys the page by the entry id, so a renamed entry must still work.
	const withFiber = { fiber: { entry: { options: { id: 'lit-search-renamed' } } } };
	assert.equal(plugin.settingsNamespace(withFiber), 'lit-search-renamed');
	assert.equal(plugin.settingsNamespace({}), plugin.SETTINGS_NS);
	assert.equal(plugin.settingsNamespace({ fiber: { entry: { options: {} } } }), plugin.SETTINGS_NS);
	assert.equal(plugin.settingsNamespace(undefined), plugin.SETTINGS_NS);
});

suite.test('tools still register when the optional seams are absent', () => {
	const ctx = stubContext();
	plugin.apply(ctx, plugin.Config({}));
	assert.equal(ctx.toolsByName.size, 5);
});

suite.test('a settings write switches the Scholar backend live', async () => {
	const { ctx, settings } = mountPlugin({ credentials: fakeCredentials(), webServer: fakeWebServer() }, { scholarProvider: 'auto' });
	const tool = ctx.toolsByName.get('scholar_search');

	await withStubbedFetch(routes, async (seen) => {
		await tool.execute({ query: 'base editing', max_results: 1 }, { signal: undefined });
		assert.equal(seen.some((url) => url.includes('/scholar?')), true, 'HTML backend expected before the key exists');
		assert.equal(seen.some((url) => url.includes('serpapi.com')), false);
	});

	// The settings card's save path: the host mutates the live references, the
	// changed projection drops the cached client, and the next call uses the key.
	await settings.update(plugin.SETTINGS_NS, { scholarSerpApiKey: 'live-key' }, settings.revision());

	await withStubbedFetch(routes, async (seen) => {
		await tool.execute({ query: 'base editing', max_results: 1 }, { signal: undefined });
		assert.equal(seen.some((url) => url.includes('serpapi.com/search.json')), true, 'SerpApi expected after the settings write');
		assert.match(seen.find((url) => url.includes('serpapi.com')), /api_key=live-key/);
	});
});

suite.test('a credential written through the seam is picked up without a restart', async () => {
	const credentials = fakeCredentials();
	await credentials.set('SERPAPI_API_KEY', 'stored-key');
	const { ctx } = mountPlugin({ credentials, webServer: fakeWebServer() }, { scholarProvider: 'auto' });
	const tool = ctx.toolsByName.get('scholar_search');
	await withStubbedFetch(routes, async (seen) => {
		await tool.execute({ query: 'base editing', max_results: 1 }, { signal: undefined });
		const serpUrl = seen.find((url) => url.includes('serpapi.com'));
		assert.notEqual(serpUrl, undefined, 'SerpApi expected when the credential store holds a key');
		assert.match(serpUrl, /api_key=stored-key/);
	});
});

suite.test('a settings write changes the live result limits', async () => {
	const { ctx, settings } = mountPlugin(
		{ credentials: fakeCredentials(), webServer: fakeWebServer() },
		{ defaultMaxResults: 10, maxResultsCap: 50, abstractMaxChars: 40 }
	);
	const tool = ctx.toolsByName.get('pubmed_search');
	await settings.update(plugin.SETTINGS_NS, { maxResultsCap: 1, abstractMaxChars: 0 }, settings.revision());
	await withStubbedFetch(routes, async (seen) => {
		// The stub always answers with two PMIDs, so assert on what the tool asked
		// for (retmax is bounded by the live maxResultsCap) plus the abstract budget.
		const value = await tool.execute({ query: 'crispr', max_results: 25 }, { signal: undefined });
		const esearchUrl = seen.find((url) => url.includes('esearch.fcgi'));
		assert.match(esearchUrl, /retmax=1/, 'the live maxResultsCap must bound the ESearch page');
		assert.equal(value.papers[0].abstract, undefined, 'abstractMaxChars=0 must drop abstracts');
	});
});

suite.test('registration-time switches are read once and never re-register live', async () => {
	// `scholarEnabled` is a restart switch: a live write must not add tools behind
	// the model's back, because the tool registry is built at apply time.
	const { ctx, settings } = mountPlugin({ credentials: fakeCredentials(), webServer: fakeWebServer() }, { scholarEnabled: false });
	assert.deepEqual([...ctx.toolsByName.keys()].sort(), ['pubmed_paper', 'pubmed_related', 'pubmed_search']);
	await settings.update(plugin.SETTINGS_NS, { scholarEnabled: true }, settings.revision());
	assert.deepEqual([...ctx.toolsByName.keys()].sort(), ['pubmed_paper', 'pubmed_related', 'pubmed_search']);
});

if (isMain(import.meta.url)) {
	const result = await suite.run();
	process.exitCode = result.failed > 0 ? 1 : 0;
}
export default suite;
