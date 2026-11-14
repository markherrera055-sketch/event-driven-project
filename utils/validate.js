/**
 * Small dependency-free request validator.
 *
 *   const data = validate(req.body, {
 *     firstName: v.string({ required: true, max: 100 }),
 *     numGuests: v.int({ required: true, min: 1 }),
 *   });
 *
 * Unknown keys are dropped (whitelisting), values are normalised (trimmed,
 * converted to numbers/booleans) and all field errors are reported together
 * as a 422 VALIDATION_ERROR.
 */
import { validationError } from "./errors.js";
import { isIsoDate } from "./dates.js";
import { passwordError } from "./password.js";

const EMPTY = Symbol("empty");
const isEmpty = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const rule = (required, check) => (value, { partial }) => {
  if (isEmpty(value)) {
    // On PATCH a missing key is fine, but explicitly blanking a required field is not.
    if (required && (!partial || value !== undefined)) return { error: "This field is required." };
    return { value: value === null ? null : EMPTY };
  }
  return check(value);
};

export const v = {
  string: ({ required = false, min = 0, max = 255, pattern, patternMessage, lowercase = false } = {}) =>
    rule(required, (value) => {
      if (typeof value !== "string" && typeof value !== "number") return { error: "Must be text." };
      let s = String(value).trim();
      if (lowercase) s = s.toLowerCase();
      if (s.length < min) return { error: `Must be at least ${min} characters.` };
      if (s.length > max) return { error: `Must be at most ${max} characters.` };
      if (pattern && !pattern.test(s)) return { error: patternMessage || "Invalid format." };
      return { value: s };
    }),

  email: ({ required = false } = {}) =>
    rule(required, (value) => {
      const s = String(value).trim().toLowerCase();
      if (s.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { error: "Must be a valid email address." };
      return { value: s };
    }),

  phone: ({ required = false } = {}) =>
    rule(required, (value) => {
      const s = String(value).trim();
      if (!/^[+]?[0-9 ()-]{7,20}$/.test(s)) return { error: "Must be a valid phone number." };
      return { value: s };
    }),

  int: ({ required = false, min = -Infinity, max = Infinity } = {}) =>
    rule(required, (value) => {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isInteger(n)) return { error: "Must be a whole number." };
      if (n < min) return { error: `Must be at least ${min}.` };
      if (n > max) return { error: `Must be at most ${max}.` };
      return { value: n };
    }),

  /** Monetary amount with at most 2 decimal places. */
  money: ({ required = false, min = -Infinity, max = 99999999.99, nonZero = false } = {}) =>
    rule(required, (value) => {
      const s = String(value).trim();
      if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return { error: "Must be an amount with up to 2 decimals." };
      const n = Number(s);
      if (n < min) return { error: `Must be at least ${min}.` };
      if (n > max) return { error: `Must be at most ${max}.` };
      if (nonZero && n === 0) return { error: "Must not be zero." };
      return { value: n };
    }),

  /** New password checked against the staff password policy (utils/password.js). Never trimmed. */
  password: ({ required = false } = {}) =>
    rule(required, (value) => {
      if (typeof value !== "string") return { error: "Must be text." };
      const error = passwordError(value);
      return error ? { error } : { value };
    }),

  /** List of short labels, given as an array or a comma-separated string; trimmed and de-duplicated. */
  stringList: ({ required = false, maxItems = 30, itemMax = 40 } = {}) =>
    rule(required, (value) => {
      const parts = Array.isArray(value) ? value : String(value).split(",");
      if (parts.some((p) => typeof p !== "string" && typeof p !== "number")) return { error: "Must be a list of text values." };
      const seen = new Set();
      const items = [];
      for (const part of parts) {
        const item = String(part).trim().replace(/\s+/g, " ");
        if (!item || seen.has(item.toLowerCase())) continue;
        if (item.length > itemMax) return { error: `Each item must be at most ${itemMax} characters.` };
        seen.add(item.toLowerCase());
        items.push(item);
      }
      if (items.length > maxItems) return { error: `At most ${maxItems} items.` };
      return { value: items };
    }),

  date: ({ required = false } = {}) =>
    rule(required, (value) => (isIsoDate(String(value).trim()) ? { value: String(value).trim() } : { error: "Must be a valid date (YYYY-MM-DD)." })),

  datetime: ({ required = false } = {}) =>
    rule(required, (value) => {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? { error: "Must be a valid ISO-8601 date-time." } : { value: d };
    }),

  enum: (values, { required = false } = {}) =>
    rule(required, (value) => {
      const s = String(value).trim().toUpperCase();
      return values.includes(s) ? { value: s } : { error: `Must be one of: ${values.join(", ")}.` };
    }),

  bool: ({ required = false } = {}) =>
    rule(required, (value) => {
      if (typeof value === "boolean") return { value };
      const s = String(value).toLowerCase();
      if (["true", "1", "on", "yes"].includes(s)) return { value: true };
      if (["false", "0", "off", "no"].includes(s)) return { value: false };
      return { error: "Must be true or false." };
    }),

  /** Nested object validated with its own schema. */
  object: (schema, { required = false } = {}) =>
    rule(required, (value) => {
      if (typeof value !== "object" || Array.isArray(value)) return { error: "Must be an object." };
      try {
        return { value: validate(value, schema) };
      } catch (err) {
        return { error: err.details || err.message };
      }
    }),

  /** Array whose items are validated with a schema (objects) — max length bounded. */
  array: (schema, { required = false, max = 100 } = {}) =>
    rule(required, (value) => {
      if (!Array.isArray(value)) return { error: "Must be an array." };
      if (value.length > max) return { error: `Must contain at most ${max} items.` };
      const out = [];
      const errors = {};
      value.forEach((item, i) => {
        try {
          out.push(validate(item ?? {}, schema));
        } catch (err) {
          errors[i] = err.details || err.message;
        }
      });
      return Object.keys(errors).length ? { error: errors } : { value: out };
    }),
};

/**
 * Validates `input` against `schema`. With { partial: true } (PATCH) required
 * rules are relaxed and only provided keys are returned.
 */
export function validate(input, schema, { partial = false } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const data = {};
  const errors = {};
  for (const [key, check] of Object.entries(schema)) {
    const result = check(source[key], { partial });
    if (result.error) errors[key] = result.error;
    else if (result.value !== EMPTY) data[key] = result.value;
    else if (source[key] === "" && partial) data[key] = null; // explicit clear on PATCH
  }
  if (Object.keys(errors).length) throw validationError(errors);
  return data;
}
