/**
 * Parser for the MEDLINE text format that `efetch.fcgi?db=pubmed&rettype=medline`
 * returns. One record per blank-line-separated block; every field is a
 * four-character tag, a dash, and a value whose continuation lines are indented.
 *
 * @module dsh-literature-search/medline
 */
import { compact, decodeEntities, text, yearOf } from './paper.js';

const FIELD = /^([A-Z]{2,4})\s*-\s?(.*)$/;

/**
 * Split a MEDLINE payload into `tag -> values[]` records.
 * @param {string} payload - raw MEDLINE text (one or more records).
 * @returns {Array<Record<string, string[]>>} one field map per record.
 */
export function parseMedline(payload) {
	const records = [];
	let current;
	let tag;
	for (const rawLine of payload.split(/\r?\n/)) {
		const line = rawLine.replace(/\s+$/, '');
		if (line.trim().length === 0) {
			if (current !== undefined && Object.keys(current).length > 0) records.push(current);
			current = undefined;
			tag = undefined;
			continue;
		}
		const match = FIELD.exec(line);
		if (match !== null) {
			current ??= {};
			tag = match[1];
			const value = match[2].trim();
			(current[tag] ??= []).push(value);
			continue;
		}
		if (current === undefined || tag === undefined) continue;
		const values = current[tag];
		values[values.length - 1] = `${values[values.length - 1]} ${line.trim()}`.trim();
	}
	if (current !== undefined && Object.keys(current).length > 0) records.push(current);
	return records;
}

/** First value of a tag, trimmed and entity-decoded. */
function first(record, tag) {
	const value = record[tag]?.[0];
	return value === undefined ? undefined : decodeEntities(value.replace(/\s+/g, ' ').trim());
}

/** All values of a tag, trimmed, de-duplicated, in order. */
function all(record, tag) {
	const values = record[tag];
	if (values === undefined) return [];
	const seen = new Set();
	const out = [];
	for (const value of values) {
		const clean = decodeEntities(value.replace(/\s+/g, ' ').trim());
		if (clean === undefined || clean.length === 0 || seen.has(clean)) continue;
		seen.add(clean);
		out.push(clean);
	}
	return out;
}

/** Extract a DOI from the `LID`/`AID` fields, which tag it with `[doi]`. */
function doiOf(record) {
	for (const tag of ['LID', 'AID']) {
		for (const value of record[tag] ?? []) {
			const match = /^\s*(10\.[^\s]+)\s*\[doi\]\s*$/i.exec(value);
			if (match !== null) return match[1];
		}
	}
	return undefined;
}

/** Reduce a MeSH heading to its bare descriptor (`COVID-19/prevention & control` -> `COVID-19`). */
function meshTerm(value) {
	const withoutTopic = value.replace(/^\*/, '');
	const [descriptor] = withoutTopic.split('/');
	return descriptor?.trim();
}

/**
 * Convert one MEDLINE record into the shared paper shape.
 * @param {Record<string, string[]>} record - parsed fields.
 * @returns {object|undefined} the normalized paper, or `undefined` without a PMID.
 */
export function medlineToPaper(record) {
	const pmid = first(record, 'PMID');
	if (pmid === undefined) return undefined;
	const authors = all(record, 'FAU');
	const authorNames = authors.length > 0 ? authors : all(record, 'AU');
	const date = first(record, 'DP');
	const mesh = [];
	for (const value of record.MH ?? []) {
		const term = meshTerm(decodeEntities(value.replace(/\s+/g, ' ').trim()) ?? '');
		if (term !== undefined && term.length > 0 && !mesh.includes(term)) mesh.push(term);
	}
	const pages = first(record, 'PG');
	return compact({
		source: 'pubmed',
		id: pmid,
		pmid,
		title: first(record, 'TI'),
		authors: authorNames,
		year: yearOf(date),
		date,
		venue: first(record, 'JT') ?? first(record, 'TA'),
		volume: first(record, 'VI'),
		issue: first(record, 'IP'),
		pages,
		abstract: first(record, 'AB'),
		doi: doiOf(record),
		pmcid: first(record, 'PMC'),
		url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
		publicationTypes: all(record, 'PT'),
		meshTerms: mesh,
		keywords: all(record, 'OT')
	});
}

/** Rendered `CIN`/`COI` comment lines, used as a paper's forward references. */
export function medlineReferences(record) {
	const lines = [];
	for (const tag of ['CIN', 'CON', 'COI']) {
		for (const value of record[tag] ?? []) {
			const clean = text(decodeEntities(value));
			if (clean !== undefined) lines.push(clean);
		}
	}
	return lines;
}
