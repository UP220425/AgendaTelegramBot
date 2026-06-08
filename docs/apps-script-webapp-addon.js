// ============================================================
//  PUENTE WEB APP PARA AGENDA COORDINACION BOT
//  Pega este bloque al final de tu Apps Script actual.
//
//  Importante:
//  1. Cambia WEBAPP_SECRET por el mismo valor de GOOGLE_APPS_SCRIPT_SECRET.
//  2. Si este script esta ligado al Google Sheet, deja WEBAPP_SPREADSHEET_ID vacio.
//  3. Vuelve a desplegar el Web App creando una nueva version.
// ============================================================

const WEBAPP_SECRET = 'pega_aqui_el_mismo_valor_de_GOOGLE_APPS_SCRIPT_SECRET';
const WEBAPP_SPREADSHEET_ID = '';

const WEBAPP_DAYS_ES = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
];

const WEBAPP_MONTHS_ES = [
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
    var body = JSON.parse((e.postData && e.postData.contents) || '{}');

    if (String(body.secret || '') !== WEBAPP_SECRET) {
      return webAppJsonResponse({
        ok: false,
        error: 'UNAUTHORIZED',
      });
    }

    if (body.action === 'GET_AGENDA_BY_DATE') {
      return webAppJsonResponse(webAppGetAgendaByDate(body.payload || {}));
    }

    if (body.action === 'ADD_MEETING') {
      return webAppJsonResponse(webAppAddMeeting(body.payload || {}));
    }

    if (body.action === 'DELETE_MEETING') {
      return webAppJsonResponse(webAppDeleteMeeting(body.payload || {}));
    }

    return webAppJsonResponse({
      ok: false,
      error: 'UNKNOWN_ACTION',
    });
  } catch (error) {
    return webAppJsonResponse({
      ok: false,
      error: 'BAD_REQUEST',
    });
  }
}

function webAppGetAgendaByDate(payload) {
  var date = webAppParseIsoDate(payload.date);

  if (!date) {
    return {
      ok: false,
      error: 'INVALID_DATE',
    };
  }

  var spreadsheet = webAppGetSpreadsheet();
  var sheet = spreadsheet.getSheetByName(webAppGetSheetName(date));

  if (!sheet) {
    return {
      ok: false,
      error: 'SHEET_NOT_FOUND',
    };
  }

  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return {
      ok: true,
      source: 'google_sheets',
      rows: [],
    };
  }

  var values = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  var headers = values[0].map(function(header) {
    return String(header || '').trim();
  });

  var rows = values
    .slice(1)
    .map(function(row, index) {
      return {
        row: row,
        rowNumber: index + 3,
      };
    })
    .filter(function(item) {
      return webAppHasMeetingContent(item.row);
    })
    .map(function(item) {
      return webAppRowToObject(headers, item.row, item.rowNumber);
    });

  return {
    ok: true,
    source: 'google_sheets',
    rows: rows,
  };
}

function webAppAddMeeting(payload) {
  var date = webAppParseIsoDate(payload.date);

  if (!date) {
    return {
      ok: false,
      error: 'INVALID_DATE',
    };
  }

  var requiredFields = [
    'horaMexico',
    'cliente',
    'nombreMeeting',
    'asignadaA',
  ];
  var missingField = requiredFields.find(function(field) {
    return !String(payload[field] || '').trim();
  });

  if (missingField) {
    return {
      ok: false,
      error: 'MISSING_REQUIRED_FIELD',
      field: missingField,
    };
  }

  var spreadsheet = webAppGetSpreadsheet();
  var sheet = webAppGetOrCreateSheet(spreadsheet, date);
  var timezone = Session.getScriptTimeZone() || 'America/Mexico_City';
  var row = {
    Fecha: Utilities.formatDate(date, timezone, 'dd-MM-yyyy'),
    'Hora Mexico': String(payload.horaMexico || '').trim(),
    Cliente: String(payload.cliente || '').trim(),
    'Nombre del meeting': String(payload.nombreMeeting || '').trim(),
    'Asignada a': String(payload.asignadaA || '').trim(),
    'Link / Comentarios': String(payload.linkComentarios || '').trim(),
  };
  var insertRow = webAppFindFirstAvailableMeetingRow(sheet);

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
    row: row,
  };
}

function webAppDeleteMeeting(payload) {
  var date = webAppParseIsoDate(payload.date);
  var rowNumber = Number(payload.rowNumber);

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

  var spreadsheet = webAppGetSpreadsheet();
  var sheet = spreadsheet.getSheetByName(webAppGetSheetName(date));

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

  var currentValues = sheet.getRange(rowNumber, 1, 1, 6).getValues()[0];

  if (!webAppHasMeetingContent(currentValues)) {
    return {
      ok: false,
      error: 'ROW_ALREADY_EMPTY',
    };
  }

  var timezone = Session.getScriptTimeZone() || 'America/Mexico_City';
  var dateText = Utilities.formatDate(date, timezone, 'dd-MM-yyyy');
  var headers = sheet.getRange(2, 1, 1, 6).getValues()[0].map(function(header) {
    return String(header || '').trim();
  });
  var row = webAppRowToObject(headers, currentValues, rowNumber);

  sheet.getRange(rowNumber, 1, 1, 6).setValues([[
    dateText,
    '',
    '',
    '',
    '',
    '',
  ]]);

  return {
    ok: true,
    source: 'google_sheets',
    rowNumber: rowNumber,
    row: row,
  };
}

function webAppGetSpreadsheet() {
  if (WEBAPP_SPREADSHEET_ID) {
    return SpreadsheetApp.openById(WEBAPP_SPREADSHEET_ID);
  }

  return SpreadsheetApp.getActiveSpreadsheet();
}

function webAppGetOrCreateSheet(spreadsheet, date) {
  var sheetName = webAppGetSheetName(date);
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (sheet) {
    return sheet;
  }

  sheet = spreadsheet.insertSheet(sheetName);

  if (typeof construirTablaAgenda === 'function') {
    construirTablaAgenda(sheet, date);
  } else {
    webAppBuildBasicAgendaSheet(sheet, date);
  }

  return sheet;
}

function webAppBuildBasicAgendaSheet(sheet, date) {
  var timezone = Session.getScriptTimeZone() || 'America/Mexico_City';
  var dateText = Utilities.formatDate(date, timezone, 'dd-MM-yyyy');

  sheet.getRange(2, 1, 1, 6).setValues([[
    'Fecha',
    'Hora Mexico',
    'Cliente',
    'Nombre del meeting',
    'Asignada a',
    'Link / Comentarios',
  ]]);

  for (var row = 3; row <= 12; row += 1) {
    sheet.getRange(row, 1).setValue(dateText);
  }
}

function webAppFindFirstAvailableMeetingRow(sheet) {
  var firstDataRow = 3;
  var lastRow = Math.max(sheet.getLastRow(), firstDataRow);
  var values = sheet.getRange(firstDataRow, 1, lastRow - firstDataRow + 1, 6).getValues();

  for (var index = 0; index < values.length; index += 1) {
    if (!webAppHasMeetingContent(values[index])) {
      return firstDataRow + index;
    }
  }

  return lastRow + 1;
}

function webAppHasMeetingContent(row) {
  return row
    .slice(1, 5)
    .some(function(cell) {
      return cell !== '' && cell !== null;
    });
}

function webAppRowToObject(headers, row, rowNumber) {
  var record = headers.reduce(function(accumulator, header, index) {
    if (header) {
      accumulator[header] = webAppSerializeCellValue(row[index]);
    }

    return accumulator;
  }, {});

  record.rowNumber = rowNumber;
  return record;
}

function webAppSerializeCellValue(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  if (value === null || value === undefined) {
    return '';
  }

  return value;
}

function webAppParseIsoDate(value) {
  var match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function webAppGetSheetName(date) {
  if (typeof nombreDePestana === 'function') {
    return nombreDePestana(date);
  }

  return [
    WEBAPP_DAYS_ES[date.getDay()],
    date.getDate(),
    WEBAPP_MONTHS_ES[date.getMonth()],
    date.getFullYear(),
  ].join(' ');
}

function webAppJsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
