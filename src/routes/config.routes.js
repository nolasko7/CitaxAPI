const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

router.use(authMiddleware);

router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT config_recordatorios FROM EMPRESA WHERE id_empresa = ?', [req.user.id_empresa]);
        if (rows.length === 0) return res.status(404).json({ error: 'Empresa no encontrada' });
        
        res.json(rows[0].config_recordatorios || {});
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener config' });
    }
});

router.put('/', async (req, res) => {
    try {
        await pool.execute('UPDATE EMPRESA SET config_recordatorios = ? WHERE id_empresa = ?', [JSON.stringify(req.body), req.user.id_empresa]);
        res.json(req.body);
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar config' });
    }
});

router.get('/bot', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT bot_config FROM EMPRESA WHERE id_empresa = ?', [req.user.id_empresa]);
        if (rows.length === 0) return res.status(404).json({ error: 'Empresa no encontrada' });
        
        const config = typeof rows[0].bot_config === 'string' 
            ? JSON.parse(rows[0].bot_config) 
            : rows[0].bot_config || {};
        
        res.json(config);
    } catch (err) {
        console.error("Error al obtener config bot:", err);
        res.status(500).json({ error: 'Error al obtener config del bot' });
    }
});

router.put('/bot', async (req, res) => {
    try {
        const payload = req.body || {};
        
        // Sanear el payload para asegurarnos de que no hay código extraño
        const config = {
            tono: String(payload.tono || "").slice(0, 100).trim(),
            rubro: String(payload.rubro || "").slice(0, 100).trim(),
            mensaje_bienvenida: String(payload.mensaje_bienvenida || "").slice(0, 200).trim(),
            palabras_propias: String(payload.palabras_propias || "").slice(0, 500).trim(),
            primera_persona: payload.primera_persona === true,
        };
        
        await pool.execute(
            'UPDATE EMPRESA SET bot_config = ? WHERE id_empresa = ?', 
            [JSON.stringify(config), req.user.id_empresa]
        );
        res.json(config);
    } catch (err) {
        console.error("Error al actualizar config bot:", err);
        res.status(500).json({ error: 'Error interno al actualizar la config del bot' });
    }
});

module.exports = router;
