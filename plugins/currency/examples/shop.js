/**
 * 可恢复订单示例，不会自动执行。
 * 主人配置：{"item-shop":["reserve","capture","release","refund"]}
 * order 必须由商店事先持久化，包含固定的 id/scope/userId/price/itemId。
 * 调用方对同一订单串行执行，并负责身份、价格、库存和订单所有者校验。
 * inventory.grantOnce(order) 必须持久化去重：
 *   { status: 'delivered' } 已交付（包括重试）；
 *   { status: 'rejected' } 明确未交付、以后重试也不会交付；
 *   抛错/其他返回表示结果未知，必须保留预扣，稍后恢复。
 * 两个扩展的数据并不在同一事务里；禁止把未知结果当失败自动退款。
 */
export async function settleOrder(api, inventory, order) {
  const currency = api.capability('currency.v1', { consumer: 'item-shop' });
  if (!currency || currency.apiVersion !== 1) return { ok: false, code: 'UNAVAILABLE', message: '货币系统未启用。' };
  const reserved = await currency.reserve({ scope: order.scope, userId: order.userId, amount: order.price,
    requestId: `order:${order.id}:reserve`, reason: '购买道具：预扣' });
  if (!reserved.ok) return reserved;
  const status = await currency.receipt({ scope: order.scope, requestId: `order:${order.id}:reserve` });
  if (!status.ok) return status;
  if (status.reservation?.status === 'released') return { ok: false, code: 'ORDER_CANCELLED', message: '订单预扣款已释放，不再交付。' };
  if (status.reservation?.status === 'captured') {
    return await currency.receipt({ scope: order.scope, requestId: `order:${order.id}:capture` });
  }
  let delivery;
  try { delivery = await inventory.grantOnce(order); }
  catch { return { ok: false, code: 'DELIVERY_UNKNOWN', message: '交付结果待核对，保留预扣款，使用同一订单恢复。' }; }
  const args = { scope: order.scope, reservationId: reserved.receipt.id };
  if (delivery?.status === 'delivered') {
    // 此步失败也不能重新发货或释放预扣：重新运行，grantOnce 返回已交付，再结算。
    return await currency.capture({ ...args, requestId: `order:${order.id}:capture`, reason: '购买道具：结算' });
  }
  if (delivery?.status === 'rejected') {
    const released = await currency.release({ ...args, requestId: `order:${order.id}:release`, reason: '购买道具：取消' });
    if (!released.ok) return released;
    return { ok: false, code: 'ORDER_CANCELLED', message: '明确未交付，已释放预扣款。' };
  }
  return { ok: false, code: 'DELIVERY_UNKNOWN', message: '交付结果待核对，预扣款仍保留。' };
}
