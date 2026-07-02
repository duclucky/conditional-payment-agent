# Đề xuất: Chống double-pay cho `split` khi retry (trước khi sang Giai đoạn 3)

Trạng thái: **ĐỀ XUẤT — chưa code.** Chờ duyệt trước khi hiện thực.

---

## 1. Vấn đề

`executeSplit` (`src/rules/executor.ts`) gửi tuần tự từng leg. Nếu leg N thất bại sau khi
1..N-1 đã gửi thành công thật, hàm trả `success:false` → `RuleEngine` KHÔNG gọi `recordFire()`
(đúng tinh thần fail-safe, CLAUDE.md 4.4 #3). Nhưng nếu SAU ĐÓ có bất kỳ cơ chế nào chạy lại
đúng luật này cho ĐÚNG event đó, code hiện tại sẽ gửi lại **toàn bộ** các leg — kể cả 1..N-1 đã
nhận tiền thật rồi. Đây là double-pay thật, không phải lý thuyết.

## 2. Vì sao đây là rủi ro THẬT khi always-on (Giai đoạn 3), không phải giả định

Idempotency hiện tại đánh dấu `transfer.id` là "đã xử lý" **sau khi** `handleIncomingTransfer`
chạy xong toàn bộ vòng lặp (dù luật fire hay fail). Trong vận hành bình thường (không crash),
một event đã fail sẽ **không** tự động chạy lại — không có gì để double-pay ở kịch bản này.

Lỗ hổng xuất hiện đúng ở kịch bản mà Giai đoạn 3 tạo ra lần đầu: **tiến trình crash/restart, hoặc
mailbox của SDK gửi lại event do lỗi ack mạng, đúng lúc đang xử lý event đó** — cụ thể là sau khi
leg 1 của `split` đã gửi xong nhưng **trước khi** dòng `idempotency.markProcessed()` ở cuối hàm
kịp chạy. Lúc đó:
1. `isProcessed(transfer.id)` sẽ (ĐÚNG) báo "chưa xử lý" — vì nó THẬT SỰ chưa xử lý xong.
2. Event bị gửi lại (SDK tự resync mailbox khi reconnect — cơ chế đã thấy tên ở Phase 0: "claim
   ... persistent seen-set").
3. `handleIncomingTransfer` chạy lại từ đầu, matched lại đúng luật `split` đó.
4. Executor gửi lại **toàn bộ** các leg, kể cả leg 1 đã thành công.

Đây chính xác là kịch bản CLAUDE.md mục Giai đoạn 3 đã lường trước ("khi khởi động lại... đối
soát trạng thái để không chi trùng") — nhưng Giai đoạn 2 chưa cần xử lý vì mỗi lần test là một
script ngắn chạy-xong-là-thoát, không bao giờ crash giữa chừng trong thực tế.

## 3. Nguyên tắc thiết kế

Thêm một tầng idempotency **mức leg**, khoá theo `(ruleId, transfer.id, legIndex)` — nằm DƯỚI
tầng idempotency mức event đã có (`IdempotencyLog`), không thay thế nó. Khi retry một luật
`split` đã chi một phần: **CHỈ gửi các leg chưa có checkpoint thành công; leg đã có checkpoint
không bao giờ gửi lại**, bất kể lý do retry là gì.

## 4. Thiết kế cụ thể

### 4.1 File mới `src/rules/split-progress.ts`

Cùng khuôn với `RuleStore` / `IdempotencyLog` đã có (path inject được để unit test không đụng
file thật của dự án):

```ts
interface SplitLegRecord {
  readonly to: string;
  readonly amount: string;
  readonly transferId: string;
  readonly completedAt: number;
}

// khoá "ruleId:executionKey" -> { legIndex (số) -> record }
type SplitProgressData = Record<string, Record<number, SplitLegRecord>>;

class SplitProgressLog {
  static async load(path = 'store/split-progress.json'): Promise<SplitProgressLog>;
  async getCompletedLegs(ruleId: string, executionKey: string): Promise<Record<number, SplitLegRecord>>;
  async markLegComplete(ruleId: string, executionKey: string, legIndex: number, record: SplitLegRecord): Promise<void>;
}
```

Định dạng file `store/split-progress.json` (đọc được bằng mắt, dễ debug):
```json
{
  "ruleId123:v2_transferIdAbc": {
    "0": { "to": "@a", "amount": "50", "transferId": "tx-1", "completedAt": 1783000000000 },
    "1": { "to": "@b", "amount": "50", "transferId": "tx-2", "completedAt": 1783000001000 }
  }
}
```

### 4.2 Sửa `executeSplit` (trong `executor.ts`)

```ts
async function executeSplit(
  action: SplitAction,
  agent: AgentPort,
  transfer: IncomingTransfer | undefined,
  scope: string,
  ruleId: string,
  progress: SplitProgressPort,
): Promise<ExecutionOutcome> {
  const received = receivedAmountForCoin(transfer, action.coinId);

  const executionKey = transfer?.id;
  if (!executionKey) {
    log.warn(scope, 'split action has no transfer.id (balance-triggered) — per-leg checkpoint KHÔNG khả dụng cho lần chạy này, xem mục 5');
  }
  const alreadyDone = executionKey ? await progress.getCompletedLegs(ruleId, executionKey) : {};

  const results: TransferResult[] = [];
  for (let i = 0; i < action.splits.length; i++) {
    const split = action.splits[i];
    const amount = (received * BigInt(split.percent)) / 100n;
    if (amount <= 0n) continue;

    const already = alreadyDone[i];
    if (already) {
      log.info(scope, `split leg ${i} to ${split.to} đã hoàn tất trước đó (transferId=${already.transferId}) — BỎ QUA, không gửi lại`);
      continue;
    }

    const outcome = await sendOne(agent, { coinId: action.coinId, amount, to: split.to }, scope);
    if (!outcome.ok) {
      return { success: false, detail: `split leg ${i} to ${split.to} failed: ${outcome.error}`, transferResults: results };
    }
    results.push(outcome.result);

    if (executionKey) {
      // Ghi checkpoint NGAY khi leg này resolve thành công — trước khi sang leg kế tiếp.
      await progress.markLegComplete(ruleId, executionKey, i, {
        to: split.to, amount: amount.toString(), transferId: outcome.result.id, completedAt: Date.now(),
      });
    }
  }

  return { success: true, detail: `split sent to ${results.length} recipient(s)`, transferResults: results };
}
```

### 4.3 Giảm xáo trộn cho `forward`/`notify`

`executeAction` thêm tham số `progress` **optional**, mặc định một no-op stub:

```ts
const NOOP_PROGRESS: SplitProgressPort = {
  async getCompletedLegs() { return {}; },
  async markLegComplete() {},
};

export async function executeAction(
  rule: Rule, agent: AgentPort, transfer: IncomingTransfer | undefined, scope: string,
  progress: SplitProgressPort = NOOP_PROGRESS,
): Promise<ExecutionOutcome> { ... }
```

`forward`/`notify` chỉ có MỘT bước (không có khái niệm "xong một phần") nên không cần biết đến
`progress` — 6 test hiện có của chúng trong `executor.test.ts` không phải sửa.

`RuleEngine` tự nạp một `SplitProgressLog` (cùng lúc với `RuleStore`/`IdempotencyLog` ở
`RuleEngine.load()`) và truyền vào mỗi lần gọi `executeAction`.

## 5. Giới hạn phạm vi (nói rõ, không tự ý mở rộng)

Khoá theo `transfer.id` chỉ có nghĩa cho luật trigger `onIncoming`. Luật `split` trigger theo
`onBalanceAbove`/`onBalanceBelow` (đánh giá theo tick của Scheduler ở Giai đoạn 3, không có
"event id" tự nhiên) **CHƯA được bọc checkpoint** ở đề xuất này — khi gặp tổ hợp này, code sẽ
`log.warn` rõ ràng ("per-leg checkpoint KHÔNG khả dụng") thay vì âm thầm bỏ qua. Cần một khoá
kiểu khác (ví dụ theo tick id của Scheduler) khi Giai đoạn 3 xây xong Scheduler — để quyết định
lúc đó, không đoán trước bây giờ.

**Edge case đã nghĩ tới nhưng chưa xử lý (nêu để bạn biết, không tự quyết):** nếu `action.splits`
bị sửa (qua Rule Store) giữa lúc một luật đang có checkpoint dở dang và lần chạy lại, chỉ-số leg
có thể lệch nghĩa. Không giải quyết ở đề xuất này — sẽ cần cảnh báo ở Dashboard (Giai đoạn 4) khi
sửa splits của một luật đang có checkpoint chưa hoàn tất.

**Không prune checkpoint sau khi thành công** — để đơn giản, dữ liệu nhỏ (mỗi record ~100 byte),
không phải vấn đề thật ở quy mô hiện tại. Có thể thêm sau nếu cần.

## 6. Kế hoạch test

### Unit test (thêm vào `test/executor.test.ts` hoặc file mới)
1. Split 3 leg, ép leg 2 fail qua fake agent (`sendResult`/`sendError`) → xác nhận leg 1 có
   checkpoint (`progress.getCompletedLegs` trả về đúng), leg 2/3 không được gửi
   (`sendCalls.length === 1`).
2. **Gọi lại `executeSplit` lần hai** với CÙNG `ruleId` + CÙNG `transfer.id` (mô phỏng retry sau
   crash), lần này KHÔNG ép lỗi nữa → xác nhận: `sendCalls` chỉ tăng thêm 2 (cho leg 2, 3) —
   leg 1 **không bị gọi lại**; kết quả cuối `success:true`.

### Test thật trên testnet2 (bắt buộc theo yêu cầu)
1. Seed luật `split` 2 người nhận: một nametag hợp lệ (ví dụ partner), một nametag **cố tình
   không tồn tại** (ép lỗi xác định qua `INVALID_RECIPIENT` — sạch và dự đoán được hơn là ép hết
   số dư, tránh lặp lại cơn bão self-healing/retry đã thấy ở Giai đoạn 2 §4.2).
2. Trigger thật từ counterparty → xác nhận qua log: leg hợp lệ gửi thành công, leg lỗi khiến
   toàn luật trả `success:false`, `rules.json` cho thấy `fireCount` KHÔNG tăng.
3. Kiểm `check-balance.ts partner` độc lập → xác nhận balance tăng đúng 1 lần (chưa retry).
4. **Retry thủ công** (gọi lại `handleIncomingTransfer` với đúng `transfer` object đã lưu, mô
   phỏng redelivery sau crash) → sửa nametag lỗi thành hợp lệ, chạy lại.
5. Kiểm `check-balance.ts partner` LẦN NỮA → xác nhận balance của leg ĐÃ THÀNH CÔNG trước đó
   **không tăng thêm lần hai** (không bị double-pay), chỉ leg từng lỗi mới có số dư mới xuất
   hiện lần đầu.

### Cập nhật unit test hiện có
Không có test nào trong `executor.test.ts`/`guards.test.ts`/`engine.test.ts` cần sửa lại do
tham số `progress` là optional với default no-op — chỉ THÊM test mới cho checkpoint.

---

➤ Chờ duyệt phương án này trước khi code.
