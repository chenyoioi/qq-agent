// 扩展系统（skills/ + plugins/）端到端测试：不碰真实 QQ / 真实模型。
// 覆盖：加载、工具注册、开关联动、能力、钩子、提示词片段、卸载清理。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-skill-test-'));
process.env.TZ = 'Asia/Shanghai';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { setRuntimeConfig, getConfig, updateConfig } = await import(path.join(ROOT, 'src/config.js'));
const { loadPlugins, unloadSkill } = await import(path.join(ROOT, 'src/plugin-loader.js'));
const { skillManager } = await import(path.join(ROOT, 'src/skills/manager.js'));
const { getTool, getToolAvailability, listTools } = await import(path.join(ROOT, 'src/tool-registry.js'));
const { buildToolDefs, executeTool } = await import(path.join(ROOT, 'src/tools.js'));

let pass = 0;
function ok(label) { pass++; console.log('  ✓ ' + label); }

// 1) 加载 —— 用自带 fixture 的临时根目录，不依赖用户实际安装的扩展
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-skill-fixtures-'));
const fxSkills = path.join(fixtureRoot, 'skills');
const fxPlugins = path.join(fixtureRoot, 'plugins');
fs.mkdirSync(fxSkills, { recursive: true });
fs.mkdirSync(fxPlugins, { recursive: true });
// fixture 直接内联，避免依赖用户实际安装/删除的扩展
fs.mkdirSync(path.join(fxSkills, 'example-dice'), { recursive: true });
fs.writeFileSync(path.join(fxSkills, 'example-dice', 'skill.json'), JSON.stringify({
  id: 'example-dice', name: '示例·掷骰子', version: '1.0.0', apiVersion: 1, category: 'utility',
  description: 'fixture', enabledByDefault: true, settings: { sides: 6 },
  configSchema: { sides: { type: 'number', label: '面数', default: 6 } },
  prompt: { sections: [{ id: 'dice-usage', title: '掷骰子', content: '用 dice_roll', priority: 40 }] }
}));
fs.writeFileSync(path.join(fxSkills, 'example-dice', 'index.js'), `
export function setup(api) {
  const cfg = () => api.config();
  api.registerTool({
    id: 'dice_roll', name: '掷骰子', description: '掷骰子', category: 'utility',
    parameters: { type: 'object', properties: { count: { type: 'number' } } },
    async execute(_ctx, args) {
      const sides = Math.max(2, Number(cfg().sides) || 6);
      const n = Math.min(5, Math.max(1, Number(args?.count) || 1));
      return { content: '\u{1F3B2} ' + Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides)).join(' / ') };
    }
  });
}
`);
fs.mkdirSync(path.join(fxPlugins, 'example-hook'), { recursive: true });
fs.writeFileSync(path.join(fxPlugins, 'example-hook', 'plugin.json'), JSON.stringify({
  id: 'example-hook', name: '示例·插件', version: '1.0.0', apiVersion: 1,
  category: 'utility', description: 'fixture', enabledByDefault: true, capabilities: ['example.echo']
}));
fs.writeFileSync(path.join(fxPlugins, 'example-hook', 'index.js'), `
let storage = null;
export function setup(api) { storage = api?.storage || null; }
export const providers = { 'example.echo': (t) => String(t ?? '').toUpperCase() };
export const hooks = {
  'before-llm-messages': (ctx) => {
    const sys = ctx?.messages?.[0];
    if (sys && typeof sys.content === 'string') sys.content += ' [example-hook]';
  },
  // onMessage：每条入站消息都要过（触发词类插件靠它），顺便验证 api.storage 能落盘
  onMessage: (ctx, meta) => {
    if (!storage) return;
    storage.set('hits', (storage.get('hits', 0) || 0) + 1);
    storage.set('lastText', String(ctx?.text ?? ''));
    storage.set('via', String(meta?.skillId || ''));
  }
};
`);

setRuntimeConfig({
  ...getConfig(),
  skills: { 'example-dice': { enabled: true }, 'example-hook': { enabled: true } },
  tools: { enabled: true, categories: {}, overrides: {} },
  extensions: { hotReload: false },
  webSearch: { enabled: true },
  api: { ...(getConfig().api || {}), vision: true }
});
const loaded = await loadPlugins({ roots: { skills: fxSkills, plugins: fxPlugins }, log: () => {} });
assert.deepEqual(loaded.loaded.map((r) => r.id).sort(), ['example-dice', 'example-hook']);
assert.equal(loaded.failed.length, 0);
ok('skills/ 与 plugins/ 都能加载，失败数为 0');

// 2) 工具注册（带 skill 前缀）
const defs = buildToolDefs();
const diceId = 'example-dice__dice_roll';
assert.ok(defs.find((d) => d.id === diceId), '技能工具应出现在工具列表');
assert.equal(getTool(diceId).skillId, 'example-dice');
ok('registerTool 生效，工具带 skillId 归属');

// 3) 工具执行
const r = await executeTool(defs, {}, diceId, JSON.stringify({ sides: 20, count: 3 }));
assert.match(String(r.content), /^🎲 /);
ok('技能工具可执行并返回结果');

// 4) 开关联动：关掉 Skill → 工具不可用且有原因
updateConfig({ skills: { 'example-dice': { enabled: false } } });
const off = getToolAvailability(diceId, { skills: skillManager, toolsCfg: getConfig().tools });
assert.equal(off.enabled, false);
assert.ok(off.reason);
assert.ok(!buildToolDefs().length || !(skillManager.isActive('example-dice', {}).active));
ok('关闭 Skill 后工具不可用（availability 给出原因）');

// 5) 重新打开
updateConfig({ skills: { 'example-dice': { enabled: true } } });
assert.equal(getToolAvailability(diceId, { skills: skillManager, toolsCfg: getConfig().tools }).enabled, true);
ok('重新开启后工具恢复可用');

// 6) 提示词片段
const sections = skillManager.getPromptSections({});
assert.ok(sections.some((s) => s.id === 'dice-usage'));
assert.ok(sections.every((s) => s.priority <= 99));
ok('manifest.prompt.sections 进入提示词片段（priority ≤ 99）');

// 7) 钩子
const msgs = [{ role: 'system', content: 'SYS' }];
await skillManager.runHook('before-llm-messages', { messages: msgs });
assert.ok(msgs[0].content.includes('example-hook'));
ok('plugins/ 的 before-llm-messages 钩子被核心调用');

// 7.5) onMessage 钩子 + 扩展存储（api.storage 落盘，跨调用保留）
await skillManager.runHook('onMessage', { text: '你好', chatKey: 'group:1' });
await skillManager.runHook('onMessage', { text: '再来一条', chatKey: 'group:1' });
const storageFile = path.join(process.env.QQ_AGENT_DATA_DIR, 'skill-storage', 'example-hook.json');
const savedStorage = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
assert.equal(savedStorage.hits, 2, 'onMessage 应被调用两次');
assert.equal(savedStorage.lastText, '再来一条');
assert.equal(savedStorage.via, 'example-hook', '钩子应拿到自己的 skillId');
ok('onMessage 钩子被调用，api.storage 落盘且跨调用保留');

// 8) 能力
assert.equal(skillManager.hasCapability('example.echo'), true);
ok('plugins/ 声明的能力可被查询/软依赖');

// 9) 工具守卫（before-tool 否决）
assert.equal(typeof skillManager.getToolGuards, 'function');
ok('tool.guard 能力接口存在');

// 10) 卸载清理
unloadSkill('example-dice', {});
assert.equal(getTool(diceId), null);
assert.ok(!listTools().some((t) => t.skillId === 'example-dice'));
ok('卸载后工具从注册表移除');

// ── 安装器：清单在 dist/ 这类嵌套布局也要装到"目录根上就是清单" ──────────
{
  const { validateZipStructure, readZipManifest, unzipToModuleDir, findModuleDirsById } = await import('../src/zip-install.js');
  // 极简 stored(不压缩) zip：只够构造测试包
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const makeStoredZip = (files) => {
    const locals = []; const centrals = []; let offset = 0;
    for (const [name, content] of Object.entries(files)) {
      const data = Buffer.from(content); const nameBuf = Buffer.from(name); const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      locals.push(local, nameBuf, data);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
      central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, end]);
  };

  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-install-'));
  fs.mkdirSync(path.join(installRoot, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'plugins'), { recursive: true });

  // 清单在包名/dist/ 下（build 后再打包的常见形态）
  const nested = makeStoredZip({
    'distpkg/dist/skill.json': JSON.stringify({ id: 'nested-skill', name: '嵌套包', version: '1.0.0', apiVersion: 1 }),
    'distpkg/dist/index.js': 'export function setup() {}',
    'distpkg/README.md': 'readme'
  });
  const peek = readZipManifest(validateZipStructure(nested));
  assert.equal(peek?.manifest?.id, 'nested-skill');
  const dirName = await unzipToModuleDir(nested, { root: installRoot, type: 'skill', preferId: '' });
  assert.equal(dirName, 'nested-skill', '目录名应取清单 id');
  assert.ok(fs.existsSync(path.join(installRoot, 'skills', 'nested-skill', 'skill.json')), '清单必须在落地目录根上');
  ok('清单在 dist/ 里也能装成"根上就是清单"（不再出现装了却看不见）');

  // 同一 id 再装一次：调用方先删旧目录 → 不会再攒出 _1 副本
  const found = findModuleDirsById(installRoot, 'nested-skill');
  assert.equal(found.length, 1);
  fs.rmSync(found[0].dir, { recursive: true, force: true });
  const again = await unzipToModuleDir(nested, { root: installRoot, type: 'skill', preferId: 'nested-skill' });
  assert.equal(again, 'nested-skill', '重装必须落到同一个目录');
  assert.equal(findModuleDirsById(installRoot, 'nested-skill').length, 1);
  assert.ok(!fs.existsSync(path.join(installRoot, 'skills', 'nested-skill_1')), '不该产生 _1 副本');
  ok('重装落到同一目录，不再产生重复副本');
}

console.log(`\n扩展系统 ${pass} 项检查通过 ✅`);

// ── 插件（确定性型）专项：生命周期、钩子、动态提示词、依赖门控 ──────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-plugin-test-'));
const tmpSkills = path.join(tmp, 'skills');
const tmpPlugins = path.join(tmp, 'plugins');
fs.mkdirSync(tmpSkills, { recursive: true });
fs.mkdirSync(tmpPlugins, { recursive: true });

function writePlugin(dir, id, indexSrc, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name: id, version: '1.0.0', apiVersion: 1, category: 'utility',
    description: id, enabledByDefault: true, ...extra
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), indexSrc);
}

writePlugin(path.join(tmpPlugins, 'life-plugin'), 'life-plugin', `
export const providers = { 'life.hello': () => 'hi' };
export const hooks = {
  'before-tool': () => ({ block: true, reason: 'test-block' }),
  'after-tool': () => {},
  'after-response': () => {},
  'before-context': () => {}
};
export function activate() { globalThis.__life = (globalThis.__life || 0) + 1; }
export function deactivate() { globalThis.__lifeOff = (globalThis.__lifeOff || 0) + 1; }
export function dispose() { globalThis.__lifeDisposed = true; }
export function promptSections() { return [{ id: 'life-dyn', title: '生命周期', content: '动态片段', priority: 30 }]; }
`);
writePlugin(path.join(tmpPlugins, 'missing-dep'), 'missing-dep', `export const providers = {};`, { requires: ['no.such.cap'] });
writePlugin(path.join(tmpPlugins, 'unavailable'), 'unavailable', `
export function available() { return false; }
export const providers = {};
`);

await loadPlugins({ roots: { skills: tmpSkills, plugins: tmpPlugins }, log: () => {} });

// 能力 + 动态提示词
assert.equal(skillManager.hasCapability('life.hello'), true);
assert.equal(skillManager.getCapabilityProviders('life.hello')[0].fn(), 'hi');
assert.ok(skillManager.getPromptSections({}).some((s) => s.id === 'life-dyn'));
ok('插件 providers 提供能力、promptSections 动态片段生效');

// 生命周期：activate → deactivate（此时仍加载，钩子照常生效）
skillManager.activate('life-plugin', {});
assert.equal(globalThis.__life, 1);
skillManager.deactivate('life-plugin', {});
assert.equal(globalThis.__lifeOff, 1);
ok('插件生命周期 activate → deactivate 被调用');

// 钩子：before-tool 能否决
const blocked = await skillManager.runHook('before-tool', { toolName: 'x' });
assert.ok(blocked.some((r) => r.value && r.value.block === true));
ok('插件 before-tool 钩子可返回否决');

// 卸载 → dispose
unloadSkill('life-plugin', {});
assert.equal(globalThis.__lifeDisposed, true);
ok('卸载时 dispose 被调用');

// 依赖门控 / available 门控
const dep = skillManager.isActive('missing-dep', {});
assert.equal(dep.active, false);
assert.match(String(dep.reason), /no\.such\.cap/);
const un = skillManager.isActive('unavailable', {});
assert.equal(un.active, false);
ok('requires 缺失与 available()=false 都会让插件判定为不可用');

console.log(`\n插件专项 ${pass - 10} 项检查通过 ✅`);
