'use strict';

const historyService = require('../services/historyService');

async function listHistory(req, res, next) {
  try {
    const history = await historyService.getHistory(req.user.id);
    const retentionDays = await historyService.getRetentionSetting(req.user.id);
    res.json({ ok: true, history, retentionDays });
  } catch (err) {
    next(err);
  }
}

async function createHistoryRecord(req, res, next) {
  try {
    const record = await historyService.addHistory(req.user.id, req.body);
    res.status(201).json({ ok: true, record });
  } catch (err) {
    next(err);
  }
}

async function clearAllHistory(req, res, next) {
  try {
    await historyService.clearHistory(req.user.id);
    res.json({ ok: true, message: 'All booking history deleted successfully.' });
  } catch (err) {
    next(err);
  }
}

async function updateRetention(req, res, next) {
  try {
    const { days } = req.body;
    const result = await historyService.setRetentionSetting(req.user.id, days);
    res.json({ ok: true, retentionDays: result.history_retention_days });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listHistory,
  createHistoryRecord,
  clearAllHistory,
  updateRetention,
};
