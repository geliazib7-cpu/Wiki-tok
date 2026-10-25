// Diccionario de claves y detector de claves en texto hablado.
// Se usa tanto en el navegador como en Node (para pruebas).
(function (root) {
  // tipo: urgent (rojo), warn (ámbar), info (gris), role (azul), place (verde)
  const CLAVES = {
    "01": ["Falsa alarma", "info"],
    "02": ["Alerta general", "urgent"],
    "03": ["Repita mensaje", "info"],
    "05": ["Rindan novedades", "info"],
    "06": ["Sin novedad", "info"],
    "07": ["Afirmativo", "info"],
    "08": ["Negativo", "info"],
    "09": ["Solicito apoyo", "urgent"],
    "10": ["Pendiente", "info"],
    "11": ["Enterado", "info"],
    "12": ["Adelante", "info"],
    "13": ["Ayuda autoridades", "urgent"],
    "14": ["Hablar sin claves", "info"],
    "15": ["Fuera de frecuencia", "info"],
    "16": ["Fuerte y claro", "info"],
    "17": ["Prueba de radio", "info"],
    "18": ["Disponible", "info"],
    "19": ["Retira del lugar", "warn"],
    "21": ["Peligro", "urgent"],
    "22": ["Ir al lugar", "warn"],
    "23": ["Inicio recorrido", "info"],
    "24": ["Darse a la fuga", "urgent"],
    "25": ["Teléfono", "info"],
    "26": ["W.C.", "info"],
    "27": ["Alimentos", "info"],
    "28": ["Robo", "urgent"],
    "29": ["Ubicación", "info"],
    "30": ["Lesionado", "urgent"],
    "31": ["Incendio", "urgent"],
    "32": ["Armado", "urgent"],
    "33": ["Abrir puertas", "warn"],
    "34": ["Mujer", "info"],
    "35": ["Hombre", "info"],
    "36": ["Niño", "info"],
    "37": ["Lesionado", "urgent"],
    "38": ["Locatario", "info"],
    "39": ["Compañeros", "info"],
    "40": ["Llaves de acceso", "info"],
    "41": ["Pelea", "urgent"],
    "44": ["Cierre de puertas", "warn"],
    "45": ["Orden superior", "warn"],
    "46": ["Dar facilidades", "info"],
    "50": ["Retira del lugar", "warn"],
    // Roles
    G1: ["Gerente de plaza", "role"],
    G2: ["Subgerente de plaza", "role"],
    G3: ["Analista de plaza", "role"],
    FENIX: ["Fénix · Jefe de mantenimiento", "role"],
    MERCURIO: ["Mercurio · Aux. de mantenimiento", "role"],
    R1: ["Jefe de guardias", "role"],
    R2: ["Compañero en joyería", "role"],
    R3: ["Compañero en Valladolid", "role"],
    R4: ["Compañero en Virrey", "role"],
    R5: ["Compañero en Alzate", "role"],
    // Ubicaciones
    Z2: ["Valladolid", "place"],
    Z3: ["PT Valladolid", "place"],
    Z4: ["Virrey de Mendoza", "place"],
    Z5: ["Antonio Alzate", "place"],
    Z6: ["Centro de plaza", "place"],
    Z7: ["Friki", "place"],
    Z8: ["Azotea", "place"],
  };

  // ---------- Números en palabras ----------
  const UNITS = {
    uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
    seis: 6, siete: 7, ocho: 8, nueve: 9,
  };
  const DIRECT = {
    diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
    dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
    veinte: 20, veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23,
    veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
    veintiocho: 28, veintinueve: 29,
    treinta: 30, cuarenta: 40, cincuenta: 50,
  };
  // Se pueden combinar con "y" + unidad: "treinta y uno", "diez y seis"
  const WITH_Y = { diez: 10, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50 };

  // Nombres de letras como las puede escribir el reconocedor de voz
  const LETTERS = {
    g: "G", ge: "G", je: "G",
    r: "R", erre: "R", ere: "R", ere2: "R",
    z: "Z", zeta: "Z", seta: "Z", ceta: "Z",
  };

  function normalize(text) {
    return String(text)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function twoDigits(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function unitValue(tok) {
    if (tok === undefined) return null;
    if (/^[1-9]$/.test(tok)) return Number(tok);
    if (Object.prototype.hasOwnProperty.call(UNITS, tok)) return UNITS[tok];
    return null;
  }

  // Devuelve [{code, label, kind}] en el orden en que se dijeron, sin repetir.
  function detectClaves(text) {
    const tokens = normalize(text).split(" ").filter(Boolean);
    const found = [];
    const add = (code) => {
      if (CLAVES[code] && !found.includes(code)) found.push(code);
    };

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      // "cero uno" / "0 1" / "cero 1" -> 01
      if (t === "cero" || t === "0") {
        const u = unitValue(tokens[i + 1]);
        if (u !== null) {
          add(twoDigits(u));
          i += 1;
          continue;
        }
      }

      // "01" ... "09" escrito junto
      if (/^0[1-9]$/.test(t)) {
        add(t);
        continue;
      }

      // "10" ... "50" en dígitos
      if (/^[1-5][0-9]$/.test(t)) {
        add(t);
        continue;
      }

      // "treinta y uno", "diez y seis"
      if (Object.prototype.hasOwnProperty.call(WITH_Y, t) && tokens[i + 1] === "y") {
        const u = unitValue(tokens[i + 2]);
        if (u !== null) {
          add(twoDigits(WITH_Y[t] + u));
          i += 2;
          continue;
        }
      }

      // "diez", "once", "veintidos", "cuarenta"...
      if (Object.prototype.hasOwnProperty.call(DIRECT, t)) {
        add(twoDigits(DIRECT[t]));
        continue;
      }

      // Roles y zonas: "g1", "ge uno", "erre dos", "zeta cuatro"
      let m = /^([grz])([1-8])$/.exec(t);
      if (m) {
        add(m[1].toUpperCase() + m[2]);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(LETTERS, t)) {
        const u = unitValue(tokens[i + 1]);
        if (u !== null && u <= 8) {
          add(LETTERS[t] + u);
          i += 1;
          continue;
        }
      }

      if (t === "fenix") add("FENIX");
      if (t === "mercurio") add("MERCURIO");
    }

    return found.map((code) => ({ code, label: CLAVES[code][0], kind: CLAVES[code][1] }));
  }

  const api = { CLAVES, detectClaves, normalize };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Claves = api;
})(typeof self !== "undefined" ? self : this);
