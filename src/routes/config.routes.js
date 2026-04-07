const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authMiddleware = require("../middlewares/auth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const { validateBotConfig } = require("../services/ai/promptValidator");
const {
  countCompanyProfessionals,
  ensureSingleProviderSetup,
  getCompanyBotConfig,
  getSingleProviderModeActivationStatus,
  sanitizeBotConfig,
} = require("../services/singleProviderMode.service");

router.use(authMiddleware);

function toSlug(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

const buildPublicLandingUrl = (slug) =>
  slug ? `https://${slug}.citax.com.ar` : "";

const normalizeComparableName = (value) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT config_recordatorios FROM EMPRESA WHERE id_empresa = ?",
      [req.user.id_empresa],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Empresa no encontrada" });

    res.json(rows[0].config_recordatorios || {});
  } catch (err) {
    res.status(500).json({ error: "Error al obtener config" });
  }
});

router.get("/company-profile", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT nombre_comercial, slug FROM EMPRESA WHERE id_empresa = ?",
      [req.user.id_empresa],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Empresa no encontrada" });
    }

    const company = rows[0];

    res.json({
      nombre_comercial: company.nombre_comercial || "",
      slug: company.slug || "",
      public_url: buildPublicLandingUrl(company.slug),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener perfil de empresa" });
  }
});

router.get("/account-profile", async (req, res) => {
  try {
    const [userRows] = await pool.execute(
      "SELECT id_usuario, email, nombre, apellido, rol FROM USUARIO WHERE id_usuario = ? LIMIT 1",
      [req.user.id_usuario],
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const [companyRows] = await pool.execute(
      "SELECT nombre_comercial FROM EMPRESA WHERE id_empresa = ? LIMIT 1",
      [req.user.id_empresa],
    );

    const user = userRows[0];
    const company = companyRows[0] || {};

    res.json({
      email: user.email || "",
      nombre: user.nombre || "",
      apellido: user.apellido || "",
      rol: user.rol || "",
      nombre_comercial: company.nombre_comercial || "",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener perfil de cuenta" });
  }
});

router.put(
  "/company-profile",
  requireRole("admin_empresa"),
  async (req, res) => {
    try {
      const requestedSlug = String(req.body?.slug || "");
      const normalizedSlug = toSlug(requestedSlug);

      if (!normalizedSlug) {
        return res.status(400).json({ error: "El subdominio es obligatorio" });
      }

      if (normalizedSlug.length < 3) {
        return res
          .status(400)
          .json({ error: "El subdominio debe tener al menos 3 caracteres" });
      }

      const [existingRows] = await pool.execute(
        "SELECT id_empresa FROM EMPRESA WHERE slug = ? AND id_empresa <> ? LIMIT 1",
        [normalizedSlug, req.user.id_empresa],
      );

      if (existingRows.length > 0) {
        return res
          .status(409)
          .json({ error: "Ese subdominio ya esta en uso por otra cuenta" });
      }

      await pool.execute("UPDATE EMPRESA SET slug = ? WHERE id_empresa = ?", [
        normalizedSlug,
        req.user.id_empresa,
      ]);

      const [rows] = await pool.execute(
        "SELECT nombre_comercial, slug FROM EMPRESA WHERE id_empresa = ?",
        [req.user.id_empresa],
      );

      const company = rows[0];

      res.json({
        nombre_comercial: company?.nombre_comercial || "",
        slug: company?.slug || normalizedSlug,
        public_url: buildPublicLandingUrl(company?.slug || normalizedSlug),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Error al actualizar el subdominio" });
    }
  },
);

router.put("/account-profile", async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const nombre = String(req.body?.nombre || "").trim();
    const apellido = String(req.body?.apellido || "").trim();
    const nombreComercial = String(req.body?.nombre_comercial || "").trim();

    if (!email || !nombre || !apellido) {
      return res
        .status(400)
        .json({ error: "Nombre, apellido y email son obligatorios" });
    }

    if (req.user.rol === "admin_empresa" && !nombreComercial) {
      return res
        .status(400)
        .json({ error: "El nombre comercial es obligatorio" });
    }

    await connection.beginTransaction();

    const [emailRows] = await connection.execute(
      "SELECT id_usuario FROM USUARIO WHERE email = ? AND id_usuario <> ? LIMIT 1",
      [email, req.user.id_usuario],
    );

    if (emailRows.length > 0) {
      await connection.rollback();
      return res
        .status(409)
        .json({ error: "Ese email ya esta en uso por otra cuenta" });
    }

    if (req.user.rol === "admin_empresa") {
      const [companyNameRows] = await connection.execute(
        "SELECT id_empresa, nombre_comercial FROM EMPRESA WHERE id_empresa <> ?",
        [req.user.id_empresa],
      );

      const duplicatedCompanyName = companyNameRows.some(
        (row) =>
          normalizeComparableName(row.nombre_comercial) ===
          normalizeComparableName(nombreComercial),
      );

      if (duplicatedCompanyName) {
        await connection.rollback();
        return res
          .status(409)
          .json({ error: "Ya existe otra empresa con ese nombre comercial" });
      }
    }

    await connection.execute(
      "UPDATE USUARIO SET email = ?, nombre = ?, apellido = ? WHERE id_usuario = ?",
      [email, nombre, apellido, req.user.id_usuario],
    );

    if (req.user.rol === "admin_empresa") {
      await connection.execute(
        "UPDATE EMPRESA SET nombre_comercial = ? WHERE id_empresa = ?",
        [nombreComercial, req.user.id_empresa],
      );
    }

    await connection.commit();

    res.json({
      email,
      nombre,
      apellido,
      rol: req.user.rol,
      nombre_comercial: req.user.rol === "admin_empresa" ? nombreComercial : "",
    });
  } catch (err) {
    try {
      await connection.rollback();
    } catch (_) {
      // noop
    }
    console.error(err);
    res.status(500).json({ error: "Error al actualizar perfil de cuenta" });
  } finally {
    connection.release();
  }
});

router.put("/", async (req, res) => {
  try {
    await pool.execute(
      "UPDATE EMPRESA SET config_recordatorios = ? WHERE id_empresa = ?",
      [JSON.stringify(req.body), req.user.id_empresa],
    );
    res.json(req.body);
  } catch (err) {
    res.status(500).json({ error: "Error al actualizar config" });
  }
});

router.get("/bot", async (req, res) => {
  try {
    const config = await getCompanyBotConfig(req.user.id_empresa);
    if (config === null)
      return res.status(404).json({ error: "Empresa no encontrada" });

    res.json(config);
  } catch (err) {
    console.error("Error al obtener config bot:", err);
    res.status(500).json({ error: "Error al obtener config del bot" });
  }
});

router.put("/bot", async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Sanear el payload para asegurarnos de que no hay código extraño
    const currentConfig = await getCompanyBotConfig(
      req.user.id_empresa,
      connection,
    );
    if (currentConfig === null) {
      await connection.rollback();
      return res.status(404).json({ error: "Empresa no encontrada" });
    }

    const config = sanitizeBotConfig(req.body || {}, currentConfig);
    const validation = await validateBotConfig(config);

    if (!validation.valid) {
      await connection.rollback();
      return res
        .status(400)
        .json({
          error:
            validation.reason ||
            "Configuración rechazada por el sistema de seguridad (insegura).",
        });
    }

    const enablingSingleProviderMode =
      currentConfig.cuenta_prestador_unico !== true &&
      config.cuenta_prestador_unico === true;

    if (enablingSingleProviderMode) {
      const professionalCount = await countCompanyProfessionals(
        req.user.id_empresa,
        connection,
      );
      const activationStatus =
        getSingleProviderModeActivationStatus(professionalCount);

      if (!activationStatus.allowed) {
        await connection.rollback();
        return res.status(409).json({ error: activationStatus.reason });
      }
    }

    await connection.execute(
      "UPDATE EMPRESA SET bot_config = ? WHERE id_empresa = ?",
      [JSON.stringify(config), req.user.id_empresa],
    );
    if (config.cuenta_prestador_unico) {
      await ensureSingleProviderSetup({
        companyId: req.user.id_empresa,
        executor: connection,
      });
    }

    await connection.commit();
    res.json(config);
  } catch (err) {
    try {
      await connection.rollback();
    } catch (_) {
      // noop
    }
    console.error("Error al actualizar config bot:", err);
    res
      .status(500)
      .json({ error: "Error interno al actualizar la config del bot" });
  } finally {
    connection.release();
  }
});

module.exports = router;
