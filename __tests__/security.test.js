/** Authentication, role-based access, CSRF and admin rules. */
import { resetDatabase, startApp, StaffClient, PASSWORDS } from "./helpers/harness.js";

let app;
let desk;
let admin;

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
  admin = await new StaffClient(app.base).login("admin", PASSWORDS.admin);
});
afterAll(() => app?.close());

describe("Authentication", () => {
  test("API without a session → 401 JSON", async () => {
    const anon = new StaffClient(app.base);
    const res = await anon.get("/dashboard");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("pages without a session redirect to /login", async () => {
    const res = await new StaffClient(app.base).raw("GET", "/dashboard");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("wrong password and unknown user give the same generic error", async () => {
    const c = new StaffClient(app.base);
    await c.refreshCsrf("/login");
    const a = await c.raw("POST", "/login", { form: { _csrf: c.csrf, username: "frontdesk", password: "nope" } });
    const b = await c.raw("POST", "/login", { form: { _csrf: c.csrf, username: "ghost", password: "nope" } });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.text()).toContain("Invalid username or password.");
    expect(await b.text()).toContain("Invalid username or password.");
  });

  test("first-run setup is closed once users exist; public registration is disabled", async () => {
    const c = new StaffClient(app.base);
    expect((await c.raw("GET", "/setup")).headers.get("location")).toBe("/login");
    expect((await c.raw("GET", "/register")).headers.get("location")).toBe("/login");
  });

  test("password hashes are never returned", async () => {
    const res = await admin.get("/admin/staff");
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });
});

describe("CSRF", () => {
  test("a state-changing API call without the CSRF token is refused", async () => {
    const res = await desk.api("POST", "/check-ins", { reservationId: 1 }, { csrf: false });
    expect(res.status).toBe(403);
    expect(res.error.code).toBe("CSRF_TOKEN_INVALID");
  });
});

describe("Role-based access (Receptionist vs Administrator)", () => {
  test("receptionist cannot use the Admin Console API or pages", async () => {
    expect((await desk.post("/admin/rooms", { roomNumber: "999", roomType: "X", capacity: 1, nightlyRate: 1 })).status).toBe(403);
    expect((await desk.get("/admin/staff")).status).toBe(403);
    expect((await desk.raw("GET", "/admin/rooms")).status).toBe(403);
  });

  test("administrator cannot run front-desk operations", async () => {
    const res = await admin.post("/check-ins", { reservationId: 1 });
    expect(res.status).toBe(403);
  });

  test("both roles can read the dashboard", async () => {
    expect((await desk.get("/dashboard")).status).toBe(200);
    expect((await admin.get("/dashboard")).status).toBe(200);
  });

  test("non-numeric ids are rejected before reaching the database", async () => {
    expect((await desk.get("/stays/abc")).status).toBe(404);
    expect((await desk.get("/guests/1%20OR%201=1")).status).toBe(404);
  });
});

describe("Admin Console: rooms and staff", () => {
  test("administrator creates and updates a room; duplicates are refused", async () => {
    const created = await admin.post("/admin/rooms", { roomNumber: "501", roomType: "Suite", capacity: 2, nightlyRate: "7500.00" });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ roomNumber: "501", status: "VACANT", nightlyRate: 7500 });
    const dup = await admin.post("/admin/rooms", { roomNumber: "501", roomType: "Suite", capacity: 2, nightlyRate: 7500 });
    expect(dup.status).toBe(409);
    const updated = await admin.patch(`/admin/rooms/${created.data.id}`, { nightlyRate: 7800, isActive: false });
    expect(updated.data).toMatchObject({ nightlyRate: 7800, isActive: false });
  });

  test("administrator creates a receptionist who can then sign in", async () => {
    const res = await admin.post("/admin/staff", { fullName: "New Clerk", username: "NewClerk", password: "Clerk#2026pw", role: "RECEPTIONIST" });
    expect(res.status).toBe(201);
    expect(res.data.username).toBe("newclerk");
    await new StaffClient(app.base).login("newclerk", "Clerk#2026pw");
  });

  test("a deactivated account can no longer sign in", async () => {
    const list = await admin.get("/admin/staff?search=newclerk");
    await admin.patch(`/admin/staff/${list.data[0].id}`, { isActive: false });
    await expect(new StaffClient(app.base).login("newclerk", "Clerk#2026pw")).rejects.toThrow();
  });

  test("the last administrator cannot be deactivated or demoted", async () => {
    const me = (await admin.get("/me")).data.user;
    const res = await admin.patch(`/admin/staff/${me.id}`, { isActive: false });
    expect(res.status).toBe(409);
  });

  test("short passwords are rejected", async () => {
    const res = await admin.post("/admin/staff", { fullName: "X", username: "xx1", password: "short", role: "RECEPTIONIST" });
    expect(res.status).toBe(422);
    expect(res.error.details.password).toBeDefined();
  });
});
