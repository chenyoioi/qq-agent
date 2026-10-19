// 群聊回复门禁：只在 @ / 叫名字时必回，其余按概率偶尔回。
import assert from 'node:assert/strict';
const { shouldWakeForReply } = await import('../src/orchestrator.js');

const policy = { enabled: true, keywords: ['大肥鱼', '小鲸鱼', 'DeepSeek'], otherProbability: 0.03 };
let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };

// @ 机器人 → 必回
assert.equal(shouldWakeForReply([{ senderId: '1', text: '在吗', atSelf: true }], policy, [], () => 0.99), true);
ok('被 @ 时必定唤醒');

// 叫到名字 → 必回（大小写不敏感）
assert.equal(shouldWakeForReply([{ senderId: '1', text: '大肥鱼出来' }], policy, [], () => 0.99), true);
assert.equal(shouldWakeForReply([{ senderId: '1', text: 'deepseek 你怎么看' }], policy, [], () => 0.99), true);
ok('提到关键词/名字时必定唤醒');

// 普通闲聊 → 按概率：骰子大就不回，骰子小就偶尔接
assert.equal(shouldWakeForReply([{ senderId: '1', text: '今天天气不错' }], policy, [], () => 0.5), false);
assert.equal(shouldWakeForReply([{ senderId: '1', text: '今天天气不错' }], policy, [], () => 0.001), true);
ok('普通消息按 otherProbability 偶尔放行');

// 同一批里只要有一条 @ 或关键词就放行
assert.equal(shouldWakeForReply([
  { senderId: '1', text: '随便聊聊' },
  { senderId: '2', text: '@机器人 看这个', atSelf: true }
], policy, [], () => 0.99), true);
ok('一批消息里有一条命中就放行');

// 关掉门禁 → 一律放行
assert.equal(shouldWakeForReply([{ senderId: '1', text: '无关内容' }], { ...policy, enabled: false }, [], () => 0.99), true);
ok('enabled=false 时不拦截（回到旧行为）');

console.log(`\n回复门禁 ${pass} 项检查通过 ✅`);
