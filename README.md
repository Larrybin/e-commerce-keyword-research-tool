# Keyword Research Tool

这个仓库用于搭建关键词调研工具。Google Sheet 数据读取/写入默认使用 Google Sheets API service account；Chrome/CDP 只用于 Semrush、Bing、Google SERP 等必须复用网页会话的自动化。

## 当前能力

- 读取默认 Google Sheet：`keyword工具`
- 读取 `工具账号密码` 子表里的 `运行浏览器账号`
- 在本机 Chrome profiles 中匹配该账号；如果对应 profile 没有打开，会打开对应 profile
- 通过 Google Sheets API 读取 `词根拓展`、`关键词总表` 等子表
- 执行 Semrush 第一步词根拓展流程：
  - 识别当前页面是在 3ue 登录页、3ue 首页、Semrush 首页、关键词概览页，还是关键词魔法工具页
  - 按 `词根拓展` 的 `词根`、`匹配类型`、`搜索量范围`、`KD范围` 设置页面
  - 采集 Keyword Magic 表格分页里的 `关键词`、`搜索量`、`KD`
  - 输出本地 CSV/JSON，并写入 `关键词总表`，存在 `来源` 表头时标记为 `semrush`
- 输出结构化 JSON：`output/google-sheet-input.json`
- 不需要 OAuth 应用；需要 service account JSON，并把目标 Sheet 分享给 service account 邮箱
- 通过 Chrome DevTools WebSocket 复用本机 Chrome 登录态执行网页自动化

## 环境要求

- Node.js 22+
- Google Sheets service account JSON：设置 `GOOGLE_SERVICE_ACCOUNT_JSON`，或放在 `secrets/` 下任意 service account JSON
- Chrome 已登录 Semrush/Bing/Google 需要的账号
- 运行网页自动化时 Chrome 已开启 remote debugging

运行 Semrush/Bing/Google SERP 自动化时，如果脚本提示找不到 `DevToolsActivePort`，先在 Chrome 打开：

```text
chrome://inspect/#remote-debugging
```

然后允许 remote debugging，再重试。

macOS 下脚本会在连接 CDP 时短暂尝试点击 Chrome 的“允许远程调试”弹窗。需要关闭自动点击时设置：

```bash
CHROME_AUTO_ALLOW_REMOTE_DEBUGGING=0 npm run bing:precheck
```

## 使用

```bash
npm run read:sheet
```

默认读取：

- 账号配置子表：`工具账号密码`
- 关键词输入子表：`词根拓展`

换表格、gid 或子表名：

```bash
npm run read:sheet -- --sheet="https://docs.google.com/spreadsheets/d/.../edit?gid=0#gid=0" --gid=0 --account-sheet="工具账号密码" --keyword-sheet="词根拓展"
```

换输出文件：

```bash
npm run read:sheet -- --out=output/my-sheet.json
```

执行 Semrush 第一步：

```bash
npm run semrush:step1 -- --reset --max-pages=all
```

`semrush:step1` 默认会启动独立 Chrome CDP 到 `127.0.0.1:9333`，使用临时 profile，任务结束后关闭并删除临时数据。采集输出文件和 Sheet 写入结果会保留。

常用参数：

```bash
npm run semrush:step1 -- --row=2 --max-pages=all
npm run semrush:step1 -- --row=2 --max-pages=1 --skip-sheet-write
npm run semrush:step1 -- --keyword-total-gid=999267438
npm run semrush:step1 -- --from-row=6 --to-row=250 --source=amazon_catalog
```

输出文件：

```text
output/semrush-step1/root-generator.keywords.json
output/semrush-step1/root-generator.keywords.csv
output/semrush-step1/root-generator.state.json
```

执行关键词 agent：

```bash
npm run agent:prefilter -- --from-row=2 --to-row=100 --dry-run
npm run agent:prefilter -- --from-row=2 --to-row=100
npm run agent:keyword
npm run agent:keyword -- --llm-provider=openai
npm run agent:keyword -- --mode=rules
```

`agent:prefilter` 是轻量电商预筛：明显非电商和 B 端词写 `判断=拒绝`，其余继续；结果原因写入 `机器筛选原因`。

默认 LLM provider 是 `deepseek`，默认模型是 `deepseek-v4-flash`，需要 `DEEPSEEK_API_KEY`。切回 OpenAI 时用 `--llm-provider=openai` 或 `KEYWORD_AGENT_LLM_PROVIDER=openai`，并设置 `OPENAI_API_KEY`。

Bing 预检默认复用本机 Chrome profile `binben168er@gmail.com`。需要换 profile 时设置 `BING_CHROME_PROFILE`，或运行时传 `--bing-account=...`。

SERP 机会判断使用 Top10 SERP 格局：`top10大平台数`、`top10独立站数`、`疑似低权重独立站`、`SERP格局`，结果写入 `SERP机会判断` 的 `机会` 或 `待定`。

Google 机会判断使用 Valentin 同款 `hl/gl/uule` 本地化 Google SERP URL，默认美国英文、Mountain View 坐标：

```bash
npm run google:precheck -- --from-row=2 --to-row=10 --dry-run
npm run google:precheck -- --from-row=2 --to-row=10 --force
```

写入 Amazon 目录词：

```bash
npm run amazon:catalog -- --file=data/amazon-categories.txt
npm run amazon:catalog -- --init
npm run amazon:crawl -- --max-depth=10 --max-pages=0 --batch-size=200 --delay-ms=1500 --log-every-ms=5000
npm run amazon:crawl -- --resume
npm run amazon:crawl -- --dry-run --max-depth=2 --max-pages=50
npm run amazon:seed-roots
npm run amazon:seed-roots -- --write --limit=500
```

脚本会创建或复用 `Amazon目录词` 子表，写入 `国家 / 平台 / 关键词 / 一级目录 / 二级目录 / 三级目录 / 目录路径 / Amazon URL / 深度 / 抓取时间`。`amazon:crawl` 只抓 Amazon Best Sellers 目录树，不进入商品页；断点默认保存在 `state/amazon-catalog-crawl.json`；默认每 5 秒输出一次 `visited / queue / categories / errors / rate` 进度，`--dry-run` 不写 Sheet 也不更新断点。

`amazon:seed-roots` 从 `Amazon目录词` 筛选 2 个单词及以上、深度 1-2、偏实体商品的目录词，去重后追加到 `词根拓展` 的 `词根` 列。默认只预览前 500 个候选；加 `--write` 才写入。可用参数：`--min-words=2 --min-depth=1 --max-depth=2 --limit=500`。

## 输出结构

```json
{
  "source": {
    "sheetUrl": "...",
    "gid": "0",
    "accountSheetName": "工具账号密码",
    "keywordSheetName": "词根拓展",
    "readAt": "..."
  },
  "toolAccount": {
    "semrush账号": "imomo",
    "运行浏览器账号": "vc.ddom@gmail.com"
  },
  "chromeProfile": {
    "directory": "Default",
    "email": "vc.ddom@gmail.com"
  },
  "sheets": {
    "词根拓展": {
      "rows": [
        {
          "词根": "generator",
          "关键词": "",
          "匹配类型": "词组匹配",
          "搜索量范围（小）": "1000",
          "KD范围（小）": "0",
          "KD范围（大）": "60"
        }
      ]
    }
  }
}
```

下一步会在这个读取层之上接 Semrush 页面采集脚本。
