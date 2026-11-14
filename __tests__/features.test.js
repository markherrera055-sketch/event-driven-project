/**
 * Password management, editable assigned rooms (incl. in-house room moves)
 * and room administration. Real HTTP against the real app and MySQL.
 */
import bcrypt from "bcrypt";
import { resetDatabase, startApp, StaffClient, PASSWORDS } from "./helpers/harness.js";
import { User, Room, Reservation, Stay, RESERVATION_STATUS } from "../models/index.js";
import { passwordProblems } from "../utils/password.js";
import { today, addDays } from "../utils/dates.js";

let app;
let desk;
let admin;
const D0 = today();
const D = (n) => addDays(D0, n);
const NEW_DESK_PASSWORD = "Harbor#Light2031";

let seq = 0;
const book = (client, { roomType, roomId, from, to, numGuests = 1 }) => {
  seq += 1;
  return client.post("/reservations", {
    guest: { firstName: "Test", lastName: `Guest${seq}`, email: `guest${seq}.${Date.now()}@example.com` },
    roomType,
    roomId,
    checkInDate: from,
    checkOutDate: to,
    numGuests,
  });
};

async function checkInGuest(r) {
  const v = await desk.post("/verifications", {
    reservationId: r.id,
    idType: "PASSPORT",
    idNumberLast4: "1234",
    nameOnId: `${r.guest.firstName} ${r.guest.lastName}`,
    expiryDate: D(3650),
    photoMatches: true,
  });
  expect(v.data.result).toBe("VERIFIED");
  const stay = await desk.post("/check-ins", { reservationId: r.id });
  expect(stay.status).toBe(201);
  return stay.data;
}

const roomByNumber = async (n) => Room.findOne({ where: { roomNumber: n } });

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
  admin = await new StaffClient(app.base).login("admin", PASSWORDS.admin);
  for (const roomNumber of ["103", "105"]) {
    expect((await admin.post("/admin/rooms", { roomNumber, roomType: "Standard", capacity: 2, nightlyRate: "2500.00" })).status).toBe(201);
  }
});
afterAll(() => app?.close());

// ─────────────────────────────────────────────────────────────────────────────
describe("Password management: users change their own password", () => {
  const change = (client, body) => client.put("/me/password", body);

  test("an incorrect current password is rejected", async () => {
    const res = await change(desk, { currentPassword: "Wrong#Pass2026", newPassword: NEW_DESK_PASSWORD, confirmPassword: NEW_DESK_PASSWORD });
    expect(res.status).toBe(422);
    expect(res.error.details.currentPassword).toMatch(/incorrect/i);
  });

  test("a confirmation mismatch is rejected", async () => {
    const res = await change(desk, { currentPassword: PASSWORDS.frontdesk, newPassword: NEW_DESK_PASSWORD, confirmPassword: `${NEW_DESK_PASSWORD}x` });
    expect(res.status).toBe(422);
    expect(res.error.details.confirmPassword).toMatch(/do not match/i);
  });

  test.each([
    ["too short", "Ab#12345"],
    ["no uppercase", "harbor#light2031"],
    ["no symbol", "HarborLight2031"],
    ["contains the username", "Frontdesk#2031x"],
    ["common password", "Password1234!"],
  ])("a weak new password is rejected (%s)", async (_label, weak) => {
    const res = await change(desk, { currentPassword: PASSWORDS.frontdesk, newPassword: weak, confirmPassword: weak });
    expect(res.status).toBe(422);
    expect(res.error.details.newPassword).toBeDefined();
  });

  test("the user changes their password; it is hashed and other sessions are signed out", async () => {
    const otherSession = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
    const adminRow = await User.findOne({ where: { username: "admin" } });

    // A user id in the body is ignored: the endpoint only ever changes the caller's own password.
    const res = await change(desk, {
      currentPassword: PASSWORDS.frontdesk,
      newPassword: NEW_DESK_PASSWORD,
      confirmPassword: NEW_DESK_PASSWORD,
      userId: adminRow.id,
      id: adminRow.id,
    });
    expect(res.status).toBe(200);
    expect(res.data.otherSessionsSignedOut).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    expect((await desk.get("/dashboard")).status).toBe(200); // this session stays signed in
    expect((await otherSession.get("/dashboard")).status).toBe(401); // other sessions are signed out

    const row = await User.scope("withPassword").findOne({ where: { username: "frontdesk" } });
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(row.passwordHash).not.toContain(NEW_DESK_PASSWORD);
    expect(await bcrypt.compare(NEW_DESK_PASSWORD, row.passwordHash)).toBe(true);
    expect(row.passwordChangedAt).not.toBeNull();

    const adminAfter = await User.scope("withPassword").findByPk(adminRow.id);
    expect(await bcrypt.compare(PASSWORDS.admin, adminAfter.passwordHash)).toBe(true);

    await expect(new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk)).rejects.toThrow();
    await new StaffClient(app.base).login("frontdesk", NEW_DESK_PASSWORD);
  });

  test("reusing the current password is rejected", async () => {
    const res = await change(desk, { currentPassword: NEW_DESK_PASSWORD, newPassword: NEW_DESK_PASSWORD, confirmPassword: NEW_DESK_PASSWORD });
    expect(res.status).toBe(422);
    expect(res.error.details.newPassword).toMatch(/different/i);
  });

  test("signed-out users cannot change a password", async () => {
    const anon = new StaffClient(app.base);
    await anon.refreshCsrf("/login");
    const res = await anon.put("/me/password", { currentPassword: "x", newPassword: NEW_DESK_PASSWORD, confirmPassword: NEW_DESK_PASSWORD });
    expect(res.status).toBe(401);
  });

  test("the account page is served", async () => {
    const res = await desk.raw("GET", "/account");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-page="account"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Password management: administrator resets", () => {
  let clerkId;
  const TEMP = "Temp#Clerk2031";

  test("receptionists cannot reset or set other users' passwords", async () => {
    const adminRow = await User.findOne({ where: { username: "admin" } });
    expect((await desk.post(`/admin/staff/${adminRow.id}/reset-password`, {})).status).toBe(403);
    expect((await desk.patch(`/admin/staff/${adminRow.id}`, { password: "Taken#Over2031" })).status).toBe(403);
  });

  test("a new account must replace its temporary password before doing anything else", async () => {
    const res = await admin.post("/admin/staff", { fullName: "Clerk One", username: "clerkone", password: TEMP, role: "RECEPTIONIST" });
    expect(res.status).toBe(201);
    expect(res.data.mustChangePassword).toBe(true);
    clerkId = res.data.id;

    const clerk = new StaffClient(app.base);
    await clerk.refreshCsrf("/login");
    const login = await clerk.raw("POST", "/login", { form: { _csrf: clerk.csrf, username: "clerkone", password: TEMP } });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/account");
    await clerk.refreshCsrf("/account");

    const blocked = await clerk.get("/dashboard");
    expect(blocked.status).toBe(403);
    expect(blocked.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await clerk.raw("GET", "/front-desk/reservations")).headers.get("location")).toBe("/account");
    expect((await clerk.get("/me")).data.user.mustChangePassword).toBe(true);

    const changed = await clerk.put("/me/password", { currentPassword: TEMP, newPassword: "Clerk#Owned2031", confirmPassword: "Clerk#Owned2031" });
    expect(changed.status).toBe(200);
    expect(changed.data.user.mustChangePassword).toBe(false);
    expect((await clerk.get("/dashboard")).status).toBe(200);
  });

  test("an administrator resets a password: generated once, sessions ended, change forced", async () => {
    const clerk = await new StaffClient(app.base).login("clerkone", "Clerk#Owned2031");
    const before = await User.findByPk(clerkId);

    const res = await admin.post(`/admin/staff/${clerkId}/reset-password`, {});
    expect(res.status).toBe(200);
    expect(res.data.generated).toBe(true);
    const temp = res.data.temporaryPassword;
    expect(passwordProblems(temp, { username: "clerkone" })).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    expect((await clerk.get("/dashboard")).status).toBe(401); // signed out everywhere

    const row = await User.scope("withPassword").findByPk(clerkId);
    expect(row.mustChangePassword).toBe(true);
    expect(row.sessionVersion).toBe(before.sessionVersion + 1);
    expect(row.passwordHash).not.toContain(temp);
    expect(await bcrypt.compare(temp, row.passwordHash)).toBe(true);
    expect(await bcrypt.compare("Clerk#Owned2031", row.passwordHash)).toBe(false);

    const again = new StaffClient(app.base);
    await again.refreshCsrf("/login");
    const login = await again.raw("POST", "/login", { form: { _csrf: again.csrf, username: "clerkone", password: temp } });
    expect(login.headers.get("location")).toBe("/account");
  });

  test("a chosen temporary password must meet the policy and is not echoed back", async () => {
    const weak = await admin.post(`/admin/staff/${clerkId}/reset-password`, { temporaryPassword: "short" });
    expect(weak.status).toBe(422);
    expect(weak.error.details.temporaryPassword).toBeDefined();
    const ok = await admin.post(`/admin/staff/${clerkId}/reset-password`, { temporaryPassword: "Chosen#Temp2031" });
    expect(ok.status).toBe(200);
    expect(ok.data.temporaryPassword).toBeUndefined();
  });

  test("administrators change their own password only through Account settings", async () => {
    const me = (await admin.get("/me")).data.user;
    expect((await admin.post(`/admin/staff/${me.id}/reset-password`, {})).status).toBe(409);
    expect((await admin.patch(`/admin/staff/${me.id}`, { password: "Admin#Other2031" })).status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Editable assigned room", () => {
  let rTomorrow;
  let rToday;
  let rOther;

  test("eligibility follows reservation dates: a room vacant today but booked tomorrow is excluded", async () => {
    rTomorrow = (await book(desk, { roomId: (await roomByNumber("102")).id, from: D(1), to: D(3) })).data;
    rToday = (await book(desk, { roomType: "Standard", from: D0, to: D(2) })).data;
    expect(rToday.room).toBeNull();

    const room102 = await roomByNumber("102");
    expect(room102.status).toBe("VACANT"); // today's status alone would wrongly say "available"

    const eligible = (await desk.get(`/reservations/${rToday.id}/assignable-rooms`)).data.map((r) => r.roomNumber);
    expect(eligible).toEqual(expect.arrayContaining(["101", "103", "105"]));
    expect(eligible).not.toContain("102");

    const clash = await desk.put(`/reservations/${rToday.id}/room`, { roomId: room102.id });
    expect(clash.status).toBe(409);
    expect(clash.error.code).toBe("ROOM_UNAVAILABLE");
  });

  test("changing the room releases the previous one and preserves guest and booking details", async () => {
    const r101 = await roomByNumber("101");
    const r103 = await roomByNumber("103");
    expect((await desk.put(`/reservations/${rToday.id}/room`, { roomId: r101.id })).data.room.roomNumber).toBe("101");

    rOther = (await book(desk, { roomType: "Standard", from: D0, to: D(1) })).data;
    let eligible = (await desk.get(`/reservations/${rOther.id}/assignable-rooms`)).data.map((r) => r.roomNumber);
    expect(eligible).not.toContain("101");

    const before = await Reservation.findByPk(rToday.id);
    const moved = await desk.put(`/reservations/${rToday.id}/room`, { roomId: r103.id });
    expect(moved.status).toBe(200);
    expect(moved.data.room.roomNumber).toBe("103");

    const after = await Reservation.findByPk(rToday.id);
    expect(after.roomId).toBe(r103.id);
    for (const key of ["guestId", "checkInDate", "checkOutDate", "numGuests", "status", "reservationCode", "source"]) {
      expect(after[key]).toEqual(before[key]);
    }

    eligible = (await desk.get(`/reservations/${rOther.id}/assignable-rooms`)).data.map((r) => r.roomNumber);
    expect(eligible).toContain("101"); // released
  });

  test("re-assigning the same room is rejected", async () => {
    const res = await desk.put(`/reservations/${rToday.id}/room`, { roomId: (await roomByNumber("103")).id });
    expect(res.status).toBe(422);
  });

  test("a room under maintenance cannot be assigned", async () => {
    const r105 = await roomByNumber("105");
    expect((await admin.patch(`/admin/rooms/${r105.id}`, { status: "MAINTENANCE" })).data.status).toBe("MAINTENANCE");
    const eligible = (await desk.get(`/reservations/${rOther.id}/assignable-rooms`)).data.map((r) => r.roomNumber);
    expect(eligible).not.toContain("105");
    const res = await desk.put(`/reservations/${rOther.id}/room`, { roomId: r105.id });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("ROOM_UNDER_MAINTENANCE");
    expect((await admin.patch(`/admin/rooms/${r105.id}`, { status: "VACANT" })).data.status).toBe("VACANT");
  });

  test("two clerks assigning the same room at once: exactly one succeeds", async () => {
    const a = (await book(desk, { roomType: "Standard", from: D(10), to: D(12) })).data;
    const b = (await book(desk, { roomType: "Standard", from: D(11), to: D(13) })).data;
    const roomId = (await roomByNumber("101")).id;
    const results = await Promise.all([a, b].map((r) => desk.put(`/reservations/${r.id}/room`, { roomId })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await Reservation.count({ where: { roomId, checkInDate: [D(10), D(11)] } })).toBe(1);
  });

  test("only receptionists change assignments", async () => {
    const res = await admin.put(`/reservations/${rOther.id}/room`, { roomId: (await roomByNumber("101")).id });
    expect(res.status).toBe(403);
  });

  test("an occupied room cannot be given to a same-day arrival, even when the in-house guest is past check-out", async () => {
    expect((await admin.post("/admin/rooms", { roomNumber: "302", roomType: "Family", capacity: 4, nightlyRate: "5200.00" })).status).toBe(201);
    const r301 = await roomByNumber("301");
    const inHouse = (await book(desk, { roomId: r301.id, from: D0, to: D(1) })).data;
    await checkInGuest(inHouse);
    // The guest overstays: their booked dates end today, but they are still in the room.
    await Reservation.update({ checkInDate: D(-2), checkOutDate: D0 }, { where: { id: inHouse.id } });

    const arrival = (await book(desk, { roomType: "Family", from: D0, to: D(1) })).data;
    const eligible = (await desk.get(`/reservations/${arrival.id}/assignable-rooms`)).data.map((r) => r.roomNumber);
    expect(eligible).toEqual(["302"]);
    const res = await desk.put(`/reservations/${arrival.id}/room`, { roomId: r301.id });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("ROOM_OCCUPIED");
    expect((await roomByNumber("301")).status).toBe("OCCUPIED"); // untouched

    // Type level: the overstaying guest + this arrival fill both Family rooms tonight.
    const extra = await book(desk, { roomType: "Family", from: D0, to: D(1) });
    expect(extra.status).toBe(409);
    expect(extra.error.code).toBe("NO_AVAILABILITY");
  });

  test("in-house room move: new room occupied, previous room vacant + needs cleaning, stay kept", async () => {
    for (const roomNumber of ["205", "206"]) {
      expect((await admin.post("/admin/rooms", { roomNumber, roomType: "Deluxe", capacity: 2, nightlyRate: "3600.00" })).status).toBe(201);
    }
    await Room.update({ needsCleaning: true }, { where: { roomNumber: "206" } });

    const r204 = await roomByNumber("204");
    const res = (await book(desk, { roomId: r204.id, from: D0, to: D(2) })).data;
    const stay = await checkInGuest(res);

    const eligible = (await desk.get(`/reservations/${res.id}/assignable-rooms`)).data.map((r) => r.roomNumber);
    expect(eligible).toContain("205");
    expect(eligible).not.toContain("206"); // not clean
    expect(eligible).not.toContain("204"); // current room

    const dirty = await desk.put(`/reservations/${res.id}/room`, { roomId: (await roomByNumber("206")).id });
    expect(dirty.status).toBe(409);
    expect(dirty.error.code).toBe("ROOM_NOT_READY");

    const moved = await desk.put(`/reservations/${res.id}/room`, { roomId: (await roomByNumber("205")).id });
    expect(moved.status).toBe(200);
    expect(moved.data.room.roomNumber).toBe("205");
    expect(moved.data.status).toBe("CHECKED_IN");

    const [old, now] = [await roomByNumber("204"), await roomByNumber("205")];
    expect(old).toMatchObject({ status: "VACANT", needsCleaning: true });
    expect(now.status).toBe("OCCUPIED");
    const stayRow = await Stay.findByPk(stay.id);
    expect(stayRow.status).toBe("IN_HOUSE");
    expect((await desk.get(`/stays/${stay.id}`)).data.reservation.room.roomNumber).toBe("205");

    // Once the final bill exists the room can no longer change.
    expect((await desk.post("/bills", { stayId: stay.id })).status).toBe(201);
    await desk.post(`/rooms/${old.id}/clean`);
    const locked = await desk.put(`/reservations/${res.id}/room`, { roomId: old.id });
    expect(locked.status).toBe(409);
    expect(locked.error.code).toBe("BILL_ALREADY_GENERATED");
    expect((await roomByNumber("205")).status).toBe("OCCUPIED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Room management", () => {
  let suite;

  test("an administrator adds a room with floor, description and amenities", async () => {
    const res = await admin.post("/admin/rooms", {
      roomNumber: "501",
      roomType: "Suite",
      floor: "5",
      capacity: 3,
      nightlyRate: "7500.00",
      description: "Corner suite with sea view",
      amenities: "Wi-Fi, Smart TV, wi-fi ,  Mini bar",
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ roomNumber: "501", floor: "5", status: "VACANT", isActive: true, amenities: ["Wi-Fi", "Smart TV", "Mini bar"] });
    suite = res.data;
    expect((await admin.get(`/rooms/${suite.id}`)).data.description).toBe("Corner suite with sea view");
  });

  test("duplicate room numbers are rejected (case-insensitive)", async () => {
    expect((await admin.post("/admin/rooms", { roomNumber: "501", roomType: "Suite", capacity: 2, nightlyRate: 1 })).status).toBe(409);
    expect((await admin.post("/admin/rooms", { roomNumber: "B-12", roomType: "Suite", capacity: 2, nightlyRate: 1 })).status).toBe(201);
    const dup = await admin.post("/admin/rooms", { roomNumber: "b-12", roomType: "Suite", capacity: 2, nightlyRate: 1 });
    expect(dup.status).toBe(409);
    expect(dup.error.details.roomNumber).toBeDefined();
    const rename = await admin.patch(`/admin/rooms/${suite.id}`, { roomNumber: "B-12" });
    expect(rename.status).toBe(409);
  });

  test("an administrator edits a room; changes persist and fields can be cleared", async () => {
    const res = await admin.patch(`/admin/rooms/${suite.id}`, { floor: "6", nightlyRate: "7800.00", description: "", amenities: ["Bathtub", "Balcony"] });
    expect(res.status).toBe(200);
    const fresh = (await admin.get(`/rooms/${suite.id}`)).data;
    expect(fresh).toMatchObject({ floor: "6", nightlyRate: 7800, description: null, amenities: ["Bathtub", "Balcony"] });
  });

  test("invalid status transitions are refused", async () => {
    expect((await admin.patch(`/admin/rooms/${suite.id}`, { status: "OCCUPIED" })).status).toBe(422);
    const occupied = await roomByNumber("205"); // in-house guest from the room-move test
    const res = await admin.patch(`/admin/rooms/${occupied.id}`, { status: "MAINTENANCE" });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("ROOM_OCCUPIED");
    expect((await admin.patch(`/admin/rooms/${occupied.id}`, { isActive: false })).status).toBe(409);
    expect((await roomByNumber("205")).status).toBe("OCCUPIED");
  });

  test("a guest due tonight blocks maintenance on their room", async () => {
    const r103 = await roomByNumber("103"); // assigned to a reservation covering tonight
    const res = await admin.patch(`/admin/rooms/${r103.id}`, { status: "MAINTENANCE" });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("ROOM_IN_USE");
  });

  test("the derived Reserved status reflects reservations holding a room tonight", async () => {
    const rooms = (await desk.get("/rooms")).data;
    const r103 = rooms.find((r) => r.roomNumber === "103");
    expect(r103.status).toBe("VACANT");
    expect(r103.displayStatus).toBe("RESERVED");
    expect(r103.reservedTonight.reservationCode).toMatch(/^RSV-/);
    expect(rooms.find((r) => r.roomNumber === "205").displayStatus).toBe("OCCUPIED");
  });

  test("rooms that are occupied or have active reservations cannot be deleted", async () => {
    const occupied = await admin.api("DELETE", `/admin/rooms/${(await roomByNumber("205")).id}`);
    expect(occupied.status).toBe(409);
    expect(occupied.error.code).toBe("ROOM_OCCUPIED");
    const booked = await admin.api("DELETE", `/admin/rooms/${(await roomByNumber("102")).id}`);
    expect(booked.status).toBe(409);
    expect(booked.error.code).toBe("ROOM_HAS_ACTIVE_RESERVATIONS");
    expect(await roomByNumber("102")).not.toBeNull();
  });

  test("receptionists cannot delete rooms", async () => {
    expect((await desk.api("DELETE", `/admin/rooms/${suite.id}`)).status).toBe(403);
  });

  test("a room that was never booked is deleted permanently", async () => {
    const b12 = await roomByNumber("B-12");
    const res = await admin.api("DELETE", `/admin/rooms/${b12.id}`);
    expect(res.status).toBe(200);
    expect(res.data.mode).toBe("deleted");
    expect((await admin.get(`/rooms/${b12.id}`)).status).toBe(404);
  });

  test("a room with history is archived: history stays intact and it can be restored", async () => {
    const created = await admin.post("/admin/rooms", { roomNumber: "601", roomType: "Studio", capacity: 2, nightlyRate: "3000.00" });
    const r = (await book(desk, { roomId: created.data.id, from: D(20), to: D(21) })).data;
    // Past booking (cancelled) → the room has history but no active reservation.
    await Reservation.update({ status: RESERVATION_STATUS.CANCELLED, cancelledAt: new Date() }, { where: { id: r.id } });

    const res = await admin.api("DELETE", `/admin/rooms/${created.data.id}`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ mode: "archived", historicalReservations: 1 });

    expect((await admin.get("/rooms", {})).data.map((x) => x.roomNumber)).not.toContain("601");
    expect((await admin.get("/rooms?includeInactive=true")).data.map((x) => x.roomNumber)).not.toContain("601");
    const archived = (await admin.get("/rooms?archived=true")).data;
    expect(archived.find((x) => x.roomNumber === "601").displayStatus).toBe("DELETED");
    expect((await desk.get("/room-types")).data.map((t) => t.roomType)).not.toContain("Studio");

    const history = await desk.get(`/reservations/${r.id}`);
    expect(history.status).toBe(200);
    expect(history.data.room.roomNumber).toBe("601");

    const reuse = await admin.post("/admin/rooms", { roomNumber: "601", roomType: "Studio", capacity: 2, nightlyRate: 1 });
    expect(reuse.status).toBe(409);
    expect(reuse.error.message).toMatch(/restore/i);
    expect((await desk.post("/reservations", { guest: { firstName: "A", lastName: "B" }, roomId: created.data.id, checkInDate: D(30), checkOutDate: D(31), numGuests: 1 })).status).toBe(404);

    const restored = await admin.post(`/admin/rooms/${created.data.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.data).toMatchObject({ isActive: true, archivedAt: null });
    expect((await admin.get("/rooms")).data.map((x) => x.roomNumber)).toContain("601");
  });

  test("a room needed by bookings not yet assigned cannot be removed; maintenance only blocks tonight", async () => {
    const loft = (await admin.post("/admin/rooms", { roomNumber: "701", roomType: "Loft", capacity: 2, nightlyRate: "4000.00" })).data;
    expect((await book(desk, { roomType: "Loft", from: D(3), to: D(4) })).status).toBe(201);

    const deactivate = await admin.patch(`/admin/rooms/${loft.id}`, { isActive: false });
    expect(deactivate.status).toBe(409);
    expect(deactivate.error.code).toBe("ROOM_NEEDED_FOR_BOOKINGS");
    expect((await admin.api("DELETE", `/admin/rooms/${loft.id}`)).error.code).toBe("ROOM_NEEDED_FOR_BOOKINGS");

    expect((await admin.patch(`/admin/rooms/${loft.id}`, { status: "MAINTENANCE" })).status).toBe(200);
    const tonight = await book(desk, { roomType: "Loft", from: D0, to: D(1) });
    expect(tonight.status).toBe(409);
    expect(tonight.error.code).toBe("NO_AVAILABILITY");
    expect((await book(desk, { roomType: "Loft", from: D(6), to: D(7) })).status).toBe(201);

    const dash = await admin.get("/dashboard");
    expect(dash.data.rooms.maintenance).toBe(1);
    expect((await admin.patch(`/admin/rooms/${loft.id}`, { status: "VACANT" })).data.status).toBe("VACANT");
  });

  test("room changes persist across a fresh read and the dashboard still works", async () => {
    const row = await Room.findByPk(suite.id);
    expect(row.floor).toBe("6");
    expect(Number(row.nightlyRate)).toBe(7800);
    expect((await desk.get("/dashboard")).status).toBe(200);
  });
});
