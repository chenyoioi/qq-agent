// 撤回处理：消息打标 + 提示词里出现"已撤回"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-recall-'));
process.env.QQ_AGENT_DATA_DIR = dir;
fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });

const { ChatStore } = await import('../src/store.js');
const { buildPastState } = await import('../src/prompt.js');

let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };

const store = new ChatStore(0);
store.appendIncoming('group:1', { mid: '42', ts: Date.now(), senderId: '100', senderName: '小明', text: '刚那张图好笑' });

assert.equal(store.markRecalled('group:1', '42'), true);
ok('撤回事件能按 mid 标记到消息');

const hit = store.recent('group:1', { limit: 5 }).find((m) => String(m.mid) === '42');
assert.equal(hit.recalled, true);
ok('标记已落库（recalled=true）');

assert.equal(store.markRecalled('group:1', '42'), false, '重复撤回不应再次落库');
assert.equal(store.markRecalled('group:1', '999'), false, '不存在的 mid 返回 false');
ok('重复/不存在的撤回不会出错');

const past = buildPastState(store, 'group:1');
assert.match(past.text, /已撤回/);
ok('提示词里带「已撤回」标记');

console.log(`\n撤回处理 ${pass} 项检查通过 ✅`);
