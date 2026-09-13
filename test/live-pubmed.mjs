/**
 * Live network smoke test against the real PubMed E-utilities.
 *
 *   node test/live-pubmed.mjs
 *
 * Needs outbound HTTPS to eutils.ncbi.nlm.nih.gov. Set NCBI_API_KEY to exercise
 * the 10-requests/second path (optional). A transport-level failure (no egress,
 * DNS, timeout, HTTP 429) is reported as SKIP, not FAIL: it says nothing about
 * the plugin. Google Scholar is intentionally not exercised here — see
 * live-scholar.mjs.
 */
import { PubmedClient } from '../lib/pubmed.js';
import { RateLimiter } from '../lib/http.js';
import { formatSearch, searchEnvelope } from '../lib/paper.js';
import { createSuite, assert, isUpstreamUnavailable } from './harness.mjs';

const suite = createSuite('live pubmed');

const client = new PubmedClient({
	baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
	tool: 'dsh-literature-search-selftest',
	email: process.env.NCBI_EMAIL,
	apiKey: process.env.NCBI_API_KEY,
	timeoutMs: 30_000,
	maxRetries: 2,
	retryBackoffMs: 1_500,
	userAgent: 'dsh-literature-search-selftest/0.1.0',
	limiter: new RateLimiter(process.env.NCBI_API_KEY === undefined ? 400 : 120)
});

const state = { skipped: 0, reason: undefined };

/** Run one live call, converting an upstream outage into a SKIP. */
async function live(task) {
	try {
		return { value: await task() };
	} catch (error) {
		if (isUpstreamUnavailable(error)) {
			state.skipped += 1;
			state.reason = error.message;
			return { skipped: true };
		}
		throw error;
	}
}

suite.test('esearch returns a large result set for a plain query', async () => {
	const outcome = await live(() => client.search({ query: 'CRISPR base editing', retmax: 5, retstart: 0, sort: 'relevance' }));
	if (outcome.skipped) return console.log(`     SKIP (no egress): ${state.reason}`);
	const found = outcome.value;
	assert.equal(found.pmids.length, 5);
	assert.equal(found.total > 1000, true);
	assert.match(found.pmids[0], /^\d+$/);
});

suite.test('searchPapers enriches results with abstracts and DOIs', async () => {
	const outcome = await live(() => client.searchPapers({ query: 'BNT162b2 vaccine efficacy', limit: 3, offset: 0, withAbstract: true }));
	if (outcome.skipped) return console.log(`     SKIP (no egress): ${state.reason}`);
	const result = outcome.value;
	assert.equal(result.papers.length, 3);
	assert.equal(result.papers.some((paper) => paper.abstract !== undefined), true, 'no abstract parsed');
	assert.equal(result.papers.some((paper) => paper.doi !== undefined), true, 'no DOI parsed');
	console.log(`     sample: ${result.papers[0].title}`);
});

suite.test('date limits and sort=pub_date are accepted', async () => {
	const outcome = await live(() =>
		client.searchPapers({ query: 'base editing', limit: 2, offset: 0, sort: 'pub_date', minDate: '2024', maxDate: '2025', withAbstract: false })
	);
	if (outcome.skipped) return console.log(`     SKIP (no egress): ${state.reason}`);
	assert.equal(outcome.value.papers.length, 2);
	// ESearch echoes the translated query, which is the authoritative proof that
	// the window reached PubMed. Individual `pubdate` values can still read
	// later than maxdate: PubMed filters on the print publication date while
	// ahead-of-print records report their assigned issue year in ESummary.
	const found = await live(() => client.search({ query: 'base editing', retmax: 1, retstart: 0, minDate: '2024', maxDate: '2025' }));
	if (found.skipped) return console.log(`     SKIP (no egress): ${state.reason}`);
	assert.match(found.value.translation ?? '', /2024\/01\/01:2025\/12\/31\[Date - Publication\]/);
	console.log(`     reported dates: ${outcome.value.papers.map((paper) => paper.date).join(', ')}`);
});

suite.test('a known PMID round-trips through efetch', async () => {
	const outcome = await live(() => client.paper('33301246'));
	if (outcome.skipped) return console.log(`     SKIP (no egress): ${state.reason}`);
	assert.equal(outcome.value.paper.title, 'Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine.');
	assert.equal(outcome.value.paper.doi, '10.1056/NEJMoa2034577');
	assert.match(outcome.value.paper.abstract, /BNT162b2/);
	const preview = formatSearch(searchEnvelope('pubmed', 'lookup', [outcome.value.paper]), 'PubMed').split('\n').slice(0, 6);
	console.log(preview.map((line) => `     ${line}`).join('\n'));
});

suite.test('related articles resolve for a known PMID', async () => {
	const outcome = await live(async () => {
		const pmids = await client.related('33301246', 5);
		return { pmids, summaries: await client.summary(pmids) };
	});
	if (outcome.skipped) return console.log(`     SKIP (no egress): ${state.reason}`);
	assert.equal(outcome.value.pmids.length > 0, true);
	assert.equal(outcome.value.summaries.size > 0, true);
});

const outcome = await suite.run();
if (state.skipped > 0) {
	console.log('');
	console.log(`NOTE: ${state.skipped} live test(s) skipped — upstream unreachable (${(state.reason ?? '').slice(0, 120)}).`);
	console.log('      Re-run when egress to eutils.ncbi.nlm.nih.gov is available.');
}
process.exitCode = outcome.failed > 0 ? 1 : 0;
