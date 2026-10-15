# Panduan Dashboard Meridian

Dashboard web **read-only** untuk memantau bot: saldo wallet, posisi terbuka + PnL live, riwayat posisi + grafik PnL, alasan keputusan agent, lessons, dan log. Tidak ada tombol deploy/close — dashboard ini tidak bisa memindahkan dana.

## 1. Pasang file

Salin folder `dashboard/` dan file yang berubah (`index.js`, `package.json`, `.env.example`, `README.md`) ke folder meridian di server. Atau, kalau pakai git:

```
git apply meridian-dashboard.patch
```

Tidak perlu `npm install` tambahan.

## 2. Isi `.env`

Tambahkan di file `.env`:

```
DASHBOARD_ENABLED=true
DASHBOARD_PORT=3030
DASHBOARD_HOST=127.0.0.1
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=ganti-dengan-password-panjang
```

## 3. Restart bot

```
npm run pm2:restart
```

Cek log (`npm run pm2:logs`), harus muncul:
`[DASHBOARD] Web dashboard running at http://127.0.0.1:3030 (password protected)`

## 4. Buka dashboard

| Bot jalan di | Cara buka |
|---|---|
| PC/laptop sendiri | Browser → `http://localhost:3030` |
| VPS — **disarankan** | Pasang **Tailscale** di VPS + HP/laptop (login akun yang sama). Ubah `DASHBOARD_HOST=0.0.0.0`, restart, lalu buka `http://<IP-tailscale-VPS>:3030` |
| VPS — SSH tunnel | Di laptop: `ssh -L 3030:localhost:3030 user@ip-vps`, lalu buka `http://localhost:3030` |
| VPS — IP publik | `DASHBOARD_HOST=0.0.0.0` + password ≥10 karakter + buka port 3030 di firewall. Koneksi HTTP biasa (tidak terenkripsi) — lebih aman pakai Tailscale |

Login pakai `DASHBOARD_USER` / `DASHBOARD_PASSWORD`.

## Keamanan bawaan

- Tidak mau jalan di host publik tanpa password (min 10 karakter).
- API key, token Telegram, dan private key disensor di tampilan log.
- 10x salah password → IP diblokir 15 menit.
- Hanya menerima request GET (read-only).

## Troubleshooting

| Gejala | Solusi |
|---|---|
| Tidak ada log `[DASHBOARD]` | Cek `DASHBOARD_ENABLED=true` lalu restart |
| `NOT started: ... DASHBOARD_PASSWORD ... required` | Isi password ≥10 karakter |
| `port 3030 already in use` | Ganti `DASHBOARD_PORT`, mis. 3040 |
| Kena blokir login | Tunggu 15 menit atau restart bot |
| PnL kosong, ada banner kuning | Data live gagal (RPC/API); posisi tetap tampil dari `state.json` |
