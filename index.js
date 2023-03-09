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
		this.aditControlInterfaceID = uuidv4()

		this.primaryFound = false;

		this.VARIABLES_INSTANCES = []; //used to hold the Companion variables for instances
		this.VARIABLES_FROMMANAGER = []; //used to hold the Companion variables received from the AdIT Mangager service

		this.currentlyReelectingPrimary = false;

		return this
	}

	async init(config) {
		this.log('info', `AdIT Instance Control Interface client ID: ${this.aditControlInterfaceID}`)

		this.getConfigFields()

		this.configUpdated(config);
	}

	configUpdated(config) {
		this.config = config
		
		this.initActions()
		this.initFeedbacks()
		this.initVariables()
		this.initPresets()

		if (this.config.manager_ip) {
			this.startConfigTimer();
		}

		if (this.config.channel && this.config.channel !== 'none') {
			this.startChannelDataTimer();
		}
	}

	async destroy() {
		this.isInitialized = false

		this.clearIntervals();

		this.closeWebSockets();
	}

	clearIntervals() { //clear any and all intervals so that they won't keep requesting data
		this.log('debug', `Stopping Intervals. AdIT will no longer request new data from the management server until errors are resolved.`);

		if (this.config_timer) {	
			clearInterval(this.config_timer);
			this.config_timer = null;
		}

		if (this.channelDataTimer) {
			clearInterval(this.channelDataTimer);
			this.channelDataTimer = null;
		}
	}	
}

runEntrypoint(moduleInstance, UpgradeScripts)