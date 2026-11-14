/**
 * express-session store backed by the `sessions` table, so logins survive a
 * restart and memory does not grow unbounded (the default MemoryStore is not
 * meant for production). No extra dependency required.
 */
import session from "express-session";
import { Op } from "sequelize";
import { Session } from "../models/index.js";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export class SequelizeSessionStore extends session.Store {
  constructor({ cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.timer = setInterval(() => this.clearExpired().catch(() => {}), cleanupIntervalMs);
    this.timer.unref();
  }

  expiry(sess) {
    const ms = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DEFAULT_TTL_MS;
    return new Date(ms);
  }

  get(sid, cb) {
    Session.findByPk(sid)
      .then((row) => {
        if (!row || row.expires < new Date()) return cb(null, null);
        cb(null, JSON.parse(row.data));
      })
      .catch(cb);
  }

  set(sid, sess, cb = () => {}) {
    Session.upsert({ sid, expires: this.expiry(sess), data: JSON.stringify(sess) })
      .then(() => cb(null))
      .catch(cb);
  }

  touch(sid, sess, cb = () => {}) {
    Session.update({ expires: this.expiry(sess) }, { where: { sid } })
      .then(() => cb(null))
      .catch(cb);
  }

  destroy(sid, cb = () => {}) {
    Session.destroy({ where: { sid } })
      .then(() => cb(null))
      .catch(cb);
  }

  clearExpired() {
    return Session.destroy({ where: { expires: { [Op.lt]: new Date() } } });
  }
}
