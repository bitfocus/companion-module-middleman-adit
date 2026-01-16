/**
 * @fileoverview Companion action definitions for controlling AdIT
 * 
 * Defines actions for setting variable values and triggering manual messaging rules. 
 * Actions send XML commands to all connected instances via the engine.
 * 
 * @module companion-module-middleman-adit/actions
 */
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

					// Construct XML request to set variable value
					let val = await self.parseVariablesInString(action.options.value)

					let obj = { SetVariableValueRequest: { $: { ID: action.options.variable }, _: val } }

					let builder = new xml2js.Builder()
					let xml = builder.buildObject(obj)

					// Send XML to AdIT instance via Control Interface WebSocket
					// Uses the class method from index.js which delegates to engine.sendToAllInstances()
					self.sendMessage(xml + '\r\n')

					// Log the message if verbose logging is enabled
					if (self.config.verbose) {
						self.log('debug', `AdIT control interface message sent: ${xml}`)
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

					// Construct XML request to evaluate manual rule
					let obj = { EvaluateManualMessagingRuleRequest: { $: { ID: action.options.messaging_rule } } }
					let builder = new xml2js.Builder()
					let xml = builder.buildObject(obj)

					// Send XML to AdIT instance via Control Interface WebSocket
					// Uses the class method from index.js which delegates to engine.sendToAllInstances()
					self.sendMessage(xml + '\r\n')

					// Log the message if verbose logging is enabled
					if (self.config.verbose) {
						self.log('debug', `AdIT control interface message sent: ${xml}`)
					}
				},
			},
		})
	},

	/**
	 * Sends a message to all connected AdIT instances.
	 * Delegates to engine.sendToAllInstances() which uses the Map-based
	 * architecture for reliable instance tracking.
	 *
	 * @param {string} msg - XML message to send
	 */
	sendMessage(msg) {
		if (this.engine) {
			this.engine.sendToAllInstances(msg)
		}
	},
}