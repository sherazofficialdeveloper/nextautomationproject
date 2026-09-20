'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Centralized Browser Resolver & Configuration for the 5 supported browsers:
 * 1. Google Chrome
 * 2. Microsoft Edge
 * 3. Brave
 * 4. Opera
 * 5. Comet
 *
 * Provides real executable paths, application-owned Chromium runtime fallback,
 * and background automation diagnostic metadata.
 */

const WINDOWS_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
].filter(Boolean);

const WINDOWS_EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
].filter(Boolean);

const WINDOWS_BRAVE_PATHS = [
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : null,
].filter(Boolean);

const WINDOWS_OPERA_PATHS = [
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Opera', 'launcher.exe') : null,
  'C:\\Program Files\\Opera\\launcher.exe',
  'C:\\Program Files (x86)\\Opera\\launcher.exe',
].filter(Boolean);

const WINDOWS_COMET_PATHS = [
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Comet', 'Application', 'comet.exe') : null,
  'C:\\Program Files\\Comet\\comet.exe',
  'C:\\Program Files (x86)\\Comet\\comet.exe',
].filter(Boolean);

const _pathCache = new Map();
let _cachedAppChromiumPath = undefined;

function clearPathCache() {
  _pathCache.clear();
  _cachedAppChromiumPath = undefined;
}

function findExistingPath(paths) {
  const cacheKey = paths.join('|');
  if (_pathCache.has(cacheKey)) {
    return _pathCache.get(cacheKey);
  }
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) {
        _pathCache.set(cacheKey, p);
        return p;
      }
    } catch {
      // ignore
    }
  }
  _pathCache.set(cacheKey, null);
  return null;
}

const OPTIMIZED_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-ipc-flooding-protection',
  '--window-size=1440,900',
];

/**
 * Locate the application-owned Patchright Chromium runtime or a verified Chromium engine fallback.
 * Checks:
 * 1. Explicit PATCHRIGHT_CHROMIUM_PATH environment variable
 * 2. Patchright Core's bundled chromium executable path
 * 3. ms-playwright directory in LOCALAPPDATA
 * 4. System Edge or Chrome as verified Chromium fallbacks (ensuring automation works out of the box)
 */
function getApplicationChromiumPath() {
  if (process.env.PATCHRIGHT_CHROMIUM_PATH && fs.existsSync(process.env.PATCHRIGHT_CHROMIUM_PATH)) {
    return process.env.PATCHRIGHT_CHROMIUM_PATH;
  }

  try {
    const { chromium } = require('patchright-core');
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {
    // ignore
  }

  if (process.env.LOCALAPPDATA) {
    const msPlaywrightDir = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
    try {
      if (fs.existsSync(msPlaywrightDir)) {
        const entries = fs.readdirSync(msPlaywrightDir);
        for (const entry of entries) {
          if (entry.startsWith('chromium-')) {
            const candidate = path.join(msPlaywrightDir, entry, 'chrome-win64', 'chrome.exe');
            if (fs.existsSync(candidate)) return candidate;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Compatible system Chromium fallback (Edge is bundled with Windows 10/11; Chrome if installed)
  const edgeFallback = findExistingPath(WINDOWS_EDGE_PATHS);
  if (edgeFallback) return edgeFallback;

  const chromeFallback = findExistingPath(WINDOWS_CHROME_PATHS);
  if (chromeFallback) return chromeFallback;

  return null;
}

const SUPPORTED_BROWSERS = ['chrome', 'edge', 'brave', 'opera', 'comet', 'web1', 'web2', 'web3'];

const BROWSER_METADATA = {
  chrome: { name: 'Google Chrome', webId: 'web1', paths: WINDOWS_CHROME_PATHS, channel: 'chrome' },
  web1: { name: 'Google Chrome', webId: 'web1', paths: WINDOWS_CHROME_PATHS, channel: 'chrome' },
  edge: { name: 'Microsoft Edge', webId: 'web2', paths: WINDOWS_EDGE_PATHS, channel: 'msedge' },
  web2: { name: 'Microsoft Edge', webId: 'web2', paths: WINDOWS_EDGE_PATHS, channel: 'msedge' },
  brave: { name: 'Brave', webId: 'brave', paths: WINDOWS_BRAVE_PATHS, channel: null },
  opera: { name: 'Opera', webId: 'opera', paths: WINDOWS_OPERA_PATHS, channel: null },
  comet: { name: 'Comet', webId: 'comet', paths: WINDOWS_COMET_PATHS, channel: null },
};

/**
 * Resolve configuration for a requested browser identifier.
 * If the requested system browser is installed, it is used.
 * If not installed, it safely falls back to the application-owned Patchright Chromium runtime.
 */
function resolveBrowserConfig(identifier) {
  const normalized = String(identifier || '').trim().toLowerCase();

  if (!SUPPORTED_BROWSERS.includes(normalized)) {
    const err = new Error(`Invalid web identifier "${identifier}". Supported options are: chrome, edge, brave, opera, comet.`);
    err.status = 400;
    throw err;
  }

  // Handle custom web3 legacy identifier
  if (normalized === 'web3') {
    const customPath = process.env.BROWSER_WEB3_EXECUTABLE;
    const exists = customPath ? fs.existsSync(customPath) : false;
    const bravePath = findExistingPath(WINDOWS_BRAVE_PATHS);
    const fallbackPath = getApplicationChromiumPath();
    const chosenPath = exists ? customPath : (bravePath || fallbackPath);

    return {
      browserKey: 'web3',
      webId: 'web3',
      name: process.env.BROWSER_WEB3_NAME || 'Third Browser',
      requestedBrowser: 'Third Browser',
      resolvedRuntime: exists ? 'Custom Executable' : (bravePath ? 'System Brave' : 'Application Chromium Runtime'),
      channel: null,
      executablePath: chosenPath,
      isAvailable: Boolean(chosenPath),
      status: chosenPath ? 'Available' : 'Unavailable — browser runtime missing',
      launchMode: 'Background',
      isFallback: !exists && !bravePath,
    };
  }

  const meta = BROWSER_METADATA[normalized];
  const systemPath = findExistingPath(meta.paths);

  if (systemPath) {
    return {
      browserKey: normalized === 'web1' ? 'chrome' : (normalized === 'web2' ? 'edge' : normalized),
      webId: meta.webId,
      name: meta.name,
      requestedBrowser: meta.name,
      resolvedRuntime: `System ${meta.name}`,
      channel: meta.channel,
      executablePath: systemPath,
      isAvailable: true,
      status: 'Available',
      launchMode: 'Background',
      isFallback: false,
    };
  }

  // System browser not found -> Fall back to Application-owned Patchright Chromium runtime
  const appChromium = getApplicationChromiumPath();
  const canonicalKey = normalized === 'web1' ? 'chrome' : (normalized === 'web2' ? 'edge' : normalized);

  if (appChromium) {
    return {
      browserKey: canonicalKey,
      webId: meta.webId,
      name: meta.name,
      requestedBrowser: meta.name,
      resolvedRuntime: 'Application Chromium Runtime',
      channel: null,
      executablePath: appChromium,
      isAvailable: true,
      status: 'Available',
      launchMode: 'Background',
      isFallback: true,
      fallbackReason: `System ${meta.name} is not installed; using application-owned Chromium runtime.`,
    };
  }

  return {
    browserKey: canonicalKey,
    webId: meta.webId,
    name: meta.name,
    requestedBrowser: meta.name,
    resolvedRuntime: null,
    channel: null,
    executablePath: null,
    isAvailable: false,
    status: 'Unavailable — browser runtime missing',
    launchMode: 'Background',
    isFallback: false,
  };
}

/**
 * Lightweight, non-navigating verification of all 5 browsers.
 * Does NOT open visible windows or navigate to IRCTC.
 */
function checkAllBrowsersAvailability() {
  const primaryKeys = ['chrome', 'edge', 'brave', 'opera', 'comet'];
  const results = {};

  for (const key of primaryKeys) {
    try {
      const config = resolveBrowserConfig(key);
      results[key] = {
        browserKey: key,
        name: config.name,
        isAvailable: config.isAvailable,
        status: config.status,
        resolvedRuntime: config.resolvedRuntime,
        isFallback: config.isFallback,
        launchMode: config.launchMode,
      };
    } catch (err) {
      results[key] = {
        browserKey: key,
        name: key,
        isAvailable: false,
        status: 'Error: ' + err.message,
        resolvedRuntime: null,
        isFallback: false,
        launchMode: 'Background',
      };
    }
  }

  return results;
}

const BROWSER_LIFECYCLE = {
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  IN_USE: 'IN_USE',
  IDLE: 'IDLE',
};

/**
 * Pre-warm the Patchright Core engine and memoize browser paths at application startup.
 * Does not launch any visible browser or navigate.
 */
function prewarmEngine() {
  try {
    // 1. Resolve and memoize browser executable paths
    const primaryKeys = ['chrome', 'edge', 'brave', 'opera', 'comet'];
    for (const key of primaryKeys) {
      try {
        resolveBrowserConfig(key);
      } catch {
        // ignore individual resolution failure during warmup
      }
    }

    // 2. Pre-load patchright-core module into memory
    try {
      require('patchright-core');
    } catch {
      // ignore
    }

    return true;
  } catch (err) {
    console.warn('[BrowserConfig] Engine prewarm notice:', err.message);
    return false;
  }
}

module.exports = {
  SUPPORTED_BROWSERS,
  SUPPORTED_WEB_IDS: SUPPORTED_BROWSERS,
  BROWSER_LIFECYCLE,
  resolveBrowserConfig,
  getApplicationChromiumPath,
  checkAllBrowsersAvailability,
  OPTIMIZED_LAUNCH_ARGS,
  clearPathCache,
  prewarmEngine,
};
