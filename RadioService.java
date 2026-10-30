package app.walkieclaves.radio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * Servicio en primer plano: mantiene viva la app (y con ella la conexión de voz) cuando
 * sales de ella o se apaga la pantalla. Muestra la notificación "Radio activa".
 */
public class RadioService extends Service {

    public static final String CH_RADIO = "radio_activa";
    public static final String CH_ALERT = "alertas_claves";
    private static final int ID_RADIO = 1001;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    /** Crea los dos canales de notificación (radio activa y alertas). */
    public static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        NotificationChannel radio = new NotificationChannel(CH_RADIO, "Radio activa", NotificationManager.IMPORTANCE_LOW);
        radio.setDescription("Mantiene la radio conectada en segundo plano");
        radio.setShowBadge(false);
        nm.createNotificationChannel(radio);

        NotificationChannel alert = new NotificationChannel(CH_ALERT, "Alertas de claves", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("Avisos de claves urgentes cuando la app no está en pantalla");
        alert.enableVibration(true);
        alert.setVibrationPattern(new long[] { 0, 300, 150, 300, 150, 500 });
        nm.createNotificationChannel(alert);
    }

    /** Al tocar una notificación se abre la app. */
    static PendingIntent openAppIntent(Context ctx) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(ctx, 0, open, flags);
    }

    /** Notificación de alerta (clave urgente) con sonido y vibración. */
    static void postAlert(Context ctx, String title, String text, boolean urgent) {
        ensureChannels(ctx);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CH_ALERT)
            .setSmallIcon(R.drawable.ic_stat_radio)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(ctx));
        if (urgent) {
            b.setVibrate(new long[] { 0, 400, 150, 400, 150, 600 });
        }
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            int id = 2000 + (int) (System.currentTimeMillis() % 100000L);
            nm.notify(id, b.build());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannels(this);

        String title = "Radio activa";
        String text = "Escuchando…";
        if (intent != null) {
            String t = intent.getStringExtra("title");
            String x = intent.getStringExtra("text");
            if (t != null && !t.isEmpty()) {
                title = t;
            }
            if (x != null && !x.isEmpty()) {
                text = x;
            }
        }

        Notification n = new NotificationCompat.Builder(this, CH_RADIO)
            .setSmallIcon(R.drawable.ic_stat_radio)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openAppIntent(this))
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ID_RADIO, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(ID_RADIO, n);
        }

        acquireLocks();
        return START_NOT_STICKY;
    }

    private void acquireLocks() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "walkieclaves:radio");
                    wakeLock.setReferenceCounted(false);
                    wakeLock.acquire();
                }
            }
        } catch (Exception ignored) {
        }
        try {
            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "walkieclaves:wifi");
                    wifiLock.setReferenceCounted(false);
                    wifiLock.acquire();
                }
            }
        } catch (Exception ignored) {
        }
    }

    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
        }
        wakeLock = null;
        try {
            if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
            }
        } catch (Exception ignored) {
        }
        wifiLock = null;
    }

    /** Si deslizas la app fuera de las recientes, también se apaga la radio. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseLocks();
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
