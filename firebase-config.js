// ============================================================
//  Smart Energy dashboard settings  (v2)
//  While apiKey starts with "YOUR", the dashboard runs in DEMO mode
//  with simulated data, so you can try the UI first.
// ============================================================
window.SEMS_CONFIG = {
  firebase: {
    apiKey: "AIzaSyCE6Qk1b4nkDKmVXSnURJF8mZY3fUUaFcU",
    authDomain: "smart-energy-c74f3.firebaseapp.com",
    databaseURL: "https://smart-energy-c74f3-default-rtdb.firebaseio.com",
    projectId: "smart-energy-c74f3",
    appId: "1:916475121632:web:a30b222332875f52b1a585",
  },

  // Must match DEVICE_ID in the ESP32 config.h
  deviceId: "sems01",

  // Site location (weather + sky colour). Same as config.h
  site: { name: "Colombo", latitude: 6.9271, longitude: 79.8612 },

  // Names shown for the three priority outputs (change to what they power,
  // for example "Lights", "Fan", "Water pump")
  outputs: { out1: "Output 1", out2: "Output 2", out3: "Output 3" },

  // Used only until the ESP32 sends its own limits from config.h
  limits: {
    out1: 11.5, out2: 12.4, out2w: 10, out3: 13.5, sunGood: 12,
    gridOn: 11.8, gridOff: 12.8, chargeOn: 13.6, chargeOff: 14.4,
    critical: 11.0, tempMax: 60,
  },
};
