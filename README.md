# 集云电表助手 / Jishe Meter Monitor

一个用于查询、远程抄读并统计集云社/集社云电表数据的轻量 Web 看板。

## 当前功能

- 查询余额、累计用电量、最近抄读时间和电闸状态
- GitHub Actions 每 5 分钟主动远程抄表
- 抄表完成后将结果推送到 Cloudflare Worker，并写入 D1
- Cloudflare Workers 提供查询、历史、统计和月历 API
- Cloudflare D1 保存连续历史记录
- 7 日用电时间轴与最近记录
- 今日用电、近 24 小时用电、采样期日均用电
- 月度用电/费用日历
- 基于有效相邻样本的中位数估算电价，自动规避充值导致的余额跳变
- 中国时区（Asia/Shanghai）统计口径
- 手机和桌面自适应 Web 看板
- Basic Auth 保护看板

> 历史统计从部署并开始记录后逐步积累。刚上线时没有足够历史数据，部分指标会显示 0 或“数据不足”。

## 数据链路

```text
GitHub Actions（每 5 分钟）
        ↓
集云社 Reading 接口：主动远程抄表
        ↓
GetMeterVistor：查询最新余额/电量
        ↓
POST /api/ingest（Bearer Token）
        ↓
Cloudflare Worker
        ↓
D1：meter_readings
        ↓
Web 看板 / API / 月度统计
```

这样即使无人打开网页，D1 也会持续积累约 5 分钟粒度的历史数据。

## 项目结构

```text
public/index.html              Web 看板（ECharts）
src/dashboard.html            Worker 直出备用看板
src/index.js                   Cloudflare Worker API
schema.sql                     D1 数据库表结构
wrangler.toml                  Cloudflare 配置
package.json                   Wrangler 开发/部署脚本
jishe_meter.py                 抄表与查询脚本
.github/workflows/test.yml     5 分钟定时抄读与 D1 入库
```

## Secrets

不要把手机号、房间 ID、电表 ID、签名或鉴权 Token 写进仓库。

### GitHub Actions Secrets

需要保留原有 5 个电表参数：

- `JISHE_PHONE`
- `JISHE_CUSTOMER_ID`
- `JISHE_ROOM_ID`
- `JISHE_METER_ID`
- `JISHE_SIGN`

新增：

- `DASHBOARD_BASE_URL`：Cloudflare Worker 公网根地址，例如 `https://jishe-meter-monitor.xxx.workers.dev`
- `INGEST_TOKEN`：随机生成的长字符串，用于 GitHub → Cloudflare 入库鉴权

如果后两个没有配置，GitHub Actions 仍会完成远程抄表，但会跳过 D1 入库并打印 warning。

### Cloudflare Worker Secrets

- `JISHE_PHONE`
- `DASHBOARD_PASSWORD`
- `INGEST_TOKEN`

其中 Cloudflare 的 `INGEST_TOKEN` 必须与 GitHub Actions 中的同名 Secret 完全一致。

生成一个随机 Token 的示例：

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

## Cloudflare / D1

生产 D1 已在 `wrangler.toml` 中绑定：

```text
binding: DB
database: jishe-meter-history
```

首次部署或重建数据库时执行：

```bash
npm install
npx wrangler login
npm run db:init:remote
```

配置 Worker Secrets：

```bash
npx wrangler secret put JISHE_PHONE
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put INGEST_TOKEN
```

部署：

```bash
npm run deploy
```

当前推荐使用 Cloudflare Git 集成：以 GitHub `main` 为生产分支，提交后自动执行 `npx wrangler deploy`。

## API

```text
GET  /api/status       查询集云社后台当前状态并去重保存
POST /api/read         查询当前状态并返回看板数据（不主动远程抄表）
POST /api/ingest       GitHub Actions 专用历史入库接口，Bearer Token 鉴权
GET  /api/history      查询历史记录
GET  /api/calendar     查询月度每日用电/费用
GET  /api/dashboard    返回状态、历史数据与统计指标
```

`/api/ingest` 不使用看板 Basic Auth，而使用独立的 `INGEST_TOKEN`；其他页面和 API 由 `DASHBOARD_PASSWORD` 保护。

## 统计口径

- “今日”按 `Asia/Shanghai` 日期边界计算
- 近 24 小时按真实滚动时间窗口计算
- 日均用电按最近 7 天内实际存在采样数据的日期数计算，而不是数据库不足 7 天时强行除以 7
- 电价只使用“电量增加且余额减少”的相邻样本计算，并取中位数，避免充值导致的余额上升污染估算
- 月度费用同样忽略余额增加的充值事件
