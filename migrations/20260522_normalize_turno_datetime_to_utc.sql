-- ============================================================================
-- MIGRACION: normalizar TURNO.fecha_hora a UTC literal
-- ============================================================================
-- Contexto:
--   TURNO.fecha_hora es DATETIME(0). No guarda timezone.
--   La app ahora interpreta este DATETIME como instante UTC literal.
--   Si los turnos activos/futuros existentes fueron guardados como reloj ART
--   literal, hay que sumar 3 horas una sola vez.
--
-- IMPORTANTE:
--   Ejecutar primero el diagnostico y backup. No correr dos veces.
-- ============================================================================

-- 1) Diagnostico previo
SELECT
  t.id_turno,
  t.origen,
  t.estado,
  t.fecha_hora AS valor_actual,
  CONVERT_TZ(t.fecha_hora, '-03:00', '+00:00') AS valor_utc_post_migracion,
  c.nombre_wa AS cliente
FROM TURNO t
JOIN CLIENTE c ON c.id_cliente = t.id_cliente
WHERE t.estado IN ('pendiente', 'pendiente_confirmacion', 'confirmado')
  AND t.fecha_hora >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 12 HOUR)
ORDER BY t.fecha_hora ASC
LIMIT 50;

-- 2) Migracion
BEGIN;

UPDATE TURNO
SET fecha_hora = DATE_ADD(fecha_hora, INTERVAL 3 HOUR)
WHERE estado IN ('pendiente', 'pendiente_confirmacion', 'confirmado')
  AND fecha_hora >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 12 HOUR);

COMMIT;

-- 3) Validacion posterior
SELECT
  t.id_turno,
  t.origen,
  t.estado,
  t.fecha_hora AS valor_utc,
  CONVERT_TZ(t.fecha_hora, '+00:00', '-03:00') AS hora_art,
  c.nombre_wa AS cliente
FROM TURNO t
JOIN CLIENTE c ON c.id_cliente = t.id_cliente
WHERE t.estado IN ('pendiente', 'pendiente_confirmacion', 'confirmado')
  AND t.fecha_hora >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 12 HOUR)
ORDER BY t.fecha_hora ASC
LIMIT 50;
