/**
 * Middleware factory that restricts access to users with the specified role(s).
 * Usage: requireRole('admin_empresa')  or  requireRole('admin_empresa', 'prestador')
 */
const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.rol)) {
            return res.status(403).json({ error: 'No tenés permisos para realizar esta acción' });
        }
        next();
    };
};

module.exports = { requireRole };
