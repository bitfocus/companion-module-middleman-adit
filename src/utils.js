const { InstanceStatus } = require('@companion-module/base')

const http = require('http')

module.exports = {
	startConfigTimer() { //starts the config timer/interval which will request a new list of Channels from the Management Service
		if (this.config_timer) { //clear the interval if it already exists
			clearInterval(this.config_timer)
		}

		this.updateStatus(InstanceStatus.Warning, 'Getting Channels from Management Service...');

		this.getChannels(); //immediately ask for the list of channels

		//On interval, call AdIT Management Service API for current lists of channels
		this.log('debug', `Requesting Channels from Management Service every ${this.config.config_polling_rate} seconds...`);
		this.config_timer = setInterval(this.getChannels.bind(this), (parseInt(this.config.config_polling_rate) * 1000));
	},

	getChannels() {
		let self = this;
		self.log('debug', 'Getting Channels from Manager...');
		self.getChannelsFromManager.bind(self)(function (channelsChanged) {
			if (channelsChanged) { //Only update if changes are made to one or more of the lists
				self.log('debug', `Available AdIT Channel options have changed, updating...`);
				//self.updateStatus(InstanceStatus.Warning, 'Choose a Channel in the Config.');
				self.getConfigFields(); //reloads the config fields
			}
			if (self.config.channel == 'none') {
				self.updateStatus('warn', 'Choose a Channel in the Config.');
				self.log('warn', 'No Channel selected, choose a Channel in the Config.');
				//self.updateStatus(InstanceStatus.Ok);
			}
			else {
				//probably ok
				self.updateStatus(InstanceStatus.Ok);
			}

			//clear the timer so they have a chance to choose
			clearInterval(self.config_timer);
			self.config_timer = undefined;
		});
	},

	startChannelDataTimer() { //requests the Channel Data (Manual Rules, Variables, and Instances) on a timer/interval
		if (this.channelDataTimer) { //clear the interval if it already exists
			clearInterval(this.channelDataTimer)
		}

		this.updateStatus(InstanceStatus.Ok);
		console.log('CONFIGURED CHANNEL:')
		console.log(this.config.channel);
		if (this.config.channel !== 'none') {
			//only proceed if they have configured a channel

			this.getChannelData(); //immediately request the channel data before setting the interval

			//On interval, call AdIT Management Service API for current lists of channel specific data - manual rules, variables, instances
			this.channelDataTimer = setInterval(this.getChannelData.bind(this), (parseInt(this.config.config_polling_rate) * 1000));
		}
	},

	getChannelData() { //requests the Manual Rules, Variables, and Instances from the AdIT Management Service
		let self = this;

		if (self.config.channel !== 'none') {
			this.getManualRulesFromManager.bind(this)(function (manualRulesChanged) {
				let self = this;

				if (manualRulesChanged) {
					//reload actions
					self.log('debug', `Available AdIT Manual Rules have changed, updating...`)
					self.initActions();
				}
			})

			this.getVariablesFromManager.bind(this)(function (variablesChanged) {
				let self = this;

				if (variablesChanged) {
					//reload variables
					self.log('debug', `Available AdIT Variables have changed, updating...`)

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
					this.log('debug', `Available AdIT Instances have changed, updating...`);
					try {
						this.VARIABLES_INSTANCES = []; //reset the array of Companion variables related to Instances, since the Instances data has changed
						
						this.VARIABLES_INSTANCES.push({
							name: 'Instance Count',
							variableId: 'instance_count'
						});

						this.VARIABLES_INSTANCES.push({
							name: 'Instance Primary Name',
							variableId: 'instance_primary_name'
						});

						this.VARIABLES_INSTANCES.push({
							name: 'Instance Connections Open',
							variableId: 'instance_connections_open'
						});
		
						for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {		
							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} Name`,
								variableId: `instance_name_${i+1}`
							})
		
							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} Description`,
								variableId: `instance_description_${i+1}`
							})
		
							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} Primary`,
								variableId: `instance_primary_${i+1}`
							})
		
							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} IP Address`,
								variableId: `instance_ipaddress_${i+1}`
							})

							this.VARIABLES_INSTANCES.push({
								name: `Instance ${i+1} Control Port`,
								variableId: `instance_controlport_${i+1}`
							})
						}

						this.createVariables(); //now create all Companion Variables (both Instance and Management Variables)

						this.updateInstanceVariables();
					}
					catch(error) {
						this.log('debug', `Error setting Instance Information Variables: ${error.toString()}`);
					}
					
					this.initWebSockets();
				}
			})
		}
		else {
			this.log('warn', `No Channel selected, choose a Channel in the Config.`);
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

		variableValues.instance_count = this.aditInstanceDefinitions.length;

		//now populate the Instance variables
		for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {
			let aditInstance = this.aditInstanceDefinitions[i];

			if (aditInstance.hasOwnProperty('Name')) {
				variableValues[`instance_name_${i+1}`] = aditInstance.Name;
			}
			
			if (aditInstance.hasOwnProperty('Description')) {
				variableValues[`instance_description_${i+1}`] = aditInstance.Description;
			}

			/*if (aditInstance.hasOwnProperty('Primary')) {
				variableValues[`instance_primary_${i+1}`] = aditInstance.Primary ? 'True' : 'False';
			}*/
			//check to see if this instance is the primary instance
			if (aditInstance.hasOwnProperty('ID') && aditInstance.ID == this.aditPrimaryInstanceID) {
				variableValues[`instance_primary_${i+1}`] = 'True';
			}
			else {
				variableValues[`instance_primary_${i+1}`] = 'False';
			}

			if (aditInstance.hasOwnProperty('IPAddress')) {
				variableValues[`instance_ipaddress_${i+1}`] = aditInstance.IPAddress;
			}

			if (aditInstance.hasOwnProperty('ControlInterfacePortNumber')) {
				variableValues[`instance_controlport_${i+1}`] = aditInstance.ControlInterfacePortNumber;
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
			self.log('debug', `Getting Channels from ${this.config.manager_ip}:${this.config.manager_port}`)
			http.get(`http://${this.config.manager_ip}:${this.config.manager_port}/channels`, res => {
				let data = []
				const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'
	
				res.on('data', chunk => {
					data.push(chunk)
				})
	
				res.on('end', () => {
					//If 200/OK, parse JSON response enumerating the available channels
					//try {
						if (res.statusCode == 200) {
							let tmpChannelDefinitions = JSON.parse(Buffer.concat(data).toString())
		
							//Determine if any changes have actually occured before assigning to this.aditChannelDefinitions array
							if (JSON.stringify(tmpChannelDefinitions) != JSON.stringify(self.aditChannelDefinitions)) {
								toReturn = true
							}
		
							self.aditChannelDefinitions = tmpChannelDefinitions
						}
						else {
							//self.log('error', `Failed to get list of Channel definitions from AdIT Management Service with HTTP status code: ${res.statusCode}`)
						}
		
						//Fire callback function with toReturn to indicate whether or not the list has changed	
						if (typeof callback === 'function') {
							callback.bind(self)(toReturn)
						}
					/*}
					catch(error) {
						self.log('error', `Failed to get list of Channel definitions from AdIT Management Service. Response Error: ${error.toString()}`)
						self.updateStatus('error', 'Error getting Channels');
						self.clearIntervals();
					}*/
				})
	
			}).on('error', err => {
				self.log('error', `Failed to get list of Channel definitions from AdIT Management Service with error: ${err.message}`)
				self.updateStatus('error', 'Error getting Channels');
				self.clearIntervals();
			})
		}
		catch(error) {
			self.log('error', 'Error retrieving Channels from AdIT Management Server. Error: ' + error.toString());
			self.updateStatus('error', 'Error getting Channels');
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
			self.log('debug', `Getting Manual Rules From Manager...`);
			self.log('debug', `http://${self.config.manager_ip}:${self.config.manager_port}/channels/${self.config.channel}/messaging-rules`);
			http.get(`http://${self.config.manager_ip}:${self.config.manager_port}/channels/${self.config.channel}/messaging-rules`, res => {
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
							if (JSON.stringify(tmpManualRuleDefinitions) != JSON.stringify(self.aditManualRuleDefinitions)) {
								toReturn = true
							}

							self.aditManualRuleDefinitions = tmpManualRuleDefinitions
						}
						else {
							self.log('error', `Failed to get list of messaging rule definitions from AdIT Management Service with HTTP status code: ${res.statusCode}`)
						}

						//Fire callback function with toReturn to indicate whether or not the list has changed	
						if (typeof callback === 'function') {
							callback.bind(self)(toReturn)
						}
					}
					catch(error) {
						self.log('error', `Failed to get list of Manual Rules from AdIT Management Service. Error: ${error.toString()}`)
						self.updateStatus('error', 'Error getting Manual Rules');
						self.clearIntervals();
					}
				})
	
			}).on('error', err => {
				self.log('error', `Failed to get list of Manual Rule definitions from AdIT Management Service with error: ${err.message}`)
				self.updateStatus('error', 'Error getting Manual Rules');
				self.clearIntervals();
			})
		}
		catch(error) {
			self.log('error', 'Error retrieving Manual Rules from AdIT Management Server. Error: ' + error.toString());
			self.updateStatus('error', 'Error getting Manual Rules');
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
			self.log('debug', `Getting Variables From Manager...`);
			self.log('debug', `http://${self.config.manager_ip}:${self.config.manager_port}/channels/${self.config.channel}/variables`);
			http.get(`http://${self.config.manager_ip}:${self.config.manager_port}/channels/${self.config.channel}/variables`, res => {
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
							if (JSON.stringify(tmpVariableDefinitions) != JSON.stringify(self.aditVariableDefinitions)) {
								toReturn = true
							}

							self.aditVariableDefinitions = tmpVariableDefinitions;
						}
						else {
							self.log('error', `Failed to get list of Variable Definitions from AdIT Management Service with HTTP status code: ${res.statusCode}`)
						}

						//Fire callback function with toReturn to indicate whether or not the list has changed	
						if (typeof callback === 'function') {
							callback.bind(self)(toReturn)
						}
					}
					catch(error) {
						self.log('error', `Failed to get list of Variable Definitions from AdIT Management Service. Error: ${error.toString()}`)
						self.updateStatus('error', 'Error getting Variables');
						self.clearIntervals();
					}
				})
	
			}).on('error', err => {
				self.log('error', `Failed to get list of Variable Definitions from AdIT Management Service with error: ${err.message}`)
				self.updateStatus('error', 'Error getting Variables');
				self.clearIntervals();
			})
		}
		catch(error) {
			self.log('error', 'Error retrieving Variables from AdIT Management Server. Error: ' + error.toString());
			self.updateStatus('error', 'Error getting Variables');
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
			self.log('debug', `Getting Instances From Manager...`);
			self.log('debug', `http://${self.config.manager_ip}:${self.config.manager_port}/channels/${self.config.channel}/instances`);
			http.get(`http://${self.config.manager_ip}:${self.config.manager_port}/channels/${self.config.channel}/instances`, res => {
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

							console.log('tmpInstanceDefinitions: ')
							console.log(tmpInstanceDefinitions);

							//Determine if any changes have actually occured before assigning to this.aditInstanceDefinitions array
							if (JSON.stringify(tmpInstanceDefinitions) != JSON.stringify(self.aditInstanceDefinitions)) {
								toReturn = true
							}

							self.aditInstanceDefinitions = tmpInstanceDefinitions
						}
						else {
							self.log('error', `Failed to get list of Instance definitions from AdIT Management Service with HTTP status code: ${res.statusCode}`)
						}

						//Fire callback function with toReturn to indicate whether or not the list has changed	
						if (typeof callback === 'function') {
							callback.bind(self)(toReturn)
						}
					}
					catch(error) {
						self.log('error', `Failed to get list of Instances from AdIT Management Service. Error: ${error.toString()}`)
						self.updateStatus('error', 'Error getting Instances');
						self.clearIntervals();
					}
				})
	
			}).on('error', err => {
				self.log('error', `Failed to get list of Instance definitions from AdIT Management Service with error: ${err.message}`)
				self.updateStatus('error', 'Error getting Instances');
				self.clearIntervals();
			})
		}
		catch(error) {
			self.log('error', 'Error retrieving Instances from AdIT Management Server. Error: ' + error.toString());
			self.updateStatus('error', 'Error getting Instances');
			self.clearIntervals();
		}
	},

	getChannelChoices() {
		let toReturn = []
		if (this.aditChannelDefinitions.length > 0) {
			toReturn.push({
				id: 'none',
				label: '(Select a Channel)'
			})

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
	},

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
	},

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
	},

	checkForPrimary() {
		this.log('info', `Checking for Primary Instance...`);
		this.primaryFound = false;
		let primaryInstanceID = null;

		for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
			if (this.aditInstanceWebSockets[i].primary == true) {
				this.primaryFound = true;
				primaryInstanceID = this.aditInstanceWebSockets[i].ID;
				let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == primaryInstanceID);
				this.log('info', `Primary Instance Found: ${aditInstance.Name}`);
				this.setVariableValues({
					instance_primary_name: aditInstance.Name
				});
				break;
			}
		}

		//make sure the instance is marked as primary in the aditInstanceDefinitions array
		if (this.primaryFound == false) {
			this.log('warn', `A Primary AdIT Instance was not detected.`);
			this.reelectPrimary.bind(this)();
		}
	},

	reelectPrimary() {
		this.log('info', `Attempting to Elect a Primary Instance...`);

		if (this.currentlyReelectingPrimary == true) {
			this.log('warn', `A Primary AdIT Instance was not detected, but a re-election is already in progress.`);
		}
		else {
			this.currentlyReelectingPrimary = true;

			this.log('warn', `Re-Electing a new Primary.`);

			let primaryElected = false;

			let primaryInstanceID = null;

			for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
				if (this.aditInstanceWebSockets[i].state == 'open') { //select the first open instance
					this.aditInstanceWebSockets[i].primary = true;
					let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == this.aditInstanceWebSockets[i].ID);
					this.log('info', `New Instance Marked as Primary: ${aditInstance.Name}`)
					this.setVariableValues({
						instance_primary_name: aditInstance.Name
					});
					primaryElected = true;
					this.primaryFound = true;
					primaryInstanceID = this.aditInstanceWebSockets[i].ID;
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
				this.log('error', 'Unable to select a new Primary Instance to receive messages from.');
				this.primaryFound = false;
				this.updateStatus('error');
			}

			this.aditPrimaryInstanceID = primaryInstanceID;

			this.updateInstanceVariables();

			this.currentlyReelectingPrimary = false;
		}		
	}
}