const authService = require('../services/authService');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required: No token provided or invalid format.' });
  }

  const token = authHeader.split(' ')[1];

  const decoded = authService.verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Authentication failed: Invalid or expired token.' });
  }

  // Attach user payload to the request
  req.user = { id: decoded.id, role: decoded.role };
  next();
}

function optionalAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const decoded = authService.verifyToken(token);
    if (decoded) {
      req.user = { id: decoded.id, role: decoded.role };
    }
  }
  next();
}

function authorize(requiredRoles) {
  return (req, res, next) => {
    if (!req.user) {
      // This should ideally not happen if authenticate runs before authorize
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (!requiredRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access forbidden: Insufficient role permissions.' });
    }
    next();
  };
}

module.exports = {
  authenticate,
  optionalAuthenticate,
  authorize,
};