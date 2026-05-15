-- ============================================================================
-- DIAGNOSTICO: Estado actual de fechas en TURNO
-- ============================================================================
-- Ejecutar en TiDB Cloud / MySQL cliente
-- Esta query muestra como esta guardado cada turno y si esta en UTC o local
-- ============================================================================

SELECT 
    t.id_turno,
    t.origen,
    t.estado,
    -- Valor crudo como esta guardado en MySQL
    t.fecha_hora AS valor_crudo_db,
    
    -- Si el valor fuera UTC, que hora ART seria
    CONVERT_TZ(t.fecha_hora, '+00:00', '-03:00') AS si_es_utc_hora_art,
    
    -- Si el valor fuera ART local, que hora UTC seria
    CONVERT_TZ(t.fecha_hora, '-03:00', '+00:00') AS si_es_art_hora_utc,
    
    -- Hora actual del servidor MySQL (UTC en TiDB Cloud)
    NOW() AS ahora_mysql_utc,
    
    -- Diferencia entre ahora y el turno (en horas)
    TIMESTAMPDIFF(HOUR, NOW(), t.fecha_hora) AS horas_hasta_turno,
    
    -- Para identificar el turno
    c.nombre_wa AS cliente,
    s.nombre AS servicio

FROM TURNO t
JOIN CLIENTE c ON c.id_cliente = t.id_cliente
JOIN SERVICIO s ON s.id_servicio = t.id_servicio

WHERE t.estado IN ('pendiente', 'pendiente_confirmacion', 'confirmado')
  AND t.fecha_hora >= DATE_SUB(NOW(), INTERVAL 7 DAY)

ORDER BY t.fecha_hora ASC
LIMIT 20;


-- ============================================================================
-- ANALISIS RAPIDO: detectar si los datos estan en UTC o local
-- ============================================================================
-- Si los turnos whatsapp tienen hora_cruda que coincide con la hora ART esperada
-- (ej: turno pedido a las 16:00 muestra 16:00 en valor_crudo_db)
-- → estan guardados en LOCAL (necesitan +3h para convertir a UTC)
--
-- Si los turnos whatsapp tienen hora_cruda 3 horas mas que la hora ART esperada
-- (ej: turno pedido a las 16:00 muestra 19:00 en valor_crudo_db)
-- → ya estan en UTC (correcto)
-- ============================================================================


-- ============================================================================
-- QUERY DE VERIFICACION POST-MIGRACION
-- ============================================================================
-- Despues de aplicar la migracion, ejecutar esto para confirmar que todo esta
-- en UTC. Todos los turnos deberian tener valor_crudo_db = hora_art_esperada + 3h
-- ============================================================================

SELECT 
    t.id_turno,
    t.origen,
    t.fecha_hora AS valor_crudo_db,
    CONVERT_TZ(t.fecha_hora, '+00:00', '-03:00') AS hora_art_correcta,
    CASE 
        WHEN HOUR(t.fecha_hora) >= 3 AND HOUR(t.fecha_hora) <= 2 
        THEN 'POSIBLE_PROBLEMA'
        ELSE 'OK_UTC'
    END AS estado_timezone
FROM TURNO t
WHERE t.estado IN ('pendiente', 'pendiente_confirmacion', 'confirmado')
  AND t.fecha_hora >= DATE_SUB(NOW(), INTERVAL 30 DAY)
ORDER BY t.fecha_hora ASC;
