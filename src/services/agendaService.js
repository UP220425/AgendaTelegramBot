const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const { PEOPLE_ALIASES } = require('../config/peopleAliases');
const { getAgendaRowsByDate } = require('./appsScriptService');

dayjs.extend(customParseFormat);

const SPANISH_DAYS = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
];

const SPANISH_MONTHS = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

const WORKDAY_START = '07:00';
const WORKDAY_END = '18:00';
const SOURCE_MOCK = 'mock';
const SOURCE_GOOGLE_SHEETS = 'google_sheets';
const SYSTEMS_GROUP_NAME = 'Sistemas';
const CLIENT_NAME_ALIASES = {
  ch: 'Cielito Home',
  'c h': 'Cielito Home',
  'cielito home': 'Cielito Home',
};

const MOCK_RAW_MEETINGS = [
  {
    fecha: '04-06-2026',
    horaMexico: '7:00 AM - 8:00 AM',
    cliente: 'Payless',
    nombreMeeting: 'Functional Team Phoenix Project',
    asignadaA: 'Sra Lety',
    linkComentarios: '',
  },
  {
    fecha: '04-06-2026',
    horaMexico: '8:00 AM - 8:30 AM',
    cliente: 'Pepsi GL',
    nombreMeeting: 'LATAM_RTR_Weekly ALL TEAM',
    asignadaA: 'Luis / Yess',
    linkComentarios: '',
  },
  {
    fecha: '04-06-2026',
    horaMexico: '8:00 AM - 8:30 AM',
    cliente: 'Pepsi',
    nombreMeeting: 'LATAM_RTR_Weekly ALL TEAM',
    asignadaA: 'Eric',
    linkComentarios: '',
  },
  {
    fecha: '04-06-2026',
    horaMexico: '8:00 AM - 9:00 AM',
    cliente: 'Pirelli',
    nombreMeeting: 'RITM022556 - Intercompany flow',
    asignadaA: 'Sra Lety / Jonathan',
    linkComentarios: '',
  },
  {
    fecha: '04-06-2026',
    horaMexico: '8:00 AM - 10:30 AM',
    cliente: 'Gyansys Jr',
    nombreMeeting: 'SAP Sprint Planning & Stand-up',
    asignadaA: 'Yess / Carlos A',
    linkComentarios: '',
  },
  {
    fecha: '04-06-2026',
    horaMexico: '10:30 AM - 11:00 AM',
    cliente: 'Sistemas',
    nombreMeeting: 'Reunion Nuevos ingresos',
    asignadaA: 'Carlos / Sra Lety / Yess / Erika / Nestor / Rodrigo / Luis Vega / Pau',
    linkComentarios: '',
  },
  {
    fecha: '04-06-2026',
    horaMexico: '2:30 PM - 3:00 PM',
    cliente: 'Payless',
    nombreMeeting: 'MDM/ ORG STRUC / KDS',
    asignadaA: 'Sra Lety / Lenin / Luis Vega',
    linkComentarios: '',
  },
  {
    fecha: '04-06-2026',
    horaMexico: '5:00 PM - 6:00 PM',
    cliente: 'Infonavit',
    nombreMeeting: 'Avance en pruebas FHS - Seguimiento',
    asignadaA: 'Yess',
    linkComentarios: '',
  },
];

function cleanText(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toReadableName(value) {
  const cleaned = cleanText(value);

  if (!cleaned) {
    return '';
  }

  return cleaned
    .split(' ')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function normalizeClientName(value) {
  const rawValue = String(value || '').trim();
  const cleanedValue = cleanText(rawValue);

  if (!cleanedValue) {
    return '';
  }

  return CLIENT_NAME_ALIASES[cleanedValue] || rawValue;
}

function getAliasEntries() {
  return Object.values(PEOPLE_ALIASES).flatMap((person) => (
    person.aliases.map((alias) => ({
      alias: cleanText(alias),
      standardName: person.standardName,
    }))
  ));
}

function normalizePersonName(name) {
  const cleanedName = cleanText(name);

  if (!cleanedName) {
    return '';
  }

  const match = getAliasEntries().find((entry) => entry.alias === cleanedName);
  return match ? match.standardName : toReadableName(cleanedName);
}

function removeDuplicatePeople(people) {
  const seen = new Set();

  return people.filter((person) => {
    const key = cleanText(person);

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function isSystemsGroupName(person) {
  return cleanText(person) === cleanText(SYSTEMS_GROUP_NAME);
}

function getCollaboratorNames() {
  const people = Object.values(PEOPLE_ALIASES)
    .map((person) => person.standardName)
    .filter((person) => !isSystemsGroupName(person));

  return removeDuplicatePeople(people);
}

function isSystemsWideMeeting(meeting) {
  const assignedPeople = Array.isArray(meeting.personasAsignadas)
    ? meeting.personasAsignadas
    : [];

  return assignedPeople.some(isSystemsGroupName) || isSystemsGroupName(meeting.cliente);
}

function getSchedulingPeopleForMeeting(meeting) {
  const assignedPeople = Array.isArray(meeting.personasAsignadas)
    ? meeting.personasAsignadas
    : [];

  if (isSystemsWideMeeting(meeting)) {
    return getCollaboratorNames();
  }

  return assignedPeople;
}

function isPersonInMeeting(meeting, personName) {
  const person = normalizePersonName(personName);

  if (!person) {
    return false;
  }

  const meetingPeople = getSchedulingPeopleForMeeting(meeting);

  if (isSystemsGroupName(person)) {
    return meeting.personasAsignadas.some(isSystemsGroupName) || isSystemsGroupName(meeting.cliente);
  }

  return meetingPeople.includes(person);
}

function expandAvailabilityPeople(people) {
  const normalizedPeople = removeDuplicatePeople(people.map(normalizePersonName));

  if (!normalizedPeople.some(isSystemsGroupName)) {
    return normalizedPeople;
  }

  return removeDuplicatePeople([
    ...normalizedPeople.filter((person) => !isSystemsGroupName(person)),
    ...getCollaboratorNames(),
  ]);
}

function parseAssignedPeople(value) {
  if (value === null || value === undefined) {
    return [];
  }

  const people = String(value)
    .split(/\s*(?:\/|,|;|\by\b)\s*/i)
    .map(normalizePersonName)
    .filter(Boolean);

  return removeDuplicatePeople(people);
}

function parsePeopleQuery(value) {
  const cleaned = cleanText(value);

  if (!cleaned) {
    return [];
  }

  if (/[\/,;]/.test(value) || /\by\b/i.test(` ${cleaned} `)) {
    return parseAssignedPeople(value);
  }

  const tokens = cleaned.split(' ');
  const aliasEntries = getAliasEntries()
    .map((entry) => ({
      ...entry,
      tokens: entry.alias.split(' '),
    }))
    .sort((a, b) => b.tokens.length - a.tokens.length);

  const people = [];
  let index = 0;

  while (index < tokens.length) {
    const match = aliasEntries.find((entry) => {
      const candidate = tokens.slice(index, index + entry.tokens.length).join(' ');
      return candidate === entry.alias;
    });

    if (match) {
      people.push(match.standardName);
      index += match.tokens.length;
      continue;
    }

    people.push(normalizePersonName(tokens[index]));
    index += 1;
  }

  return removeDuplicatePeople(people);
}

function parseSingleTime(value) {
  const timeText = String(value || '')
    .trim()
    .replace(/[.,;]+$/g, '')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s+/g, ' ');
  const twelveHourMatch = timeText.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);

  if (twelveHourMatch) {
    let hours = Number(twelveHourMatch[1]);
    const minutes = Number(twelveHourMatch[2] || 0);
    const period = twelveHourMatch[3].toLowerCase();

    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
      return null;
    }

    if (period === 'am' && hours === 12) {
      hours = 0;
    }

    if (period === 'pm' && hours < 12) {
      hours += 12;
    }

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  const twentyFourHourMatch = timeText.match(/^(\d{1,2}):(\d{2})$/);

  if (!twentyFourHourMatch) {
    return null;
  }

  const hours = Number(twentyFourHourMatch[1]);
  const minutes = Number(twentyFourHourMatch[2]);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function parseTimeRange(value) {
  const text = String(value || '')
    .trim()
    .replace(/\s*:\s*/g, ':')
    .replace(/\s+/g, ' ');
  const cleanedText = cleanText(text);

  if (
    cleanedText === 'todo el dia'
    || cleanedText === 'todo dia'
    || cleanedText === 'all day'
  ) {
    return {
      start: WORKDAY_START,
      end: WORKDAY_END,
      isAllDay: true,
    };
  }

  const timeMatches = text.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi) || [];

  if (timeMatches.length >= 2) {
    const normalizedMatches = timeMatches.slice(0, 2);
    const hasPeriod = (timeText) => /\b(?:am|pm)\b/i.test(timeText);

    if (!hasPeriod(normalizedMatches[0]) && hasPeriod(normalizedMatches[1])) {
      normalizedMatches[0] = `${normalizedMatches[0]} ${normalizedMatches[1].match(/\b(?:am|pm)\b/i)[0]}`;
    }

    const start = parseSingleTime(normalizedMatches[0]);
    const end = parseSingleTime(normalizedMatches[1]);

    if (start && end) {
      return {
        start,
        end,
        isAllDay: false,
      };
    }
  }

  const parts = text.split(/\s*(?:[-–—]|\.|\ba\b|\bal\b|\bhasta\b)\s*/i);

  if (parts.length !== 2) {
    return null;
  }

  const start = parseSingleTime(parts[0]);
  const end = parseSingleTime(parts[1]);

  if (!start || !end) {
    return null;
  }

  return {
    start,
    end,
    isAllDay: false,
  };
}

function getSpanishSheetName(date) {
  const parsedDate = dayjs.isDayjs(date) ? date : dayjs(date);
  const safeDate = parsedDate.isValid() ? parsedDate : dayjs();

  return [
    SPANISH_DAYS[safeDate.day()],
    safeDate.date(),
    SPANISH_MONTHS[safeDate.month()],
    safeDate.year(),
  ].join(' ');
}

function getRowValue(row, keys) {
  const key = keys.find((candidate) => row && row[candidate] !== undefined && row[candidate] !== null);
  return key ? row[key] : '';
}

function mapRawRowToMeeting(row = {}) {
  const rawRowNumber = getRowValue(row, ['rowNumber', 'Row Number', '_rowNumber']);
  const rowNumber = Number(rawRowNumber);
  const fecha = getRowValue(row, ['fecha', 'Fecha']);
  const horaMexico = getRowValue(row, ['horaMexico', 'Hora Mexico']);
  const cliente = normalizeClientName(getRowValue(row, ['cliente', 'Cliente']));
  const nombreMeeting = getRowValue(row, ['nombreMeeting', 'Nombre del meeting']);
  const asignadaA = getRowValue(row, ['asignadaA', 'Asignada a']);
  const linkComentarios = getRowValue(row, ['linkComentarios', 'Link / Comentarios']);
  const rowBackground = getRowValue(row, ['rowBackground', 'rowColor', '_rowBackground']);
  const timeRange = parseTimeRange(horaMexico);

  return {
    rowNumber: Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber : null,
    fecha,
    horaMexico,
    cliente,
    nombreMeeting,
    asignadaA,
    personasAsignadas: parseAssignedPeople(asignadaA),
    linkComentarios,
    rowBackground,
    rowBackgrounds: Array.isArray(row.rowBackgrounds) ? row.rowBackgrounds : [],
    start: timeRange ? timeRange.start : null,
    end: timeRange ? timeRange.end : null,
    isAllDay: timeRange ? Boolean(timeRange.isAllDay) : false,
  };
}

function getDateKey(date) {
  const parsedDate = dayjs.isDayjs(date) ? date : dayjs(date);

  if (parsedDate.isValid()) {
    return parsedDate.format('DD-MM-YYYY');
  }

  return dayjs().format('DD-MM-YYYY');
}

function getMockDateKey() {
  return MOCK_RAW_MEETINGS[0]?.fecha || '';
}

function hasMockAgendaForDate(date) {
  const dateKey = getDateKey(date);
  return MOCK_RAW_MEETINGS.some((row) => row.fecha === dateKey);
}

function sortMeetingsByStart(meetings) {
  return [...meetings].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
}

function attachSource(value, source) {
  Object.defineProperty(value, 'source', {
    value: source,
    enumerable: false,
    configurable: true,
  });

  return value;
}

function getSource(value) {
  return value?.source || SOURCE_MOCK;
}

function hasMeetingContent(meeting) {
  return Boolean(
    meeting.horaMexico
    || meeting.cliente
    || meeting.nombreMeeting
    || meeting.asignadaA
  );
}

function mapRowsToMeetings(rows, source) {
  const meetings = sortMeetingsByStart(rows.map(mapRawRowToMeeting).filter(hasMeetingContent));

  meetings.forEach((meeting) => attachSource(meeting, source));

  return attachSource(meetings, source);
}

function getMockAgendaByDate(date) {
  const dateKey = getDateKey(date);
  const matchingRows = MOCK_RAW_MEETINGS.filter((row) => row.fecha === dateKey);
  const rows = matchingRows.length > 0 ? matchingRows : MOCK_RAW_MEETINGS;

  return mapRowsToMeetings(rows, SOURCE_MOCK);
}

async function getAgendaByDate(date, options = {}) {
  const shouldLog = !options.silent;

  try {
    if (shouldLog) {
      console.log('Leyendo agenda desde Apps Script');
    }

    const appsScriptRows = await getAgendaRowsByDate(date);
    return mapRowsToMeetings(appsScriptRows, getSource(appsScriptRows) || SOURCE_GOOGLE_SHEETS);
  } catch (error) {
    if (shouldLog) {
      console.log('Usando mock data por fallback');
    }

    return getMockAgendaByDate(date);
  }
}

async function getTodayAgenda(options = {}) {
  return getAgendaByDate(dayjs(), options);
}

function getNextAgendaDate(date = dayjs()) {
  const parsedDate = dayjs.isDayjs(date) ? date : dayjs(date);
  const baseDate = parsedDate.isValid() ? parsedDate : dayjs();
  let nextDate = baseDate.add(1, 'day');

  while (nextDate.day() === 0 || nextDate.day() === 6) {
    nextDate = nextDate.add(1, 'day');
  }

  return nextDate;
}

async function getTomorrowAgenda(options = {}) {
  return getAgendaByDate(getNextAgendaDate(), options);
}

async function getMeetingsForPersonByDate(date, personName, options = {}) {
  const agenda = await getAgendaByDate(date, options);
  const meetings = agenda.filter((meeting) => isPersonInMeeting(meeting, personName));

  return attachSource(meetings, getSource(agenda));
}

async function getTodayMeetingsForPerson(personName, options = {}) {
  return getMeetingsForPersonByDate(dayjs(), personName, options);
}

function timeToMinutes(value) {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }

  const [hours, minutes] = String(value).split(':').map(Number);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return Number.POSITIVE_INFINITY;
  }

  return hours * 60 + minutes;
}

function minutesToTime(value) {
  const safeValue = Math.max(0, Math.min(value, 23 * 60 + 59));
  const hours = Math.floor(safeValue / 60);
  const minutes = safeValue % 60;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

async function getNextMeeting(personName = 'Carlos') {
  const person = normalizePersonName(personName || 'Carlos');
  const today = dayjs();
  const agenda = await getAgendaByDate(today);
  const isUsingFallbackMock = getSource(agenda) === SOURCE_MOCK && !hasMockAgendaForDate(today);

  // Si hoy no existe en mock, empezamos desde 00:00 para que el MVP sea demostrable.
  const currentMinutes = isUsingFallbackMock ? 0 : today.hour() * 60 + today.minute();

  return agenda.find((meeting) => {
    const meetingPeople = getSchedulingPeopleForMeeting(meeting);
    const matchesPerson = isSystemsGroupName(person)
      ? meeting.personasAsignadas.some(isSystemsGroupName)
      : meetingPeople.includes(person);

    return matchesPerson && timeToMinutes(meeting.start) >= currentMinutes;
  }) || null;
}

async function getConflicts(date = dayjs()) {
  const fullAgenda = await getAgendaByDate(date);
  const agenda = fullAgenda.filter((meeting) => meeting.start && meeting.end);
  const people = new Set(agenda.flatMap(getSchedulingPeopleForMeeting));
  const conflicts = [];

  people.forEach((person) => {
    const personMeetings = sortMeetingsByStart(
      agenda.filter((meeting) => getSchedulingPeopleForMeeting(meeting).includes(person))
    );

    let previousMeeting = null;

    personMeetings.forEach((currentMeeting) => {
      if (!previousMeeting) {
        previousMeeting = currentMeeting;
        return;
      }

      const currentStart = timeToMinutes(currentMeeting.start);
      const previousEnd = timeToMinutes(previousMeeting.end);

      if (currentStart < previousEnd) {
        conflicts.push({
          person,
          persona: person,
          meetingA: previousMeeting,
          meetingB: currentMeeting,
        });
      }

      if (timeToMinutes(currentMeeting.end) > previousEnd) {
        previousMeeting = currentMeeting;
      }
    });
  });

  return attachSource(conflicts, getSource(fullAgenda));
}

async function getAvailability(date = dayjs(), people = []) {
  const normalizedPeople = expandAvailabilityPeople(people);

  if (normalizedPeople.length === 0) {
    return attachSource([], SOURCE_MOCK);
  }

  const agenda = await getAgendaByDate(date);
  const busyBlocks = agenda
    .filter((meeting) => meeting.start && meeting.end)
    .filter((meeting) => (
      getSchedulingPeopleForMeeting(meeting).some((person) => normalizedPeople.includes(person))
    ))
    .map((meeting) => ({
      start: Math.max(timeToMinutes(WORKDAY_START), timeToMinutes(meeting.start)),
      end: Math.min(timeToMinutes(WORKDAY_END), timeToMinutes(meeting.end)),
    }))
    .filter((block) => block.start < block.end)
    .sort((a, b) => a.start - b.start);

  const mergedBusyBlocks = [];

  busyBlocks.forEach((block) => {
    const lastBlock = mergedBusyBlocks[mergedBusyBlocks.length - 1];

    if (!lastBlock || block.start > lastBlock.end) {
      mergedBusyBlocks.push({ ...block });
      return;
    }

    lastBlock.end = Math.max(lastBlock.end, block.end);
  });

  const availability = [];
  let cursor = timeToMinutes(WORKDAY_START);
  const workdayEnd = timeToMinutes(WORKDAY_END);

  mergedBusyBlocks.forEach((block) => {
    if (cursor < block.start) {
      availability.push({
        start: minutesToTime(cursor),
        end: minutesToTime(block.start),
      });
    }

    cursor = Math.max(cursor, block.end);
  });

  if (cursor < workdayEnd) {
    availability.push({
      start: minutesToTime(cursor),
      end: minutesToTime(workdayEnd),
    });
  }

  return attachSource(availability, getSource(agenda));
}

module.exports = {
  MOCK_RAW_MEETINGS,
  cleanText,
  normalizeClientName,
  normalizePersonName,
  parseAssignedPeople,
  parsePeopleQuery,
  parseTimeRange,
  expandAvailabilityPeople,
  getSchedulingPeopleForMeeting,
  getSpanishSheetName,
  mapRawRowToMeeting,
  getAgendaByDate,
  getMockAgendaByDate,
  getTodayAgenda,
  getNextAgendaDate,
  getTomorrowAgenda,
  getMeetingsForPersonByDate,
  getTodayMeetingsForPerson,
  getNextMeeting,
  getConflicts,
  getAvailability,
  hasMockAgendaForDate,
  getSource,
  getCollaboratorNames,
  isPersonInMeeting,
  timeToMinutes,
};
