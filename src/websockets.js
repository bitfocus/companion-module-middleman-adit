const WebSocket = require('ws')
const xml2js = require('xml2js')

module.exports = {

	initWebSockets() {
		this.updateStatus('unknown', 'Opening Instance Websocket Connections...');

		//first go through and close out any existing websocket definitions, if they happen to exist
		this.closeWebSockets();

		//now open a websocket to each instance ID
		for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {
			let aditInstance = this.aditInstanceDefinitions[i];
			this.openWebSocket.bind(this)(aditInstance.ID, aditInstance.Primary);	
		}

		this.updateStatus('ok');

		//if (this.config.channel !== 'none') {
			setTimeout(this.checkForPrimary.bind(this), 5000); //checks after 5 seconds
		//}
	},

	openWebSocket(instanceID, primary) {
		let self = this;

		this.log('debug', 'Opening WebSocket Connection for: ' + instanceID);
		
		let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == instanceID);
		let aditInstanceWS = this.aditInstanceWebSockets.find((INSTANCE) => INSTANCE.ID == instanceID);

		if (aditInstance) {
			//check to see if this instance GUID is in the list of GUIDs already opened
			if (this.openConnectionGUIDs.includes(aditInstance.ID)) {
				//don't open a new connection, close this one first
				this.log('debug', `AdIT Instance: ${aditInstance.Name} is in the list of open connection GUIDs, so we will not open a new one.`);
				return
			}
		}

		if (aditInstance && aditInstanceWS) { //if the instance exists and the websocket exists
			this.log('debug', `WebSocket already exists for AdIT Instance: ${aditInstance.Name}`); //really shouldn't happen with the new openconnectionguids list
		}
		else if (aditInstance && !aditInstanceWS) { //if the instance exists and the websocket does not exist
			this.log('debug', `Creating WebSocket for AdIT Instance: ${aditInstance.Name}`);

			if (primary) { //if this is the/a primary Instance
				this.log('info', `AdIT Instance ${aditInstance.Name} will be marked as Primary.`);
			}
			//add new index to the ws array, and then open the websocket
			this.aditInstanceWebSockets.push({
				ID: instanceID,
				primary: primary,
				state: 'closed',
			})
		}

		for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
			if (this.aditInstanceWebSockets[i].ID == instanceID) {
				this.log('debug', `Attempting to open WebSocket connection to AdIT Instance: ${aditInstance.Name}`);
				//this.log('debug', `WebSocket Path: ${aditInstance.IPAddress}:${aditInstance.ControlInterfacePortNumber}`);

				if (this.aditInstanceWebSockets[i].state == 'open') {
					this.log('debug', `WebSocket connection already open to AdIT Instance: ${aditInstance.Name}`);
				}
				else {
					this.aditInstanceWebSockets[i].ws = new WebSocket(`ws://${aditInstance.IPAddress}:${aditInstance.ControlInterfacePortNumber}/${this.aditControlInterfaceID}`);

					this.aditInstanceWebSockets[i].ws.on('open', () => {
						this.log('info', `AdIT Instance Control Interface WebSocket connection opened: ${aditInstance.Name}`)
						this.updateStatus('ok')
						this.aditInstanceWebSockets[i].state = 'ok';
		
						this.aditInstanceWebSockets[i].state = 'open';

						this.openConnectionGUIDs.push(aditInstance.ID);
		
						this.checkAllWebSockets(); 
					});
			
					this.aditInstanceWebSockets[i].ws.on('close', (code) => {
						if (this.aditInstanceWebSockets[i].state !== 'force-closed') {
							this.log('warn', `AdIT Instance (${aditInstance.Name}) Control Interface WebSocket connection closed with code ${code}`)
							//this.updateStatus('warning');
							this.aditInstanceWebSockets[i].state = 'closed';
	
							if (this.aditInstanceWebSockets[i].primary == true) {
								//this.reelectPrimary();
							}
	
							//remove this instance from the openConnectionGUIDs array before attempting to re-open
							let index = this.openConnectionGUIDs.indexOf(this.aditInstanceWebSockets[i].ID);
							if (index > -1) {
								this.openConnectionGUIDs.splice(index, 1);
							}

							this.reconnectWebSocket(instanceID);
						}
						else {
							this.log('debug', `AdIT Instance (${aditInstance.Name}) Control Interface WebSocket connection forced closed with code ${code}`);

							//remove this instance from the openConnectionGUIDs array
							let index = this.openConnectionGUIDs.indexOf(this.aditInstanceWebSockets[i].ID);
							if (index > -1) {
								this.openConnectionGUIDs.splice(index, 1);
							}
						}
						
						this.checkAllWebSockets();
					});		
		
					this.aditInstanceWebSockets[i].ws.on('message', (data) => {
						this.messageReceivedFromWebSocket.bind(this)(instanceID, primary, data)
					});
			
					this.aditInstanceWebSockets[i].ws.on('error', (data) => {
						let state = 'error';
		
						//this.updateStatus('warning');
		
						if (data.toString().indexOf('ECONNREFUSED') > -1) {
							state = 'conn-refused';
							this.log('warn', `AdIT Instance (${aditInstance.Name}) Connection Refused. Is this Instance still online?`)
						}
						else {
							this.log('warn', `AdIT Instance (${aditInstance.Name}) Control Interface WebSocket error: ${data}`)
						}
						
						this.aditInstanceWebSockets[i].state = state;
	
						if (this.aditInstanceWebSockets[i].primary == true) {
							this.reelectPrimary();
						}
				
						this.checkAllWebSockets();
					})
				}				

				break;
			}				
		}

		//if (this.config.channel !== 'none') {
			setTimeout(this.checkForPrimary.bind(this), 5000); //checks after 5 seconds
		//}
	},

	reconnectWebSocket(instanceID) {
		let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == instanceID);
		if (aditInstance) {
			if (this.config.channel !== 'none') {
				this.log('debug', `Attempting to re-open websocket connection to: ${aditInstance.Name}`);
				setTimeout(this.openWebSocket.bind(this), 3000, instanceID, aditInstance.Primary);
			}
		}
		else {
			this.log('debug', `AdIT Instance ${instanceID} not found. Cannot re-open websocket connection.`);
		}		
	},

	messageReceivedFromWebSocket(instanceID, isPrimary, data) {
		let self = this;

		//let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == instanceID);
		//let aditInstanceWS = this.aditInstanceWebSockets.find((INSTANCE) => INSTANCE.ID == instanceID);
	
		if (self.config.log_control_interface_messages == true) {
			self.log('debug', `AdIT Control Interface message received: ${data}`)
		}

		xml2js.parseString(data, function (err, result) {
			if (result.Variable) {
				if (self.config.log_control_interface_messages == true) {
					//self.log('debug', `Variable message received from AdIT Instance: ${instanceID}`);
				}
				//This is a variable XML message that was received
				if (instanceID == self.aditPrimaryInstanceID) {
					//if this is a primary instance, save that variable value
					if (self.config.log_control_interface_messages == true) {
						//self.log('debug', 'This is a primary instance, so we will save the variable value.');
					}
					let variableVal = {}
					variableVal[result.Variable.$.ID] = result.Variable._
					self.setVariableValues(variableVal)

					if (self.config.log_control_interface_messages == true) {
						//self.log('debug', `Variable ${result.Variable.$.ID} set to ${result.Variable._}`);
					}
				}
				else {
					if (self.config.log_control_interface_messages == true) {
						//self.log('debug', 'This is not a primary instance, so we will not save the variable value.');
						//self.log('debug', `Primary Instance ID: ${self.aditPrimaryInstanceID}`);
					}
				}			

				//also just save the variable value to an array, in case a message arrives while we do not have a primary open, and then we will periodically check this array for any values to set
				let aditMessageObj = {};
				aditMessageObj.instanceId = instanceID;
				aditMessageObj.type = 'variable';
				aditMessageObj.variableId = result.Variable.$.ID;
				aditMessageObj.variableValue = result.Variable._;

				//lets make sure that this variable is not already in the array
				let found = false;

				for (let i = 0; i < self.aditMessages.length; i++) {
					if (self.aditMessages[i].instanceId == instanceID && self.aditMessages[i].variableId == result.Variable.$.ID) {
						//this variable is already in the array, so we will just update the value
						if (self.config.log_control_interface_messages == true) {
							//self.log('debug', `Variable ${result.Variable.$.ID} already exists in the array, so we will just update the value.`)
						}
						self.aditMessages[i].variableValue = result.Variable._;
						found = true;
						break;
					}
				}

				if (!found) {
					if (self.config.log_control_interface_messages == true) {
						//self.log('debug', `Variable ${result.Variable.$.ID} does not exist in the array, so we will add it.`)
					}
					self.aditMessages.push(aditMessageObj);
				}
			}
			else {
				//maybe some other type of message was received that we haven't implemented yet
			}
		});
	},

	checkAllWebSockets() {
		let instanceOpenCount = 0;
		for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
			if (this.aditInstanceWebSockets[i].state == 'open') {
				instanceOpenCount++;
			}
		}

		if (instanceOpenCount == 0) {
			this.log('error', `No Instance WebSocket connections available. The module will not function properly until an Instance connection is available.`);
			this.updateStatus('error');
		}

		this.setVariableValues({
			instance_connections_open: instanceOpenCount
		});
	},

	closeWebSockets() {
		if (this.aditInstanceWebSockets.length > 0) {
			this.log('info', 'Closing Web Sockets...');

			for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
				this.log('debug', `Closing WebSocket connection to AdIT Instance: ${this.aditInstanceWebSockets[i].ID}`)
				this.aditInstanceWebSockets[i].state = 'force-closed';
				this.aditInstanceWebSockets[i].ws.terminate();
				delete this.aditInstanceWebSockets[i].ws;

				//remove this instance from the openConnectionGUIDs array
				let index = this.openConnectionGUIDs.indexOf(this.aditInstanceWebSockets[i].ID);
				if (index > -1) {
					this.openConnectionGUIDs.splice(index, 1);
				}
			}
	
			//now reset the entire websocket array
			//this.aditInstanceWebSockets = [];
		}		
	}
}