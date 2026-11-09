/**
 * Root Server Entry Point
 * Starts the secure server from root
 */
// Keep Express as a direct import in this recognized root entry point so
// Vercel's Express framework detector can identify the app.
const express = require('express');
const { app, startServer } = require('./server/server.js');

if (typeof express !== 'function' || typeof app !== 'function') {
  throw new TypeError('The Vercel entry point must export an Express application.');
}

// Vercel detects this root entry and serves the Express app as a Function.
// Keep the existing local HTTPS startup behavior for development.
if (require.main === module) {
  startServer();
}

module.exports = app;
