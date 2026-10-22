// 提供商管理（设置 → 模型 API）：改 Key 要能真生效、删除当前提供商要自动切换。
// 背景：之前没有删除入口，"想换 API Key 只能删了重加，而删又删不掉"——彻底卡死。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-prov-'));
process.env.QQ_AGENT_DATA_DIR = DATA_DIR;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
  api: { provider: 'p1', model: 'm1', baseUrl: 'https://a.example/v1', apiKey: 'sk-old' },
  providers: [
    { id: 'p1', displayName: 'A', baseURL: 'https://a.example/v1', apiKey: 'sk-old', models: ['m1'] },
    { id: 'p2', displayName: 'B', baseURL: 'https://b.example/v1', apiKey: 'sk-b', models: ['m2', 'm3'] }
  ]
}));

const { removeProvider, setProviderKey, currentProviders } = await import(path.join(ROOT, 'src/providers.js'));
const { getConfig } = await import(path.join(ROOT, 'src/config.js'));

let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };

// ① 给"当前使用"的提供商换 Key：必须同步 api.apiKey（llm.js 读的是这个，否则改了等于没改）
setProviderKey('p1', 'sk-new');
assert.equal(currentProviders().find((p) => p.id === 'p1').apiKey, 'sk-new');
assert.equal(getConfig().api.apiKey, 'sk-new');
ok('改当前提供商的 Key 会同步到 api.apiKey');

// ② 改非当前提供商的 Key：不动当前请求用的 key
setProviderKey('p2', 'sk-b2');
assert.equal(getConfig().api.apiKey, 'sk-new');
ok('改非当前提供商的 Key 不影响当前 api.apiKey');

// ③ 删除当前使用的提供商：自动切到剩下的第一个，model/baseUrl/apiKey 一起换
const r = removeProvider('p1');
assert.equal(r.wasActive, true);
assert.equal(r.removed.id, 'p1');
assert.equal(r.switchedTo.id, 'p2');
assert.equal(currentProviders().length, 1);
assert.equal(getConfig().api.provider, 'p2');
assert.equal(getConfig().api.model, 'm2');
assert.equal(getConfig().api.baseUrl, 'https://b.example/v1');
assert.equal(getConfig().api.apiKey, 'sk-b2');
ok('删除当前提供商会自动切换到剩下的第一个');

// ④ 不存在的 id
assert.equal(removeProvider('nope'), null);
ok('删除不存在的提供商返回 null');

// ⑤ 删掉最后一个：清空 api 指向，不残留失效的 provider id
const last = removeProvider('p2');
assert.equal(last.wasActive, true);
assert.equal(last.switchedTo, null);
assert.equal(getConfig().api.provider, '');
assert.equal(getConfig().api.model, '');
ok('删掉最后一个提供商时清空当前模型配置');

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n提供商管理 ${pass} 项检查通过 ✅`);
