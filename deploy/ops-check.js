// Il gioco raggiunge il gestionale? Gira dentro il container (docker exec -i … node - < ops-check.js):
// prova la strada diretta e quella dal Caddy interno (PROXY_INTERNO), come fa l'accesso con Zero Dark Ops.
const dns = require('dns');
const https = require('https');
const url = `${(process.env.OPS || 'https://ops.zerodarkteam.it').replace(/\/+$/, '')}/.well-known/openid-configuration`;
const proxy = process.env.PROXY_INTERNO || '';
const prova = (via) => new Promise((resolve) => {
  const opts = { timeout: 5000 };
  if (via) opts.lookup = (_h, o, cb) => dns.lookup(via, o, cb);
  const req = https.get(url, opts, (res) => { res.resume(); resolve(`HTTP ${res.statusCode}`); });
  req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  req.on('error', (e) => resolve(`errore ${e.code || e.message}`));
});
(async () => {
  console.log(`${url}`);
  console.log(`  diretto: ${await prova('')}`);
  if (proxy) console.log(`  tramite ${proxy}: ${await prova(proxy)}`);
  else console.log('  PROXY_INTERNO non impostato');
})();
