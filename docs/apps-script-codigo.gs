// ============================================================
//  AGENDA AUTOMATICA - Google Apps Script
//  Este archivo es el Codigo.gs base para crear y administrar
//  pestanas de agenda en Google Sheets.
//
//  Importante:
//  - Este archivo NO debe tener doPost.
//  - Este archivo NO debe tener WEBAPP_SECRET ni BOT_API_SECRET.
//  - El puente del bot debe vivir aparte en BotTelegramAPI.gs.
// ============================================================

const COLOR_TITULO_BG = "#1155CC";
const COLOR_TITULO_FG = "#FFFFFF";
const COLOR_HEADER_BG = "#1155CC";
const COLOR_HEADER_FG = "#FFFFFF";

const DIAS_ES = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
const MESES_ES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
                  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Agenda")
    .addItem("Crear pestañas del mes", "crearPestanasMes")
    .addItem("Crear días específicos", "crearDiasEspecificos")
    .addSeparator()
    .addItem("Ir a una fecha", "irAFecha")
    .addSeparator()
    .addItem("Reordenar pestañas (más reciente primero)", "reordenarPestanas")
    .addSeparator()
    .addItem("Eliminar por rango de fechas", "eliminarPestanasAntiguas")
    .addItem("Eliminar pestañas sin nomenclatura correcta", "eliminarSinNomenclatura")
    .addToUi();
}

function nombreDePestana(fecha) {
  return DIAS_ES[fecha.getDay()] + " " + fecha.getDate() + " " + MESES_ES[fecha.getMonth()] + " " + fecha.getFullYear();
}

function extraerFechaDePestana(nombre) {
  var MESES_MAP = {
    ene:0,enero:0,feb:1,febrero:1,mar:2,marzo:2,
    abr:3,abril:3,may:4,mayo:4,jun:5,junio:5,
    jul:6,julio:6,ago:7,agosto:7,sep:8,sept:8,septiembre:8,
    oct:9,octubre:9,nov:10,noviembre:10,dic:11,diciembre:11
  };
  var n = nombre.toLowerCase().trim()
    .replace(/á/g,"a").replace(/é/g,"e").replace(/í/g,"i")
    .replace(/ó/g,"o").replace(/ú/g,"u").replace(/ü/g,"u");

  var m = n.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);

  m = n.match(/(?:[a-z]+\s+)?(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?/);
  if (m) {
    var key = m[2].substring(0,3);
    var mesIdx = MESES_MAP[key] !== undefined ? MESES_MAP[key] : MESES_MAP[m[2]];
    if (mesIdx !== undefined) {
      var anio = m[3] ? +m[3] : new Date().getFullYear();
      return new Date(anio, mesIdx, +m[1]);
    }
  }
  return null;
}

function tieneNomenclaturaCorrecta(nombre) {
  var DIAS_NORM = ["domingo","lunes","martes","miercoles","jueves","viernes","sabado"];
  var MESES_NORM = ["enero","febrero","marzo","abril","mayo","junio",
                    "julio","agosto","septiembre","octubre","noviembre","diciembre"];
  var n = nombre.trim().toLowerCase()
    .replace(/á/g,"a").replace(/é/g,"e").replace(/í/g,"i")
    .replace(/ó/g,"o").replace(/ú/g,"u");
  var match = n.match(/^([a-z]+)\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if (!match) return false;
  return DIAS_NORM.indexOf(match[1]) >= 0
      && MESES_NORM.indexOf(match[3]) >= 0
      && +match[2] >= 1 && +match[2] <= 31;
}

function parsearFechaInput(str) {
  var m = str.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  var fecha = new Date(+m[3], +m[2]-1, +m[1]);
  return isNaN(fecha.getTime()) ? null : fecha;
}

function construirTablaAgenda(sheet, fecha) {
  var dd = String(fecha.getDate()).padStart(2,"0");
  var mm = String(fecha.getMonth()+1).padStart(2,"0");
  var aaaa = fecha.getFullYear();
  var fechaStr = dd + "-" + mm + "-" + aaaa;
  var tituloStr = "Agenda " + DIAS_ES[fecha.getDay()] + " " + fecha.getDate() +
                  " de " + MESES_ES[fecha.getMonth()] + " de " + aaaa;

  sheet.setColumnWidth(1,110);
  sheet.setColumnWidth(2,150);
  sheet.setColumnWidth(3,130);
  sheet.setColumnWidth(4,250);
  sheet.setColumnWidth(5,180);
  sheet.setColumnWidth(6,220);

  sheet.getRange("A1:F1").merge()
    .setValue(tituloStr)
    .setBackground(COLOR_TITULO_BG).setFontColor(COLOR_TITULO_FG)
    .setFontSize(14).setFontWeight("bold")
    .setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.setRowHeight(1,35);

  sheet.getRange(2,1,1,6)
    .setValues([["Fecha","Hora Mexico","Cliente","Nombre del meeting","Asignada a","Link / Comentarios"]])
    .setBackground(COLOR_HEADER_BG).setFontColor(COLOR_HEADER_FG)
    .setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.setRowHeight(2,28);

  for (var r = 3; r <= 12; r++) {
    sheet.getRange(r,1).setValue(fechaStr).setHorizontalAlignment("center");
    sheet.setRowHeight(r,24);
  }

  sheet.getRange(1,1,12,6)
    .setBorder(true,true,true,true,true,true,"#000000",SpreadsheetApp.BorderStyle.SOLID);
  sheet.setFrozenRows(2);
}

function reordenarPestanas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var conFecha = [];
  var sinFecha = [];

  sheets.forEach(function(s) {
    var f = extraerFechaDePestana(s.getName());
    if (f) conFecha.push({sheet:s, fecha:f});
    else sinFecha.push(s);
  });

  conFecha.sort(function(a,b) { return b.fecha - a.fecha; });

  conFecha.forEach(function(item, i) {
    ss.setActiveSheet(item.sheet);
    ss.moveActiveSheet(i + 1);
  });

  sinFecha.forEach(function(s, i) {
    ss.setActiveSheet(s);
    ss.moveActiveSheet(conFecha.length + i + 1);
  });

  SpreadsheetApp.getUi().alert(
    "Reordenado",
    conFecha.length + " pestaña(s) ordenadas de más reciente a más antigua.\n" +
    sinFecha.length + " pestaña(s) sin fecha reconocible quedaron al final.",
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function irAFecha() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var resp = ui.prompt(
    "Ir a una fecha",
    "Escribe la fecha a la que quieres ir.\nFormato: DD/MM/YYYY  (ej: 29/05/2026)",
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var fecha = parsearFechaInput(resp.getResponseText());
  if (!fecha) {
    ui.alert("Fecha inválida. Usa DD/MM/YYYY.");
    return;
  }

  var nombreBuscado = nombreDePestana(fecha);
  var encontrada = ss.getSheetByName(nombreBuscado);

  if (!encontrada) {
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      var f = extraerFechaDePestana(sheets[i].getName());
      if (f && f.toDateString() === fecha.toDateString()) {
        encontrada = sheets[i];
        break;
      }
    }
  }

  if (!encontrada) {
    var resp2 = ui.alert(
      "Pestaña no encontrada",
      "No existe una pestaña para el " + nombreBuscado + ".\n\n¿Quieres crearla ahora?",
      ui.ButtonSet.YES_NO
    );
    if (resp2 === ui.Button.YES) {
      var nueva = ss.insertSheet(nombreBuscado);
      construirTablaAgenda(nueva, fecha);
      reordenarPestanas();
      ss.setActiveSheet(nueva);
    }
    return;
  }

  ss.setActiveSheet(encontrada);
}

function crearPestanasMes() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoy = new Date();

  var respMes = ui.prompt(
    "Crear pestañas del mes",
    "Ingresa el mes y año a crear (formato MM/YYYY).\n" +
    "Deja vacío para usar el mes actual (" + String(hoy.getMonth()+1).padStart(2,"0") + "/" + hoy.getFullYear() + "):",
    ui.ButtonSet.OK_CANCEL
  );
  if (respMes.getSelectedButton() !== ui.Button.OK) return;

  var mes;
  var anio;
  var input = respMes.getResponseText().trim();

  if (!input) {
    mes = hoy.getMonth() + 1;
    anio = hoy.getFullYear();
  } else {
    var partes = input.split("/");
    if (partes.length !== 2 || isNaN(partes[0]) || isNaN(partes[1])) {
      ui.alert("Formato incorrecto. Usa MM/YYYY (ej: 04/2026).");
      return;
    }
    mes = parseInt(partes[0], 10);
    anio = parseInt(partes[1], 10);
    if (mes < 1 || mes > 12) {
      ui.alert("Mes inválido.");
      return;
    }
  }

  var diasEnMes = new Date(anio, mes, 0).getDate();
  var existentes = ss.getSheets().map(function(s){ return s.getName(); });
  var creadas = 0;
  var omitidas = 0;

  for (var d = 1; d <= diasEnMes; d++) {
    var fecha = new Date(anio, mes - 1, d);
    var diaSem = fecha.getDay();
    if (diaSem === 0 || diaSem === 6) continue;

    var nombre = nombreDePestana(fecha);
    if (existentes.indexOf(nombre) >= 0) {
      omitidas++;
      continue;
    }

    var sheet = ss.insertSheet(nombre);
    construirTablaAgenda(sheet, fecha);
    creadas++;
  }

  if (creadas > 0) reordenarPestanas();

  ui.alert(
    "Listo",
    "Mes: " + MESES_ES[mes-1] + " " + anio + "\n" +
    "Pestañas creadas: " + creadas + "\n" +
    "Omitidas (ya existían): " + omitidas,
    ui.ButtonSet.OK
  );
}

function crearDiasEspecificos() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var resp = ui.prompt(
    "Crear días específicos",
    "Ingresa las fechas separadas por coma.\nFormato: DD/MM/YYYY\n\n" +
    "Ejemplo: 03/06/2026, 15/06/2026, 02/07/2026",
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var input = resp.getResponseText().trim();
  if (!input) {
    ui.alert("No ingresaste ninguna fecha.");
    return;
  }

  var entradas = input.split(",").map(function(s){ return s.trim(); }).filter(Boolean);
  var existentes = ss.getSheets().map(function(s){ return s.getName(); });
  var creadas = 0;
  var omitidas = 0;
  var errores = [];

  for (var i = 0; i < entradas.length; i++) {
    var fecha = parsearFechaInput(entradas[i]);
    if (!fecha) {
      errores.push(entradas[i]);
      continue;
    }

    var nombre = nombreDePestana(fecha);
    if (existentes.indexOf(nombre) >= 0) {
      omitidas++;
      continue;
    }

    var sheet = ss.insertSheet(nombre);
    construirTablaAgenda(sheet, fecha);
    creadas++;
  }

  if (creadas > 0) reordenarPestanas();

  var msg = "Pestañas creadas: " + creadas + "\nOmitidas (ya existían): " + omitidas;
  if (errores.length) msg += "\n\nNo se pudieron interpretar:\n" + errores.join(", ");
  ui.alert("Listo", msg, ui.ButtonSet.OK);
}

function eliminarSinNomenclatura() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();

  var correctas = sheets.filter(function(s){ return tieneNomenclaturaCorrecta(s.getName()); });
  var incorrectas = sheets.filter(function(s){ return !tieneNomenclaturaCorrecta(s.getName()); });

  if (incorrectas.length === 0) {
    ui.alert("Todo en orden", "Todas las pestañas ya tienen la nomenclatura correcta.", ui.ButtonSet.OK);
    return;
  }

  var listaCorrectas = correctas.map(function(s){ return "- " + s.getName(); }).join("\n") || "(ninguna)";
  var paso1 = ui.alert(
    "Pestañas que se conservarán",
    "Estas " + correctas.length + " pestaña(s) NO se tocarán:\n\n" + listaCorrectas +
    "\n\nPresiona OK para ver cuáles se eliminarán.",
    ui.ButtonSet.OK_CANCEL
  );
  if (paso1 !== ui.Button.OK) return;

  var preview = incorrectas.slice(0,30).map(function(s){ return "- " + s.getName(); }).join("\n");
  var masInfo = incorrectas.length > 30 ? "\n...y " + (incorrectas.length-30) + " más." : "";
  var confirmar = ui.alert(
    "Se eliminarán " + incorrectas.length + " pestaña(s)",
    preview + masInfo + "\n\n¿Confirmas?",
    ui.ButtonSet.YES_NO
  );
  if (confirmar !== ui.Button.YES) return;

  if (incorrectas.length >= sheets.length) {
    ui.alert("Error","No se pueden eliminar todas las pestañas.", ui.ButtonSet.OK);
    return;
  }

  incorrectas.forEach(function(s){ ss.deleteSheet(s); });
  ui.alert("Listo", "Se eliminaron " + incorrectas.length + " pestaña(s) con nomenclatura incorrecta.", ui.ButtonSet.OK);
}

function eliminarPestanasAntiguas() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var r1 = ui.prompt(
    "Fecha de inicio",
    "¿Desde qué fecha quieres eliminar?\nFormato: DD/MM/YYYY  (ej: 01/01/2025)\nO escribe 'todo' para desde el inicio:",
    ui.ButtonSet.OK_CANCEL
  );
  if (r1.getSelectedButton() !== ui.Button.OK) return;

  var r2 = ui.prompt(
    "Fecha de fin",
    "¿Hasta qué fecha quieres eliminar?\nFormato: DD/MM/YYYY  (ej: 31/03/2026):",
    ui.ButtonSet.OK_CANCEL
  );
  if (r2.getSelectedButton() !== ui.Button.OK) return;

  var inputInicio = r1.getResponseText().trim().toLowerCase();
  var fechaFin = parsearFechaInput(r2.getResponseText().trim());
  if (!fechaFin) {
    ui.alert("Fecha de fin inválida. Usa DD/MM/YYYY.");
    return;
  }

  var fechaInicio = inputInicio === "todo"
    ? new Date(2000,0,1)
    : parsearFechaInput(r1.getResponseText().trim());
  if (!fechaInicio) {
    ui.alert("Fecha de inicio inválida. Usa DD/MM/YYYY.");
    return;
  }
  if (fechaInicio > fechaFin) {
    ui.alert("La fecha de inicio no puede ser mayor que la de fin.");
    return;
  }

  var sheets = ss.getSheets();
  var aBorrar = sheets.filter(function(s) {
    var f = extraerFechaDePestana(s.getName());
    return f && f >= fechaInicio && f <= fechaFin;
  });

  if (aBorrar.length === 0) {
    ui.alert("No se encontraron pestañas en ese rango.");
    return;
  }

  var preview = aBorrar.slice(0,20).map(function(s){ return "- " + s.getName(); }).join("\n");
  var masInfo = aBorrar.length > 20 ? "\n...y " + (aBorrar.length-20) + " más." : "";
  var confirm = ui.alert(
    "Confirmar eliminación",
    "Se eliminarán " + aBorrar.length + " pestaña(s):\n\n" + preview + masInfo + "\n\n¿Continuar?",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  if (aBorrar.length >= sheets.length) {
    ui.alert("No se puede eliminar todas las pestañas. Debe quedar al menos una.");
    return;
  }

  aBorrar.forEach(function(s){ ss.deleteSheet(s); });
  ui.alert("Listo", "Se eliminaron " + aBorrar.length + " pestaña(s) correctamente.", ui.ButtonSet.OK);
}
