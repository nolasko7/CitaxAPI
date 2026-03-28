const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');

router.use(authMiddleware);

const SLOT_INTERVAL_MINUTES = 60;

const getCompanyAvailability = async (companyId) => {
    const [rows] = await pool.execute(
        'SELECT horarios_disponibilidad FROM EMPRESA WHERE id_empresa = ?',
        [companyId]
    );

    if (rows.length === 0) return null;
    return rows[0].horarios_disponibilidad;
};

const getPrestadorAvailability = async (companyId, prestadorId) => {
    const [rows] = await pool.execute(
        'SELECT horarios_disponibilidad FROM PRESTADOR WHERE id_prestador = ? AND id_empresa = ?',
        [prestadorId, companyId]
    );

    if (rows.length === 0) {
        return { exists: false, config: null };
    }

    return {
        exists: true,
        config: rows[0].horarios_disponibilidad,
    };
};

const getPrestadorScope = async (req, prestadorIdFromQuery = null) => {
    const companyId = req.user.id_empresa;
    const companyConfig = await getCompanyAvailability(companyId);

    if (companyConfig === null) {
        return { error: { status: 404, message: 'Empresa no encontrada' } };
    }

    if (req.user.rol === 'prestador') {
        const ownPrestadorId = Number(req.user.id_prestador);
        if (!ownPrestadorId) {
            return { error: { status: 403, message: 'No tenés un prestador asociado' } };
        }

        if (prestadorIdFromQuery && Number(prestadorIdFromQuery) !== ownPrestadorId) {
            return { error: { status: 403, message: 'No podés consultar el horario de otro prestador' } };
        }

        const ownResult = await getPrestadorAvailability(companyId, ownPrestadorId);
        if (!ownResult.exists) {
            return { error: { status: 404, message: 'Prestador no encontrado' } };
        }

        return {
            companyConfig,
            prestadorId: ownPrestadorId,
            effective: resolveEffectiveAvailability({ ownConfig: ownResult.config, companyConfig }),
        };
    }

    if (!prestadorIdFromQuery) {
        return {
            companyConfig,
            prestadorId: null,
            effective: {
                scope: 'empresa',
                source: 'own',
                config: toAvailabilityPayload(companyConfig),
            },
        };
    }

    const prestadorId = Number(prestadorIdFromQuery);
    if (!prestadorId) {
        return { error: { status: 400, message: 'prestador_id inválido' } };
    }

    const ownResult = await getPrestadorAvailability(companyId, prestadorId);
    if (!ownResult.exists) {
        return { error: { status: 404, message: 'Prestador no encontrado' } };
    }

    return {
        companyConfig,
        prestadorId,
        effective: resolveEffectiveAvailability({ ownConfig: ownResult.config, companyConfig }),
    };
};

router.get('/config', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT horarios_disponibilidad FROM EMPRESA WHERE id_empresa = ?', [req.user.id_empresa]);
        if (rows.length === 0) return res.status(404).json({ error: 'Empresa no encontrada' });
        res.json(rows[0].horarios_disponibilidad || { config: [] });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener disponibilidad' });
    }
});

router.put('/config', async (req, res) => {
    const { items } = req.body;
    try {
        const config = { config: items };
        await pool.execute('UPDATE EMPRESA SET horarios_disponibilidad = ? WHERE id_empresa = ?', [JSON.stringify(config), req.user.id_empresa]);
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar disponibilidad' });
    }
});

router.get('/', async (req, res) => {
    const { prestador_id, fecha } = req.query;

    if (!prestador_id || !fecha) {
        return res.status(400).json({ error: 'Faltan parámetros' });
    }

    try {
        const empId = req.user.id_empresa;
        const [empresaRows] = await pool.execute('SELECT horarios_disponibilidad FROM EMPRESA WHERE id_empresa = ?', [empId]);
        const empresa = empresaRows[0];

        // Fetch turnos for the day
        const dayStart = `${fecha} 00:00:00`;
        const dayEnd = `${fecha} 23:59:59`;
        const [turnos] = await pool.execute(
            'SELECT fecha_hora FROM TURNO WHERE id_prestador = ? AND fecha_hora BETWEEN ? AND ? AND estado != "cancelado"',
            [prestador_id, dayStart, dayEnd]
        );

        const jsDay = new Date(fecha).getDay(); 
        const dayMap = [7, 1, 2, 3, 4, 5, 6]; 
        const targetDay = dayMap[jsDay];

        const config = empresa?.horarios_disponibilidad?.config || [];
        const dayConfig = config.filter(c => c.dia_semana === targetDay);

        let slots = [];
        dayConfig.forEach(range => {
            let current = new Date(`${fecha}T${range.hora_desde}`);
            const endParts = range.hora_hasta.split(':');
            const end = new Date(`${fecha}T${range.hora_hasta}`);

            while (current < end) {
                const hh = String(current.getHours()).padStart(2, '0');
                const mm = String(current.getMinutes()).padStart(2, '0');
                const timeStr = `${hh}:${mm}`;
                
                const isTaken = turnos.some(t => {
                    const rowDate = new Date(t.fecha_hora);
                    const rowHH = String(rowDate.getHours()).padStart(2, '0');
                    const rowMM = String(rowDate.getMinutes()).padStart(2, '0');
                    return `${rowHH}:${rowMM}` === timeStr;
                });

                if (!isTaken) slots.push(timeStr);
                current.setMinutes(current.getMinutes() + SLOT_INTERVAL_MINUTES);
            }
        });

        res.json({ slots });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error calculando disponibilidad' });
    }
});

module.exports = router;
