// 主人绝对模式：主人触发才注入最高指令，其他人不受影响
import assert from 'node:assert/strict';
const mod = await import('../plugins/master-absolute/index.js');

const settings = { enabled: true, masterQqs: '1535743858', mode: 'absolute', applyToGroup: true, applyToPrivate: true, safetyFloor: true, extraRules: '' };
mod.setup({ config: () => settings, log: () => {} });

let pass = 0;
const run = (sessionId, senderId, kind = 'group') => {
  const messages = [{ role: 'system', content: 'SYS' }];
  mod.hooks['before-context']({ kind, sessionId, chatKey: `chat:${sessionId}`, triggerEntries: [{ senderId }] });
  mod.hooks['before-llm-messages']({ kind, sessionId, chatKey: `chat:${sessionId}`, messages });
  return messages[0].content;
};

assert.match(run('s1', '1535743858'), /^【最高优先级·主人指令】/);
pass++;
assert.match(run('s1', '1535743858'), /不反驳/);
pass++;
assert.equal(run('s2', '999999'), 'SYS');
pass++;

settings.mode = 'warm';
assert.match(run('s3', '1535743858'), /更耐心/);
pass++;

settings.mode = 'absolute';
settings.applyToGroup = false;
assert.equal(run('s4', '1535743858', 'group'), 'SYS');
pass++;
assert.match(run('s5', '1535743858', 'private'), /最高优先级/);
pass++;
settings.applyToGroup = true;

settings.enabled = false;
assert.equal(run('s6', '1535743858'), 'SYS');
pass++;
settings.enabled = true;

settings.safetyFloor = false;
assert.doesNotMatch(run('s7', '1535743858'), /违法/);
pass++;
settings.safetyFloor = true;

settings.extraRules = '回复叫我老板';
assert.match(run('s8', '1535743858'), /回复叫我老板/);
pass++;

console.log(`\n主人绝对模式 ${pass} 项检查通过 ✅`);
