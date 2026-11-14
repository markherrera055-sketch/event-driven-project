/**
 * Database migration.
 *
 *   npm run migrate                 create database (if missing) + missing tables + v_bill_total view
 *   npm run migrate -- --fresh      DROP and recreate all tables (asks for confirmation; development only)
 *   npm run migrate -- --seed       also insert initial rooms and staff accounts (only if tables are empty)
 *   npm run migrate -- --yes        do not prompt (CI / scripts)
 *
 * The previous version always ran sync({ force: true }), which silently wiped
 * all data on every run. That is now opt-in via --fresh.
 */
import { Sequelize } from "sequelize";
import inquirer from "inquirer";
import { config } from "./config/index.js";
import { sequelize, syncSchema } from "./models/index.js";

const args = new Set(process.argv.slice(2));
const fresh = args.has("--fresh");
const seed = args.has("--seed");
const assumeYes = args.has("--yes") || !process.stdin.isTTY;

const confirm = async (message, fallback) => {
  if (assumeYes) return fallback;
  const { answer } = await inquirer.prompt([{ type: "confirm", name: "answer", message, default: fallback }]);
  return answer;
};

let exitCode = 0;
try {
  if (!/^[A-Za-z0-9_]+$/.test(config.db.name)) throw new Error(`Invalid DB_NAME "${config.db.name}"`);

  const root = new Sequelize("", config.db.user, config.db.password, {
    host: config.db.host,
    port: config.db.port,
    dialect: "mysql",
    logging: false,
  });
  if (await confirm(`Create database '${config.db.name}' if it does not exist?`, true)) {
    await root.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    );
    console.log(`✅ Database '${config.db.name}' is ready`);
  }
  await root.close();

  await sequelize.authenticate();
  console.log("✅ Connected to MySQL");

  if (fresh) {
    const sure = await confirm("--fresh will DELETE ALL DATA in this database. Continue?", false);
    if (!sure && !args.has("--yes")) {
      console.log("Aborted. (Pass --yes together with --fresh to run non-interactively.)");
      process.exit(1);
    }
  }

  await syncSchema({ fresh, log: console.log });
  console.log(fresh ? "✅ All tables dropped and recreated" : "✅ Tables and v_bill_total view are up to date");

  if (seed) {
    const { seedInitialData } = await import("./scripts/seed.js");
    await seedInitialData({ log: console.log });
  }
} catch (err) {
  exitCode = 1;
  console.error("❌ Migration failed:", err.message);
} finally {
  await sequelize.close().catch(() => {});
  process.exit(exitCode);
}
