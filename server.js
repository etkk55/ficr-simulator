/**
 * SIMULATORE API FICR v2.0
 * 
 * Chat 17: Controllo completo da pagina web
 * - Endpoint init/start/pause/stop/reset
 * - Timer automatico per rilascio tempi
 * - Parametri configurabili dal frontend
 * - Log dettagliato con numeri piloti per PS
 * - Logica sovrapposizione PS realistica
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const config = require('./config');

const app = express();
app.use(cors());
app.use(express.json());

// Connessione DB
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============================================
// STATO SIMULAZIONE
// ============================================
let statoSimulazione = {
  // Stato generale
  inizializzato: false,
  inEsecuzione: false,
  inPausa: false,
  completato: false,
  
  // Dati evento
  eventoId: null,
  evento: null,
  
  // Tempi
  tempiPerPilota: {},
  tempiOriginali: [],
  tempiTotali: 0,
  tempiRilasciati: 0,
  
  // PS
  psOrdinate: [],
  proveInfo: {},
  tempiRilasciatiPerPS: {},
  tempiTotaliPerPS: {},
  
  // Piloti
  pilotiOrdine: [],
  psRilasciatePerPilota: {},
  numPiloti: 0,
  
  // Parametri (configurabili da frontend)
  parametri: {
    durataMinuti: 5,
    batchMin: 30,
    batchMax: 50,
    sovrapposizione: 0.7
  },
  
  // Timer
  timerRef: null,
  intervalloMs: 5000,
  
  // Timestamp
  oraInizio: null,
  
  // Log eventi (ultimi 50)
  logEventi: []
};

// ============================================
// FUNZIONI UTILITÀ
// ============================================

function formatTempoFICR(secondi) {
  if (!secondi) return null;
  const min = Math.floor(secondi / 60);
  const sec = (secondi % 60).toFixed(2);
  return `${min}'${sec.padStart(5, '0')}`;
}

function shuffleConVariazione(array, maxVar) {
  return array
    .map((item, index) => ({
      item,
      sortKey: index + (Math.random() * maxVar * 2 - maxVar)
    }))
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ item }) => item);
}

function aggiungiLog(icona, tipo, messaggio, dettaglio = null) {
  const log = {
    timestamp: new Date().toLocaleTimeString('it-IT'),
    icona,
    tipo,
    messaggio,
    dettaglio
  };
  statoSimulazione.logEventi.unshift(log);
  statoSimulazione.logEventi = statoSimulazione.logEventi.slice(0, 50);
  console.log(`${log.timestamp} ${icona} ${tipo}: ${messaggio}${dettaglio ? ' - ' + dettaglio : ''}`);
  return log;
}

// ============================================
// INIZIALIZZAZIONE
// ============================================

async function inizializzaSimulazione(eventoId, parametri = {}) {
  console.log(`\n📊 Inizializzazione simulazione per evento: ${eventoId}`);
  
  // Ferma eventuale simulazione in corso
  if (statoSimulazione.timerRef) {
    clearInterval(statoSimulazione.timerRef);
    statoSimulazione.timerRef = null;
  }
  
  try {
    // Verifica evento
    const eventoResult = await pool.query(
      'SELECT * FROM eventi WHERE id = $1',
      [eventoId]
    );
    
    if (eventoResult.rows.length === 0) {
      throw new Error(`Evento non trovato: ${eventoId}`);
    }
    
    // Carica tutti i tempi
    const tempiResult = await pool.query(`
      SELECT 
        t.id,
        t.id_pilota,
        t.id_ps,
        t.tempo_secondi,
        t.penalita_secondi,
        p.numero_gara,
        p.nome,
        p.cognome,
        p.classe,
        p.moto,
        ps.numero_ordine,
        ps.nome_ps
      FROM tempi t
      JOIN piloti p ON t.id_pilota = p.id
      JOIN prove_speciali ps ON t.id_ps = ps.id
      WHERE ps.id_evento = $1
      ORDER BY p.numero_gara, ps.numero_ordine
    `, [eventoId]);
    
    if (tempiResult.rows.length === 0) {
      throw new Error('Nessun tempo trovato. Importare prima i tempi da FICR.');
    }
    
    // Aggiorna parametri
    const params = {
      durataMinuti: parametri.durata_minuti || parametri.durataMinuti || 5,
      batchMin: parametri.batch_min || parametri.batchMin || 30,
      batchMax: parametri.batch_max || parametri.batchMax || 50,
      sovrapposizione: parametri.sovrapposizione || 0.7
    };
    
    // Calcola intervallo per rispettare la durata
    const numBatch = Math.ceil(tempiResult.rows.length / ((params.batchMin + params.batchMax) / 2));
    const intervalloMs = Math.floor((params.durataMinuti * 60 * 1000) / numBatch);
    
    // Raggruppa tempi per pilota
    const tempiPerPilota = {};
    const psSet = new Set();
    
    tempiResult.rows.forEach(t => {
      const numGara = t.numero_gara;
      if (!tempiPerPilota[numGara]) {
        tempiPerPilota[numGara] = [];
      }
      tempiPerPilota[numGara].push(t);
      psSet.add(t.numero_ordine);
    });
    
    const psOrdinate = Array.from(psSet).sort((a, b) => a - b);
    const piloti = Object.keys(tempiPerPilota).map(Number).sort((a, b) => a - b);
    
    // Info prove
    const proveInfo = {};
    const tempiTotaliPerPS = {};
    const tempiRilasciatiPerPS = {};
    
    psOrdinate.forEach(ps => {
      const tempiPS = tempiResult.rows.filter(t => t.numero_ordine === ps);
      proveInfo[ps] = { totale: tempiPS.length, nome: `PS${ps}` };
      tempiTotaliPerPS[ps] = tempiPS.length;
      tempiRilasciatiPerPS[ps] = 0;
    });
    
    // Inizializza stato rilascio piloti
    const psRilasciatePerPilota = {};
    piloti.forEach(p => {
      psRilasciatePerPilota[p] = -1;
    });
    
    // Aggiorna stato globale
    statoSimulazione = {
      ...statoSimulazione,
      inizializzato: true,
      inEsecuzione: false,
      inPausa: false,
      completato: false,
      eventoId,
      evento: eventoResult.rows[0],
      tempiPerPilota,
      tempiOriginali: tempiResult.rows,
      tempiTotali: tempiResult.rows.length,
      tempiRilasciati: 0,
      psOrdinate,
      proveInfo,
      tempiTotaliPerPS,
      tempiRilasciatiPerPS,
      pilotiOrdine: shuffleConVariazione(piloti, 20),
      psRilasciatePerPilota,
      numPiloti: piloti.length,
      parametri: params,
      intervalloMs: Math.max(1000, intervalloMs),
      timerRef: null,
      oraInizio: null,
      logEventi: []
    };
    
    aggiungiLog('✅', 'INIT', `Evento: ${statoSimulazione.evento.nome_evento}`);
    aggiungiLog('📊', 'INFO', `${tempiResult.rows.length} tempi, ${piloti.length} piloti, ${psOrdinate.length} PS`);
    aggiungiLog('⚙️', 'CONFIG', `Durata ${params.durataMinuti}min, Batch ${params.batchMin}-${params.batchMax}, Sovr ${Math.round(params.sovrapposizione * 100)}%`);
    aggiungiLog('⏱️', 'TIMER', `Intervallo rilascio: ${Math.round(statoSimulazione.intervalloMs / 1000)}s`);
    
    console.log(`\n✅ Simulazione inizializzata!`);
    console.log(`   Tempi: ${tempiResult.rows.length}`);
    console.log(`   Piloti: ${piloti.length}`);
    console.log(`   PS: ${psOrdinate.join(', ')}`);
    console.log(`   Intervallo: ${Math.round(statoSimulazione.intervalloMs / 1000)}s`);
    
    return {
      success: true,
      evento: statoSimulazione.evento.nome_evento,
      tempiTotali: statoSimulazione.tempiTotali,
      piloti: statoSimulazione.numPiloti,
      prove: psOrdinate.length,
      intervalloMs: statoSimulazione.intervalloMs
    };
    
  } catch (error) {
    console.error('❌ Errore inizializzazione:', error.message);
    aggiungiLog('❌', 'ERRORE', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// RILASCIO TEMPI (con sovrapposizione)
// ============================================

function rilasciaBatch() {
  if (!statoSimulazione.inizializzato || statoSimulazione.inPausa) {
    return null;
  }
  
  if (statoSimulazione.tempiRilasciati >= statoSimulazione.tempiTotali) {
    // Completato
    if (statoSimulazione.timerRef) {
      clearInterval(statoSimulazione.timerRef);
      statoSimulazione.timerRef = null;
    }
    statoSimulazione.inEsecuzione = false;
    statoSimulazione.completato = true;
    aggiungiLog('🏁', 'COMPLETATO', 'Simulazione terminata');
    return { completato: true, tempi: [] };
  }
  
  const { batchMin, batchMax, sovrapposizione } = statoSimulazione.parametri;
  const batchSize = Math.floor(Math.random() * (batchMax - batchMin + 1)) + batchMin;
  const psOrdinate = statoSimulazione.psOrdinate;
  
  // Trova PS attive
  const psAttive = psOrdinate.filter(ps => {
    const rilasciati = statoSimulazione.tempiRilasciatiPerPS[ps] || 0;
    const totali = statoSimulazione.tempiTotaliPerPS[ps] || 1;
    return rilasciati < totali;
  });
  
  if (psAttive.length === 0) {
    statoSimulazione.completato = true;
    return { completato: true, tempi: [] };
  }
  
  // Calcola quali PS possono rilasciare
  const psConPercentuale = psAttive.map(ps => ({
    ps,
    rilasciati: statoSimulazione.tempiRilasciatiPerPS[ps] || 0,
    totali: statoSimulazione.tempiTotaliPerPS[ps] || 1,
    percentuale: (statoSimulazione.tempiRilasciatiPerPS[ps] || 0) / (statoSimulazione.tempiTotaliPerPS[ps] || 1)
  }));
  
  const psChePossonoRilasciare = [];
  for (let i = 0; i < psConPercentuale.length; i++) {
    const ps = psConPercentuale[i];
    if (i === 0) {
      psChePossonoRilasciare.push(ps);
    } else {
      const psPrecedente = psConPercentuale[i - 1];
      if (psPrecedente.percentuale >= sovrapposizione) {
        psChePossonoRilasciare.push(ps);
      }
    }
  }
  
  // Rilascia tempi
  const batch = [];
  const pilotiPerPS = {};
  let tempiRimanenti = batchSize;
  
  for (let i = 0; i < psChePossonoRilasciare.length && tempiRimanenti > 0; i++) {
    const psInfo = psChePossonoRilasciare[i];
    const ps = psInfo.ps;
    const psIndex = psOrdinate.indexOf(ps);
    
    const tempiPerQuestaPS = i === 0 
      ? Math.ceil(tempiRimanenti * 0.7) 
      : Math.ceil(tempiRimanenti / (psChePossonoRilasciare.length - i));
    
    const pilotiDisponibili = statoSimulazione.pilotiOrdine.filter(numGara => {
      const tempiPilota = statoSimulazione.tempiPerPilota[numGara];
      const ultimaPsRilasciata = statoSimulazione.psRilasciatePerPilota[numGara];
      return tempiPilota && tempiPilota[psIndex] && psIndex === ultimaPsRilasciata + 1;
    });
    
    const pilotiDaRilasciare = pilotiDisponibili.slice(0, tempiPerQuestaPS);
    pilotiPerPS[ps] = [];
    
    for (const numGara of pilotiDaRilasciare) {
      const tempiPilota = statoSimulazione.tempiPerPilota[numGara];
      const tempo = tempiPilota[psIndex];
      
      if (tempo) {
        batch.push(tempo);
        pilotiPerPS[ps].push(numGara);
        statoSimulazione.psRilasciatePerPilota[numGara] = psIndex;
        statoSimulazione.tempiRilasciatiPerPS[ps]++;
        statoSimulazione.tempiRilasciati++;
        tempiRimanenti--;
      }
    }
  }
  
  // Log dettagliato
  const psLive = psChePossonoRilasciare.map(p => `PS${p.ps}(${Math.round(p.percentuale * 100)}%)`);
  const dettaglio = Object.entries(pilotiPerPS)
    .filter(([_, piloti]) => piloti.length > 0)
    .map(([ps, piloti]) => `PS${ps}: ${piloti.join(',')}`)
    .join(' | ');
  
  const progresso = Math.round((statoSimulazione.tempiRilasciati / statoSimulazione.tempiTotali) * 100);
  aggiungiLog('📤', 'BATCH', `${batch.length} tempi (${progresso}%)`, dettaglio);
  
  if (psLive.length > 1) {
    aggiungiLog('🔴', 'PS LIVE', psLive.join(', '));
  }
  
  return {
    completato: false,
    tempi: batch,
    rilasciati: statoSimulazione.tempiRilasciati,
    totali: statoSimulazione.tempiTotali,
    progresso,
    psLive: psChePossonoRilasciare.map(p => ({ ps: p.ps, percentuale: Math.round(p.percentuale * 100) })),
    pilotiPerPS
  };
}

// ============================================
// SALVA TEMPI NEL DATABASE
// ============================================

async function salvaTempiDB(tempi) {
  if (!tempi || tempi.length === 0) return { salvati: 0, errori: 0 };
  
  let salvati = 0;
  let errori = 0;
  
  for (const tempo of tempi) {
    try {
      // Verifica se esiste già
      const exists = await pool.query(
        'SELECT id FROM tempi WHERE id_pilota = $1 AND id_ps = $2',
        [tempo.id_pilota, tempo.id_ps]
      );
      
      if (exists.rows.length === 0) {
        // Inserisci
        await pool.query(`
          INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi)
          VALUES ($1, $2, $3, $4)
        `, [tempo.id_pilota, tempo.id_ps, tempo.tempo_secondi, tempo.penalita_secondi || 0]);
        salvati++;
      } else {
        // Già esistente, conta come salvato
        salvati++;
      }
    } catch (err) {
      console.error(`Errore salvataggio tempo:`, err.message);
      errori++;
    }
  }
  
  if (salvati > 0) {
    aggiungiLog('💾', 'DB', `Salvati ${salvati} tempi nel database`);
  }
  
  return { salvati, errori };
}

// ============================================
// ENDPOINTS API
// ============================================

// Inizializza simulazione con parametri
app.post('/simulator/init', async (req, res) => {
  const { evento_id, durata_minuti, batch_min, batch_max, sovrapposizione } = req.body;
  
  if (!evento_id) {
    return res.status(400).json({ success: false, error: 'evento_id richiesto' });
  }
  
  const result = await inizializzaSimulazione(evento_id, {
    durata_minuti,
    batch_min,
    batch_max,
    sovrapposizione
  });
  
  res.json(result);
});

// Avvia simulazione automatica
app.post('/simulator/start', async (req, res) => {
  if (!statoSimulazione.inizializzato) {
    return res.status(400).json({ success: false, error: 'Simulazione non inizializzata. Chiamare /simulator/init' });
  }
  
  if (statoSimulazione.inEsecuzione && !statoSimulazione.inPausa) {
    return res.json({ success: true, message: 'Simulazione già in esecuzione' });
  }
  
  statoSimulazione.inEsecuzione = true;
  statoSimulazione.inPausa = false;
  statoSimulazione.oraInizio = statoSimulazione.oraInizio || new Date();
  
  // Avvia timer
  if (!statoSimulazione.timerRef) {
    statoSimulazione.timerRef = setInterval(async () => {
      if (!statoSimulazione.inPausa) {
        const result = rilasciaBatch();
        if (result && result.tempi && result.tempi.length > 0) {
          await salvaTempiDB(result.tempi);
        }
      }
    }, statoSimulazione.intervalloMs);
  }
  
  aggiungiLog('▶️', 'START', 'Simulazione avviata');
  
  res.json({
    success: true,
    message: 'Simulazione avviata',
    intervalloMs: statoSimulazione.intervalloMs
  });
});

// Pausa/Riprendi
app.post('/simulator/pause', (req, res) => {
  if (!statoSimulazione.inEsecuzione) {
    return res.status(400).json({ success: false, error: 'Simulazione non in esecuzione' });
  }
  
  statoSimulazione.inPausa = !statoSimulazione.inPausa;
  
  if (statoSimulazione.inPausa) {
    aggiungiLog('⏸️', 'PAUSA', 'Simulazione in pausa');
  } else {
    aggiungiLog('▶️', 'RIPRESO', 'Simulazione ripresa');
  }
  
  res.json({
    success: true,
    inPausa: statoSimulazione.inPausa,
    message: statoSimulazione.inPausa ? 'In pausa' : 'Ripresa'
  });
});

// Stop simulazione
app.post('/simulator/stop', (req, res) => {
  if (statoSimulazione.timerRef) {
    clearInterval(statoSimulazione.timerRef);
    statoSimulazione.timerRef = null;
  }
  
  statoSimulazione.inEsecuzione = false;
  statoSimulazione.inPausa = false;
  
  aggiungiLog('⏹️', 'STOP', 'Simulazione fermata');
  
  res.json({
    success: true,
    message: 'Simulazione fermata',
    tempiRilasciati: statoSimulazione.tempiRilasciati,
    tempiTotali: statoSimulazione.tempiTotali
  });
});

// Reset simulazione
app.post('/simulator/reset', async (req, res) => {
  const eventoId = req.body.evento_id || statoSimulazione.eventoId || config.EVENTO_DEFAULT;
  
  if (statoSimulazione.timerRef) {
    clearInterval(statoSimulazione.timerRef);
    statoSimulazione.timerRef = null;
  }
  
  const result = await inizializzaSimulazione(eventoId, statoSimulazione.parametri);
  
  if (result.success) {
    aggiungiLog('🔄', 'RESET', 'Simulazione resettata');
  }
  
  res.json(result);
});

// Status dettagliato
app.get('/simulator/status', (req, res) => {
  if (!statoSimulazione.inizializzato) {
    return res.json({ 
      inizializzato: false, 
      message: 'Chiamare POST /simulator/init con evento_id' 
    });
  }
  
  const progresso = Math.round((statoSimulazione.tempiRilasciati / statoSimulazione.tempiTotali) * 100);
  
  // Calcola PS live
  const psLive = statoSimulazione.psOrdinate
    .map(ps => ({
      ps,
      percentuale: Math.round((statoSimulazione.tempiRilasciatiPerPS[ps] || 0) / (statoSimulazione.tempiTotaliPerPS[ps] || 1) * 100)
    }))
    .filter(p => p.percentuale > 0 && p.percentuale < 100);
  
  res.json({
    inizializzato: true,
    inEsecuzione: statoSimulazione.inEsecuzione,
    inPausa: statoSimulazione.inPausa,
    completato: statoSimulazione.completato,
    evento: statoSimulazione.evento?.nome_evento,
    eventoId: statoSimulazione.eventoId,
    tempiTotali: statoSimulazione.tempiTotali,
    tempiRilasciati: statoSimulazione.tempiRilasciati,
    percentuale: progresso,
    piloti: statoSimulazione.numPiloti,
    prove: statoSimulazione.psOrdinate.length,
    psLive,
    parametri: statoSimulazione.parametri,
    intervalloMs: statoSimulazione.intervalloMs,
    oraInizio: statoSimulazione.oraInizio
  });
});

// Log eventi
app.get('/simulator/log', (req, res) => {
  res.json({
    log: statoSimulazione.logEventi
  });
});

// Endpoint FICR simulato (per compatibilità con polling esistente)
app.get('/END/mpcache-5/get/clasps/:anno/:equipe/:manif/:giorno/:prova/*', (req, res) => {
  const { anno, equipe, manif, giorno, prova } = req.params;
  
  if (!statoSimulazione.inizializzato) {
    return res.json({ data: { clasdella: [] } });
  }
  
  // Se in esecuzione automatica, restituisce batch vuoto
  // (i tempi vengono rilasciati dal timer interno)
  if (statoSimulazione.inEsecuzione) {
    return res.json({ data: { clasdella: [] } });
  }
  
  // Altrimenti rilascia un batch manualmente
  const result = rilasciaBatch();
  
  if (!result || !result.tempi) {
    return res.json({ data: { clasdella: [] } });
  }
  
  const clasdella = result.tempi.map(t => ({
    Numero: t.numero_gara,
    Tempo: formatTempoFICR(t.tempo_secondi),
    Cognome: t.cognome,
    Nome: t.nome,
    Classe: t.classe || '',
    Moto: t.moto || '',
    Motoclub: '',
    Naz: 'ITA',
    Penalita: t.penalita_secondi || 0,
    NumeroProva: t.numero_ordine
  }));
  
  res.json({ data: { clasdella } });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'ficr-simulator',
    version: '2.0.0',
    timestamp: new Date().toISOString() 
  });
});

// Info
app.get('/', (req, res) => {
  res.json({
    name: 'FICR Simulator',
    version: '2.0.0',
    description: 'Chat 17: Controllo completo da pagina web',
    endpoints: {
      'POST /simulator/init': 'Inizializza con evento_id e parametri',
      'POST /simulator/start': 'Avvia rilascio automatico',
      'POST /simulator/pause': 'Pausa/Riprendi',
      'POST /simulator/stop': 'Ferma simulazione',
      'POST /simulator/reset': 'Reset simulazione',
      'GET /simulator/status': 'Stato dettagliato',
      'GET /simulator/log': 'Log eventi',
      'GET /health': 'Health check'
    }
  });
});

// ============================================
// AVVIO SERVER
// ============================================

async function avviaServer() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Connessione DB OK');
  } catch (err) {
    console.error('❌ Errore connessione DB:', err.message);
    process.exit(1);
  }
  
  app.listen(config.PORT, () => {
    console.log(`\n🚀 Simulatore FICR v2.0 avviato su porta ${config.PORT}`);
    console.log(`   http://localhost:${config.PORT}`);
    console.log(`\n📋 Nuovi Endpoints:`);
    console.log(`   POST /simulator/init   - Inizializza`);
    console.log(`   POST /simulator/start  - Avvia`);
    console.log(`   POST /simulator/pause  - Pausa/Riprendi`);
    console.log(`   POST /simulator/stop   - Ferma`);
    console.log(`   POST /simulator/reset  - Reset`);
    console.log(`   GET  /simulator/status - Stato`);
    console.log(`   GET  /simulator/log    - Log eventi\n`);
  });
}

avviaServer();
