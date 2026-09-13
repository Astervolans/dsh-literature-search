#!/usr/bin/env node
/**
 * Standalone CLI for dsh-literature-search. It exercises the same clients the
 * plugin registers, without loading DeepSeek Harness — handy for checking
 * network access, an NCBI key, or a SerpApi key before wiring the plugin in.
 *
 * Usage:
 *   node cli.mjs pubmed "CRISPR base editing" [--max 5] [--sort pub_date] [--min 2020] [--until 2024] [--offset 0] [--no-abstract] [--json]
 *   node cli.mjs paper 33301246 [--json]
 *   node cli.mjs related 33301246 [--max 5] [--json]
 *   node cli.mjs scholar "CRISPR base editing" [--max 10] [--from 2020] [--to 2025] [--provider auto|serpapi|html] [--json]
 *   node cli.mjs cite <result_id> [--json]
 *
 * Environment: NCBI_API_KEY (optional), SERPAPI_API_KEY (optional).
 */
import { PubmedClient } from './lib/pubmed.js';
import { ScholarClient } from './lib/scholar.js';
import { formatPaperEnvelope, formatSearch, searchEnvelope } from './lib/paper.js';
import { RateLimiter } from './lib/http.js';

/** Parse `--key value` / `--flag` arguments after the positional command. */
function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith('--')) {
			positional.push(token);
			continue;
		}
		const [key, inline] = token.slice(2).split('=');
		if (inline !== undefined) {
			flags[key] = inline;
			continue;
		}
		const next = argv[index + 1];
		if (next === undefined || next.startsWith('--')) {
			flags[key] = true;
		} else {
			flags[key] = next;
			index += 1;
		}
	}
	return { positional, flags };
}

/** Parse a numeric flag. */
function num(flags, key, fallback) {
	const raw = flags[key];
	if (raw === undefined || raw === true) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

/** Print a value as JSON when `--json` was passed, otherwise render text. */
function emit(json, value, renderer) {
	if (json) {
		console.log(JSON.stringify(value, null, 2));
		return;
	}
	console.log(renderer(value));
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, argument] = positional;
const asJson = flags.json === true;

const pubmed = new PubmedClient({
	baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
	tool: 'dsh-literature-search-cli',
	email: process.env.NCBI_EMAIL,
	apiKey: process.env.NCBI_API_KEY,
	timeoutMs: 30000,
	maxRetries: 3,
	retryBackoffMs: 1000,
	userAgent: 'dsh-literature-search-cli/0.1.0',
	limiter: new RateLimiter(process.env.NCBI_API_KEY === undefined ? 350 : 110)
});

const scholar = new ScholarClient({
	provider: typeof flags.provider === 'string' ? flags.provider : 'auto',
	baseUrl: 'https://scholar.google.com',
	serpApiBaseUrl: 'https://serpapi.com',
	serpApiKey: process.env.SERPAPI_API_KEY,
	hl: 'en',
	timeoutMs: 30000,
	maxRetries: 2,
	retryBackoffMs: 1500,
	userAgent:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	limiter: new RateLimiter(2500)
});

try {
	switch (command) {
		case 'pubmed': {
			if (argument === undefined) throw new Error('pubmed needs a query');
			const limit = num(flags, 'max', 10);
			const offset = num(flags, 'offset', 0);
			const result = await pubmed.searchPapers({
				query: argument,
				limit,
				offset,
				sort: typeof flags.sort === 'string' ? flags.sort : undefined,
				minDate: typeof flags.min === 'string' ? flags.min : undefined,
				maxDate: typeof flags.until === 'string' ? flags.until : undefined,
				withAbstract: flags['no-abstract'] !== true
			});
			const value = searchEnvelope('pubmed', argument, result.papers, { total: result.total, offset, warning: result.warning });
			emit(asJson, value, (v) => formatSearch(v, 'PubMed'));
			break;
		}
		case 'paper': {
			if (argument === undefined) throw new Error('paper needs a PMID');
			const result = await pubmed.paper(argument);
			emit(asJson, { source: 'pubmed', ...result }, (v) => formatPaperEnvelope(v, 'PubMed record'));
			break;
		}
		case 'related': {
			if (argument === undefined) throw new Error('related needs a PMID');
			const limit = num(flags, 'max', 10);
			const pmids = await pubmed.related(argument, limit);
			const summaries = await pubmed.summary(pmids);
			const papers = pmids.map((pmid) => summaries.get(pmid)).filter((paper) => paper !== undefined);
			const value = searchEnvelope('pubmed', `related to PMID ${argument}`, papers);
			emit(asJson, value, (v) => formatSearch(v, 'PubMed related'));
			break;
		}
		case 'scholar': {
			if (argument === undefined) throw new Error('scholar needs a query');
			const limit = num(flags, 'max', 10);
			const offset = num(flags, 'offset', 0);
			const result = await scholar.search({
				query: argument,
				limit,
				offset,
				yearFrom: num(flags, 'from', undefined),
				yearTo: num(flags, 'to', undefined)
			});
			// Google returns a whole page of ~10 results; honour --max here, the
			// same way the registered tool slices the page.
			const value = searchEnvelope('google-scholar', argument, result.papers.slice(0, limit), {
				offset,
				truncated: result.truncated || result.papers.length > limit
			});
			emit(asJson, value, (v) => formatSearch(v, 'Google Scholar'));
			break;
		}
		case 'cite': {
			if (argument === undefined) throw new Error('cite needs a result id');
			const result = await scholar.cite(argument);
			emit(asJson, result, (v) => v.citations.map((entry) => `${entry.title}: ${entry.snippet}`).join('\n\n'));
			break;
		}
		default:
			console.log('commands: pubmed <query> | paper <pmid> | related <pmid> | scholar <query> | cite <result_id>');
			console.log('flags: --max N --offset N --sort S --min YYYY --until YYYY --from YYYY --to YYYY --provider auto|serpapi|html --no-abstract --json');
			process.exitCode = command === undefined ? 0 : 2;
	}
} catch (error) {
	console.error(`error: ${error?.message ?? String(error)}`);
	process.exitCode = 1;
}
