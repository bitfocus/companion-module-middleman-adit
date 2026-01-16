/**
 * @fileoverview Middleman AdIT Control Module for Bitfocus Companion
 * 
 * This module enables control of Middleman Software's AdIT for SCTE 104/35
 * messaging. It provides actions for triggering messaging rules and setting variable values, 
 * with support for multi-instance failover and continued operation with an offline manager.
 * 
 * Architecture:
 * - index.js: Module lifecycle, configuration management, Companion integration
 * - engine.js: Instance orchestration, primary election, definition caching
 * - websocket.js: WebSocket connection management (connect, ping, send, close)
 * - api.js: HTTP API calls to manager and instance endpoints
 * - actions.js: Companion action definitions (set variable, evaluate rule)
 * - feedbacks.js: Companion feedback definitions
 * - variables.js: Companion variable definitions
 * - presets.js: Companion preset definitions
 * - config.js: Module configuration fields
 * - upgrades.js: Configuration migration scripts
 * 
 * @module companion-module-middleman-adit
 * @author James Heliker
 * @see {@link https://github.com/bitfocus/companion-module-middleman-adit}
 */
const { InstanceBase, InstanceStatus, runEntrypoint } = require('@companion-module/base')
const { v4: uuidv4 } = require('uuid')

const UpgradeScripts = require('./src/upgrades')
const config = require('./src/config')
const actions = require('./src/actions')
const feedbacks = require('./src/feedbacks')
const variables = require('./src/variables')
const presets = require('./src/presets')
const Engine = require('./src/engine')

/**
 * Timing constants for network operations.
 * Centralized here for visibility and tuning.
 * 
 * @constant {Object}
 * @property {number} HTTP_MANAGER_TIMEOUT - Timeout for manager API requests (ms)
 * @property {number} HTTP_INSTANCE_STATUS_TIMEOUT - Timeout for instance status polls (ms)
 * @property {number} WEBSOCKET_CONNECT_TIMEOUT - Max time to establish WebSocket connection (ms)
 * @property {number} WEBSOCKET_PING_INTERVAL - Interval between WebSocket ping frames (ms)
 * @property {number} WEBSOCKET_PONG_TIMEOUT - Max time to wait for pong response (ms)
 * @property {number} RECONNECT_DELAY - Delay before attempting WebSocket reconnection (ms)
 * @property {number} INSTANCE_STATUS_POLL_INTERVAL - Interval for polling instance status (ms)
 * @property {number} MANAGER_POLL_INTERVAL - Interval for polling manager definitions (ms)
 */
const CONSTANTS = {
  HTTP_MANAGER_TIMEOUT: 2000,
  HTTP_INSTANCE_STATUS_TIMEOUT: 2000,
  WEBSOCKET_CONNECT_TIMEOUT: 5000,
  WEBSOCKET_PING_INTERVAL: 30000,
  WEBSOCKET_PONG_TIMEOUT: 10000,
  RECONNECT_DELAY: 3000,
  INSTANCE_STATUS_POLL_INTERVAL: 1000,
  MANAGER_POLL_INTERVAL: 5000,
}

class ModuleInstance extends InstanceBase {
  constructor(internal) {
    super(internal)

    // Mixin methods from separate files for organization
    Object.assign(this, {
      ...config,
      ...actions,
      ...feedbacks,
      ...variables,
      ...presets,
    })

    this.engine = null
  }

  // ---------------------------------------------------------------------------
  // Lifecycle Methods
  // ---------------------------------------------------------------------------

  /**
   * Called when the module is initialized.
   *
   * Must await _startEngine() so that channel/variable/rule definitions are
   * fetched before initializing actions/feedbacks. Otherwise dropdowns
   * would be empty on first load.
   *
   * @param {object} config - User configuration from Companion
   */
  async init(config) {
    this.config = config
    this._ensureControlInterfaceId()

    await this._startEngine()

    // Init actions/feedbacks/etc AFTER engine has fetched definitions
    // so that dropdowns are populated with current data
    this.initActions()
    this.initFeedbacks()
    this.initVariables()
    this.initPresets()
  }

  /**
   * Called when the user updates configuration.
   *
   * Only restarts the engine if manager connection settings changed.
   * Other config changes (channel selection, verbose logging) are handled
   * by the running engine's poll loop, avoiding unnecessary disruption and
   * race conditions where the UI re-renders before definitions are loaded.
   *
   * @param {object} config - Updated configuration
   */
  async configUpdated(config) {
    const oldConfig = this.config
    this.config = config
    this._ensureControlInterfaceId()

    // Determine if manager connection settings changed - these require
    // a full engine restart since we're connecting to a different manager
    const managerChanged = 
      oldConfig.manager_ip !== config.manager_ip ||
      oldConfig.manager_port !== config.manager_port

    if (managerChanged) {
      // Full restart required - connecting to different manager
      this._stopEngine()
      await this._startEngine()

      // Re-init everything with new definitions
      this.initActions()
      this.initFeedbacks()
      this.initVariables()
      this.initPresets()
    }
    // For other config changes (channel, verbose, etc.), the engine's
    // existing poll loop will pick them up on the next cycle. This avoids
    // the race condition where Companion re-renders the config UI before
    // the engine finishes fetching definitions.
  }

  /**
   * Called when the module is destroyed.
   * Cleans up all connections and timers.
   */
  async destroy() {
    this._stopEngine()
  }

  // ---------------------------------------------------------------------------
  // Engine Management
  // ---------------------------------------------------------------------------

  /**
   * Ensures a control interface ID exists for WebSocket identification.
   * Generated once and persisted in config.
   */
  _ensureControlInterfaceId() {
    if (!this.config.control_interface_id) {
      this.config.control_interface_id = uuidv4()
      this.log('info', `Generated control interface ID: ${this.config.control_interface_id}`)
      this.saveConfig(this.config)
    }
  }

  /**
   * Starts the engine if minimum configuration is present.
   * Engine handles graceful degradation - it will poll for channels even
   * without a channel selected, and maintain existing connections even if
   * manager becomes unreachable.
   *
   * Returns a promise that resolves after the engine's initial data fetch,
   * ensuring definitions are available before callers proceed.
   */
  async _startEngine() {
    if (!this.config.manager_ip) {
      this.updateStatus(InstanceStatus.BadConfig, 'Manager IP not configured')
      return
    }

    this.updateStatus(InstanceStatus.Connecting)

    this.engine = new Engine(this, CONSTANTS)
    await this.engine.start()
  }

  /**
   * Stops the engine if running.
   */
  _stopEngine() {
    if (this.engine) {
      this.engine.stop()
      this.engine = null
    }
  }

  // ---------------------------------------------------------------------------
  // Config Dropdown Helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns channel choices for the config dropdown.
   * 
   * When the manager is reachable, returns live channel data.
   * When unreachable but we have cached channel info, returns the cached
   * channel so the dropdown displays a name instead of a raw GUID.
   * 
   * Always ensures the currently selected channel appears in choices to
   * prevent "?? (guid)" display during engine restart race conditions.
   */
  getChannelChoices() {
    const reachable = this.engine?.isManagerReachable()
    const channels = this.engine?.getChannelDefinitions() ?? []
    const currentChannelId = this.config?.channel

    // Manager not reachable (false) or never attempted (null/undefined)
    if (!reachable) {
      // If we loaded from cache, show the cached channel so the dropdown
      // displays a readable name instead of "?? (guid)" or an error
      const cached = this.engine?.getCachedChannelInfo()
      if (cached) {
        return [{ id: cached.id, label: `${cached.name} (cached)` }]
      }

      // If a channel is selected but we can't reach manager and have no cache,
      // try to get the name from the persisted cache in config
      if (currentChannelId && currentChannelId !== 'none') {
        const cachedName = this._getChannelNameFromConfigCache(currentChannelId)
        if (cachedName) {
          return [{ id: currentChannelId, label: `${cachedName} (cached)` }]
        }
      }

      return [{ id: 'none', label: 'Unable to reach manager' }]
    }

    if (channels.length === 0) {
      // No channels yet but manager is reachable - might still be loading
      // Preserve current selection if we have one
      if (currentChannelId && currentChannelId !== 'none') {
        const cachedName = this._getChannelNameFromConfigCache(currentChannelId)
        const label = cachedName ? `${cachedName} (loading...)` : `(Loading...)`
        return [{ id: currentChannelId, label }]
      }
      return [{ id: 'none', label: 'No channels available' }]
    }

    return [
      { id: 'none', label: '(Select a Channel)' },
      ...channels.map((c) => ({ id: c.ID, label: c.Name })),
    ]
  }

  /**
   * Extracts channel name from the persisted definition cache.
   * Used as fallback when engine hasn't loaded cache into memory yet,
   * such as during engine restart race conditions.
   * 
   * @param {string} channelId - Channel GUID to look up
   * @returns {string|null} Channel name or null if not found
   */
  _getChannelNameFromConfigCache(channelId) {
    if (!this.config?.definition_cache) {
      return null
    }

    try {
      const cache = JSON.parse(this.config.definition_cache)
      if (cache.channelId === channelId && cache.channelName) {
        return cache.channelName
      }
    } catch {
      // Cache corrupted or invalid, ignore
    }

    return null
  }

  /**
   * Returns manual rule choices for action dropdowns.
   */
  getManualRuleChoices() {
    const rules = this.engine?.getManualRuleDefinitions() ?? []
    return rules.map((r) => ({ id: r.ID, label: r.Name }))
  }

  /**
   * Returns variable choices for action dropdowns.
   */
  getVariableChoices() {
    const vars = this.engine?.getVariableDefinitions() ?? []
    return vars.map((v) => ({ id: v.ID, label: v.Name }))
  }
}

runEntrypoint(ModuleInstance, UpgradeScripts)