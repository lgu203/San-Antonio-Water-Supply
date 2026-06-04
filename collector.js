// collector.js — read-only view, unpaid/partial accounts only
let ACCOUNTS   = [];
let accountMap = {};
let PAYMENTS   = {}; // { acctNum: totalPaid }
let syncTimer  = null;
const SYNC_INTERVAL = 30 * 1000; // 30 seconds — para ma-reflect agad ang payments mula sa ibang device
let _lastReadingsCache = '';

// ── BOOTSTRAP ─────────────────────────────────────────────────────
(function () {
  try {
    const saved = localStorage.getItem('acct_data_v2');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) { initData(parsed); updateSyncSub(); }
    }
    const savedPay = localStorage.getItem('acct_payments_cache');
    if (savedPay) PAYMENTS = JSON.parse(savedPay);
    loadTariffFromCache();
    // Load manually entered readings and inject into accounts
    _lastReadingsCache = localStorage.getItem('acct_readings_list') || '[]';
    const readings = JSON.parse(_lastReadingsCache);
    for (const r of readings) {
      const acct = accountMap[String(r.accountNumber)];
      if (!acct) continue;
      if (acct.months.some(m => m.month === r.month)) continue;
      const bill = computeBill(r.consumption, r.type || acct.acctType || 'R');
      acct.months.unshift({
        month: r.month, date: r.date, reading: r.presentReading,
        type: r.type, installment: null,
        consumption: r.consumption,
        basicAmt: bill.basicAmt, envFee: bill.envFee, total: bill.total
      });
    }
  } catch (e) {}
  if (document.readyState === 'complete') { attemptSync(); startSyncTimer(); }
  else window.addEventListener('load', () => { attemptSync(); startSyncTimer(); });
})();

function initData(data) {
  ACCOUNTS   = data;
  accountMap = {};
  ACCOUNTS.forEach(a => { accountMap[a.accountNumber] = a; });
  updateRecordCount();
  if (ACCOUNTS.length > 0 && document.querySelector('.empty-state'))
    document.getElementById('results').innerHTML = '';
}

function updateRecordCount() {
  const dataDate = localStorage.getItem('acct_data_date');
  const dateLabel = dataDate ? ' · Data as of ' + dataDate : '';
  const unpaidCount = ACCOUNTS.filter(a => {
    const bill  = a.months.reduce((s, m) => s + (m.total || m.basicAmt), 0);
    const paid  = PAYMENTS[a.accountNumber] || 0;
    return (bill - paid) > 0;
  }).length;
  document.getElementById('record-count').textContent =
    unpaidCount + ' accounts with balance' + dateLabel + ' — search by account number or name';
}

function saveLocal() {
  try { localStorage.setItem('acct_data_v2', JSON.stringify(ACCOUNTS)); } catch (e) {}
}

// ── SYNC ──────────────────────────────────────────────────────────
function startSyncTimer() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(attemptSync, SYNC_INTERVAL);
}

window.addEventListener('online',  () => { setSyncStatus('syncing', 'Connecting...'); setTimeout(attemptSync, 800); });
window.addEventListener('offline', () => { setSyncStatus('offline', 'No internet'); updateSyncSub(); });

function attemptSync() {
  const url = getScriptUrl();
  if (!url) {
    setSyncStatus('waiting', 'Not configured');
    document.getElementById('sync-sub').textContent = 'Tap Setup to connect to Google Drive';
    return;
  }
  if (!navigator.onLine) { setSyncStatus('offline', 'No internet'); updateSyncSub(); return; }
  doSync(url);
}

function doSync(url) {
  setSyncStatus('syncing', 'Syncing...');

  // Fetch each independently — one failure won't break the others
  const fetchJSON = (endpoint) =>
    fetch(url + endpoint, { cache: 'no-store', redirect: 'follow' })
      .then(r => r.json())
      .catch(() => ({ error: 'fetch failed' }));

  Promise.all([
    fetchJSON('?action=data'),
    fetchJSON('?action=payments'),
    fetchJSON('?action=tariff'),
    fetchJSON('?action=readings')
  ])
  .then(([data, payData, tariffData, rdgData]) => {
    // Process billing rows
    if (!data.error && data.rows && data.rows.length) {
      const newMap = parseRows(data.rows);
      overwriteData(newMap, ACCOUNTS, accountMap);
      saveLocal();
      const ts = formatDate(new Date());
      localStorage.setItem('acct_last_sync', ts);
      localStorage.setItem('acct_last_file', data.fileName || '');
      const dateFromFile = parseDateFromFilename(data.fileName || '');
      if (dateFromFile) localStorage.setItem('acct_data_date', dateFromFile);
    }

    // Process payments from server — only overwrite local if server has data
    if (!payData.error && payData.payments && payData.payments.length > 0) {
      PAYMENTS = {};
      payData.payments.forEach(p => {
        const n = String(p.accountNumber);
        PAYMENTS[n] = (PAYMENTS[n] || 0) + Number(p.amount);
      });
      try { localStorage.setItem('acct_payments_cache', JSON.stringify(PAYMENTS)); } catch (e) {}
    } else {
      // Server has no payments — always use local admin-saved cache
      try {
        const local = localStorage.getItem('acct_payments_cache');
        PAYMENTS = local ? JSON.parse(local) : {};
      } catch (e) { PAYMENTS = {}; }
    }

    // Process tariff
    if (!tariffData.error && tariffData.rates) applyTariff(tariffData.rates);

    // Process manually entered readings — inject into account data
    if (!rdgData.error && rdgData.readings && rdgData.readings.length) {
      for (const r of rdgData.readings) {
        const acct = accountMap[String(r.accountNumber)];
        if (!acct) continue;
        // Skip if this month already exists from Excel data
        const alreadyHas = acct.months.some(m => m.month === r.month);
        if (alreadyHas) continue;
        const bill = computeBill(r.consumption, r.type);
        acct.months.unshift({
          month: r.month, date: r.date, reading: r.presentReading,
          type: r.type, installment: null,
          consumption: r.consumption, basicAmt: bill.basicAmt,
          envFee: bill.envFee, total: bill.total
        });
      }
      saveLocal();
    }

    setSyncStatus('online', 'Synced');
    updateSyncSub();
    updateRecordCount();
    showStatus('Synced · ' + (data.fileName || '') + ' · ' + formatDate(new Date()), 'success', 5000);
    doSearch();
  })
  .catch(err => {
    // Even on full failure, refresh from local cache
    try {
      const local = localStorage.getItem('acct_payments_cache');
      PAYMENTS = local ? JSON.parse(local) : {};
    } catch(e) { PAYMENTS = {}; }
    setSyncStatus('offline', 'Sync failed');
    updateSyncSub();
    showStatus('Could not reach server: ' + err.message, 'error', 5000);
    doSearch();
  });
}

function setSyncStatus(state, text) {
  document.getElementById('sync-dot').className = 'sync-dot ' + state;
  document.getElementById('sync-text').textContent = text;
}
function updateSyncSub() {
  const lastSync = localStorage.getItem('acct_last_sync');
  const lastFile = localStorage.getItem('acct_last_file');
  document.getElementById('sync-sub').textContent = lastSync
    ? 'Last sync: ' + lastSync + (lastFile ? ' · ' + lastFile : '')
    : (navigator.onLine ? '' : 'Using locally saved data');
}

// ── SETUP ─────────────────────────────────────────────────────────
function showSetup() {
  const banner  = document.getElementById('setup-banner');
  const visible = banner.style.display === 'block';
  banner.style.display = visible ? 'none' : 'block';
  if (!visible) document.getElementById('script-url-input').value = getScriptUrl();
}
function saveScriptUrl() {
  const url = document.getElementById('script-url-input').value.trim();
  if (!url || !url.startsWith('https://script.google.com')) {
    alert('Invalid URL. Must start with https://script.google.com'); return;
  }
  localStorage.setItem('acct_script_url', url);
  document.getElementById('setup-banner').style.display = 'none';
  attemptSync();
}

// ── STORAGE EVENT — auto-refresh when admin saves payments (cross-tab) ─────────
window.addEventListener('storage', e => {
  if (e.key === 'acct_payments_cache') {
    try { PAYMENTS = JSON.parse(e.newValue || '{}'); } catch(_) { PAYMENTS = {}; }
    updateRecordCount();
    doSearch();
    if (currentAcctNum) renderModalTable();
  }
});

// ── PAYMENT POLLING — para gumana kahit same browser, same tab ────
let _lastPayCache = '';
function pollPayments() {
  try {
    const raw = localStorage.getItem('acct_payments_cache') || '{}';
    if (raw !== _lastPayCache) {
      _lastPayCache = raw;
      PAYMENTS = JSON.parse(raw);
      updateRecordCount();
      doSearch();
      if (currentAcctNum) renderModalTable();
    }
  } catch(e) {}
}
setInterval(pollPayments, 2000);

// ── READINGS POLLING — mag-detect ng bagong readings na sine-save ng admin ──
// Katulad ng pollPayments — kinukuha ang acct_readings_list at ini-inject sa ACCOUNTS
function pollReadings() {
  try {
    const raw = localStorage.getItem('acct_readings_list') || '[]';
    if (raw === _lastReadingsCache) return;
    _lastReadingsCache = raw;
    const readings = JSON.parse(raw);
    if (!readings.length) return;

    let changed = false;
    for (const r of readings) {
      const acct = accountMap[String(r.accountNumber)];
      if (!acct) continue;
      // Skip if month already present (from Excel or previous inject)
      if (acct.months.some(m => m.month === r.month)) continue;
      const bill = computeBill(r.consumption, r.type || acct.acctType || 'R');
      acct.months.unshift({
        month: r.month, date: r.date, reading: r.presentReading,
        type: r.type, installment: null,
        consumption: r.consumption,
        basicAmt: bill.basicAmt, envFee: bill.envFee, total: bill.total
      });
      changed = true;
    }
    if (changed) {
      updateRecordCount();
      doSearch();
      if (currentAcctNum) renderModalTable();
    }
  } catch(e) {}
}
setInterval(pollReadings, 2000);

// ── SEARCH — shows UNPAID / PARTIAL only ──────────────────────────
document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// Always read from in-memory PAYMENTS (kept fresh by polling + storage event)
function getTotalPaid(acctNum) {
  return PAYMENTS[String(acctNum)] || 0;
}

function doSearch() {
  const q  = document.getElementById('searchInput').value.trim().toLowerCase();
  const el = document.getElementById('results');
  if (!q) { el.innerHTML = ''; return; }
  if (!ACCOUNTS.length) {
    el.innerHTML = '<p class="no-result">No data available. Please complete Setup to sync from Google Drive.</p>'; return;
  }

  const matches = ACCOUNTS.filter(a => {
    if (!a.accountNumber.includes(q) && !a.accountName.toLowerCase().includes(q)) return false;
    const bill    = a.months.reduce((s, m) => s + (m.total || m.basicAmt), 0);
    const paid    = getTotalPaid(a.accountNumber);
    return (bill - paid) > 0.01; // hide fully paid accounts
  });

  if (!matches.length) {
    el.innerHTML = '<p class="no-result">No unpaid accounts found for "<strong>' + escHtml(q) + '</strong>"</p>'; return;
  }

  el.innerHTML = matches.slice(0, 20).map(a => {
    const bill    = a.months.reduce((s, m) => s + (m.total || m.basicAmt), 0);
    const paid    = getTotalPaid(a.accountNumber);
    const balance = Math.max(0, bill - paid);
    return `
    <div class="result-item" onclick="openModal('${a.accountNumber}')">
      <div>
        <div class="acct-num">Acct # ${a.accountNumber} &nbsp;·&nbsp; ${brgyName(a.barangayCode)}, Purok ${a.purk}</div>
        <div class="acct-name">${escHtml(titleCase(a.accountName))}</div>
      </div>
      <div class="result-balance">
        <div class="lbl">Balance</div>
        <div class="bal">₱${fmt(balance)}</div>
      </div>
      <span class="arrow">›</span>
    </div>`;
  }).join('') +
    (matches.length > 20 ? `<p class="no-result" style="padding:6px 0">Showing top 20 of ${matches.length}. Refine your search.</p>` : '');
}

// ── MODAL — read-only, no payment input ───────────────────────────
let currentAcctNum = null;

function openModal(acctNum) {
  const a = accountMap[acctNum]; if (!a) return;
  currentAcctNum = acctNum;
  document.getElementById('modal-name').textContent = titleCase(a.accountName);
  document.getElementById('modal-acct').textContent = 'Acct # ' + a.accountNumber;
  document.getElementById('modal-brgy').textContent = brgyName(a.barangayCode);
  document.getElementById('modal-purk').textContent = a.purk;
  renderModalTable();
  document.getElementById('modal-overlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function renderModalTable() {
  const a         = accountMap[currentAcctNum]; if (!a) return;
  const totalPaid = getTotalPaid(currentAcctNum);
  const totalBill = a.months.reduce((s, m) => s + (m.total || m.basicAmt), 0);
  const balance   = Math.max(0, totalBill - totalPaid);
  const rows       = calcMonthBalances(a.months, totalPaid);
  const visibleRows = rows.filter(m => m.status !== 'Paid'); // collector: hide fully paid months

  document.getElementById('modal-grand').textContent   = '₱' + fmt(totalBill);
  document.getElementById('modal-paid').textContent    = '₱' + fmt(totalPaid);
  document.getElementById('modal-balance').textContent = '₱' + fmt(balance);

  document.getElementById('modal-table-body').innerHTML = visibleRows.map(m => {
    const inst = m.installment ? `<span class="badge-inst">+₱${fmt(m.installment)} inst.</span>` : '';
    return `<tr>
      <td><strong>${escHtml(m.month)}</strong></td>
      <td>${m.reading}</td>
      <td>₱${fmt(m.basicAmt)}</td>
      <td>₱${fmt(m.envFee)}</td>
      <td>₱${fmt(m.total)}${inst}</td>
      <td>₱${fmt(m.paid)}</td>
      <td>₱${fmt(m.remaining)}</td>
    </tr>`;
  }).join('');

  const gB = visibleRows.reduce((s, m) => s + m.basicAmt,   0);
  const gE = visibleRows.reduce((s, m) => s + m.envFee,     0);
  const gT = visibleRows.reduce((s, m) => s + m.total,      0);
  const gP = visibleRows.reduce((s, m) => s + m.paid,       0);
  const gR = visibleRows.reduce((s, m) => s + m.remaining,  0);
  document.getElementById('modal-table-foot').innerHTML =
    `<tr><td>TOTAL (${visibleRows.length})</td><td>—</td><td>₱${fmt(gB)}</td><td>₱${fmt(gE)}</td><td>₱${fmt(gT)}</td><td>₱${fmt(gP)}</td><td>₱${fmt(gR)}</td></tr>`;
}

function closeModal(e) { if (e.target === document.getElementById('modal-overlay')) closeModalDirect(); }
function closeModalDirect() { document.getElementById('modal-overlay').classList.remove('active'); document.body.style.overflow = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModalDirect(); });

function showStatus(msg, type, duration) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg; bar.className = type || 'info'; bar.style.display = 'block';
  if (duration) setTimeout(() => { bar.style.display = 'none'; }, duration);
}