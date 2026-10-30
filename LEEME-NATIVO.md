# Walkie Claves — versión nativa de Android

La app se compila en la nube con GitHub Actions (sin computadora) y deja un APK listo para instalar.

## Subir los archivos al repositorio (Wiki-tok)

1. Extrae el zip en tu teléfono.
2. En el repositorio: **Add file → Upload files** y selecciona **todos los archivos menos `android.yml`**. Haz **Commit changes**.
   - Los archivos que ya existen (`index.html`, `app.js`, etc.) se reemplazan por los nuevos.
   - Revisa que los nombres queden exactos (sin "(1)" ni "-2").
3. **Add file → Create new file**. En el nombre escribe exactamente `.github/workflows/android.yml`, pega todo el contenido del archivo `android.yml` y haz **Commit changes**.

## Compilar y descargar el APK

1. Pestaña **Actions** → entra a **Compilar APK de Android**. Tarda unos 6 a 10 minutos. Debe terminar en verde.
2. En la página principal del repositorio, a la derecha, entra a **Releases** y baja `walkie-claves.apk`.
3. Instálalo (Android pide permitir instalar desde esta fuente).
4. Las siguientes versiones se actualizan encima, sin desinstalar.

## Primera vez que la abres

Acepta micrófono, notificaciones y "sin restricciones de batería". Si el último diálogo no sale, ve a Ajustes → Apps → Walkie Claves → Batería → Sin restricciones.

## Qué cambia respecto a la PWA

- Notificación "Radio activa" y la radio sigue conectada al salir de la app o apagar la pantalla.
- Si llega una clave urgente o de aviso con la app fuera de pantalla, suena y vibra una notificación.
- Casilla "Mantener pantalla encendida" (apagada por defecto).
- La transcripción usa el reconocimiento de voz de Android.

## Si falla la compilación

Abre la compilación en rojo en **Actions**, toca el paso marcado con la X y mándame una captura del error.

## Nota sobre la llave de firma

`debug.keystore` es una llave de pruebas, pública. Sirve para instalar y actualizar el APK. Para Play Store se crea una llave propia y privada.
