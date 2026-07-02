# Phase 2 Report — Rule Engine

Toàn bộ pipeline `transfer:incoming → Rule Matcher → Guard Check → Action Executor → state +
idempotency` đã chạy thật trên **Unicity Testnet v2**, kể cả nhánh lỗi fail-safe — lần đầu tiên
dự án này quan sát một send() thất bại thật.

---

## 1. Type `Rule` cuối cùng

`src/rules/types.ts` — khớp mô hình CLAUDE.md 4.3, với MỘT phần mở rộng có chủ đích (đánh dấu
rõ bên dưới):

```ts
type RuleTrigger =
  | { type: 'onIncoming'; fromSender?: string; minIncoming?: string }
  | { type: 'onBalanceAbove' | 'onBalanceBelow'; threshold: string; coinId: string }
  | { type: 'onSchedule'; cron: string };   // chưa được đánh giá — chờ Scheduler ở Giai đoạn 3

type RuleAction =
  | { type: 'forward'; to: string; percent?: number; fixedAmount?: string; coinId: string; memo?: string }
  | { type: 'split'; splits: { to: string; percent: number }[]; coinId: string }
  | { type: 'notify'; to: string; message: string };

interface RuleGuards {
  minAmount?: string;
  maxTriggersPerHour?: number;
  excludeSenders?: readonly string[];
  cooldownSeconds?: number;
}

interface RuleState {
  lastFiredAt?: number;
  fireCount: number;
  // MỞ RỘNG so với CLAUDE.md 4.3 — cần để triển khai đúng maxTriggersPerHour (cửa sổ cố định,
  // reset sau 1h) thay vì chỉ đếm dồn suốt đời:
  windowStartedAt?: number;
  firesInWindow?: number;
}

interface Rule {
  id: string; enabled: boolean;
  trigger: RuleTrigger; action: RuleAction; guards: RuleGuards; state: RuleState;
}
```

**Quyết định khi spec chưa nói rõ (ghi lại để bạn duyệt, có thể chỉnh):**
- `minIncoming` / `guards.minAmount` không có `coinId` riêng trong spec gốc. Đã triển khai:
  khớp nếu **BẤT KỲ MỘT coin nào** trong `tokens[]` đạt ngưỡng — không bao giờ CỘNG DỒN nhiều
  coin khác nhau lại (tránh cộng nhầm hai loại token có decimals khác nhau). Đúng cho trường
  hợp thực tế hiện tại (chỉ có UCT); cần xem lại nếu sau này có nhiều loại coin cùng lúc.
- **"Mọi đích của luật" trong chống-loop = TOÀN BỘ đích của TẤT CẢ luật**, không chỉ đích của
  luật đang xét — diễn giải an toàn hơn (chặn cả loop nhiều-luật, ví dụ luật A chuyển tới X,
  X vô tình khớp trigger của luật B).

## 2. Cấu trúc + tóm tắt từng module

```
src/
  util/json-file.ts        — (dời từ wallet/, dùng chung) readOrCreateJson/writeJson/readJsonIfExists
  wallet/init.ts             — (Phase 1, có thêm parseRoleArg cho CLI an toàn)
  payments/incoming.ts        — (Phase 1, không đổi)
  rules/
    types.ts                  — Rule model + "port" interfaces (AgentPort, IdentityResolverPort...)
                                 để test được bằng object giả, không cần Sphere thật
    store.ts                   — RuleStore: load/add/setEnabled/remove/saveState, path inject được
    idempotency.ts               — IdempotencyLog: isProcessed/markProcessed, path inject được
    identity-cache.ts             — IdentityResolver: resolve('@x') -> chainPubkey, cache theo process
    matcher.ts                     — matchIncomingRules (sender+amount), matchBalanceRules
    guards.ts                       — checkGuards: cooldown, rate-limit cửa sổ cố định, minAmount,
                                       chống loop (agent tự thân + toàn bộ đích luật + excludeSenders)
    executor.ts                      — executeAction: forward/split/notify; bắt SphereError; coi
                                        deliveryPending là THÀNH CÔNG, chỉ status='failed'/throw là lỗi
    engine.ts                         — RuleEngine: nối toàn bộ pipeline; tách rõ "event đã xử lý"
                                        (idempotency, luôn đánh dấu) khỏi "luật đã chạy" (rule.state,
                                        chỉ cập nhật khi action thành công)
scripts/
  run-agent.ts                — always-on thật: sphere.on('transfer:incoming') -> RuleEngine
  add-rule.ts <preset>          — seed luật test (forward-normal | forward-oversized); tự tạo
                                   thêm ví "partner" làm đích chuyển — khác cả agent lẫn counterparty
test/
  test-helpers.ts               — fakeToken/fakeTransfer/fakeRule/fakeResolver/createFakeAgent
  executor.test.ts                — toán BigInt % (bắt buộc), fixedAmount, split nhiều người nhận
  guards.test.ts                    — chống loop (bắt buộc), cooldown, rate-limit, minAmount
  engine.test.ts                     — idempotent (bắt buộc, cả trong-process lẫn giả-lập-restart),
                                        fail-safe ở mức unit (fireCount không tăng khi send thất bại)
store/
  rules.json, idempotency.json         — state của TA tự lưu (CLAUDE.md 4.5), KHÔNG phải SDK quản
```

## 3. Kết quả unit test — 17/17 pass

```
npm test
✔ forward: percent computes via BigInt floor division, never manufactures value
✔ forward: percent floors on non-exact division instead of rounding up      (10 × 33% = 3, không làm tròn lên 4)
✔ forward: fixedAmount is sent as-is, ignoring the received amount
✔ split: each recipient computed independently; sum can be <= total, never >
✔ split: stops and reports failure on the first send failure, without retrying prior sends
✔ forward: a thrown SphereError-like error is treated as failure, not swallowed
✔ loop protection: rejects when the sender IS the agent itself
✔ loop protection: rejects when the sender resolves to a rule destination (any rule)
✔ loop protection: rejects when the sender is in guards.excludeSenders
✔ allows a legitimate sender that is neither the agent nor any protected destination
✔ cooldownSeconds: rejects while within the cooldown window
✔ maxTriggersPerHour: rejects once the fixed-window cap is reached, resets after the window
✔ minAmount: rejects an incoming amount below the guard threshold
✔ idempotency: the same transfer.id processed twice (same process) only pays once
✔ idempotency: survives a simulated restart (fresh IdempotencyLog instance loaded from the same file)
✔ fail-safe: a failed send does not mark the rule as fired, but the event is still marked processed
✔ no rule matches: the event is still marked processed
tests 17, pass 17, fail 0
```

Toàn bộ test dùng object giả (`AgentPort`/`IdentityResolverPort` là interface hẹp, không phải
`Sphere` thật) — chạy tức thời, không chạm mạng, không đụng file `store/` thật của dự án (mỗi
test tạo thư mục tạm riêng qua `mkdtemp`).

## 4. Kết quả chạy THẬT trên testnet2

### 4.1 Test tích hợp bình thường — forward 10%

Luật seed (`add-rule.ts forward-normal`): nhận từ `@cpa-peer-de1b95` (counterparty) ≥ 0.1 UCT
→ chuyển 10% cho `@cpa-partner-fe45dc` (ví "partner" mới tạo riêng cho Giai đoạn 2 — khác cả
agent lẫn counterparty, để việc test đích-đến không bị nhầm với người gửi).

Gửi thật 1 UCT kèm memo từ counterparty → log agent:
```
transfer:incoming id=v2_9042... senderPubkey=02d07f... memo="phase2-trigger-forward"
rule-engine: 1 onIncoming rule(s) matched
send to @cpa-partner-fe45dc: status=completed deliveryPending=false amount=100000000000000000
rule 0f591638... fired: forwarded 100000000000000000 to @cpa-partner-fe45dc
```
Kiểm độc lập bằng `check-balance.ts partner` (không có tiến trình nào khác giữ ví đó lúc kiểm):
**balance = 100000000000000000 (đúng 0.1 UCT, đúng 10% của 1 UCT, không lệch).**

### 4.2 Test fail-safe THẬT (bắt buộc) — kết quả PHỨC TẠP HƠN dự kiến, và thú vị hơn

Luật seed (`add-rule.ts forward-oversized`): cùng trigger (từ counterparty), action `forward`
với `fixedAmount = 999999 UCT` — vượt xa số dư agent thật có (~5-6 UCT). **Không có guard nào**
để guard check không cản trước khi tới Action Executor — cố tình, để chắc chắn lỗi xảy ra ở
tầng `send()`, đúng thứ ta cần quan sát.

Cả hai luật (forward-normal + forward-oversized) đều khớp cùng một sự kiện (cùng trigger sender)
— cố ý không tắt luật kia, để xem thêm một câu hỏi phụ: một luật lỗi có ảnh hưởng luật khác đang
khớp cùng sự kiện không?

**Log thật, nguyên văn (đã lược request id dài):**
```
rule-engine: 2 onIncoming rule(s) matched
[Payments] Token v2_8f5a... was spent on-chain during the failed send — marked 'spent'
transfer:failed id=e0309070... error=Send conflicted: a source token was already spent by a
  concurrent transfer — re-plan and retry (Split burn failed: the source state was already
  consumed by a different transaction (lost race — abort this intent and re-plan under a new transferId))
[Payments] Source v2_8f5a... already spent on-chain — demoted, re-planning with the next
  candidate (#625, attempt 1/8)
   ... (19 giây sau) ...
send to @cpa-partner-fe45dc: status=completed deliveryPending=false amount=100000000000000000
rule 0f591638... fired: forwarded 100000000000000000 to @cpa-partner-fe45dc      ← luật BÌNH THƯỜNG vẫn thành công
[Payments] abortIntent failed (soft abort is best-effort): WalletApiError 404 NOT_FOUND unknown intent
transfer:failed id=bdbd7c50... error=Insufficient balance for this transaction
rule-engine: send to @cpa-partner-fe45dc threw SphereError code=SEND_INSUFFICIENT_BALANCE: Insufficient balance for this transaction
rule d2cda1c6... action failed, NOT marking as fired (fail-safe, controlled retry later): SEND_INSUFFICIENT_BALANCE...
```

**Diễn giải:**
1. Luật BÌNH THƯỜNG (forward-normal, chạy trước vì Rule Matcher/Engine xử lý tuần tự — `for...of`
   có `await`, không chạy song song) tự nó đụng một **conflict tự chữa lành** của chính SDK
   (cơ chế `#625 self-healing coin selection` đã thấy tên trong `.d.ts` ở Giai đoạn 0, giờ mới
   thấy nó THẬT chạy): một token nguồn bị phát hiện "đã tiêu trên chain", SDK tự động demote +
   re-plan với token khác (tối đa 8 lần) — và **tự phục hồi thành công**, luật vẫn fired đúng.
   → `transfer:failed` NỔ RA cho một lần thử TRUNG GIAN đã được tự chữa, KHÔNG PHẢI kết quả cuối
   cùng của thao tác logic. Bài học quan trọng: **không dùng event `transfer:failed` làm căn cứ
   fail-safe** — chỉ dùng kết quả (resolve/throw) của chính lệnh `send()` mà Action Executor gọi
   (đúng như thiết kế `executor.ts` đã làm — event chỉ để LOG/quan sát, không điều khiển logic).
2. Luật OVERSIZED thất bại đúng như dự kiến — nhưng qua đường **ném `SphereError`**
   (`code: SEND_INSUFFICIENT_BALANCE`), không phải qua `status: 'failed'` của kết quả trả về.
   Executor đã bắt được bằng nhánh `catch` + `isSphereError`, y như thiết kế.
3. **Rule không liên can nhau:** luật lỗi KHÔNG chặn/làm hỏng luật đang khớp cùng sự kiện —
   xử lý tuần tự, độc lập, đúng thiết kế.
4. Có thêm một lỗi phụ vô hại: `abortIntent failed ... 404 NOT_FOUND` — SDK tự dọn dẹp một
   "intent" đã hết hạn/không còn tồn tại phía server; comment của chính SDK ghi rõ "soft abort
   is best-effort" — không lọt ra ngoài thành lỗi ném cho code của ta, chỉ là log nội bộ ồn.

**Đối soát trên file `store/rules.json` (nguồn sự thật cuối cùng, không suy luận từ log):**
```json
"0f591638-...": { "fireCount": 2, "lastFiredAt": 1783000777477, ... }   // luật thường: fired đúng 2 lần qua 2 lượt test
"d2cda1c6-...": { "fireCount": 0 }                                        // luật oversized: KHÔNG có lastFiredAt — CHƯA BAO GIỜ được đánh dấu đã chạy
```
Đúng 100% yêu cầu fail-safe: **luật gây lỗi không được đánh dấu đã chạy, dù đã được matched và
qua guard check** — vì nó thất bại ở bước cuối (Action Executor).

`store/idempotency.json` có đúng 2 event (khớp 2 lần trigger thật đã gửi) — mỗi event chỉ xuất
hiện một lần dù bên trong nó có thể có nhiều lần retry/conflict nội bộ của SDK.

## 5. Ledger đối soát

| Ví | Trước Phase 2 | Sau | Δ |
|---|---|---|---|
| partner (mới) | 0 | 0.1 UCT (kiểm độc lập bằng check-balance.ts) | +0.1 |
| counterparty | 9 UCT | 7 UCT | −2 (quan sát trực tiếp 2 mốc: log "balance before send" ghi 9 rồi 8 UCT ở hai lần gửi liên tiếp; 7 là bước trừ cuối cùng từ mốc 8 đã quan sát, không phải suy luận từ đầu) |
| agent | ~5.9 UCT | ~6.8 UCT (nhận 2 UCT, gửi ra 0.2 UCT cho partner; KHÔNG kiểm độc lập vì `run-agent.ts` đang giữ ví — cùng lý do an toàn đã nêu ở Phase 1 §3.4) | suy ra, không tự kiểm chứng thêm |

## 6. Giới hạn đã biết (không chặn Giai đoạn 3, nhưng cần nhớ)

- **`split` không atomic.** Nếu người nhận thứ N thất bại sau khi 1..N-1 đã nhận tiền thật,
  không thể hoàn tác — và vì luật bị để "chưa chạy" (đúng tinh thần fail-safe), một lần retry
  ngây thơ cho CẢ luật sẽ **trả tiền lần hai** cho 1..N-1. Chưa có test nào đụng nhánh này (test
  unit chỉ xác nhận nó DỪNG ĐÚNG chỗ và báo lỗi rõ, chưa test retry). Cần cơ chế
  checkpoint-theo-từng-người-nhận nếu muốn an toàn tuyệt đối — để dành quyết định cho bạn, chưa
  tự làm vì vượt phạm vi test bắt buộc của Giai đoạn 2.
- **`onSchedule` chưa được đánh giá** — đúng kế hoạch, chờ Scheduler ở Giai đoạn 3. Một luật
  loại này hiện nằm im trong Rule Store, không lỗi, không chạy.
- **`transfer:failed` không phải nguồn sự thật cho fail-safe** — phát hiện thật ở mục 4.2, đã
  áp dụng đúng trong code (dựa vào kết quả `send()`, không dựa vào sự kiện). Ghi ở đây để không
  ai sau này "sửa" theo hướng nghe event `transfer:failed` để quyết định fail-safe.
- **`notify` dùng `sphere.communications.sendDM`** (đã xác nhận chữ ký `.d.ts` trước khi code,
  `dist/index.d.ts:3101`) — CHƯA test thật (chưa có luật `notify` nào seed) vì không nằm trong
  danh sách bắt buộc của Giai đoạn 2. Có thể test nhanh nếu bạn muốn trước khi sang Giai đoạn 3.
- **`onBalanceAbove`/`onBalanceBelow`** — có code (`matchBalanceRules`) và unit-test-able, nhưng
  CHƯA test thật bằng luật thật trên testnet2 (chưa nằm trong yêu cầu bắt buộc).

## 7. Cách tái chạy

```bash
npm test                                          # 17 unit test, không chạm mạng/testnet2

npx tsx scripts/add-rule.ts forward-normal        # (đã chạy) tạo ví partner + luật forward 10%
npx tsx scripts/add-rule.ts forward-oversized     # (đã chạy) luật fail-safe test

npx tsx scripts/run-agent.ts                      # long-running — nạp store/rules.json, lắng nghe thật
npx tsx scripts/counterparty-send.ts 1 "memo..."  # ở cửa sổ khác, sau khi agent "running"

npx tsx scripts/check-balance.ts partner          # chỉ khi KHÔNG có tiến trình khác giữ ví đó
```

---

➤ Chờ duyệt trước khi sang Giai đoạn 3 (vòng lặp agent always-on).
