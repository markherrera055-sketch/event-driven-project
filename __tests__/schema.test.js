/** Schema upgrade for existing databases (npm run migrate) + password policy helpers. */
import { resetDatabase } from "./helpers/harness.js";
import { sequelize, upgradeSchema, Room } from "../models/index.js";
import { passwordProblems, generateTemporaryPassword } from "../utils/password.js";

beforeAll(resetDatabase);
afterAll(() => sequelize.close());

describe("upgradeSchema()", () => {
  test("adds the new columns and the MAINTENANCE status to a database created by the previous version, keeping data", async () => {
    // Recreate the old shape.
    await sequelize.query("ALTER TABLE rooms DROP COLUMN floor, DROP COLUMN description, DROP COLUMN amenities, DROP COLUMN archived_at");
    await sequelize.query("ALTER TABLE rooms MODIFY status ENUM('VACANT','OCCUPIED') NOT NULL DEFAULT 'VACANT'");
    await sequelize.query("ALTER TABLE users DROP COLUMN must_change_password, DROP COLUMN session_version, DROP COLUMN password_changed_at");
    const [[{ n: roomsBefore }]] = await sequelize.query("SELECT COUNT(*) AS n FROM rooms");

    const applied = await upgradeSchema();
    expect(applied).toEqual(
      expect.arrayContaining([
        "users.must_change_password",
        "users.session_version",
        "users.password_changed_at",
        "rooms.floor",
        "rooms.description",
        "rooms.amenities",
        "rooms.archived_at",
        "rooms.status (+MAINTENANCE)",
      ])
    );
    expect(await Room.count()).toBe(roomsBefore);
    const [[user]] = await sequelize.query("SELECT must_change_password, session_version FROM users LIMIT 1");
    expect(user).toMatchObject({ must_change_password: 0, session_version: 0 });

    await Room.update({ status: "MAINTENANCE" }, { where: { roomNumber: "101" } });
    expect((await Room.findOne({ where: { roomNumber: "101" } })).status).toBe("MAINTENANCE");
  });

  test("running it again changes nothing", async () => {
    expect(await upgradeSchema()).toEqual([]);
  });
});

describe("password policy", () => {
  test.each([
    ["Harbor#Light2031", true],
    ["short#A1", false],
    ["NoSymbolHere2031", false],
    ["no#upper#case2031", false],
    ["NO#LOWER#CASE2031", false],
    ["NoDigits#Here!!", false],
    ["Password2031!", false],
    ["Welcome!2031", false],
    [`${"Aa1#".repeat(18)}x`, false], // 73 bytes
  ])("%s → acceptable: %s", (pw, ok) => {
    expect(passwordProblems(pw).length === 0).toBe(ok);
  });

  test("a password containing the username is refused", () => {
    expect(passwordProblems("Liza#Ramos2031", { username: "liza" })).toEqual(["Must not contain your username."]);
  });

  test("generated temporary passwords always satisfy the policy and differ", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const pw = generateTemporaryPassword();
      expect(pw).toHaveLength(14);
      expect(passwordProblems(pw)).toEqual([]);
      seen.add(pw);
    }
    expect(seen.size).toBe(200);
  });
});
