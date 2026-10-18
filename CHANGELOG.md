# 更新日志

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
