# 谷歌学术与 PubMed 的 API 文献检索方式调研

调研时间：2026-09（本次实现时）。
结论先行：**PubMed 有官方、免费、文档完善的检索 API（NCBI E-utilities），应当直接使用；
Google Scholar 至今没有官方 API**，只能用第三方代理服务（SerpApi 等）或自行抓取 HTML，
而抓取会被 Google 限流/拦截。本插件据此分成两条完全不同的实现路径。

---

## 1. PubMed：NCBI E-utilities

### 1.1 是什么

NCBI 官方提供的 9 个 CGI 接口，统一入口：

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/{einfo|esearch|epost|esummary|efetch|elink|egquery|espell|ecitmatch}.fcgi
```

检索文献最实用的四个：

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `esearch` | 文本检索 → PMID 列表 | `db=pubmed`、`term`、`retmax`、`retstart`、`sort`、`datetype`、`mindate`、`maxdate`、`retmode=json` |
| `esummary` | PMID → 文档摘要（DocSum） | `db=pubmed`、`id`、`retmode=json`、`version=2.0` |
| `efetch` | PMID → 完整记录 | `db=pubmed`、`id`、`rettype=medline|abstract`、`retmode=text|xml` |
| `elink` | PMID → 相关/被引/全文链接 | `dbfrom=pubmed`、`db=pubmed`、`cmd=neighbor`、`id`、`retmode=json` |

### 1.2 使用政策（决定插件如何限速）

- 每个 IP **不超过 3 请求/秒**；超过会被封 IP。
- 带上 `api_key`（NCBI 账号 Settings 页获取）后默认 **10 请求/秒**，需要更高可申请。
- 建议所有请求都带 `tool=<软件名>` 与 `email=<开发者邮箱>`；被封后只有注册这两个值才能恢复。
- 超时/限流时的报错形如 `{"error":"API rate limit exceeded","count":"11"}`。

**插件实现**：`tool` / `email` / `api_key` 每次都带；每个 E-utilities 端点共用一个串行限速闸门
（`RateLimiter`），无 key 350 ms、有 key 110 ms；429/5xx 指数退避重试并遵守 `Retry-After`。

### 1.3 检索语法与分页

- `term` 支持 Entrez 语法：`asthma[Title/Abstract] AND 2020:2024[pdat]`、`review[filter]`、
  邻近检索 `"asthma treatment"[Title:~3]`。
- `sort` 对 PubMed 的取值：`relevance`（默认，Best Match）、`pub_date`、`Author`、`JournalName`。
- `mindate`/`maxdate` 必须配合 `datetype`，格式 `YYYY`、`YYYY/MM`、`YYYY/MM/DD`。
- `retstart` + `retmax` 做分页；`retmax` 上限 10,000（PubMed/PMC 最多只能取前 10,000 条）。
- 大规模检索应使用 History Server（`usehistory=y` → `WebEnv` + `query_key`）批量下载，而不是逐条请求。

### 1.4 返回格式的取舍（实测）

实测请求与结果（2026-09）：

```
esearch.fcgi?db=pubmed&term=CRISPR+base+editing&retmode=json&retmax=5&sort=relevance
→ count = 25683, idlist = [33449100, 34480847, 32833534, 39231901, 38308006]
  另有 querytranslation，可用来确认日期/字段过滤真的生效
```

- `esummary` + `retmode=json` + `version=2.0` 返回：`title`、`authors[]`、`pubdate`、
  `fulljournalname`、`volume/issue/pages`、`pubtype[]`、`articleids[]`（含 `doi`、`pmc`）。
  **不含摘要**，但结构化、体积小。
- `efetch` 有三种可用形态：
  - `retmode=xml&rettype=abstract`：字段最全，但**连带整个 ReferenceList**，一篇 NEJM 论文就能到 50 KB+；
  - `rettype=medline&retmode=text`：纯文本、按 `TAG - value` 分行，含 `TI/AB/FAU/DP/JT/VI/IP/PG/LID[doi]/PMC/MH/OT/PT/CIN`，
    体积小、易解析；
  - `rettype=abstract&retmode=text`：人类可读，但结构弱。

**插件实现**：`esearch`（JSON）→ `esummary`（v2.0 JSON，拿 DOI/PMC/期刊全名）→
`efetch rettype=medline&retmode=text`（拿摘要、MeSH、关键词、评论引用行），按 PMID 合并；
`with_abstract=false` 时跳过 efetch，一次检索只需 2 个请求。

### 1.5 实测踩到的坑

`datetype=pdat` 的日期过滤在 PubMed 侧按**印刷出版日期**执行，而 `esummary.pubdate` 对
ahead-of-print 记录可能显示为更晚的年份。实测 `mindate=2024&maxdate=2025` 时
`querytranslation` 里确实出现 `2024/01/01:2025/12/31[Date - Publication]`，
但返回记录的 `pubdate` 显示为 `2026 Dec`。因此在线测试改为断言 `querytranslation`，
而不是逐条比对 `pubdate` 年份。

### 1.6 其他可选增强（未采用）

- `icite.od.nih.gov/api/pubs?pmids=...` 可给出 NIH 引用计数与临床引用标记，
  但响应会带上数千条 `citedByPmidsByYear`，体积大且无字段裁剪，本次未接入。
- `ecitmatch` 支持用引用串反查 PMID，适合做“参考文献补全”，本次未接入。
- ELink 的 `pubmed_pubmed_citedin` / `pmc` 链接可做被引与全文，本次只用了 `pubmed_pubmed`（相关文献）。

### 1.7 参考

- E-utilities 总览与使用政策：<https://www.ncbi.nlm.nih.gov/books/NBK25497/>
- 参数详解（ESearch/ESummary/EFetch/ELink）：<https://www.ncbi.nlm.nih.gov/books/NBK25499/>
- 免责声明与版权：<https://www.ncbi.nlm.nih.gov/About/disclaimer.html>

---

## 2. Google Scholar：没有官方 API

### 2.1 现状

Google 从未提供 Google Scholar 的公开 API（Google Scholar 的 `robots.txt` 与使用条款也禁止自动抓取）。
社区里能用的只有四类路线：

| 路线 | 代表 | 优点 | 代价 |
| --- | --- | --- | --- |
| 商业代理 API | SerpApi `google_scholar` / `google_scholar_cite`、ScraperAPI、Octoparse 等 | 稳定 JSON、含被引次数与引用格式、有 SLA | 付费、需 key、第三方经手查询 |
| 开源抓取库 | `scholarly`（Python）、`google-scholar-scraper` | 免费 | 仍受 Google 反爬；需要 cookie/代理/代理池；随时失效 |
| 直接请求 HTML | `https://scholar.google.com/scholar?q=...` | 免费、无需中间人 | 极易被 429/CAPTCHA；不能高频 |
| 换数据源 | OpenAlex、Crossref、Semantic Scholar、PubMed | 有官方 API、可商用、字段规范 | 被引次数/覆盖与 Scholar 不完全一致，不是“Scholar” |

### 2.2 实测（2026-09，本机）

第一次探测（当天早些时候）：

| 方式 | 结果 |
| --- | --- |
| 直接用 HTTP 抓 `scholar.google.com/scholar?q=...` | `fetch failed`（连接层面就失败） |
| Playwright 真实浏览器访问同一 URL | **HTTP 429** |
| 无 key 调 SerpApi | 返回 JSON `{"error":"..."}`（符合预期，需要 key） |
| `eutils.ncbi.nlm.nih.gov` 同时段访问 | 正常返回（说明不是本机整体断网） |

重试（同一天稍后，同样的机器与网络）：

| 方式 | 结果 |
| --- | --- |
| `node cli.mjs scholar "CRISPR base editing" --max 3` | **HTTP 200**，解析出 10 条结果（标题/作者/期刊/年份/被引/PDF 链接/摘要片段全部正常） |
| 裸 `fetch` 四种 header 变体（无 UA / Chrome UA / 站点根 / `.com.hk` 镜像） | 全部 200（176–177 KB） |
| 连发 5 个 `start=` 分页请求 | 全部 200，未出现验证码页 |
| 年份过滤 `as_ylo=2023&as_yhi=2024` | 10 条结果年份全部落在 2023–2024 |
| 分页 `start=10` | 返回与第 1 页不重叠的新结果 |

**结论：Google Scholar 的 HTML 端点不是“稳定可用”也不是“必然不可用”，而是时好时坏**——
同一台机器、同一天内从 429/连接失败变成 200 正常。因此插件必须两者都能处理：
有 key 用 SerpApi，没 key 走 HTML，被拦时抛可读错误（见 §3）。

### 2.3 分页与“是否还有下一页”的坑

- Scholar 的下一页链接写成 `href="/scholar?q=...&amp;hl=en&amp;as_sdt=0,5&amp;start=10"`，
  分隔符被转义成 `&amp;`。用 `[?&]start=` 匹配会全部漏掉，必须写成 `(?:\?|&|&amp;)start=`。
- **页内结果条数不能代表是否还有下一页**：实测 `start=10` 的一页只解析出 2 条结果，
  但它仍有下一页；`start=40` 解析出 0 条且确实到底了。
  因此 `truncated` 必须由“页内是否存在比当前 `start` 更大的分页链接”判断，
  而不能用 `papers.length >= 10`。
  这两个问题都是本次重试后才暴露并修复的（单测 `scholarNextStart` 覆盖）。

### 2.4 SerpApi `google_scholar` 引擎

请求：

```
GET https://serpapi.com/search.json
    ?engine=google_scholar
    &q=CRISPR+base+editing
    &api_key=...
    &hl=en
    &num=20            # 每页条数（最大 20）
    &start=0           # 偏移，分页用
    &as_ylo=2020       # 起始年份
    &as_yhi=2025       # 结束年份
```

响应要点（`organic_results[]`）：

- `title`、`link`、`snippet`、`result_id`
- `publication_info.summary`（`作者 - 期刊, 年份 - 域名`）与 `publication_info.authors[]`
- `inline_links.cited_by.total` / `.link`（被引次数）
- `inline_links.versions`、`resources[]`（PDF 链接）
- `pagination.next`（是否有下一页）
- 失败时顶层出现 `error` 字段

引用格式接口：

```
GET https://serpapi.com/search.json?engine=google_scholar_cite&q=<result_id>&api_key=...
→ citations[]: { title: "MLA"|"APA"|"Chicago"|"Harvard"|"Vancouver"|"BibTeX", snippet }
  links[]: { name, link }
```

**插件实现**：`normalizeSerpApiResult()` 把上述字段映射到统一 paper 结构；
`scholar_cite` 直接返回 `citations` + `links` 渲染成可粘贴文本。

### 2.5 HTML 抓取要点

真实 Scholar 结果页的结构（本次按此实现并写了 fixture 单测）：

```html
<div class="gs_r gs_or gs_scl" data-cid="...">
  <div class="gs_ggs gs_fl">…<a href="…pdf">…</a></div>   <!-- 可选：PDF -->
  <div class="gs_ri">
    <h3 class="gs_rt"><a href="…">标题</a></h3>
    <div class="gs_a">作者 - 期刊, 年份 - 域名</div>
    <div class="gs_rs">摘要片段</div>
    <div class="gs_fl gs_flb"><a href="…cites=…">Cited by 123</a> …</div>
  </div>
</div>
```

实现上的两个坑（都已在单测里覆盖）：

1. `gs_r` / `gs_rs`、`gs_fl` / `gs_flb`、`gs_ggs gs_fl` 互为前缀或共用 token，
   用子串匹配会取错节点；必须按 class 列表的**完整 token** 匹配，并对嵌套 `<div>` 做深度配对。
2. 同一个结果块里 `class="gs_ggs gs_fl"`（PDF 容器）出现在真正的页脚 `class="gs_fl gs_flb"` 之前，
   因此选“页脚”时要按内容（含 `cites=` / `Cited by`）挑选。

反爬特征识别：响应里出现 `unusual traffic`、`not a robot`、`/sorry/`、`captcha`，
或状态码 429，一律判定为被拦截并抛出带解决建议的错误。

其他请求参数：`hl=en`（语言）、`as_sdt=0,5`（不含专利）、`as_ylo`/`as_yhi`（年份）、`start`（偏移，每页 10 条）。

### 2.6 参考

- SerpApi Google Scholar API：<https://serpapi.com/google-scholar-api>
- SerpApi 结果字段：<https://serpapi.com/google-scholar-organic-results>
- SerpApi 引用格式接口：<https://serpapi.com/google-scholar-cite-api>
- 第三方对“无官方 API”现状的综述：<https://www.octoparse.com/blog/google-scholar-api>、<https://www.scrapingbee.com/blog/best-google-scholar-api/>

---

## 3. 调研结论 → 插件设计映射

| 调研结论 | 插件里的落点 |
| --- | --- |
| PubMed 有官方 API，免费且稳定 | `lib/pubmed.js`：`pubmed_search` / `pubmed_paper` / `pubmed_related`，默认启用 |
| 3 请求/秒、可申请到 10 请求/秒 | `RateLimiter` + `pubmedRateLimitMs`，自动按是否配置 `NCBI_API_KEY` 选择间隔 |
| `tool`/`email` 是政策要求 | 每次请求都带 `pubmedTool` / `pubmedEmail` |
| ESearch 只给 PMID，摘要要 EFetch | 检索流程固定为 esearch → esummary → efetch，可关掉 efetch 降成本 |
| EFetch XML 带巨大 ReferenceList | 改用 `rettype=medline&retmode=text` 并自写解析器（`lib/medline.js`） |
| Scholar 无官方 API，HTML 时通时断 | `scholarProvider=auto`：有 key 用 SerpApi，否则 HTML 并诚实报错 |
| SerpApi 有稳定的 JSON 与被引次数、引用格式 | `normalizeSerpApiResult()` + `scholar_cite` |
| HTML 结构易被前缀匹配搞错 | 完整 class token 匹配 + 嵌套 div 配对 + 反爬特征识别，配 fixture 单测 |
| 分页链接被转义成 `&amp;start=`，且短页仍可能有下一页 | `scholarNextStart()` 判定 `truncated`，不再用条数推断 |

## 4. 本次验证记录

- 离线套件：`node test/run-all.mjs` → **33/33** 通过（MEDLINE 解析 7、Scholar HTML/SerpApi 解析与分页判定 6、
  插件契约与五个工具的 execute + render + 输出 schema 校验 16、配置漂移 4）。
- 在线套件：`node test/live-scholar.mjs` → **5/5** 通过（真实 Scholar HTML：
  解析结果、年份窗口、翻页不重叠、渲染、`scholar_cite` 拒绝 HTML 后端）。
  该套件把“Google 拒绝请求 / 页面无结果块”记为 SKIP，把“页面里仍有结果块但解析出 0 条”记为失败。
- 在线套件：`node test/live-pubmed.mjs` → 出网正常时 **5/5** 通过（真实 E-utilities：
  检索命中数、摘要/DOI 富集、日期窗口、单篇回读、相关文献）；本机出网时通时断，
  不通时套件打印 SKIP 与原因而不是伪装成通过。
- 连通性诊断：`node test/probe-scholar.mjs`（不改插件代码，直接看 status / 结果块数 / 是否被拦）。

**关于本机网络**：调研期间同一台机器上 `eutils.ncbi.nlm.nih.gov` 与 `scholar.google.com`
都出现过“前一次成功、后一次 `fetch failed`”的交替现象，说明沙箱/网络的出网能力本身不稳定。
因此两个在线套件都按“上游不可用 → SKIP”设计，只有解析/断言层面的错误才判失败。

## 5. 重试后新增的两个修复

重试 Google Scholar 抓取时，真实的 200 页面暴露了两个此前被 429 掩盖的问题，均已修复并加了单测：

1. **分页链接被转义**：`href="...&amp;start=10"`，`[?&]start=` 匹配不到 → 改用 `(?:\?|&|&amp;)start=`；
   此前 `truncated` 在 HTML 模式下恒为 `false`。
2. **短页不等于最后一页**：实测 `start=10` 只解析出 2 条却仍有下一页，
   改用“页内是否存在更大的 `start` 链接”（`scholarNextStart()`）判断 `truncated`。
