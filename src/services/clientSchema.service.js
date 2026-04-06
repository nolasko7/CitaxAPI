const pool = require("../config/db");

const CACHE_TTL_MS = 5 * 60 * 1000;

let clienteEmailColumnCache = {
  expiresAt: 0,
  value: false,
};

const hasClienteEmailColumn = async (executor = pool) => {
  if (Date.now() <= clienteEmailColumnCache.expiresAt) {
    return clienteEmailColumnCache.value;
  }

  try {
    const [rows] = await executor.execute(
      `SELECT 1
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'CLIENTE'
         AND COLUMN_NAME = 'email'
       LIMIT 1`
    );

    const value = rows.length > 0;
    clienteEmailColumnCache = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value,
    };

    return value;
  } catch (error) {
    console.error("Error verificando columna CLIENTE.email:", error.message);
    return false;
  }
};

const invalidateClienteEmailColumnCache = () => {
  clienteEmailColumnCache = {
    expiresAt: 0,
    value: false,
  };
};

module.exports = {
  hasClienteEmailColumn,
  invalidateClienteEmailColumnCache,
};
