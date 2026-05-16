/**
 * KitfoxPay 数据库存储层 / Database Storage Layer
 *
 * 负责两件事 / Handles two things:
 *
 * 1. 配置持久化 / Config persistence
 *    将管理界面保存的 config.js 内容存入数据库。
 *    每次启动时从数据库恢复，确保重启、重部署后配置不丢失。
 *    Stores config.js content saved by admin UI into the database.
 *    Restored on every startup so config survives restarts and redeploys.
 *
 * 2. Webhook 幂等性 / Webhook idempotency
 *    防止同一 Paystack Webhook 事件被重复处理。
 *    Prevents the same Paystack webhook event from being processed twice.
 *
 * 兼容任何 PostgreSQL 提供商 / Compatible with any PostgreSQL provider:
 *   Supabase  → Project Settings → Database → Connection String → URI
 *   Aiven     → Service Overview → Connection Information → Service URI
 *   Neon      → Dashboard → Connection Details → Connection string
 *   Railway   → Service → Variables → DATABASE_URL (auto-set)
 *   本地      → postgresql://user:pass@localhost:5432/dbname
 *
 * 工作模式 / Modes:
 *   DATABASE_URL 已设置 → PostgreSQL 持久化，自动建表，重启/重部署后数据保持
 *   DATABASE_URL 未设置 → 内存模式（配置只存文件，幂等性重启失效）
 *
 *   DATABASE_URL set     → PostgreSQL persistent, auto-creates tables, survives restarts/redeploys
 *   DATABASE_URL not set → memory mode (config file only, idempotency cleared on restart)
 */

const { Pool } = require('pg');

const TABLE_CONFIG      = 'kfp_config';
const TABLE_IDEMPOTENCY = 'kfp_webhook_idempotency';

// 内存幂等回退 / In-memory idempotency fallback
const _mem    = new Set();
const MEM_MAX = 10000;

class KfpStore {
  /**
   * @param {string} [databaseUrl] - PostgreSQL 连接字符串 / connection URL (process.env.DATABASE_URL)
   */
  constructor(databaseUrl) {
    this._pool  = null;
    this._ready = false;

    if (!databaseUrl) {
      console.log('[KfpStore] ⚠  DATABASE_URL 未设置');
      console.log('[KfpStore]    配置将仅保存到本地文件（重部署后丢失）');
      console.log('[KfpStore]    DATABASE_URL not set');
      console.log('[KfpStore]    Config will only be saved to local file (lost on redeploy)');
      console.log('[KfpStore]    设置 DATABASE_URL 以启用完整持久化 / Set DATABASE_URL to enable full persistence');
      return;
    }

    this._pool = new Pool({
      connectionString:        databaseUrl,
      ssl:                     { rejectUnauthorized: false }, // 兼容云 DB TLS / cloud DB TLS
      max:                     3,
      idleTimeoutMillis:       30000,
      connectionTimeoutMillis: 5000
    });

    // 异步初始化建表 / Async table creation
    this._init().catch(err => {
      console.error('[KfpStore] 初始化异常 / init error:', err.message);
    });
  }

  // ─────────────────────────────────────────────
  // 初始化：自动建表 / Init: auto-create tables
  // ─────────────────────────────────────────────

  async _init() {
    try {
      // 配置表：单行存储完整 config.js 内容 / Config table: single row stores full config.js content
      await this._pool.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE_CONFIG} (
          id             TEXT        PRIMARY KEY DEFAULT 'main',
          config_content TEXT        NOT NULL,
          updated_at     TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // 幂等性表 / Idempotency table
      await this._pool.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE_IDEMPOTENCY} (
          id         TEXT        PRIMARY KEY,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await this._pool.query(`
        CREATE INDEX IF NOT EXISTS idx_${TABLE_IDEMPOTENCY}_created_at
        ON ${TABLE_IDEMPOTENCY} (created_at)
      `);

      this._ready = true;
      console.log('[KfpStore] ✅ 数据库就绪 / Database ready');
      console.log(`[KfpStore]    配置表 / Config table: ${TABLE_CONFIG}`);
      console.log(`[KfpStore]    幂等性表 / Idempotency table: ${TABLE_IDEMPOTENCY}`);

      // 清理 7 天前的幂等性记录 / Clean idempotency records older than 7 days
      const { rowCount } = await this._pool.query(
        `DELETE FROM ${TABLE_IDEMPOTENCY} WHERE created_at < NOW() - INTERVAL '7 days'`
      );
      if (rowCount > 0) {
        console.log(`[KfpStore] 🧹 清理过期幂等记录 / Cleaned expired idempotency records: ${rowCount}`);
      }
    } catch (err) {
      console.error('[KfpStore] ❌ 数据库初始化失败，退回内存模式 / DB init failed, using memory mode:', err.message);
      this._ready = false;
    }
  }

  // ─────────────────────────────────────────────
  // 配置持久化 / Config persistence
  // ─────────────────────────────────────────────

  /**
   * 从数据库读取 config.js 文件内容 / Read config.js file content from database
   *
   * 用于启动时恢复配置，确保重部署后配置不丢失
   * Used on startup to restore config so it survives redeploys
   *
   * @returns {Promise<string|null>} config.js 文件内容，若无则返回 null / file content or null if not saved yet
   */
  async getConfig() {
    if (!this._ready) return null;
    try {
      const { rows } = await this._pool.query(
        `SELECT config_content FROM ${TABLE_CONFIG} WHERE id = 'main' LIMIT 1`
      );
      return rows[0]?.config_content || null;
    } catch (err) {
      console.error('[KfpStore] getConfig() 失败 / failed:', err.message);
      return null;
    }
  }

  /**
   * 将 config.js 文件内容保存到数据库 / Save config.js file content to database
   *
   * 在管理界面保存配置后调用，确保下次启动时配置可从数据库恢复
   * Called after admin UI saves config so it can be restored from DB on next startup
   *
   * @param {string} configFileContent - config.js 文件的完整内容 / full content of config.js
   * @returns {Promise<void>}
   */
  async saveConfig(configFileContent) {
    if (!this._ready) {
      // 无 DB 时静默跳过，管理界面已写入文件 / No DB: silently skip, admin UI already wrote the file
      return;
    }
    try {
      await this._pool.query(
        `INSERT INTO ${TABLE_CONFIG} (id, config_content, updated_at)
         VALUES ('main', $1, NOW())
         ON CONFLICT (id) DO UPDATE
           SET config_content = EXCLUDED.config_content,
               updated_at     = NOW()`,
        [configFileContent]
      );
      console.log('[KfpStore] ✅ 配置已同步到数据库 / Config synced to database');
    } catch (err) {
      // 不抛出：文件已保存，DB 失败只影响持久化，不影响当前运行
      // Don't throw: file already saved, DB failure only affects persistence, not current run
      console.error('[KfpStore] saveConfig() 失败（配置已保存到文件）/ saveConfig() failed (config saved to file):', err.message);
    }
  }

  // ─────────────────────────────────────────────
  // Webhook 幂等性 / Webhook idempotency
  // ─────────────────────────────────────────────

  /**
   * 检查 Webhook 事件 ID 是否已处理 / Check if webhook event ID was already processed
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async has(id) {
    if (!this._ready) return _mem.has(String(id));
    try {
      const { rowCount } = await this._pool.query(
        `SELECT 1 FROM ${TABLE_IDEMPOTENCY} WHERE id = $1 LIMIT 1`,
        [String(id)]
      );
      return rowCount > 0;
    } catch (err) {
      console.error('[KfpStore] has() 失败，退回内存 / failed, fallback to memory:', err.message);
      return _mem.has(String(id));
    }
  }

  /**
   * 标记 Webhook 事件 ID 为已处理 / Mark webhook event ID as processed
   * @param {string} id
   * @returns {Promise<void>}
   */
  async mark(id) {
    const strId = String(id);

    // 双写内存层（DB 抖动时的保障）/ Dual-write memory layer (safety net for DB blips)
    if (_mem.size >= MEM_MAX) _mem.delete(_mem.values().next().value);
    _mem.add(strId);

    if (!this._ready) return;
    try {
      await this._pool.query(
        `INSERT INTO ${TABLE_IDEMPOTENCY} (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [strId]
      );
    } catch (err) {
      console.error('[KfpStore] mark() 失败（内存已标记）/ mark() failed (memory marked):', err.message);
    }
  }

  // ─────────────────────────────────────────────
  // 工具 / Utility
  // ─────────────────────────────────────────────

  /** 当前是否连接到数据库 / Whether connected to database */
  isConnected() {
    return this._ready;
  }

  /** 关闭连接池（优雅退出）/ Close pool (graceful shutdown) */
  async close() {
    if (this._pool) await this._pool.end();
  }
}

module.exports = KfpStore;
