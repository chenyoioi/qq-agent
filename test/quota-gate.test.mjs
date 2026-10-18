// quota-guard 接线测试：验证核心确实能通过 chat.quota-gate 拦下一轮（不碰真实 QQ/模型）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-quota-'));
process.env.QQ_AGENT_DATA_DIR = DATA_DIR;
process.env.TZ = 'Asia/Shanghai';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { setRuntimeConfig, getConfig, updateConfig } = await import(path.join(ROOT, 'src/config.js'));
const { loadPlugins } = await import(path.join(ROOT, 'src/plugin-loader.js'));
const { skillManager } = await import(path.join(ROOT, 'src/skills/manager.js'));
const { SendQueue } = await import(path.join(ROOT, 'src/sender.js'));

let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };

// 把一个“已超额”的账本先放好（插件在 import 时会读）
const today = (() => {
  const shift = new Date(Date.now() - 4 * 3600 * 1000);
  return `${shift.getFullYear()}-${String(shift.getMonth() + 1).padStart(2, '0')}-${String(shift.getDate()).padStart(2, '0')}`;
})();
fs.mkdirSync(path.join(DATA_DIR, 'quota-guard'), { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'quota-guard', 'ledger.json'), JSON.stringify({
  version: 1,
  users: {
    '111': { dayKey: today, used: 900, spent: 900, name: '超额的人' },
    '222': { dayKey: today, used: 10, spent: 10, name: '还有额度的人' },
    '999': { dayKey: today, used: 900, spent: 900, name: '主人' },
    '111111': { dayKey: today, used: 50, spent: 50, name: '待重置' },
    '222222': { dayKey: today, used: 50, spent: 50, name: '非主人目标' }
  },
  totals: {}, blocked: {}, userFloors: {}
}));

// 用真实目录加载（插件内部按 ../../src 引用核心模块，拷到别处会解析失败）
const realRoots = { skills: path.join(ROOT, 'skills'), plugins: path.join(ROOT, 'plugins') };

setRuntimeConfig({
  ...getConfig(),
  skills: { 'quota-guard': { enabled: true, resetHour: 0, defaultDailyLimit: 100, blockWhenSendLimited: true } },
  tools: { enabled: true, categories: {}, overrides: {} },
  extensions: { hotReload: false },
  send: { ...(getConfig().send || {}), maxPerMinute: 0, maxPerHour: 0 }
});

await loadPlugins({ roots: realRoots, log: () => {} });
assert.equal(skillManager.isActive('quota-guard', {}).active, true);
ok('quota-guard 加载并激活');

const providers = skillManager.getCapabilityProviders('chat.quota-gate', {});
assert.equal(providers.length, 1, '应有一个 chat.quota-gate 提供者');
ok('能力 chat.quota-gate 可被核心解析');

const gate = providers[0].fn;
const base = { chatKey: 'group:1', kind: 'group', chatId: '1', sessionId: 's1', tier: 0, willRespond: true, sendState: { ok: true } };

// 全部参与者都超额 → 必须拦
const allBlocked = await gate({ ...base, triggerEntries: [{ senderId: '111', senderName: 'A', text: 'hi' }] });
assert.equal(allBlocked?.skip, true);
assert.equal(allBlocked.code, 'quota-exhausted');
ok('全员超额时返回 skip=quota-exhausted');

// 还有人有余额 → 放行
const someLeft = await gate({ ...base, triggerEntries: [
  { senderId: '111', senderName: 'A', text: 'hi' },
  { senderId: '222', senderName: 'B', text: 'yo' }
] });
assert.equal(someLeft, null);
ok('仍有参与者有余额时放行（null）');

// 额度为 0 = 不限 → 放行
updateConfig({ skills: { 'quota-guard': { enabled: true, resetHour: 0, defaultDailyLimit: 0 } } });
const unlimited = await gate({ ...base, triggerEntries: [{ senderId: '111', senderName: 'A', text: 'hi' }] });
assert.equal(unlimited, null);
ok('额度 0（不限）时放行');

// 发送限流：canSend 只读、不占额度
const q = new SendQueue({ onebot: {}, store: {} });
updateConfig({ send: { ...(getConfig().send || {}), maxPerMinute: 1, maxPerHour: 0 } });
assert.equal(q.canSend('group:1').ok, true);
q.minuteTimes.set('group:1', [Date.now()]);
const limitState = q.canSend('group:1');
assert.equal(limitState.ok, false);
assert.match(limitState.reason, /每分钟/);
assert.equal(q.minuteTimes.get('group:1').length, 1, 'canSend 不能写入记录');
ok('canSend 只读：限流状态可查且不占用额度');

// 把发送限流交给 gate：核心会在请求模型前拦下
updateConfig({ skills: { 'quota-guard': { enabled: true, resetHour: 0, defaultDailyLimit: 0, blockWhenSendLimited: true } } });
const rateBlocked = await gate({ ...base, triggerEntries: [{ senderId: '111', senderName: 'A', text: 'hi' }], sendState: limitState });
assert.equal(rateBlocked?.skip, true);
assert.equal(rateBlocked.code, 'rate-limited');
ok('发送限流已满时返回 skip=rate-limited（零消耗）');

console.log(`\nquota-guard 接线 ${pass} 项检查通过 ✅`);

// ── 本轮被拦名单：核心据此"不回复他" ──────────────────────────────────
const { buildToolDefs, executeTool } = await import(path.join(ROOT, 'src/tools.js'));
updateConfig({ skills: { 'quota-guard': { enabled: true, resetHour: 0, defaultDailyLimit: 100 } } });

const qg = skillManager.registry.get('quota-guard');
const trig = [
  { senderId: '111', senderName: 'A', text: '超额的人' },
  { senderId: '222', senderName: 'B', text: '还有额度' }
];
await qg.hooks['before-context']({ chatKey: 'group:1', kind: 'group', triggerEntries: trig, sessionId: 's9' }, {});
assert.deepEqual(trig.map((m) => m.senderId), ['222']);
const blockedFn = skillManager.getCapabilityProviders('chat.blocked-users', {})[0].fn;
assert.deepEqual(blockedFn({ sessionId: 's9' }), ['111']);
ok('超额者的消息被剔除，且 blocked-users 能报出名单');

const defs = buildToolDefs();
const ctx = {
  chatKey: 'group:1', chatId: '1', kind: 'group',
  blockedUserIds: ['111'],
  store: { recent: () => [{ mid: 'm-111', senderId: '111' }] },
  sender: { sendTextBatch: async () => ({ sent: [{ text: 'x', messageId: 1 }], failed: [] }) },
  session: { id: 's9', sent: [] },
  emit: () => {}
};
const atBlocked = await executeTool(defs, ctx, 'send_message', JSON.stringify({ messages: 'hi', atUserId: '111' }));
assert.equal(atBlocked.isError, true);
const replyBlocked = await executeTool(defs, ctx, 'send_message', JSON.stringify({ messages: 'hi', replyToMessageId: 'm-111' }));
assert.equal(replyBlocked.isError, true);
const normal = await executeTool(defs, ctx, 'send_message', JSON.stringify({ messages: 'hi' }));
assert.ok(!normal.isError);
ok('send_message 拒绝 @/引用被拦者，普通发言不受影响');

console.log(`\nquota-guard 静默成员 ${pass - 7} 项检查通过 ✅`);

// ── 主人豁免 + 重置指令 ─────────────────────────────────────────────────
updateConfig({
  persona: { ...(getConfig().persona || {}), masterQQ: '999' },
  skills: { 'quota-guard': { enabled: true, resetHour: 0, defaultDailyLimit: 100 } }
});

// 主人自己用了 900（远超 100）也不该被算超额
const masterGate = await gate({ ...base, triggerEntries: [{ senderId: '999', senderName: '主人', text: 'hi' }] });
assert.equal(masterGate, null);
ok('主人不受额度限制（用量超阈仍放行）');

// 主人发「重置 111」→ 清零 + 回确认 + 整轮零消耗
const sent = [];
const cmdCtx = {
  chatKey: 'group:1', kind: 'group', sessionId: 'sR',
  triggerEntries: [{ senderId: '999', senderName: '主人', text: '重置 111111' }],
  sender: { sendTextBatch: async (_k, msgs) => { sent.push(...msgs); return { sent: [], failed: [] }; } }
};
await qg.hooks['before-context'](cmdCtx, {});
assert.equal(cmdCtx.triggerEntries.length, 0);
const handled = await gate({ ...base, sessionId: 'sR', triggerEntries: [] });
assert.equal(handled?.code, 'handled');
const ledgerNow = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'quota-guard', 'ledger.json'), 'utf8'));
assert.equal(Number(ledgerNow.users['111111'].used), 0);
assert.ok(sent.join('').includes('已重置'));
ok('主人「重置 QQ号」清零额度、回确认、本轮零消耗');

// 非主人发同样指令 → 不生效
const before222 = Number(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'quota-guard', 'ledger.json'), 'utf8')).users['222222'].used);
const fakeCtx = {
  chatKey: 'group:1', kind: 'group', sessionId: 'sX',
  triggerEntries: [{ senderId: '222', senderName: 'B', text: '重置 222222' }],
  sender: { sendTextBatch: async () => ({ sent: [], failed: [] }) }
};
await qg.hooks['before-context'](fakeCtx, {});
const after222 = Number(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'quota-guard', 'ledger.json'), 'utf8')).users['222222'].used);
assert.equal(after222, before222);
ok('非主人的重置指令不生效');

console.log(`\nquota-guard 主人特权 ${pass - 9} 项检查通过 ✅`);
