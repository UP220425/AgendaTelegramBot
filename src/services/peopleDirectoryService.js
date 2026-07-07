const fs = require('fs');
const path = require('path');
const { PEOPLE_ALIASES } = require('../config/peopleAliases');

const DATA_DIR = path.join(process.cwd(), 'data');
const PEOPLE_DIRECTORY_FILE = path.join(DATA_DIR, 'peopleDirectory.json');
const SYSTEMS_GROUP_NAME = 'Sistemas';

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function cleanKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toId(value) {
  return cleanKey(value).replace(/\s+/g, '_');
}

function toDisplayName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function removeDuplicateAliases(aliases = []) {
  const seen = new Set();

  return aliases
    .map((alias) => String(alias || '').trim())
    .filter(Boolean)
    .filter((alias) => {
      const key = cleanKey(alias);

      if (!key || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

function readDirectoryOverrides() {
  try {
    if (!fs.existsSync(PEOPLE_DIRECTORY_FILE)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(PEOPLE_DIRECTORY_FILE, 'utf8') || '{}');
  } catch (error) {
    return {};
  }
}

function writeDirectoryOverrides(directory) {
  ensureDataDir();
  fs.writeFileSync(PEOPLE_DIRECTORY_FILE, `${JSON.stringify(directory, null, 2)}\n`);
}

function getBaseDirectory() {
  return Object.entries(PEOPLE_ALIASES).reduce((directory, [id, person]) => {
    directory[id] = {
      id,
      standardName: person.standardName,
      aliases: removeDuplicateAliases(person.aliases || [person.standardName]),
      isActive: true,
      isSystem: person.standardName === SYSTEMS_GROUP_NAME,
    };

    return directory;
  }, {});
}

function getDirectory() {
  const baseDirectory = getBaseDirectory();
  const overrides = readDirectoryOverrides();
  const directory = {
    ...baseDirectory,
    ...overrides,
  };

  Object.keys(directory).forEach((id) => {
    const record = directory[id] || {};
    const standardName = toDisplayName(record.standardName || id);

    directory[id] = {
      id,
      standardName,
      aliases: removeDuplicateAliases([
        standardName,
        ...(record.aliases || []),
      ]),
      isActive: record.isActive !== false,
      isSystem: record.isSystem || standardName === SYSTEMS_GROUP_NAME,
      createdAt: record.createdAt || null,
      updatedAt: record.updatedAt || null,
    };
  });

  return directory;
}

function applyDirectoryToAliases() {
  const directory = getDirectory();

  Object.keys(PEOPLE_ALIASES).forEach((key) => {
    delete PEOPLE_ALIASES[key];
  });

  Object.values(directory)
    .filter((person) => person.isActive)
    .forEach((person) => {
      PEOPLE_ALIASES[person.id] = {
        standardName: person.standardName,
        aliases: person.aliases,
      };
    });

  return directory;
}

function getActivePeople(options = {}) {
  const { includeSystems = true } = options;

  return Object.values(getDirectory())
    .filter((person) => person.isActive)
    .filter((person) => includeSystems || !person.isSystem)
    .sort((a, b) => {
      if (a.isSystem && !b.isSystem) return -1;
      if (!a.isSystem && b.isSystem) return 1;
      return a.standardName.localeCompare(b.standardName, 'es');
    })
    .map((person) => ({
      id: person.id,
      name: person.standardName,
      aliases: person.aliases,
      isSystem: person.isSystem,
    }));
}

function findPerson(value) {
  const key = cleanKey(value);

  if (!key) {
    return null;
  }

  return Object.values(getDirectory()).find((person) => (
    cleanKey(person.standardName) === key
    || cleanKey(person.id) === key
    || person.aliases.some((alias) => cleanKey(alias) === key)
  )) || null;
}

function isActivePersonName(value) {
  const person = findPerson(value);
  return Boolean(person && person.isActive);
}

function addPerson(name, aliases = []) {
  const standardName = toDisplayName(name);

  if (!standardName || standardName === SYSTEMS_GROUP_NAME) {
    throw new Error('INVALID_PERSON_NAME');
  }

  const id = toId(standardName);
  const directory = getDirectory();
  const current = directory[id] || {};

  directory[id] = {
    ...current,
    id,
    standardName,
    aliases: removeDuplicateAliases([
      standardName,
      ...aliases,
      ...(current.aliases || []),
    ]),
    isActive: true,
    isSystem: false,
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  writeDirectoryOverrides(directory);
  applyDirectoryToAliases();
  return directory[id];
}

function deactivatePerson(value) {
  const person = findPerson(value);

  if (!person || person.isSystem) {
    return null;
  }

  const directory = getDirectory();

  directory[person.id] = {
    ...person,
    isActive: false,
    updatedAt: new Date().toISOString(),
  };

  writeDirectoryOverrides(directory);
  applyDirectoryToAliases();
  return directory[person.id];
}

applyDirectoryToAliases();

module.exports = {
  getActivePeople,
  findPerson,
  isActivePersonName,
  addPerson,
  deactivatePerson,
  applyDirectoryToAliases,
};
