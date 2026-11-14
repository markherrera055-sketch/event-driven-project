/** Unit tests for pure helpers (no database). */
import { validate, v } from "../utils/validate.js";
import { toCents, sumMoney, multiplyMoney } from "../utils/money.js";
import { isIsoDate, nightsBetween, eachNight, addDays } from "../utils/dates.js";
import { nameMatches } from "../services/verificationService.js";
import { signPayload } from "../integrations/shared/outbox.js";

describe("validate()", () => {
  test("whitelists, trims and converts", () => {
    const out = validate({ name: "  Ana ", qty: "3", extra: "dropped", ok: "true" }, { name: v.string({ required: true }), qty: v.int({ min: 1 }), ok: v.bool() });
    expect(out).toEqual({ name: "Ana", qty: 3, ok: true });
  });
  test("reports all field errors at once", () => {
    expect(() => validate({ qty: "x" }, { name: v.string({ required: true }), qty: v.int() })).toThrow(
      expect.objectContaining({ status: 422, details: { name: expect.any(String), qty: expect.any(String) } })
    );
  });
  test("partial mode allows missing keys but not blanking required ones", () => {
    expect(validate({}, { name: v.string({ required: true }) }, { partial: true })).toEqual({});
    expect(() => validate({ name: "" }, { name: v.string({ required: true }) }, { partial: true })).toThrow();
  });
  test("money accepts at most 2 decimals", () => {
    expect(validate({ a: "10.50" }, { a: v.money() })).toEqual({ a: 10.5 });
    expect(() => validate({ a: "10.555" }, { a: v.money() })).toThrow();
  });
  test("dates must be real calendar dates", () => {
    expect(() => validate({ d: "2026-02-30" }, { d: v.date() })).toThrow();
    expect(validate({ d: "2028-02-29" }, { d: v.date() })).toEqual({ d: "2028-02-29" });
  });
});

describe("money", () => {
  test("no floating-point drift", () => {
    expect(sumMoney(0.1, 0.2)).toBe(0.3);
    expect(multiplyMoney(3500, 2)).toBe(7000);
    expect(toCents("6500.00")).toBe(650000);
  });
});

describe("dates", () => {
  test("night arithmetic", () => {
    expect(isIsoDate("2026-10-28")).toBe(true);
    expect(nightsBetween("2026-10-28", "2026-10-30")).toBe(2);
    expect(eachNight("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("identity name matching", () => {
  const guest = { firstName: "Juan", lastName: "Dela Cruz" };
  test.each([
    ["JUAN DELA CRUZ", true],
    ["Dela Cruz, Juan Miguel", true],
    ["Juán Dela Cruz", true],
    ["Juan Santos", false],
    ["", false],
  ])("%s → %s", (name, expected) => expect(nameMatches(name, guest)).toBe(expected));
});

describe("webhook signature", () => {
  test("is a stable HMAC-SHA256 over timestamp.body", () => {
    expect(signPayload("secret", "1700000000", '{"a":1}')).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(signPayload("secret", "1", "x")).not.toBe(signPayload("other", "1", "x"));
  });
});
