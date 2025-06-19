const xml2js = require('xml2js')

module.exports = {
	initActions() {
		let self = this

		self.setActionDefinitions({
			set_variable_value: {
				name: 'Set Variable Value',
				options: [
					{
						type: 'dropdown',
						id: 'variable',
						label: 'Variable',
						width: 6,
						choices: self.getVariableChoices(),
						required: true,
					},
					{
						type: 'textinput',
						label: 'Value',
						id: 'value',
						default: '',
						useVariables: true,
					},
				],
				callback: async (action) => {
					self.log(
						'debug',
						`Sending request to set variable: ${action.options.variable} to value: ${action.options.value}`,
					)

					//Construct XML request to set variable value
					let val = await self.parseVariablesInString(action.options.value)

					let obj = { SetVariableValueRequest: { $: { ID: action.options.variable }, _: val } }

					let builder = new xml2js.Builder()
					let xml = builder.buildObject(obj)

					//Send XML to AdIT instance via Control Interface WebSocket
					self.sendMessage(xml + '\r\n')

					//Finally, if option is turned on, log the message that was sent
					if (self.config.log_control_interface_messages) {
						self.log('info', `AdIT control interface message sent: ${xml}`)
					}
				},
			},
			evaluate_manual_rule: {
				name: 'Evaluate Messaging Rule',
				options: [
					{
						type: 'dropdown',
						id: 'messaging_rule',
						label: 'Messaging Rule',
						tooltip: 'Only messaging rules with rule type Manual will appear in this list.',
						width: 6,
						choices: self.getManualRuleChoices(),
						required: true,
					},
				],
				callback: (action) => {
					self.log('debug', `Sending request to evaluate messaging rule: ${action.options.messaging_rule}`)

					//Construct XML request to set variable value
					let obj = { EvaluateManualMessagingRuleRequest: { $: { ID: action.options.messaging_rule } } }
					let builder = new xml2js.Builder()
					let xml = builder.buildObject(obj)

					//Send XML to AdIT instance via Control Interface WebSocket
					self.sendMessage(xml + '\r\n')

					//Finally, if option is turned on, log the message that was sent
					if (self.config.log_control_interface_messages) {
						self.log('info', `AdIT control interface message sent: ${xml}`)
					}
				},
			},
		})
	},

	sendMessage(msg) {
		let self = this

		for (let i = 0; i < self.aditInstanceWebSockets.length; i++) {
			if (self.aditInstanceWebSockets[i].state == 'open') {
				let aditInstance = self.aditInstanceDefinitions.find((x) => x.ID == self.aditInstanceWebSockets[i].ID)
				if (self.config.verbose) {
					self.log('debug', `Sending message to AdIT instance: "${aditInstance.Name}" (${aditInstance.ID})`)
				}
				self.aditInstanceWebSockets[i].ws.send(msg)
			}
		}
	},
}
