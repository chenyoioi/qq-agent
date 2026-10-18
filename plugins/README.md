# plugins/ —— 确定性型扩展

每个扩展一个目录：`<id>/plugin.json` + `<id>/index.js`（导出 `providers` / `hooks`）。

- 由核心在条件命中时**必然**调用，不经过模型判断；
- 可提供能力（`capabilities`）供其他扩展软依赖；
- 钩子：`before-context` / `before-llm-messages` / `before-tool` / `after-tool` / `after-response`。

完整规范见 [EXTENSIONS.md](../EXTENSIONS.md)。
