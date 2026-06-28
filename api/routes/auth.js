const express = require('express');
const { wrap, ok, getToken } = require('../helpers');
const authService = require('../../lib/authService');
const dataService = require('../../lib/dataService');

const router = express.Router();

/** Ported from buildBootstrap_() in Code.gs. */
function parseUserPersonMap(settings) {
  const m = settings.userPersonMap;
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m); } catch (e) { return {}; }
}

async function buildBootstrap(user) {
  const settings = await dataService.getSettings();
  user.personId = parseUserPersonMap(settings)[user.userId] || '';
  return {
    user,
    permissions: await authService.getEffectivePermissions(user),
    settings,
    people: await dataService.getPeople()
  };
}

// POST /api/auth/login  — api_login(email, password)
router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  const result = await authService.login(email, password);
  result.bootstrap = await buildBootstrap(result.user);
  ok(res, result);
}));

// POST /api/auth/logout — api_logout(token)
router.post('/logout', wrap(async (req, res) => {
  const token = getToken(req);
  const result = await authService.logout(token);
  ok(res, result);
}));

module.exports = { router, buildBootstrap };
