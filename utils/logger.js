import { config } from "../config/index.js";

/**
 * Minimal structured logger (one JSON line per event). Important business
 * transactions (check-in, payment, checkout, integration calls) are logged
 * through here. Never pass passwords, API keys or full ID numbers.
 */
const write = (level, event, fields = {}) => {
  if (config.isTest && level !== "error") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};

export const logger = {
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
};
