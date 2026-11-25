/* Single-window portable shell for the existing localhost panel. */
const { app, BrowserWindow, dialog, shell } = require('electron')
const { createDesktopApp } = require('./desktop-main.cjs')

module.exports = createDesktopApp({ app, BrowserWindow, dialog, shell, dirname: __dirname })
