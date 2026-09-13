/**
 * Dependency-free HTTP layer for dsh-literature-search: one shared rate
 * limiter per upstream host, per-attempt timeouts, retries with exponential
 * backoff, `Retry-After` support, and JSON/text decoding with useful errors.
 *
 * @module dsh-literature-search/http
 */

/** An upstream request that failed after its retries. */
export class HttpError extends Error {
	/**
	 * @param {string} message - human-readable summary.
	 * @param {object} [info] - `{ status, url, body }` context.
	 */
	constructor(message, info = {}) {
		super(message);
		this.name = 'HttpError';
		this.status = info.status;
		this.url = info.url;
		this.body = info.body;
	}
}

/** HTTP status codes worth retrying (transient upstream or rate limiting). */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 509, 522, 524]);

/** Sleep, rejecting promptly when the caller's signal aborts. */
export function sleep(ms, signal) {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('request aborted'));
		};
		if (signal === undefined) return;
		if (signal.aborted) {
			clearTimeout(timer);
			reject(new Error('request aborted'));
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Serializes operations so consecutive starts are at least `minIntervalMs`
 * apart. The whole operation runs inside the gate, which keeps a burst of
 * parallel tool calls inside the upstream's published rate limit.
 */
export class RateLimiter {
	/**
	 * @param {number} minIntervalMs - minimum spacing between operation starts.
	 */
	constructor(minIntervalMs = 0) {
		this.minIntervalMs = Math.max(0, minIntervalMs);
		this.chain = Promise.resolve();
		this.lastStart = 0;
	}

	/**
	 * Run `task` once the rate gate allows it.
	 * @template T
	 * @param {() => Promise<T>} task - the operation to serialize.
	 * @param {AbortSignal} [signal] - caller cancellation.
	 * @returns {Promise<T>} the task result.
	 */
	async run(task, signal) {
		const previous = this.chain;
		let release;
		this.chain = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			const waitMs = Math.max(0, this.lastStart + this.minIntervalMs - Date.now());
			if (waitMs > 0) await sleep(waitMs, signal);
			this.lastStart = Date.now();
			return await task();
		} finally {
			release();
		}
	}
}

/** Combine a caller signal with a per-attempt timeout signal. */
function attemptSignal(signal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Parse a `Retry-After` header in either delta-seconds or HTTP-date form. */
function retryAfterMs(header) {
	if (typeof header !== 'string' || header.length === 0) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const date = Date.parse(header);
	if (Number.isNaN(date)) return undefined;
	return Math.max(0, date - Date.now());
}

/**
 * Perform one HTTP request with retries, honouring the shared limiter.
 * @param {string} url - absolute URL.
 * @param {object} options - `{ method, headers, body, signal, timeoutMs, maxRetries, retryBackoffMs, userAgent, limiter, accept }`.
 * @returns {Promise<{ status: number, headers: Headers, text: string, url: string }>} the response.
 */
export async function request(url, options = {}) {
	const {
		method = 'GET',
		headers = {},
		body,
		signal,
		timeoutMs = 30_000,
		maxRetries = 3,
		retryBackoffMs = 1_000,
		userAgent,
		limiter,
		accept = 'application/json, text/plain, */*'
	} = options;
	const send = async () => {
		let lastError;
		for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
			if (signal?.aborted) throw new Error('request aborted');
			try {
				const response = await fetch(url, {
					method,
					headers: {
						accept,
						...(userAgent !== undefined && userAgent.length > 0 ? { 'user-agent': userAgent } : {}),
						...headers
					},
					...(body === undefined ? {} : { body }),
					redirect: 'follow',
					signal: attemptSignal(signal, timeoutMs)
				});
				const text = await response.text();
				if (response.ok) return { status: response.status, headers: response.headers, text, url: response.url || url };
				if (!RETRY_STATUS.has(response.status) || attempt === maxRetries) {
					throw new HttpError(`HTTP ${response.status} from ${hostOf(url)}`, {
						status: response.status,
						url,
						body: text.slice(0, 500)
					});
				}
				lastError = new HttpError(`HTTP ${response.status} from ${hostOf(url)}`, {
					status: response.status,
					url,
					body: text.slice(0, 200)
				});
				const after = retryAfterMs(response.headers.get('retry-after'));
				await sleep(after ?? retryBackoffMs * 2 ** attempt, signal);
			} catch (error) {
				if (error instanceof HttpError && !RETRY_STATUS.has(error.status)) throw error;
				if (signal?.aborted) throw new Error('request aborted');
				if (attempt === maxRetries) {
					if (error instanceof HttpError) throw error;
					throw new HttpError(`network failure talking to ${hostOf(url)}: ${error?.message ?? String(error)}`, { url });
				}
				lastError = error;
				await sleep(retryBackoffMs * 2 ** attempt, signal);
			}
		}
		throw lastError ?? new HttpError(`request to ${hostOf(url)} failed`, { url });
	};
	return limiter === undefined ? send() : limiter.run(send, signal);
}

/**
 * Request a URL and parse the body as JSON.
 * @param {string} url - absolute URL.
 * @param {object} options - as {@link request}.
 * @returns {Promise<unknown>} the decoded JSON value.
 */
export async function requestJson(url, options = {}) {
	const response = await request(url, { ...options, accept: 'application/json' });
	try {
		return JSON.parse(response.text);
	} catch (error) {
		throw new HttpError(`invalid JSON from ${hostOf(url)}: ${error?.message ?? String(error)}`, {
			status: response.status,
			url,
			body: response.text.slice(0, 300)
		});
	}
}

/** Host name of a URL, for error messages. */
export function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Build a query string, skipping `undefined`/empty values. */
export function queryString(params) {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === '') continue;
		search.set(key, String(value));
	}
	return search.toString();
}
