(() => {
  'use strict';
  const STORE_KEY = 'ajerbi-invoices-v1';
  const DEFAULTS = { nextNumber: 16, taxRate: 19, stamp: 1 };
  let state = readState();
  let toastTimer;
  let editingInvoiceId = null;
  let cloudClient = null;
  let cloudUser = null;
  let cloudChannel = null;
  const cloudConfig = window.APP_CONFIG || {};
  const cloudConfigured = Boolean(cloudConfig.supabaseUrl && cloudConfig.supabasePublishableKey);
  const signatureAllowed = cloudConfig.allowSignature !== false;
  if (state.invoices.length === 0) state.settings.nextNumber = 16;
  const $ = (id) => document.getElementById(id);
  const money = (n) => `${Number(n || 0).toLocaleString('fr-TN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} DT`;
  const today = () => new Date().toLocaleDateString('fr-TN', { day: '2-digit', month: 'long', year: 'numeric' });
  const isoToday = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };

  const underHundred = (n) => {
    const ones = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
    const teens = ['dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
    const tens = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];
    if (n < 10) return ones[n];
    if (n < 20) return teens[n - 10];
    if (n < 70) { const d = Math.floor(n / 10), u = n % 10; return `${tens[d]}${u === 1 ? ' et un' : u ? `-${ones[u]}` : ''}`; }
    if (n < 80) return `soixante${n === 71 ? ' et onze' : `-${underHundred(n - 60)}`}`;
    if (n < 100) return `quatre-vingt${n === 80 ? 's' : `-${underHundred(n - 80)}`}`;
    return '';
  };
  function numberWords(n) {
    if (!Number.isFinite(n) || n < 0 || n > 999999999) return String(n);
    if (n === 0) return 'zéro';
    const parts = [];
    const group = (value, scale) => {
      if (!value) return;
      const hundreds = Math.floor(value / 100), rest = value % 100;
      let text = '';
      if (hundreds) text += `${hundreds === 1 ? 'cent' : `${underHundred(hundreds)} cent${rest === 0 ? 's' : ''}`}`;
      if (rest) text += `${text ? ' ' : ''}${underHundred(rest)}`;
      if (scale === 'mille') parts.push(`${value === 1 ? '' : `${text} `}mille`);
      else if (scale === 'million') parts.push(`${text} million${value > 1 ? 's' : ''}`);
      else parts.push(text);
    };
    const millions = Math.floor(n / 1000000), thousands = Math.floor((n % 1000000) / 1000), rest = n % 1000;
    group(millions, 'million'); group(thousands, 'mille'); group(rest, '');
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  function amountInWords(amount) {
    const millimes = Math.round(Number(amount) * 1000);
    const dinars = Math.floor(millimes / 1000), remainder = millimes % 1000;
    const dinarText = `${numberWords(dinars)} ${dinars === 1 ? 'dinar' : 'dinars'}`;
    return `${dinarText}${remainder ? ` et ${numberWords(remainder)} ${remainder === 1 ? 'millime' : 'millimes'}` : ''}`;
  }

  function readState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return { settings: { ...DEFAULTS, ...(parsed.settings || {}) }, invoices: Array.isArray(parsed.invoices) ? parsed.invoices : [] };
    } catch { return { settings: { ...DEFAULTS }, invoices: [] }; }
  }
  function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); updateCounts(); }
  function updateCounts() { $('history-count').textContent = String(state.invoices.length); }
  function notify(message) {
    const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }
  function syncStatus(label, detail, connected = false) {
    $('sync-label').textContent = label; $('sync-detail').textContent = detail;
    $('sync-dot').style.background = connected ? '#68bb83' : '#c49a55';
    $('logout-button').classList.toggle('hidden', !cloudUser);
  }
  function showLogin(message = '') {
    $('auth-gate').classList.remove('hidden'); document.querySelector('.app-shell').classList.add('hidden');
    $('auth-message').textContent = message;
  }
  function showApplication() {
    $('auth-gate').classList.add('hidden'); document.querySelector('.app-shell').classList.remove('hidden');
  }
  async function cloudLoadSnapshot() {
    const [invoicesResult, settingsResult] = await Promise.all([
      cloudClient.from('invoices').select('data').order('number', { ascending: false }),
      cloudClient.from('app_settings').select('data').eq('id', 1).single()
    ]);
    if (invoicesResult.error) throw invoicesResult.error;
    if (settingsResult.error) throw settingsResult.error;
    const remoteInvoices = invoicesResult.data.map((row) => row.data);
    const local = readState();
    if (!remoteInvoices.length && local.invoices.length) {
      if (window.confirm(`Importer ${local.invoices.length} facture(s) enregistrée(s) sur cet appareil dans l’espace partagé ?`)) {
        const nextNumber = Math.max(Number(settingsResult.data.data.nextNumber || 16), ...local.invoices.map((item) => Number(item.number) + 1));
        const imported = await cloudClient.from('invoices').upsert(local.invoices.map((item) => ({ id: item.id, number: item.number, data: item })));
        if (imported.error) throw imported.error;
        const settings = await cloudClient.from('app_settings').update({ data: { ...settingsResult.data.data, nextNumber } }).eq('id', 1);
        if (settings.error) throw settings.error;
        return cloudLoadSnapshot();
      }
    }
    state = { settings: { ...DEFAULTS, ...settingsResult.data.data }, invoices: remoteInvoices };
    saveState(); updateTotals();
    if (!$('view-history').classList.contains('hidden')) renderHistory();
  }
  async function activateCloud(user) {
    cloudUser = user;
    try {
      const { data: membership, error: memberError } = await cloudClient.from('app_members').select('user_id').eq('user_id', user.id).maybeSingle();
      if (memberError || !membership) {
        await cloudClient.auth.signOut(); cloudUser = null;
        showLogin('Ce compte n’a pas encore été autorisé pour cet espace. Demandez à son propriétaire de l’ajouter.'); return;
      }
      await cloudLoadSnapshot(); showApplication();
      syncStatus('Synchronisation active', 'Factures partagées en direct', true);
      if (cloudChannel) await cloudClient.removeChannel(cloudChannel);
      cloudChannel = cloudClient.channel('shared-invoice-workspace')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, (event) => {
          const id = event.eventType === 'DELETE' ? event.old.id : event.new.id;
          state.invoices = state.invoices.filter((item) => item.id !== id);
          if (event.eventType !== 'DELETE') state.invoices.unshift(event.new.data);
          saveState(); updateTotals(); if (!$('view-history').classList.contains('hidden')) renderHistory();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_settings' }, (event) => {
          state.settings = { ...DEFAULTS, ...event.new.data }; saveState(); updateTotals();
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') syncStatus('Synchronisation active', 'Factures partagées en direct', true);
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') syncStatus('Reconnexion en cours', 'Vérifiez votre connexion Internet', false);
        });
    } catch (error) {
      cloudUser = null; showLogin(`Connexion impossible : ${error.message || 'vérifiez la configuration Supabase.'}`);
    }
  }
  async function initializeCloud() {
    if (!cloudConfigured) { syncStatus('Mode local', 'Non synchronisé avec d’autres appareils'); return; }
    if (!window.supabase?.createClient) { showLogin('Le service de connexion ne s’est pas chargé. Vérifiez la connexion Internet puis rechargez la page.'); return; }
    cloudClient = window.supabase.createClient(cloudConfig.supabaseUrl, cloudConfig.supabasePublishableKey);
    showLogin();
    $('login-form').addEventListener('submit', async (event) => {
      event.preventDefault(); $('login-button').disabled = true; $('auth-message').textContent = 'Connexion…';
      const { data, error } = await cloudClient.auth.signInWithPassword({ email: $('login-email').value.trim(), password: $('login-password').value });
      $('login-button').disabled = false;
      if (error) { $('auth-message').textContent = 'Connexion refusée. Vérifiez l’adresse e-mail et le mot de passe.'; return; }
      await activateCloud(data.user);
    });
    $('logout-button').addEventListener('click', async () => { await cloudClient.auth.signOut(); cloudUser = null; if (cloudChannel) await cloudClient.removeChannel(cloudChannel); showLogin(); });
    const { data: sessionData } = await cloudClient.auth.getSession();
    if (sessionData.session) await activateCloud(sessionData.session.user);
    cloudClient.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { cloudUser = null; showLogin(); }
    });
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function showView(name) {
    document.querySelectorAll('.view').forEach((view) => view.classList.toggle('hidden', view.id !== `view-${name}`));
    document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
    $('page-title').textContent = name === 'new' ? 'Créer une facture' : name === 'history' ? 'Historique des factures' : 'Paramètres';
    if (name === 'history') renderHistory();
    if (name === 'settings') loadSettings();
  }
  function createLine(description = '', quantity = 1, price = '') {
    const row = document.createElement('div'); row.className = 'item-row';
    row.innerHTML = `<input class="description" aria-label="Désignation" placeholder="Prestation ou service" value="${escapeHtml(description)}"><input class="quantity" aria-label="Quantité" type="number" min="0" step="0.01" value="${quantity}"><input class="price" aria-label="Prix unitaire HT" type="number" min="0" step="0.001" placeholder="0,000" value="${price}"><span class="line-total">0,000</span><button type="button" class="remove-line" aria-label="Supprimer la ligne">×</button>`;
    row.querySelectorAll('input').forEach((input) => input.addEventListener('input', updateTotals));
    row.querySelector('.remove-line').addEventListener('click', () => { if ($$('item-row').length > 1) row.remove(); updateTotals(); });
    $('items-list').appendChild(row); updateTotals();
  }
  function $$(selector) { return [...document.querySelectorAll(selector)]; }
  function getLines() {
    return $$('.item-row').map((row) => ({
      description: row.querySelector('.description').value.trim(),
      quantity: Math.max(0, Number(row.querySelector('.quantity').value || 0)),
      unitPrice: Math.max(0, Number(row.querySelector('.price').value || 0))
    })).filter((line) => line.description || line.unitPrice > 0);
  }
  function totals(lines = getLines()) {
    const ht = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
    const tax = ht * Number(state.settings.taxRate) / 100;
    const stamp = Number(state.settings.stamp);
    return { ht, tax, stamp, ttc: ht + tax + stamp };
  }
  function updateTotals() {
    $$('.item-row').forEach((row) => {
      const quantity = Math.max(0, Number(row.querySelector('.quantity').value || 0));
      const price = Math.max(0, Number(row.querySelector('.price').value || 0));
      row.querySelector('.line-total').textContent = money(quantity * price).replace(' DT', '');
    });
    const t = totals();
    $('sum-ht').textContent = money(t.ht); $('sum-tax').textContent = money(t.tax);
    $('sum-stamp').textContent = money(t.stamp); $('sum-ttc').innerHTML = `${money(t.ttc).replace(' DT', '')} <small>DT</small>`;
    $('sum-tax-rate').textContent = state.settings.taxRate;
    $('tax-rate-note').textContent = `${state.settings.taxRate} %`; $('stamp-note').textContent = money(state.settings.stamp);
    $('summary-client').textContent = $('client-name').value.trim() || 'Nom du client';
    $('next-number-label').textContent = String(state.settings.nextNumber);
  }
  function resetForm() {
    $('client-name').value = ''; $('client-address').value = ''; $('client-id').value = '';
    $('items-list').innerHTML = ''; $('include-signature').checked = false; editingInvoiceId = null;
    $('generate-invoice').innerHTML = 'Générer la facture <span>→</span>';
    $('items-list').innerHTML = ''; createLine('', 1, ''); $('client-name').focus();
  }
  async function createInvoice() {
    const client = $('client-name').value.trim();
    const lines = getLines();
    if (!client) { $('client-name').focus(); notify('Veuillez saisir le nom du client.'); return; }
    if (!lines.length || lines.some((line) => !line.description || line.quantity <= 0 || line.unitPrice <= 0)) {
      notify('Complétez la désignation, la quantité et le prix de chaque ligne.'); return;
    }
    const oldInvoice = editingInvoiceId ? state.invoices.find((entry) => entry.id === editingInvoiceId) : null;
    let invoice = {
      id: oldInvoice?.id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
      number: oldInvoice?.number ?? Number(state.settings.nextNumber), date: oldInvoice?.date ?? isoToday(), client,
      address: $('client-address').value.trim(), clientId: $('client-id').value.trim(),
      lines, taxRate: Number(state.settings.taxRate), stamp: Number(state.settings.stamp),
      totals: totals(lines), includeSignature: signatureAllowed && $('include-signature').checked
    };
    if (cloudClient && cloudUser) {
      $('generate-invoice').disabled = true;
      try {
        if (oldInvoice) {
          const { error } = await cloudClient.from('invoices').upsert({ id: invoice.id, number: invoice.number, data: invoice, updated_at: new Date().toISOString() });
          if (error) throw error;
        } else {
          const { data, error } = await cloudClient.rpc('create_invoice', { invoice_payload: invoice });
          if (error) throw error;
          invoice = data;
          const { data: settingsRow, error: settingsError } = await cloudClient.from('app_settings').select('data').eq('id', 1).single();
          if (settingsError) throw settingsError;
          state.settings = { ...DEFAULTS, ...settingsRow.data };
        }
      } catch (error) {
        notify(`La facture n’a pas été synchronisée : ${error.message || 'erreur de connexion.'}`); return;
      } finally { $('generate-invoice').disabled = false; }
    }
    if (oldInvoice) state.invoices = state.invoices.map((entry) => entry.id === invoice.id ? invoice : entry);
    else { state.invoices.unshift(invoice); state.settings.nextNumber += 1; }
    editingInvoiceId = null; $('generate-invoice').innerHTML = 'Générer la facture <span>→</span>';
    saveState(); updateTotals();
    buildPrintDocument(invoice);
    if (invoice.includeSignature) await $('print-root').querySelector('img')?.decode().catch(() => {});
    window.print();
    notify(oldInvoice ? `Facture n° ${invoice.number} mise à jour.` : `Facture n° ${invoice.number} enregistrée dans cet appareil.`);
  }
  function buildPrintDocument(invoice) {
    const t = invoice.totals;
    const rows = invoice.lines.map((line) => `<tr><td>${escapeHtml(line.description)}</td><td>${line.quantity.toLocaleString('fr-TN')}</td><td>${money(line.unitPrice)}</td><td>${money(line.quantity * line.unitPrice)}</td></tr>`).join('');
    $('print-root').innerHTML = `<article class="print-invoice"><div class="print-top"><div class="print-company"><h1>A JERBI SERVICES</h1><p>IU : 1922720N</p><p>53 Rue Salah Ben Youssef, Sidi Daoued, La Marsa</p></div><div class="print-customer"><b>Client : ${escapeHtml(invoice.client)}</b>${invoice.address ? `<p>${escapeHtml(invoice.address)}</p>` : ''}${invoice.clientId ? `<p>IU : ${escapeHtml(invoice.clientId)}</p>` : ''}</div></div><div class="print-title"><div><h2>Facture</h2><p>Document établi le ${new Date(`${invoice.date}T12:00:00`).toLocaleDateString('fr-TN', { day: '2-digit', month: 'long', year: 'numeric' })}</p></div><div><b>N° ${invoice.number}</b></div></div><table><thead><tr><th>Désignation</th><th>Quantité</th><th>Prix unitaire HT</th><th>Total HT</th></tr></thead><tbody>${rows}</tbody></table><div class="print-totals"><div><span>Total HT brut</span><b>${money(t.ht)}</b></div><div><span>Total HT net</span><b>${money(t.ht)}</b></div><div><span>TVA (${invoice.taxRate} %)</span><b>${money(t.tax)}</b></div><div><span>Timbre fiscal</span><b>${money(t.stamp)}</b></div><div class="total"><span>Total TTC</span><b>${money(t.ttc)}</b></div></div><div class="print-amount-words">Arrêtée la présente facture à la somme TTC de : <b>${escapeHtml(amountInWords(t.ttc))}</b>.</div>${invoice.includeSignature ? '<div class="print-footer"><img src="signature-cachet.png" alt="Cachet et signature de A Jerbi Services"><span>Signature et cachet</span></div>' : ''}</article>`;
  }
  function renderHistory() {
    const query = $('history-search').value.trim().toLocaleLowerCase('fr');
    const entries = state.invoices.filter((item) => `${item.number} ${item.client}`.toLocaleLowerCase('fr').includes(query));
    $('history-total').textContent = `${entries.length} facture${entries.length === 1 ? '' : 's'}`;
    if (!entries.length) { $('history-list').innerHTML = `<div class="empty-state"><b>${query ? 'Aucun résultat' : 'Aucune facture pour le moment'}</b>${query ? 'Essayez un autre numéro ou nom de client.' : 'Vos factures générées apparaîtront ici.'}</div>`; return; }
    $('history-list').innerHTML = entries.map((item) => `<div class="history-entry"><strong>Facture n° ${item.number}</strong><span class="client">${escapeHtml(item.client)}</span><span class="date">${new Date(`${item.date}T12:00:00`).toLocaleDateString('fr-TN')}</span><span class="amount">${money(item.totals.ttc)}</span><div class="history-actions"><button class="small-action" data-edit="${escapeHtml(item.id)}">Modifier</button><button class="small-action" data-print="${escapeHtml(item.id)}">PDF / Imprimer</button><button class="small-action" data-delete="${escapeHtml(item.id)}" aria-label="Supprimer">×</button></div></div>`).join('');
    $('history-list').querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => {
      const item = state.invoices.find((entry) => entry.id === button.dataset.edit); if (!item) return;
      editingInvoiceId = item.id; $('client-name').value = item.client; $('client-address').value = item.address || ''; $('client-id').value = item.clientId || '';
      $('include-signature').checked = Boolean(item.includeSignature); $('items-list').innerHTML = '';
      item.lines.forEach((line) => createLine(line.description, line.quantity, line.unitPrice));
      $('generate-invoice').textContent = 'Enregistrer les modifications'; updateTotals(); showView('new'); $('client-name').focus();
    }));
    $('history-list').querySelectorAll('[data-print]').forEach((button) => button.addEventListener('click', async () => { const inv = state.invoices.find((entry) => entry.id === button.dataset.print); if (inv) { buildPrintDocument(inv); if (inv.includeSignature) await $('print-root').querySelector('img')?.decode().catch(() => {}); window.print(); } }));
    $('history-list').querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
      if (!window.confirm('Supprimer définitivement cette facture de l’espace partagé ?')) return;
      if (cloudClient && cloudUser) {
        const { error } = await cloudClient.from('invoices').delete().eq('id', button.dataset.delete);
        if (error) { notify(`Suppression impossible : ${error.message}`); return; }
      }
      state.invoices = state.invoices.filter((entry) => entry.id !== button.dataset.delete); saveState(); renderHistory(); notify('Facture supprimée.');
    }));
  }
  function loadSettings() {
    $('setting-number').value = state.settings.nextNumber; $('setting-tax').value = state.settings.taxRate; $('setting-stamp').value = state.settings.stamp;
  }
  async function saveSettings() {
    const number = Number($('setting-number').value), tax = Number($('setting-tax').value), stamp = Number($('setting-stamp').value);
    if (!Number.isInteger(number) || number < 1 || !Number.isFinite(tax) || tax < 0 || tax > 100 || !Number.isFinite(stamp) || stamp < 0) { notify('Vérifiez les valeurs des paramètres.'); return; }
    const highestIssued = Math.max(15, ...state.invoices.map((item) => Number(item.number) || 0));
    if (number <= highestIssued) { notify(`Le prochain numéro doit être supérieur au dernier numéro utilisé (${highestIssued}).`); return; }
    state.settings = { nextNumber: number, taxRate: tax, stamp };
    if (cloudClient && cloudUser) {
      const { error } = await cloudClient.from('app_settings').update({ data: state.settings }).eq('id', 1);
      if (error) { notify(`Paramètres non synchronisés : ${error.message}`); return; }
    }
    saveState(); updateTotals(); notify('Paramètres enregistrés.');
  }
  function exportData() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `sauvegarde-factures-${isoToday()}.json`; link.click(); URL.revokeObjectURL(url);
  }

  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
  $('today-pill').textContent = new Date().toLocaleDateString('fr-TN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  $('add-line').addEventListener('click', () => createLine());
  $('generate-invoice').addEventListener('click', createInvoice);
  $('reset-form').addEventListener('click', resetForm);
  $('client-name').addEventListener('input', updateTotals);
  $('history-new').addEventListener('click', () => showView('new'));
  $('history-search').addEventListener('input', renderHistory);
  $('save-settings').addEventListener('click', saveSettings);
  $('export-data').addEventListener('click', exportData);
  if (!signatureAllowed) $('include-signature').closest('.signature-option').classList.add('hidden');
  createLine(''); updateCounts(); updateTotals();
  initializeCloud();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
