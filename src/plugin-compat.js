// 插件兼容层：第三方扩展经常会 import 核心内部的小工具（如 toFileUri）。
// 这些符号在核心内部重构时容易改名/搬家，导致插件"装上了加载失败"。
// 这里提供一份**稳定出口**，建议扩展统一从 plugin-compat.js 取用：
//
//   import { toFileUri, sleep, randInt, getConfig, DATA_DIR } from '../../src/plugin-compat.js';
//
// 只做转发，不改变任何行为。
export { toFileUri, stripToolMarkup } from './sender.js';
export { sleep, randInt } from './util.js';
export { getConfig, DATA_DIR } from './config.js';
export { mdToPlain, splitForQQ } from './md-to-plain.js';
