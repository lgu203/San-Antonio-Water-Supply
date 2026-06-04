// admin.js — full access, payment recording, syncs to Google Sheet
let ACCOUNTS   = [];
let accountMap = {};
let PAYMENTS_LIST = []; // array of { paymentId, accountNumber, amount, note, timestamp }
let syncTimer  = null;
const SYNC_INTERVAL = 5 * 60 * 1000;

// ── BOOTSTRAP ─────────────────────────────────────────────────────
(function () {
  try {
    const saved = localStorage.getItem('acct_data_v2');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) { initData(parsed); updateSyncSub(); }
    }
    const savedPay = localStorage.getItem('acct_payments_list');
    if (savedPay) PAYMENTS_LIST = JSON.parse(savedPay);
    loadTariffFromCache();
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
  document.getElementById('record-count').textContent =
    ACCOUNTS.length + ' accounts loaded' + dateLabel + ' — search by account number or name';
}

function saveLocal() {
  try { localStorage.setItem('acct_data_v2', JSON.stringify(ACCOUNTS)); } catch (e) {}
}
function savePaymentsLocal() {
  try { localStorage.setItem('acct_payments_list', JSON.stringify(PAYMENTS_LIST)); } catch (e) {}
  syncPaymentsCache();
}

// Sync summary cache so collector.js can read updated payments without Google Sheet
function syncPaymentsCache() {
  const cache = {};
  PAYMENTS_LIST.forEach(p => {
    const n = String(p.accountNumber);
    cache[n] = (cache[n] || 0) + Number(p.amount);
  });
  try { localStorage.setItem('acct_payments_cache', JSON.stringify(cache)); } catch (e) {}
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
  Promise.all([
    fetch(url + '?action=data',     { cache: 'no-store', redirect: 'follow' }).then(r => r.json()),
    fetch(url + '?action=payments', { cache: 'no-store', redirect: 'follow' }).then(r => r.json()),
    fetch(url + '?action=tariff',   { cache: 'no-store', redirect: 'follow' }).then(r => r.json()),
    fetch(url + '?action=readings', { cache: 'no-store', redirect: 'follow' }).then(r => r.json()).catch(() => ({ readings: [] }))
  ])
  .then(([data, payData, tariffData, rdgData]) => {
    if (data.error) throw new Error(data.error);
    if (data.rows && data.rows.length) {
      const newMap = parseRows(data.rows);
      overwriteData(newMap, ACCOUNTS, accountMap);
      saveLocal();
      const ts = formatDate(new Date());
      localStorage.setItem('acct_last_sync', ts);
      localStorage.setItem('acct_last_file', data.fileName || '');
      const dateFromFile = parseDateFromFilename(data.fileName || '');
      if (dateFromFile) localStorage.setItem('acct_data_date', dateFromFile);
    }
    if (!payData.error && payData.payments) {
      PAYMENTS_LIST = payData.payments;
      savePaymentsLocal();
    }
    if (!tariffData.error && tariffData.rates) {
      applyTariff(tariffData.rates);
      populateTariffForm();
    }
    // Merge readings from server (from other devices)
    if (!rdgData.error && rdgData.readings) {
      mergeServerReadings(rdgData.readings);
    }
    setSyncStatus('online', 'Synced');
    updateSyncSub();
    updateRecordCount();
    showStatus('Synced · ' + (data.fileName || '') + ' · ' + formatDate(new Date()), 'success', 5000);
    doSearch();
    if (currentAcctNum) renderModalTable();
  })
  .catch(err => {
    // Preserve local payments — do NOT clear PAYMENTS_LIST on sync failure
    setSyncStatus('offline', 'Sync failed');
    updateSyncSub();
    showStatus('Could not reach server: ' + err.message, 'error', 5000);
    doSearch();
    if (currentAcctNum) renderModalTable();
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

// ── PAYMENTS HELPERS ──────────────────────────────────────────────
function getPaymentsForAcct(acctNum) {
  return PAYMENTS_LIST.filter(p => String(p.accountNumber) === String(acctNum));
}
function getTotalPaid(acctNum) {
  return getPaymentsForAcct(acctNum).reduce((s, p) => s + Number(p.amount), 0);
}

// ── SEARCH — shows ALL accounts ───────────────────────────────────
document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

function doSearch() {
  const q  = document.getElementById('searchInput').value.trim().toLowerCase();
  const el = document.getElementById('results');
  if (!q) { el.innerHTML = ''; return; }
  if (!ACCOUNTS.length) {
    el.innerHTML = '<p class="no-result">No data available. Please complete Setup to sync from Google Drive.</p>'; return;
  }
  const matches = ACCOUNTS.filter(a =>
    a.accountNumber.includes(q) || a.accountName.toLowerCase().includes(q)
  );
  if (!matches.length) {
    el.innerHTML = '<p class="no-result">No accounts found for "<strong>' + escHtml(q) + '</strong>"</p>'; return;
  }
  el.innerHTML = matches.slice(0, 20).map(a => {
    const bill    = a.months.reduce((s, m) => s + (m.total || m.basicAmt), 0);
    const paid    = getTotalPaid(a.accountNumber);
    const balance = Math.max(0, bill - paid);
    const cleared = balance <= 0.01;
    const statusLabel = cleared
      ? '<span class="status-paid">PAID</span>'
      : '<span class="status-unpaid">BALANCE</span>';
    return `
    <div class="result-item" onclick="openModal('${a.accountNumber}')">
      <div>
        <div class="acct-num">Acct # ${a.accountNumber} &nbsp;·&nbsp; ${brgyName(a.barangayCode)}, Purok ${a.purk}</div>
        <div class="acct-name">${escHtml(titleCase(a.accountName))} ${statusLabel}</div>
      </div>
      <div class="result-balance">
        <div class="lbl">Balance</div>
        <div class="bal${cleared ? ' cleared' : ''}">₱${fmt(balance)}</div>
      </div>
      <span class="arrow">›</span>
    </div>`;
  }).join('') +
    (matches.length > 20 ? `<p class="no-result" style="padding:6px 0">Showing top 20 of ${matches.length}. Refine your search.</p>` : '');
}

// ── MODAL ─────────────────────────────────────────────────────────
let currentAcctNum = null;

function openModal(acctNum) {
  const a = accountMap[acctNum]; if (!a) return;
  currentAcctNum = acctNum;
  document.getElementById('modal-name').textContent = titleCase(a.accountName);
  document.getElementById('modal-acct').textContent = 'Acct # ' + a.accountNumber;
  document.getElementById('modal-brgy').textContent = brgyName(a.barangayCode);
  document.getElementById('modal-purk').textContent = a.purk;
  document.getElementById('payment-input').value = '';
  renderModalTable();
  document.getElementById('modal-overlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function renderModalTable() {
  const a         = accountMap[currentAcctNum]; if (!a) return;
  const totalPaid = getTotalPaid(currentAcctNum);
  const totalBill = a.months.reduce((s, m) => s + (m.total || m.basicAmt), 0);
  const balance   = Math.max(0, totalBill - totalPaid);
  const rows      = calcMonthBalances(a.months, totalPaid);

  document.getElementById('modal-grand').textContent   = '₱' + fmt(totalBill);
  document.getElementById('modal-paid').textContent    = '₱' + fmt(totalPaid);
  document.getElementById('modal-balance').textContent = '₱' + fmt(balance);

  const firstUnpaid = rows.find(r => r.remaining > 0);
  document.getElementById('payment-hint').textContent = firstUnpaid
    ? 'Next unpaid: ' + firstUnpaid.month + ' — ₱' + fmt(firstUnpaid.remaining) + ' remaining'
    : '✓ All months cleared';

  document.getElementById('modal-table-body').innerHTML = rows.map(m => {
    const inst        = m.installment ? `<span class="badge-inst">+₱${fmt(m.installment)} inst.</span>` : '';
    const statusClass = m.status === 'Paid' ? 'status-paid' : m.status === 'Partial' ? 'status-partial' : 'status-unpaid';
    return `<tr>
      <td><strong>${escHtml(m.month)}</strong></td>
      <td>${m.reading}</td>
      <td>₱${fmt(m.basicAmt)}</td>
      <td>₱${fmt(m.envFee)}</td>
      <td>₱${fmt(m.total)}${inst}</td>
      <td>₱${fmt(m.paid)}</td>
      <td>₱${fmt(m.remaining)}</td>
      <td><span class="${statusClass}">${m.status}</span></td>
    </tr>`;
  }).join('');

  const gB = rows.reduce((s, m) => s + m.basicAmt,   0);
  const gE = rows.reduce((s, m) => s + m.envFee,     0);
  const gT = rows.reduce((s, m) => s + m.total,      0);
  const gP = rows.reduce((s, m) => s + m.paid,       0);
  const gR = rows.reduce((s, m) => s + m.remaining,  0);
  document.getElementById('modal-table-foot').innerHTML =
    `<tr><td>TOTAL (${rows.length})</td><td>—</td><td>₱${fmt(gB)}</td><td>₱${fmt(gE)}</td><td>₱${fmt(gT)}</td><td>₱${fmt(gP)}</td><td>₱${fmt(gR)}</td><td></td></tr>`;

  renderPaymentHistory();
}

function renderPaymentHistory() {
  const payments = getPaymentsForAcct(currentAcctNum);
  const list     = document.getElementById('payment-history-list');
  if (!payments.length) { list.innerHTML = '<p class="no-payments">No payments recorded yet.</p>'; return; }
  list.innerHTML = [...payments].reverse().map(p =>
    `<div class="pay-hist-item">
      <div>
        <div class="pay-hist-amt">₱${fmt(p.amount)}</div>
        <div class="pay-hist-date">${p.timestamp}${p.note ? ' · ' + escHtml(p.note) : ''}</div>
      </div>
      <button class="btn-undo" onclick="undoPayment('${p.paymentId}')">✕ Undo</button>
    </div>`
  ).join('');
}

// ── RECORD PAYMENT ────────────────────────────────────────────────
function recordPayment() {
  const input  = document.getElementById('payment-input');
  const amount = parseFloat(input.value);
  if (!amount || amount <= 0) { showStatus('Enter a valid payment amount.', 'error', 3000); return; }
  const a         = accountMap[currentAcctNum];
  const totalBill = a.months.reduce((s, m) => s + (m.total || m.basicAmt), 0);
  const totalPaid = getTotalPaid(currentAcctNum);
  if (totalPaid >= totalBill) { showStatus('This account has no outstanding balance.', 'warning', 3000); return; }

  const url = getScriptUrl();
  const ts  = formatDate(new Date());
  const payload = {
    action:        'savePayment',
    accountNumber: currentAcctNum,
    amount,
    note:          '',
    timestamp:     ts
  };

  // Optimistic: add locally right away
  const tempId = 'temp_' + Date.now();
  PAYMENTS_LIST.push({ paymentId: tempId, accountNumber: currentAcctNum, amount, note: '', timestamp: ts });
  savePaymentsLocal();
  input.value = '';
  renderModalTable();
  doSearch();
  showStatus('Payment of ₱' + fmt(amount) + ' recorded.', 'success', 4000);

  // Sync to server in background
  if (url && navigator.onLine) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(r => r.json())
    .then(res => {
      if (res.paymentId) {
        // Replace temp ID with real server ID
        const idx = PAYMENTS_LIST.findIndex(p => p.paymentId === tempId);
        if (idx !== -1) PAYMENTS_LIST[idx].paymentId = res.paymentId;
        savePaymentsLocal();
      }
    })
    .catch(() => showStatus('Payment saved locally. Will sync when back online.', 'warning', 4000));
  } else {
    showStatus('Saved locally — will sync when online.', 'warning', 4000);
  }
}

// ── UNDO PAYMENT ──────────────────────────────────────────────────
function undoPayment(paymentId) {
  if (!confirm('Remove this payment?')) return;
  const idx = PAYMENTS_LIST.findIndex(p => p.paymentId === paymentId);
  if (idx === -1) return;
  PAYMENTS_LIST.splice(idx, 1);
  savePaymentsLocal();
  renderModalTable();
  doSearch();
  showStatus('Payment removed.', 'info', 3000);

  const url = getScriptUrl();
  if (url && navigator.onLine && !String(paymentId).startsWith('temp_')) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'undoPayment', paymentId })
    }).catch(() => {});
  }
}

function closeModal(e) { if (e.target === document.getElementById('modal-overlay')) closeModalDirect(); }
function closeModalDirect() {
  document.getElementById('modal-overlay').classList.remove('active');
  document.getElementById('modal-tariff-panel').style.display = 'none';
  document.getElementById('reading-modal-overlay').style.display = 'none';
  document.body.style.overflow = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModalDirect(); });

function showStatus(msg, type, duration) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg; bar.className = type || 'info'; bar.style.display = 'block';
  if (duration) setTimeout(() => { bar.style.display = 'none'; }, duration);
}
// ── TARIFF SETTINGS ───────────────────────────────────────────────
function toggleModalTariff() {
  const panel = document.getElementById('modal-tariff-panel');
  const visible = panel.style.display === 'block';
  panel.style.display = visible ? 'none' : 'block';
  if (!visible) populateTariffForm();
}

function populateTariffForm() {
  const types = ['R', 'CA', 'CB', 'NM'];
  types.forEach(t => {
    const rates = TARIFF[t] || TARIFF_DEFAULTS[t];
    const el = id => document.getElementById('tr-' + t + '-' + id);
    if (el('min'))    el('min').value    = rates.min;
    if (el('r1'))     el('r1').value     = rates.r1;
    if (el('r2'))     el('r2').value     = rates.r2;
    if (el('r3'))     el('r3').value     = rates.r3;
    if (el('envFee')) el('envFee').value = rates.envFee;
  });
}

function saveTariff() {
  const types = ['R', 'CA', 'CB', 'NM'];
  const newRates = {};
  for (const t of types) {
    const el = id => document.getElementById('tr-' + t + '-' + id);
    newRates[t] = {
      min:    parseFloat(el('min').value)    || TARIFF_DEFAULTS[t].min,
      r1:     parseFloat(el('r1').value)     || TARIFF_DEFAULTS[t].r1,
      r2:     parseFloat(el('r2').value)     || TARIFF_DEFAULTS[t].r2,
      r3:     parseFloat(el('r3').value)     || TARIFF_DEFAULTS[t].r3,
      envFee: parseFloat(el('envFee').value) || TARIFF_DEFAULTS[t].envFee,
      vat:    TARIFF_DEFAULTS[t].vat  // VAT not editable in UI — fixed per type
    };
  }

  applyTariff(newRates);

  const url = getScriptUrl();
  if (!url || !navigator.onLine) {
    showStatus('Tariff saved locally. Will sync when online.', 'warning', 4000);
    return;
  }

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'saveTariff', rates: newRates })
  })
  .then(r => r.json())
  .then(res => {
    if (res.error) throw new Error(res.error);
    showStatus('Tariff rates saved to Google Sheet.', 'success', 4000);
    doSearch();
    if (currentAcctNum) renderModalTable();
  })
  .catch(err => showStatus('Saved locally, server error: ' + err.message, 'warning', 4000));
}

function resetTariff() {
  if (!confirm('Reset all rates to system defaults?')) return;
  applyTariff(JSON.parse(JSON.stringify(TARIFF_DEFAULTS)));
  populateTariffForm();
  showStatus('Rates reset to defaults.', 'info', 3000);
}
// ═══════════════════════════════════════════════════════════════════
// READING ENTRY PANEL
// ═══════════════════════════════════════════════════════════════════

let READINGS_LIST = []; // { readingId, accountNumber, accountName, month, date, prevReading, presentReading, consumption, type, timestamp }
let rpSelectedAcct = null; // currently selected account in reading panel

// Load saved readings from localStorage on boot
(function loadReadings() {
  try {
    const saved = localStorage.getItem('acct_readings_list');
    if (saved) READINGS_LIST = JSON.parse(saved);
  } catch(e) {}
})();

function saveReadingsLocal() {
  try { localStorage.setItem('acct_readings_list', JSON.stringify(READINGS_LIST)); } catch(e) {}
}

// ── MONTH DROPDOWN HELPERS ────────────────────────────────────────
function rpPopulateYears() {
  const sel = document.getElementById('rp-month-y');
  if (!sel) return;
  sel.innerHTML = '';
  const now = new Date();
  for (let y = now.getFullYear() + 10; y >= 2015; y--) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    if (y === now.getFullYear()) opt.selected = true;
    sel.appendChild(opt);
  }
}

function rpSyncMonthLabel() {
  const m = document.getElementById('rp-month-m').value;
  const y = document.getElementById('rp-month-y').value;
  document.getElementById('rp-month').value = m + ' ' + y;
}

function rpSetMonthDropdowns(label) {
  // label like "Jun 2025"
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts = (label || '').trim().split(' ');
  const mIdx = months.indexOf(parts[0]);
  const yr   = parseInt(parts[1], 10);
  if (mIdx >= 0) document.getElementById('rp-month-m').value = months[mIdx];
  if (yr)        document.getElementById('rp-month-y').value = yr;
  rpSyncMonthLabel();
}

// ── READING MODAL OPEN / CLOSE ────────────────────────────────────
function openReadingModal() {
  if (!currentAcctNum) return;
  const a = accountMap[currentAcctNum];
  if (!a) return;

  rpSelectedAcct = a;

  // Populate account info strip in 2nd modal
  document.getElementById('rdg-modal-acct-badge').textContent = 'Acct # ' + a.accountNumber;
  document.getElementById('rdg-modal-acct-name').textContent  = titleCase(a.accountName);
  document.getElementById('rdg-modal-acct-meta').textContent  =
    brgyName(a.barangayCode) + ', Purok ' + a.purk + (a.acctType ? ' · Type: ' + a.acctType : '');

  const lastM       = a.months[0];
  const lastReading = lastM ? lastM.reading : 0;
  const lastMonth   = lastM ? lastM.month   : 'N/A';
  document.getElementById('rdg-modal-last').innerHTML =
    `Last recorded reading: <strong>${lastReading} m³</strong> &nbsp;·&nbsp; Month: <strong>${lastMonth}</strong>` +
    (lastM ? ` &nbsp;·&nbsp; Date: <strong>${lastM.date || '—'}</strong>` : '');

  // Pre-fill form
  rpPopulateYears();
  document.getElementById('rp-prev').value    = lastReading;
  document.getElementById('rp-present').value = '';
  document.getElementById('rp-consumption').value = '';
  document.getElementById('rp-preview').style.display = 'none';

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('rp-date').value = today;
  rpSetMonthDropdowns(rpNextMonthLabel(lastMonth));

  // Show reading history
  rpRenderHistory(a.accountNumber);

  // Open 2nd modal
  const overlay = document.getElementById('reading-modal-overlay');
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeReadingModal(e) {
  if (e && e.target !== document.getElementById('reading-modal-overlay')) return;
  _closeReadingModal();
}

function _closeReadingModal() {
  document.getElementById('reading-modal-overlay').style.display = 'none';
  // Refresh main modal table in case a reading was saved
  if (currentAcctNum) renderModalTable();
  // Ensure main modal body scroll is restored
  document.body.style.overflow = 'hidden'; // main modal still open
}

// ── CLEAR / RESET FORM ───────────────────────────────────────────
function rpNextMonthLabel(lastMonthStr) {
  // Try to parse "MMM YYYY" → add 1 month
  if (!lastMonthStr || lastMonthStr === 'N/A') {
    const now = new Date();
    return now.toLocaleString('en-PH', { month: 'short' }) + ' ' + now.getFullYear();
  }
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts  = lastMonthStr.trim().split(' ');
  if (parts.length >= 2) {
    const mIdx = months.indexOf(parts[0]);
    const yr   = parseInt(parts[parts.length - 1], 10);
    if (mIdx >= 0 && yr) {
      const nextMIdx = (mIdx + 1) % 12;
      const nextYr   = mIdx === 11 ? yr + 1 : yr;
      return months[nextMIdx] + ' ' + nextYr;
    }
  }
  const now = new Date();
  return now.toLocaleString('en-PH', { month: 'short' }) + ' ' + now.getFullYear();
}

function rpClearSearch() {
  rpSelectedAcct = null;
  document.getElementById('rp-history').style.display = 'none';
  rpResetForm();
}

function rpResetForm() {
  document.getElementById('rp-prev').value        = '';
  document.getElementById('rp-present').value     = '';
  document.getElementById('rp-consumption').value = '';
  document.getElementById('rp-preview').style.display = 'none';
}
function rpComputePreview() {
  if (!rpSelectedAcct) return;
  const prev    = parseFloat(document.getElementById('rp-prev').value)    || 0;
  const present = parseFloat(document.getElementById('rp-present').value) || 0;
  const type    = rpSelectedAcct.acctType || 'R';
  const consumption = Math.max(0, present - prev);

  document.getElementById('rp-consumption').value = consumption;

  if (present <= 0) {
    document.getElementById('rp-preview').style.display = 'none';
    return;
  }

  const bill = computeBill(consumption, type);
  document.getElementById('prev-consumption').textContent = consumption + ' m³';
  document.getElementById('prev-basic').textContent       = '₱' + fmt(bill.basicAmt);
  document.getElementById('prev-env').textContent         = '₱' + fmt(bill.envFee);
  document.getElementById('prev-total').textContent       = '₱' + fmt(bill.total);
  document.getElementById('rp-preview').style.display     = 'block';
}

// ── SAVE READING ──────────────────────────────────────────────────
function rpSaveReading() {
  if (!rpSelectedAcct) { showStatus('Pumili muna ng account.', 'error', 3000); return; }

  const month   = document.getElementById('rp-month').value.trim();
  const date    = document.getElementById('rp-date').value;
  const type    = rpSelectedAcct ? (rpSelectedAcct.acctType || 'R') : 'R';
  const prev    = parseFloat(document.getElementById('rp-prev').value);
  const present = parseFloat(document.getElementById('rp-present').value);

  if (!month)               { showStatus('Ilagay ang buwan (e.g. Jun 2025).', 'error', 3000); return; }
  if (!date)                { showStatus('Piliin ang petsa ng reading.', 'error', 3000); return; }
  if (isNaN(prev))          { showStatus('Ilagay ang previous reading.', 'error', 3000); return; }
  if (isNaN(present))       { showStatus('Ilagay ang present reading.', 'error', 3000); return; }
  if (present < prev)       { showStatus('Present reading ay hindi pwedeng mas mababa sa previous reading.', 'error', 4000); return; }

  const consumption = Math.max(0, present - prev);
  const bill        = computeBill(consumption, type);
  const ts          = formatDate(new Date());
  const acct        = rpSelectedAcct;
  const tempId      = 'rdg_' + Date.now();

  // ── 1. Save to READINGS_LIST ───────────────────────────────────
  const entry = {
    readingId:      tempId,
    accountNumber:  acct.accountNumber,
    accountName:    acct.accountName,
    month,
    date,
    prevReading:    prev,
    presentReading: present,
    consumption,
    type,
    timestamp:      ts
  };
  READINGS_LIST.push(entry);
  saveReadingsLocal();

  // ── 2. Inject into in-memory account data so UI updates NOW ───
  rpInjectReadingIntoAccount(acct, entry, bill);

  // ── 3. Update UI ───────────────────────────────────────────────
  rpRenderHistory(acct.accountNumber);
  doSearch();
  if (currentAcctNum === acct.accountNumber) renderModalTable();

  // Update selected acct strip with new last reading
  document.getElementById('rp-last-reading').innerHTML =
    `Last recorded reading: <span>${present} m³</span> &nbsp;·&nbsp; Month: <span>${month}</span> &nbsp;·&nbsp; Date: <span>${date}</span>`;

  // Advance to next month using dropdowns
  rpSetMonthDropdowns(rpNextMonthLabel(month));
  document.getElementById('rp-prev').value    = present;
  document.getElementById('rp-present').value = '';
  document.getElementById('rp-consumption').value = '';
  document.getElementById('rp-preview').style.display = 'none';

  showStatus('Reading saved! Consumption: ' + consumption + ' m³ · Bill: ₱' + fmt(bill.total), 'success', 5000);

  // Close reading modal, go back to main account modal
  document.getElementById('reading-modal-overlay').style.display = 'none';
  // Main modal is still open; re-render its table
  if (currentAcctNum) renderModalTable();
  document.body.style.overflow = 'hidden'; // keep main modal scroll locked

  // ── 4. Sync to Google Sheet in background ─────────────────────
  const url = getScriptUrl();
  if (url && navigator.onLine) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'saveReading', ...entry })
    })
    .then(r => r.json())
    .then(res => {
      if (res.readingId) {
        const idx = READINGS_LIST.findIndex(r => r.readingId === tempId);
        if (idx !== -1) READINGS_LIST[idx].readingId = res.readingId;
        saveReadingsLocal();
      }
    })
    .catch(() => showStatus('Reading saved locally. Mag-o-online sync mamaya.', 'warning', 4000));
  } else {
    showStatus('Saved locally — mag-i-sync kapag online na.', 'warning', 4000);
  }
}

// Inject a new reading entry into the in-memory account so the modal & search update immediately
function rpInjectReadingIntoAccount(acct, entry, bill) {
  // Remove existing month entry for same month (avoid duplicate)
  acct.months = acct.months.filter(m => m.month !== entry.month);

  const newMonth = {
    month:       entry.month,
    date:        entry.date,
    reading:     entry.presentReading,
    type:        entry.type,
    installment: null,
    consumption: entry.consumption,
    basicAmt:    bill.basicAmt,
    envFee:      bill.envFee,
    total:       bill.total
  };

  // months are stored newest-first; insert at front
  acct.months.unshift(newMonth);
  saveLocal();
}

// ── DELETE READING ────────────────────────────────────────────────
function rpDeleteReading(readingId) {
  if (!confirm('Burahin ang reading na ito?')) return;

  const idx = READINGS_LIST.findIndex(r => r.readingId === readingId);
  if (idx === -1) return;
  const entry = READINGS_LIST[idx];
  READINGS_LIST.splice(idx, 1);
  saveReadingsLocal();

  // Remove from in-memory account too
  const acct = accountMap[entry.accountNumber];
  if (acct) {
    acct.months = acct.months.filter(m => m.month !== entry.month);
    saveLocal();
  }

  if (rpSelectedAcct) rpRenderHistory(rpSelectedAcct.accountNumber);
  doSearch();
  if (currentAcctNum === entry.accountNumber) renderModalTable();
  showStatus('Reading removed.', 'info', 3000);

  const url = getScriptUrl();
  if (url && navigator.onLine && !String(readingId).startsWith('rdg_temp')) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deleteReading', readingId })
    }).catch(() => {});
  }
}

// ── HISTORY LIST ──────────────────────────────────────────────────
function rpRenderHistory(acctNum) {
  const entries = READINGS_LIST.filter(r => String(r.accountNumber) === String(acctNum));
  const histDiv = document.getElementById('rp-history');
  const listDiv = document.getElementById('rp-history-list');

  if (!entries.length) {
    histDiv.style.display = 'none';
    return;
  }

  histDiv.style.display = 'block';
  listDiv.innerHTML = [...entries].reverse().map(r => {
    const bill = computeBill(r.consumption, r.type);
    return `<div class="rdg-hist-item">
      <div>
        <div class="rdg-hist-main">${escHtml(r.month)} — ${r.prevReading} → ${r.presentReading} m³ &nbsp;(${r.consumption} m³ consumed)</div>
        <div class="rdg-hist-sub">Date: ${r.date} &nbsp;·&nbsp; Type: ${r.type} &nbsp;·&nbsp; Saved: ${r.timestamp}</div>
      </div>
      <div style="text-align:right">
        <div class="rdg-hist-bill">₱${fmt(bill.total)}</div>
        <button class="btn-del-rdg" onclick="rpDeleteReading('${r.readingId}')">✕ Remove</button>
      </div>
    </div>`;
  }).join('');
}

// ── SYNC READINGS FROM SERVER ─────────────────────────────────────
// Called inside doSync — merge server readings into local list
function mergeServerReadings(serverReadings) {
  if (!serverReadings || !serverReadings.length) return;
  const localIds = new Set(READINGS_LIST.map(r => r.readingId));
  let added = 0;
  for (const r of serverReadings) {
    if (!localIds.has(r.readingId)) {
      READINGS_LIST.push(r);
      // Also inject into in-memory account
      const acct = accountMap[r.accountNumber];
      if (acct) {
        const bill = computeBill(r.consumption, r.type);
        rpInjectReadingIntoAccount(acct, r, bill);
      }
      added++;
    }
  }
  if (added > 0) saveReadingsLocal();
}
