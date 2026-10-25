import { createStorage, defaultDataDirectory } from './lib/storage.js';
import { createService } from './lib/service.js';
import { registerTools } from './lib/tools.js';
import { fail, settings } from './lib/validation.js';

export function createCurrencyPlugin({ directory, io, now = Date.now } = {}) {
  let hostApi, running = false, epoch = 0, activationError = '';
  const storage = createStorage({ directory: directory ?? (() => defaultDataDirectory(import.meta.url)), io, now });
  const readSettings = () => settings(hostApi?.config?.() ?? {});
  const guard = expectedEpoch => {
    if (!running || !storage.state || expectedEpoch !== epoch) fail('UNAVAILABLE', '货币服务已停用或重新加载，请重新获取 currency.v1。');
    // 能力对象可能被消费方缓存；每次调用仍遵守宿主的唯一启用状态。
    if (hostApi?.isSkillActive?.('currency') === false) fail('UNAVAILABLE', '货币系统当前未生效，请检查插件开关与设置。');
  };
  const service = createService({ storage, readSettings, guard });

  return {
    setup(api) {
      hostApi = api;
      registerTools(api, { service, readSettings, epoch: () => epoch, now });
    },
    activate() {
      if (running) return;
      epoch += 1;
      // 配置自检由 available / 每次调用负责。宿主保存设置不会再次 activate，
      // 因此错误配置不能阻止存储初始化，否则修正配置后仍会永远不可用。
      try { storage.open(); running = true; activationError = ''; }
      catch (error) { running = false; activationError = error.message; throw error; }
    },
    deactivate() { running = false; epoch += 1; storage.close(); },
    dispose() { running = false; epoch += 1; storage.close(); },
    available() {
      try { readSettings(); } catch (error) { return { ok: false, reason: error.message }; }
      return activationError ? { ok: false, reason: activationError } : true;
    },
    providers: {
      'currency.v1': ({ consumer } = {}) => {
        if (!running || hostApi?.isSkillActive?.('currency') === false) return undefined;
        return service.client(consumer, epoch);
      }
    }
  };
}

const plugin = createCurrencyPlugin();
export const { setup, activate, deactivate, dispose, available, providers } = plugin;
