require('dotenv').config();

const TIMEZONE = process.env.TIMEZONE || 'America/Mexico_City';
process.env.TZ = TIMEZONE;

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Telegraf, Markup } = require('telegraf');
const dayjs = require('dayjs');
const cron = require('node-cron');
const {
  getTodayAgenda,
  getTomorrowAgenda,
  getAgendaByDate,
  getNextMeeting,
  getConflicts,
  getAvailability,
  getTodayMeetingsForPerson,
  normalizeClientName,
  normalizePersonName,
  parseAssignedPeople,
  parsePeopleQuery,
  parseTimeRange,
  expandAvailabilityPeople,
  getSchedulingPeopleForMeeting,
  getNextAgendaDate,
  getSource,
  isPersonInMeeting,
  timeToMinutes,
} = require('./services/agendaService');
const { addMeetingRow, deleteMeetingRow, sortAgendaRowsByDate } = require('./services/appsScriptService');
const { createAgendaImageBuffer } = require('./services/agendaImageService');
const {
  getUserProfile,
  setUserProfile,
  getAllUserProfiles,
} = require('./services/userProfileService');
const {
  upsertSubscriber,
  upsertSubscriberFromContext,
  getActiveSubscribers,
  markDailyDigestSent,
  deactivateSubscriber,
} = require('./services/subscriberService');

const BOT_NAME = 'Agenda Coordinación Bot';
const SOURCE_NOTE = 'Fuente: datos de prueba.';
const DATA_DIR = path.join(process.cwd(), 'data');
const GENERATED_DIR = path.join(DATA_DIR, 'generated');
const SENT_REMINDERS_FILE = path.join(DATA_DIR, 'sentReminders.json');
const {
  TELEGRAM_BOT_TOKEN,
  NODE_ENV = 'development',
  REMINDER_MINUTES_BEFORE = '15',
  DAILY_AGENDA_DIGEST_TIME = '17:00',
} = process.env;
const execFileAsync = promisify(execFile);

let isBotRunning = false;
let isCheckingReminders = false;
let isSendingDailyAgendaDigest = false;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN no está definido en el archivo .env.');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const AGENDA_IMAGE_FORMAT = 'jpeg';
const AGENDA_IMAGE_EXTENSION = 'jpg';
const TELEGRAM_UPLOAD_TIMEOUT_MS = 12000;
const TELEGRAM_UPLOAD_CURL_TIMEOUT_SECONDS = Math.ceil(TELEGRAM_UPLOAD_TIMEOUT_MS / 1000);
const REMINDER_GRACE_MINUTES = 1;

const mainMenuMessage = [
  'Hola, soy Agenda Coordinación Bot.',
  'Puedo ayudarte a consultar reuniones, revisar disponibilidad, detectar empalmes y agregar reuniones.',
  '',
  'Selecciona una opción:',
].join('\n');

const helpMessage = [
  '- /hoy: consultar agenda de hoy',
  '- /misjuntas: consultar mis juntas de hoy',
  '- /soy: configurar quién soy',
  '- /manana: consultar agenda del día siguiente',
  '- /siguiente: consultar la siguiente reunión',
  '- /disponibilidad: buscar horarios libres entre personas',
  '- /disponibilidad manana Yess Carlos: buscar horarios libres del día siguiente',
  '- /empalmes: revisar conflictos de agenda',
  '- /empalmes manana: revisar conflictos del día siguiente',
  '- /agregar: iniciar alta de una nueva reunión',
  '- /baja: dar de baja una reunión',
  '- /ordenaragenda: ordenar la agenda por hora',
  '- /resumenhoy: generar imagen de agenda de hoy',
  '- /resumenmanana: probar el resumen automático del día siguiente',
].join('\n');

const AVAILABLE_PEOPLE = [
  { id: 'sistemas', name: 'Sistemas' },
  { id: 'carlos', name: 'Carlos' },
  { id: 'carlos_alberto', name: 'Carlos 2' },
  { id: 'leti', name: 'Lety' },
  { id: 'yess', name: 'Yess' },
  { id: 'citlali', name: 'Citlali' },
  { id: 'jacel', name: 'Jacel' },
  { id: 'ivan', name: 'Ivan' },
  { id: 'mariana', name: 'Mariana' },
  { id: 'cielo', name: 'Cielo' },
  { id: 'nestor', name: 'Nestor' },
  { id: 'rodrigo', name: 'Rodrigo' },
  { id: 'paulina', name: 'Paulina' },
  { id: 'diego', name: 'Diego' },
  { id: 'brandon', name: 'Brandon' },
  { id: 'erika', name: 'Erika' },
  { id: 'lenin', name: 'Lenin' },
  { id: 'jonathan', name: 'Jonathan' },
  { id: 'luis_gallo', name: 'Luis Gallo' },
  { id: 'luis_vega', name: 'Luis Vega' },
  { id: 'eric', name: 'Eric' },
];

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

const availabilitySelections = new Map();
const availabilityDateSelections = new Map();
const addMeetingFlows = new Map();
const deleteMeetingFlows = new Map();
const sentReminderKeys = loadSentReminderKeys();
const reminderMinutesBefore = Number(REMINDER_MINUTES_BEFORE) || 15;
const reminderMinimumMinutesBefore = Math.max(reminderMinutesBefore - REMINDER_GRACE_MINUTES, 0);
const dailyAgendaDigestTime = parseDailyDigestTime(DAILY_AGENDA_DIGEST_TIME);

const ADD_MEETING_STEPS = {
  DATE: 'date',
  TIME: 'time',
  CLIENT: 'client',
  NAME: 'name',
  ASSIGNED: 'assigned',
  LINK: 'link',
  COLOR: 'color',
  CONFIRM: 'confirm',
};
const ADD_MEETING_WORKDAY_START_MINUTES = 7 * 60;
const ADD_MEETING_WORKDAY_END_MINUTES = 18 * 60;
const ADD_MEETING_TIME_STEP_MINUTES = 30;
const ADD_MEETING_DURATION_OPTIONS = [30, 60, 90, 120];
const ADD_MEETING_COLORS = {
  white: {
    label: 'Blanco',
    value: 'white',
  },
  green: {
    label: 'Verde',
    value: 'green',
  },
  red: {
    label: 'Rojo claro',
    value: 'red',
  },
  strongRed: {
    label: 'Rojo fuerte',
    value: 'strong_red',
  },
};

function getCommandArgs(ctx, command) {
  const text = ctx.message?.text || '';
  return text.replace(new RegExp(`^/${command}(?:@\\w+)?\\s*`, 'i'), '').trim();
}

function parseDailyDigestTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return {
      hour: 17,
      minute: 0,
      label: '17:00',
    };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return {
      hour: 17,
      minute: 0,
      label: '17:00',
    };
  }

  return {
    hour,
    minute,
    label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function buildDateTarget(mode = 'today', dateValue) {
  if (mode === 'next') {
    const date = getNextAgendaDate();
    return {
      mode,
      date,
      iso: date.format('YYYY-MM-DD'),
      label: `día siguiente (${date.format('YYYY-MM-DD')})`,
    };
  }

  if (mode === 'custom') {
    const date = dayjs(dateValue);
    const safeDate = date.isValid() ? date : dayjs();
    return {
      mode,
      date: safeDate,
      iso: safeDate.format('YYYY-MM-DD'),
      label: safeDate.format('YYYY-MM-DD'),
    };
  }

  const date = dayjs();
  return {
    mode: 'today',
    date,
    iso: date.format('YYYY-MM-DD'),
    label: `hoy (${date.format('YYYY-MM-DD')})`,
  };
}

function extractDateTarget(text = '') {
  let remainingText = String(text || '').trim();
  const isoDateMatch = remainingText.match(/\b\d{4}-\d{2}-\d{2}\b/);

  if (isoDateMatch) {
    const parsedDate = dayjs(isoDateMatch[0]);

    if (parsedDate.isValid() && parsedDate.format('YYYY-MM-DD') === isoDateMatch[0]) {
      remainingText = remainingText.replace(isoDateMatch[0], '').replace(/\s+/g, ' ').trim();
      return {
        target: buildDateTarget('custom', isoDateMatch[0]),
        remainingText,
      };
    }
  }

  const nextDayPattern = /\b(?:d[ií]a\s+siguiente|mañana|manana|siguiente)\b/i;
  const todayPattern = /\bhoy\b/i;

  if (nextDayPattern.test(remainingText)) {
    remainingText = remainingText.replace(nextDayPattern, '').replace(/\s+/g, ' ').trim();
    return {
      target: buildDateTarget('next'),
      remainingText,
    };
  }

  if (todayPattern.test(remainingText)) {
    remainingText = remainingText.replace(todayPattern, '').replace(/\s+/g, ' ').trim();
    return {
      target: buildDateTarget('today'),
      remainingText,
    };
  }

  return {
    target: buildDateTarget('today'),
    remainingText,
  };
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Agenda de hoy', 'agenda_hoy'),
      Markup.button.callback('Agenda día siguiente', 'agenda_manana'),
    ],
    [
      Markup.button.callback('Mis juntas de hoy', 'mis_juntas_hoy'),
      Markup.button.callback('Configurar mi nombre', 'configurar_persona'),
    ],
    [
      Markup.button.callback('Siguiente reunión', 'siguiente_reunion'),
      Markup.button.callback('Disponibilidad', 'disponibilidad_menu'),
    ],
    [
      Markup.button.callback('Siguiente Junta Sra Lety', 'siguiente_jefa_lety'),
      Markup.button.callback('Siguiente Junta Yess', 'siguiente_jefa_yess'),
    ],
    [
      Markup.button.callback('Empalmes', 'empalmes'),
      Markup.button.callback('Agregar reunión', 'agregar_reunion'),
    ],
    [
      Markup.button.callback('Dar de baja reunión', 'baja_reunion'),
      Markup.button.callback('Ordenar agenda', 'ordenar_agenda'),
    ],
    [
      Markup.button.callback('Ayuda', 'ayuda'),
    ],
  ]);
}

function backToMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ]);
}

function getUserAvailabilitySelection(ctx) {
  const userId = ctx.from?.id;

  if (!userId) {
    return new Set();
  }

  if (!availabilitySelections.has(userId)) {
    availabilitySelections.set(userId, new Set());
  }

  return availabilitySelections.get(userId);
}

function clearUserAvailabilitySelection(ctx) {
  const selectedPeople = getUserAvailabilitySelection(ctx);
  selectedPeople.clear();
  return selectedPeople;
}

function setUserAvailabilityTarget(ctx, target) {
  const userId = ctx.from?.id;

  if (!userId) {
    return;
  }

  availabilityDateSelections.set(userId, {
    mode: target.mode,
    iso: target.iso,
  });
}

function getUserAvailabilityTarget(ctx) {
  const userId = ctx.from?.id;
  const savedTarget = userId ? availabilityDateSelections.get(userId) : null;

  if (!savedTarget) {
    return buildDateTarget('today');
  }

  return savedTarget.mode === 'custom'
    ? buildDateTarget('custom', savedTarget.iso)
    : buildDateTarget(savedTarget.mode);
}

function getPersonById(personId) {
  return AVAILABLE_PEOPLE.find((person) => person.id === personId);
}

function canConsultAvailability(selectedPeople) {
  return selectedPeople.length >= 1;
}

function getNextMeetingPeople() {
  return AVAILABLE_PEOPLE.filter((person) => person.name !== 'Sistemas');
}

function getNextMeetingButtons() {
  const rows = [];
  const people = getNextMeetingPeople();

  for (let index = 0; index < people.length; index += 2) {
    rows.push(people.slice(index, index + 2).map((person) => (
      Markup.button.callback(person.name, `siguiente_persona:${person.id}`)
    )));
  }

  rows.push([
    Markup.button.callback('Volver al menú', 'menu_principal'),
  ]);

  return rows;
}

function getProfileButtons() {
  const rows = [];
  const people = getNextMeetingPeople();

  for (let index = 0; index < people.length; index += 2) {
    rows.push(people.slice(index, index + 2).map((person) => (
      Markup.button.callback(person.name, `perfil_persona:${person.id}`)
    )));
  }

  rows.push([
    Markup.button.callback('Volver al menú', 'menu_principal'),
  ]);

  return rows;
}

function dateChoiceKeyboard(callbackPrefix) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Hoy', `${callbackPrefix}:today`),
      Markup.button.callback('Día siguiente', `${callbackPrefix}:next`),
    ],
    [
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ]);
}

function getPeopleButtons(selectedPeople = new Set(), target = buildDateTarget('today'), profile = null) {
  const peopleRows = [];
  const todayLabel = target.mode === 'today' ? '[x] Hoy' : 'Hoy';
  const nextLabel = target.mode === 'next' ? '[x] Día siguiente' : 'Día siguiente';
  const profileLabel = profile
    ? `Usar mi nombre (${profile.personName})`
    : 'Usar mi nombre';

  for (let index = 0; index < AVAILABLE_PEOPLE.length; index += 2) {
    const rowPeople = AVAILABLE_PEOPLE.slice(index, index + 2);
    peopleRows.push(rowPeople.map((person) => {
      const isSelected = selectedPeople.has(person.name);
      const marker = isSelected ? '[x]' : '[ ]';
      return Markup.button.callback(
        `${marker} ${person.name}`,
        `disponibilidad_toggle:${person.id}`
      );
    }));
  }

  return [
    [
      Markup.button.callback(todayLabel, 'disponibilidad_fecha:today'),
      Markup.button.callback(nextLabel, 'disponibilidad_fecha:next'),
    ],
    [
      Markup.button.callback(profileLabel, 'disponibilidad_mi_nombre'),
    ],
    ...peopleRows,
    [
      Markup.button.callback('Consultar disponibilidad', 'disponibilidad_consultar'),
    ],
    [
      Markup.button.callback('Limpiar selección', 'disponibilidad_limpiar'),
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ];
}

function formatAvailabilityMenuMessage(selectedPeople = new Set(), target = buildDateTarget('today')) {
  const selectedList = [...selectedPeople];

  if (selectedList.length === 0) {
    return [
      'Selecciona una o más personas para consultar disponibilidad:',
      '',
      `Fecha: ${target.label}`,
    ].join('\n');
  }

  return [
    `Fecha: ${target.label}`,
    '',
    'Personas seleccionadas:',
    ...selectedList.map((person) => `- ${person}`),
    '',
    'Selecciona más personas o consulta disponibilidad.',
  ].join('\n');
}

function showNextMeetingMenu(ctx) {
  const message = 'Selecciona de quién quieres consultar la siguiente reunión:';
  const keyboard = Markup.inlineKeyboard(getNextMeetingButtons());

  if (ctx.callbackQuery) {
    return ctx.editMessageText(message, keyboard)
      .catch((error) => {
        if (isMessageNotModifiedError(error)) {
          return undefined;
        }

        return ctx.reply(message, keyboard);
      });
  }

  return ctx.reply(message, keyboard);
}

function showProfileMenu(ctx) {
  const message = [
    'Para mostrar tus juntas y enviarte recordatorios, selecciona quién eres:',
    '',
    'También puedes escribir:',
    '/soy Yess',
  ].join('\n');
  const keyboard = Markup.inlineKeyboard(getProfileButtons());

  if (ctx.callbackQuery) {
    return ctx.editMessageText(message, keyboard)
      .catch((error) => {
        if (isMessageNotModifiedError(error)) {
          return undefined;
        }

        return ctx.reply(message, keyboard);
      });
  }

  return ctx.reply(message, keyboard);
}

function showDateChoiceMenu(ctx, message, callbackPrefix) {
  const keyboard = dateChoiceKeyboard(callbackPrefix);

  if (ctx.callbackQuery) {
    return ctx.editMessageText(message, keyboard)
      .catch((error) => {
        if (isMessageNotModifiedError(error)) {
          return undefined;
        }

        return ctx.reply(message, keyboard);
      });
  }

  return ctx.reply(message, keyboard);
}

function showAvailabilityDateMenu(ctx) {
  return showDateChoiceMenu(
    ctx,
    '¿Para qué día quieres consultar disponibilidad?',
    'disponibilidad_fecha'
  );
}

function showConflictsDateMenu(ctx) {
  return showDateChoiceMenu(
    ctx,
    '¿Para qué día quieres revisar empalmes?',
    'empalmes_fecha'
  );
}

function showDeleteMeetingDateMenu(ctx) {
  return showDateChoiceMenu(
    ctx,
    '¿De qué día quieres dar de baja una reunión?',
    'baja_fecha'
  );
}

function showSortAgendaDateMenu(ctx) {
  return showDateChoiceMenu(
    ctx,
    '¿Qué agenda quieres ordenar por hora?',
    'ordenar_fecha'
  );
}

function isMessageNotModifiedError(error) {
  return String(error?.description || error?.message || '')
    .toLowerCase()
    .includes('message is not modified');
}

function showAvailabilityMenu(
  ctx,
  selectedPeople = getUserAvailabilitySelection(ctx),
  target = getUserAvailabilityTarget(ctx)
) {
  const message = formatAvailabilityMenuMessage(selectedPeople, target);
  const keyboard = Markup.inlineKeyboard(getPeopleButtons(selectedPeople, target, getCurrentProfile(ctx)));

  if (ctx.callbackQuery) {
    return ctx.editMessageText(message, keyboard)
      .catch((error) => {
        if (isMessageNotModifiedError(error)) {
          return undefined;
        }

        return ctx.reply(message, keyboard);
      });
  }

  return ctx.reply(message, keyboard);
}

async function showMainMenu(ctx) {
  clearAddMeetingFlow(ctx);
  clearDeleteMeetingFlow(ctx);

  if (ctx.callbackQuery) {
    return ctx.editMessageText(mainMenuMessage, mainMenuKeyboard())
      .catch((error) => {
        if (isMessageNotModifiedError(error)) {
          return undefined;
        }

        return ctx.reply(mainMenuMessage, mainMenuKeyboard());
      });
  }

  return ctx.reply(mainMenuMessage, mainMenuKeyboard());
}

async function answerCallback(ctx) {
  if (!ctx.callbackQuery) {
    return;
  }

  await ctx.answerCbQuery().catch(() => {});
}

function getUserId(ctx) {
  return ctx.from?.id;
}

function getChatId(ctx) {
  return ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id || getUserId(ctx);
}

function getProfilePersonByName(personName) {
  const normalizedName = normalizePersonName(personName);
  return getNextMeetingPeople().find((person) => person.name === normalizedName);
}

function saveUserProfile(ctx, personName) {
  const person = getProfilePersonByName(personName);

  if (!person) {
    return null;
  }

  return setUserProfile(getUserId(ctx), person.name, ctx.from || {}, getChatId(ctx));
}

function formatProfileResponse(profile) {
  return [
    `Listo. Te tengo registrado como ${profile.personName}.`,
    '',
    'Con esto puedo mostrar tus juntas y enviarte recordatorios de reuniones próximas.',
  ].join('\n');
}

function getCurrentProfile(ctx) {
  const userId = getUserId(ctx);
  return userId ? getUserProfile(userId) : null;
}

function getActiveAddMeetingFlow(ctx) {
  const userId = getUserId(ctx);
  return userId ? addMeetingFlows.get(userId) : null;
}

function clearAddMeetingFlow(ctx) {
  const userId = getUserId(ctx);

  if (userId) {
    addMeetingFlows.delete(userId);
  }
}

function getActiveDeleteMeetingFlow(ctx) {
  const userId = getUserId(ctx);
  return userId ? deleteMeetingFlows.get(userId) : null;
}

function clearDeleteMeetingFlow(ctx) {
  const userId = getUserId(ctx);

  if (userId) {
    deleteMeetingFlows.delete(userId);
  }
}

function addMeetingCancelKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Cancelar alta', 'agregar_cancelar'),
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ]);
}

function addMeetingDateKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Hoy', 'agregar_fecha:today'),
      Markup.button.callback('Día siguiente', 'agregar_fecha:next'),
    ],
    [
      Markup.button.callback('Elegir en calendario', 'agregar_calendario'),
    ],
    [
      Markup.button.callback('Cancelar alta', 'agregar_cancelar'),
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ]);
}

function addMeetingCalendarKeyboard(monthDate = dayjs()) {
  const safeMonth = dayjs.isDayjs(monthDate) && monthDate.isValid()
    ? monthDate.startOf('month')
    : dayjs().startOf('month');
  const previousMonth = safeMonth.subtract(1, 'month').format('YYYY-MM');
  const nextMonth = safeMonth.add(1, 'month').format('YYYY-MM');
  const monthLabel = `${SPANISH_MONTHS[safeMonth.month()]} ${safeMonth.year()}`;
  const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const rows = [
    [
      Markup.button.callback('<', `agregar_cal:${previousMonth}`),
      Markup.button.callback(monthLabel, 'agregar_cal_noop'),
      Markup.button.callback('>', `agregar_cal:${nextMonth}`),
    ],
    weekdays.map((day) => Markup.button.callback(day, 'agregar_cal_noop')),
  ];
  const daysInMonth = safeMonth.daysInMonth();
  const firstDayOffset = (safeMonth.day() + 6) % 7;
  let day = 1;

  for (let week = 0; week < 6; week += 1) {
    const row = [];

    for (let weekday = 0; weekday < 7; weekday += 1) {
      if ((week === 0 && weekday < firstDayOffset) || day > daysInMonth) {
        row.push(Markup.button.callback('-', 'agregar_cal_noop'));
        continue;
      }

      const date = safeMonth.date(day);
      row.push(Markup.button.callback(String(day), `agregar_dia:${date.format('YYYY-MM-DD')}`));
      day += 1;
    }

    rows.push(row);

    if (day > daysInMonth) {
      break;
    }
  }

  rows.push([
    Markup.button.callback('Hoy', 'agregar_fecha:today'),
    Markup.button.callback('Día siguiente', 'agregar_fecha:next'),
  ]);
  rows.push([
    Markup.button.callback('Cancelar alta', 'agregar_cancelar'),
    Markup.button.callback('Volver al menú', 'menu_principal'),
  ]);

  return Markup.inlineKeyboard(rows);
}

function addMeetingLinkKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Sin link/comentarios', 'agregar_sin_link'),
    ],
    [
      Markup.button.callback('Cancelar alta', 'agregar_cancelar'),
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ]);
}

function addMeetingColorKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Blanco', 'agregar_color:white'),
      Markup.button.callback('Verde', 'agregar_color:green'),
    ],
    [
      Markup.button.callback('Rojo claro', 'agregar_color:red'),
      Markup.button.callback('Rojo fuerte', 'agregar_color:strong_red'),
    ],
    [
      Markup.button.callback('Cancelar alta', 'agregar_cancelar'),
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ]);
}

function formatMeetingTimeFromMinutes(minutes) {
  const safeMinutes = Math.max(0, Math.min(minutes, 23 * 60 + 59));
  const hours24 = Math.floor(safeMinutes / 60);
  const displayHour = hours24 % 12 || 12;
  const displayMinutes = safeMinutes % 60;
  const period = hours24 < 12 ? 'AM' : 'PM';

  return `${displayHour}:${String(displayMinutes).padStart(2, '0')} ${period}`;
}

function formatMeetingTimeRangeFromMinutes(startMinutes, endMinutes) {
  return [
    formatMeetingTimeFromMinutes(startMinutes),
    formatMeetingTimeFromMinutes(endMinutes),
  ].join(' - ');
}

function formatDurationLabel(minutes) {
  if (minutes === 30) {
    return '30 min';
  }

  if (minutes % 60 === 0) {
    return `${minutes / 60} h`;
  }

  return `${minutes / 60} h`;
}

function addMeetingTimeStartKeyboard() {
  const rows = [];
  const buttons = [];

  for (
    let minutes = ADD_MEETING_WORKDAY_START_MINUTES;
    minutes < ADD_MEETING_WORKDAY_END_MINUTES;
    minutes += ADD_MEETING_TIME_STEP_MINUTES
  ) {
    buttons.push(Markup.button.callback(
      formatMeetingTimeFromMinutes(minutes),
      `agregar_hora_inicio:${minutes}`
    ));
  }

  for (let index = 0; index < buttons.length; index += 3) {
    rows.push(buttons.slice(index, index + 3));
  }

  rows.push([
    Markup.button.callback('Escribir horario manual', 'agregar_hora_manual'),
  ]);
  rows.push([
    Markup.button.callback('Cancelar alta', 'agregar_cancelar'),
    Markup.button.callback('Volver al menú', 'menu_principal'),
  ]);

  return Markup.inlineKeyboard(rows);
}

function addMeetingDurationKeyboard(startMinutes) {
  const durationButtons = ADD_MEETING_DURATION_OPTIONS
    .filter((duration) => startMinutes + duration <= ADD_MEETING_WORKDAY_END_MINUTES)
    .map((duration) => Markup.button.callback(
      formatDurationLabel(duration),
      `agregar_duracion:${startMinutes}:${duration}`
    ));
  const rows = [];

  for (let index = 0; index < durationButtons.length; index += 2) {
    rows.push(durationButtons.slice(index, index + 2));
  }

  rows.push([
    Markup.button.callback('Cambiar inicio', 'agregar_hora_cambiar'),
  ]);
  rows.push([
    Markup.button.callback('Cancelar alta', 'agregar_cancelar'),
    Markup.button.callback('Volver al menú', 'menu_principal'),
  ]);

  return Markup.inlineKeyboard(rows);
}

function addMeetingConfirmKeyboard(hasConflicts = false) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(hasConflicts ? 'Guardar de todos modos' : 'Confirmar alta', 'agregar_confirmar'),
    ],
    [
      Markup.button.callback('Cancelar alta', 'agregar_cancelar'),
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ]);
}

function getAddMeetingSelectedPeople(flow) {
  if (!flow.selectedPeople) {
    flow.selectedPeople = new Set();
  }

  return flow.selectedPeople;
}

function addMeetingPeopleKeyboard(selectedPeople = new Set()) {
  const rows = [];
  const people = AVAILABLE_PEOPLE;

  for (let index = 0; index < people.length; index += 2) {
    const rowPeople = people.slice(index, index + 2);
    rows.push(rowPeople.map((person) => {
      const isSelected = selectedPeople.has(person.name);
      const marker = isSelected ? '[x]' : '[ ]';
      return Markup.button.callback(`${marker} ${person.name}`, `agregar_toggle:${person.id}`);
    }));
  }

  rows.push([
    Markup.button.callback('Listo con asignados', 'agregar_asignados_listo'),
  ]);
  rows.push([
    Markup.button.callback('Cancelar alta', 'agregar_cancelar'),
    Markup.button.callback('Volver al menú', 'menu_principal'),
  ]);

  return Markup.inlineKeyboard(rows);
}

function formatAddMeetingPeoplePrompt(flow) {
  const selectedPeople = [...getAddMeetingSelectedPeople(flow)];

  if (!selectedPeople.length) {
    return [
      'Selecciona las personas asignadas.',
      '',
      'También puedes escribirlas, por ejemplo:',
      'Yess / Carlos 2 / Lety',
    ].join('\n');
  }

  return [
    'Personas seleccionadas:',
    ...selectedPeople.map((person) => `- ${person}`),
    '',
    'Puedes seleccionar más o tocar Listo con asignados.',
  ].join('\n');
}

function showAddMeetingPeopleMenu(ctx, flow = getActiveAddMeetingFlow(ctx)) {
  if (!flow) {
    return replyWithMenuButton(ctx, 'No encontré un alta de reunión activa.');
  }

  return sendOrEdit(
    ctx,
    formatAddMeetingPeoplePrompt(flow),
    addMeetingPeopleKeyboard(getAddMeetingSelectedPeople(flow))
  );
}

function getAddMeetingPrompt(step) {
  const prompts = {
    [ADD_MEETING_STEPS.DATE]: [
      'Vamos a agregar una reunión.',
      '',
      'Elige una fecha o escribe una en formato YYYY-MM-DD.',
      'También puedes escribir hoy o día siguiente.',
      '',
      'También puedes escribir cancelar.',
    ].join('\n'),
    [ADD_MEETING_STEPS.TIME]: [
      'Escribe el horario.',
      'Ejemplo: 9:00 AM - 10:00 AM',
    ].join('\n'),
    [ADD_MEETING_STEPS.CLIENT]: 'Escribe el cliente o área.',
    [ADD_MEETING_STEPS.NAME]: 'Escribe el nombre de la reunión.',
    [ADD_MEETING_STEPS.ASSIGNED]: [
      'Escribe las personas asignadas.',
      'Ejemplo: Yess / Carlos 2 / Lety',
    ].join('\n'),
    [ADD_MEETING_STEPS.LINK]: [
      'Escribe el link o comentarios.',
      'Si no hay, escribe no.',
    ].join('\n'),
    [ADD_MEETING_STEPS.COLOR]: [
      'Elige el color de la fila.',
      '',
      'Blanco: clientes Sra. Lety o cualquier otra junta',
      'Verde: cliente de Pau',
      'Rojo claro: cliente de Yess',
      'Rojo fuerte: urgencia',
    ].join('\n'),
  };

  return prompts[step] || prompts[ADD_MEETING_STEPS.DATE];
}

function getAddMeetingColorLabel(value) {
  const color = ADD_MEETING_COLORS[value] || ADD_MEETING_COLORS.white;
  return color.label;
}

function parseMeetingDateInput(value) {
  const cleaned = String(value || '').trim().toLowerCase();

  if (cleaned === 'hoy') {
    return dayjs();
  }

  if (
    cleaned === 'mañana'
    || cleaned === 'manana'
    || cleaned === 'siguiente'
    || cleaned === 'dia siguiente'
    || cleaned === 'día siguiente'
  ) {
    return getNextAgendaDate();
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return null;
  }

  const parsedDate = dayjs(cleaned);

  if (!parsedDate.isValid() || parsedDate.format('YYYY-MM-DD') !== cleaned) {
    return null;
  }

  return parsedDate;
}

function formatAssignedPersonForAgenda(personName) {
  return normalizePersonName(personName) === 'Lety'
    ? 'Sra. Lety'
    : personName;
}

function formatAssignedPeopleForAgenda(people = []) {
  return people
    .map(formatAssignedPersonForAgenda)
    .join(' / ');
}

function formatAddMeetingSummary(data) {
  const normalizedPeople = parseAssignedPeople(data.asignadaA);
  const assignedText = normalizedPeople.length > 0
    ? formatAssignedPeopleForAgenda(normalizedPeople)
    : data.asignadaA;

  return [
    'Revisa la reunión antes de guardar:',
    '',
    `Fecha: ${data.date}`,
    `Horario: ${data.horaMexico}`,
    `Cliente: ${data.cliente}`,
    `Reunión: ${data.nombreMeeting}`,
    `Asignados: ${assignedText}`,
    `Link / Comentarios: ${data.linkComentarios || 'Sin link/comentarios'}`,
    `Color: ${getAddMeetingColorLabel(data.rowColor)}`,
  ].join('\n');
}

function hasTimeOverlap(firstRange, secondRange) {
  return timeToMinutes(firstRange.start) < timeToMinutes(secondRange.end)
    && timeToMinutes(firstRange.end) > timeToMinutes(secondRange.start);
}

function isValidForwardTimeRange(timeRange) {
  return Boolean(
    timeRange
    && timeToMinutes(timeRange.start) < timeToMinutes(timeRange.end)
  );
}

async function findAddMeetingConflicts(data) {
  const timeRange = parseTimeRange(data.horaMexico);
  const assignedPeople = expandAvailabilityPeople(parseAssignedPeople(data.asignadaA));

  if (!isValidForwardTimeRange(timeRange) || assignedPeople.length === 0) {
    return [];
  }

  const agenda = await getAgendaByDate(dayjs(data.date));

  if (getSource(agenda) === 'mock') {
    return [];
  }

  return agenda
    .filter((meeting) => meeting.start && meeting.end)
    .map((meeting) => {
      const matchingPeople = getSchedulingPeopleForMeeting(meeting)
        .filter((person) => assignedPeople.includes(person));

      return {
        meeting,
        people: matchingPeople,
      };
    })
    .filter((conflict) => (
      conflict.people.length > 0
      && hasTimeOverlap(timeRange, {
        start: conflict.meeting.start,
        end: conflict.meeting.end,
      })
    ));
}

function formatAddMeetingConflictWarning(conflicts) {
  if (!conflicts.length) {
    return '';
  }

  const lines = [
    'Aviso de disponibilidad',
    '',
    'Este horario ya está ocupado para alguna de las personas asignadas:',
    '',
  ];

  conflicts.slice(0, 6).forEach((conflict) => {
    lines.push(`Personas ocupadas: ${conflict.people.join(', ')}`);
    lines.push(formatMeetingShortBlock(conflict.meeting));
    lines.push('');
  });

  if (conflicts.length > 6) {
    lines.push(`Además hay ${conflicts.length - 6} empalme(s) más.`);
    lines.push('');
  }

  lines.push('Puedes guardar de todos modos o cancelar el alta.');

  return lines.join('\n').trim();
}

function formatAddMeetingReview(data, conflicts = []) {
  const lines = [
    formatAddMeetingSummary(data),
  ];

  if (conflicts.length > 0) {
    lines.push('', formatAddMeetingConflictWarning(conflicts));
  }

  return lines.join('\n');
}

async function showAddMeetingReview(ctx, flow) {
  flow.conflicts = await findAddMeetingConflicts(flow.data);

  return sendOrEdit(
    ctx,
    formatAddMeetingReview(flow.data, flow.conflicts),
    addMeetingConfirmKeyboard(flow.conflicts.length > 0)
  );
}

function getMeetingDateText(meeting) {
  return meeting.date || meeting.fecha || meeting.Fecha || '';
}

function getMeetingTimeText(meeting) {
  return meeting.horaMexico || meeting['Hora Mexico'] || `${meeting.start || '??:??'} - ${meeting.end || '??:??'}`;
}

function getMeetingAssignedPeopleText(meeting) {
  if (meeting.asignadaA) {
    return meeting.asignadaA;
  }

  if (meeting['Asignada a']) {
    return meeting['Asignada a'];
  }

  if (Array.isArray(meeting.personasAsignadas) && meeting.personasAsignadas.length > 0) {
    return meeting.personasAsignadas.join(' / ');
  }

  return '';
}

function getMeetingPeopleForNotifications(meeting) {
  const assignedPeople = Array.isArray(meeting.personasAsignadas) && meeting.personasAsignadas.length > 0
    ? meeting.personasAsignadas
    : parseAssignedPeople(getMeetingAssignedPeopleText(meeting));

  return expandAvailabilityPeople(assignedPeople);
}

function getRegisteredPersonRecipients() {
  const recipientsByChatId = new Map();

  getAllUserProfiles()
    .filter((profile) => profile.chatId && profile.personName)
    .forEach((profile) => {
      recipientsByChatId.set(String(profile.chatId), profile);
    });

  getActiveSubscribers()
    .filter((subscriber) => subscriber.chatId && subscriber.personName)
    .filter((subscriber) => !subscriber.chatType || subscriber.chatType === 'private')
    .forEach((subscriber) => {
      const key = String(subscriber.chatId);

      if (!recipientsByChatId.has(key)) {
        recipientsByChatId.set(key, subscriber);
      }
    });

  return [...recipientsByChatId.values()];
}

function getNotificationRecipientsForPeople(targetPeople = []) {
  const normalizedTargets = new Set(targetPeople.map(normalizePersonName).filter(Boolean));

  return getRegisteredPersonRecipients()
    .filter((recipient) => normalizedTargets.has(normalizePersonName(recipient.personName)));
}

function formatMeetingChangeNotification(meeting, actionLabel) {
  const lines = [
    actionLabel,
    '',
    `Fecha: ${getMeetingDateText(meeting)}`,
    `Horario: ${getMeetingTimeText(meeting)}`,
    `Cliente: ${meeting.cliente || meeting.Cliente || 'Sin cliente'}`,
    `Reunión: ${meeting.nombreMeeting || meeting['Nombre del meeting'] || 'Sin nombre'}`,
    `Asignados: ${getMeetingAssignedPeopleText(meeting) || 'Sin asignar'}`,
  ];

  const linkComentarios = meeting.linkComentarios || meeting['Link / Comentarios'] || '';

  if (linkComentarios) {
    lines.push(`Link / Comentarios: ${linkComentarios}`);
  }

  return lines.join('\n');
}

async function notifyRegisteredPeopleForMeeting(ctx, meeting, type) {
  const targetPeople = getMeetingPeopleForNotifications(meeting);

  if (!targetPeople.length) {
    return 0;
  }

  const actionLabel = type === 'delete'
    ? 'Se dio de baja una reunión de tu agenda.'
    : 'Se agregó una reunión a tu agenda.';
  const message = formatMeetingChangeNotification(meeting, actionLabel);
  const recipients = getNotificationRecipientsForPeople(targetPeople);
  let sentCount = 0;

  if (!recipients.length) {
    console.log(`No encontré chats registrados para notificar a: ${targetPeople.join(', ')}`);
    return 0;
  }

  for (const profile of recipients) {
    try {
      await bot.telegram.sendMessage(profile.chatId, message);
      sentCount += 1;
    } catch (error) {
      console.error(`No pude enviar notificación a ${profile.personName}:`, getSafeErrorMessage(error));

      if (shouldDeactivateSubscriber(error)) {
        deactivateSubscriber(profile.chatId, getSafeErrorMessage(error));
      }
    }
  }

  return sentCount;
}

function startAddMeetingFlow(ctx) {
  const userId = getUserId(ctx);

  if (!userId) {
    return replyWithMenuButton(ctx, 'No pude iniciar el alta de reunión para este usuario.');
  }

  addMeetingFlows.set(userId, {
    step: ADD_MEETING_STEPS.DATE,
    data: {
      rowColor: ADD_MEETING_COLORS.white.value,
    },
    selectedPeople: new Set(),
    conflicts: [],
  });

  return ctx.reply(getAddMeetingPrompt(ADD_MEETING_STEPS.DATE), addMeetingDateKeyboard());
}

function getAddMeetingDateFromMode(mode) {
  return mode === 'next' ? getNextAgendaDate() : dayjs();
}

function showAddMeetingCalendar(ctx, monthValue = dayjs()) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow || flow.step !== ADD_MEETING_STEPS.DATE) {
    return startAddMeetingFlow(ctx);
  }

  const parsedMonth = dayjs.isDayjs(monthValue)
    ? monthValue
    : dayjs(`${monthValue}-01`);
  const safeMonth = parsedMonth.isValid() ? parsedMonth : dayjs();

  return sendOrEdit(ctx, [
    'Elige la fecha de la reunión:',
    '',
    `${SPANISH_MONTHS[safeMonth.month()]} ${safeMonth.year()}`,
  ].join('\n'), addMeetingCalendarKeyboard(safeMonth));
}

function formatAddMeetingTimePrompt(flow) {
  return [
    'Elige la hora de inicio.',
    '',
    `Fecha: ${flow.data.date}`,
    '',
    'También puedes escribir el horario manualmente.',
    'Ejemplo: 9:00 AM - 10:00 AM',
  ].join('\n');
}

function showAddMeetingTimeMenu(ctx, flow = getActiveAddMeetingFlow(ctx)) {
  if (!flow || flow.step !== ADD_MEETING_STEPS.TIME) {
    return replyWithMenuButton(ctx, 'No encontré un alta de reunión esperando horario.');
  }

  return sendOrEdit(
    ctx,
    formatAddMeetingTimePrompt(flow),
    addMeetingTimeStartKeyboard()
  );
}

function showAddMeetingManualTimePrompt(ctx) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow || flow.step !== ADD_MEETING_STEPS.TIME) {
    return replyWithMenuButton(ctx, 'No encontré un alta de reunión esperando horario.');
  }

  return sendOrEdit(ctx, [
    'Escribe el horario manualmente.',
    '',
    'Ejemplo: 9:00 AM - 10:00 AM',
  ].join('\n'), addMeetingCancelKeyboard());
}

function showAddMeetingDurationMenu(ctx, startMinutes) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow || flow.step !== ADD_MEETING_STEPS.TIME) {
    return replyWithMenuButton(ctx, 'No encontré un alta de reunión esperando horario.');
  }

  if (
    !Number.isFinite(startMinutes)
    || startMinutes < ADD_MEETING_WORKDAY_START_MINUTES
    || startMinutes >= ADD_MEETING_WORKDAY_END_MINUTES
  ) {
    return showAddMeetingTimeMenu(ctx, flow);
  }

  return sendOrEdit(ctx, [
    'Elige la duración.',
    '',
    `Inicio: ${formatMeetingTimeFromMinutes(startMinutes)}`,
  ].join('\n'), addMeetingDurationKeyboard(startMinutes));
}

function setAddMeetingTimeRange(ctx, startMinutes, durationMinutes) {
  const flow = getActiveAddMeetingFlow(ctx);
  const endMinutes = startMinutes + durationMinutes;

  if (!flow || flow.step !== ADD_MEETING_STEPS.TIME) {
    return replyWithMenuButton(ctx, 'No encontré un alta de reunión esperando horario.');
  }

  if (
    !Number.isFinite(startMinutes)
    || !Number.isFinite(durationMinutes)
    || startMinutes < ADD_MEETING_WORKDAY_START_MINUTES
    || endMinutes > ADD_MEETING_WORKDAY_END_MINUTES
    || startMinutes >= endMinutes
  ) {
    return showAddMeetingTimeMenu(ctx, flow);
  }

  flow.data.horaMexico = formatMeetingTimeRangeFromMinutes(startMinutes, endMinutes);
  flow.step = ADD_MEETING_STEPS.CLIENT;

  return sendOrEdit(ctx, [
    `Horario seleccionado: ${flow.data.horaMexico}`,
    '',
    getAddMeetingPrompt(flow.step),
  ].join('\n'), addMeetingCancelKeyboard());
}

function setAddMeetingDateValue(ctx, date) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow || flow.step !== ADD_MEETING_STEPS.DATE) {
    return startAddMeetingFlow(ctx);
  }

  const safeDate = dayjs.isDayjs(date) ? date : dayjs(date);

  if (!safeDate.isValid()) {
    return showAddMeetingCalendar(ctx);
  }

  flow.data.date = safeDate.format('YYYY-MM-DD');
  flow.step = ADD_MEETING_STEPS.TIME;

  return showAddMeetingTimeMenu(ctx, flow);
}

function setAddMeetingDate(ctx, mode) {
  return setAddMeetingDateValue(ctx, getAddMeetingDateFromMode(mode));
}

function toggleAddMeetingPerson(ctx, personId) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow || flow.step !== ADD_MEETING_STEPS.ASSIGNED) {
    return replyWithMenuButton(ctx, 'No encontré un alta de reunión esperando asignados.');
  }

  const person = getPersonById(personId);

  if (!person) {
    return showAddMeetingPeopleMenu(ctx, flow);
  }

  const selectedPeople = getAddMeetingSelectedPeople(flow);

  if (selectedPeople.has(person.name)) {
    selectedPeople.delete(person.name);
  } else {
    selectedPeople.add(person.name);
  }

  return showAddMeetingPeopleMenu(ctx, flow);
}

function finishAddMeetingPeopleSelection(ctx) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow || flow.step !== ADD_MEETING_STEPS.ASSIGNED) {
    return replyWithMenuButton(ctx, 'No encontré un alta de reunión esperando asignados.');
  }

  const selectedPeople = [...getAddMeetingSelectedPeople(flow)];

  if (!selectedPeople.length) {
    return showAddMeetingPeopleMenu(ctx, flow);
  }

  flow.data.asignadaA = formatAssignedPeopleForAgenda(selectedPeople);
  flow.step = ADD_MEETING_STEPS.LINK;

  return sendOrEdit(ctx, getAddMeetingPrompt(flow.step), addMeetingLinkKeyboard());
}

async function finishAddMeetingWithoutLink(ctx) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow || flow.step !== ADD_MEETING_STEPS.LINK) {
    return replyWithMenuButton(ctx, 'No encontré un alta de reunión esperando link o comentarios.');
  }

  flow.data.linkComentarios = '';
  flow.step = ADD_MEETING_STEPS.COLOR;

  return sendOrEdit(ctx, getAddMeetingPrompt(flow.step), addMeetingColorKeyboard());
}

async function setAddMeetingColor(ctx, colorValue) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow || flow.step !== ADD_MEETING_STEPS.COLOR) {
    return replyWithMenuButton(ctx, 'No encontré un alta de reunión esperando color.');
  }

  const color = ADD_MEETING_COLORS[colorValue] || ADD_MEETING_COLORS.white;
  flow.data.rowColor = color.value;
  flow.step = ADD_MEETING_STEPS.CONFIRM;

  return showAddMeetingReview(ctx, flow);
}

async function handleAddMeetingText(ctx) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow) {
    return undefined;
  }

  const text = String(ctx.message?.text || '').trim();
  const cleaned = text.toLowerCase();

  if (cleaned === 'cancelar' || cleaned === 'cancelar alta') {
    clearAddMeetingFlow(ctx);
    return replyWithMenuButton(ctx, 'Alta de reunión cancelada.');
  }

  if (text.startsWith('/')) {
    return ctx.reply('Termina el alta actual o escribe cancelar.', addMeetingCancelKeyboard());
  }

  if (flow.step === ADD_MEETING_STEPS.DATE) {
    const date = parseMeetingDateInput(text);

    if (!date) {
      return ctx.reply('Fecha inválida. Usa formato YYYY-MM-DD o elige un botón.', addMeetingDateKeyboard());
    }

    flow.data.date = date.format('YYYY-MM-DD');
    flow.step = ADD_MEETING_STEPS.TIME;
    return showAddMeetingTimeMenu(ctx, flow);
  }

  if (flow.step === ADD_MEETING_STEPS.TIME) {
    const timeRange = parseTimeRange(text);

    if (!isValidForwardTimeRange(timeRange)) {
      return ctx.reply(
        'Horario inválido. Elige una hora o escribe algo como: 9:00 AM - 10:00 AM',
        addMeetingTimeStartKeyboard()
      );
    }

    flow.data.horaMexico = formatMeetingTimeRangeFromMinutes(
      timeToMinutes(timeRange.start),
      timeToMinutes(timeRange.end)
    );
    flow.step = ADD_MEETING_STEPS.CLIENT;
    return ctx.reply(getAddMeetingPrompt(flow.step), addMeetingCancelKeyboard());
  }

  if (flow.step === ADD_MEETING_STEPS.CLIENT) {
    if (!text) {
      return ctx.reply('Escribe el cliente o área.', addMeetingCancelKeyboard());
    }

    flow.data.cliente = normalizeClientName(text);
    flow.step = ADD_MEETING_STEPS.NAME;
    return ctx.reply(getAddMeetingPrompt(flow.step), addMeetingCancelKeyboard());
  }

  if (flow.step === ADD_MEETING_STEPS.NAME) {
    if (!text) {
      return ctx.reply('Escribe el nombre de la reunión.', addMeetingCancelKeyboard());
    }

    flow.data.nombreMeeting = text;
    flow.step = ADD_MEETING_STEPS.ASSIGNED;
    return showAddMeetingPeopleMenu(ctx, flow);
  }

  if (flow.step === ADD_MEETING_STEPS.ASSIGNED) {
    const assignedPeople = parseAssignedPeople(text);

    if (assignedPeople.length === 0) {
      return ctx.reply('Escribe al menos una persona asignada.', addMeetingCancelKeyboard());
    }

    flow.data.asignadaA = formatAssignedPeopleForAgenda(assignedPeople);
    flow.selectedPeople = new Set(assignedPeople);
    flow.step = ADD_MEETING_STEPS.LINK;
    return ctx.reply(getAddMeetingPrompt(flow.step), addMeetingLinkKeyboard());
  }

  if (flow.step === ADD_MEETING_STEPS.LINK) {
    flow.data.linkComentarios = ['no', 'sin link', 'sin comentarios', '-'].includes(cleaned)
      ? ''
      : text;
    flow.step = ADD_MEETING_STEPS.COLOR;

    return ctx.reply(getAddMeetingPrompt(flow.step), addMeetingColorKeyboard());
  }

  if (flow.step === ADD_MEETING_STEPS.COLOR) {
    const colorByText = {
      blanco: ADD_MEETING_COLORS.white.value,
      white: ADD_MEETING_COLORS.white.value,
      normal: ADD_MEETING_COLORS.white.value,
      verde: ADD_MEETING_COLORS.green.value,
      'verde claro': ADD_MEETING_COLORS.green.value,
      green: ADD_MEETING_COLORS.green.value,
      rojo: ADD_MEETING_COLORS.red.value,
      'rojo claro': ADD_MEETING_COLORS.red.value,
      red: ADD_MEETING_COLORS.red.value,
      'rojo fuerte': ADD_MEETING_COLORS.strongRed.value,
      'rojo intenso': ADD_MEETING_COLORS.strongRed.value,
      urgencia: ADD_MEETING_COLORS.strongRed.value,
      urgente: ADD_MEETING_COLORS.strongRed.value,
      strong_red: ADD_MEETING_COLORS.strongRed.value,
      strongred: ADD_MEETING_COLORS.strongRed.value,
    };

    return setAddMeetingColor(ctx, colorByText[cleaned] || ADD_MEETING_COLORS.white.value);
  }

  return undefined;
}

async function confirmAddMeeting(ctx) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow || flow.step !== ADD_MEETING_STEPS.CONFIRM) {
    return replyWithMenuButton(ctx, 'No encontré una reunión pendiente por confirmar.');
  }

  try {
    const alreadyWarnedAboutConflicts = Array.isArray(flow.conflicts) && flow.conflicts.length > 0;
    const latestConflicts = await findAddMeetingConflicts(flow.data);

    if (latestConflicts.length > 0 && !alreadyWarnedAboutConflicts) {
      flow.conflicts = latestConflicts;

      return ctx.reply(
        formatAddMeetingReview(flow.data, latestConflicts),
        addMeetingConfirmKeyboard(true)
      );
    }

    await addMeetingRow(flow.data);
    const notifiedCount = await notifyRegisteredPeopleForMeeting(ctx, flow.data, 'add');
    clearAddMeetingFlow(ctx);

    return replyWithMenuButton(ctx, [
      'Reunión agregada correctamente.',
      `Notificaciones enviadas: ${notifiedCount}.`,
      '',
      formatAddMeetingSummary(flow.data),
    ].join('\n'));
  } catch (error) {
    const safeErrorMessage = getSafeErrorMessage(error);
    console.error('No se pudo agregar la reunión en Apps Script:', safeErrorMessage);

    return ctx.reply([
      'No pude agregar la reunión en Google Sheets.',
      `Detalle: ${safeErrorMessage}`,
      '',
      'Cuando actualices y redespliegues Apps Script, puedes volver a tocar Confirmar alta.',
    ].join('\n'), addMeetingConfirmKeyboard());
  }
}

function deleteMeetingCancelKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Cancelar baja', 'baja_cancelar'),
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ]);
}

function deleteMeetingConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Confirmar baja', 'baja_confirmar'),
    ],
    [
      Markup.button.callback('Cancelar baja', 'baja_cancelar'),
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ]);
}

function truncateButtonText(value, maxLength = 52) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function formatDeleteMeetingButtonLabel(meeting, index) {
  return truncateButtonText([
    `${index + 1}.`,
    meeting.start || meeting.horaMexico || '??:??',
    meeting.cliente || 'Sin cliente',
    meeting.nombreMeeting || 'Sin nombre',
  ].join(' '));
}

function getDeleteMeetingButtons(meetings) {
  const rows = meetings.map((meeting, index) => ([
    Markup.button.callback(formatDeleteMeetingButtonLabel(meeting, index), `baja_select:${index}`),
  ]));

  rows.push([
    Markup.button.callback('Cancelar baja', 'baja_cancelar'),
    Markup.button.callback('Volver al menú', 'menu_principal'),
  ]);

  return rows;
}

function formatDeleteMeetingChoices(target, meetings) {
  const lines = [
    'Selecciona la reunión que quieres dar de baja:',
    '',
    `Fecha: ${target.label}`,
    '',
  ];

  meetings.forEach((meeting, index) => {
    lines.push(`${index + 1}. ${meeting.horaMexico || `${meeting.start || '??:??'} - ${meeting.end || '??:??'}`}`);
    lines.push(`Cliente: ${meeting.cliente || 'Sin cliente'}`);
    lines.push(`Reunión: ${meeting.nombreMeeting || 'Sin nombre'}`);
    lines.push(`Asignados: ${meeting.asignadaA || formatAssignedPeople(meeting)}`);
    lines.push('');
  });

  return lines.join('\n').trim();
}

function formatDeleteMeetingSummary(target, meeting) {
  return [
    'Revisa la reunión antes de darla de baja:',
    '',
    `Fecha: ${target.label}`,
    `Fila en Google Sheets: ${meeting.rowNumber}`,
    '',
    formatMeetingBlock(meeting),
  ].join('\n');
}

async function sendOrEdit(ctx, message, keyboard) {
  if (ctx.callbackQuery) {
    return ctx.editMessageText(message, keyboard)
      .catch((error) => {
        if (isMessageNotModifiedError(error)) {
          return undefined;
        }

        return ctx.reply(message, keyboard);
      });
  }

  return ctx.reply(message, keyboard);
}

async function startDeleteMeetingFlow(ctx, target = buildDateTarget('today')) {
  const userId = getUserId(ctx);

  if (!userId) {
    return replyWithMenuButton(ctx, 'No pude iniciar la baja de reunión para este usuario.');
  }

  const agenda = await getAgendaByDate(target.date);

  if (getSource(agenda) === 'mock') {
    return replyWithMenuButton(ctx, [
      'No puedo dar de baja reuniones porque no estoy leyendo Google Sheets real.',
      'Revisa la conexión con Apps Script y vuelve a intentar.',
    ].join('\n'));
  }

  if (!agenda.length) {
    return replyWithMenuButton(ctx, [
      'No encontré reuniones para dar de baja.',
      '',
      `Fecha: ${target.label}`,
    ].join('\n'));
  }

  const meetings = agenda.filter((meeting) => Number.isFinite(Number(meeting.rowNumber)));

  if (!meetings.length) {
    return replyWithMenuButton(ctx, [
      'No pude identificar las filas reales de Google Sheets para dar de baja.',
      'Actualiza y redespliega Apps Script con la versión que agrega rowNumber y DELETE_MEETING.',
    ].join('\n'));
  }

  deleteMeetingFlows.set(userId, {
    target: {
      mode: target.mode,
      iso: target.iso,
      label: target.label,
    },
    meetings,
    selectedIndex: null,
  });

  return sendOrEdit(
    ctx,
    formatDeleteMeetingChoices(target, meetings),
    Markup.inlineKeyboard(getDeleteMeetingButtons(meetings))
  );
}

async function selectDeleteMeeting(ctx, selectedIndex) {
  const flow = getActiveDeleteMeetingFlow(ctx);

  if (!flow) {
    return showDeleteMeetingDateMenu(ctx);
  }

  const meeting = flow.meetings[selectedIndex];

  if (!meeting) {
    return startDeleteMeetingFlow(ctx, buildDateTarget(flow.target.mode, flow.target.iso));
  }

  flow.selectedIndex = selectedIndex;

  return ctx.editMessageText(
    formatDeleteMeetingSummary(flow.target, meeting),
    deleteMeetingConfirmKeyboard()
  ).catch(() => ctx.reply(formatDeleteMeetingSummary(flow.target, meeting), deleteMeetingConfirmKeyboard()));
}

async function confirmDeleteMeeting(ctx) {
  const flow = getActiveDeleteMeetingFlow(ctx);

  if (!flow || flow.selectedIndex === null) {
    return replyWithMenuButton(ctx, 'No encontré una reunión pendiente por dar de baja.');
  }

  const meeting = flow.meetings[flow.selectedIndex];

  if (!meeting?.rowNumber) {
    return replyWithMenuButton(ctx, 'No pude identificar la fila de esa reunión en Google Sheets.');
  }

  try {
    await deleteMeetingRow({
      date: flow.target.iso,
      rowNumber: meeting.rowNumber,
    });
    const notifiedCount = await notifyRegisteredPeopleForMeeting(ctx, {
      ...meeting,
      date: flow.target.iso,
      asignadaA: meeting.asignadaA || formatAssignedPeople(meeting),
    }, 'delete');
    clearDeleteMeetingFlow(ctx);

    return replyWithMenuButton(ctx, [
      'Reunión dada de baja correctamente.',
      `Notificaciones enviadas: ${notifiedCount}.`,
      '',
      formatDeleteMeetingSummary(flow.target, meeting),
    ].join('\n'));
  } catch (error) {
    const safeErrorMessage = getSafeErrorMessage(error);
    console.error('No se pudo dar de baja la reunión en Apps Script:', safeErrorMessage);

    return ctx.reply([
      'No pude dar de baja la reunión en Google Sheets.',
      `Detalle: ${safeErrorMessage}`,
      '',
      'Revisa que Apps Script tenga la acción DELETE_MEETING desplegada y vuelve a intentar.',
    ].join('\n'), deleteMeetingConfirmKeyboard());
  }
}

function formatAssignedPeople(meeting) {
  const assignedPeople = Array.isArray(meeting.personasAsignadas)
    ? meeting.personasAsignadas
    : [];

  return assignedPeople.length > 0
    ? assignedPeople.join(', ')
    : 'Sin asignar';
}

function formatMeetingTimeDisplay(meeting) {
  if (meeting.start && meeting.end) {
    return `${meeting.start} - ${meeting.end}`;
  }

  return meeting.horaMexico || '??:?? - ??:??';
}

function formatMeetingBlock(meeting) {
  return [
    formatMeetingTimeDisplay(meeting),
    `Cliente: ${meeting.cliente || 'Sin cliente'}`,
    `Reunión: ${meeting.nombreMeeting || 'Sin nombre'}`,
    `Asignados: ${formatAssignedPeople(meeting)}`,
  ].join('\n');
}

function formatMeetingShortBlock(meeting) {
  return [
    formatMeetingTimeDisplay(meeting),
    `Cliente: ${meeting.cliente || 'Sin cliente'}`,
    `Reunión: ${meeting.nombreMeeting || 'Sin nombre'}`,
  ].join('\n');
}

function formatLongSpanishDate(date) {
  const parsedDate = dayjs.isDayjs(date) ? date : dayjs(date);
  const safeDate = parsedDate.isValid() ? parsedDate : dayjs();

  return [
    SPANISH_DAYS[safeDate.day()],
    safeDate.date(),
    'de',
    SPANISH_MONTHS[safeDate.month()],
    'de',
    safeDate.year(),
  ].join(' ');
}

function formatDigestMeetingBlock(meeting) {
  const lines = [
    meeting.horaMexico || `${meeting.start || '??:??'} - ${meeting.end || '??:??'}`,
    `Cliente: ${meeting.cliente || 'Sin cliente'}`,
    `Nombre del meeting: ${meeting.nombreMeeting || 'Sin nombre'}`,
    `Asignada a: ${meeting.asignadaA || formatAssignedPeople(meeting)}`,
  ];

  if (meeting.linkComentarios) {
    lines.push(`Link / Comentarios: ${meeting.linkComentarios}`);
  }

  return lines.join('\n');
}

function splitLongMessage(message, maxLength = 3800) {
  const chunks = [];
  const paragraphs = String(message || '').split('\n\n');
  let currentChunk = '';

  paragraphs.forEach((paragraph) => {
    const candidate = currentChunk
      ? `${currentChunk}\n\n${paragraph}`
      : paragraph;

    if (candidate.length <= maxLength) {
      currentChunk = candidate;
      return;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    currentChunk = paragraph;
  });

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.length ? chunks : [''];
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readSentReminderStore() {
  try {
    if (!fs.existsSync(SENT_REMINDERS_FILE)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(SENT_REMINDERS_FILE, 'utf8') || '{}');
  } catch (error) {
    console.error('No pude leer recordatorios enviados; iniciaré memoria limpia:', getSafeErrorMessage(error));
    return {};
  }
}

function pruneSentReminderStore(store, currentDateKey) {
  const minDate = dayjs(currentDateKey).subtract(7, 'day');

  Object.keys(store).forEach((dateKey) => {
    const parsedDate = dayjs(dateKey);

    if (!parsedDate.isValid() || parsedDate.isBefore(minDate, 'day')) {
      delete store[dateKey];
    }
  });

  return store;
}

function loadSentReminderKeys() {
  const todayKey = dayjs().format('YYYY-MM-DD');
  const store = readSentReminderStore();
  const todayKeys = Array.isArray(store[todayKey]) ? store[todayKey] : [];

  return new Set(todayKeys);
}

function saveSentReminderKeys(dateKey) {
  try {
    ensureDataDir();

    const store = pruneSentReminderStore(readSentReminderStore(), dateKey);
    store[dateKey] = [...sentReminderKeys]
      .filter((key) => key.includes(`|${dateKey}|`));

    fs.writeFileSync(SENT_REMINDERS_FILE, `${JSON.stringify(store, null, 2)}\n`);
  } catch (error) {
    console.error('No pude guardar memoria de recordatorios:', getSafeErrorMessage(error));
  }
}

function sanitizeLogMessage(value) {
  let message = String(value || '');
  const sensitiveValues = [
    TELEGRAM_BOT_TOKEN,
    process.env.GOOGLE_APPS_SCRIPT_SECRET,
  ].filter(Boolean);

  sensitiveValues.forEach((secret) => {
    message = message.split(secret).join('[REDACTED]');
  });

  return message
    .replace(/\/bot\d{6,}:[A-Za-z0-9_-]+/g, '/bot[REDACTED]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/(secret["'=:\s]+)[^"',\s}]+/gi, '$1[REDACTED]');
}

function getSafeErrorMessage(error) {
  return sanitizeLogMessage(error?.description || error?.message || error);
}

function isTransientNetworkError(error) {
  const message = getSafeErrorMessage(error).toLowerCase();

  return message.includes('socket hang up')
    || message.includes('econnreset')
    || message.includes('etimedout')
    || message.includes('timeout')
    || message.includes('aborted')
    || message.includes('econnaborted')
    || message.includes('epipe')
    || message.includes('fetch failed')
    || message.includes('network');
}

function formatDailyAgendaDigest(date, agenda) {
  const response = [
    `Agenda ${formatLongSpanishDate(date)}`,
    '',
  ];

  if (!agenda.length) {
    response.push('No encontré reuniones para el día siguiente.');
  } else {
    response.push(agenda.map(formatDigestMeetingBlock).join('\n\n'));
  }

  if (getSource(agenda) === 'mock') {
    response.push('', SOURCE_NOTE);
  }

  return response.join('\n');
}

function formatAgendaResponse(title, agenda) {
  const response = [
    title,
    '',
  ];

  if (!agenda.length) {
    response.push('No encontré reuniones.');
  } else {
    response.push(agenda.map(formatMeetingBlock).join('\n\n'));
  }

  if (getSource(agenda) === 'mock') {
    response.push('', SOURCE_NOTE);
  }

  return response.join('\n');
}

function formatNextMeetingResponse(meeting, personName) {
  const person = normalizePersonName(personName || 'Carlos');

  if (!meeting) {
    return [
      `No encontré reuniones próximas para ${person}.`,
    ].join('\n');
  }

  const response = [
    `Siguiente reunión para ${person}`,
    '',
    formatMeetingBlock(meeting),
  ];

  if (getSource(meeting) === 'mock') {
    response.push('', SOURCE_NOTE);
  }

  return response.join('\n');
}

function formatConflictsResponse(conflicts, target = buildDateTarget('today')) {
  if (!conflicts.length) {
    const response = [
      'No se detectaron empalmes por persona.',
      '',
      `Fecha: ${target.label}`,
    ];

    if (getSource(conflicts) === 'mock') {
      response.push('', SOURCE_NOTE);
    }

    return response.join('\n');
  }

  const groupedConflicts = groupConflictsByPerson(conflicts);
  const lines = [
    'Empalmes detectados',
    '',
    `Fecha: ${target.label}`,
    '',
  ];

  Object.entries(groupedConflicts).forEach(([person, personConflicts]) => {
    lines.push(person);

    personConflicts.forEach((conflict) => {
      lines.push(formatMeetingShortBlock(conflict.meetingA));
      lines.push('');
      lines.push('Se empalma con:');
      lines.push('');
      lines.push(formatMeetingShortBlock(conflict.meetingB));
      lines.push('');
    });
  });

  if (getSource(conflicts) === 'mock') {
    lines.push(SOURCE_NOTE);
  }

  return lines.join('\n').trim();
}

function formatAvailabilityResponse(blocks, people, target = buildDateTarget('today')) {
  const peopleText = people.length > 0 ? people.join(', ') : 'las personas indicadas';
  const peopleLabel = people.length === 1 ? 'Persona:' : 'Personas:';

  if (!blocks.length) {
    const response = [
      'No se encontraron espacios libres comunes para las personas seleccionadas.',
      '',
      `Fecha: ${target.label}`,
      '',
      peopleLabel,
      peopleText,
    ];

    if (getSource(blocks) === 'mock') {
      response.push('', SOURCE_NOTE);
    }

    return response.join('\n');
  }

  const response = [
    people.length === 1 ? 'Disponibilidad' : 'Disponibilidad común',
    '',
    `Fecha: ${target.label}`,
    '',
    peopleLabel,
    peopleText,
    '',
    'Bloques libres:',
    blocks.map((block) => `${block.start} - ${block.end}`).join('\n'),
  ];

  if (getSource(blocks) === 'mock') {
    response.push('', SOURCE_NOTE);
  }

  return response.join('\n');
}

function replyWithMenuButton(ctx, message) {
  return ctx.reply(message, backToMenuKeyboard());
}

async function replyTodayAgenda(ctx) {
  const agenda = await getTodayAgenda();
  return replyWithMenuButton(ctx, formatAgendaResponse('Agenda de hoy', agenda));
}

async function replyMyTodayAgenda(ctx) {
  const profile = getCurrentProfile(ctx);

  if (!profile) {
    await ctx.reply('Primero necesito saber quién eres.');
    return showProfileMenu(ctx);
  }

  const meetings = await getTodayMeetingsForPerson(profile.personName);
  return replyWithMenuButton(ctx, formatAgendaResponse(`Mis juntas de hoy (${profile.personName})`, meetings));
}

async function replyTomorrowAgenda(ctx) {
  const agenda = await getTomorrowAgenda();
  return replyWithMenuButton(ctx, formatAgendaResponse('Agenda del día siguiente', agenda));
}

async function replyNextMeeting(ctx, personName = 'Carlos') {
  const meeting = await getNextMeeting(personName);
  return replyWithMenuButton(ctx, formatNextMeetingResponse(meeting, personName));
}

async function replyConflicts(ctx, target = buildDateTarget('today')) {
  const conflicts = await getConflicts(target.date);
  return replyWithMenuButton(ctx, formatConflictsResponse(conflicts, target));
}

async function replyAvailability(ctx, people, target = buildDateTarget('today')) {
  const availability = await getAvailability(target.date, people);
  return replyWithMenuButton(ctx, formatAvailabilityResponse(availability, people, target));
}

async function replySortAgenda(ctx, target = buildDateTarget('today')) {
  try {
    const result = await sortAgendaRowsByDate(target.date);
    const response = [
      'Agenda ordenada por hora correctamente.',
      '',
      `Fecha: ${target.label}`,
    ];

    if (result.sheetName) {
      response.push(`Pestaña: ${result.sheetName}`);
    }

    return replyWithMenuButton(ctx, response.join('\n'));
  } catch (error) {
    const safeErrorMessage = getSafeErrorMessage(error);
    console.error('No se pudo ordenar la agenda en Apps Script:', safeErrorMessage);

    return replyWithMenuButton(ctx, [
      'No pude ordenar la agenda en Google Sheets.',
      `Detalle: ${safeErrorMessage}`,
      '',
      'Revisa que Apps Script tenga la acción SORT_AGENDA_BY_DATE desplegada y vuelve a intentar.',
    ].join('\n'));
  }
}

function replyHelp(ctx) {
  return replyWithMenuButton(ctx, helpMessage);
}

function replyAddMeeting(ctx) {
  return startAddMeetingFlow(ctx);
}

async function handleAction(ctx, handler) {
  await answerCallback(ctx);
  return handler(ctx);
}

function groupConflictsByPerson(conflicts) {
  return conflicts.reduce((groups, conflict) => {
    const person = conflict.person || conflict.persona;

    if (!groups[person]) {
      groups[person] = [];
    }

    groups[person].push(conflict);
    return groups;
  }, {});
}

function getReminderKey(profile, meeting, dateKey) {
  const profileKey = profile.chatId || profile.userId || profile.personName;
  const meetingKey = meeting.rowNumber
    ? `row:${meeting.rowNumber}`
    : [
      meeting.start,
      meeting.end,
      meeting.cliente,
      meeting.nombreMeeting,
    ].join(':');

  return [
    profileKey,
    dateKey,
    meetingKey,
    meeting.start,
  ].join('|');
}

function formatReminderMessage(profile, meeting, minutesUntilStart) {
  const timeText = minutesUntilStart <= 0
    ? 'Está por iniciar.'
    : `Empieza en ${minutesUntilStart} min.`;

  return [
    `Recordatorio para ${profile.personName}`,
    '',
    timeText,
    '',
    formatMeetingBlock(meeting),
  ].join('\n');
}

async function sendUpcomingMeetingReminders() {
  if (isCheckingReminders) {
    return;
  }

  const profiles = getRegisteredPersonRecipients();

  if (!profiles.length) {
    return;
  }

  isCheckingReminders = true;

  try {
    const now = dayjs();
    const todayKey = now.format('YYYY-MM-DD');
    const nowMinutes = now.hour() * 60 + now.minute();
    const agenda = await getTodayAgenda({ silent: true });

    await Promise.all(profiles.map(async (profile) => {
      const meetings = agenda.filter((meeting) => isPersonInMeeting(meeting, profile.personName));

      for (const meeting of meetings) {
        const startMinutes = timeToMinutes(meeting.start);
        const minutesUntilStart = startMinutes - nowMinutes;

        if (
          minutesUntilStart < reminderMinimumMinutesBefore
          || minutesUntilStart > reminderMinutesBefore
        ) {
          continue;
        }

        const reminderKey = getReminderKey(profile, meeting, todayKey);

        if (sentReminderKeys.has(reminderKey)) {
          continue;
        }

        sentReminderKeys.add(reminderKey);
        saveSentReminderKeys(todayKey);

        await bot.telegram.sendMessage(
          profile.chatId,
          formatReminderMessage(profile, meeting, minutesUntilStart)
        ).catch((error) => {
          console.error(`No pude enviar recordatorio a ${profile.personName}:`, getSafeErrorMessage(error));
        });
      }
    }));
  } finally {
    isCheckingReminders = false;
  }
}

function shouldDeactivateSubscriber(error) {
  const description = String(error?.description || error?.message || '').toLowerCase();

  return error?.code === 403
    || error?.response?.error_code === 403
    || description.includes('bot was blocked')
    || description.includes('chat not found')
    || description.includes('user is deactivated');
}

async function sendLongTelegramMessage(chatId, message, extra = {}) {
  const chunks = splitLongMessage(message);

  for (let index = 0; index < chunks.length; index += 1) {
    const isLastChunk = index === chunks.length - 1;
    await bot.telegram.sendMessage(chatId, chunks[index], isLastChunk ? extra : {});
  }
}

function ensureGeneratedDir() {
  if (!fs.existsSync(GENERATED_DIR)) {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'tamano desconocido';
  }

  if (bytes < 1024) {
    return `${bytes} bytes`;
  }

  return `${Math.round(bytes / 1024)} KB`;
}

function getAgendaImagePath(digest) {
  return path.join(GENERATED_DIR, `agenda-${digest.target.iso}.${AGENDA_IMAGE_EXTENSION}`);
}

async function writeAgendaImageFile(digest) {
  ensureGeneratedDir();

  const imageBuffer = await createAgendaImageBuffer(digest.target.date, digest.agenda, {
    format: AGENDA_IMAGE_FORMAT,
  });
  const imagePath = getAgendaImagePath(digest);
  const filename = path.basename(imagePath);
  fs.writeFileSync(imagePath, imageBuffer);
  console.log(`Imagen de agenda generada (${digest.target.iso}): ${formatBytes(imageBuffer.length)}.`);

  return {
    imageBuffer,
    imagePath,
    filename,
    bytes: imageBuffer.length,
  };
}

function createTelegramApiUrl(method) {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

function createAbortTimeoutError(method) {
  const error = new Error(`TELEGRAM_${method.toUpperCase()}_TIMEOUT`);
  error.code = 'ETIMEDOUT';
  return error;
}

function createTelegramApiError(method, data, status) {
  const error = new Error(data?.description || `TELEGRAM_${method.toUpperCase()}_${status || 'ERROR'}`);
  error.code = data?.error_code || status;
  error.response = {
    error_code: data?.error_code || status,
    description: data?.description || error.message,
  };

  return error;
}

async function callTelegramMultipart(method, fields, file) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_UPLOAD_TIMEOUT_MS);
  const form = new FormData();

  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }

    form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  });

  form.append(
    file.fieldName,
    new Blob([file.buffer], { type: file.contentType }),
    file.filename
  );

  try {
    const response = await fetch(createTelegramApiUrl(method), {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    const responseText = await response.text();
    let data;

    try {
      data = JSON.parse(responseText);
    } catch (error) {
      throw new Error(`TELEGRAM_${method.toUpperCase()}_INVALID_JSON_RESPONSE`);
    }

    if (!response.ok || !data.ok) {
      throw createTelegramApiError(method, data, response.status);
    }

    return data.result;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw createAbortTimeoutError(method);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getTelegramImageFile(image, fieldName) {
  return {
    fieldName,
    buffer: image.imageBuffer,
    path: image.imagePath,
    filename: image.filename,
    contentType: 'image/jpeg',
  };
}

async function callTelegramMultipartWithCurl(method, fields, file) {
  const args = [
    '--silent',
    '--show-error',
    '--max-time',
    String(TELEGRAM_UPLOAD_CURL_TIMEOUT_SECONDS),
    createTelegramApiUrl(method),
  ];

  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }

    args.push('-F', `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  });

  args.push('-F', `${file.fieldName}=@${file.path};filename=${file.filename};type=${file.contentType}`);

  try {
    const { stdout } = await execFileAsync('curl', args, {
      timeout: (TELEGRAM_UPLOAD_CURL_TIMEOUT_SECONDS + 3) * 1000,
      maxBuffer: 1024 * 1024,
    });
    let data;

    try {
      data = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`TELEGRAM_${method.toUpperCase()}_CURL_INVALID_JSON_RESPONSE`);
    }

    if (!data.ok) {
      throw createTelegramApiError(method, data);
    }

    return data.result;
  } catch (error) {
    if (error.response) {
      throw error;
    }

    throw new Error(getSafeErrorMessage(error.stderr || error.stdout || error.message || error));
  }
}

async function sendTelegramImage(method, chatId, image, caption, fieldName) {
  const fields = {
    chat_id: chatId,
    caption,
  };
  const file = getTelegramImageFile(image, fieldName);

  try {
    return await callTelegramMultipart(method, fields, file);
  } catch (error) {
    if (shouldDeactivateSubscriber(error) || !isTransientNetworkError(error)) {
      throw error;
    }

    console.log(`Upload directo falló para ${method}; intentando con curl: ${getSafeErrorMessage(error)}`);
    return callTelegramMultipartWithCurl(method, fields, file);
  }
}

async function sendAgendaPhotoWithRetry(chatId, image, caption = '') {
  return sendTelegramImage('sendPhoto', chatId, image, caption, 'photo');
}

async function sendAgendaDocumentWithRetry(chatId, image, caption = '') {
  return sendTelegramImage('sendDocument', chatId, image, caption, 'document');
}

async function replyLongMessage(ctx, message, extra = {}) {
  const chunks = splitLongMessage(message);

  for (let index = 0; index < chunks.length; index += 1) {
    const isLastChunk = index === chunks.length - 1;
    await ctx.reply(chunks[index], isLastChunk ? extra : {});
  }
}

async function buildAgendaDigest(mode, options = {}) {
  const target = buildDateTarget(mode);
  const agenda = await getAgendaByDate(target.date, options);

  return {
    target,
    agenda,
    message: formatDailyAgendaDigest(target.date, agenda),
  };
}

async function buildTodayAgendaDigest(options = {}) {
  return buildAgendaDigest('today', options);
}

async function buildTomorrowAgendaDigest(options = {}) {
  return buildAgendaDigest('next', options);
}

function formatAgendaDigestCaption(digest) {
  return `Agenda ${formatLongSpanishDate(digest.target.date)}`;
}

async function sendAgendaDigestToChat(chatId, digest, extra = {}) {
  let image;
  const caption = formatAgendaDigestCaption(digest);

  try {
    image = await writeAgendaImageFile(digest);
  } catch (error) {
    console.error('No pude generar imagen de agenda; enviando texto:', getSafeErrorMessage(error));
    await sendLongTelegramMessage(chatId, digest.message, extra);
    return;
  }

  try {
    await sendAgendaPhotoWithRetry(chatId, image, caption);
  } catch (error) {
    if (shouldDeactivateSubscriber(error)) {
      throw error;
    }

    console.error('No pude enviar agenda como foto; intentando como documento:', getSafeErrorMessage(error));

    try {
      await sendAgendaDocumentWithRetry(chatId, image, caption);
    } catch (documentError) {
      if (shouldDeactivateSubscriber(documentError)) {
        throw documentError;
      }

      console.error('No pude enviar agenda como imagen; enviando texto:', getSafeErrorMessage(documentError));
      await sendLongTelegramMessage(chatId, digest.message, extra);
    }
  }

  if (extra?.reply_markup) {
    await bot.telegram.sendMessage(chatId, 'Opciones:', extra);
  }
}

async function replyAgendaDigest(ctx, buildDigest) {
  const chatId = getChatId(ctx);

  await ctx.reply('Generando imagen de agenda. En unos segundos te la mando.');

  buildDigest()
    .then((digest) => sendAgendaDigestToChat(chatId, digest, backToMenuKeyboard()))
    .catch((error) => {
      console.error('Error enviando resumen de agenda solicitado:', getSafeErrorMessage(error));
    });

  return undefined;
}

async function replyTodayAgendaDigest(ctx) {
  return replyAgendaDigest(ctx, buildTodayAgendaDigest);
}

async function replyTomorrowAgendaDigest(ctx) {
  return replyAgendaDigest(ctx, buildTomorrowAgendaDigest);
}

async function sendDailyAgendaDigest() {
  if (isSendingDailyAgendaDigest) {
    return;
  }

  const subscribers = getActiveSubscribers();

  if (!subscribers.length) {
    return;
  }

  isSendingDailyAgendaDigest = true;

  try {
    const digest = await buildTomorrowAgendaDigest({ silent: true });
    let sentCount = 0;

    for (const subscriber of subscribers) {
      if (subscriber.lastDailyDigestDate === digest.target.iso) {
        continue;
      }

      try {
        await sendAgendaDigestToChat(subscriber.chatId, digest);
        markDailyDigestSent(subscriber.chatId, digest.target.iso);
        sentCount += 1;
      } catch (error) {
        console.error('No pude enviar resumen diario a un chat:', getSafeErrorMessage(error));

        if (shouldDeactivateSubscriber(error)) {
          deactivateSubscriber(subscriber.chatId, getSafeErrorMessage(error));
        }
      }
    }

    console.log(`Resumen diario enviado a ${sentCount} chat(s).`);
  } finally {
    isSendingDailyAgendaDigest = false;
  }
}

function scheduleMeetingReminders() {
  cron.schedule('* * * * *', () => {
    sendUpcomingMeetingReminders().catch((error) => {
      console.error('Error revisando recordatorios:', getSafeErrorMessage(error));
    });
  }, {
    timezone: TIMEZONE,
    noOverlap: true,
  });

  console.log(`Recordatorios activos: ${reminderMinutesBefore} min antes de cada reunión.`);
}

function scheduleDailyAgendaDigest() {
  cron.schedule(`${dailyAgendaDigestTime.minute} ${dailyAgendaDigestTime.hour} * * 1-5`, () => {
    sendDailyAgendaDigest().catch((error) => {
      console.error('Error enviando resumen diario:', getSafeErrorMessage(error));
    });
  }, {
    timezone: TIMEZONE,
    noOverlap: true,
  });

  console.log(`Resumen diario activo: ${dailyAgendaDigestTime.label} de lunes a viernes.`);
}

function syncSubscribersFromProfiles() {
  getAllUserProfiles()
    .filter((profile) => profile.chatId)
    .forEach((profile) => {
      upsertSubscriber({
        chatId: profile.chatId,
        chatType: 'private',
        title: profile.personName,
        telegramUsername: profile.telegramUsername || '',
        personName: profile.personName,
      });
    });
}

// Comandos principales del MVP local.
bot.use((ctx, next) => {
  upsertSubscriberFromContext(ctx);
  return next();
});

bot.start((ctx) => {
  return showMainMenu(ctx);
});

bot.help((ctx) => {
  return replyHelp(ctx);
});

bot.command('hoy', (ctx) => {
  return replyTodayAgenda(ctx);
});

bot.command(['misjuntas', 'mis'], (ctx) => {
  return replyMyTodayAgenda(ctx);
});

bot.command(['soy', 'perfil'], (ctx) => {
  const requestedPerson = getCommandArgs(ctx, ctx.message.text.split(/\s+/)[0].replace('/', ''));

  if (!requestedPerson) {
    return showProfileMenu(ctx);
  }

  const profile = saveUserProfile(ctx, requestedPerson);

  if (!profile) {
    return ctx.reply('No reconocí esa persona. Selecciona una opción:', Markup.inlineKeyboard(getProfileButtons()));
  }

  return replyWithMenuButton(ctx, formatProfileResponse(profile));
});

bot.command('manana', (ctx) => {
  return replyTomorrowAgenda(ctx);
});

bot.command('resumenhoy', (ctx) => {
  return replyTodayAgendaDigest(ctx);
});

bot.command(['resumenmanana', 'resumendiasiguiente'], (ctx) => {
  return replyTomorrowAgendaDigest(ctx);
});

bot.command('siguiente', (ctx) => {
  const requestedPerson = getCommandArgs(ctx, 'siguiente');

  if (!requestedPerson) {
    return showNextMeetingMenu(ctx);
  }

  return replyNextMeeting(ctx, requestedPerson);
});

bot.command('empalmes', (ctx) => {
  const { target } = extractDateTarget(getCommandArgs(ctx, 'empalmes'));
  return replyConflicts(ctx, target);
});

bot.command('disponibilidad', (ctx) => {
  const { target, remainingText } = extractDateTarget(getCommandArgs(ctx, 'disponibilidad'));
  const requestedPeople = parsePeopleQuery(remainingText);

  if (!requestedPeople.length) {
    setUserAvailabilityTarget(ctx, target);
    return showAvailabilityMenu(ctx, clearUserAvailabilitySelection(ctx), target);
  }

  return replyAvailability(ctx, requestedPeople, target);
});

bot.command('agregar', (ctx) => {
  return replyAddMeeting(ctx);
});

bot.command(['baja', 'bajar'], (ctx) => {
  const { target } = extractDateTarget(getCommandArgs(ctx, ctx.message.text.split(/\s+/)[0].replace('/', '')));
  return startDeleteMeetingFlow(ctx, target);
});

bot.command(['ordenar', 'ordenaragenda'], (ctx) => {
  const command = ctx.message.text.split(/\s+/)[0].replace('/', '').split('@')[0];
  const { target } = extractDateTarget(getCommandArgs(ctx, command));
  return replySortAgenda(ctx, target);
});

bot.action('agenda_hoy', (ctx) => handleAction(ctx, replyTodayAgenda));
bot.action('agenda_manana', (ctx) => handleAction(ctx, replyTomorrowAgenda));
bot.action('mis_juntas_hoy', (ctx) => handleAction(ctx, replyMyTodayAgenda));
bot.action('configurar_persona', (ctx) => handleAction(ctx, showProfileMenu));
bot.action('siguiente_reunion', (ctx) => handleAction(ctx, showNextMeetingMenu));
bot.action('siguiente_jefa_lety', (ctx) => handleAction(ctx, (context) => replyNextMeeting(context, 'Sra Lety')));
bot.action('siguiente_jefa_yess', (ctx) => handleAction(ctx, (context) => replyNextMeeting(context, 'Yess')));
bot.action('disponibilidad_menu', async (ctx) => {
  await answerCallback(ctx);
  clearUserAvailabilitySelection(ctx);
  return showAvailabilityDateMenu(ctx);
});
bot.action('disponibilidad', async (ctx) => {
  await answerCallback(ctx);
  clearUserAvailabilitySelection(ctx);
  return showAvailabilityDateMenu(ctx);
});
bot.action('empalmes', (ctx) => handleAction(ctx, showConflictsDateMenu));
bot.action('agregar_reunion', (ctx) => handleAction(ctx, replyAddMeeting));
bot.action('baja_reunion', (ctx) => handleAction(ctx, showDeleteMeetingDateMenu));
bot.action('ordenar_agenda', (ctx) => handleAction(ctx, showSortAgendaDateMenu));
bot.action('ayuda', (ctx) => handleAction(ctx, replyHelp));
bot.action(/^siguiente_persona:(.+)$/, async (ctx) => {
  await answerCallback(ctx);

  const person = getPersonById(ctx.match[1]);

  if (!person) {
    return showNextMeetingMenu(ctx);
  }

  return replyNextMeeting(ctx, person.name);
});
bot.action(/^perfil_persona:(.+)$/, async (ctx) => {
  await answerCallback(ctx);

  const person = getPersonById(ctx.match[1]);

  if (!person || person.name === 'Sistemas') {
    return showProfileMenu(ctx);
  }

  const profile = saveUserProfile(ctx, person.name);

  if (!profile) {
    return showProfileMenu(ctx);
  }

  return ctx.editMessageText(formatProfileResponse(profile), backToMenuKeyboard())
    .catch(() => replyWithMenuButton(ctx, formatProfileResponse(profile)));
});
bot.action(/^disponibilidad_fecha:(today|next)$/, async (ctx) => {
  await answerCallback(ctx);

  const target = buildDateTarget(ctx.match[1]);
  setUserAvailabilityTarget(ctx, target);

  return showAvailabilityMenu(ctx, getUserAvailabilitySelection(ctx), target);
});
bot.action(/^empalmes_fecha:(today|next)$/, async (ctx) => {
  await answerCallback(ctx);
  return replyConflicts(ctx, buildDateTarget(ctx.match[1]));
});
bot.action(/^baja_fecha:(today|next)$/, async (ctx) => {
  await answerCallback(ctx);
  return startDeleteMeetingFlow(ctx, buildDateTarget(ctx.match[1]));
});
bot.action(/^ordenar_fecha:(today|next)$/, async (ctx) => {
  await answerCallback(ctx);
  return replySortAgenda(ctx, buildDateTarget(ctx.match[1]));
});
bot.action(/^baja_select:(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  return selectDeleteMeeting(ctx, Number(ctx.match[1]));
});
bot.action(/^agregar_fecha:(today|next)$/, async (ctx) => {
  await answerCallback(ctx);
  return setAddMeetingDate(ctx, ctx.match[1]);
});
bot.action('agregar_calendario', async (ctx) => {
  await answerCallback(ctx);
  return showAddMeetingCalendar(ctx);
});
bot.action(/^agregar_cal:(\d{4}-\d{2})$/, async (ctx) => {
  await answerCallback(ctx);
  return showAddMeetingCalendar(ctx, ctx.match[1]);
});
bot.action(/^agregar_dia:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await answerCallback(ctx);
  return setAddMeetingDateValue(ctx, dayjs(ctx.match[1]));
});
bot.action('agregar_cal_noop', async (ctx) => {
  await answerCallback(ctx);
  return undefined;
});
bot.action(/^agregar_hora_inicio:(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  return showAddMeetingDurationMenu(ctx, Number(ctx.match[1]));
});
bot.action(/^agregar_duracion:(\d+):(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  return setAddMeetingTimeRange(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
});
bot.action('agregar_hora_manual', async (ctx) => {
  await answerCallback(ctx);
  return showAddMeetingManualTimePrompt(ctx);
});
bot.action('agregar_hora_cambiar', async (ctx) => {
  await answerCallback(ctx);
  return showAddMeetingTimeMenu(ctx);
});
bot.action(/^agregar_toggle:(.+)$/, async (ctx) => {
  await answerCallback(ctx);
  return toggleAddMeetingPerson(ctx, ctx.match[1]);
});
bot.action('agregar_asignados_listo', async (ctx) => {
  await answerCallback(ctx);
  return finishAddMeetingPeopleSelection(ctx);
});
bot.action('agregar_sin_link', async (ctx) => {
  await answerCallback(ctx);
  return finishAddMeetingWithoutLink(ctx);
});
bot.action(/^agregar_color:(white|green|red|strong_red)$/, async (ctx) => {
  await answerCallback(ctx);
  return setAddMeetingColor(ctx, ctx.match[1]);
});
bot.action(/^disponibilidad_toggle:(.+)$/, async (ctx) => {
  await answerCallback(ctx);

  const personId = ctx.match[1];
  const person = getPersonById(personId);

  if (!person) {
    return showAvailabilityMenu(ctx);
  }

  const selectedPeople = getUserAvailabilitySelection(ctx);

  if (selectedPeople.has(person.name)) {
    selectedPeople.delete(person.name);
  } else {
    selectedPeople.add(person.name);
  }

  return showAvailabilityMenu(ctx, selectedPeople);
});
bot.action('disponibilidad_mi_nombre', async (ctx) => {
  await answerCallback(ctx);

  const profile = getCurrentProfile(ctx);

  if (!profile) {
    await ctx.reply('Primero necesito saber quién eres para usar tu nombre.');
    return showProfileMenu(ctx);
  }

  const selectedPeople = clearUserAvailabilitySelection(ctx);
  selectedPeople.add(profile.personName);

  return showAvailabilityMenu(ctx, selectedPeople, getUserAvailabilityTarget(ctx));
});
bot.action('disponibilidad_limpiar', async (ctx) => {
  await answerCallback(ctx);
  const selectedPeople = clearUserAvailabilitySelection(ctx);
  return showAvailabilityMenu(ctx, selectedPeople);
});
bot.action('disponibilidad_consultar', async (ctx) => {
  await answerCallback(ctx);
  const selectedPeople = [...getUserAvailabilitySelection(ctx)];

  if (!canConsultAvailability(selectedPeople)) {
    return replyWithMenuButton(ctx, 'Selecciona al menos una persona para consultar disponibilidad.');
  }

  return replyAvailability(ctx, selectedPeople, getUserAvailabilityTarget(ctx));
});
bot.action('agregar_cancelar', async (ctx) => {
  await answerCallback(ctx);
  clearAddMeetingFlow(ctx);
  return replyWithMenuButton(ctx, 'Alta de reunión cancelada.');
});
bot.action('agregar_confirmar', async (ctx) => {
  await answerCallback(ctx);
  return confirmAddMeeting(ctx);
});
bot.action('baja_cancelar', async (ctx) => {
  await answerCallback(ctx);
  clearDeleteMeetingFlow(ctx);
  return replyWithMenuButton(ctx, 'Baja de reunión cancelada.');
});
bot.action('baja_confirmar', async (ctx) => {
  await answerCallback(ctx);
  return confirmDeleteMeeting(ctx);
});
bot.action('menu_principal', async (ctx) => {
  await answerCallback(ctx);
  return showMainMenu(ctx);
});

bot.on('text', (ctx) => handleAddMeetingText(ctx));

// Manejo básico de errores para evitar que el proceso caiga sin registro.
bot.catch((error, ctx) => {
  const updateId = ctx?.update?.update_id || 'desconocido';
  console.error(`Error procesando update ${updateId}:`, getSafeErrorMessage(error));
});

function isTelegramConflictError(error) {
  return error?.code === 409 || error?.response?.error_code === 409;
}

function logPollingError(error) {
  if (isTelegramConflictError(error)) {
    console.error('No se pudo iniciar polling: Telegram detectó otra instancia usando este mismo bot.');
    console.error('Cierra la otra terminal/proceso del bot y vuelve a ejecutar npm run dev.');
    return;
  }

  console.error(`Error durante polling de ${BOT_NAME}:`, getSafeErrorMessage(error));
}

function stopBot(reason) {
  if (!isBotRunning) {
    return;
  }

  try {
    bot.stop(reason);
    isBotRunning = false;
    console.log(`${BOT_NAME} detenido (${reason}).`);
  } catch (error) {
    console.error(`No se pudo detener ${BOT_NAME}:`, getSafeErrorMessage(error));
  }
}

console.log(`Iniciando ${BOT_NAME} en modo ${NODE_ENV}.`);
console.log(`Timezone configurado: ${TIMEZONE}.`);
console.log('Usando polling local para pruebas.');

async function startBot() {
  try {
    const botInfo = await bot.telegram.getMe();
    console.log(`Token validado para @${botInfo.username}.`);

    bot.launch({ dropPendingUpdates: false }).catch((error) => {
      logPollingError(error);
      process.exit(1);
    });

    isBotRunning = true;
    syncSubscribersFromProfiles();
    scheduleMeetingReminders();
    scheduleDailyAgendaDigest();

    setTimeout(() => {
      if (isBotRunning) {
        console.log(`${BOT_NAME} iniciado correctamente.`);
      }
    }, 1000).unref();
  } catch (error) {
    console.error(`No se pudo iniciar ${BOT_NAME}:`, getSafeErrorMessage(error));
    process.exit(1);
  }
}

startBot();

// Apagado ordenado para desarrollo local.
process.once('SIGINT', () => {
  stopBot('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  stopBot('SIGTERM');
  process.exit(0);
});

// Nodemon usa SIGUSR2 cuando reinicia por cambios en archivos.
process.once('SIGUSR2', () => {
  stopBot('SIGUSR2');
  process.kill(process.pid, 'SIGUSR2');
});
