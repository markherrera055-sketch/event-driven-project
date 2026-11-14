/*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
    
import express from "express";
import path from "path";
import fs from "fs";
import session from "express-session";
import flash from "connect-flash";
import hbs from "hbs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";
import { config } from "./config/index.js";
import { sequelize } from "./models/index.js";
import router from "./routes/index.js";
import { integrationRouter, startIntegrations } from "./integrations/index.js";
import { SequelizeSessionStore } from "./middleware/sessionStore.js";
import { csrfProtection } from "./middleware/csrf.js";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = config.port;

app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", 1);

// Security headers (no inline scripts are used, so the CSP can be strict).
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
  });
  if (req.originalUrl.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: config.isProduction ? "1h" : 0 }));

// External systems (POS, Hotel Reservation System): API-key auth, no cookies,
// so they are mounted before the session / CSRF middleware.
app.use("/api/v1/integrations", integrationRouter());

app.use(
  session({
    name: "frontdesk.sid",
    secret: config.session.secret,
    store: config.isTest ? undefined : new SequelizeSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.session.secureCookie,
      maxAge: config.session.maxAgeMs,
    },
  })
);
app.use(flash());
app.use(csrfProtection);

app.use((req, res, next) => {
  res.locals.success_msg = req.flash("success_msg");
  res.locals.error_msg = req.flash("error_msg");
  res.locals.hotelName = config.hotel.name;
  next();
});

// ── XianFire view engine (.xian = Handlebars) ────────────────────────────────
app.engine("xian", (filePath, options, callback) => hbs.__express(filePath, options, callback));
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "xian");

// Partials are registered synchronously at start-up (the previous async
// registration could race with the first request).
const partialsDir = path.join(__dirname, "views/partials");
for (const file of fs.readdirSync(partialsDir).filter((f) => f.endsWith(".xian"))) {
  hbs.registerPartial(file.replace(".xian", ""), fs.readFileSync(path.join(partialsDir, file), "utf8"));
}
hbs.registerHelper("eq", (a, b) => a === b);

app.use("/", router);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;

// Start the HTTP server; resolves once the server is listening.
// Exported so the Electron main process can control startup itself.
export const startServer = async (port = PORT) => {
  if (config.isProduction && config.paymentGateway.driver === "sandbox" && process.env.ALLOW_SANDBOX_GATEWAY !== "true") {
    throw new Error("PAYMENT_GATEWAY_DRIVER=sandbox is not allowed in production.");
  }
  await sequelize.authenticate();
  startIntegrations();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🔥 ${config.hotel.name} PMS running at http://localhost:${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
};

// Auto-start only when executed directly (node index.js).
// When imported by electron/main.js, Electron manages the server lifecycle.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer().catch((err) => {
    console.error("❌ Failed to start:", err.message);
    console.error("   Is MySQL running and has `npm run migrate` been executed?");
    process.exit(1);
  });
}
