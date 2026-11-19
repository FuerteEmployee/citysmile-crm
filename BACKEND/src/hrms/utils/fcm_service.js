const admin = require("firebase-admin");

let fcmReady = false;

// Resolve a Firebase credential from (in priority order):
//   1. FIREBASE_SERVICE_ACCOUNT      — the service-account JSON inline (best for Vercel/serverless)
//   2. FIREBASE_SERVICE_ACCOUNT_PATH — path to a service-account .json file
//   3. GOOGLE_APPLICATION_CREDENTIALS — Google's default (file path) via applicationDefault()
const loadCredential = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      return admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    } catch (e) {
      console.warn("[FCM Service] FIREBASE_SERVICE_ACCOUNT is not valid JSON:", e.message);
    }
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    try {
      const path = require("path").resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      return admin.credential.cert(require(path));
    } catch (e) {
      console.warn("[FCM Service] Could not load FIREBASE_SERVICE_ACCOUNT_PATH:", e.message);
    }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return admin.credential.applicationDefault();
  }
  return null;
};

try {
  if (!admin.apps.length) {
    const credential = loadCredential();
    if (credential) {
      admin.initializeApp({ credential });
      fcmReady = true;
      console.log("[FCM Service] Firebase Admin initialized — push notifications ENABLED.");
    } else {
      console.warn(
        "[FCM Service] No Firebase credentials found — push notifications DISABLED. " +
          "Set FIREBASE_SERVICE_ACCOUNT (inline JSON), FIREBASE_SERVICE_ACCOUNT_PATH, or GOOGLE_APPLICATION_CREDENTIALS. " +
          "(In-app + socket notifications still work.)"
      );
    }
  } else {
    fcmReady = true;
  }
} catch (err) {
  console.warn("[FCM Service] Initialization failed — push disabled:", err.message);
}

// Lets other code check whether push can actually be delivered.
exports.isConfigured = () => fcmReady;

exports.sendDataMessage = async ({ token, data }) => {
  if (!fcmReady) return false; // push not configured — skip quietly
  if (!token) {
    console.warn("[FCM Service] Cannot send push: No FCM token provided.");
    return false;
  }

  try {
    const message = {
      token,
      android: {
        priority: "high", // Wakes Android out of Doze mode
      },
      notification: {
        title: "Location Sync Request",
        body: "Fetching live GPS coordinates for dashboard tracking...",
      },
      data: {
        action: "FORCE_LOCATION_PING",
        ...data,
      },
    };

    const response = await admin.messaging().send(message);
    console.log(`[FCM Service] Successfully sent high-priority ping to token ${token.substring(0, 15)}... Response:`, response);
    return true;
  } catch (err) {
    console.error("[FCM Service] Failed to send FCM data message:", err.message);
    return false;
  }
};

exports.sendPushNotification = async ({ token, title, body, data }) => {
  if (!fcmReady) return false; // push not configured — skip quietly
  if (!token) {
    console.warn("[FCM Service] Cannot send notification: No FCM token provided.");
    return false;
  }

  try {
    const message = {
      token,
      android: {
        priority: "high",
      },
      notification: {
        title,
        body,
      },
      data: data || {},
    };

    const response = await admin.messaging().send(message);
    console.log(`[FCM Service] Successfully sent notification to token ${token.substring(0, 15)}... Response:`, response);
    return true;
  } catch (err) {
    console.error("[FCM Service] Failed to send FCM push notification:", err.message);
    return false;
  }
};
