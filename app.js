/* =========================================================
   Smart Energy dashboard - app logic  (v2)
   Sources: Solar, Wind, Grid (AC) -> Battery (charging relay)
   -> three priority outputs.
   Works in two ways:
     - FIREBASE: live data from the ESP32 (fill in firebase-config.js)
     - DEMO:     simulated data, so the UI can be tried right away
   ========================================================= */
(() => {
  "use strict";

  const C = window.SEMS_CONFIG;
  const DEMO = !C || !C.firebase || String(C.firebase.apiKey).startsWith("YOUR");
  const FIREBASE_VERSION = "10.12.2";
  const OFFLINE_AFTER_MS = 15000;
  const LIVE_POINTS = 300; // 10 min at 2 s

  const SOURCES = ["solar", "wind", "grid", "charge"];
  const OUTPUTS = ["out1", "out2", "out3"];
  const ALL = [...SOURCES, ...OUTPUTS];
  const NAME = { solar: "Solar", wind: "Wind", grid: "Grid (AC)", charge: "Battery charging", ...C.outputs };
  const COLOR = { solar: "var(--sun)", wind: "var(--wind)", grid: "var(--grid)", charge: "var(--battery)" };
  const RANK = ["1<small>st</small>", "2<small>nd</small>", "3<small>rd</small>"];
  const allOff = () => Object.fromEntries(ALL.map((k) => [k, false]));

  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = (v, d = 1) => (v === undefined || v === null || isNaN(+v) ? "–" : (+v).toFixed(d));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const state = {
    live: null,
    control: { mode: "auto", relays: allOff() },
    events: [],
    liveBuf: [],
    history: null,
    chart: "power",
    range: "live",
    weather: null,
  };
  const L = () => ({ ...C.limits, ...(state.live?.limits || {}) }); // limits from the ESP32 when known

  // =======================================================
  //  BACKENDS
  // =======================================================
  let backend;

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
      if (!user) { $("login").hidden = false; $("signOutBtn").hidden = true; return; }
      $("login").hidden = true;
      $("signOutBtn").hidden = false;
      unsubs.push(dbM.onValue(path("live"), (s) => onLive(s.val()), (e) => permissionHint(e)));
      unsubs.push(dbM.onValue(path("control"), (s) => onControl(s.val())));
      unsubs.push(dbM.onValue(dbM.query(path("events"), dbM.limitToLast(40)), (s) => {
        onEvents(Object.values(s.val() || {}).sort((a, b) => b.ts - a.ts));
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
          mode: ctl.mode, relays: ctl.relays,
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

  function permissionHint(err) {
    $("headline").textContent = "No permission to read the data";
    $("headlineSub").textContent = "Add your user's UID to the 'allowed' list in the Realtime Database, then reload.";
    console.error(err);
  }

  // ---------- Demo: a small simulated ESP32 (same rules as the firmware) ----------
  function demoBackend() {
    $("demoBanner").hidden = false;
    let ctl = { mode: "auto", relays: allOff() };
    let batV = 12.6, windNow = 11, gen = 0.512, level = 2, conf = 0.88, grid = false, lastDecide = 0;
    let crit = false, full = false;
    const events = [{ ts: Date.now() - 60000, level: "info", msg: "Controller started (demo)" }];
    const lim = C.limits;

    function sunNow() {
      const wx = state.weather;
      if (wx && wx.radNow !== undefined) return wx.radNow;
      const h = new Date().getHours() + new Date().getMinutes() / 60;
      return Math.max(0, Math.sin(Math.PI * (h - 6) / 12)) * 800;
    }
    function ruleLevel(v, solar, renew, fcRad, prev) {
      const h = (n) => (prev >= n ? 0.2 : 0);
      const o1 = v >= lim.out1 - h(1);
      const o2 = o1 && (v >= lim.out2 - h(2) || renew >= lim.out2w || (v >= 12.1 && fcRad > 400));
      const o3 = o2 && v >= lim.out3 - h(3) && solar >= lim.sunGood;
      return +o1 + +o2 + +o3;
    }
    function tick() {
      windNow = clamp(windNow + (Math.random() - 0.5) * 3, 0, 40);
      const solarW = 20 * sunNow() / 1000 * (0.9 + Math.random() * 0.1);
      const windW = 30 * Math.pow(clamp((windNow - 8) / 32, 0, 1), 3) * 4;
      const fc = state.weather?.next || { cloud: 40, wind: 12, rad: sunNow() };

      if (ctl.mode === "auto" && Date.now() - lastDecide > 15000) {
        const nl = ruleLevel(batV, solarW, solarW + windW, fc.rad, level);
        if (nl !== level) events.unshift({ ts: Date.now(), level: "info", msg: `Auto: ${nl} of 3 outputs on (model, ${Math.round(conf * 100)}%)` });
        level = nl; conf = 0.75 + Math.random() * 0.25;
        if (batV < lim.gridOn && solarW + windW < 5) grid = true;
        if (batV >= lim.gridOff) grid = false;
        lastDecide = Date.now();
        onEvents(events.slice(0, 40));
      }
      if (batV < lim.critical) crit = true; if (batV > 11.8) crit = false;
      if (batV >= lim.chargeOff) full = true; if (batV < lim.chargeOn) full = false;

      const r = ctl.mode === "auto"
        ? { solar: true, wind: true, grid, charge: true, out1: level >= 1, out2: level >= 2, out3: level >= 3 }
        : { ...ctl.relays };
      if (full) r.charge = false;
      if (crit) r.out1 = r.out2 = r.out3 = false;

      const draw = (r.out1 ? 4 : 0) + (r.out2 ? 6 : 0) + (r.out3 ? 8 : 0);
      const inW = (r.solar ? solarW : 0) + (r.wind ? windW : 0) + (r.grid ? 15 : 0);
      const chargeW = r.charge ? Math.max(0, inW - draw) : 0;
      const batI = (draw - (r.charge ? inW : 0)) / batV;   // + = discharging
      batV = clamp(batV - batI * 0.003 + (Math.random() - 0.5) * 0.004, 11.2, 14.5);
      gen += ((r.solar ? solarW : 0) + (r.wind ? windW : 0)) * 2 / 3600 / 1000;

      onLive({
        ts: Date.now(), fw: "demo", rssi: -58,
        battery: { v: batV, i: batI, w: batV * batI, soc: clamp((batV - 11.8) / 0.9 * 100, 0, 100), ok: true },
        solar: { v: solarW ? 17.6 : 0, i: solarW / 17.6, w: r.solar ? solarW : 0, ok: true },
        wind: { v: windW ? 14.2 : 0, i: windW / 14.2, w: r.wind ? windW : 0, ok: true },
        temp: { panel: 27 + sunNow() / 40, system: 31 + draw / 4 },
        genKwh: gen, mode: ctl.mode, relays: r, chargeW,
        ai: { level, confidence: conf, source: "model", model: "RF 15 trees (demo)", fc_cloud: fc.cloud, fc_wind: fc.wind, fc_rad: fc.rad, fc_valid: true },
        safety: { batCritical: crit, batFull: full, overTemp: false, sensorFault: false },
        limits: lim,
      });
    }
    setTimeout(() => { onControl(ctl); onEvents(events); tick(); }, 50);
    setInterval(tick, 2000);

    return {
      async writeControl(next) {
        const was = ctl.mode;
        ctl = JSON.parse(JSON.stringify(next));
        if (was !== ctl.mode) events.unshift({ ts: Date.now(), level: "info", msg: `Switched to ${ctl.mode.toUpperCase()} mode` });
        if (ctl.mode === "auto") lastDecide = 0;
        onControl(ctl);
        onEvents(events.slice(0, 40));
        setTimeout(tick, 500);
      },
      async loadHistory() {
        const rows = [], now = Date.now();
        let v = 12.4, w = 10;
        for (let k = 1440; k > 0; k -= 5) {
          const t = now - k * 60000, h = new Date(t).getHours() + new Date(t).getMinutes() / 60;
          const sun = Math.max(0, Math.sin(Math.PI * (h - 6) / 12));
          w = clamp(w + (Math.random() - 0.5) * 4, 0, 35);
          const solar = 18 * sun * (0.7 + Math.random() * 0.3), wind = 30 * Math.pow(clamp((w - 8) / 32, 0, 1), 3) * 4;
          v = clamp(v + (solar + wind - 10) * 0.002, 11.6, 14.2);
          rows.push({ ts: t, bat_v: v, bat_i: (10 - solar - wind) / v, solar_w: solar, wind_w: wind, panel_temp: 26 + sun * 20, sys_temp: 31 + sun * 4 });
        }
        return rows;
      },
    };
  }

  // =======================================================
  //  DATA IN
  // =======================================================
  function onLive(live) {
    if (!live) return;
    state.live = live;
    state.liveBuf.push({
      t: live.ts || Date.now(),
      solar: +live.solar?.w || 0, wind: +live.wind?.w || 0,
      battery: +live.battery?.w || 0, batV: +live.battery?.v || null,
      panel: live.temp?.panel !== undefined ? +live.temp.panel : null,
      sys: live.temp?.system !== undefined ? +live.temp.system : null,
    });
    if (state.liveBuf.length > LIVE_POINTS) state.liveBuf.shift();
    render();
    if (state.range === "live") updateChart();
  }
  function onControl(ctl) {
    if (!ctl) return;
    state.control = { mode: ctl.mode === "manual" ? "manual" : "auto", relays: { ...allOff(), ...(ctl.relays || {}) } };
    renderControl();
  }
  function onEvents(list) { state.events = list || []; renderEvents(); }

  // =======================================================
  //  RENDER
  // =======================================================
  const isOnline = () => DEMO || (state.live?.ts && Date.now() - state.live.ts < OFFLINE_AFTER_MS);
  const outsOn = (r) => OUTPUTS.filter((k) => r && r[k]);

  function headline(l) {
    const s = l.safety || {}, r = l.relays || {}, n = outsOn(r).length;
    if (s.overTemp) return ["Too hot, so everything is off", `System temperature is ${fmt(l.temp?.system)} °C. It turns back on below 50 °C.`];
    if (s.sensorFault) return ["Battery sensor is not responding", "Charging and outputs are held off until the INA226 (0x45) answers again."];
    if (s.batCritical) return ["Battery is very low, so all outputs are off", `Outputs come back when the battery recovers above 11.8 V.${r.grid ? " The grid is charging it now." : ""}`];
    let h;
    if (n === 3) h = "All three outputs are on";
    else if (n === 0) h = "All outputs are off";
    else if (n === 1 && r.out1) h = `Only ${NAME.out1} is on`;
    else h = `${n} of 3 outputs are on`;
    const renew = (+l.solar?.w || 0) + (+l.wind?.w || 0);
    let sub = `Sun and wind give ${fmt(renew)} W. `;
    if (r.grid) sub += "The grid is backing up the battery. ";
    else if (s.batFull) sub += "The battery is full, so charging is paused. ";
    sub += l.mode === "auto"
      ? `Auto mode chose this with ${Math.round((+l.ai?.confidence || 0) * 100)}% agreement.`
      : "Manual mode: you're choosing what's on.";
    return [h, sub];
  }

  function render() {
    const l = state.live;
    if (!l) return;
    const online = isOnline();
    const conn = $("conn");
    conn.className = "conn " + (online ? "online" : "offline");
    $("connText").textContent = DEMO ? "Demo" : online ? "Live" : `Offline, last seen ${ago(l.ts)}`;

    const [h, sub] = online ? headline(l) : ["Controller is offline", `The last reading arrived ${ago(l.ts)}. Check the ESP32's power and Wi-Fi.`];
    $("headline").textContent = h;
    $("headlineSub").textContent = sub;
    $("heroMode").textContent = l.mode === "auto" ? "Auto (AI)" : "Manual";
    $("heroOutputs").textContent = `${outsOn(l.relays).length} of 3`;

    renderFlow(l, online);
    renderReadings(l);
    renderAlerts(l, online);
    renderControl();
    renderAI(l);
    $("footDevice").textContent = `Device ${C.deviceId}${l.rssi ? `, Wi-Fi ${l.rssi} dBm` : ""}`;
    $("footFw").textContent = l.fw ? `Firmware ${l.fw}` : "";
  }

  function setFlow(row, closed, flowing, watts, reverse) {
    const el = $(row);
    if (el.dataset.ox) { el.style.setProperty("--ox", el.dataset.ox + "px"); el.style.setProperty("--oy", el.dataset.oy + "px"); }
    el.classList.toggle("closed", closed);
    el.classList.toggle("on", flowing);
    el.classList.toggle("rev", !!reverse);
    el.style.setProperty("--speed", clamp(2.4 - watts / 8, 0.45, 2.4).toFixed(2) + "s");
  }

  function renderFlow(l, online) {
    const r = l.relays || {};
    const sw = +l.solar?.w || 0, ww = +l.wind?.w || 0, bi = +l.battery?.i || 0, bw = Math.abs(+l.battery?.w || 0);
    setFlow("row-solar", !!r.solar, online && r.solar && sw > 0.3, sw);
    setFlow("row-wind", !!r.wind, online && r.wind && ww > 0.3, ww);
    setFlow("row-grid", !!r.grid, online && !!r.grid, 15);
    setFlow("row-charge", !!r.charge, online && r.charge && bi < -0.02, bw);
    const anyOut = outsOn(r).length > 0;
    setFlow("row-discharge", true, online && anyOut, bw);
    OUTPUTS.forEach((k) => setFlow(`row-${k}`, !!r[k], online && !!r[k], 8));

    const rotor = $("rotor");
    rotor.classList.toggle("spin", online && ww > 0.2);
    rotor.style.setProperty("--rot", clamp(3.5 - ww / 5, 0.35, 3.5).toFixed(2) + "s");

    $("v-solar").textContent = `${fmt(sw)} W`;
    $("v-wind").textContent = `${fmt(ww)} W`;
    $("v-grid").textContent = r.grid ? "on" : "off";
    $("v-battery").textContent = `${fmt(l.battery?.v, 2)} V`;
    $("v-battery-sub").textContent = Math.abs(bi) < 0.02 ? "Idle" : bi < 0 ? `Charging ${fmt(-bi, 2)} A` : `Discharging ${fmt(bi, 2)} A`;
    OUTPUTS.forEach((k) => { $(`v-${k}`).textContent = r[k] ? "on" : "off"; $(`name-${k}`).textContent = NAME[k]; });
    const soc = clamp(+l.battery?.soc || 0, 0, 100), hgt = 24 * soc / 100, fill = $("batFill");
    fill.setAttribute("height", hgt.toFixed(1));
    fill.setAttribute("y", (12 - hgt).toFixed(1));
  }

  function renderReadings(l) {
    const soc = Math.round(+l.battery?.soc || 0), ring = $("socRing");
    ring.style.setProperty("--p", soc);
    ring.classList.toggle("low", soc < 20);
    $("socText").textContent = `${soc}%`;
    $("r-bat-v").textContent = fmt(l.battery?.v, 2);
    const bi = +l.battery?.i || 0;
    $("r-bat-i").textContent = l.battery?.ok === false ? "Sensor missing" : Math.abs(bi) < 0.02 ? "Idle" : bi > 0 ? `Discharging ${fmt(bi, 2)} A` : `Charging ${fmt(-bi, 2)} A`;
    $("r-sol-w").textContent = fmt(l.solar?.w);
    $("r-sol-vi").textContent = l.solar?.ok === false ? "Sensor missing (0x44)" : `${fmt(l.solar?.v)} V, ${fmt(l.solar?.i, 2)} A`;
    $("r-wind-w").textContent = fmt(l.wind?.w);
    $("r-wind-vi").textContent = l.wind?.ok === false ? "Sensor missing (0x40)" : `${fmt(l.wind?.v)} V, ${fmt(l.wind?.i, 2)} A`;
    $("r-gen").textContent = fmt(l.genKwh, 3);
    $("r-panel").textContent = l.temp?.panel !== undefined ? `${fmt(l.temp.panel)} °C` : "–";
    $("r-sys").textContent = l.temp?.system !== undefined ? `${fmt(l.temp.system)} °C` : "–";
    $("r-temp-note").textContent = `Everything turns off above ${L().tempMax} °C`;
  }

  function renderAlerts(l, online) {
    const s = l.safety || {}, bar = $("alertBar"), lim = L();
    let msg = "", warn = false;
    if (!online && !DEMO) { msg = "No data from the controller for over 15 seconds. Relays keep their last state; safety limits still run on the ESP32."; warn = true; }
    if (s.batCritical) msg = `Battery dropped below ${lim.critical} V. All outputs are off until it recovers above 11.8 V.`;
    if (s.sensorFault) msg = "The battery INA226 (0x45) is not responding. Check its wiring and address.";
    if (s.overTemp) msg = `System temperature passed ${lim.tempMax} °C. Everything is off until it cools below 50 °C.`;
    bar.hidden = !msg;
    bar.textContent = msg;
    bar.classList.toggle("warn", warn);
  }

  // ---------- control ----------
  function outputReason(k, l) {
    const lim = L(), s = l?.safety || {}, v = +l?.battery?.v || 0;
    const renew = (+l?.solar?.w || 0) + (+l?.wind?.w || 0);
    const on = !!l?.relays?.[k];
    if (s.overTemp) return [false, "Held off: system too hot"];
    if (s.batCritical) return [false, `Held off: battery below ${lim.critical} V`];
    if (state.control.mode === "manual") return [false, on ? "On, set by you" : "Off, set by you"];
    if (on) return [false, "On"];
    if (k === "out1") return [false, `Off: battery ${fmt(v, 2)} V, needs ${lim.out1} V`];
    if (k === "out2") return [false, `Off: needs battery ${lim.out2} V or sun + wind ${lim.out2w} W (now ${fmt(v, 2)} V, ${fmt(renew)} W)`];
    return [false, `Off: needs battery ${lim.out3} V and solar ${lim.sunGood} W (now ${fmt(v, 2)} V, ${fmt(l?.solar?.w)} W)`];
  }

  function buildLists() {
    const ol = $("outputList");
    ol.innerHTML = "";
    OUTPUTS.forEach((k, i) => {
      const li = document.createElement("li");
      li.className = "pri-item";
      li.id = `pri-${k}`;
      li.style.setProperty("--c", "var(--out)");
      li.innerHTML = `<span class="pri-rank">${RANK[i]}</span>
        <label class="pri-name" for="sw-${k}">${NAME[k]}<span class="pri-state" id="why-${k}"></span></label>
        <span class="switch" style="--c: var(--out)"><input type="checkbox" role="switch" id="sw-${k}" data-key="${k}" /><i></i></span>`;
      ol.appendChild(li);
    });
    const box = $("relayList");
    box.innerHTML = "";
    SOURCES.forEach((k) => {
      const row = document.createElement("div");
      row.className = "relay";
      row.style.setProperty("--c", COLOR[k]);
      row.innerHTML = `<label for="sw-${k}"><span class="dot"></span>${NAME[k]} <span class="why" id="why-${k}"></span></label>
        <span class="switch"><input type="checkbox" role="switch" id="sw-${k}" data-key="${k}" /><i></i></span>`;
      box.appendChild(row);
    });
    const onSwitch = (e) => {
      const k = e.target.dataset.key;
      if (!k) return;
      const base = state.control.mode === "auto" && state.live ? state.live.relays : state.control.relays;
      const relays = { ...allOff(), ...base, [k]: e.target.checked };
      send({ mode: "manual", relays }, `${NAME[k]} turned ${e.target.checked ? "on" : "off"}.` + (state.control.mode === "auto" ? " Switched to manual mode." : ""));
    };
    ol.addEventListener("change", onSwitch);
    box.addEventListener("change", onSwitch);
  }

  function renderControl() {
    const ctl = state.control, l = state.live, s = l?.safety || {};
    $("modeManual").setAttribute("aria-checked", ctl.mode === "manual");
    $("modeAuto").setAttribute("aria-checked", ctl.mode === "auto");
    $("modeHint").textContent = ctl.mode === "auto"
      ? "The ESP32 decides every minute: Solar and Wind stay on, Grid backs up a low battery, and the AI picks how many outputs to keep on. Flip any switch to take over in manual mode."
      : "You choose what's on. Safety limits still apply. Switch to Auto to let the system decide.";
    const shown = ctl.mode === "auto" && l ? l.relays : ctl.relays;
    for (const k of ALL) {
      const sw = $(`sw-${k}`);
      if (sw) sw.checked = !!(shown && shown[k]);
    }
    OUTPUTS.forEach((k) => {
      const li = $(`pri-${k}`);
      const [, why] = outputReason(k, l);
      $(`why-${k}`).textContent = why;
      li.classList.toggle("on", !!l?.relays?.[k]);
      li.classList.toggle("held", !!(s.batCritical || s.overTemp));
    });
    const lim = L();
    $("why-solar").textContent = s.overTemp ? "held off: too hot" : "";
    $("why-wind").textContent = s.overTemp ? "held off: too hot" : "";
    $("why-grid").textContent = s.overTemp ? "held off: too hot" : ctl.mode === "auto" ? `auto: on below ${lim.gridOn} V` : "";
    $("why-charge").textContent = s.overTemp ? "held off: too hot" : s.batFull ? `held off: battery full (${lim.chargeOff} V)` : s.sensorFault ? "held off: no battery sensor" : "";
    SOURCES.forEach((k) => { const w = $(`why-${k}`); w.classList.toggle("held", w.textContent.startsWith("held")); });
    $("safetyNote").textContent = `Safety limits on the ESP32 always win: below ${lim.critical} V all outputs turn off, at ${lim.chargeOff} V charging stops, above ${lim.tempMax} °C everything turns off.`;
  }

  // ---------- AI ----------
  function renderAI(l) {
    const ai = l.ai || {}, lim = L(), lvl = +ai.level || 0;
    $("aiChoice").textContent = lvl === 0 ? "no outputs" : lvl === 1 ? "1 output" : `${lvl} outputs`;
    const conf = Math.round((+ai.confidence || 0) * 100);
    $("confBar").style.width = conf + "%";
    $("confText").textContent = conf + "%";
    $("aiSource").textContent = ai.source === "model"
      ? "Decided by the Random Forest running on the ESP32."
      : ai.source === "rule" ? "Decided by the built-in rules. The AI waits for the first weather forecast." : "No decision yet.";
    $("aiModel").textContent = ai.model ? `Model: ${ai.model}.` + (l.mode !== "auto" ? " Auto mode is off, so this choice is not applied." : "") : "";

    const v = +l.battery?.v || 0, sw = +l.solar?.w || 0, renew = sw + (+l.wind?.w || 0);
    const rad = +ai.fc_rad || 0, wnd = +ai.fc_wind || 0;
    const items = [
      { c: "var(--battery)", b: `${fmt(v, 2)} V`, t: v >= lim.out3 ? `Battery is full enough for Output 3 (${lim.out3} V)` : v >= lim.out2 ? `Battery is enough for Output 2 (${lim.out2} V)` : v >= lim.out1 ? `Battery is enough for Output 1 only (${lim.out1} V)` : `Battery is too low for any output (${lim.out1} V)` },
      { c: "var(--sun)", b: `${fmt(renew)} W`, t: renew >= lim.out2w ? `Sun and wind give at least ${lim.out2w} W, enough for Output 2` : `Sun and wind give less than ${lim.out2w} W` },
      { c: "var(--sun)", b: `${fmt(sw)} W`, t: sw >= lim.sunGood ? `Solar is strong (${lim.sunGood} W or more)` : `Solar is below ${lim.sunGood} W, so Output 3 waits` },
      { c: "var(--sun)", b: `${fmt(rad, 0)} W/m²`, t: rad > 400 ? "Good sun expected next hour" : rad > 50 ? "Some sun expected next hour" : "Little or no sun next hour" },
      { c: "var(--wind)", b: `${fmt(wnd)} km/h`, t: wnd > 20 ? "Strong wind expected next hour" : "Light wind expected next hour" },
    ];
    const ul = $("aiReasons");
    ul.innerHTML = "";
    for (const it of items) {
      const li = document.createElement("li");
      li.style.setProperty("--c", it.c);
      const sp = document.createElement("span"); sp.textContent = it.t;
      const b = document.createElement("b"); b.textContent = it.b;
      li.append(sp, b);
      ul.appendChild(li);
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
  function chartSets(rows, kind, hist) {
    const g = (r, a, b) => (hist ? r[b] : r[a]);
    if (kind === "power") return [
      { label: "Solar (W)", color: css("--sun"), data: rows.map((r) => g(r, "solar", "solar_w")) },
      { label: "Wind (W)", color: css("--wind"), data: rows.map((r) => g(r, "wind", "wind_w")) },
      { label: "Battery (W, + = discharging)", color: css("--battery"), data: rows.map((r) => (hist ? r.bat_v * r.bat_i : r.battery)) },
    ];
    if (kind === "battery") return [{ label: "Battery voltage (V)", color: css("--battery"), data: rows.map((r) => g(r, "batV", "bat_v")) }];
    return [
      { label: "Panel (°C)", color: css("--sun"), data: rows.map((r) => g(r, "panel", "panel_temp")) },
      { label: "System (°C)", color: css("--danger"), data: rows.map((r) => g(r, "sys", "sys_temp")) },
    ];
  }
  function updateChart() {
    if (!window.Chart) return;
    const hist = state.range === "day";
    const rows = hist ? state.history || [] : state.liveBuf;
    const opt = hist ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
    const labels = rows.map((r) => new Date(hist ? r.ts : r.t).toLocaleTimeString([], opt));
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
          scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { grid: { color: css("--rule") }, beginAtZero: false } },
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
      state.weather = { hours, radNow: w.current.shortwave_radiation, next: hours[0] ? { cloud: hours[0].cloud, wind: hours[0].wind, rad: hours[0].rad } : null };
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
      await backend.writeControl(ctl);
      state.control = { mode: ctl.mode, relays: { ...ctl.relays } };
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
      const relays = state.live ? { ...allOff(), ...state.live.relays } : { ...state.control.relays };
      send({ mode: "manual", relays }, "Manual mode on. Everything stays as it is until you change it.");
    });
    $("modeAuto").addEventListener("click", () => {
      if (state.control.mode === "auto") return;
      send({ mode: "auto", relays: { ...state.control.relays } }, "Auto mode on. The ESP32 decides now.");
    });
    $("allOffBtn").addEventListener("click", () => send({ mode: "manual", relays: allOff() }, "Everything turned off. Switched to manual mode."));
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
    buildLists();
    wireUi();
    renderControl();
    loadWeather();
    setInterval(loadWeather, 15 * 60 * 1000);
    setInterval(() => state.live && render(), 5000);
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
