const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');
const { listAvailableSlots } = require('../services/ai/companyContextService');

router.use(authMiddleware);

const EMPTY_CONFIG = { config: [] };

const parseAvailabilityConfig = (value) => {
    if (!value) return EMPTY_CONFIG;

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parseAvailabilityConfig(parsed);
        } catch (_) {
            return EMPTY_CONFIG;
        }
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
        return EMPTY_CONFIG;
    }

    return {
        config: Array.isArray(value.config) ? value.config : [],
    };
};

const hasOwnAvailabilityConfig = (value) => parseAvailabilityConfig(value).config.length > 0;

const getCompanyAvailabilityRow = async (companyId, executor = pool) => {
    const [rows] = await executor.execute(
        'SELECT horarios_disponibilidad FROM EMPRESA WHERE id_empresa = ? LIMIT 1',
        [companyId]
    );

    return rows[0] || null;
};

const getProfessionalAvailabilityRow = async (companyId, prestadorId, executor = pool) => {
    const [rows] = await executor.execute(
        'SELECT id_prestador, horarios_disponibilidad FROM PRESTADOR WHERE id_empresa = ? AND id_prestador = ? LIMIT 1',
        [companyId, prestadorId]
    );

    return rows[0] || null;
};

const getRequestedPrestadorId = (req) => {
    if (req.user.rol === 'prestador') {
        return Number(req.user.id_prestador || 0) || null;
    }

    const rawValue = req.query.prestador_id ?? req.body?.prestador_id ?? null;
    const parsed = Number(rawValue);
    return parsed || null;
};

router.get('/config', async (req, res) => {
    try {
        const companyId = req.user.id_empresa;
        const requestedPrestadorId = getRequestedPrestadorId(req);
        const companyRow = await getCompanyAvailabilityRow(companyId);

        if (!companyRow) {
            return res.status(404).json({ error: 'Empresa no encontrada' });
        }

        const companyConfig = parseAvailabilityConfig(companyRow.horarios_disponibilidad);

        if (!requestedPrestadorId) {
            return res.json({
                scope: 'empresa',
                source: 'empresa',
                prestador_id: null,
                config: companyConfig.config,
            });
        }

        const professionalRow = await getProfessionalAvailabilityRow(companyId, requestedPrestadorId);
        if (!professionalRow) {
            return res.status(404).json({ error: 'Prestador no encontrado' });
        }

        const professionalConfig = parseAvailabilityConfig(professionalRow.horarios_disponibilidad);
        const source = hasOwnAvailabilityConfig(professionalRow.horarios_disponibilidad)
            ? 'propio'
            : 'fallback_empresa';

        return res.json({
            scope: 'prestador',
            source,
            prestador_id: requestedPrestadorId,
            config: (source === 'propio' ? professionalConfig : companyConfig).config,
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error al obtener disponibilidad' });
    }
});

router.put('/config', async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const companyId = req.user.id_empresa;
        const requestedPrestadorId = getRequestedPrestadorId(req);
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        const payload = JSON.stringify({ config: items });

        await connection.beginTransaction();

        if (requestedPrestadorId) {
            const professionalRow = await getProfessionalAvailabilityRow(companyId, requestedPrestadorId, connection);
            if (!professionalRow) {
                await connection.rollback();
                return res.status(404).json({ error: 'Prestador no encontrado' });
            }

            await connection.execute(
                'UPDATE PRESTADOR SET horarios_disponibilidad = ? WHERE id_prestador = ? AND id_empresa = ?',
                [payload, requestedPrestadorId, companyId]
            );

            const companyRow = await getCompanyAvailabilityRow(companyId, connection);
            await connection.commit();

            return res.json({
                scope: 'prestador',
                source: items.length ? 'propio' : 'fallback_empresa',
                prestador_id: requestedPrestadorId,
                config: items.length ? items : parseAvailabilityConfig(companyRow?.horarios_disponibilidad).config,
            });
        }

        await connection.execute(
            'UPDATE EMPRESA SET horarios_disponibilidad = ? WHERE id_empresa = ?',
            [payload, companyId]
        );

        await connection.commit();

        return res.json({
            scope: 'empresa',
            source: 'empresa',
            prestador_id: null,
            config: items,
        });
    } catch (err) {
        try {
            await connection.rollback();
        } catch (_) {
            // noop
        }
        console.error(err);
        return res.status(500).json({ error: 'Error al actualizar disponibilidad' });
    } finally {
        connection.release();
    }
});

router.get('/', async (req, res) => {
    const professionalId = Number(req.query.prestador_id);
    const serviceId = Number(req.query.servicio_id);
    const date = String(req.query.fecha || '').trim();

    if (!professionalId || !date) {
        return res.status(400).json({ error: 'Faltan parámetros' });
    }

    try {
        const slots = await listAvailableSlots({
            companyId: req.user.id_empresa,
            professionalId,
            serviceId: serviceId || null,
            startDate: date,
            endDate: date,
            referenceDate: date,
            limit: 120,
        });

        return res.json({
            slots: slots
                .filter((slot) => Number(slot.professionalId) === professionalId && slot.date === date)
                .map((slot) => slot.time),
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Error calculando disponibilidad' });
    }
});

module.exports = router;
