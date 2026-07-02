# Phase 1 Report — Headless Wallet Skeleton (money in/out path)

Tất cả chạy thật trên **Unicity Testnet v2**, không mock. Hai ví Sphere thật đã được tạo (agent
+ counterparty test), token thật đã được tự-mint, một transfer thật đã được gửi và nhận, quan
sát được qua sự kiện live `transfer:incoming`.

---

## 1. Cấu trúc thư mục đã dựng

```
Conditional Payment Agent/
├── .env                        # config thật (gitignored) — key testnet2 public, đã điền sẵn
├── .env.example                # committed — tài liệu hoá các biến + giá trị public
├── .gitignore
├── package.json / package-lock.json
├── tsconfig.json                # strict, ESM, NodeNext, include src/ + scripts/
├── CLAUDE.md / CLAUDE_MD_DIFF.md / PHASE0_VERIFIED_API.md   # tài liệu Giai đoạn 0
├── PHASE1_REPORT.md             # file này
├── src/
│   ├── config.ts                 # đọc + validate .env → AppConfig
│   ├── logger.ts                 # logger console có timestamp, 3 mức info/warn/error
│   ├── wallet/
│   │   ├── local-state.ts        # readOrCreateJson / writeJson / readJsonIfExists (JSON nhỏ, tự tạo)
│   │   └── init.ts               # initWallet(role, config): init 2 lớp provider, own-storage,
│   │                              # sinh + validate + đăng ký nametag, đọc/tạo deviceId bền
│   └── payments/
│       └── incoming.ts           # sumIncomingByCoin (BigInt, gom theo coinId), formatCoinTotals
├── scripts/                      # script kiểm thử tay (Giai đoạn 1) — chạy qua `npx tsx`
│   ├── run-agent-wallet.ts       # init ví AGENT, in identity, gắn listener sống, chạy mãi
│   ├── mint.ts                   # CLI: mint UCT test vào ví agent|counterparty
│   ├── counterparty-send.ts      # CLI: ví counterparty gửi tới nametag agent kèm memo đã biết
│   ├── send-external.ts          # CLI: ví agent gửi ra nametag NGOÀI (TODO — chờ người dùng)
│   └── check-balance.ts          # CLI: in số dư hiện tại của một ví theo role
└── data/ , tokens/                # gitignored — state SDK tự quản (own-storage) + local-identity.json
    ├── agent/       (dataDir, tokensDir, local-identity.json {deviceId, nametag})
    └── counterparty/ (tương tự — ví test do TA tự tạo để có cả hai đầu transfer)
```

**Vì sao có ví "counterparty":** Phase 1 cần một transfer ĐẾN ví agent để kiểm hai kết quả bắt
buộc (khớp người gửi + quan sát memo). Chưa có nametag đối tác thật từ người dùng cho bước gửi-ra
(step 5), nên tự dựng một ví Sphere thứ hai — hoàn toàn thật trên testnet2, không mock — để đóng
vai người gửi trong lúc chờ. Ví agent và ví counterparty tìm nametag của nhau qua
`peekNametag()` (đọc `data/<role>/local-identity.json` của nhau) thay vì phải copy-paste tay qua
`.env` giữa các lần chạy.

## 2. Tóm tắt từng module

- **`src/config.ts`** — đọc `.env` qua `dotenv/config`; báo lỗi rõ ràng nếu thiếu
  `ORACLE_API_KEY`/`WALLET_API_BASE_URL`. Không đoán giá trị mặc định cho hai key này.
- **`src/wallet/local-state.ts`** — 3 hàm tiện ích JSON nhỏ (đọc-hoặc-tạo, ghi, đọc-nếu-có) dùng
  chung cho `deviceId` + `nametag` cục bộ (SDK không tự lo hai giá trị này).
- **`src/wallet/init.ts`** — module lõi:
  - `initWallet(role, config)`: dựng đúng chuỗi 2 lớp đã chốt — `createNodeProviders` (base) →
    `createOwnStorageWalletApiProviders` (delivery + walletApi, custody `'external'`) →
    `Sphere.init`. Đọc/tạo `deviceId` bền qua `local-identity.json`. Sau khi ví sẵn sàng, tự
    ĐĂNG KÝ nametag nếu chưa có (check `isNametagAvailable` trước, retry tối đa 3 lần với ứng
    viên MỚI nếu bị trùng — không stack suffix để tránh vượt trần 20 ký tự).
  - `generateNametagCandidate(prefix)`: validate định dạng Unicity ID (`[a-z0-9_-]{3,20}`)
    NGAY khi sinh — fail nhanh với thông báo rõ nếu prefix cấu hình quá dài, thay vì để SDK ném
    lỗi sâu trong `registerNametag`.
  - `peekNametag(roleName)`: đọc nametag của MỘT ví khác từ file mà không init ví đó — chỉ dùng
    giữa các script test trên cùng máy.
- **`src/payments/incoming.ts`** — `sumIncomingByCoin`: duyệt `IncomingTransfer.tokens[]`, gom
  theo `coinId`, cộng `amount` bằng BigInt (KHÔNG đọc `transfer.amount` — trường đó không tồn
  tại, xem CLAUDE.md 4.2 #2).
- **`scripts/run-agent-wallet.ts`** — init ví agent; in `directAddress`/nametag/`chainPubkey`/
  `deviceId`/balance; resolve trước `PeerInfo` của counterparty (nếu đã có) để so khớp
  `senderPubkey` SỐNG ngay khi tiền vào; đăng ký `transfer:incoming` / `transfer:confirmed` /
  `transfer:delivery_pending` / `transfer:failed`; chạy vô hạn (Ctrl+C để dừng) — đây là tiền
  thân trực tiếp của Event Listener trong Giai đoạn 3.
- **`scripts/mint.ts`** — mint token test; gọi `TokenRegistry.waitForReady()` TRƯỚC
  `getCoinIdBySymbol` để tránh false-negative do registry tải nền (phát hiện ở Giai đoạn 0, xem
  PHASE0_VERIFIED_API.md #9); nếu symbol không có trong registry → dừng, in 2 phương án, KHÔNG
  đoán hex.
- **`scripts/counterparty-send.ts`** — gửi từ counterparty → agent kèm memo tuỳ ý; nguồn dữ liệu
  cho cả hai kết quả bắt buộc (a) và (b) bên dưới.
- **`scripts/send-external.ts`** — gửi ra ngoài; bắt buộc CLI arg hoặc `EXTERNAL_TEST_NAMETAG`
  trong `.env`, nếu thiếu thì dừng với thông báo TODO rõ ràng — **CHƯA CHẠY**, chờ nametag thật.
- **`scripts/check-balance.ts`** — tiện ích debug, in số dư một ví.

## 3. Kết quả chạy thật trên testnet2

### 3.1 Mint

| Ví | Nametag đăng ký | directAddress | Mint | tokenId |
|---|---|---|---|---|
| agent | `@cpa-agent-66969549` | `DIRECT://0000d935d77d81bc2e8f2039a0c17ea8699cf0659280ce7b43aa941140299a2d889f5c00e089` | 5 UCT | `64e902a8e7f8bece289a71fcf59991404bbda4702ceb1fb783b96d63aac69321` |
| counterparty | `@cpa-peer-de1b95` | `DIRECT://0000e53926967980239f1d9d79eb16d15dd6c6a6d08ec401682d267ed0a2d5fe0a6e91a4952b` | 10 UCT | `99075822f2bbab4209d3ab9b3a0284d8cce63ec19db3163b7d2b1440c3e51d42` |

coinId UCT (testnet2, lấy qua `getCoinIdBySymbol('UCT')` sau `TokenRegistry.waitForReady()`):
`f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0`, decimals=18.

### 3.2 Send (counterparty → agent, 1 UCT, kèm memo)

```
send() resolved: id=dec3309a-bfae-4795-bf57-c61784b856ea
status=completed  deliveryPending=false  deliveryState=landed
```

Thành công ngay lần đầu, đi thẳng đường "landed" (không rơi vào nhánh `deliveryPending`/
`pending-delivery` — nhánh đó vẫn chưa được quan sát thực tế, ghi vào TODO bên dưới).

### 3.3 Receive — listener sống bắt được sự kiện

```
transfer:incoming id=v2_525378a8e5725416fbb21dc1e06f8d70427c9a50db90244868e673fa025f48a9
  senderPubkey=02d07f7f27e489f3f45fc25e0c56430162ecb8c0d0e4b4ef02654819eb4b674236
  senderNametag=cpa-peer-de1b95
  memo="phase1-memo-check-abc123"
  tokens=1000000000000000000 UCT (coinId f581d30f593e…)
```
Độ trễ từ lúc `send()` resolve tới lúc `transfer:incoming` nổ trên tiến trình agent: **< 1 giây**
(13:31:04.019 → 13:31:04.899) — đúng tinh thần "agent phản ứng trong vài giây" reviewer sẽ kiểm
(CLAUDE.md mục 8).

### 3.4 Đối soát số dư (idempotent, không lệch)

| Ví | Trước | Sau | Δ |
|---|---|---|---|
| counterparty | 10 UCT | **9 UCT** (đã kiểm bằng `check-balance.ts` độc lập) | −1 |
| agent | 5 UCT | 6 UCT (suy ra: đã nhận đúng 1 UCT qua log tokens[], không kiểm lại bằng script thứ hai — xem lưu ý an toàn bên dưới) | +1 |

**Lưu ý an toàn khi đối soát:** KHÔNG chạy `check-balance.ts agent` trong lúc
`run-agent-wallet.ts` còn sống — cả hai sẽ cùng mở một `dataDir`/`deviceId`, đúng kịch bản
"hai client cùng owner+deviceId" mà PHASE0_VERIFIED_API.md §3.3 cảnh báo có thể trip
rotation-reuse revocation phía wallet-api. Đã dừng tiến trình agent trước khi kết luận Giai
đoạn 1, và chỉ kiểm số dư counterparty (khi đó không có tiến trình nào khác đang giữ ví đó).

## 4. HAI kết quả bắt buộc

### (a) Khớp người gửi — ĐÃ CÓ CÂU TRẢ LỜI DỨT KHOÁT

Resolve `@cpa-peer-de1b95` (counterparty) từ phía agent:
```
PeerInfo.chainPubkey     = 02d07f7f27e489f3f45fc25e0c56430162ecb8c0d0e4b4ef02654819eb4b674236
PeerInfo.transportPubkey =   d07f7f27e489f3f45fc25e0c56430162ecb8c0d0e4b4ef02654819eb4b674236
```
So với `IncomingTransfer.senderPubkey` nhận được:
```
senderPubkey = 02d07f7f27e489f3f45fc25e0c56430162ecb8c0d0e4b4ef02654819eb4b674236
```

**`senderPubkey` khớp `chainPubkey`, KHÔNG khớp `transportPubkey`** (chainPubkey match=true,
transportPubkey match=false — log trực tiếp từ agent). Ghi nhận thêm: `transportPubkey` ở đây
đúng bằng `chainPubkey` bỏ byte tiền tố `02` đầu (33 byte nén → 32 byte x-only) — hợp lý vì cùng
một khoá gốc, khác cách mã hoá (nametag/Nostr dùng x-only, L3 chain dùng nén 33-byte).

**→ Kết luận cho Giai đoạn 2 (Rule Matcher):** để khớp `fromSender: '@client'`, PHẢI
`resolve('@client')` rồi so `peer.chainPubkey === transfer.senderPubkey`. So với
`transportPubkey` sẽ LUÔN sai. Đây là dữ kiện mà `.d.ts` một mình không thể cho biết — chỉ xác
nhận được bằng cách gửi tiền thật và so trực tiếp, đúng như đã làm.

Ghi chú thêm: `IncomingTransfer.senderNametag` được SDK tự điền
(`senderNametag=cpa-peer-de1b95`) mà không cần ta tự resolve — tiện cho việc log, nhưng Rule
Matcher (an toàn tiền) vẫn nên dựa vào so khớp `chainPubkey` đã resolve, không dựa vào chuỗi
`senderNametag` tự điền này (chưa rõ mức độ xác thực/chống giả mạo của trường tiện ích này ở
tầng vận chuyển — thận trọng tương tự nguyên tắc đã áp dụng với memo).

### (b) Quan sát memo — CHỈ QUAN SÁT, không đổi nguyên tắc

Memo gửi đi: `"phase1-memo-check-abc123"`. Memo nhận được (log phía agent):
`memo="phase1-memo-check-abc123"` — **khớp chính xác, đến đầy đủ**.

Đúng như đã lường trước: test này gửi từ ví do TA tự kiểm soát cả hai đầu, nên memo chắc chắn
đúng — **không chứng minh được gì về chống giả mạo memo** (ai kiểm soát cả hai đầu của một phép
thử thì kết quả luôn "đẹp"). Việc memo đến đúng nội dung chỉ xác nhận: (1) đường truyền memo qua
v2 hoạt động, (2) `IncomingTransfer.memo` đọc được như `.d.ts` mô tả. **Nguyên tắc "không chi
tiền theo memo" (CLAUDE.md 4.2 #3) giữ nguyên không đổi** — kết quả tốt ở đây không phải bằng
chứng ngược lại, vì bài test không có "kẻ tấn công" nào cố giả mạo memo để so sánh.

## 5. Hai lỗi tìm thấy NHỜ chạy thật (không thấy được nếu chỉ đọc `.d.ts`)

1. **`Sphere.init` cần `network` dù `.d.ts` ghi "chỉ mang tính thông tin".** Chạy thật ném:
   `SphereError: network is required to configure the TokenRegistry. Every Sphere entry point
   must forward options.network.` (nguồn: `core/Sphere.ts:890`, `configureTokenRegistry`). Đã
   sửa: thêm `network: 'testnet2'` tường minh vào `Sphere.init({...})` trong `src/wallet/init.ts`.
   → **Bài học ghi vào PHASE0_VERIFIED_API.md cần cập nhật**: comment trong `.d.ts` mô tả HÀNH VI
   Ý ĐỊNH, không phải luôn khớp hành vi THẬT lúc chạy — chỉ đọc type không đủ, phải chạy thử.

2. **Trần 20 ký tự cho nametag** (README có ghi "3–20 chars" nhưng tôi đã bỏ sót khi chọn prefix
   mặc định `cpa-counterparty` = 16 ký tự + 8 hex = 25 ký tự, vượt trần). Lỗi thật:
   `SphereError: Invalid Unicity ID format...`. Đã sửa ba chỗ: (i) đổi prefix mặc định thành
   `cpa-peer` (8 ký tự); (ii) thêm `generateNametagCandidate()` validate độ dài NGAY khi sinh,
   fail nhanh với thông báo rõ thay vì để lỗi nổ sâu trong SDK; (iii) sửa logic retry-khi-trùng
   để sinh ứng viên MỚI từ prefix mỗi lần thay vì nối thêm suffix vào ứng viên cũ (nối thêm sẽ
   có lúc vượt trần dù ứng viên gốc hợp lệ).

Cả hai lỗi đều được sửa tại chỗ, re-test lại thành công (xem mục 3). Không có lỗi nào bị che
giấu hay bỏ qua.

## 6. TODO / cần người dùng quyết định

- **Bước 5 (gửi ra ngoài) CHƯA CHẠY** — `scripts/send-external.ts` đã viết xong, đã typecheck,
  nhưng cần một **nametag thật bên ngoài** (ví reviewer, hoặc ví cá nhân của bạn) để test. Chạy:
  `npx tsx scripts/send-external.ts <nametag> <amount> [memo]`, hoặc set
  `EXTERNAL_TEST_NAMETAG` trong `.env` rồi bỏ qua tham số đầu.
- **Nhánh `deliveryPending: true` / `deliveryState: 'pending-delivery'` chưa được quan sát
  thật** — lần gửi test đi thẳng `'landed'`. README mô tả đây là nhánh THÀNH CÔNG (không phải
  lỗi), nhưng ta chưa có bằng chứng thực tế nó hoạt động đúng như mô tả. Chưa chặn Giai đoạn 2,
  nhưng nên nhớ khi viết Action Executor: đừng coi `deliveryPending` là lỗi.
- **`transfer:failed` chưa được kích hoạt thật** — chưa có kịch bản lỗi thật nào xảy ra (số dư
  đủ, người nhận hợp lệ suốt các lần test). Fail-safe (CLAUDE.md 4.4 #3) sẽ cần một bài test cố
  ý gây lỗi (ví dụ gửi vượt số dư) ở Giai đoạn 2 để xác nhận hành vi thật.
- **`senderNametag` tự động điền — độ tin cậy chưa rõ.** SDK tự gắn `senderNametag` vào
  `IncomingTransfer` mà không cần ta resolve. Chưa rõ tầng vận chuyển có xác thực trường này hay
  chỉ là tiện ích hiển thị (giống câu hỏi đã đặt ra với `memo`). Giai đoạn 2 nên tiếp tục dựa vào
  so khớp `chainPubkey` đã resolve (đã chứng minh đúng ở mục 4a), không dựa vào chuỗi này.
- Ví counterparty là ví THẬT, có mnemonic thật (đã in ra log, không lưu file riêng ngoài
  `data/counterparty/wallet.json` do SDK tự quản) — thuần cho mục đích test. Giữ lại để Giai
  đoạn 2/3 tiếp tục dùng làm nguồn gửi thử, hay muốn dọn đi? (Không tự xoá — đợi bạn quyết.)

## 7. Cách tái chạy

```bash
npx tsc --noEmit                                  # typecheck

npx tsx scripts/mint.ts agent 5                   # (đã chạy — idempotent nếu chạy lại: mint thêm)
npx tsx scripts/mint.ts counterparty 10           # (đã chạy)

npx tsx scripts/run-agent-wallet.ts               # long-running — để một cửa sổ riêng
npx tsx scripts/counterparty-send.ts 1 "memo..."  # ở cửa sổ khác, sau khi agent đã "listening"

npx tsx scripts/check-balance.ts counterparty     # chỉ chạy khi KHÔNG có tiến trình khác giữ ví đó
```

---

➤ Chờ duyệt trước khi sang Giai đoạn 2 (Rule engine).
