const { InstanceStatus } = require('@companion-module/base')

const WebSocket = require('ws')
const xml2js = require('xml2js')

module.exports = {
	initWebSockets() {
		this.updateStatus('unknown', 'Opening instance WebSocket connections...')

		//first go through and close out any existing websocket definitions, if they happen to exist
		this.closeWebSockets()

		//now open a websocket to each instance ID
		for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {
			let aditInstance = this.aditInstanceDefinitions[i]
			this.openWebSocket.bind(this)(aditInstance.ID, aditInstance.Primary)
		}

		//this.updateStatus(InstanceStatus.Ok)
		this.updateStatusObject('ws', 'initWebSockets', true, 'ok')

		if (this.config.channel !== 'none') {
			setTimeout(this.checkForPrimary.bind(this), 5000) //checks after 5 seconds
		}
	},

	openWebSocket(instanceID, primary) {
		let self = this

		if (self.config.verbose) {
			self.log('debug', 'Opening WebSocket connection for: ' + instanceID)
		}

		let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == instanceID)
		let aditInstanceWS = this.aditInstanceWebSockets.find((INSTANCE) => INSTANCE.ID == instanceID)

		if (aditInstance) {
			//check to see if this instance GUID is in the list of GUIDs already opened
			if (this.openConnectionGUIDs.includes(aditInstance.ID)) {
				//don't open a new connection, close this one first
				if (self.config.verbose) {
					self.log(
						'debug',
						`AdIT instance: "${aditInstance.Name}" (${aditInstance.ID}) is in the list of open connection GUIDs, so we will not open a new one.`,
					)
				}

				return
			}
		}

		if (aditInstance && aditInstanceWS) {
			//if the instance exists and the websocket exists
			if (self.config.verbose) {
				self.log('debug', `WebSocket already exists for AdIT instance: "${aditInstance.Name}" (${aditInstance.ID})`) //really shouldn't happen with the new openconnectionguids list
			}
		} else if (aditInstance && !aditInstanceWS) {
			//if the instance exists and the websocket does not exist
			if (self.config.verbose) {
				self.log('debug', `Creating WebSocket for AdIT instance: "${aditInstance.Name}" (${aditInstance.ID})`)
			}

			if (primary) {
				//if this is the/a primary Instance
				if (self.config.verbose) {
					self.log('info', `AdIT instance "${aditInstance.Name}" (${aditInstance.ID}) will be marked as Primary.`)
				}
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
				if (self.config.verbose) {
					self.log(
						'debug',
						`Attempting to open WebSocket connection to AdIT instance: "${aditInstance.Name}" (${aditInstance.ID})`,
					)
				}

				if (this.aditInstanceWebSockets[i].state == 'open') {
					//this websocket is already open
					if (self.config.verbose) {
						self.log(
							'debug',
							`WebSocket connection already open to AdIT instance: "${aditInstance.Name}" (${aditInstance.ID})`,
						)
					}
				} else {
					//this websocket is not open, so lets open it
					if (self.config.verbose) {
						console.log(
							`ws://${aditInstance.IPAddress}:${aditInstance.ControlInterfacePortNumber}/${this.config.control_interface_id}`,
						)
					}

					this.aditInstanceWebSockets[i].ws = new WebSocket(
						`ws://${aditInstance.IPAddress}:${aditInstance.ControlInterfacePortNumber}/${this.config.control_interface_id}`,
					)

					this.aditInstanceWebSockets[i].ws.on('open', () => {
						if (self.config.verbose) {
							self.log(
								'debug',
								`Opened WebSocket connection to AdIT instance: "${aditInstance.Name}" (${aditInstance.ID})`,
							)
						}

						//this.updateStatus(InstanceStatus.Ok)
						self.updateStatusObject.bind(self)(
							'ws',
							`websocket-${aditInstance.ID}`,
							true,
							'ok',
							`Connected to AdIT instance "${aditInstance.Name}" (${aditInstance.ID}).`,
						)

						this.aditInstanceWebSockets[i].state = 'ok'

						this.aditInstanceWebSockets[i].state = 'open'

						this.openConnectionGUIDs.push(aditInstance.ID)

						this.checkAllWebSockets()
					})

					this.aditInstanceWebSockets[i].ws.on('close', (code) => {
						if (this.aditInstanceWebSockets[i].state !== 'force-closed') {
							if (self.config.verbose) {
								self.log(
									'error',
									`WebSocket connection to AdIT instance: "${aditInstance.Name}" (${aditInstance.ID}) closed with code ${code}`,
								)
							}

							//this.updateStatus('warning');
							self.updateStatusObject.bind(self)(
								'ws',
								`websocket-${aditInstance.ID}`,
								false,
								'error',
								`Failed to communicate with AdIT instance "${aditInstance.Name}" (${aditInstance.ID}).`,
							)
							this.aditInstanceWebSockets[i].state = 'closed'

							if (this.aditInstanceWebSockets[i].primary == true) {
								//this.reelectPrimary();
							}

							//remove this instance from the openConnectionGUIDs array before attempting to re-open
							let index = this.openConnectionGUIDs.indexOf(this.aditInstanceWebSockets[i].ID)
							if (index > -1) {
								this.openConnectionGUIDs.splice(index, 1)
							}

							this.reconnectWebSocket(instanceID)
						} else {
							//this is a forced close
							if (self.config.verbose) {
								self.log(
									'debug',
									`WebSocket connection to AdIT instance: "${aditInstance.Name}" (${aditInstance.ID}) forcibly closed with code ${code}`,
								)
							}

							self.updateStatusObject.bind(self)(
								'ws',
								`websocket-${aditInstance.ID}`,
								true,
								'error',
								`Connection to AdIT instance "${aditInstance.Name}" (${aditInstance.ID}) forcibly closed.`,
							)

							//remove this instance from the openConnectionGUIDs array
							let index = this.openConnectionGUIDs.indexOf(this.aditInstanceWebSockets[i].ID)
							if (index > -1) {
								this.openConnectionGUIDs.splice(index, 1)
							}
						}

						this.checkAllWebSockets()
					})

					this.aditInstanceWebSockets[i].ws.on('message', (data) => {
						this.messageReceivedFromWebSocket.bind(this)(instanceID, primary, data)
					})

					this.aditInstanceWebSockets[i].ws.on('error', (data) => {
						let state = 'error'

						//this.updateStatus('warning');

						if (data.toString().indexOf('ECONNREFUSED') > -1) {
							state = 'conn-refused'

							self.updateStatusObject.bind(self)(
								'ws',
								`websocket-${aditInstance.ID}`,
								false,
								'error',
								`"${aditInstance.Name}" (${aditInstance.ID} refused. Is this AdIT instance still online?`,
							)
						} else {
							self.updateStatusObject.bind(self)(
								'ws',
								`websocket-${aditInstance.ID}`,
								false,
								'error',
								`"${aditInstance.Name}" (${aditInstance.ID} WS error: ${data}`,
							)
						}

						this.aditInstanceWebSockets[i].state = state

						if (this.aditInstanceWebSockets[i].primary == true) {
							this.reelectPrimary()
						}

						this.checkAllWebSockets()
					})
				}

				break
			}
		}

		if (this.config.channel !== 'none') {
			setTimeout(this.checkForPrimary.bind(this), 5000) //checks after 5 seconds
		}
	},

	reconnectWebSocket(instanceID) {
		let self = this

		let aditInstance = this.aditInstanceDefinitions.find((INSTANCE) => INSTANCE.ID == instanceID)
		if (aditInstance) {
			if (this.config.channel !== 'none') {
				if (self.config.verbose) {
					self.log(
						'debug',
						`Attempting to re-open WebSocket connection to instance "${aditInstance.Name}" (${aditInstance.ID})`,
					)
				}

				setTimeout(this.openWebSocket.bind(this), 3000, instanceID, aditInstance.Primary)
			}
		} else {
			this.updateStatusObject(
				'ws',
				`websocket-${aditInstance.ID}`,
				false,
				'error',
				`"${aditInstance.Name}" (${aditInstance.ID} not found. Cannot re-open WebSocket connection.`,
			)
		}
	},

	messageReceivedFromWebSocket(instanceID, isPrimary, data) {
		let self = this

		if (self.config.log_control_interface_messages == true) {
			self.log('debug', `AdIT control interface message received: ${data}`)
		}

		xml2js.parseString(data, function (err, result) {
			if (result.Variable) {
				if (self.config.log_control_interface_messages == true) {
					self.log('debug', `Variable message received from AdIT Instance: ${instanceID}`)
				}
				//This is a variable XML message that was received
				if (instanceID == self.aditPrimaryInstanceID) {
					//if this is a primary instance, save that variable value
					if (self.config.log_control_interface_messages == true) {
						//self.log('debug', 'This is the primary instance, so we will apply the variable value.')
					}
					let variableVal = {}
					variableVal[result.Variable.$.ID] = result.Variable._
					self.setVariableValues(variableVal)

					if (self.config.log_control_interface_messages == true) {
						//self.log('debug', `Variable ${result.Variable.$.ID} set to ${result.Variable._}`);
					}
				} else {
					if (self.config.log_control_interface_messages == true) {
						self.log('debug', 'This is not the primary instance, so we will not apply the variable value.')
						self.log('debug', `Primary instance ID: ${self.aditPrimaryInstanceID}`)
					}
				}

				//also just save the variable value to an array, in case a message arrives while we do not have a primary open, and then we will periodically check this array for any values to set
				let aditMessageObj = {}
				aditMessageObj.instanceId = instanceID
				aditMessageObj.type = 'variable'
				aditMessageObj.variableId = result.Variable.$.ID
				aditMessageObj.variableValue = result.Variable._

				//lets make sure that this variable is not already in the array
				let found = false

				for (let i = 0; i < self.aditMessages.length; i++) {
					if (
						self.aditMessages[i].instanceId == instanceID &&
						self.aditMessages[i].variableId == result.Variable.$.ID
					) {
						//this variable is already in the array, so we will just update the value
						if (self.config.log_control_interface_messages == true) {
							//self.log('debug', `Variable ${result.Variable.$.ID} already exists in the array, so we will just update the value.`)
						}
						self.aditMessages[i].variableValue = result.Variable._
						found = true
						break
					}
				}

				if (!found) {
					if (self.config.log_control_interface_messages == true) {
						//self.log('debug', `Variable ${result.Variable.$.ID} does not exist in the array, so we will add it.`)
					}
					self.aditMessages.push(aditMessageObj)
				}
			} else {
				//maybe some other type of message was received that we haven't implemented yet
			}
		})
	},

	checkAllWebSockets() {
		let self = this

		let instanceOpenCount = 0
		for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
			if (this.aditInstanceWebSockets[i].state == 'open') {
				instanceOpenCount++
			}
		}

		if (instanceOpenCount == 0) {
			//no AdIT instance connections are open/available
			if (self.config.verbose) {
				self.log(
					'error',
					`No AdIT instance WebSocket connections available. The module will not function properly until at least one AdIT instance connection is connected.`,
				)
			}

			//this.updateStatus('error')
			/*this.updateStatusObject(
				'ws',
				'checkAllWebSockets',
				false,
				'error',
				'No AdIT instance WebSocket connections available. The module will not function properly until at least one AdIT instance connection is connected.',
			)*/
		} else {
			this.updateStatusObject('ws', 'checkAllWebSockets', true, 'ok')
		}

		this.setVariableValues({
			instances_connected: instanceOpenCount,
		})

		//Loop through instance definitions to set "_connected" variables for each
		let instanceConnectedVariableValues = {}
		for (let i = 0; i < this.aditInstanceDefinitions.length; i++) {
			let aditInstance = this.aditInstanceDefinitions[i]
			//If this instance ID is found in openConnectionGUIDs, then set connected to true, otherwise false
			if (this.openConnectionGUIDs.indexOf(aditInstance.ID) > -1) {
				instanceConnectedVariableValues[`instance_${i + 1}_connected`] = 'True'
			} else {
				instanceConnectedVariableValues[`instance_${i + 1}_connected`] = 'False'
			}
		}
		this.setVariableValues(instanceConnectedVariableValues)
	},

	closeWebSockets() {
		let self = this

		if (this.aditInstanceWebSockets.length > 0) {
			self.log('debug', 'Closing WebSockets connections...')

			for (let i = 0; i < this.aditInstanceWebSockets.length; i++) {
				if (self.config.verbose) {
					self.log('debug', `Closing WebSocket connection to AdIT instance: ${this.aditInstanceWebSockets[i].ID}`)
				}

				this.aditInstanceWebSockets[i].state = 'force-closed'
				this.aditInstanceWebSockets[i].ws.terminate()
				delete this.aditInstanceWebSockets[i].ws

				//remove this instance from the openConnectionGUIDs array
				let index = this.openConnectionGUIDs.indexOf(this.aditInstanceWebSockets[i].ID)
				if (index > -1) {
					this.openConnectionGUIDs.splice(index, 1)
				}
			}
		}
	},
}
