const pool = require("../config/db");

const TABLE_NAME = "SUPPORT_AUTH_SESSION";
const SESSION_HOURS = Number(process.env.SUPPORT_SESSION_TTL_HOURS || 24);
const SAFE_SESSION_HOURS = Number.isFinite(SESSION_HOURS) && SESSION_HOURS > 0 ? Math.floor(SESSION_HOURS) : 24;

let ensured = false;

const ensureTable = async () => {
  if (ensured) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      phone VARCHAR(32) PRIMARY KEY,
      company_id INT NOT NULL,
      company_name VARCHAR(255) NULL,
      user_email VARCHAR(255) NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  ensured = true;
};

const getSupportSessionDb = async (phone) => {
  if (!phone) return null;
  await ensureTable();
  const [rows] = await pool.execute(
    `SELECT phone, company_id, company_name, user_email, expires_at FROM ${TABLE_NAME} WHERE phone = ? LIMIT 1`,
    [phone]
  );
  const row = rows[0];
  if (!row) return null;

  const expiresAt = new Date(row.expires_at).getTime();
  if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
    await pool.execute(`DELETE FROM ${TABLE_NAME} WHERE phone = ?`, [phone]);
    return null;
  }

  return {
    companyId: row.company_id,
    companyName: row.company_name || null,
    userEmail: row.user_email || null,
    expiresAt,
  };
};

const setSupportSessionDb = async ({ phone, companyId, companyName, userEmail }) => {
  if (!phone || !companyId) return;
  await ensureTable();
  await pool.execute(
    `INSERT INTO ${TABLE_NAME} (phone, company_id, company_name, user_email, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${SAFE_SESSION_HOURS} HOUR))
     ON DUPLICATE KEY UPDATE
       company_id = VALUES(company_id),
       company_name = VALUES(company_name),
       user_email = VALUES(user_email),
       expires_at = VALUES(expires_at)`,
    [phone, Number(companyId), companyName || null, userEmail || null]
  );
};

module.exports = {
  getSupportSessionDb,
  setSupportSessionDb,
};
