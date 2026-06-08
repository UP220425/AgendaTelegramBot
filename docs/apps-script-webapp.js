const SECRET = 'cambia_este_secret';
const SPREADSHEET_ID = '1tGgyRdl76vTFtaBVGqmYXyYb14bh8iy3EwhUruVyHdg';

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

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');

    if (body.secret !== SECRET) {
      return jsonResponse({
        ok: false,
        error: 'UNAUTHORIZED',
      });
    }

    if (body.action === 'GET_AGENDA_BY_DATE') {
      return jsonResponse(getAgendaByDate(body.payload || {}));
    }

    if (body.action === 'ADD_MEETING') {
      return jsonResponse(addMeeting(body.payload || {}));
    }

    if (body.action === 'DELETE_MEETING') {
      return jsonResponse(deleteMeeting(body.payload || {}));
    }

    return jsonResponse({
      ok: false,
      error: 'UNKNOWN_ACTION',
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: 'BAD_REQUEST',
    });
  }
}

function getAgendaByDate(payload) {
  const date = parseIsoDate(payload.date);

  if (!date) {
    return {
      ok: false,
      error: 'INVALID_DATE',
    };
  }

  const sheetName = getSpanishSheetName(date);
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    return {
      ok: false,
      error: 'SHEET_NOT_FOUND',
    };
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return {
      ok: true,
      source: 'google_sheets',
      rows: [],
    };
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  const headers = values[0].map((header) => String(header || '').trim());
  const rows = values
    .slice(1)
    .map((row, index) => ({
      row,
      rowNumber: index + 3,
    }))
    .filter((item) => hasMeetingContent(item.row))
    .map((item) => rowToObject(headers, item.row, item.rowNumber));

  return {
    ok: true,
    source: 'google_sheets',
    rows,
  };
}

function addMeeting(payload) {
  const date = parseIsoDate(payload.date);

  if (!date) {
    return {
      ok: false,
      error: 'INVALID_DATE',
    };
  }

  const requiredFields = [
    'horaMexico',
    'cliente',
    'nombreMeeting',
    'asignadaA',
  ];
  const missingField = requiredFields.find((field) => !String(payload[field] || '').trim());

  if (missingField) {
    return {
      ok: false,
      error: 'MISSING_REQUIRED_FIELD',
      field: missingField,
    };
  }

  const sheetName = getSpanishSheetName(date);
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    return {
      ok: false,
      error: 'SHEET_NOT_FOUND',
    };
  }

  const row = {
    Fecha: Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd-MM-yyyy'),
    'Hora Mexico': String(payload.horaMexico || '').trim(),
    Cliente: String(payload.cliente || '').trim(),
    'Nombre del meeting': String(payload.nombreMeeting || '').trim(),
    'Asignada a': String(payload.asignadaA || '').trim(),
    'Link / Comentarios': String(payload.linkComentarios || '').trim(),
  };

  const insertRow = findFirstAvailableMeetingRow(sheet);

  sheet.getRange(insertRow, 1, 1, 6).setValues([[
    row.Fecha,
    row['Hora Mexico'],
    row.Cliente,
    row['Nombre del meeting'],
    row['Asignada a'],
    row['Link / Comentarios'],
  ]]);

  return {
    ok: true,
    source: 'google_sheets',
    rowNumber: insertRow,
    row,
  };
}

function deleteMeeting(payload) {
  const date = parseIsoDate(payload.date);
  const rowNumber = Number(payload.rowNumber);

  if (!date) {
    return {
      ok: false,
      error: 'INVALID_DATE',
    };
  }

  if (!rowNumber || rowNumber < 3) {
    return {
      ok: false,
      error: 'INVALID_ROW_NUMBER',
    };
  }

  const sheetName = getSpanishSheetName(date);
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    return {
      ok: false,
      error: 'SHEET_NOT_FOUND',
    };
  }

  if (rowNumber > sheet.getLastRow()) {
    return {
      ok: false,
      error: 'ROW_NOT_FOUND',
    };
  }

  const currentValues = sheet.getRange(rowNumber, 1, 1, 6).getValues()[0];

  if (!hasMeetingContent(currentValues)) {
    return {
      ok: false,
      error: 'ROW_ALREADY_EMPTY',
    };
  }

  const headers = sheet.getRange(2, 1, 1, 6).getValues()[0].map((header) => String(header || '').trim());
  const row = rowToObject(headers, currentValues, rowNumber);

  sheet.getRange(rowNumber, 1, 1, 6).setValues([[
    Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd-MM-yyyy'),
    '',
    '',
    '',
    '',
    '',
  ]]);

  return {
    ok: true,
    source: 'google_sheets',
    rowNumber,
    row,
  };
}

function hasMeetingContent(row) {
  return row
    .slice(1, 5)
    .some((cell) => cell !== '' && cell !== null);
}

function findFirstAvailableMeetingRow(sheet) {
  const firstDataRow = 3;
  const lastRow = Math.max(sheet.getLastRow(), firstDataRow);
  const values = sheet.getRange(firstDataRow, 1, lastRow - firstDataRow + 1, 6).getValues();

  for (let index = 0; index < values.length; index += 1) {
    if (!hasMeetingContent(values[index])) {
      return firstDataRow + index;
    }
  }

  return lastRow + 1;
}

function rowToObject(headers, row, rowNumber) {
  const record = headers.reduce((accumulator, header, index) => {
    if (header) {
      accumulator[header] = serializeCellValue(row[index]);
    }

    return accumulator;
  }, {});

  record.rowNumber = rowNumber;
  return record;
}

function serializeCellValue(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  if (value === null || value === undefined) {
    return '';
  }

  return value;
}

function parseIsoDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function getSpanishSheetName(date) {
  return [
    SPANISH_DAYS[date.getDay()],
    date.getDate(),
    SPANISH_MONTHS[date.getMonth()],
    date.getFullYear(),
  ].join(' ');
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
