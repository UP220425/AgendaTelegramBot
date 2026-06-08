const sharp = require('sharp');
const dayjs = require('dayjs');

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

const TABLE_WIDTH = 1440;
const TITLE_HEIGHT = 60;
const HEADER_HEIGHT = 48;
const MIN_ROW_HEIGHT = 42;
const CELL_PADDING_X = 12;
const CELL_PADDING_Y = 8;
const BORDER_COLOR = '#111111';
const BLUE = '#1155cc';
const WHITE = '#ffffff';
const HIGHLIGHT = '#f4cccc';

const COLUMNS = [
  { key: 'fecha', label: 'Fecha', width: 150 },
  { key: 'hora', label: 'Hora Mexico', width: 205 },
  { key: 'cliente', label: 'Cliente', width: 180 },
  { key: 'meeting', label: 'Nombre del meeting', width: 360 },
  { key: 'asignadaA', label: 'Asignada a', width: 250 },
  { key: 'link', label: 'Link / Comentarios', width: 295 },
];

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

function formatShortDate(date) {
  const parsedDate = dayjs.isDayjs(date) ? date : dayjs(date);
  const safeDate = parsedDate.isValid() ? parsedDate : dayjs();

  return safeDate.format('DD-MM-YYYY');
}

function getMeetingRow(date, meeting) {
  return {
    fecha: formatShortDate(date),
    hora: meeting.horaMexico || `${meeting.start || ''} - ${meeting.end || ''}`.trim(),
    cliente: meeting.cliente || '',
    meeting: meeting.nombreMeeting || '',
    asignadaA: meeting.asignadaA || (Array.isArray(meeting.personasAsignadas)
      ? meeting.personasAsignadas.join(' / ')
      : ''),
    link: meeting.linkComentarios || '',
  };
}

function wrapText(value, width, fontSize) {
  const text = String(value || '').trim();

  if (!text) {
    return [''];
  }

  const maxChars = Math.max(6, Math.floor((width - CELL_PADDING_X * 2) / (fontSize * 0.52)));
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  words.forEach((word) => {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (candidate.length <= maxChars) {
      currentLine = candidate;
      return;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    currentLine = word;
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function getRowHeight(row) {
  const fontSize = 22;
  const lineHeight = 25;
  const maxLines = COLUMNS.reduce((count, column) => {
    const lines = wrapText(row[column.key], column.width, fontSize);
    return Math.max(count, lines.length);
  }, 1);

  return Math.max(MIN_ROW_HEIGHT, maxLines * lineHeight + CELL_PADDING_Y * 2);
}

function renderTextLines(lines, x, y, width, height, fontSize, color, weight = 600) {
  const lineHeight = Math.round(fontSize * 1.18);
  const totalHeight = lines.length * lineHeight;
  const startY = y + (height - totalHeight) / 2 + fontSize * 0.82;

  return lines.map((line, index) => (
    `<text x="${x + width / 2}" y="${startY + index * lineHeight}" `
    + `font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" `
    + `font-weight="${weight}" fill="${color}" text-anchor="middle">`
    + `${escapeXml(line)}</text>`
  )).join('');
}

function shouldHighlightRow(row) {
  return /\byess\b|\byes\b|\byessica\b/i.test(row.asignadaA);
}

function renderTableSvg(date, agenda = []) {
  const rows = agenda.map((meeting) => getMeetingRow(date, meeting));
  const rowHeights = rows.map(getRowHeight);
  const imageHeight = TITLE_HEIGHT + HEADER_HEIGHT + rowHeights.reduce((total, height) => total + height, 0) + 2;
  let currentY = 0;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TABLE_WIDTH}" height="${imageHeight}" viewBox="0 0 ${TABLE_WIDTH} ${imageHeight}">`,
    `<rect x="0" y="0" width="${TABLE_WIDTH}" height="${imageHeight}" fill="${WHITE}"/>`,
    `<rect x="0" y="0" width="${TABLE_WIDTH}" height="${TITLE_HEIGHT}" fill="${BLUE}" stroke="${BORDER_COLOR}" stroke-width="2"/>`,
    renderTextLines([`Agenda ${formatLongSpanishDate(date)}`], 0, 0, TABLE_WIDTH, TITLE_HEIGHT, 32, WHITE, 700),
  ];

  currentY += TITLE_HEIGHT;

  let currentX = 0;
  COLUMNS.forEach((column) => {
    parts.push(`<rect x="${currentX}" y="${currentY}" width="${column.width}" height="${HEADER_HEIGHT}" fill="${BLUE}" stroke="${BORDER_COLOR}" stroke-width="2"/>`);
    parts.push(renderTextLines([column.label], currentX, currentY, column.width, HEADER_HEIGHT, 24, WHITE, 700));
    currentX += column.width;
  });

  currentY += HEADER_HEIGHT;

  rows.forEach((row, rowIndex) => {
    currentX = 0;
    const rowHeight = rowHeights[rowIndex];
    const fill = shouldHighlightRow(row) ? HIGHLIGHT : WHITE;

    COLUMNS.forEach((column) => {
      const lines = wrapText(row[column.key], column.width, 22);
      parts.push(`<rect x="${currentX}" y="${currentY}" width="${column.width}" height="${rowHeight}" fill="${fill}" stroke="${BORDER_COLOR}" stroke-width="2"/>`);
      parts.push(renderTextLines(lines, currentX, currentY, column.width, rowHeight, 22, '#111111', 500));
      currentX += column.width;
    });

    currentY += rowHeight;
  });

  parts.push('</svg>');
  return parts.join('');
}

async function createAgendaImageBuffer(date, agenda = []) {
  const svg = renderTableSvg(date, agenda);

  return sharp(Buffer.from(svg))
    .png()
    .toBuffer();
}

module.exports = {
  createAgendaImageBuffer,
};
