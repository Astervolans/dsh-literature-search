/**
 * Web host surface for dsh-literature-search: the `/plugin/literature-search`
 * route tree behind the Settings -> Plugins card.
 *
 * Config reads/writes go through the settings seam (`ctx.settings`, revision
 * fenced); API-key values cross the wire only inside a POST body and are stored
 * through the credentials seam (`ctx.credentials`), never in the settings
 * document. Origin checks allow same-origin browser calls only.
 *
 * @module dsh-literature-search/web
 */
import { HttpError } from './http.js';

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/plugin/literature-search';

/** Settings namespace owned by this plugin. */
export const SETTINGS_NS = 'literature-search';

/** Credential slots the card may write, keyed by the field naming the ref. */
export const CREDENTIAL_SLOTS = [
	{ slot: 'pubmed', field: 'pubmedApiKeyEnv', inlineField: 'pubmedApiKey', label: 'NCBI API key' },
	{ slot: 'scholar', field: 'scholarSerpApiKeyEnv', inlineField: 'scholarSerpApiKey', label: 'SerpApi key' }
];

/** Credential references look like POSIX environment variable names. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Cap on one JSON request body. */
const JSON_BODY_LIMIT = 1 << 20;

/** Read a JSON request body. */
function readBody(req, limit = JSON_BODY_LIMIT) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/** Send one JSON response. */
export function sendJson(res, status, payload) {
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff'
	});
	res.end(JSON.stringify(payload));
}

/** Resolve the credential reference for one slot from the live config. */
export function slotRef(config, slotName) {
	const entry = CREDENTIAL_SLOTS.find((candidate) => candidate.slot === slotName);
	if (entry === undefined) return undefined;
	const value = config?.[entry.field];
	if (typeof value === 'string' && REF_PATTERN.test(value)) return { ...entry, ref: value };
	return undefined;
}

/**
 * Read one credential slot through both seams and report what each one saw.
 *
 * `describe` is the documented presence probe, but a composition can expose a
 * credentials service that resolves a value while reporting it unconfigured
 * (or that throws). Probing with `resolve` as well — and surfacing both raw
 * outcomes — keeps the badge honest and makes a broken seam diagnosable from
 * the UI instead of silently showing "not configured".
 *
 * @param {object} config - live plugin config.
 * @param {object} candidate - one {@link CREDENTIAL_SLOTS} entry.
 * @param {object} deps - `{ credentials, settingSecrets }`.
 * @returns {Promise<object>} the slot facts (never the value itself).
 */
async function collectSlot(config, candidate, deps) {
	const target = slotRef(config, candidate.slot);
	const inlineValue = typeof config?.[candidate.inlineField] === 'string' ? config[candidate.inlineField].trim() : '';
	const secretPath = deps.settingSecrets?.find((entry) => entry.path?.[0] === candidate.inlineField);
	const facts = {
		slot: candidate.slot,
		label: candidate.label,
		ref: target?.ref ?? null,
		describeRaw: null,
		describeError: null,
		resolveFound: false,
		resolveSource: null,
		configured: false,
		source: null,
		writable: true,
		inlineConfigured: inlineValue.length > 0,
		settingSecretSet: secretPath?.set === true,
		mode: null
	};

	if (target !== undefined && deps.credentials !== undefined) {
		try {
			const info = await deps.credentials.describe(target.ref);
			facts.describeRaw = info === undefined ? null : { configured: info.configured === true, source: info.source ?? null, writable: info.writable !== false };
		} catch (error) {
			facts.describeError = String(error?.message ?? error).slice(0, 200);
		}
		try {
			const hit = await deps.credentials.resolve(target.ref);
			facts.resolveFound = typeof hit?.value === 'string' && hit.value.length > 0;
			facts.resolveSource = hit?.source ?? null;
		} catch (error) {
			facts.describeError ??= `resolve: ${String(error?.message ?? error).slice(0, 180)}`;
		}
	}

	if (inlineValue.length > 0) {
		facts.configured = true;
		facts.source = 'settings-inline';
		facts.mode = 'inline';
	} else if (facts.describeRaw?.configured === true) {
		facts.configured = true;
		facts.source = facts.describeRaw.source;
		facts.writable = facts.describeRaw.writable;
		facts.mode = 'credentials';
	} else if (facts.resolveFound) {
		facts.configured = true;
		facts.source = facts.resolveSource ?? 'resolve';
		facts.mode = 'credentials';
	} else if (facts.settingSecretSet) {
		facts.configured = true;
		facts.source = 'settings-secret';
		facts.mode = 'settings';
	}
	return facts;
}

/**
 * Non-secret facts for the card's status badges.
 * @param {object} config - live plugin config.
 * @param {object} deps - `{ credentials, settingSecrets }` accessors.
 * @returns {Promise<object>} the facts object.
 */
export async function collectFacts(config, deps) {
	const credentials = [];
	for (const candidate of CREDENTIAL_SLOTS) {
		credentials.push(await collectSlot(config, candidate, deps));
	}
	return {
		pubmed: {
			enabled: config?.pubmedEnabled !== false,
			baseUrl: config?.pubmedBaseUrl,
			rateLimitMs: config?.pubmedRateLimitMs
		},
		scholar: {
			enabled: config?.scholarEnabled !== false,
			provider: config?.scholarProvider,
			baseUrl: config?.scholarBaseUrl,
			serpApiBaseUrl: config?.scholarSerpApiBaseUrl
		},
		credentialsService: deps.credentials !== undefined,
		credentials,
		checkedAt: new Date().toISOString()
	};
}

/**
 * Best-effort diagnostic dump so a misbehaving seam can be inspected from disk
 * without a debugger. Never contains a secret value — only presence, source and
 * error strings.
 * @param {object} payload - what to record.
 * @returns {Promise<string|undefined>} the written path, when one was written.
 */
export async function writeDiagnostics(payload) {
	try {
		const { mkdir, writeFile } = await import('node:fs/promises');
		const { homedir } = await import('node:os');
		const { join } = await import('node:path');
		const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
		const dir = join(dshHome, '.dsh-literature-search');
		await mkdir(dir, { recursive: true });
		const file = join(dir, 'diagnostics.json');
		// Environment presence (never values) settles "is the key in the file the
		// host reads, or only in the process environment" without a debugger.
		const environment = {
			dshHome,
			homedir: homedir(),
			cwd: process.cwd(),
			pubmedKeyInEnv: typeof process.env.NCBI_API_KEY === 'string' && process.env.NCBI_API_KEY.length > 0,
			serpApiKeyInEnv: typeof process.env.SERPAPI_API_KEY === 'string' && process.env.SERPAPI_API_KEY.length > 0
		};
		await writeFile(file, `${JSON.stringify({ at: new Date().toISOString(), version: payload.version, environment, ...payload }, null, 2)}\n`, 'utf8');
		return file;
	} catch {
		return undefined;
	}
}

/** Probe the configured PubMed endpoint with one cheap search. */
async function probePubmed(runtime) {
	const started = Date.now();
	try {
		const client = await runtime.pubmed();
		const found = await client.search({ query: 'crispr', retmax: 1, retstart: 0, sort: 'relevance' });
		return {
			target: 'pubmed',
			ok: true,
			ms: Date.now() - started,
			detail: `NCBI E-utilities OK — esearch returned ${found.total.toLocaleString('en-US')} matches`
		};
	} catch (error) {
		return { target: 'pubmed', ok: false, ms: Date.now() - started, detail: error?.message ?? String(error) };
	}
}

/** Probe the configured Google Scholar backend with one page. */
async function probeScholar(runtime) {
	const started = Date.now();
	try {
		const client = await runtime.scholar();
		const provider = await client.backend();
		const result = await client.search({ query: 'base editing', limit: 10, offset: 0 });
		return {
			target: 'scholar',
			ok: true,
			ms: Date.now() - started,
			detail: `${provider} backend OK — parsed ${result.papers.length} result(s)`
		};
	} catch (error) {
		const blocked = error instanceof HttpError || /429|unusual traffic|captcha|fetch failed|network failure|CONNECT_TIMEOUT/i.test(String(error?.message));
		return {
			target: 'scholar',
			ok: false,
			ms: Date.now() - started,
			detail: error?.message ?? String(error),
			hint: blocked
				? 'Google Scholar is unreachable or rate-limiting from this machine. Either configure a SerpApi key or point scholarProvider at a reachable route.'
				: undefined
		};
	}
}

/**
 * Handle one request under the plugin's route prefix.
 * @param {object} req - Node request.
 * @param {object} res - Node response.
 * @param {object} deps - `{ webServer, settings, credentials, runtime, schema, version }`.
 * @returns {Promise<void>} resolves once the response is written.
 */
export async function handleRequest(req, res, deps) {
	// Services are resolved per request so a seam that appears (or disappears)
	// after mount is picked up without remounting the routes.
	const services = typeof deps.services === 'function' ? deps.services() : { settings: deps.settings, credentials: deps.credentials };
	const method = req.method ?? 'GET';
	const url = new URL(req.url ?? '/', 'http://localhost');
	const pathname = url.pathname.replace(/\/+$/, '') || '/';
	const route = pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) || '/' : pathname;

	const origin = req.headers?.origin;
	if (typeof origin === 'string' && origin.length > 0) {
		const port = deps.webServer?.port;
		const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://${deps.webServer?.host}:${port}`]);
		if (!allowed.has(origin)) {
			sendJson(res, 403, { ok: false, error: 'cross-origin request refused' });
			return;
		}
	}
	if (method === 'OPTIONS') {
		res.writeHead(204, { 'X-Content-Type-Options': 'nosniff' });
		res.end();
		return;
	}

	const settings = services.settings;
	if (settings === undefined) {
		sendJson(res, 503, { ok: false, error: 'the settings service is not available in this composition' });
		return;
	}

	/** Read the plugin's settings descriptor (redacted) when it is registered. */
	const descriptorOf = () => (settings.describe({ redactSecrets: true }) ?? []).find((entry) => entry.ns === SETTINGS_NS);
	/** Facts include the settings-secret metadata so a slot can report inline keys. */
	const factsFor = async (descriptor) =>
		collectFacts(deps.runtime.config(), { ...services, settingSecrets: descriptor?.secrets ?? [] });

	if (route === '/' && method === 'GET') {
		const descriptor = descriptorOf();
		const facts = await factsFor(descriptor);
		await writeDiagnostics({ route: 'GET /', version: deps.version, services: { settings: true, credentials: services.credentials !== undefined }, facts });
		sendJson(res, 200, { ok: true, plugin: 'dsh-literature-search', version: deps.version, namespace: SETTINGS_NS, facts });
		return;
	}

	if (route === '/config' && method === 'GET') {
		const descriptor = descriptorOf();
		if (descriptor === undefined) {
			sendJson(res, 503, { ok: false, error: `settings namespace "${SETTINGS_NS}" is not registered` });
			return;
		}
		const facts = await factsFor(descriptor);
		await writeDiagnostics({ route: 'GET /config', version: deps.version, services: { settings: true, credentials: services.credentials !== undefined }, facts });
		sendJson(res, 200, {
			ok: true,
			namespace: descriptor.ns,
			revision: descriptor.revision ?? 0,
			value: descriptor.value ?? {},
			base: descriptor.base ?? {},
			user: descriptor.user ?? {},
			applies: descriptor.applies ?? 'live',
			secrets: descriptor.secrets ?? [],
			facts,
			schemaHints: {
				providers: ['auto', 'serpapi', 'html'],
				defaults: deps.defaults ?? {},
				restartKeys: ['enabled', 'pubmedEnabled', 'scholarEnabled', 'promptGuidance', 'promptOrder']
			}
		});
		return;
	}

	if (route === '/config' && (method === 'POST' || method === 'PUT')) {
		let body;
		try {
			body = JSON.parse((await readBody(req)) || '{}');
		} catch {
			sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
			return;
		}
		const patch = body !== null && typeof body.patch === 'object' && body.patch !== null ? body.patch : undefined;
		if (patch === undefined) {
			sendJson(res, 400, { ok: false, error: 'missing patch object' });
			return;
		}
		try {
			await settings.update(SETTINGS_NS, patch, Number.isInteger(body.expectedRevision) ? body.expectedRevision : undefined);
			const descriptor = (settings.describe({ redactSecrets: true }) ?? []).find((entry) => entry.ns === SETTINGS_NS);
			sendJson(res, 200, { ok: true, revision: descriptor?.revision ?? 0 });
		} catch (error) {
			if (error?.code === 'SETTINGS_CONFLICT' || error?.name === 'SettingsConflictError') {
				sendJson(res, 409, {
					ok: false,
					conflict: true,
					currentRevision: error.actual,
					error: '设置已被其他会话修改，请重新加载后再保存。'
				});
				return;
			}
			sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 500) });
		}
		return;
	}

	if (route === '/credential' && method === 'POST') {
		let body;
		try {
			body = JSON.parse((await readBody(req)) || '{}');
		} catch {
			sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
			return;
		}
		const config = deps.runtime.config();
		const target = slotRef(config, typeof body.slot === 'string' ? body.slot : '');
		if (target === undefined) {
			sendJson(res, 400, { ok: false, error: 'unknown or invalid credential slot' });
			return;
		}
		const value = typeof body.value === 'string' ? body.value.trim() : '';
		if (body.clear !== true && (value.length === 0 || value.length > 4096)) {
			sendJson(res, 400, { ok: false, error: '密钥为空或过长（1..4096 字符）' });
			return;
		}
		const credentials = services.credentials;
		const descriptor = descriptorOf();
		/** Result envelope shared by both write paths. */
		const respond = async (mode, detail) => {
			const facts = await factsFor(descriptorOf());
			await writeDiagnostics({ route: 'POST /credential', version: deps.version, slot: target.slot, mode, detail, facts });
			const slot = facts.credentials.find((entry) => entry.slot === target.slot);
			sendJson(res, detail.ok ? 200 : 400, {
				ok: detail.ok,
				slot: target.slot,
				mode,
				ref: target.ref,
				configured: slot?.configured === true,
				source: slot?.source ?? null,
				writable: slot?.writable !== false,
				error: detail.error
			});
		};

		if (credentials !== undefined) {
			try {
				if (body.clear === true) await credentials.unset(target.ref);
				else await credentials.set(target.ref, value);
				// An inline settings key would win over the store, so clear it on write.
				if (body.clear !== true && config?.[target.inlineField] !== undefined) {
					try {
						await settings.update(SETTINGS_NS, { [target.inlineField]: '' }, descriptor?.revision);
					} catch {
						// Best effort: the stored credential is already in place.
					}
				}
				await respond('credentials', { ok: true });
			} catch (error) {
				await respond('credentials', { ok: false, error: String(error?.message ?? error).slice(0, 400) });
			}
			return;
		}

		// No credentials seam in this composition: fall back to the namespace's own
		// secret field, which `resolveSecret` prefers anyway.
		try {
			await settings.update(SETTINGS_NS, { [target.inlineField]: body.clear === true ? '' : value }, descriptor?.revision);
			await respond('settings', { ok: true });
		} catch (error) {
			await respond('settings', { ok: false, error: String(error?.message ?? error).slice(0, 400) });
		}
		return;
	}

	if (route === '/test' && method === 'POST') {
		let body = {};
		try {
			body = JSON.parse((await readBody(req)) || '{}');
		} catch {
			body = {};
		}
		const target = typeof body.target === 'string' ? body.target : 'all';
		const results = [];
		if (target === 'pubmed' || target === 'all') results.push(await probePubmed(deps.runtime));
		if (target === 'scholar' || target === 'all') results.push(await probeScholar(deps.runtime));
		const facts = await factsFor(descriptorOf());
		await writeDiagnostics({ route: 'POST /test', version: deps.version, target, results, facts });
		sendJson(res, 200, { ok: results.every((entry) => entry.ok), results, facts });
		return;
	}

	sendJson(res, 404, { ok: false, error: `unknown route: ${route}` });
}

/**
 * Mount the route tree on the host web server.
 * @param {object} ctx - context with `webServer` and `effect`.
 * @param {object} deps - as {@link handleRequest}.
 * @returns {void}
 */
export function mountHttp(ctx, deps) {
	const webServer = ctx.webServer;
	ctx.effect(
		() =>
			webServer.register({
				kind: 'prefix',
				path: ROUTE_PREFIX,
				handler: (req, res) =>
					handleRequest(req, res, { ...deps, webServer }).catch((error) => {
						if (!res.headersSent) {
							sendJson(res, 500, { ok: false, error: `internal error: ${String(error?.message ?? error).slice(0, 300)}` });
						} else {
							res.destroy();
						}
					})
			}),
		'dsh-literature-search: settings routes'
	);
}
