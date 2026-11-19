/**
 * kalmanFilter.js
 * Server-side GPS path smoothing.
 *
 * Input points must have: { lat, lng, accuracy, timestamp (Date|string), speed?, batteryLevel?, visitId? }
 * Returns smoothed points with all original metadata preserved.
 */

const Q = 0.0001;  // Process noise — higher = more responsive to actual movement
const R = 0.005;   // Base measurement noise (GPS error floor, tightened)

/**
 * Smooth a raw GPS path using a 1-D Kalman filter applied independently
 * to latitude and longitude.
 *
 * @param {Array} rawPoints
 * @returns {Array} smoothed points (same length, same structure)
 */
exports.smoothPath = (rawPoints) => {
  if (!Array.isArray(rawPoints) || rawPoints.length < 2) return rawPoints;

  let variance = R;
  const smoothed = [{ ...rawPoints[0] }]; // first point passes through unchanged

  for (let i = 1; i < rawPoints.length; i++) {
    const prev = smoothed[i - 1];
    const curr = rawPoints[i];

    // Resolve timestamp to milliseconds regardless of whether it's a Date, ISO string, or numeric ms
    const prevMs = new Date(prev.timestamp).getTime();
    const currMs = new Date(curr.timestamp).getTime();
    const dt = (currMs - prevMs) / 1000; // seconds

    // Skip duplicate or out-of-order timestamps — pass through unchanged
    if (dt <= 0) {
      smoothed.push({ ...curr });
      continue;
    }

    // --- Kalman predict ---
    const predictedVariance = variance + Q * dt;

    // Scale measurement noise by reported GPS accuracy (accuracy in metres; 10m = baseline)
    const measurementNoise = R * ((curr.accuracy || 10) / 10);

    // --- Kalman update ---
    const gain = predictedVariance / (predictedVariance + measurementNoise);

    smoothed.push({
      ...curr,                                            // preserve ALL metadata (speed, battery, visitId…)
      lat: prev.lat + gain * (curr.lat - prev.lat),      // blended latitude
      lng: prev.lng + gain * (curr.lng - prev.lng),      // blended longitude
    });

    variance = (1 - gain) * predictedVariance;
  }

  return smoothed;
};
