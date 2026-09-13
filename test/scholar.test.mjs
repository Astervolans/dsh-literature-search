/** Google Scholar HTML and SerpApi result normalization. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeSerpApiResult, parseScholarHtml, scholarNextStart } from '../lib/scholar.js';
import { formatSearch, searchEnvelope } from '../lib/paper.js';
import { createSuite, assert, isMain } from './harness.mjs';

const html = await readFile(fileURLToPath(new URL('./fixtures/scholar-sample.html', import.meta.url)), 'utf8');
const serpApi = JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/serpapi-sample.json', import.meta.url)), 'utf8'));

const suite = createSuite('google scholar');

suite.test('parses three HTML results with title, authors, venue and year', () => {
	const papers = parseScholarHtml(html, 'https://scholar.google.com/scholar?q=test');
	assert.equal(papers.length, 3);
	assert.equal(papers[0].title, 'Attention is all you need');
	assert.equal(papers[0].url, 'https://example.org/vaswani2017');
	assert.equal(papers[0].pdfUrl, 'https://example.org/vaswani2017.pdf');
	assert.deepEqual(papers[0].authors, ['A Vaswani', 'N Shazeer', 'N Parmar', 'J Uszkoreit']);
	assert.equal(papers[0].venue, 'Advances in neural information processing systems');
	assert.equal(papers[0].year, 2017);
	assert.equal(papers[0].citationCount, 120543);
	assert.equal(papers[0].resultId, 'abc123xyz');
	assert.match(papers[0].citedByUrl, /cites=1234567890/);
});

suite.test('handles a result without a PDF link and a [BOOK] marker', () => {
	const papers = parseScholarHtml(html);
	assert.equal(papers[1].pdfUrl, undefined);
	assert.equal(papers[1].citationCount, 3120);
	assert.equal(papers[2].title, 'Genome editing: a practical guide');
	assert.equal(papers[2].venue, 'Cold Spring Harbor Laboratory Press');
	assert.equal(papers[2].year, 2021);
});

suite.test('detects Google anti-bot interstitials instead of returning nothing', () => {
	assert.throws(
		() => parseScholarHtml('<html><body>Our systems have detected unusual traffic from your computer network</body></html>'),
		/unusual traffic|anti-bot/
	);
});

suite.test('normalizes SerpApi organic results', () => {
	const papers = serpApi.organic_results.map(normalizeSerpApiResult);
	assert.equal(papers.length, 2);
	assert.equal(papers[0].source, 'google-scholar');
	assert.equal(papers[0].resultId, 'abc123xyz');
	assert.equal(papers[0].year, 2016);
	assert.equal(papers[0].venue, 'Nature');
	assert.deepEqual(papers[0].authors, ['AC Komor', 'YB Kim']);
	assert.equal(papers[0].citationCount, 3120);
	assert.equal(papers[0].pdfUrl, 'https://www.nature.com/articles/nature17946.pdf');
	assert.equal(papers[0].citedByUrl.includes('cites=2222222222'), true);
});

suite.test('detects the next page from pagination links, not the result count', () => {
	// The fixture holds three results and a "start=10" link: a page can be short
	// and still have a next page, so truncation must come from the markup.
	assert.equal(scholarNextStart(html, 0), 10);
	assert.equal(scholarNextStart(html, 10), undefined);
	assert.equal(scholarNextStart('<div class="gs_r gs_or gs_scl">x</div>', 0), undefined);
});

suite.test('renders a search envelope with the cited-by counts', () => {
	const papers = parseScholarHtml(html);
	const value = searchEnvelope('google-scholar', 'CRISPR base editing', papers, { truncated: true });
	const rendered = formatSearch(value, 'Google Scholar');
	assert.match(rendered, /Google Scholar search: "CRISPR base editing"/);
	assert.match(rendered, /cited by 120543/);
	assert.match(rendered, /More results available — call again with offset=3\./);
});

if (isMain(import.meta.url)) await suite.run();
export default suite;
