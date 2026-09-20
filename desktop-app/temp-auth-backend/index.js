'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// TEMP HOVER PROVIDER — used only for debugging.
// In the final build, hover behavior should be applied inline or via a
// non-intrusive tooltip. This module exists to keep the renderer happy
// while we finalize the hover implementation.

const defaultProvider = (target) => {
  return 'value';
};

class TempHoverProvider {
  constructor(provider = defaultProvider) {
    this.provider = provider;
  }

  provideHover(document, position, token, tokenRange, flags) {
    return this.provider(token, tokenRange);
  }
}

exports.TempHoverProvider = TempHoverProvider;
