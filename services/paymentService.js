/**
 * Payment module (DFD 8.0 Process Payment, 9.0 Retry Payment; REQ-6):
 * "The system shall process payment, show 'payment failed' and allow retry."
 *
 * - Bill must be CONFIRMED; the amount must equal the total due (no partial
 *   payments — PaymentStatus has only SUCCESSFUL / FAILED).
 * - CASH is received at the desk; CARD / E_WALLET go through the gateway adapter.
 * - Every attempt is saved (attemptNo 1, 2, …). A successful payment issues a
 *   receipt (REQ-7) and marks the bill PAID in the same transaction.
 * - The bill row is locked for the whole operation, so two terminals can never
 *   charge the same bill twice.
 */
import { Bill, Payment, Receipt, BILL_STATUS, PAYMENT_METHOD, PAYMENT_STATUS } from "../models/index.js";
import { conflict, notFound, validationError } from "../utils/errors.js";
import { toCents } from "../utils/money.js";
import { config } from "../config/index.js";
import { authorizePayment } from "../integrations/paymentGateway/index.js";
import { getBillTotals } from "./billingService.js";
import { paymentJSON, receiptJSON } from "./serializers.js";
import { withTransaction } from "./tx.js";
import { logger } from "../utils/logger.js";

export async function processPayment(billId, { method, amount, paymentToken }, actor) {
  return withTransaction(null, async (t) => {
    const bill = await Bill.findByPk(billId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!bill) throw notFound("Bill");
    if (bill.status === BILL_STATUS.PAID) throw conflict("BILL_ALREADY_PAID", "This bill has already been paid.");
    if (bill.status !== BILL_STATUS.CONFIRMED) {
      throw conflict("BILL_NOT_CONFIRMED", "Confirm the bill before taking payment.");
    }

    const { totalDue } = await getBillTotals(bill.id, t);
    if (toCents(amount) !== toCents(totalDue)) {
      throw conflict("AMOUNT_MISMATCH", `The amount must equal the total due (${totalDue.toFixed(2)}). Reload the bill if it changed.`, {
        totalDue,
      });
    }
    if (method !== PAYMENT_METHOD.CASH && !paymentToken) {
      throw validationError({ paymentToken: "A payment token from the card terminal / e-wallet is required." });
    }

    const attemptNo = ((await Payment.max("attemptNo", { where: { billId: bill.id }, transaction: t })) || 0) + 1;
    const result =
      method === PAYMENT_METHOD.CASH
        ? { approved: true, reference: null }
        : await authorizePayment({
            amount: totalDue,
            currency: config.hotel.currency,
            method,
            paymentToken,
            reference: `BILL-${bill.id}-${attemptNo}`,
          });

    const payment = await Payment.create(
      {
        billId: bill.id,
        attemptNo,
        amount: totalDue,
        method,
        status: result.approved ? PAYMENT_STATUS.SUCCESSFUL : PAYMENT_STATUS.FAILED,
        gatewayReference: result.reference || null,
        failureReason: result.approved ? null : result.reason || "Payment declined",
        receivedBy: actor.id,
        processedAt: new Date(),
      },
      { transaction: t }
    );

    let receipt = null;
    if (result.approved) {
      // Receipt.generate(): OR-000123 style number derived from the receipt id.
      receipt = await Receipt.create(
        { paymentId: payment.id, receiptNo: `TMP-${payment.id}`, issuedAt: new Date() },
        { transaction: t }
      );
      await receipt.update({ receiptNo: `OR-${String(receipt.id).padStart(6, "0")}` }, { transaction: t });
      await bill.update({ status: BILL_STATUS.PAID, paidAt: new Date() }, { transaction: t });
    }

    logger.info("payment_processed", { billId: bill.id, attemptNo, method, status: payment.status, by: actor.id });
    return { ...paymentJSON(payment), receipt: receipt ? receiptJSON(receipt) : null };
  });
}

export async function listPayments(billId) {
  const rows = await Payment.findAll({
    where: { billId },
    include: ["receipt", { association: "receiver", attributes: ["id", "fullName", "role"] }],
    order: [["attemptNo", "ASC"]],
  });
  return rows.map(paymentJSON);
}
