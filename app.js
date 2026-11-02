// Walkie Claves — lógica principal.
// Voz: WebRTC (PeerJS), sin servidor propio.
//  - Canales: cada canal tiene "casillas" 1..8. Quien entra toma la primera libre y se conecta
//    a las casillas con número menor. Puedes tener varios canales conectados a la vez y
//    escucharlos todos; el botón de hablar manda tu voz al destino que elijas.
//  - Contactos: cada teléfono tiene un código personal. Los contactos se conectan directo,
//    estén en el canal que estén. Hay que aceptar la solicitud antes de poder oírse.
(function () {
  "use strict";

  const { CLAVES, detectClaves, normalize } = window.Claves;
  const MAX_SLOTS = 8;
  const MAX_CHANNELS = 5;
  const MAX_REQUESTS = 5;
  const CALL_TIMEOUT = 8000;
  const MIC_OPTIONS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const $ = (s) => document.querySelector(s);
  const ROLE_CODES = Object.keys(CLAVES).filter((k) => CLAVES[k][1] === "role");

  // ---------- Modo nativo (app de Android hecha con Capacitor) ----------
  // En el navegador (PWA) todo esto se ignora.
  const NATIVE = !!(
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === "function" &&
    window.Capacitor.isNativePlatform()
  );
  function nativePlugin(name) {
    try {
      const C = window.Capacitor;
      return (C.Plugins && C.Plugins[name]) || C.registerPlugin(name);
    } catch (e) {
      return null;
    }
  }
  const Radio = NATIVE ? nativePlugin("Radio") : null;
  if (NATIVE) document.documentElement.classList.add("native");

  // ---------- Datos guardados en el teléfono ----------
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
    getJSON(k, d) {
      try {
        const v = localStorage.getItem("wk_" + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    setJSON(k, v) {
      this.set(k, JSON.stringify(v));
    },
  };

  const S = {
    name: "",
    role: "",
    code: "", // código personal
    channels: [], // [{ room, label, on }]
    contacts: [], // [{ code, name, state: "ok" | "pending" | "denied" }]
    target: null, // { type: "channel", room } | { type: "contact", code }
    radioOn: false,
    started: false,
    audioCtx: null,
    silent: null, // flujo mudo: va en las llamadas mientras el micrófono está libre
    stream: null,
    micTrack: null,
    micBusy: false,
    talking: false,
    talkTarget: null,
    wake: null,
    timers: [],
    alertTimer: null,
  };
  const groups = new Map(); // "c:<sala>" o "hub" -> grupo de conexión
  const requests = new Map(); // código -> { name, role } (solicitudes recibidas)
  const refused = new Set(); // códigos rechazados en esta sesión

  // ---------- Utilidades ----------
  const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  const cleanRoom = (s) => normalize(s).replace(/ /g, "").slice(0, 24);
  const cleanCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const chanId = (room, slot) => `wktalkie-${room}-${slot}`;
  const hubId = (code) => `wkuser-${code}`;
  const timeStr = () =>
    new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  const isOpen = (l) => !!(l && l.data && l.data.open);

  function newCode() {
    const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const a = new Uint32Array(6);
    try {
      window.crypto.getRandomValues(a);
    } catch (e) {
      for (let i = 0; i < 6; i++) a[i] = Math.floor(Math.random() * 4294967296);
    }
    let s = "";
    for (let i = 0; i < 6; i++) s += A[a[i] % A.length];
    return s;
  }

  const chanByRoom = (room) => S.channels.find((c) => c.room === room);
  const contactByCode = (code) => S.contacts.find((c) => c.code === code);
  const saveChannels = () => store.setJSON("channels", S.channels);
  const saveContacts = () => store.setJSON("contacts", S.contacts);
  const saveTarget = () => store.setJSON("target", S.target);

  function note(text) {
    $("#note").textContent = text || "";
  }
  function joinMsg(text) {
    $("#joinMsg").textContent = text || "";
  }

  function loadState() {
    S.name = clip(store.get("name", ""), 20);
    const role = store.get("role", "");
    S.role = ROLE_CODES.includes(role) ? role : "";
    S.code = cleanCode(store.get("code", ""));
    if (S.code.length < 6) {
      S.code = newCode();
      store.set("code", S.code);
    }

    let chans = store.getJSON("channels", null);
    if (!Array.isArray(chans)) {
      // Versión anterior: solo guardaba la última sala
      const old = cleanRoom(store.get("room", ""));
      chans = old ? [{ room: old, label: old, on: true }] : [];
    }
    S.channels = chans
      .filter((c) => c && typeof c.room === "string" && cleanRoom(c.room))
      .map((c) => ({ room: cleanRoom(c.room), label: clip(c.label, 24) || c.room, on: c.on !== false }));
    saveChannels();

    const cons = store.getJSON("contacts", []);
    S.contacts = (Array.isArray(cons) ? cons : [])
      .filter((c) => c && cleanCode(c.code).length >= 6)
      .map((c) => ({
        code: cleanCode(c.code),
        name: clip(c.name, 20) || cleanCode(c.code),
        state: ["ok", "pending", "denied"].includes(c.state) ? c.state : "pending",
      }));

    const t = store.getJSON("target", null);
    S.target = t && (t.type === "channel" || t.type === "contact") ? t : null;
    S.radioOn = store.get("radio", "0") === "1";
  }

  // ---------- Micrófono: se usa solo mientras hablas ----------
  // En las llamadas va un audio mudo. Al presionar el botón se abre el micrófono real y se
  // cambia esa pista solo en las llamadas del destino elegido; al soltar se vuelve a la muda y
  // se libera el micrófono, así otras apps (llamadas, notas de voz) pueden usarlo.
  function ensureAudio() {
    if (!S.audioCtx) {
      try {
        S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        S.audioCtx = null;
      }
    }
    if (S.audioCtx && !S.silent) {
      try {
        S.silent = S.audioCtx.createMediaStreamDestination().stream;
      } catch (e) {
        S.silent = null;
      }
    }
  }
  const outStream = () => S.silent;
  const silentTrack = () => (S.silent && S.silent.getAudioTracks()[0]) || null;

  function inTarget(l) {
    const t = S.talkTarget;
    if (!t) return false;
    if (t.type === "channel") return l.group.kind === "channel" && l.group.room === t.room;
    return l.group.kind === "hub" && l.code === t.code;
  }

  // Pone en la llamada de `l` la pista que le toca: el micrófono si es el destino y estás
  // hablando; si no, la muda.
  function applyTrack(l) {
    const pc = l.call && l.call.peerConnection;
    if (!pc || !pc.getSenders) return;
    const want = S.talking && S.micTrack && inTarget(l) ? S.micTrack : silentTrack();
    if (!want) return;
    pc.getSenders().forEach((s) => {
      if (s.track && s.track.kind === "audio" && s.track !== want) {
        try {
          s.replaceTrack(want);
        } catch (_) {}
      }
    });
  }
  function applyAllTracks() {
    groups.forEach((g) => g.links.forEach(applyTrack));
  }

  async function acquireMic() {
    if (S.micBusy) return;
    if (S.micTrack && S.micTrack.readyState === "live") {
      applyAllTracks();
      return;
    }
    S.micBusy = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: MIC_OPTIONS });
      if (!S.talking || !S.radioOn) {
        s.getTracks().forEach((t) => t.stop()); // ya soltaste el botón antes de que abriera
        return;
      }
      S.stream = s;
      S.micTrack = s.getAudioTracks()[0] || null;
      applyAllTracks();
    } catch (e) {
      note("No pude abrir el micrófono. ¿Otra app lo está usando?");
    } finally {
      S.micBusy = false;
    }
  }

  function releaseMic() {
    applyAllTracks(); // vuelve a la pista muda (S.talking ya es false)
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null;
    S.micTrack = null;
  }

  // ---------- Conexiones ----------
  // Un "grupo" es una conexión a PeerJS: un canal, o el buzón personal ("hub").
  // Un "enlace" es la conexión con una persona dentro de un grupo.
  function newGroup(kind, key, extra) {
    return Object.assign(
      { kind, key, peer: null, myId: "", slot: 0, links: new Map(), pending: new Set(), status: "connecting", closed: false, retry: null },
      extra || {}
    );
  }

  function ensureLink(g, id) {
    let l = g.links.get(id);
    if (!l) {
      l = {
        group: g,
        id,
        name: "…",
        role: "",
        code: g.kind === "hub" ? id.slice(7) : "",
        data: null,
        call: null,
        audio: null,
        talking: false,
        callAt: 0,
        hasStream: false,
        guest: null,
      };
      g.links.set(id, l);
    }
    return l;
  }

  function sendLink(l, msg) {
    if (isOpen(l)) {
      try {
        l.data.send(msg);
      } catch (_) {}
    }
  }

  function linkName(l) {
    if (l.group.kind === "hub") {
      const c = contactByCode(l.code);
      return (c && c.name) || (l.name !== "…" ? l.name : "") || l.code;
    }
    return l.name;
  }
  const labelOf = (l) => linkName(l) + (l.role ? ` (${l.role})` : "");
  const groupLabel = (g) => (g.kind === "hub" ? "Directo" : g.label);

  function closeLink(l) {
    clearTimeout(l.guest);
    try {
      l.call && l.call.close();
    } catch (_) {}
    try {
      l.data && l.data.close();
    } catch (_) {}
    detachAudio(l);
  }

  function dropLink(g, id, conn) {
    const l = g.links.get(id);
    if (!l || (conn && l.data !== conn)) return;
    g.links.delete(id);
    closeLink(l);
    scheduleRender();
  }

  function startGroup(g, slot) {
    if (g.closed) return;
    let id;
    if (g.kind === "hub") {
      id = hubId(S.code);
    } else {
      if (slot > MAX_SLOTS) {
        g.status = "full";
        scheduleRender();
        return;
      }
      id = chanId(g.room, slot);
    }
    const p = new window.Peer(id, { debug: 1 });
    let claimed = false;

    p.on("open", () => {
      if (g.closed) {
        try {
          p.destroy();
        } catch (_) {}
        return;
      }
      claimed = true;
      g.peer = p;
      g.myId = id;
      g.slot = slot;
      g.status = "ok";
      scheduleRender();
      discoverGroup(g);
    });

    p.on("connection", (conn) => wireData(g, conn, false));
    p.on("call", (call) => onCall(g, call));

    p.on("error", (err) => {
      if (err.type === "unavailable-id" && !claimed) {
        try {
          p.destroy();
        } catch (_) {}
        if (g.kind === "hub") {
          // Tu código lo está usando otro teléfono: reintenta en un rato
          g.status = "inuse";
          scheduleRender();
          g.retry = setTimeout(() => startGroup(g, 0), 10000);
        } else {
          startGroup(g, slot + 1); // esa casilla ya está ocupada
        }
        return;
      }
      if (err.type === "peer-unavailable") return; // casilla o contacto sin conectar: es normal
      if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) {
        g.status = "offline";
        scheduleRender();
        return;
      }
      g.status = "error";
      scheduleRender();
    });

    p.on("disconnected", () => {
      if (g.closed) return;
      g.status = "offline";
      scheduleRender();
    });
  }

  function onCall(g, call) {
    if (g.kind === "hub") {
      // Solo se contesta a contactos ya aceptados
      const c = contactByCode(String(call.peer).slice(7));
      if (!c || c.state !== "ok") {
        try {
          call.close();
        } catch (_) {}
        return;
      }
    }
    wireCall(g, call); // primero escuchar eventos, luego contestar
    call.answer(outStream());
  }

  function wireData(g, conn, outgoing) {
    conn.on("open", () => {
      const id = conn.peer;
      g.pending.delete(id);
      const l = ensureLink(g, id);
      const old = l.data;
      l.data = conn;
      if (old && old !== conn) {
        try {
          old.close();
        } catch (_) {}
      }
      conn.send({ t: "hello", name: S.name, role: S.role, code: S.code });
      if (g.kind === "hub") hubOpened(g, l, outgoing);
      else if (outgoing && !l.call) placeCall(g, id); // quien tiene la casilla mayor llama
      scheduleRender();
    });
    conn.on("data", (d) => onData(g, conn.peer, d));
    conn.on("close", () => dropLink(g, conn.peer, conn));
    conn.on("error", () => dropLink(g, conn.peer, conn));
  }

  function placeCall(g, id) {
    const out = outStream();
    if (!g.peer || !out) return;
    const call = g.peer.call(id, out);
    if (call) wireCall(g, call);
  }

  function wireCall(g, call) {
    const l = ensureLink(g, call.peer);
    const old = l.call;
    l.call = call;
    l.callAt = Date.now();
    l.hasStream = false;
    if (old && old !== call) {
      try {
        old.close();
      } catch (_) {}
    }
    call.on("stream", (stream) => {
      l.hasStream = true;
      attachAudio(l, stream);
      applyTrack(l);
    });
    call.on("close", () => {
      if (l.call === call) {
        detachAudio(l);
        l.call = null;
      }
    });
    call.on("error", () => {});
  }

  // Si una llamada que yo inicié no logra conectar en 8 s, se cancela y se reintenta
  function ensureCall(g, l) {
    if (!l.call) {
      placeCall(g, l.id);
    } else if (!l.hasStream && Date.now() - l.callAt > CALL_TIMEOUT) {
      try {
        l.call.close();
      } catch (_) {}
      l.call = null;
    }
  }

  function attachAudio(l, stream) {
    if (!l.audio) {
      l.audio = document.createElement("audio");
      l.audio.autoplay = true;
      l.audio.setAttribute("playsinline", "");
      $("#audios").appendChild(l.audio);
    }
    l.audio.srcObject = stream;
    const play = l.audio.play();
    if (play && play.catch) play.catch(() => {});
  }
  function detachAudio(l) {
    if (l.audio) {
      l.audio.srcObject = null;
      l.audio.remove();
      l.audio = null;
    }
  }

  // ---------- Buscar y conectar con los demás (cada 3 s) ----------
  function groupReady(g) {
    const p = g.peer;
    if (!p || g.closed) return false;
    if (p.disconnected && !p.destroyed) {
      try {
        p.reconnect();
      } catch (e) {}
      return false;
    }
    if (!p.open) return false;
    if (g.status === "offline") {
      g.status = "ok";
      scheduleRender();
    }
    return true;
  }

  function connectTo(g, id) {
    if (g.pending.has(id)) return;
    g.pending.add(id);
    setTimeout(() => g.pending.delete(id), 5000);
    wireData(g, g.peer.connect(id, { reliable: true }), true);
  }

  function discoverChannel(g) {
    if (!groupReady(g)) return;
    for (let s = 1; s < g.slot; s++) {
      const id = chanId(g.room, s);
      const l = g.links.get(id);
      if (isOpen(l)) ensureCall(g, l);
      else connectTo(g, id);
    }
  }

  function discoverHub(g) {
    if (!groupReady(g)) return;
    S.contacts.forEach((c) => {
      if (c.state === "denied") return;
      const id = hubId(c.code);
      const l = g.links.get(id);
      // Quien tiene el código "mayor" inicia la conexión; las solicitudes siempre las inicia quien las manda
      const iInitiate = c.state === "pending" || S.code > c.code;
      if (isOpen(l)) {
        if (c.state === "ok" && iInitiate) ensureCall(g, l);
        return;
      }
      if (iInitiate) connectTo(g, id);
    });
  }

  function discoverGroup(g) {
    if (g.kind === "hub") discoverHub(g);
    else discoverChannel(g);
  }

  function discoverAll() {
    groups.forEach(discoverGroup);
    // Audio que el sistema dejó en pausa
    groups.forEach((g) =>
      g.links.forEach((l) => {
        if (l.audio && l.audio.paused && l.audio.srcObject) {
          const p = l.audio.play();
          if (p && p.catch) p.catch(() => {});
        }
      })
    );
  }

  // ---------- Mensajes recibidos ----------
  function validClaves(arr) {
    return Array.isArray(arr) ? arr.filter((c) => CLAVES[c]).slice(0, 10) : [];
  }

  function onData(g, id, d) {
    if (!d || typeof d !== "object") return;
    const l = g.links.get(id);
    if (!l) return;
    if (g.kind === "hub") return onHubData(g, l, d);

    if (d.t === "hello") {
      l.name = clip(d.name, 20) || "Anónimo";
      l.role = ROLE_CODES.includes(d.role) ? d.role : "";
      l.code = cleanCode(d.code);
      scheduleRender();
    } else if (d.t === "ptt") {
      l.talking = !!d.on;
      scheduleRender();
    } else if (d.t === "msg") {
      const text = clip(d.text, 300);
      if (!text) return;
      l.talking = false;
      addMessage({ who: labelOf(l), where: g.label, text, claves: validClaves(d.claves), me: false });
      scheduleRender();
    }
  }

  function onHubData(g, l, d) {
    const code = l.code;
    const c = contactByCode(code);

    if (d.t === "req") {
      if (c && c.state === "ok") {
        sendLink(l, { t: "ok", name: S.name, role: S.role }); // ya somos contactos: confirmar
        return;
      }
      if (c) {
        acceptContact(code); // los dos nos agregamos: quedamos como contactos sin preguntar
        return;
      }
      if (refused.has(code)) {
        sendLink(l, { t: "no" });
        return;
      }
      if (!requests.has(code) && requests.size >= MAX_REQUESTS) return;
      const isNew = !requests.has(code);
      requests.set(code, {
        name: clip(d.name, 20) || "Sin nombre",
        role: ROLE_CODES.includes(d.role) ? d.role : "",
      });
      clearTimeout(l.guest);
      if (isNew) beep(false);
      scheduleRender();
      return;
    }

    if (!c) return; // desconocidos: no se les hace caso
    if (c.state === "pending" || c.state === "denied") {
      if (d.t === "ok") {
        c.state = "ok";
        saveContacts();
        if (S.code > c.code && isOpen(l) && !l.call) placeCall(g, l.id);
        scheduleRender();
      } else if (d.t === "no") {
        c.state = "denied";
        saveContacts();
        scheduleRender();
      }
      return;
    }

    // Contacto aceptado
    if (d.t === "hello") {
      l.name = clip(d.name, 20) || "Anónimo";
      l.role = ROLE_CODES.includes(d.role) ? d.role : "";
      scheduleRender();
    } else if (d.t === "ptt") {
      l.talking = !!d.on;
      scheduleRender();
    } else if (d.t === "msg") {
      const text = clip(d.text, 300);
      if (!text) return;
      l.talking = false;
      addMessage({ who: labelOf(l), where: "Directo", text, claves: validClaves(d.claves), me: false });
      scheduleRender();
    }
  }

  // Se abrió la conexión de datos con alguien en el buzón personal
  function hubOpened(g, l, outgoing) {
    const c = contactByCode(l.code);
    if (c && c.state === "pending" && outgoing) {
      sendLink(l, { t: "req", name: S.name, role: S.role });
    } else if (c && c.state === "ok" && outgoing && !l.call && S.code > c.code) {
      placeCall(g, l.id);
    } else if (!c && !outgoing) {
      // Un desconocido: si no manda una solicitud pronto, se le cierra
      l.guest = setTimeout(() => {
        if (!contactByCode(l.code) && !requests.has(l.code)) dropLink(g, l.id, l.data);
      }, 8000);
    }
  }

  // ---------- Contactos ----------
  function addContact(codeRaw, nick) {
    const code = cleanCode(codeRaw);
    if (code.length < 6) return "Ese código no es válido (son 6 letras o números).";
    if (code === S.code) return "Ese es tu propio código.";
    let c = contactByCode(code);
    if (c) {
      if (c.state !== "denied") return "Ya está en tu lista.";
      c.state = "pending";
    } else {
      c = { code, name: clip(nick, 20) || code, state: "pending" };
      S.contacts.push(c);
    }
    if (requests.has(code)) {
      acceptContact(code); // esa persona ya me había mandado solicitud
      return "";
    }
    saveContacts();
    scheduleRender();
    discoverAll();
    return "";
  }

  function acceptContact(code) {
    const req = requests.get(code);
    let c = contactByCode(code);
    if (!c) {
      c = { code, name: (req && req.name) || code, state: "ok" };
      S.contacts.push(c);
    } else {
      c.state = "ok";
    }
    requests.delete(code);
    refused.delete(code);
    saveContacts();
    const g = groups.get("hub");
    const l = g && g.links.get(hubId(code));
    if (l) {
      clearTimeout(l.guest);
      sendLink(l, { t: "ok", name: S.name, role: S.role });
      if (isOpen(l) && S.code > code) {
        // Un momento para que llegue el "ok" antes que la llamada
        setTimeout(() => {
          if (g.links.get(l.id) === l && !l.call) placeCall(g, l.id);
        }, 600);
      }
    }
    scheduleRender();
  }

  function refuseRequest(code) {
    requests.delete(code);
    refused.add(code);
    const g = groups.get("hub");
    const l = g && g.links.get(hubId(code));
    if (l) sendLink(l, { t: "no" });
    scheduleRender();
  }

  function removeContact(code) {
    S.contacts = S.contacts.filter((c) => c.code !== code);
    saveContacts();
    const g = groups.get("hub");
    const l = g && g.links.get(hubId(code));
    if (l) {
      g.links.delete(l.id);
      closeLink(l);
    }
    ensureTarget();
    scheduleRender();
  }

  function offerContact(l) {
    if (!l.code || l.code === S.code || contactByCode(l.code)) return;
    if (!window.confirm(`¿Agregar a ${linkName(l)} a tus contactos?`)) return;
    addContact(l.code, linkName(l));
  }

  // ---------- Canales guardados ----------
  function startChannel(ch) {
    const key = "c:" + ch.room;
    if (groups.has(key) || !S.radioOn) return;
    const g = newGroup("channel", key, { room: ch.room, label: ch.label });
    groups.set(key, g);
    startGroup(g, 1);
  }

  function closeGroup(g) {
    g.closed = true;
    clearTimeout(g.retry);
    Array.from(g.links.values()).forEach(closeLink);
    g.links.clear();
    g.pending.clear();
    try {
      g.peer && g.peer.destroy();
    } catch (_) {}
    groups.delete(g.key);
  }

  function connectedChannels() {
    let n = 0;
    groups.forEach((g) => {
      if (g.kind === "channel") n++;
    });
    return n;
  }

  // Devuelve un texto si hay algo que avisar
  function addChannel(raw) {
    const room = cleanRoom(raw);
    if (!room) return "Escribe el código del canal.";
    let ch = chanByRoom(room);
    if (!ch) {
      ch = { room, label: clip(raw, 24) || room, on: false };
      S.channels.push(ch);
    }
    return setChannelOn(room, true);
  }

  function setChannelOn(room, on) {
    const ch = chanByRoom(room);
    if (!ch) return "";
    if (on && !ch.on && S.radioOn && connectedChannels() >= MAX_CHANNELS) {
      return `Máximo ${MAX_CHANNELS} canales conectados a la vez.`;
    }
    ch.on = on;
    saveChannels();
    if (on) {
      if (!S.radioOn) startRadio();
      else startChannel(ch);
      if (!S.target) {
        S.target = { type: "channel", room };
        saveTarget();
      }
    } else {
      const g = groups.get("c:" + room);
      if (g) {
        if (S.talking && S.talkTarget && S.talkTarget.type === "channel" && S.talkTarget.room === room) setTalking(false);
        closeGroup(g);
      }
      ensureTarget();
    }
    scheduleRender();
    return "";
  }

  function deleteChannel(room) {
    setChannelOn(room, false);
    S.channels = S.channels.filter((c) => c.room !== room);
    saveChannels();
    ensureTarget();
    scheduleRender();
  }

  // ---------- Radio: encender y apagar todo ----------
  async function startRadio() {
    if (S.started) return;
    S.started = true;
    S.radioOn = true;
    store.set("radio", "1");
    ensureAudio();
    if (!S.silent) note("Este navegador no permite el audio necesario. Prueba con Chrome.");
    renderAll();

    // Permiso de micrófono (solo la primera vez; se libera enseguida)
    if (store.get("mic_ok", "0") !== "1" && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: MIC_OPTIONS });
        s.getTracks().forEach((t) => t.stop());
        store.set("mic_ok", "1");
      } catch (e) {
        note("Sin permiso de micrófono: solo podrás escuchar.");
      }
    }
    if (!S.started) return; // la apagaron mientras se pedía el permiso

    if (!groups.has("hub")) {
      const hub = newGroup("hub", "hub");
      groups.set("hub", hub);
      startGroup(hub, 0);
    }
    S.channels.filter((c) => c.on).slice(0, MAX_CHANNELS).forEach(startChannel);
    S.timers.push(setInterval(discoverAll, 3000));
    ensureTarget();
    if (NATIVE) startNative();
    else keepAwake();
    renderAll();
  }

  function stopRadio() {
    S.started = false;
    S.radioOn = false;
    store.set("radio", "0");
    if (S.talking) setTalking(false);
    S.timers.forEach(clearInterval);
    S.timers = [];
    Array.from(groups.values()).forEach(closeGroup);
    requests.clear();
    if (NATIVE && Radio) {
      try {
        Radio.stop();
        Radio.keepScreenOn({ on: false });
      } catch (_) {}
    }
    try {
      S.wake && S.wake.release();
    } catch (_) {}
    S.wake = null;
    $("#alert").classList.add("hidden");
    renderAll();
  }

  // Servicio en segundo plano (solo app de Android)
  async function startNative() {
    if (!Radio) return;
    try {
      await Radio.start({ title: "Radio activa", text: "Escuchando tus canales y contactos" });
    } catch (e) {}
    try {
      Radio.keepScreenOn({ on: $("#optScreen").checked });
    } catch (e) {}
    // Una sola vez: pedir que el ahorro de batería no apague la radio
    if (store.get("battery_asked", "0") !== "1") {
      store.set("battery_asked", "1");
      try {
        await Radio.requestBatteryExemption();
      } catch (e) {}
    }
  }

  async function keepAwake() {
    if (NATIVE) return; // en la app de Android la pantalla se controla con la casilla de abajo
    try {
      if ("wakeLock" in navigator && S.radioOn) {
        S.wake = await navigator.wakeLock.request("screen");
      }
    } catch (_) {}
  }

  // ---------- Destino de la voz ----------
  const targetKey = (t) => (t ? (t.type === "channel" ? "c:" + t.room : "u:" + t.code) : "");

  function linksOf(t) {
    if (!t) return [];
    if (t.type === "channel") {
      const g = groups.get("c:" + t.room);
      return g ? Array.from(g.links.values()).filter(isOpen) : [];
    }
    const g = groups.get("hub");
    const c = contactByCode(t.code);
    const l = g && g.links.get(hubId(t.code));
    return l && isOpen(l) && c && c.state === "ok" ? [l] : [];
  }

  function whereLabel(t) {
    if (!t) return "";
    if (t.type === "channel") {
      const ch = chanByRoom(t.room);
      return ch ? ch.label : t.room;
    }
    const c = contactByCode(t.code);
    return "Directo · " + (c ? c.name : t.code);
  }

  function targetKnown(t) {
    if (!t) return false;
    if (t.type === "channel") {
      const ch = chanByRoom(t.room);
      return !!(ch && ch.on);
    }
    const c = contactByCode(t.code);
    return !!(c && c.state === "ok");
  }

  function ensureTarget() {
    if (targetKnown(S.target)) return;
    const first = S.channels.find((c) => c.on);
    S.target = first ? { type: "channel", room: first.room } : null;
    saveTarget();
  }

  function selectTarget(t) {
    S.target = t;
    saveTarget();
    note("");
    renderAll();
  }

  // ---------- Hablar (push-to-talk) ----------
  function setTalking(on) {
    if (on === S.talking) return;
    if (on) {
      if (!S.radioOn || !S.started) {
        note("Enciende la radio para hablar.");
        return;
      }
      if (!targetKnown(S.target)) {
        note("Elige a quién hablar: un canal o un contacto.");
        return;
      }
      S.talkTarget = S.target;
      S.talking = true;
      note(linksOf(S.talkTarget).length ? "" : "Nadie más está conectado ahí ahora.");
      acquireMic();
      linksOf(S.talkTarget).forEach((l) => sendLink(l, { t: "ptt", on: true }));
    } else {
      const t = S.talkTarget;
      S.talking = false;
      releaseMic();
      linksOf(t).forEach((l) => sendLink(l, { t: "ptt", on: false }));
      S.talkTarget = null;
    }
    $("#ptt").classList.toggle("on", S.talking);
    updatePttText();
    renderPeers();
    if (on) startRec();
    else stopRec();
  }

  function updatePttText() {
    const toggle = $("#optToggle").checked;
    let txt;
    if (!S.radioOn) txt = "Radio apagada";
    else if (S.talking) txt = toggle ? "Hablando…\ntoca para terminar" : "Hablando…";
    else txt = toggle ? "Toca para hablar" : "Mantén para hablar";
    $("#pttText").textContent = txt;
    $("#ptt").classList.toggle("off", !S.radioOn);
  }

  function onPress() {
    if ($("#optToggle").checked) setTalking(!S.talking);
    else setTalking(true);
  }
  function onRelease() {
    if (!$("#optToggle").checked) setTalking(false);
  }

  // ---------- Transcripción ----------
  // En la app de Android el WebView no trae reconocimiento de voz, así que se usa el de
  // Android (plugin SpeechRecognition) con la misma forma que el del navegador.
  class NativeSR {
    constructor() {
      this.lang = "es-MX";
      this.interimResults = true;
      this.continuous = false;
      this.maxAlternatives = 1;
      this.onresult = null;
      this.onend = null;
      this.onerror = null;
      this._cur = "";
      this._done = false;
      this._finishing = false;
      this._poll = null;
      this._handle = null;
      this._P = null;
      this._t0 = 0;
    }
    _emit(text, isFinal) {
      if (!this.onresult || !text) return;
      const res = Object.assign([{ transcript: text }], { isFinal: isFinal });
      this.onresult({ resultIndex: 0, results: [res] });
    }
    _cleanup() {
      this._done = true;
      clearInterval(this._poll);
      if (this._handle) {
        try {
          this._handle.remove();
        } catch (_) {}
        this._handle = null;
      }
    }
    _fail(code) {
      this._cleanup();
      if (this.onerror) this.onerror({ error: code });
      setTimeout(() => this.onend && this.onend(), 0);
    }
    // Termina la sesión: espera un momento a que llegue el texto final
    _finish(waitMs) {
      if (this._finishing || this._done) return;
      this._finishing = true;
      clearInterval(this._poll);
      setTimeout(() => {
        const text = this._cur.trim();
        this._emit(text, true);
        this._cleanup();
        if (!text && Date.now() - this._t0 < 700) NativeSR.quick++;
        else NativeSR.quick = 0;
        if (NativeSR.quick >= 5) {
          NativeSR.quick = 0; // demasiadas sesiones vacías seguidas: algo ocupa el micrófono
          if (this.onerror) this.onerror({ error: "audio-capture" });
        }
        if (this.onend) this.onend();
      }, waitMs);
    }
    async start() {
      const P = nativePlugin("SpeechRecognition");
      if (!P) return this._fail("service-not-allowed");
      this._P = P;
      this._t0 = Date.now();
      try {
        const perm = await P.checkPermissions();
        if (!perm || perm.speechRecognition !== "granted") {
          const req = await P.requestPermissions();
          if (!req || req.speechRecognition !== "granted") return this._fail("not-allowed");
        }
        this._handle = await P.addListener("partialResults", (d) => {
          if (this._done) return;
          const m = d && d.matches && d.matches[0];
          if (m) {
            this._cur = String(m);
            this._emit(this._cur, false);
          }
        });
        await P.start({ language: this.lang, maxResults: 1, partialResults: true, popup: false });
      } catch (e) {
        return this._fail("audio-capture");
      }
      this._poll = setInterval(async () => {
        try {
          const r = await P.isListening();
          if (r && !r.listening) this._finish(500); // Android terminó de escuchar esta frase
        } catch (_) {}
      }, 350);
    }
    stop() {
      try {
        if (this._P) this._P.stop();
      } catch (_) {}
      this._finish(900);
    }
    abort() {
      this.stop();
    }
  }
  NativeSR.quick = 0;

  const SR = NATIVE ? NativeSR : window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = { r: null, finalText: "", interim: "", active: false, finishing: false, timer: null, target: null };

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
    rec.target = S.talkTarget;
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
      if (rec.active && S.talking) {
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
    if (text) sendText(text, null, rec.target);
  }

  // Envía un mensaje (voz transcrita o clave tocada) al destino
  function sendText(text, forcedClaves, target) {
    const t = target || S.target;
    const clean = clip(text, 300);
    if (!clean || !t) return;
    const claves = forcedClaves || detectClaves(clean).map((c) => c.code);
    const links = linksOf(t);
    links.forEach((l) => sendLink(l, { t: "msg", text: clean, claves }));
    addMessage({ who: "Tú", where: whereLabel(t), text: clean, claves, me: true, undelivered: links.length === 0 });
  }

  // ---------- Pantalla: mensajes ----------
  function renderFeedEmpty() {
    const feed = $("#feed");
    if (feed.children.length) return;
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Aquí aparecerá lo que se diga en tus canales y contactos.";
    feed.appendChild(d);
  }

  function chipEl(code) {
    const c = document.createElement("span");
    c.className = "chip " + CLAVES[code][1];
    c.textContent = `${code} · ${CLAVES[code][0]}`;
    return c;
  }

  function addMessage({ who, where, text, claves, me, undelivered }) {
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
    t.textContent = (where ? where + " · " : "") + timeStr();
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
    if (undelivered) {
      const u = document.createElement("div");
      u.className = "undelivered";
      u.textContent = "Nadie estaba conectado: no se entregó.";
      card.appendChild(u);
    }
    feed.appendChild(card);
    while (feed.children.length > 100) feed.firstChild.remove();
    feed.scrollTop = feed.scrollHeight;

    if (!me) {
      const urgent = claves.filter((c) => CLAVES[c][1] === "urgent");
      const warn = claves.filter((c) => CLAVES[c][1] === "warn");
      const src = who + (where ? " · " + where : "");
      if (urgent.length) showAlert(src, urgent);
      else if (warn.length) beep(false);

      // App fuera de pantalla: aviso del sistema con sonido y vibración
      if (NATIVE && Radio && document.visibilityState === "hidden" && (urgent.length || warn.length)) {
        const list = urgent.length ? urgent : warn;
        try {
          Radio.alert({
            title: (urgent.length ? "⚠ " : "") + list.map((c) => CLAVES[c][0]).join(" · "),
            text: src + ": " + text,
            urgent: urgent.length > 0,
          });
        } catch (e) {}
      }
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
    clearTimeout(S.alertTimer);
    S.alertTimer = setTimeout(() => a.classList.add("hidden"), 12000);
    beep(true);
    if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 400]);
  }

  function beep(urgent) {
    const ctx = S.audioCtx;
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

  // ---------- Pantalla: dibujar todo ----------
  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAll();
    }, 0);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function btn(text, cls, onclick) {
    const b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", onclick);
    return b;
  }

  function renderStatus() {
    const dot = document.querySelector("#status .dot");
    let text;
    let kind = "";
    if (!S.radioOn) {
      text = "Radio apagada";
      kind = "bad";
    } else {
      let chans = 0;
      let people = 0;
      let offline = false;
      let waiting = false;
      groups.forEach((g) => {
        if (g.kind === "channel") chans++;
        g.links.forEach((l) => {
          if (isOpen(l)) people++;
        });
        if (g.status === "offline" || g.status === "error") offline = true;
        else if (g.status === "connecting") waiting = true;
      });
      if (offline) {
        text = "Sin conexión, reintentando…";
        kind = "bad";
      } else if (waiting || !groups.size) {
        text = "Conectando…";
      } else {
        text = `En línea · ${chans} canal${chans === 1 ? "" : "es"} · ${people} conectado${people === 1 ? "" : "s"}`;
        kind = "ok";
      }
    }
    $("#statusText").textContent = text;
    dot.className = "dot" + (kind ? " " + kind : "");
    const pw = $("#power");
    pw.textContent = S.radioOn ? "Apagar" : "Encender";
    pw.classList.toggle("on", S.radioOn);
  }

  function renderTargets() {
    const box = $("#targets");
    box.textContent = "";
    const items = [];
    S.channels
      .filter((c) => c.on)
      .forEach((c) =>
        items.push({ t: { type: "channel", room: c.room }, label: "📻 " + c.label, online: groups.has("c:" + c.room) })
      );
    S.contacts
      .filter((c) => c.state === "ok")
      .forEach((c) => {
        const t = { type: "contact", code: c.code };
        items.push({ t, label: "👤 " + c.name, online: linksOf(t).length > 0 });
      });
    if (!items.length) {
      box.appendChild(el("span", "tl-empty", "Agrega un canal o un contacto"));
      return;
    }
    items.forEach((it) => {
      const b = btn(it.label, "target-chip", () => selectTarget(it.t));
      if (targetKey(it.t) === targetKey(S.target)) b.classList.add("on");
      if (!it.online || !S.radioOn) b.classList.add("off");
      box.appendChild(b);
    });
  }

  function renderPeers() {
    const box = $("#peers");
    box.textContent = "";
    const mk = (text, cls, onclick) => {
      const s = el("span", "peer-chip " + cls, text);
      if (onclick) {
        s.classList.add("tap");
        s.addEventListener("click", onclick);
      }
      box.appendChild(s);
    };
    mk("Tú" + (S.role ? ` (${S.role})` : ""), "me" + (S.talking ? " talking" : ""));
    const t = S.target;
    if (!t) return;
    linksOf(t).forEach((l) => {
      const addable = l.group.kind === "channel" && l.code && l.code !== S.code && !contactByCode(l.code);
      mk((l.talking ? "🎙 " : "") + labelOf(l), l.talking ? "talking" : "", addable ? () => offerContact(l) : null);
    });
  }

  function renderTalkline() {
    const names = [];
    groups.forEach((g) =>
      g.links.forEach((l) => {
        if (l.talking && isOpen(l)) names.push(labelOf(l) + " · " + groupLabel(g));
      })
    );
    $("#talkline").textContent = names.length ? "🎙 " + names.join("   ") : "";
  }

  function renderChannels() {
    const list = $("#chanList");
    list.textContent = "";
    if (!S.channels.length) {
      list.appendChild(el("div", "empty", "Todavía no tienes canales guardados."));
      return;
    }
    S.channels.forEach((c) => {
      const g = groups.get("c:" + c.room);
      let state = c.on ? (S.radioOn ? "Conectando…" : "Radio apagada") : "Desconectado";
      let dot = c.on ? "wait" : "";
      if (g) {
        if (g.status === "ok") {
          const n = Array.from(g.links.values()).filter(isOpen).length;
          state = n ? `${n} conectado${n === 1 ? "" : "s"}` : "Solo tú por ahora";
          dot = "ok";
        } else if (g.status === "full") {
          state = "Canal lleno (máx. 8)";
          dot = "bad";
        } else if (g.status === "offline" || g.status === "error") {
          state = "Sin conexión";
          dot = "bad";
        }
      }
      const row = el("div", "row");
      row.appendChild(el("i", "dot " + dot));
      const info = el("div", "grow");
      info.appendChild(el("b", "", c.label));
      info.appendChild(el("small", "", state));
      row.appendChild(info);
      if (g) {
        row.appendChild(
          btn("Hablar", "sm", () => {
            selectTarget({ type: "channel", room: c.room });
            switchTab("radio");
          })
        );
      }
      const sw = el("label", "switch");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = c.on;
      cb.setAttribute("aria-label", "Conectar a " + c.label);
      cb.addEventListener("change", () => {
        const msg = setChannelOn(c.room, cb.checked);
        $("#chanMsg").textContent = msg;
        if (msg) cb.checked = c.on;
      });
      sw.append(cb, el("span", "slider"));
      row.appendChild(sw);
      row.appendChild(
        btn("🗑", "sm danger", () => {
          if (window.confirm(`¿Quitar el canal «${c.label}»?`)) deleteChannel(c.room);
        })
      );
      list.appendChild(row);
    });
  }

  function renderRequests() {
    const box = $("#reqBox");
    const list = $("#reqList");
    list.textContent = "";
    box.classList.toggle("hidden", requests.size === 0);
    requests.forEach((r, code) => {
      const row = el("div", "row");
      const info = el("div", "grow");
      info.appendChild(el("b", "", r.name + (r.role ? ` (${r.role})` : "")));
      info.appendChild(el("small", "", "Quiere ser tu contacto · " + code));
      row.appendChild(info);
      row.appendChild(btn("Aceptar", "sm ok", () => acceptContact(code)));
      row.appendChild(btn("Rechazar", "sm danger", () => refuseRequest(code)));
      list.appendChild(row);
    });
    const badge = $("#badge");
    badge.textContent = String(requests.size);
    badge.classList.toggle("hidden", requests.size === 0);
  }

  function renderContacts() {
    const list = $("#contactList");
    list.textContent = "";
    $("#myCode").textContent = S.code;
    const hub = groups.get("hub");
    $("#hubNote").textContent =
      hub && hub.status === "inuse"
        ? "Tu código está en uso en otro teléfono. Cierra la app allá o se reintentará solo."
        : !S.radioOn
        ? "Enciende la radio para que tus contactos puedan encontrarte."
        : "";
    if (!S.contacts.length) {
      list.appendChild(el("div", "empty", "Aún no tienes contactos. Dale tu código a alguien o agrega el suyo."));
      return;
    }
    S.contacts.forEach((c) => {
      const online = linksOf({ type: "contact", code: c.code }).length > 0;
      let state;
      let dot = "";
      if (c.state === "ok") {
        state = online ? "En línea" : "Sin conexión";
        dot = online ? "ok" : "";
      } else if (c.state === "pending") {
        state = "Esperando a que acepte…";
        dot = "wait";
      } else {
        state = "No aceptó la solicitud";
        dot = "bad";
      }
      const row = el("div", "row");
      row.appendChild(el("i", "dot " + dot));
      const info = el("div", "grow");
      info.appendChild(el("b", "", c.name));
      info.appendChild(el("small", "", state + " · " + c.code));
      row.appendChild(info);
      if (c.state === "ok") {
        row.appendChild(
          btn("Hablar", "sm", () => {
            selectTarget({ type: "contact", code: c.code });
            switchTab("radio");
          })
        );
      } else if (c.state === "denied") {
        row.appendChild(
          btn("Reintentar", "sm", () => {
            addContact(c.code, c.name);
          })
        );
      }
      row.appendChild(
        btn("🗑", "sm danger", () => {
          if (window.confirm(`¿Quitar a ${c.name} de tus contactos?`)) removeContact(c.code);
        })
      );
      list.appendChild(row);
    });
  }

  function renderAll() {
    ensureTarget();
    renderStatus();
    renderTargets();
    renderPeers();
    renderTalkline();
    renderChannels();
    renderRequests();
    renderContacts();
    updatePttText();
    $("#ptt").classList.toggle("on", S.talking);
  }

  // ---------- Lista de claves ----------
  function renderClaves(filter) {
    const list = $("#clavesList");
    list.textContent = "";
    const f = normalize(filter || "");
    const groupsDef = [
      ["Claves", (k) => /^\d+$/.test(k)],
      ["Roles", (k) => CLAVES[k][1] === "role"],
      ["Ubicaciones", (k) => CLAVES[k][1] === "place"],
    ];
    groupsDef.forEach(([title, test]) => {
      const codes = Object.keys(CLAVES)
        .filter(test)
        .filter((k) => !f || normalize(k + " " + CLAVES[k][0]).includes(f));
      if (!codes.length) return;
      list.appendChild(el("div", "group-title", title));
      codes.forEach((code) => {
        const row = el("div", "clave-row");
        row.appendChild(el("span", "chip " + CLAVES[code][1], code));
        row.appendChild(el("span", "label", CLAVES[code][0]));
        row.appendChild(
          btn("Enviar", "", () => {
            if (!targetKnown(S.target)) {
              switchTab("radio");
              note("Elige a quién enviar: un canal o un contacto.");
              return;
            }
            sendText(`${code} · ${CLAVES[code][0]}`, [code], null);
            switchTab("radio");
          })
        );
        list.appendChild(row);
      });
    });
  }

  function switchTab(tab) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    ["radio", "canales", "contactos", "claves"].forEach((t) => {
      const v = $("#view" + t.charAt(0).toUpperCase() + t.slice(1));
      if (v) v.classList.toggle("hidden", t !== tab);
    });
  }

  // ---------- Entrada y perfil ----------
  function buildRoleSelects() {
    ["#role", "#profRole"].forEach((id) => {
      const sel = $(id);
      sel.textContent = "";
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
    });
  }

  function showScreens() {
    const ready = !!S.name;
    $("#join").classList.toggle("hidden", ready);
    $("#app").classList.toggle("hidden", !ready);
  }

  async function enter() {
    joinMsg("");
    const name = clip($("#name").value, 20);
    if (!name) return joinMsg("Escribe tu nombre.");
    if (!window.Peer) return joinMsg("No se cargó la librería de conexión. Recarga la página.");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      return joinMsg("Este navegador no deja usar el micrófono. Abre la app con https en Chrome.");

    S.name = name;
    S.role = $("#role").value;
    store.set("name", S.name);
    store.set("role", S.role);

    const roomRaw = $("#room").value;
    const room = cleanRoom(roomRaw);
    if (room) {
      let ch = chanByRoom(room);
      if (!ch) {
        ch = { room, label: clip(roomRaw, 24) || room, on: true };
        S.channels.push(ch);
      }
      ch.on = true;
      saveChannels();
      S.target = { type: "channel", room };
      saveTarget();
    }
    showScreens();
    $("#profName").value = S.name;
    $("#profRole").value = S.role;
    renderAll();
    await startRadio();
  }

  function saveProfile() {
    const name = clip($("#profName").value, 20);
    if (!name) {
      $("#profMsg").textContent = "Escribe tu nombre.";
      return;
    }
    S.name = name;
    S.role = $("#profRole").value;
    store.set("name", S.name);
    store.set("role", S.role);
    groups.forEach((g) =>
      g.links.forEach((l) => sendLink(l, { t: "hello", name: S.name, role: S.role, code: S.code }))
    );
    $("#profMsg").textContent = "Guardado.";
    renderAll();
  }

  function copyCode() {
    const done = (ok) => {
      $("#codeMsg").textContent = ok ? "Código copiado." : "Tu código es " + S.code;
    };
    try {
      navigator.clipboard.writeText(S.code).then(() => done(true), () => done(false));
    } catch (e) {
      done(false);
    }
  }

  function shareCode() {
    const text = `Agrégame en Walkie Claves con mi código: ${S.code}`;
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else {
      copyCode();
    }
  }

  // ---------- Arranque ----------
  function unlockAudio() {
    if (S.audioCtx && S.audioCtx.state === "suspended") {
      try {
        S.audioCtx.resume();
      } catch (_) {}
    }
    groups.forEach((g) =>
      g.links.forEach((l) => {
        if (l.audio && l.audio.paused) {
          const p = l.audio.play();
          if (p && p.catch) p.catch(() => {});
        }
      })
    );
  }

  function init() {
    loadState();
    buildRoleSelects();
    $("#name").value = S.name;
    $("#role").value = S.role;
    $("#profName").value = S.name;
    $("#profRole").value = S.role;
    $("#optToggle").checked = store.get("toggle", "0") === "1";
    $("#optTranscribe").checked = store.get("transcribe", "1") === "1";
    $("#optScreen").checked = store.get("screen", "0") === "1";
    renderClaves("");

    $("#enter").addEventListener("click", enter);
    $("#room").addEventListener("keydown", (e) => e.key === "Enter" && enter());
    $("#power").addEventListener("click", () => (S.radioOn ? stopRadio() : startRadio()));
    $("#alert").addEventListener("click", () => $("#alert").classList.add("hidden"));
    $("#search").addEventListener("input", (e) => renderClaves(e.target.value));
    document.querySelectorAll(".tabs button").forEach((b) =>
      b.addEventListener("click", () => switchTab(b.dataset.tab))
    );

    $("#addChanBtn").addEventListener("click", () => {
      $("#chanMsg").textContent = addChannel($("#chanInput").value);
      if (!$("#chanMsg").textContent) $("#chanInput").value = "";
    });
    $("#chanInput").addEventListener("keydown", (e) => e.key === "Enter" && $("#addChanBtn").click());

    $("#addContactBtn").addEventListener("click", () => {
      const msg = addContact($("#contactCode").value, $("#contactName").value);
      $("#contactMsg").textContent = msg || "Solicitud enviada. Aparecerá en línea cuando la acepte.";
      if (!msg) {
        $("#contactCode").value = "";
        $("#contactName").value = "";
      }
    });
    $("#saveProfile").addEventListener("click", saveProfile);
    $("#copyCode").addEventListener("click", copyCode);
    $("#shareCode").addEventListener("click", shareCode);

    $("#optToggle").addEventListener("change", (e) => {
      store.set("toggle", e.target.checked ? "1" : "0");
      if (S.talking) setTalking(false);
      updatePttText();
    });
    $("#optTranscribe").addEventListener("change", (e) => store.set("transcribe", e.target.checked ? "1" : "0"));
    $("#optScreen").addEventListener("change", (e) => {
      store.set("screen", e.target.checked ? "1" : "0");
      if (NATIVE && Radio && S.radioOn) {
        try {
          Radio.keepScreenOn({ on: e.target.checked });
        } catch (_) {}
      }
    });

    const ptt = $("#ptt");
    ptt.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try {
        ptt.setPointerCapture(e.pointerId);
      } catch (_) {}
      onPress();
    });
    ["pointerup", "pointercancel"].forEach((ev) => ptt.addEventListener(ev, onRelease));
    ptt.addEventListener("contextmenu", (e) => e.preventDefault());

    // Barra espaciadora para hablar en computadora
    document.addEventListener("keydown", (e) => {
      if (e.code !== "Space" || e.repeat || !S.radioOn) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      e.preventDefault();
      onPress();
    });
    document.addEventListener("keyup", (e) => {
      if (e.code === "Space" && S.radioOn) onRelease();
    });

    // Cualquier toque desbloquea el audio que el sistema haya dejado en pausa
    document.addEventListener("pointerdown", unlockAudio, true);

    document.addEventListener("visibilitychange", () => {
      if (!S.radioOn) return;
      if (document.visibilityState === "visible") {
        keepAwake();
        discoverAll(); // reconectar de inmediato al volver
      } else if (S.talking) setTalking(false); // al salir de la app se suelta el micrófono
    });
    window.addEventListener("online", () => {
      if (S.radioOn) discoverAll();
    });

    if ("serviceWorker" in navigator && !NATIVE) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    showScreens();
    renderFeedEmpty();
    renderAll();
    // Si la radio estaba encendida la última vez, se vuelve a conectar sola
    if (S.name && S.radioOn) startRadio();
  }

  init();
})();
