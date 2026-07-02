# PHASE4_REPORT.md — Dashboard

## 0. Tóm tắt

Dashboard đã build xong, chạy **trong cùng tiến trình** với `scripts/run-agent.ts` (không mở ví
riêng), phục vụ qua HTTP tại `http://<DASHBOARD_HOST>:<DASHBOARD_PORT>` (mặc định
`127.0.0.1:8787`). Đã test thật trên testnet2: gửi 0.5 UCT thật từ ví counterparty → quan sát
dashboard (qua đúng API mà trình duyệt sẽ gọi, không nhìn console server) phản ứng trong ~2 giây.
30/30 unit test cũ vẫn xanh sau refactor. Không phát sinh vi phạm ràng buộc một-ví-một-tiến-trình.

Một sự cố nhỏ lặp lại (process leak khi dừng agent — xem mục 6) đã xảy ra và được xử lý bằng đúng
quy trình đã lập ở Phase 3.

---

## 1. Quyết định kiến trúc: endpoint trong tiến trình agent

**Chọn: Đường 1** — `run-agent.ts` tự mở một HTTP server read-mostly ngay trong tiến trình đang
giữ ví, `RuleEngine`, và `RuleStore` trong bộ nhớ. Dashboard (file HTML/CSS/JS tĩnh) được server
này phục vụ luôn tại `GET /`, gọi API cùng origin (`/api/status`, `/api/log/stream`,
`POST /api/rules/:id/toggle`).

**Vì sao đường 2 (dashboard đọc/ghi thẳng `store/*.json`) KHÔNG an toàn cho tính năng bật/tắt luật** —
đây là đúng điểm nhạy được cảnh báo trước khi làm:

Đọc lại `src/rules/store.ts`, `saveState()` gọi `save()` — hàm này **ghi đè toàn bộ mảng
`this.rules` đang có trong bộ nhớ xuống file**, không merge với file trên đĩa:

```ts
private async save(): Promise<void> {
  await writeJson(this.path, this.rules);   // ghi đè, không đọc-merge
}
```

Tiến trình agent đang chạy giữ **một instance `RuleStore` nạp một lần lúc khởi động**. Nếu một
tiến trình thứ hai (ví dụ dashboard backend riêng) sửa `rules.json` trên đĩa trong lúc agent đang
chạy, bản sửa đó chỉ tồn tại cho tới lần kế tiếp agent tự gọi `saveState()` — mà việc này xảy ra
**mỗi khi bất kỳ luật nào fire** (`recordFire()` trong `engine.ts`). Lúc đó agent sẽ ghi đè bản
trong bộ nhớ (đã cũ) lên trên bản sửa của tiến trình thứ hai, xoá sạch thay đổi đó **một cách im
lặng**. Đây chính xác là cơ chế sự cố ở `SPLIT_REPORT.md` §5 (tiến trình rò rỉ ghi đè `rules.json`,
xoá mất luật split và bật lại 2 luật đã tắt).

→ Do đó **bật/tắt luật của dashboard PHẢI đi qua đúng instance `RuleStore` mà agent đang giữ**.
Cách duy nhất làm được điều này mà không cần thêm IPC là chạy dashboard server ngay trong tiến
trình agent, gọi thẳng `engine.rules.setEnabled(id, enabled)` — xem `dashboard-server.ts`:

```ts
// Mutates the SAME in-memory RuleStore instance the agent's own event loop already holds and
// persists through — this is the entire reason the dashboard server lives inside the agent
// process instead of being a standalone process that writes rules.json directly...
await opts.engine.rules.setEnabled(id, body.enabled);
```

Không có tiến trình thứ hai nào từng ghi `rules.json` trong toàn bộ thiết kế Phase 4. Đã verify
thật (mục 4).

---

## 2. Log kích hoạt real-time — chọn hook tại logger, không sửa engine.ts

Thay vì thêm một "activity sink" port mới xuyên qua `engine.ts`/`executor.ts`/`guards.ts`/
`scheduler.ts` (rủi ro động vào 4 file đã được duyệt và test kỹ ở Phase 2-3), tôi hook thẳng
`src/logger.ts` — điểm mà MỌI scope đã gọi qua sẵn (`log.info/warn/error`). Thêm một ring buffer
(500 dòng gần nhất) + pub/sub, giữ nguyên chữ ký `log.info(scope, message)` cũ:

```ts
export function getLogHistory(sinceSeq = 0): LogEntry[] { ... }
export function onLogEntry(listener: (entry: LogEntry) => void): () => void { ... }
```

Kết quả: dashboard thấy **đúng những gì** một người xem console server thấy — kể cả log của
scheduler, wallet init, executor — không phải một tập con tự chọn có thể thiếu sót. Không file nào
trong `src/rules/*` bị đổi để phục vụ việc này (giảm rủi ro hồi quy trên code đã duyệt).

`src/rules/guards.ts` có MỘT thay đổi nhỏ, thuần refactor: tách `cooldownRemainingSeconds(rule, now)`
ra khỏi `checkGuards` làm hàm pure export riêng, để dashboard hiển thị **đúng con số** mà logic
enforcement dùng — tránh hai nguồn sự thật lệch nhau nếu công thức cooldown đổi sau này. Hành vi
`checkGuards` giữ nguyên 100% (đã chạy lại `guards.test.ts`, 7/7 xanh, message cooldown vẫn đúng
định dạng cũ `cooldown active (Xs remaining)`).

---

## 3. API bề mặt

| Method | Path | Việc gì | Đổi trạng thái? |
|---|---|---|---|
| GET | `/` | Trang dashboard (HTML/CSS/JS tĩnh, tự chứa) | Không |
| GET | `/api/status` | Identity agent + toàn bộ luật (enabled, fireCount, lastFiredAt, cooldownRemainingSeconds tính live) | Không |
| GET | `/api/log?since=N` | Snapshot log từ seq > N (dùng khi load trang / SSE lỗi) | Không |
| GET | `/api/log/stream?since=N` | SSE, replay từ seq > N rồi push live; heartbeat 20s giữ kết nối qua proxy | Không |
| POST | `/api/rules/:id/toggle` `{enabled}` | Bật/tắt MỘT luật đã có sẵn | Có — qua `engine.rules.setEnabled` |

Không có endpoint tạo luật, xoá luật, hay gửi tiền tuỳ ý. `identity` trả về đúng 3 field
(`nametag`, `directAddress`, `chainPubkey`) — module server **không bao giờ nhận** `mnemonic` hay
`oracle.apiKey` (chỉ nhận `engine` + một struct identity hẹp do `run-agent.ts` tự trích, xem
`scripts/run-agent.ts`), nên không có đường nào lỡ tay serialize bí mật ra JSON.

---

## 4. Test thật trên testnet2

### 4.1 Khởi động — tự phục hồi lock cũ (như thiết kế Phase 3)

Có một `data/agent/agent.lock` còn sót từ phiên Phase 3 trước (PID 5228, tiến trình đã chết —
xác nhận bằng PowerShell, không còn `node.exe` nào chạy). Khởi động `run-agent.ts`:

```
[18:23:29.248] [agent] found orphaned lock from dead PID 5228 (started 2026-07-02T16:06:17.863Z) — cleaning up
[18:23:29.249] [agent] process lock acquired: PID 20524, instance da6c7e6f
...
[18:23:33.292] [scheduler] started — evaluating balance-triggered rules every 30000ms
[18:23:33.294] [agent] dashboard listening at http://127.0.0.1:8787
[18:23:33.294] [agent] agent running — Ctrl+C to stop
```

Tự phục hồi đúng như thiết kế, không cần can thiệp tay.

### 4.2 API cơ bản

`GET /` → 200, trả HTML đầy đủ. `GET /api/status` → JSON đúng identity thật + 5 luật hiện có,
`cooldownRemainingSeconds` tính đúng (0 cho luật không trong cooldown).

### 4.3 Toggle thật + xác nhận không ghi đè sai

Bật rồi tắt lại luật `0f591638…` (forward 10%, vốn đang `disabled` từ Phase 2) qua
`POST /api/rules/.../toggle`:

```
--- toggle ON ---
{"rule":{"id":"0f591638-...","enabled":true, ..., "fireCount":3, "lastFiredAt":1783005031245, ...}}
--- toggle OFF (restore) ---
{"rule":{"id":"0f591638-...","enabled":false, ..., "fireCount":3, "lastFiredAt":1783005031245, ...}}
```

Đọc thẳng `store/rules.json` sau đó: `enabled:false`, `fireCount`/`lastFiredAt`/`windowStartedAt`/
`firesInWindow` **không đổi** — đúng ý định (toggle không được đụng vào state fire). Đã khôi phục
lại đúng trạng thái ban đầu (giữ đúng quyết định "3 luật Phase 2 enabled:false — giữ làm tư liệu").

Test đường lỗi: `POST` id không tồn tại → `404`; body sai kiểu (`{"enabled":"yes"}`) → `400`.

### 4.4 SSE bắt sự kiện real-time — kể cả log do chính toggle tạo ra

Bắt luồng `/api/log/stream` trong lúc gọi 2 request toggle ở trên. Log dashboard tự phát ra
**cũng lên luôn stream** (audit trail cho hành động điều khiển, không chỉ hành động tiền):

```
id: 17
data: {"seq":17,...,"scope":"dashboard","message":"rule 0f591638-... enabled via dashboard"}

id: 18
data: {"seq":18,...,"scope":"dashboard","message":"rule 0f591638-... disabled via dashboard"}
```

### 4.5 Kịch bản reviewer đầy đủ — tiền thật, quan sát QUA dashboard API (không xem console)

Gửi thật 0.5 UCT từ ví counterparty (`@cpa-peer-de1b95`) sang agent (`@cpa-agent-66969549`), memo
`"phase4-dashboard-live-test"`, **trong lúc một client SSE riêng đang mở `/api/log/stream`** —
mô phỏng đúng những gì trình duyệt của reviewer sẽ thấy:

```
[counterparty-send] sending 0.5 UCT (500000000000000000 base units) to @cpa-agent-66969549 ...
[18:25:58.320] [counterparty-send] send() resolved: id=51c51c29-... status=completed deliveryState=landed
```

SSE nhận được (không qua console server, qua đúng cổng dashboard công khai):

```
id: 21  ts=...:59.616  [agent]       transfer:incoming id=v2_10b2c4... senderPubkey=02d07f7f... memo="phase4-dashboard-live-test"
id: 22  ts=...:59.856  [rule-engine] event v2_10b2c4...: 1 onIncoming rule(s) matched
id: 23  ts=...:60.609  [rule-engine] rule d5cc79b3-... fired: notified @cpa-partner-fe45dc
id: 24  ts=...:60.610  [rule-engine] rule 57844f73-... skipped: cooldown active (34s remaining)
```

**Độ trễ đo thật:** từ lúc `send()` resolve (18:25:58.320) tới lúc `transfer:incoming` xuất hiện
trên SSE (18:25:59.616) ≈ **1.3s**; tới lúc luật fire xong (18:26:00.609) ≈ **2.3s** — nằm gọn
trong "vài giây" theo kỳ vọng CLAUDE.md mục 8.

Xác nhận qua `GET /api/status` sau đó: `d5cc79b3` (`notify-on-incoming`) `fireCount` 1→2,
`lastFiredAt` đúng thời điểm gửi. 3 luật Phase 2 (disabled) không đổi — không bị fire lây.

Cũng quan sát được luật `onBalanceAbove` tự fire độc lập một lần trong lúc test (số dư vẫn > 1 UCT
và cooldown 60s đã hết) — bằng chứng Scheduler và dashboard SSE cùng hoạt động đồng thời không
tranh chấp, đi qua đúng `runExclusive` queue chung như Phase 3 đã thiết kế.

### 4.6 Syntax-check phần JS nhúng client-side

`tsc --noEmit` chỉ xác nhận `dashboard-page.ts` là một template string TS hợp lệ — **không** parse
nội dung bên trong chuỗi đó như JavaScript thật. Đã trích riêng phần trong `<script>...</script>`
và chạy `node --check` (parse-only, không thực thi) → **hợp lệ cú pháp**. Đây KHÔNG phải chạy thử
trong trình duyệt thật (xem mục 7 — TODO).

### 4.7 Unit test + typecheck

`npx tsc --noEmit`: sạch. `npm test`: **30/30 pass** (không đổi số lượng so với Phase 3 — Phase 4
không thêm unit test mới vì thay đổi logic thuần là 1 hàm pure-refactor trong `guards.ts`, đã được
`guards.test.ts` hiện có phủ qua các message-format assertion; phần còn lại là I/O — HTTP server —
đã verify bằng test thật ở trên thay vì mock).

---

## 5. Bảo mật

- Không endpoint nào trả về mnemonic hay `oracle.apiKey` — module server chỉ nhận một struct
  identity hẹp (`nametag`, `directAddress`, `chainPubkey`), không nhận `wallet`/`config` đầy đủ.
- Không endpoint tạo luật mới hay gửi tiền tuỳ ý — chỉ bật/tắt luật đã cấu hình sẵn.
- **Quyết định KHÔNG thêm auth cho `POST /toggle`** (không được yêu cầu, giữ đơn giản đúng tinh
  thần "không cần đẹp, cần rõ"). Rủi ro: nếu deploy công khai với `DASHBOARD_HOST=0.0.0.0`, BẤT KỲ
  ai biết URL đều bật/tắt được luật (không rút được tiền, không đổi được luật, nhưng có thể tắt
  luật đang chạy demo). Nêu rõ ở đây thay vì âm thầm bỏ qua — TODO nếu muốn siết trước khi public.

---

## 6. Sự cố trong lúc test: process leak lần thứ 5 (TaskStop)

Dừng agent bằng `TaskStop` → báo thành công. Verify bằng PowerShell (đúng quy trình Phase 3) vẫn
thấy đủ 3 tiến trình cây `npx → tsx/cli.mjs → node` còn sống (PID 23344/7468/20524). Đây là lần
**thứ 5 liên tiếp trong phiên làm việc này** — củng cố thêm luận điểm Phase 3: không bao giờ tin
tín hiệu "đã dừng" từ harness, luôn verify qua OS. Đã `Stop-Process -Force` cả 3 PID, verify lại
— sạch. Sau force-kill, `data/agent/agent.lock` còn sót đúng PID 20524 (dự kiến — force-kill
không cho tiến trình chạy handler `process.on('exit')`) — sẽ tự phục hồi ở lần chạy kế tiếp, đúng
cơ chế Tầng 1. Cổng 8787 xác nhận đã đóng (connection timed out).

Không có tiền nào bị ảnh hưởng — sự cố này thuần về vòng đời tiến trình dev/test, không phải logic
tiền. Ghi nhận thêm một điểm dữ liệu cho AstridOS: môi trường Windows dev hiện tại có vấn đề dọn
tiến trình nền mang tính hệ thống, không phải một lần.

---

## 7. TODO / giới hạn đã biết (không chặn duyệt Phase 4)

1. **Chưa mở bằng trình duyệt thật.** Mọi thứ ở mục 4 verify qua `curl`/`EventSource`-qua-curl ở
   tầng HTTP — đúng cái dashboard thật sẽ gọi, nhưng chưa thực sự render DOM/CSS/click checkbox
   bằng một browser engine thật (môi trường này không có công cụ browser). Rủi ro còn lại: lỗi ở
   tầng DOM/CSS (không phải tầng logic/API) sẽ không bị bắt bởi các test đã chạy.
2. **"Publicly viewable" (CLAUDE.md mục 8/9) chưa xong** — dashboard mặc định bind
   `127.0.0.1:8787`, chỉ máy này truy cập được. Cần một quyết định hạ tầng (đổi
   `DASHBOARD_HOST=0.0.0.0` sau firewall/reverse-proxy của VPS, hoặc dùng tunnel như ngrok/
   Cloudflare Tunnel) — KHÔNG đoán thay bạn, để ở `.env.example` làm TODO rõ ràng.
3. **`POST /toggle` không có auth** — xem mục 5, quyết định có chủ đích, cân nhắc lại nếu deploy
   công khai lâu dài.
4. **Dashboard server's `close()` trong graceful shutdown chưa verify được thật** — vì cùng lý do
   Phase 3 mục 3.2 (TaskStop không chạm tới tiến trình thật; Windows không có POSIX signal chuẩn
   cho tiến trình nền không gắn console). Không phải regression mới, cùng giới hạn đã biết.
5. **`onSchedule` (cron): giữ nguyên quyết định không hiện thực** (theo chỉ đạo ở đầu phiên này) —
   dashboard hiển thị rõ nhãn "NOT evaluated" cho luật loại này nếu có, không giấu.
6. Link Explorer trong dashboard chỉ trỏ về `https://unicity.network` (bare domain, đúng những gì
   CLAUDE.md mục 8 nêu) — KHÔNG bịa deep-link dạng `/address/<x>` vì chưa xác nhận được cấu trúc
   URL thật của Explorer. Reviewer tự dán nametag/address/tx id vào đó.

---

## 8. File đã thêm / sửa

**Thêm mới:**
- `src/server/dashboard-server.ts` — HTTP server (status/toggle/log/log-stream), chạy trong tiến trình agent.
- `src/server/dashboard-page.ts` — trang HTML/CSS/JS tự chứa.

**Sửa:**
- `src/logger.ts` — thêm ring buffer 500 dòng + pub/sub (`getLogHistory`, `onLogEntry`), giữ nguyên chữ ký `log.*` cũ.
- `src/rules/guards.ts` — tách `cooldownRemainingSeconds` thành hàm pure export (refactor thuần, không đổi hành vi `checkGuards`).
- `src/config.ts` — thêm `dashboardPort`/`dashboardHost` (có default, không bắt buộc trong `.env`).
- `scripts/run-agent.ts` — khởi động dashboard server sau `scheduler.start()`, đóng nó trong `shutdown()` trước khi release lock.
- `.env.example` — tài liệu hoá `DASHBOARD_PORT`/`DASHBOARD_HOST` kèm ghi chú về deploy công khai.

Không file nào trong `src/rules/engine.ts`, `executor.ts`, `matcher.ts`, `idempotency.ts`,
`split-progress.ts`, `store.ts` (ngoại trừ đọc qua getter có sẵn) hay `src/wallet/*` bị đổi.

---

## 9. Cách tự chạy lại

```bash
npx tsx scripts/run-agent.ts
# log in ra: "dashboard listening at http://127.0.0.1:8787"
```

Mở `http://127.0.0.1:8787` bằng trình duyệt → thấy identity + bảng luật + log sống. Gửi tiền thật
tới nametag hiển thị trên dashboard từ một ví Sphere khác trên testnet2 để tự kiểm chứng lại kịch
bản ở mục 4.5.

---

➤ Dừng ở đây, chờ bạn duyệt trước khi sang Giai đoạn 5 (AstridOS).
