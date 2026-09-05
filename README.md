# 集云电表助手 / Jishe Meter Monitor

一个用于查询集云社/集社云电表信息的轻量工具实验项目。

当前目标：

- 查询电表余额、累计用电量、最近抄读时间和电闸状态
- 验证远程抄表接口是否可在微信小程序之外调用
- 使用 GitHub Actions 做公网环境连通性测试
- 后续扩展 Windows 托盘显示、自动刷新、低余额提醒和用电统计

## 安全说明

本仓库不会保存手机号、房间 ID、电表 ID、签名等个人参数。请通过环境变量或 GitHub Actions Secrets 注入这些值。

需要的变量：

- `JISHE_PHONE`
- `JISHE_CUSTOMER_ID`
- `JISHE_ROOM_ID`
- `JISHE_METER_ID`
- `JISHE_SIGN`

## 本地测试

安装依赖：

```bash
pip install -r requirements.txt
```

仅查询服务器已有数据：

```bash
python jishe_meter.py query
```

触发一次远程抄读并再次查询：

```bash
python jishe_meter.py read
```

> 建议先使用 `query` 验证接口连通性。`read` 会实际触发远程抄表，不建议高频调用。

## GitHub Actions

仓库包含一个手动触发的测试工作流。先在：

`Settings → Secrets and variables → Actions → Repository secrets`

添加上述 5 个 Secret，然后进入：

`Actions → Test Jishe Meter → Run workflow`

默认只执行查询，不会主动远程抄表。
