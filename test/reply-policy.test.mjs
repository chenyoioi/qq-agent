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

// ── @ 判定（isAtMe）：插件拿它做「仅 @」准入，QQ 号优先、名字兜底 ──
const { isAtMe } = await import('../src/prompt.js');
const at = { selfId: '123456', selfNickname: '大肥鱼', botName: '小鲸鱼' };
assert.equal(isAtMe('@大肥鱼 在吗', at), true, '群名片 @');
assert.equal(isAtMe('@小鲸鱼 看这个', at), true, '机器人名 @');
assert.equal(isAtMe('[CQ:at,qq=123456] 来', at), true, '未展平的 CQ 码');
assert.equal(isAtMe('[CQ:at,qq=123456,type=1] 来', at), true, '带附加字段的 CQ 码');
assert.equal(isAtMe('@大肥鱼(QQ:123456) 来', at), true, '展平的 昵称(QQ) 写法');
assert.equal(isAtMe('@123456 来', at), true, '只剩 QQ 号');
assert.equal(isAtMe('@1234567 来', at), false, '前缀相同的别的号不该命中');
assert.equal(isAtMe('@别人 看看', at), false, '@ 别人不算');
assert.equal(isAtMe('没有艾特', at), false, '没有 @');
assert.equal(isAtMe('', at), false, '空文本');
assert.equal(isAtMe('@全体成员', at), false, '@全体成员 不算 @我');
// 没有 selfId 时按名字兜底；没有 @ 不算
assert.equal(isAtMe('@大肥鱼 hi', { selfNickname: '大肥鱼' }), true, '无 selfId 时名字兜底');
assert.equal(isAtMe('随便说说', { selfNickname: '大肥鱼' }), false, '没有 @ 不算');
ok('@ 判定（isAtMe）按 QQ 号优先、名字兜底');

// 关掉门禁 → 一律放行
assert.equal(shouldWakeForReply([{ senderId: '1', text: '无关内容' }], { ...policy, enabled: false }, [], () => 0.99), true);
ok('enabled=false 时不拦截（回到旧行为）');

// ── 主人闲聊门禁：不再"主人说一句她回一句"，但 @/引用/叫名字仍然必回 ──
const { shouldWakeForMasterChatter } = await import('../src/orchestrator.js');
const masterPolicy = { enabled: true, keywords: ['大肥鱼'], otherProbability: 0.03, masterProbability: 0.35 };
// 随机数 0.9 > 0.35 → 不唤醒
assert.equal(shouldWakeForMasterChatter([{ senderId: '9', text: '今天好累' }], masterPolicy, ['小鲸鱼'], () => 0.9), false, '主人闲聊按概率可以被跳过');
// 随机数 0.1 < 0.35 → 唤醒
assert.equal(shouldWakeForMasterChatter([{ senderId: '9', text: '今天好累' }], masterPolicy, ['小鲸鱼'], () => 0.1), true, '概率内照常唤醒');
// 硬命中一律放行，与随机数无关
assert.equal(shouldWakeForMasterChatter([{ senderId: '9', text: '@小鲸鱼 在吗', atSelf: true }], masterPolicy, ['小鲸鱼'], () => 0.99), true, '@ 我必回');
assert.equal(shouldWakeForMasterChatter([{ senderId: '9', text: '回我这句', replyToSelf: true }], masterPolicy, ['小鲸鱼'], () => 0.99), true, '引用我必回');
assert.equal(shouldWakeForMasterChatter([{ senderId: '9', text: '小鲸鱼你说呢' }], masterPolicy, ['小鲸鱼'], () => 0.99), true, '叫名字必回');
// 概率可调到 0（只回点名）与 1（句句回）
assert.equal(shouldWakeForMasterChatter([{ senderId: '9', text: '嗯' }], { ...masterPolicy, masterProbability: 0 }, [], () => 0.0), false, '概率 0 → 闲聊不接');
assert.equal(shouldWakeForMasterChatter([{ senderId: '9', text: '嗯' }], { ...masterPolicy, masterProbability: 1 }, [], () => 0.99), true, '概率 1 → 句句回');
ok('主人闲聊门禁（@/引用/叫名字必回，其余按 masterProbability）');

console.log(`\n回复门禁 ${pass} 项检查通过 ✅`);
