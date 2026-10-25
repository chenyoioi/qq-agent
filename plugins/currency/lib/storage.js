import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { emptyState, restore, prepare, commit } from './ledger.js';
import { fail } from './validation.js';
import { createFileLock } from './file-lock.js';

export function defaultDataDirectory(pluginUrl, env = process.env) {
  if (env.QQ_AGENT_DATA_DIR) return path.resolve(env.QQ_AGENT_DATA_DIR);
  const rawProfile = (env.QQ_AGENT_PROFILE || '').trim();
  const profile = /^\d+$/.test(rawProfile) ? rawProfile : '';
  return fileURLToPath(new URL(`../../data${profile ? `-${profile}` : ''}/`, pluginUrl));
}

export function createStorage({ directory, io = fs, now = Date.now }) {
  let state = null, file;
  let reason = '';
  const lock = createFileLock({ io, label: '货币数据' });

  function open() {
    if (state) return;
    const dir = typeof directory === 'function' ? directory() : directory;
    io.mkdirSync(dir, { recursive: true });
    file = path.join(io.realpathSync(dir), 'currency.json');
    try {
      lock.acquire(`${file}.lock`);
      let parsed;
      try { parsed = JSON.parse(io.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') fail('CORRUPT_DATA', `无法读取货币数据：${error.message}`); }
      state = parsed === undefined ? emptyState() : restore(parsed);
      reason = '';
    } catch (error) {
      reason = error.message;
      close();
      throw error;
    }
  }

  function transact(input) {
    if (!state) fail('UNAVAILABLE', '货币存储尚未启用。');
    const result = prepare(state, input, now());
    if (result.replayed) return { ...structuredClone(result.receipt), replayed: true };
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      lock.assertOwned();
      const document = { pluginId: 'currency', version: 1, transactions: [...state.receipts, result.receipt] };
      fd = io.openSync(temp, 'wx');
      io.writeFileSync(fd, JSON.stringify(document), 'utf8');
      io.fsyncSync(fd);
      io.closeSync(fd); fd = undefined;
      io.renameSync(temp, file);
    } catch (error) {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      reason = '货币数据保存失败，未提交本次交易。';
      if (error.code === 'STORAGE_LOCKED') throw error;
      fail('STORAGE_ERROR', reason);
    } finally { try { io.unlinkSync(temp); } catch {} }
    // 文件替换成功后才改变可见余额；失败无需回滚，也不会在停用时补交。
    commit(state, result);
    reason = '';
    return { ...structuredClone(result.receipt), replayed: false };
  }

  function close() {
    state = null;
    lock.release();
  }

  return { open, close, transact, get state() { return state; }, get reason() { return reason; } };
}
