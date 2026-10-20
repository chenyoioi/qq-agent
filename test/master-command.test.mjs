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
