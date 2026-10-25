import { createStorage, defaultDataDirectory } from './lib/storage.js';
import { register as registerCheckin, ui as checkinUi } from './lib/checkin.js';
import { register as registerRedPacket, ui as redPacketUi } from './lib/red-packet.js';
import { register as registerShop, ui as shopUi } from './lib/shop.js';
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
      // 经济系统的三块业务（签到 / 红包 / 商店）与货币同属一个插件：
      // 同一个设置页、同一张卡片、同一个面板，不再分四个插件各管一份配置。
      registerCheckin(api);
      registerRedPacket(api);
      registerShop(api);
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

/**
 * 控制台面板的统一入口（宿主读模块导出的 handleUiRequest）。
 * 面板动作按区域前缀分发：shop:* / checkin:* / rp:*，货币自身的查询走 shop 面板里的调账区。
 */
export async function handleUiRequest({ action, payload } = {}) {
  const name = String(action || '');
  const [area, ...rest] = name.split(':');
  const sub = rest.join(':');
  if (area === 'shop') return shopUi({ action: sub, payload });
  if (area === 'checkin') return checkinUi({ action: sub, payload });
  if (area === 'rp') return redPacketUi({ action: sub === 'list' ? 'list' : sub, payload });
  return { ok: false, error: `未知面板动作：${name}` };
}
