# Thiết kế vòng đời tiến trình + bất biến "một sự kiện, một hành động"

Trạng thái: **ĐỀ XUẤT — chưa code.** Trả lời trực tiếp sự cố ở SPLIT_REPORT.md mục 5. Phân
tích hai tầng theo đúng khung bạn đặt ra, không dừng ở pid-file.

---

## Tóm tắt sự cố (để đối chiếu khi đọc thiết kế)

Ba tiến trình `run-agent(-wallet).ts` cũ từ Giai đoạn 1/2 vẫn sống dù đã `TaskStop` (harness chỉ
giết được wrapper ngoài, không giết hết cây tiến trình Windows con). Khi một sự kiện
`transfer:incoming` tới, CẢ BA tiến trình cũ + tiến trình mới đều nhận được (cùng một ví), mỗi
tiến trình đọc `rules.json` của RIÊNG NÓ (nạp tại các thời điểm khác nhau, có luật khác nhau,
`enabled` khác nhau), tự ý hành động theo bản của nó, rồi ghi đè `rules.json` — tiến trình ghi
sau cùng thắng, xoá mất thay đổi của các tiến trình khác (kể cả luật hoàn toàn không tồn tại
trong bản của nó).

**Hai lỗ hổng riêng biệt cộng lại gây ra sự cố:**
1. Không có gì NGĂN nhiều tiến trình cùng sống trên một ví (Tầng 1).
2. Ngay cả khi phát hiện "đã xử lý" đúng cách, việc kiểm tra (check) và đánh dấu (mark) tách rời
   nhau bởi toàn bộ pipeline hành động (có thể tốn 10-30+ giây, đã thấy ở Giai đoạn 2/split) —
   hai tiến trình (hoặc, như phân tích bên dưới, ngay cả hai tác vụ bất đồng bộ TRONG CÙNG một
   tiến trình) đều có thể đọc "chưa xử lý" trước khi bên nào ghi xong (Tầng 2).

---

## Tầng 1 — Ngăn khởi động trùng (phòng ngừa)

### Cơ chế: pid-file theo từng ví, kiểm tra sống-chết bằng chính OS, không dựa vào harness

**Vị trí:** `data/<role>/agent.lock` — theo ĐÚNG từng ví (không phải một lock toàn cục), vì các
vai trò khác nhau (agent/counterparty/partner) là các ví riêng biệt, được phép có tiến trình
riêng chạy song song.

**Nội dung ghi:**
```json
{ "pid": 21240, "startedAt": 1783012345678, "instanceId": "a1b2c3d4" }
```
`pid` PHẢI là `process.pid` đọc từ BÊN TRONG chính tiến trình đang chạy code (`initWallet()`),
KHÔNG phải PID của tiến trình bọc ngoài (`npx`/`tsx cli.mjs`) — đây là điểm mấu chốt khiến cơ chế
này **không phụ thuộc vào việc harness "dừng" tiến trình có đúng không**: khi tiến trình MỚI khởi
động, nó tự tra thẳng OS process table (`process.kill(pid, 0)` — ném lỗi nếu PID không tồn tại,
hoạt động cross-platform kể cả Windows) để hỏi "PID này CÒN THẬT SỰ SỐNG không", không hỏi
"harness có báo đã dừng không". Đây chính là lý do cơ chế này XỬ LÝ ĐÚNG sự cố vừa xảy ra: dù
`TaskStop` báo "đã dừng" sai, `process.kill(pid, 0)` của tiến trình mới vẫn sẽ trả lời ĐÚNG rằng
PID đó còn sống — vì nó tự hỏi OS, không tin lời harness.

### Thời điểm chiếm khoá

Ngay đầu `initWallet()` (`src/wallet/init.ts`), TRƯỚC `createNodeProviders`/`Sphere.init()` —
thất bại nhanh, không tốn một vòng kết nối mạng nếu đằng nào cũng phải từ chối.

### Xử lý khoá cũ (mồ côi vs còn sống)

1. Đọc `agent.lock` nếu có.
2. `process.kill(recorded.pid, 0)`:
   - Ném lỗi (PID không tồn tại) → khoá MỒ CÔI (tiến trình cũ chết mà không kịp dọn) → xoá, ghi
     khoá mới, tiếp tục.
   - Không ném lỗi (PID còn sống) → **TỪ CHỐI KHỞI ĐỘNG**, ném lỗi rõ ràng:
     ```
     Another process (PID 21240, started 2026-07-02T15:09:28Z, instance a1b2c3d4) is already
     holding the wallet lock at data/agent/agent.lock. Refusing to start — running two
     processes against the same wallet WILL corrupt state (see SPLIT_REPORT.md §5).
     If you have verified that PID 21240 is NOT actually related to this wallet (e.g. a PID
     reused by an unrelated process), delete data/agent/agent.lock manually and retry.
     ```

**Không làm cờ `--force`.** Cân nhắc rồi bỏ: một cờ dễ bị đưa vào script/retry-loop tự động một
cách bất cẩn, biến "phải dừng lại suy nghĩ" thành "tự động bỏ qua". Thông báo lỗi đã chỉ thẳng
file cần xoá NẾU người dùng chắc chắn — xoá tay một file đòi hỏi người dùng thật sự dừng lại,
đúng tinh thần "không chắc thì dừng". Đây KHÔNG phải thiếu sót — là lựa chọn có chủ đích.

**Giới hạn còn lại (nói rõ, không giấu):** PID có thể bị HĐH tái sử dụng cho một tiến trình
KHÔNG LIÊN QUAN sau khi tiến trình cũ chết — trường hợp này `process.kill(pid, 0)` sẽ báo "còn
sống" SAI (false positive), chặn nhầm một khởi động lẽ ra hợp lệ. Đã cân nhắc thêm xác minh bằng
"thời điểm khởi động của PID đó theo HĐH" (đối chiếu với `startedAt` đã ghi) để phân biệt "đúng
tiến trình cũ" với "PID trùng ngẫu nhiên" — nhưng việc này cần gọi công cụ ngoài Node thuần (
`Get-CimInstance`/`wmic` trên Windows, đọc `/proc/PID/stat` trên Linux), không có API portable
sẵn trong `fs`/`process`. Vì **hậu quả của false positive chỉ là phải xoá tay một file** (an
toàn, không mất tiền), trong khi hậu quả của false negative (không phát hiện được tiến trình còn
sống) là ĐÚNG sự cố vừa xảy ra — quyết định: chấp nhận rủi ro false-positive nhỏ, KHÔNG xây thêm
xác minh chéo OS-specific. Thiên về "từ chối nhầm" hơn "cho qua nhầm" — đúng nguyên tắc an toàn
tiền của dự án.

### Dọn khoá khi thoát

- Thoát sạch (Ctrl+C/SIGTERM ở `run-agent.ts`, hoặc cuối script một lần chạy): gọi
  `releaseLock()` (xoá file) TRƯỚC KHI `process.exit()`.
- An toàn dự phòng: đăng ký `process.on('exit', ...)` gọi `fs.unlinkSync` (bắt buộc đồng bộ —
  Node không cho phép việc bất đồng bộ trong handler `'exit'`) để dọn ngay cả khi thoát qua
  nhánh lỗi không tường minh gọi `releaseLock()`.
- Không dọn được (crash cứng, kill -9 tương đương) → để lại khoá MỒ CÔI → xử lý ở bước "Xử lý
  khoá cũ" phía trên khi tiến trình kế tiếp khởi động.

### Hệ quả cần chấp nhận

**Mọi script chạm ví (kể cả chỉ đọc, ví dụ `check-balance.ts`) đều bị khoá này chặn nếu
`run-agent.ts` đang sống trên CÙNG ví** — vì rủi ro không chỉ ở việc SCRIPT có ghi gì hay không,
mà ở tầng phiên đăng nhập wallet-api dùng chung `deviceId` (PHASE0_VERIFIED_API.md §3.3: hai
client cùng owner+deviceId có thể trip rotation-reuse revocation phía server) — bất kể đọc hay
ghi. Đây CHÍNH LÀ hành vi "rủi ro nhưng thường chạy được" mà cả phiên làm việc này đã lặp lại
nhiều lần (dừng agent → check balance → chạy lại agent) — thiết kế này biến kỷ luật thao tác thủ
công đó thành ràng buộc được ép buộc bằng code, không còn dựa vào trí nhớ con người. Muốn xem
trạng thái ví khi agent đang sống → đọc trực tiếp file `store/*.json` (không cần ví) hoặc để
chính `run-agent.ts` tự log định kỳ — không mở thêm kết nối ví cạnh tranh (khớp định hướng
dashboard đọc-qua-tiến-trình-agent đã thống nhất từ Giai đoạn 2).

Vai trò khác nhau (agent/counterparty/partner) có khoá RIÊNG theo `dataDir` riêng — chạy
`counterparty-send.ts` trong lúc `run-agent.ts` (ví agent) đang sống hoàn toàn không bị ảnh
hưởng.

---

## Tầng 2 — Giảm hậu quả nếu vẫn có hai tiến trình sống song song

Tầng 1 làm cho tình huống này HIẾM (từ chối ngay khi phát hiện), nhưng "hiếm" không phải "không
thể" — pid-file có thể thất bại (false-negative do PID tái sử dụng theo hướng ngược lại — cực
hiếm nhưng không phải zero; hoặc một khoảng hở nhỏ ngay lúc khởi động). Câu hỏi đúng của bạn:
NẾU tầng 1 thủng, còn gì chặn được double-action?

### Phát hiện thêm khi phân tích: đây là HAI loại rủi ro khác nhau, cần hai cơ chế khác nhau

**Rủi ro A — CÙNG một sự kiện bị hành động hai lần** (đúng thứ đã xảy ra thật). Đây là thứ
`IdempotencyLog` hiện tại NHẮM tới nhưng chưa đạt được, vì check và mark tách rời:
```ts
if (idempotency.isProcessed(transfer.id)) return;   // (check) — hai tiến trình cùng đọc "chưa"
... 10-30+ giây pipeline hành động (đã đo thật ở Giai đoạn 2/split) ...
await idempotency.markProcessed(transfer.id);        // (mark) — quá trễ để ngăn hành động đã xảy ra
```

**Rủi ro B — HAI SỰ KIỆN KHÁC NHAU cùng đụng state của MỘT luật, ngay cả trong CÙNG một tiến
trình.** Phát hiện này KHÔNG có trong báo cáo trước, nhưng cùng họ vấn đề: `sphere.on(
'transfer:incoming', handler)` gọi `handler` NGAY mỗi khi có sự kiện — nếu sự kiện thứ hai tới
trong lúc `handler` của sự kiện thứ nhất còn đang `await` (ví dụ đang chờ `resolve()` hay chờ
`send()` mất 10-30 giây), Node sẽ chạy CHỒNG hai lần gọi `handleIncomingTransfer` xen kẽ nhau
qua vòng lặp sự kiện — dù chỉ một tiến trình, một luồng. Ví dụ cụ thể: cả hai đọc
`rule.state.firesInWindow` (đang là 2) trước khi bên nào ghi lại — bên xong trước ghi 3, bên xong
sau (từ giá trị đọc cũ) CŨNG ghi 3 — hai lần bắn thật nhưng bộ đếm chỉ tăng một. Đây là lỗ hổng
CÓ THẬT ngay trong code hiện tại, không cần thao tác sai gì — chỉ cần hai giao dịch đến gần nhau,
sẽ xảy ra trong vận hành bình thường, không phải tình huống hiếm.

Hai rủi ro cần hai cơ chế khác nhau vì nguyên nhân khác nhau (rủi ro A: đọc-trước-khi-ghi giữa
các LẦN GỌI riêng biệt cho CÙNG khoá; rủi ro B: xen kẽ bất đồng bộ giữa các LẦN GỌI cho khoá
KHÁC nhau nhưng cùng đích ghi).

### Cơ chế 2a — Xử lý Rủi ro B: hàng đợi tuần tự hoá trong RuleEngine

Thay vì gọi trực tiếp, `RuleEngine` giữ một chuỗi promise nội bộ, MỌI lần "có việc cần xử lý"
(sự kiện tiền vào, VÀ SAU NÀY tick của Scheduler cho luật balance) đều nối vào ĐÚNG một hàng đợi
này:
```ts
class RuleEngine {
  private queue: Promise<void> = Promise.resolve();

  private runExclusive(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, fn); // chạy fn dù nhánh trước thành công hay lỗi
    return this.queue;
  }

  async handleIncomingTransfer(transfer: IncomingTransfer): Promise<void> {
    return this.runExclusive(() => this.processIncoming(transfer));
  }
  // Giai đoạn 3 sau: handleScheduleTick(...) cũng đi qua runExclusive() — CÙNG hàng đợi,
  // không phải hàng đợi riêng — để tick Scheduler không xen kẽ với việc xử lý tiền vào.
}
```
Chi phí gần như bằng 0 (chỉ là một promise chain), giải quyết TRỌN VẸN Rủi ro B cho MỘT tiến
trình — không cần khoá OS, không cần thư viện ngoài.

**Lưu ý cho phần Scheduler (mục còn lại Giai đoạn 3):** khi xây tick Scheduler cho luật balance,
PHẢI cho nó đi qua CÙNG `runExclusive()` này — nếu vô tình để tick chạy trên một đường riêng, lỗ
hổng B quay lại dưới dạng khác (tick xen giữa lúc một transfer đang xử lý). Ghi chú trước ở đây
để không quên khi code phần đó.

### Cơ chế 2b — Xử lý Rủi ro A: gộp "kiểm tra" và "đánh dấu" thành MỘT thao tác nguyên tử

Thay `IdempotencyLog` hiện tại (một file JSON, đọc rồi ghi riêng) bằng claim nguyên tử dựa trên
chính đảm bảo của hệ điều hành, không cần thư viện khoá ngoài:

```ts
// store/idempotency/<transferId>.json — MỘT FILE MỖI SỰ KIỆN, thay vì một object chung
async tryClaim(transferId: string): Promise<boolean> {
  try {
    await writeFile(join(this.dir, `${transferId}.json`), JSON.stringify({ claimedAt: Date.now() }), { flag: 'wx' });
    return true;   // ta vừa tạo file — chưa ai claim trước
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;  // đã bị claim (bởi ai đó, bất kể lúc nào)
    throw err;
  }
}
```
`fs`'s flag `'wx'` (write, exclusive — thất bại nếu file đã tồn tại) là một API `fs` THUẦN CỦA
NODE, được chính HĐH đảm bảo nguyên tử ở tầng filesystem (`open(O_CREAT|O_EXCL)`) — không cần
thêm gói khoá-file nào. Hai tiến trình (hoặc hai lần gọi xen kẽ) cùng gọi `tryClaim` cho CÙNG
`transferId` — HĐH sẽ quyết định ai thắng, người thua nhận `EEXIST` NGAY LẬP TỨC, trước khi kịp
làm bất kỳ việc gì khác. Không còn khoảng hở giữa "đọc" và "ghi" vì đây là MỘT syscall.

`RuleEngine` gọi `tryClaim` NGAY ĐẦU pipeline (trước matching/guards/actions), thay cho
`isProcessed()` + `markProcessed()` cũ:
```ts
private async processIncoming(transfer: IncomingTransfer): Promise<void> {
  if (!(await this.idempotency.tryClaim(transfer.id))) {
    log.warn(SCOPE, `event ${transfer.id} already claimed — skipping`);
    return;
  }
  // ... y hệt logic cũ, không cần gọi markProcessed() ở cuối nữa — tryClaim() CHÍNH LÀ mark.
}
```

**Đánh đổi:** mất tính "một file JSON duyệt bằng mắt" hiện có (giờ là một thư mục nhiều file nhỏ)
— đổi lấy đúng một đảm bảo nguyên tử thật. Ở quy mô agent này (vài trăm-nghìn sự kiện), số file
nhỏ không phải vấn đề (`ls store/idempotency/ | wc -l` vẫn xem được, chỉ không "một file, một cái
nhìn" như trước). **Không giữ song song bản cũ** — thay hẳn, tránh có hai cơ chế cùng làm một
việc (một cái đúng, một cái sai) dễ gây nhầm lẫn sau này. `store/idempotency.json` hiện tại chỉ
có vài dòng dữ liệu test — bỏ luôn, không cần script di chuyển.

### KHÔNG áp dụng lại cùng kiểu "file độc quyền" cho `RuleStore` (rules.json) — và vì sao

`rules.json` khác `idempotency`: một transferId chỉ CLAIM MỘT LẦN DUY NHẤT (khớp hoàn hảo với
`wx` — tạo-một-lần-rồi-thôi), còn `rule.state` (fireCount, cooldown, cửa sổ rate-limit) bị SỬA
LẶP LẠI suốt vòng đời luật — không khớp mẫu "tạo độc quyền". Làm một khoá tương tự cho từng lần
sửa `rule.state` cần khoá đọc-sửa-ghi thật (không có API `fs` thuần nào cho việc này), tức phải
thêm khoá file/thư viện ngoài — chi phí thật cho một rủi ro mà **Tầng 1 đã lo**: nếu chỉ MỘT
tiến trình sống (đúng bất biến Tầng 1 buộc), *đọc-sửa-ghi trong bộ nhớ rồi ghi cả mảng ra file*
(cách `RuleStore` đang làm) là AN TOÀN — không có ai khác cạnh tranh ghi. Cơ chế 2a (hàng đợi
tuần tự) đã đóng luôn lỗ hổng xen kẽ TRONG một tiến trình. Thêm một lớp khoá file cho
`RuleStore` là giải quyết lại một vấn đề tầng khác đã lo — không làm, đúng tinh thần không thêm
phức tạp cho thứ tầng dưới đã chặn.

---

## Ranh giới đảm bảo — nói thẳng, không tô vẽ

**Được đảm bảo (sau khi làm đủ Tầng 1 + Tầng 2):**
- Một tiến trình khác không thể khởi động khi một tiến trình còn sống thật trên cùng ví (Tầng 1,
  trừ rủi ro PID-tái-sử-dụng cực hiếm đã nêu, thiên về từ chối nhầm hơn bỏ sót).
- Trong MỘT tiến trình: hai sự kiện không bao giờ xen kẽ xử lý — luôn tuần tự (2a).
- Một `transfer.id` cụ thể không bao giờ bị hành động hai lần — kể cả nếu (giả sử) có hai tiến
  trình cùng sống, claim nguyên tử vẫn chặn đúng RỦI RO A cho sự kiện đó (2b) — đây là lớp
  phòng thủ chiều sâu, không phụ thuộc Tầng 1 phải đúng tuyệt đối.

**KHÔNG được đảm bảo (giới hạn còn lại, chấp nhận có chủ đích):**
- NẾU Tầng 1 thủng thật (hai tiến trình cùng sống) VÀ hai sự kiện KHÁC NHAU cùng khớp MỘT luật,
  mỗi tiến trình xử lý một sự kiện của RIÊNG NÓ — cả hai claim thành công (khác `transferId`,
  claim 2b không ngăn được) — `rule.state` (rate-limit, cooldown) của luật đó có thể bị ghi đè
  qua lại giữa hai tiến trình, dẫn tới đếm sai hoặc bắn vượt giới hạn đã đặt. Giải quyết TRỌN VẸN
  case này cần trạng thái dùng chung có giao dịch thật (một tiến trình canh giữ duy nhất kiểu
  actor, hoặc CSDL có transaction) — vượt quá mức cần thiết cho một agent chạy trên testnet.
  **Quyết định: chấp nhận giới hạn này, vì Tầng 1 đã biến "hai tiến trình cùng sống" thành sự
  kiện HIẾM VÀ ĐƯỢC PHÁT HIỆN NGAY** (từ chối khởi động ầm ĩ) thay vì trạng thái ổn định âm thầm
  như sự cố vừa xảy ra — rủi ro còn lại chỉ tồn tại trong khoảng thời gian cực ngắn (nếu có) chứ
  không kéo dài hàng giờ như đã xảy ra thật.

## Sự cố vừa rồi — nếu có thiết kế này thì sao?

Đi lại chính xác mốc thời gian: khi tiến trình test split (`bclzkb7mm`) khởi động lúc 15:09:28,
`initWallet()` sẽ đọc `data/agent/agent.lock`, thấy PID của một trong các tiến trình rò rỉ
(20:56 hoặc 20:58 local), gọi `process.kill(pid, 0)` → KHÔNG ném lỗi (PID đó thật sự còn sống,
đã xác nhận bằng `Get-CimInstance`) → **từ chối khởi động ngay lập tức**, in rõ PID/thời điểm/
hướng dẫn xoá tay nếu chắc chắn. Tôi sẽ phát hiện sự cố NGAY tại đây — trước khi tốn 15+ phút
điều tra qua đối soát balance/log, và trước khi có thêm tiền thật bị gửi ngoài ý muốn.

---

## Việc cần làm khi được duyệt (liệt kê để bạn thấy phạm vi, chưa code)

- `src/wallet/process-lock.ts` (mới): `acquireProcessLock(lockPath)` / `releaseLock()`.
- `src/wallet/init.ts`: gọi chiếm khoá đầu `initWallet()`; trả `WalletHandle.release()`; đăng ký
  `process.on('exit', ...)` dọn khoá đồng bộ.
- `src/rules/idempotency.ts`: viết lại theo `tryClaim()` nguyên tử, thư mục thay vì một file.
- `src/rules/engine.ts`: thêm `runExclusive()`, đổi `handleIncomingTransfer` đi qua nó; đổi sang
  gọi `tryClaim()` thay `isProcessed()`+`markProcessed()`.
- Xoá `store/idempotency.json` cũ (dữ liệu test, không cần di chuyển).
- Cập nhật `test/engine.test.ts` cho API mới của idempotency; thêm test cho `runExclusive()` (mô
  phỏng hai sự kiện xen kẽ, xác nhận tuần tự) và cho `tryClaim()` (mô phỏng claim trùng, xác nhận
  chỉ một bên thắng).

---

➤ Chờ duyệt thiết kế hai tầng này trước khi code. Chưa đụng phần còn lại của Giai đoạn 3.
