// ============================================================
//  Smart Energy dashboard settings
//  Firebase console -> Project settings -> General -> "Your apps"
//  -> Web app -> copy the firebaseConfig values here.
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

  // Must match PROGRAM_RELAYS in config.h   {battery, ac, solar, wind}
  programs: {
    1: { name: "Renewable only", note: "Sun and wind feed the load", relays: { battery: false, ac: false, solar: true, wind: true } },
    2: { name: "Renewable + battery", note: "Battery helps sun and wind", relays: { battery: true, ac: false, solar: true, wind: true } },
    3: { name: "AC backup", note: "AC input feeds the load", relays: { battery: false, ac: true, solar: false, wind: false } },
  },

  // Must match the safety limits in config.h (used for colours and text only)
  limits: { batLow: 11.0, batHigh: 14.4, sysTempMax: 60 },
};
