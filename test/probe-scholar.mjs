/**
 * Reachability diagnostic for scholar.google.com and its regional mirrors
 * (no plugin code involved).
 *
 *   node test/probe-scholar.mjs
 *
 * Prints status, size, parsed result-block count and block-page detection for
 * each host, then five rapid `start=` pages on the main host, so "Google is
 * blocking / unreachable" can be told apart from "the parser broke".
 */
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const headers = { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' };
const blocked = /unusual traffic|not a robot|captcha|\/sorry\//i;

/** Fetch one URL and report what came back. */
async function probe(label, url) {
	const started = Date.now();
	// The anti-bot heuristic only applies to Scholar hosts: unrelated sites can
	// legitimately contain the words it looks for.
	const isScholar = label.includes('scholar');
	try {
		const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
		const body = await response.text();
		const blocks = (body.match(/class="gs_r\b/g) ?? []).length;
		const title = /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? '';
		console.log(
			`${label.padEnd(22)} status=${response.status} bytes=${body.length} resultBlocks=${blocks} ` +
				`blocked=${isScholar && blocked.test(body)} ${Date.now() - started}ms  "${title.slice(0, 50)}"`
		);
		return { status: response.status, blocks, blocked: isScholar && blocked.test(body) };
	} catch (error) {
		console.log(`${label.padEnd(22)} ERR ${error.cause?.code ?? error.message} (${Date.now() - started}ms)`);
		return { error: error.cause?.code ?? error.message };
	}
}

console.log('== hosts ==');
await probe('scholar.google.com', 'https://scholar.google.com/scholar?q=base+editing&hl=en&as_sdt=0%2C5');
await probe('scholar.google.com.hk', 'https://scholar.google.com.hk/scholar?q=base+editing&hl=en&as_sdt=0%2C5');
await probe('scholar.google.co.jp', 'https://scholar.google.co.jp/scholar?q=base+editing&hl=en&as_sdt=0%2C5');
await probe('scholar.google.de', 'https://scholar.google.de/scholar?q=base+editing&hl=en&as_sdt=0%2C5');
await probe('serpapi.com', 'https://serpapi.com/');
await probe('eutils.ncbi.nlm.nih.gov', 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=crispr&retmode=json&retmax=1');

console.log('== five rapid paged requests on the main host ==');
for (let index = 1; index <= 5; index += 1) {
	await probe(`start=${index * 10}`, `https://scholar.google.com/scholar?q=base+editing&hl=en&as_sdt=0%2C5&start=${index * 10}`);
}

console.log('');
console.log('resultBlocks > 0        => the HTML backend can parse this host (scholarBaseUrl is configurable)');
console.log('blocked=true            => Google served its anti-bot interstitial (use SERPAPI_API_KEY)');
console.log('ERR UND_ERR_CONNECT_TIMEOUT => the host is unreachable from this network (blocked / needs a proxy)');
