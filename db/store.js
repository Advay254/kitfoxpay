/**
 * Webhook 幂等性存储（PostgreSQL）/ Webhook Idempotency Store (PostgreSQL)
 *
 * 防止同一 Paystack Webhook 事件被重复处理。
 * Prevents the same Paystack webhook event from being processed twice.
 *
 * 兼容任何 PostgreSQL 提供商 / Compatible with any PostgreSQL provider:
 *   Supabase  → Project Settings → Database → Connection String → URI
 *   Aiven     → Service Overview → Connection Information → Service URI
 *   Neon      → Dashboard → Connection Details → Connection string
 *   Railway   → Service → Variables → DATABASE_URL (auto-set)
 *   本地 / local → postgresql://user:pass@localhost:5432/dbname
 *
 * 工作模式 / Modes:
 *   DATABASE_URL 已设置 → 连接 PostgreSQL，首次运行自动建表，重启后保持幂等性
 *   DATABASE_URL 未设置 → 退回进程内 Set，重启后失效（功能正常但非持久）
 *
 *   DATABASE_URL set     → connects to PostgreSQL, auto-creates table on first run, survives restarts
 *   DATABASE_URL not set → falls back to in-process Set, cleared on restart (functional but not persistent)
 */

const { Pool } = require('pg');

const TABLE = 'kfp_webhook_idempotency';

// 内存回退 / In-memory fallback
const _mem    = new Set();
const MEM_MAX = 10000;

class IdempotencyStore {
  /**
   * @param {string} [databaseUrl] - PostgreSQL 连接字符串 / connection URL (from process.env.DATABASE_URL)
   */
  constructor(databaseUrl) {
    this._pool  = null;
    this._ready = false;

    if (!databaseUrl) {
      console.log('[IdempotencyStore] ⚠  DATABASE_URL 未设置，使用内存模式（重启后幂等性失效）');
      console.log('[IdempotencyStore]    DATABASE_URL not set — memory mode active (not persistent across restarts)');
      console.log('[IdempotencyStore]    支持的 PostgreSQL 提供商 / Supported providers: Supabase, Aiven, Neon, Railway, 本地/local');
      return;
    }

    this._pool = new Pool({
      connectionString:    databaseUrl,
      ssl:                 { rejectUnauthorized: false }, // 兼容 TLS 强制要求的云 DB / supports cloud DBs that require TLS
      max:                 3,
      idleTimeoutMillis:   30000,
      connectionTimeoutMillis: 5000
    });

    // 异步初始化：建表（首次运行）/ Async init: create table (first run)
    this._init().catch(err => {
      console.error('[IdempotencyStore] 初始化异常 / init error:', err.message);
    });
  }

  // ─────────────────────────────────────────────
  // 初始化：自动建表 / Init: auto-create table
  // ─────────────────────────────────────────────

  async _init() {
    try {
      await this._pool.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id         TEXT        PRIMARY KEY,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await this._pool.query(`
        CREATE INDEX IF NOT EXISTS idx_${TABLE}_created_at
        ON ${TABLE} (created_at)
      `);

      this._ready = true;
      console.log(`[IdempotencyStore] ✅ PostgreSQL 模式已就绪 / PostgreSQL mode ready`);
      console.log(`[IdempotencyStore]    表 / Table: ${TABLE}`);

      // 清理 7 天前的旧记录 / Clean records older than 7 days
      const { rowCount } = await this._pool.query(
        `DELETE FROM ${TABLE} WHERE created_at < NOW() - INTERVAL '7 days'`
      );
      if (rowCount > 0) {
        console.log(`[IdempotencyStore] 🧹 清理过期记录 / Cleaned expired records: ${rowCount}`);
      }
    } catch (err) {
      console.error('[IdempotencyStore] ❌ 数据库初始化失败，退回内存模式 / DB init failed, falling back to memory:', err.message);
      this._ready = false;
    }
  }

  // ─────────────────────────────────────────────
  // 公开方法 / Public methods
  // ─────────────────────────────────────────────

  /**
   * 检查 ID 是否已处理 / Check if ID was already processed
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async has(id) {
    if (!this._ready) return _mem.has(String(id));
    try {
      const { rowCount } = await this._pool.query(
        `SELECT 1 FROM ${TABLE} WHERE id = $1 LIMIT 1`,
        [String(id)]
      );
      return rowCount > 0;
    } catch (err) {
      console.error('[IdempotencyStore] has() 失败，退回内存 / failed, fallback:', err.message);
      return _mem.has(String(id));
    }
  }

  /**
   * 标记 ID 为已处理 / Mark ID as processed
   * @param {string} id
   * @returns {Promise<void>}
   */
  async mark(id) {
    const strId = String(id);

    // 内存同步（双写，保证即使 DB 抖动也有缓存层）
    // Dual-write: memory layer ensures coverage even during DB blips
    if (_mem.size >= MEM_MAX) _mem.delete(_mem.values().next().value);
    _mem.add(strId);

    if (!this._ready) return;
    try {
      await this._pool.query(
        `INSERT INTO ${TABLE} (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [strId]
      );
    } catch (err) {
      // 不抛出 — 内存层已标记，业务可继续 / Don't throw — memory already marked, business continues
      console.error('[IdempotencyStore] mark() 失败（内存已标记）/ mark() failed (memory marked):', err.message);
    }
  }

  /**
   * 关闭连接池（优雅退出）/ Close pool on graceful shutdown
   */
  async close() {
    if (this._pool) await this._pool.end();
  }
}

module.exports = IdempotencyStore;
