/**
 * KitfoxPay 数据库存储单例 / Database Store Singleton
 *
 * 确保整个应用共享同一个数据库连接池实例。
 * Ensures the entire app shares a single database connection pool instance.
 *
 * 使用方式 / Usage:
 *   const db = require('./db');
 *   await db.saveConfig(content);
 *   await db.getConfig();
 *   await db.mark(id);
 *   await db.has(id);
 */

const KfpStore = require('./store');

// 单例：模块缓存确保只创建一次 / Singleton: module cache ensures created only once
module.exports = new KfpStore(process.env.DATABASE_URL);
