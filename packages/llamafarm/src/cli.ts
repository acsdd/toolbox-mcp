#!/usr/bin/env node
/**
 * Entry point for the `llamafarm` binary.
 */
import { runCli } from './app.js'

const code = await runCli(process.argv.slice(2))
if (code !== 0) process.exitCode = code
