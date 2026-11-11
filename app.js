/* Presenze FIRE - web app di scansione (versione 2).
 *
 * Principi:
 *  - ogni scansione viene SALVATA SUL TELEFONO (IndexedDB) prima del
 *    segnale di esito; l'invio al foglio Google avviene dopo, quando c'e'
 *    rete, in lotti, con un ID univoco per scansione (niente doppioni);
 *  - la verifica "in elenco" usa l'elenco scaricato: funziona senza rete;
 *  - nessuna scansione viene cancellata: "Annulla ultima" aggiunge una
 *    scansione di tipo "annulla" che fa riferimento a quella annullata.
 */
'use strict';

const VERSIONE_APP = '2.0.0';
const SCARTO_OROLOGIO_MAX_MS = 2 * 60000;
const CHIAVI = { cfg: 'pf_cfg', dati: 'pf_dati', evento: 'pf_evento' };
const COLORI_EVENTI = ['#1b5e3b', '#1565c0', '#6a1b9a', '#00838f', '#ad1457', '#5d4037', '#283593', '#2e7d32'];
const INTERVALLO_INVIO_MS = 30000;
const INTERVALLO_ELENCO_MS = 5 * 60000;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
//  Memoria locale
// ---------------------------------------------------------------------

function leggiLS(chiave, predefinito) {
  try { const v = localStorage.getItem(chiave); return v ? JSON.parse(v) : predefinito; }
  catch (e) { return predefinito; }
}
function scriviLS(chiave, valore) {
  try { localStorage.setItem(chiave, JSON.stringify(valore)); return true; }
  catch (e) { return false; }
}

const DB = {
  db: null,
  apri() {
    return new Promise((ok, ko) => {
      const r = indexedDB.open('presenze-fire', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('scansioni', { keyPath: 'id' });
        s.createIndex('t', 't');
      };
      r.onsuccess = () => { this.db = r.result; ok(); };
      r.onerror = () => ko(r.error);
    });
  },
  _scrivi(fn) {
    return new Promise((ok, ko) => {
      let tx;
      try { tx = this.db.transaction('scansioni', 'readwrite', { durability: 'strict' }); }
      catch (e) { tx = this.db.transaction('scansioni', 'readwrite'); }
      fn(tx.objectStore('scansioni'));
      tx.oncomplete = () => ok();
      tx.onerror = () => ko(tx.error);
      tx.onabort = () => ko(tx.error || new Error('scrittura annullata'));
    });
  },
  aggiungi(rec) { return this._scrivi((s) => s.put(rec)); },
  aggiorna(lista) { return this._scrivi((s) => lista.forEach((r) => s.put(r))); },
  svuota() { return this._scrivi((s) => s.clear()); },
  tutte() {
    return new Promise((ok, ko) => {
      const r = this.db.transaction('scansioni', 'readonly').objectStore('scansioni').getAll();
      r.onsuccess = () => ok(r.result.sort((a, b) => a.t - b.t));
      r.onerror = () => ko(r.error);
    });
  }
};

// ---------------------------------------------------------------------
//  Stato
// ---------------------------------------------------------------------

let cfg = leggiLS(CHIAVI.cfg, {});            // { u: url script, k: chiave, dispositivo }
let dati = leggiLS(CHIAVI.dati, { elenco: [], eventi: [], impostazioni: {} });
let elenco = new Map();                         // numero -> { c, no }
let scansioni = [];                             // tutte le scansioni del telefono
let codiceEvento = leggiLS(CHIAVI.evento, '');
let attivo = false, occupato = false, inInvio = false;
let ultimoTesto = '', ultimoVisto = 0;
let ultimoInvio = 0, erroreInvio = '', erroreDati = '';
let scartoOrologio = 0;
let audio = null, rilevatore = null, wakeLock = null;
let timerInvio = null, timerAvviso = null;

// ---------------------------------------------------------------------
//  Utilita'
// ---------------------------------------------------------------------

function nuovoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const pad = (n) => String(n).padStart(3, '0');
const oraBreve = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dataOra = (t) => new Date(t).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const stessoGiorno = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** Interpreta il testo del QR: "001|Nome|Cognome", "001|Nome Cognome", "001", "SIGLA|001|...". */
function analizza(testo) {
  const parti = String(testo).split('|').map((x) => x.replace(/[\s\u00a0]+/g, ' ').trim());
  if (parti.length > 1 && /^[A-Za-z]{2,10}$/.test(parti[0]) && /^\d+$/.test(parti[1])) parti.shift();
  if (!/^\d{1,9}$/.test(parti[0])) return null;
  const n = String(parseInt(parti[0], 10));
  if (parti.length >= 3) return { n, nome: parti[1], cognome: parti.slice(2).join(' ') };
  if (parti.length === 2) return { n, nome: parti[1], cognome: '' };      // nominativo tutto insieme
  return { n, nome: '', cognome: '' };
}
const nominativoQR = (a) => [a.cognome, a.nome].filter(Boolean).join(' ');

function normNome(s) {
  return String(s || '').toLowerCase().replace(/[ \s]+/g, ' ').trim().split(' ').sort().join(' ');
}

function costruisciElenco() {
  elenco = new Map();
  (dati.elenco || []).forEach((p) => elenco.set(String(p.n), { c: p.c || '', no: p.no || '' }));
}
function eventoCorrente() {
  return (dati.eventi || []).find((e) => e.codice === codiceEvento) || null;
}
function etichettaEvento(codice) {
  if (codice === 'annulla') return 'Annullamento';
  const e = (dati.eventi || []).find((x) => x.codice === codice);
  return e ? e.etichetta : codice;
}
function nomeDi(s) {
  const p = elenco.get(s.n);
  if (p) return `${p.c} ${p.no}`.trim() || 'riserva';
  return s.nome || 'non in elenco';
}
const daInviare = () => scansioni.filter((s) => !s.inviata);

// ---------------------------------------------------------------------
//  Segnali: suono e vibrazione
// ---------------------------------------------------------------------

const SUONI = {
  letto: [[1400, 60]],
  trovato: [[880, 110], [1320, 170]],
  gia: [[880, 100], [660, 100], [880, 170]],
  nonInElenco: [[330, 480]],
  riserva: [[660, 120], [990, 120], [660, 160]],
  errore: [[220, 250], [170, 380]]
};
const VIBRAZIONI = { letto: 40, trovato: [90, 70, 90], gia: [90, 60, 90, 60, 90], nonInElenco: 450, riserva: [60, 60, 60, 60, 200], errore: [300, 120, 300] };

function suona(nome) {
  if (!audio) return;
  let t = audio.currentTime + 0.01;
  for (const [f, d] of SUONI[nome]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d / 1000);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + d / 1000 + 0.02);
    t += d / 1000 + 0.045;
  }
}
function vibra(nome) {
  if (navigator.vibrate) { try { navigator.vibrate(VIBRAZIONI[nome]); } catch (e) { /* niente */ } }
}
function segnale(nome, ritardo) {
  setTimeout(() => { suona(nome); vibra(nome); }, ritardo || 0);
}

// ---------------------------------------------------------------------
//  Interfaccia
// ---------------------------------------------------------------------

function mostraEsito(classe, titolo, dettaglio, nota) {
  const el = $('esito');
  el.className = 'esito ' + (classe || '');
  $('esitoTitolo').textContent = titolo;
  $('esitoDettaglio').textContent = dettaglio || '';
  $('esitoNota').textContent = nota || '';
}

function avviso(testo, ms) {
  const el = $('avviso');
  el.textContent = testo;
  el.classList.remove('nascosto');
  clearTimeout(timerAvviso);
  timerAvviso = setTimeout(() => el.classList.add('nascosto'), ms || 3500);
}

function dialogo(testo, conInput, valore) {
  return new Promise((risolvi) => {
    $('dialogoTesto').textContent = testo;
    const inp = $('dialogoInput');
    inp.classList.toggle('nascosto', !conInput);
    inp.value = valore || '';
    $('dialogo').classList.remove('nascosto');
    if (conInput) setTimeout(() => inp.focus(), 50);
    const chiudi = (r) => {
      $('dialogo').classList.add('nascosto');
      $('dialogoSi').onclick = $('dialogoNo').onclick = null;
      risolvi(r);
    };
    $('dialogoSi').onclick = () => chiudi(conInput ? inp.value.trim() : true);
    $('dialogoNo').onclick = () => chiudi(conInput ? null : false);
  });
}
const finestraAperta = () =>
  !$('dialogo').classList.contains('nascosto') || !$('pannello').classList.contains('nascosto');

function disegnaEventi() {
  const nav = $('eventi');
  nav.innerHTML = '';
  const eventi = dati.eventi || [];
  if (!eventi.length) {
    const d = document.createElement('div');
    d.className = 'vuoto';
    d.textContent = cfg.u ? 'Nessun evento: aggiorna l\'elenco dalle impostazioni.'
                          : 'Telefono non collegato: tocca "Tocca per iniziare" e inquadra il QR di configurazione.';
    nav.appendChild(d);
    return;
  }
  eventi.forEach((e, i) => {
    const b = document.createElement('button');
    b.textContent = e.etichetta;
    b.style.setProperty('--c', COLORI_EVENTI[i % COLORI_EVENTI.length]);
    if (e.codice === codiceEvento) b.classList.add('scelto');
    b.onclick = () => {
      codiceEvento = e.codice;
      scriviLS(CHIAVI.evento, codiceEvento);
      ultimoTesto = '';
      disegnaEventi();
      mostraEsito('', 'Evento: ' + e.etichetta, 'Inquadra un QR.');
    };
    nav.appendChild(b);
  });
}

function aggiornaStato() {
  const n = daInviare().length;
  const rete = navigator.onLine ? 'in linea' : 'senza rete';
  $('stato').innerHTML = '';
  const r1 = document.createElement('div');
  r1.textContent = `${cfg.dispositivo || 'telefono senza nome'} - ${rete}`;
  const r2 = document.createElement('div');
  r2.textContent = n ? `${n} da inviare` : 'tutto inviato';
  $('stato').append(r1, r2);
  $('btnInvia').textContent = n ? `Invia (${n})` : 'Invia';

  $('infoElenco').textContent = dati.scaricatoIl
    ? `${elenco.size} persone, ${(dati.eventi || []).length} eventi. Aggiornato il ${dataOra(dati.scaricatoIl)}.` +
      (erroreDati ? ` Ultimo tentativo non riuscito: ${erroreDati}` : '')
    : 'Elenco non ancora scaricato.' + (erroreDati ? ` Errore: ${erroreDati}` : '');
  const valide = scansioni.filter((s) => s.ev !== 'annulla');
  $('infoScansioni').textContent =
    `${valide.length} scansioni sul telefono, ${n} da inviare. ` +
    (ultimoInvio ? `Ultimo invio riuscito: ${oraBreve(ultimoInvio)}. ` : '') +
    (erroreInvio ? `Ultimo errore: ${erroreInvio}` : '');
  $('infoServer').textContent = cfg.u ? 'Collegato allo script.' : 'Non collegato: apri il link di configurazione.';
}

function disegnaUltime() {
  const box = $('ultime');
  box.innerHTML = '';
  scansioni.slice(-40).reverse().forEach((s) => {
    const d = document.createElement('div');
    const stato = s.inviata ? 'inviata' : 'da inviare';
    d.textContent = `${oraBreve(s.t)}  ${etichettaEvento(s.ev)}  ${nomeDi(s)} (${pad(s.n)})  - ${stato}`;
    if (s.annullata) d.className = 'annullata';
    box.appendChild(d);
  });
}

function apriPannello() {
  $('inDispositivo').value = cfg.dispositivo || '';
  $('inUrl').value = cfg.u || '';
  $('inChiave').value = cfg.k || '';
  $('versione').textContent = `Versione app ${VERSIONE_APP}. Lettore QR: ${rilevatore ? 'integrato' : 'jsQR'}.`;
  aggiornaStato();
  disegnaUltime();
  $('pannello').classList.remove('nascosto');
}

// ---------------------------------------------------------------------
//  Fotocamera e lettura
// ---------------------------------------------------------------------

async function preparaRilevatore() {
  if (!('BarcodeDetector' in window)) return;
  try {
    const formati = await BarcodeDetector.getSupportedFormats();
    if (formati.includes('qr_code')) rilevatore = new BarcodeDetector({ formats: ['qr_code'] });
  } catch (e) { rilevatore = null; }
}

async function leggiFotogramma() {
  const v = $('video');
  if (!v.videoWidth) return null;
  if (rilevatore) {
    try {
      const codici = await rilevatore.detect(v);
      return codici.length ? codici[0].rawValue : null;
    } catch (e) { rilevatore = null; }       // ripiego su jsQR
  }
  const scala = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.round(v.videoWidth * scala), h = Math.round(v.videoHeight * scala);
  const tela = $('tela');
  tela.width = w; tela.height = h;
  const ctx = tela.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, w, h);
  const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
  return r ? r.data : null;
}

async function ciclo() {
  if (!attivo) return;
  if (!occupato && !document.hidden) {
    occupato = true;
    try {
      const testo = await leggiFotogramma();
      if (testo) await gestisciLettura(testo);
    } catch (e) { console.warn(e); }
    occupato = false;
  }
  setTimeout(ciclo, 110);
}

async function avvia() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') await audio.resume();
  } catch (e) { audio = null; }
  try {
    const flusso = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const v = $('video');
    v.srcObject = flusso;
    await v.play();
  } catch (e) {
    $('avvioMsg').textContent = 'Fotocamera non disponibile: ' + (e.name === 'NotAllowedError'
      ? 'permesso negato. Consentilo nelle impostazioni del browser.' : e.message);
    return;
  }
  $('avvio').classList.add('nascosto');
  attivo = true;
  tieniSchermoAcceso();
  suona('letto');
  ciclo();
}

async function tieniSchermoAcceso() {
  try { if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); }
  catch (e) { /* non disponibile */ }
}

async function gestisciLettura(testo) {
  if (finestraAperta()) return;
  const ora = Date.now();
  const antirimbalzo = (Number(dati.impostazioni && dati.impostazioni.antirimbalzo) || 5) * 1000;
  // Lo stesso QR tenuto davanti alla fotocamera non conta piu' volte.
  if (testo === ultimoTesto && ora - ultimoVisto < antirimbalzo) { ultimoVisto = ora; return; }
  ultimoTesto = testo; ultimoVisto = ora;
  segnale('letto');

  if (/[#&?]cfg=/.test(testo)) { await configuraDaTesto(testo, true); return; }   // QR di configurazione

  const ev = eventoCorrente();
  if (!ev) {
    mostraEsito('rosso', 'Scegli un evento', 'Tocca uno dei pulsanti in alto, poi inquadra di nuovo il QR.');
    segnale('errore', 160);
    return;
  }
  const a = analizza(testo);
  if (!a) {
    mostraEsito('rosso', 'QR non riconosciuto', String(testo).slice(0, 80), 'Non e\' un QR delle tessere: non registrato.');
    segnale('errore', 160);
    return;
  }
  const persona = elenco.get(a.n);
  const precedente = scansioni.filter((s) => s.n === a.n && s.ev === ev.codice && !s.annullata && stessoGiorno(s.t, ora)).pop();
  const rec = {
    id: nuovoId(), t: ora, ev: ev.codice, n: a.n, testo: String(testo).slice(0, 500),
    nome: nominativoQR(a), inElenco: !!persona, rif: '', inviata: 0
  };
  try {
    await DB.aggiungi(rec);
  } catch (e) {
    mostraEsito('rosso', 'SCANSIONE NON SALVATA', 'Errore della memoria del telefono: ' + e, 'Riprova o annota a mano.');
    segnale('errore', 160);
    return;
  }
  scansioni.push(rec);

  const dettaglio = `n. ${pad(a.n)} - ${ev.etichetta} - ${oraBreve(ora)}`;
  const gia = precedente ? `Gia' letto alle ${oraBreve(precedente.t)}: registrata di nuovo. ` : '';
  if (!persona) {
    mostraEsito('arancio', nominativoQR(a) || 'Numero non in elenco', dettaglio, gia + 'Non in elenco: registrata comunque.');
    segnale('nonInElenco', 160);
  } else if (!`${persona.c}${persona.no}`.trim()) {
    mostraEsito('blu', 'Numero di riserva', dettaglio, gia + 'Non ancora assegnato: registrata. Il nominativo si associa nel foglio Elenco.');
    segnale('riserva', 160);
  } else {
    const nome = `${persona.c} ${persona.no}`.trim();
    let nota = '';
    if (nominativoQR(a) && normNome(nominativoQR(a)) !== normNome(nome)) nota = `Nel QR c'e' scritto: ${nominativoQR(a)}`;
    if (precedente) {
      mostraEsito('giallo', nome, dettaglio, gia + nota);
      segnale('gia', 160);
    } else {
      mostraEsito('verde', nome, dettaglio, nota);
      segnale('trovato', 160);
    }
  }
  aggiornaStato();
  programmaInvio(1500);
}

async function annullaUltima() {
  const ultima = [...scansioni].reverse().find((s) => s.ev !== 'annulla' && !s.annullata);
  if (!ultima) { avviso('Nessuna scansione da annullare.'); return; }
  const ok = await dialogo(`Annullare l'ultima scansione?\n\n${nomeDi(ultima)} (n. ${pad(ultima.n)})\n${etichettaEvento(ultima.ev)} alle ${oraBreve(ultima.t)}`);
  if (!ok) return;
  const rec = {
    id: nuovoId(), t: Date.now(), ev: 'annulla', n: ultima.n, testo: '', nome: '',
    inElenco: ultima.inElenco, rif: ultima.id, inviata: 0
  };
  await DB.aggiungi(rec);
  scansioni.push(rec);
  ultima.annullata = true;
  ultimoTesto = '';
  mostraEsito('', 'Scansione annullata', `${nomeDi(ultima)} - ${etichettaEvento(ultima.ev)} - ${oraBreve(ultima.t)}`);
  aggiornaStato();
  programmaInvio(1500);
}

// ---------------------------------------------------------------------
//  Collegamento con il foglio Google
// ---------------------------------------------------------------------

function programmaInvio(ms) {
  clearTimeout(timerInvio);
  timerInvio = setTimeout(invia, ms || 0);
}

async function invia(manuale) {
  if (inInvio || !cfg.u) { if (manuale && !cfg.u) avviso('Telefono non collegato.'); return; }
  const lista = daInviare();
  if (!lista.length) { if (manuale) avviso('Niente da inviare.'); return; }
  if (!navigator.onLine) { if (manuale) avviso('Senza rete: le scansioni restano sul telefono.'); return; }
  inInvio = true;
  try {
    for (let i = 0; i < lista.length; i += 100) {
      const lotto = lista.slice(i, i + 100);
      const risp = await fetch(cfg.u, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // niente richiesta preliminare CORS
        body: JSON.stringify({
          chiave: cfg.k, dispositivo: cfg.dispositivo || '',
          scansioni: lotto.map((s) => ({ id: s.id, t: s.t, ev: s.ev, n: s.n, testo: s.testo, nome: s.nome, inElenco: s.inElenco, rif: s.rif }))
        })
      });
      const j = await risp.json();
      if (!j.ok) throw new Error(j.errore || 'risposta non valida');
      const ricevuti = new Set(j.ricevuti || []);
      const aggiornate = lotto.filter((s) => ricevuti.has(s.id));
      aggiornate.forEach((s) => { s.inviata = 1; });
      await DB.aggiorna(aggiornate);
    }
    ultimoInvio = Date.now();
    erroreInvio = '';
    if (manuale) avviso('Scansioni inviate.');
  } catch (e) {
    erroreInvio = e.message || String(e);
    if (manuale) avviso('Invio non riuscito: ' + erroreInvio + '. Le scansioni restano sul telefono.', 5000);
  } finally {
    inInvio = false;
    aggiornaStato();
    if (!$('pannello').classList.contains('nascosto')) disegnaUltime();
  }
}

async function scaricaDati(manuale) {
  if (!cfg.u) { if (manuale) avviso('Telefono non collegato.'); return; }
  if (!navigator.onLine) { if (manuale) avviso('Senza rete: resta l\'elenco gia\' scaricato.'); return; }
  try {
    const url = cfg.u + (cfg.u.includes('?') ? '&' : '?') + 'azione=dati&chiave=' + encodeURIComponent(cfg.k);
    const t0 = Date.now();
    const j = await (await fetch(url, { cache: 'no-store' })).json();
    const t1 = Date.now();
    if (!j.ok) throw new Error(j.errore || 'risposta non valida');
    if (j.oraServer) { scartoOrologio = (t0 + t1) / 2 - j.oraServer; mostraAllarmeOrologio(); }
    const nuovi = { elenco: j.elenco || [], eventi: j.eventi || [], impostazioni: j.impostazioni || {}, versione: j.versione, scaricatoIl: Date.now() };
    if (!scriviLS(CHIAVI.dati, nuovi)) throw new Error('memoria del telefono piena');
    const prima = elenco.size;
    dati = nuovi;
    erroreDati = '';
    costruisciElenco();
    let eventoTolto = false;
    if (codiceEvento && !eventoCorrente()) {           // l'evento scelto non esiste piu': si sceglie di nuovo
      codiceEvento = '';
      scriviLS(CHIAVI.evento, '');
      eventoTolto = true;
      mostraEsito('rosso', 'Scegli l\'evento', 'L\'evento scelto e\' stato tolto dal foglio: tocca uno degli eventi in alto.');
      segnale('errore');
    }
    disegnaEventi();
    if (manuale || eventoTolto) {
      avviso(`Elenco aggiornato: ${elenco.size} persone` + (prima && elenco.size > prima ? ` (${elenco.size - prima} nuove)` : '') + '.' +
             (eventoTolto ? ' L\'evento scelto non c\'e\' piu\': scegline un altro.' : ''), eventoTolto ? 7000 : 3500);
    }
  } catch (e) {
    erroreDati = e.message || String(e);
    if (manuale) avviso('Elenco non aggiornato: ' + erroreDati, 5000);
  } finally {
    aggiornaStato();
  }
}

/** Legge {u, k} da un testo che contiene "cfg=<base64url>" (link o QR di configurazione). */
function decodificaConfigurazione(testo) {
  const m = String(testo).match(/cfg=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  let b = m[1].replace(/-/g, '+').replace(/_/g, '/');
  b += '='.repeat((4 - (b.length % 4)) % 4);
  const c = JSON.parse(atob(b));
  if (!/^https:\/\//.test(c.u) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(c.u)) throw new Error('indirizzo non valido');
  if (!c.k) throw new Error('chiave mancante');
  return { u: c.u, k: c.k };
}

/** Collega il telefono al foglio. daQR: arriva dalla fotocamera dell'app (chiede conferma). */
async function configuraDaTesto(testo, daQR) {
  let c;
  try { c = decodificaConfigurazione(testo); }
  catch (e) { avviso('QR di configurazione non valido: ' + e.message, 6000); return false; }
  if (!c) return false;
  if (c.u === cfg.u && c.k === cfg.k) {
    if (daQR) { mostraEsito('', 'Telefono gia\' collegato', 'Questo e\' il QR di configurazione: per le presenze inquadra le tessere.'); }
    return false;
  }
  if (daQR || cfg.u) {
    const domanda = cfg.u ? 'Collegare questo telefono a un altro foglio?\nLe scansioni gia\' fatte restano sul telefono e vanno inviate al foglio attuale prima.'
                          : 'Collegare questo telefono al foglio delle presenze?';
    if (daQR && daInviare().length && cfg.u) { avviso('Prima invia le scansioni in sospeso al foglio attuale.', 6000); return false; }
    if (!(await dialogo(domanda))) return false;
  }
  cfg = Object.assign({}, cfg, c);
  scriviLS(CHIAVI.cfg, cfg);
  if (!cfg.dispositivo) {
    const nome = await dialogo('Telefono collegato.\nDai un nome a questo telefono (es. Ingresso 1):', true,
                               'Telefono ' + Math.floor(100 + Math.random() * 900));
    cfg.dispositivo = (nome || 'Telefono').slice(0, 40);
    scriviLS(CHIAVI.cfg, cfg);
  }
  mostraEsito('verde', 'Telefono collegato', 'Scarico elenco ed eventi...');
  await scaricaDati(true);
  disegnaEventi();
  mostraEsito('', eventoCorrente() ? 'Pronto' : 'Scegli l\'evento', 'Tocca un evento in alto e inquadra le tessere.');
  aggiornaStato();
  return true;
}

function mostraAllarmeOrologio() {
  const el = $('allarme');
  const min = Math.round(Math.abs(scartoOrologio) / 60000);
  if (Math.abs(scartoOrologio) > SCARTO_OROLOGIO_MAX_MS) {
    el.textContent = `Orologio del telefono ${scartoOrologio > 0 ? 'avanti' : 'indietro'} di circa ${min} minuti: ` +
                     'imposta data e ora automatiche, altrimenti gli orari registrati saranno sbagliati.';
    el.classList.remove('nascosto');
  } else {
    el.classList.add('nascosto');
  }
}

// ---------------------------------------------------------------------
//  Esporta e pulizia
// ---------------------------------------------------------------------

function fileScansioni() {
  const campo = (v) => { const s = String(v === undefined || v === null ? '' : v); return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const righe = [['id', 'ora', 'dispositivo', 'evento', 'numero', 'nome in elenco', 'testo QR', 'in elenco', 'riferimento', 'inviata']];
  scansioni.forEach((s) => {
    const p = elenco.get(s.n);
    righe.push([s.id, new Date(s.t).toLocaleString('it-IT'), cfg.dispositivo || '', s.ev, s.n,
      p ? `${p.c} ${p.no}`.trim() : '', s.testo, s.inElenco ? 'si' : 'no', s.rif || '', s.inviata ? 'si' : 'no']);
  });
  const testo = '﻿' + righe.map((r) => r.map(campo).join(';')).join('\r\n');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const nome = `scansioni_${(cfg.dispositivo || 'telefono').replace(/[^A-Za-z0-9]+/g, '_')}_${stamp}.csv`;
  return new File([testo], nome, { type: 'text/csv' });
}

function esporta() {
  const f = fileScansioni();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f);
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  avviso('File salvato nei Download: ' + f.name, 5000);
}

async function condividi() {
  const f = fileScansioni();
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: f.name }); } catch (e) { /* annullato */ }
  } else {
    esporta();
  }
}

async function cancellaDati() {
  if (daInviare().length) {
    avviso('Ci sono scansioni da inviare: prima inviale (o esportale).', 5000);
    return;
  }
  if (!(await dialogo('Cancellare elenco e scansioni da questo telefono?\nIl collegamento e il nome del telefono restano.'))) return;
  await DB.svuota();
  scansioni = [];
  dati = { elenco: [], eventi: [], impostazioni: {} };
  scriviLS(CHIAVI.dati, dati);
  costruisciElenco();
  disegnaEventi();
  aggiornaStato();
  disegnaUltime();
  avviso('Dati cancellati. Aggiorna l\'elenco prima di ricominciare.');
}

// ---------------------------------------------------------------------
//  Avvio
// ---------------------------------------------------------------------

async function inizio() {
  try {
    await DB.apri();
    scansioni = await DB.tutte();
  } catch (e) {
    mostraEsito('rosso', 'Memoria non disponibile', String(e), 'Le scansioni non possono essere salvate.');
    $('btnAvvia').disabled = true;
    return;
  }
  const annullati = new Set(scansioni.filter((s) => s.ev === 'annulla').map((s) => s.rif));
  scansioni.forEach((s) => { if (annullati.has(s.id)) s.annullata = true; });

  costruisciElenco();
  let linkCfg = '';
  if (/cfg=/.test(location.hash)) { linkCfg = location.hash; history.replaceState(null, '', location.pathname + location.search); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await preparaRilevatore();
  disegnaEventi();
  aggiornaStato();

  if (linkCfg) {
    await configuraDaTesto(linkCfg, false);
  } else if (!cfg.u) {
    mostraEsito('rosso', 'Telefono non collegato', 'Tocca "Tocca per iniziare" e inquadra il QR di configurazione',
                'Nel foglio Google: menu Presenze > Mostra link di configurazione.');
  } else {
    scaricaDati(false);
  }
  invia(false);

  $('btnAvvia').onclick = avvia;
  $('btnImpostazioni').onclick = apriPannello;
  $('btnChiudi').onclick = () => $('pannello').classList.add('nascosto');
  $('btnInvia').onclick = () => invia(true);
  $('btnAnnulla').onclick = annullaUltima;
  $('btnAggiornaElenco').onclick = () => scaricaDati(true);
  $('btnEsporta').onclick = esporta;
  $('btnInviaFile').onclick = condividi;
  $('btnCancella').onclick = cancellaDati;
  $('btnSalvaDispositivo').onclick = () => {
    cfg.dispositivo = $('inDispositivo').value.trim().slice(0, 40);
    scriviLS(CHIAVI.cfg, cfg);
    aggiornaStato();
    avviso('Nome salvato.');
  };
  $('btnSalvaServer').onclick = () => {
    cfg.u = $('inUrl').value.trim();
    cfg.k = $('inChiave').value.trim();
    scriviLS(CHIAVI.cfg, cfg);
    aggiornaStato();
    scaricaDati(true);
  };

  window.addEventListener('hashchange', () => {      // link di configurazione aperto con l'app gia' aperta
    if (!/cfg=/.test(location.hash)) return;
    const h = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    configuraDaTesto(h, false);
  });
  window.addEventListener('online', () => { aggiornaStato(); invia(false); scaricaDati(false); });
  window.addEventListener('offline', aggiornaStato);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { tieniSchermoAcceso(); invia(false); aggiornaStato(); }
  });
  setInterval(() => invia(false), INTERVALLO_INVIO_MS);
  setInterval(() => scaricaDati(false), INTERVALLO_ELENCO_MS);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  const giaControllata = !!navigator.serviceWorker.controller;   // false al primo avvio
  let ricaricato = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (ricaricato || !giaControllata) return;
    ricaricato = true;
    avviso('Nuova versione dell\'app installata: chiudi e riapri l\'app quando hai finito.', 8000);
  });
}

inizio();
