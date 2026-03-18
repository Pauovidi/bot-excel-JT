const DEMO_V2_CONFIG = {
  endpointUrl: 'https://TU-PROYECTO.vercel.app/api/triggers/sheets-edit',
  pushSecret: 'CAMBIA_ESTE_SECRETO',
  monitoredRow: 2,
  validSheets: ['Ortodoncia', 'Implantología', 'Limpieza dental'],
  headerPhone: 'Teléfono móvil',
  headerDate: 'Fecha del tratamiento',
  headerAction: 'tipo_accion'
};

function setupDemoV2Trigger() {
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.setProperties({
    DEMO_V2_ENDPOINT_URL: DEMO_V2_CONFIG.endpointUrl,
    DEMO_V2_PUSH_SECRET: DEMO_V2_CONFIG.pushSecret
  });

  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'onDemoV2Edit')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('onDemoV2Edit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  seedDemoV2Baselines();
}

function seedDemoV2Baselines() {
  const spreadsheet = SpreadsheetApp.getActive();
  DEMO_V2_CONFIG.validSheets.forEach((sheetName) => {
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      return;
    }

    const snapshot = readDemoV2RowSnapshot(sheet);
    if (!snapshot) {
      return;
    }

    writeDemoV2Baseline(sheetName, snapshot);
  });
}

function onDemoV2Edit(e) {
  if (!e || !e.range) {
    return;
  }

  const range = e.range;
  const sheet = range.getSheet();
  const sheetName = sheet.getName();
  const rowStart = range.getRow();
  const rowEnd = rowStart + range.getNumRows() - 1;

  if (!DEMO_V2_CONFIG.validSheets.includes(sheetName)) {
    console.log('[AppsScript] ignored unsupported sheet', sheetName);
    return;
  }

  if (rowStart > DEMO_V2_CONFIG.monitoredRow || rowEnd < DEMO_V2_CONFIG.monitoredRow) {
    console.log('[AppsScript] ignored row because not row 2', sheetName, rowStart, rowEnd);
    return;
  }

  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    const snapshot = readDemoV2RowSnapshot(sheet);
    if (!snapshot) {
      console.log('[AppsScript] ignored because snapshot missing', sheetName);
      return;
    }

    const baseline = readDemoV2Baseline(sheetName) || snapshot;
    if (!readDemoV2Baseline(sheetName)) {
      writeDemoV2Baseline(sheetName, snapshot);
      console.log('[AppsScript] baseline seeded', sheetName);
      return;
    }

    const phoneChanged = snapshot.phone !== baseline.phone;
    const dateChanged = snapshot.treatmentDate !== baseline.treatmentDate;
    const actionChanged = snapshot.actionType !== baseline.actionType;

    console.log('[AppsScript] sheet valid', sheetName);
    console.log('[AppsScript] row valid', DEMO_V2_CONFIG.monitoredRow);
    console.log('[AppsScript] phone changed', phoneChanged);
    console.log('[AppsScript] date changed', dateChanged);
    console.log('[AppsScript] tipo_accion changed', actionChanged);

    if (!phoneChanged && !dateChanged && !actionChanged) {
      console.log('[AppsScript] ignored non-relevant change', sheetName);
      return;
    }

    if (!(phoneChanged && dateChanged && actionChanged)) {
      if (actionChanged && !phoneChanged && !dateChanged) {
        console.log('[AppsScript] ignored because only tipo_accion changed', sheetName);
      } else {
        console.log('[AppsScript] ignored because only phone/date changed', sheetName);
      }
      return;
    }

    console.log('[AppsScript] relevant triple-change detected', sheetName, snapshot);

    const response = UrlFetchApp.fetch(getDemoV2EndpointUrl(), {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: {
        'x-demo-v2-secret': getDemoV2PushSecret()
      },
      payload: JSON.stringify({
        editId: buildDemoV2EditId_(sheetName),
        spreadsheetId: SpreadsheetApp.getActive().getId(),
        sheetName: sheetName,
        rowNumber: DEMO_V2_CONFIG.monitoredRow
      })
    });

    const statusCode = response.getResponseCode();
    const responseText = response.getContentText();
    console.log('[AppsScript] endpoint response', statusCode, responseText);

    if (statusCode < 200 || statusCode >= 300) {
      return;
    }

    const payload = JSON.parse(responseText || '{}');
    const reason = payload && payload.result ? payload.result.reason : '';
    if (reason === 'processed' || reason === 'duplicate') {
      writeDemoV2Baseline(sheetName, snapshot);
      console.log('[AppsScript] baseline updated', sheetName);
    }
  } finally {
    lock.releaseLock();
  }
}

function readDemoV2RowSnapshot(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (!lastColumn) {
    return null;
  }

  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const rowValues = sheet.getRange(DEMO_V2_CONFIG.monitoredRow, 1, 1, lastColumn).getValues()[0];
  const headerIndex = buildHeaderIndex_(headers);
  const phoneIndex = headerIndex[normalizeHeader_(DEMO_V2_CONFIG.headerPhone)];
  const dateIndex = headerIndex[normalizeHeader_(DEMO_V2_CONFIG.headerDate)];
  const actionIndex = headerIndex[normalizeHeader_(DEMO_V2_CONFIG.headerAction)];

  if (phoneIndex === undefined || dateIndex === undefined || actionIndex === undefined) {
    throw new Error('Faltan columnas requeridas en la hoja: Teléfono móvil, Fecha del tratamiento o tipo_accion.');
  }

  return {
    phone: String(rowValues[phoneIndex] || '').trim(),
    treatmentDate: normalizeSheetDate_(rowValues[dateIndex]),
    actionType: String(rowValues[actionIndex] || '').trim()
  };
}

function readDemoV2Baseline(sheetName) {
  const raw = PropertiesService.getDocumentProperties().getProperty(getDemoV2BaselineKey_(sheetName));
  return raw ? JSON.parse(raw) : null;
}

function writeDemoV2Baseline(sheetName, snapshot) {
  PropertiesService.getDocumentProperties().setProperty(
    getDemoV2BaselineKey_(sheetName),
    JSON.stringify(snapshot)
  );
}

function getDemoV2BaselineKey_(sheetName) {
  return 'DEMO_V2_BASELINE::' + sheetName;
}

function getDemoV2EndpointUrl() {
  return PropertiesService.getScriptProperties().getProperty('DEMO_V2_ENDPOINT_URL') || DEMO_V2_CONFIG.endpointUrl;
}

function getDemoV2PushSecret() {
  return PropertiesService.getScriptProperties().getProperty('DEMO_V2_PUSH_SECRET') || DEMO_V2_CONFIG.pushSecret;
}

function buildDemoV2EditId_(sheetName) {
  return sheetName + '-' + new Date().getTime();
}

function buildHeaderIndex_(headers) {
  const index = {};
  headers.forEach((header, position) => {
    index[normalizeHeader_(header)] = position;
  });
  return index;
}

function normalizeHeader_(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeSheetDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (!match) {
    return raw;
  }

  const day = ('0' + match[1]).slice(-2);
  const month = ('0' + match[2]).slice(-2);
  const year = match[3].length === 2 ? '20' + match[3] : match[3];
  return year + '-' + month + '-' + day;
}
