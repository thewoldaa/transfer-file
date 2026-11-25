# KabelLink — transfer file PC ⇄ HP Android

Hubungkan HP Android (target: Samsung Galaxy A12) ke PC lewat **Wi-Fi atau kabel USB**,
lalu **kirim/ambil file dua arah**: foto, video, dokumen, folder, apa saja.

```
pc/        -> program PC (Node >= 24, tanpa dependensi) + pembangun EXE + Web UI lokal
android/   -> APK pendamping (Java, jalan sebagai user biasa, tanpa root)
.github/   -> workflow GitHub Actions: build APK + EXE, dan rilis otomatis
```

APK dan EXE hasil build bisa diunduh di tab **Releases** repo ini.

## Cara pakai (paling cepat)

1. Unduh `transfer-file.apk` dan `transfer-file.exe` dari **Releases**.
2. Pasang APK di HP, buka aplikasinya:
   - catat **IP** dan **Token** (8 karakter),
   - ketuk **Izinkan akses semua file** (supaya DCIM/Download bisa ditransfer),
   - biarkan servisnya jalan (ada notifikasi "KabelLink aktif").
3. Jalankan `transfer-file.exe` di PC (klik dua kali juga boleh).
4. Masukkan token saat diminta (sekali saja, disimpan di `%USERPROFILE%\.transfer-file\config.json`).
5. Ketik **`ui`** untuk membuka **Web UI** di browser.

Setelah itu PC menemukan HP otomatis (IP tersimpan → broadcast UDP → scan subnet /24).
Kalau kabel USB tercolok dan USB debugging aktif, kabel otomatis dipakai dan Wi-Fi jadi cadangan.

## Web UI (paling mudah)

Ketik `ui` di terminal, atau jalankan `transfer-file.exe --ui`, maka browser terbuka di
`http://127.0.0.1:8767`. Isinya:

- **Isi HP** — telusuri folder, lihat ukuran, tombol **Unduh** / **Unduh folder** / **Hapus**.
- **Kirim ke HP** — taruh file di kotak (drag & drop) atau klik untuk pilih banyak file sekaligus.
- **Antrean** — progress tiap transfer, status selesai/gagal, penanda `sha256 ok` dan `dihapus di HP`.
  Transfer yang gagal punya tombol **Lanjutkan** dan melanjutkan dari byte terakhir.
- **Cut-off** dan **Verifikasi SHA-256** — sakelar, tersimpan di config.
- **Mode transmisi lambat** — pilih batas kecepatan (128 KB/detik … 4 MB/detik) supaya transfer
  besar semalaman tidak membuat HP/PC panas.
- **Sisa ruang HP** tampil di header.

Semua file unduhan masuk ke `Downloads\transfer-file\` (bisa dibuka lewat tombol
**Buka folder PC**). Server UI hanya mendengarkan di `127.0.0.1` dan mewajibkan header
khusus, jadi situs lain tidak bisa memerintahkannya.

## Mode Cut-off (potong-pindah)

Aktifkan dengan `cutoff on` atau sakelar **Cut-off** di Web UI. Saat aktif, setiap file
yang **berhasil diunduh** akan **dihapus dari HP** — tapi hanya setelah:

1. jumlah byte yang diterima sama dengan ukuran asli, **dan**
2. **SHA-256** file di HP sama dengan file di PC.

Kalau salah satu gagal, file **tidak dihapus** dan diberi tanda gagal. Untuk folder,
folder kosong di HP ikut dirapikan setelah semua isinya pindah. Cut-off hanya berlaku
untuk arah HP → PC; file yang kamu kirim ke HP tidak dihapus dari PC.

## Jalan di latar belakang

Supaya transfer besar bisa ditinggal tidur, jalankan tanpa jendela konsol:

```
transfer-file.exe --background      (atau: ketik bg di terminal)
```

Proses berjalan terpisah, Web UI tetap aktif di `http://127.0.0.1:8767`, dan jendela
terminal boleh ditutup. Perintah pengelola:

```
--status        cek apakah latar belakang jalan (PID + lokasi log)
--open          buka Web UI (otomatis menjalankan latar belakang bila belum)
--stop          hentikan proses latar belakang
--autostart on  ikut menyala otomatis saat Windows menyala
--autostart off matikan autostart
```

Log ada di `%USERPROFILE%\.transfer-file\kabellink.log`, PID di `daemon.pid` (folder yang sama).
Di HP, servis memegang **wake-lock** (CPU + Wi-Fi) selama aktif, jadi transfer tidak putus
hanya karena layar mati. Tetap disarankan set baterai aplikasi ke *Unrestricted*.

## Mode transmisi lambat

Membatasi kecepatan supaya perangkat tidak panas saat transfer besar berjalan lama:

```
kabellink> limit 256      batasi 256 KB/detik
kabellink> limit 1024     batasi 1 MB/detik
kabellink> limit off      kembali tanpa batas
```

Di Web UI, pilih **Mode transmisi lambat → Batas kecepatan**. Batas ini berlaku untuk
unduh **dan** kirim, serta tersimpan di config. Karena progress dicatat ke disk, transfer
yang lambat pun tetap bisa dilanjutkan kapan saja.

## Lanjut otomatis (resume)

Koneksi putus di tengah jalan **tidak menghapus kemajuan**:

- **HP → PC**: data ditulis ke `<nama>.part`. Unduhan berikutnya memakai HTTP `Range`
  dan melanjutkan dari byte terakhir, lalu diganti nama setelah ukuran + SHA-256 cocok.
- **PC → HP**: data ditulis ke `<nama>.part` **di HP** lewat `offset`, lalu diganti nama
  (`/rename`) setelah selesai. Jalankan `put` yang sama lagi kapan pun untuk melanjutkan.

Di Web UI, transfer yang gagal menampilkan tombol **Lanjutkan** (unduh) atau **Kirim ulang**
(kirim). Tidak ada batas waktu — bisa dilanjutkan besok atau kapan saja selama file `.part`
masih ada.

## Perintah transfer

```
ui                         buka Web UI di browser
bg | stop | open           latar belakang: mulai / hentikan / buka Web UI
autostart [on|off]         jalankan otomatis saat Windows menyala
limit <KB/detik|off>       mode transmisi lambat (mis. limit 256)
ls [folder]                daftar isi HP (+ sisa ruang)
get <jarak> [lokal]        ambil file ATAU folder dari HP
put <lokal> [folder jarak] kirim file ATAU folder ke HP
rm <jarak>                 hapus file di HP
cutoff [on|off]            mode potong: hapus di HP setelah unduhan lolos SHA-256
verify [on|off]            cek SHA-256 setiap unduhan (default: on)
```

Contoh:

```
kabellink> ls
kabellink> ls DCIM/Camera
kabellink> get DCIM/Camera/20240101_120000.jpg D:\foto
kabellink> get DCIM/Camera D:\backup-camera
kabellink> put "D:\film kucing.mp4" Download
kabellink> put "D:\album" Download
```

Nama dengan spasi pakai tanda kutip. Transfer folder berjalan rekursif dan menampilkan progress.
Unduhan **dan** unggahan memakai akhiran `.part` dan bisa dilanjutkan kapan saja kalau
koneksi terputus — jalankan perintah yang sama lagi dan ia melanjutkan dari byte terakhir.

Perintah lain: `status`, `info`, `sh <perintah>`, `adb-on`, `adb <args>`, `wifi`, `token <kode>`, `exit`.

## Di HP

- Folder akar transfer = `/sdcard` (seluruh penyimpanan) **jika** izin "Semua file" diberikan.
  Kalau belum, akar = folder milik aplikasi (`Android/data/app.kabellink/files`).
- Server di HP: HTTP `8765` (wajib token) + UDP `8766` untuk penemuan. Jalan sebagai user biasa.
- Selama servis aktif, APK memegang **wake-lock** CPU + Wi-Fi (`WAKE_LOCK`), jadi transfer
  malam hari tetap jalan walau layar mati. Set baterai aplikasi ke *Unrestricted* agar
  sistem tidak mematikannya.

## Kabel USB walau mode "Mengisi daya"

1. **Developer options** di HP: Settings → About phone → Software information → tap *Build number* 7x → aktifkan *USB debugging*.
2. Colok kabel. Kalau muncul dialog "Izinkan USB debugging", tap **Izinkan** (centang "Selalu izinkan").
3. Opsional, sekali saja lewat kabel, supaya APK bisa menyalakan USB debugging sendiri dari jaringan:
   `adb shell pm grant app.kabellink android.permission.WRITE_SECURE_SETTINGS`

PC memantau kabel tiap 3 detik dengan perbaikan otomatis:
`unauthorized` → minta tap Izinkan · `offline` → restart adb · `no permissions` (Linux) → aturan udev Samsung · HP terlihat tapi adb tidak → saran driver · tidak terlihat sama sekali → kabel hanya-cas.

Tanpa adb sama sekali pun tetap bisa: **mode Wi-Fi** tidak memerlukan adb maupun USB debugging.

## Bangun sendiri lewat GitHub

Push repo → tab **Actions** → workflow **build**:

- job **APK** menghasilkan artifact `apk` (file `transfer-file.apk`),
- job **EXE** menghasilkan artifact `exe` (file `transfer-file.exe`).

Buat tag untuk merilis keduanya sekaligus:

```
git tag v1.3.0
git push origin v1.3.0
```

Job **release** mengunggah `transfer-file.apk`, `transfer-file.exe`, dan `SHA256SUMS.txt` ke Releases.

EXE dibangun dengan Node *Single Executable Application* (esbuild → blob SEA → postject),
jadi tidak perlu memasang Node di PC pengguna. EXE ini tidak ditandatangani, jadi Windows
SmartScreen bisa menampilkan peringatan "More info → Run anyway".

## Build lokal

```
cd pc
npm start            # jalankan langsung dengan Node 24+
npm run mock         # tiruan APK untuk uji tanpa HP (token TESTTOKN)
npm run build        # hasilkan dist/transfer-file.exe
```

APK: buka folder `android/` di Android Studio, atau `gradle -p android assembleDebug`.

## Batas yang tidak bisa ditembus (sengaja, keamanan Android)

- USB debugging harus pernah dinyalakan dan dialog "Izinkan" pernah disetujui di HP.
- Kabel yang benar-benar hanya-cas (tanpa jalur data) tidak bisa disambungkan lewat software.
- `sh` berjalan sebagai user aplikasi, bukan root.
- Server di HP memakai token di HTTP biasa (bukan HTTPS): pakai di Wi-Fi tepercaya.
- Root PC dengan adb: kunci RSA yang dipakai milik root, jadi HP akan meminta izin lagi sekali.
