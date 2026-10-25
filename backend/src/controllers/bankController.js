'use strict';

const bankService = require('../services/bankService');

// ============================================================================
// BANKS
// ============================================================================

async function listBanks(req, res, next) {
  try {
    const banks = await bankService.listBanks(req.user.id);
    return res.status(200).json({
      success: true,
      data: banks,
    });
  } catch (error) {
    next(error);
  }
}

async function createBank(req, res, next) {
  try {
    const body = req.body || {};
    const bankName = (body.bankName || body.name || '').trim();

    if (!bankName) {
      return res.status(400).json({ error: 'Bank name is required.' });
    }

    const newBank = await bankService.createBank(req.user.id, {
      gateway: body.gateway || 'IRCTC',
      bankName,
      userName: body.userName || body.bankUserName || body.upiId || '',
      password: body.password || '',
      nameToSave: body.nameToSave || body.displayName || '',
    });
    return res.status(201).json({
      success: true,
      message: 'Bank saved successfully.',
      data: newBank,
    });
  } catch (error) {
    if (error.status === 409) {
      return res.status(409).json({ error: error.message });
    }
    next(error);
  }
}

async function updateBank(req, res, next) {
  try {
    const bankId = parseInt(req.params.id, 10);
    if (isNaN(bankId) || bankId <= 0) {
      return res.status(400).json({ error: 'Invalid bank ID.' });
    }

    const body = req.body || {};
    const bankName = (body.bankName || body.name || '').trim();

    if (!bankName) {
      return res.status(400).json({ error: 'Bank name is required.' });
    }

    const updated = await bankService.updateBank(req.user.id, bankId, {
      gateway: body.gateway || 'IRCTC',
      bankName,
      userName: body.userName || body.bankUserName || body.upiId || '',
      password: body.password || '',
      nameToSave: body.nameToSave || body.displayName || '',
    });
    return res.status(200).json({
      success: true,
      message: 'Bank updated successfully.',
      data: updated,
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    if (error.status === 409) {
      return res.status(409).json({ error: error.message });
    }
    next(error);
  }
}

async function deleteBank(req, res, next) {
  try {
    const bankId = parseInt(req.params.id, 10);
    if (isNaN(bankId) || bankId <= 0) {
      return res.status(400).json({ error: 'Invalid bank ID.' });
    }

    await bankService.deleteBank(req.user.id, bankId);
    return res.status(200).json({
      success: true,
      message: 'Bank deleted successfully.',
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
}

async function deleteAllBanks(req, res, next) {
  try {
    const count = await bankService.deleteAllBanks(req.user.id);
    return res.status(200).json({
      success: true,
      message: `${count} banks deleted successfully.`,
    });
  } catch (error) {
    next(error);
  }
}

// ============================================================================
// CARDS (DEBIT / CREDIT)
// ============================================================================

async function listCards(req, res, next) {
  try {
    const cardType = req.query.type ? String(req.query.type).toUpperCase() : null;
    const cards = await bankService.listCards(req.user.id, cardType);
    return res.status(200).json({
      success: true,
      data: cards,
    });
  } catch (error) {
    next(error);
  }
}

async function createCard(req, res, next) {
  try {
    const body = req.body || {};
    const newCard = await bankService.createCard(req.user.id, body);
    return res.status(201).json({
      success: true,
      message: 'Card saved successfully.',
      data: newCard,
    });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
}

async function updateCard(req, res, next) {
  try {
    const cardId = parseInt(req.params.id, 10);
    if (isNaN(cardId) || cardId <= 0) {
      return res.status(400).json({ error: 'Invalid card ID.' });
    }

    const body = req.body || {};
    const updated = await bankService.updateCard(req.user.id, cardId, body);
    return res.status(200).json({
      success: true,
      message: 'Card updated successfully.',
      data: updated,
    });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ error: error.message });
    }
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
}

async function deleteCard(req, res, next) {
  try {
    const cardId = parseInt(req.params.id, 10);
    if (isNaN(cardId) || cardId <= 0) {
      return res.status(400).json({ error: 'Invalid card ID.' });
    }

    await bankService.deleteCard(req.user.id, cardId);
    return res.status(200).json({
      success: true,
      message: 'Card deleted successfully.',
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
}

async function deleteAllCards(req, res, next) {
  try {
    const cardType = req.query.type ? String(req.query.type).toUpperCase() : null;
    const count = await bankService.deleteAllCards(req.user.id, cardType);
    return res.status(200).json({
      success: true,
      message: `${count} cards deleted successfully.`,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listBanks,
  createBank,
  updateBank,
  deleteBank,
  deleteAllBanks,
  listCards,
  createCard,
  updateCard,
  deleteCard,
  deleteAllCards,
};
