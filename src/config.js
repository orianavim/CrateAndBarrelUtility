'use strict';

require('dotenv').config();

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return String(v).toLowerCase() === 'true' || v === '1';
}

const mockMode = bool(process.env.MOCK_MODE, true);

// The only production environment. Live (non-mock) servers connect here and
// nowhere else — there is no staging option in production.
const PRODUCTION_URL = 'https://pulsefinalmile.grasshopperlabs.net';
const STAGING_URL = 'https://staging.grasshopperlabs.io';

// Environments offered on the login screen. Production is the single live env.
// Staging is only available in mock/dev mode for testing; a live server exposes
// production only.
const envs = mockMode ? { staging: STAGING_URL, production: PRODUCTION_URL } : { production: PRODUCTION_URL };

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  envs,
  // Default environment selected on the login screen.
  defaultEnv: envs.staging ? 'staging' : 'production',
  gh: {
    baseUrl: (process.env.GH_BASE_URL || '').replace(/\/+$/, ''),
    email: process.env.GH_EMAIL || '',
    password: process.env.GH_PASSWORD || '',
  },
  mockMode,
  cancelReason: process.env.CANCEL_REASON || 'Not on Crate & Barrel delivery file',
  // Default retailer (account) to scope order lookups to. Can be overridden per
  // session from the login screen. Without it, the tool lists ALL retailers.
  retailerId: process.env.GH_RETAILER_ID || '',
};

// Resolve a base URL from an env key; fall back to the default environment
// (never to an env that isn't offered on this server).
config.resolveBaseUrl = function (envKey) {
  if (envKey && config.envs[envKey]) return config.envs[envKey].replace(/\/+$/, '');
  if (config.gh.baseUrl) return config.gh.baseUrl;
  return config.envs[config.defaultEnv].replace(/\/+$/, '');
};

// Credentials are now collected at the login screen, so we no longer need
// GH_EMAIL / GH_PASSWORD in .env. MOCK_MODE simply controls whether the login
// screen offers a "continue without credentials" path for safe local testing.

module.exports = config;
