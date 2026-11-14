/**
 * Payment Gateway Adapter (Figure 3). The Payment module talks only to this
 * interface:
 *
 *   authorize({ amount, currency, method, paymentToken, reference })
 *     → { approved: boolean, reference?: string, reason?: string }
 *
 * Card / e-wallet details never reach the PMS: the gateway's terminal or
 * hosted form returns a one-time `paymentToken`, which is all we forward.
 *
 * Drivers are selected with PAYMENT_GATEWAY_DRIVER. Only the `sandbox` driver
 * ships today; a real provider is added by implementing the same `authorize`
 * function in a new driver file and registering it below — no change to the
 * Payment module is needed.
 */
import { config } from "../../config/index.js";
import { sandboxGateway } from "./sandboxGateway.js";

const drivers = { sandbox: sandboxGateway };

export function getPaymentGateway() {
  const driver = drivers[config.paymentGateway.driver];
  if (!driver) throw new Error(`Unknown PAYMENT_GATEWAY_DRIVER "${config.paymentGateway.driver}"`);
  return driver;
}

/** Wraps a gateway call with a timeout; a timeout or error is reported as a decline, never a success. */
export async function authorizePayment(request) {
  const gateway = getPaymentGateway();
  let timer;
  try {
    return await Promise.race([
      gateway.authorize(request),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Payment gateway timed out")), config.paymentGateway.timeoutMs);
      }),
    ]);
  } catch (err) {
    return { approved: false, reason: `Gateway error: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

export const gatewayInfo = () => ({ driver: config.paymentGateway.driver, sandbox: config.paymentGateway.driver === "sandbox" });
