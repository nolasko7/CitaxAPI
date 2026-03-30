const bcrypt = require("bcryptjs");
const pool = require("../config/db");

const authenticateCompanyUser = async ({ email, password }) => {
  const [rows] = await pool.execute("SELECT * FROM USUARIO WHERE email = ?", [email]);
  const user = rows[0];
  if (!user) return null;

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch && password !== user.password_hash) {
    return null;
  }

  const [empresaRows] = await pool.execute("SELECT * FROM EMPRESA WHERE id_usuario = ?", [user.id_usuario]);
  const empresa = empresaRows[0] || null;

  let prestadorData = null;
  if (user.rol === "prestador") {
    const [prestRows] = await pool.execute(
      `SELECT p.id_prestador, p.id_empresa, e.nombre_comercial, e.slug
       FROM PRESTADOR p
       JOIN EMPRESA e ON p.id_empresa = e.id_empresa
       WHERE p.id_usuario = ?`,
      [user.id_usuario]
    );
    prestadorData = prestRows[0] || null;
  }

  const companyId = empresa?.id_empresa || prestadorData?.id_empresa || null;
  if (!companyId) return null;

  return {
    user: {
      id: user.id_usuario,
      email: user.email,
      nombre: user.nombre,
      apellido: user.apellido,
      rol: user.rol,
      id_prestador: prestadorData?.id_prestador || null,
      empresa_id: companyId,
      nombre_comercial: empresa?.nombre_comercial || prestadorData?.nombre_comercial || null,
      slug: empresa?.slug || prestadorData?.slug || null,
    },
    companyId,
  };
};

module.exports = {
  authenticateCompanyUser,
};
