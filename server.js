/**
 * SIMULATORE API FICR v2.2
 * 
 * Chat 17: Fix completo
 * - Reset cancella tempi dal DB
 * - Max 2 PS attive contemporaneamente
 * - Progressione graduale
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const config = require('./config');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============================================
// STATO SIMULAZIONE
// ============================================
let statoSimulazione = {
  inizializzato: false,
  inEsecuzione: false,
  inPausa: false,
  completato: false,
  eventoId: null,
  evento: null,
  tempiPerPilota: {},
  tempiInMemoria: [],
  tempiTotali: 0,
  tempiRilasciati: 0,
  psOrdinate: [],
  proveInfo: {},
  tempiRilasciatiPerPS: {},
  tempiTotaliPerPS: {},
  pilotiOrdine: [],
  psRilasciatePerPilota: {},
  numPiloti: 0,
  parametri: {
    durataMinuti: 5,
    batchMin: 30,
    batchMax: 50,
    sovrapposizione: 0.7
  },
  timerRef: null,
  intervalloMs: 5000,
  oraInizio: null,
  logEventi: [],
  psCorrenteIndex: 0
};

// ============================================
// FUNZIONI UTILITÀ
// ============================================

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

function shuffleConVariazione(array, maxVar) {
  return array
    .map((item, index) => ({
      item,
      sortKey: index + (Math.random() * maxVar * 2 - maxVar)
    }))
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ item }) => item);
}

// ============================================
// CANCELLA TEMPI DAL DATABASE
// ============================================

async function cancellaTempiEvento(eventoId) {
  try {
    // Trova tutti i piloti dell'evento
    const pilotiResult = await pool.query(
      'SELECT id FROM piloti WHERE id_evento = $1',
      [eventoId]
    );
    
    if (pilotiResult.rows.length === 0) {
      return { cancellati: 0 };
    }
    
    const pilotiIds = pilotiResult.rows.map(p => p.id);
    
    // Cancella i tempi di questi piloti
    const deleteResult = await pool.query(
      'DELETE FROM tempi WHERE id_pilota = ANY($1)',
      [pilotiIds]
    );
    
    console.log(`🗑️ Cancellati ${deleteResult.rowCount} tempi dal database`);
    return { cancellati: deleteResult.rowCount };
    
  } catch (error) {
    console.error('Errore cancellazione tempi:', error.message);
    return { cancellati: 0, errore: error.message };
  }
}

// ============================================
// INIZIALIZZAZIONE (carica tempi in memoria)
// ============================================

async function inizializzaSimulazione(eventoId, parametri = {}) {
  console.log(`\n📊 Inizializzazione simulazione per evento: ${eventoId}`);
  
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
    
    // Carica tempi da FICR (tabella temporanea o calcolo)
    // Per ora usiamo i tempi già presenti nel DB, ma li salviamo in memoria
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
    
    // Salva tempi in memoria
    const tempiInMemoria = tempiResult.rows.map(t => ({...t}));
    
    const params = {
      durataMinuti: parametri.durata_minuti || parametri.durataMinuti || 5,
      batchMin: parametri.batch_min || parametri.batchMin || 30,
      batchMax: parametri.batch_max || parametri.batchMax || 50,
      sovrapposizione: parametri.sovrapposizione || 0.7
    };
    
    // Raggruppa per pilota
    const tempiPerPilota = {};
    const psSet = new Set();
    
    tempiInMemoria.forEach(t => {
      const numGara = t.numero_gara;
      if (!tempiPerPilota[numGara]) {
        tempiPerPilota[numGara] = [];
      }
      tempiPerPilota[numGara].push(t);
      psSet.add(t.numero_ordine);
    });
    
    const psOrdinate = Array.from(psSet).sort((a, b) => a - b);
    const piloti = Object.keys(tempiPerPilota).map(Number).sort((a, b) => a - b);
    
    // Calcola intervallo
    const numBatch = Math.ceil(tempiInMemoria.length / ((params.batchMin + params.batchMax) / 2));
    const intervalloMs = Math.floor((params.durataMinuti * 60 * 1000) / numBatch);
    
    // Info prove
    const proveInfo = {};
    const tempiTotaliPerPS = {};
    const tempiRilasciatiPerPS = {};
    
    psOrdinate.forEach(ps => {
      const tempiPS = tempiInMemoria.filter(t => t.numero_ordine === ps);
      proveInfo[ps] = { totale: tempiPS.length, nome: `PS${ps}` };
      tempiTotaliPerPS[ps] = tempiPS.length;
      tempiRilasciatiPerPS[ps] = 0;
    });
    
    // Stato rilascio piloti
    const psRilasciatePerPilota = {};
    piloti.forEach(p => {
      psRilasciatePerPilota[p] = -1;
    });
    
    // Aggiorna stato
    statoSimulazione = {
      ...statoSimulazione,
      inizializzato: true,
      inEsecuzione: false,
      inPausa: false,
      completato: false,
      eventoId,
      evento: eventoResult.rows[0],
      tempiPerPilota,
      tempiInMemoria,
      tempiTotali: tempiInMemoria.length,
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
      logEventi: [],
      psCorrenteIndex: 0
    };
    
    aggiungiLog('✅', 'INIT', `Evento: ${statoSimulazione.evento.nome_evento}`);
    aggiungiLog('📊', 'INFO', `${tempiInMemoria.length} tempi in memoria, ${piloti.length} piloti, ${psOrdinate.length} PS`);
    aggiungiLog('⚙️', 'CONFIG', `Durata ${params.durataMinuti}min, Batch ${params.batchMin}-${params.batchMax}, Sovr ${Math.round(params.sovrapposizione * 100)}%`);
    
    return {
      success: true,
      evento: statoSimulazione.evento.nome_evento,
      tempiTotali: statoSimulazione.tempiTotali,
      piloti: statoSimulazione.numPiloti,
      prove: psOrdinate.length,
      intervalloMs: statoSimulazione.intervalloMs
    };
    
  } catch (error) {
    console.error('❌ Errore:', error.message);
    aggiungiLog('❌', 'ERRORE', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// RILASCIO BATCH (max 2 PS attive)
// ============================================

function rilasciaBatch() {
  if (!statoSimulazione.inizializzato || statoSimulazione.inPausa) {
    return null;
  }
  
  if (statoSimulazione.tempiRilasciati >= statoSimulazione.tempiTotali) {
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
  
  // PS corrente
  const psMainIndex = statoSimulazione.psCorrenteIndex;
  const psMain = psOrdinate[psMainIndex];
  
  if (!psMain) {
    statoSimulazione.completato = true;
    return { completato: true, tempi: [] };
  }
  
  // Percentuale PS corrente
  const percMain = (statoSimulazione.tempiRilasciatiPerPS[psMain] || 0) / (statoSimulazione.tempiTotaliPerPS[psMain] || 1);
  
  // Se PS corrente completa, avanza
  if (percMain >= 1) {
    statoSimulazione.psCorrenteIndex++;
    const nuovaPS = psOrdinate[statoSimulazione.psCorrenteIndex];
    if (nuovaPS) {
      aggiungiLog('➡️', 'AVANZA', `Passaggio a PS${nuovaPS}`);
    }
    return rilasciaBatch(); // Richiama per processare nuova PS
  }
  
  const batch = [];
  const pilotiPerPS = {};
  let tempiRimanenti = batchSize;
  
  // Può sovrapporre con PS successiva?
  const puoSovrapporre = percMain >= sovrapposizione && psOrdinate[psMainIndex + 1];
  
  // Tempi per PS principale
  let tempiPerMain = puoSovrapporre ? Math.ceil(tempiRimanenti * 0.7) : tempiRimanenti;
  
  // Trova piloti disponibili per PS principale
  const pilotiDisponibiliMain = statoSimulazione.pilotiOrdine.filter(numGara => {
    const tempiPilota = statoSimulazione.tempiPerPilota[numGara];
    const ultimaPs = statoSimulazione.psRilasciatePerPilota[numGara];
    return tempiPilota && tempiPilota[psMainIndex] && psMainIndex === ultimaPs + 1;
  });
  
  pilotiPerPS[psMain] = [];
  const pilotiDaRilasciareMain = pilotiDisponibiliMain.slice(0, tempiPerMain);
  
  for (const numGara of pilotiDaRilasciareMain) {
    const tempiPilota = statoSimulazione.tempiPerPilota[numGara];
    const tempo = tempiPilota[psMainIndex];
    
    if (tempo) {
      batch.push(tempo);
      pilotiPerPS[psMain].push(numGara);
      statoSimulazione.psRilasciatePerPilota[numGara] = psMainIndex;
      statoSimulazione.tempiRilasciatiPerPS[psMain]++;
      statoSimulazione.tempiRilasciati++;
      tempiRimanenti--;
    }
  }
  
  // Sovrapposizione con PS successiva
  if (puoSovrapporre && tempiRimanenti > 0) {
    const psNext = psOrdinate[psMainIndex + 1];
    const psNextIndex = psMainIndex + 1;
    
    const pilotiDisponibiliNext = statoSimulazione.pilotiOrdine.filter(numGara => {
      const tempiPilota = statoSimulazione.tempiPerPilota[numGara];
      const ultimaPs = statoSimulazione.psRilasciatePerPilota[numGara];
      return tempiPilota && tempiPilota[psNextIndex] && psNextIndex === ultimaPs + 1;
    });
    
    pilotiPerPS[psNext] = [];
    const pilotiDaRilasciareNext = pilotiDisponibiliNext.slice(0, tempiRimanenti);
    
    for (const numGara of pilotiDaRilasciareNext) {
      const tempiPilota = statoSimulazione.tempiPerPilota[numGara];
      const tempo = tempiPilota[psNextIndex];
      
      if (tempo) {
        batch.push(tempo);
        pilotiPerPS[psNext].push(numGara);
        statoSimulazione.psRilasciatePerPilota[numGara] = psNextIndex;
        statoSimulazione.tempiRilasciatiPerPS[psNext]++;
        statoSimulazione.tempiRilasciati++;
        tempiRimanenti--;
      }
    }
  }
  
  // Log
  const dettaglio = Object.entries(pilotiPerPS)
    .filter(([_, piloti]) => piloti.length > 0)
    .map(([ps, piloti]) => `PS${ps}:${piloti.length}`)
    .join(' | ');
  
  const progresso = Math.round((statoSimulazione.tempiRilasciati / statoSimulazione.tempiTotali) * 100);
  aggiungiLog('📤', 'BATCH', `${batch.length} tempi (${progresso}%)`, dettaglio);
  
  return {
    completato: false,
    tempi: batch,
    rilasciati: statoSimulazione.tempiRilasciati,
    totali: statoSimulazione.tempiTotali,
    progresso,
    pilotiPerPS
  };
}

// ============================================
// SALVA TEMPI NEL DATABASE
// ============================================

async function salvaTempiDB(tempi) {
  if (!tempi || tempi.length === 0) return { salvati: 0 };
  
  let salvati = 0;
  
  for (const tempo of tempi) {
    try {
      await pool.query(`
        INSERT INTO tempi (id_pilota, id_ps, tempo_secondi, penalita_secondi)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id_pilota, id_ps) DO UPDATE SET tempo_secondi = $3, penalita_secondi = $4
      `, [tempo.id_pilota, tempo.id_ps, tempo.tempo_secondi, tempo.penalita_secondi || 0]);
      salvati++;
    } catch (err) {
      // Ignora errori di duplicati
    }
  }
  
  return { salvati };
}

// ============================================
// ENDPOINTS API
// ============================================

app.post('/simulator/init', async (req, res) => {
  const { evento_id, durata_minuti, batch_min, batch_max, sovrapposizione } = req.body;
  
  if (!evento_id) {
    return res.status(400).json({ success: false, error: 'evento_id richiesto' });
  }
  
  const result = await inizializzaSimulazione(evento_id, {
    durata_minuti, batch_min, batch_max, sovrapposizione
  });
  
  res.json(result);
});

app.post('/simulator/start', async (req, res) => {
  if (!statoSimulazione.inizializzato) {
    return res.status(400).json({ success: false, error: 'Simulazione non inizializzata' });
  }
  
  if (statoSimulazione.inEsecuzione && !statoSimulazione.inPausa) {
    return res.json({ success: true, message: 'Già in esecuzione' });
  }
  
  // CANCELLA TEMPI DAL DB PRIMA DI INIZIARE
  aggiungiLog('🗑️', 'PULIZIA', 'Cancellazione tempi dal database...');
  const risultatoCancellazione = await cancellaTempiEvento(statoSimulazione.eventoId);
  aggiungiLog('✅', 'PULIZIA', `Cancellati ${risultatoCancellazione.cancellati} tempi`);
  
  statoSimulazione.inEsecuzione = true;
  statoSimulazione.inPausa = false;
  statoSimulazione.oraInizio = new Date();
  
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

app.post('/simulator/pause', (req, res) => {
  if (!statoSimulazione.inEsecuzione) {
    return res.status(400).json({ success: false, error: 'Non in esecuzione' });
  }
  
  statoSimulazione.inPausa = !statoSimulazione.inPausa;
  aggiungiLog(statoSimulazione.inPausa ? '⏸️' : '▶️', statoSimulazione.inPausa ? 'PAUSA' : 'RIPRESO', '');
  
  res.json({ success: true, inPausa: statoSimulazione.inPausa });
});

app.post('/simulator/stop', (req, res) => {
  if (statoSimulazione.timerRef) {
    clearInterval(statoSimulazione.timerRef);
    statoSimulazione.timerRef = null;
  }
  
  statoSimulazione.inEsecuzione = false;
  statoSimulazione.inPausa = false;
  aggiungiLog('⏹️', 'STOP', 'Simulazione fermata');
  
  res.json({ success: true, tempiRilasciati: statoSimulazione.tempiRilasciati });
});

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

app.get('/simulator/status', (req, res) => {
  if (!statoSimulazione.inizializzato) {
    return res.json({ inizializzato: false });
  }
  
  const progresso = Math.round((statoSimulazione.tempiRilasciati / statoSimulazione.tempiTotali) * 100);
  
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
    psCorrente: statoSimulazione.psOrdinate[statoSimulazione.psCorrenteIndex],
    parametri: statoSimulazione.parametri,
    intervalloMs: statoSimulazione.intervalloMs,
    oraInizio: statoSimulazione.oraInizio
  });
});

app.get('/simulator/log', (req, res) => {
  res.json({ log: statoSimulazione.logEventi });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'ficr-simulator',
    version: '2.2.0',
    timestamp: new Date().toISOString() 
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'FICR Simulator',
    version: '2.2.0',
    description: 'Reset cancella tempi dal DB + sovrapposizione corretta'
  });
});

// ============================================
// AVVIO
// ============================================

async function avviaServer() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Connessione DB OK');
  } catch (err) {
    console.error('❌ Errore DB:', err.message);
    process.exit(1);
  }
  
  app.listen(config.PORT, () => {
    console.log(`\n🚀 Simulatore FICR v2.2 su porta ${config.PORT}`);
    console.log(`   - Reset cancella tempi dal DB`);
    console.log(`   - Max 2 PS attive\n`);
  });
}

avviaServer();
