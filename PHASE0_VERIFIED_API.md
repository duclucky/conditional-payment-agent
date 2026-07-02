# Phase 0 — Verified API Reference (`@unicitylabs/sphere-sdk@0.11.0`)

Toàn văn mục "0. Sự thật API đã xác minh" trong `CLAUDE.md`, kèm nguồn `.d.ts` (đường dẫn +
số dòng) cho từng chữ ký. Mọi đường dẫn dưới đây tương đối so với gốc repo:
`node_modules/@unicitylabs/sphere-sdk/...`.

Cách đọc: mỗi khối có dòng **Nguồn:** ghi rõ file + số dòng tại thời điểm verify (2026-07-02,
bản `0.11.0`). Nếu `npm ls @unicitylabs/sphere-sdk` cho version khác, coi toàn bộ file này là
NGHI VẤN — mở lại `.d.ts` và re-verify trước khi dùng.

---

## 1. Version & Testnet2 endpoints

**Nguồn:** `dist/impl/nodejs/index.d.ts:6549-6585` (bảng `NETWORKS` + `type NetworkType`);
README dòng 171–188 (bảng endpoint, key công bố công khai); `package.json:3` (`"version": "0.11.0"`).

```ts
declare const NETWORKS: {
  mainnet:  { name: "Mainnet",  aggregatorUrl: "https://aggregator.unicity.network/rpc", ... };
  testnet:  { name: "Testnet2", networkId: 4, aggregatorUrl: "https://gateway.testnet2.unicity.network",
              nostrRelays: ["wss://nostr-relay.testnet.unicity.network"], ... };
  testnet2: { name: "Testnet2", networkId: 4, aggregatorUrl: "https://gateway.testnet2.unicity.network",
              nostrRelays: ["wss://nostr-relay.testnet.unicity.network"], ... };  // giống hệt `testnet`
  dev:      { name: "Development", aggregatorUrl: "https://dev-aggregator.dyndns.org/rpc", ... };
};
type NetworkType = keyof typeof NETWORKS;   // 'mainnet' | 'testnet' | 'testnet2' | 'dev'
```

**`testnet` và `testnet2` là hai key riêng trong `NETWORKS` nhưng cấu hình GIỐNG HỆT nhau**
(cùng `networkId: 4`, cùng `aggregatorUrl`, cùng relay) — dùng key nào cho `NodeProvidersConfig.
network` cũng ra kết quả như nhau. Khuyến nghị: dùng `'testnet2'` (tường minh hơn) xuyên suốt.

| Mục | Giá trị | Nguồn |
|---|---|---|
| `oracle.apiKey` (public) | `sk_ddc3cfcc001e4a28ac3fad7407f99590` | README:181 |
| Gateway (token engine) | `https://gateway.testnet2.unicity.network` | `.d.ts:6561` + README:180 |
| wallet-api (delivery + custody) | `https://wallet-api.unicity.network` | README:182 |
| Nostr relay | `wss://nostr-relay.testnet.unicity.network` | `.d.ts:6562` + README:183 |
| Token registry | `.../unicity-ids.testnet2.json` | `.d.ts:6565` |

**Bản npm đã cài KHÔNG có `.env.example`** — đã kiểm tra `node_modules/@unicitylabs/sphere-sdk/`
(chỉ có `dist/`, `README.md`, `LICENSE`, `package.json` theo trường `files` trong
`package.json:cuối`). Key ở bảng trên lấy từ README, không phải từ `.env.example`.

---

## 2. Base providers — `createNodeProviders`

**Nguồn:** `dist/impl/nodejs/index.d.ts:2912-2929` (`NodeProvidersConfig`), `:2939-2952`
(`NodeProviders`), `:2986` (hàm), `:2794-2797` (`NodeOracleExtensions`), `:2899`
(`NodeOracleConfig`).

```ts
interface NodeProvidersConfig {
  network?: NetworkType;              // preset mạng: 'mainnet'|'testnet'|'testnet2'|'dev'
  debug?: boolean;
  dataDir?: string;                   // thư mục lưu wallet.json
  walletFileName?: string;            // default: 'wallet.json'
  tokensDir?: string;                 // thư mục lưu token (own-storage)
  transport?: NodeTransportConfig;    // Nostr — messaging/nametag, KHÔNG phải rail tiền
  oracle?: NodeOracleConfig;          // { apiKey?, trustBasePath?, url?, timeout? }
  price?: BasePriceConfig;
  tokenSync?: NodeTokenSyncConfig;    // IPFS backup (optional)
}

interface NodeProviders {
  storage: StorageProvider;
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
  transport: TransportProvider;
  oracle: OracleProvider;
  price?: PriceProvider;
  ipfsTokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  groupChat?: GroupChatModuleConfig | boolean;
  market?: MarketModuleConfig | boolean;
  // ← KHÔNG có trường `delivery`. Đây là điểm mấu chốt của Việc 1.
}

declare function createNodeProviders(config?: NodeProvidersConfig): NodeProviders;
```

**Xác nhận lại phát hiện cốt lõi:** `NodeProviders` (kiểu trả về thật, dòng 2939-2952) không có
trường `delivery` ở đâu cả. Base layer chỉ cho storage/tokenStorage/transport/oracle — không đủ
để gửi/nhận transfer v2. Đây là lý do bắt buộc phải có lớp thứ hai (mục 3 dưới đây).

---

## 3. wallet-api rails — `createOwnStorageWalletApiProviders` (ĐÃ CHỐT DÙNG)

**Nguồn:** `dist/impl/shared/wallet-api/index.d.ts:1991-1997` (`SphereBaseProviders`),
`:2014-2036` (`WalletApiCompositionConfig`), `:2037-2049` (`WalletApiProviderExtras`),
`:2055` (`createWalletApiProviders` — KHÔNG dùng), `:2067`
(`createOwnStorageWalletApiProviders` — ĐÃ CHỐT DÙNG).

```ts
interface SphereBaseProviders {   // những gì base bundle (createNodeProviders) phải có
  storage: StorageProvider;
  transport: TransportProvider;
  oracle: OracleProvider;
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
}

interface WalletApiCompositionConfig {
  baseUrl: string;                                        // BẮT BUỘC — xem mục 3.1
  network: string;                                         // BẮT BUỘC — xem mục 3.2 (lưu ý: string thường, không phải NetworkType)
  deviceId?: string;                                       // optional — xem mục 3.3
  client?: WalletApiClient;                                // optional — tái dùng client (test/advanced), bỏ qua cho use-case này
  stateStore?: KeyValueStore;                               // optional — xem mục 3.4
  fetchFn?: FetchLike;                                      // optional, default globalThis.fetch
  webSocketFactory?: WebSocketFactoryLike;                  // optional — xem mục 3.5
  verifyToken?: (blob: TokenBlob) => Promise<boolean>;      // optional, cho recoverRemoved()
}

interface WalletApiProviderExtras {
  delivery: DeliveryProvider;       // ← đây là thứ base layer thiếu
  walletApi: WalletApiClient;       // truyền cho Sphere.init({ walletApi })
}

declare function createOwnStorageWalletApiProviders<B extends SphereBaseProviders>(
  base: B, config: WalletApiCompositionConfig
): B & WalletApiProviderExtras;
```

### 3.1 — `baseUrl`: BẮT BUỘC, không có default trong type

Field khai báo `baseUrl: string;` (không có `?`) — TypeScript sẽ báo lỗi biên dịch nếu thiếu.
Comment tại dòng 2015: *"Backend base URL — https off-loopback (ARCHITECTURE §4, client-enforced)"*
— nghĩa là SDK tự kiểm tra: URL không phải loopback (localhost/127.0.0.1) thì BẮT BUỘC phải là
`https:`, sẽ ném lỗi cấu hình nếu vi phạm (hành vi runtime, không thấy được từ `.d.ts` — suy ra
từ comment, không phải đã chạy thử). Giá trị cần dùng: `https://wallet-api.unicity.network`
(README:72, mục 1 ở trên) — không có default nào được mã hoá sẵn trong type; phải truyền tường
minh, đúng như ví dụ README.

### 3.2 — `network`: BẮT BUỘC, là `string` thường — KHÔNG phải `NetworkType`

Khác với `NodeProvidersConfig.network?: NetworkType` (union hữu hạn `'mainnet'|'testnet'|
'testnet2'|'dev'`), field `network` ở đây là `string` tự do (dòng 2018) — không được TypeScript
ràng buộc giá trị hợp lệ. Comment: *"required end-to-end (ARCHITECTURE §14)"*. Quan trọng hơn:
`WalletApiClient.network` (dòng 1394, `dist/impl/shared/wallet-api/index.d.ts`) ghi rõ giá trị
này **là tiền tố khoá blob phía server**: `<network>/t/<sha256>` (comment §5.2) — tức chuỗi này
đi thẳng vào đường dẫn lưu trữ server-side, phải khớp CHÍNH XÁC với quy ước backend, không phải
chỉ để hiển thị. README dùng `network: 'testnet2'` (chữ thường, không phải `'testnet'`) ở ví dụ
cho lớp wallet-api. **Khuyến nghị: dùng đúng chuỗi `'testnet2'`** cho field này để khớp quy ước
server, dù `'testnet'` cũng là `NetworkType` hợp lệ ở lớp base — hai lớp không bắt buộc phải
dùng cùng chuỗi, nhưng dùng `'testnet2'` cho cả hai là an toàn nhất (không có bằng chứng ngược
lại trong `.d.ts`, chỉ có README làm căn cứ ở field này).

### 3.3 — `deviceId`: OPTIONAL — thiếu KHÔNG hỏng âm thầm, chỉ tốn thêm 1 vòng challenge sign-in

Comment đầy đủ (dòng 2019-2024):
> "Stable per-device label (ARCHITECTURE §4 — one session row per (owner, device); the refresh
> token is stored under it). Pass a persisted value; **when omitted a fresh random label is
> generated per construction, which still works but starts every run with a challenge
> sign-in**."

Trả lời trực tiếp câu hỏi: **KHÔNG giống trường hợp thiếu `delivery`.** Thiếu `delivery` là hỏng
chức năng gửi/nhận mà không báo lỗi (silent breakage). Thiếu `deviceId` thì mọi thứ **vẫn hoạt
động đúng chức năng** — chỉ là mỗi lần agent khởi động lại, nó phải làm lại "challenge sign-in"
(bắt tay xác thực) từ đầu thay vì tái dùng refresh token đã lưu từ lần chạy trước (vì label ngẫu
nhiên mới ≠ label cũ, server thấy như một "device" khác). Đây là chi phí độ trễ khởi động, một
hành vi quan sát được (có network round-trip xác thực thêm mỗi lần restart), không phải lỗi âm
thầm.

**Khuyến nghị cho agent always-on (Giai đoạn 3 sẽ chạy liên tục, thỉnh thoảng restart):** tự sinh
một `deviceId` ổn định một lần (ví dụ UUID) và lưu cùng chỗ với `dataDir`, đọc lại mỗi lần khởi
động — tương tự cách xử lý mnemonic. Không bắt buộc để CHẠY ĐÚNG, nhưng nên làm để tránh challenge
sign-in lặp lại không cần thiết mỗi lần restart.

**Rủi ro liên quan (không áp dụng cho single-process của ta):** comment ở
`WalletApiClient` (dòng ~1424, cùng file) cảnh báo nếu HAI client dùng CHÙNG `owner+deviceId`
trên cùng `stateStore` thì có thể trip "rotation-reuse revocation" phía server (do xoay vòng
refresh token trùng nhau). Không phát sinh nếu agent chỉ chạy một tiến trình duy nhất tại một
thời điểm — ghi chú lại để nhớ nếu sau này chạy nhiều instance song song.

### 3.4 — `stateStore`: optional, default = `base.storage` — đã đúng tinh thần own-storage

Comment dòng 2028: *"Refresh-token / cursor / seen-set persistence; defaults to `base.storage`"*.
`base.storage` (từ `createNodeProviders`) là `FileStorageProvider`
(`dist/impl/nodejs/index.d.ts:1518`, `implements StorageProvider`), có đủ `get/set/remove`
(dòng 1536-1538) — thoả cấu trúc `KeyValueStore` (chỉ cần `get/set/remove`, định nghĩa tại
`dist/impl/shared/wallet-api/index.d.ts:1010-1014`). **Không cần truyền `stateStore` thủ công**
— mặc định nó đã trỏ vào `dataDir` local, đúng tinh thần own-custody (refresh token + con trỏ
mailbox nằm trên máy agent, không phải server).

### 3.5 — `webSocketFactory`: optional, default = `globalThis.WebSocket` — không cần wire `ws` thủ công cho lớp này

Comment dòng 2032: *"Injectable WebSocket factory (defaults to `globalThis.WebSocket`)"*. Node.js
≥ 22 có sẵn `WebSocket` toàn cục (WHATWG-compatible qua undici), khớp cấu trúc `WebSocketLike`
(`onopen/onmessage/onerror/onclose/close`, định nghĩa dòng 1027-1048) — nên mặc định chạy được
trên Node 22 mà không cần truyền gì thêm cho field này. README's ví dụ `createWalletApiProviders`
cũng KHÔNG truyền `webSocketFactory`, củng cố việc mặc định là đủ dùng theo thiết kế của SDK.

**Lưu ý phân biệt:** gói `ws` (đã cài theo yêu cầu CLAUDE.md mục 6) vẫn CẦN THIẾT — nhưng cho
**lớp Nostr transport** của base providers (`createNodeProviders`), qua
`createNodeWebSocketFactory()` (`dist/impl/nodejs/index.d.ts:1620`, factory riêng dùng type
`WebSocketFactory`/`IWebSocket` ở `dist/impl/nodejs/index.d.ts:657-673` — type KHÁC với
`WebSocketFactoryLike`/`WebSocketLike` của lớp wallet-api). Đây là hai cơ chế WebSocket độc lập
cho hai mục đích khác nhau (Nostr messaging vs wallet-api wake-channel); `.d.ts` không cho thấy
`createNodeProviders` có tự động gọi `createNodeWebSocketFactory()` bên trong hay không (chi
tiết implementation, không phải type) — sẽ xác nhận bằng quan sát thực tế khi chạy thử Giai đoạn 1
(nếu Nostr transport connect được mà không lỗi thiếu WebSocket, coi như đã tự động wire).

### Trả lời tóm tắt 4 câu hỏi của Việc 1, mục 1

| Câu hỏi | Trả lời |
|---|---|
| Field nào bắt buộc? | `baseUrl`, `network` bắt buộc. `deviceId`, `client`, `stateStore`, `fetchFn`, `webSocketFactory`, `verifyToken` đều optional. |
| `baseUrl` có default không? | KHÔNG — bắt buộc truyền tường minh. Dùng `https://wallet-api.unicity.network`. |
| `deviceId` bắt buộc hay optional? Thiếu có hỏng âm thầm không? | Optional. Thiếu KHÔNG hỏng âm thầm — SDK tự sinh label ngẫu nhiên, chỉ tốn thêm 1 vòng challenge sign-in mỗi lần khởi động lại. Khuyến nghị tự sinh + lưu bền để tối ưu, không bắt buộc để đúng chức năng. |
| `stateStore` và các field còn lại dùng để làm gì trong own-storage? | `stateStore` giữ refresh-token/cursor/seen-set, mặc định = `base.storage` (đã là local, đúng tinh thần own-storage, không cần chỉnh). `fetchFn`/`webSocketFactory` là điểm inject cho test/môi trường đặc biệt, mặc định dùng `globalThis.fetch`/`globalThis.WebSocket` là đủ trên Node 22. |

---

## 4. `Sphere.init`

**Nguồn:** `dist/index.d.ts:7785-7857` (`SphereInitOptions`), `:7858-7866`
(`SphereInitResult`), `:7964` (chữ ký hàm).

```ts
interface SphereInitOptions {
  storage: StorageProvider;
  transport: TransportProvider;
  oracle: OracleProvider;
  delivery?: DeliveryProvider;              // truyền từ createOwnStorageWalletApiProviders
  walletApi?: SphereWalletApiSession;        // WalletApiClient thoả kiểu này "as-is" (comment SDK)
  tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  mnemonic?: string;
  autoGenerate?: boolean;
  derivationPath?: string;                  // default m/44'/0'/0'
  nametag?: string;                         // đăng ký nametag khi TẠO MỚI; token tự mint
  price?: PriceProvider;
  network?: NetworkType;                    // ⚠ xem "CẬP NHẬT SAU KHI CHẠY THẬT" ngay dưới — .d.ts nói informational, RUNTIME đòi bắt buộc
  groupChat?: GroupChatModuleConfig | boolean;
  market?: MarketModuleConfig | boolean;
  accounting?: AccountingModuleConfig | boolean;
  swap?: SwapModuleConfig | boolean;
  password?: string;                        // mã hoá seed tại rest (PBKDF2) nếu có
  discoverAddresses?: boolean | DiscoverAddressesOptions;
  dmSince?: number;
  communications?: CommunicationsModuleConfig;
  debug?: boolean;
  onProgress?: InitProgressCallback;
}

interface SphereInitResult {
  sphere: Sphere;
  created: boolean;
  generatedMnemonic?: string;    // chỉ có khi autoGenerate tạo ví mới — PHẢI in ra cho user backup
}

declare class Sphere {
  static init(options: SphereInitOptions): Promise<SphereInitResult>;
}
```

Gọi thực tế cho dự án này (own-storage):
```ts
const base = createNodeProviders({ network: 'testnet2', dataDir: './wallet-data', tokensDir: './tokens', oracle: { apiKey } });
const { delivery, walletApi } = createOwnStorageWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',
  network: 'testnet2',
  deviceId,   // đọc từ file cấu hình cục bộ, tự sinh nếu chưa có (mục 3.3)
});
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...base, delivery, walletApi, autoGenerate: true,
  network: 'testnet2',   // BẮT BUỘC thực tế — xem cập nhật ngay dưới
});
```

### ⚠️ CẬP NHẬT SAU KHI CHẠY THẬT (Giai đoạn 1, xem PHASE1_REPORT.md #5.1)

`.d.ts` ghi `network?: NetworkType` là optional, kèm comment "informational only — cấu hình
thật đến từ provider URLs". **Chạy thật cho kết quả KHÁC**: bỏ `network` ra khỏi `Sphere.init()`
ném ngay:
```
SphereError: network is required to configure the TokenRegistry. Every Sphere entry point
must forward options.network.
  at _Sphere.configureTokenRegistry (core/Sphere.ts:890)
  at _Sphere.init (core/Sphere.ts:719)
```
**Bài học:** comment trong `.d.ts` mô tả Ý ĐỊNH thiết kế, không đảm bảo khớp HÀNH VI THẬT lúc
chạy — đây là ranh giới cố hữu của việc chỉ đọc type mà không chạy thử. `.d.ts` vẫn là nguồn
chân lý cho CHỮ KÝ (tên field, kiểu dữ liệu), nhưng KHÔNG phải nguồn chân lý cho HÀNH VI RUNTIME
khi có mâu thuẫn với comment mô tả. → Luôn truyền `network: 'testnet2'` tường minh vào
`Sphere.init()`, bất kể `.d.ts` nói optional.

---

## 5. Payments — send / mint / receive / balance

**Nguồn:** `dist/index.d.ts:2103-2106` (`send`), `:2646-2653` (`mintFungibleToken`),
`:2307` (`receive`), `:1750-1761` (`ReceiveOptions`/`ReceiveResult`), `:2338` (`getBalance`),
`:2346` (`getAssets`), `:4356` (`TransferStatus`), `:4359-4375` (`TransferRequest`),
`:4392-4408` (`TransferResult`), `:4292-4318` (`Token`), `:4319-4355` (`Asset`).

```ts
type TransferStatus = 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed';

interface TransferRequest {
  coinId: string;
  amount: string;              // base units, STRING — không phải số JS
  recipient: string;           // '@nametag' hoặc DIRECT://...
  memo?: string;                // agent TỰ đính khi gửi — được phép
  addressMode?: 'auto' | 'direct';
  transferMode?: 'instant' | 'conservative';   // @deprecated — bị IGNORE, đừng dùng
  invoiceRefundAddress?: string;
  invoiceContact?: { address: string; url?: string };
}

interface TransferResult {
  id: string;
  status: TransferStatus;      // 'completed' = thành công
  tokens: Token[];
  tokenTransfers: TokenTransferDetail[];
  error?: string;
  deliveryPending?: boolean;   // true = THÀNH CÔNG (giao hàng hoãn), KHÔNG PHẢI lỗi
  deliveryState?: 'landed' | 'pending-delivery';
}

sphere.payments.send(request: TransferRequest): Promise<TransferResult>;
// ném SphereError cho lỗi thật (INSUFFICIENT_BALANCE, INVALID_RECIPIENT, SEND_INSUFFICIENT_BALANCE, ...)

sphere.payments.mintFungibleToken(coinIdHex: string, amount: bigint):
  Promise<{ success: true; token: Token; tokenId: string } | { success: false; error: string }>;

interface ReceiveOptions {   // cả 2 field đều @deprecated — ignore
  finalize?: boolean;
  timeout?: number;
  pollInterval?: number;
}
interface ReceiveResult { transfers: IncomingTransfer[]; }
sphere.payments.receive(_options?: ReceiveOptions, callback?: (t: IncomingTransfer) => void): Promise<ReceiveResult>;
// tiền vào tự động qua delivery port (poll/wake nền); receive() chỉ để "drain" thủ công (CLI/batch).

sphere.payments.getBalance(coinId?: string): Asset[];            // ĐỒNG BỘ — không await
sphere.payments.getAssets(coinId?: string): Promise<Asset[]>;    // async, kèm giá fiat nếu có price provider

interface Token {
  id: string; coinId: string; symbol: string; name: string; decimals: number;
  iconUrl?: string; amount: string; status: TokenStatus;
  createdAt: number; updatedAt: number; sdkData?: string;
  lazy?: boolean; suspectedSpent?: boolean;
}

interface Asset {
  coinId: string; symbol: string; name: string; decimals: number; iconUrl?: string;
  totalAmount: string; tokenCount: number;
  confirmedAmount: string; unconfirmedAmount: string;
  confirmedTokenCount: number; unconfirmedTokenCount: number;
  transferringTokenCount: number; transferringAmount: string;   // in-flight, KHÔNG spendable
  priceUsd: number | null; priceEur: number | null; change24h: number | null;
  fiatValueUsd: number | null; fiatValueEur: number | null;
}
```

### Tiền vào — `IncomingTransfer` (chỗ dễ code sai nhất)

**Nguồn:** `dist/index.d.ts:4409-4416`.

```ts
interface IncomingTransfer {
  id: string;
  senderPubkey: string;
  senderNametag?: string;      // chỉ có khi resolve được — đừng giả định luôn có
  tokens: Token[];              // ← số tiền + coinId nằm ở đây, KHÔNG có transfer.amount/transfer.coinId
  memo?: string;                 // CÓ tồn tại — nhưng KHÔNG dùng để chi tiền (xem CLAUDE.md 4.2 #3)
  receivedAt: number;
}
```
Tính tổng tiền vào theo coin: duyệt `tokens[]`, `group by coinId`, cộng `amount` bằng `BigInt(t.amount)`.

---

## 6. `resolve` + `PeerInfo`

**Nguồn:** `dist/index.d.ts:8564` (hàm), `:1323-1334` (`PeerInfo`), `:8541-8542` (`on`/`off`).

```ts
interface PeerInfo {
  nametag?: string;
  transportPubkey: string;    // pubkey tầng messaging (Nostr)
  chainPubkey: string;        // 33-byte compressed secp256k1 — pubkey tầng L3/chain
  directAddress: string;      // DIRECT://... — địa chỉ nhận tiền thật
  timestamp: number;
}

sphere.resolve(identifier: string): Promise<PeerInfo | null>;
// nhận: '@nametag' | bare nametag | 'DIRECT://...' | 'PROXY://...' | chain pubkey hex | transport pubkey hex

sphere.on<T extends SphereEventType>(type: T, handler: (data: SphereEventMap[T]) => void): () => void;
sphere.off<T extends SphereEventType>(type: T, handler: ...): void;
```

**Lưu ý khớp người gửi cho Rule Matcher:** `IncomingTransfer.senderPubkey` — cần xác định đây là
`chainPubkey` hay `transportPubkey` của `PeerInfo` để so khớp đúng khi luật có `fromSender:
'@client'`. `.d.ts` không ghi rõ field này map với field nào của `PeerInfo` — đây là điểm CẦN
kiểm chứng bằng test gửi thật ở Giai đoạn 1 (resolve `@sender-test` lấy `PeerInfo`, so cả hai
field `chainPubkey`/`transportPubkey` với `senderPubkey` nhận được, xem field nào khớp).

---

## 7. Sự kiện (`SphereEventMap`, phần liên quan transfer)

**Nguồn:** `dist/index.d.ts:4587-4607`.

| Event | Payload | Ý nghĩa |
|---|---|---|
| `transfer:incoming` | `IncomingTransfer` | Tiền vào — trigger chính cho Rule Matcher |
| `transfer:confirmed` | `TransferResult` | Gửi đi đã xác nhận on-chain |
| `transfer:failed` | `TransferResult` | Gửi đi thất bại — ⚠️ CHỈ để LOG/quan sát, KHÔNG dùng làm căn cứ fail-safe (xem cập nhật ngay dưới) |
| `transfer:delivery_pending` | `TransferResult` | Đã chứng thực on-chain, giao hàng hoãn — KHÔNG PHẢI lỗi |
| `transfer:invalid` | `{ deliveryId: string; senderPubkey?: string; reason: string }` | Tiền vào rớt verify cục bộ (terminal cho discovery, có thể retry sau update trustbase) |

### ⚠️ CẬP NHẬT SAU KHI CHẠY THẬT (Giai đoạn 2, xem PHASE2_REPORT.md §4.2)

Dòng gốc ở bảng trên từng ghi "dùng cho fail-safe" cho `transfer:failed` — **SAI, đã sửa**. Chạy
thật cho thấy: `transfer:failed` CÓ THỂ nổ ra cho một lần thử TRUNG GIAN mà cơ chế tự chữa lành
của SDK (`#625 self-healing coin selection` — token nguồn bị phát hiện đã tiêu, SDK tự động
demote + re-plan với token khác, tối đa 8 lần) sau đó **vẫn tự phục hồi và thành công**. Log thật
quan sát được (bản rút gọn):
```
transfer:failed id=e0309070... error=Send conflicted: a source token was already spent by a
  concurrent transfer — re-plan and retry (...)
[Payments] Source ... already spent on-chain — demoted, re-planning with the next candidate
  (#625, attempt 1/8)
   ... 19 giây sau ...
send to @partner: status=completed ...     ← CÙNG lệnh send() này, cuối cùng THÀNH CÔNG
```

**Nguyên tắc bắt buộc:** Fail-safe (CLAUDE.md 4.4 #3) CHỈ được quyết định dựa trên kết quả
(resolve hay throw) của CHÍNH lệnh `send()` mà Action Executor gọi — `status: 'failed'` trả về,
hoặc lỗi bị ném (`SphereError`/`WalletApiError`). **KHÔNG BAO GIỜ** dùng sự kiện `transfer:failed`
để quyết định có đánh dấu luật đã chạy hay không — dùng nó sẽ chặn nhầm một luật THỰC RA ĐÃ
THÀNH CÔNG (sau khi SDK tự chữa lành). Sự kiện này chỉ có giá trị LOG/quan sát/audit trail, không
phải nguồn sự thật cho luồng điều khiển tiền. Đã áp dụng đúng trong `src/rules/executor.ts` —
ghi lại ở đây để phiên sau không "sửa" theo hướng nghe event.

---

## 8. Mã lỗi

**Nguồn:** `dist/index.d.ts:663` (`SphereErrorCode` + class `SphereError`, dòng 664-668);
`:9854-9878` (`WalletApiErrorCode` + class `WalletApiError`).

```ts
type SphereErrorCode =
  | 'NOT_INITIALIZED' | 'ALREADY_INITIALIZED' | 'INVALID_CONFIG' | 'INVALID_IDENTITY'
  | 'INSUFFICIENT_BALANCE' | 'INVALID_RECIPIENT' | 'TRANSFER_FAILED' | 'TRANSFER_CONFLICT'
  | 'STORAGE_ERROR' | 'TRANSPORT_ERROR' | 'AGGREGATOR_ERROR' | 'VALIDATION_ERROR'
  | 'INVALID_AMOUNT' | 'NETWORK_ERROR' | 'TIMEOUT' | 'DECRYPTION_ERROR'
  | 'MODULE_NOT_AVAILABLE' | 'SIGNING_ERROR' | 'SEND_QUEUE_TIMEOUT' | 'SEND_INSUFFICIENT_BALANCE'
  | 'SEND_RESERVATION_CANCELLED' | 'SEND_QUEUE_FULL' | 'MODULE_DESTROYED' | 'REENTRANT_GATE'
  | 'RATE_LIMITED' | 'COMMUNICATIONS_UNAVAILABLE';
  // + ~35 mã INVOICE_* / SWAP_* khác (module invoice/swap, không dùng ở dự án này —
  //   danh sách đầy đủ tại dist/index.d.ts:663)

declare class SphereError extends Error {
  readonly code: SphereErrorCode;
  readonly cause?: unknown;
}

type WalletApiErrorCode =
  | 'CONFIG' | 'CHALLENGE_TEMPLATE' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'CONFLICT' | 'TOO_LARGE' | 'VALIDATION' | 'RATE_LIMITED' | 'NETWORK' | 'PROTOCOL' | 'SERVER';
```

`send()` ném `SphereError` (lỗi nghiệp vụ: số dư, người nhận không hợp lệ...). Tầng delivery
(wallet-api) ném `WalletApiError` riêng (lỗi HTTP/giao thức: 401/403/409/429...). Action Executor
(Giai đoạn 2) cần bắt CẢ HAI loại.

---

## 9. Tiện ích tiền tệ

**Nguồn:** `dist/index.d.ts:8882` (`parseTokenAmount`), `:8898` (`toHumanReadable`), `:10410`
(`getCoinIdBySymbol`).

```ts
declare function parseTokenAmount(value: string, decimals?: number): bigint;       // "1.5" → 1500000000000000000n, throws nếu invalid
declare function safeParseTokenAmount(...): bigint | null;                          // như trên, không throw
declare function toHumanReadable(amount: bigint | string, decimals?: number): string; // ngược lại, để hiển thị
getCoinIdBySymbol(symbol: string): string | undefined;   // 'UCT' → coinId hex, hoặc undefined nếu không có trong registry
```

---

## Việc còn TODO / cần người dùng cấp (không đoán)

- Nametag ví "người nhận test" thứ hai — người dùng sẽ cấp sau khi khung Giai đoạn 1 dựng xong
  (theo xác nhận trước đó).
- `coinId` hex cho UCT: dự định lấy bằng `getCoinIdBySymbol('UCT')` lúc chạy — nếu trả về
  `undefined` (không có trong token registry testnet2), sẽ dừng lại hỏi người dùng thay vì đoán
  một hex string.
- `senderPubkey` khớp với `chainPubkey` hay `transportPubkey` của `PeerInfo` — cần test thật,
  ghi ở mục 6 trên. Sẽ xác nhận và cập nhật file này sau khi có kết quả Giai đoạn 1.
