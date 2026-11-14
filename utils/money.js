/**
 * Money is stored as DECIMAL(10,2). All arithmetic is done in integer cents
 * to avoid floating point drift, then converted back for storage / output.
 */
export const toCents = (value) => Math.round(Number(value || 0) * 100);
export const fromCents = (cents) => Math.round(cents) / 100;
export const sumMoney = (...values) => fromCents(values.reduce((acc, v) => acc + toCents(v), 0));
export const multiplyMoney = (value, qty) => fromCents(toCents(value) * qty);
export const sameAmount = (a, b) => toCents(a) === toCents(b);
