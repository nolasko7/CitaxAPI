const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

async function run() {
  const token = jwt.sign(
    { id_usuario: 1, email: 'admin@citax.com', id_empresa: 1, rol: 'admin' },
    process.env.JWT_SECRET || 'tu_jwt_secret_seguro'
  );

  console.log('Sending create-instance request to localhost:3000...');
  try {
    const res = await axios.post(
      'http://localhost:3000/api/whatsapp/create-instance',
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    console.log('Success response:', res.status, JSON.stringify(res.data, null, 2));
  } catch (error) {
    console.error('Error response:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

run();
