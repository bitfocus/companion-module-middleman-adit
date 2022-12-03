var instance_skel = require('../../instance_skel')
const { v4: uuidv4 } = require('uuid')
const http = require('http')
const WebSocket = require('ws')
const xml2js = require('xml2js')

class AdITInstance extends instance_skel {

	constructor(system, id, config) {
		super(system, id, config)

		this.subscriptions = new Map()

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

		return this
	}

	init() {
		this.log('info', `AdIT Instance Control Interface client ID: ${this.aditControlInterfaceID}`)

		this.config_fields()

		this.updateConfig(this.config);
	}

	updateConfig(config) {
		this.config = config

		this.actions.bind(this)();

		if (this.config.manager_ip) {
			this.startConfigTimer.bind(this)();
		}

		if (this.config.channel && this.config.channel !== 'none') {
			this.startChannelDataTimer.bind(this)();
		}
	}

	config_fields() {
		return [
			{
				type: 'text',
				id: 'info',
				label: 'Information',
				width: 12,
				value: `
					<div class="alert alert-warning">
						<div>
							<strong>To use this module:</strong>
							<br>
							<ol>
								<li>First enter your AdIT Management Service IP Address and Port.</li>
								<li>Click "Save"</li>
								<li>Then return to this Connection page, and a list of channels will be available.</li>
							</ol>
						</div>
					</div>
				`,
				isVisible: (configValues) => configValues.channel == 'none',
			},
			{
				type: 'textinput',
				id: 'manager_ip',
				label: 'AdIT Management Service IP Address',
				tooltip: 'The IP address of the server hosting the AdIT Management Service',
				default: '127.0.0.1',
				width: 6
			},
			{
				type: 'textinput',
				id: 'manager_port',
				label: 'AdIT Management Service Port Number',
				tooltip: 'The port number of the AdIT Management Service',
				default: '8000',
				width: 6,
				regex: this.REGEX_NUMBER
			},
			{
				type: 'textinput',
				id: 'config_polling_rate',
				label: 'AdIT Management Service Refresh Rate (in seconds)',
				tooltip: 'How often to refresh the Channels, Management Rules, Variables, and Instance information from the Management Server',
				default: 1,
				width: 6,
				regex: this.REGEX_NUMBER
			},
			{
				type: 'dropdown',
				id: 'channel',
				label: 'Channel',
				width: 12,
				choices: this.getChannelChoices.bind(this)(),
				default: this.getChannelChoices.bind(this)()[0].id,
				isVisible: (configValues) => configValues.channel !== 'none',
			},
			{
				type: 'checkbox',
				id: 'log_control_interface_messages',
				label: 'Log Control Interface Messages',
				tooltip: 'Log all AdIT instance Control Interface messages',
				width: 6,
				default: true,
				isVisible: (configValues) => configValues.channel !== 'none',
			}
		]
	}

	startConfigTimer() { //starts the config timer/interval which will request a new list of Channels from the Management Service
		if (this.config_timer) { //clear the interval if it already exists
			clearInterval(this.config_timer)
		}

		this.status(this.STATUS_WARNING, 'Getting Channels from Management Service...');

		this.getChannels.bind(this)(); //immediately ask for the list of channels

		//On interval, call AdIT Management Service API for current lists of channels
		this.config_timer = setInterval(this.getChannels.bind(this), (parseInt(this.config.config_polling_rate) * 1000));
	}

	getChannels() {
		this.log('debug', 'Getting Channels...');
		this.getChannelsFromManager(function (channelsChanged) {
			if (channelsChanged) { //Only update if changes are made to one or more of the lists
				this.log('debug', `Available AdIT Channel options have changed, updating...`)
				this.status(this.STATUS_OK, 'Channels loaded. Choose a Channel in the Config.');
				if (this.config.channel == 'none') {
					this.config.channel = this.getChannelChoices.bind(this)()[0].id; //get the first loaded channel
				}				
				this.saveConfig(); //saves the config to memory
				this.config_fields.bind(this)();
			}
		})
	}

	startChannelDataTimer() { //requests the Channel Data (Manual Rules, Variables, and Instances) on a timer/interval
		if (this.channelDataTimer) { //clear the interval if it already exists
			clearInterval(this.channelDataTimer)
		}

		this.status(this.STATUS_OK);

		if (this.config.channel !== 'none') {
			//only proceed if they have configured a channel

			this.getChannelData.bind(this)(); //immediately request the channel data before setting the interval

			//On interval, call AdIT Management Service API for current lists of channel specific data - manual rules, variables, instances
			this.channelDataTimer = setInterval(this.getChannelData.bind(this), (parseInt(this.config.config_polling_rate) * 1000));
		}
	}

	getChannelData() { //requests the Manual Rules, Variables, and Instances from the AdIT Management Service
		this.getManualRulesFromManager(function (manualRulesChanged) {
			if (manualRulesChanged) {
				//reload actions
				this.log('debug', `Available AdIT Manual Rules have changed, updating...`)
				this.actions.bind(this)();
			}
		})

		this.getVariablesFromManager(function (variablesChanged) {
			if (variablesChanged) {
				//reload variables
				this.log('debug', `Available AdIT Variables have changed, updating...`)

				//Construct array of companion variable definitions and call set for all available AdIT variable definitions:
				this.VARIABLES_FROMMANAGER = []; //reset the array of Companion variables loaded from the Management Service, because we are recreating them

				for (let tmpVar of this.aditVariableDefinitions) {
					this.VARIABLES_FROMMANAGER.push({
						label: tmpVar.Name,
						name: tmpVar.ID
					})
				}

				this.createVariables.bind(this)(); //now create all Companion Variables (both Instance and Management Variables)
				
				this.actions.bind(this)();
			}
		})

		this.getInstancesFromManager(function (instancesChanged) {
			if (instancesChanged) {
				//reload instances
				this.log('debug', `Available AdIT Instances have changed, updating...`);
				try {
					this.VARIABLES_INSTANCES = []; //reset the array of Companion variables related to Instances, since the Instances data has changed
					
					this.VARIABLES_INSTANCES.push({
						label: 'Instance Count',
						name: 'instance_count'
					});

					this.VARIABLES_INSTANCES.push({
						label: 'Instance Primary Name',
						name: 'instance_primary_name'
					});

					this.VARIABLES_INSTANCES.push({
						label: 'Instance Connections Open',
						name: 'instance_connections_open'
					});
	
					for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {		
						this.VARIABLES_INSTANCES.push({
							label: `Instance ${i+1} Name`,
							name: `instance_name_${i+1}`
						})
	
						this.VARIABLES_INSTANCES.push({
							label: `Instance ${i+1} Description`,
							name: `instance_description_${i+1}`
						})
	
						this.VARIABLES_INSTANCES.push({
							label: `Instance ${i+1} Primary`,
							name: `instance_primary_${i+1}`
						})
	
						this.VARIABLES_INSTANCES.push({
							label: `Instance ${i+1} IP Address`,
							name: `instance_ipaddress_${i+1}`
						})

						this.VARIABLES_INSTANCES.push({
							label: `Instance ${i+1} Control Port`,
							name: `instance_controlport_${i+1}`
						})
					}

					this.createVariables.bind(this)(); //now create all Companion Variables (both Instance and Management Variables)

					this.setVariable('instance_count', this.aditInstanceDefinitions.length);

					//now populate the Instance variables
					for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {
						let aditInstance = this.aditInstanceDefinitions[i];
	
						if (aditInstance.hasOwnProperty('Name')) {
							this.setVariable(`instance_name_${i+1}`, aditInstance.Name);
						}
						
						if (aditInstance.hasOwnProperty('Description')) {
							this.setVariable(`instance_description_${i+1}`, aditInstance.Description);
						}

						if (aditInstance.hasOwnProperty('Primary')) {
							this.setVariable(`instance_primary_${i+1}`, aditInstance.Primary ? 'True' : 'False');
						}

						if (aditInstance.hasOwnProperty('IPAddress')) {
							this.setVariable(`instance_ipaddress_${i+1}`, aditInstance.IPAddress);
						}

						if (aditInstance.hasOwnProperty('ControlInterfacePortNumber')) {
							this.setVariable(`instance_controlport_${i+1}`, aditInstance.ControlInterfacePortNumber);
						}
					}
				}
				catch(error) {
					this.log('debug', `Error setting Instance Information Variables: ${error.toString()}`);
				}
				
				this.initWebSockets.bind(this)();
			}
		})
	}

	createVariables() { //Because the calls to get Instances and Variables happen asynchronously, we need one common function to call from both areas that can build the list of Companion Variables
		let companionVarDefs = [];

		for (let i = 0; i < this.VARIABLES_INSTANCES.length; i++) {
			companionVarDefs.push(this.VARIABLES_INSTANCES[i]);
		}

		for (let i = 0; i < this.VARIABLES_FROMMANAGER.length; i++) {
			companionVarDefs.push(this.VARIABLES_FROMMANAGER[i]);
		}

		this.setVariableDefinitions(companionVarDefs);
	}

	destroy() {
		this.isInitialized = false

		this.clearIntervals.bind(this)();

		this.closeWebSockets.bind(this)();
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

	/**
	 * Calls AdIT Management Service API to retrieve the current list of channels.
	 *
	 * @param {function} callback function that indicates if the list of channels has changed since the last call to this function.
	 */
	getChannelsFromManager(callback) {
		try {
			let toReturn = false
			//this.log('debug', `Getting Channels from ${this.config.manager_ip}:${this.config.manager_port}`)
			http.get(`http://${this.config.manager_ip}:${this.config.manager_port}/channels`, res => {
				let data = []
				const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
	
				res.on('data', chunk => {
					data.push(chunk)
				})
	
				res.on('end', () => {
					//If 200/OK, parse JSON response enumerating the available channels
					try {
						if (res.statusCode == 200) {
							let tmpChannelDefinitions = JSON.parse(Buffer.concat(data).toString())
		
							//Determine if any changes have actually occured before assigning to this.aditChannelDefinitions array
							if (JSON.stringify(tmpChannelDefinitions) != JSON.stringify(this.aditChannelDefinitions)) {
								toReturn = true
							}
		
							this.aditChannelDefinitions = tmpChannelDefinitions
						}
						else {
							this.log('error', `Failed to get list of Channel definitions from AdIT Management Service with HTTP status code: ${res.statusCode}`)
						}
		
						//Fire callback function with toReturn to indicate whether or not the list has changed	
						if (typeof callback === 'function') {
							callback.bind(this)(toReturn)
						}
					}
					catch(error) {
						this.log('error', `Failed to get list of Channel definitions from AdIT Management Service. Response Error: ${error.toString()}`)
						this.status(this.STATUS_ERROR, 'Error getting Channels');
						this.clearIntervals.bind(this)();
					}
				})
	
			}).on('error', err => {
				this.log('error', `Failed to get list of Channel definitions from AdIT Management Service with error: ${err.message}`)
				this.status(this.STATUS_ERROR, 'Error getting Channels');
				this.clearIntervals.bind(this)();
			})
		}
		catch(error) {
			this.log('error', 'Error retrieving Channels from AdIT Management Server. Error: ' + error.toString());
			this.status(this.STATUS_ERROR, 'Error getting Channels');
			this.clearIntervals.bind(this)();
		}
	}

	/**
	 * Calls AdIT Management Service API to retrieve the current list of manual rules for the configured channel.
	 *
	 * @param {function} callback function that indicates if the list of manual rules has changed since the last call to this function.
	 */
	getManualRulesFromManager(callback) {
		try {
			let toReturn = false
			this.log('debug', `Getting Manual Rules From Manager...`);
			http.get(`http://${this.config.manager_ip}:${this.config.manager_port}/channels/${this.config.channel}/messaging-rules`, res => {
				let data = []
				const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
	
				res.on('data', chunk => {
					data.push(chunk)
				})
	
				res.on('end', () => {
					try {
						//If 200/OK, parse JSON response enumerating the channel's messaging rules
						if (res.statusCode == 200) {
							let tmpRuleDefinitions = JSON.parse(Buffer.concat(data).toString())
							let tmpManualRuleDefinitions = []

							//Filter tmpRuleDefinitions down to only manual (type 1) rules to populate tmpManualRuleDefinitions
							for (let tmpRule of tmpRuleDefinitions) {
								let ruleContents = JSON.parse(tmpRule.JSON)
								if (ruleContents.RuleType == 1) {
									tmpManualRuleDefinitions.push(tmpRule)
								}
							}

							//Determine if any changes have actually occured before assigning to this.aditManualRuleDefinitions array
							if (JSON.stringify(tmpManualRuleDefinitions) != JSON.stringify(this.aditManualRuleDefinitions)) {
								toReturn = true
							}

							this.aditManualRuleDefinitions = tmpManualRuleDefinitions
						}
						else {
							this.log('error', `Failed to get list of messaging rule definitions from AdIT Management Service with HTTP status code: ${res.statusCode}`)
						}

						//Fire callback function with toReturn to indicate whether or not the list has changed	
						if (typeof callback === 'function') {
							callback.bind(this)(toReturn)
						}
					}
					catch(error) {
						this.log('error', `Failed to get list of Manual Rules from AdIT Management Service. Error: ${error.toString()}`)
						this.status(this.STATUS_ERROR, 'Error getting Manual Rules');
						this.clearIntervals.bind(this)();
					}
				})
	
			}).on('error', err => {
				this.log('error', `Failed to get list of Manual Rule definitions from AdIT Management Service with error: ${err.message}`)
				this.status(this.STATUS_ERROR, 'Error getting Manual Rules');
				this.clearIntervals.bind(this)();
			})
		}
		catch(error) {
			this.log('error', 'Error retrieving Manual Rules from AdIT Management Server. Error: ' + error.toString());
			this.status(this.STATUS_ERROR, 'Error getting Manual Rules');
			this.clearIntervals.bind(this)();
		}
	}

	/**
	 * Calls AdIT Management Service API to retrieve the current list of variables for the configured channel.
	 *
	 * @param {function} callback function that indicates if the list of variables has changed since the last call to this function.
	 */
	getVariablesFromManager(callback) {
		try {
			let toReturn = false
			this.log('debug', `Getting Variables From Manager...`);
			http.get(`http://${this.config.manager_ip}:${this.config.manager_port}/channels/${this.config.channel}/variables`, res => {
				let data = []
				const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
	
				res.on('data', chunk => {
					data.push(chunk)
				})
	
				res.on('end', () => {
					try {
						//If 200/OK, parse JSON response enumerating the channel's variables
						if (res.statusCode == 200) {
							let tmpVariableDefinitions = JSON.parse(Buffer.concat(data).toString())

							//Determine if any changes have actually occured before assigning to this.aditVariableDefinitions array
							if (JSON.stringify(tmpVariableDefinitions) != JSON.stringify(this.aditVariableDefinitions)) {
								toReturn = true
							}

							this.aditVariableDefinitions = tmpVariableDefinitions;
						}
						else {
							this.log('error', `Failed to get list of Variable Definitions from AdIT Management Service with HTTP status code: ${res.statusCode}`)
						}

						//Fire callback function with toReturn to indicate whether or not the list has changed	
						if (typeof callback === 'function') {
							callback.bind(this)(toReturn)
						}
					}
					catch(error) {
						this.log('error', `Failed to get list of Variable Definitions from AdIT Management Service. Error: ${error.toString()}`)
						this.status(this.STATUS_ERROR, 'Error getting Variables');
						this.clearIntervals.bind(this)();
					}
				})
	
			}).on('error', err => {
				this.log('error', `Failed to get list of Variable Definitions from AdIT Management Service with error: ${err.message}`)
				this.status(this.STATUS_ERROR, 'Error getting Variables');
				this.clearIntervals.bind(this)();
			})
		}
		catch(error) {
			this.log('error', 'Error retrieving Variables from AdIT Management Server. Error: ' + error.toString());
			this.status(this.STATUS_ERROR, 'Error getting Variables');
			this.clearIntervals.bind(this)();
		}
	}

	/**
	 * Calls AdIT Management Service API to retrieve the current list of instances.
	 *
	 * @param {function} callback function that indicates if the list of instances has changed since the last call to this function.
	 */
	 getInstancesFromManager(callback) {
		try {
			let toReturn = false
			this.log('debug', `Getting Instances From Manager...`);
			http.get(`http://${this.config.manager_ip}:${this.config.manager_port}/channels/${this.config.channel}/instances`, res => {
				let data = []
				const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
	
				res.on('data', chunk => {
					data.push(chunk)
				})
	
				res.on('end', () => {
					try {
						//If 200/OK, parse JSON response enumerating the available channels
						if (res.statusCode == 200) {
							let tmpInstanceDefinitions = JSON.parse(Buffer.concat(data).toString())

							//Determine if any changes have actually occured before assigning to this.aditInstanceDefinitions array
							if (JSON.stringify(tmpInstanceDefinitions) != JSON.stringify(this.aditInstanceDefinitions)) {
								toReturn = true
							}

							this.aditInstanceDefinitions = tmpInstanceDefinitions
						}
						else {
							this.log('error', `Failed to get list of Instance definitions from AdIT Management Service with HTTP status code: ${res.statusCode}`)
						}

						//Fire callback function with toReturn to indicate whether or not the list has changed	
						if (typeof callback === 'function') {
							callback.bind(this)(toReturn)
						}
					}
					catch(error) {
						this.log('error', `Failed to get list of Instances from AdIT Management Service. Error: ${error.toString()}`)
						this.status(this.STATUS_ERROR, 'Error getting Instances');
						this.clearIntervals.bind(this)();
					}
				})
	
			}).on('error', err => {
				this.log('error', `Failed to get list of Instance definitions from AdIT Management Service with error: ${err.message}`)
				this.status(this.STATUS_ERROR, 'Error getting Instances');
				this.clearIntervals.bind(this)();
			})
		}
		catch(error) {
			this.log('error', 'Error retrieving Instances from AdIT Management Server. Error: ' + error.toString());
			this.status(this.STATUS_ERROR, 'Error getting Instances');
			this.clearIntervals.bind(this)();
		}
	}

	initWebSockets() {
		this.status(this.STATUS_UNKNOWN, 'Opening Instance Websocket Connections...');

		//first go through and close out any existing websocket definitions, if they happen to exist
		this.closeWebSockets.bind(this)();

		this.primaryFound = false;

		//check for a primary instance
		for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {
			if (this.aditInstanceDefinitions[i].Primary == true) {
				this.primaryFound = true;
				break;
			}
		}

		//now open a websocket to each instance ID
		for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {
			let aditInstance = this.aditInstanceDefinitions[i];

			let primary = false;

			if (aditInstance.Primary == true) { //if it's marked Primary
				primary = true;
			}

			this.openWebSocket.bind(this)(aditInstance.ID, primary);			
		}

		this.status(this.STATUS_OK);

		setTimeout(this.checkForPrimary.bind(this), 5000); //checks after 5 seconds
	}

	openWebSocket(instanceID, primary) {
		let websocketObj = {};
		websocketObj.ID = instanceID;
		websocketObj.primary = primary;

		let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == instanceID);
		//let aditInstanceWS = this.aditInstanceWebSockets.find((INSTANCE) => INSTANCE.ID == instanceID);

		if (primary) { //if this is the/a primary Instance
			this.log('info', `AdIT Instance ${aditInstance.Name} will be marked as Primary.`);
		}

		let reopen = true;

		if (aditInstance && reopen) {
			this.log('debug', `Attempting to open WebSocket connection to AdIT Instance: ${aditInstance.Name}`);
			this.log('debug', `WebSocket Path: ${aditInstance.IPAddress}:${aditInstance.ControlInterfacePortNumber}`);

			websocketObj.ws = new WebSocket(`ws://${aditInstance.IPAddress}:${aditInstance.ControlInterfacePortNumber}/${this.aditControlInterfaceID}`);

			websocketObj.ws.on('open', () => {
				this.log('debug', `AdIT Instance Control Interface WebSocket connection opened: ${aditInstance.Name}`)
				this.status(this.STATUS_OK)
				websocketObj.state = 'ok';

				for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
					if (this.aditInstanceWebSockets[i].ID == instanceID) {
						this.aditInstanceWebSockets[i].state = 'open';
					}
				}

				this.checkAllWebSockets.bind(this)();
			});
	
			websocketObj.ws.on('close', (code) => {
				for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
					if (this.aditInstanceWebSockets[i].ID == instanceID) {
						if (this.aditInstanceWebSockets[i].state !== 'force-closed') {
							this.log('warn', `AdIT Instance (${aditInstance.Name}) Control Interface WebSocket connection closed with code ${code}`)
							this.status(this.STATUS_WARNING);
							this.aditInstanceWebSockets[i].state = 'closed';

							if (this.aditInstanceWebSockets[i].primary == true) {
								this.reelectPrimary.bind(this)();
							}

							this.reconnectWebSocket.bind(this)(instanceID);
						}
						else {
							this.log('debug', `AdIT Instance (${aditInstance.Name}) Control Interface WebSocket connection closed with code ${code}`);
						}

						break;
					}
				}
				
				this.checkAllWebSockets.bind(this)();
			});		

			websocketObj.ws.on('message', (data) => {
				this.messageReceivedFromWebSocket.bind(this)(instanceID, data)
			});
	
			websocketObj.ws.on('error', (data) => {
				let state = 'error';

				this.status(this.STATUS_WARNING);

				if (data.toString().indexOf('ECONNREFUSED') > -1) {
					state = 'conn-refused';
					this.log('warn', `AdIT Instance (${aditInstance.Name}) Connection Refused. Is this Instance still online?`)
				}
				else {
					this.log('warn', `AdIT Instance (${aditInstance.Name}) Control Interface WebSocket error: ${data}`)
				}				

				for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
					if (this.aditInstanceWebSockets[i].ID == instanceID) {
						this.aditInstanceWebSockets[i].state = state;

						if (this.aditInstanceWebSockets[i].primary == true) {
							this.reelectPrimary.bind(this)();
						}

						break;
					}					
				}

				this.checkAllWebSockets.bind(this)();
			})

			//first look for the instance websocket object in the array, and if it already exists, attempt to open it there, otherwise create a new one
			let found = false;

			for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
				if (this.aditInstanceWebSockets[i].ID == instanceID) {
					this.aditInstanceWebSockets[i].ws = websocketObj.ws;
					this.aditInstanceWebSockets[i].state = websocketObj.state;
					this.aditInstanceWebSockets[i].primary = websocketObj.primary;
					found = true;
					break;
				}
			}

			if (!found) {
				this.aditInstanceWebSockets.push(websocketObj);
			}
		}
	}

	reconnectWebSocket(instanceID) {
		let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == instanceID);
		this.log('debug', `Attempting to re-open websocket connection to: ${aditInstance.Name}`);
		setTimeout(this.openWebSocket.bind(this), 3000, instanceID);
	}

	checkForPrimary() {
		if (this.primaryFound == false) {
			this.log('warn', `A Primary AdIT Instance was not detected.`);
			this.reelectPrimary.bind(this)();
		}
	}

	messageReceivedFromWebSocket(instanceID, data) {
		let aditInstance = this.aditInstanceWebSockets.find((INSTANCE) => INSTANCE.ID == instanceID);

		if (aditInstance.primary == true) {
			if (this.config.log_control_interface_messages) {
				this.log('debug', `AdIT Control Interface message received: ${data}`)
			}
	
			let myThis = this;
			xml2js.parseString(data, function (err, result) {
				if (result.Variable != null) {
					//This is a variable XML message that was received
					myThis.setVariable(result.Variable.$.ID, result.Variable._)
				}
			})
		}		
	}

	reelectPrimary() {
		this.log('warn', `Re-Electing a new Primary.`);

		let primaryElected = false;

		for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
			if (this.aditInstanceWebSockets[i].state == 'open') { //select the first open instance
				this.aditInstanceWebSockets[i].primary = true;
				let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == this.aditInstanceWebSockets[i].ID);
				this.log('debug', `New Instance Marked as Primary: ${aditInstance.Name}`)
				this.setVariable('instance_primary_name', aditInstance.Name);
				primaryElected = true;
				this.primaryFound = true;
				break;
			}
		}

		if (!primaryElected) {
			this.log('error', 'Unable to select a new Primary Instance to receive messages from.');
			this.primaryFound = false;
			this.status(this.STATUS_ERROR);
		}
	}

	checkAllWebSockets() {
		let instanceOpenCount = 0;
		for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
			if (this.aditInstanceWebSockets[i].state == 'open') {
				instanceOpenCount++;
			}
		}

		if (instanceOpenCount == 0) {
			this.log('error', `No Instance WebSocket connections available. The module will not function properly until an Instance connection is available.`);
			this.status(this.STATUS_ERROR);
		}

		this.setVariable('instance_connections_open', instanceOpenCount);
	}

	closeWebSockets() {
		if (this.aditInstanceWebSockets.length > 0) {
			this.log('info', 'Closing Web Sockets...');

			for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
				this.aditInstanceWebSockets[i].state = 'force-closed';
				//this.aditInstanceWebSockets[i].ws.close(1000);
				this.aditInstanceWebSockets[i].ws.terminate();
				delete this.aditInstanceWebSockets[i].ws;
			}
	
			//now reset the entire websocket array
			this.aditInstanceWebSockets = [];
		}		
	}

	sendMessage(msg) {
		this.log('debug', 'Sending Message...');
		for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
			this.aditInstanceWebSockets[i].ws.send(msg);
		}
	}

	getChannelChoices() {
		let toReturn = []
		if (this.aditChannelDefinitions.length > 0) {
			this.aditChannelDefinitions.forEach((c) => {
				if (c.NetworkEdition && c.NetworkEdition == true) {
					toReturn.push({
						id: c.ID,
						label: c.Name
					})
				}				
			})
		}
		else {
			toReturn.push({
				id: 'none',
				label: 'No Channels Loaded'
			})
		}

		return toReturn
	}

	getManualRuleChoices() {
		let toReturn = []
		if (this.aditManualRuleDefinitions.length > 0) {
			this.aditManualRuleDefinitions.forEach((mr) => {
				toReturn.push({
					id: mr.ID,
					label: mr.Name
				})
			})
		}
		return toReturn
	}

	getVariableChoices() {
		let toReturn = []
		if (this.aditVariableDefinitions.length > 0) {
			this.aditVariableDefinitions.forEach((v) => {
				toReturn.push({
					id: v.ID,
					label: v.Name
				})
			})
		}
		return toReturn
	}

	actions() {
		this.setActions({
			set_variable_value: {
				label: 'Set Variable Value',
				options: [
					{
						type: 'dropdown',
						id: 'variable',
						label: 'Variable',
						width: 6,
						choices: this.getVariableChoices.bind(this)(),
						required: true
					},
					{
						type: 'textinput',
						label: 'Value',
						id: 'value',
						default: ''
					}
				],
				callback: (action) => {
					this.log('info', `Sending request to set variable ID: ${action.options.variable} to value  ${action.options.value}`)

					//Construct XML request to set variable value
					let val = action.options.value;
					this.parseVariables(action.options.value, function(value) {
						val = value;
					});

					let obj = { SetVariableValueRequest: { $: { ID: action.options.variable }, _: val} }
					let builder = new xml2js.Builder()
					let xml = builder.buildObject(obj)

					//Send XML to AdIT instance via Control Interface WebSocket
					this.sendMessage.bind(this)(xml + '\r\n')

					//Finally, if option is turned on, log the message that was sent
					if (this.config.log_control_interface_messages) {
						this.log('debug', `AdIT Control Interface message sent: ${xml}`)
					}
				},
			},
			evaluate_manual_rule: {
				label: 'Evaluate Messaging Rule',
				options: [
					{
						type: 'dropdown',
						id: 'messaging_rule',
						label: 'Messaging Rule',
						tooltip: 'Only messaging rules with rule type Manual will appear in this list.',
						width: 6,
						choices: this.getManualRuleChoices.bind(this)(),
						required: true
					}
				],
				callback: (action) => {
					this.log('info', `Sending request to evaluate messaging rule ID: ${action.options.messaging_rule}`)

					//Construct XML request to set variable value
					let obj = { EvaluateManualMessagingRuleRequest: { $: { ID: action.options.messaging_rule } } }
					let builder = new xml2js.Builder()
					let xml = builder.buildObject(obj)

					//Send XML to AdIT instance via Control Interface WebSocket
					this.sendMessage.bind(this)(xml + '\r\n')

					//Finally, if option is turned on, log the message that was sent
					if (this.config.log_control_interface_messages) {
						this.log('debug', `AdIT Control Interface message sent: ${xml}`)
					}
				}
			}
		})
	}

	initFeedbacks() {
		this.setFeedbackDefinitions({})
	}
}

exports = module.exports = AdITInstance
