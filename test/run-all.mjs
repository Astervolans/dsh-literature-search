/**
 * Runs every offline suite in this directory. No test framework, no network.
 *
 *   node test/run-all.mjs
 */
const suites = ['medline', 'scholar', 'plugin', 'web', 'client', 'config'];

let failed = 0;
for (const name of suites) {
	console.log(`\n== ${name} ==`);
	try {
		const module = await import(`./${name}.test.mjs`);
		const result = await module.default.run();
		failed += result.failed;
	} catch (error) {
		failed += 1;
		console.log(`  FAIL suite ${name} crashed: ${error?.message ?? String(error)}`);
		if (error?.stack !== undefined) console.log(error.stack);
	}
}

console.log('');
if (failed > 0) {
	console.log(`${failed} FAILURE(S)`);
	process.exitCode = 1;
} else {
	console.log('ALL PASSED');
}


