/** currency.v1 — 金额为最小单位整数；方法同步返回，也可 await。 */
export type Scope = `group:${string}` | `private:${string}`;
export type WriteMethod = 'credit' | 'debit' | 'transfer' | 'reserve' | 'capture' | 'release' | 'refund';
export type ErrorCode = 'INVALID_ARGUMENT' | 'INVALID_CONFIG' | 'INVALID_CONTEXT' | 'AMBIGUOUS_REQUESTER'
  | 'FORBIDDEN' | 'UNAVAILABLE' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'BALANCE_LIMIT'
  | 'INSUFFICIENT_FUNDS' | 'INVALID_STATE' | 'HOLD_CLOSED' | 'ALREADY_REFUNDED'
  | 'CORRUPT_DATA' | 'STORAGE_LOCKED' | 'STORAGE_ERROR' | 'INTERNAL_ERROR';
export type Result<T> = ({ ok: true } & T) | { ok: false; code: ErrorCode; message: string };
export interface Request {
  scope: Scope;
  /** 同一 consumer + scope 内永久唯一，重试必须保持参数（含 reason）完全相同。 */
  requestId: string;
  reason: string;
}
export interface AmountRequest extends Request { userId: string; amount: number }
export interface TransferRequest extends Request { fromUserId: string; toUserId: string; amount: number }
export interface HoldRequest extends Request { reservationId: string }
export interface RefundRequest extends Request { transactionId: string }
export type TransactionInput = { consumer: string } & (
  | (AmountRequest & { operation: 'credit' | 'debit' | 'reserve' })
  | (TransferRequest & { operation: 'transfer' })
  | (HoldRequest & { operation: 'capture' | 'release' })
  | (RefundRequest & { operation: 'refund' })
);
export interface Balance { scope: Scope; userId: string; balance: number; held: number; available: number }
export interface Entry { userId: string; delta: number; heldDelta: number; balance: number; held: number; available: number }
export interface Receipt {
  id: string;
  sequence: number;
  at: number;
  input: TransactionInput;
  amount: number;
  entries: Entry[];
}
export interface Reservation {
  id: string; scope: Scope; consumer: string; userId: string; amount: number;
  status: 'pending' | 'captured' | 'released'; resolvedBy: string | null;
}
export interface CurrencyClient {
  readonly apiVersion: 1;
  readonly consumer: string;
  info(): Result<{ apiVersion: 1; currencyName: string; unit: 'integer'; maxBalance: number; permissions: WriteMethod[] }>;
  balance(args: { scope: Scope; userId: string }): Result<Balance & { currencyName: string }>;
  history(args: { scope: Scope; userId: string; limit?: number; before?: number }): Result<{ receipts: Receipt[]; nextBefore: number | null }>;
  rank(args: { scope: Scope; limit?: number }): Result<{ accounts: Balance[]; currencyName: string }>;
  /** 只查本 consumer 的 requestId；receipt 是原始快照，reservation/refundId 是当前状态。 */
  receipt(args: { scope: Scope; requestId: string }): Result<{ receipt: Receipt; reservation: Reservation | null; refundId: string | null }>;
  /** 只查本 consumer 尚未处理的预扣款，按序号升序分页；after 传上一页 nextAfter。 */
  reservations(args: { scope: Scope; userId?: string; limit?: number; after?: number }): Result<{ reservations: (Reservation & { sequence: number })[]; nextAfter: number | null }>;
  credit(args: AmountRequest): WriteResult;
  debit(args: AmountRequest): WriteResult;
  transfer(args: TransferRequest): WriteResult;
  reserve(args: AmountRequest): WriteResult;
  capture(args: HoldRequest): WriteResult;
  release(args: HoldRequest): WriteResult;
  refund(args: RefundRequest): WriteResult;
}
export type WriteResult = Result<{ receipt: Receipt & { replayed: boolean }; currencyName: string }>;
export interface CurrencyHostApi {
  capability(name: 'currency.v1', args: { consumer: string }): CurrencyClient | undefined;
}
