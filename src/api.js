/**
 * @fileoverview HTTP API client for AdIT manager and instance endpoints
 * 
 * @module companion-module-middleman-adit/api
 */
const http = require('http')

/**
 * Makes an HTTP GET request and returns parsed JSON.
 * Centralizes timeout handling, error formatting, and response parsing so the
 * individual fetch functions stay focused on their specific endpoints.
 * 
 * @param {string} url - Full URL to request
 * @param {number} timeout - Max ms to wait before aborting
 * @param {object} headers - Optional HTTP headers
 * @returns {Promise<any>} Parsed JSON response
 */
function httpGet(url, timeout, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = []

      res.on('data', (chunk) => chunks.push(chunk))

      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`))
          return
        }

        try {
          const data = JSON.parse(Buffer.concat(chunks).toString())
          resolve(data)
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url}: ${e.message}`))
        }
      })
    })

    req.on('error', (e) => {
      reject(new Error(`Request failed for ${url}: ${e.message}`))
    })

    req.setTimeout(timeout, () => {
      req.destroy()
      reject(new Error(`Timeout after ${timeout}ms for ${url}`))
    })
  })
}

/**
 * Fetches available channels from the AdIT manager.
 * 
 * @param {string} managerIp - Manager service IP address
 * @param {number} managerPort - Manager service port
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<Array>} Array of channel objects
 */
async function fetchChannels(managerIp, managerPort, timeout) {
  const url = `http://${managerIp}:${managerPort}/channels`
  return httpGet(url, timeout)
}

/**
 * Fetches messaging rules for a channel, filtered to manual rules only.
 * Manual rules (RuleType === 1) are the only ones that can be triggered via
 * the control interface, so we filter here to keep downstream logic simpler.
 * 
 * @param {string} managerIp - Manager service IP address
 * @param {number} managerPort - Manager service port
 * @param {string} channelId - Channel GUID
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<Array>} Array of manual rule objects
 */
async function fetchManualRules(managerIp, managerPort, channelId, timeout) {
  const url = `http://${managerIp}:${managerPort}/channels/${channelId}/messaging-rules`
  const rules = await httpGet(url, timeout)

  return rules.filter((rule) => {
    try {
      const contents = JSON.parse(rule.JSON)
      return contents.RuleType === 1
    } catch {
      return false
    }
  })
}

/**
 * Fetches variable definitions for a channel.
 * 
 * @param {string} managerIp - Manager service IP address
 * @param {number} managerPort - Manager service port
 * @param {string} channelId - Channel GUID
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<Array>} Array of variable definition objects
 */
async function fetchVariables(managerIp, managerPort, channelId, timeout) {
  const url = `http://${managerIp}:${managerPort}/channels/${channelId}/variables`
  return httpGet(url, timeout)
}

/**
 * Fetches instance definitions for a channel.
 * 
 * @param {string} managerIp - Manager service IP address
 * @param {number} managerPort - Manager service port
 * @param {string} channelId - Channel GUID
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<Array>} Array of instance definition objects
 */
async function fetchInstances(managerIp, managerPort, channelId, timeout) {
  const url = `http://${managerIp}:${managerPort}/channels/${channelId}/instances`
  return httpGet(url, timeout)
}

/**
 * Polls an individual instance's status endpoint.
 * Returns only the fields we need for health/primary determination, avoiding
 * tight coupling to the full response schema which includes many fields we
 * don't use (license info, port numbers, feature flags, etc).
 * 
 * @param {string} instanceIp - Instance IP address
 * @param {number} apiPort - Instance API port (typically 8001)
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<{status: number, primary: boolean}>} Health and primary state
 */
async function fetchInstanceStatus(instanceIp, apiPort, timeout) {
  const url = `http://${instanceIp}:${apiPort}/status`
  const headers = { Accept: 'application/json' }
  const data = await httpGet(url, timeout, headers)

  // Status can be nested ({Status: {Status: 3}}) or flat ({Status: 3})
  // depending on endpoint. Handle both to be defensive.
  const status = typeof data.Status === 'object' ? data.Status.Status : data.Status

  return {
    status: status,
    primary: data.Primary === true,
  }
}

module.exports = {
  fetchChannels,
  fetchManualRules,
  fetchVariables,
  fetchInstances,
  fetchInstanceStatus,
}