# 集社云电表助手 / Jishe Meter Monitor

一个用于远程抄读、查询并统计集社云电表数据的轻量 Web 看板。

## 当前功能

- Cloudflare Workers Cron 每 5 分钟主动远程抄表
- 抄表完成后查询最新余额、电量、抄读时间和电闸状态，并写入 Cloudflare D1
- Web 看板支持“立即抄读”和“刷新最新数据”两种操作
- 普通打开页面和“刷新最新数据”只读取 D1，不再等待集社云外部查询接口
- GitHub Actions 保留为手动备用抄读链路，不再承担定时任务
- 7 日用电时间轴、最近记录、今日用电、近 24 小时用电和采样期日均用电
- 月度用电/费用日历与单日明细
- 基于有效相邻样本的中位数估算电价，自动规避充值导致的余额跳变
- 中国时区（Asia/Shanghai）统计口径
- 手机和桌面自适应 Web 看板
- Basic Auth 保护看板
- Workers Logs 记录 Cron 与手动抄读执行结果，便于排查 reading / query / D1 阶段问题

> 历史统计从部署并开始记录后逐步积累。刚上线时没有足够历史数据，部分指标会显示 0 或“数据不足”。

## 当前数据链路

生产环境的自动采集链路：

```text
Cloudflare Cron（每 5 分钟）
        ↓
Cloudflare Worker scheduled()
        ↓
集社云 Reading 接口：主动远程抄表
        ↓
GetMeterVistor：查询本次抄读后的最新状态
        ↓
去重并写入 Cloudflare D1
```

看板访问链路已经与集社云外部接口解耦：

```text
打开网页 / 刷新最新数据
        ↓
Cloudflare Worker
        ↓
Cloudflare D1
        ↓
状态 / 历史 / 统计 / 日历
```

因此普通访问网页不会触发真实抄表，也不会等待集社云接口返回。页面展示的是最近一次成功写入 D1 的采样结果，通常最多落后一个 Cron 周期。

网页的两个按钮含义：

- **立即抄读**：真实调用 Reading 接口，完成一次远程抄读，随后查询最新状态并写入 D1。
- **刷新最新数据**：重新从 D1 读取最近一次采样和统计结果，不主动访问集社云，也不触发远程抄表。

## GitHub Actions 的定位

`.github/workflows/test.yml` 只保留 `workflow_dispatch` 手动触发，用于 Cloudflare 异常时的备用抄读和排障验证。

GitHub Actions 不再配置 `schedule`，生产环境的自动抄读统一由 Cloudflare Cron 完成，避免维护两套定时器和产生重复抄读。

备用链路：

```text
GitHub Actions（手动）
        ↓
Reading + GetMeterVistor
        ↓
POST /api/ingest
        ↓
Cloudflare D1
```

## 项目结构

```text
public/index.html              Web 看板（ECharts）
src/dashboard.html            Worker 直出备用看板
src/index.js                   历史、日历、单日明细等原有 HTTP API
src/worker.js                  Cron 自动抄读、立即抄读与主 Worker 逻辑
src/entry.js                   D1-first 入口；状态/刷新/看板请求直接读取 D1
schema.sql                     D1 数据库表结构
wrangler.toml                  Cloudflare、Cron、D1、日志与静态资源配置
package.json                   Wrangler 开发/部署脚本
jishe_meter.py                 GitHub Actions 备用抄表与查询脚本
.github/workflows/test.yml     手动备用抄读与 D1 入库
```

## Secrets

不要把手机号、房间 ID、电表 ID、签名、密码或鉴权 Token 写进仓库。

### Cloudflare Worker Secrets

生产环境需要：

- `JISHE_PHONE`
- `JISHE_CUSTOMER_ID`
- `JISHE_ROOM_ID`
- `JISHE_METER_ID`
- `JISHE_SIGN`
- `DASHBOARD_PASSWORD`
- `INGEST_TOKEN`

其中前 5 个参数必须来自同一套有效的电表配置。若 ID 与 `JISHE_SIGN` 不匹配，Reading 接口可能直接返回“签名错误”。

`DASHBOARD_PASSWORD` 用于保护 Web 看板和普通 API；`INGEST_TOKEN` 仅用于 GitHub Actions 备用链路调用 `/api/ingest`。

### GitHub Actions Secrets

如果要保留手动备用链路，需要：

- `JISHE_PHONE`
- `JISHE_CUSTOMER_ID`
- `JISHE_ROOM_ID`
- `JISHE_METER_ID`
- `JISHE_SIGN`
- `DASHBOARD_BASE_URL`
- `INGEST_TOKEN`

`DASHBOARD_BASE_URL` 为 Cloudflare Worker 公网根地址，例如 `https://jishe-meter-monitor.xxx.workers.dev`。

GitHub 与 Cloudflare 中的 `INGEST_TOKEN` 必须完全一致；GitHub 中的电表参数建议与 Cloudflare 保持同一套配置，便于备用验证。

## Cloudflare / D1

生产 D1 已在 `wrangler.toml` 中绑定：

```text
binding: DB
database: jishe-meter-history
```

Cron 每 5 分钟执行一次：

```toml
[triggers]
crons = ["*/5 * * * *"]
```

Workers Logs / Invocation Logs 已开启，可在 Cloudflare 控制台中搜索：

```text
meter_cron      自动 Cron 抄读
meter_manual    网页“立即抄读”
dashboard_d1    D1 看板读取异常
```

首次部署或重建数据库时执行：

```bash
npm install
npx wrangler login
npm run db:init:remote
```

如使用 Wrangler CLI 配置 Secrets：

```bash
npx wrangler secret put JISHE_PHONE
npx wrangler secret put JISHE_CUSTOMER_ID
npx wrangler secret put JISHE_ROOM_ID
npx wrangler secret put JISHE_METER_ID
npx wrangler secret put JISHE_SIGN
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put INGEST_TOKEN
```

部署：

```bash
npm run deploy
```

当前推荐使用 Cloudflare Git 集成：以 GitHub `main` 为生产分支，提交后自动执行 Wrangler 部署。生产环境的定时抄读由 Cloudflare Cron 负责。

## API

```text
GET  /api/status        从 D1 返回最近一次成功采样状态
POST /api/read          从 D1 返回最近状态、历史和统计，不主动抄表
POST /api/manual-read   真实远程抄读一次，查询最新状态并写入 D1
POST /api/ingest        GitHub Actions 备用历史入库接口，Bearer Token 鉴权
GET  /api/history       查询 D1 历史记录
GET  /api/calendar      查询月度每日用电/费用
GET  /api/day           查询单日曲线、分时用电和采样明细
GET  /api/dashboard     从 D1 返回状态、历史数据与统计指标
```

`/api/manual-read` 由看板 Basic Auth 保护；`/api/ingest` 不使用看板 Basic Auth，而使用独立的 `INGEST_TOKEN`。

## 统计口径

- “今日”按 `Asia/Shanghai` 日期边界计算
- 近 24 小时按真实滚动时间窗口计算
- 日均用电按最近 7 天内实际存在采样数据的日期数计算，而不是数据库不足 7 天时强行除以 7
- 电价只使用“电量增加且余额减少”的相邻样本计算，并取中位数，避免充值导致的余额上升污染估算
- 月度费用同样忽略余额增加的充值事件

## 常见排障

如果自动或手动抄读失败，优先在 Cloudflare Workers Logs 中搜索 `meter_cron` 或 `meter_manual`，查看 `stage` 字段：

- `reading`：Reading 远程抄读阶段失败，常见于签名或电表参数不匹配
- `query`：抄读后查询最新状态失败
- `d1`：写入 D1 失败
- `complete`：本轮执行成功

如果 Cloudflare 返回“签名错误”，而 GitHub Actions 使用同一电表可以正常抄读，应优先核对 Cloudflare 中的 `JISHE_PHONE`、`JISHE_CUSTOMER_ID`、`JISHE_ROOM_ID`、`JISHE_METER_ID`、`JISHE_SIGN` 是否与有效配置完全一致。

如果看板页面可以打开但状态或统计读取失败，搜索 `dashboard_d1` 日志，优先检查 D1 绑定和数据库查询。