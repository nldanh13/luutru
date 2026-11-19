# Lưu trú bệnh viện

Web app (cài được như app trên điện thoại) để quét CCCD bệnh nhân và người nuôi bệnh, gom người nhà theo từng bệnh nhân,
xuất file Excel đúng mẫu nhập của hệ thống lưu trú (công dân VN: `tblt_vn_import.xlsx`, người nước ngoài: mẫu KBTT).

- `web/` – giao diện (một file `index.html`, chạy cả offline, có PWA).
- `src/index.js` – Cloudflare Worker: đăng nhập theo nhân viên, đồng bộ dữ liệu giữa các máy (D1 `luutru-bv`).
- `migrations/` – cấu trúc cơ sở dữ liệu.

## Triển khai
Cloudflare → Workers & Pages → worker `cccd` → Settings → Build → Connect to Git → chọn repo này.
Mỗi lần đẩy code lên nhánh `main`, Cloudflare tự chạy `npx wrangler deploy`.

## Gửi thẳng lên hệ thống lưu trú (API KBTT)
Trong Cloudflare → worker `cccd` → Settings → Variables and Secrets, thêm:
- `KBTT_USER` (Secret): tên đăng nhập tài khoản cơ sở lưu trú
- `KBTT_PASS` (Secret): mật khẩu
- `KBTT_BASE` (tùy chọn, Text): để trống là hệ thống thật; `https://api-kbtt.ai-vlab.com` để thử môi trường demo

Khi đã cấu hình, app có nút "Gửi lên hệ thống", tự trả phòng khi xuất viện và gia hạn khi đổi ngày đi.

## Tài khoản
Lần đầu mở app sẽ yêu cầu mã thiết lập để tạo tài khoản quản trị. Quản trị viên thêm/khóa tài khoản nhân viên trong phần Cài đặt.
