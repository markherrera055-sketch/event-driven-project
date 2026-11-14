import { config } from "../config/index.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True when value is a real calendar date in YYYY-MM-DD form. */
export const isIsoDate = (value) => {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

/** Calendar date (YYYY-MM-DD) of a moment, in the hotel's timezone. */
export const hotelDate = (moment = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: config.hotel.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(moment);

export const today = () => hotelDate(new Date());

export const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
};

/** Whole nights between two calendar dates (checkOut - checkIn). */
export const nightsBetween = (fromIso, toIso) =>
  Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / DAY_MS);

/** Each night (by its date) in the half-open range [from, to). */
export const eachNight = (fromIso, toIso) => {
  const nights = [];
  for (let d = fromIso; d < toIso; d = addDays(d, 1)) nights.push(d);
  return nights;
};
