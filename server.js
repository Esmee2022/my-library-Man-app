/**
 * Root Server Entry Point
 * Starts the secure server from root
 */
const { app, startServer } = require('./server/server.js');

// Vercel detects this root entry and serves the Express app as a Function.
// Keep the existing local HTTPS startup behavior for development.
if (require.main === module) {
  startServer();
}

module.exports = app;
