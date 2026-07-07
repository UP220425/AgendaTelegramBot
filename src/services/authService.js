const fs = require('fs');
const path = require('path');
const { hasAnyPersonPassword } = require('./personPasswordService');

const DATA_DIR = path.join(process.cwd(), 'data');
const AUTHORIZED_USERS_FILE = path.join(DATA_DIR, 'authorizedUsers.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readAuthorizedUsers() {
  try {
    if (!fs.existsSync(AUTHORIZED_USERS_FILE)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(AUTHORIZED_USERS_FILE, 'utf8') || '{}');
  } catch (error) {
    return {};
  }
}

function writeAuthorizedUsers(users) {
  ensureDataDir();
  fs.writeFileSync(AUTHORIZED_USERS_FILE, `${JSON.stringify(users, null, 2)}\n`);
}

function isBootstrapPasswordConfigured() {
  return Boolean(String(process.env.BOT_ACCESS_PASSWORD || '').trim());
}

function isBootstrapPasswordValid(value) {
  const configuredPassword = String(process.env.BOT_ACCESS_PASSWORD || '').trim();
  return Boolean(configuredPassword) && String(value || '').trim() === configuredPassword;
}

function isAccessPasswordConfigured() {
  return true;
}

function getAuthorizedUser(userId) {
  if (!userId) {
    return null;
  }

  return readAuthorizedUsers()[String(userId)] || null;
}

function isUserAuthorized(userId) {
  if (!isAccessPasswordConfigured()) {
    return true;
  }

  const user = getAuthorizedUser(userId);
  return Boolean(user && user.isActive !== false);
}

function isUserRevoked(userId) {
  const user = getAuthorizedUser(userId);
  return Boolean(user && user.isActive === false);
}

function authorizeUser(ctx, personName = '') {
  const userId = ctx.from?.id;

  if (!userId) {
    return null;
  }

  const users = readAuthorizedUsers();
  const key = String(userId);

  users[key] = {
    ...users[key],
    userId,
    chatId: ctx.chat?.id || users[key]?.chatId || userId,
    chatType: ctx.chat?.type || users[key]?.chatType || '',
    telegramUsername: ctx.from?.username || '',
    firstName: ctx.from?.first_name || '',
    lastName: ctx.from?.last_name || '',
    personName,
    isActive: true,
    authorizedAt: users[key]?.authorizedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  writeAuthorizedUsers(users);
  return users[key];
}

function clearAuthorizedUser(userId) {
  if (!userId) {
    return null;
  }

  const users = readAuthorizedUsers();
  const key = String(userId);
  const current = users[key] || null;

  if (!current || current.isActive === false) {
    return current;
  }

  delete users[key];
  writeAuthorizedUsers(users);
  return current;
}

function revokeAuthorizedUser(userId, reason = '') {
  if (!userId) {
    return null;
  }

  const users = readAuthorizedUsers();
  const key = String(userId);

  users[key] = {
    ...users[key],
    userId,
    isActive: false,
    revokedAt: new Date().toISOString(),
    revokedReason: reason,
    updatedAt: new Date().toISOString(),
  };

  writeAuthorizedUsers(users);
  return users[key];
}

module.exports = {
  isAccessPasswordConfigured,
  isBootstrapPasswordConfigured,
  isBootstrapPasswordValid,
  getAuthorizedUser,
  isUserAuthorized,
  isUserRevoked,
  authorizeUser,
  clearAuthorizedUser,
  revokeAuthorizedUser,
};
