/**
 * @fileoverview Core orchestration engine for AdIT communication
 * 
 * Manages connections to AdIT manager and instances.
 * Uses a Map-based architecture to prevent closure bugs from the original array-based implementation.
 * 
 * @module companion-module-middleman-adit/engine
 */
const xml2js = require('xml2js')
const api = require('./api')
const websocket = require('./websocket')

// Cache schema version - increment when cache structure changes to invalidate
// old caches automatically rather than risk parsing errors or stale formats
const CACHE_VERSION = 1

// AdIT instance status codes (for reference, used in status polling)
const STATUS_NAMES = {
  0: 'Unknown',
  1: 'LicenseError',
  2: 'Idle',
  3: 'Running',
  4: 'Error',
}

/**
 * Orchestrates connections to AdIT instances and determines which instance
 * is the effective primary for receiving variable updates.
 *
 * Replaces the previous array-based approach with a Map keyed by instance ID,
 * which prevents closure bugs where event handlers captured array indices that
 * became stale when the array was mutated.
 */
class Engine {
  /**
   * @param {object} module - Companion module instance for logging, config, status updates
   * @param {object} constants - Timing constants (timeouts, intervals)
   */
  constructor(module, constants) {
    this.module = module
    this.constants = constants

    // -------------------------------------------------------------------------
    // Instance State
    // -------------------------------------------------------------------------

    // Map<instanceId, InstanceState> - see _createInstanceState for shape
    this.instances = new Map()

    // Sticky primary: we only switch when current primary becomes invalid
    // undefined = never determined, null = determined but none available
    this.effectivePrimaryId = undefined

    // Preserves manager's ordering for deterministic fallback selection
    this.instanceOrder = []

    // -------------------------------------------------------------------------
    // Definition State
    // -------------------------------------------------------------------------

    // Definitions from manager (kept for actions/variables that need the raw data)
    this.channelDefinitions = []
    this.manualRuleDefinitions = []
    this.variableDefinitions = []

    // -------------------------------------------------------------------------
    // Change Detection State
    // -------------------------------------------------------------------------

    // Track last fetched data to detect actual content changes.
    // Using JSON strings allows exact comparison without deep object diffing.
    // This prevents unnecessary initActions() calls when data hasn't changed.
    this.lastChannelId = null
    this.lastRulesJson = null
    this.lastVariablesJson = null

    // Track variable definition count for Companion updates
    this.lastVariableDefCount = 0

    // -------------------------------------------------------------------------
    // Polling Timers
    // -------------------------------------------------------------------------

    this.managerPollTimer = null
    this.statusPollTimer = null
    this.pingTimer = null

    // -------------------------------------------------------------------------
    // Module Status State
    // -------------------------------------------------------------------------

    // Track current module status to avoid duplicate updates
    this.currentStatus = null
    this.currentStatusMessage = null

    // Track manager reachability for logging transitions
    this.managerReachable = null

    // -------------------------------------------------------------------------
    // Cache State
    // -------------------------------------------------------------------------

    // Track whether we've loaded from cache this session to avoid re-logging
    this.loadedFromCache = false

    // Cached channel info for dropdown display when manager is unreachable.
    // Without this, the config dropdown can't resolve the channel ID to a name.
    this.cachedChannelId = null
    this.cachedChannelName = null

    // -------------------------------------------------------------------------
    // Engine State
    // -------------------------------------------------------------------------

    this.running = false
  }

  // ---------------------------------------------------------------------------
  // Lifecycle Methods
  // ---------------------------------------------------------------------------

  /**
   * Starts the engine after configuration is valid.
   * Begins polling the manager for definitions and instances for health status.
   */
  async start() {
    if (this.running) return
    this.running = true

    if (this.module.config.verbose) {
      this._log('debug', 'Engine starting')
    }

    // Initial fetch before starting intervals
    await this._pollManager()

    // Poll instance statuses immediately to elect primary before WebSockets
    // finish connecting and start sending variable updates
    await this._pollInstanceStatuses()

    // Manager poll: fetch instance definitions, diff, update connections
    this.managerPollTimer = setInterval(
      () => this._pollManager(),
      this.constants.MANAGER_POLL_INTERVAL
    )

    // Instance status poll: check health/primary state of each instance
    this.statusPollTimer = setInterval(
      () => this._pollInstanceStatuses(),
      this.constants.INSTANCE_STATUS_POLL_INTERVAL
    )

    // Ping loop: primary liveness check for WebSocket connections
    this.pingTimer = setInterval(
      () => this._sendPings(),
      this.constants.WEBSOCKET_PING_INTERVAL
    )
  }

  /**
   * Stops all polling and closes all connections.
   * Safe to call multiple times.
   */
  stop() {
    if (!this.running) return
    this.running = false

    if (this.module.config.verbose) {
      this._log('debug', 'Engine stopping')
    }

    // Clear polling timers
    if (this.managerPollTimer) {
      clearInterval(this.managerPollTimer)
      this.managerPollTimer = null
    }

    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer)
      this.statusPollTimer = null
    }

    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }

    // Close all instance connections and clear state
    for (const [instanceId] of this.instances) {
      this._closeInstanceConnection(instanceId)
    }
    this.instances.clear()

    // Reset all state
    this.effectivePrimaryId = undefined
    this.instanceOrder = []
    this.currentStatus = null
    this.currentStatusMessage = null
    this.lastVariableDefCount = 0
    this.managerReachable = null
    this.loadedFromCache = false
    this.cachedChannelId = null
    this.cachedChannelName = null
    this.lastChannelId = null
    this.lastRulesJson = null
    this.lastVariablesJson = null
  }

  // ---------------------------------------------------------------------------
  // Public Methods (called by index.js and actions.js)
  // ---------------------------------------------------------------------------

  /**
   * Sends a message to all connected instances.
   * Used by actions to broadcast commands (set variable, trigger rule).
   *
   * @param {string} message - XML message to send
   */
  sendToAllInstances(message) {
    for (const [, state] of this.instances) {
      if (state.wsState === 'connected') {
        const sent = websocket.sendMessage(state.ws, message)
        if (sent && this.module.config.verbose) {
          this._log('debug', `Sent message to ${this._fmtInstance(state)}`)
        }
      }
    }
  }

  /**
   * Returns the current effective primary instance ID, or null if none.
   */
  getEffectivePrimaryId() {
    return this.effectivePrimaryId ?? null
  }

  /**
   * Returns definitions for use by actions.js and other modules.
   */
  getManualRuleDefinitions() {
    return this.manualRuleDefinitions
  }

  getVariableDefinitions() {
    return this.variableDefinitions
  }

  getChannelDefinitions() {
    return this.channelDefinitions
  }

  /**
   * Returns whether the manager is currently reachable.
   * null = never attempted, true = reachable, false = unreachable
   */
  isManagerReachable() {
    return this.managerReachable
  }

  /**
   * Returns cached channel info for dropdown display when manager is unreachable.
   * Without this, the config UI shows raw GUIDs instead of channel names.
   *
   * @returns {{id: string, name: string}|null} Cached channel info or null
   */
  getCachedChannelInfo() {
    if (this.cachedChannelId) {
      return { id: this.cachedChannelId, name: this.cachedChannelName }
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Formatting Helpers
  // ---------------------------------------------------------------------------

  /**
   * Formats an instance for log messages: 'Name' (id)
   * Includes both name and ID since names can change and aren't always descriptive.
   *
   * @param {object} state - InstanceState object (or object with name and id properties)
   * @returns {string} Formatted instance identifier
   */
  _fmtInstance(state) {
    return `'${state.name}' (${state.id})`
  }

  /**
   * Formats an instance from raw manager data (before state object exists).
   *
   * @param {object} inst - Instance definition from manager API
   * @returns {string} Formatted instance identifier
   */
  _fmtInstanceDef(inst) {
    return `'${inst.Name}' (${inst.ID})`
  }

  // ---------------------------------------------------------------------------
  // Definition Cache (Persistence)
  // ---------------------------------------------------------------------------

  /**
   * Loads and validates the definition cache from config.
   * Returns null if cache is missing, invalid, or doesn't match current config.
   *
   * Cache is invalidated when manager IP or channel ID changes because the
   * definitions from a different manager or channel would be incorrect.
   *
   * @returns {object|null} Valid cache object or null
   */
  _loadCache() {
    const config = this.module.config

    if (!config.definition_cache) {
      return null
    }

    let cache
    try {
      cache = JSON.parse(config.definition_cache)
    } catch (err) {
      this._log('warn', `Definition cache corrupted, ignoring: ${err.message}`)
      this._clearCache()
      return null
    }

    // Validate cache version to handle schema changes across module updates
    if (cache.version !== CACHE_VERSION) {
      if (this.module.config.verbose) {
        this._log('debug', `Cache version mismatch (have ${cache.version}, need ${CACHE_VERSION}), ignoring`)
      }
      this._clearCache()
      return null
    }

    // Validate cache matches current configuration - definitions from a different
    // manager or channel would be incorrect and potentially cause failures
    if (cache.managerIp !== config.manager_ip) {
      if (this.module.config.verbose) {
        this._log('debug', `Cache manager IP mismatch, ignoring`)
      }
      this._clearCache()
      return null
    }

    if (cache.channelId !== config.channel) {
      if (this.module.config.verbose) {
        this._log('debug', `Cache channel ID mismatch, ignoring`)
      }
      this._clearCache()
      return null
    }

    // Validate required data exists
    if (!cache.instancesJson || !cache.variablesJson || !cache.rulesJson) {
      if (this.module.config.verbose) {
        this._log('debug', `Cache missing required data, ignoring`)
      }
      this._clearCache()
      return null
    }

    return cache
  }

  /**
   * Saves definition data to cache if it has changed.
   * Compares raw JSON strings to detect changes, avoiding unnecessary config writes.
   *
   * @param {string} instancesJson - Raw JSON string from instances endpoint
   * @param {string} variablesJson - Raw JSON string from variables endpoint
   * @param {string} rulesJson - Raw JSON string from rules endpoint
   * @param {string} channelName - Human-readable channel name for reference
   */
  _saveCache(instancesJson, variablesJson, rulesJson, channelName) {
    const config = this.module.config
    const existingCache = this._loadCache()

    // Check if data actually changed to avoid excessive config writes
    if (existingCache &&
        existingCache.instancesJson === instancesJson &&
        existingCache.variablesJson === variablesJson &&
        existingCache.rulesJson === rulesJson) {
      return // No changes
    }

    const cache = {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      managerIp: config.manager_ip,
      channelId: config.channel,
      channelName: channelName,
      instancesJson: instancesJson,
      variablesJson: variablesJson,
      rulesJson: rulesJson,
    }

    config.definition_cache = JSON.stringify(cache)
    this.module.saveConfig(config)

    if (this.module.config.verbose) {
      this._log('debug', `Definition cache updated`)
    }
  }

  /**
   * Clears the definition cache.
   * Called when cache is detected as invalid or corrupted.
   */
  _clearCache() {
    const config = this.module.config
    if (config.definition_cache && config.definition_cache !== '{}') {
      config.definition_cache = '{}'
      this.module.saveConfig(config)
    }
  }

  /**
   * Formats a cache timestamp as a human-readable age string.
   *
   * @param {number} timestamp - Unix timestamp in milliseconds
   * @returns {string} Human-readable age (e.g., "2 hours ago", "3 days ago")
   */
  _formatCacheAge(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000)

    if (seconds < 60) {
      return 'just now'
    }

    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) {
      return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
    }

    const hours = Math.floor(minutes / 60)
    if (hours < 24) {
      return hours === 1 ? '1 hour ago' : `${hours} hours ago`
    }

    const days = Math.floor(hours / 24)
    return days === 1 ? '1 day ago' : `${days} days ago`
  }

  /**
   * Attempts to load definitions from cache when manager is unreachable.
   * Only called on cold start when we have no instance data.
   */
  _tryLoadFromCache() {
    const cache = this._loadCache()
    if (!cache) {
      return
    }

    try {
      const instances = JSON.parse(cache.instancesJson)
      const variables = JSON.parse(cache.variablesJson)
      const rules = JSON.parse(cache.rulesJson)

      // Store cached channel info so getChannelChoices() can display the name
      // in the dropdown instead of showing a raw GUID or error message
      this.cachedChannelId = cache.channelId
      this.cachedChannelName = cache.channelName || cache.channelId

      this.loadedFromCache = true

      // Log cache usage before syncing instances so the log reads in logical order:
      // "using cached definitions" then "instance discovered"
      const age = this._formatCacheAge(cache.timestamp)
      const channelLabel = cache.channelName || cache.channelId
      this._log('info', `Manager unreachable, using cached definitions for '${channelLabel}' (cached ${age})`)

      this.manualRuleDefinitions = rules
      this.variableDefinitions = variables
      this._syncInstances(instances)

      // Update change tracking state to match cached data
      this.lastChannelId = cache.channelId
      this.lastRulesJson = cache.rulesJson
      this.lastVariablesJson = cache.variablesJson

      // Register variable definitions with Companion so button text variables resolve
      this._updateModuleVariableDefinitions()

      // Refresh action definitions with cached data
      this.module.initActions()

    } catch (err) {
      this._log('warn', `Failed to parse cached definitions: ${err.message}`)
      this._clearCache()
    }
  }

  // ---------------------------------------------------------------------------
  // Manager Polling
  // ---------------------------------------------------------------------------

  /**
   * Fetches current definitions from the manager.
   *
   * Always attempts to fetch channels (needed for config dropdown).
   * Only fetches instances/rules/variables when a channel is selected.
   * On manager failure, falls back to cached definitions if available on cold
   * start, otherwise preserves existing instance state for continued operation.
   */
  async _pollManager() {
    const config = this.module.config
    if (!config.manager_ip) return

    const hasChannel = config.channel && config.channel !== 'none'
    const channelChanged = config.channel !== this.lastChannelId

    // Always try to fetch channels for the dropdown
    try {
      const channels = await api.fetchChannels(
        config.manager_ip,
        config.manager_port,
        this.constants.HTTP_MANAGER_TIMEOUT
      )
      this.channelDefinitions = channels

      // Log on connection established or restored
      if (this.managerReachable === null) {
        this._log('info', `Connected to manager at ${config.manager_ip}:${config.manager_port}`)
      } else if (this.managerReachable === false) {
        this._log('info', `Manager connection restored`)
      }
      this.managerReachable = true

      // Clear cached channel info since we have live data now
      this.cachedChannelId = null
      this.cachedChannelName = null

      if (this.module.config.verbose) {
        this._log('debug', `Fetched ${channels.length} channels from manager`)
      }
    } catch (err) {
      // Log on transition to unreachable
      if (this.managerReachable !== false) {
        this._log('warn', `Manager unreachable: ${err.message}`)
      }
      this.managerReachable = false

      // On cold start with no data, try to load from cache
      if (hasChannel && this.instances.size === 0 && !this.loadedFromCache) {
        this._tryLoadFromCache()
      }
    }

    // Only fetch channel-specific data if manager is reachable and channel selected
    if (!this.managerReachable || !hasChannel) {
      this._updateModuleStatus()
      return
    }

    // Fetch instances, rules, and variables for the selected channel
    let fetchedInstances = null
    let instancesJson = null
    let variablesJson = null
    let rulesJson = null

    try {
      const [rulesResponse, variablesResponse, instancesResponse] = await Promise.all([
        this._fetchWithJson(
          api.fetchManualRules,
          config.manager_ip, config.manager_port, config.channel, this.constants.HTTP_MANAGER_TIMEOUT
        ),
        this._fetchWithJson(
          api.fetchVariables,
          config.manager_ip, config.manager_port, config.channel, this.constants.HTTP_MANAGER_TIMEOUT
        ),
        this._fetchWithJson(
          api.fetchInstances,
          config.manager_ip, config.manager_port, config.channel, this.constants.HTTP_MANAGER_TIMEOUT
        ),
      ])

      const rules = rulesResponse.data
      const variables = variablesResponse.data
      const instances = instancesResponse.data

      rulesJson = rulesResponse.json
      variablesJson = variablesResponse.json
      instancesJson = instancesResponse.json

      // Detect actual content changes using JSON comparison rather than just
      // counting items. This ensures we catch changes like renamed variables
      // or modified rules, not just additions/deletions.
      const rulesChanged = rulesJson !== this.lastRulesJson
      const varsChanged = variablesJson !== this.lastVariablesJson

      this.manualRuleDefinitions = rules
      this.variableDefinitions = variables
      fetchedInstances = instances

      if (this.module.config.verbose) {
        this._log('debug', `Fetched ${rules.length} rules, ${variables.length} variables, ${instances.length} instances`)
      }

      // Refresh action definitions if content changed or channel switched.
      // Channel changes require refresh even if data looks similar because
      // the GUIDs are different between channels.
      if (rulesChanged || varsChanged || channelChanged) {
        this.module.initActions()
      }

      // Update change tracking state after successful fetch
      this.lastChannelId = config.channel
      this.lastRulesJson = rulesJson
      this.lastVariablesJson = variablesJson

      // Save to cache for offline operation
      const channelName = this._getChannelName(config.channel)
      this._saveCache(instancesJson, variablesJson, rulesJson, channelName)

    } catch (err) {
      // Manager became unreachable between channels fetch and this fetch,
      // or channels succeeded but this failed - only log if we have connections to preserve
      if (this.instances.size > 0 && this.managerReachable) {
        this._log('warn', `Manager unreachable, maintaining ${this.instances.size} existing connections`)
        this.managerReachable = false
      }

      // On cold start with no data, try to load from cache
      if (this.instances.size === 0 && !this.loadedFromCache) {
        this._tryLoadFromCache()
      }
    }

    // Sync instances if we got new data
    if (fetchedInstances) {
      this._syncInstances(fetchedInstances)
    }

    this._updateModuleVariableDefinitions()
    this._updateModuleStatus()
  }

  /**
   * Wraps an API fetch function to also return the raw JSON string.
   * Needed for cache comparison without re-serializing (which could change key order).
   *
   * @param {Function} fetchFn - The API fetch function to wrap
   * @param  {...any} args - Arguments to pass to the fetch function
   * @returns {Promise<{data: any, json: string}>} Parsed data and original JSON
   */
  async _fetchWithJson(fetchFn, ...args) {
    // For rules, we need special handling since fetchManualRules filters the data
    // We'll store the filtered result's JSON, not the raw response
    const data = await fetchFn(...args)
    const json = JSON.stringify(data)
    return { data, json }
  }

  /**
   * Gets the channel name for the given channel ID from current definitions.
   *
   * @param {string} channelId - Channel GUID
   * @returns {string} Channel name or empty string if not found
   */
  _getChannelName(channelId) {
    const channel = this.channelDefinitions.find(c => c.ID === channelId)
    return channel?.Name ?? ''
  }

  // ---------------------------------------------------------------------------
  // Instance Synchronization
  // ---------------------------------------------------------------------------

  /**
   * Synchronizes our instance Map with the list from the manager.
   * Opens connections for new instances, closes for removed ones,
   * updates metadata for existing ones without touching their connections.
   *
   * @param {Array} managerInstances - Instance definitions from manager API
   */
  _syncInstances(managerInstances) {
    const managerIds = new Set(managerInstances.map((i) => i.ID))

    // Remove instances no longer in manager's list
    for (const [instanceId, state] of this.instances) {
      if (!managerIds.has(instanceId)) {
        this._log('info', `Instance removed from channel: ${this._fmtInstance(state)}`)
        this._closeInstanceConnection(instanceId)
        this.instances.delete(instanceId)
      }
    }

    // Add new instances or update existing metadata
    for (const inst of managerInstances) {
      if (!this.instances.has(inst.ID)) {
        // New instance
        this._log('info', `Instance discovered: ${this._fmtInstanceDef(inst)} at ${inst.IPAddress}:${inst.ControlInterfacePortNumber}`)
        const state = this._createInstanceState(inst)
        this.instances.set(inst.ID, state)
        this._openInstanceConnection(inst.ID)
      } else {
        // Existing instance: update metadata only (name, description could change)
        const state = this.instances.get(inst.ID)
        state.name = inst.Name
        state.description = inst.Description
        state.ip = inst.IPAddress
        state.apiPort = inst.APIPortNumber
        state.controlPort = inst.ControlInterfacePortNumber
      }
    }

    // Store manager's ordering for primary fallback selection
    this.instanceOrder = managerInstances.map((i) => i.ID)
  }

  /**
   * Creates initial state object for a new instance.
   *
   * @param {object} inst - Instance definition from manager
   * @returns {object} InstanceState object
   */
  _createInstanceState(inst) {
    return {
      id: inst.ID,
      name: inst.Name,
      description: inst.Description,
      ip: inst.IPAddress,
      apiPort: inst.APIPortNumber,
      controlPort: inst.ControlInterfacePortNumber,

      // Health state (determined by WebSocket connectivity)
      healthy: false,

      // Primary designation (from HTTP polling)
      primary: false,
      lastStatus: null,
      lastStatusPoll: 0,
      statusPollFailures: 0,

      // WebSocket state
      ws: null,
      wsState: 'disconnected',
      reconnectTimer: null,
      pendingPong: false,
      pongTimer: null,
    }
  }

  // ---------------------------------------------------------------------------
  // Instance Status Polling
  // ---------------------------------------------------------------------------

  /**
   * Polls each instance's /status endpoint to get authoritative primary
   * designation. Health is determined by WebSocket connectivity, not HTTP.
   */
  async _pollInstanceStatuses() {
    // Nothing to poll if no instances configured
    if (this.instances.size === 0) return

    const pollPromises = []

    for (const [instanceId, state] of this.instances) {
      pollPromises.push(this._pollSingleInstanceStatus(instanceId, state))
    }

    await Promise.all(pollPromises)

    this._determinePrimary()
    this._updateModuleStatus()
    this._updateInstanceVariables()
  }

  /**
   * Polls a single instance's status endpoint and updates its primary designation.
   * Health state is determined by WebSocket connectivity, not HTTP polling.
   * HTTP polling only provides AdIT's authoritative primary designation.
   *
   * @param {string} instanceId - Instance GUID
   * @param {object} state - InstanceState object
   */
  async _pollSingleInstanceStatus(instanceId, state) {
    try {
      const result = await api.fetchInstanceStatus(
        state.ip,
        state.apiPort,
        this.constants.HTTP_INSTANCE_STATUS_TIMEOUT
      )

      // Log recovery from HTTP poll failures
      if (state.statusPollFailures > 0) {
        this._log('info', `${this._fmtInstance(state)} status endpoint recovered`)
      }

      state.primary = result.primary
      state.lastStatus = result.status
      state.lastStatusPoll = Date.now()
      state.statusPollFailures = 0
    } catch (err) {
      state.statusPollFailures++

      // Only log on first failure to avoid spam
      if (state.statusPollFailures === 1) {
        this._log('warn', `${this._fmtInstance(state)} status endpoint unreachable: ${err.message}`)
      }

      // Don't affect health state or WebSocket - HTTP poll is only for primary designation
      // Keep last known primary designation until we can poll again
    }
  }

  // ---------------------------------------------------------------------------
  // Primary Determination
  // ---------------------------------------------------------------------------

  /**
   * Determines which instance should be treated as primary.
   *
   * Uses sticky logic: keeps current primary if still healthy and reporting primary,
   * only switches when necessary. This prevents unnecessary flapping and provides
   * predictable behavior during split-brain scenarios.
   */
  _determinePrimary() {
    const currentPrimary = this.effectivePrimaryId
      ? this.instances.get(this.effectivePrimaryId)
      : null

    // Sticky: keep current if still valid (healthy AND reporting primary)
    if (currentPrimary && currentPrimary.healthy && currentPrimary.primary) {
      this._checkSplitBrain(currentPrimary)
      return
    }

    // Also sticky: keep current if healthy, even if not reporting primary,
    // as long as no other instance is reporting primary. This prevents
    // log spam when an instance is healthy but hasn't elected itself primary.
    const healthyInstances = this._getHealthyInstancesInOrder()
    const reportingPrimary = healthyInstances.filter((s) => s.primary)

    if (currentPrimary && currentPrimary.healthy && reportingPrimary.length === 0) {
      // Current is healthy, no one else is claiming primary - keep it
      return
    }

    // Need to select new primary
    let newPrimary = null
    let selectionReason = null

    if (reportingPrimary.length >= 1) {
      newPrimary = reportingPrimary[0]
      if (reportingPrimary.length > 1) {
        const names = reportingPrimary.map((s) => this._fmtInstance(s)).join(', ')
        this._log('error', `Split-brain: ${names} all report primary. Selecting ${this._fmtInstance(newPrimary)}`)
      }
    } else if (healthyInstances.length > 0) {
      newPrimary = healthyInstances[0]
      selectionReason = 'fallback'
    }

    const newPrimaryId = newPrimary?.id ?? null

    // Only log on actual state transitions
    if (newPrimaryId !== this.effectivePrimaryId) {
      const oldLabel = currentPrimary ? this._fmtInstance(currentPrimary) : 'none'
      const newLabel = newPrimary ? this._fmtInstance(newPrimary) : 'none'

      if (newPrimary) {
        if (selectionReason === 'fallback') {
          this._log('warn', `No instance reporting primary. Falling back to ${newLabel}`)
        }
        this._log('info', `Primary changed: ${oldLabel} -> ${newLabel}`)
      } else {
        // Transitioning to no primary - include diagnostic info
        const summary = this._getInstanceStatusSummary()
        this._log('error', `No healthy instances available (${summary})`)
      }

      this.effectivePrimaryId = newPrimaryId
      this._logVariableSnapshot()
    }
  }

  /**
   * Checks for split-brain condition when we already have a valid primary.
   * Logs error but doesn't switch, maintaining stability.
   *
   * @param {object} currentPrimary - Current primary's InstanceState
   */
  _checkSplitBrain(currentPrimary) {
    const others = []
    for (const [id, state] of this.instances) {
      if (id !== currentPrimary.id && state.healthy && state.primary) {
        others.push(state)
      }
    }

    if (others.length > 0) {
      const otherLabels = others.map((s) => this._fmtInstance(s)).join(', ')
      this._log('error', `Split-brain: ${this._fmtInstance(currentPrimary)} and ${otherLabels} all report primary. Staying with ${this._fmtInstance(currentPrimary)}`)
    }
  }

  /**
   * Returns healthy instances in manager list order.
   * Order matters for deterministic fallback selection.
   */
  _getHealthyInstancesInOrder() {
    const result = []
    for (const id of this.instanceOrder || []) {
      const state = this.instances.get(id)
      if (state && state.healthy) {
        result.push(state)
      }
    }
    return result
  }

  /**
   * Builds a human-readable summary of instance statuses for diagnostics.
   */
  _getInstanceStatusSummary() {
    const parts = []
    for (const [, state] of this.instances) {
      const connStatus = state.healthy ? 'connected' : 'disconnected'
      parts.push(`${this._fmtInstance(state)} ${connStatus}`)
    }

    if (parts.length === 0) {
      return '0 instances registered'
    }

    return `${parts.length} registered: ${parts.join(', ')}`
  }

  /**
   * Logs current primary info when primary changes.
   * Only logs at debug level behind verbose flag.
   */
  _logVariableSnapshot() {
    if (!this.module.config.verbose) return

    const primary = this.effectivePrimaryId
      ? this.instances.get(this.effectivePrimaryId)
      : null

    if (primary) {
      this._log('debug', `Now receiving variable updates from ${this._fmtInstance(primary)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket Management
  // ---------------------------------------------------------------------------

  /**
   * Opens a WebSocket connection to an instance.
   * Callbacks are bound to this engine with the instanceId captured by value
   * (not by array index) to prevent stale reference bugs.
   *
   * @param {string} instanceId - Instance GUID
   */
  _openInstanceConnection(instanceId) {
    const state = this.instances.get(instanceId)
    if (!state) return

    if (state.wsState !== 'disconnected') {
      return // Already connecting or connected
    }

    const url = `ws://${state.ip}:${state.controlPort}/${this.module.config.control_interface_id}`
    state.wsState = 'connecting'

    // Capture instanceId by value in callbacks - this is the key fix for the
    // original closure bug where array indices went stale
    const callbacks = {
      onOpen: () => this._handleWsOpen(instanceId),
      onClose: (code, reason) => this._handleWsClose(instanceId, code, reason),
      onMessage: (data) => this._handleWsMessage(instanceId, data),
      onError: (err) => this._handleWsError(instanceId, err),
      onPong: () => this._handleWsPong(instanceId),
    }

    state.ws = websocket.createWebSocket(
      url,
      this.constants.WEBSOCKET_CONNECT_TIMEOUT,
      callbacks
    )
  }

  /**
   * Closes an instance's WebSocket connection and clears associated timers.
   * Does not remove the instance from the Map - that's handled by _syncInstances.
   *
   * @param {string} instanceId - Instance GUID
   */
  _closeInstanceConnection(instanceId) {
    const state = this.instances.get(instanceId)
    if (!state) return

    // Clear any pending reconnect
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }

    // Clear pong timeout
    if (state.pongTimer) {
      clearTimeout(state.pongTimer)
      state.pongTimer = null
    }
    state.pendingPong = false

    // Close the WebSocket
    if (state.ws) {
      websocket.closeWebSocket(state.ws)
      state.ws = null
    }

    state.wsState = 'disconnected'
  }

  /**
   * Schedules a reconnection attempt after the configured delay.
   * Only one reconnect can be pending per instance to prevent accumulation.
   *
   * @param {string} instanceId - Instance GUID
   */
  _scheduleReconnect(instanceId) {
    const state = this.instances.get(instanceId)
    if (!state) return

    // Don't schedule if engine is stopped or reconnect already pending
    if (!this.running || state.reconnectTimer) return

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null

      // Check instance still exists and engine still running
      if (!this.running || !this.instances.has(instanceId)) return

      this._openInstanceConnection(instanceId)
    }, this.constants.RECONNECT_DELAY)
  }

  // ---------------------------------------------------------------------------
  // WebSocket Event Handlers
  // ---------------------------------------------------------------------------

  _handleWsOpen(instanceId) {
    const state = this.instances.get(instanceId)
    if (!state) return

    const wasReconnect = state.wsState === 'connecting' && !state.healthy
    state.wsState = 'connected'
    state.healthy = true

    if (wasReconnect) {
      this._log('info', `Reconnected to ${this._fmtInstance(state)}`)
    } else {
      this._log('info', `Connected to ${this._fmtInstance(state)}`)
    }

    this._updateModuleStatus()
  }

  _handleWsClose(instanceId, code, reason) {
    const state = this.instances.get(instanceId)
    if (!state) return

    const wasConnected = state.wsState === 'connected'
    state.wsState = 'disconnected'
    state.ws = null
    state.healthy = false

    // Clear pong state
    if (state.pongTimer) {
      clearTimeout(state.pongTimer)
      state.pongTimer = null
    }
    state.pendingPong = false

    // Only log unexpected disconnections (not during shutdown or forced close)
    if (wasConnected && this.running) {
      this._log('warn', `Disconnected from ${this._fmtInstance(state)} (code: ${code})`)
    }

    this._scheduleReconnect(instanceId)
    this._determinePrimary()
    this._updateModuleStatus()
  }

  _handleWsError(instanceId, err) {
    const state = this.instances.get(instanceId)
    if (!state) return

    // Only log errors at debug level - the close event will handle the important logging
    if (this.module.config.verbose) {
      this._log('debug', `WebSocket error for ${this._fmtInstance(state)}: ${err.message}`)
    }

    // Error is usually followed by close event, which handles reconnection
  }

  /**
   * Handles incoming WebSocket messages.
   * Only applies variable updates from the effective primary - updates from
   * other instances are logged but ignored to prevent inconsistent state.
   *
   * @param {string} instanceId - Instance GUID
   * @param {Buffer|string} data - Raw message data
   */
  _handleWsMessage(instanceId, data) {
    const state = this.instances.get(instanceId)
    if (!state) return

    if (this.module.config.verbose) {
      this._log('debug', `Message from ${this._fmtInstance(state)}: ${data}`)
    }

    xml2js.parseString(data.toString(), (err, result) => {
      if (err) {
        this._log('debug', `Failed to parse message from ${this._fmtInstance(state)}: ${err.message}`)
        return
      }

      if (result.Variable) {
        this._handleVariableUpdate(instanceId, result.Variable)
      }
      // Other message types can be added here as needed
    })
  }

  /**
   * Processes a variable update from an instance.
   * Only applies the value if it came from the effective primary.
   *
   * @param {string} instanceId - Instance GUID
   * @param {object} variable - Parsed Variable element
   */
  _handleVariableUpdate(instanceId, variable) {
    const variableId = variable.$.ID
    const value = variable._

    if (instanceId === this.effectivePrimaryId) {
      this.module.setVariableValues({ [variableId]: value })

      if (this.module.config.verbose) {
        const state = this.instances.get(instanceId)
        this._log('debug', `Applied variable ${variableId} = ${value} from ${this._fmtInstance(state)}`)
      }
    } else if (this.module.config.verbose) {
      const state = this.instances.get(instanceId)
      this._log('debug', `Ignored variable ${variableId} from non-primary ${this._fmtInstance(state)}`)
    }
  }

  _handleWsPong(instanceId) {
    const state = this.instances.get(instanceId)
    if (!state) return

    state.pendingPong = false
    if (state.pongTimer) {
      clearTimeout(state.pongTimer)
      state.pongTimer = null
    }
  }

  // ---------------------------------------------------------------------------
  // Ping/Pong Heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Sends pings to all connected WebSockets.
   * Primary liveness check for detecting silent connection death.
   */
  _sendPings() {
    for (const [instanceId, state] of this.instances) {
      if (state.wsState !== 'connected' || !state.ws) continue

      // If we're still waiting for a pong from the last ping, connection is dead
      if (state.pendingPong) {
        this._log('warn', `Pong timeout for ${this._fmtInstance(state)}, closing connection`)
        this._closeInstanceConnection(instanceId)
        state.healthy = false
        this._scheduleReconnect(instanceId)
        this._determinePrimary()
        this._updateModuleStatus()
        continue
      }

      websocket.sendPing(state.ws)
      state.pendingPong = true

      // Set timeout for pong response
      state.pongTimer = setTimeout(() => {
        if (state.pendingPong && this.instances.has(instanceId)) {
          this._log('warn', `Pong timeout for ${this._fmtInstance(state)}, closing connection`)
          this._closeInstanceConnection(instanceId)
          state.healthy = false
          this._scheduleReconnect(instanceId)
          this._determinePrimary()
          this._updateModuleStatus()
        }
      }, this.constants.WEBSOCKET_PONG_TIMEOUT)
    }
  }

  // ---------------------------------------------------------------------------
  // Module Integration
  // ---------------------------------------------------------------------------

  /**
   * Updates Companion's module status based on current state.
   * Builds a compound status message when multiple issues exist.
   * Uses 'disconnected' (red) when both manager and instances are unreachable.
   * Only calls module.updateStatus when status actually changes to prevent log spam.
   */
  _updateModuleStatus() {
    const config = this.module.config
    const hasChannel = config.channel && config.channel !== 'none'

    // Collect all current issues
    const issues = []
    let managerDown = false
    let instancesDown = false

    // Check manager reachability
    if (!this.managerReachable) {
      issues.push('Unable to reach manager')
      managerDown = true
    }

    // Check channel selection (only if manager is up)
    if (this.managerReachable && !hasChannel) {
      issues.push('No channel selected')
    }

    // Check instance states (only if we have a channel)
    if (hasChannel) {
      if (this.instances.size === 0) {
        issues.push('No instances registered for channel')
      } else {
        // Count connected instances
        let connectedCount = 0
        for (const [, state] of this.instances) {
          if (state.wsState === 'connected') connectedCount++
        }

        const primary = this.effectivePrimaryId
          ? this.instances.get(this.effectivePrimaryId)
          : null

        if (connectedCount === 0) {
          issues.push('No instances connected')
          instancesDown = true
        } else if (!primary) {
          issues.push('No primary instance')
        }

        // Update instance-related variables when we have a channel
        this.module.setVariableValues({
          instances_connected: connectedCount,
          primary_instance_id: primary?.id ?? '',
          primary_instance_name: primary?.name ?? '',
        })
      }
    }

    // Determine status level and message
    let newStatus, newMessage

    if (issues.length === 0) {
      // All good
      const primary = this.instances.get(this.effectivePrimaryId)
      newStatus = 'ok'
      newMessage = `Primary: ${this._fmtInstance(primary)}`
    } else if (managerDown && instancesDown) {
      // Both manager and instances down - red disconnected
      newStatus = 'disconnected'
      newMessage = issues.join('\n')
    } else {
      // Single issue or non-critical combination - yellow warning
      newStatus = 'warning'
      newMessage = issues.join('\n')
    }

    // Only update if status or message changed
    if (newStatus !== this.currentStatus || newMessage !== this.currentStatusMessage) {
      this.currentStatus = newStatus
      this.currentStatusMessage = newMessage
      this.module.updateStatus(newStatus, newMessage)
    }
  }

  /**
   * Updates Companion variables for each instance's state.
   */
  _updateInstanceVariables() {
    const values = {}
    let index = 1

    for (const id of this.instanceOrder || []) {
      const state = this.instances.get(id)
      if (!state) continue

      values[`instance_${index}_id`] = state.id
      values[`instance_${index}_name`] = state.name
      values[`instance_${index}_description`] = state.description ?? ''
      values[`instance_${index}_ip_address`] = state.ip
      values[`instance_${index}_port_number`] = state.controlPort
      values[`instance_${index}_connected`] = state.wsState === 'connected' ? 'True' : 'False'
      values[`instance_${index}_primary`] = state.id === this.effectivePrimaryId ? 'True' : 'False'

      index++
    }

    values.instances_registered = this.instances.size
    this.module.setVariableValues(values)
  }

  /**
   * Updates Companion variable definitions when variable list changes.
   * Only logs and updates when the definition count actually changes.
   */
  _updateModuleVariableDefinitions() {
    const defs = [
      { variableId: 'primary_instance_id', name: 'Primary Instance ID' },
      { variableId: 'primary_instance_name', name: 'Primary Instance Name' },
      { variableId: 'instances_connected', name: 'Number of Connected Instances' },
      { variableId: 'instances_registered', name: 'Number of Registered Instances' },
    ]

    // Instance variables
    let index = 1
    for (const id of this.instanceOrder || []) {
      const state = this.instances.get(id)
      if (!state) continue

      defs.push({ variableId: `instance_${index}_id`, name: `Instance ${index} ID` })
      defs.push({ variableId: `instance_${index}_name`, name: `Instance ${index} Name` })
      defs.push({ variableId: `instance_${index}_description`, name: `Instance ${index} Description` })
      defs.push({ variableId: `instance_${index}_ip_address`, name: `Instance ${index} IP Address` })
      defs.push({ variableId: `instance_${index}_port_number`, name: `Instance ${index} Port Number` })
      defs.push({ variableId: `instance_${index}_connected`, name: `Instance ${index} Connected` })
      defs.push({ variableId: `instance_${index}_primary`, name: `Instance ${index} Primary` })

      index++
    }

    // AdIT variables from manager
    for (const v of this.variableDefinitions) {
      defs.push({ variableId: v.ID, name: v.Name })
    }

    // Only update and log if count changed
    if (defs.length !== this.lastVariableDefCount) {
      this.lastVariableDefCount = defs.length
      this.module.setVariableDefinitions(defs)
      this._log('info', `Variable definitions updated (${defs.length} variables)`)
    }
  }

  /**
   * Logs a message through the module's logging system.
   *
   * @param {'debug'|'info'|'warn'|'error'} level - Log level
   * @param {string} message - Message to log
   */
  _log(level, message) {
    this.module.log(level, message)
  }
}

module.exports = Engine