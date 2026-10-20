// 主人指令解析：各种说法都要能对上，普通聊天不能误判
import assert from 'node:assert/strict';
const { parseMasterCommand } = await import('../src/master-command.js');

let pass = 0;
const eq = (text, expect) => {
  assert.deepEqual(parseMasterCommand(text), expect, `解析「${text}」`);
  pass++;
};

eq('关闭点歌', { action: 'off', query: '点歌' });
eq('关掉点歌功能', { action: 'off', query: '点歌' });
eq('把点歌关了', { action: 'off', query: '点歌' });
eq('点歌关掉', { action: 'off', query: '点歌' });
eq('别点歌了', { action: 'off', query: '点歌' });
eq('禁用点歌插件', { action: 'off', query: '点歌' });
eq('帮我把点歌关了', { action: 'off', query: '点歌' });
eq('打开语音', { action: 'on', query: '语音' });
eq('恢复点歌', { action: 'on', query: '点歌' });
eq('点歌功能打开', { action: 'on', query: '点歌' });

// 普通聊天不能误判
for (const t of ['你好', '今天吃什么', '关我什么事', '这个功能挺好', '点歌 年轮']) {
  assert.equal(parseMasterCommand(t), null, `「${t}」不应被当成指令`);
  pass++;
}

console.log(`\n主人指令解析 ${pass} 项检查通过 ✅`);

// 扩展匹配：模糊匹配 + 全部
import { matchExtensions } from '../src/master-command.js';
const list = [
  { id: 'netease-voice-song', name: '点歌发语音条', enabled: true },
  { id: 'voxcpm-voice', name: '鲸鱼语音（VoxCPM）', enabled: true },
  { id: 'whale-memes', name: '梗鲸表情包', enabled: true },
  { id: 'quota-guard', name: 'Token 配额守卫', enabled: true }
];
assert.deepEqual(matchExtensions(list, '点歌').map((x) => x.id), ['netease-voice-song']);
assert.deepEqual(matchExtensions(list, '梗鲸').map((x) => x.id), ['whale-memes']);
assert.deepEqual(matchExtensions(list, '配额').map((x) => x.id), ['quota-guard']);
assert.equal(matchExtensions(list, '所有').length, 4);
assert.equal(matchExtensions(list, '不存在的东西').length, 0);
console.log('扩展匹配 5 项检查通过 ✅');

// 闭嘴 / 张嘴
import { matchMuteCommand } from '../src/master-command.js';
assert.equal(matchMuteCommand('闭嘴'), 'mute');
assert.equal(matchMuteCommand('别说话。'), 'mute');
assert.equal(matchMuteCommand('安静点'), 'mute');
assert.equal(matchMuteCommand('张嘴'), 'unmute');
assert.equal(matchMuteCommand('可以说话了'), null); // 带“了”不在白名单，避免误判普通聊天
assert.equal(matchMuteCommand('今天吃什么'), null);
console.log('闭嘴/张嘴 6 项检查通过 ✅');
