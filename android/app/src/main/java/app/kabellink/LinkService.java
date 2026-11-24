package app.kabellink;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.os.StatFs;
import android.provider.Settings;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import static java.nio.charset.StandardCharsets.UTF_8;

/**
 * Server kecil di HP: UDP 8766 (penemuan) + HTTP 8765 (kontrol + transfer file, wajib token).
 * Jalan sebagai user biasa, tanpa root.
 */
public class LinkService extends Service {
    static final int HTTP_PORT = 8765, UDP_PORT = 8766;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile boolean running;
    private ServerSocket http;
    private DatagramSocket udp;
    private WifiManager.MulticastLock lock;

    static String token(Context c) {
        SharedPreferences p = c.getSharedPreferences("kl", MODE_PRIVATE);
        String t = p.getString("token", null);
        if (t == null) {
            String abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
            SecureRandom r = new SecureRandom();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(abc.charAt(r.nextInt(abc.length())));
            t = sb.toString();
            p.edit().putString("token", t).apply();
        }
        return t;
    }

    /** True kalau aplikasi boleh menyentuh seluruh /storage/emulated/0 (izin "Semua file"). */
    static boolean allFiles() {
        return Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager();
    }

    /** Folder akar transfer: seluruh penyimpanan kalau diizinkan, kalau tidak folder milik app. */
    static File baseDir(Context c) {
        if (allFiles()) return Environment.getExternalStorageDirectory();
        File ext = c.getExternalFilesDir(null);
        return ext != null ? ext : c.getFilesDir();
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("kl", "KabelLink", NotificationManager.IMPORTANCE_LOW));
        Notification n = new Notification.Builder(this, "kl")
                .setContentTitle("KabelLink aktif")
                .setContentText("Port " + HTTP_PORT)
                .setSmallIcon(android.R.drawable.ic_dialog_info).build();
        startForeground(1, n);
        if (!running) {
            running = true;
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            lock = wm.createMulticastLock("kl");
            lock.acquire();
            pool.execute(this::httpLoop);
            pool.execute(this::udpLoop);
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        running = false;
        try { if (http != null) http.close(); } catch (IOException ignored) { }
        if (udp != null) udp.close();
        if (lock != null && lock.isHeld()) lock.release();
        pool.shutdownNow();
        super.onDestroy();
    }

    private void httpLoop() {
        try {
            http = new ServerSocket(HTTP_PORT);
            while (running) {
                Socket s = http.accept();
                pool.execute(() -> handle(s));
            }
        } catch (IOException ignored) { }
    }

    private void udpLoop() {
        try {
            udp = new DatagramSocket(null);
            udp.setReuseAddress(true);
            udp.bind(new InetSocketAddress(UDP_PORT));
            byte[] buf = new byte[256];
            while (running) {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                udp.receive(p);
                if (new String(p.getData(), 0, p.getLength(), UTF_8).trim().equals("KABELLINK?")) {
                    byte[] r = new JSONObject().put("app", "kabellink").put("name", Build.MODEL)
                            .put("port", HTTP_PORT).toString().getBytes(UTF_8);
                    udp.send(new DatagramPacket(r, r.length, p.getAddress(), p.getPort()));
                }
            }
        } catch (Exception ignored) { }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 4096) break;
        }
        return (c == -1 && sb.length() == 0) ? null : sb.toString();
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            // transfer file bisa lambat; batas idle longgar, kontrol tetap cepat
            sock.setSoTimeout(120000);
            InputStream in = new BufferedInputStream(sock.getInputStream(), 65536);
            String line = readLine(in);
            if (line == null) return;
            String[] rl = line.split(" ");
            String method = rl.length > 0 ? rl[0] : "GET";
            String target = rl.length > 1 ? rl[1] : "/";
            long len = 0, rangeStart = -1;
            String tok = "", h;
            while ((h = readLine(in)) != null && !h.isEmpty()) {
                String l = h.toLowerCase();
                if (l.startsWith("content-length:")) {
                    try { len = Long.parseLong(h.substring(15).trim()); } catch (NumberFormatException ignored) { }
                } else if (l.startsWith("x-token:")) tok = h.substring(8).trim();
                else if (l.startsWith("range:")) {
                    String v = h.substring(6).trim();
                    if (v.startsWith("bytes=")) {
                        try { rangeStart = Long.parseLong(v.substring(6).split("-")[0].trim()); }
                        catch (NumberFormatException ignored) { }
                    }
                }
            }

            int q = target.indexOf('?');
            String path = q >= 0 ? target.substring(0, q) : target;
            String query = q >= 0 ? target.substring(q + 1) : "";

            if (path.equals("/ping")) {
                send(sock, 200, new JSONObject().put("app", "kabellink").put("ok", true));
                return;
            }
            if (!MessageDigest.isEqual(tok.getBytes(UTF_8), token(this).getBytes(UTF_8))) {
                send(sock, 401, new JSONObject().put("error", "token salah"));
                return;
            }
            switch (path) {
                case "/info":
                    send(sock, 200, info());
                    break;
                case "/shell":
                    send(sock, 200, shell(new String(readBody(in, len), UTF_8)));
                    break;
                case "/adb-on":
                    send(sock, 200, adbOn());
                    break;
                case "/files":
                    send(sock, 200, list(param(query, "dir")));
                    break;
                case "/hash":
                    send(sock, 200, hash(param(query, "path")));
                    break;
                case "/file":
                    if (method.equals("GET") || method.equals("HEAD")) {
                        download(sock, param(query, "path"), method.equals("HEAD"), rangeStart);
                    } else if (method.equals("PUT") || method.equals("POST")) {
                        send(sock, 200, upload(in, len, param(query, "path")));
                    } else if (method.equals("DELETE")) {
                        send(sock, 200, removeFile(param(query, "path")));
                    } else {
                        send(sock, 405, new JSONObject().put("error", "method tidak didukung"));
                    }
                    break;
                default:
                    send(sock, 404, new JSONObject().put("error", "not found"));
            }
        } catch (Exception ignored) { }
    }

    private static byte[] readBody(InputStream in, long len) throws IOException {
        int n = (int) Math.min(len, 65536);
        byte[] body = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(body, off, n - off);
            if (r < 0) break;
            off += r;
        }
        return off == n ? body : Arrays.copyOf(body, off);
    }

    private static void send(Socket sock, int code, JSONObject out) throws IOException {
        byte[] b = out.toString().getBytes(UTF_8);
        OutputStream os = sock.getOutputStream();
        os.write(("HTTP/1.1 " + code + " X\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "
                + b.length + "\r\nConnection: close\r\n\r\n").getBytes(UTF_8));
        os.write(b);
        os.flush();
    }

    // ---------- transfer file ----------

    private static String param(String query, String key) {
        if (query == null || query.isEmpty()) return "";
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            String k = eq >= 0 ? pair.substring(0, eq) : pair;
            if (k.equals(key)) {
                String v = eq >= 0 ? pair.substring(eq + 1) : "";
                try { return URLDecoder.decode(v, "UTF-8"); } catch (Exception e) { return v; }
            }
        }
        return "";
    }

    /** Ubah path relatif jadi File, atau null kalau keluar dari folder akar (path traversal). */
    private File resolve(String rel) throws IOException {
        File base = baseDir(this).getCanonicalFile();
        String r = rel == null ? "" : rel.replace('\\', '/').trim();
        while (r.startsWith("/")) r = r.substring(1);
        File f = new File(base, r).getCanonicalFile();
        if (!f.equals(base) && !f.getPath().startsWith(base.getPath() + File.separator)) return null;
        return f;
    }

    private static String relPath(File base, File f) {
        return base.toPath().relativize(f.toPath()).toString().replace('\\', '/');
    }

    private JSONObject list(String dir) throws Exception {
        File base = baseDir(this).getCanonicalFile();
        JSONObject o = new JSONObject().put("base", base.getPath()).put("all_files", allFiles());
        try { o.put("free", new StatFs(base.getPath()).getAvailableBytes()); } catch (Exception ignored) { }
        File d = resolve(dir);
        if (d == null) return o.put("error", "path tidak valid");
        if (!d.exists()) return o.put("path", relPath(base, d)).put("error", "tidak ada");
        if (!d.isDirectory()) return o.put("path", relPath(base, d)).put("error", "bukan folder");
        File[] fs = d.listFiles();
        JSONArray a = new JSONArray();
        if (fs != null) {
            Arrays.sort(fs, (x, y) -> x.isDirectory() != y.isDirectory() ? (x.isDirectory() ? -1 : 1)
                    : x.getName().compareToIgnoreCase(y.getName()));
            for (File f : fs) {
                long size = f.isDirectory() ? 0 : f.length();
                a.put(new JSONObject().put("name", f.getName()).put("dir", f.isDirectory())
                        .put("size", size).put("path", relPath(base, f)));
            }
        }
        return o.put("path", relPath(base, d)).put("entries", a);
    }

    /** Unduh file; mendukung Range (lanjut unduhan yang terputus). */
    private void download(Socket sock, String rel, boolean headOnly, long rangeStart) throws Exception {
        File f = resolve(rel);
        if (f == null) { send(sock, 403, new JSONObject().put("error", "path tidak valid")); return; }
        if (!f.isFile()) { send(sock, 404, new JSONObject().put("error", "bukan file")); return; }
        long size = f.length();
        if (rangeStart > size) {
            send(sock, 416, new JSONObject().put("error", "range di luar ukuran file").put("size", size));
            return;
        }
        boolean part = rangeStart > 0 && rangeStart < size;
        long start = part ? rangeStart : 0;
        long send = size - start;
        String head = part
                ? "HTTP/1.1 206 X\r\nContent-Type: application/octet-stream\r\nContent-Length: " + send
                  + "\r\nContent-Range: bytes " + start + "-" + (size - 1) + "/" + size
                  + "\r\nConnection: close\r\n\r\n"
                : "HTTP/1.1 200 X\r\nContent-Type: application/octet-stream\r\nContent-Length: " + size
                  + "\r\nConnection: close\r\n\r\n";
        OutputStream os = new BufferedOutputStream(sock.getOutputStream(), 65536);
        os.write(head.getBytes(UTF_8));
        if (!headOnly) {
            try (FileInputStream fi = new FileInputStream(f)) {
                long skip = start;
                while (skip > 0) {
                    long s = fi.skip(skip);
                    if (s <= 0) break;
                    skip -= s;
                }
                byte[] b = new byte[65536];
                int n;
                while ((n = fi.read(b)) > 0) os.write(b, 0, n);
            }
        }
        os.flush();
    }

    /** SHA-256 isi file, dihitung di HP. */
    private JSONObject hash(String rel) throws Exception {
        File f = resolve(rel);
        if (f == null) return new JSONObject().put("error", "path tidak valid");
        if (!f.isFile()) return new JSONObject().put("error", "bukan file");
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (FileInputStream fi = new FileInputStream(f)) {
            byte[] b = new byte[65536];
            int n;
            while ((n = fi.read(b)) > 0) md.update(b, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte x : md.digest()) sb.append(String.format("%02x", x));
        return new JSONObject().put("sha256", sb.toString()).put("size", f.length());
    }

    /** Hapus file (dipakai mode cut-off setelah transfer + checksum cocok). */
    private JSONObject removeFile(String rel) throws Exception {
        File f = resolve(rel);
        if (f == null) return new JSONObject().put("error", "path tidak valid");
        if (f.isDirectory()) return new JSONObject().put("error", "target adalah folder");
        if (!f.isFile()) return new JSONObject().put("error", "tidak ada");
        long size = f.length();
        if (!f.delete()) return new JSONObject().put("error", "gagal menghapus");
        return new JSONObject().put("ok", true).put("path", rel).put("size", size);
    }

    private JSONObject upload(InputStream in, long len, String rel) throws Exception {
        JSONObject o = new JSONObject();
        File f = resolve(rel);
        if (f == null) return o.put("error", "path tidak valid");
        if (f.isDirectory()) return o.put("error", "target adalah folder");
        if (len <= 0) return o.put("error", "isi file kosong (butuh Content-Length)");
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return o.put("error", "gagal membuat folder");
        long left = len;
        try (FileOutputStream fo = new FileOutputStream(f)) {
            byte[] b = new byte[65536];
            int n;
            while (left > 0 && (n = in.read(b, 0, (int) Math.min(b.length, left))) > 0) {
                fo.write(b, 0, n);
                left -= n;
            }
        }
        if (left > 0) {
            f.delete();
            return o.put("error", "transfer terputus (" + (len - left) + "/" + len + " byte)");
        }
        return o.put("ok", true).put("path", rel).put("size", f.length());
    }

    // ---------- kontrol ----------

    private JSONObject info() throws Exception {
        JSONObject o = new JSONObject()
                .put("model", Build.MODEL).put("maker", Build.MANUFACTURER)
                .put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
                .put("base", baseDir(this).getAbsolutePath()).put("all_files", allFiles());
        Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b != null) {
            o.put("battery", b.getIntExtra("level", -1) * 100 / Math.max(1, b.getIntExtra("scale", 100)));
            o.put("plugged", b.getIntExtra("plugged", 0));
        }
        Intent u = registerReceiver(null, new IntentFilter("android.hardware.usb.action.USB_STATE"));
        if (u != null) {
            o.put("usb_connected", u.getBooleanExtra("connected", false));
            o.put("usb_adb", u.getBooleanExtra("adb", false));
        }
        o.put("adb_enabled", Settings.Global.getInt(getContentResolver(), Settings.Global.ADB_ENABLED, 0) == 1);
        return o;
    }

    /** Perintah shell dengan hak user aplikasi (bukan root). Batas 15 detik / 64 KB. */
    private JSONObject shell(String cmd) throws Exception {
        java.lang.Process p = new ProcessBuilder("sh", "-c", cmd).redirectErrorStream(true).start();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        Thread t = new Thread(() -> {
            try (InputStream i = p.getInputStream()) {
                byte[] bf = new byte[4096];
                int n;
                while ((n = i.read(bf)) > 0 && bo.size() < 65536) bo.write(bf, 0, n);
            } catch (IOException ignored) { }
        });
        t.start();
        boolean done = p.waitFor(15, TimeUnit.SECONDS);
        if (!done) p.destroyForcibly();
        t.join(500);
        return new JSONObject().put("code", done ? p.exitValue() : -1).put("out", bo.toString("UTF-8"));
    }

    private JSONObject adbOn() throws Exception {
        JSONObject o = new JSONObject();
        try {
            Settings.Global.putInt(getContentResolver(), Settings.Global.ADB_ENABLED, 1);
            o.put("ok", true);
        } catch (SecurityException e) {
            o.put("ok", false).put("error",
                    "butuh izin sekali: adb shell pm grant app.kabellink android.permission.WRITE_SECURE_SETTINGS");
        }
        return o;
    }
}
