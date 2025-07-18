// lib/db.ts
import { createPool } from 'mysql2/promise';

const pool = createPool({
  host: process.env.WP_DB_HOST,
  user: process.env.WP_DB_USER,
  password: process.env.WP_DB_PASSWORD,
  database: process.env.WP_DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

export async function queryDB(sql: string, values?: any[]) {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query(sql, values);
    return rows;
  } finally {
    connection.release();
  }
}