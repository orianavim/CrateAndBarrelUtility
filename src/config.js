'use strict';

require('dotenv').config();

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return String(v).toLowerCase() === 'true' || v === '1';
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  // Selectable Grasshopper environments shown on the login screen.
  envs: {
    staging: 'https://staging.grasshopperlabs.io',
    production: 'https://pulsefinalmile.grasshopperlabs.net',
  },
  gh: {
    baseUrl: (process.env.GH_BASE_URL || '').replace(/\/+$/, ''),
    email: process.env.GH_EMAIL || '',
    password: process.env.GH_PASSWORD || '',
  },
  mockMode: bool(process.env.MOCK_MODE, true),
  cancelReason: process.env.CANCEL_REASON || 'Not on Crate & Barrel delivery file',
  // Default retailer (account) to scope order lookups to. Can be overridden per
  // session from the login screen. Without it, the tool lists ALL retailers.
  retailerId: process.env.GH_RETAILER_ID || '',
};

// Resolve a base URL from an env key ("staging"/"production"); fall back to GH_BASE_URL.
config.resolveBaseUrl = function (envKey) {
  if (envKey && config.envs[envKey]) return config.envs[envKey].replace(/\/+$/, '');
  return config.gh.baseUrl;
};

// Credentials are now collected at the login screen, so we no longer need
// GH_EMAIL / GH_PASSWORD in .env. MOCK_MODE simply controls whether the login
// screen offers a "continue without credentials" path for safe local testing.

module.exports = config;
