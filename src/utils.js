const { InstanceStatus } = require('@companion-module/base')

const http = require('http')

module.exports = {
	startConfigTimer() { //starts the config timer/interval which will request a new list of Channels from the Management Service
		if (this.config_timer) { //clear the interval if it already exists
			clearInterval(this.config_timer)
		}

		this.updateStatus(InstanceStatus.Warning, 'Getting channels from AdIT Management Service...');

		this.getChannels(); //immediately ask for the list of channels

		//On interval, call AdIT Management Service API for current lists of channels
		this.log('debug', `Requesting channels from AdIT Management Service every ${this.config.config_polling_rate} seconds...`);
		this.config_timer = setInterval(this.getChannels.bind(this), (parseInt(this.config.config_polling_rate) * 1000));
	},

	getChannels() {
		let self = this;
		self.log('debug', 'Getting channels from AdIT Management Service...');
		self.getChannelsFromManager.bind(self)(function (channelsChanged) {
			if (channelsChanged) { //Only update if changes are made to one or more of the lists
				self.log('debug', `Available AdIT channel options have changed, updating...`);
				self.getConfigFields(); //reloads the config fields
			}
			if (self.config.channel !== undefined) {
				if (self.config.channel == 'none') {
					self.updateStatus('warn', 'No channel selected in configuration');
					self.log('warn', 'No channel selected in configuration');
				}
				else {
					//check to see if their previously selected channel is now in the list of available channels
					let channelObj = self.aditChannelDefinitions.find(channel => channel.ID === self.config.channel);
					if (channelObj) {
						//probably ok
						self.updateStatus(InstanceStatus.Ok);
						this.startChannelDataTimer();
					}
					else {
						//channel was not found, we should tell the user
						self.updateStatus('warn', 'Channel no longer available, please select a new one');
						self.log('warn', 'Channel no longer available, please select a new one in the module config');
						self.config.channel = 'none';
						self.saveConfig(self.config);
						self.getConfigFields();
						self.configUpdated(self.config);
					}
				}
			}
			else {
				self.updateStatus('warn', 'No channel selected in configuration.');
				self.log('warn', 'No channel selected in configuration.');
			}

			//clear the timer so they have a chance to choose
			//clearInterval(self.config_timer);
			//self.config_timer = undefined;
		});
	},

	startChannelDataTimer() { //requests the Channel Data (Manual Rules, Variables, and Instances) on a timer/interval
		if (this.channelDataTimer) { //clear the interval if it already exists
			clearInterval(this.channelDataTimer)
		}

		this.updateStatus(InstanceStatus.Ok);

		console.log('this.config.channel value: ' + this.config.channel);

		if (this.config.channel !== 'none') {
			//check to see if their previously selected channel is now in the list of available channels
			let channelObj = this.aditChannelDefinitions.find(channel => channel.ID === this.config.channel);
			console.log('channel obj');
			console.log(channelObj);
			if (channelObj) {
				this.getChannelData(); //immediately request the channel data before setting the interval

				//On interval, call AdIT Management Service API for current lists of channel specific data - manual rules, variables, instances
				this.channelDataTimer = setInterval(this.getChannelData.bind(this), (parseInt(this.config.config_polling_rate) * 1000));
			}
			else {
				if (this.aditChannelDefinitions.length > 0) {
					this.updateStatus('warn', 'Channel no longer available, please select a new one');
				}
			}
		}
	},

	getChannelData() { //requests the Manual Rules, Variables, and Instances from the AdIT Management Service
		let self = this;

		if (self.config.channel !== 'none') {
			this.getManualRulesFromManager.bind(this)(function (manualRulesChanged) {
				let self = this;

				if (manualRulesChanged) {
					//reload actions
					self.log('debug', `Available manual rules have changed, updating...`)
					self.initActions();
				}
			})

			this.getVariablesFromManager.bind(this)(function (variablesChanged) {
				let self = this;

				if (variablesChanged) {
					//reload variables
					self.log('debug', `Available variables have changed, updating...`)

					//Construct array of companion variable definitions and call set for all available AdIT variable definitions:
					self.VARIABLES_FROMMANAGER = []; //reset the array of Companion variables loaded from the Management Service, because we are recreating them

					for (let tmpVar of self.aditVariableDefinitions) {
						self.VARIABLES_FROMMANAGER.push({
							name: tmpVar.Name,
							variableId: tmpVar.ID
						})
					}

					self.createVariables.bind(self)(); //now create all Companion Variables (both Instance and Management Variables)
					
					self.initActions();
				}
			})

			this.getInstancesFromManager.bind(this)(function (instancesChanged) {
				let self = this;

				if (instancesChanged) {
					//reload instances
					this.log('debug', `Available instances have changed, updating...`);
					try {
						this.VARIABLES_INSTANCES = []; //reset the array of Companion variables related to Instances, since the Instances data has changed
						
						this.VARIABLES_INSTANCES.push({
							name: 'Primary Instance ID',
							variableId: 'primary_instance_id'
						});

						this.VARIABLES_INSTANCES.push({
							name: 'Primary Instance Name',
							variableId: 'primary_instance_name'
						});
						
						this.VARIABLES_INSTANCES.push({
							name: 'Number of Connected Instances',
							variableId: 'instances_connected'
						});
		
						this.VARIABLES_INSTANCES.push({
							name: 'Number of Registered Instances',
							variableId: 'instances_registered'
						});

						for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {	
							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} ID`,
								variableId: `instance_${i+1}_id`
							})

							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} Name`,
								variableId: `instance_${i+1}_name`
							})
		
							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} Description`,
								variableId: `instance_${i+1}_description`
							})

							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} Connected`,
								variableId: `instance_${i+1}_connected`
							})
		
							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} Primary`,
								variableId: `instance_${i+1}_primary`
							})
		
							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} IP Address`,
								variableId: `instance_${i+1}_ip_address`
							})

							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} Port Number`,
								variableId: `instance_${i+1}_port_number`
							})
						}

						this.createVariables(); //now create all Companion variables

						this.updateInstanceVariables();
					}
					catch(error) {
						this.log('debug', `Error setting instance information variables: ${error.toString()}`);
					}
					
					this.initWebSockets();
				}
			})
		}
		else {
			this.log('warn', `No channel selected in configuration`);
			this.clearIntervals();
		}
	},

	createVariables() { //Because the calls to get Instances and Variables happen asynchronously, we need one common function to call from both areas that can build the list of Companion Variables
		let companionVarDefs = [];

		for (let i = 0; i < this.VARIABLES_INSTANCES.length; i++) {
			companionVarDefs.push(this.VARIABLES_INSTANCES[i]);
		}

		for (let i = 0; i < this.VARIABLES_FROMMANAGER.length; i++) {
			companionVarDefs.push(this.VARIABLES_FROMMANAGER[i]);
		}

		this.setVariableDefinitions(companionVarDefs);
	},

	updateInstanceVariables() {
		let variableValues = {};

		variableValues.instances_registered = this.aditInstanceDefinitions.length;

		//now populate the Instance variables
		for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {
			let aditInstance = this.aditInstanceDefinitions[i];

			if (aditInstance.hasOwnProperty('ID')) {
				variableValues[`instance_${i+1}_id`] = aditInstance.ID;
			}
			
			if (aditInstance.hasOwnProperty('Name')) {
				variableValues[`instance_${i+1}_name`] = aditInstance.Name;
			}
			
			if (aditInstance.hasOwnProperty('Description')) {
				variableValues[`instance_${i+1}_description`] = aditInstance.Description;
			}

			//check to see if this instance is the primary instance
			if (aditInstance.hasOwnProperty('ID') && aditInstance.ID == this.aditPrimaryInstanceID) {
				variableValues[`instance_${i+1}_primary`] = 'True';
			}
			else {
				variableValues[`instance_${i+1}_primary`] = 'False';
			}

			if (aditInstance.hasOwnProperty('IPAddress')) {
				variableValues[`instance_${i+1}_ip_address`] = aditInstance.IPAddress;
			}

			if (aditInstance.hasOwnProperty('ControlInterfacePortNumber')) {
				variableValues[`instance_${i+1}_port_number`] = aditInstance.ControlInterfacePortNumber;
			}
		}

		this.setVariableValues(variableValues);
	},

	/**
	 * Calls AdIT Management Service API to retrieve the current list of channels.
	 *
	 * @param {function} callback function that indicates if the list of channels has changed since the last call to this function.
	 */
	getChannelsFromManager(callback) {
		let self = this;

		try {
			let toReturn = false
			http.get(`http://${this.config.manager_ip}:${this.config.manager_port}/channels`, res => {
				let data = []
				const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
	
				res.on('data', chunk => {
					data.push(chunk)
				})
	
				res.on('end', () => {
					//If 200/OK, parse JSON response enumerating the available channels
					if (res.statusCode == 200) {
						try {
							let tmpChannelDefinitions = JSON.parse(Buffer.concat(data).toString())
	
							//Determine if any changes have actually occured before assigning to this.aditChannelDefinitions array
							if (JSON.stringify(tmpChannelDefinitions) != JSON.stringify(self.aditChannelDefinitions)) {
								toReturn = true
							}
		
							self.aditChannelDefinitions = tmpChannelDefinitions
						}
						catch(error) {
							self.log('error', `Failed to parse response and get list of Channels from AdIT Management Service: ${error}`);
						}						
					}
					else {
						self.log('error', `Failed to get list of channels from AdIT Management Service with HTTP status code: ${res.statusCode}`)
					}
	
					//Fire callback function with toReturn to indicate whether or not the list has changed	
					if (typeof callback === 'function') {
						callback.bind(self)(toReturn)
					}
				});
	
			}).on('error', err => {
				self.log('error', `Failed to get list of channels from AdIT Management Service with HTTP error: ${err.message}`)
				self.updateStatus('error', 'Error getting channels');
				self.clearIntervals();
			});
		}
		catch(error) {
			self.log('error', `Error retrieving Channels from AdIT Management Service: ${error}`);
			self.updateStatus('error', 'Error getting channels');
			self.clearIntervals();
		}
	},

	/**
	 * Calls AdIT Management Service API to retrieve the current list of manual rules for the configured channel.
	 *
	 * @param {function} callback function that indicates if the list of manual rules has changed since the last call to this function.
	 */
	getManualRulesFromManager(callback) {
		let self = this;

		try {
			let toReturn = false
			self.log('debug', `Requesting manual rules from ${this.config.manager_ip}:${this.config.manager_port}`);
			http.get(`http://${self.config.manager_ip}:${self.config.manager_port}/channels/${self.config.channel}/messaging-rules`, res => {
				let data = []
				const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
	
				res.on('data', chunk => {
					data.push(chunk)
				});
	
				res.on('end', () => {
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
						if (JSON.stringify(tmpManualRuleDefinitions) != JSON.stringify(self.aditManualRuleDefinitions)) {
							toReturn = true
						}

						self.aditManualRuleDefinitions = tmpManualRuleDefinitions
					}
					else {
						self.log('error', `Failed to get list of messaging rules from AdIT Management Service with HTTP status code: ${res.statusCode}`)
					}

					//Fire callback function with toReturn to indicate whether or not the list has changed	
					if (typeof callback === 'function') {
						callback.bind(self)(toReturn)
					}
				});
	
			}).on('error', err => {
				self.log('error', `Failed to get list of messaging rules from AdIT Management Service with HTTP error: ${err.message}`);
				self.updateStatus('error', 'Error getting messaging rules');
				self.clearIntervals();
			});
		}
		catch(error) {
			self.log('error', `Error retrieving Messaging Rules from AdIT Management Service: ${error}`);
			self.updateStatus('error', 'Error getting messaging rules');
			self.clearIntervals();
		}
	},

	/**
	 * Calls AdIT Management Service API to retrieve the current list of variables for the configured channel.
	 *
	 * @param {function} callback function that indicates if the list of variables has changed since the last call to this function.
	 */
	getVariablesFromManager(callback) {
		let self = this;

		try {
			let toReturn = false
			self.log('debug', `Requesting variables from ${this.config.manager_ip}:${this.config.manager_port}`);
			http.get(`http://${self.config.manager_ip}:${self.config.manager_port}/channels/${self.config.channel}/variables`, res => {
				let data = []
				const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
	
				res.on('data', chunk => {
					data.push(chunk)
				});
	
				res.on('end', () => {
					//If 200/OK, parse JSON response enumerating the channel's variables
					if (res.statusCode == 200) {
						let tmpVariableDefinitions = JSON.parse(Buffer.concat(data).toString())

						//Determine if any changes have actually occured before assigning to this.aditVariableDefinitions array
						if (JSON.stringify(tmpVariableDefinitions) != JSON.stringify(self.aditVariableDefinitions)) {
							toReturn = true
						}

						self.aditVariableDefinitions = tmpVariableDefinitions;
					}
					else {
						self.log('error', `Failed to get list of variables from AdIT Management Service with HTTP status code: ${res.statusCode}`)
					}

					//Fire callback function with toReturn to indicate whether or not the list has changed	
					if (typeof callback === 'function') {
						callback.bind(self)(toReturn)
					}
				});
	
			}).on('error', err => {
				self.log('error', `Failed to get list of variables from AdIT Management Service with HTTP error: ${err.message}`);
				self.updateStatus('error', 'Error getting variables');
				self.clearIntervals();
			});
		}
		catch(error) {
			self.log('error', `Error retrieving variables from AdIT Management Service: ${error}`);
			self.updateStatus('error', 'Error getting variables');
			self.clearIntervals();
		}
	},

	/**
	 * Calls AdIT Management Service API to retrieve the current list of instances.
	 *
	 * @param {function} callback function that indicates if the list of instances has changed since the last call to this function.
	 */
		getInstancesFromManager(callback) {
		let self = this;

		try {
			let toReturn = false
			self.log('debug', `Requesting instances from ${this.config.manager_ip}:${this.config.manager_port}`);
			http.get(`http://${self.config.manager_ip}:${self.config.manager_port}/channels/${self.config.channel}/instances`, res => {
				let data = []
				const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
	
				res.on('data', chunk => {
					data.push(chunk)
				});
	
				res.on('end', () => {
					//If 200/OK, parse JSON response enumerating the available channels
					if (res.statusCode == 200) {
						let tmpInstanceDefinitions = JSON.parse(Buffer.concat(data).toString());
						
						//Determine if any changes have actually occured before assigning to this.aditInstanceDefinitions array
						if (JSON.stringify(tmpInstanceDefinitions) != JSON.stringify(self.aditInstanceDefinitions)) {
							toReturn = true
						}

						self.aditInstanceDefinitions = tmpInstanceDefinitions
					}
					else {
						self.log('error', `Failed to get list of instances from AdIT Management Service with HTTP status code: ${res.statusCode}`)
					}

					//Fire callback function with toReturn to indicate whether or not the list has changed	
					if (typeof callback === 'function') {
						callback.bind(self)(toReturn)
					}
				});
	
			}).on('error', err => {
				self.log('error', `Failed to get list of instances from AdIT Management Service with HTTP error: ${err.message}`)
				self.updateStatus('error', 'Error getting instances');
				self.clearIntervals();
			});
		}
		catch(error) {
			self.log('error', `Error retrieving instances from AdIT Management Service: ${error}`);
			self.updateStatus('error', 'Error getting instances');
			self.clearIntervals();
		}
	},

	getChannelChoices() {
		let toReturn = []
		if (this.aditChannelDefinitions.length > 0) {
			toReturn.push({
				id: 'none',
				label: '(Select a Channel)'
			});

			this.aditChannelDefinitions.forEach((c) => {
					toReturn.push({
						id: c.ID,
						label: c.Name
					});
			});
		}
		else {
			toReturn.push({
				id: 'none',
				label: 'No Channels Loaded'
			});
		}

		return toReturn
	},

	getManualRuleChoices() {
		let toReturn = []
		if (this.aditManualRuleDefinitions.length > 0) {
			this.aditManualRuleDefinitions.forEach((mr) => {
				toReturn.push({
					id: mr.ID,
					label: mr.Name
				});
			});
		}
		return toReturn
	},

	getVariableChoices() {
		let toReturn = []
		if (this.aditVariableDefinitions.length > 0) {
			this.aditVariableDefinitions.forEach((v) => {
				toReturn.push({
					id: v.ID,
					label: v.Name
				});
			});
		}
		return toReturn
	},

	checkForPrimary() {
		this.log('debug', `Checking for primary AdIT instance...`);
		this.primaryFound = false;
		let primaryInstanceID = null;

		for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
			if (this.aditInstanceWebSockets[i].primary == true) {
				this.primaryFound = true;
				primaryInstanceID = this.aditInstanceWebSockets[i].ID;
				let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == primaryInstanceID);
				this.log('debug', `Primary AdIT instance: ${aditInstance.Name} (${aditInstance.ID})`);
				this.setVariableValues({
					primary_instance_id: aditInstance.ID,
					primary_instance_name: aditInstance.Name
				});
				this.aditPrimaryInstanceID = primaryInstanceID;
				break;
			}
		}

		//make sure the instance is marked as primary in the aditInstanceDefinitions array
		if (this.primaryFound == false) {
			this.log('warn', `A primary AdIT instance was not detected.`);
			this.reelectPrimary.bind(this)();
		}
	},

	reelectPrimary() {
		this.log('info', `Attempting to elect a primary AdIT instance...`);

		if (this.currentlyReelectingPrimary == true) {
			this.log('warn', `A primary AdIT instance was not detected, however re-election is already in progress`);
		}
		else {
			this.currentlyReelectingPrimary = true;

			this.log('warn', `Re-electing a new primary AdIT instance`);

			let primaryElected = false;

			let primaryInstanceID = null;

			for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
				if (this.aditInstanceWebSockets[i].state == 'open') { //select the first open instance
					this.aditInstanceWebSockets[i].primary = true;
					let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == this.aditInstanceWebSockets[i].ID);
					this.log('info', `AdIT instance elected as primary: ${aditInstance.Name} (${aditInstance.ID})`)
					this.setVariableValues({
						primary_instance_id: aditInstance.ID,
						primary_instance_name: aditInstance.Name
					});
					primaryElected = true;
					this.primaryFound = true;
					primaryInstanceID = this.aditInstanceWebSockets[i].ID;
					this.aditPrimaryInstanceID = primaryInstanceID;
					this.checkAditMessages();
					break;
				}
			}

			//now mark all others as not primary in the aditInstanceWebSockets array
			for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
				if (this.aditInstanceWebSockets[i].ID != primaryInstanceID) {
					this.aditInstanceWebSockets[i].primary = false;
				}
			}

			if (!primaryElected) {
				this.log('error', 'Failed to elect a new primary AdIT instance to receive messages from');
				this.primaryFound = false;					
				this.setVariableValues({
					primary_instance_id: undefined,
					primary_instance_name: undefined
				});
				this.updateStatus('error');
			}

			this.aditPrimaryInstanceID = primaryInstanceID;

			this.updateInstanceVariables();

			this.currentlyReelectingPrimary = false;
		}		
	},

	checkAditMessages() {
		let self = this;
		self.log('debug', `Stored values from AdIT instance ID: ${self.aditPrimaryInstanceID} will be applied`);

		//lets see if any messages arrived from any instances that are primary, that we now need to process
		for (let i = 0; i < self.aditMessages.length; i++) {
			if (self.aditMessages[i].instanceId == self.aditPrimaryInstanceID) {  //this is a message from our primary instance
				//if type is a variable
				if (self.aditMessages[i].type == 'variable') {
					//do something with this variable
					self.log('debug', `Applying stored value for variable: ${self.aditMessages[i].variableId}`);
					let variableObj = {};
					variableObj[self.aditMessages[i].variableId] = self.aditMessages[i].variableValue;
					self.setVariableValues(variableObj);
				}
			}
		}
	},
}