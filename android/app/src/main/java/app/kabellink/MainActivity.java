package app.kabellink;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;

public class MainActivity extends Activity {
    private TextView status;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 33)
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
        if (Build.VERSION.SDK_INT < 30)
            requestPermissions(new String[]{"android.permission.READ_EXTERNAL_STORAGE",
                    "android.permission.WRITE_EXTERNAL_STORAGE"}, 2);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(48, 96, 48, 48);

        TextView t = new TextView(this);
        t.setTextSize(18);
        t.setTextIsSelectable(true);
        t.setText("KabelLink aktif\n\nIP: " + ip()
                + "\nPort: " + LinkService.HTTP_PORT
                + "\nToken: " + LinkService.token(this)
                + "\n\nMasukkan token ini di aplikasi PC (sekali saja).");

        status = new TextView(this);
        status.setTextSize(16);
        status.setPadding(0, 48, 0, 0);

        Button allow = new Button(this);
        allow.setText("Izinkan akses semua file");
        allow.setOnClickListener(v -> askAllFiles());

        Button open = new Button(this);
        open.setText("Buka folder transfer");
        open.setOnClickListener(v -> openBaseFolder());

        Button start = new Button(this);
        start.setText("Start");
        start.setOnClickListener(v -> startForegroundService(new Intent(this, LinkService.class)));

        Button stop = new Button(this);
        stop.setText("Stop");
        stop.setOnClickListener(v -> stopService(new Intent(this, LinkService.class)));

        box.addView(t);
        box.addView(status);
        box.addView(allow);
        box.addView(open);
        box.addView(start);
        box.addView(stop);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);
        setContentView(scroll);
        startForegroundService(new Intent(this, LinkService.class));
    }

    @Override protected void onResume() {
        super.onResume();
        refresh();
    }

    private void refresh() {
        boolean all = LinkService.allFiles();
        status.setText("Folder transfer: " + LinkService.baseDir(this).getAbsolutePath()
                + (all ? "\nAkses semua file: AKTIF (DCIM, Download, dll bisa ditransfer)"
                       : "\nAkses semua file: BELUM — transfer hanya di folder aplikasi"));
    }

    private void askAllFiles() {
        if (Build.VERSION.SDK_INT >= 30) {
            startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getPackageName())));
        } else {
            requestPermissions(new String[]{"android.permission.READ_EXTERNAL_STORAGE",
                    "android.permission.WRITE_EXTERNAL_STORAGE"}, 2);
        }
    }

    @SuppressWarnings("ResultOfMethodCallIgnored")
    private void openBaseFolder() {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.fromFile(LinkService.baseDir(this)), "resource/folder");
            startActivity(i);
        } catch (Exception ignored) { }
    }

    static String ip() {
        try {
            for (NetworkInterface n : Collections.list(NetworkInterface.getNetworkInterfaces()))
                for (InetAddress a : Collections.list(n.getInetAddresses()))
                    if (!a.isLoopbackAddress() && a instanceof Inet4Address) return a.getHostAddress();
        } catch (Exception ignored) { }
        return "?";
    }
}
