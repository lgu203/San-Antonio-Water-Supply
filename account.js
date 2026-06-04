// ── SHARED.JS — used by both collector (acccount.html) and admin (admin.html) ──

// ── TARIFF ENGINE ────────────────────────────────────────────────
function computeBill(consumption, type) {
  if (!consumption || consumption <= 0) return { basicAmt: 0, envFee: 0, total: 0 };
  type = (type || 'R').toUpperCase();
  let basicAmt = 0;
  if (type === 'CA') {
    if      (consumption <= 10) basicAmt = 270;
    else if (consumption <= 20) basicAmt = 270 + (consumption - 10) * 28.50;
    else if (consumption <= 30) basicAmt = 270 + 10 * 28.50 + (consumption - 20) * 30.50;
    else                        basicAmt = 270 + 10 * 28.50 + 10 * 30.50 + (consumption - 30) * 30.50;
  } else if (type === 'CB') {
    if      (consumption <= 10) basicAmt = 230;
    else if (consumption <= 20) basicAmt = 230 + (consumption - 10) * 24.50;
    else if (consumption <= 30) basicAmt = 230 + 10 * 24.50 + (consumption - 20) * 26.50;
    else                        basicAmt = 230 + 10 * 24.50 + 10 * 26.50 + (consumption - 30) * 26.50;
  } else {
    if      (consumption <= 10) basicAmt = 200;
    else if (consumption <= 20) basicAmt = 200 + (consumption - 10) * 22;
    else if (consumption <= 30) basicAmt = 200 + 10 * 22 + (consumption - 20) * 23;
    else                        basicAmt = 200 + 10 * 22 + 10 * 23 + (consumption - 30) * 24;
  }
  const envFee = consumption * 6;
  let total = basicAmt + envFee;
  if (type === 'NM') total = total * 1.12;
  return {
    basicAmt: Math.round(basicAmt * 100) / 100,
    envFee:   Math.round(envFee   * 100) / 100,
    total:    Math.round(total    * 100) / 100
  };
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
    map[acctNum].months.push(entry);
  }
  for (const a of Object.values(map)) {
    a.months.sort((x, y) => (x.date || '').localeCompare(y.date || ''));
    for (let i = 0; i < a.months.length; i++) {
      const cur  = a.months[i];
      const prev = i > 0 ? a.months[i - 1] : null;
      const consumption = prev ? Math.max(0, cur.reading - prev.reading) : 0;
      const bill = computeBill(consumption, cur.type || a.acctType);
      cur.consumption = consumption;
      cur.basicAmt    = bill.basicAmt;
      cur.envFee      = bill.envFee;
      cur.total       = bill.total;
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
function calcMonthBalances(months, totalPaid) {
  let remaining = totalPaid;
  return [...months].reverse().map(m => {
    const billAmt = m.total || m.basicAmt;
    const paid    = Math.min(remaining, billAmt);
    remaining     = Math.max(0, remaining - billAmt);
    const rem     = Math.max(0, billAmt - paid);
    return { ...m, paid, remaining: rem,
      status: paid >= billAmt ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid' };
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