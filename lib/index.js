/**
 * dsh-literature-search — literature search for DeepSeek Harness over the two
 * upstreams that matter here:
 *
 * - **PubMed**: the official NCBI E-utilities (esearch / esummary / efetch /
 *   elink). Free, keyless, documented, 3 requests/second per IP (10 with an
 *   NCBI API key).
 * - **Google Scholar**: no official API exists. This plugin uses SerpApi's
 *   `google_scholar` engine when a key is configured and otherwise parses
 *   `scholar.google.com` HTML directly, reporting Google's rate limiting
 *   honestly instead of silently returning nothing.
 *
 * The plugin also owns the `literature-search` settings namespace and the
 * `/plugin/literature-search` route tree backing its Settings → Plugins card,
 * so API keys and provider choices are editable in the Web UI. Keys are stored
 * through the credentials seam, never in the settings document.
 *
 * @module dsh-literature-search
 */
import { createRequire } from 'node:module';
import Schema from '@deepseek-ai/schemastery';
import { RateLimiter } from './http.js';
import { clipAbstract } from './paper.js';
import { PubmedClient, applyPubmedTools } from './pubmed.js';
import { ScholarClient, applyScholarTools } from './scholar.js';
import { ROUTE_PREFIX, SETTINGS_NS, mountHttp } from './web.js';

const require = createRequire(import.meta.url);

/** Cordis plugin name used by loader diagnostics. */
export const name = 'literature-search';

/**
 * Services required before `apply` runs. `settings`, `credentials` and the web
 * server are consumed through `ctx.inject`, so the plugin also runs — with
 * tools only — in compositions that lack them.
 */
export const inject = ['tools', 'systemPrompt'];

/** Version sent as `User-Agent` and shown on the settings card. */
export const VERSION = require('../package.json').version ?? '0.1.0';

/** Settings namespace and route prefix owned by this plugin; re-exported for tests. */
export { SETTINGS_NS, ROUTE_PREFIX };

/** Prompt order of the guidance section (after the web tools and ai4scholar). */
const PROMPT_ORDER = 155;

/** Credential references must look like POSIX environment variable names. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Accepted `scholarProvider` values. */
export const SCHOLAR_PROVIDERS = ['auto', 'serpapi', 'html'];

/**
 * Mark one field live-editable.
 *
 * DSH derives a plugin's Settings → Plugins page from its exported `Config`:
 * the settings service only offers the fields carrying `meta.volatile`
 * (see `volatileForm` in `@deepseek-ai/dsh-settings`), and the loader turns
 * those fields into live references instead of plain values. A plugin whose
 * schema has no volatile field therefore has **no** settings page at all.
 *
 * `.volatile()` exists in schemastery >= 3.18.4 only, and a profile can hoist an
 * older copy (3.18.2, which still satisfies `^3.18.1`) above the installation's
 * one — so the guard matters: an unguarded call fails plugin activation with
 * `TypeError: ...volatile is not a function`. `.extra('volatile', true)` writes
 * the same `meta.volatile` flag on every version, so the page appears either
 * way; only hot-edit needs the newer copy.
 *
 * @template T
 * @param {T} field - one schemastery field.
 * @returns {T} the field, flagged volatile when the copy supports it.
 */
function live(field) {
	if (typeof field?.volatile === 'function') return field.volatile();
	if (typeof field?.extra === 'function') return field.extra('volatile', true);
	return field;
}

/**
 * Unwrap one live configuration reference.
 *
 * A `meta.volatile` field resolves to a cosmokit volatile reference rather than
 * a value; reading it through `get()` is what makes a settings write visible to
 * the very next tool call. Plain values (older schemastery, or a composition
 * that never marked the field) pass through unchanged.
 *
 * @param {unknown} value - a reference or a plain value.
 * @returns {unknown} the current value.
 */
export function unwrapField(value) {
	return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * Project the entry config into plain values.
 * @param {object} [config] - the config handed to `apply` (volatile fields are references).
 * @returns {object} a plain, detached configuration object.
 */
export function plainConfig(config) {
	const out = {};
	for (const [key, value] of Object.entries(config ?? {})) out[key] = unwrapField(value);
	return out;
}

/**
 * Plugin configuration; also the schema of the `literature-search` settings
 * namespace. Every field is live (see {@link live}) so the whole card hot-applies
 * except the registration-time switches, which the page flags as restart-only.
 */
export const Config = Schema.object({
	enabled: live(Schema.boolean().default(true).description('Register the literature-search tools at all (restart required).')),
	pubmedEnabled: live(Schema.boolean().default(true).description('Register the PubMed tools (restart required).')),
	pubmedBaseUrl: live(Schema.string().default('https://eutils.ncbi.nlm.nih.gov/entrez/eutils').description('E-utilities endpoint root.')),
	pubmedTool: live(Schema.string().default('dsh-literature-search').description('Value of the E-utilities `tool` parameter.')),
	pubmedEmail: live(Schema.string().default('').description('Value of the E-utilities `email` parameter; NCBI asks that it be a real contact address.')),
	pubmedApiKeyEnv: live(Schema.string().default('NCBI_API_KEY').description('Credential reference holding an NCBI API key (raises the rate limit from 3/s to 10/s).')),
	pubmedApiKey: live(Schema.string().default('').role('secret').description('Inline NCBI API key; overrides pubmedApiKeyEnv (prefer the credential field on the card).')),
	pubmedRateLimitMs: live(Schema.number().default(0).description('Minimum spacing between E-utilities calls (0 = 350 ms keyless, 110 ms with a key).')),
	scholarEnabled: live(Schema.boolean().default(true).description('Register the Google Scholar tools (restart required).')),
	scholarProvider: live(Schema.string().default('auto').description('auto | serpapi | html. "auto" uses SerpApi when a key resolves, otherwise HTML.')),
	scholarBaseUrl: live(Schema.string().default('https://scholar.google.com').description('Google Scholar origin used by the HTML backend.')),
	scholarSerpApiBaseUrl: live(Schema.string().default('https://serpapi.com').description('SerpApi origin.')),
	scholarSerpApiKeyEnv: live(Schema.string().default('SERPAPI_API_KEY').description('Credential reference holding a SerpApi key (Google Scholar backend).')),
	scholarSerpApiKey: live(Schema.string().default('').role('secret').description('Inline SerpApi key; overrides scholarSerpApiKeyEnv (prefer the credential field on the card).')),
	scholarHl: live(Schema.string().default('en').description('Google Scholar interface language (`hl`).')),
	scholarRateLimitMs: live(Schema.number().default(0).description('Minimum spacing between Scholar requests (0 = 2500 ms HTML, 250 ms SerpApi).')),
	defaultMaxResults: live(Schema.number().default(10).description('Papers returned when the model omits max_results.')),
	maxResultsCap: live(Schema.number().default(50).description('Upper bound the model may request per call.')),
	abstractMaxChars: live(Schema.number().default(600).description('Abstract/snippet characters per paper; 0 omits them.')),
	requestTimeoutMs: live(Schema.number().default(30000).description('Per-attempt HTTP timeout (ms).')),
	maxRetries: live(Schema.number().default(3).description('Attempts for retryable failures.')),
	retryBackoffMs: live(Schema.number().default(1000).description('Base retry delay (ms); doubles per attempt.')),
	toolTimeoutMs: live(Schema.number().default(120000).description('Cooperative per-call budget (ms; applies at registration, restart to change).')),
	userAgent: live(Schema.string().default('').description('Override the default User-Agent (defaults to a current desktop Chrome UA).')),
	promptGuidance: live(Schema.boolean().default(true).description('Register the system-prompt guidance section (restart required).')),
	promptOrder: live(Schema.number().default(PROMPT_ORDER).description('Order of the guidance section within the assembled prompt (restart required).'))
});

/** A current desktop UA; the Scholar HTML endpoint rejects obvious bot agents. */
const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Reject non-positive integers with a configuration-specific message. */
function assertPositiveInteger(field, value) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`literature-search: ${field} must be a positive integer`);
}

/** Reject negative numbers. */
function assertNonNegative(field, value) {
	if (!Number.isFinite(value) || value < 0) throw new Error(`literature-search: ${field} must be a non-negative number`);
}

/** Validate an absolute HTTP(S) URL. */
function assertUrl(field, value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`literature-search: ${field} "${value}" is not a valid URL`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error(`literature-search: ${field} must use http or https`);
	}
	return parsed.toString().replace(/\/+$/, '');
}

/**
 * Validate one resolved configuration object. Used by the loader at mount time
 * and by the settings seam on every write, so a bad value from the card is
 * rejected before it is persisted.
 * @param {object} value - candidate configuration.
 * @returns {object} the same value when valid.
 */
export function validateConfig(value) {
	for (const field of ['defaultMaxResults', 'maxResultsCap', 'requestTimeoutMs', 'toolTimeoutMs']) {
		assertPositiveInteger(field, value[field]);
	}
	if (!Number.isInteger(value.maxRetries) || value.maxRetries < 0) {
		throw new Error('literature-search: maxRetries must be a non-negative integer');
	}
	for (const field of ['abstractMaxChars', 'retryBackoffMs', 'pubmedRateLimitMs', 'scholarRateLimitMs']) {
		assertNonNegative(field, value[field]);
	}
	if (!Number.isFinite(value.promptOrder)) throw new Error('literature-search: promptOrder must be a finite number');
	if (value.defaultMaxResults > value.maxResultsCap) throw new Error('literature-search: defaultMaxResults must not exceed maxResultsCap');
	if (typeof value.scholarProvider !== 'string' || !SCHOLAR_PROVIDERS.includes(value.scholarProvider)) {
		throw new Error(`literature-search: scholarProvider must be one of ${SCHOLAR_PROVIDERS.join(', ')}`);
	}
	assertUrl('pubmedBaseUrl', value.pubmedBaseUrl);
	assertUrl('scholarBaseUrl', value.scholarBaseUrl);
	assertUrl('scholarSerpApiBaseUrl', value.scholarSerpApiBaseUrl);
	return value;
}

/**
 * Resolve one secret: inline config first, then the credentials service, then
 * the ambient environment. Never throws, so a missing key degrades to a
 * capability message instead of a broken plugin.
 * @param {object} ctx - plugin context; `credentials` is optional.
 * @param {string} ref - credential reference (an environment-variable name).
 * @param {string} [inline] - inline key from the configuration, if any.
 * @param {object} [service] - credentials service captured from an injected context.
 * @returns {Promise<string|undefined>} the secret value.
 */
export async function resolveSecret(ctx, ref, inline, service) {
	const direct = typeof inline === 'string' ? inline.trim() : '';
	if (direct.length > 0) return direct;
	if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return undefined;
	const credentials = service ?? ctx.get('credentials');
	if (credentials !== undefined && typeof credentials.resolve === 'function') {
		try {
			const hit = await credentials.resolve(ref);
			if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value;
		} catch {
			// A rejection here means "no stored credential"; fall through to the environment.
		}
	}
	const ambient = process.env[ref];
	return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined;
}

/** Bound the model's requested count to `[1, maxResultsCap]`. */
function boundResults(requested, limits) {
	if (requested === undefined) return Math.min(limits.defaultMaxResults, limits.maxResultsCap);
	if (!Number.isFinite(requested) || requested < 1) return 1;
	return Math.min(Math.trunc(requested), limits.maxResultsCap);
}

/**
 * Resolve the settings namespace the host keys this plugin's page by.
 *
 * DSH 2.x derives a plugin's Settings → Plugins page from its profile entry:
 * `describe()` reports every descriptor under `entry.options.id` and writes go
 * back to the same id. The plugin's own `/config` route must therefore look its
 * page up under that id, not under a constant that only matches the id the
 * installer happened to write.
 *
 * @param {object} ctx - plugin context.
 * @returns {string} the profile entry id, or {@link SETTINGS_NS} when unreadable.
 */
export function settingsNamespace(ctx) {
	try {
		const id = ctx?.fiber?.entry?.options?.id;
		if (typeof id === 'string' && id.length > 0) return id;
	} catch {
		// A fiber with no owning entry (or an unreadable computed id) falls back.
	}
	return SETTINGS_NS;
}

/**
 * Validate the config, build the runtime, and register the enabled tools.
 * Every registration is an effect on `ctx`, so disposing the plugin fiber
 * removes the tools, the prompt section and the settings routes together.
 *
 * @param {object} ctx - plugin context with `tools` and `systemPrompt` ready.
 * @param {object} config - entry config; `meta.volatile` fields are live references.
 */
export function apply(ctx, config) {
	// Registration-time decisions are read once: enabling or disabling a
	// capability is a restart switch, so a live write must never re-register
	// (or silently drop) tools behind the model's back.
	const boot = plainConfig(config);
	if (!boot.enabled) return;
	validateConfig(boot);

	// The entry config is the single source of configuration. Volatile fields
	// arrive as live references, so every read re-projects them and a settings
	// write is visible to the very next tool call. A changed projection drops the
	// cached clients, which is how a new key or provider takes effect immediately.
	let lastSignature = '';
	let pubmedClient;
	let scholarClient;
	const invalidate = () => {
		pubmedClient = undefined;
		scholarClient = undefined;
	};
	const configNow = () => {
		const next = plainConfig(config);
		const signature = JSON.stringify(next);
		if (signature !== lastSignature) {
			lastSignature = signature;
			invalidate();
		}
		return next;
	};
	configNow();

	const limits = {
		get defaultMaxResults() {
			return configNow().defaultMaxResults;
		},
		get maxResultsCap() {
			return configNow().maxResultsCap;
		}
	};

	const runtime = {
		/** Live configuration (volatile fields re-read on every access). */
		config: configNow,
		limits,
		timeouts: { tool: boot.toolTimeoutMs },
		/** Clip abstracts/snippets to the configured budget. */
		clipPapers(papers) {
			const budget = configNow().abstractMaxChars;
			if (budget <= 0) {
				return papers.map((paper) => {
					if (paper.abstract === undefined) return paper;
					const { abstract: _drop, ...rest } = paper;
					return rest;
				});
			}
			return papers.map((paper) => (paper.abstract === undefined ? paper : { ...paper, abstract: clipAbstract(paper.abstract, budget) }));
		},
		boundResults: (requested) => boundResults(requested, limits),
		/** Lazily build the E-utilities client; config and keys are re-read per build. */
		async pubmed() {
			if (pubmedClient !== undefined) return pubmedClient;
			const cfg = configNow();
			const apiKey = await resolveSecret(ctx, cfg.pubmedApiKeyEnv, cfg.pubmedApiKey, credentialsService);
			const interval = cfg.pubmedRateLimitMs > 0 ? cfg.pubmedRateLimitMs : apiKey === undefined ? 350 : 110;
			pubmedClient = new PubmedClient({
				baseUrl: assertUrl('pubmedBaseUrl', cfg.pubmedBaseUrl),
				tool: cfg.pubmedTool.trim().length > 0 ? cfg.pubmedTool.trim() : 'dsh-literature-search',
				email: cfg.pubmedEmail.trim().length > 0 ? cfg.pubmedEmail.trim() : undefined,
				apiKey,
				timeoutMs: cfg.requestTimeoutMs,
				maxRetries: cfg.maxRetries,
				retryBackoffMs: cfg.retryBackoffMs,
				userAgent: `dsh-literature-search/${VERSION}`,
				limiter: new RateLimiter(interval)
			});
			return pubmedClient;
		},
		/** Lazily build the Scholar client; config and keys are re-read per build. */
		async scholar() {
			if (scholarClient !== undefined) return scholarClient;
			const cfg = configNow();
			const serpApiKey = await resolveSecret(ctx, cfg.scholarSerpApiKeyEnv, cfg.scholarSerpApiKey, credentialsService);
			const provider = cfg.scholarProvider;
			const agent = cfg.userAgent.trim().length > 0 ? cfg.userAgent.trim() : DEFAULT_USER_AGENT;
			const interval =
				cfg.scholarRateLimitMs > 0
					? cfg.scholarRateLimitMs
					: provider === 'serpapi' || (provider === 'auto' && serpApiKey !== undefined)
						? 250
						: 2500;
			scholarClient = new ScholarClient({
				provider,
				baseUrl: assertUrl('scholarBaseUrl', cfg.scholarBaseUrl),
				serpApiBaseUrl: assertUrl('scholarSerpApiBaseUrl', cfg.scholarSerpApiBaseUrl),
				serpApiKey,
				hl: cfg.scholarHl.trim().length > 0 ? cfg.scholarHl.trim() : 'en',
				timeoutMs: cfg.requestTimeoutMs,
				maxRetries: cfg.maxRetries,
				retryBackoffMs: cfg.retryBackoffMs,
				userAgent: agent,
				limiter: new RateLimiter(interval)
			});
			return scholarClient;
		}
	};

	if (boot.pubmedEnabled) applyPubmedTools(ctx, runtime);
	if (boot.scholarEnabled) applyScholarTools(ctx, runtime);

	if (boot.promptGuidance) {
		const guidance = buildGuidance(boot);
		if (guidance !== undefined) {
			ctx.systemPrompt.section({
				name: 'tool:literature-search',
				order: boot.promptOrder,
				text: guidance
			});
		}
	}

	// Optional seams: without them the plugin still registers its tools.
	// Both services are captured from their injected contexts rather than through
	// `ctx.get`, which is the composition-safe way to reach a sibling plugin's
	// service (and the one the first-party plugins use).
	//
	// There is deliberately no `ctx.settings.register` here: DSH 2.x removed that
	// service method (it now throws `TypeError: ctx.settings.register is not a
	// function` and aborts the whole plugin), and the settings page is derived
	// from the exported `Config` instead. What the page needs is a namespace equal
	// to this entry's id — which is what `settingsNs` resolves below.
	let settingsService;
	let credentialsService;

	ctx.inject(['settings'], (settingsCtx) => {
		settingsService = settingsCtx.settings;
	});

	ctx.inject(['credentials'], (credentialsCtx) => {
		credentialsService = credentialsCtx.credentials;
	});

	ctx.inject(['webServer'], (webCtx) => {
		mountHttp(webCtx, {
			// Resolved per request so a seam that appears after mount is picked up.
			services: () => ({ settings: settingsService ?? ctx.get('settings'), credentials: credentialsService ?? ctx.get('credentials') }),
			// The settings service keys a plugin's page by its profile entry id, so
			// the routes must look the page up under that id rather than a constant.
			settingsNs: settingsNamespace(ctx),
			runtime,
			defaults: {
				pubmedBaseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
				scholarBaseUrl: 'https://scholar.google.com',
				scholarSerpApiBaseUrl: 'https://serpapi.com',
				defaultMaxResults: 10,
				maxResultsCap: 50,
				abstractMaxChars: 600,
				requestTimeoutMs: 30000,
				maxRetries: 3,
				retryBackoffMs: 1000
			},
			version: VERSION
		});
	});
}

/** Compose the system-prompt guidance section from the enabled capabilities. */
export function buildGuidance(config) {
	const lines = [];
	if (config.pubmedEnabled) {
		lines.push(
			'PubMed tools (pubmed_*) query the official NCBI E-utilities API: pubmed_search (field-tagged queries, date window, sort, paging), '
				+ 'pubmed_paper (one PMID in full: abstract, MeSH, keywords, publication types), pubmed_related (NCBI related-article ranking). '
				+ 'Free and keyless; results carry PMID and DOI so they can be cited directly.'
		);
	}
	if (config.scholarEnabled) {
		lines.push(
			'Google Scholar tools (scholar_*): scholar_search returns title, authors, venue, year, cited-by count, snippet and PDF link; '
				+ 'scholar_cite returns formatted citations for one result id (SerpApi backend only). Google publishes no Scholar API, so a '
				+ 'SerpApi key is preferred; without one the HTML backend may be rate-limited (HTTP 429) and will say so instead of returning nothing.'
		);
	}
	if (lines.length === 0) return undefined;
	return lines.join(' ');
}
