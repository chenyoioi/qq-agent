# 更新日志

## 1.1.3（2026-10-18）

### 新增

- **主人不受额度限制**：`quota-guard` 的额度判定对 `config.persona.masterQQ` 直接返回“不限”（limit=0），
  主人不会被剔除、不会被静默、也不会让整轮被拦；
- **主人指令「重置 QQ号」**：主人发一条 `重置 123456` 即可把对方的今日额度清零（`used=0`，
  保留 `spent` 真实用量），机器人回一句确认，该轮**不请求模型**（零消耗）。
  非主人发同样的话不生效。

核心侧配套：`before-context` 钩子的上下文补了 `sender` / `onebot`，插件才能在钩子里发确认消息。

> 前提：`config.persona.masterQQ` 必须填成你的 QQ 号，否则“主人”判定为空，两条功能都不生效。

## 1.1.2（2026-10-18）

### 新增

- 扩展自带控制面板：`GET /plugin-ui/<id>/*` 静态页面 + `POST /api/plugin-ui/<id>/action` 转发到插件的 `handleUiRequest`
  （quota-guard 的额度管理页现在能打开了；此前 404）；
- 能力 `chat.blocked-users`：核心在提示词里声明【静默成员】，并在 `send_message` 里兜底拒绝 @/引用被拦者，
  **额度用尽的人一条都不回**（包括他单独触发的整轮零消耗）。

### 修复

- 发现并清理“游离实例”：早先 update.sh 走过非 systemd 分支，留下一个占着 3210 的孤儿进程，
  systemd 新实例退到 3211，两个进程同时连 OneBot —— 表现为“配额守卫时灵时不灵”。
  update.sh 现在先停 unit、清扫 `node src/server.js` 游离进程、启动后校验实例数。
- 启动日志误用 `summary.enabled`（应为 `active`）。

## 1.1.1（2026-10-18）

### 修复：Token 配额守卫（quota-guard）装了不生效

根因是**核心缺两个接线点**，插件只提供能力却没人调用，表现为“额度用超了照样聊”：

- `SendQueue.canSend(chatKey)`：只读的发送限流状态（不占用额度、不写记录）；
- `orchestrator.#runAgent`：在 `before-context` 之后、组装提示词之前调用能力 `chat.quota-gate`，
  返回 `{skip:true, code, reason}` 时**一条 LLM 请求都不发**就收尾；`#wake` 按 `noreply` 结束会话并记录拦截原因。

效果：超额用户的消息被插件从触发批剔除；整批都超额（或发送限流已满）时整轮零消耗。
插件判错时按“放行”处理，避免消息静默丢失。

新增 `test/quota-gate.test.mjs`（7 项）：能力解析、全员超额拦截、部分超额放行、额度 0 不限、`canSend` 只读、限流前置拦截。

## 1.1.0（2026-10-18）

本版把原仓库（K0nd1us/QQ-agent）的扩展运行时完整移植进来，并补了一套部署/分发方案。

### 新增：扩展系统（Skill / Plugin）

- `src/tool-registry.js`：工具注册表 + `getToolAvailability()` 统一可用性口径；
- `src/skills/*`：清单校验、能力注册、开关、状态机、钩子调度；
- `src/plugin-loader.js`：扫描 `skills/`（LLM 型）与 `plugins/`（确定性型），热重载；
- `src/zip-install.js`：zip 安装的结构校验（路径穿越 / 可执行文件 / 体积上限）；
- 钩子：`before-context`、`before-llm-messages`、`before-tool`（可否决）、`after-tool`、`after-response`；
- 能力：`llm.request-params` / `llm.response` / `llm.usage` / `tool.guard` / `media.download` 等；
- 内置 31 个工具改为注册进 registry，与扩展工具统一过滤。

### 新增：控制台

- 「技能」页：扩展列表、开关、设置、卸载、zip 安装、重新扫描、热重载提示；
- 「技能」页 → 工具清单：搜索、只看不可用、逐项开关、来源/分类/状态/不可用原因；
- 「设置 → 能力总览」：工具状态徽章（不可用 / 仅主人 / 仅学习模式），计数区分注册数与常规可用数；
- 新增 `/api/skills*`、`/api/tools`、`/api/tools/toggle` 接口。

### 修复

- zip 安装不识别插件类型 → 按包内 `plugin.json` 自动落 `plugins/`；
- 嵌套根目录（`x/x/skill.json`）导致加载失败 → 连续剥离统一根目录；
- 卸载只匹配 `skill.json`，插件删不掉 → 两种清单都匹配；
- 插件依赖原仓库的内部模块：补 `src/model-prices.js`；`llm.js` 补转换链，插件可裁剪本轮工具；
- 控制台只监听 127.0.0.1 → 支持 `QQ_AGENT_HOST` 覆盖（容器里用 0.0.0.0）。

### 部署与分发

- `scripts/install.sh`：一键装系统依赖 + LinuxQQ + NapCat + qq-agent，可选 systemd；
- `scripts/update.sh`：一条命令跟到 `origin/main` 并重启、健康检查；
- `Dockerfile` + `docker-compose.yml`（qq-agent + napcat）；
- `DEPLOY.md`、`EXTENSIONS.md`、`DISTRIBUTE.md` 三份文档；
- 测试：新增 `test/skills.test.mjs`（扩展 10 项 + 插件专项 5 项）。

### 安全提示

Skill 是 Node ESM，`import` 即执行任意本地代码；`permissions: ["web_fetch"]` 只限制 `api.fetch`。
只安装自己审过的扩展。
