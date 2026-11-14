import { sequelize } from "../models/index.js";

/**
 * Runs fn inside the caller's transaction when one is supplied, otherwise in a
 * new managed transaction (committed on success, rolled back on throw).
 */
export const withTransaction = (transaction, fn) => (transaction ? fn(transaction) : sequelize.transaction(fn));
