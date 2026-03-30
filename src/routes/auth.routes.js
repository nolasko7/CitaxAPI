const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { authenticateCompanyUser } = require('../services/authCompany.service');

const JWT_SECRET = process.env.JWT_SECRET || 'secret-key-citax';

function toSlug(text) {
    return text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .trim().replace(/\s+/g, '-')
        .substring(0, 50);
}

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const authResult = await authenticateCompanyUser({ email, password });
        if (!authResult) return res.status(401).json({ error: 'Credenciales inválidas' });
        const { user: resolvedUser } = authResult;
        
        const token = jwt.sign({
            id_usuario: resolvedUser.id,
            email: resolvedUser.email,
            id_empresa: resolvedUser.empresa_id,
            id_prestador: resolvedUser.id_prestador,
            rol: resolvedUser.rol
        }, JWT_SECRET, { expiresIn: '30d' });

        res.json({
            token,
            user: resolvedUser
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// Refresh token endpoint - renews the token if it's still valid
router.post('/refresh', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);

        // Fetch fresh user data from DB
        const [rows] = await pool.execute('SELECT * FROM USUARIO WHERE id_usuario = ?', [decoded.id_usuario]);
        const user = rows[0];
        if (!user) return res.status(401).json({ error: 'User not found' });

        const [empresaRows] = await pool.execute('SELECT * FROM EMPRESA WHERE id_usuario = ?', [user.id_usuario]);
        const empresa = empresaRows[0];

        let prestadorData = null;
        if (user.rol === 'prestador') {
            const [prestRows] = await pool.execute(
                `SELECT p.id_prestador, p.id_empresa, e.nombre_comercial, e.slug
                 FROM PRESTADOR p
                 JOIN EMPRESA e ON p.id_empresa = e.id_empresa
                 WHERE p.id_usuario = ?`,
                [user.id_usuario]
            );
            prestadorData = prestRows[0];
        }

        // Issue a brand new token with fresh 30-day expiry
        const newToken = jwt.sign({
            id_usuario: user.id_usuario,
            email: user.email,
            id_empresa: empresa?.id_empresa || prestadorData?.id_empresa || null,
            id_prestador: prestadorData?.id_prestador || null,
            rol: user.rol
        }, JWT_SECRET, { expiresIn: '30d' });

        res.json({
            token: newToken,
            user: {
                id: user.id_usuario,
                email: user.email,
                nombre: user.nombre,
                apellido: user.apellido,
                rol: user.rol,
                id_prestador: prestadorData?.id_prestador || null,
                empresa_id: empresa?.id_empresa || prestadorData?.id_empresa || null,
                nombre_comercial: empresa?.nombre_comercial || prestadorData?.nombre_comercial || null,
                slug: empresa?.slug || prestadorData?.slug || null
            }
        });
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
});

router.post('/register', async (req, res) => {
    const { email, password, nombre, apellido, nombre_comercial } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const hashedPassword = await bcrypt.hash(password, 10);
        const [userResult] = await connection.execute(
            'INSERT INTO USUARIO (email, password_hash, nombre, apellido, rol) VALUES (?, ?, ?, ?, ?)',
            [email, hashedPassword, nombre, apellido, 'admin_empresa']
        );
        const userId = userResult.insertId;

        let slug = toSlug(nombre_comercial);
        const [slugCheck] = await connection.execute('SELECT id_empresa FROM EMPRESA WHERE slug = ?', [slug]);
        if (slugCheck.length > 0) slug = `${slug}-${Date.now()}`;

        const [empresaResult] = await connection.execute(
            'INSERT INTO EMPRESA (id_usuario, nombre_comercial, slug, config_recordatorios, horarios_disponibilidad) VALUES (?, ?, ?, ?, ?)',
            [userId, nombre_comercial, slug,
                JSON.stringify({
                    recordatorio_activo: false,
                    recordatorio_offsets_minutos: [1440],
                    recordatorio_mensaje: "Hola {{cliente_nombre}}, te recordamos tu turno para {{fecha}} a las {{hora}}."
                }),
                JSON.stringify({ config: [] })
            ]
        );

        await connection.commit();
        res.status(201).json({ id_usuario: userId, id_empresa: empresaResult.insertId, slug });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: 'Error al registrar' });
    } finally {
        connection.release();
    }
});

module.exports = router;
