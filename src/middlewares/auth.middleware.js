const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
    // Bypass authentication for webhooks
    if (req.originalUrl.toLowerCase().includes('/webhook')) {
        return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ 
            error: 'No token provided', 
            debug_url: req.originalUrl,
            debug_path: req.path 
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key-citax');
        req.user = decoded; // { id_usuario, email, id_empresa, rol }
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

module.exports = authMiddleware;
