/**
 * dsh-literature-search — browser half (client plugin).
 *
 * Registers one Settings → Plugins tab that edits this plugin's settings
 * namespace and stores API keys through the host credential store. The bundle
 * is hand-written ESM in the module-loader envelope DSH expects, so the plugin
 * needs no build step: `require("react")` / `require("react/jsx-runtime")` are
 * resolved by the client module loader.
 *
 * Wire contract (see lib/web.js):
 *   GET  /plugin/literature-search/config      -> { revision, value, base, user, facts, schemaHints }
 *   POST /plugin/literature-search/config      <- { patch, expectedRevision }
 *   POST /plugin/literature-search/credential  <- { slot, value } | { slot, clear: true }
 *   POST /plugin/literature-search/test        <- { target: "pubmed" | "scholar" | "all" }
 */
window.__ModuleLoader__.load({
	id: 'dsh-literature-search',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		var React = require('react');
		var { jsx, jsxs, Fragment } = require('react/jsx-runtime');
		var { useState, useEffect, useCallback, useRef } = React;

		var ROUTE = '/plugin/literature-search';

		/** Call one of the plugin's own routes. */
		async function api(path, init) {
			var res = await fetch(ROUTE + path, {
				cache: 'no-store',
				headers: init && init.body ? { 'Content-Type': 'application/json' } : undefined,
				...init
			});
			var payload = null;
			try {
				payload = await res.json();
			} catch (error) {
				payload = null;
			}
			return { status: res.status, payload: payload };
		}

		// ------------------------------------------------------------------
		// Styles (the card lives inside the settings surface)
		// ------------------------------------------------------------------
		var S = {
			wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0 8px' },
			card: {
				background: 'var(--dsw-alias-bg-layer-3, #16181d)',
				border: '1px solid var(--dsw-alias-border-l2, #2a2d34)',
				borderRadius: 10,
				padding: '14px 16px'
			},
			cardHead: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 },
			cardTitle: { flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #e8e8e8)' },
			field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2, #2a2d34)' },
			fieldHead: { display: 'flex', alignItems: 'center', gap: 8 },
			label: { flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary, #e8e8e8)' },
			input: {
				background: 'var(--dsw-alias-bg-layer-3, #16181d)',
				border: '1px solid var(--dsw-alias-border-l2, #2a2d34)',
				borderRadius: 8,
				height: 32,
				padding: '0 10px',
				fontSize: 13,
				color: 'var(--dsw-alias-label-primary, #e8e8e8)',
				width: '100%',
				boxSizing: 'border-box'
			},
			select: {
				background: 'var(--dsw-alias-bg-layer-3, #16181d)',
				border: '1px solid var(--dsw-alias-border-l2, #2a2d34)',
				borderRadius: 8,
				height: 32,
				padding: '0 8px',
				fontSize: 13,
				color: 'var(--dsw-alias-label-primary, #e8e8e8)'
			},
			row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
			hint: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary, #8a8f98)' },
			error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
			ok: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #5dbb76)' },
			mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
			badge: {
				whiteSpace: 'nowrap',
				background: 'var(--dsw-alias-bg-module-platform, #20242c)',
				color: 'var(--dsw-alias-label-secondary, #a8adb8)',
				borderRadius: 999,
				padding: '1px 8px',
				fontSize: 11,
				lineHeight: '17px'
			},
			// Status badges use the state-* alias family, whose *-tertiary background
			// and *-primary foreground are re-paired by the dark theme.
			badgeOk: { whiteSpace: 'nowrap', background: 'var(--dsw-alias-state-success-tertiary, rgba(64, 160, 90, 0.15))', color: 'var(--dsw-alias-state-success-primary, #5dbb76)', borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px' },
			badgeWarn: { whiteSpace: 'nowrap', background: 'var(--dsw-alias-state-warn-tertiary, rgba(214, 158, 46, 0.15))', color: 'var(--dsw-alias-state-warn-primary, #d6a64b)', borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px' },
			badgeErr: { whiteSpace: 'nowrap', background: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(229, 72, 77, 0.15))', color: 'var(--dsw-alias-state-error-primary, #e5484d)', borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px' },
			// Secondary button: the ghost treatment the first-party settings card
			// uses (transparent fill, border-l2 outline, secondary label).
			button: {
				font: 'inherit',
				cursor: 'pointer',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary, #a8adb8)',
				border: '1px solid var(--dsw-alias-border-l2, #2a2d34)',
				borderRadius: 8,
				padding: '6px 14px',
				fontSize: 12
			},
			// Primary button: the first-party pairing (see .BDWblG_save in
			// dsh-client-ui-settings-plugins). `--dsw-alias-label-primary` and
			// `--dsw-alias-bg-layer-3` swap together per theme, so the label stays
			// legible in both. Never pair a brand/background token with a literal
			// colour here: those tokens invert in dark mode (brand-primary is
			// #0f1115 in light and #f9fafb in dark).
			buttonPrimary: {
				font: 'inherit',
				cursor: 'pointer',
				background: 'var(--dsw-alias-label-primary, #0f1115)',
				color: 'var(--dsw-alias-bg-layer-3, #ffffff)',
				border: '1px solid transparent',
				borderRadius: 8,
				padding: '7px 16px',
				fontSize: 12,
				fontWeight: 500
			},
			buttonDisabled: { opacity: 0.4, cursor: 'not-allowed' },
			testLine: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', fontSize: 12 }
		};

		// ------------------------------------------------------------------
		// Small form primitives
		// ------------------------------------------------------------------
		function Badge(props) {
			return jsx('span', { style: props.tone === 'ok' ? S.badgeOk : props.tone === 'warn' ? S.badgeWarn : props.tone === 'err' ? S.badgeErr : S.badge, children: props.children });
		}

		function Field(props) {
			return jsxs('div', {
				style: S.field,
				children: [
					jsxs('div', {
						style: S.fieldHead,
						children: [jsx('label', { style: S.label, children: props.label }), props.badge === undefined ? null : props.badge]
					}),
					props.children,
					props.hint === undefined ? null : jsx('p', { style: S.hint, children: props.hint })
				]
			});
		}

		function TextField(props) {
			return jsx('input', {
				style: S.input,
				value: props.value,
				placeholder: props.placeholder,
				spellCheck: false,
				onChange: (event) => props.onChange(event.target.value)
			});
		}

		function NumberField(props) {
			return jsx('input', {
				style: S.input,
				type: 'number',
				min: 0,
				value: props.value,
				onChange: (event) => props.onChange(event.target.value)
			});
		}

		function SelectField(props) {
			return jsx('select', {
				style: S.select,
				value: props.value,
				onChange: (event) => props.onChange(event.target.value),
				children: props.options.map((option) => jsx('option', { value: option.value, children: option.label }, option.value))
			});
		}

		/** One credential slot: status, save, and clear. */
		function CredentialField(props) {
			var [draft, setDraft] = useState('');
			var info = props.info;
			var tone = info === undefined ? 'warn' : info.configured ? 'ok' : 'warn';
			var statusText;
			if (info === undefined) statusText = '状态未知';
			else if (info.source === 'settings-inline') statusText = '已配置（设置内的密钥字段）';
			else if (info.source === 'settings-secret') statusText = '已配置（保存在设置中）';
			else if (info.configured && info.source === 'env') statusText = '已配置（来源：环境变量 ' + info.ref + '，只读）';
			else if (info.configured) statusText = '已配置（凭据库）';
			else statusText = '未配置';

			// Non-secret explanation of how that state was determined: this is what
			// turns "still shows unconfigured" into an actionable report.
			var detail = [];
			if (info !== undefined) {
				detail.push('ref=' + (info.ref || '—'));
				if (info.describeRaw) detail.push('describe=' + (info.describeRaw.configured ? 'set' : 'unset') + (info.describeRaw.source ? '/' + info.describeRaw.source : ''));
				else detail.push('describe=unavailable');
				detail.push('resolve=' + (info.resolveFound ? 'found' : 'empty'));
				if (info.settingSecretSet) detail.push('settings-secret=set');
				if (info.describeError) detail.push('error=' + info.describeError);
			}
			if (props.serviceMissing) detail.push('凭据服务不可用：密钥会保存到设置里');

			var save = function () {
				if (draft.trim().length === 0 || props.busy) return;
				props.onSave(draft.trim()).then(function (done) {
					if (done) setDraft('');
				});
			};

			return jsxs(Field, {
				label: props.label,
				badge: jsx(Badge, { tone: tone, children: statusText }),
				hint: props.hint,
				children: [
					jsxs('div', {
						style: S.row,
						children: [
							jsx('input', {
								style: { ...S.input, flex: 1, minWidth: 220 },
								type: 'password',
								autoComplete: 'off',
								placeholder: info !== undefined && info.configured ? '••••••••（留空表示不修改）' : '粘贴密钥后点击保存',
								value: draft,
								onChange: (event) => setDraft(event.target.value)
							}),
							jsx('button', {
								style: { ...S.buttonPrimary, ...(draft.trim().length === 0 || props.busy ? S.buttonDisabled : {}) },
								disabled: draft.trim().length === 0 || props.busy,
								onClick: save,
								children: props.busy ? '保存中…' : '保存密钥'
							}),
							jsx('button', {
								style: { ...S.button, ...(props.busy ? S.buttonDisabled : {}) },
								disabled: props.busy,
								onClick: () => props.onClear(),
								children: '清除'
							})
						]
					}),
					detail.length > 0 ? jsx('p', { style: S.hint, children: detail.join(' · ') }) : null,
					props.message === undefined ? null : jsx('p', { style: props.message.ok ? S.ok : S.error, children: props.message.text })
				]
			});
		}

		// ------------------------------------------------------------------
		// Settings tab
		// ------------------------------------------------------------------
		var TEXT_FIELDS = {
			pubmedEmail: { label: '联系邮箱（NCBI 建议填写）', hint: '作为 E-utilities 的 email 参数随每次请求发送。' },
			pubmedTool: { label: 'tool 参数', hint: 'E-utilities 的 tool 参数，用于标识调用方。' },
			pubmedBaseUrl: { label: 'E-utilities 根地址' },
			scholarHl: { label: '界面语言（hl）' },
			scholarBaseUrl: { label: 'Google Scholar 地址（HTML 后端）' },
			scholarSerpApiBaseUrl: { label: 'SerpApi 地址' },
			userAgent: { label: 'User-Agent（留空使用内置 Chrome UA）' }
		};

		var NUMBER_FIELDS = {
			pubmedRateLimitMs: { label: 'PubMed 请求间隔（ms，0 = 自动）', hint: '0 表示无密钥 350ms、有密钥 110ms。' },
			scholarRateLimitMs: { label: 'Google Scholar 请求间隔（ms，0 = 自动）', hint: '0 表示 HTML 2500ms、SerpApi 250ms。' },
			defaultMaxResults: { label: '默认返回条数' },
			maxResultsCap: { label: '单次最多条数' },
			abstractMaxChars: { label: '摘要字符上限（0 = 不返回摘要）' },
			requestTimeoutMs: { label: '单次请求超时（ms）' },
			maxRetries: { label: '失败重试次数' },
			retryBackoffMs: { label: '重试退避基数（ms）' }
		};

		var INT_KEYS = [
			'pubmedRateLimitMs',
			'scholarRateLimitMs',
			'defaultMaxResults',
			'maxResultsCap',
			'abstractMaxChars',
			'requestTimeoutMs',
			'maxRetries',
			'retryBackoffMs'
		];

		function LiteratureSettingsTab() {
			var [state, setState] = useState({
				phase: 'loading',
				revision: 0,
				value: {},
				base: {},
				user: {},
				facts: null,
				schemaHints: { providers: ['auto', 'serpapi', 'html'], restartKeys: [] },
				drafts: {},
				saveMsg: null,
				saveErr: null,
				tests: [],
				testErr: null
			});
			var [busy, setBusy] = useState({ save: false, reload: false, test: false, key: null });
			var keyMessages = useRef({});
			var [, forceRender] = useState(0);

			var reload = useCallback(async function (announce) {
				try {
					var res = await api('/config');
					if (res.status !== 200 || !res.payload || !res.payload.ok) {
						throw new Error((res.payload && res.payload.error) || 'HTTP ' + res.status);
					}
					var payload = res.payload;
					setState(function (prev) {
						return {
							...prev,
							phase: 'ready',
							revision: payload.revision || 0,
							value: payload.value || {},
							base: payload.base || {},
							user: payload.user || {},
							facts: payload.facts || null,
							schemaHints: payload.schemaHints || prev.schemaHints,
							drafts: {},
							saveErr: null,
							saveMsg: announce === true ? '已重新加载。' : null
						};
					});
					return payload;
				} catch (error) {
					setState(function (prev) {
						return { ...prev, phase: 'error', saveErr: '加载配置失败：' + (error && error.message ? error.message : String(error)) };
					});
					return undefined;
				}
			}, []);

			useEffect(() => {
				reload();
			}, [reload]);

			// Defensive reads: the card must never crash on a partial state, because
			// a thrown render takes the whole settings tab down with it.
			var drafts = state.drafts || {};
			var values = state.value || {};
			var current = function (key) {
				return drafts[key] !== undefined ? drafts[key] : values[key];
			};

			var setDraft = function (key, next) {
				setState(function (prev) {
					var prevDrafts = { ...(prev.drafts || {}) };
					var prevValue = (prev.value || {})[key];
					if (String(next) === String(prevValue === undefined ? '' : prevValue)) delete prevDrafts[key];
					else prevDrafts[key] = next;
					return { ...prev, drafts: prevDrafts, saveMsg: null, saveErr: null };
				});
			};

			var dirty = Object.keys(drafts).length > 0;

			var save = async function () {
				if (busy.save) return;
				if (!dirty) {
					setState((prev) => ({ ...prev, saveMsg: '没有需要保存的更改。', saveErr: null }));
					return;
				}
				setBusy((b) => ({ ...b, save: true }));
				setState((prev) => ({ ...prev, saveMsg: null, saveErr: null }));
				try {
					var patch = {};
					for (const [key, raw] of Object.entries(state.drafts)) {
						if (INT_KEYS.indexOf(key) >= 0) {
							var parsed = Number(raw);
							if (!Number.isFinite(parsed)) throw new Error(key + ' 必须是数字');
							patch[key] = Math.trunc(parsed);
						} else {
							patch[key] = raw;
						}
					}
					var res = await api('/config', {
						method: 'POST',
						body: JSON.stringify({ patch: patch, expectedRevision: state.revision })
					});
					if (res.status === 200 && res.payload && res.payload.ok) {
						setState((prev) => ({ ...prev, revision: res.payload.revision, saveMsg: '已保存并即时生效。' }));
						await reload();
						setState((prev) => ({ ...prev, saveMsg: '已保存并即时生效。' }));
					} else if (res.status === 409) {
						setState((prev) => ({ ...prev, saveErr: '保存冲突：设置已被其他会话修改，请点击「重新加载」后再保存。' }));
					} else {
						setState((prev) => ({ ...prev, saveErr: '保存失败：' + ((res.payload && res.payload.error) || 'HTTP ' + res.status) }));
					}
				} catch (error) {
					setState((prev) => ({ ...prev, saveErr: '保存失败：' + (error && error.message ? error.message : String(error)) }));
				} finally {
					setBusy((b) => ({ ...b, save: false }));
				}
			};

			var writeKey = async function (slot, action, value) {
				setBusy((b) => ({ ...b, key: slot }));
				try {
					var body = action === 'clear' ? { slot: slot, clear: true } : { slot: slot, value: value };
					var res = await api('/credential', { method: 'POST', body: JSON.stringify(body) });
					var ok = res.status === 200 && res.payload && res.payload.ok;
					if (ok) {
						var mode = res.payload && res.payload.mode;
						keyMessages.current[slot] = {
							ok: true,
							text:
								action === 'clear'
									? '已清除（若存在环境变量，仍会优先使用它）。'
									: mode === 'settings'
										? '密钥已保存到插件设置中（当前组合没有凭据服务）。'
										: '密钥已保存到凭据库。'
						};
						var refreshedPayload = await reload();
						var list = refreshedPayload && refreshedPayload.facts && refreshedPayload.facts.credentials ? refreshedPayload.facts.credentials : [];
						var refreshed = list.filter(function (entry) {
							return entry.slot === slot;
						})[0];
						if (refreshed === undefined || !refreshed.configured) {
							keyMessages.current[slot].text += ' 但状态仍显示未配置，请把下面这行诊断信息发给开发者。';
						}
					} else {
						keyMessages.current[slot] = { ok: false, text: (res.payload && res.payload.error) || 'HTTP ' + res.status };
					}
				} catch (error) {
					keyMessages.current[slot] = { ok: false, text: '网络错误：' + (error && error.message ? error.message : String(error)) };
				} finally {
					setBusy((b) => ({ ...b, key: null }));
					forceRender((n) => n + 1);
				}
				return true;
			};

			var runTest = async function (target) {
				setBusy((b) => ({ ...b, test: true }));
				setState((prev) => ({ ...prev, testErr: null, tests: [] }));
				try {
					var res = await api('/test', { method: 'POST', body: JSON.stringify({ target: target }) });
					if (res.payload && res.payload.results) {
						setState((prev) => ({ ...prev, tests: res.payload.results }));
					} else {
						setState((prev) => ({ ...prev, testErr: (res.payload && res.payload.error) || 'HTTP ' + res.status }));
					}
				} catch (error) {
					setState((prev) => ({ ...prev, testErr: '测试失败：' + (error && error.message ? error.message : String(error)) }));
				} finally {
					setBusy((b) => ({ ...b, test: false }));
				}
			};

			if (state.phase === 'loading') {
				return jsx('div', { style: S.wrap, children: jsx('p', { style: S.hint, children: '正在加载文献检索配置…' }) });
			}
			if (state.phase === 'error') {
				return jsxs('div', {
					style: S.wrap,
					children: [
						jsx('p', { style: S.error, children: state.saveErr }),
						jsx('button', {
							style: S.button,
							onClick: () => reload(true),
							children: '重试'
						})
					]
				});
			}

			var facts = state.facts || {};
			var credentials = facts.credentials || [];
			var credentialOf = function (slot) {
				return credentials.filter((entry) => entry.slot === slot)[0];
			};
			var pubmedKey = credentialOf('pubmed');
			var scholarKey = credentialOf('scholar');
			var provider = current('scholarProvider');
			// Only meaningful once facts arrived: an absent seam is reported, not hidden.
			var serviceMissing = state.facts !== null && facts.credentialsService === false;

			var scholarTone = 'warn';
			var scholarStatus = '未配置';
			if (scholarKey && scholarKey.configured) {
				scholarStatus = 'SerpApi 已配置';
				scholarTone = 'ok';
			} else if (provider === 'html' || provider === 'auto') {
				scholarStatus = provider === 'auto' ? 'SerpApi 未配置 → 走 HTML 抓取' : 'HTML 抓取模式';
				scholarTone = 'warn';
			}

			return jsxs('div', {
				style: S.wrap,
				children: [
					// ---- PubMed ----
					jsxs('section', {
						style: S.card,
						children: [
							jsxs('div', {
								style: S.cardHead,
								children: [
									jsx('span', { style: S.cardTitle, children: 'PubMed（NCBI E-utilities）' }),
									jsx(Badge, { tone: facts.pubmed && facts.pubmed.enabled === false ? 'err' : 'ok', children: facts.pubmed && facts.pubmed.enabled === false ? '已禁用' : '免密钥可用' })
								]
							}),
							jsx(CredentialField, {
								label: 'NCBI API Key',
								info: pubmedKey,
								busy: busy.key === 'pubmed',
								serviceMissing: serviceMissing,
								message: keyMessages.current.pubmed,
								hint: '填写后配额从 3 请求/秒 提升到 10 请求/秒。留空则使用公共配额（插件自动限速到 350ms/请求）。',
								onSave: (value) => writeKey('pubmed', 'set', value),
								onClear: () => writeKey('pubmed', 'clear')
							}),
							jsx(Field, {
								label: TEXT_FIELDS.pubmedEmail.label,
								hint: TEXT_FIELDS.pubmedEmail.hint,
								children: jsx(TextField, { value: current('pubmedEmail') || '', onChange: (v) => setDraft('pubmedEmail', v) })
							}),
							jsx(Field, {
								label: TEXT_FIELDS.pubmedTool.label,
								children: jsx(TextField, { value: current('pubmedTool') || '', onChange: (v) => setDraft('pubmedTool', v) })
							}),
							jsx(Field, {
								label: NUMBER_FIELDS.pubmedRateLimitMs.label,
								hint: NUMBER_FIELDS.pubmedRateLimitMs.hint,
								children: jsx(NumberField, { value: current('pubmedRateLimitMs'), onChange: (v) => setDraft('pubmedRateLimitMs', v) })
							}),
							jsx(Field, {
								label: TEXT_FIELDS.pubmedBaseUrl.label,
								children: jsx(TextField, { value: current('pubmedBaseUrl') || '', onChange: (v) => setDraft('pubmedBaseUrl', v) })
							})
						]
					}),

					// ---- Google Scholar ----
					jsxs('section', {
						style: S.card,
						children: [
							jsxs('div', {
								style: S.cardHead,
								children: [
									jsx('span', { style: S.cardTitle, children: 'Google Scholar' }),
									jsx(Badge, { tone: scholarTone, children: scholarStatus })
								]
							}),
							jsx(Field, {
								label: '后端选择（scholarProvider）',
								hint: 'auto：有 SerpApi Key 走 SerpApi，否则抓取 scholar.google.com。Google 无官方 API，HTML 后端可能被限流或不可达。',
								children: jsx(SelectField, {
									value: provider || 'auto',
									options: (state.schemaHints.providers || ['auto', 'serpapi', 'html']).map((value) => ({
										value: value,
										label: value === 'auto' ? 'auto（自动）' : value === 'serpapi' ? 'serpapi（需 Key，稳定）' : 'html（免 Key，可能被限流）'
									})),
									onChange: (v) => setDraft('scholarProvider', v)
								})
							}),
							jsx(CredentialField, {
								label: 'SerpApi Key',
								info: scholarKey,
								busy: busy.key === 'scholar',
								serviceMissing: serviceMissing,
								message: keyMessages.current.scholar,
								hint: 'serpapi.com 在多数网络下可直连；配置后 scholar_search 会返回被引次数，scholar_cite 也会可用。',
								onSave: (value) => writeKey('scholar', 'set', value),
								onClear: () => writeKey('scholar', 'clear')
							}),
							jsx(Field, {
								label: TEXT_FIELDS.scholarHl.label,
								children: jsx(TextField, { value: current('scholarHl') || '', onChange: (v) => setDraft('scholarHl', v) })
							}),
							jsx(Field, {
								label: TEXT_FIELDS.scholarBaseUrl.label,
								children: jsx(TextField, { value: current('scholarBaseUrl') || '', onChange: (v) => setDraft('scholarBaseUrl', v) })
							}),
							jsx(Field, {
								label: TEXT_FIELDS.scholarSerpApiBaseUrl.label,
								children: jsx(TextField, { value: current('scholarSerpApiBaseUrl') || '', onChange: (v) => setDraft('scholarSerpApiBaseUrl', v) })
							}),
							jsx(Field, {
								label: NUMBER_FIELDS.scholarRateLimitMs.label,
								hint: NUMBER_FIELDS.scholarRateLimitMs.hint,
								children: jsx(NumberField, { value: current('scholarRateLimitMs'), onChange: (v) => setDraft('scholarRateLimitMs', v) })
							})
						]
					}),

					// ---- general ----
					jsxs('section', {
						style: S.card,
						children: [
							jsx('div', { style: S.cardHead, children: jsx('span', { style: S.cardTitle, children: '通用' }) }),
							['defaultMaxResults', 'maxResultsCap', 'abstractMaxChars', 'requestTimeoutMs', 'maxRetries', 'retryBackoffMs'].map((key) =>
								jsx(
									Field,
									{
										label: NUMBER_FIELDS[key].label,
										children: jsx(NumberField, { value: current(key), onChange: (v) => setDraft(key, v) })
									},
									key
								)
							),
							jsx(Field, {
								label: TEXT_FIELDS.userAgent.label,
								children: jsx(TextField, { value: current('userAgent') || '', onChange: (v) => setDraft('userAgent', v) })
							}),
							jsx('p', {
								style: S.hint,
								children: '启用/禁用各后端、提示词段落等开关需重启 DSH 后生效（可通过 profile 的 cordis.patch.yml 或 API 调整）。'
							})
						]
					}),

					// ---- actions ----
					jsxs('section', {
						style: S.card,
						children: [
							jsxs('div', {
								style: S.row,
								children: [
									jsx('button', {
										style: { ...S.buttonPrimary, ...(busy.save ? S.buttonDisabled : {}) },
										disabled: busy.save,
										onClick: save,
										children: busy.save ? '保存中…' : dirty ? '保存并应用' : '保存并应用（无更改）'
									}),
									jsx('button', {
										style: { ...S.button, ...(busy.reload ? S.buttonDisabled : {}) },
										disabled: busy.reload,
										onClick: () => {
											setBusy((b) => ({ ...b, reload: true }));
											reload(true).finally(() => setBusy((b) => ({ ...b, reload: false })));
										},
										children: busy.reload ? '加载中…' : '重新加载'
									}),
									jsx('button', {
										style: { ...S.button, ...(busy.test ? S.buttonDisabled : {}) },
										disabled: busy.test,
										onClick: () => runTest('pubmed'),
										children: '测试 PubMed'
									}),
									jsx('button', {
										style: { ...S.button, ...(busy.test ? S.buttonDisabled : {}) },
										disabled: busy.test,
										onClick: () => runTest('scholar'),
										children: '测试 Google Scholar'
									}),
									jsx('span', { style: S.hint, children: 'revision ' + state.revision })
								]
							}),
							state.saveMsg === null ? null : jsx('p', { style: S.ok, children: state.saveMsg }),
							state.saveErr === null ? null : jsx('p', { style: S.error, children: state.saveErr }),
							state.testErr === null ? null : jsx('p', { style: S.error, children: state.testErr }),
							state.tests.length === 0
								? null
								: state.tests.map((entry) =>
										jsxs(
											'div',
											{
												style: S.testLine,
												children: [
													jsx(Badge, { tone: entry.ok ? 'ok' : 'err', children: entry.target }),
													jsxs('div', {
														style: { flex: 1 },
														children: [
															jsx('div', { style: entry.ok ? S.ok : S.error, children: (entry.ok ? '✓ ' : '✗ ') + entry.detail + '（' + entry.ms + 'ms）' }),
															entry.hint === undefined ? null : jsx('p', { style: S.hint, children: entry.hint })
														]
													})
												]
											},
											entry.target
										)
									)
						]
					})
				]
			});
		}

		// ------------------------------------------------------------------
		// Plugin entry
		// ------------------------------------------------------------------
		var inject = ['slots', 'connection'];

		function apply(ctx) {
			ctx.slots.inject('settings.plugins.tab', () =>
				ctx.slots.register(
					{
						name: 'settings.plugins.tab',
						id: 'literature-search',
						order: 35,
						label: '文献检索'
					},
					LiteratureSettingsTab
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.LiteratureSettingsTab = LiteratureSettingsTab;
		return module.exports;
	}
});
