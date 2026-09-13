# dsh-literature-search

[![CI](https://github.com/Astervolans/dsh-literature-search/actions/workflows/ci.yml/badge.svg)](https://github.com/Astervolans/dsh-literature-search/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen.svg)](package.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](package.json)

DeepSeek Harness（dsh）插件：通过 **PubMed 官方 E-utilities API** 与 **Google Scholar** 检索文献，
把结果统一成同一种 paper 结构返回给模型。

- **PubMed 走官方 API**：`esearch`（检索 PMID）→ `esummary`（元数据）→ `efetch`（摘要/MeSH/关键词）→ `elink`（相关文献）。
  免费、无需密钥、有文档、可长期稳定运行。
- **Google Scholar 没有官方 API**：有 SerpApi key 时走 SerpApi 的 `google_scholar` 引擎；
  没有 key 时直接解析 `scholar.google.com` 的 HTML（会被 Google 限流/拦截，此时**明确报错**而不是静默返回空结果）。
- **零运行时依赖**：只用 Node 内置 `fetch` / `AbortSignal`，`@deepseek-ai/*` 由 DSH 运行时提供，无需 `npm install`。
- **设置界面**：在 **设置 → 插件 → 文献检索** 里有专属配置页，可直接填 NCBI / SerpApi 密钥、切换 Scholar 后端、调速率与返回条数，并一键测试连通性。

> 详细的 API 调研（参数、速率、返回格式、实测证据、选型理由）见 [`docs/API-RESEARCH.md`](docs/API-RESEARCH.md)。

## 工具

| 工具 | 上游 | 说明 |
| --- | --- | --- |
| `pubmed_search` | E-utilities `esearch`+`esummary`+`efetch` | 关键词/字段标签检索，支持 `sort`、发表日期窗口、`offset` 分页；返回 PMID、标题、作者、期刊、卷期页、DOI、PMC、摘要、MeSH、关键词 |
| `pubmed_paper` | `efetch` + `esummary` | 按 PMID 取完整记录（含摘要、MeSH、关键词、文献类型、评论/引用行） |
| `pubmed_related` | `elink` `pubmed_pubmed` | 按 NCBI 相关文献算法列出与某篇最相关的论文 |
| `scholar_search` | SerpApi / HTML | 谷歌学术检索：标题、作者、期刊/会议、年份、被引次数、摘要片段、PDF 链接；支持年份区间与分页 |
| `scholar_cite` | SerpApi `google_scholar_cite` | 返回 MLA/APA/Chicago/Harvard/Vancouver/BibTeX 等可粘贴引用格式（仅 SerpApi 后端） |

所有工具名与已有的 `dsh-ai4scholar` 插件（`search_pubmed` / `search_google_scholar`）**不冲突**，可以共存。

## 设置界面（设置 → 插件 → 文献检索）

客户端插件（`lib/client.js`）在设置面板注册一个标签页，服务端提供
`/plugin/literature-search` 路由支撑它：

| 路由 | 用途 |
| --- | --- |
| `GET /plugin/literature-search/config` | 返回 settings 命名空间（已脱敏）、修订号与状态事实（facts） |
| `POST /plugin/literature-search/config` | 带 `expectedRevision` 的补丁写入；版本冲突返回 409 |
| `POST /plugin/literature-search/credential` | 按 `slot`（`pubmed` / `scholar`）写入或清除密钥 |
| `POST /plugin/literature-search/test` | 真跑一次 PubMed esearch 与 Scholar 检索，返回耗时与结果 |

页面能力：

- **密钥**：NCBI API Key 与 SerpApi Key 通过**凭据服务**写入 `$DSH_HOME/.credentials.yaml`，
  不落进 settings 文档；页面显示来源（`环境变量` = 只读 / `已保存` = 可改）与配置状态。
- **后端选择**：`scholarProvider` 三选一（auto / serpapi / html），保存后**立即生效**（客户端缓存会失效重建）。
- **速率与结果**：PubMed/Scholar 请求间隔、默认条数、单次上限、摘要字符数、超时与重试——均为即时生效。
- **一键测试**：分别探测 PubMed 与 Google Scholar，失败时给出原因（含「被墙/限流 → 建议配 SerpApi」提示）。
- **需重启项**：`enabled`、`pubmedEnabled`、`scholarEnabled`、`promptGuidance`、`promptOrder`
  属于注册期开关，改动后需重启 DSH（页面上有说明）。

实现细节：`lib/web.js` 负责路由与事实采集；`lib/client.js` 是手写的模块加载器包
（`window.__ModuleLoader__.load`，`require("react")` 由 DSH 客户端运行时解析），**不需要构建步骤**。

### 密钥存放与状态判定

每个密钥槽用**两条独立探针**判断状态，并在徽章下方打印一行非敏感诊断
（`ref=` / `describe=` / `resolve=` / `error=`）：

1. **凭据服务**（`ctx.credentials`，写 `$DSH_HOME/.credentials.yaml`）——首选；
2. **设置内的密钥字段**（`pubmedApiKey` / `scholarSerpApiKey`，标了 `role('secret')`，读取时脱敏）——
   当前组合**没有**凭据服务时自动降级到这里；`resolveSecret` 也优先读取它。

所以不论组合里有没有凭据服务，密钥都会落到一个**插件确实会读到**的位置。
若两条探针结论不一致（例如 `describe` 说未配置、`resolve` 却能取到值），页面按「已配置」显示，
同时把两条原始结论留在诊断行里。

服务端还会把**不含密钥值**的判定结果写到：

```
$DSH_HOME/.dsh-literature-search/diagnostics.json
```

`GET /config`、`POST /credential`、`POST /test` 每次都会刷新它，内容含
`describe`/`resolve` 原始结论、错误文本、`DSH_HOME`/`cwd`，以及环境变量中是否存在同名密钥（只记布尔）。
排查「填了 key 仍显示未配置」时先看这个文件。

另外，服务端与工具侧都改为从**注入的上下文**取 `settings` / `credentials`
（`ctx.inject(['credentials'], …)`），而不是 `ctx.get('credentials')` ——
后者在某些组合里可能取不到兄弟插件的服务，这正是密钥「写进去了却读不出来」的典型原因。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Profile desktop
```

- `-Profile`：目标 profile（桌面应用为 `desktop`，`dsh web` CLI 为 `web`）。
- 脚本做两件事：把插件复制到 `$DSH_HOME\profiles\<profile>\node_modules\dsh-literature-search`，
  并把 `literature-search` 配置行合并进该 profile 的 `cordis.patch.yml`（幂等，可重复执行）。
- 安装后**重启 DSH**（桌面应用或 `dsh web`）才会加载新工具。
- 卸载：`powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Profile desktop`。

不想改 profile 也可以直接先跑 CLI 验证：

```powershell
node cli.mjs pubmed "CRISPR base editing" --max 3
node cli.mjs paper 33301246
node cli.mjs scholar "base editing" --max 5          # 无 key 时走 HTML，时通时断，被拦会给出提示
```

## 密钥（可选）

| 环境变量 / credential | 作用 | 不设置的后果 |
| --- | --- | --- |
| `NCBI_API_KEY` | E-utilities 配额从 3 请求/秒 提升到 10 请求/秒 | 仍然可用，插件自动限速到 350 ms/请求 |
| `SERPAPI_API_KEY` | Google Scholar 走 SerpApi（稳定、含被引次数与引用格式） | 退回 HTML 抓取，可能被 Google 以 HTTP 429 拦截 |
| `NCBI_EMAIL` | 仅 CLI 使用，填进 E-utilities 的 `email` 参数 | NCBI 官方建议填，便于他们在异常时联系 |

两种配置方式（插件按 内联配置 → 凭据服务 → 环境变量 的顺序解析）：

1. 启动 DSH 的环境变量；
2. `$DSH_HOME\.credentials.yaml`（DSH 凭据服务）中写入 `NCBI_API_KEY` / `SERPAPI_API_KEY`；
3. 直接写进 `cordis.patch.yml` 的 `pubmedApiKey` / `scholarSerpApiKey`（不推荐，容易泄漏到版本库）。

## 配置

`cordis.patch.yml` 中的 `literature-search` 行：

| Key | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否注册本插件的工具 |
| `pubmedEnabled` | `true` | 是否注册 `pubmed_*` 三个工具 |
| `pubmedBaseUrl` | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | E-utilities 根地址 |
| `pubmedTool` / `pubmedEmail` | `dsh-literature-search` / 空 | 每次请求都带上的 `tool` / `email` 参数（NCBI 使用政策要求） |
| `pubmedApiKeyEnv` / `pubmedApiKey` | `NCBI_API_KEY` / 空 | 密钥引用 / 内联密钥 |
| `pubmedRateLimitMs` | `0` | 请求最小间隔；0 = 无 key 350 ms、有 key 110 ms |
| `scholarEnabled` | `true` | 是否注册 `scholar_*` 两个工具 |
| `scholarProvider` | `auto` | `auto`（有 key 用 SerpApi，否则 HTML）/ `serpapi` / `html` |
| `scholarBaseUrl` / `scholarSerpApiBaseUrl` | Google / SerpApi 官方地址 | 可指向自建代理 |
| `scholarSerpApiKeyEnv` / `scholarSerpApiKey` | `SERPAPI_API_KEY` / 空 | 密钥引用 / 内联密钥 |
| `scholarHl` | `en` | 谷歌学术界面语言 |
| `scholarRateLimitMs` | `0` | 0 = HTML 2500 ms、SerpApi 250 ms |
| `defaultMaxResults` / `maxResultsCap` | `10` / `50` | 模型未指定 / 最多可请求的条数 |
| `abstractMaxChars` | `600` | 每篇摘要/片段字符上限，0 = 不返回摘要 |
| `requestTimeoutMs` / `maxRetries` / `retryBackoffMs` | `30000` / `3` / `1000` | 单次请求超时、重试次数、退避基数（遇 429/5xx 自动重试并遵守 `Retry-After`） |
| `toolTimeoutMs` | `120000` | 单次工具调用预算 |
| `userAgent` | 空（内置 Chrome UA） | 覆盖默认 UA |
| `promptGuidance` / `promptOrder` | `true` / `155` | 是否注册系统提示词段落及其顺序 |

## 使用示例

模型侧（自然语言即可）：

> 用 pubmed_search 检索 2020 年以后 “base editing” 的综述，取 5 篇，然后对第一篇用 pubmed_related 找 5 篇相关文献。

> 用 scholar_search 找 “CRISPR base editing” 被引最高的 10 篇，并把第一篇的 resultId 交给 scholar_cite 生成 BibTeX。

返回示例（`pubmed_paper 33301246`）：

```
PubMed record: Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine.

Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine.
   2020 · The New England journal of medicine · vol 383 · no 27 · pp 2603-2615
   Polack, Fernando P, Thomas, Stephen J, Kitchin, Nicholas et al. (29 authors)
   DOI: 10.1056/NEJMoa2034577 · PMID: 33301246 · PMC: PMC7745181
   https://pubmed.ncbi.nlm.nih.gov/33301246/
   Types: Clinical Trial, Phase III, Journal Article, Randomized Controlled Trial
   MeSH: BNT162 Vaccine, COVID-19, SARS-CoV-2, ...
   Abstract: BACKGROUND: ...
```

## 测试

离线套件需要两个 DSH 运行时包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）。
两种准备方式，任选其一：

```powershell
# 路线 A：从本机 DSH 安装里抽取（无需联网）
powershell -ExecutionPolicy Bypass -File setup-dev-links.ps1   # 首次运行

# 路线 B：从 npm 安装（CI 用的就是这条，机器上没装 DSH 也能跑）
node tools/fetch-dev-deps.mjs

# 离线（解析器 + 插件契约 + 设置路由 + 客户端 bundle + 配置漂移）
node test/run-all.mjs

# 在线（真实上游；需要能访问对应域名）
node test/live-pubmed.mjs      # eutils.ncbi.nlm.nih.gov
node test/live-scholar.mjs     # scholar.google.com（Google 拒绝请求时记为 SKIP）
node test/probe-scholar.mjs    # 连通性诊断：status / 结果块数 / 是否被反爬拦截
```

- `setup-dev-links.ps1` 调用 `tools/extract-dev-deps.mjs`，从
  `D:\DSH Desktop\resources\app.asar` 里**按需抽取**插件测试所需的 DSH 运行时闭包
  （`@deepseek-ai/dsh-tools`、`schemastery`、`yaml` 及其传递依赖）到 `.dev-deps/`，
  再用 junction 链到 `node_modules/`。DSH 换版本、profile 布局变化都不影响；
  **插件本身零 npm 依赖**，`.dev-deps/` 与 `node_modules/` 都不会被安装进 profile。
- `tools/fetch-dev-deps.mjs` 走另一条路：按 `.dev-deps/package.json` 里钉住的版本
  从 npm 装同一批包，再软链到 `node_modules/`。适合没装 DSH Desktop 的机器和 CI
  （`.github/workflows/ci.yml` 在 Ubuntu + Windows × Node 22/24 上跑全部离线用例）。
- 离线共 **62 个用例**：MEDLINE 解析 7、Scholar 解析/分页 6、插件与工具 21（含
  「settings 写入后 Scholar 即时切换后端」「凭据写入后无需重启生效」「实时条数上限」）、
  设置路由 14、客户端 bundle 10、配置漂移 4。全部用桩 `fetch`/假服务，不联网。
- 客户端 bundle 套件用桩 `window.__ModuleLoader__` + 极简 React shim 真正执行并遍历渲染树，
  能在没有浏览器的情况下抓出设置页里的拼写错误与空引用（已借此修掉一个 `state.drafts` 空值崩溃）。
  0.2.2 起它会展开函数组件做深度渲染，因此子组件拥有的节点（如密钥字段的按钮）也能断言，
  并直接守住主题回归：主按钮必须用成对的 token、不得把 `--dsw-alias-brand-primary` 当填充色。
- 在线测试把**上游不可用**（无出网 / DNS / 超时 / HTTP 429 / 反爬页）记为 SKIP 而不是 FAIL，
  因为那是环境或对方策略问题；只有“页面里有结果块但解析出 0 条”才判失败。
  实测：Google Scholar HTML 5/5 通过；PubMed 在本机出网时好时坏，不通时会明确打印 SKIP 与原因。

## 目录结构

```
dsh-literature-search/
├── lib/
│   ├── index.js     # 插件入口：Config / apply / runtime / settings 命名空间 / 提示词段落
│   ├── web.js       # /plugin/literature-search 路由：配置读写、密钥读写、连通性测试
│   ├── client.js    # 设置页客户端插件（window.__ModuleLoader__，免构建）
│   ├── http.js      # 限速闸门、超时、重试、Retry-After、JSON/文本解码
│   ├── paper.js     # 统一 paper 结构、输出 schema、渲染
│   ├── medline.js   # MEDLINE 文本解析（efetch rettype=medline）
│   ├── pubmed.js    # E-utilities 客户端 + pubmed_* 三个工具
│   └── scholar.js   # Google Scholar（SerpApi / HTML）+ scholar_* 两个工具
├── tools/
│   ├── extract-dev-deps.mjs   # 从 app.asar 抽取测试所需的 DSH 运行时闭包
│   └── fetch-dev-deps.mjs     # 从 npm 装同一批包（CI / 没装 DSH 的机器）
├── test/            # 离线套件（含设置路由与客户端 bundle）+ 在线冒烟 + fixtures
├── docs/API-RESEARCH.md
├── .github/         # CI 工作流 + Issue / PR 模板
├── .dev-deps/package.json   # 钉住离线测试用的 DSH 运行时版本（只有这一个文件入库）
├── cli.mjs          # 脱离 DSH 的命令行验证
├── install.ps1 / uninstall.ps1 / setup-dev-links.ps1
├── cordis.patch.yml
├── LICENSE / CHANGELOG.md / CONTRIBUTING.md / SECURITY.md
└── package.json
```

## 已知限制

- **PubMed 的日期过滤按印刷出版日期（`pdat`）**：ahead-of-print 记录的 `esummary.pubdate`
  可能显示为之后的年份，这是 PubMed 数据本身的行为，不是插件 bug。
- **Google Scholar 无官方 API**：HTML 后端时通时断（同一台机器可能一会儿 200、一会儿 429 或直接连接失败）；
  插件会抛出可读错误并给出替代方案。要稳定使用请配 SerpApi key。
- **PubMed 摘要可能受版权保护**：NCBI 免责声明要求使用者遵守版权方条款；大规模挖掘请下载 PubMed 本地副本。
- `scholar_cite` 只支持 SerpApi 后端（HTML 端点没有引用格式接口）。

## scholar.google.com 连不上时怎么办

在被阻断的网络里，`scholar.google.com`（及其 `.com.hk` / `.co.jp` / `.de` 镜像）会直接
`UND_ERR_CONNECT_TIMEOUT`，而 `serpapi.com` 与 `eutils.ncbi.nlm.nih.gov` 正常。
最快的判断方式是设置页里的 **「测试 Google Scholar」** 按钮；命令行诊断脚本：

```powershell
node test/probe-scholar.mjs
```

- `resultBlocks > 0`：页面能抓到 → HTML 后端可用（`scholarBaseUrl` 可改成任一可达镜像）。
- `blocked=true`：Google 返回反爬页 → 降低频率，或改用 SerpApi。
- `ERR UND_ERR_CONNECT_TIMEOUT`：网络层被阻断 → 下面两条路二选一。

**方案 A：配 SerpApi（推荐，稳定）**
在设置页「Google Scholar」区块粘贴 SerpApi Key 并保存（写入 `$DSH_HOME/.credentials.yaml`），
或在启动 DSH 的环境里设置 `SERPAPI_API_KEY`；`scholarProvider=auto` 会自动切到 SerpApi。

**方案 B：走本机代理**
若本机有代理（如 Clash 默认 `127.0.0.1:7897`），用 Node 24 的环境变量代理支持启动 DSH：

```powershell
set NODE_USE_ENV_PROXY=1
set HTTPS_PROXY=http://127.0.0.1:7897
set HTTP_PROXY=http://127.0.0.1:7897
"D:\DSH Desktop\DSH Desktop.exe"
```

注意：`NODE_USE_ENV_PROXY` 是 Node 24 起的特性，且必须让 **DSH 进程本身**带着这些变量启动
（插件内部的 `fetch` 会继承）；若代理客户端没开（`ProxyEnable=0` 且端口无监听），这条方案无效。

PubMed 不受影响：`eutils.ncbi.nlm.nih.gov` 在同样网络下可直接访问。

## 参与贡献

欢迎 Issue 与 PR：开发环境、测试命令和代码约定见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；
变更历史见 [`CHANGELOG.md`](CHANGELOG.md)。

发现安全问题时请不要开公开 Issue，改走 [`SECURITY.md`](SECURITY.md) 里的私下渠道 ——
本插件会接触 NCBI / SerpApi 密钥，密钥泄漏路径都按安全问题处理。

## License

[MIT](LICENSE)
