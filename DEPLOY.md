# qq-agent 部署记录（本机）

## 目录

| 内容 | 路径 |
|---|---|
| qq-agent 代码 | `/root/qq-agent` |
| qq-agent 配置 | `/root/qq-agent/data/config.json` |
| LinuxQQ（NapCat 注入在 `app_launcher/napcat`） | `/root/napcat/opt/QQ` |
| NapCat 配置 | `/root/napcat/opt/QQ/resources/app/app_launcher/napcat/config/` |
| NapCat 登录二维码（原始） | `/root/napcat/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png` |
| 登录二维码（放大 4 倍，自动跟随刷新） | `/root/qq-agent/data/napcat-qrcode.png` |

## 组件与端口

- LinuxQQ 3.2.34-53644 + NapCat v4.18.38（Shell，Xvfb 无头运行）
- OneBot v11：WS `ws://127.0.0.1:3001`，HTTP `http://127.0.0.1:3000`
- NapCat WebUI：`http://127.0.0.1:6099`（token 见 `config/webui.json`）
- qq-agent 控制台：`http://127.0.0.1:3210`

## systemd 服务（已 enable，开机自启 + 崩溃自动重启）

```bash
systemctl status napcat qq-agent qr-publish
systemctl restart napcat        # 重新拉起 QQ / 换一张二维码
systemctl restart qq-agent
journalctl -u napcat -f         # 看 NapCat 日志（含二维码 URL）
```

- `napcat.service`：`xvfb-run -a ./qq --no-sandbox`
- `qq-agent.service`：`node src/server.js`
- `qr-publish.service`：把 NapCat 的 `cache/qrcode.png` 放大后同步到固定路径

## 登录

扫码路径见上表；控制台里也有二维码卡片（自动跟随 NapCat 换码）。
NapCat 约每 2 分钟刷新一次二维码，`qr-publish` 会同步更新放大版文件，路径始终指向最新一张。

如需在 NapCat WebUI 里扫码：`http://127.0.0.1:6099/webui?token=<webui.json 里的 token>`

## 启动后还需在控制台里配置

1. 设置页 → 填 OpenAI 兼容 API 的 baseUrl / key / 模型，点「测试一下」。
2. 扫码登录成功后，点「选择群」从 QQ 账号拉群列表，勾选白名单。
3. 存档页可手动发一条测试消息验证全链路。

## 扩展系统（Skill / Plugin）

已移植原仓库（K0nd1us/QQ-agent）的扩展运行时：

- `skills/<id>/`（LLM 型，注册工具，模型决定何时用）
- `plugins/<id>/`（确定性型，提供能力/钩子，核心必然执行）
- 工具注册表统一：内置 31 个工具 + 扩展工具都在 `src/tool-registry.js`，
  可用性由 `getToolAvailability()` 统一判定（Skill 开关 / 能力依赖 / vision / 搜索 / 分类 / 单工具覆盖）
- 钩子：`before-context`、`before-llm-messages`、`before-tool`、`after-tool`、`after-response`
- 热重载：改目录内文件自动重扫
- 管理：控制台「技能」页（列表/开关/设置/卸载/zip 安装）+ `/api/skills` 系列接口
- 详见 [EXTENSIONS.md](./EXTENSIONS.md)

示例：`skills/example-dice`（默认关）、`plugins/example-hook`（默认关），可在「技能」页一键启用验证。

## 常用命令

```bash
# 跟到远端最新版（拉代码 → 装依赖 → 重启 → 健康检查）
bash scripts/update.sh

# 换码/重新登录
systemctl restart napcat

# 只重新生成二维码图（不动 QQ）
curl -X POST http://127.0.0.1:6099/api/QQLogin/RefreshQRcode  # 需 Credential，建议走控制台按钮

# qq-agent 自检
cd /root/qq-agent && npm test
```
