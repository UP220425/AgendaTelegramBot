const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { findPerson } = require('./peopleDirectoryService');

const DATA_DIR = path.join(process.cwd(), 'data');
const PERSON_PASSWORDS_FILE = path.join(DATA_DIR, 'personPasswords.json');
const HASH_KEY_LENGTH = 64;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readPersonPasswords() {
  try {
    if (!fs.existsSync(PERSON_PASSWORDS_FILE)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(PERSON_PASSWORDS_FILE, 'utf8') || '{}');
  } catch (error) {
    return {};
  }
}

function writePersonPasswords(passwords) {
  ensureDataDir();
  fs.writeFileSync(PERSON_PASSWORDS_FILE, `${JSON.stringify(passwords, null, 2)}\n`);
}

function normalizePassword(value) {
  return String(value || '').trim();
}

function getActivePerson(value) {
  const person = findPerson(value);

  if (!person || !person.isActive || person.isSystem) {
    return null;
  }

  return person;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(normalizePassword(password), salt, HASH_KEY_LENGTH).toString('hex');

  return {
    algorithm: 'scrypt',
    salt,
    hash,
  };
}

function verifyHash(password, record) {
  if (!record?.salt || !record?.hash) {
    return false;
  }

  const expected = Buffer.from(record.hash, 'hex');
  const actual = crypto.scryptSync(normalizePassword(password), record.salt, HASH_KEY_LENGTH);

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

function hasAnyPersonPassword() {
  return Object.values(readPersonPasswords()).some((record) => record && record.isActive !== false);
}

function hasPasswordForPerson(personName) {
  const person = getActivePerson(personName);

  if (!person) {
    return false;
  }

  const record = readPersonPasswords()[person.id];
  return Boolean(record && record.isActive !== false && record.hash);
}

function verifyPersonPassword(personName, password) {
  const person = getActivePerson(personName);

  if (!person) {
    return false;
  }

  const record = readPersonPasswords()[person.id];

  if (!record || record.isActive === false) {
    return false;
  }

  return verifyHash(password, record);
}

function setPersonPassword(personName, password) {
  const person = getActivePerson(personName);
  const cleanPassword = normalizePassword(password);

  if (!person) {
    throw new Error('PERSON_NOT_FOUND');
  }

  if (cleanPassword.length < 4) {
    throw new Error('PASSWORD_TOO_SHORT');
  }

  const passwords = readPersonPasswords();

  passwords[person.id] = {
    personId: person.id,
    personName: person.standardName,
    ...hashPassword(cleanPassword),
    isActive: true,
    updatedAt: new Date().toISOString(),
  };

  writePersonPasswords(passwords);
  return passwords[person.id];
}

function removePersonPassword(personName) {
  const person = findPerson(personName);

  if (!person) {
    return null;
  }

  const passwords = readPersonPasswords();

  if (!passwords[person.id]) {
    return null;
  }

  passwords[person.id] = {
    ...passwords[person.id],
    isActive: false,
    removedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  writePersonPasswords(passwords);
  return passwords[person.id];
}

module.exports = {
  hasAnyPersonPassword,
  hasPasswordForPerson,
  verifyPersonPassword,
  setPersonPassword,
  removePersonPassword,
};
