<?php
/**
 * The tendr payment gateway. For now it only owns the settings page (WooCommerce → Settings →
 * Payments → tendr); checkout arrives in a later task, and until then it is never offered to
 * shoppers.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * Gateway `tendr`.
 */
class Tendr_Gateway extends WC_Payment_Gateway {

	/**
	 * Set up the gateway.
	 */
	public function __construct() {
		$this->id                 = 'tendr';
		$this->method_title       = __( 'tendr', 'tendr' );
		$this->method_description = __( 'Take crypto payments that settle into your own tendr account.', 'tendr' );
		$this->title              = __( 'Pay with crypto', 'tendr' );
		$this->has_fields         = false;
		$this->supports           = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();
		$this->enabled = $this->get_option( 'enabled', 'no' );
	}

	/**
	 * Settings fields. `enabled` is managed by Connect and Disconnect, and by the Payments list toggle.
	 */
	public function init_form_fields() {
		$this->form_fields = array(
			'enabled' => array(
				'title'   => __( 'Enable/Disable', 'tendr' ),
				'type'    => 'checkbox',
				'label'   => __( 'Enable tendr', 'tendr' ),
				'default' => 'no',
			),
		);
	}

	/**
	 * The settings page: Connect / connected state. WooCommerce's Save button is hidden because
	 * every action here is its own request.
	 */
	public function admin_options() {
		$GLOBALS['hide_save_button'] = true; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- WooCommerce's documented switch.
		echo Tendr_Settings::render(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in Tendr_Settings::render().
	}

	/**
	 * Nothing to save from this page.
	 */
	public function process_admin_options() {
		return false;
	}

	/**
	 * Not offered at checkout until checkout support lands.
	 */
	public function is_available() {
		return false;
	}
}
