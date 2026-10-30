#!/usr/bin/env node
// Prepara el proyecto de Android a partir de los archivos de la app web.
// Lo ejecuta GitHub Actions antes de compilar; también se puede correr a mano:
//   npm install && node prepare.js
// Así el repositorio solo necesita archivos sueltos (sin carpetas de Android).

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;
const WEB_FILES = [
  "index.html",
  "app.js",
  "claves.js",
  "style.css",
  "peerjs.min.js",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
  "sw.js",
];
const NATIVE_JAVA = ["MainActivity.java", "RadioPlugin.java", "RadioService.java"];
const PKG_DIR = "android/app/src/main/java/app/walkieclaves/radio";
const RES = "android/app/src/main/res";
const DARK = "#0F1720";

const abs = (rel) => path.join(ROOT, rel);
function run(cmd) {
  console.log("> " + cmd);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}
function ensure(cond, msg) {
  if (!cond) {
    console.error("ERROR: " + msg);
    process.exit(1);
  }
}
function write(rel, content) {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content);
  console.log("  escrito " + rel);
}
function patch(rel, fn) {
  ensure(fs.existsSync(abs(rel)), "no existe " + rel);
  const before = fs.readFileSync(abs(rel), "utf8");
  const after = fn(before);
  if (after === before) console.warn("  AVISO: sin cambios en " + rel);
  fs.writeFileSync(abs(rel), after);
  console.log("  modificado " + rel);
}

// ---------- 1. Copiar la app web a www/ ----------
console.log("\n[1/6] Copiando la app web");
fs.rmSync(abs("www"), { recursive: true, force: true });
fs.mkdirSync(abs("www"));
for (const f of WEB_FILES) {
  if (!fs.existsSync(abs(f))) {
    ensure(f !== "index.html", "falta index.html en la raíz del repositorio");
    console.warn("  AVISO: falta " + f);
    continue;
  }
  fs.copyFileSync(abs(f), abs("www/" + f));
}

// ---------- 2. Crear el proyecto de Android ----------
console.log("\n[2/6] Creando el proyecto de Android");
if (!fs.existsSync(abs("android"))) run("npx cap add android");
for (const f of NATIVE_JAVA) ensure(fs.existsSync(abs(f)), "falta " + f);

// ---------- 3. Código nativo y permisos ----------
console.log("\n[3/6] Código nativo, permisos y servicio");
for (const f of NATIVE_JAVA) {
  write(PKG_DIR + "/" + f, fs.readFileSync(abs(f), "utf8"));
}

const PERMISSIONS = `
    <!-- Walkie Claves -->
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-feature android:name="android.hardware.microphone" android:required="false" />
`;
patch("android/app/src/main/AndroidManifest.xml", (x) => {
  if (x.includes("RadioService")) return x;
  x = x.replace(
    "</application>",
    '    <service\n            android:name=".RadioService"\n            android:exported="false"\n            android:foregroundServiceType="mediaPlayback" />\n    </application>'
  );
  x = x.replace("</manifest>", PERMISSIONS + "</manifest>");
  return x;
});

// Número de versión: sube solo con cada compilación
const run_n = parseInt(process.env.GITHUB_RUN_NUMBER || "1", 10) || 1;
patch("android/app/build.gradle", (x) =>
  x.replace(/versionCode\s+\d+/, "versionCode " + run_n).replace(/versionName\s+"[^"]*"/, 'versionName "1.' + run_n + '"')
);

// ---------- 4. Colores y tema oscuro ----------
console.log("\n[4/6] Tema oscuro");
patch(RES + "/values/styles.xml", (x) =>
  x
    .replace("Theme.AppCompat.DayNight.NoActionBar", "Theme.AppCompat.NoActionBar")
    .replace(
      /(<style name="AppTheme\.NoActionBar"[^>]*>)/,
      "$1\n        <item name=\"android:windowBackground\">" + DARK + "</item>\n" +
        "        <item name=\"android:statusBarColor\">" + DARK + "</item>\n" +
        "        <item name=\"android:navigationBarColor\">" + DARK + "</item>"
    )
);
write(
  RES + "/values/ic_launcher_background.xml",
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">' + DARK + "</color>\n</resources>\n"
);
// Ícono pequeño (blanco) para la notificación: un micrófono
write(
  RES + "/drawable/ic_stat_radio.xml",
  `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M12,14c1.66,0 3,-1.34 3,-3V5c0,-1.66 -1.34,-3 -3,-3S9,3.34 9,5v6c0,1.66 1.34,3 3,3zM17.3,11c0,3 -2.54,5.1 -5.3,5.1S6.7,14 6.7,11H5c0,3.41 2.72,6.23 6,6.72V21h2v-3.28c3.28,-0.48 6,-3.3 6,-6.72h-1.7z" />
</vector>
`
);

// ---------- 5. Íconos de la app y pantalla de inicio ----------
console.log("\n[5/6] Íconos");
async function icons() {
  let sharp;
  try {
    sharp = require("sharp");
  } catch (e) {
    console.warn("  AVISO: sin sharp, se dejan los íconos por defecto");
    return;
  }
  const src = abs("icon-512.png");
  if (!fs.existsSync(src)) return console.warn("  AVISO: falta icon-512.png");
  const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, size] of Object.entries(densities)) {
    const dir = abs(RES + "/mipmap-" + d);
    if (!fs.existsSync(dir)) continue;
    // Ícono normal
    await sharp(src).resize(size, size).png().toFile(path.join(dir, "ic_launcher.png"));
    // Ícono redondo
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`
    );
    await sharp(src)
      .resize(size, size)
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toFile(path.join(dir, "ic_launcher_round.png"));
    // Primer plano del ícono adaptable (108dp), con margen de seguridad
    const full = Math.round(size * 2.25);
    const inner = Math.round(full * 0.62);
    const innerBuf = await sharp(src).resize(inner, inner).png().toBuffer();
    await sharp({ create: { width: full, height: full, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: innerBuf, gravity: "center" }])
      .png()
      .toFile(path.join(dir, "ic_launcher_foreground.png"));
  }
  // Pantalla de inicio: fondo oscuro con el ícono al centro
  const splashFiles = [];
  for (const dir of fs.readdirSync(abs(RES))) {
    if (dir.startsWith("drawable") && fs.existsSync(abs(RES + "/" + dir + "/splash.png"))) {
      splashFiles.push(abs(RES + "/" + dir + "/splash.png"));
    }
  }
  for (const f of splashFiles) {
    const meta = await sharp(f).metadata();
    const w = meta.width;
    const h = meta.height;
    const s = Math.round(Math.min(w, h) * 0.3);
    const ic = await sharp(src).resize(s, s).png().toBuffer();
    await sharp({ create: { width: w, height: h, channels: 4, background: DARK } })
      .composite([{ input: ic, gravity: "center" }])
      .png()
      .toFile(f + ".tmp");
    fs.renameSync(f + ".tmp", f);
  }
  console.log("  íconos y pantalla de inicio listos");
}

(async () => {
  try {
    await icons();
  } catch (e) {
    console.warn("  AVISO: no se pudieron generar los íconos (" + e.message + "). Se usan los de siempre.");
  }

  // ---------- 6. Sincronizar ----------
  console.log("\n[6/6] Sincronizando");
  run("npx cap sync android");
  console.log("\nListo: el proyecto de Android está en la carpeta android/");
})();
