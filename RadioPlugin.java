package app.walkieclaves.radio;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Puente entre la app web y Android: servicio en segundo plano, alertas,
 * pantalla encendida y exención de ahorro de batería.
 * En JavaScript se usa como Capacitor.Plugins.Radio
 */
@CapacitorPlugin(
    name = "Radio",
    permissions = { @Permission(strings = { "android.permission.POST_NOTIFICATIONS" }, alias = "notifications") }
)
public class RadioPlugin extends Plugin {

    @Override
    public void load() {
        RadioService.ensureChannels(getContext());
    }

    /** Inicia el servicio "Radio activa". En Android 13+ primero pide permiso para notificaciones. */
    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notifCallback");
        } else {
            doStart(call);
        }
    }

    @PermissionCallback
    private void notifCallback(PluginCall call) {
        // Aunque no den permiso de notificaciones, el servicio sí se inicia
        doStart(call);
    }

    private void doStart(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent i = new Intent(ctx, RadioService.class);
            i.putExtra("title", call.getString("title", "Radio activa"));
            i.putExtra("text", call.getString("text", "Escuchando…"));
            ContextCompat.startForegroundService(ctx, i);
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo iniciar el servicio: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            Context ctx = getContext();
            ctx.stopService(new Intent(ctx, RadioService.class));
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    /** Notificación con sonido y vibración (para claves urgentes con la app fuera de pantalla). */
    @PluginMethod
    public void alert(PluginCall call) {
        try {
            String title = call.getString("title", "Alerta");
            String text = call.getString("text", "");
            boolean urgent = Boolean.TRUE.equals(call.getBoolean("urgent", false));
            RadioService.postAlert(getContext(), title, text, urgent);
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    /** Mantiene la pantalla encendida mientras la app está abierta (opcional). */
    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        try {
            getActivity()
                .runOnUiThread(
                    () -> {
                        try {
                            if (on) {
                                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            } else {
                                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            }
                        } catch (Exception ignored) {
                        }
                    }
                );
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    /** Pide que la app no sea limitada por el ahorro de batería (importante en POCO, Honor, etc.). */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        JSObject r = new JSObject();
        try {
            Context ctx = getContext();
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
            r.put("ignoring", ignoring);
            if (!ignoring) {
                Intent it = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                it.setData(Uri.parse("package:" + ctx.getPackageName()));
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(it);
            }
        } catch (Exception e) {
            r.put("ignoring", false);
        }
        call.resolve(r);
    }

    /** Abre la lista de ajustes de optimización de batería (por si el diálogo anterior no aparece). */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        try {
            Intent it = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(it);
        } catch (Exception ignored) {
        }
        call.resolve();
    }
}
