/**
 * PostgreSQL 连接池与事务封装（仅用 pg，不引入 ORM，Docker 构建无代码生成步骤）。
 * 注意：bigint/bigserial 默认以字符串返回，查询里一律 `seq::int` 显式转换。
 */
import pg from 'pg'
import type { PoolClient } from 'pg'
import { SCHEMA_SQL } from './schema.js'

const { Pool } = pg

export interface Queryable {
  query: <T>(sql: string, params?: readonly unknown[]) => Promise<T[]>
}

export interface Database extends Queryable {
  transaction: <T>(fn: (client: Queryable) => Promise<T>) => Promise<T>
  close: () => Promise<void>
}

export async function openDatabase(databaseUrl: string): Promise<Database> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
  })

  const query = async <T>(sql: string, params: readonly unknown[] = []): Promise<T[]> => {
    const result = await pool.query(sql, params as unknown[])
    return result.rows as T[]
  }

  const transaction = async <T>(fn: (client: Queryable) => Promise<T>): Promise<T> => {
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      const scoped: Queryable = {
        query: async <R>(sql: string, params: readonly unknown[] = []) => {
          const result = await client.query(sql, params as unknown[])
          return result.rows as R[]
        },
      }
      const value = await fn(scoped)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  await pool.query(SCHEMA_SQL)

  return {
    query,
    transaction,
    close: async () => {
      await pool.end()
    },
  }
}
