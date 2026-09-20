'use strict';

// Minimal operational error type understood by the central error handler.
// Error handler (utils/errorHandler.js) reads err.statusCode and err.message.
// These errors never carry access keys or other sensitive data.

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function badRequest(message) { return new HttpError(400, message || 'Bad request.'); }
function unauthorized(message) { return new HttpError(401, message || 'Unauthorized.'); }
function forbidden(message)  { return new HttpError(403, message || 'Forbidden.'); }
function notFound(message)   { return new HttpError(404, message || 'Not found.'); }
function conflict(message)   { return new HttpError(409, message || 'Conflict.'); }
function internal(message)   { return new HttpError(500, message || 'Internal server error.'); }

module.exports = {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  internal,
};