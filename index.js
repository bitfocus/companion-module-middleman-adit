const { InstanceBase, Regex, runEntrypoint } = require('@companion-module/base')
const UpgradeScripts = require('./src/upgrades')

const config = require('./src/config')
const actions = require('./src/actions')
const feedbacks = require('./src/feedbacks')
const variables = require('./src/variables')
const presets = require('./src/presets')
const utils = require('./src/utils')
const websockets = require('./src/websockets')

const { v4: uuidv4 } = require('uuid')

class moduleInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		// Assign the methods from the listed files to this class
		Object.assign(this, {
			...config,
			...actions,
			...feedbacks,
			...variables,
			...presets,
			...utils,
			...websockets,
		})

		this.initFeedbacks()
		this.subscribeFeedbacks()

		this.aditChannelDefinitions = []
		this.aditManualRuleDefinitions = []
		this.aditVariableDefinitions = []
		this.aditInstanceDefinitions = []
		this.aditInstanceWebSockets = []

		this.openConnectionGUIDs = []

		this.primaryFound = false

		this.VARIABLES_INSTANCES = [] //used to hold the Companion variables about instances and connections
		this.VARIABLES_FROMMANAGER = [] //used to hold the Companion variables received from AdIT

		this.currentlyReelectingPrimary = false

		this.aditMessages = []

		return this
	}

	async init(config) {
		//this.getConfigFields()
		this.configUpdated(config)
	}

	configUpdated(config) {
		this.config = config

		this.initActions()
		this.initFeedbacks()
		this.initVariables()
		this.initPresets()

		this.clearIntervals()
		this.closeWebSockets()

		if (
			this.config.control_interface_id == '' ||
			this.config.control_interface_id == null ||
			this.config.control_interface_id == undefined
		) {
			this.config.control_interface_id = uuidv4()
			this.log('info', 'AdIT Control Interface ID not set. Setting to ' + this.config.control_interface_id)
			this.configUpdated(this.config)
			return
		} else {
			this.log('info', 'AdIT Control Interface ID: ' + this.config.control_interface_id)
		}

		if (this.config.manager_ip) {
			this.startConfigTimer()

			if (this.config.channel !== 'none') {
				//if channel is not none (they've selected a channel), start channel data timer
				//this.aditChannelDefinitions = []
				this.aditManualRuleDefinitions = []
				this.aditVariableDefinitions = []
				this.aditInstanceDefinitions = []
				this.aditInstanceWebSockets = []

				this.openConnectionGUIDs = []

				this.primaryFound = false

				this.VARIABLES_INSTANCES = [] //used to hold the Companion variables for instances
				this.VARIABLES_FROMMANAGER = [] //used to hold the Companion variables received from the AdIT Manager Service

				this.currentlyReelectingPrimary = false

				this.initActions() //rebuild the list of actions since we have reset the manual rules and variables back to empty

				this.startChannelDataTimer()
			}
		}
	}

	async destroy() {
		this.isInitialized = false

		this.clearIntervals()

		this.closeWebSockets()
	}

	clearIntervals() {
		if (this.config_timer) {
			this.log('debug', `Stopping configuration timer (channels).`)
			clearInterval(this.config_timer)
			this.config_timer = null
		}

		if (this.channelDataTimer) {
			this.log('debug', `Stopping channel data timer (variables, messaging rules, and instances)`)
			clearInterval(this.channelDataTimer)
			this.channelDataTimer = null
		}
	}
}

runEntrypoint(moduleInstance, UpgradeScripts)
