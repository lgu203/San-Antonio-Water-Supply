// ── SHARED.JS — used by both collector (acccount.html) and admin (admin.html) ──

// ── TARIFF ENGINE ────────────────────────────────────────────────
// Default rates — overwritten by fetched tariff from Google Sheet
const TARIFF_DEFAULTS = {
  R:  { min: 200, r1: 22,    r2: 23,    r3: 24,    envFee: 6, vat: 0 },
  CA: { min: 270, r1: 28.50, r2: 30.50, r3: 30.50, envFee: 6, vat: 0 },
  CB: { min: 230, r1: 24.50, r2: 26.50, r3: 26.50, envFee: 6, vat: 0 },
  NM: { min: 200, r1: 22,    r2: 23,    r3: 24,    envFee: 6, vat: 0.12 }
};
let TARIFF = JSON.parse(JSON.stringify(TARIFF_DEFAULTS)); // deep copy, will be overwritten on sync

function computeBill(consumption, type) {
  if (!consumption || consumption <= 0) return { basicAmt: 0, envFee: 0, total: 0 };
  type = (type || 'R').toUpperCase();
  // NM uses R rates + VAT, so fall back to R if NM not explicitly set
  const t = TARIFF[type] || TARIFF['R'];
  let basicAmt = 0;
  if      (consumption <= 10) basicAmt = t.min;
  else if (consumption <= 20) basicAmt = t.min + (consumption - 10) * t.r1;
  else if (consumption <= 30) basicAmt = t.min + 10 * t.r1 + (consumption - 20) * t.r2;
  else                        basicAmt = t.min + 10 * t.r1 + 10 * t.r2 + (consumption - 30) * t.r3;
  const envFee = consumption * t.envFee;
  let total = basicAmt + envFee;
  if (t.vat > 0) total = total * (1 + t.vat);
  return {
    basicAmt: Math.round(basicAmt * 100) / 100,
    envFee:   Math.round(envFee   * 100) / 100,
    total:    Math.round(total    * 100) / 100
  };
}

function applyTariff(data) {
  if (!data || typeof data !== 'object') return;
  // Merge fetched rates over defaults — only overwrite keys that exist
  for (const type of Object.keys(TARIFF_DEFAULTS)) {
    if (data[type]) TARIFF[type] = { ...TARIFF_DEFAULTS[type], ...data[type] };
  }
  try { localStorage.setItem('acct_tariff', JSON.stringify(TARIFF)); } catch (e) {}
}

function loadTariffFromCache() {
  try {
    const saved = localStorage.getItem('acct_tariff');
    if (saved) applyTariff(JSON.parse(saved));
  } catch (e) {}
}

// ── BARANGAY MAP ──────────────────────────────────────────────────
const BARANGAY = { 1:'Sta. Barbara', 2:'Panabingan', 3:'Cama Juan', 4:'Lawang Kupang' };
function brgyName(code) { return BARANGAY[code] || 'Brgy ' + code; }

// ── PARSE ROWS FROM EXCEL ─────────────────────────────────────────
function parseRows(rows) {
  const map = {};
  for (const row of rows) {
    const raw = row['Accnt'] || row['Account'] || row['accnt'] || 0;
    const acctNum = String(Math.round(Number(raw)));
    if (!acctNum || acctNum === '0' || acctNum === 'NaN') continue;
    const dateVal = row['LessMonth'] || row['lessmonth'] || row['Date'] || '';
    let dateStr = '';
    if (typeof dateVal === 'string' && dateVal.length >= 8) dateStr = dateVal.slice(0,10);
    else if (typeof dateVal === 'number' && dateVal > 0)
      dateStr = new Date((dateVal - 25569) * 86400 * 1000).toISOString().slice(0,10);
    const acctType = String(row['Type'] || row['type'] || 'R').trim().toUpperCase() || 'R';
    const entry = {
      month:       String(row['Month'] || row['month'] || ''),
      date:        dateStr,
      reading:     Number(row['Rdng'] || 0) || 0,
      type:        acctType,
      installment: (row['Instn'] != null && row['Instn'] !== '') ? (Number(row['Instn']) || null) : null,
      consumption: 0, basicAmt: 0, envFee: 0, total: 0
    };
    if (!map[acctNum]) {
      map[acctNum] = {
        accountNumber: acctNum,
        accountName:   String(row['AccountName'] || ''),
        barangayCode:  Math.round(Number(row['BarangayCode'] || 1)) || 1,
        purk:          Math.round(Number(row['Purk'] || 1)) || 1,
        acctType:      acctType,
        months:        []
      };
    } else {
      const n = String(row['AccountName'] || '');
      if (n) map[acctNum].accountName = n;
    }
    // Use Excel's pre-computed amounts if present; store them on the entry now
    // so we don't lose them after the loop below overwrites with reading-diff calc.
    entry._excelBasic = Number(row['BasicAmt'] || row['basicAmt'] || 0) || 0;
    entry._excelEnv   = Number(row['EnvFee']   || row['envFee']   || 0) || 0;
    entry._excelTotal = Number(row['Total']    || row['total']    || 0) || 0;
    map[acctNum].months.push(entry);
  }
  for (const a of Object.values(map)) {
    a.months.sort((x, y) => (x.date || '').localeCompare(y.date || ''));
    for (let i = 0; i < a.months.length; i++) {
      const cur  = a.months[i];
      const prev = i > 0 ? a.months[i - 1] : null;
      const consumption = prev ? Math.max(0, cur.reading - prev.reading) : 0;
      cur.consumption = consumption;
      // Prefer Excel's pre-computed amounts — only fall back to recompute
      // if the Excel columns are missing/zero (e.g. manually-entered readings).
      if (cur._excelTotal > 0) {
        cur.basicAmt = cur._excelBasic;
        cur.envFee   = cur._excelEnv;
        cur.total    = cur._excelTotal;
      } else {
        const bill   = computeBill(consumption, cur.type || a.acctType);
        cur.basicAmt = bill.basicAmt;
        cur.envFee   = bill.envFee;
        cur.total    = bill.total;
      }
      // Clean up temporary fields
      delete cur._excelBasic;
      delete cur._excelEnv;
      delete cur._excelTotal;
    }
    a.months.reverse();
  }
  return map;
}

function overwriteData(newMap, ACCOUNTS, accountMap) {
  for (const [acctNum, newAcct] of Object.entries(newMap)) {
    if (accountMap[acctNum]) {
      accountMap[acctNum].accountName  = newAcct.accountName || accountMap[acctNum].accountName;
      accountMap[acctNum].barangayCode = newAcct.barangayCode;
      accountMap[acctNum].purk         = newAcct.purk;
      accountMap[acctNum].months       = newAcct.months;
    } else {
      ACCOUNTS.push(newAcct);
      accountMap[acctNum] = newAcct;
    }
  }
}

function parseDateFromFilename(fileName) {
  const match = fileName.match(/(\d{8})/);
  if (!match) return '';
  const s = match[1];
  const mm = parseInt(s.slice(0,2), 10);
  const dd = parseInt(s.slice(2,4), 10);
  const yyyy = parseInt(s.slice(4,8), 10);
  if (!mm || !dd || !yyyy) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return (months[mm - 1] || '') + ' ' + dd + ', ' + yyyy;
}

// ── BALANCE CALCULATION ───────────────────────────────────────────
// Payments are applied oldest-first (chronological order).
// If totalPaid is 0, all months are Unpaid — no guessing.
function calcMonthBalances(months, totalPaid) {
  const paid = Math.max(0, Number(totalPaid) || 0);
  let remaining = paid;
  return [...months].reverse().map(m => {
    const billAmt  = m.total || m.basicAmt || 0;
    const paidAmt  = paid > 0 ? Math.min(remaining, billAmt) : 0;
    remaining      = Math.max(0, remaining - billAmt);
    const rem      = Math.max(0, billAmt - paidAmt);
    return { ...m, paid: paidAmt, remaining: rem,
      status: paidAmt >= billAmt && billAmt > 0 ? 'Paid'
            : paidAmt > 0                       ? 'Partial'
            :                                     'Unpaid' };
  }).reverse();
}

// ── HELPERS ───────────────────────────────────────────────────────
function fmt(n) { return Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function titleCase(s) { return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }
function formatDate(d) {
  return d.toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' }) + ' ' +
         d.toLocaleTimeString('en-PH', { hour:'2-digit', minute:'2-digit' });
}
function getScriptUrl() { return localStorage.getItem('acct_script_url') || ''; }
// ── QUOTA GUARD — huwag mag-fetch kung hindi pa lumipas ang minimum interval ──
const FETCH_MIN_INTERVAL = {
  data:     5 * 60 * 1000,  // data (Excel rows) — 5 minuto
  payments: 2 * 60 * 1000,  // payments — 2 minuto
  tariff:   60 * 60 * 1000, // tariff — 1 oras
  readings: 5 * 60 * 1000   // readings — 5 minuto
};

function canFetch(action) {
  const key  = 'acct_last_fetch_' + action;
  const last = parseInt(localStorage.getItem(key) || '0', 10);
  const now  = Date.now();
  if (now - last < (FETCH_MIN_INTERVAL[action] || 60000)) return false;
  localStorage.setItem(key, String(now));
  return true;
}

function forceFetch(action) {
  localStorage.setItem('acct_last_fetch_' + action, '0');
}
