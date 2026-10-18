# skills/ —— LLM 型扩展

每个扩展一个目录：`<id>/skill.json` + `<id>/index.js`（`export function setup(api)`）。

- 注册的工具会进入模型的 function 列表，何时调用由模型判断；
- 开关写在 `config.skills[<id>].enabled`，控制台「技能」页可切换；
- 放进来即热重载生效（`config.extensions.hotReload` 默认开）。

完整规范见 [EXTENSIONS.md](../EXTENSIONS.md)。
