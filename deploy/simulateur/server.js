// Simulateur de fournisseur pour la sandbox : jamais de vrai fournisseur derrière la sandbox.
// Répond en JSON à toute requête et renvoie ce qu'il a reçu (méthode, chemin, en-têtes utiles).
// Les simulateurs métier (SVIP, Cockpit, Chargeback, Plateforme 1) arrivent au lot 4.
const http = require('node:http');

const port = Number(process.env.PORT ?? 8080);

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"status":"ok"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          simulateur: true,
          method: req.method,
          path: req.url,
          requestId: req.headers['x-request-id'] ?? null,
          // Aucun identifiant de la banque ne doit arriver jusqu'ici (hide_credentials).
          apikeyReceived: 'apikey' in req.headers,
          bodyLength: body.length,
        }),
      );
    });
  })
  .listen(port, () => console.log(`Simulateur prêt sur le port ${port}`));
