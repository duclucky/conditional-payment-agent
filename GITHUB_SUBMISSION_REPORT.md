# GITHUB_SUBMISSION_REPORT.md — Repo public hoá cho submission + VPS deploy

## 0. Kết quả

**Repo:** https://github.com/duclucky/conditional-payment-agent — **PUBLIC** (xác nhận qua
`gh repo view` → `"visibility":"PUBLIC"`), branch `main`, 1 commit (`3f98a7f`).

Không có secret nào lọt lên GitHub — đã scan 2 lần (trước khi stage và lại lần nữa trên đúng tập
file đã stage), chi tiết ở mục 2.

---

## 1. .gitignore — quyết định cuối

Phát hiện: **đã có sẵn `.gitignore` từ Phase 1**, và nó đã bao phủ mọi thứ bạn liệt kê trong Bước 1
(và rộng hơn: `.env.local`, `*.mnemonic`, `*.log`, `.vscode/`, `.idea/`, `reference/`). Tôi giữ
nguyên toàn bộ, chỉ thêm một dòng:

```diff
+ # Claude Code local session/task bookkeeping — tool-local state, not project source
+ .claude/
```

(có `.claude/scheduled_tasks.lock` thật trong thư mục — không phải source code của dự án, không
nên lên repo).

**`store/rules.json`** — theo lựa chọn bạn đã chọn ("Gitignore, thêm ví dụ chỉnh chu riêng"):
KHÔNG commit. `.gitignore` cũ đã có blanket `store/` nên tự động loại — không cần sửa thêm.
README mục "Rules supported" có sẵn lệnh `add-rule.ts notify-on-incoming` / `forward-normal` để
reviewer tự tạo file này sạch trên máy họ.

---

## 2. Scan secret — chi tiết (Bước 2)

Lệnh bạn yêu cầu, chạy tại thời điểm đã stage:

```
$ git diff --cached --name-only
```
→ 52 file (danh sách đầy đủ ở mục 4).

**Phát hiện trong lúc kiểm tra `data/`/`tokens/` (KHÔNG nằm trong diện commit, nhưng cần biết để
hiểu vì sao gitignore này bắt buộc):** `data/agent/wallet.json`, `data/counterparty/wallet.json`,
`data/partner/wallet.json` mỗi file chứa **mnemonic thật ở dạng plaintext** (trường `"mnemonic"`
trong JSON do SDK tự ghi) — đây chính là bằng chứng cụ thể tại sao `data/` PHẢI luôn nằm trong
`.gitignore`, không phải suy đoán lý thuyết. Đã xác nhận các file này KHÔNG nằm trong danh sách
staged (mục 4 dưới, và lệnh xác nhận ở cuối mục này).

**Scan trên đúng tập 52 file đã stage** (không phải toàn bộ working tree — tránh báo động giả từ
`data/`/`tokens/`):

```
$ git ls-files -z | xargs -0 grep -n "sk_[A-Za-z0-9]"
.env.example:3:ORACLE_API_KEY=sk_ddc3cfcc001e4a28ac3fad7407f99590
CLAUDE.md:23: | `oracle.apiKey` | `sk_ddc3cfcc001e4a28ac3fad7407f99590` |
PHASE0_VERIFIED_API.md:36: | `oracle.apiKey` (public) | `sk_ddc3cfcc001e4a28ac3fad7407f99590` | README:181 |
```
→ Chỉ một giá trị duy nhất, đúng key testnet2 CÔNG KHAI mà CLAUDE.md mục 0 đã ghi nhận từ Phase 0
(verify qua README của bản SDK đã cài) — không phải secret bị lộ, là tài liệu hoá có chủ đích.

```
$ git ls-files -z | xargs -0 grep -ln -i "mnemonic\|recovery phrase\|BEGIN PRIVATE\|BEGIN RSA\|xprv"
.gitignore, CLAUDE.md, PHASE0_VERIFIED_API.md, PHASE1_REPORT.md, PHASE4_REPORT.md,
src/server/dashboard-page.ts, src/server/dashboard-server.ts, src/wallet/init.ts
```
→ Đã đọc kỹ TỪNG file này (không chỉ đếm số dòng khớp): tất cả chỉ bàn về CƠ CHẾ xử lý mnemonic
(tên biến, comment code, đoạn văn giải thích "dashboard không bao giờ nhận mnemonic") — **không
file nào chứa giá trị mnemonic thật**. Riêng `PHASE1_REPORT.md` có nhắc "ví counterparty có
mnemonic thật (đã in ra log...)" — mô tả sự kiện, không dán lại giá trị.

```
$ git ls-files -z | xargs -0 grep -n "BEGIN (RSA|EC|PRIVATE|OPENSSH)|xprv"
(không có kết quả)
```

```
$ git ls-files | grep -E "^(data/|tokens/|store/|\.env$|\.claude/)"
(không có kết quả — sạch)
```

**Kết luận: KHÔNG có secret nào trong 52 file đã push.** Không cần dừng theo điều kiện ở Bước 2.

---

## 3. Một vấn đề phát sinh ngoài kịch bản: git identity là placeholder

`git config user.name` / `user.email` trên máy đang là `"Your Name"` /
`"your.github.email@gmail.com"` — placeholder chưa từng điền, không phải lỗi tôi gây ra nhưng nếu
commit ngay sẽ gắn tác giả giả vào lịch sử git của repo public vĩnh viễn. Đã dừng lại hỏi bạn thay
vì tự ý sửa git config (đúng nguyên tắc không tự động sửa git config) hoặc lờ đi commit ẩu. Bạn đã
tự set (`duclucky` / `trungduccant999@gmail.com`) — khớp với tài khoản GitHub đã đăng nhập qua
`gh`. Commit + push sau đó dùng đúng danh tính thật.

---

## 4. Danh sách 52 file đã commit (đối chiếu với bạn)

```
.env.example                         package.json
.gitignore                           scripts/add-rule.ts
CLAUDE.md                            scripts/check-balance.ts
CLAUDE_MD_DIFF.md                    scripts/check-dms.ts
PHASE0_VERIFIED_API.md               scripts/counterparty-send.ts
PHASE1_REPORT.md                     scripts/mint.ts
PHASE2_REPORT.md                     scripts/replay-transfer.ts
PHASE2_SPLIT_ATOMICITY_PROPOSAL.md   scripts/run-agent-wallet.ts
PHASE3_PROCESS_DESIGN.md             scripts/run-agent.ts
PHASE3_REPORT.md                     scripts/send-external.ts
PHASE4_REPORT.md                     scripts/set-rule-enabled.ts
README.md                            src/config.ts
SPLIT_DESIGN_V2.md                   src/logger.ts
SPLIT_REPORT.md                      src/payments/incoming.ts
package-lock.json                    src/rules/engine.ts
                                      src/rules/executor.ts
                                      src/rules/guards.ts
                                      src/rules/idempotency.ts
                                      src/rules/identity-cache.ts
                                      src/rules/matcher.ts
                                      src/rules/scheduler.ts
                                      src/rules/split-progress.ts
                                      src/rules/store.ts
                                      src/rules/types.ts
                                      src/server/dashboard-page.ts
                                      src/server/dashboard-server.ts
                                      src/util/json-file.ts
                                      src/wallet/init.ts
                                      src/wallet/process-lock.ts
                                      test/*.test.ts (7 file)
                                      tsconfig.json
```

Đã đối chiếu 3 lần khớp nhau tuyệt đối: preview trước khi `git add` (`git status --porcelain`),
danh sách đã stage (`git diff --cached --name-only`), và cây thật trên remote sau khi push
(`git ls-tree -r origin/main`). Không lệch một file nào.

**KHÔNG có trên GitHub** (đúng dự định): `.env` (thật), `data/` (mnemonic + wallet state thật của
3 ví), `tokens/` (token/asset state thật), toàn bộ `store/` (rules.json + idempotency +
split-progress thật của phiên dev), `.claude/`, `node_modules/`.

---

## 5. Thay đổi code đi kèm (ngoài .gitignore/README)

- `package.json`: thêm script `"agent": "tsx scripts/run-agent.ts"` — khớp lệnh `npm run agent`
  trong README. Đã smoke-test thật (dashboard trả về HTTP 200) trước khi viết vào README.
- Không sửa gì trong `src/rules/*`, `src/wallet/*`, `src/server/*` — chỉ thêm 2 file mới
  (`README.md`, `GITHUB_SUBMISSION_REPORT.md` này) và cập nhật `.gitignore`/`package.json`.

**Sự cố nhỏ lặp lại (lần thứ 6 trong dự án):** smoke-test `npm run agent` để lại 3 tiến trình con
sống sau khi bash `kill` tiến trình bao ngoài — cùng hiện tượng process-tree đã ghi nhận ở Phase
2-4. Đã `Stop-Process -Force` dọn sạch, xác nhận lại bằng PowerShell trước khi tiếp tục. Không ảnh
hưởng tới nội dung đã push.

---

## 6. Câu hỏi / điểm chưa chắc — cần bạn xác nhận

1. **README mục "Live dashboard" đang để `TODO — filled in after VPS deployment.`** — đúng như bạn
   nói mục tiêu (1) là deploy VPS; tôi chưa động tới việc deploy (không có quyền truy cập VPS, và
   đây có vẻ là bước tiếp theo riêng bạn muốn làm/giao). Khi có VPS + domain/IP, báo tôi để điền
   link thật vào README (và cân nhắc `DASHBOARD_HOST=0.0.0.0` sau firewall — xem `.env.example`).
2. **`package.json` khai `"license": "MIT"` nhưng repo chưa có file `LICENSE`** — phát hiện khi
   viết README, không phải lỗi do Phase 4. Không tự thêm `LICENSE` vì cần biết chính xác tên/tổ
   chức đứng tên copyright — bạn muốn thêm không, và đứng tên ai?
3. **Dashboard `POST /toggle` vẫn không có auth** (quyết định có chủ đích từ PHASE4_REPORT.md) —
   nêu lại ở đây vì giờ repo đã public, ai đọc source cũng biết endpoint này tồn tại. Chấp nhận
   được cho bản demo testnet, nhưng đáng cân nhắc lại nếu VPS deploy xong và để chạy dài hạn.
4. Repo hiện **không có CI** (không GitHub Actions chạy `npm test`/`typecheck` khi có commit mới)
   — không nằm trong yêu cầu ban đầu, chỉ nêu để bạn biết đây là khoảng trống nếu muốn có sau này.

---

## 7. Lệnh để tự kiểm chứng

```bash
git clone https://github.com/duclucky/conditional-payment-agent.git
cd conditional-payment-agent
git log --oneline        # 3f98a7f, tác giả duclucky
git ls-files | wc -l     # 52
```

---

➤ Chờ bạn xác nhận 3 điểm ở mục 6 (đặc biệt LICENSE + thời điểm deploy VPS) trước khi làm gì tiếp.
