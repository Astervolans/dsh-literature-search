/**
 * Client-bundle contract tests.
 *
 * The Settings → Plugins card must load through the DSH module-loader envelope
 * and register into the `settings.plugins.tab` slot. This suite evaluates the
 * bundle with a stub `window.__ModuleLoader__` and a minimal React shim, then
 * walks the rendered element tree — enough to catch a typo or an undefined
 * reference in the card without a browser.
 */
import { createSuite, assert, isMain } from './harness.mjs';

/** Collect every string rendered anywhere in an element tree. */
function collectStrings(node, out = []) {
	if (node === null || node === undefined || typeof node === 'boolean') return out;
	if (typeof node === 'string' || typeof node === 'number') {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) collectStrings(child, out);
		return out;
	}
	if (typeof node === 'object') {
		collectStrings(node.props?.children, out);
		if (typeof node.props?.label === 'string') out.push(node.props.label);
		if (typeof node.props?.placeholder === 'string') out.push(node.props.placeholder);
	}
	return out;
}

/** Minimal React shim seeded with one state value so the card renders. */
function createReactShim(seedState) {
	const createElement = (type, props) => ({ type, props: props ?? {} });
	let useStateCalls = 0;
	const React = {
		// The tab's own state is the first hook call of a render pass; later
		// useState calls (the per-slot key drafts) must get their real initial.
		useState: (initial) => {
			useStateCalls += 1;
			return [useStateCalls === 1 ? seedState : initial, () => {}];
		},
		useEffect: () => {},
		useCallback: (fn) => fn,
		useRef: (initial) => ({ current: initial ?? {} })
	};
	const jsxRuntime = {
		jsx: createElement,
		jsxs: createElement,
		Fragment: 'Fragment'
	};
	return { React, jsxRuntime };
}

/**
 * Expand function components the way React would, so nodes owned by child
 * components (the credential fields' buttons) become reachable. Hooks are the
 * shim's, so this is only safe for a single render pass.
 */
function renderDeep(node) {
	if (node === null || node === undefined) return node;
	if (Array.isArray(node)) return node.map(renderDeep);
	if (typeof node !== 'object') return node;
	if (typeof node.type === 'function') return renderDeep(node.type({ ...node.props }));
	return { ...node, props: { ...node.props, children: renderDeep(node.props?.children) } };
}

/** Every node of one element type in a rendered tree. */
function collectNodes(node, type, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out;
	if (Array.isArray(node)) {
		for (const child of node) collectNodes(child, type, out);
		return out;
	}
	if (node.type === type) out.push(node);
	collectNodes(node.props?.children, type, out);
	return out;
}

/** Every inline style object in a rendered tree. */
function collectStyles(node, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out;
	if (Array.isArray(node)) {
		for (const child of node) collectStyles(child, out);
		return out;
	}
	if (node.props?.style !== undefined && typeof node.props.style === 'object') out.push(node.props.style);
	collectStyles(node.props?.children, out);
	return out;
}

/** Bumped per load so each test gets a fresh module instance. */
let loadCounter = 0;

/** Load the client bundle with a stub module loader; returns its exports + spec. */
async function loadClientBundle(seedState) {
	const captured = [];
	const previousWindow = globalThis.window;
	globalThis.window = {
		__ModuleLoader__: {
			load(spec) {
				captured.push(spec);
			}
		}
	};
	try {
		// A unique query defeats the ESM cache, so every test re-evaluates the bundle.
		loadCounter += 1;
		await import(`../lib/client.js?load=${loadCounter}`);
	} finally {
		globalThis.window = previousWindow;
	}
	assert.equal(captured.length, 1, 'the bundle must call window.__ModuleLoader__.load exactly once');
	const spec = captured[0];
	const { React, jsxRuntime } = createReactShim(seedState);
	const exports = spec.factory((name) => {
		if (name === 'react') return React;
		if (name === 'react/jsx-runtime') return jsxRuntime;
		throw new Error(`unexpected require("${name}")`);
	});
	return { spec, exports };
}

/** A realistic "ready" tab state as /config would deliver it. */
function readyState(overrides = {}) {
	return {
		phase: 'ready',
		revision: 7,
		value: {
			pubmedEmail: 'dev@example.com',
			pubmedTool: 'dsh-literature-search',
			pubmedBaseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
			pubmedRateLimitMs: 0,
			scholarProvider: 'auto',
			scholarHl: 'en',
			scholarBaseUrl: 'https://scholar.google.com',
			scholarSerpApiBaseUrl: 'https://serpapi.com',
			scholarRateLimitMs: 0,
			defaultMaxResults: 10,
			maxResultsCap: 50,
			abstractMaxChars: 600,
			requestTimeoutMs: 30000,
			maxRetries: 3,
			retryBackoffMs: 1000,
			userAgent: ''
		},
		base: {},
		user: {},
		facts: {
			pubmed: { enabled: true, baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils', rateLimitMs: 0 },
			scholar: { enabled: true, provider: 'auto' },
			credentials: [
				{ slot: 'pubmed', label: 'NCBI API key', ref: 'NCBI_API_KEY', configured: false, source: null, writable: true, inlineConfigured: false },
				{ slot: 'scholar', label: 'SerpApi key', ref: 'SERPAPI_API_KEY', configured: true, source: 'file', writable: true, inlineConfigured: false }
			]
		},
		schemaHints: { providers: ['auto', 'serpapi', 'html'], restartKeys: ['enabled'], defaults: {} },
		drafts: {},
		saveMsg: null,
		saveErr: null,
		tests: [],
		testErr: null,
		...overrides
	};
}

const suite = createSuite('client bundle');

suite.test('the bundle declares the plugin id and the cordis client face', async () => {
	const { spec, exports } = await loadClientBundle(readyState());
	assert.equal(spec.id, 'dsh-literature-search');
	assert.equal(typeof exports.apply, 'function');
	assert.deepEqual(exports.inject, ['slots', 'connection']);
});

suite.test('apply() registers one settings tab with a stable id and label', async () => {
	const { exports } = await loadClientBundle(readyState());
	const injections = [];
	const registrations = [];
	const ctx = {
		slots: {
			inject(name, callback) {
				injections.push(name);
				callback();
			},
			register(options, component) {
				registrations.push({ options, component });
			}
		}
	};
	exports.apply(ctx);
	assert.deepEqual(injections, ['settings.plugins.tab']);
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0].options.name, 'settings.plugins.tab');
	assert.equal(registrations[0].options.id, 'literature-search');
	assert.equal(registrations[0].options.label, '文献检索');
	assert.equal(typeof registrations[0].options.order, 'number');
	assert.equal(typeof registrations[0].component, 'function');
});

suite.test('the loading phase renders a placeholder', async () => {
	const { exports } = await loadClientBundle({ phase: 'loading' });
	const tree = exports.LiteratureSettingsTab();
	const strings = collectStrings(tree).join(' | ');
	assert.match(strings, /正在加载文献检索配置/);
});

suite.test('the ready phase renders every field group and action', async () => {
	const { exports } = await loadClientBundle(readyState());
	const tree = exports.LiteratureSettingsTab();
	const strings = collectStrings(tree).join('\n');
	for (const expected of [
		'PubMed（NCBI E-utilities）',
		'NCBI API Key',
		'Google Scholar',
		'SerpApi Key',
		'后端选择（scholarProvider）',
		'通用',
		'默认返回条数',
		'单次最多条数',
		'摘要字符上限（0 = 不返回摘要）',
		'保存并应用（无更改）',
		'重新加载',
		'测试 PubMed',
		'测试 Google Scholar'
	]) {
		assert.equal(strings.includes(expected), true, `the card should render "${expected}"`);
	}
	assert.match(strings, /SerpApi 已配置/);
	assert.match(strings, /revision 7/);
});

suite.test('the error phase renders the message and a retry button', async () => {
	const { exports } = await loadClientBundle(readyState({ phase: 'error', saveErr: '加载配置失败：HTTP 503' }));
	const strings = collectStrings(exports.LiteratureSettingsTab()).join(' | ');
	assert.match(strings, /加载配置失败：HTTP 503/);
	assert.match(strings, /重试/);
});

suite.test('test results render with their hints', async () => {
	const { exports } = await loadClientBundle(
		readyState({
			tests: [
				{ target: 'pubmed', ok: true, ms: 120, detail: 'NCBI E-utilities OK — esearch returned 25,683 matches' },
				{ target: 'scholar', ok: false, ms: 30, detail: 'fetch failed', hint: 'Google Scholar is unreachable' }
			]
		})
	);
	const strings = collectStrings(exports.LiteratureSettingsTab()).join('\n');
	assert.match(strings, /E-utilities OK/);
	assert.match(strings, /Google Scholar is unreachable/);
});

suite.test('primary buttons stay legible in both themes', async () => {
	// Regression guard for the dark-mode defect: the first-party pairing is
	// `--dsw-alias-label-primary` fill over `--dsw-alias-bg-layer-3` label, and
	// both swap together per theme. A literal white label is what made the
	// buttons unreadable, because `--dsw-alias-brand-primary` is near-white in
	// dark mode.
	const { exports } = await loadClientBundle(readyState());
	const tree = renderDeep(exports.LiteratureSettingsTab());
	const buttons = collectNodes(tree, 'button');
	assert.equal(buttons.length >= 2, true, `expected buttons in the card, found ${buttons.length}`);
	const primary = buttons.filter((button) => /保存/.test(collectStrings(button).join('')));
	assert.equal(primary.length >= 2, true, 'expected the save-key and save-and-apply buttons');
	for (const button of primary) {
		const style = button.props.style;
		// The defect was a token-driven fill (which flips per theme) next to a
		// literal label (which does not). Both halves must therefore be tokens; a
		// hex value is only acceptable *inside* the var() fallback.
		assert.match(String(style.background), /^var\(--dsw-alias-label-primary/, 'primary fill must be the label-primary token');
		assert.match(String(style.color), /^var\(--dsw-alias-bg-layer-3/, 'primary label must be the paired surface token');
	}
});

suite.test('no style paints a brand token behind a fixed colour', async () => {
	const { exports } = await loadClientBundle(readyState());
	const styles = collectStyles(renderDeep(exports.LiteratureSettingsTab()));
	assert.equal(styles.length > 0, true);
	for (const style of styles) {
		const fill = String(style.background ?? style.backgroundColor ?? '');
		assert.doesNotMatch(fill, /--dsw-alias-brand-primary/, 'brand-primary is an accent/outline token, never a fill');
	}
});

suite.test('disabled buttons use the first-party 40% opacity', async () => {
	const { exports } = await loadClientBundle(readyState());
	const tree = renderDeep(exports.LiteratureSettingsTab());
	const buttons = collectNodes(tree, 'button');
	// The empty key draft leaves "保存密钥" disabled.
	const disabled = buttons.filter((button) => button.props.disabled === true);
	assert.equal(disabled.length > 0, true, 'expected at least one disabled button');
	for (const button of disabled) {
		assert.equal(button.props.style.opacity, 0.4);
		assert.equal(button.props.style.cursor, 'not-allowed');
	}
});

suite.test('status colours come from state tokens, not hardcoded hex', async () => {
	const { exports } = await loadClientBundle(readyState());
	const styles = collectStyles(renderDeep(exports.LiteratureSettingsTab()));
	const flattened = styles.map((style) => `${style.color ?? ''}|${style.background ?? ''}`).join('\n');
	assert.match(flattened, /--dsw-alias-state-(success|error|warn)-primary/);
	// `--dsw-alias-label-error` does not exist in the theme, so it must not be used.
	assert.doesNotMatch(flattened, /--dsw-alias-label-error/);
});

if (isMain(import.meta.url)) {
	const result = await suite.run();
	process.exitCode = result.failed > 0 ? 1 : 0;
}
export default suite;
