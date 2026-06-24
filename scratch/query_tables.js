const pool = require('../src/config/db');

async function test() {
  try {
    const [rows] = await pool.execute('SHOW TABLES');
    console.log('Tables in database:', rows.map(r => Object.values(r)[0]));
  } catch (err) {
    console.error('Error showing tables:', err);
  } finally {
    await pool.end();
  }
}

test();
