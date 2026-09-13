/** MEDLINE text parser and PubMed paper normalization. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { medlineReferences, medlineToPaper, parseMedline } from '../lib/medline.js';
import { esummaryToPaper, mergePubmed } from '../lib/pubmed.js';
import { createSuite, assert, isMain } from './harness.mjs';

const fixture = fileURLToPath(new URL('./fixtures/medline-sample.txt', import.meta.url));
const payload = await readFile(fixture, 'utf8');
const records = parseMedline(payload);

const suite = createSuite('medline');

suite.test('splits two records and joins continuation lines', () => {
	assert.equal(records.length, 2);
	assert.equal(records[0].PMID[0], '33301246');
	assert.match(records[0].AB[0], /^BACKGROUND: Severe acute respiratory syndrome/);
	assert.match(records[0].AB[0], /protection\.$/);
	assert.equal(records[0].SO[0].endsWith('2020 Dec 10.'), true);
});

suite.test('normalizes the first record', () => {
	const paper = medlineToPaper(records[0]);
	assert.equal(paper.source, 'pubmed');
	assert.equal(paper.pmid, '33301246');
	assert.equal(paper.title, 'Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine.');
	assert.deepEqual(paper.authors, ['Polack, Fernando P', 'Thomas, Stephen J', 'Gruber, William C']);
	assert.equal(paper.year, 2020);
	assert.equal(paper.date, '2020 Dec 31');
	assert.equal(paper.venue, 'The New England journal of medicine');
	assert.equal(paper.volume, '383');
	assert.equal(paper.issue, '27');
	assert.equal(paper.pages, '2603-2615');
	assert.equal(paper.doi, '10.1056/NEJMoa2034577');
	assert.equal(paper.pmcid, 'PMC7745181');
	assert.deepEqual(paper.publicationTypes, ['Clinical Trial, Phase III', 'Journal Article', 'Randomized Controlled Trial']);
	assert.deepEqual(paper.keywords, ['covid-19', 'mRNA vaccine']);
	assert.equal(paper.url, 'https://pubmed.ncbi.nlm.nih.gov/33301246/');
});

suite.test('strips MeSH qualifiers and major-topic stars', () => {
	const paper = medlineToPaper(records[0]);
	assert.equal(paper.meshTerms.includes('COVID-19'), true);
	assert.equal(paper.meshTerms.includes('SARS-CoV-2'), true);
	assert.equal(paper.meshTerms.some((term) => term.includes('/')), false);
	assert.equal(paper.meshTerms.some((term) => term.startsWith('*')), false);
});

suite.test('keeps comment-in lines as references', () => {
	const references = medlineReferences(records[0]);
	assert.equal(references.length, 1);
	assert.match(references[0], /NEJMe2034717/);
});

suite.test('decodes entities in MEDLINE fields', () => {
	const paper = medlineToPaper({ PMID: ['1'], TI: ['A &amp; B &#x3bc;g &lt;test&gt;'] });
	assert.equal(paper.title, 'A & B μg <test>');
});

suite.test('esummary normalization fills DOI, PMC id and venue', () => {
	const paper = esummaryToPaper({
		uid: '33301246',
		title: 'Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine.',
		authors: [{ name: 'Polack FP' }, { name: 'Thomas SJ' }],
		pubdate: '2020 Dec 31',
		fulljournalname: 'The New England journal of medicine',
		volume: '383',
		issue: '27',
		pages: '2603-2615',
		pubtype: ['Journal Article'],
		articleids: [
			{ idtype: 'pubmed', value: '33301246' },
			{ idtype: 'pmc', value: 'PMC7745181' },
			{ idtype: 'doi', value: '10.1056/NEJMoa2034577' }
		]
	});
	assert.equal(paper.doi, '10.1056/NEJMoa2034577');
	assert.equal(paper.pmcid, 'PMC7745181');
	assert.equal(paper.year, 2020);
	assert.deepEqual(paper.authors, ['Polack FP', 'Thomas SJ']);
});

suite.test('merge prefers MEDLINE detail and keeps ESummary extras', () => {
	const medline = medlineToPaper(records[1]);
	const summary = esummaryToPaper({ uid: '33449100', title: 'from summary', articleids: [{ idtype: 'doi', value: '10.1042/BST20200550' }] });
	const merged = mergePubmed(medline, summary);
	assert.equal(merged.title, 'CRISPR/Cas9 and base editing in cancer.');
	assert.equal(merged.doi, '10.1042/BST20200550');
	assert.equal(merged.pmid, '33449100');
});

if (isMain(import.meta.url)) await suite.run();
export default suite;
