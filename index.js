var instance_skel = require('../../instance_skel')
const { v4: uuidv4 } = require('uuid')
const http = require('http')
const WebSocket = require('ws')
const xml2js = require('xml2js')

class instance extends instance_skel {
	isInitialized = false

	constructor(system, id, config) {
		super(system, id, config)

		this.subscriptions = new Map()

		this.actions()
		this.initFeedbacks()
		this.subscribeFeedbacks()

		this.aditChannelDefinitions = []
		this.aditManualRuleDefinitions = []
		this.aditVariableDefinitions = []
		this.aditControlInterfaceID = uuidv4()

		return this
	}

	init() {
		this.log('info', `AdIT instance Control Interface client ID: ${this.aditControlInterfaceID}`)
		this.updateVariables()
		this.initWebSocket()

		this.getChannelsFromManager()
		this.getManualRulesFromManager()
		this.getVariablesFromManager()

		this.config_fields()
		this.actions(system)

		if (this.config_timer) {
			clearInterval(this.config_timer)
		}
		this.config_timer = setInterval(() => {
			//On interval, call AdIT Management Service API for current lists of channels, manual rules and variables
			//Only call companion config_fields() and actions() if changes are made to one or more of the lists
			var myThis = this
			myThis.getChannelsFromManager(function (channelsChanged) {
				myThis.getManualRulesFromManager(function (manualRulesChanged) {
					myThis.getVariablesFromManager(function (variablesChanged) {
						if (channelsChanged || manualRulesChanged || variablesChanged) {
							myThis.log('debug', `Available AdIT options have changed, updating...`)
							myThis.config_fields()
							myThis.actions(system)
						}
					})
				})
			})

		}, 5000)

		this.isInitialized = true
	}

	destroy() {
		this.isInitialized = false

		if (this.config_timer) {
			clearInterval(this.config_timer)
			this.config_timer = null
		}

		if (this.reconnect_timer) {
			clearTimeout(this.reconnect_timer)
			this.reconnect_timer = null
		}

		if (this.ws !== undefined) {
			this.ws.close(1000)
			delete this.ws
		}
	}

	updateConfig(config) {
		this.config = config

		//Re-init the WebSocket only if required due to config change:
		if (this.ws == null || this.ws._url != `ws://${this.config.instance_ip}:${this.config.instance_port}/${this.aditControlInterfaceID}`) {
			this.initWebSocket()
		}
	}

	updateVariables(callerId = null) {
	}

	maybeReconnect() {
		if (this.isInitialized) {
			if (this.reconnect_timer) {
				clearTimeout(this.reconnect_timer)
			}
			this.reconnect_timer = setTimeout(() => {
				this.initWebSocket()
			}, 5000)
		}
	}

	/**
	 * Calls AdIT Management Service API to retrieve the current list of channels.
	 *
	 * @param {function} callback function that indicates if the list of channels has changed since the last call to this function.
	 */
	getChannelsFromManager(callback) {
		var toReturn = false
		http.get(`http://${this.config.manager_ip}:${this.config.manager_port}/channels`, res => {
			let data = []
			const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'

			res.on('data', chunk => {
				data.push(chunk)
			})

			res.on('end', () => {
				//If 200/OK, parse JSON response enumerating the available channels
				if (res.statusCode == 200) {
					var tmpChannelDefinitions = JSON.parse(Buffer.concat(data).toString())

					//Determine if any changes have actually occured before assigning to this.aditChannelDefinitions array
					if (JSON.stringify(tmpChannelDefinitions) != JSON.stringify(this.aditChannelDefinitions)) {
						toReturn = true
					}

					this.aditChannelDefinitions = tmpChannelDefinitions
				}
				else {
					this.log('error', `Failed to get list of channel definitions from AdIT Management Service with HTTP status code: ${res.statusCode}`)
				}

				//Fire callback function with toReturn to indicate whether or not the list has changed	
				if (typeof callback === 'function') {
					callback(toReturn)
				}
			})

		}).on('error', err => {
			this.log('error', `Failed to get list of channel definitions from AdIT Management Service with error: ${err.message}`)
		})
	}


	/**
	 * Calls AdIT Management Service API to retrieve the current list of manual rules for the configured channel.
	 *
	 * @param {function} callback function that indicates if the list of manual rules has changed since the last call to this function.
	 */
	getManualRulesFromManager(callback) {
		var toReturn = false
		http.get(`http://${this.config.manager_ip}:${this.config.manager_port}/channels/${this.config.channel}/messaging-rules`, res => {
			let data = []
			const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'

			res.on('data', chunk => {
				data.push(chunk)
			})

			res.on('end', () => {
				//If 200/OK, parse JSON response enumerating the channel's messaging rules
				if (res.statusCode == 200) {
					var tmpRuleDefinitions = JSON.parse(Buffer.concat(data).toString())
					var tmpManualRuleDefinitions = []

					//Filter tmpRuleDefinitions down to only manual (type 1) rules to populate tmpManualRuleDefinitions
					for (var tmpRule of tmpRuleDefinitions) {
						var ruleContents = JSON.parse(tmpRule.JSON)
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
					callback(toReturn)
				}
			})

		}).on('error', err => {
			this.log('error', `Failed to get list of messaging rule definitions from AdIT Management Service with error: ${err.message}`)
		})
	}

	/**
	 * Calls AdIT Management Service API to retrieve the current list of variables for the configured channel.
	 *
	 * @param {function} callback function that indicates if the list of variables has changed since the last call to this function.
	 */
	getVariablesFromManager(callback) {
		var toReturn = false
		http.get(`http://${this.config.manager_ip}:${this.config.manager_port}/channels/${this.config.channel}/variables`, res => {
			let data = []
			const headerDate = res.headers && res.headers.date ? res.headers.date : 'no response date'

			res.on('data', chunk => {
				data.push(chunk)
			})

			res.on('end', () => {
				//If 200/OK, parse JSON response enumerating the channel's variables
				if (res.statusCode == 200) {
					var tmpVariableDefinitions = JSON.parse(Buffer.concat(data).toString())

					//Construct array of companion variable definitions and call set for all available AdIT variable definitions:
					var companionVarDefs = []
					for (var tmpVar of tmpVariableDefinitions) {
						companionVarDefs.push({
							label: tmpVar.Name,
							name: tmpVar.ID
						})
					}

					//Determine if any changes have actually occured before assigning to this.aditVariableDefinitions array
					if (JSON.stringify(tmpVariableDefinitions) != JSON.stringify(this.aditVariableDefinitions)) {
						toReturn = true
					}

					this.aditVariableDefinitions = tmpVariableDefinitions;
					this.setVariableDefinitions(companionVarDefs)
				}
				else {
					this.log('error', `Failed to get list of variable definitions from AdIT Management Service with HTTP status code: ${res.statusCode}`)
				}

				//Fire callback function with toReturn to indicate whether or not the list has changed	
				if (typeof callback === 'function') {
					callback(toReturn)
				}
			})

		}).on('error', err => {
			this.log('error', `Failed to get list of variable definitions from AdIT Management Service with error: ${err.message}`)
		})
	}

	initWebSocket() {
		if (this.reconnect_timer) {
			clearTimeout(this.reconnect_timer)
			this.reconnect_timer = null
		}
		var ip = this.config.instance_ip
		var port = this.config.instance_port
		this.status(this.STATUS_UNKNOWN)
		if (!ip || !port) {
			this.status(this.STATUS_ERROR, `Configuration error - no AdIT instance IP and/or port defined`)
			return
		}

		//Ensure this.ws is unassigned and then construct using configuration parameters provided
		if (this.ws !== undefined) {
			this.ws.close(1000)
			delete this.ws
		}
		this.ws = new WebSocket(`ws://${this.config.instance_ip}:${this.config.instance_port}/${this.aditControlInterfaceID}`)

		this.ws.on('open', () => {
			this.log('debug', `AdIT instance Control Interface WebSocket connection opened`)
			this.status(this.STATUS_OK)
		})
		this.ws.on('close', (code) => {
			this.log('debug', `AdIT instance Control Interface WebSocket connection closed with code ${code}`)
			this.status(this.STATUS_ERROR, `AdIT instance connection closed with code ${code}`)
			this.maybeReconnect()
		})

		this.ws.on('message', this.messageReceivedFromWebSocket.bind(this))

		this.ws.on('error', (data) => {
			this.log('error', `AdIT instance Control Interface WebSocket error: ${data}`)
		})
	}

	messageReceivedFromWebSocket(data) {
		if (this.config.log_control_interface_messages) {
			this.log('debug', `AdIT Control Interface message received: ${data}`)
		}

		var myThis = this
		xml2js.parseString(data, function (err, result) {
			if (result.Variable != null) {
				//This is a variable XML message that was received
				myThis.setVariable(result.Variable.$.ID, result.Variable._)
			}
		})
	}

	config_fields() {
		return [
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
				label: 'AdIT Mangement Service Port Number',
				tooltip: 'The port number of the AdIT Management Service',
				default: '8000',
				width: 6,
				regex: this.REGEX_NUMBER
			},
			{
				type: 'textinput',
				id: 'instance_ip',
				label: 'AdIT Instance IP Address',
				tooltip: 'The IP address of the server hosting the AdIT instance',
				default: '127.0.0.1',
				width: 6
			},
			{
				type: 'textinput',
				id: 'instance_port',
				label: 'AdIT Instance Control Interface Port Number',
				tooltip: 'The port number of the AdIT instance Control Interface',
				default: '9091',
				width: 6,
				regex: this.REGEX_NUMBER
			},
			{
				type: 'dropdown',
				id: 'channel',
				label: 'Channel',
				width: 12,
				choices: this.getChannelChoices()
			},
			{
				type: 'checkbox',
				id: 'log_control_interface_messages',
				label: 'Log Control Interface Messages',
				tooltip: 'Log all AdIT instance Control Interface messages',
				width: 6,
				default: '1'
			}
		]
	}

	initFeedbacks() {
		this.setFeedbackDefinitions({})
	}

	getChannelChoices() {
		var toReturn = []
		if (this.aditChannelDefinitions) {
			this.aditChannelDefinitions.forEach((c) => {
				toReturn.push({
					id: c.ID,
					label: c.Name
				})
			})
		}
		return toReturn
	}

	getManualRuleChoices() {
		var toReturn = []
		if (this.aditManualRuleDefinitions) {
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
		var toReturn = []
		if (this.aditVariableDefinitions) {
			this.aditVariableDefinitions.forEach((v) => {
				toReturn.push({
					id: v.ID,
					label: v.Name
				})
			})
		}
		return toReturn
	}

	actions(system) {
		this.setActions({
			set_variable_value: {
				label: 'Set Variable Value',
				options: [
					{
						type: 'dropdown',
						id: 'variable',
						label: 'Variable',
						width: 6,
						choices: this.getVariableChoices(),
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
					var obj = { SetVariableValueRequest: { $: { ID: action.options.variable }, _: action.options.value } }
					var builder = new xml2js.Builder()
					var xml = builder.buildObject(obj)

					//Send XML to AdIT instance via Control Interface WebSocket
					this.ws.send(xml + '\r\n')

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
						choices: this.getManualRuleChoices(),
						required: true
					}
				],
				callback: (action) => {
					this.log('info', `Sending request to evaluate messaging rule ID: ${action.options.messaging_rule}`)

					//Construct XML request to set variable value
					var obj = { EvaluateManualMessagingRuleRequest: { $: { ID: action.options.messaging_rule } } }
					var builder = new xml2js.Builder()
					var xml = builder.buildObject(obj)

					//Send XML to AdIT instance via Control Interface WebSocket
					this.ws.send(xml + '\r\n')

					//Finally, if option is turned on, log the message that was sent
					if (this.config.log_control_interface_messages) {
						this.log('debug', `AdIT Control Interface message sent: ${xml}`)
					}
				}
			}
		})
	}
}

exports = module.exports = instance
