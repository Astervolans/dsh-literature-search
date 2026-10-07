/**
 * Client-bundle contract tests.
 *
 * The configuration page must load through the DSH module-loader envelope and
 * register into the Plugins panel's `plugins.bundle.config` slot. This suite
 * evaluates the bundle with a stub `window.__ModuleLoader__` and a minimal React
 * shim, then walks the rendered element tree — enough to catch a typo or an
 * undefined reference in the card without a browser.
 *
 * It pins the two identities the registration depends on, because either one
 * drifting silently orphans the page:
 *
 *   * the module-loader `id` against `package.json#name`, which decides whether
 *     the DSH client loader ever arrives the row (see the regression test in the
 *     middle of the file);
 *   * the slot `key` against `package.json#name` too, because
 *     `plugins.bundle.config` addresses a page by the *bundle's package name* —
 *     the same string `@deepseek-ai/dsh-client-ui-plugin-manager` passes as
 *     `entryKey` and gates the section on with `ledger.bundles.has(pkg.name)`.
 *
 * `cordis.patch.yml`'s row id plays no part in either one; `config.test.mjs`
 * pins that file on its own.
 */
import { readFile } from 'node:fs/promises';
import { createSuite, assert, isMain } from './harness.mjs';

/** The manifest is the single source of truth for the client registration id. */
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

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

/** Execute the bundle once against `loader`, as one script tag would. */
async function runClientBundle(loader) {
	const previousWindow = globalThis.window;
	globalThis.window = { __ModuleLoader__: loader };
	try {
		// A unique query defeats the ESM cache, so every call re-evaluates the bundle.
		loadCounter += 1;
		await import(`../lib/client.js?load=${loadCounter}`);
	} finally {
		globalThis.window = previousWindow;
	}
}

/** Load the client bundle with a stub module loader; returns its exports + spec. */
async function loadClientBundle(seedState) {
	const captured = [];
	await runClientBundle({
		load(spec) {
			captured.push(spec);
		}
	});
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

suite.test('the bundle registers under the package name and declares the cordis client face', async () => {
	const { spec, exports } = await loadClientBundle(readyState());
	// The DSH client loader asks for the row by the *package name* it resolved,
	// so any other id leaves the row unarrived and the bundle is loaded twice.
	assert.equal(spec.id, manifest.name, 'the client registration id must equal package.json#name');
	assert.equal(typeof exports.apply, 'function');
	assert.deepEqual(exports.inject, ['slots', 'connection']);
});

suite.test('one execution satisfies the loader row; the retry is the duplicate-registration failure', async () => {
	// The two load-bearing rules of @deepseek-ai/dsh-client-modules, reduced to
	// their observable behaviour: a boot-graph row is keyed by the package name
	// the row resolved to, and registering the same factory twice aborts the
	// page. `arrive(row)` runs the bundle, then asks whether *its* row id came
	// back; on a miss it retries the one-resource URL, and that second
	// execution is the failure users see as "1 entry did not activate".
	//
	// Regression guard for 0.3.0, where the bundle still filed itself under the
	// pre-rename unscoped name while the profile row named the scoped package:
	// the row never arrived, the retry threw
	// `duplicate factory registration for "dsh-literature-search"`, and the
	// desktop host disabled the bundle on the next start.
	const factories = new Set();
	const executed = [];
	const loader = {
		load(spec) {
			executed.push(spec.id);
			if (factories.has(spec.id)) {
				throw new Error(
					`client-modules: duplicate factory registration for "${spec.id}" (bundle executed twice without invalidate?)`
				);
			}
			factories.add(spec.id);
		}
	};

	await runClientBundle(loader);
	assert.deepEqual(executed, [manifest.name], 'the bundle must file exactly one registration under the package name');
	assert.equal(factories.has(manifest.name), true, `the loader row "${manifest.name}" must be registered by one execution`);

	// `arrive()`'s fallback attempt on the same bundle — the crash this guards.
	await assert.rejects(runClientBundle(loader), /duplicate factory registration/);
});

suite.test('apply() registers the configuration on this bundle’s page in the Plugins panel', async () => {
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

	// `plugins.bundle.config` is a keyed slot of the plugin manager's `main` panel
	// entry, and it is one level above the rows: the panel renders it on the
	// *package* page ("the configuration the bundle registered for itself"), ahead
	// of the package's row list. The `settings.plugins.tab` cell of 0.3.x is gone
	// on purpose — the Plugins panel is the surface DSH documents for configuring
	// plugins, and Settings → 内置插件 keeps only the built-in inventory.
	assert.deepEqual(injections, ['plugins.bundle.config']);
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0].options.name, 'plugins.bundle.config');
	assert.equal(typeof registrations[0].component, 'function');
	assert.equal('id' in registrations[0].options, false, 'a keyed slot takes `key`, not `id`');
});

suite.test('the slot key is the bundle package name', async () => {
	// Unlike `plugins.row.config` — keyed `<package name>#<row id>`, which 0.3.3
	// used — this cell is addressed by the package alone: the panel passes
	// `entryKey: pkg.name` and gates the section on `ledger.bundles.has(pkg.name)`.
	// The row id in `cordis.patch.yml` therefore plays no part here.
	const { exports } = await loadClientBundle(readyState());
	assert.equal(exports.CONFIG_KEY, manifest.name);
	assert.equal(exports.CONFIG_KEY, '@astervolans/dsh-literature-search');
});

suite.test('the slot component serves the manager’s two views', async () => {
	const { exports } = await loadClientBundle(readyState());

	// `plugins.bundle.config` only ever dispatches `view: "page"` (its contract
	// says so), but the sibling `plugins.item` cell hands the same props shape to
	// cards that must answer `summary`. That branch has to stay a plain value: the
	// page fetches /config the moment it mounts, so answering a summary by
	// rendering it would double the read.
	const summary = exports.LiteratureSearchConfig({ view: 'summary' });
	assert.equal(typeof summary, 'string');
	assert.match(summary, /PubMed/);

	// `page` is the form, and an unknown/absent view must not silently render
	// nothing — the panel's own JSX path always passes one, a future slot owner
	// might not.
	for (const props of [{ view: 'page' }, {}]) {
		const tree = exports.LiteratureSearchConfig(props);
		assert.equal(typeof tree, 'object');
		assert.equal(tree.type, exports.LiteratureSearchPage);
	}
});

suite.test('one section is a real disclosure the caller controls', async () => {
	const { exports } = await loadClientBundle(readyState());

	const toggles = [];
	const open = exports.ConfigSection({
		title: '通用',
		badge: '已配置',
		open: true,
		onToggle: () => toggles.push('toggled'),
		children: 'body-marker'
	});
	const [openHead, openBody] = open.props.children;
	assert.equal(openHead.type, 'button', 'the header must be a button, so the disclosure is keyboard-reachable');
	assert.equal(openHead.props['aria-expanded'], true);
	assert.equal(collectStrings(openHead).includes('通用'), true);
	assert.equal(collectStrings(openBody).includes('body-marker'), true);
	openHead.props.onClick();
	assert.deepEqual(toggles, ['toggled'], 'the header must call the caller\u2019s toggle');

	// Collapsed: the body is gone, but the badge stays — a collapsed section still
	// has to report whether its key is configured.
	const closed = exports.ConfigSection({ title: '通用', badge: '已配置', open: false, onToggle: () => {}, children: 'body-marker' });
	const [closedHead, closedBody] = closed.props.children;
	assert.equal(closedHead.props['aria-expanded'], false);
	assert.equal(closedBody, null);
	assert.equal(collectStrings(closed).includes('body-marker'), false, 'a collapsed section must not render its fields');
	assert.equal(collectStrings(closed).includes('已配置'), true);
});

suite.test('the page opens with all three sections expanded', async () => {
	// Defaulting to collapsed would hide the keys and backends the page exists to
	// make reachable, so the seed state is open for all three. The shim hands the
	// page's first `useState` the seeded state and every later one its real
	// initial, which is exactly where `openSections` lives.
	const { exports } = await loadClientBundle(readyState());
	const tree = renderDeep(exports.LiteratureSearchPage());
	const heads = collectNodes(tree, 'button').filter((node) => 'aria-expanded' in node.props);
	assert.equal(heads.length, 3, `expected three collapsible sections, found ${heads.length}`);
	for (const head of heads) assert.equal(head.props['aria-expanded'], true);
	const labels = heads.map((head) => collectStrings(head).join(''));
	for (const expected of ['PubMed', 'Google Scholar', '通用']) {
		assert.equal(labels.some((label) => label.includes(expected)), true, `expected a "${expected}" section header`);
	}
	// Every field is still reachable while they are open.
	const strings = collectStrings(tree).join('\n');
	assert.equal(strings.includes('NCBI API Key'), true);
	assert.equal(strings.includes('SerpApi Key'), true);
	assert.equal(strings.includes('默认返回条数'), true);
});

suite.test('the loading phase renders a placeholder', async () => {
	const { exports } = await loadClientBundle({ phase: 'loading' });
	const tree = exports.LiteratureSearchPage();
	const strings = collectStrings(tree).join(' | ');
	assert.match(strings, /正在加载文献检索配置/);
});

suite.test('the ready phase renders every field group and action', async () => {
	const { exports } = await loadClientBundle(readyState());
	// Deep render: the section titles live on the `ConfigSection` element's own
	// props, so only expanding the component puts them in the walked tree.
	const tree = renderDeep(exports.LiteratureSearchPage());
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
	const strings = collectStrings(exports.LiteratureSearchPage()).join(' | ');
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
	const strings = collectStrings(exports.LiteratureSearchPage()).join('\n');
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
	const tree = renderDeep(exports.LiteratureSearchPage());
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
	const styles = collectStyles(renderDeep(exports.LiteratureSearchPage()));
	assert.equal(styles.length > 0, true);
	for (const style of styles) {
		const fill = String(style.background ?? style.backgroundColor ?? '');
		assert.doesNotMatch(fill, /--dsw-alias-brand-primary/, 'brand-primary is an accent/outline token, never a fill');
	}
});

suite.test('disabled buttons use the first-party 40% opacity', async () => {
	const { exports } = await loadClientBundle(readyState());
	const tree = renderDeep(exports.LiteratureSearchPage());
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
	const styles = collectStyles(renderDeep(exports.LiteratureSearchPage()));
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
