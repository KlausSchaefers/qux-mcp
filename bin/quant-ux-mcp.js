#!/usr/bin/env node
/**
 * The remote MCP server of Quant-UX (Streamable HTTP + OAuth), see
 * src/http.js for the configuration.
 */
import { startHttpServer } from '../src/http.js'

startHttpServer()
