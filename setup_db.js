require('dotenv').config();
const pool = require('./src/config/db');
const bcrypt = require('bcryptjs');

async function setup() {
    const connection = await pool.getConnection();
    try {
        // Add slug column if it doesnt exist
        console.log('Adding slug column to EMPRESA...');
        try {
            await connection.execute("ALTER TABLE EMPRESA ADD COLUMN slug VARCHAR(100) UNIQUE");
            console.log('✅ slug column added');
        } catch(e) {
            if (e.code === 'ER_DUP_FIELDNAME') {
                console.log('ℹ️  slug already exists, skipping');
            } else {
                throw e;
            }
        }

        // Recreate admin account if it doesn't exist
        const [existing] = await connection.execute("SELECT id_usuario FROM USUARIO WHERE email = 'admin@citax.com'");
        if (existing.length === 0) {
            console.log('Creating admin@citax.com...');
            const hash = await bcrypt.hash('admin1234', 10);
            const [userRes] = await connection.execute(
                "INSERT INTO USUARIO (email, password_hash, nombre, apellido, rol) VALUES ('admin@citax.com', ?, 'Admin', 'Citax', 'admin_empresa')",
                [hash]
            );
            await connection.execute(
                "INSERT INTO EMPRESA (id_usuario, nombre_comercial, slug, config_recordatorios, horarios_disponibilidad) VALUES (?, 'Citax Empresa', 'citax-empresa', ?, ?)",
                [userRes.insertId, JSON.stringify({ recordatorio_activo: false, recordatorio_offsets_minutos: [1440], recordatorio_mensaje: "Hola {{cliente_nombre}}, te recordamos tu turno para {{fecha}} a las {{hora}}." }), JSON.stringify({ config: [] })]
            );
            console.log('✅ admin@citax.com creado — pass: admin1234');
        } else {
            // Ensure slug is set on existing empresa
            await connection.execute("UPDATE EMPRESA SET slug = 'citax-empresa' WHERE id_usuario = ? AND (slug IS NULL OR slug = '')", [existing[0].id_usuario]);
            console.log('✅ admin ya exists, slug asegurado');
        }
    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        connection.release();
        process.exit();
    }
}

setup();
