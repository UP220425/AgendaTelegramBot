// ============================================================
// BOT TELEGRAM API - AGENDA COORDINACION BOT
// Telegram Bot Node.js -> Google Apps Script -> Google Sheets
// ============================================================

const BOT_API_SECRET = 'AgendaCielitoHome_Bot_2026_Privado_7391';
const BOT_API_SPREADSHEET_ID = '';

const BOT_API_DAYS_ES = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
];

const BOT_API_MONTHS_ES = [
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

function doGet() {
  return botApiJsonResponse({
    ok: true,
    service: 'Agenda Coordinacion Bot Web App',
  });
}

function doPost(e) {
  try {
    var body = JSON.parse((e.postData && e.postData.contents) || '{}');

    if (String(body.secret || '') !== BOT_API_SECRET) {
      return botApiJsonResponse({
        ok: false,
        error: 'UNAUTHORIZED',
      });
    }

    if (body.action === 'GET_AGENDA_BY_DATE') {
      return botApiJsonResponse(botApiGetAgendaByDate(body.payload || {}));
    }

    if (body.action === 'ADD_MEETING') {
      return botApiJsonResponse(botApiAddMeeting(body.payload || {}));
    }

    if (body.action === 'DELETE_MEETING') {
      return botApiJsonResponse(botApiDeleteMeeting(body.payload || {}));
    }

    return botApiJsonResponse({
      ok: false,
      error: 'UNKNOWN_ACTION',
    });
  } catch (error) {
    return botApiJsonResponse({
      ok: false,
      error: 'BAD_REQUEST',
      message: error.message,
    });
  }
}

function botApiGetAgendaByDate(payload) {
  var date = botApiParseIsoDate(payload.date);

  if (!date) {
    return {
      ok: false,
      error: 'INVALID_DATE',
    };
  }

  var spreadsheet = botApiGetSpreadsheet();
  var sheetName = botApiGetSheetName(date);
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    return {
      ok: false,
      error: 'SHEET_NOT_FOUND',
      sheetName: sheetName,
    };
  }

  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return {
      ok: true,
      source: 'google_sheets',
      sheetName: sheetName,
      rows: [],
    };
  }

  var agendaRange = sheet.getRange(2, 1, lastRow - 1, 6);
  var values = agendaRange.getValues();
  var backgrounds = agendaRange.getBackgrounds();
  var headers = values[0].map(function(header) {
    return String(header || '').trim();
  });

  var rows = values
    .slice(1)
    .map(function(row, index) {
      return {
        row: row,
        backgrounds: backgrounds[index + 1],
        rowNumber: index + 3,
      };
    })
    .filter(function(item) {
      return botApiHasMeetingContent(item.row);
    })
    .map(function(item) {
      return botApiRowToObject(headers, item.row, item.rowNumber, item.backgrounds);
    });

  return {
    ok: true,
    source: 'google_sheets',
    sheetName: sheetName,
    rows: rows,
  };
}

function botApiAddMeeting(payload) {
  var date = botApiParseIsoDate(payload.date);

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

  var spreadsheet = botApiGetSpreadsheet();
  var sheet = botApiGetOrCreateSheet(spreadsheet, date);
  var timezone = Session.getScriptTimeZone() || 'America/Mexico_City';
  var row = {
    Fecha: Utilities.formatDate(date, timezone, 'dd-MM-yyyy'),
    'Hora Mexico': String(payload.horaMexico || '').trim(),
    Cliente: String(payload.cliente || '').trim(),
    'Nombre del meeting': String(payload.nombreMeeting || '').trim(),
    'Asignada a': String(payload.asignadaA || '').trim(),
    'Link / Comentarios': String(payload.linkComentarios || '').trim(),
  };
  var insertRow = botApiFindFirstAvailableMeetingRow(sheet);

  sheet.getRange(insertRow, 1, 1, 6).setValues([[
    row.Fecha,
    row['Hora Mexico'],
    row.Cliente,
    row['Nombre del meeting'],
    row['Asignada a'],
    row['Link / Comentarios'],
  ]]);
  botApiApplyMeetingRowFormat(sheet, insertRow);
  sheet.getRange(insertRow, 1, 1, 6).setBackground(botApiGetMeetingRowColor(payload));
  botApiNormalizeMeetingRows(sheet, row.Fecha);

  return {
    ok: true,
    source: 'google_sheets',
    rowNumber: insertRow,
    row: row,
  };
}

function botApiDeleteMeeting(payload) {
  var date = botApiParseIsoDate(payload.date);
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

  var spreadsheet = botApiGetSpreadsheet();
  var sheetName = botApiGetSheetName(date);
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    return {
      ok: false,
      error: 'SHEET_NOT_FOUND',
      sheetName: sheetName,
    };
  }

  if (rowNumber > sheet.getLastRow()) {
    return {
      ok: false,
      error: 'ROW_NOT_FOUND',
    };
  }

  var currentValues = sheet.getRange(rowNumber, 1, 1, 6).getValues()[0];

  if (!botApiHasMeetingContent(currentValues)) {
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
  var row = botApiRowToObject(headers, currentValues, rowNumber);

  botApiRemoveMeetingRowAndCompact(sheet, dateText, rowNumber);

  return {
    ok: true,
    source: 'google_sheets',
    rowNumber: rowNumber,
    row: row,
  };
}

function botApiGetSpreadsheet() {
  if (BOT_API_SPREADSHEET_ID) {
    return SpreadsheetApp.openById(BOT_API_SPREADSHEET_ID);
  }

  return SpreadsheetApp.getActiveSpreadsheet();
}

function botApiGetOrCreateSheet(spreadsheet, date) {
  var sheetName = botApiGetSheetName(date);
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (sheet) {
    return sheet;
  }

  sheet = spreadsheet.insertSheet(sheetName);

  if (typeof construirTablaAgenda === 'function') {
    construirTablaAgenda(sheet, date);
  } else {
    botApiBuildBasicAgendaSheet(sheet, date);
  }

  return sheet;
}

function botApiBuildBasicAgendaSheet(sheet, date) {
  var timezone = Session.getScriptTimeZone() || 'America/Mexico_City';
  var dateText = Utilities.formatDate(date, timezone, 'dd-MM-yyyy');

  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidth(2, 150);
  sheet.setColumnWidth(3, 130);
  sheet.setColumnWidth(4, 250);
  sheet.setColumnWidth(5, 180);
  sheet.setColumnWidth(6, 220);

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
    botApiApplyMeetingRowFormat(sheet, row);
  }
}

function botApiFindFirstAvailableMeetingRow(sheet) {
  var firstDataRow = 3;
  var lastRow = Math.max(sheet.getLastRow(), firstDataRow);
  var values = sheet.getRange(firstDataRow, 1, lastRow - firstDataRow + 1, 6).getValues();

  for (var index = 0; index < values.length; index += 1) {
    if (!botApiHasMeetingContent(values[index])) {
      return firstDataRow + index;
    }
  }

  return lastRow + 1;
}

function botApiRemoveMeetingRowAndCompact(sheet, dateText, rowNumberToRemove) {
  botApiNormalizeMeetingRows(sheet, dateText, {
    removeRowNumber: rowNumberToRemove,
  });
}

function botApiNormalizeMeetingRows(sheet, dateText, options) {
  var config = options || {};
  var firstDataRow = 3;
  var lastRow = Math.max(sheet.getLastRow(), firstDataRow);
  var rowCount = lastRow - firstDataRow + 1;
  var range = sheet.getRange(firstDataRow, 1, rowCount, 6);
  var values = range.getValues();
  var backgrounds = range.getBackgrounds();
  var fontColors = range.getFontColors();
  var fontWeights = range.getFontWeights();
  var meetingRows = values
    .map(function(row, index) {
      return {
        row: row,
        backgrounds: backgrounds[index],
        fontColors: fontColors[index],
        fontWeights: fontWeights[index],
        rowNumber: firstDataRow + index,
        originalIndex: index,
      };
    })
    .filter(function(item) {
      return item.rowNumber !== config.removeRowNumber && botApiHasMeetingContent(item.row);
    })
    .sort(function(a, b) {
      var aStart = botApiGetStartMinutes(a.row[1]);
      var bStart = botApiGetStartMinutes(b.row[1]);

      if (aStart !== bStart) {
        return aStart - bStart;
      }

      return a.originalIndex - b.originalIndex;
    });

  var outputValues = meetingRows
    .map(function(item) {
      return [
        dateText,
        item.row[1],
        item.row[2],
        item.row[3],
        item.row[4],
        item.row[5],
      ];
    });
  var outputBackgrounds = meetingRows.map(function(item) {
    return item.backgrounds;
  });
  var outputFontColors = meetingRows.map(function(item) {
    return item.fontColors;
  });
  var outputFontWeights = meetingRows.map(function(item) {
    return item.fontWeights;
  });

  while (outputValues.length < rowCount) {
    outputValues.push([dateText, '', '', '', '', '']);
    outputBackgrounds.push(['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff']);
    outputFontColors.push(['#000000', '#000000', '#000000', '#000000', '#000000', '#000000']);
    outputFontWeights.push(['normal', 'normal', 'normal', 'normal', 'normal', 'normal']);
  }

  range
    .setValues(outputValues)
    .setBackgrounds(outputBackgrounds)
    .setFontColors(outputFontColors)
    .setFontWeights(outputFontWeights)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);

  try {
    sheet.autoResizeRows(firstDataRow, Math.max(meetingRows.length, 1));
  } catch (error) {
    // Si Google Sheets no puede autoajustar por algun contenido raro, dejamos la altura actual.
  }
}

function botApiApplyMeetingRowFormat(sheet, rowNumber, backgroundColor) {
  var rowRange = sheet.getRange(rowNumber, 1, 1, 6);

  rowRange
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setFontColor('#000000')
    .setFontWeight('normal')
    .setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);

  if (backgroundColor) {
    rowRange.setBackground(backgroundColor);
  }

  sheet.setRowHeight(rowNumber, 28);
}

function botApiGetMeetingRowColor(payload) {
  var color = String(payload.rowColor || payload.color || '').trim().toLowerCase();

  if (color === 'green' || color === 'verde') {
    return '#b6d7a8';
  }

  if (color === 'red' || color === 'rojo') {
    return '#f4cccc';
  }

  return '#ffffff';
}

function botApiGetStartMinutes(value) {
  var startText = String(value || '').split(/\s*[-–—]\s*/)[0] || '';
  var twelveHourMatch = startText.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);

  if (twelveHourMatch) {
    var hours = Number(twelveHourMatch[1]);
    var minutes = Number(twelveHourMatch[2] || 0);
    var period = twelveHourMatch[3].toLowerCase();

    if (period === 'am' && hours === 12) hours = 0;
    if (period === 'pm' && hours < 12) hours += 12;

    return hours * 60 + minutes;
  }

  var twentyFourHourMatch = startText.trim().match(/^(\d{1,2}):(\d{2})$/);

  if (twentyFourHourMatch) {
    return Number(twentyFourHourMatch[1]) * 60 + Number(twentyFourHourMatch[2]);
  }

  return 24 * 60 + 99;
}

function botApiHasMeetingContent(row) {
  return row
    .slice(1, 5)
    .some(function(cell) {
      return cell !== '' && cell !== null;
    });
}

function botApiRowToObject(headers, row, rowNumber, rowBackgrounds) {
  var record = headers.reduce(function(accumulator, header, index) {
    if (header) {
      accumulator[header] = botApiSerializeCellValue(row[index]);
    }

    return accumulator;
  }, {});

  record.rowNumber = rowNumber;

  if (rowBackgrounds && rowBackgrounds.length) {
    record.rowBackground = botApiGetDominantRowBackground(rowBackgrounds);
    record.rowBackgrounds = rowBackgrounds;
  }

  return record;
}

function botApiGetDominantRowBackground(rowBackgrounds) {
  var normalizedColors = rowBackgrounds
    .map(function(color) {
      return String(color || '').trim().toLowerCase();
    })
    .filter(function(color) {
      return color && color !== '#ffffff' && color !== 'white';
    });

  return normalizedColors[0] || '#ffffff';
}

function botApiSerializeCellValue(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone() || 'America/Mexico_City',
      'yyyy-MM-dd'
    );
  }

  if (value === null || value === undefined) {
    return '';
  }

  return value;
}

function botApiParseIsoDate(value) {
  var match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function botApiGetSheetName(date) {
  if (typeof nombreDePestana === 'function') {
    return nombreDePestana(date);
  }

  return [
    BOT_API_DAYS_ES[date.getDay()],
    date.getDate(),
    BOT_API_MONTHS_ES[date.getMonth()],
    date.getFullYear(),
  ].join(' ');
}

function botApiJsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
