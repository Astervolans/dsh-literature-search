/**
 * Live smoke test for the Google Scholar HTML backend.
 *
 *   node test/live-scholar.mjs
 *
 * scholar.google.com is an undocumented, anti-bot-protected endpoint: results
 * are expected most of the time, but Google can answer HTTP 429, serve a page
 * without result blocks, or drop the connection at any moment. Those are
 * upstream conditions and are reported as SKIP; a 200 page that still contains
 * result blocks but parses to nothing is a real failure (exit 1).
 */
import { RateLimiter, request } from '../lib/http.js';
import { ScholarClient } from '../lib/scholar.js';
import { formatSearch, searchEnvelope } from '../lib/paper.js';
import { createSuite, assert, isUpstreamUnavailable } from './harness.mjs';

const suite = createSuite('live google scholar');

const client = new ScholarClient({
	provider: 'html',
	baseUrl: 'https://scholar.google.com',
	serpApiBaseUrl: 'https://serpapi.com',
	serpApiKey: undefined,
	hl: 'en',
	timeoutMs: 30_000,
	maxRetries: 1,
	retryBackoffMs: 2_000,
	userAgent:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	limiter: new RateLimiter(2_500)
});

const state = { blocked: undefined };

/** Run a live search; an upstream refusal becomes a SKIP rather than a failure. */
async function liveSearch(params) {
	try {
		return await client.search(params);
	} catch (error) {
		if (isUpstreamUnavailable(error)) {
			state.blocked = error.message;
			return undefined;
		}
		throw error;
	}
}

/** Count the raw result blocks Google actually served for a page. */
async function rawBlockCount(params) {
	const response = await request(client.htmlUrl(params), {
		headers: { 'user-agent': client.userAgent, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
		timeoutMs: 20_000
	});
	return (response.text.match(/class="gs_r\b/g) ?? []).length;
}

/**
 * Decide whether an empty parse is Google's doing or a parser regression.
 * @returns {Promise<boolean>} true when the caller should SKIP.
 */
async function emptyIsUpstream(params, context) {
	const blocks = await rawBlockCount(params);
	assert.equal(blocks, 0, `${context}: the page carried ${blocks} result blocks but the parser returned none`);
	return true;
}

suite.test('HTML backend returns parsed results for a plain query', async () => {
	const params = { query: 'CRISPR base editing', limit: 10, offset: 0 };
	const result = await liveSearch(params);
	if (result === undefined) {
		console.log(`     SKIP (upstream refused): ${state.blocked}`);
		return;
	}
	if (result.papers.length === 0) {
		if (await emptyIsUpstream(params, 'plain query')) console.log('     SKIP: upstream served a page without result blocks');
		return;
	}
	assert.equal(result.provider, 'html');
	const withYear = result.papers.filter((paper) => paper.year !== undefined);
	const withAuthors = result.papers.filter((paper) => (paper.authors ?? []).length > 0);
	const withCitedBy = result.papers.filter((paper) => paper.citationCount !== undefined);
	assert.equal(withYear.length, result.papers.length, 'every paper should carry a year');
	assert.equal(withAuthors.length > 0, true, 'authors should be parsed');
	assert.equal(withCitedBy.length > 0, true, 'cited-by counts should be parsed');
	console.log(`     parsed ${result.papers.length} papers, e.g. "${result.papers[0].title.slice(0, 80)}"`);
	console.log(`     ${result.papers[0].year} · ${result.papers[0].venue} · cited ${result.papers[0].citationCount}`);
});

suite.test('year window (as_ylo/as_yhi) is honoured', async () => {
	const params = { query: 'base editing', limit: 10, offset: 0, yearFrom: 2023, yearTo: 2024 };
	const result = await liveSearch(params);
	if (result === undefined) {
		console.log(`     SKIP (upstream refused): ${state.blocked}`);
		return;
	}
	if (result.papers.length === 0) {
		if (await emptyIsUpstream(params, 'year window')) console.log('     SKIP: upstream served a page without result blocks');
		return;
	}
	const years = result.papers.map((paper) => paper.year).filter((year) => year !== undefined);
	assert.equal(years.length > 0, true);
	const inRange = years.filter((year) => year >= 2023 && year <= 2024);
	assert.equal(inRange.length, years.length, `years outside 2023-2024: ${years.join(',')}`);
	console.log(`     years: ${years.join(',')}`);
});

suite.test('offset paging returns a different page', async () => {
	const firstParams = { query: 'base editing', limit: 10, offset: 0 };
	const first = await liveSearch(firstParams);
	if (first === undefined || first.papers.length === 0) {
		console.log(`     SKIP (upstream refused or served no blocks): ${state.blocked ?? 'empty page'}`);
		return;
	}
	const secondParams = { query: 'base editing', limit: 10, offset: 10 };
	const second = await liveSearch(secondParams);
	if (second === undefined) {
		console.log(`     SKIP (upstream refused): ${state.blocked}`);
		return;
	}
	if (second.papers.length === 0) {
		if (await emptyIsUpstream(secondParams, 'page 2')) console.log('     SKIP: upstream served a page without result blocks');
		return;
	}
	const firstIds = new Set(first.papers.map((paper) => paper.id));
	const overlap = second.papers.filter((paper) => firstIds.has(paper.id)).length;
	assert.equal(overlap, 0, `page 2 overlaps page 1 by ${overlap} papers`);
	console.log(`     page 2 starts with "${second.papers[0].title.slice(0, 70)}"`);
});

suite.test('renders through the model-facing path', async () => {
	const params = { query: 'base editing', limit: 3, offset: 0 };
	const result = await liveSearch(params);
	if (result === undefined) {
		console.log(`     SKIP (upstream refused): ${state.blocked}`);
		return;
	}
	if (result.papers.length === 0) {
		if (await emptyIsUpstream(params, 'render path')) console.log('     SKIP: upstream served a page without result blocks');
		return;
	}
	const value = searchEnvelope('google-scholar', 'base editing', result.papers, { truncated: result.truncated });
	const text = formatSearch(value, 'Google Scholar');
	assert.match(text, /Google Scholar search: "base editing"/);
	assert.match(text, /cited by \d+/);
	console.log(text.split('\n').slice(0, 6).map((line) => `     ${line}`).join('\n'));
});

suite.test('scholar_cite refuses the HTML backend with guidance', async () => {
	await assert.rejects(() => client.cite('some-result-id'), /needs scholarProvider "serpapi"/);
});

const outcome = await suite.run();
if (state.blocked !== undefined) {
	console.log('');
	console.log(`NOTE: Google refused at least one request (${state.blocked.slice(0, 120)}).`);
	console.log('      That is upstream anti-bot behaviour, not a parser defect; use SERPAPI_API_KEY for a supported route.');
}
process.exitCode = outcome.failed > 0 ? 1 : 0;
