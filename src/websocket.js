/**
 * @fileoverview WebSocket connection management for AdIT instance communications
 * 
 * Provides pure WebSocket operations (connect, ping, send, close) without instance-specific logic. 
 * The engine binds callbacks to associate events with specific instance IDs.
 * 
 * @module companion-module-middleman-adit/websocket
 */
const WebSocket = require('ws')

/**
 * Creates a WebSocket connection with timeout handling.
 * 
 * Callbacks are used instead of returning events because the engine needs to
 * associate events with specific instance IDs, which requires closure over
 * instance-specific state. Passing callbacks lets the engine bind that context.
 * 
 * @param {string} url - WebSocket URL to connect to
 * @param {number} connectTimeout - Max ms to wait for connection to open
 * @param {object} callbacks - Event handlers: { onOpen, onClose, onMessage, onError, onPong }
 * @returns {WebSocket} The WebSocket instance (caller stores this for later send/close)
 */
function createWebSocket(url, connectTimeout, callbacks) {
  const ws = new WebSocket(url)

  // Connection timeout: if we don't reach OPEN state in time, kill it.
  // This catches cases where the TCP connection hangs without erroring.
  const connectionTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      ws.terminate()
      callbacks.onError?.(new Error(`Connection timeout after ${connectTimeout}ms`))
    }
  }, connectTimeout)

  ws.on('open', () => {
    clearTimeout(connectionTimer)
    callbacks.onOpen?.()
  })

  ws.on('close', (code, reason) => {
    clearTimeout(connectionTimer)
    callbacks.onClose?.(code, reason)
  })

  ws.on('message', (data) => {
    callbacks.onMessage?.(data)
  })

  ws.on('error', (err) => {
    // Note: 'error' is usually followed by 'close', so we don't clear the
    // connection timer here - let 'close' handle it or let it fire if we
    // never connect at all.
    callbacks.onError?.(err)
  })

  ws.on('pong', () => {
    callbacks.onPong?.()
  })

  return ws
}

/**
 * Sends a ping frame to check if the connection is still alive.
 * The WebSocket 'pong' event will fire on the response.
 */
function sendPing(ws) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.ping()
  }
}

/**
 * Sends a message through the WebSocket.
 * Returns true if sent, false if connection wasn't open.
 */
function sendMessage(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(message)
    return true
  }
  return false
}

/**
 * Cleanly closes a WebSocket connection.
 * 
 * Removes all listeners before terminating to prevent spurious events during
 * shutdown - otherwise the 'close' handler might fire and trigger reconnection
 * logic even though we're intentionally closing.
 * 
 * @param {WebSocket} ws - WebSocket instance to close
 */
function closeWebSocket(ws) {
  if (!ws) return

  // Add a no-op error handler before removing listeners and terminating.
  // This prevents "unhandled error" crashes when terminating a socket that's
  // still connecting - terminate() emits an error in that case.
  ws.removeAllListeners()
  ws.on('error', () => {})
  
  // terminate() is immediate; close() initiates graceful handshake which can
  // hang if the remote end is unresponsive. For reliability we prefer immediate.
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
    ws.terminate()
  }
}

module.exports = {
  createWebSocket,
  sendPing,
  sendMessage,
  closeWebSocket,
}