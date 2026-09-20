function errorHandler(err, req, res, next) {
  console.error(err); // Log the error for debugging purposes

  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || 'An unexpected error occurred.';

  // For production, avoid sending detailed error messages to the client
  // except for known operational errors.
  const response = {
    error: message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.stage ? { stage: err.stage } : {}),
  };

  if (process.env.NODE_ENV === 'development' && err.stack) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

module.exports = errorHandler;