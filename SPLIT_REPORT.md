# Split Chống Double-Pay — Báo Cáo Hiện Thực + Test Thật

Hiện thực đúng theo [SPLIT_DESIGN_V2.md](SPLIT_DESIGN_V2.md) (đã duyệt). Toàn bộ chạy thật
trên **Unicity Testnet v2**. Trong lúc test còn phát hiện một **sự cố vận hành nghiêm trọng**
(tiến trình cũ từ Giai đoạn 1/2 bị rò rỉ, không chết dù đã `TaskStop`) — ghi lại đầy đủ ở mục 5
vì đây là bài học quan trọng cho Giai đoạn 3 (always-on).

---

## 1. Đã hiện thực đúng thiết kế đã duyệt

- `src/rules/types.ts`: `SplitLegRecord` (status `'sending'|'sent'`), `SplitProgressPort`
  (`getLeg` đồng bộ, `markLegSending`/`markLegSent`/`clearLeg` bất đồng bộ).
- `src/rules/split-progress.ts`: `SplitProgressLog` — ghi đè toàn file mỗi mutate, path inject
  được cho test, có ghi chú rõ giả định "một tiến trình" (không khoá, không cần cho pipeline
  tuần tự hiện tại).
- `src/rules/executor.ts`: `executeSplit` ba nhánh (không record/`'sent'`/`'sending'`) đúng thiết
  kế; `executeAction` nhận `progress` optional (no-op mặc định) — `forward`/`notify` không đổi.
- `src/rules/engine.ts`: `RuleEngine` nạp `SplitProgressLog` (tham số bắt buộc, KHÔNG có default
  trỏ path thật — cố tình, tránh test quên override rồi ghi nhầm vào file thật của dự án); log
  riêng biệt khi `needsManualReview`.

## 2. Lỗi tự bắt được TRƯỚC KHI chạy thật (nhờ viết test trước)

Khi viết ca test "leg 2 fail rồi retry", phát hiện: code ban đầu ghi `'sending'` cho MỌI leg
trước khi gửi — kể cả khi `send()` sau đó trả về THẤT BẠI SẠCH (không phải crash, có kết quả rõ
ràng). Điều này khiến một lỗi bình thường (ví dụ hết số dư) bị nhầm thành trạng thái "kẹt không
rõ" ở lần chạy lại, chặn nhầm một leg lẽ ra retry được bình thường.

**Đã sửa:** thêm `SplitProgressPort.clearLeg()` — khi `send()` trả lời DỨT KHOÁT là thất bại
(resolve `status:'failed'` hoặc ném lỗi), xoá checkpoint `'sending'` ngay (coi như "chưa từng
thử"), CHỈ giữ `'sending'` khi `send()` không bao giờ trả lời (crash thật giữa chừng). Bug này
không lọt ra ngoài vì được unit test bắt trước khi chạy thật — đúng tinh thần viết test trước.

## 3. Kết quả unit test — 21/21 pass

17 test cũ (Giai đoạn 2) + 4 test mới cho checkpoint (`test/split-checkpoint.test.ts`):

```
✔ split checkpoint: no record for any leg -> sends every leg and checkpoints each as sent
✔ split checkpoint: a leg already marked sent is skipped on retry, never resent
✔ split checkpoint: a leg stuck at sending stops the rule immediately without guessing,
  and never touches later legs
✔ split checkpoint: retry after a genuine (non-crash) send failure resumes without
  resending the already-sent leg
tests 21, pass 21, fail 0
```

Ca "stuck at sending" xác nhận đúng yêu cầu bổ sung của bạn: leg kẹt dừng ngay, các leg SAU
KHÔNG được chạm tới (không gửi, không checkpoint) — chứng minh vòng lặp dừng tại đúng leg mơ hồ,
không chạy tiếp.

## 4. Test thật trên testnet2

### 4.1 Chuẩn bị

Tắt 2 luật Giai đoạn 2 (`set-rule-enabled.ts ... false`) để cô lập test; seed luật mới qua preset
`split-with-invalid-leg` (`add-rule.ts`): 2 người nhận, mỗi người 40% — một là ví `partner` thật,
một là nametag **không tồn tại** (`@nonexistent-test-leg`, hợp lệ về định dạng nhưng chắc chắn
chưa đăng ký) để ép lỗi `INVALID_RECIPIENT` sạch, thay vì ép hết số dư (tránh lặp lại cơn bão
self-healing đã thấy ở Giai đoạn 2).

### 4.2 Lần trigger đầu — leg hợp lệ thành công, leg lỗi thất bại sạch

Gửi 1 UCT thật từ counterparty. Log agent (rút gọn):
```
rule-engine: 1 onIncoming rule(s) matched
[Payments] ... self-healing coin selection (#625, attempt 1/8) ...   ← lại gặp cơ chế tự chữa lành như Giai đoạn 2
send to @cpa-partner-fe45dc: status=completed amount=400000000000000000   ← leg 0: 0.4 UCT (đúng 40%)
send to @nonexistent-test-leg threw SphereError code=INVALID_RECIPIENT: Cannot resolve
  transport pubkey for "@nonexistent-test-leg". No binding event found.
rule 098a066a... action failed, NOT marking as fired: split leg 1 to @nonexistent-test-leg
  failed after 1 prior send(s): INVALID_RECIPIENT...
```
`store/split-progress.json` xác nhận: leg 0 `status:"sent"`, `transferId` thật
(`b2056e56-ce98-4ed2-8a8b-27f9acdd3a03`); leg 1 KHÔNG có record (đã `clearLeg` — đúng mục 2).
`store/rules.json`: luật split `fireCount: 0` — đúng fail-safe.

### 4.3 Sự cố phát hiện giữa chừng — tiến trình rò rỉ (xem mục 5 để biết chi tiết đầy đủ)

Đối soát balance ban đầu cho kết quả LỆCH khó hiểu — điều tra dẫn tới phát hiện `TaskStop`
KHÔNG giết hết cây tiến trình Windows của các agent Giai đoạn 1/2 trước đó, khiến chúng vẫn sống
và tự ý bắn luật `forward-normal` cũ (đã tưởng là tắt) trên CHÍNH sự kiện trigger của test này,
đồng thời ghi đè hỏng `store/rules.json` (xoá mất luật split!). Đã chẩn đoán, dọn tiến trình, và
sửa lại `rules.json` đúng — xem mục 5. **Không phát hiện lỗi gì trong logic split/checkpoint** —
`store/split-progress.json` hoàn toàn không bị ảnh hưởng (tiến trình cũ chạy code CŨ, không biết
gì về file này).

### 4.4 Mô phỏng leg kẹt `'sending'` (không cần crash thật)

Sau khi hạ tầng đã sạch: sửa tay `split-progress.json` — leg 0 (đã "sent" thật ở 4.2) đổi ngược
thành `'sending'` (xoá `transferId`/`completedAt`); xoá entry event trong `idempotency.json`
(mô phỏng "crash trước khi kịp đánh dấu đã xử lý"). Dùng script mới `replay-transfer.ts` (đưa
thẳng transfer y hệt vào `RuleEngine.handleIncomingTransfer`, không qua SDK thật — chỉ để test
đường phục hồi sau crash) để "phát lại" đúng sự kiện đó.

**Kết quả — đúng thiết kế:**
```
rule-engine: 1 onIncoming rule(s) matched
MANUAL REVIEW NEEDED: split leg 0 to @cpa-partner-fe45dc (amount 400000000000000000) is stuck
  at 'sending' since 2026-07-02T15:10:08.348Z — outcome UNKNOWN (no transferId was ever
  recorded, since send() never resolved). Check the agent's and @cpa-partner-fe45dc's balance...
```
**KHÔNG có lệnh gửi nào được gọi** (không log `send to...` nào cả — leg 0 không bị gửi lại, leg 1
không bao giờ được chạm tới). Kiểm `check-balance.ts partner` độc lập: **0.9 UCT — không đổi**
so với trước khi mô phỏng. Không double-pay.

### 4.5 Sửa checkpoint đúng lại, phát lại lần cuối — xác nhận skip đúng

Sửa tay leg 0 trở lại `'sent'` với `transferId` thật đã có; xoá lại entry idempotency; phát lại.
```
split leg 0 to @cpa-partner-fe45dc already sent previously (transferId=b2056e56-...) — SKIPPING
send to @nonexistent-test-leg threw SphereError code=INVALID_RECIPIENT: ...
rule 098a066a... action failed ...: split leg 1 ... failed after 0 prior send(s): INVALID_RECIPIENT...
```
Leg 0 bị BỎ QUA đúng (không gửi lại — "0 prior send(s)" ở lần chạy NÀY vì leg 0 không được thử
trong lượt này). Leg 1 thử lại và thất bại y hệt (nametag vẫn chưa đăng ký — hợp lý). Kiểm
`check-balance.ts partner` LẦN CUỐI: vẫn **0.9 UCT** — xuyên suốt toàn bộ chuỗi test, partner
chỉ nhận đúng MỘT lần 0.4 UCT cho leg 0, dù bị "thử lại" tổng cộng 3 lần (bình thường, kẹt-mô
phỏng, sửa-rồi-thử-lại).

## 5. Sự cố vận hành: tiến trình rò rỉ — phát hiện quan trọng cho Giai đoạn 3

### Triệu chứng ban đầu

Sau lần trigger 4.2, `store/rules.json` bỗng cho thấy 2 luật Giai đoạn 2 đã tắt lại **BẬT LẠI**
(`enabled:true`), luật `forward-normal` **fireCount tăng từ 2 lên 3** (bắn thêm một lần dù đã
disable!), và luật split **BIẾN MẤT KHỎI FILE HOÀN TOÀN**.

### Chẩn đoán

`ps -W` cho thấy nhiều tiến trình `node.exe` cũ. Dùng
`Get-CimInstance Win32_Process | Select CommandLine` (chính xác hơn `ps`) xác nhận: **BA tiến
trình `run-agent-wallet.ts`/`run-agent.ts` từ Giai đoạn 1 và Giai đoạn 2 (đã gọi `TaskStop` và
nhận "Successfully stopped") vẫn ĐANG SỐNG THẬT** — `TaskStop` chỉ dừng được tiến trình bọc
ngoài mà harness theo dõi, KHÔNG giết hết cây tiến trình con Windows thật sự (`npx` →
`tsx/cli.mjs` → tiến trình `node` cuối cùng chạy code — 3 tầng, mỗi tầng một PID Windows riêng).

Khi tiến trình MỚI (test split, đã tắt đúng 2 luật cũ) gửi trigger, CẢ BA tiến trình cũ (đang
sống, vẫn giữ bản sao luật CŨ trong bộ nhớ với `forward-normal` còn BẬT) **cùng nhận được sự
kiện `transfer:incoming` y hệt** (cùng một địa chỉ ví) và tự ý bắn luật của CHÚNG — gửi thêm tiền
thật (một phần trong 0.7 UCT dư ra đối soát được ở mục 4.3), đồng thời tiến trình nào ghi
`rules.json` SAU CÙNG sẽ **ghi đè bằng bản trong bộ nhớ của NÓ** — bản đó KHÔNG có luật split
(được tạo SAU khi tiến trình cũ đã khởi động), nên ghi đè xoá mất luật split khỏi file.

### Khắc phục

1. Xác nhận PID Windows thật của 3 tiến trình rò rỉ qua `CommandLine`, `Stop-Process -Force`
   trực tiếp (không qua `TaskStop`) — xác nhận lại bằng cách liệt kê `node.exe` lần nữa.
2. Restore `store/rules.json`: đưa luật split trở lại (từ bản JSON đã lưu lúc tạo), đặt 2 luật cũ
   về `enabled:false` đúng ý định ban đầu. `fireCount:3` của forward-normal GIỮ NGUYÊN — tiền
   thật đã đi thật do sự cố này, sửa số xuống để "cho đẹp" sẽ là viết sai lịch sử; ghi nhận thẳng
   ở đây thay vì giấu.
3. Phát hiện tiến trình agent test hiện tại (`bclzkb7mm`) SAU NÀY khi tôi `TaskStop` nó cũng gặp
   ĐÚNG vấn đề — xác nhận đây là lỗi HỆ THỐNG trên máy này (không phải ngẫu nhiên một lần), không
   phải lỗi logic của agent. Từ đó về sau trong phiên này, **mọi lần dừng agent đều xác minh lại
   bằng `Get-CimInstance Win32_Process` trước khi tin `TaskStop` đã xong**, và `Stop-Process
   -Force` thủ công nếu còn sống.
4. Phát hiện phụ trong lúc điều tra: `check-balance.ts` KHÔNG gọi `receive()` trước khi đọc
   balance — với các lần gửi phức tạp (bị self-healing retry), tiền có thể chưa được "khám phá"
   vào ví dù `send()` đã trả `status:'completed'`. Đã sửa: thêm `await sphere.payments.receive()`
   trước `getBalance()` (đúng khuyến nghị PHASE0_VERIFIED_API.md §5 "receive() cho CLI/batch
   app"). Sau khi sửa, `receive()` khám phá ra **4 giao dịch dồn lại** (0.7 UCT — gồm leg 0 của
   test này + các lần bắn lạc của tiến trình rò rỉ).

### Bài học cho Giai đoạn 3 (GHI NHỚ — ảnh hưởng thiết kế always-on)

- **`TaskStop`/dừng tiến trình qua harness KHÔNG đáng tin trên máy Windows này** để đảm bảo một
  ví chỉ có một tiến trình sống. Giai đoạn 3 cần một cách CHẮC CHẮN hơn để biết agent cũ đã chết
  hẳn trước khi khởi động agent mới (ví dụ: file lock/pid-file mà agent tự ghi khi khởi động và
  xoá khi thoát sạch, kiểm tra tồn tại trước khi start — không dựa vào "đã gọi lệnh dừng").
- Đây KHÔNG PHẢI lỗi lý thuyết — nó **thực sự làm hỏng dữ liệu thật** (`rules.json` bị ghi đè,
  luật bị xoá) và **thực sự khiến agent gửi tiền thật ngoài ý muốn** (fireCount 2→3) trong CHÍNH
  buổi test này. Nguyên tắc "một ví một tiến trình" (đã nêu từ Phase 0 §3.3) không phải lý
  thuyết suông — cần enforcement thật ở Giai đoạn 3, không chỉ ghi chú.
- `store/split-progress.json` sống sót nguyên vẹn qua sự cố vì tiến trình cũ chạy CODE CŨ, không
  biết tới file này — một minh chứng ngẫu nhiên rằng namespacing state theo tính năng (thay vì
  gộp chung) giảm được một phần rủi ro khi có phiên bản code lệch nhau chạy song song, dù đây
  không phải giải pháp cho vấn đề gốc (nhiều tiến trình cùng sống).

## 6. Script mới trong quá trình này

- `scripts/set-rule-enabled.ts <ruleId> <true|false>` — bật/tắt một luật (tiện ích nhỏ, cũng sẽ
  cần cho Dashboard Giai đoạn 4).
- `scripts/replay-transfer.ts <transferId> <senderPubkey> <coinId> <amount> [memo]` — đưa thẳng
  một `IncomingTransfer` tổng hợp vào `RuleEngine`, bỏ qua SDK thật. CHỈ dùng để test đường phục
  hồi sau crash — không dùng cho vận hành thật.
- `add-rule.ts` thêm preset `split-with-invalid-leg`.
- `check-balance.ts` thêm `receive()` trước khi đọc balance.

## 7. TODO / giữ nguyên từ thiết kế

- `split` trigger theo `onBalanceAbove/Below` vẫn CHƯA có checkpoint (không có `transfer.id` tự
  nhiên) — như đã thống nhất, để Giai đoạn 3 quyết khi có khái niệm "tick" của Scheduler.
- Sửa `action.splits` giữa lúc có checkpoint dở dang — vẫn chưa xử lý, để Dashboard cảnh báo sau.
- Gỡ leg kẹt vẫn là sửa tay JSON — chưa xây `scripts/resolve-stuck-leg.ts` (đúng như đã thống
  nhất, chỉ làm nếu việc sửa tay gây bất tiện thật; buổi test này cho thấy sửa tay vẫn khả thi
  cho quy mô hiện tại).
- **Mới phát sinh:** cần cơ chế pid-file/lock để Giai đoạn 3 tự phát hiện + từ chối khởi động nếu
  một tiến trình khác (có thể đã "tưởng chết") vẫn đang giữ cùng ví — xem mục 5.

---

➤ Chờ duyệt trước khi sang Giai đoạn 3 (always-on).
