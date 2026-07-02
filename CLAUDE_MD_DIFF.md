# CLAUDE.md — Diff Report (Việc 1)

Nguồn: verify trực tiếp `.d.ts` của `@unicitylabs/sphere-sdk@0.11.0` đã cài trong
`node_modules/` (Giai đoạn 0). Mục tiêu: sửa các chỗ CLAUDE.md mô tả sai/thiếu so với API thật,
và ghim lại sự thật đã verify để các phiên sau không phải khám phá lại.

Tất cả thay đổi áp dụng trong file `CLAUDE.md` ở gốc repo. Không có thay đổi nào ngoài file này.

---

## 1. [MỚI] Thêm mục "0. Sự thật API đã xác minh (SDK 0.11.0)"

**Vị trí:** ngay sau dòng `---` đầu file, trước mục "1. Sản phẩm là gì".

**Trước:** không tồn tại.

**Sau:** mục mới ghim lại toàn bộ những gì đã verify qua `.d.ts`, để tránh phiên sau phải dò
lại từ đầu:
- Version SDK thật đã cài: `0.11.0` (không phải `0.9.x-dev`).
- Bảng endpoint/key testnet2 (network, oracle.apiKey, gateway, wallet-api, nostr relay).
- Chữ ký hàm đã xác nhận: `createNodeProviders`, `createOwnStorageWalletApiProviders`,
  `Sphere.init`, `payments.send`, `mintFungibleToken`, `receive`, `getBalance`/`getAssets`,
  `resolve`, `on`.
- Type `IncomingTransfer` / `Token` đầy đủ — chỉ rõ số tiền nằm ở `tokens[]`, không phải
  `transfer.amount`.
- Bảng 5 sự kiện (`transfer:incoming|confirmed|failed|delivery_pending|invalid`) + payload.
- Danh sách `SphereErrorCode`.

**Lý do:** đây là toàn bộ phát hiện của Giai đoạn 0. Ghim thành một mục riêng, đặt đầu file, để
nó là điểm tra cứu đầu tiên thay vì nằm rải rác trong báo cáo chat sẽ mất khi qua phiên mới.

---

## 2. [SỬA] Mục 4.1 — Mô hình ví: một lớp provider → hai lớp provider + chốt custody

**Trước:**
```
- Agent init ví qua `Sphere.init` + `createNodeProviders` (`@unicitylabs/sphere-sdk/impl/nodejs`).
- **TUYỆT ĐỐI KHÔNG** dùng Connect / ConnectClient / autoConnect. ...
- SDK tự persist ví + token ra file qua `dataDir` / `tokensDir` (per-address, network-scoped).
```

**Sau:**
```
- Init ví là HAI lớp provider, không phải một:
  1. Base: createNodeProviders({ network, dataDir, tokensDir, oracle: { apiKey } })
     → CHỈ base thôi CHƯA ĐỦ: không có `delivery` → ví không gửi/nhận được transfer v2,
       và KHÔNG báo lỗi gì khi thiếu (hỏng âm thầm).
  2. wallet-api rails: createOwnStorageWalletApiProviders(base, { baseUrl, network, deviceId })
     → cho delivery (mailbox) + walletApi (client). Custody CHỐT = own-storage ('external').
  3. Sphere.init({ ...base, delivery, walletApi, autoGenerate: true, nametag? }).
- (giữ nguyên) TUYỆT ĐỐI KHÔNG dùng Connect / ConnectClient / autoConnect.
- SDK tự persist ví ra dataDir + token ra tokensDir (own-storage). THÊM: tokensDir giữ tài sản
  thật → khi deploy VPS/container PHẢI dùng volume bền + backup định kỳ.
```

**Lý do:** `createNodeProviders` chỉ trả về base bundle (`storage/tokenStorage/transport/oracle`)
— không có `delivery`. Thiếu bước 2, ví KHÔNG báo lỗi nhưng cũng không gửi/nhận được transfer
v2 (cạm bẫy số 1 theo README bản 0.11.0). Custody chốt = own-storage theo quyết định của người
dùng: agent tự chủ phải tự giữ tài sản của mình, không giao server giữ hộ.

---

## 3. [SỬA] Mục 4.2 — Ràng buộc #2 (memo): đổi lý do + thêm ràng buộc #2 mới (tokens[])

**Trước (ràng buộc #2 cũ, nay là #3):**
```
2. Sự kiện tiền vào KHÔNG mang memo/ghi chú. KHÔNG thiết kế luật lọc theo nội dung ghi chú
   của tiền đến. Chỉ lọc theo người gửi và số lượng. (Khi GỬI thì có thể đính memo — bất đối
   xứng này là có chủ đích.)
```

**Sau (ràng buộc #3):**
```
3. KHÔNG dùng nội dung memo của tiền vào để điều khiển chi tiền, dù IncomingTransfer.memo? CÓ
   tồn tại trong type (đã verify .d.ts, bản 0.11.0). Lý do KHÔNG phải "trường không tồn tại" —
   mà vì memo do chính người gửi tự điền, không có gì đảm bảo tính toàn vẹn/chống giả mạo của
   nó. Một trường tồn tại trong type không đồng nghĩa nó đến nơi đủ đáng tin để làm căn cứ chi
   tiền. Chỉ lọc luật theo người gửi (xác thực qua pubkey) và số lượng.
   (Khi GỬI thì agent có thể tự đính memo — bất đối xứng có chủ đích: kiểm soát được nội dung
   mình viết ra, không kiểm soát được nội dung người khác viết vào.)
```

**Thêm mới (ràng buộc #2):**
```
2. Số tiền của một transfer đến nằm trong IncomingTransfer.tokens[], KHÔNG có transfer.amount /
   transfer.coinId ở cấp ngoài (khác ví dụ rút gọn trong README SDK). Muốn biết tổng tiền vào +
   loại coin → duyệt tokens[], gom theo coinId, cộng amount bằng BigInt.
```

Tiêu đề mục đổi từ "Hai ràng buộc dễ sai" → "Ba ràng buộc dễ sai".

**Lý do:**
- **Memo:** `.d.ts` cho thấy `IncomingTransfer.memo?: string` CÓ tồn tại — khẳng định cũ
  ("không mang memo") sai sự thật, sẽ gây nhầm nếu ai đó đọc code SDK và thấy field này rồi nghi
  ngờ toàn bộ tài liệu. Giữ nguyên KẾT LUẬN (không dùng memo để chi tiền) nhưng sửa LÝ DO cho
  đúng và chắc hơn: vấn đề là độ tin cậy/chống giả mạo, không phải sự tồn tại của field. Lý do
  đúng thì mới áp dụng nhất quán được cho các trường hợp biên sau này.
- **tokens[]:** README của SDK có đoạn ví dụ dùng `t.amount`/`t.coinId` ở cấp transfer trong
  callback `receive()` — nhưng type thật `IncomingTransfer` không có 2 trường đó ở cấp ngoài,
  chỉ có `tokens: Token[]`. Đây là chỗ dễ code sai nhất khi build Action Executor/Rule Matcher
  đọc số tiền vào, nên nâng thành ràng buộc ghim riêng thay vì chỉ nói trong mục 0.

---

## 4. [SỬA] Mục 4.6 — Event Listener: bỏ ngộ nhận "nghe ws Nostr"

**Trước:**
```
├─ Event Listener   (nghe tiền vào / thất bại)
```
(không có ghi chú gì thêm; CLAUDE.md gốc dùng chữ "ws" ở mục 4.6 ngữ cảnh thành phần, ngầm định
observer sẽ tự nối socket Nostr để nghe tiền vào)

**Sau:**
```
├─ Event Listener   (sphere.on('transfer:incoming' | 'transfer:failed' | ...))
```
+ Thêm đoạn giải thích ngay dưới sơ đồ:
```
Event Listener KHÔNG lắng nghe socket ws Nostr trực tiếp. Trong v2, transfer được token-engine
chứng thực on-chain rồi giao qua wallet-api mailbox (DeliveryProvider) — Nostr chỉ còn lo
messaging/nametag, KHÔNG PHẢI đường đi của tiền. Event Listener chỉ cần sphere.on('transfer:
incoming', handler) (+ 'transfer:failed', 'transfer:delivery_pending' cho fail-safe) — SDK tự
lo polling/wake nền qua delivery port.
```

**Lý do:** README bản 0.11.0 nói rõ "Delivery is a port, not Nostr" — v2 chuyển token qua
wallet-api mailbox, không qua relay Nostr như v1. Nếu không sửa, phiên code Giai đoạn 3 (Event
Listener always-on) có thể đi tự viết code quản lý ws Nostr để "nghe tiền vào" — sai tầng, và
lãng phí công sức vì SDK đã tự lo việc này qua event `transfer:incoming`.

---

## 5. [SỬA] Mục 5 — Version SDK trong đoạn mở đầu

**Trước:**
```
Kiến thức nền về SDK này KHÔNG đáng tin — SDK ở bản `0.9.x-dev`, thay đổi thường xuyên.
**KHÔNG code API theo trí nhớ.** ...
```

**Sau:**
```
Kiến thức nền về SDK này KHÔNG đáng tin — bản đã cài thực tế là `0.11.0` (xem mục 0; phỏng đoán
ban đầu `0.9.x-dev` đã SAI, lệch xa), và SDK còn tiếp tục thay đổi. **KHÔNG code API theo trí
nhớ — kể cả trí nhớ từ mục 0, nếu bản cài lúc đó đã khác.** ...
```

**Lý do:** số hiệu version cũ trong CLAUDE.md sai theo thực tế đã verify; nếu không sửa, phiên
sau đọc "0.9.x-dev" sẽ hạ thấp mức tin cậy sai chỗ (nghĩ SDK cũ hơn thực tế) hoặc bối rối khi
thấy `npm ls` ra 0.11.0. Thêm câu nhắc "kể cả trí nhớ từ mục 0" để mục 0 không bị hiểu lầm là
chân lý vĩnh viễn — nó là ảnh chụp, không phải nguồn sống.

---

## 6. [THÊM] Mục 5 — câu dẫn ngược về mục 0 sau checklist "cần tra và xác nhận"

**Thêm cuối danh sách checklist (sau dòng về `sphere.resolve`):**
```
→ Đã verify cho bản `0.11.0` — xem mục 0. Nếu `npm ls @unicitylabs/sphere-sdk` cho version
khác, coi mục 0 là NGHI VẤN và re-verify lại toàn bộ danh sách trên trước khi code tiếp.
```

**Lý do:** checklist gốc là hướng dẫn "cần tra những gì trước khi code" — viết cho Giai đoạn 0
khi chưa có câu trả lời. Giờ đã có câu trả lời (mục 0), nhưng checklist vẫn hữu ích làm điểm
re-verify nếu SDK bump version sau này. Câu dẫn giúp người đọc biết đi đâu lấy câu trả lời hiện
tại, và biết khi nào phải nghi ngờ câu trả lời đó.

---

## 7. [SỬA] Mục 6 — bỏ khẳng định sai về `.env.example` của SDK

**Trước:**
```
- **oracle.apiKey:** BẮT BUỘC khi init. Key testnet2 KHÔNG phải bí mật — lấy từ `.env.example`
  của SDK. Đưa vào `.env` của project qua dotenv. KHÔNG hardcode, KHÔNG commit `.env`.
```

**Sau:**
```
- **oracle.apiKey:** BẮT BUỘC khi init. Key testnet2 KHÔNG phải bí mật — **bản npm đã cài KHÔNG
  kèm `.env.example`** (đã kiểm tra, không có file này trong package); key được công bố thẳng
  trong README của bản đã cài, giá trị đã ghim sẵn ở mục 0. Đưa vào `.env` của project qua
  dotenv. KHÔNG hardcode trong source, KHÔNG commit `.env`.
```

**Lý do:** đã kiểm tra trực tiếp `node_modules/@unicitylabs/sphere-sdk/` — không có file
`.env.example` nào được đóng gói trong bản npm 0.11.0. Nếu giữ nguyên câu cũ, phiên sau sẽ tốn
thời gian tìm một file không tồn tại. Key thật nằm trong README (đã copy vào mục 0).

---

## Tổng kết phạm vi thay đổi

| Mục | Loại thay đổi |
|---|---|
| Mục 0 (mới) | Thêm — ghim toàn bộ API đã verify |
| 4.1 | Sửa — 2 lớp provider, custody own-storage, cảnh báo tokensDir |
| 4.2 | Sửa — đổi lý do memo, thêm ràng buộc tokens[], đổi "Hai" → "Ba ràng buộc" |
| 4.6 | Sửa — Event Listener dùng sphere.on(), không phải ws Nostr |
| 5 (đoạn mở) | Sửa — version 0.9.x-dev → 0.11.0 |
| 5 (checklist) | Thêm — câu dẫn về mục 0 |
| 6 | Sửa — bỏ khẳng định sai về .env.example |

Không thay đổi: mục 1, 2, 3, 4.3, 4.4, 4.5, 5b, 7, 8, 9, 10, 11 — các mục này mô tả sản phẩm/
quy trình/tiêu chí cuộc thi, không phụ thuộc chữ ký API nên không có gì để sửa theo phát hiện
Giai đoạn 0.
