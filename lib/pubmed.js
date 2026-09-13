/**
 * PubMed literature search over the official NCBI E-utilities
 * (https://eutils.ncbi.nlm.nih.gov/entrez/eutils/): `esearch` for matching
 * PMIDs, `esummary` for metadata, `efetch` (MEDLINE text) for abstracts, MeSH
 * headings and keywords, and `elink` for the related-articles graph.
 *
 * Free, no key required. NCBI allows 3 requests/second per IP; an NCBI API key
 * (`api_key`) raises that to 10. `tool` and `email` are sent on every call as
 * the usage policy asks.
 *
 * @module dsh-literature-search/pubmed
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HttpError, queryString, request, requestJson } from './http.js';
import { medlineReferences, medlineToPaper, parseMedline } from './medline.js';
import {
	PAPER_OUTPUT_SCHEMA,
	SEARCH_OUTPUT_SCHEMA,
	clipAbstract,
	compact,
	formatPaperEnvelope,
	formatSearch,
	searchEnvelope,
	text,
	yearOf
} from './paper.js';

/** Source label used in every PubMed paper. */
export const SOURCE = 'pubmed';

/** PubMed date-limit syntax accepted by E-utilities: `YYYY`, `YYYY/MM`, `YYYY/MM/DD`. */
const PUBMED_DATE = /^\d{4}(\/\d{1,2}(\/\d{1,2})?)?$/;

/** Sort values `esearch` accepts for `db=pubmed`. */
export const PUBMED_SORTS = ['relevance', 'pub_date', 'Author', 'JournalName'];

/** Guard against a single call asking for more than E-utilities will return. */
const PUBMED_MAX_RETMAX = 10_000;

/** Read a string field from an untyped JSON record. */
function str(record, key) {
	const value = record?.[key];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Read an integer field from an untyped JSON record. */
function int(record, key) {
	const value = record?.[key];
	if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
	return undefined;
}

/** Read a string array from an untyped JSON record. */
function strArray(record, key) {
	const value = record?.[key];
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
}

/**
 * Convert one ESummary v2.0 DocSum into the shared paper shape.
 * @param {Record<string, unknown>} record - one entry of `result[uid]`.
 * @returns {object|undefined} the normalized paper.
 */
export function esummaryToPaper(record) {
	const pmid = str(record, 'uid');
	if (pmid === undefined) return undefined;
	const authors = Array.isArray(record.authors)
		? record.authors.map((author) => str(author, 'name')).filter((name) => name !== undefined)
		: [];
	let doi;
	let pmcid;
	for (const id of Array.isArray(record.articleids) ? record.articleids : []) {
		const type = str(id, 'idtype');
		const value = str(id, 'value');
		if (value === undefined) continue;
		if (type === 'doi' && doi === undefined) doi = value;
		if ((type === 'pmc' || type === 'pmcid') && pmcid === undefined) pmcid = value;
	}
	const elocation = str(record, 'elocationid');
	const elocationDoi = elocation !== undefined ? /^doi:\s*(10\..+)$/i.exec(elocation)?.[1] : undefined;
	const pubdate = str(record, 'pubdate') ?? str(record, 'epubdate');
	return compact({
		source: SOURCE,
		id: pmid,
		pmid,
		title: str(record, 'title'),
		authors,
		year: yearOf(pubdate) ?? yearOf(str(record, 'sortpubdate')),
		date: pubdate,
		venue: str(record, 'fulljournalname') ?? str(record, 'source'),
		volume: str(record, 'volume'),
		issue: str(record, 'issue'),
		pages: str(record, 'pages'),
		doi: doi ?? elocationDoi,
		pmcid,
		url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
		publicationTypes: strArray(record, 'pubtype')
	});
}

/** Merge a MEDLINE-derived paper with its ESummary counterpart, keeping the richer field. */
export function mergePubmed(medlinePaper, summaryPaper) {
	if (medlinePaper === undefined) return summaryPaper;
	if (summaryPaper === undefined) return medlinePaper;
	const merged = { ...summaryPaper, ...medlinePaper };
	return compact({
		...merged,
		doi: medlinePaper.doi ?? summaryPaper.doi,
		pmcid: medlinePaper.pmcid ?? summaryPaper.pmcid,
		venue: medlinePaper.venue ?? summaryPaper.venue,
		date: medlinePaper.date ?? summaryPaper.date,
		publicationTypes: medlinePaper.publicationTypes?.length > 0 ? medlinePaper.publicationTypes : summaryPaper.publicationTypes,
		authors: medlinePaper.authors?.length > 0 ? medlinePaper.authors : summaryPaper.authors
	});
}

/** Validate a PubMed date limit and normalize it. */
function checkDate(name, value) {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	if (!PUBMED_DATE.test(trimmed)) throw new Error(`${name} must be YYYY, YYYY/MM, or YYYY/MM/DD`);
	return trimmed;
}

/** Validate a PMID argument. */
export function checkPmid(value) {
	const trimmed = String(value ?? '').trim();
	if (!/^\d{1,9}$/.test(trimmed)) throw new Error(`pmid must be a numeric PubMed identifier, got "${value}"`);
	return trimmed;
}

/**
 * Thin client over the E-utilities endpoint.
 */
export class PubmedClient {
	/**
	 * @param {object} options - endpoint, policy parameters, and transport policy.
	 */
	constructor(options) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
		this.tool = options.tool;
		this.email = options.email;
		this.apiKey = options.apiKey;
		this.timeoutMs = options.timeoutMs;
		this.maxRetries = options.maxRetries;
		this.retryBackoffMs = options.retryBackoffMs;
		this.userAgent = options.userAgent;
		this.limiter = options.limiter;
	}

	/** Shared policy parameters for every E-utility call. */
	policy() {
		return compact({
			tool: this.tool,
			email: this.email,
			api_key: this.apiKey
		});
	}

	/** Issue one E-utility request and return its decoded body. */
	async call(utility, params, { json = false, signal } = {}) {
		const url = `${this.baseUrl}/${utility}.fcgi?${queryString({ ...this.policy(), ...params })}`;
		const options = {
			signal,
			timeoutMs: this.timeoutMs,
			maxRetries: this.maxRetries,
			retryBackoffMs: this.retryBackoffMs,
			userAgent: this.userAgent,
			limiter: this.limiter
		};
		try {
			return json ? await requestJson(url, options) : (await request(url, { ...options, accept: 'text/plain' })).text;
		} catch (error) {
			if (error instanceof HttpError) {
				throw new Error(`PubMed ${utility} failed: ${error.message}${describeApiError(error.body)}`);
			}
			throw error;
		}
	}

	/**
	 * Run an ESearch and return the matching PMIDs plus the reported total.
	 * @param {object} params - query, paging, sort, and date limits.
	 * @returns {Promise<{ pmids: string[], total: number, translation?: string }>} the id page.
	 */
	async search(params) {
		const body = await this.call(
			'esearch',
			compact({
				db: 'pubmed',
				term: params.query,
				retmode: 'json',
				retmax: params.retmax,
				retstart: params.retstart,
				sort: params.sort,
				datetype: params.minDate !== undefined || params.maxDate !== undefined ? 'pdat' : undefined,
				mindate: params.minDate,
				maxdate: params.maxDate
			}),
			{ json: true, signal: params.signal }
		);
		const result = body?.esearchresult;
		if (result === undefined) throw new Error('PubMed esearch returned an unexpected payload');
		if (typeof result.error === 'string') throw new Error(`PubMed esearch error: ${result.error}`);
		const pmids = Array.isArray(result.idlist) ? result.idlist.map(String) : [];
		const total = Number.parseInt(String(result.count ?? pmids.length), 10);
		return {
			pmids,
			total: Number.isFinite(total) ? total : pmids.length,
			translation: typeof result.querytranslation === 'string' ? result.querytranslation : undefined
		};
	}

	/** Fetch ESummary v2.0 DocSums for a PMID list. */
	async summary(pmids, signal) {
		if (pmids.length === 0) return new Map();
		const body = await this.call('esummary', { db: 'pubmed', id: pmids.join(','), retmode: 'json', version: '2.0' }, { json: true, signal });
		const result = body?.result;
		const out = new Map();
		if (result === undefined || typeof result !== 'object') return out;
		for (const [uid, record] of Object.entries(result)) {
			if (uid === 'uids') continue;
			const paper = esummaryToPaper(record);
			if (paper !== undefined) out.set(paper.pmid, paper);
		}
		return out;
	}

	/** Fetch MEDLINE records for a PMID list, keyed by PMID. */
	async medline(pmids, signal) {
		const out = new Map();
		if (pmids.length === 0) return out;
		const payload = await this.call('efetch', { db: 'pubmed', id: pmids.join(','), rettype: 'medline', retmode: 'text' }, { signal });
		for (const record of parseMedline(payload)) {
			const paper = medlineToPaper(record);
			if (paper === undefined) continue;
			out.set(paper.pmid, { paper, references: medlineReferences(record) });
		}
		return out;
	}

	/**
	 * Full search: ESearch, then ESummary plus (optionally) MEDLINE enrichment.
	 * @param {object} params - `{ query, limit, offset, sort, minDate, maxDate, withAbstract, signal }`.
	 * @returns {Promise<{ papers: object[], total: number, warning?: string }>} the page.
	 */
	async searchPapers(params) {
		const found = await this.search({
			query: params.query,
			retmax: Math.min(params.limit, PUBMED_MAX_RETMAX),
			retstart: params.offset,
			sort: params.sort,
			minDate: params.minDate,
			maxDate: params.maxDate,
			signal: params.signal
		});
		if (found.pmids.length === 0) return { papers: [], total: found.total };
		let summaries = new Map();
		let medlines = new Map();
		let warning;
		try {
			summaries = await this.summary(found.pmids, params.signal);
		} catch (error) {
			warning = `esummary unavailable (${error.message}); metadata comes from MEDLINE only`;
		}
		if (params.withAbstract !== false) {
			try {
				medlines = await this.medline(found.pmids, params.signal);
			} catch (error) {
				warning = warning === undefined ? `efetch unavailable (${error.message})` : `${warning}; efetch unavailable (${error.message})`;
			}
		}
		const papers = found.pmids.map((pmid) => mergePubmed(medlines.get(pmid)?.paper, summaries.get(pmid))).filter((paper) => paper !== undefined);
		return compact({ papers, total: found.total, warning });
	}

	/**
	 * Fetch one paper in full, plus the comment/reference lines MEDLINE carries.
	 * @param {string} pmid - PubMed identifier.
	 * @param {AbortSignal} [signal] - cancellation.
	 * @returns {Promise<{ paper: object, references: string[] }>} the record.
	 */
	async paper(pmid, signal) {
		const medlines = await this.medline([pmid], signal);
		const hit = medlines.get(pmid);
		const summaries = await this.summary([pmid], signal).catch(() => new Map());
		const merged = mergePubmed(hit?.paper, summaries.get(pmid));
		if (merged === undefined) throw new Error(`PubMed has no record for PMID ${pmid}`);
		return { paper: merged, references: hit?.references ?? [] };
	}

	/**
	 * Related articles for one PMID (ELink `pubmed_pubmed` neighbour links).
	 * @param {string} pmid - seed PubMed identifier.
	 * @param {number} limit - how many related papers to return.
	 * @param {AbortSignal} [signal] - cancellation.
	 * @returns {Promise<string[]>} related PMIDs in ELink relevance order.
	 */
	async related(pmid, limit, signal) {
		const body = await this.call('elink', { dbfrom: 'pubmed', db: 'pubmed', cmd: 'neighbor', id: pmid, retmode: 'json' }, { json: true, signal });
		const linkset = Array.isArray(body?.linksets) ? body.linksets[0] : undefined;
		const linksets = Array.isArray(linkset?.linksetdbs) ? linkset.linksetdbs : [];
		const chosen = linksets.find((entry) => entry?.linkname === 'pubmed_pubmed') ?? linksets[0];
		const links = Array.isArray(chosen?.links) ? chosen.links.map(String) : [];
		return links.filter((id) => id !== pmid).slice(0, limit);
	}
}

/** Turn an E-utilities error body into a readable suffix. */
function describeApiError(body) {
	if (typeof body !== 'string' || body.length === 0) return '';
	const match = /"error"\s*:\s*"([^"]+)"/.exec(body);
	if (match !== null) return ` — ${match[1]}`;
	return body.startsWith('<?xml') || body.startsWith('<') ? '' : ` — ${body.slice(0, 200)}`;
}

/**
 * Register the PubMed tools.
 * @param {object} ctx - plugin context whose `tools` registry receives the registrations.
 * @param {object} runtime - shared plugin runtime.
 */
export function applyPubmedTools(ctx, runtime) {
	const { limits, timeouts } = runtime;
	const searchLabel = 'PubMed';

	ctx.tools.register(
		defineTool({
			name: 'pubmed_search',
			description:
				'Search PubMed through the official NCBI E-utilities (free, no API key). Returns PMID, title, authors, journal, date, DOI/PMC id, abstract, MeSH terms and keywords. Supports MeSH/field-tagged queries (e.g. asthma[Title/Abstract] AND 2020:2024[pdat]), relevance or date sorting, a publication-date window, and offset paging.',
			parameters: {
				query: { type: 'string', required: true, description: 'PubMed query. Field tags and Boolean operators are supported.' },
				max_results: { type: 'integer', description: `Papers per page (default ${limits.defaultMaxResults}, max ${limits.maxResultsCap}).` },
				offset: { type: 'integer', description: 'Index of the first match to return (default 0).' },
				sort: { type: 'string', enum: PUBMED_SORTS, description: 'relevance (default, PubMed Best Match), pub_date, Author, or JournalName.' },
				min_date: { type: 'string', description: 'Earliest publication date: YYYY, YYYY/MM, or YYYY/MM/DD.' },
				max_date: { type: 'string', description: 'Latest publication date: YYYY, YYYY/MM, or YYYY/MM/DD.' },
				with_abstract: { type: 'boolean', description: 'Fetch abstracts/MeSH via efetch (default true; set false for a metadata-only, cheaper page).' }
			},
			output: {
				schema: SEARCH_OUTPUT_SCHEMA,
				render: (_args, value) => [{ type: 'text', text: formatSearch(value, searchLabel) }]
			},
			timeoutMs: timeouts.tool,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const query = text(args.query);
				if (query === undefined) throw new Error('query must be a non-empty string');
				const limit = runtime.boundResults(args.max_results);
				const offset = args.offset !== undefined && Number.isFinite(args.offset) && args.offset > 0 ? Math.trunc(args.offset) : 0;
				const minDate = checkDate('min_date', args.min_date);
				const maxDate = checkDate('max_date', args.max_date);
				if (minDate !== undefined && maxDate !== undefined && minDate > maxDate) throw new Error('min_date must not be later than max_date');
				const client = await runtime.pubmed();
				const result = await client.searchPapers({
					query,
					limit,
					offset,
					sort: args.sort,
					minDate,
					maxDate,
					withAbstract: args.with_abstract !== false,
					signal: exec.signal
				});
				return searchEnvelope(SOURCE, query, runtime.clipPapers(result.papers), {
					total: result.total,
					offset,
					warning: result.warning
				});
			}
		})
	);

	ctx.tools.register(
		defineTool({
			name: 'pubmed_paper',
			description:
				'Fetch one PubMed record by PMID: full abstract, authors, journal, MeSH headings, keywords, publication types, and the comment/reference lines MEDLINE records. Use after pubmed_search to read a specific paper.',
			parameters: {
				pmid: { type: 'string', required: true, description: 'PubMed identifier, e.g. "33301246".' },
				with_references: { type: 'boolean', description: 'Include the comment/related-citation lines (default true).' }
			},
			output: {
				schema: PAPER_OUTPUT_SCHEMA,
				render: (_args, value) => [{ type: 'text', text: formatPaperEnvelope(value, 'PubMed record') }]
			},
			timeoutMs: timeouts.tool,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const pmid = checkPmid(args.pmid);
				const client = await runtime.pubmed();
				const result = await client.paper(pmid, exec.signal);
				return compact({
					source: SOURCE,
					paper: runtime.clipPapers([result.paper])[0],
					references: args.with_references === false ? undefined : result.references
				});
			}
		})
	);

	ctx.tools.register(
		defineTool({
			name: 'pubmed_related',
			description:
				'List PubMed articles related to one PMID, ranked by the NCBI related-article algorithm (ELink pubmed_pubmed). Good for citation-free literature expansion around a seed paper.',
			parameters: {
				pmid: { type: 'string', required: true, description: 'Seed PubMed identifier, e.g. "33301246".' },
				max_results: { type: 'integer', description: `Related papers to return (default ${limits.defaultMaxResults}, max ${limits.maxResultsCap}).` }
			},
			output: {
				schema: SEARCH_OUTPUT_SCHEMA,
				render: (_args, value) => [{ type: 'text', text: formatSearch(value, 'PubMed related') }]
			},
			timeoutMs: timeouts.tool,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const pmid = checkPmid(args.pmid);
				const limit = runtime.boundResults(args.max_results);
				const client = await runtime.pubmed();
				const pmids = await client.related(pmid, limit, exec.signal);
				let papers = [];
				let warning;
				if (pmids.length > 0) {
					try {
						const summaries = await client.summary(pmids, exec.signal);
						papers = pmids.map((id) => summaries.get(id)).filter((paper) => paper !== undefined);
					} catch (error) {
						warning = `related ids found but metadata fetch failed: ${error.message}`;
						papers = pmids.map((id) => ({ source: SOURCE, id, pmid: id, title: `PMID ${id}`, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/` }));
					}
				}
				return searchEnvelope(SOURCE, `related to PMID ${pmid}`, papers, { warning });
			}
		})
	);
}
