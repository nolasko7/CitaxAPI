CREATE TABLE `NOTIFICACION` (
  `id_notificacion` INT NOT NULL AUTO_INCREMENT,
  `id_empresa` INT NOT NULL,
  `tipo` VARCHAR(50) NOT NULL,
  `titulo` VARCHAR(255) NOT NULL,
  `descripcion` TEXT NULL,
  `metadata` JSON NULL,
  `appointment_id` INT NULL,
  `read_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (`id_notificacion`),
  INDEX `idx_notificacion_empresa_created` (`id_empresa`, `created_at`),
  INDEX `idx_notificacion_empresa_read` (`id_empresa`, `read_at`),
  CONSTRAINT `fk_notificacion_empresa`
    FOREIGN KEY (`id_empresa`) REFERENCES `EMPRESA`(`id_empresa`)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT `fk_notificacion_turno`
    FOREIGN KEY (`appointment_id`) REFERENCES `TURNO`(`id_turno`)
    ON DELETE SET NULL
    ON UPDATE NO ACTION
);
