/**
 * Shared paper shape, tool output schemas, and model-facing rendering for
 * dsh-literature-search. Both backends (PubMed E-utilities, Google Scholar)
 * normalize into the same paper object so one renderer serves every tool.
 *
 * @module dsh-literature-search/paper
 */

/** Drop `undefined`, `null`, empty strings, and empty arrays; keep `0`/`false`. */
export function compact(value) {
	const out = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry === undefined || entry === null) continue;
		if (typeof entry === 'string' && entry.trim().length === 0) continue;
		if (Array.isArray(entry) && entry.length === 0) continue;
		out[key] = entry;
	}
	return out;
}

/** Trim a string, returning `undefined` for blank input. */
export function text(value) {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.replace(/\s+/g, ' ').trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/** Parse a leading/embedded year, returning `undefined` when absent. */
export function yearOf(value) {
	if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value !== 'string') return undefined;
	const match = /(1[5-9]\d{2}|20\d{2}|21\d{2})/.exec(value);
	return match === null ? undefined : Number.parseInt(match[0], 10);
}

/** Decode the XML/HTML entities the PubMed and Scholar payloads carry. */
export function decodeEntities(value) {
	if (typeof value !== 'string') return undefined;
	return value
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => safeCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(Number.parseInt(dec, 10)))
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

/** Convert a code point to a character without throwing on malformed input. */
function safeCodePoint(code) {
	if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
	try {
		return String.fromCodePoint(code);
	} catch {
		return '';
	}
}

/** Strip tags from a fragment of markup and decode its entities. */
export function stripTags(value) {
	if (typeof value !== 'string') return undefined;
	return text(decodeEntities(value.replace(/<[^>]*>/g, ' ')));
}

/** The normalized paper object every tool returns. */
export const PAPER_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		source: { type: 'string', required: true, description: 'Backend that produced the record: pubmed or google-scholar.' },
		id: { type: 'string', required: true, description: 'Stable identifier within the source (PMID for PubMed, result id/URL for Google Scholar).' },
		title: { type: 'string', required: true },
		authors: { type: 'array', items: { type: 'string' }, description: 'Author names in the order the source reports them.' },
		year: { type: 'integer' },
		date: { type: 'string', description: 'Publication date as reported, e.g. 2020 Dec 31.' },
		venue: { type: 'string', description: 'Journal, conference, or repository.' },
		volume: { type: 'string' },
		issue: { type: 'string' },
		pages: { type: 'string' },
		abstract: { type: 'string', description: 'Abstract or snippet, truncated to the configured abstractMaxChars.' },
		doi: { type: 'string' },
		pmid: { type: 'string' },
		pmcid: { type: 'string', description: 'PubMed Central id when the article has a free full text.' },
		citationCount: { type: 'integer', description: 'Cited-by count (Google Scholar only; PubMed exposes none).' },
		url: { type: 'string' },
		pdfUrl: { type: 'string' },
		publicationTypes: { type: 'array', items: { type: 'string' } },
		meshTerms: { type: 'array', items: { type: 'string' } },
		keywords: { type: 'array', items: { type: 'string' } },
		resultId: { type: 'string', description: 'Google Scholar result id, accepted by scholar_cite.' },
		citedByUrl: { type: 'string' }
	}
};

/** Output schema of a paginated search tool. */
export const SEARCH_OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		source: { type: 'string', required: true },
		query: { type: 'string', required: true },
		total: { type: 'integer', description: 'Total matches the source reports, when it reports one.' },
		returned: { type: 'integer', required: true, description: 'Papers in this response.' },
		offset: { type: 'integer', description: 'Index of the first returned paper within the full result set.' },
		truncated: { type: 'boolean', description: 'True when more matches exist beyond this page.' },
		nextOffset: { type: 'integer', description: 'Pass as offset to fetch the next page.' },
		papers: { type: 'array', required: true, items: PAPER_SCHEMA },
		warning: { type: 'string', description: 'Non-fatal degradation, e.g. pagination stopped early.' }
	}
};

/** Output schema of a single-record tool. */
export const PAPER_OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		source: { type: 'string', required: true },
		paper: { type: 'object', required: true, additionalProperties: false, properties: PAPER_SCHEMA.properties },
		references: { type: 'array', items: { type: 'string' }, description: 'Rendered reference lines the source supplied.' },
		warning: { type: 'string' }
	}
};

/** Wrap a paper list in the search envelope, computing truncation bookkeeping. */
export function searchEnvelope(source, query, papers, extra = {}) {
	const total = extra.total;
	const offset = extra.offset ?? 0;
	const truncated = extra.truncated ?? (total !== undefined ? offset + papers.length < total : false);
	return compact({
		source,
		query,
		total,
		returned: papers.length,
		offset,
		truncated,
		nextOffset: truncated ? offset + papers.length : undefined,
		papers,
		warning: extra.warning
	});
}

/** One-line author summary: first three names, then an ellipsis count. */
export function authorLine(authors, max = 3) {
	if (!Array.isArray(authors) || authors.length === 0) return 'authors not reported';
	if (authors.length <= max) return authors.join(', ');
	return `${authors.slice(0, max).join(', ')} et al. (${authors.length} authors)`;
}

/** Render one paper as a compact markdown block. */
export function formatPaper(paper, index) {
	const lines = [];
	const heading = index === undefined ? paper.title : `${index}. ${paper.title}`;
	lines.push(heading);
	const meta = [];
	if (paper.year !== undefined) meta.push(String(paper.year));
	if (paper.venue !== undefined) meta.push(paper.venue);
	if (paper.volume !== undefined) meta.push(`vol ${paper.volume}`);
	if (paper.issue !== undefined) meta.push(`no ${paper.issue}`);
	if (paper.pages !== undefined) meta.push(`pp ${paper.pages}`);
	if (meta.length > 0) lines.push(`   ${meta.join(' · ')}`);
	lines.push(`   ${authorLine(paper.authors)}`);
	const ids = [];
	if (paper.doi !== undefined) ids.push(`DOI: ${paper.doi}`);
	if (paper.pmid !== undefined) ids.push(`PMID: ${paper.pmid}`);
	if (paper.pmcid !== undefined) ids.push(`PMC: ${paper.pmcid}`);
	if (paper.citationCount !== undefined) ids.push(`cited by ${paper.citationCount}`);
	if (ids.length > 0) lines.push(`   ${ids.join(' · ')}`);
	if (paper.url !== undefined) lines.push(`   ${paper.url}`);
	if (paper.pdfUrl !== undefined && paper.pdfUrl !== paper.url) lines.push(`   PDF: ${paper.pdfUrl}`);
	if (paper.publicationTypes !== undefined && paper.publicationTypes.length > 0) {
		lines.push(`   Types: ${paper.publicationTypes.join(', ')}`);
	}
	if (paper.meshTerms !== undefined && paper.meshTerms.length > 0) {
		lines.push(`   MeSH: ${paper.meshTerms.join(', ')}`);
	}
	if (paper.abstract !== undefined) lines.push(`   Abstract: ${paper.abstract}`);
	return lines.join('\n');
}

/** Render a search result envelope as model-facing text. */
export function formatSearch(value, label) {
	const head = [];
	head.push(`${label} search: "${value.query}"`);
	if (value.total !== undefined) head.push(`${value.total.toLocaleString('en-US')} total matches`);
	head.push(`showing ${value.returned}${value.offset !== undefined && value.offset > 0 ? ` from offset ${value.offset}` : ''}`);
	const lines = [head.join(' — ')];
	if (value.warning !== undefined) lines.push(`warning: ${value.warning}`);
	if (value.papers.length === 0) {
		lines.push('No papers matched.');
	} else {
		lines.push('');
		value.papers.forEach((paper, index) => {
			lines.push(formatPaper(paper, index + 1));
			lines.push('');
		});
	}
	if (value.truncated === true && value.nextOffset !== undefined) {
		lines.push(`More results available — call again with offset=${value.nextOffset}.`);
	}
	return lines.join('\n').trimEnd();
}

/** Render one paper envelope as model-facing text. */
export function formatPaperEnvelope(value, label) {
	const lines = [`${label}: ${value.paper.title}`, ''];
	lines.push(formatPaper(value.paper));
	if (value.references !== undefined && value.references.length > 0) {
		lines.push('');
		lines.push(`References (${value.references.length}):`);
		value.references.slice(0, 25).forEach((ref, index) => lines.push(`  ${index + 1}. ${ref}`));
		if (value.references.length > 25) lines.push(`  … ${value.references.length - 25} more`);
	}
	if (value.warning !== undefined) {
		lines.push('');
		lines.push(`warning: ${value.warning}`);
	}
	return lines.join('\n');
}

/** Truncate an abstract to the configured budget, appending an ellipsis marker. */
export function clipAbstract(value, maxChars) {
	if (value === undefined) return undefined;
	if (maxChars <= 0) return undefined;
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars).trimEnd()}… [truncated]`;
}
