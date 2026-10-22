// ============================================================
//  Smart Energy dashboard settings
//  Firebase console -> Project settings -> General -> "Your apps"
//  -> Web app -> copy the firebaseConfig values here.
//  While apiKey starts with "YOUR", the dashboard runs in DEMO mode
//  with simulated data, so you can try the UI first.
// ============================================================
window.SEMS_CONFIG = {
  firebase: {
    apiKey: "YOUR_FIREBASE_WEB_API_KEY",
    authDomain: "YOUR-PROJECT.firebaseapp.com",
    databaseURL: "https://YOUR-PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "YOUR-PROJECT",
    appId: "YOUR_APP_ID",
  },

  // Must match DEVICE_ID in the ESP32 config.h
  deviceId: "sems01",

  // Site location (weather + sky colour). Same as config.h
  site: { name: "Colombo", latitude: 6.9271, longitude: 79.8612 },

  // Must match PROGRAM_RELAYS in config.h   {battery, dc, solar, wind}
  programs: {
    1: { name: "Renewable only", note: "Sun and wind feed the load", relays: { battery: false, dc: false, solar: true, wind: true } },
    2: { name: "Renewable + battery", note: "Battery helps sun and wind", relays: { battery: true, dc: false, solar: true, wind: true } },
    3: { name: "DC backup", note: "DC input feeds the load", relays: { battery: false, dc: true, solar: false, wind: false } },
  },

  // Must match the safety limits in config.h (used for colours and text only)
  limits: { batLow: 11.0, batHigh: 14.4, sysTempMax: 60 },
};
