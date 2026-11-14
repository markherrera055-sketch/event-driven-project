/**
 * Nightly database backup (Figure 4, Deployment Diagram: "nightly backup").
 *
 *   npm run backup
 *
 * Writes backups/<DB_NAME>-YYYYMMDD-HHmmss.sql using mysqldump (single
 * consistent snapshot, includes the v_bill_total view) and deletes backups
 * older than BACKUP_RETENTION_DAYS (default 14).
 *
 * Schedule it nightly, e.g.
 *   Linux cron:        0 2 * * *  cd /srv/frontdesk && npm run backup >> backups/backup.log 2>&1
 *   Windows scheduler: schtasks /Create /SC DAILY /ST 02:00 /TN "FrontDesk backup" /TR "cmd /c cd /d C:\path\to\FrontDesk && npm run backup"
 *
 * Restore:  mysql -u root -p FrontDesk < backups/FrontDesk-YYYYMMDD-HHmmss.sql
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { config } from "../config/index.js";

const dir = path.resolve(process.env.BACKUP_DIR || path.join(config.rootDir, "backups"));
const retentionDays = Number.parseInt(process.env.BACKUP_RETENTION_DAYS || "14", 10);
const mysqldump = process.env.MYSQLDUMP_PATH || "mysqldump";

fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const file = path.join(dir, `${config.db.name}-${stamp}.sql`);

const args = [
  `--host=${config.db.host}`,
  `--port=${config.db.port}`,
  `--user=${config.db.user}`,
  "--single-transaction",
  "--routines",
  "--triggers",
  "--set-gtid-purged=OFF",
  "--default-character-set=utf8mb4",
  config.db.name,
];

const out = fs.createWriteStream(file);
// The password is passed through the environment, never on the command line.
const child = spawn(mysqldump, args, { env: { ...process.env, MYSQL_PWD: config.db.password } });
let stderr = "";
child.stdout.pipe(out);
child.stderr.on("data", (d) => (stderr += d));
child.on("error", (err) => {
  console.error(`❌ Could not run mysqldump (${err.message}). Set MYSQLDUMP_PATH to its full path.`);
  process.exitCode = 1;
});
child.on("close", (code) => {
  out.end(() => {
    if (code !== 0) {
      fs.rmSync(file, { force: true });
      console.error(`❌ Backup failed (exit ${code}): ${stderr.trim()}`);
      process.exitCode = 1;
      return;
    }
    const size = fs.statSync(file).size;
    console.log(`✅ Backup written: ${file} (${(size / 1024).toFixed(1)} KB)`);

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (f.startsWith(`${config.db.name}-`) && f.endsWith(".sql") && fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p);
        console.log(`🗑  Removed old backup ${f}`);
      }
    }
  });
});
