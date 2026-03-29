const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middlewares/auth.middleware');
const {
    buildAvailabilityMap,
    resolveEffectiveAvailability,
    toAvailabilityPayload,
} = require('../utils/availabilitySchedule');

router.use(authMiddleware);

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
        const prestadorIdFromQuery = req.query.prestador_id || null;
        const scope = await getPrestadorScope(req, prestadorIdFromQuery);

        if (scope.error) {
            return res.status(scope.error.status).json({ error: scope.error.message });
        }

        res.json({
            scope: scope.effective.scope,
            source: scope.effective.source,
            prestador_id: scope.prestadorId,
            config: scope.effective.config,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener disponibilidad' });
    }
});

router.put('/config', async (req, res) => {
    const { items, prestador_id: prestadorIdFromBody } = req.body;
    const prestadorIdFromQuery = req.query.prestador_id || null;
    const prestadorIdInput = prestadorIdFromBody || prestadorIdFromQuery;

    if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'items debe ser un array' });
    }

    try {
        const payload = JSON.stringify({ config: items });
        const companyId = req.user.id_empresa;

        if (req.user.rol === 'prestador') {
            const ownPrestadorId = Number(req.user.id_prestador);
            if (!ownPrestadorId) {
                return res.status(403).json({ error: 'No tenés un prestador asociado' });
            }

            if (prestadorIdInput && Number(prestadorIdInput) !== ownPrestadorId) {
                return res.status(403).json({ error: 'No podés modificar el horario de otro prestador' });
            }

            const [result] = await pool.execute(
                'UPDATE PRESTADOR SET horarios_disponibilidad = ? WHERE id_prestador = ? AND id_empresa = ?',
                [payload, ownPrestadorId, companyId]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Prestador no encontrado' });
            }

            return res.json({
                scope: 'prestador',
                source: 'own',
                prestador_id: ownPrestadorId,
                config: { config: items },
            });
        }

        if (prestadorIdInput) {
            const prestadorId = Number(prestadorIdInput);
            if (!prestadorId) {
                return res.status(400).json({ error: 'prestador_id inválido' });
            }

            const [result] = await pool.execute(
                'UPDATE PRESTADOR SET horarios_disponibilidad = ? WHERE id_prestador = ? AND id_empresa = ?',
                [payload, prestadorId, companyId]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Prestador no encontrado' });
            }

            return res.json({
                scope: 'prestador',
                source: 'own',
                prestador_id: prestadorId,
                config: { config: items },
            });
        }

        const [result] = await pool.execute(
            'UPDATE EMPRESA SET horarios_disponibilidad = ? WHERE id_empresa = ?',
            [payload, companyId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Empresa no encontrada' });
        }

        res.json({
            scope: 'empresa',
            source: 'own',
            prestador_id: null,
            config: { config: items },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar disponibilidad' });
    }
});

router.get('/', async (req, res) => {
    const prestadorIdFromQuery = req.query.prestador_id || null;
    const { fecha, servicio_id, empresa_id } = req.query;

    if (!fecha) {
        return res.status(400).json({ error: 'Falta el parámetro fecha' });
    }

    try {
        const scope = await getPrestadorScope(req, prestadorIdFromQuery);
        if (scope.error) {
            return res.status(scope.error.status).json({ error: scope.error.message });
        }

        if (!scope.prestadorId) {
            return res.status(400).json({ error: 'Falta el parámetro prestador_id' });
        }

        const configMap = buildAvailabilityMap(scope.effective.config);

        // Parsear la fecha en UTC para evitar desfases por zona horaria del servidor
        const [year, month, day] = fecha.split('-').map(Number);
        const fechaUTC = new Date(Date.UTC(year, month - 1, day));
        const jsDay = fechaUTC.getUTCDay(); // 0=dom,1=lun...6=sab
        const dayMap = [7, 1, 2, 3, 4, 5, 6];
        const targetDay = dayMap[jsDay];
        const dayConfig = configMap[targetDay] || [];

        // Si la empresa no trabaja ese día, devolver vacío directamente
        if (!dayConfig.length) {
            return res.json({ slots: [] });
        }

        // Obtener duración real del servicio si se indicó
        let duracionMinutos = 30;
        if (servicio_id) {
            const companyId = empresa_id || req.user.id_empresa;
            const [svcRows] = await pool.execute(
                'SELECT duracion_minutos FROM SERVICIO WHERE id_servicio = ? AND id_empresa = ?',
                [Number(servicio_id), Number(companyId)]
            );
            if (svcRows.length > 0) {
                duracionMinutos = svcRows[0].duracion_minutos || 30;
            }
        }

        const dayStart = `${fecha} 00:00:00`;
        const dayEnd = `${fecha} 23:59:59`;
        const [turnos] = await pool.execute(
            `SELECT t.fecha_hora, COALESCE(s.duracion_minutos, 30) AS duracion_minutos
             FROM TURNO t
             LEFT JOIN SERVICIO s ON t.id_servicio = s.id_servicio
             WHERE t.id_prestador = ? AND t.fecha_hora BETWEEN ? AND ? AND t.estado != "cancelado"`,
            [scope.prestadorId, dayStart, dayEnd]
        );

        const slots = [];
        const now = new Date();

        for (const range of dayConfig) {
            // Forzar UTC para que los horarios configurados se respeten tal cual
            let current = new Date(`${fecha}T${range.start}:00Z`);
            const end = new Date(`${fecha}T${range.end}:00Z`);

            while (current < end) {
                const slotEnd = new Date(current.getTime() + duracionMinutos * 60000);

                // El slot tiene que caber completo dentro del rango
                if (slotEnd > end) break;

                // No mostrar slots pasados
                if (current <= now) {
                    current = new Date(current.getTime() + duracionMinutos * 60000);
                    continue;
                }

                const hh = String(current.getUTCHours()).padStart(2, '0');
                const mm = String(current.getUTCMinutes()).padStart(2, '0');
                const timeStr = `${hh}:${mm}`;

                // Verificar solapamiento real con turnos existentes
                const isTaken = turnos.some((t) => {
                    const tStart = new Date(t.fecha_hora);
                    const tEnd = new Date(tStart.getTime() + t.duracion_minutos * 60000);
                    return current < tEnd && slotEnd > tStart;
                });

                if (!isTaken) slots.push(timeStr);
                current = new Date(current.getTime() + duracionMinutos * 60000);
            }
        }

        res.json({ slots });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error calculando disponibilidad' });
    }
});

module.exports = router;
