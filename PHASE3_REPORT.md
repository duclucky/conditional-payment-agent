# Giai đoạn 3 — Vòng lặp agent Always-On

Hiện thực đúng [PHASE3_PROCESS_DESIGN.md](PHASE3_PROCESS_DESIGN.md) (đã duyệt) + phần còn lại
của Giai đoạn 3 (Scheduler, restart reconciliation, graceful shutdown). Toàn bộ chạy thật trên
**Unicity Testnet v2**. 30/30 unit test pass. Bốn kết quả test thật mới: force-kill + tự phục
hồi lock mồ côi; refuse-to-start khi ví còn sống; luật `notify` thật; luật `onBalanceAbove` thật
qua Scheduler tick.

---

## 1. Đã hiện thực đúng thiết kế đã duyệt (Tầng 1 + Tầng 2)

- **`src/wallet/process-lock.ts`** (mới) — `acquireProcessLock(lockPath, scope)`: tự hỏi OS
  (`process.kill(pid, 0)`) chứ không tin harness; PID mồ côi → tự dọn + log rõ; PID còn sống →
  ném lỗi với hướng dẫn xoá tay; không có cờ `--force` (đúng quyết định đã duyệt).
- **`src/wallet/init.ts`** — chiếm khoá NGAY ĐẦU `initWallet()`, trước mọi kết nối mạng;
  `WalletHandle` có thêm `release()`.
- **`src/rules/idempotency.ts`** (viết lại) — `tryClaim()` nguyên tử qua `fs` flag `'wx'`
  (`O_CREAT|O_EXCL`), một file/sự kiện thay vì một JSON object chung. Không còn `markProcessed()`
  riêng — `tryClaim()` CHÍNH LÀ mark, không còn khoảng hở giữa check và act.
- **`src/rules/engine.ts`** — thêm `runExclusive()` (hàng đợi promise nội bộ); tách
  `handleIncomingTransfer` (sự kiện tiền vào) và `runBalanceTick()` (Scheduler) thành hai lối
  vào CÔNG KHAI riêng nhưng đi qua CÙNG một hàng đợi.

## 2. Phần còn lại Giai đoạn 3

- **`src/rules/scheduler.ts`** (mới) — `Scheduler` chạy `setInterval` tick cố định (mặc định
  30s, ghi đè qua `SCHEDULER_TICK_MS`), mỗi tick gọi `engine.runBalanceTick()`. Có luật
  `onSchedule` (cron) đang bật → log cảnh báo một lần rõ ràng ("chưa hiện thực, sẽ không bao giờ
  chạy") thay vì im lặng bỏ qua — cron thật là phạm vi RIÊNG, không làm trong đợt này (CLAUDE.md
  tự gọi `onSchedule` là "loại yếu — không nên đứng một mình").
- **`scripts/run-agent.ts`** — nối `Scheduler` + xử lý `SIGINT`/`SIGTERM` (dừng scheduler, gọi
  `wallet.release()`, thoát sạch).
- **Đối soát khi khởi động lại** — không cần code thêm: `RuleStore.load()` /
  `SplitProgressLog.load()` đã đọc lại từ file mỗi lần khởi động; `IdempotencyLog` giờ không cần
  "nạp" gì (mỗi claim là một file riêng, tra theo yêu cầu). Đã XÁC NHẬN bằng chính test phục hồi
  lock mồ côi ở mục 3.1 — tiến trình mới nạp lại đúng cả 5 luật với đúng trạng thái
  enabled/fireCount từ tiến trình cũ.

## 3. Test thật trên testnet2

### 3.1 Vòng đời tiến trình (Tầng 1) — bốn kịch bản, đủ cả

**(a) Khởi động sạch:** ví chưa ai giữ → chiếm khoá ngay, log `process lock acquired: PID X`.

**(b) Force-kill rồi phục hồi (bắt buộc theo yêu cầu):**
```
[bước 1] chạy run-agent.ts → process lock acquired: PID 1192
[bước 2] Stop-Process -Force cho CẢ BA PID trong cây tiến trình (npx/tsx-cli/node thật)
[bước 3] xác nhận qua Get-CimInstance: cả ba PID đã chết thật
[bước 4] cat data/agent/agent.lock → VẪN CÒN, vẫn ghi PID 1192 (chết) — đúng dự đoán,
         'exit' handler không chạy được khi bị force-kill
[bước 5] chạy run-agent.ts lần nữa →
  "found orphaned lock from dead PID 1192 (started ...) — cleaning up"
  "process lock acquired: PID 2752, instance 90b07f61"
  ... khởi động thành công, nạp đúng 3 luật, chạy bình thường
[bước 6] cat data/agent/agent.lock → PID 2752 (đúng, không phải 1192)
```
Đây là đường phục hồi thực tế nhất (force-kill là thao tác THƯỜNG XUYÊN trên máy này, như chính
sự cố ở SPLIT_REPORT.md §5 đã cho thấy) — đã chứng minh chạy đúng.

**(c) Từ chối khi ví còn sống thật (trong lúc PID 2752 ở bước trên vẫn đang chạy):**
```
$ npx tsx scripts/run-agent.ts
fatal: Error: Another process (PID 2752, started 2026-07-02T15:57:46.964Z, instance 90b07f61)
is already holding the wallet lock at data\agent\agent.lock.
Refusing to start — running two processes against the same wallet WILL corrupt state
(see SPLIT_REPORT.md §5).
If you have verified PID 2752 is NOT actually related to this wallet (e.g. a reused PID),
delete data\agent\agent.lock manually and retry.
```
Từ chối NGAY LẬP TỨC (không tốn một vòng kết nối mạng) — đúng thiết kế "thất bại nhanh".

**(d) Áp dụng đồng nhất cho MỌI script, không chỉ `run-agent.ts`:** trong lúc chạy các test bên
dưới, MỌI lần gọi `check-balance.ts`/`add-rule.ts`/... đều tự chiếm-khoá-rồi-nhả qua CHÍNH
`initWallet()` — quan sát được tự nhiên nhiều lần trong log (ví dụ `check-balance.ts agent` lúc
16:03:55 tự phát hiện và dọn một lock mồ côi từ lần force-kill trước đó, HOÀN TOÀN không cần tôi
làm gì thêm). Xác nhận cơ chế áp dụng đều, không phải chỉ cho kịch bản long-running.

### 3.2 Phát hiện lại: `TaskStop` vẫn không giết được tiến trình thật — LẦN THỨ TƯ

Trong suốt phần test Giai đoạn 3, `TaskStop` được gọi bốn lần cho tiến trình `run-agent.ts` —
**CẢ BỐN LẦN đều KHÔNG giết được PID thật** (chỉ tiến trình bọc ngoài biến mất khỏi theo dõi của
harness, PID node.exe thật vẫn sống, xác nhận lại bằng `Get-CimInstance` mỗi lần). Đây không còn
là một lần ngẫu nhiên (SPLIT_REPORT.md §5) mà là **hành vi có hệ thống trên máy này** — càng
củng cố lý do Tầng 1 (tự hỏi OS, không tin harness) là quyết định đúng, không phải phòng xa quá
mức.

**Hệ quả cho việc test graceful shutdown (SIGINT/SIGTERM):** vì `TaskStop` không đưa được tín
hiệu tới đúng tiến trình, KHÔNG CÓ CÁCH nào trong phiên này gửi một tín hiệu SIGINT/SIGTERM thật
sự tới tiến trình đang chạy để quan sát handler mới thêm (`process.on('SIGINT'|'SIGTERM', ...)`)
có thực sự chạy hay không. Thêm vào đó, tín hiệu kiểu POSIX (SIGINT/SIGTERM) vốn đã không có
tương đương trực tiếp trên Windows cho tiến trình chạy nền — `Ctrl+C` chỉ hoạt động đúng khi có
console đính kèm trực tiếp, điều không có được trong môi trường chạy nền của phiên làm việc này.

→ **Nói thẳng, không giả vờ đã test:** code xử lý SIGINT/SIGTERM (dừng scheduler, gọi
`wallet.release()`, thoát sạch) đã viết đúng theo mẫu chuẩn của Node.js và qua được typecheck,
nhưng **CHƯA được xác nhận chạy thật** trong phiên này — do giới hạn công cụ (TaskStop không tới
đúng tiến trình) CỘNG giới hạn nền tảng (Windows không có SIGINT/SIGTERM thật cho tiến trình
nền). Đây là việc CẦN xác nhận lại khi triển khai trên môi trường đích thật (Linux/AstridOS theo
CLAUDE.md mục 7, nơi SIGTERM hoạt động đúng chuẩn POSIX) — ghi vào TODO, không đánh dấu đã xong.

### 3.3 Luật `notify` (sendDM) — thật, lần đầu tiên trong dự án

Seed luật `notify-on-incoming`: nhận từ counterparty → gửi DM cho partner. Trigger bằng 1 UCT
thật từ counterparty:
```
transfer:incoming id=v2_e603ff12...
rule-engine: 1 onIncoming rule(s) matched
rule d5cc79b3... fired: notified @cpa-partner-fe45dc
```
**Xác nhận độc lập** qua `check-dms.ts partner` (một tiến trình HOÀN TOÀN riêng, đọc lịch sử hội
thoại của partner từ Nostr, không dựa vào log của agent):
```
[2026-07-02T16:07:21.000Z] from cpa-agent-66969549: "phase3-notify-test: incoming transfer received"
```
Khớp chính xác nội dung + đúng người gửi.

### 3.4 Luật `onBalanceAbove` qua Scheduler tick — thật, lần đầu tiên trong dự án

Seed luật `balance-above` (ngưỡng 1 UCT, số dư agent thật lúc đó là 8.1 UCT — vượt ngưỡng sẵn) +
`cooldownSeconds: 60`. Chạy `run-agent.ts` với `SCHEDULER_TICK_MS=5000` (rút ngắn để test
nhanh, mặc định production là 30000):
```
scheduler: started — evaluating balance-triggered rules every 5000ms
[tick 1, +5.5s] rule 57844f73... fired: notified @cpa-partner-fe45dc
[tick 2..9]     rule 57844f73... skipped: cooldown active (56s..11s remaining)
```
Fired ĐÚNG ngay tick đầu tiên (balance đã vượt ngưỡng sẵn, không cần chờ sự kiện tiền vào nào).
Các tick sau bị `cooldownSeconds` chặn đúng — xác nhận guard áp dụng nhất quán cho luật trigger
theo balance, không chỉ luật trigger theo tiền vào (đường code guard dùng chung, không rẽ nhánh
theo loại trigger).

Bằng chứng phụ đáng chú ý: sau khi luật `notify-on-incoming` fired (mục 3.3), log cho thấy NGAY
sau đó rule `57844f73` được kiểm tra LẦN NỮA và bị skip vì cooldown ("cooldown active (6s
remaining)") — đây là `processIncoming`'s lời gọi `processBalanceRules()` SAU MỖI incoming
transfer (thiết kế: phản ứng ngay khi có tiền vào, không đợi tick kế tiếp), và nó tôn trọng ĐÚNG
cooldown state đã có từ nhánh tick — xác nhận state luật dùng chung nhất quán giữa hai đường vào.

**Xác nhận độc lập** qua `check-dms.ts partner` — 3 tin nhắn, đúng thời điểm khớp log:
```
[16:06:27] "phase3-balance-test: balance above 1 UCT"   ← tick đầu
[16:07:21] "phase3-notify-test: incoming transfer received"  ← từ luật notify-on-incoming
[16:07:32] "phase3-balance-test: balance above 1 UCT"   ← tick sau khi cooldown 60s từ 16:06:27 hết hạn
```

## 4. Unit test — 30/30 pass (thêm 9 test mới so với Giai đoạn split)

```
4 test mới cho tryClaim (test/idempotency.test.ts):
✔ tryClaim: concurrent claims for the SAME transferId — exactly one wins
✔ tryClaim: different transferIds all succeed independently
✔ tryClaim: a second attempt for an already-claimed transferId (sequential) returns false
✔ isProcessed: reflects claims made via tryClaim, false for never-claimed ids

4 test mới cho process-lock (test/process-lock.test.ts):
✔ no existing lock -> acquires immediately, recording our own pid
✔ refuses to start if the recorded PID is alive
✔ cleans up an orphaned lock (dead PID) and acquires successfully
✔ release() is idempotent — calling it twice does not throw

1 test mới cho runExclusive (test/engine.test.ts):
✔ runExclusive: two different events matching the same rate-limited rule are serialized, never interleaved

tests 30, pass 30, fail 0
```

**Đã tự kiểm chứng test không phải "test giả"**: tạm bỏ `runExclusive` khỏi
`handleIncomingTransfer` (gọi thẳng `processIncoming`), chạy lại đúng test đó → **FAIL đúng như
dự đoán** (`2 !== 1` — cả hai sự kiện đều lọt qua rate limit thay vì chỉ một) → khôi phục lại
code đúng, test pass lại. Xác nhận test thật sự bắt được lỗi nó được viết ra để bắt.

**Test process-lock dùng kỹ thuật xác định, không đoán PID:** ca "PID còn sống" dùng
`process.pid` của CHÍNH tiến trình test (chắc chắn còn sống); ca "PID mồ côi" dùng
`spawnSync` sinh một tiến trình con RỒI ĐỢI nó thoát hẳn trước khi lấy PID của nó làm "PID chết"
— không đoán một số ngẫu nhiên hy vọng nó không tồn tại.

## 5. Sửa lại một mô tả chưa chính xác ở PHASE3_PROCESS_DESIGN.md (minh bạch)

Thiết kế đã duyệt mô tả Rủi ro B là "hai lần bắn thật nhưng bộ đếm chỉ tăng một". Khi viết test
thật để CHỨNG MINH race này, vết tích chính xác hơn: `recordFire()` tự nó đọc-sửa-ghi đồng bộ
(không có `await` xen giữa đọc và ghi), nên bộ đếm **vẫn tăng đúng số lần gọi thật** (2 lần gọi
→ tăng 2) — lỗi THẬT SỰ nằm ở bước KIỂM TRA rate-limit (`checkGuards`) đọc giá trị CŨ trước khi
bên kia kịp ghi, khiến **CẢ HAI đều được phép bắn** (vượt quá `maxTriggersPerHour` đã cấu hình),
không phải "bắn hai lần nhưng đếm thiếu". Hậu quả cuối (rate limit bị vượt, tiền có thể bị gửi
vượt giới hạn) giống hệt kết luận cũ — **kiến trúc `runExclusive` đã duyệt xử lý đúng cả hai
cách diễn giải như nhau** — chỉ đính chính lại cơ chế chính xác để ai đọc lại thiết kế sau này
không hiểu sai chi tiết kỹ thuật. Không cần duyệt lại thiết kế vì kết luận/giải pháp không đổi.

## 6. TODO / giới hạn còn lại

- **Graceful shutdown (SIGINT/SIGTERM) chưa được xác nhận chạy thật** — xem mục 3.2. Cần verify
  lại khi có môi trường Linux thật (AstridOS hoặc VPS) hoặc một cách khác để gửi tín hiệu thật
  trên Windows (ví dụ chạy trực tiếp trong một cửa sổ terminal thật, gõ Ctrl+C bằng tay, ngoài
  phạm vi công cụ nền của phiên này).
- **`onSchedule` (cron) vẫn chưa hiện thực** — như đã nêu ở mục 2 và trong `scheduler.ts`, log
  cảnh báo rõ ràng nếu có luật loại này đang bật, không âm thầm bỏ qua. Cần quyết định sau: có
  cần thật sự cho track dự thi này không, hay `onIncoming` + `onBalanceAbove/Below` là đủ minh
  chứng "agentic" (CLAUDE.md mục 2 nhấn mạnh agent tự quyết theo ĐIỀU KIỆN, không bắt buộc phải
  có lịch cố định).
- **Giới hạn đã nêu ở PHASE3_PROCESS_DESIGN.md §"Ranh giới đảm bảo" vẫn giữ nguyên** — chưa có gì
  thay đổi, không lặp lại chi tiết ở đây.
- Ba luật Giai đoạn 2 (forward-normal, forward-oversized, split-with-invalid-leg) đang để
  `enabled:false` — giữ lại trong `rules.json` làm tư liệu, chưa xoá (không tự quyết xoá).

## 7. Cách tái chạy

```bash
npm test                                              # 30 unit test, không chạm mạng

npx tsx scripts/run-agent.ts                          # always-on: Event Listener + Scheduler
SCHEDULER_TICK_MS=5000 npx tsx scripts/run-agent.ts   # tick nhanh hơn để test

# Mô phỏng crash cứng (không dùng TaskStop — đã biết không đáng tin trên máy này):
# PowerShell: Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ... | Stop-Process -Force
# rồi chạy lại run-agent.ts — quan sát log "found orphaned lock... cleaning up"

npx tsx scripts/check-dms.ts partner                  # xác nhận độc lập DM đã nhận
npx tsx scripts/check-balance.ts <role>                # PHẢI đảm bảo không có run-agent.ts nào
                                                        # đang sống trên CÙNG ví — giờ được ép
                                                        # buộc tự động bởi process-lock, không
                                                        # còn phải tự nhớ kỷ luật thao tác nữa
```

---

➤ Chờ duyệt trước khi sang Giai đoạn 4 (Dashboard).
