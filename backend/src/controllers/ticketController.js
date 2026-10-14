'use strict';

const ticketService = require('../services/ticketService');
const irctcAutomationService = require('../automation/irctc/irctcAutomationService');
const railwayTrainSearchService = require('../services/railwayTrainSearchService');
const ghumoTrainSearchService = require('../services/ghumoTrainSearchService');

const { resolveBrowserConfig, checkAllBrowsersAvailability } = require('../automation/browserConfig');

/**
 * Controller for ticket operations and high-speed train search.
 */
async function searchTrains(req, res, next) {
  try {
    const { fromStation, toStation, journeyDate, quota, travelClass } = req.body || {};

    if (!fromStation || !toStation) {
      return res.status(400).json({ error: 'From Station and To Station are required.' });
    }
    if (!journeyDate) {
      return res.status(400).json({ error: 'Journey Date is required.' });
    }

    const trains = await railwayTrainSearchService.searchTrains({
      fromStation,
      toStation,
      journeyDate,
      quota,
      travelClass,
    });

    return res.status(200).json({
      success: true,
      data: trains,
    });
  } catch (error) {
    next(error);
  }
}


async function save(req, res, next) {
  try {
    const ticket = await ticketService.saveTicket(req.user.id, req.body);
    return res.status(201).json({
      success: true,
      message: 'Ticket saved successfully.',
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (isNaN(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID.' });
    }

    const ticket = await ticketService.updateTicket(req.user.id, ticketId, req.body);
    return res.status(200).json({
      success: true,
      message: 'Ticket updated successfully.',
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
}

async function list(req, res, next) {
  try {
    const tickets = await ticketService.listTickets(req.user.id);
    return res.status(200).json({
      success: true,
      data: tickets,
    });
  } catch (error) {
    next(error);
  }
}

async function getById(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (isNaN(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID.' });
    }

    const ticket = await ticketService.getTicketById(req.user.id, ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }

    return res.status(200).json({
      success: true,
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (isNaN(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID.' });
    }

    const deleted = await ticketService.deleteTicket(req.user.id, ticketId);
    if (!deleted) {
      return res.status(404).json({ error: 'Ticket not found or access denied.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Ticket deleted successfully.',
    });
  } catch (error) {
    next(error);
  }
}

async function removeAll(req, res, next) {
  try {
    const deletedCount = await ticketService.deleteAllTickets(req.user.id);
    return res.status(200).json({
      success: true,
      message: `Deleted ${deletedCount} tickets successfully.`,
      deletedCount,
    });
  } catch (error) {
    next(error);
  }
}

async function launchBrowser(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (isNaN(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID.' });
    }

    const { webId, browserKey } = req.body || {};
    const identifier = browserKey || webId;
    if (!identifier) {
      return res.status(400).json({ error: 'Browser selection (chrome, edge, brave, opera, comet) is required.' });
    }

    const browserConfig = resolveBrowserConfig(identifier);
    if (!browserConfig || !browserConfig.isAvailable || !browserConfig.executablePath) {
      return res.status(404).json({
        error: `${browserConfig?.name || identifier} is not installed or cannot be launched for automation.`,
      });
    }

    const ticket = await ticketService.getTicketById(req.user.id, ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }

    const { stopPayment = false, proxyId = null } = req.body || {};
    const result = await irctcAutomationService.launchTicketBrowser(req.user.id, ticket, browserConfig, {
      stopPayment: Boolean(stopPayment),
      proxyId,
    });

    return res.status(200).json({
      success: true,
      message: `Launched ${browserConfig.name} for ticket "${ticket.ticketName}".`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function prepareBrowser(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (isNaN(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID.' });
    }

    const { webId, browserKey } = req.body || {};
    const identifier = browserKey || webId || 'chrome';

    const browserConfig = resolveBrowserConfig(identifier);
    if (!browserConfig || !browserConfig.isAvailable || !browserConfig.executablePath) {
      return res.status(404).json({
        error: `${browserConfig?.name || identifier} is not installed or cannot be launched for automation.`,
      });
    }

    const ticket = await ticketService.getTicketById(req.user.id, ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }

    const result = await irctcAutomationService.prepareTicketBrowser(req.user.id, ticket, browserConfig);

    return res.status(200).json({
      success: true,
      message: `${browserConfig.name} prepared successfully for ticket "${ticket.ticketName}".`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function startBooking(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (isNaN(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID.' });
    }

    const ticket = await ticketService.getTicketById(req.user.id, ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }

    const { stopPayment = false } = req.body || {};
    const bookingStatus = await irctcAutomationService.startTicketBooking(req.user.id, ticketId, {
      stopPayment: Boolean(stopPayment),
      ticket,
    });

    return res.status(200).json({
      success: true,
      data: bookingStatus,
    });
  } catch (error) {
    next(error);
  }
}

async function stopBooking(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (isNaN(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID.' });
    }

    const bookingStatus = await irctcAutomationService.stopTicketBooking(req.user.id, ticketId);
    return res.status(200).json({
      success: true,
      data: bookingStatus,
    });
  } catch (error) {
    next(error);
  }
}

async function getBookingStatus(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (isNaN(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID.' });
    }

    const bookingStatus = irctcAutomationService.getBookingStatus(req.user.id, ticketId);
    return res.status(200).json({
      success: true,
      data: bookingStatus,
    });
  } catch (error) {
    next(error);
  }
}

async function getAvailability(req, res, next) {
  try {
    const ticketId = parseInt(req.params.id, 10);
    if (isNaN(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: 'Invalid ticket ID.' });
    }

    const ticket = await ticketService.getTicketById(req.user.id, ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }

    const availabilityResult = await railwayTrainSearchService.checkAvailability({
      trainNumber: ticket.trainNumber,
      fromStation: ticket.fromStation,
      toStation: ticket.toStation,
      journeyDate: ticket.journeyDate,
      travelClass: ticket.selectedClass,
      quota: ticket.quota,
    });

    return res.status(200).json({
      success: true,
      data: availabilityResult,
    });
  } catch (error) {
    next(error);
  }
}

async function checkAvailabilityDirect(req, res, next) {
  try {
    const { trainNumber, fromStation, toStation, journeyDate, travelClass, quota, trainType } = req.body || {};

    if (!trainNumber || !fromStation || !toStation || !journeyDate) {
      return res.status(400).json({
        error: 'trainNumber, fromStation, toStation, and journeyDate are required.',
      });
    }

    const availabilityResult = await railwayTrainSearchService.checkAvailability({
      trainNumber,
      fromStation,
      toStation,
      journeyDate,
      travelClass,
      quota,
      trainType,
    });

    return res.status(200).json({
      success: true,
      data: availabilityResult,
    });
  } catch (error) {
    next(error);
  }
}

async function getBrowserAvailability(req, res, next) {
  try {
    const results = checkAllBrowsersAvailability();
    return res.status(200).json({
      success: true,
      data: results,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  searchTrains,
  save,
  update,
  list,
  getById,
  remove,
  removeAll,
  launchBrowser,
  prepareBrowser,
  startBooking,
  stopBooking,
  getBookingStatus,
  getAvailability,
  checkAvailabilityDirect,
  getBrowserAvailability,
};

