/**
 * HTTPS Certificate Management
 * Automatically checks for existing cert.pem and key.pem,
 * or generates a self-signed localhost certificate with the selfsigned library.
 */

const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const CERTS_DIR = path.join(__dirname);
const CERT_FILE = path.join(CERTS_DIR, 'cert.pem');
const KEY_FILE = path.join(CERTS_DIR, 'key.pem');

async function getOrGenerateCertificate() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return {
      cert: fs.readFileSync(CERT_FILE, 'utf8'),
      key: fs.readFileSync(KEY_FILE, 'utf8')
    };
  }

  console.log('[HTTPS] Generating fresh self-signed SSL certificate for localhost...');
  const attrs = [
    { name: 'commonName', value: 'localhost' },
    { name: 'countryName', value: 'US' },
    { name: 'organizationName', value: 'Local Dev Secure Auth' }
  ];

  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    days: 365,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' }
        ]
      }
    ]
  });

  fs.writeFileSync(CERT_FILE, pems.cert, { mode: 0o600 });
  fs.writeFileSync(KEY_FILE, pems.private, { mode: 0o600 });
  console.log('[HTTPS] Certificate and key saved to server/certs/');

  return {
    cert: pems.cert,
    key: pems.private
  };
}

module.exports = {
  getOrGenerateCertificate,
  CERT_FILE,
  KEY_FILE
};
