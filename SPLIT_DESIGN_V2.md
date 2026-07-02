# Split chống double-pay — Thiết kế V2 (checkpoint hai pha)

Trạng thái: **ĐỀ XUẤT — chưa code.** Sửa từ [PHASE2_SPLIT_ATOMICITY_PROPOSAL.md](PHASE2_SPLIT_ATOMICITY_PROPOSAL.md)
sau khi phát hiện khe hở giữa "gửi" và "ghi checkpoint" ở bản V1. Chờ duyệt trước khi hiện thực.

---

## 1. Khe hở của thiết kế V1 (vì sao phải sửa)

V1 ghi checkpoint **sau khi** `send()` resolve:
```
const outcome = await sendOne(...)      // (1) tiền RỜI ví — không hoàn tác được
await progress.markLegComplete(...)     // (2) ghi checkpoint
```
Nếu tiến trình chết đúng giữa (1) và (2): tiền đã đi thật, nhưng checkpoint chưa kịp ghi. Retry
sau đó sẽ không thấy checkpoint cho leg này → gửi lại → double-pay. V1 thu hẹp cửa sổ rủi ro so
với không có checkpoint gì, nhưng không đóng hẳn — và nó nằm đúng chỗ chết người (giữa "tiền đã
đi" và "đã ghi nhận").

## 2. Nguyên lý sửa: hai pha, ba trạng thái quan sát được

Không thể làm "gửi tiền qua mạng" và "ghi file local" thành MỘT thao tác nguyên tử — đây là giới
hạn vật lý, không phải lỗi thiết kế. Thay vào đó, thu hẹp vùng không biết xuống mức nhỏ nhất có
thể, và với phần không thể thu hẹp thêm được nữa (leg đang "gửi dở" khi crash), THỪA NHẬN rõ ràng
là không biết, thay vì đoán.

Mỗi leg giờ có đúng BA trạng thái quan sát được qua checkpoint:

| Trạng thái | Ý nghĩa | Hành động khi retry |
|---|---|---|
| Không có record | Chưa từng bắt đầu gửi | Gửi bình thường |
| `'sending'` | Đã bắt đầu gửi, KHÔNG rõ kết quả (crash giữa chừng) | **DỪNG luật này lại, không đoán** — cần người kiểm tra thủ công |
| `'sent'` | Đã gửi xong, có `transferId` xác nhận | BỎ QUA — không gửi lại |

**Vì sao dừng thay vì đoán ở trạng thái `'sending'`:** đây là trường hợp KHÔNG THỂ biết chắc nếu
không tra ngược nguồn sự thật (chain/explorer) — gửi lại có thể double-pay, bỏ qua có thể thiếu
chi. Cả hai hướng đoán đều có thể sai với hậu quả tiền thật. Dừng và biến nó thành trạng thái
nhìn thấy được (log rõ + trả outcome đặc biệt) là lựa chọn an toàn duy nhất, nhất quán với
nguyên tắc "không chắc → dừng và hỏi" của toàn dự án.

**Ghi chú về ranh giới đảm bảo:** ghi `'sending'` PHẢI hoàn tất (await xong việc ghi file) TRƯỚC
khi gọi `send()`. Nhờ thứ tự này, nếu tiến trình chết:
- Chết TRƯỚC khi ghi `'sending'` xong → file chưa có gì cho leg này → coi như "chưa từng bắt đầu"
  → an toàn (vì `send()` cũng chưa kịp gọi, thứ tự là ghi-trước-gửi-sau).
- Chết SAU khi `send()` resolve + ghi `'sent'` xong → an toàn, có `transferId` xác nhận.
- Chết ở khoảng giữa (đã ghi `'sending'`, đã gọi `send()`, chưa biết kết quả) → ĐÂY là vùng không
  thể thu hẹp thêm — xử lý bằng cách dừng, không đoán (bảng trên).

Đây là giới hạn cố hữu của việc phối hợp một thao tác mạng (gửi) với một thao tác ghi local
(checkpoint) mà không có cơ chế 2-phase-commit thật với backend — SDK cũng không lộ ra một
idempotency-key cho `send()` để ta có thể "hỏi lại xem lệnh này đã chạy chưa" một cách an toàn.
Chấp nhận giới hạn này thay vì giả vờ nó không tồn tại.

**Phạm vi đảm bảo:** thiết kế này chống được tiến trình Node bị crash/kill/restart (kịch bản
thật của always-on). KHÔNG nhắm tới mất điện phần cứng đúng lúc `fs.writeFile` đang ghi (ranh
giới durability của hệ điều hành, ngoài phạm vi một dự án chạy trên testnet).

## 3. Thay đổi kiểu dữ liệu

`src/rules/types.ts` — `SplitLegRecord`:
```ts
interface SplitLegRecord {
  readonly status: 'sending' | 'sent';
  readonly to: string;
  readonly amount: string;
  readonly transferId?: string;   // chỉ có khi status='sent'
  readonly startedAt: number;
  readonly completedAt?: number;  // chỉ có khi status='sent'
}

interface SplitProgressPort {
  /** Đồng bộ — đọc dữ liệu đã nạp trong bộ nhớ, cùng khuôn với RuleStore.get()/IdempotencyLog.isProcessed(). */
  getLeg(ruleId: string, executionKey: string, legIndex: number): SplitLegRecord | undefined;
  /** PHẢI resolve xong trước khi gọi send() cho leg đó. */
  markLegSending(ruleId: string, executionKey: string, legIndex: number, info: { to: string; amount: string }): Promise<void>;
  markLegSent(ruleId: string, executionKey: string, legIndex: number, transferId: string): Promise<void>;
}
```

`ExecutionOutcome` (executor.ts) — thêm một cờ:
```ts
interface ExecutionOutcome {
  readonly success: boolean;
  readonly detail: string;
  readonly transferResults?: readonly TransferResult[];
  readonly needsManualReview?: boolean;   // true = có leg kẹt ở 'sending' — KHÔNG tự retry
}
```

## 4. `src/rules/split-progress.ts` (mới)

Cùng khuôn `RuleStore`/`IdempotencyLog` — path inject được cho test, ghi đè toàn file mỗi lần
mutate (đơn giản, nhất quán với các store khác đã có, đủ dùng ở quy mô hiện tại):

```ts
type SplitProgressData = Record<string, Record<number, SplitLegRecord>>;  // khoá "ruleId:executionKey"

class SplitProgressLog implements SplitProgressPort {
  static async load(path = 'store/split-progress.json'): Promise<SplitProgressLog>;

  getLeg(ruleId: string, executionKey: string, legIndex: number): SplitLegRecord | undefined {
    return this.data[`${ruleId}:${executionKey}`]?.[legIndex];
  }

  async markLegSending(ruleId, executionKey, legIndex, info): Promise<void> {
    const key = `${ruleId}:${executionKey}`;
    this.data[key] = { ...this.data[key], [legIndex]: { status: 'sending', to: info.to, amount: info.amount, startedAt: Date.now() } };
    await writeJson(this.path, this.data);   // await xong TRƯỚC khi hàm gọi return
  }

  async markLegSent(ruleId, executionKey, legIndex, transferId): Promise<void> {
    const key = `${ruleId}:${executionKey}`;
    const existing = this.data[key]?.[legIndex];
    this.data[key] = { ...this.data[key], [legIndex]: { ...existing, status: 'sent', transferId, completedAt: Date.now() } };
    await writeJson(this.path, this.data);
  }
}
```

Định dạng file ví dụ (leg 0 kẹt, leg 1 xong):
```json
{
  "rule123:v2_abc": {
    "0": { "status": "sending", "to": "@x", "amount": "50", "startedAt": 1783000000000 },
    "1": { "status": "sent", "to": "@y", "amount": "50", "transferId": "tx-2", "startedAt": 1783000000500, "completedAt": 1783000001200 }
  }
}
```

## 5. `executeSplit` — logic ba nhánh

```ts
async function executeSplit(action, agent, transfer, scope, ruleId, progress): Promise<ExecutionOutcome> {
  const received = receivedAmountForCoin(transfer, action.coinId);
  const executionKey = transfer?.id;
  if (!executionKey) {
    log.warn(scope, 'split action không có transfer.id (trigger theo balance) — checkpoint từng leg KHÔNG khả dụng, xem giới hạn phạm vi mục 7');
  }

  const results: TransferResult[] = [];
  for (let i = 0; i < action.splits.length; i++) {
    const split = action.splits[i];
    const amount = (received * BigInt(split.percent)) / 100n;
    if (amount <= 0n) continue;

    const existing = executionKey ? progress.getLeg(ruleId, executionKey, i) : undefined;

    if (existing?.status === 'sent') {
      log.info(scope, `split leg ${i} to ${split.to} đã gửi xong trước đó (transferId=${existing.transferId}) — BỎ QUA`);
      continue;
    }

    if (existing?.status === 'sending') {
      // Kẹt giữa hai pha do crash trước đó — KHÔNG có transferId để tra, vì send() chưa từng
      // resolve. Không đoán theo hướng nào — dừng luật này, cần người kiểm tra thủ công.
      const detail = `split leg ${i} to ${split.to} (amount ${existing.amount}) đang ở trạng thái 'sending' từ ${new Date(existing.startedAt).toISOString()} — KHÔNG RÕ đã gửi thành công hay chưa (không có transferId để tra). Kiểm tra thủ công số dư ví agent/${split.to} hoặc Network Explorer trước khi xử lý tiếp.`;
      log.error(scope, `⚠️ MANUAL REVIEW: ${detail}`);
      return { success: false, needsManualReview: true, detail, transferResults: results };
    }

    // existing === undefined -> chưa từng thử leg này
    if (executionKey) {
      await progress.markLegSending(ruleId, executionKey, i, { to: split.to, amount: amount.toString() });
    }

    const outcome = await sendOne(agent, { coinId: action.coinId, amount, to: split.to }, scope);
    if (!outcome.ok) {
      return { success: false, detail: `split leg ${i} to ${split.to} failed: ${outcome.error}`, transferResults: results };
    }
    results.push(outcome.result);

    if (executionKey) {
      await progress.markLegSent(ruleId, executionKey, i, outcome.result.id);
    }
  }

  return { success: true, detail: `split sent to ${results.length} recipient(s)`, transferResults: results };
}
```

`executeAction` vẫn nhận `progress` là tham số **optional** với no-op stub mặc định (giữ nguyên
từ V1) — `forward`/`notify` và 6 test hiện có không phải sửa.

## 6. `RuleEngine` — xử lý `needsManualReview`

```ts
const outcome = await executeAction(rule, this.agent, transfer, SCOPE, this.splitProgress);
if (outcome.success) {
  await this.recordFire(rule);
  log.info(SCOPE, `rule ${rule.id} fired: ${outcome.detail}`);
} else if (outcome.needsManualReview) {
  log.error(SCOPE, `⚠️ rule ${rule.id} CẦN NGƯỜI KIỂM TRA trước khi xử lý tiếp: ${outcome.detail}`);
} else {
  log.error(SCOPE, `rule ${rule.id} action failed, NOT marking as fired: ${outcome.detail}`);
}
```

Cả hai nhánh lỗi (fail thường / needsManualReview) đều giống nhau ở chỗ: `rule.state` KHÔNG
cập nhật, và event vẫn được `idempotency.markProcessed()` như bình thường ở cuối
`handleIncomingTransfer` — event NÀY đã được đánh giá đầy đủ (kết luận là "cần người xem", một
kết luận hợp lệ, không phải "chưa xử lý"). Sự mơ hồ nằm ở file `split-progress.json`, không nằm
ở việc event đã được xử lý hay chưa.

**Cố tình KHÔNG làm:** không tự động tắt (`disable`) luật khi gặp `needsManualReview`. Lý do:
yêu cầu là "dừng xử lý luật đó [cho sự kiện này]", không phải "vô hiệu hoá luật vĩnh viễn" — tự
tắt luật là một hành động tự quyết vượt quá "quan sát và từ chối đoán". Một record `'sending'`
kẹt chỉ chặn retry của ĐÚNG `transfer.id` đó (vì khoá theo executionKey) — một sự kiện MỚI khớp
cùng luật vẫn xử lý bình thường, không bị ảnh hưởng.

**Cách người dùng gỡ một leg kẹt (thủ công, chưa xây tool riêng):** sau khi tự kiểm tra thật
(balance hai đầu / Network Explorer) và biết chắc kết quả, sửa tay `store/split-progress.json`:
- Nếu XÁC NHẬN đã gửi thật → sửa `status` thành `'sent'`, điền `transferId` tìm được +
  `completedAt`.
- Nếu XÁC NHẬN chưa gửi → xoá hẳn record của leg đó (coi như chưa từng bắt đầu).
Chưa đề xuất xây script hỗ trợ việc này (ví dụ `scripts/resolve-stuck-leg.ts`) vì nằm ngoài yêu
cầu hiện tại (chặn double-pay) — có thể làm sau nếu việc sửa tay JSON gây bất tiện thật.

## 7. Giữ nguyên từ V1 (không đổi)

- Giới hạn phạm vi: `split` trigger theo `onBalanceAbove`/`onBalanceBelow` chưa có `transfer.id`
  tự nhiên → checkpoint chưa khả dụng cho tổ hợp đó, `log.warn` rõ ràng khi gặp — để quyết định
  khoá kiểu khác khi Giai đoạn 3 xây Scheduler.
- Không prune checkpoint sau khi thành công (dữ liệu nhỏ, chưa cần).
- Edge case "sửa `action.splits` giữa lúc có checkpoint dở dang" — chưa xử lý, để Dashboard
  (Giai đoạn 4) cảnh báo sau.
- Tài liệu bài học `transfer:failed` không phải nguồn fail-safe — đã cập nhật vào
  `PHASE0_VERIFIED_API.md` §7 và `CLAUDE.md` 4.4 #3 ở lượt trước, không đổi gì thêm.

## 8. Kế hoạch test (cập nhật so với V1 — thêm ca `'sending'` kẹt)

### Unit test (`test/executor.test.ts` hoặc file mới, dùng `SplitProgressLog` với path tạm qua `mkdtemp` như `engine.test.ts` đã làm)
1. **Không có record → gửi bình thường** (hồi quy, đảm bảo case cơ bản không vỡ).
2. **`'sent'` → bỏ qua:** ghi tay một leg `'sent'`, gọi `executeSplit` → xác nhận leg đó KHÔNG
   được gửi lại (`sendCalls` không tăng cho leg đó), các leg khác vẫn xử lý bình thường.
3. **`'sending'` kẹt → dừng, không đoán (ca quan trọng nhất):** ghi tay một leg `'sending'` (mô
   phỏng crash giữa hai pha), gọi `executeSplit` → xác nhận: (a) leg đó KHÔNG được gửi
   (`sendCalls` không tăng), (b) các leg SAU leg kẹt cũng KHÔNG được chạm tới (dừng ngay tại leg
   mơ hồ, không tiếp tục), (c) outcome trả về `needsManualReview: true`.
4. Ca gốc từ V1 vẫn giữ: leg 2 fail giữa chừng → checkpoint leg 1 (`'sent'`) còn nguyên; gọi lại
   lần hai (không ép lỗi nữa) → leg 1 không gửi lại, leg 2/3 gửi và thành công.

### Test thật testnet2 (bắt buộc)
1. Seed luật `split` 2 người nhận: một nametag hợp lệ (partner), một nametag không tồn tại (ép
   `INVALID_RECIPIENT`, giữ nguyên cách tiếp cận sạch từ V1).
2. Trigger thật → xác nhận leg hợp lệ gửi thành công (`check-balance` độc lập), leg lỗi khiến
   luật "chưa chạy" (`rules.json` fireCount không tăng).
3. **Mô phỏng leg kẹt `'sending'`** (không cần crash thật): sau bước 2, sửa tay
   `store/split-progress.json`, đổi leg ĐÃ THÀNH CÔNG ở bước 2 từ `'sent'` ngược lại thành
   `'sending'` (giả lập như nó chưa kịp ghi `'sent'` khi crash) → chạy lại luật cho cùng
   `transfer.id` → xác nhận: agent DỪNG luật, log "⚠️ MANUAL REVIEW", KHÔNG gửi lại leg đó, và
   `check-balance` xác nhận balance KHÔNG đổi thêm (không double-pay, không gửi thêm).
4. Sửa tay leg đó trở lại `'sent'` với transferId thật đã có → chạy lại lần nữa → xác nhận giờ
   nó xử lý tiếp bình thường (bỏ qua leg đã sent, xử lý leg lỗi còn lại nếu đã sửa nametag, hoặc
   vẫn dừng đúng ở leg lỗi như bước 2 nếu chưa sửa).

---

➤ Chờ duyệt thiết kế hai pha này trước khi code.
