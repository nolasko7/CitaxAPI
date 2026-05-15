-- ============================================================================
-- MIGRACION: Normalizar todos los turnos a UTC
-- ============================================================================
-- PRE-REQUISITO: Ejecutar diagnostico_timezone.sql PRIMERO para verificar
-- el estado actual de los datos.
--
-- CONTEXTO:
--   - Antes de este fix, Prisma guardaba WhatsApp en UTC pero mysql2 guardaba
--     manual/pagina en hora local (ART). Esto creaba inconsistencia.
--   - Con el fix (timezone: 'Z' en mysql2 + construccion UTC en INSERTs),
--     todos los nuevos turnos se guardan en UTC.
--   - Esta migracion normaliza los datos existentes.
--
-- DECISION:
--   Si la migracion anterior (20260514_fix_ai_turnos_timezone.sql) fue ejecutada:
--     → WhatsApp fue shifted -3h (ahora en local), manual nunca se toco (local)
--     → AMBOS necesitan +3h para estar en UTC
--
--   Si la migracion anterior NO fue ejecutada:
--     → WhatsApp esta en UTC (correcto), manual esta en local
--     → Solo manual necesita +3h
-- ============================================================================

-- OPCION A: Si la migracion anterior SI fue ejecutada (recomendada)
-- Convierte TODO a UTC sumando 3 horas
BEGIN;

UPDATE TURNO
SET fecha_hora = DATE_ADD(fecha_hora, INTERVAL 3 HOUR)
WHERE origen IN ('whatsapp', 'manual', 'pagina')
  AND fecha_hora IS NOT NULL;

COMMIT;


-- OPCION B: Si la migracion anterior NO fue ejecutada
-- Solo convierte manual/pagina a UTC (whatsapp ya esta en UTC)
/*
BEGIN;

UPDATE TURNO
SET fecha_hora = DATE_ADD(fecha_hora, INTERVAL 3 HOUR)
WHERE origen IN ('manual', 'pagina')
  AND fecha_hora IS NOT NULL;

COMMIT;
*/


-- ============================================================================
-- VERIFICACION POST-MIGRACION
-- ============================================================================
-- Despues de ejecutar la migracion, correr esto:
--
-- SELECT 
--     id_turno,
--     origen,
--     fecha_hora AS valor_crudo_db,
--     CONVERT_TZ(fecha_hora, '+00:00', '-03:00') AS hora_art
-- FROM TURNO
-- WHERE estado IN ('pendiente', 'pendiente_confirmacion', 'confirmado')
--   AND fecha_hora >= DATE_SUB(NOW(), INTERVAL 7 DAY)
-- ORDER BY fecha_hora ASC;
--
-- La hora_art deberia coincidir con la hora real del turno ART.
-- ============================================================================
