# CLAUDE.md — Conditional Payment Agent (Unicity Builder Program)

Đây là ngữ cảnh dự án cho Claude Code. Đọc kỹ trước khi làm việc trong repo này.
File này mô tả **sản phẩm, kiến trúc, và các ràng buộc**. Nó KHÔNG phải là tài liệu API
của SDK — API thật lấy từ type definitions của bản SDK đã cài (xem mục "Nguồn chân lý API").

---

## 0. Sự thật API đã xác minh (SDK 0.11.0) — ĐỌC TRƯỚC, đừng khám phá lại

Đã verify trực tiếp qua `.d.ts` của bản cài thật (Giai đoạn 0 triển khai, xem quy trình ở mục 5).
Ghim ở đây để các phiên sau không phải dò lại từ đầu. Đây là ẢNH CHỤP tại thời điểm verify —
nếu bản SDK cài sau này khác bản dưới đây, coi mục này là NGHI VẤN, tin `.d.ts` mới, và cập
nhật lại mục này.

**Bản đã cài:** `@unicitylabs/sphere-sdk@0.11.0` (KHÔNG phải `0.9.x-dev` như phỏng đoán ban đầu).

**Testnet2 (public, không phải bí mật):**

| Mục | Giá trị |
|---|---|
| Network | `testnet` (alias `testnet2`), networkId **4** |
| `oracle.apiKey` | `sk_ddc3cfcc001e4a28ac3fad7407f99590` |
| Gateway (token engine) | `https://gateway.testnet2.unicity.network` |
| wallet-api (delivery + custody) | `https://wallet-api.unicity.network` |
| Nostr relay (messaging/nametag) | `wss://nostr-relay.testnet.unicity.network` |

**Chữ ký hàm đã xác nhận trong `.d.ts`:**
```ts
createNodeProviders(config?: NodeProvidersConfig): NodeProviders
//   NodeProvidersConfig: { network?, dataDir?, tokensDir?, transport?, oracle?: { apiKey?, trustBasePath? }, ... }
//   NodeProviders trả về: { storage, tokenStorage, transport, oracle, price? }  ← KHÔNG có delivery!

createOwnStorageWalletApiProviders<B>(base, cfg): B & { delivery, walletApi }
//   cfg (WalletApiCompositionConfig): { baseUrl, network, deviceId?, stateStore?, ... }
//   custody 'external' — app tự giữ token (tokensDir), wallet-api chỉ làm rail giao hàng.
//   (createWalletApiProviders = bản custody 'inventory', server giữ token — KHÔNG dùng, xem mục 4.1)

Sphere.init(options): Promise<{ sphere, created, generatedMnemonic? }>
//   options cần: { storage, transport, oracle, delivery, walletApi, mnemonic?, autoGenerate?, nametag?, password? }

sphere.payments.send(request: TransferRequest): Promise<TransferResult>
//   TransferRequest: { coinId, amount: string (base units), recipient, memo?, addressMode? }
//   TransferResult:  { id, status, tokens, error?, deliveryPending?, deliveryState? }
//   TransferStatus = 'pending'|'submitted'|'confirmed'|'delivered'|'completed'|'failed'
//   status === 'completed' = thành công. deliveryPending === true = THÀNH CÔNG (giao hàng hoãn), KHÔNG PHẢI lỗi.
//   send() ném SphereError cho lỗi thật (INSUFFICIENT_BALANCE, INVALID_RECIPIENT, ...).

sphere.payments.mintFungibleToken(coinIdHex: string, amount: bigint):
    Promise<{success:true, token, tokenId} | {success:false, error}>

sphere.payments.receive(_opts?, cb?): Promise<{ transfers: IncomingTransfer[] }>
//   _opts đã deprecated/ignored — tiền vào tự động qua delivery port; receive() chỉ để "drain" thủ công.

sphere.payments.getBalance(coinId?): Asset[]         // ĐỒNG BỘ, không await
sphere.payments.getAssets(coinId?): Promise<Asset[]> // async, kèm giá fiat nếu có price provider

sphere.resolve(identifier): Promise<PeerInfo | null>
//   PeerInfo: { nametag?, transportPubkey, chainPubkey, directAddress, timestamp }

sphere.on(type, handler): () => void
```

**Kiểu dữ liệu tiền-vào — QUAN TRỌNG, khác ví dụ rút gọn trong README SDK:**
```ts
interface IncomingTransfer {
  id: string
  senderPubkey: string
  senderNametag?: string
  tokens: Token[]        // ← số tiền + coinId nằm Ở ĐÂY, KHÔNG có transfer.amount/transfer.coinId
  memo?: string          // ← CÓ tồn tại trong type; xem mục 4.2 vì sao KHÔNG dùng để chi tiền
  receivedAt: number
}
interface Token { id, coinId, symbol, decimals, amount: string, status, ... }
```
Muốn biết "tiền vào bao nhiêu, loại gì" → duyệt `transfer.tokens[]`, gom theo `coinId`, cộng
`amount` bằng BigInt.

**Sự kiện (`sphere.on`):**

| Event | Payload | Ý nghĩa |
|---|---|---|
| `transfer:incoming` | `IncomingTransfer` | Tiền vào — trigger chính cho Rule Matcher |
| `transfer:confirmed` | `TransferResult` | Gửi đi đã xác nhận on-chain |
| `transfer:failed` | `TransferResult` | Gửi đi thất bại thật — dùng cho fail-safe |
| `transfer:delivery_pending` | `TransferResult` | Đã chứng thực on-chain, giao hàng hoãn — KHÔNG PHẢI lỗi |
| `transfer:invalid` | `{ deliveryId, senderPubkey?, reason }` | Tiền vào rớt verify cục bộ |

**Mã lỗi (`SphereError.code`):** `INSUFFICIENT_BALANCE`, `SEND_INSUFFICIENT_BALANCE`,
`INVALID_RECIPIENT`, `INVALID_AMOUNT`, `TRANSFER_FAILED`, `TRANSFER_CONFLICT`, `RATE_LIMITED`,
`TIMEOUT`, `NETWORK_ERROR`, `AGGREGATOR_ERROR`, `INVALID_CONFIG`, `SEND_QUEUE_TIMEOUT/FULL`, …
(danh sách đầy đủ trong `.d.ts`, type `SphereErrorCode`).

**Nguyên tắc:** khi `.d.ts` của bản đã cài lệch với bảng trên → TIN `.d.ts`, cập nhật lại mục
này, không im lặng dùng thông tin cũ.

## 1. Sản phẩm là gì

**Conditional Payment Agent** — một "IFTTT / Zapier cho tiền P2P" chạy trên Unicity
Testnet v2, dự thi **Unicity Builder Program, Track 01 (Autonomous Agents)**.

Một agent chạy nền (Node.js) giữ ví Sphere của riêng nó, lắng nghe sự kiện tiền vào,
và khi một **luật** người dùng đã cấu hình được thỏa, agent **tự động** thực thi hành động
chuyển tiền — không có con người bấm nút cho mỗi hành động.

Ví dụ luật:
- "Khi @agent nhận tiền từ @client → tự chuyển 10% cho @partner."
- "Khi số dư vượt 500 → tự quét phần dư sang ví tiết kiệm."
- "Khi nhận bất kỳ khoản nào ≥ 1 token → chia 70/20/10 cho ba ví."

## 2. Tại sao build này (bối cảnh cuộc thi)

- **Track 01 — Autonomous Agents**, mỗi track thưởng tối đa 20.000 XP, thưởng scale theo
  chất lượng + impact.
- **Agentic bonus** (được nhấn mạnh là "significant"): agent phải tự khởi tạo VÀ hoàn thành
  hành động kinh tế mà KHÔNG có human-in-the-loop mỗi hành động. Con người chỉ đặt mục tiêu
  và giới hạn ban đầu. → Đây là lý do build này giá trị: nó tự-quan-sát → tự-quyết → tự-thực-thi.
- **AstridOS bonus**: build chạy trên AstridOS được cộng điểm (giai đoạn sau).

### Định nghĩa "agentic" phải thỏa (in đậm trong đầu khi thiết kế)
Agent quyết định KHI NÀO hành động, tự khớp điều kiện, và thực thi theo chương trình.
App nào cần người bấm "send" mỗi lần → là build hợp lệ nhưng KHÔNG được agentic bonus.
**Mọi quyết định của agent này phải tự động, không modal phê duyệt.**

## 3. Nguyên tắc thiết kế cốt lõi

1. **KHÔNG dùng LLM.** Toàn bộ logic là DETERMINISTIC (số học + if-then). Rẻ, đáng tin,
   dễ audit, không rủi ro "ảo giác" khi xử lý tiền. Không tích hợp LLM vào lõi.
2. **Ví HEADLESS, tự chủ.** Agent tự sở hữu ví, tự ký, tự gửi. KHÔNG dùng Connect protocol.
3. **An toàn tiền bạc là ưu tiên số 1.** Thà không hành động còn hơn hành động sai.
4. **Mọi hành động phải để lại dấu vết audit** (log + về sau là audit chain của Astrid).

## 4. Kiến trúc (đã chốt qua nghiên cứu — BUILD cái này, đừng redesign)

### 4.1 Mô hình ví: HEADLESS, KHÔNG Connect
- Init ví là **HAI lớp provider, không phải một** (xác nhận qua `.d.ts`, chi tiết ở mục 0):
  1. **Base**: `createNodeProviders({ network, dataDir, tokensDir, oracle: { apiKey } })`
     (`@unicitylabs/sphere-sdk/impl/nodejs`) — cho `storage` + `tokenStorage` + `transport` +
     `oracle`. **CHỈ base thôi CHƯA ĐỦ**: base KHÔNG có `delivery` — ví sẽ KHÔNG gửi/nhận được
     transfer v2, và **không báo lỗi gì khi thiếu** (hỏng âm thầm, đây là cạm bẫy dễ sập nhất).
  2. **wallet-api rails**: bọc thêm `createOwnStorageWalletApiProviders(base, { baseUrl, network,
     deviceId })` (`@unicitylabs/sphere-sdk/impl/shared/wallet-api`) để có `delivery` (mailbox)
     + `walletApi` (client). Custody đã CHỐT = **own-storage** (`'external'`): agent tự giữ token
     ở `tokensDir` local, wallet-api chỉ làm rail giao hàng — không giao tài sản cho server giữ
     hộ. Lý do chốt: agent tự chủ phải tự giữ tài sản của mình — đúng tinh thần headless/auditable
     và là bằng chứng agentic mạnh hơn trước reviewer. (SDK còn có `createWalletApiProviders`,
     custody `'inventory'`, server giữ token — KHÔNG dùng cho dự án này.)
  3. `Sphere.init({ ...base, delivery, walletApi, autoGenerate: true, nametag? })`.
- **TUYỆT ĐỐI KHÔNG** dùng Connect / ConnectClient / autoConnect. Connect là để dApp mượn ví
  người dùng và mỗi thao tác bật modal phê duyệt → phá vỡ tính tự chủ, mất agentic bonus.
- SDK tự persist ví ra `dataDir` và token ra `tokensDir` (per-address, network-scoped, own-storage).
  **`tokensDir` giữ tài sản thật của agent** — khi deploy (VPS/container) thư mục này PHẢI nằm
  trên volume bền (không ephemeral) và nên có backup định kỳ. Mất `tokensDir` = mất token thật.

### 4.2 Ba ràng buộc dễ sai — LUÔN nhớ
1. **`amount` là base units dạng STRING** (đơn vị nhỏ nhất), KHÔNG phải số token người dùng.
   Mọi phép tính tỷ lệ % PHẢI dùng **BigInt** (chia số nguyên), KHÔNG dùng float — tránh
   mất/tạo tiền do làm tròn. (Hàm mint nhận `bigint`.)
2. **Số tiền của một transfer đến nằm trong `IncomingTransfer.tokens[]`, KHÔNG có
   `transfer.amount` / `transfer.coinId` ở cấp ngoài** (khác ví dụ rút gọn trong README SDK —
   xem mục 0). Muốn biết tổng tiền vào + loại coin → duyệt `tokens[]`, gom theo `coinId`, cộng
   `amount` bằng BigInt.
3. **KHÔNG dùng nội dung memo của tiền vào để điều khiển chi tiền**, dù `IncomingTransfer.memo?`
   CÓ tồn tại trong type (đã verify qua `.d.ts`, bản 0.11.0 — xem mục 0). Lý do KHÔNG phải "trường
   không tồn tại" — mà vì **memo do chính người gửi tự điền, không có gì đảm bảo tính toàn vẹn
   hay chống giả mạo của nó**. Một trường tồn tại trong type không đồng nghĩa nó đến nơi đủ đáng
   tin để làm căn cứ chi tiền. Chỉ lọc luật theo **người gửi** (danh tính, xác thực qua pubkey)
   và **số lượng** — hai thứ agent có thể tin. (Khi GỬI thì agent có thể tự đính memo — bất đối
   xứng này có chủ đích: ta kiểm soát được nội dung mình viết ra, không kiểm soát được nội dung
   người khác viết vào.)
   - Muốn phân biệt mục đích của tiền vào → dùng **địa chỉ HD / nametag khác nhau** cho từng
     luồng (SDK hỗ trợ nhiều địa chỉ, mỗi địa chỉ 1 nametag). Ví dụ tiền vào @agent-tips khác
     tiền vào @agent-split. Danh tính người nhận (nametag/địa chỉ) là thứ chắc chắn; nội dung
     ghi chú thì không.

### 4.3 Mô hình dữ liệu Rule
```
Rule {
  id:       string
  enabled:  boolean
  trigger:
    | { type: 'onIncoming', fromSender?: string, minIncoming?: string }
    | { type: 'onBalanceAbove' | 'onBalanceBelow', threshold: string, coinId: string }
    | { type: 'onSchedule', cron: string }   // loại yếu — không nên đứng một mình
  action:
    | { type: 'forward', to: string, percent?: number, fixedAmount?: string, coinId: string, memo?: string }
    | { type: 'split', splits: Array<{ to: string, percent: number }>, coinId: string }
    | { type: 'notify', to: string, message: string }
  guards:
    minAmount?:          string   // bỏ qua khoản nhỏ hơn ngưỡng
    maxTriggersPerHour?: number   // trần cứng số lần kích hoạt
    excludeSenders?:     string[] // KHÔNG kích hoạt với các nguồn này
    cooldownSeconds?:    number   // thời gian tối thiểu giữa 2 lần chạy cùng luật
  state:
    lastFiredAt?: number
    fireCount:    number
}
```

### 4.4 Ba cơ chế an toàn BẮT BUỘC (reviewer sẽ soi đúng chỗ này)
1. **Chống vòng lặp vô hạn:** tự động thêm nametag của chính agent + mọi đích của luật vào
   `excludeSenders`; áp `maxTriggersPerHour` làm trần cứng; bỏ qua khoản `< minAmount`.
2. **Idempotency:** mỗi transfer đến có định danh ổn định → lưu "đã xử lý" ra file; nếu cùng
   sự kiện đến lại (reconnect / restart giữa chừng) thì KHÔNG chi tiền hai lần.
3. **Fail-safe:** dựa DUY NHẤT vào kết quả của chính lệnh `send()` mà Action Executor gọi —
   `status: 'failed'` trả về, hoặc lỗi bị ném (`SphereError`/`WalletApiError`) — thì KHÔNG
   đánh dấu luật đã chạy, ghi log để retry có kiểm soát. **KHÔNG dùng sự kiện `transfer:failed`
   làm căn cứ quyết định** — đã verify thật ở Giai đoạn 2 (xem PHASE0_VERIFIED_API.md mục 7):
   sự kiện này CÓ THỂ nổ ra cho một lần thử trung gian mà SDK tự chữa lành (self-healing coin
   selection, tối đa 8 lần re-plan) rồi vẫn thành công — nghe event để quyết định sẽ chặn nhầm
   một luật THỰC RA đã thành công. Event `transfer:failed` chỉ dùng để LOG/quan sát. Không bao
   giờ nuốt lỗi im lặng.

### 4.5 State người dùng tự lưu (ngoài phần SDK tự lo)
SDK tự persist ví + token. Bạn PHẢI tự persist thêm, ra file JSON, đọc lại khi khởi động:
- **Rule Store** — danh sách luật + state mỗi luật.
- **Idempotency log** — các event tiền vào đã xử lý.

### 4.6 Các thành phần
```
Dashboard (web tối giản)  ──►  Rule Store (file JSON)
                                     │
Agent Core (Node.js)                 ▼
  ├─ Event Listener   (sphere.on('transfer:incoming' | 'transfer:failed' | ...))
  ├─ Scheduler        (cho luật theo lịch)
  ├─ Rule Matcher     (khớp luật với sự kiện)
  ├─ Guard Check      (minAmount / rate limit / chống loop / cooldown / idempotency)
  └─ Action Executor  (thực thi chuyển tiền, đính memo, xử lý theo trạng thái trả về)
        │
        ▼
  Sphere SDK  (ví testnet2 của agent — init/send/receive/mint/on/resolve/getBalance)
```

**Event Listener KHÔNG lắng nghe socket ws Nostr trực tiếp.** Trong v2, một transfer được
token-engine chứng thực on-chain rồi giao qua **wallet-api mailbox** (`DeliveryProvider`, lớp
own-storage rails ở mục 4.1) — Nostr trong SDK này chỉ còn lo messaging/nametag, KHÔNG PHẢI
đường đi của tiền. Event Listener chỉ cần đăng ký `sphere.on('transfer:incoming', handler)`
(và `'transfer:failed'`, `'transfer:delivery_pending'` cho fail-safe) — SDK tự lo việc polling/
wake nền qua delivery port.

## 5. Nguồn chân lý API (QUAN TRỌNG)

Kiến thức nền về SDK này KHÔNG đáng tin — bản đã cài thực tế là `0.11.0` (xem mục 0; phỏng đoán
ban đầu `0.9.x-dev` đã SAI, lệch xa), và SDK còn tiếp tục thay đổi. **KHÔNG code API theo trí
nhớ — kể cả trí nhớ từ mục 0, nếu bản cài lúc đó đã khác.** Thứ tự ưu tiên khi cần chữ ký hàm:

1. **Type definitions thật:** `node_modules/@unicitylabs/sphere-sdk/dist/**/*.d.ts` — nguồn
   chân lý cuối cùng. Chính là code sẽ chạy.
2. **README của bản đã cài:** `node_modules/@unicitylabs/sphere-sdk/README.md`.
3. **Tài liệu tham khảo bối cảnh** (nếu có trong repo): các file docs / QUICKSTART-NODEJS.

Nếu các nguồn mâu thuẫn → TIN `.d.ts`. Khi phát hiện lệch quan trọng → báo cho người dùng.

### Các phần API cần tra và xác nhận trước khi code (đừng giả định chữ ký):
- `createNodeProviders(...)` — tham số network, oracle.apiKey, dataDir, tokensDir.
- `Sphere.init(...)` — giá trị trả về, cờ autoGenerate/nametag.
- `sphere.payments.send(...)` — tham số recipient/amount/coinId/memo, và các trạng thái trả về.
- `sphere.payments.mintFungibleToken(...)` — dạng coinId (hex), kiểu amount (bigint).
- Sự kiện tiền vào (`transfer:incoming` hoặc tương đương) — payload có gì (người gửi? tokens?).
- Sự kiện gửi thất bại — để làm fail-safe.
- `sphere.payments.getBalance(...)` / `getAssets(...)` — cho luật theo ngưỡng số dư.
- `sphere.resolve(...)` — phân giải @nametag → thông tin peer.

→ Đã verify cho bản `0.11.0` — xem mục 0. Nếu `npm ls @unicitylabs/sphere-sdk` cho version
khác, coi mục 0 là NGHI VẤN và re-verify lại toàn bộ danh sách trên trước khi code tiếp.

## 5b. Liên kết tham khảo (tra khi cần thông tin)

Khi cần thông tin không có sẵn trong repo hoặc trong `.d.ts`, tra các nguồn chính thức sau
(ưu tiên vẫn theo mục 5: `.d.ts` của bản đã cài > README > docs online > các nguồn khác):

- **Tài liệu Sphere dành cho developer:**
  https://sphere.unicity.network/developers/docs
  (Trang docs dạng SPA — nội dung nạp bằng JS; nếu fetch tĩnh chỉ thấy khung, hãy mở trong
  trình duyệt hoặc tìm mục/route cụ thể. Đây là nơi tra API, hướng dẫn, ví dụ ở mức cao.)

- **Sphere SDK (mã nguồn):**
  https://github.com/unicity-sphere/sphere-sdk
  (Đối chiếu khi cần xem code thật/issue/thay đổi. LƯU Ý: source repo có thể ở nhánh dev khác
  với bản đã publish qua npm — khi lệch, tin `.d.ts` của bản đã cài, không tin source repo.)

- **Unicity Claude Marketplace (plugin cho Claude Code):**
  https://github.com/unicity-sphere/unicity-claude-marketplace
  (Nguồn của plugin `sphere-connect` và các skill liên quan. Hữu ích để hiểu cách Unicity khuyến
  nghị tích hợp — nhưng phần lớn hướng về nhánh **Connect** (dApp↔wallet), KHÔNG phải nhánh
  agent headless của dự án này; đọc có chọn lọc.)

Lưu ý chung: các URL trên có thể thay đổi theo thời gian. Nếu một link không còn đúng, tìm lại
từ trang chủ developer portal thay vì đoán đường dẫn con.

## 6. Môi trường & Setup

- **Node.js >= 22** (SDK yêu cầu).
- Cài: `npm install @unicitylabs/sphere-sdk ws`
- **Mạng:** testnet2 (alias `testnet`). Init BẮT BUỘC khai báo network.
- **oracle.apiKey:** BẮT BUỘC khi init. Key testnet2 KHÔNG phải bí mật — **bản npm đã cài KHÔNG
  kèm `.env.example`** (đã kiểm tra, không có file này trong package); key được công bố thẳng
  trong README của bản đã cài, giá trị đã ghim sẵn ở mục 0. Đưa vào `.env` của project qua
  dotenv. KHÔNG hardcode trong source, KHÔNG commit `.env`.
  (Đây là key gateway của SDK — KHÁC với API key LLM; agent này không cần LLM key.)
- **Token test:** tự mint qua hàm mint của SDK, KHÔNG cần faucet ngoài.

## 7. Chạy trên AstridOS (bonus — GIAI ĐOẠN SAU)

- Đóng gói agent thành capsule chạy trên AstridOS (repo: github.com/unicity-astrid/astrid;
  cài qua `cargo install astrid`; tài liệu "The Astrid Book": github.com/unicity-astrid/book).
- Lợi ích chính: **audit chain chống giả mạo (BLAKE3)** ghi lại mọi hành động → bằng chứng
  agentic mạnh nhất để trình reviewer.
- Agent KHÔNG cần LLM → khi cấu hình Astrid: KHÔNG nạp capsule LLM provider; xác nhận
  `astrid init` không đòi API key LLM lúc boot khi không có capsule LLM.
- **Ưu tiên:** làm lõi agent chạy trên Node thuần TRƯỚC; Astrid là bước sau cùng.

## 8. Dashboard (để reviewer kiểm tra — sau lõi)

Web tối giản: xem/tạo/tắt luật; xem log kích hoạt real-time. Không cần đẹp, cần rõ và LIVE.
Kịch bản reviewer: mở app live → tự gửi tiền tới nametag agent → thấy agent tự phản ứng
trong vài giây → đối chiếu giao dịch trên Unicity Network Explorer (unicity.network).
Kèm hai đường cho reviewer: (a) link app live + kịch bản thao tác; (b) hướng dẫn chạy từ repo.

## 9. Tiêu chí cuộc thi PHẢI thỏa (nếu không sẽ 0 XP)

- CHẠY trên Unicity Testnet v2. Không chạy = 0 XP.
- Repo PUBLIC, đọc & chạy được. App LIVE, publicly viewable.
- DI CHUYỂN GIÁ TRỊ THẬT + exercise network primitives (không chỉ mô phỏng UI).
- KHÔNG phải fork / re-skin / clone không có hành vi gốc.
- Submission gồm: mô tả ngắn; track đã chọn (01); hướng dẫn chạy rõ ràng đối với Testnet v2;
  nêu rõ build CÓ agentic không + CÓ chạy AstridOS không. Nộp qua developers.unicity.network.

## 10. Code style

- TypeScript strict mode. ESM. async/await.
- Ưu tiên `interface` cho object; `readonly` cho thuộc tính bất biến.
- Tính toán tiền: LUÔN BigInt trên base units. Không float cho số tiền.
- Mọi thao tác tiền: try/catch, log rõ ràng, không nuốt lỗi.

## 11. Cách làm việc mong muốn

- VERIFY trước, CODE sau. Đọc `.d.ts` để xác nhận API trước khi gọi hàm.
- Khi cần giá trị chỉ người dùng biết (coinId hex token đã mint, key testnet2, các nametag
  đích) → để `TODO` rõ ràng và HỎI, đừng bịa.
- Làm theo giai đoạn: lõi agent → dashboard → AstridOS. Không ôm hết một lúc.
- Khi không chắc → dừng và hỏi, không đoán (đặc biệt với code động tới tiền).
