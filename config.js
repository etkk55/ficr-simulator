// Configurazione Simulatore FICR
module.exports = {
  // Database Railway (stessa connection string del backend)
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:ilmKISCQFyCjqRvOmolnbIjlGBWeRQiU@switchback.proxy.rlwy.net:24698/railway',
  
  // Porta simulatore
  PORT: process.env.PORT || 3001,
  
  // UUID evento Vestenanova (default per test)
  EVENTO_DEFAULT: '2897481d-bfc6-47e6-922e-8605703df40c',
  
  // Parametri simulazione realistica
  SIMULAZIONE: {
    // Batch di tempi rilasciati per ogni chiamata
    BATCH_SIZE_MIN: 30,
    BATCH_SIZE_MAX: 50,
    
    // Variazione ordine piloti (±N posizioni)
    VARIAZIONE_ORDINE: 20,
    
    // Percentuale completamento PS prima di iniziare la successiva
    // 0.7 = quando PS1 è al 70%, iniziano ad arrivare tempi PS2
    SOVRAPPOSIZIONE: 0.7
  }
};
