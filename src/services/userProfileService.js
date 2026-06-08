const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const PROFILE_FILE = path.join(DATA_DIR, 'userProfiles.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readProfiles() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) {
      return {};
    }

    const rawData = fs.readFileSync(PROFILE_FILE, 'utf8');
    return JSON.parse(rawData || '{}');
  } catch (error) {
    return {};
  }
}

function writeProfiles(profiles) {
  ensureDataDir();
  fs.writeFileSync(PROFILE_FILE, `${JSON.stringify(profiles, null, 2)}\n`);
}

function getUserProfile(userId) {
  const profiles = readProfiles();
  return profiles[String(userId)] || null;
}

function setUserProfile(userId, personName, telegramUser = {}, chatId = userId) {
  const profiles = readProfiles();
  const key = String(userId);

  profiles[key] = {
    userId,
    chatId,
    personName,
    telegramUsername: telegramUser.username || '',
    firstName: telegramUser.first_name || '',
    lastName: telegramUser.last_name || '',
    updatedAt: new Date().toISOString(),
  };

  writeProfiles(profiles);
  return profiles[key];
}

function getAllUserProfiles() {
  return Object.values(readProfiles());
}

function deleteUserProfile(userId) {
  const profiles = readProfiles();
  delete profiles[String(userId)];
  writeProfiles(profiles);
}

module.exports = {
  getUserProfile,
  setUserProfile,
  getAllUserProfiles,
  deleteUserProfile,
};
