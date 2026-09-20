'use strict';

/**
 * Validation helpers and Express middleware powered by Zod.
 */

function formatZodError(error) {
  if (!error || !error.issues || error.issues.length === 0) {
    return 'Invalid request data.';
  }
  return error.issues[0].message;
}

function validate(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data, error: null };
  }
  return {
    success: false,
    data: null,
    error: formatZodError(result.error),
    issues: result.error.issues,
  };
}

function validateBody(schema) {
  return (req, res, next) => {
    const result = validate(schema, req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    req.validatedBody = result.data;
    next();
  };
}

module.exports = {
  formatZodError,
  validate,
  validateBody,
};

