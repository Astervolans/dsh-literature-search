/**
 * Google Scholar literature search. Google publishes **no** official Scholar
 * API, so this module offers the two routes that actually work:
 *
 * - `serpapi`: SerpApi's `google_scholar` engine (and `google_scholar_cite` for
 *   formatted citations). Needs `SERPAPI_API_KEY`; returns parsed JSON.
 * - `html`: direct `scholar.google.com/scholar` requests parsed locally. No key,
 *   but Google rate-limits or blocks non-browser traffic (HTTP 429 / CAPTCHA),
 *   so failures are reported instead of retried forever.
 *
 * @module dsh-literature-search/scholar
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HttpError, queryString, request, requestJson } from './http.js';
import {
	PAPER_OUTPUT_SCHEMA,
	SEARCH_OUTPUT_SCHEMA,
	compact,
	decodeEntities,
	formatSearch,
	searchEnvelope,
	stripTags,
	text,
	yearOf
} from './paper.js';

/** Source label used in every Google Scholar paper. */
export const SOURCE = 'google-scholar';

/** Google Scholar returns ten organic results per HTML page. */
const SCHOLAR_PAGE_SIZE = 10;

/** Headers a real browser sends; the HTML endpoint rejects the default UA. */
const BROWSER_HEADERS = {
	'accept-language': 'en-US,en;q=0.9',
	'sec-fetch-dest': 'document',
	'sec-fetch-mode': 'navigate',
	'sec-fetch-site': 'same-origin',
	'upgrade-insecure-requests': '1'
};

/** Detect the interstitial Google serves to rate-limited clients. */
function assertNotBlocked(html, url) {
	const probe = html.slice(0, 4000).toLowerCase();
	if (probe.includes('unusual traffic') || probe.includes('not a robot') || probe.includes('/sorry/') || probe.includes('captcha')) {
		throw new HttpError(
			'Google Scholar returned its anti-bot interstitial instead of results (HTTP 429 / "unusual traffic"). '
				+ 'Scholar has no public API; configure a SerpApi key (scholarSerpApiKeyEnv) or lower scholarScrapeDelayMs traffic.',
			{ status: 429, url }
		);
	}
}

/** Split the results page into one markup block per organic result. */
function resultBlocks(html) {
	const out = [];
	const starts = [];
	const pattern = /<div[^>]*class="[^"]*\bgs_r\b[^"]*"/g;
	let match;
	while ((match = pattern.exec(html)) !== null) starts.push(match.index);
	for (let index = 0; index < starts.length; index += 1) {
		out.push(html.slice(starts[index], starts[index + 1] ?? html.length));
	}
	return out;
}

/**
 * Inner HTML of the first `<div>` whose class list contains `token` as a whole
 * class name, with nested-div aware closing-tag matching.
 *
 * Class tokens are compared exactly, so `gs_r` never matches `gs_rs`. When a
 * block carries the token more than once (Scholar's PDF container is
 * `class="gs_ggs gs_fl"` and the footer is `class="gs_fl gs_flb"`), `accept`
 * picks the right one.
 */
function divByClass(block, token, accept = () => true) {
	const tag = /<div\b([^>]*)>/gi;
	let match;
	while ((match = tag.exec(block)) !== null) {
		const classAttr = /class="([^"]*)"/.exec(match[1])?.[1];
		if (classAttr === undefined || !classAttr.split(/\s+/).includes(token)) continue;
		const inner = sliceElement(block, tag.lastIndex);
		if (inner !== undefined && accept(inner)) return inner;
	}
	return undefined;
}

/** Slice a block from `start` to the matching `</div>`, honouring nesting. */
function sliceElement(block, start) {
	const tag = /<div\b[^>]*>|<\/div>/gi;
	tag.lastIndex = start;
	let depth = 1;
	let match;
	while ((match = tag.exec(block)) !== null) {
		if (match[0].startsWith('</')) {
			depth -= 1;
			if (depth === 0) return block.slice(start, match.index);
		} else {
			depth += 1;
		}
	}
	return block.slice(start);
}

/** Pull the first `href` out of a fragment, decoding HTML entities. */
function firstHref(fragment) {
	const href = /href="([^"]+)"/.exec(fragment)?.[1];
	return href === undefined ? undefined : decodeEntities(href);
}

/**
 * Parse Google Scholar's HTML results page.
 * @param {string} html - the response body.
 * @param {string} [url] - request URL, for error context.
 * @returns {object[]} normalized papers (possibly empty).
 */
export function parseScholarHtml(html, url) {
	assertNotBlocked(html, url ?? 'https://scholar.google.com/scholar');
	const papers = [];
	for (const block of resultBlocks(html)) {
		const titleHtml = /<h3[^>]*class="[^"]*\bgs_rt\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/.exec(block)?.[1] ?? '';
		const rawTitle = stripTags(titleHtml.replace(/<span[^>]*class="[^"]*gs_ctg2[^"]*"[\s\S]*?<\/span>/g, ' '));
		const title = rawTitle?.replace(/^\[(HTML|PDF|BOOK|CITATION|B\])\s*\]?\s*/i, '').trim();
		if (title === undefined || title.length === 0) continue;
		const titleBlock = /<h3[^>]*class="[^"]*\bgs_rt\b[^"]*"[\s\S]*?<\/h3>/.exec(block)?.[0] ?? '';
		const link = firstHref(titleBlock);
		const metaRaw = stripTags(divByClass(block, 'gs_a') ?? '');
		const snippet = stripTags(divByClass(block, 'gs_rs') ?? '');
		// The footer is the `gs_fl` div that actually carries the "Cited by" link.
		const footer =
			divByClass(block, 'gs_fl', (inner) => /cites=|cited by/i.test(inner)) ?? divByClass(block, 'gs_fl') ?? '';
		const footerText = stripTags(footer) ?? '';
		const citedBy = /cited by\s+([\d,]+)/i.exec(footerText);
		const citedByHref = /href="([^"]*cites=[^"]*)"/.exec(footer)?.[1];
		const clusterHref = /href="([^"]*cluster=[^"]*)"/.exec(block)?.[1];
		const pdfHref = firstHref(divByClass(block, 'gs_ggs') ?? '')
			?? (link !== undefined && /\.pdf(\?|$)/i.test(link) ? link : undefined);
		const segments = (metaRaw ?? '').split(' - ');
		const authorSegment = segments[0] ?? '';
		const authors = authorSegment
			.split(',')
			.map((author) => author.replace(/…|\u2026/g, '').trim())
			.filter((author) => author.length > 0 && !/^\d{4}$/.test(author));
		// `gs_a` reads "Authors - Venue, Year - host"; a bare year in the middle
		// slot (books and citations) means the venue sits in the third slot.
		let venueSegment = segments[1] ?? '';
		let venue = venueSegment.replace(/,\s*(1[5-9]\d{2}|20\d{2}|21\d{2})\s*$/, '').trim();
		if (/^(1[5-9]\d{2}|20\d{2}|21\d{2})$/.test(venue) && segments[2] !== undefined) {
			venue = segments[2].trim();
			venueSegment = segments[1];
		}
		const resultId = /data-cid="([^"]+)"/.exec(block)?.[1] ?? /cluster=(\d+)/.exec(clusterHref ?? '')?.[1];
		papers.push(
			compact({
				source: SOURCE,
				id: resultId ?? link ?? title,
				title,
				authors,
				year: yearOf(venueSegment) ?? yearOf(metaRaw),
				venue,
				abstract: snippet,
				citationCount: citedBy === null ? undefined : Number.parseInt(citedBy[1].replace(/,/g, ''), 10),
				url: link ?? `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`,
				pdfUrl: pdfHref,
				resultId,
				citedByUrl: citedByHref
			})
		);
	}
	return papers;
}

/**
 * Lowest `start=` value greater than `currentStart` among the page's
 * pagination links, or `undefined` when the page has no next page. Google can
 * return nine results on a page that still has a next page, so the count alone
 * cannot decide truncation.
 * @param {string} html - the results page.
 * @param {number} currentStart - the `start` used for this request.
 * @returns {number|undefined} the next page offset.
 */
export function scholarNextStart(html, currentStart) {
	// Scholar escapes the separator as `&amp;` inside href attributes, so accept
	// both `?start=` / `&start=` and the HTML-escaped form.
	const pattern = /href="[^"]*(?:\?|&|&amp;)start=(\d+)[^"]*"/g;
	let best;
	let match;
	while ((match = pattern.exec(html)) !== null) {
		const start = Number.parseInt(match[1], 10);
		if (start > currentStart && (best === undefined || start < best)) best = start;
	}
	return best;
}

/**
 * Normalize one SerpApi `organic_results[]` entry.
 * @param {Record<string, unknown>} record - the raw entry.
 * @returns {object|undefined} the normalized paper.
 */
export function normalizeSerpApiResult(record) {
	if (record === null || typeof record !== 'object') return undefined;
	const title = text(record.title);
	if (title === undefined) return undefined;
	const info = typeof record.publication_info === 'object' && record.publication_info !== null ? record.publication_info : undefined;
	const summary = text(info?.summary) ?? text(record.publication_info);
	const authors = Array.isArray(info?.authors)
		? info.authors.map((author) => text(author?.name)).filter((name) => name !== undefined)
		: [];
	const fromSummary = summary !== undefined && authors.length === 0 ? summary.split(' - ')[0] : undefined;
	const authorList =
		authors.length > 0
			? authors
			: fromSummary !== undefined
				? fromSummary
						.split(',')
						.map((author) => author.replace(/…|\u2026/g, '').trim())
						.filter((author) => author.length > 0 && !/^\d{4}$/.test(author))
				: [];
	const venueSegment = summary !== undefined ? (summary.split(' - ')[1] ?? '') : '';
	const inline = typeof record.inline_links === 'object' && record.inline_links !== null ? record.inline_links : undefined;
	const citedBy = inline?.cited_by !== undefined && typeof inline.cited_by === 'object' ? inline.cited_by : undefined;
	const resources = Array.isArray(record.resources) ? record.resources : [];
	const pdfResource = resources.find((entry) => /pdf/i.test(String(entry?.file_format ?? '')) || /pdf/i.test(String(entry?.title ?? '')));
	const link = text(record.link);
	return compact({
		source: SOURCE,
		id: text(record.result_id) ?? link ?? title,
		title,
		authors: authorList,
		year: yearOf(summary) ?? yearOf(record.publication_info),
		venue: venueSegment.replace(/,\s*(1[5-9]\d{2}|20\d{2}|21\d{2})\s*$/, '').trim() || undefined,
		abstract: text(record.snippet),
		citationCount: Number.isFinite(citedBy?.total) ? Math.trunc(citedBy.total) : undefined,
		url: link ?? `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`,
		pdfUrl: text(pdfResource?.link),
		resultId: text(record.result_id),
		citedByUrl: text(citedBy?.link)
	});
}

/**
 * Google Scholar client with a pluggable backend.
 */
export class ScholarClient {
	/**
	 * @param {object} options - provider, endpoints, credentials, and transport policy.
	 */
	constructor(options) {
		this.provider = options.provider;
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
		this.serpApiBaseUrl = options.serpApiBaseUrl.replace(/\/+$/, '');
		this.serpApiKey = options.serpApiKey;
		this.hl = options.hl;
		this.timeoutMs = options.timeoutMs;
		this.maxRetries = options.maxRetries;
		this.retryBackoffMs = options.retryBackoffMs;
		this.userAgent = options.userAgent;
		this.limiter = options.limiter;
		this.resolvedProvider = undefined;
	}

	/** Which backend is in use once keys have been resolved. */
	async backend() {
		if (this.resolvedProvider !== undefined) return this.resolvedProvider;
		if (this.provider === 'serpapi') {
			if (this.serpApiKey === undefined) {
				throw new Error(
					'scholarProvider is "serpapi" but no key was found. Set scholarSerpApiKeyEnv (default SERPAPI_API_KEY) in the '
						+ 'environment or $DSH_HOME/.credentials.yaml, or switch scholarProvider to "html".'
				);
			}
			this.resolvedProvider = 'serpapi';
			return this.resolvedProvider;
		}
		if (this.provider === 'html') {
			this.resolvedProvider = 'html';
			return this.resolvedProvider;
		}
		this.resolvedProvider = this.serpApiKey === undefined ? 'html' : 'serpapi';
		return this.resolvedProvider;
	}

	/** Transport policy shared by both backends. */
	transport() {
		return {
			timeoutMs: this.timeoutMs,
			maxRetries: this.maxRetries,
			retryBackoffMs: this.retryBackoffMs,
			limiter: this.limiter
		};
	}

	/**
	 * Search Google Scholar.
	 * @param {object} params - `{ query, limit, offset, yearFrom, yearTo, signal }`.
	 * @returns {Promise<{ papers: object[], provider: string, truncated: boolean, warning?: string }>} the page.
	 */
	async search(params) {
		const provider = await this.backend();
		return provider === 'serpapi' ? this.searchSerpApi(params) : this.searchHtml(params);
	}

	/** One SerpApi `google_scholar` request. */
	async searchSerpApi(params) {
		const perPage = Math.min(20, Math.max(SCHOLAR_PAGE_SIZE, params.limit));
		const start = params.offset ?? 0;
		const url = `${this.serpApiBaseUrl}/search.json?${queryString({
			engine: 'google_scholar',
			q: params.query,
			api_key: this.serpApiKey,
			hl: this.hl,
			num: perPage,
			start,
			as_ylo: params.yearFrom,
			as_yhi: params.yearTo
		})}`;
		let body;
		try {
			body = await requestJson(url, { ...this.transport(), signal: params.signal, userAgent: this.userAgent });
		} catch (error) {
			if (error instanceof HttpError) throw new Error(`SerpApi Google Scholar failed: ${error.message}${serpApiMessage(error.body)}`);
			throw error;
		}
		if (typeof body?.error === 'string') throw new Error(`SerpApi Google Scholar error: ${body.error}`);
		const rows = Array.isArray(body?.organic_results) ? body.organic_results : [];
		const papers = rows.map(normalizeSerpApiResult).filter((paper) => paper !== undefined);
		const hasNext = body?.pagination !== undefined && body.pagination.next !== undefined;
		return { papers, provider: 'serpapi', truncated: hasNext || papers.length >= perPage };
	}

	/** Build the scholar.google.com results URL for one HTML-mode page. */
	htmlUrl(params) {
		const start = params.offset ?? 0;
		return `${this.baseUrl}/scholar?${queryString({
			q: params.query,
			hl: this.hl,
			as_sdt: '0,5',
			start: start === 0 ? undefined : start,
			as_ylo: params.yearFrom,
			as_yhi: params.yearTo
		})}`;
	}

	/** One HTML page of scholar.google.com, parsed locally. */
	async searchHtml(params) {
		const start = params.offset ?? 0;
		const url = this.htmlUrl(params);
		let response;
		try {
			response = await request(url, {
				...this.transport(),
				headers: BROWSER_HEADERS,
				accept: 'text/html,application/xhtml+xml',
				userAgent: this.userAgent,
				signal: params.signal
			});
		} catch (error) {
			if (error instanceof HttpError && error.status === 429) {
				throw new Error(
					'Google Scholar rate-limited this client (HTTP 429). Scholar has no public API; use a SerpApi key '
						+ '(scholarSerpApiKeyEnv) or wait and retry with a larger scholarScrapeDelayMs.'
				);
			}
			if (error instanceof HttpError) throw new Error(`Google Scholar HTML request failed: ${error.message}`);
			throw new Error(
				`Google Scholar HTML request failed: ${error?.message ?? String(error)}. scholar.google.com is frequently blocked or `
					+ 'rate-limited for non-browser traffic; configure scholarProvider "serpapi" with a SERPAPI_API_KEY for a supported route.'
			);
		}
		const papers = parseScholarHtml(response.text, url);
		return { papers, provider: 'html', truncated: scholarNextStart(response.text, start) !== undefined };
	}

	/**
	 * Fetch formatted citations (MLA, APA, Chicago, Harvard, Vancouver, BibTeX) for a result id.
	 * @param {string} resultId - `result_id` from a SerpApi search, or the `data-cid`/cluster id from HTML mode.
	 * @param {AbortSignal} [signal] - cancellation.
	 * @returns {Promise<{ citations: Array<{ title: string, snippet: string }>, links: Array<{ name: string, link: string }> }>} the citation set.
	 */
	async cite(resultId, signal) {
		const provider = await this.backend();
		if (provider !== 'serpapi') {
			throw new Error('scholar_cite needs scholarProvider "serpapi" (or a SerpApi key): the HTML endpoint exposes no citation-format API.');
		}
		const url = `${this.serpApiBaseUrl}/search.json?${queryString({
			engine: 'google_scholar_cite',
			q: resultId,
			api_key: this.serpApiKey
		})}`;
		let body;
		try {
			body = await requestJson(url, { ...this.transport(), signal, userAgent: this.userAgent });
		} catch (error) {
			if (error instanceof HttpError) throw new Error(`SerpApi Google Scholar cite failed: ${error.message}${serpApiMessage(error.body)}`);
			throw error;
		}
		if (typeof body?.error === 'string') throw new Error(`SerpApi Google Scholar cite error: ${body.error}`);
		const citations = (Array.isArray(body?.citations) ? body.citations : [])
			.map((entry) => ({ title: text(entry?.title) ?? '', snippet: text(entry?.snippet) ?? '' }))
			.filter((entry) => entry.snippet.length > 0);
		const links = (Array.isArray(body?.links) ? body.links : [])
			.map((entry) => ({ name: text(entry?.name) ?? '', link: text(entry?.link) ?? '' }))
			.filter((entry) => entry.link.length > 0);
		return { citations, links };
	}
}

/** Extract SerpApi's `error` field from a raw body. */
function serpApiMessage(body) {
	if (typeof body !== 'string' || body.length === 0) return '';
	const match = /"error"\s*:\s*"([^"]+)"/.exec(body);
	return match === null ? '' : ` — ${match[1]}`;
}

/**
 * Register the Google Scholar tools.
 * @param {object} ctx - plugin context whose `tools` registry receives the registrations.
 * @param {object} runtime - shared plugin runtime.
 */
export function applyScholarTools(ctx, runtime) {
	const { limits, timeouts } = runtime;
	const label = 'Google Scholar';

	ctx.tools.register(
		defineTool({
			name: 'scholar_search',
			description:
				'Search Google Scholar (broadest coverage: publishers, theses, books, preprints) and return title, authors, venue, year, cited-by count, snippet, and PDF link. Google has no official Scholar API: this tool uses SerpApi when scholarSerpApiKeyEnv is set, otherwise it parses scholar.google.com HTML (which Google may rate-limit with HTTP 429). Supports a publication-year window and offset paging.',
			parameters: {
				query: { type: 'string', required: true, description: 'Search query, e.g. "CRISPR base editing".' },
				max_results: { type: 'integer', description: `Papers to return (default ${limits.defaultMaxResults}, max ${limits.maxResultsCap}).` },
				offset: { type: 'integer', description: 'Index of the first match (default 0; HTML mode pages in steps of 10).' },
				year_from: { type: 'integer', description: 'Earliest publication year, e.g. 2020.' },
				year_to: { type: 'integer', description: 'Latest publication year, e.g. 2025.' }
			},
			output: {
				schema: SEARCH_OUTPUT_SCHEMA,
				render: (_args, value) => [{ type: 'text', text: formatSearch(value, label) }]
			},
			timeoutMs: timeouts.tool,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const query = text(args.query);
				if (query === undefined) throw new Error('query must be a non-empty string');
				if (args.year_from !== undefined && args.year_to !== undefined && args.year_from > args.year_to) {
					throw new Error('year_from must not be later than year_to');
				}
				const limit = runtime.boundResults(args.max_results);
				const offset = args.offset !== undefined && Number.isFinite(args.offset) && args.offset > 0 ? Math.trunc(args.offset) : 0;
				const client = await runtime.scholar();
				const result = await client.search({
					query,
					limit,
					offset,
					yearFrom: args.year_from,
					yearTo: args.year_to,
					signal: exec.signal
				});
				const papers = runtime.clipPapers(result.papers).slice(0, limit);
				return searchEnvelope(SOURCE, query, papers, { offset, truncated: result.truncated, warning: result.warning });
			}
		})
	);

	ctx.tools.register(
		defineTool({
			name: 'scholar_cite',
			description:
				'Return ready-to-paste citation formats (MLA, APA, Chicago, Harvard, Vancouver, BibTeX) for one Google Scholar result, plus the links Scholar exposes for it. Requires scholarProvider "serpapi" (or a SerpApi key); pass the resultId that scholar_search reported.',
			parameters: {
				result_id: { type: 'string', required: true, description: 'resultId from a scholar_search paper, e.g. a SerpApi result_id or a Scholar cluster id.' }
			},
			output: {
				schema: PAPER_OUTPUT_SCHEMA,
				render: (_args, value) => {
					const lines = [`Google Scholar citations for ${value.paper.resultId ?? value.paper.title}`, ''];
					if (value.references !== undefined) value.references.forEach((entry) => lines.push(entry, ''));
					if (value.warning !== undefined) lines.push(`warning: ${value.warning}`);
					return [{ type: 'text', text: lines.join('\n').trimEnd() }];
				}
			},
			timeoutMs: timeouts.tool,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const resultId = text(args.result_id);
				if (resultId === undefined) throw new Error('result_id must be a non-empty string');
				const client = await runtime.scholar();
				const cite = await client.cite(resultId, exec.signal);
				const references = cite.citations.map((entry) => `${entry.title}: ${entry.snippet}`);
				for (const link of cite.links) references.push(`${link.name}: ${link.link}`);
				return compact({
					source: SOURCE,
					paper: { source: SOURCE, id: resultId, title: `result ${resultId}`, resultId },
					references,
					warning: references.length === 0 ? 'Google Scholar returned no citation formats for this result id' : undefined
				});
			}
		})
	);
}
