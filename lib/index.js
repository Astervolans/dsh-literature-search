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

/** Plugin configuration; also the schema of the `literature-search` settings namespace. */
export const Config = Schema.object({
	enabled: Schema.boolean().default(true).description('Register the literature-search tools at all (restart required).'),
	pubmedEnabled: Schema.boolean().default(true).description('Register the PubMed tools (restart required).'),
	pubmedBaseUrl: Schema.string().default('https://eutils.ncbi.nlm.nih.gov/entrez/eutils').description('E-utilities endpoint root.'),
	pubmedTool: Schema.string().default('dsh-literature-search').description('Value of the E-utilities `tool` parameter.'),
	pubmedEmail: Schema.string().default('').description('Value of the E-utilities `email` parameter; NCBI asks that it be a real contact address.'),
	pubmedApiKeyEnv: Schema.string().default('NCBI_API_KEY').description('Credential reference holding an NCBI API key (raises the rate limit from 3/s to 10/s).'),
	pubmedApiKey: Schema.string().default('').role('secret').description('Inline NCBI API key; overrides pubmedApiKeyEnv (prefer the credential field on the card).'),
	pubmedRateLimitMs: Schema.number().default(0).description('Minimum spacing between E-utilities calls (0 = 350 ms keyless, 110 ms with a key).'),
	scholarEnabled: Schema.boolean().default(true).description('Register the Google Scholar tools (restart required).'),
	scholarProvider: Schema.string().default('auto').description('auto | serpapi | html. "auto" uses SerpApi when a key resolves, otherwise HTML.'),
	scholarBaseUrl: Schema.string().default('https://scholar.google.com').description('Google Scholar origin used by the HTML backend.'),
	scholarSerpApiBaseUrl: Schema.string().default('https://serpapi.com').description('SerpApi origin.'),
	scholarSerpApiKeyEnv: Schema.string().default('SERPAPI_API_KEY').description('Credential reference holding a SerpApi key (Google Scholar backend).'),
	scholarSerpApiKey: Schema.string().default('').role('secret').description('Inline SerpApi key; overrides scholarSerpApiKeyEnv (prefer the credential field on the card).'),
	scholarHl: Schema.string().default('en').description('Google Scholar interface language (`hl`).'),
	scholarRateLimitMs: Schema.number().default(0).description('Minimum spacing between Scholar requests (0 = 2500 ms HTML, 250 ms SerpApi).'),
	defaultMaxResults: Schema.number().default(10).description('Papers returned when the model omits max_results.'),
	maxResultsCap: Schema.number().default(50).description('Upper bound the model may request per call.'),
	abstractMaxChars: Schema.number().default(600).description('Abstract/snippet characters per paper; 0 omits them.'),
	requestTimeoutMs: Schema.number().default(30000).description('Per-attempt HTTP timeout (ms).'),
	maxRetries: Schema.number().default(3).description('Attempts for retryable failures.'),
	retryBackoffMs: Schema.number().default(1000).description('Base retry delay (ms); doubles per attempt.'),
	toolTimeoutMs: Schema.number().default(120000).description('Cooperative per-call budget (ms; applies at registration, restart to change).'),
	userAgent: Schema.string().default('').description('Override the default User-Agent (defaults to a current desktop Chrome UA).'),
	promptGuidance: Schema.boolean().default(true).description('Register the system-prompt guidance section (restart required).'),
	promptOrder: Schema.number().default(PROMPT_ORDER).description('Order of the guidance section within the assembled prompt (restart required).')
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
 * Validate the config, build the runtime, and register the enabled tools.
 * Every registration is an effect on `ctx`, so disposing the plugin fiber
 * removes the tools, the prompt section and the settings namespace together.
 *
 * @param {object} ctx - plugin context with `tools` and `systemPrompt` ready.
 * @param {object} config - schemastery-validated config with defaults applied.
 */
export function apply(ctx, config) {
	const resolved = config;
	if (!resolved.enabled) return;
	validateConfig(resolved);

	const userAgent = resolved.userAgent.trim().length > 0 ? resolved.userAgent.trim() : DEFAULT_USER_AGENT;

	// The settings namespace (when the host serves one) becomes the live source
	// of configuration; the composition entry stays the base layer and fallback.
	let live = resolved;
	const configNow = () => live;
	let pubmedClient;
	let scholarClient;
	const invalidate = () => {
		pubmedClient = undefined;
		scholarClient = undefined;
	};

	const limits = {
		get defaultMaxResults() {
			return configNow().defaultMaxResults;
		},
		get maxResultsCap() {
			return configNow().maxResultsCap;
		}
	};

	const runtime = {
		/** Live configuration (settings-backed when the seam is present). */
		config: configNow,
		limits,
		timeouts: { tool: resolved.toolTimeoutMs },
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
				userAgent,
				limiter: new RateLimiter(interval)
			});
			return scholarClient;
		}
	};

	if (resolved.pubmedEnabled) applyPubmedTools(ctx, runtime);
	if (resolved.scholarEnabled) applyScholarTools(ctx, runtime);

	if (resolved.promptGuidance) {
		const guidance = buildGuidance(resolved);
		if (guidance !== undefined) {
			ctx.systemPrompt.section({
				name: 'tool:literature-search',
				order: resolved.promptOrder,
				text: guidance
			});
		}
	}

	// Optional seams: without them the plugin still registers its tools.
	// Both services are captured from their injected contexts rather than through
	// `ctx.get`, which is the composition-safe way to reach a sibling plugin's
	// service (and the one the first-party plugins use).
	let settingsService;
	let credentialsService;

	ctx.inject(['settings'], (settingsCtx) => {
		settingsService = settingsCtx.settings;
		let scope;
		try {
			scope = settingsCtx.settings.register(SETTINGS_NS, Config, {
				base: resolved,
				applies: 'live',
				validate: validateConfig
			});
		} catch (error) {
			ctx.logger?.warn?.(`literature-search: settings namespace unavailable: ${error?.message ?? error}`);
			return;
		}
		live = scope.get();
		invalidate();
		scope.watch(() => {
			live = scope.get();
			invalidate();
		});
	});

	ctx.inject(['credentials'], (credentialsCtx) => {
		credentialsService = credentialsCtx.credentials;
	});

	ctx.inject(['webServer'], (webCtx) => {
		mountHttp(webCtx, {
			// Resolved per request so a seam that appears after mount is picked up.
			services: () => ({ settings: settingsService ?? ctx.get('settings'), credentials: credentialsService ?? ctx.get('credentials') }),
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
