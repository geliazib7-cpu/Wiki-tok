// Walkie Claves — lógica principal.
// Voz: WebRTC (PeerJS). Cada sala tiene "casillas" 1..8: quien entra toma la primera libre
// y se conecta a las casillas con número menor. Así no hace falta servidor propio.
(function () {
  "use strict";

  const { CLAVES, detectClaves, normalize } = window.Claves;
  const MAX_SLOTS = 8;
  const MIC_OPTIONS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const $ = (s) => document.querySelector(s);
  const ROLE_CODES = Object.keys(CLAVES).filter((k) => CLAVES[k][1] === "role");

  // ---------- Preferencias guardadas ----------
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("wk_" + k);
        return v === null ? d : v;
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("wk_" + k, v);
      } catch (e) {}
    },
  };

  const state = {
    peer: null,
    myId: null,
    mySlot: 0,
    room: "",
    name: "",
    role: "",
    stream: null,
    talking: false,
    wake: null,
    audioCtx: null,
    silent: null, // flujo de audio mudo: va en la llamada mientras el micrófono está libre
    micTrack: null,
    micBusy: false,
    releaseMode: true, // true = el micrófono solo se usa mientras hablas
    timers: [],
    alertTimer: null,
    inRoom: false,
  };
  // peerId -> { slot, name, role, data, call, audio, talking }
  const peers = new Map();
  const pending = new Set();

  // ---------- Utilidades ----------
  const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  const idFor = (slot) => `wktalkie-${state.room}-${slot}`;
  const slotOf = (id) => parseInt(String(id).split("-").pop(), 10) || 0;
  const cleanRoom = (s) => normalize(s).replace(/ /g, "").slice(0, 24);
  const labelOf = (e) => e.name + (e.role ? ` (${e.role})` : "");
  const timeStr = () =>
    new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });

  function setStatus(text, kind) {
    $("#statusText").textContent = text;
    const dot = document.querySelector("#status .dot");
    dot.className = "dot" + (kind ? " " + kind : "");
  }
  function note(text) {
    $("#note").textContent = text || "";
  }
  function joinMsg(text) {
    $("#joinMsg").textContent = text || "";
  }

  // ---------- Micrófono: se usa solo mientras hablas ----------
  // En la llamada va un audio mudo. Al presionar el botón se abre el micrófono real y se
  // cambia esa pista; al soltar se cambia de vuelta y se suelta el micrófono, así otras
  // apps (llamadas, notas de voz) pueden usarlo.
  function makeSilent() {
    if (state.silent || !state.audioCtx) return state.silent;
    try {
      if (state.audioCtx.createMediaStreamDestination) {
        state.silent = state.audioCtx.createMediaStreamDestination().stream;
      }
    } catch (e) {
      state.silent = null;
    }
    return state.silent;
  }
  const useRelease = () => state.releaseMode && !!state.silent;
  const outStream = () => state.stream || state.silent;

  // Pone `track` como la pista de audio que se envía en todas las llamadas
  function swapTrack(track) {
    if (!track) return;
    peers.forEach((e) => {
      const pc = e.call && e.call.peerConnection;
      if (!pc || !pc.getSenders) return;
      pc.getSenders().forEach((s) => {
        if (s.track && s.track.kind === "audio" && s.track !== track) {
          try {
            s.replaceTrack(track);
          } catch (_) {}
        }
      });
    });
  }
  const silentTrack = () => (state.silent && state.silent.getAudioTracks()[0]) || null;

  async function acquireMic() {
    if (state.micBusy) return;
    if (state.micTrack && state.micTrack.readyState === "live") {
      state.micTrack.enabled = true;
      swapTrack(state.micTrack);
      return;
    }
    state.micBusy = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: MIC_OPTIONS });
      if (!state.inRoom || !state.talking) {
        // ya soltaste el botón antes de que abriera
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      state.stream = s;
      state.micTrack = s.getAudioTracks()[0] || null;
      if (state.micTrack) {
        state.micTrack.enabled = true;
        swapTrack(state.micTrack);
      }
    } catch (e) {
      note("No pude abrir el micrófono. ¿Otra app lo está usando?");
    } finally {
      state.micBusy = false;
    }
  }

  function releaseMic() {
    swapTrack(silentTrack());
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    state.micTrack = null;
  }

  // Cuando el usuario cambia la opción con la sala abierta
  async function applyMicMode() {
    state.releaseMode = $("#optRelease").checked;
    if (!state.inRoom) return;
    if (useRelease()) {
      if (!state.talking) releaseMic();
    } else if (!state.stream) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: MIC_OPTIONS });
        if (!state.inRoom) return s.getTracks().forEach((t) => t.stop());
        state.stream = s;
        state.micTrack = s.getAudioTracks()[0] || null;
        s.getAudioTracks().forEach((t) => (t.enabled = state.talking));
        swapTrack(state.micTrack);
      } catch (e) {
        note("No pude abrir el micrófono.");
      }
    }
  }

  // ---------- Pantalla de entrada ----------
  function buildRoleSelect() {
    const sel = $("#role");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Sin rol";
    sel.appendChild(none);
    ROLE_CODES.forEach((code) => {
      const o = document.createElement("option");
      o.value = code;
      o.textContent = `${code} · ${CLAVES[code][0]}`;
      sel.appendChild(o);
    });
  }

  async function enter() {
    joinMsg("");
    const name = clip($("#name").value, 20) || "Anónimo";
    const room = cleanRoom($("#room").value);
    if (!room) return joinMsg("Escribe un código de sala (el mismo para todos).");
    if (!window.Peer) return joinMsg("No se cargó la librería de conexión. Recarga la página.");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      return joinMsg("Este navegador no deja usar el micrófono. Abre la app con https en Chrome.");

    const btn = $("#enter");
    btn.disabled = true;

    // El audio se crea aquí, mientras el toque del botón todavía cuenta
    try {
      if (state.audioCtx) state.audioCtx.close();
    } catch (e) {}
    state.audioCtx = null;
    state.silent = null;
    try {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {}

    let first;
    try {
      first = await navigator.mediaDevices.getUserMedia({ audio: MIC_OPTIONS });
    } catch (e) {
      btn.disabled = false;
      return joinMsg("Necesito permiso del micrófono para entrar.");
    }
    btn.disabled = false;

    state.releaseMode = $("#optRelease").checked;
    makeSilent();
    if (useRelease()) {
      // Solo se pedía el permiso: se suelta el micrófono para que otras apps lo puedan usar
      first.getTracks().forEach((t) => t.stop());
      state.stream = null;
      state.micTrack = null;
    } else {
      state.stream = first;
      state.micTrack = first.getAudioTracks()[0] || null;
      first.getAudioTracks().forEach((t) => (t.enabled = false)); // en silencio hasta presionar
    }

    state.name = name;
    state.room = room;
    state.role = $("#role").value;
    store.set("name", name);
    store.set("room", room);
    store.set("role", state.role);

    $("#join").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#roomName").textContent = "Sala " + room;
    setStatus("Conectando…", "");
    state.inRoom = true;
    keepAwake();
    renderPeers();
    renderFeedEmpty();
    startPeer(1);
    state.timers.push(setInterval(discover, 3000));
  }

  // ---------- Conexión ----------
  function startPeer(slot) {
    if (!state.inRoom) return;
    if (slot > MAX_SLOTS) {
      setStatus("Sala llena (máx. 8)", "bad");
      return;
    }
    const id = idFor(slot);
    const p = new window.Peer(id, { debug: 1 });
    let claimed = false;

    p.on("open", () => {
      if (!state.inRoom) return p.destroy();
      claimed = true;
      state.peer = p;
      state.myId = id;
      state.mySlot = slot;
      setStatus(`En línea · tú eres #${slot}`, "ok");
      renderPeers();
      discover();
    });

    p.on("connection", (conn) => wireData(conn, false));
    p.on("call", (call) => {
      wireCall(call); // primero escuchar eventos, luego contestar
      call.answer(outStream());
    });

    p.on("error", (err) => {
      if (err.type === "unavailable-id" && !claimed) {
        p.destroy();
        startPeer(slot + 1); // esa casilla ya está ocupada
        return;
      }
      if (err.type === "peer-unavailable") return; // casilla vacía, es normal
      if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) {
        setStatus("Sin conexión, reintentando…", "bad");
        return;
      }
      setStatus("Error: " + err.type, "bad");
    });

    p.on("disconnected", () => {
      if (!state.inRoom) return;
      setStatus("Sin conexión, reintentando…", "bad");
    });
  }

  // Cada 3 s: conecta con las casillas menores que aún no estén conectadas
  function discover() {
    const p = state.peer;
    if (!p || !state.inRoom) return;
    if (p.disconnected && !p.destroyed) {
      try {
        p.reconnect();
      } catch (e) {}
      return;
    }
    if (!p.open) return;
    if ($("#statusText").textContent.startsWith("Sin conexión")) {
      setStatus(`En línea · tú eres #${state.mySlot}`, "ok");
    }
    for (let s = 1; s < state.mySlot; s++) {
      const id = idFor(s);
      const e = peers.get(id);
      if (e && e.data && e.data.open) {
        if (!e.call) placeCall(id); // datos listos pero sin audio: reintenta
        continue;
      }
      if (pending.has(id)) continue;
      pending.add(id);
      setTimeout(() => pending.delete(id), 5000);
      wireData(p.connect(id, { reliable: true }), true);
    }
  }

  function ensureEntry(id) {
    let e = peers.get(id);
    if (!e) {
      e = { slot: slotOf(id), name: "…", role: "", data: null, call: null, audio: null, talking: false };
      peers.set(id, e);
    }
    return e;
  }

  function wireData(conn, outgoing) {
    conn.on("open", () => {
      const id = conn.peer;
      pending.delete(id);
      const e = ensureEntry(id);
      const old = e.data;
      e.data = conn;
      if (old && old !== conn) {
        try {
          old.close();
        } catch (_) {}
      }
      conn.send({ t: "hello", name: state.name, role: state.role });
      if (outgoing && !e.call) placeCall(id); // quien tiene la casilla mayor llama
      renderPeers();
    });
    conn.on("data", (d) => onData(conn.peer, d));
    conn.on("close", () => dropPeer(conn.peer, conn));
    conn.on("error", () => dropPeer(conn.peer, conn));
  }

  function placeCall(id) {
    const out = outStream();
    if (!state.peer || !out) return;
    const call = state.peer.call(id, out);
    if (call) wireCall(call);
  }

  function wireCall(call) {
    const id = call.peer;
    const e = ensureEntry(id);
    const old = e.call;
    e.call = call;
    if (old && old !== call) {
      try {
        old.close();
      } catch (_) {}
    }
    call.on("stream", (stream) => attachAudio(e, stream));
    call.on("close", () => {
      if (e.call === call) {
        detachAudio(e);
        e.call = null;
      }
    });
    call.on("error", () => {});
  }

  function attachAudio(e, stream) {
    if (!e.audio) {
      e.audio = document.createElement("audio");
      e.audio.autoplay = true;
      e.audio.setAttribute("playsinline", "");
      $("#audios").appendChild(e.audio);
    }
    e.audio.srcObject = stream;
    const play = e.audio.play();
    if (play && play.catch) play.catch(() => {});
  }
  function detachAudio(e) {
    if (e.audio) {
      e.audio.srcObject = null;
      e.audio.remove();
      e.audio = null;
    }
  }

  function dropPeer(id, conn) {
    const e = peers.get(id);
    if (!e || (conn && e.data !== conn)) return;
    if (e.call) {
      try {
        e.call.close();
      } catch (_) {}
    }
    detachAudio(e);
    peers.delete(id);
    renderPeers();
  }

  function broadcast(msg) {
    peers.forEach((e) => {
      if (e.data && e.data.open) {
        try {
          e.data.send(msg);
        } catch (_) {}
      }
    });
  }

  // ---------- Mensajes recibidos ----------
  function onData(id, d) {
    if (!d || typeof d !== "object") return;
    const e = peers.get(id);
    if (!e) return;
    if (d.t === "hello") {
      e.name = clip(d.name, 20) || "Anónimo";
      e.role = ROLE_CODES.includes(d.role) ? d.role : "";
      renderPeers();
    } else if (d.t === "ptt") {
      e.talking = !!d.on;
      renderPeers();
    } else if (d.t === "msg") {
      const text = clip(d.text, 300);
      if (!text) return;
      const claves = Array.isArray(d.claves) ? d.claves.filter((c) => CLAVES[c]).slice(0, 10) : [];
      e.talking = false;
      addMessage({ who: labelOf(e), text, claves, me: false });
      renderPeers();
    }
  }

  // ---------- Pantalla: compañeros y mensajes ----------
  function renderPeers() {
    const box = $("#peers");
    box.textContent = "";
    const mk = (text, cls) => {
      const s = document.createElement("span");
      s.className = "peer-chip " + cls;
      s.textContent = text;
      box.appendChild(s);
    };
    mk("Tú" + (state.role ? ` (${state.role})` : ""), "me" + (state.talking ? " talking" : ""));
    peers.forEach((e) => mk((e.talking ? "🎙 " : "") + labelOf(e), e.talking ? "talking" : ""));
  }

  function renderFeedEmpty() {
    const feed = $("#feed");
    if (feed.children.length) return;
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Aquí aparecerá lo que se diga. Mantén presionado el botón para hablar.";
    feed.appendChild(d);
  }

  function chipEl(code) {
    const c = document.createElement("span");
    c.className = "chip " + CLAVES[code][1];
    c.textContent = `${code} · ${CLAVES[code][0]}`;
    return c;
  }

  function addMessage({ who, text, claves, me }) {
    const feed = $("#feed");
    const empty = feed.querySelector(".empty");
    if (empty) empty.remove();

    const card = document.createElement("div");
    card.className = "msg-card" + (me ? " me" : "");
    const head = document.createElement("div");
    head.className = "msg-head";
    const b = document.createElement("b");
    b.textContent = who;
    const t = document.createElement("span");
    t.textContent = timeStr();
    head.append(b, t);
    const body = document.createElement("div");
    body.className = "msg-text";
    body.textContent = text;
    card.append(head, body);
    if (claves.length) {
      const chips = document.createElement("div");
      chips.className = "chips";
      claves.forEach((c) => chips.appendChild(chipEl(c)));
      card.appendChild(chips);
    }
    feed.appendChild(card);
    while (feed.children.length > 100) feed.firstChild.remove();
    feed.scrollTop = feed.scrollHeight;

    if (!me) {
      const urgent = claves.filter((c) => CLAVES[c][1] === "urgent");
      const warn = claves.filter((c) => CLAVES[c][1] === "warn");
      if (urgent.length) showAlert(who, urgent);
      else if (warn.length) beep(false);
    }
  }

  function showAlert(who, codes) {
    const a = $("#alert");
    a.textContent = "";
    const strong = document.createElement("div");
    strong.textContent = "⚠ " + codes.map((c) => CLAVES[c][0]).join(" · ").toUpperCase();
    const small = document.createElement("small");
    small.textContent = who + " · toca para cerrar";
    a.append(strong, small);
    a.classList.remove("hidden");
    // reinicia la animación
    a.style.animation = "none";
    void a.offsetWidth;
    a.style.animation = "";
    clearTimeout(state.alertTimer);
    state.alertTimer = setTimeout(() => a.classList.add("hidden"), 12000);
    beep(true);
    if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 400]);
  }

  function beep(urgent) {
    const ctx = state.audioCtx;
    if (!ctx) return;
    try {
      if (ctx.state === "suspended") ctx.resume();
      const t0 = ctx.currentTime;
      const tones = urgent ? [880, 660, 880] : [660];
      tones.forEach((f, i) => {
        const at = t0 + i * 0.2;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "square";
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(at);
        o.stop(at + 0.18);
      });
    } catch (_) {}
  }

  // ---------- Hablar (push-to-talk) ----------
  function setTalking(on) {
    if (on === state.talking || !state.inRoom) return;
    state.talking = on;
    if (useRelease()) {
      if (on) acquireMic();
      else releaseMic();
    } else if (state.stream) {
      state.stream.getAudioTracks().forEach((t) => (t.enabled = on));
    }
    broadcast({ t: "ptt", on });
    const btn = $("#ptt");
    btn.classList.toggle("on", on);
    updatePttText();
    renderPeers();
    if (on) startRec();
    else stopRec();
  }

  function updatePttText() {
    const toggle = $("#optToggle").checked;
    $("#pttText").textContent = state.talking
      ? toggle
        ? "Hablando…\ntoca para terminar"
        : "Hablando…"
      : toggle
      ? "Toca para hablar"
      : "Mantén para hablar";
  }

  function onPress() {
    if ($("#optToggle").checked) setTalking(!state.talking);
    else setTalking(true);
  }
  function onRelease() {
    if (!$("#optToggle").checked) setTalking(false);
  }

  // ---------- Transcripción ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = { r: null, finalText: "", interim: "", active: false, finishing: false, timer: null };

  function startRec() {
    note("");
    if (!$("#optTranscribe").checked) return;
    if (!SR) {
      note("Este navegador no transcribe: solo se envía la voz.");
      return;
    }
    clearTimeout(rec.timer);
    rec.finalText = "";
    rec.interim = "";
    rec.active = true;
    rec.finishing = false;
    $("#live").textContent = "";
    openRec();
  }

  function openRec() {
    const r = new SR();
    r.lang = "es-MX";
    r.continuous = false; // más estable en Android; se reinicia solo mientras hablas
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) rec.finalText += res[0].transcript + " ";
        else interim += res[0].transcript;
      }
      rec.interim = interim;
      $("#live").textContent = (rec.finalText + rec.interim).trim();
    };
    r.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        rec.active = false;
        note("La transcripción no tiene permiso. Revisa los permisos del navegador.");
      } else if (ev.error === "audio-capture") {
        rec.active = false;
        note("El micrófono está ocupado para transcribir. Prueba quitar «Transcribir».");
      }
    };
    r.onend = () => {
      if (r !== rec.r) return; // sesión vieja
      if (rec.active && state.talking) {
        try {
          openRec();
        } catch (_) {}
      } else finishRec();
    };
    rec.r = r;
    try {
      r.start();
    } catch (_) {}
  }

  function stopRec() {
    if (!rec.active) return;
    rec.active = false;
    try {
      rec.r && rec.r.stop();
    } catch (_) {}
    clearTimeout(rec.timer);
    rec.timer = setTimeout(finishRec, 1500); // por si el navegador no avisa que terminó
  }

  function finishRec() {
    if (rec.finishing) return;
    rec.finishing = true;
    clearTimeout(rec.timer);
    const text = (rec.finalText + " " + rec.interim).replace(/\s+/g, " ").trim();
    rec.finalText = "";
    rec.interim = "";
    $("#live").textContent = "";
    if (text) sendText(text, null);
  }

  // Envía un mensaje (voz transcrita o clave tocada)
  function sendText(text, forcedClaves) {
    const clean = clip(text, 300);
    const claves = forcedClaves || detectClaves(clean).map((c) => c.code);
    broadcast({ t: "msg", text: clean, claves });
    addMessage({ who: "Tú", text: clean, claves, me: true });
  }

  // ---------- Lista de claves ----------
  function renderClaves(filter) {
    const list = $("#clavesList");
    list.textContent = "";
    const f = normalize(filter || "");
    const groups = [
      ["Claves", (k) => /^\d+$/.test(k)],
      ["Roles", (k) => CLAVES[k][1] === "role"],
      ["Ubicaciones", (k) => CLAVES[k][1] === "place"],
    ];
    groups.forEach(([title, test]) => {
      const codes = Object.keys(CLAVES)
        .filter(test)
        .filter((k) => !f || normalize(k + " " + CLAVES[k][0]).includes(f));
      if (!codes.length) return;
      const h = document.createElement("div");
      h.className = "group-title";
      h.textContent = title;
      list.appendChild(h);
      codes.forEach((code) => {
        const row = document.createElement("div");
        row.className = "clave-row";
        const chip = document.createElement("span");
        chip.className = "chip " + CLAVES[code][1];
        chip.textContent = code;
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = CLAVES[code][0];
        const send = document.createElement("button");
        send.textContent = "Enviar";
        send.addEventListener("click", () => {
          sendText(`${code} · ${CLAVES[code][0]}`, [code]);
          switchTab("radio");
        });
        row.append(chip, label, send);
        list.appendChild(row);
      });
    });
  }

  function switchTab(tab) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $("#viewRadio").classList.toggle("hidden", tab !== "radio");
    $("#viewClaves").classList.toggle("hidden", tab !== "claves");
  }

  // ---------- Pantalla encendida ----------
  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && state.inRoom) {
        state.wake = await navigator.wakeLock.request("screen");
      }
    } catch (_) {}
  }

  // ---------- Salir ----------
  function leave() {
    state.inRoom = false;
    if (state.talking) setTalking(false);
    state.timers.forEach(clearInterval);
    state.timers = [];
    clearTimeout(state.alertTimer);
    peers.forEach((e) => {
      try {
        e.call && e.call.close();
      } catch (_) {}
      try {
        e.data && e.data.close();
      } catch (_) {}
      detachAudio(e);
    });
    peers.clear();
    pending.clear();
    try {
      state.peer && state.peer.destroy();
    } catch (_) {}
    state.peer = null;
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    state.micTrack = null;
    if (state.silent) state.silent.getTracks().forEach((t) => t.stop());
    state.silent = null;
    try {
      state.wake && state.wake.release();
    } catch (_) {}
    state.wake = null;
    $("#feed").textContent = "";
    $("#alert").classList.add("hidden");
    $("#app").classList.add("hidden");
    $("#join").classList.remove("hidden");
  }

  // ---------- Arranque ----------
  function init() {
    buildRoleSelect();
    $("#name").value = store.get("name", "");
    $("#room").value = store.get("room", "");
    $("#role").value = store.get("role", "");
    $("#optToggle").checked = store.get("toggle", "0") === "1";
    $("#optTranscribe").checked = store.get("transcribe", "1") === "1";
    updatePttText();
    renderClaves("");

    $("#enter").addEventListener("click", enter);
    $("#room").addEventListener("keydown", (e) => e.key === "Enter" && enter());
    $("#leave").addEventListener("click", leave);
    $("#alert").addEventListener("click", () => $("#alert").classList.add("hidden"));
    $("#search").addEventListener("input", (e) => renderClaves(e.target.value));
    document.querySelectorAll(".tabs button").forEach((b) =>
      b.addEventListener("click", () => switchTab(b.dataset.tab))
    );
    $("#optToggle").addEventListener("change", (e) => {
      store.set("toggle", e.target.checked ? "1" : "0");
      if (state.talking) setTalking(false);
      updatePttText();
    });
    $("#optTranscribe").addEventListener("change", (e) =>
      store.set("transcribe", e.target.checked ? "1" : "0")
    );
    $("#optRelease").checked = store.get("release", "1") === "1";
    $("#optRelease").addEventListener("change", (e) => {
      store.set("release", e.target.checked ? "1" : "0");
      applyMicMode();
    });

    const ptt = $("#ptt");
    ptt.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try {
        ptt.setPointerCapture(e.pointerId);
      } catch (_) {}
      if (state.audioCtx && state.audioCtx.state === "suspended") state.audioCtx.resume();
      onPress();
    });
    ["pointerup", "pointercancel"].forEach((ev) => ptt.addEventListener(ev, onRelease));
    ptt.addEventListener("contextmenu", (e) => e.preventDefault());

    // Barra espaciadora para hablar en computadora
    document.addEventListener("keydown", (e) => {
      if (e.code !== "Space" || e.repeat || !state.inRoom) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      e.preventDefault();
      onPress();
    });
    document.addEventListener("keyup", (e) => {
      if (e.code === "Space" && state.inRoom) onRelease();
    });

    document.addEventListener("visibilitychange", () => {
      if (!state.inRoom) return;
      if (document.visibilityState === "visible") keepAwake();
      else if (state.talking) setTalking(false); // al salir de la app se suelta el micrófono
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  init();
})();
