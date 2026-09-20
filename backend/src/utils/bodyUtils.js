'use strict';

// Shared request-body allow-listing. Any field outside the allow-list is
// rejected. Used by account and license modules so mass assignment is
// impossible everywhere.

const { badRequest } = require('./httpError');

function pickAllowed(body, allowedKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  const extra = Object.keys(body).filter((key) => !allowedKeys.includes(key));
  if (extra.length > 0) {
    const label = extra.length > 1 ? 'fields' : 'field';
    throw badRequest(`Unexpected ${label}: ${extra.join(', ')}.`);
  }
  const picked = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) picked[key] = body[key];
  }
  return picked;
}

module.exports = { pickAllowed };
