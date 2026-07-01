const dayjs = require('dayjs');

const APPS_SCRIPT_TIMEOUT_MS = 15000;

function getAppsScriptConfig() {
  return {
    url: process.env.GOOGLE_APPS_SCRIPT_URL,
    secret: process.env.GOOGLE_APPS_SCRIPT_SECRET,
  };
}

function getIsoDateKey(date) {
  const parsedDate = dayjs.isDayjs(date) ? date : dayjs(date);
  const safeDate = parsedDate.isValid() ? parsedDate : dayjs();

  return safeDate.format('YYYY-MM-DD');
}

async function callAppsScript(action, payload = {}) {
  const { url, secret } = getAppsScriptConfig();

  if (!url) {
    throw new Error('GOOGLE_APPS_SCRIPT_URL_NOT_CONFIGURED');
  }

  if (!secret) {
    throw new Error('GOOGLE_APPS_SCRIPT_SECRET_NOT_CONFIGURED');
  }

  if (typeof fetch !== 'function') {
    throw new Error('FETCH_NOT_AVAILABLE');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPS_SCRIPT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        secret,
        action,
        payload,
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();
    let data;

    try {
      data = JSON.parse(responseText);
    } catch (error) {
      throw new Error('APPS_SCRIPT_INVALID_JSON_RESPONSE');
    }

    if (!response.ok) {
      throw new Error(`APPS_SCRIPT_HTTP_${response.status}`);
    }

    if (!data.ok) {
      throw new Error(data.error || 'APPS_SCRIPT_ERROR');
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAgendaRowsByDate(date) {
  const result = await callAppsScript('GET_AGENDA_BY_DATE', {
    date: getIsoDateKey(date),
  });

  const rows = Array.isArray(result.rows) ? result.rows : [];

  Object.defineProperty(rows, 'source', {
    value: result.source || 'google_sheets',
    enumerable: false,
  });

  return rows;
}

async function addMeetingRow(meeting) {
  const result = await callAppsScript('ADD_MEETING', meeting);
  return result.row || null;
}

async function deleteMeetingRow(meeting) {
  const result = await callAppsScript('DELETE_MEETING', {
    date: getIsoDateKey(meeting.date),
    rowNumber: meeting.rowNumber,
  });

  return result.row || null;
}

async function sortAgendaRowsByDate(date) {
  return callAppsScript('SORT_AGENDA_BY_DATE', {
    date: getIsoDateKey(date),
  });
}

module.exports = {
  callAppsScript,
  getAgendaRowsByDate,
  addMeetingRow,
  deleteMeetingRow,
  sortAgendaRowsByDate,
};
