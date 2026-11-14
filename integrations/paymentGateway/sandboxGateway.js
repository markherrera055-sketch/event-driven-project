/**
 * Sandbox payment gateway for development and training. Deterministic:
 *   paymentToken "tok_approve…"  → approved
 *   paymentToken "tok_decline…"  → declined ("Card declined by issuer")
 *   anything else                → declined ("Invalid payment token")
 * Never use in production (startup refuses it when NODE_ENV=production
 * unless ALLOW_SANDBOX_GATEWAY=true).
 */
import crypto from "crypto";

export const sandboxGateway = {
  name: "sandbox",
  async authorize({ amount, paymentToken }) {
    if (!(amount > 0)) return { approved: false, reason: "Invalid amount" };
    const token = String(paymentToken || "");
    if (token.startsWith("tok_approve")) {
      return { approved: true, reference: `SBX-${crypto.randomBytes(6).toString("hex").toUpperCase()}` };
    }
    if (token.startsWith("tok_decline")) return { approved: false, reason: "Card declined by issuer" };
    return { approved: false, reason: "Invalid payment token" };
  },
};
