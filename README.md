# 集云电表助手 / Jishe Meter Monitor

一个用于查询、远程抄读并统计集云社/集社云电表数据的轻量 Web 看板。

## 当前功能

- 查询余额、累计用电量、最近抄读时间和电闸状态
- 手动触发远程实时抄读
- Cloudflare Workers 提供后端 API
- Cloudflare D1 保存历史抄读记录
- 7 日用电时间轴
- 今日用电、近 24 小时用电、7 日平均用电
- 根据历史余额变化估算电价与今日电费
- 手机和桌面自适应 Web 看板

> 历史统计从部署并开始记录后逐步积累。刚上线时没有足够历史数据，部分指标会显示 0 或“数据不足”。

## 项目结构

```text
public/index.html      Web 看板（ECharts）
src/index.js           Cloudflare Worker API
schema.sql             D1 数据库表结构
wrangler.toml          Cloudflare 配置
package.json           Wrangler 开发/部署脚本
jishe_meter.py         原始 Python 接口验证脚本
.github/workflows/     GitHub Actions 接口测试
```

## 安全说明

不要把手机号、房间 ID、电表 ID 或签名写进仓库。Cloudflare 部署时使用 Worker Secrets：

- `JISHE_PHONE`
- `JISHE_CUSTOMER_ID`
- `JISHE_ROOM_ID`
- `JISHE_METER_ID`
- `JISHE_SIGN`

## Cloudflare 部署

### 1. 创建 D1 数据库

在 Cloudflare Dashboard 中创建一个 D1 数据库：

```text
jishe-meter-history
```

创建后复制 Database ID，把 `wrangler.toml` 中：

```toml
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

替换为真实 ID。

### 2. 初始化数据库

本机安装依赖：

```bash
npm install
```

登录 Cloudflare：

```bash
npx wrangler login
```

初始化远程 D1：

```bash
npm run db:init:remote
```

### 3. 配置 Secrets

依次执行：

```bash
npx wrangler secret put JISHE_PHONE
npx wrangler secret put JISHE_CUSTOMER_ID
npx wrangler secret put JISHE_ROOM_ID
npx wrangler secret put JISHE_METER_ID
npx wrangler secret put JISHE_SIGN
```

### 4. 部署

```bash
npm run deploy
```

部署成功后会得到一个 `*.workers.dev` 地址，可直接在手机或电脑浏览器访问。

## API

```text
GET  /api/status       查询后台已有的最新状态
POST /api/read         触发一次远程实时抄读，并保存结果
GET  /api/history      查询历史记录
GET  /api/dashboard    返回状态、历史数据与统计指标
```

Web 页面每 60 秒刷新一次后台已有状态，但不会每分钟主动触发远程抄表。主动抄表只在点击“立即抄读”时发生。

## 关于统计

D1 会在查询或抄读后保存一条历史记录，因此历史时间轴会从首次部署使用后开始形成。

当前统计包括：

- 今日累计用电
- 最近 24 小时用电
- 最近 7 天平均日用电
- 根据历史余额与用电差值估算电价
- 今日估算电费

随着历史数据积累，可以继续扩展每日柱状图、月度统计、低余额提醒、月底费用预测等功能。
