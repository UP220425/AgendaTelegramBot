require('dotenv').config();

const TIMEZONE = process.env.TIMEZONE || 'America/Mexico_City';
process.env.TZ = TIMEZONE;

const fs = require('fs');
const path = require('path');
const { Telegraf, Markup, Input } = require('telegraf');
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
  normalizePersonName,
  parseAssignedPeople,
  parsePeopleQuery,
  parseTimeRange,
  getNextAgendaDate,
  getSource,
  isPersonInMeeting,
  timeToMinutes,
} = require('./services/agendaService');
const { addMeetingRow, deleteMeetingRow } = require('./services/appsScriptService');
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
const GENERATED_DIR = path.join(process.cwd(), 'data', 'generated');
const {
  TELEGRAM_BOT_TOKEN,
  NODE_ENV = 'development',
  REMINDER_MINUTES_BEFORE = '15',
  DAILY_AGENDA_DIGEST_TIME = '17:00',
} = process.env;

let isBotRunning = false;
let isCheckingReminders = false;
let isSendingDailyAgendaDigest = false;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN no está definido en el archivo .env.');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

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
  '- /resumenmanana: probar el resumen automático del día siguiente',
].join('\n');

const AVAILABLE_PEOPLE = [
  { id: 'sistemas', name: 'Sistemas' },
  { id: 'carlos', name: 'Carlos' },
  { id: 'carlos_alberto', name: 'Carlos 2' },
  { id: 'leti', name: 'Lety' },
  { id: 'yess', name: 'Yess' },
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
const sentReminderKeys = new Set();
const reminderMinutesBefore = Number(REMINDER_MINUTES_BEFORE) || 15;
const dailyAgendaDigestTime = parseDailyDigestTime(DAILY_AGENDA_DIGEST_TIME);

const ADD_MEETING_STEPS = {
  DATE: 'date',
  TIME: 'time',
  CLIENT: 'client',
  NAME: 'name',
  ASSIGNED: 'assigned',
  LINK: 'link',
  CONFIRM: 'confirm',
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

function getPeopleButtons(selectedPeople = new Set()) {
  const peopleRows = [];

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
  const keyboard = Markup.inlineKeyboard(getPeopleButtons(selectedPeople));

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

function addMeetingConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Confirmar alta', 'agregar_confirmar'),
    ],
    [
      Markup.button.callback('Cancelar alta', 'agregar_cancelar'),
      Markup.button.callback('Volver al menú', 'menu_principal'),
    ],
  ]);
}

function getAddMeetingPrompt(step) {
  const prompts = {
    [ADD_MEETING_STEPS.DATE]: [
      'Vamos a agregar una reunión.',
      '',
      'Escribe la fecha en formato YYYY-MM-DD.',
      'Ejemplo: 2026-06-08',
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
  };

  return prompts[step] || prompts[ADD_MEETING_STEPS.DATE];
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

function formatAddMeetingSummary(data) {
  const normalizedPeople = parseAssignedPeople(data.asignadaA);
  const assignedText = normalizedPeople.length > 0
    ? normalizedPeople.join(', ')
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
  ].join('\n');
}

function startAddMeetingFlow(ctx) {
  const userId = getUserId(ctx);

  if (!userId) {
    return replyWithMenuButton(ctx, 'No pude iniciar el alta de reunión para este usuario.');
  }

  addMeetingFlows.set(userId, {
    step: ADD_MEETING_STEPS.DATE,
    data: {},
  });

  return ctx.reply(getAddMeetingPrompt(ADD_MEETING_STEPS.DATE), addMeetingCancelKeyboard());
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
      return ctx.reply('Fecha inválida. Usa formato YYYY-MM-DD.', addMeetingCancelKeyboard());
    }

    flow.data.date = date.format('YYYY-MM-DD');
    flow.step = ADD_MEETING_STEPS.TIME;
    return ctx.reply(getAddMeetingPrompt(flow.step), addMeetingCancelKeyboard());
  }

  if (flow.step === ADD_MEETING_STEPS.TIME) {
    if (!parseTimeRange(text)) {
      return ctx.reply('Horario inválido. Ejemplo válido: 9:00 AM - 10:00 AM', addMeetingCancelKeyboard());
    }

    flow.data.horaMexico = text;
    flow.step = ADD_MEETING_STEPS.CLIENT;
    return ctx.reply(getAddMeetingPrompt(flow.step), addMeetingCancelKeyboard());
  }

  if (flow.step === ADD_MEETING_STEPS.CLIENT) {
    if (!text) {
      return ctx.reply('Escribe el cliente o área.', addMeetingCancelKeyboard());
    }

    flow.data.cliente = text;
    flow.step = ADD_MEETING_STEPS.NAME;
    return ctx.reply(getAddMeetingPrompt(flow.step), addMeetingCancelKeyboard());
  }

  if (flow.step === ADD_MEETING_STEPS.NAME) {
    if (!text) {
      return ctx.reply('Escribe el nombre de la reunión.', addMeetingCancelKeyboard());
    }

    flow.data.nombreMeeting = text;
    flow.step = ADD_MEETING_STEPS.ASSIGNED;
    return ctx.reply(getAddMeetingPrompt(flow.step), addMeetingCancelKeyboard());
  }

  if (flow.step === ADD_MEETING_STEPS.ASSIGNED) {
    const assignedPeople = parseAssignedPeople(text);

    if (assignedPeople.length === 0) {
      return ctx.reply('Escribe al menos una persona asignada.', addMeetingCancelKeyboard());
    }

    flow.data.asignadaA = text;
    flow.step = ADD_MEETING_STEPS.LINK;
    return ctx.reply(getAddMeetingPrompt(flow.step), addMeetingCancelKeyboard());
  }

  if (flow.step === ADD_MEETING_STEPS.LINK) {
    flow.data.linkComentarios = ['no', 'sin link', 'sin comentarios', '-'].includes(cleaned)
      ? ''
      : text;
    flow.step = ADD_MEETING_STEPS.CONFIRM;

    return ctx.reply(formatAddMeetingSummary(flow.data), addMeetingConfirmKeyboard());
  }

  return undefined;
}

async function confirmAddMeeting(ctx) {
  const flow = getActiveAddMeetingFlow(ctx);

  if (!flow || flow.step !== ADD_MEETING_STEPS.CONFIRM) {
    return replyWithMenuButton(ctx, 'No encontré una reunión pendiente por confirmar.');
  }

  try {
    await addMeetingRow(flow.data);
    clearAddMeetingFlow(ctx);

    return replyWithMenuButton(ctx, [
      'Reunión agregada correctamente.',
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
    clearDeleteMeetingFlow(ctx);

    return replyWithMenuButton(ctx, [
      'Reunión dada de baja correctamente.',
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

function formatMeetingBlock(meeting) {
  return [
    `${meeting.start || '??:??'} - ${meeting.end || '??:??'}`,
    `Cliente: ${meeting.cliente || 'Sin cliente'}`,
    `Reunión: ${meeting.nombreMeeting || 'Sin nombre'}`,
    `Asignados: ${formatAssignedPeople(meeting)}`,
  ].join('\n');
}

function formatMeetingShortBlock(meeting) {
  return [
    `${meeting.start || '??:??'} - ${meeting.end || '??:??'}`,
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
  return [
    profile.userId,
    dateKey,
    meeting.start,
    meeting.end,
    meeting.cliente,
    meeting.nombreMeeting,
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

  const profiles = getAllUserProfiles()
    .filter((profile) => profile.chatId && profile.personName);

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

        if (minutesUntilStart < 0 || minutesUntilStart > reminderMinutesBefore) {
          continue;
        }

        const reminderKey = getReminderKey(profile, meeting, todayKey);

        if (sentReminderKeys.has(reminderKey)) {
          continue;
        }

        sentReminderKeys.add(reminderKey);

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

function getAgendaImagePath(digest) {
  return path.join(GENERATED_DIR, `agenda-${digest.target.iso}.png`);
}

async function writeAgendaImageFile(digest) {
  ensureGeneratedDir();

  const imageBuffer = await createAgendaImageBuffer(digest.target.date, digest.agenda);
  const imagePath = getAgendaImagePath(digest);
  fs.writeFileSync(imagePath, imageBuffer);

  return imagePath;
}

async function sendAgendaPhotoWithRetry(chatId, imagePath, caption = '') {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await bot.telegram.sendPhoto(chatId, Input.fromLocalFile(imagePath), {
        caption,
      });
      return;
    } catch (error) {
      if (shouldDeactivateSubscriber(error) || attempt === maxAttempts || !isTransientNetworkError(error)) {
        throw error;
      }

      console.log(`Reintentando envío de imagen de agenda (${attempt + 1}/${maxAttempts}): ${getSafeErrorMessage(error)}`);
      await wait(750 * attempt);
    }
  }
}

async function sendAgendaDocumentWithRetry(chatId, imagePath, caption = '') {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await bot.telegram.sendDocument(chatId, Input.fromLocalFile(imagePath), {
        caption,
      });
      return;
    } catch (error) {
      if (shouldDeactivateSubscriber(error) || attempt === maxAttempts || !isTransientNetworkError(error)) {
        throw error;
      }

      console.log(`Reintentando envío de documento de agenda (${attempt + 1}/${maxAttempts}): ${getSafeErrorMessage(error)}`);
      await wait(750 * attempt);
    }
  }
}

async function replyLongMessage(ctx, message, extra = {}) {
  const chunks = splitLongMessage(message);

  for (let index = 0; index < chunks.length; index += 1) {
    const isLastChunk = index === chunks.length - 1;
    await ctx.reply(chunks[index], isLastChunk ? extra : {});
  }
}

async function buildTomorrowAgendaDigest(options = {}) {
  const target = buildDateTarget('next');
  const agenda = await getAgendaByDate(target.date, options);

  return {
    target,
    agenda,
    message: formatDailyAgendaDigest(target.date, agenda),
  };
}

function formatAgendaDigestCaption(digest) {
  return `Agenda ${formatLongSpanishDate(digest.target.date)}`;
}

async function sendAgendaDigestToChat(chatId, digest, extra = {}) {
  let imagePath;
  const caption = formatAgendaDigestCaption(digest);

  try {
    imagePath = await writeAgendaImageFile(digest);
  } catch (error) {
    console.error('No pude generar imagen de agenda; enviando texto:', getSafeErrorMessage(error));
    await sendLongTelegramMessage(chatId, digest.message, extra);
    return;
  }

  try {
    await sendAgendaPhotoWithRetry(chatId, imagePath, caption);
  } catch (error) {
    if (shouldDeactivateSubscriber(error)) {
      throw error;
    }

    console.error('No pude enviar agenda como foto; intentando como documento:', getSafeErrorMessage(error));

    try {
      await sendAgendaDocumentWithRetry(chatId, imagePath, caption);
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

async function replyTomorrowAgendaDigest(ctx) {
  const digest = await buildTomorrowAgendaDigest();
  return sendAgendaDigestToChat(getChatId(ctx), digest, backToMenuKeyboard());
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
    return showAvailabilityMenu(ctx, getUserAvailabilitySelection(ctx), target);
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

bot.action('agenda_hoy', (ctx) => handleAction(ctx, replyTodayAgenda));
bot.action('agenda_manana', (ctx) => handleAction(ctx, replyTomorrowAgenda));
bot.action('mis_juntas_hoy', (ctx) => handleAction(ctx, replyMyTodayAgenda));
bot.action('configurar_persona', (ctx) => handleAction(ctx, showProfileMenu));
bot.action('siguiente_reunion', (ctx) => handleAction(ctx, showNextMeetingMenu));
bot.action('siguiente_jefa_lety', (ctx) => handleAction(ctx, (context) => replyNextMeeting(context, 'Sra Lety')));
bot.action('siguiente_jefa_yess', (ctx) => handleAction(ctx, (context) => replyNextMeeting(context, 'Yess')));
bot.action('disponibilidad_menu', (ctx) => handleAction(ctx, showAvailabilityDateMenu));
bot.action('disponibilidad', (ctx) => handleAction(ctx, showAvailabilityDateMenu));
bot.action('empalmes', (ctx) => handleAction(ctx, showConflictsDateMenu));
bot.action('agregar_reunion', (ctx) => handleAction(ctx, replyAddMeeting));
bot.action('baja_reunion', (ctx) => handleAction(ctx, showDeleteMeetingDateMenu));
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
bot.action(/^baja_select:(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  return selectDeleteMeeting(ctx, Number(ctx.match[1]));
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
bot.action('disponibilidad_limpiar', async (ctx) => {
  await answerCallback(ctx);
  const selectedPeople = getUserAvailabilitySelection(ctx);
  selectedPeople.clear();
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
