/**
 * Minimal dependency-free test harness: no framework, no install step.
 * Each `*.test.mjs` file builds a suite and exports it; `run-all.mjs` runs all.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** True when this module was started directly with `node file.mjs`. */
export function isMain(metaUrl) {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	try {
		return metaUrl === pathToFileURL(entry).href;
	} catch {
		return false;
	}
}

/**
 * Build a named suite of assertions.
 * @param {string} label - suite name shown in output.
 * @returns {{ test: (name: string, fn: () => unknown) => void, run: () => Promise<{ passed: number, failed: number }> }} the suite.
 */
export function createSuite(label) {
	const cases = [];
	return {
		test(caseName, fn) {
			cases.push({ name: caseName, fn });
		},
		async run() {
			let passed = 0;
			const failures = [];
			for (const entry of cases) {
				try {
					await entry.fn();
					passed += 1;
					console.log(`  ok   ${entry.name}`);
				} catch (error) {
					failures.push({ name: entry.name, error });
					console.log(`  FAIL ${entry.name}`);
					console.log(`       ${error?.message ?? String(error)}`);
				}
			}
			console.log(`${label}: ${passed}/${cases.length} passed`);
			return { passed, failed: failures.length, failures };
		}
	};
}

/**
 * True when a failure came from the upstream (transport, DNS, timeout, HTTP 429
 * or an anti-bot interstitial) rather than from our code. Live suites use this
 * to report SKIP instead of FAIL: egress from a sandbox or CI runner is often
 * intermittent, and Google's blocking is a policy decision, not a defect here.
 */
export function isUpstreamUnavailable(error) {
	const message = `${error?.message ?? String(error)} ${error?.cause?.code ?? ''} ${error?.cause?.message ?? ''}`;
	return /fetch failed|network failure|socket hang up|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|HTTP 429|unusual traffic|anti-bot|captcha/i.test(
		message
	);
}

export { assert };
