/* =========================================================
   Smart Energy dashboard - app logic
   Works in two ways:
     - FIREBASE: live data from the ESP32 (fill in firebase-config.js)
     - DEMO:     simulated data, so the UI can be tried right away
   ========================================================= */
(() => {
  "use strict";

  const C = window.SEMS_CONFIG;
  const DEMO = !C || !C.firebase || String(C.firebase.apiKey).startsWith("YOUR");
  const KEYS = ["battery", "ac", "solar", "wind"];
  const KEY_NAME = { battery: "Battery", ac: "AC input", solar: "Solar", wind: "Wind" };
  const KEY_LETTER = { battery: "B", ac: "AC", solar: "S", wind: "W" };
  const KEY_COLOR = { battery: "var(--battery)", ac: "var(--ac)", solar: "var(--sun)", wind: "var(--wind)" };
  const MODE_LABEL = { manual: "Manual", priority: "Priority", auto: "Auto (AI)" };
  const RANK = ["1<small>st</small>", "2<small>nd</small>", "3<small>rd</small>", "4<small>th</small>"];
  const FIREBASE_VERSION = "10.12.2";
  const OFFLINE_AFTER_MS = 15000;
  const LIVE_POINTS = 300; // 10 min at 2 s

  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = (v, d = 1) => (v === undefined || v === null || isNaN(+v) ? "–" : (+v).toFixed(d));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const state = {
    live: null,
    control: { mode: "priority", relays: { battery: false, ac: false, solar: false, wind: false }, priority: ["solar", "wind", "battery", "ac"] },
    events: [],
    liveBuf: [],
    history: null,
    chart: "power",
    range: "live",
    weather: null,
  };

  // =======================================================
  //  BACKENDS
  // =======================================================
  let backend;

  // ---------- Firebase ----------
  async function firebaseBackend() {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const [appM, authM, dbM] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-database.js`),
    ]);
    const app = appM.initializeApp(C.firebase);
    const auth = authM.getAuth(app);
    const db = dbM.getDatabase(app);
    const path = (p) => dbM.ref(db, `devices/${C.deviceId}/${p}`);
    let unsubs = [];

    authM.onAuthStateChanged(auth, (user) => {
      unsubs.forEach((u) => u());
      unsubs = [];
      if (!user) {
        $("login").hidden = false;
        $("signOutBtn").hidden = true;
        return;
      }
      $("login").hidden = true;
      $("signOutBtn").hidden = false;
      unsubs.push(dbM.onValue(path("live"), (s) => onLive(s.val())));
      unsubs.push(dbM.onValue(path("control"), (s) => onControl(s.val())));
      unsubs.push(dbM.onValue(dbM.query(path("events"), dbM.limitToLast(40)), (s) => {
        const v = s.val() || {};
        onEvents(Object.values(v).sort((a, b) => b.ts - a.ts));
      }));
    });

    $("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      $("loginError").textContent = "";
      try {
        await authM.signInWithEmailAndPassword(auth, $("loginEmail").value, $("loginPass").value);
      } catch (err) {
        $("loginError").textContent = "Sign-in failed. Check the email and password, or create the user in Firebase Authentication.";
      }
    });
    $("signOutBtn").addEventListener("click", () => authM.signOut(auth));

    return {
      async writeControl(ctl) {
        await dbM.set(path("control"), {
          mode: ctl.mode,
          relays: ctl.relays,
          priority: ctl.priority,
          by: auth.currentUser ? auth.currentUser.email : "unknown",
          ts: dbM.serverTimestamp(),
        });
      },
      async loadHistory() {
        const s = await dbM.get(dbM.query(path("history"), dbM.limitToLast(1440)));
        return Object.values(s.val() || {}).sort((a, b) => a.ts - b.ts);
      },
    };
  }

  // ---------- Demo (a small simulated ESP32) ----------
  function demoBackend() {
    $("demoBanner").hidden = false;
    let ctl = { mode: "priority", relays: { battery: false, ac: false, solar: true, wind: true }, priority: ["solar", "wind", "battery", "ac"] };
    let batV = 12.55, windNow = 9, energy = 0.412, aiProg = 1, aiConf = 0.87, lastAi = 0, prioN = 1, lastPrio = 0;
    let lastW = { solar: 0, wind: 0, battery: 0, ac: 0 }, prioAvail = { solar: true, wind: true, battery: true, ac: true };
    const events = [{ ts: Date.now() - 60000, level: "info", msg: "Controller started (demo)" }];

    function sunNow() {
      const wx = state.weather;
      if (wx && wx.radNow !== undefined) return wx.radNow;
      const h = new Date().getHours() + new Date().getMinutes() / 60;
      return Math.max(0, Math.sin(Math.PI * (h - 6) / 12)) * 800;
    }
    function tick() {
      windNow = clamp(windNow + (Math.random() - 0.5) * 3, 0, 40);
      // priority mode: same logic as updatePriority() on the ESP32
      const sunW = 20 * sunNow() / 1000, windCap = 30 * Math.pow(clamp((windNow - 8) / 32, 0, 1), 3) * 4;
      prioAvail = { solar: sunW > 0.5, wind: windCap > 0.3, battery: batV >= 12.0, ac: true };
      const avail = ctl.priority.filter((k) => prioAvail[k]);
      const loadEst = 9.5;
      if (ctl.mode === "priority" && Date.now() - lastPrio > 4000) {
        prioN = clamp(prioN, avail.length ? 1 : 0, avail.length);
        const cap = { solar: sunW, wind: windCap, battery: 6, ac: 1000 };
        const supplied = avail.slice(0, prioN).reduce((s, k) => s + cap[k], 0);
        const lastCap = prioN ? cap[avail[prioN - 1]] : 0;
        if (prioN < avail.length && supplied < loadEst * 1.05) prioN++;
        else if (prioN > 1 && supplied - lastCap >= loadEst * 1.25) prioN--;
        lastPrio = Date.now();
      }
      const prioRelays = { battery: false, ac: false, solar: false, wind: false };
      avail.slice(0, prioN).forEach((k) => (prioRelays[k] = true));
      const relays = { ...(ctl.mode === "auto" ? C.programs[aiProg].relays : ctl.mode === "priority" ? prioRelays : ctl.relays) };
      const solarW = relays.solar ? 20 * sunNow() / 1000 * (0.9 + Math.random() * 0.1) : 0;
      const windW = relays.wind ? 30 * Math.pow(clamp((windNow - 8) / 32, 0, 1), 3) * 4 : 0;
      const loadW = 7 + Math.random() * 5;
      const renew = solarW + windW;
      let batI = 0;
      if (relays.battery) batI = (loadW - renew) / batV;
      else if (renew > loadW) batI = -(renew - loadW) / batV * 0.6;
      batV = clamp(batV - batI * 0.002, 11.3, 13.9);
      energy += loadW * 2 / 3600 / 1000;

      const fc = state.weather && state.weather.next ? state.weather.next : { cloud: 40, wind: 12, rad: sunNow() };
      if (ctl.mode === "auto" && Date.now() - lastAi > 20000) {
        const p = ruleProgram({ bat_v: batV, solar_w: 20 * sunNow() / 1000, wind_w: windW || 2, load_w: loadW, fc_rad: fc.rad, fc_wind: fc.wind });
        if (p !== aiProg) events.unshift({ ts: Date.now(), level: "info", msg: `AI selected Program ${p} (model, ${Math.round(aiConf * 100)}%)` });
        aiProg = p;
        aiConf = 0.7 + Math.random() * 0.3;
        lastAi = Date.now();
        onEvents(events.slice(0, 40));
      }
      const roof = 27 + sunNow() / 60, sys = 31 + loadW / 3;
      onLive({
        ts: Date.now(), fw: "demo", uptime: 0, rssi: -58,
        battery: { v: batV, i: batI, w: batV * batI, soc: clamp((batV - 11.8) / 0.9 * 100, 0, 100), ok: true },
        solar: { v: solarW ? 17.6 : 0, i: solarW / 17.6, w: solarW, ok: true },
        wind: { v: windW ? 14.2 : 0, i: windW / 14.2, w: windW, ok: true },
        load: { v: batV, i: loadW / batV, w: loadW, ok: true },
        temp: { roof, system: sys },
        energyKwh: energy,
        mode: ctl.mode,
        program: matchProgram(relays),
        relays,
        priority: [...ctl.priority], prioActive: prioN, prioAvail: { ...prioAvail },
        ai: { program: aiProg, confidence: aiConf, source: "model", model: "RF 15 trees (demo)", fc_cloud: fc.cloud, fc_wind: fc.wind, fc_rad: fc.rad, fc_valid: true },
        safety: { batLow: false, batHigh: false, overTemp: false, sensorFault: false },
      });
    }
    setTimeout(() => { onControl(ctl); onEvents(events); tick(); }, 50);
    setInterval(tick, 2000);

    return {
      async writeControl(next) {
        const was = ctl.mode;
        ctl = JSON.parse(JSON.stringify(next));
        if (was !== ctl.mode) events.unshift({ ts: Date.now(), level: "info", msg: `Switched to ${ctl.mode.toUpperCase()} mode` });
        if (ctl.mode === "auto") lastAi = 0;
        if (ctl.mode === "priority") { prioN = 1; lastPrio = 0; }
        onControl(ctl);
        onEvents(events.slice(0, 40));
        setTimeout(tick, 600);
      },
      async loadHistory() {
        const rows = [], now = Date.now();
        let v = 12.4, w = 10;
        for (let k = 1440; k > 0; k -= 5) {
          const t = now - k * 60000, h = new Date(t).getHours() + new Date(t).getMinutes() / 60;
          const sun = Math.max(0, Math.sin(Math.PI * (h - 6) / 12));
          w = clamp(w + (Math.random() - 0.5) * 4, 0, 35);
          const solar = 18 * sun * (0.7 + Math.random() * 0.3), wind = 30 * Math.pow(clamp((w - 8) / 32, 0, 1), 3) * 4;
          const load = 7 + Math.random() * 5;
          v = clamp(v + (solar + wind - load) * 0.002, 11.6, 13.8);
          rows.push({ ts: t, bat_v: v, solar_w: solar, wind_w: wind, load_w: load, roof_temp: 26 + sun * 14, sys_temp: 30 + load / 3 });
        }
        return rows;
      },
    };
  }

  // Same rule as the ESP32 fallback and ai/sems_common.py
  function ruleProgram(r) {
    const renew = r.solar_w + r.wind_w, load = r.load_w;
    const coming = r.fc_rad > 300 || r.fc_wind > 20;
    if (r.bat_v < 11.6) return renew >= load ? 1 : 3;
    if (renew >= load) return 1;
    if (r.bat_v >= 12.4) return 2;
    if (r.bat_v >= 11.9 && coming) return 2;
    return 3;
  }

  function matchProgram(relays) {
    if (KEYS.every((k) => !relays[k])) return 0;
    for (const [n, p] of Object.entries(C.programs)) {
      if (KEYS.every((k) => !!p.relays[k] === !!relays[k])) return +n;
    }
    return -1;
  }
  const programName = (n) => (n === 0 ? "All off" : n > 0 && C.programs[n] ? `Program ${n}` : "Custom");

  // =======================================================
  //  DATA IN
  // =======================================================
  function onLive(live) {
    if (!live) return;
    state.live = live;
    state.liveBuf.push({
      t: live.ts || Date.now(),
      solar: +live.solar?.w || 0, wind: +live.wind?.w || 0, load: +live.load?.w || 0,
      battery: +live.battery?.w || 0, batV: +live.battery?.v || null, soc: +live.battery?.soc || null,
      roof: live.temp?.roof !== undefined ? +live.temp.roof : null,
      sys: live.temp?.system !== undefined ? +live.temp.system : null,
    });
    if (state.liveBuf.length > LIVE_POINTS) state.liveBuf.shift();
    render();
    if (state.range === "live") updateChart();
  }
  function onControl(ctl) {
    if (!ctl) return;
    const pr = Array.isArray(ctl.priority) && ctl.priority.length === 4 ? ctl.priority : state.control.priority;
    state.control = { mode: ctl.mode || "priority", relays: { ...state.control.relays, ...(ctl.relays || {}) }, priority: [...pr] };
    renderControl();
  }
  function onEvents(list) {
    state.events = list || [];
    renderEvents();
  }

  // =======================================================
  //  RENDER
  // =======================================================
  function isOnline() {
    if (DEMO) return true;
    return state.live && state.live.ts && Date.now() - state.live.ts < OFFLINE_AFTER_MS;
  }

  function headline(l) {
    const s = l.safety || {}, r = l.relays || {};
    const solarOn = r.solar && +l.solar.w > 0.3, windOn = r.wind && +l.wind.w > 0.3;
    if (s.overTemp) return ["Too hot, so everything is off", `System temperature is ${fmt(l.temp?.system)} °C. It turns back on below 50 °C.`];
    if (s.sensorFault) return ["Battery sensor is not responding", "The battery relay is held off until the INA219 answers again."];
    if (KEYS.every((k) => !r[k])) return ["Everything is off", "No source is connected to the load."];
    let h;
    if (r.ac && !r.battery && !solarOn && !windOn) h = "Running on AC backup";
    else if (r.battery && (solarOn || windOn)) h = "Battery is helping " + (solarOn && windOn ? "the sun and wind" : solarOn ? "the panel" : "the turbine");
    else if (r.battery) h = "Running on the battery";
    else if (solarOn && windOn) h = "Running on sun and wind";
    else if (solarOn) h = "Running on sunshine";
    else if (windOn) h = "Running on wind";
    else if (r.solar || r.wind) h = "Waiting for sun or wind";
    else h = "Running on AC backup";
    if (r.ac && h !== "Running on AC backup") h += ", with AC backup";
    if (s.batLow) h = "Battery is low, so it's cut off";
    if (s.batHigh) h = "Battery is full, so sun and wind are paused";

    const renew = (+l.solar.w || 0) + (+l.wind.w || 0);
    let sub = `The load uses ${fmt(l.load.w)} W and sun and wind give ${fmt(renew)} W. `;
    if (l.mode === "auto") sub += `Auto mode picked ${programName(l.ai?.program)} with ${Math.round((+l.ai?.confidence || 0) * 100)}% agreement.`;
    else if (l.mode === "priority") { const n = l.prioActive || 0; sub += n === 0 ? "Priority mode: no source on your list is available." : n === 1 ? "Priority mode is using the 1st available source on your list." : `Priority mode is using the top ${n} available sources on your list.`; }
    else sub += "Manual mode: you're choosing the sources.";
    return [h, sub];
  }

  function render() {
    const l = state.live;
    if (!l) return;
    const online = isOnline();

    // connection
    const conn = $("conn");
    conn.className = "conn " + (online ? "online" : "offline");
    $("connText").textContent = DEMO ? "Demo" : online ? "Live" : `Offline, last seen ${ago(l.ts)}`;

    // headline
    const [h, sub] = online ? headline(l) : ["Controller is offline", `The last reading arrived ${ago(l.ts)}. Check the ESP32's power and Wi-Fi.`];
    $("headline").textContent = h;
    $("headlineSub").textContent = sub;
    $("heroMode").textContent = MODE_LABEL[l.mode] || "–";
    const onList = KEYS.filter((k) => l.relays && l.relays[k]).map((k) => KEY_NAME[k]);
    $("heroProgram").textContent = onList.length ? onList.join(" + ") : "None";

    renderFlow(l, online);
    renderReadings(l);
    renderAlerts(l, online);
    renderControl();
    renderAI(l);
    $("footDevice").textContent = `Device ${C.deviceId}${l.rssi ? `, Wi-Fi ${l.rssi} dBm` : ""}`;
    $("footFw").textContent = l.fw ? `Firmware ${l.fw}` : "";
  }

  function renderFlow(l, online) {
    const r = l.relays || {};
    const power = { solar: +l.solar?.w || 0, wind: +l.wind?.w || 0, battery: Math.abs(+l.battery?.w || 0), ac: r.ac ? 10 : 0 };
    for (const k of KEYS) {
      const row = $(`row-${k}`);
      row.style.setProperty("--y", row.dataset.y + "px");
      row.classList.toggle("closed", !!r[k]);
      const flowing = online && r[k] && power[k] > 0.3;
      row.classList.toggle("on", flowing);
      row.style.setProperty("--speed", clamp(2.4 - power[k] / 8, 0.45, 2.4).toFixed(2) + "s");
    }
    // battery charging -> flow runs from the bus into the battery
    $("row-battery").classList.toggle("rev", (+l.battery?.i || 0) < -0.02);
    $("flow-load").classList.toggle("on", online && (+l.load?.w || 0) > 0.3);
    $("flow-load").style.setProperty("--speed", clamp(2.4 - (+l.load?.w || 0) / 8, 0.45, 2.4).toFixed(2) + "s");

    const rotor = $("rotor");
    rotor.classList.toggle("spin", online && power.wind > 0.2);
    rotor.style.setProperty("--rot", clamp(3.5 - power.wind / 5, 0.35, 3.5).toFixed(2) + "s");

    $("v-solar").textContent = `${fmt(l.solar?.w)} W`;
    $("v-wind").textContent = `${fmt(l.wind?.w)} W`;
    $("v-ac").textContent = r.ac ? "on" : "off";
    $("v-battery").textContent = `${fmt(l.battery?.v, 2)} V`;
    $("v-load").textContent = `${fmt(l.load?.w)} W`;
    const soc = clamp(+l.battery?.soc || 0, 0, 100), hgt = 24 * soc / 100;
    const fill = $("batFill");
    fill.setAttribute("height", hgt.toFixed(1));
    fill.setAttribute("y", (12 - hgt).toFixed(1));
  }

  function renderReadings(l) {
    const soc = Math.round(+l.battery?.soc || 0);
    const ring = $("socRing");
    ring.style.setProperty("--p", soc);
    ring.classList.toggle("low", soc < 20);
    $("socText").textContent = `${soc}%`;
    $("r-bat-v").textContent = fmt(l.battery?.v, 2);
    const bi = +l.battery?.i || 0;
    $("r-bat-i").textContent = Math.abs(bi) < 0.02 ? "Idle" : bi > 0 ? `Discharging ${fmt(bi, 2)} A` : `Charging ${fmt(-bi, 2)} A`;
    $("r-sol-w").textContent = fmt(l.solar?.w);
    $("r-sol-vi").textContent = l.solar?.ok === false ? "Sensor missing" : `${fmt(l.solar?.v)} V, ${fmt(l.solar?.i, 2)} A`;
    $("r-wind-w").textContent = fmt(l.wind?.w);
    $("r-wind-vi").textContent = l.wind?.ok === false ? "Sensor missing" : `${fmt(l.wind?.v)} V, ${fmt(l.wind?.i, 2)} A`;
    $("r-load-w").textContent = fmt(l.load?.w);
    $("r-energy").textContent = `${fmt(l.energyKwh, 3)} kWh used in total`;
    $("r-roof").textContent = l.temp?.roof !== undefined ? `${fmt(l.temp.roof)} °C` : "–";
    $("r-sys").textContent = l.temp?.system !== undefined ? `${fmt(l.temp.system)} °C` : "–";
    $("r-temp-note").textContent = `System turns off above ${C.limits.sysTempMax} °C`;
  }

  function renderAlerts(l, online) {
    const s = l.safety || {}, bar = $("alertBar");
    let msg = "", warn = false;
    if (!online && !DEMO) { msg = "No data from the controller for over 15 seconds. Relays keep their last state; safety limits still run on the ESP32."; warn = true; }
    if (s.batHigh) { msg = `Battery is above ${C.limits.batHigh} V. Solar and wind are cut off to stop over-charging.`; warn = true; }
    if (s.batLow) msg = `Battery dropped below ${C.limits.batLow} V. The battery output is cut off until it recovers to 12.0 V.`;
    if (s.sensorFault) msg = "The battery INA219 is not responding. Check its wiring and I2C address (0x40).";
    if (s.overTemp) msg = `System temperature passed ${C.limits.sysTempMax} °C. Everything is off until it cools below 50 °C.`;
    bar.hidden = !msg;
    bar.textContent = msg;
    bar.classList.toggle("warn", warn);
  }

  // ---------- control ----------
  function renderPrograms() {
    const box = $("programs");
    box.innerHTML = "";
    for (const [n, p] of Object.entries(C.programs)) {
      const el = document.createElement("div");
      el.className = "prog";
      el.dataset.prog = n;
      const pat = KEYS.map((k) => `<span class="${p.relays[k] ? "on" : ""}" style="--c: var(--${k === "ac" ? "ac" : k === "solar" ? "sun" : k})" title="${KEY_NAME[k]} ${p.relays[k] ? "on" : "off"}">${KEY_LETTER[k]}</span>`).join("");
      el.innerHTML = `
        <div class="pattern" aria-hidden="true">${pat}</div>
        <div><h3>Program ${n}: ${p.name}<span class="badge" hidden>AI choice</span></h3><p>${p.note}</p></div>
        <button class="use" data-prog="${n}">Use</button>`;
      box.appendChild(el);
    }
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button.use");
      if (!b) return;
      const p = C.programs[b.dataset.prog];
      send({ mode: "manual", relays: { ...p.relays } }, `Program ${b.dataset.prog} sent.` + (state.control.mode !== "manual" ? " Switched to manual mode." : ""));
    });
  }

  function renderRelays() {
    const box = $("relayList");
    box.innerHTML = "";
    for (const k of KEYS) {
      const color = k === "solar" ? "var(--sun)" : `var(--${k})`;
      const row = document.createElement("div");
      row.className = "relay";
      row.style.setProperty("--c", color);
      row.innerHTML = `
        <label for="sw-${k}"><span class="dot"></span>${KEY_NAME[k]} <span class="why" id="why-${k}"></span></label>
        <span class="switch"><input type="checkbox" role="switch" id="sw-${k}" data-key="${k}" /><i></i></span>`;
      box.appendChild(row);
    }
    box.addEventListener("change", (e) => {
      const k = e.target.dataset.key;
      if (!k) return;
      const base = state.control.mode !== "manual" && state.live ? state.live.relays : state.control.relays;
      const relays = { ...base, [k]: e.target.checked };
      send({ mode: "manual", relays }, `${KEY_NAME[k]} turned ${e.target.checked ? "on" : "off"}.` + (state.control.mode !== "manual" ? " Switched to manual mode." : ""));
    });
  }

  function renderPriority() {
    const ctl = state.control, l = state.live, ol = $("priorityList");
    const live = ctl.mode === "priority";
    $("priorityBox").classList.toggle("live", live);
    ol.innerHTML = "";
    ctl.priority.forEach((k, i) => {
      const avail = l?.prioAvail ? l.prioAvail[k] !== false : true;
      const on = !!(l?.relays && l.relays[k]);
      let stateTxt;
      if (!live) stateTxt = "Used in Priority mode";
      else if (!avail) stateTxt = k === "battery" ? "Not available, battery below 12.0 V" : "Not available right now";
      else stateTxt = on ? "Feeding the load" : "Standby, not needed now";
      const li = document.createElement("li");
      li.className = "pri-item" + (live && on ? " feeding" : "") + (live && !avail ? " unavailable" : "");
      li.style.setProperty("--c", KEY_COLOR[k]);
      li.innerHTML = `<span class="pri-rank">${RANK[i]}</span>
        <span class="pri-name">${KEY_NAME[k]}<span class="pri-state">${stateTxt}</span></span>
        <span class="pri-move">
          <button data-move="-1" data-i="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move ${KEY_NAME[k]} up">&#8593;</button>
          <button data-move="1" data-i="${i}" ${i === 3 ? "disabled" : ""} aria-label="Move ${KEY_NAME[k]} down">&#8595;</button>
        </span>`;
      ol.appendChild(li);
    });
  }

  function renderControl() {
    const ctl = state.control, l = state.live;
    $("modeManual").setAttribute("aria-checked", ctl.mode === "manual");
    $("modePriority").setAttribute("aria-checked", ctl.mode === "priority");
    $("modeAuto").setAttribute("aria-checked", ctl.mode === "auto");
    $("modeHint").textContent = {
      auto: "The AI on the ESP32 picks a program every minute. Pick a program or flip a relay to take over in manual mode.",
      priority: "Sources turn on in your order until the load is covered. Use the arrows to change the order.",
      manual: "You choose each source. Switch to Priority or Auto to let the system decide.",
    }[ctl.mode];
    renderPriority();

    const active = l ? l.program : null, aiProg = l?.ai?.program;
    document.querySelectorAll(".prog").forEach((el) => {
      const n = +el.dataset.prog;
      el.classList.toggle("active", n === active);
      el.querySelector(".badge").hidden = !(ctl.mode === "auto" && n === aiProg);
      el.querySelector(".use").textContent = n === active ? "Active" : "Use";
    });

    const shown = ctl.mode !== "manual" && l ? l.relays : ctl.relays;
    const s = l?.safety || {};
    const forced = { battery: s.batLow || s.sensorFault || s.overTemp, ac: s.overTemp, solar: s.batHigh || s.overTemp, wind: s.batHigh || s.overTemp };
    for (const k of KEYS) {
      const sw = $(`sw-${k}`);
      if (!sw) continue;
      sw.checked = !!(shown && shown[k]);
      $(`why-${k}`).textContent = forced[k] ? "held off by safety" : "";
    }
  }

  // ---------- AI ----------
  function renderAI(l) {
    const ai = l.ai || {};
    const p = ai.program;
    $("aiChoice").textContent = p > 0 && C.programs[p] ? `Program ${p}` : "–";
    const conf = Math.round((+ai.confidence || 0) * 100);
    $("confBar").style.width = conf + "%";
    $("confText").textContent = conf + "%";
    $("aiSource").textContent = ai.source === "model"
      ? "Decided by the Random Forest running on the ESP32."
      : ai.source === "rule" ? "Decided by the built-in rule. The model waits for the first weather forecast." : "No decision yet.";
    $("aiModel").textContent = ai.model ? `Model: ${ai.model}.` + (l.mode !== "auto" ? " Auto mode is off, so this choice is not applied." : "") : "";

    const v = +l.battery?.v || 0, renew = (+l.solar?.w || 0) + (+l.wind?.w || 0), load = +l.load?.w || 0;
    const batWord = v < 11.6 ? "low, protect it" : v < 12.0 ? "getting low" : v < 12.4 ? "OK" : v > 13.8 ? "full" : "healthy";
    const gap = renew - load;
    const rad = +ai.fc_rad || 0, wnd = +ai.fc_wind || 0;
    const items = [
      { c: "var(--battery)", b: `${fmt(v, 2)} V`, t: `Battery is ${batWord}` },
      { c: "var(--sun)", b: `${fmt(renew)} W`, t: gap >= 0 ? `Sun and wind cover the ${fmt(load)} W load` : `Sun and wind are ${fmt(-gap)} W short of the load` },
      { c: "var(--sun)", b: `${fmt(rad, 0)} W/m²`, t: rad > 300 ? "Good sun expected next hour" : rad > 50 ? "Some sun expected next hour" : "Little or no sun next hour" },
      { c: "var(--wind)", b: `${fmt(wnd)} km/h`, t: wnd > 20 ? "Strong wind expected next hour" : "Light wind expected next hour" },
      { c: "var(--ink)", b: `${fmt(ai.fc_cloud, 0)}%`, t: "Cloud cover next hour" },
    ];
    $("aiReasons").innerHTML = "";
    for (const it of items) {
      const li = document.createElement("li");
      li.style.setProperty("--c", it.c);
      const sp = document.createElement("span"); sp.textContent = it.t;
      const b = document.createElement("b"); b.textContent = it.b;
      li.append(sp, b);
      $("aiReasons").appendChild(li);
    }
  }

  // ---------- events ----------
  function renderEvents() {
    const ol = $("eventList");
    ol.innerHTML = "";
    if (!state.events.length) { ol.innerHTML = '<li class="empty">No events yet.</li>'; return; }
    for (const e of state.events.slice(0, 40)) {
      const li = document.createElement("li");
      li.className = e.level || "info";
      const t = document.createElement("time");
      t.textContent = e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "";
      const s = document.createElement("span");
      s.textContent = e.msg || "";
      li.append(t, s);
      ol.appendChild(li);
    }
  }

  // =======================================================
  //  CHART
  // =======================================================
  let chart;
  function chartSets(rows, kind, isHist) {
    const g = (r, a, b) => (isHist ? r[b] : r[a]);
    if (kind === "power") return [
      { label: "Solar (W)", color: css("--sun"), data: rows.map((r) => g(r, "solar", "solar_w")) },
      { label: "Wind (W)", color: css("--wind"), data: rows.map((r) => g(r, "wind", "wind_w")) },
      { label: "Load (W)", color: css("--ink"), data: rows.map((r) => g(r, "load", "load_w")) },
    ];
    if (kind === "battery") return [
      { label: "Battery voltage (V)", color: css("--battery"), data: rows.map((r) => g(r, "batV", "bat_v")) },
    ];
    return [
      { label: "Roof (°C)", color: css("--sun"), data: rows.map((r) => g(r, "roof", "roof_temp")) },
      { label: "System (°C)", color: css("--danger"), data: rows.map((r) => g(r, "sys", "sys_temp")) },
    ];
  }
  function updateChart() {
    if (!window.Chart) return;
    const hist = state.range === "day";
    const rows = hist ? state.history || [] : state.liveBuf;
    const labels = rows.map((r) => new Date(hist ? r.ts : r.t).toLocaleTimeString([], hist ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }));
    const sets = chartSets(rows, state.chart, hist).map((s) => ({
      label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color + "22",
      borderWidth: 2, pointRadius: 0, tension: 0.3, fill: state.chart === "battery",
    }));
    if (!chart) {
      Chart.defaults.font.family = "IBM Plex Sans, sans-serif";
      Chart.defaults.color = css("--ink-2");
      chart = new Chart($("chart"), {
        type: "line",
        data: { labels, datasets: sets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { position: "top", align: "end", labels: { boxWidth: 12, boxHeight: 3 } } },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
            y: { grid: { color: css("--rule") }, beginAtZero: false },
          },
        },
      });
    } else {
      chart.data.labels = labels;
      chart.data.datasets = sets;
      chart.update("none");
    }
  }

  // =======================================================
  //  WEATHER + SKY
  // =======================================================
  async function loadWeather() {
    const { latitude, longitude, name } = C.site;
    $("heroSite").textContent = name;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      "&current=temperature_2m,cloud_cover,wind_speed_10m,shortwave_radiation" +
      "&hourly=temperature_2m,cloud_cover,wind_speed_10m,shortwave_radiation" +
      "&daily=sunrise,sunset&forecast_days=2&timezone=auto";
    try {
      const w = await (await fetch(url)).json();
      const nowStr = w.current.time;
      const start = w.hourly.time.findIndex((t) => t > nowStr);
      const hours = [];
      for (let k = start; k < start + 12 && k < w.hourly.time.length; k++) {
        hours.push({ t: w.hourly.time[k].slice(11, 16), rad: w.hourly.shortwave_radiation[k], wind: w.hourly.wind_speed_10m[k], temp: w.hourly.temperature_2m[k], cloud: w.hourly.cloud_cover[k] });
      }
      state.weather = {
        hours, radNow: w.current.shortwave_radiation,
        next: hours[0] ? { cloud: hours[0].cloud, wind: hours[0].wind, rad: hours[0].rad } : null,
      };
      $("heroWeather").textContent = `${Math.round(w.current.temperature_2m)} °C, ${Math.round(w.current.cloud_cover)}% cloud`;
      renderWeather();
      const mins = (s) => +s.slice(11, 13) * 60 + +s.slice(14, 16);
      setSky(mins(nowStr), mins(w.daily.sunrise[0]), mins(w.daily.sunset[0]), w.current.cloud_cover);
    } catch (e) {
      $("heroWeather").textContent = "Unavailable";
      const n = new Date();
      setSky(n.getHours() * 60 + n.getMinutes(), 360, 1095, 30);
    }
  }

  function renderWeather() {
    const box = $("wxStrip");
    box.innerHTML = "";
    const hrs = state.weather?.hours || [];
    const maxRad = Math.max(400, ...hrs.map((h) => h.rad));
    for (const h of hrs) {
      const col = document.createElement("div");
      col.className = "wx-col";
      col.title = `${h.t}: ${Math.round(h.rad)} W/m² sun, ${Math.round(h.wind)} km/h wind, ${Math.round(h.cloud)}% cloud`;
      col.innerHTML = `<span class="t">${Math.round(h.temp)}°</span>
        <div class="bar-area"><div class="bar" style="height:${(h.rad / maxRad * 100).toFixed(0)}%"></div></div>
        <span class="wv">${Math.round(h.wind)}</span><span>${h.t}</span>`;
      box.appendChild(col);
    }
    $("wxLegend").hidden = !hrs.length;
  }

  // The hero sky follows the real sun at the site
  function setSky(now, rise, set, cloud) {
    const root = document.documentElement.style;
    let sky;
    if (now < rise - 40 || now > set + 40) sky = ["#0E1A3A", "#2A3D72", "#EEF2FA", "rgba(238,242,250,.72)", "rgba(255,255,255,.12)"];
    else if (now < rise + 50) sky = ["#5C6FB3", "#F7C08A", "#16213A", "rgba(22,33,58,.75)", "rgba(255,255,255,.4)"];
    else if (now > set - 60) sky = ["#3B3C7A", "#F0895B", "#FFF5EC", "rgba(255,245,236,.8)", "rgba(255,255,255,.16)"];
    else if (cloud > 70) sky = ["#8DA6BB", "#DDE5EB", "#14263C", "rgba(20,38,60,.72)", "rgba(255,255,255,.5)"];
    else sky = ["#5FAEE3", "#D6ECF8", "#12263F", "rgba(18,38,63,.72)", "rgba(255,255,255,.55)"];
    ["--sky-top", "--sky-bottom", "--sky-ink", "--sky-ink-2", "--sky-glass"].forEach((v, i) => root.setProperty(v, sky[i]));
  }

  // =======================================================
  //  ACTIONS
  // =======================================================
  async function send(ctl, msg) {
    try {
      ctl.priority = ctl.priority || [...state.control.priority];
      await backend.writeControl(ctl);
      state.control = { mode: ctl.mode, relays: { ...ctl.relays }, priority: [...ctl.priority] };
      renderControl();
      toast(msg + (DEMO ? "" : " The controller applies it within a few seconds."));
    } catch (e) {
      toast("Could not send the command. Check that you're signed in and online.");
      renderControl();
    }
  }

  function wireUi() {
    $("modeManual").addEventListener("click", () => {
      if (state.control.mode === "manual") return;
      const relays = state.live ? { ...state.live.relays } : { ...state.control.relays };
      send({ mode: "manual", relays }, "Manual mode on. The sources stay as they are until you change them.");
    });
    $("modeAuto").addEventListener("click", () => {
      if (state.control.mode === "auto") return;
      send({ mode: "auto", relays: { ...state.control.relays } }, "Auto mode on. The AI picks a program now.");
    });
    $("modePriority").addEventListener("click", () => {
      if (state.control.mode === "priority") return;
      send({ mode: "priority", relays: { ...state.control.relays } }, "Priority mode on. Sources follow your list.");
    });
    $("priorityList").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-move]");
      if (!b || b.disabled) return;
      const i = +b.dataset.i, j = i + +b.dataset.move;
      const order = [...state.control.priority];
      [order[i], order[j]] = [order[j], order[i]];
      send({ mode: state.control.mode, relays: { ...state.control.relays }, priority: order },
        `Priority saved: ${order.map((k, n) => `${n + 1}. ${KEY_NAME[k]}`).join(", ")}.`);
      setTimeout(() => { const btn = $("priorityList").querySelectorAll("button[data-move]")[j * 2 + (+b.dataset.move > 0 ? 1 : 0)]; if (btn && !btn.disabled) btn.focus(); }, 50);
    });
    $("allOffBtn").addEventListener("click", () => {
      send({ mode: "manual", relays: { battery: false, ac: false, solar: false, wind: false } }, "Everything turned off. Switched to manual mode.");
    });
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
      state.chart = b.dataset.chart;
      updateChart();
    }));
    document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", async () => {
      document.querySelectorAll("[data-range]").forEach((x) => x.setAttribute("aria-checked", x === b));
      state.range = b.dataset.range;
      if (state.range === "day") {
        try { state.history = await backend.loadHistory(); } catch (e) { state.history = []; toast("Could not load the 24-hour history."); }
      }
      updateChart();
    }));
  }

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3800);
  }
  function ago(ts) {
    if (!ts) return "never";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  }

  // =======================================================
  //  START
  // =======================================================
  async function start() {
    renderPrograms();
    renderRelays();
    wireUi();
    loadWeather();
    setInterval(loadWeather, 15 * 60 * 1000);
    setInterval(() => state.live && render(), 5000); // keeps "offline" status fresh
    if (DEMO) {
      backend = demoBackend();
    } else {
      try {
        backend = await firebaseBackend();
      } catch (e) {
        $("headline").textContent = "Can't reach Firebase";
        $("headlineSub").textContent = "Check firebase-config.js and your internet connection.";
      }
    }
  }
  start();
})();
