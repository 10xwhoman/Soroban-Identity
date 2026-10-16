import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getCurrentTenantId } from '../context/tenantContext';

/**
 * Connection pool management with health checks, automatic reconnection,
 * query timeout handling and pool metrics.
 *
 * See issue #809 [BE-NEW-10].
 */

export interface PoolMetrics {
  total: number;
  active: number;
  idle: number;
  waiting: number;
}

export interface PoolOptions {
  /** Maximum number of clients the pool will hold. Defaults to 10. */
  max?: number;
  /** Minimum number of idle clients kept alive. Defaults to 0. */
  min?: number;
  /** Milliseconds a client may sit idle before being released. */
  idleTimeoutMillis?: number;
  /** Milliseconds to wait for a connection before failing. */
  connectionTimeoutMillis?: number;
  /** Default per-query timeout in milliseconds. Defaults to 30_000. */
  queryTimeoutMillis?: number;
  /** Number of reconnect attempts before giving up. */
  maxRetries?: number;
  /** Base delay (ms) between reconnect attempts (exponential backoff). */
  retryDelayMillis?: number;
}

const DEFAULT_POOL_SIZE = 10;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

/** Postgres session variable used by row-level security policies. */
const TENANT_SETTING = 'app.tenant_id';

/**
 * Error raised when a query would cross tenant boundaries or when no
 * tenant is available in the current request context.
 */
export class TenantIsolationError extends Error {
  readonly code = 'TENANT_ISOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

/**
 * Heuristic check for queries that reference tenant-scoped tables without
 * constraining them by tenant_id. Used as a defence-in-depth guard on top
 * of database row-level security.
 */
function referencesTenantColumn(text: string): boolean {
  return /\btenant_id\b/i.test(text);
}

function isWriteStatement(text: string): boolean {
  return /^\s*(insert|update|delete|merge|truncate)\b/i.test(text);
}

/** Errors that indicate a transient/lost connection worth retrying. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
]);

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' && RETRYABLE_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DatabasePool {
  private readonly pool: Pool;
  private readonly queryTimeoutMillis: number;
  private readonly maxRetries: number;
  private readonly retryDelayMillis: number;
  private shuttingDown = false;

  constructor(options: PoolOptions = {}) {
    const poolConfig: PoolConfig = {
      connectionString: config.database.url,
      max: options.max ?? DEFAULT_POOL_SIZE,
      min: options.min ?? 0,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
      // Keep TCP connections alive so transient drops are detected early.
      keepAlive: true,
    };

    this.queryTimeoutMillis = options.queryTimeoutMillis ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMillis = options.retryDelayMillis ?? DEFAULT_RETRY_DELAY_MS;
    this.pool = new Pool(poolConfig);

    this.pool.on('connect', () => {
      logger.debug('db.pool: client connected');
    });
    this.pool.on('acquire', () => {
      logger.debug('db.pool: client acquired');
    });
    this.pool.on('remove', () => {
      logger.debug('db.pool: client removed');
    });
    this.pool.on('error', (err) => {
      // Idle client errors must not crash the process.
      logger.error('db.pool: idle client error', { error: err.message });
    });
  }

  /** Current pool metrics: active, idle and waiting connections. */
  metrics(): PoolMetrics {
    return {
      total: this.pool.totalCount,
      active: this.pool.totalCount - this.pool.idleCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /** Verify a client is usable before handing it to a query. */
  private async healthCheck(client: PoolClient): Promise<void> {
    await client.query('SELECT 1');
  }

  /**
   * Acquire a healthy client, retrying with exponential backoff on
   * transient connection failures.
   */
  private async acquireHealthyClient(): Promise<PoolClient> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.shuttingDown) {
        throw new Error('db.pool: pool is shutting down');
      }
      try {
        const client = await this.pool.connect();
        try {
          await this.healthCheck(client);
          return client;
        } catch (err) {
          // Unhealthy client: discard and retry.
          client.release(true);
          throw err;
        }
      } catch (err) {
        lastError = err;
        if (attempt === this.maxRetries || !isRetryable(err)) {
          break;
        }
        const delay = this.retryDelayMillis * 2 ** attempt;
        logger.warn('db.pool: connection attempt failed, retrying', {
          attempt: attempt + 1,
          delay,
          error: (err as Error).message,
        });
        await sleep(delay);
      }
    }
    logger.error('db.pool: unable to acquire connection', {
      error: (lastError as Error)?.message,
    });
    throw lastError;
  }

  /**
   * Execute a query with a per-query timeout and automatic retry on
   * transient connection loss.
   */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
    timeoutMillis: number = this.queryTimeoutMillis,
  ): Promise<QueryResult<T>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const client = await this.acquireHealthyClient();
      try {
        return await this.withTimeout(client.query<T>(text, params), timeoutMillis);
      } catch (err) {
        lastError = err;
        // Release the client; mark it broken if the connection was lost.
        client.release(isRetryable(err));
        if (attempt === this.maxRetries || !isRetryable(err)) {
          break;
        }
        const delay = this.retryDelayMillis * 2 ** attempt;
        logger.warn('db.pool: query failed, retrying', {
          attempt: attempt + 1,
          delay,
          error: (err as Error).message,
        });
        await sleep(delay);
      }
    }
    throw lastError;
  }

  /**
   * Resolve the tenant for the current request, falling back to an explicit
   * override. Throws when no tenant can be determined so that unscoped
   * queries never reach the database.
   */
  private resolveTenantId(explicitTenantId?: string): string {
    const tenantId = explicitTenantId ?? getCurrentTenantId();
    if (!tenantId) {
      throw new TenantIsolationError(
        'db.pool: no tenant in context; refusing to run tenant-scoped query',
      );
    }
    return tenantId;
  }

  /**
   * Apply the tenant context to a client session so that row-level security
   * policies (using current_setting('app.tenant_id')) are enforced.
   */
  private async setTenantContext(
    client: PoolClient,
    tenantId: string,
    timeoutMillis: number,
  ): Promise<void> {
    await this.withTimeout(
      client.query(`SELECT set_config($1, $2, true)`, [TENANT_SETTING, tenantId]),
      timeoutMillis,
    );
  }

  /**
   * Execute a tenant-scoped query. The current tenant id is injected into the
   * session so row-level security applies, and queries that touch tenant
   * columns without constraining them are rejected.
   */
  async tenantQuery<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
    timeoutMillis: number = this.queryTimeoutMillis,
    tenantId?: string,
  ): Promise<QueryResult<T>> {
    const resolvedTenantId = this.resolveTenantId(tenantId);
    if (isWriteStatement(text) && !referencesTenantColumn(text)) {
      throw new TenantIsolationError(
        'db.pool: tenant-scoped write must reference tenant_id',
      );
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const client = await this.acquireHealthyClient();
      try {
        await this.setTenantContext(client, resolvedTenantId, timeoutMillis);
        const result = await this.withTimeout(
          client.query<T>(text, params),
          timeoutMillis,
        );
        client.release();
        return result;
      } catch (err) {
        lastError = err;
        client.release(isRetryable(err));
        if (attempt === this.maxRetries || !isRetryable(err)) {
          break;
        }
        const delay = this.retryDelayMillis * 2 ** attempt;
        logger.warn('db.pool: tenant query failed, retrying', {
          attempt: attempt + 1,
          delay,
          tenantId: resolvedTenantId,
          error: (err as Error).message,
        });
        await sleep(delay);
      }
    }
    throw lastError;
  }

  /**
   * Run a callback inside a transaction with timeout + retry, scoped to the
   * current tenant. The tenant context is set with SET LOCAL so it is
   * automatically cleared when the transaction ends.
   */
  async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    timeoutMillis: number = this.queryTimeoutMillis,
    tenantId?: string,
  ): Promise<T> {
    const resolvedTenantId = this.resolveTenantId(tenantId);
    const client = await this.acquireHealthyClient();
    let caught: unknown;
    try {
      await this.withTimeout(client.query('BEGIN'), timeoutMillis);
      await this.withTimeout(
        client.query(`SET LOCAL ${TENANT_SETTING} = $1`, [resolvedTenantId]),
        timeoutMillis,
      );
      const result = await this.withTimeout(fn(client), timeoutMillis);
      await this.withTimeout(client.query('COMMIT'), timeoutMillis);
      return result;
    } catch (err) {
      caught = err;
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('db.pool: rollback failed', {
          error: (rollbackErr as Error).message,
        });
      }
      throw err;
    } finally {
      client.release(isRetryable(caught));
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMillis: number): Promise<T> {
    if (!timeoutMillis || timeoutMillis <= 0) {
      return promise;
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`db.pool: query timed out after ${timeoutMillis}ms`);
        (err as { code?: string }).code = 'ETIMEDOUT';
        reject(err);
      }, timeoutMillis);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Gracefully drain and close the pool on server shutdown. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    logger.info('db.pool: shutting down', this.metrics());
    await this.pool.end();
    logger.info('db.pool: shutdown complete');
  }
}

export const dbPool = new DatabasePool();
