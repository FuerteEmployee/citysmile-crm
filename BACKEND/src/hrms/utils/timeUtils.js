/**
 * Time Utilities for handling Asia/Kolkata (IST) timezone
 */

const TIMEZONE = "Asia/Kolkata";

/**
 * Returns current date in YYYY-MM-DD format (IST)
 */
exports.getISTDate = () => {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
};

/**
 * Returns current time in HH:mm:ss format (IST)
 */
exports.getISTTime = () => {
  return new Date().toLocaleTimeString("en-US", { 
    timeZone: TIMEZONE, 
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
};

/**
 * Returns a Date object adjusted to IST
 * Note: Use this carefully as Date objects are always internally UTC
 */
exports.getISTDateObject = () => {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TIMEZONE }));
};
