<?php
/**
 * "Pay with crypto" in the WooCommerce Blocks checkout. The block checkout places the order
 * through the Store API, which calls Tendr_Gateway::process_payment() and follows its redirect
 * to the order-pay step, where the tendr modal opens: the same flow as the classic checkout.
 *
 * Loaded only when WooCommerce Blocks' AbstractPaymentMethodType exists.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;
use Automattic\WooCommerce\Blocks\Payments\PaymentMethodRegistry;

/**
 * Blocks payment method `tendr`.
 */
final class Tendr_Blocks extends AbstractPaymentMethodType {

	/**
	 * Payment method name (the gateway id).
	 *
	 * @var string
	 */
	protected $name = 'tendr';

	/**
	 * `woocommerce_blocks_payment_method_type_registration`.
	 *
	 * @param PaymentMethodRegistry $registry Registry.
	 */
	public static function register( $registry ): void {
		$registry->register( new self() );
	}

	/**
	 * Load the gateway settings.
	 */
	public function initialize() {
		$settings       = get_option( 'woocommerce_tendr_settings', array() );
		$this->settings = is_array( $settings ) ? $settings : array();
	}

	/**
	 * Enabled and connected. Per-shopper availability (test mode is for store managers only) is
	 * the gateway's is_available(), which the Store API applies.
	 */
	public function is_active() {
		return 'yes' === $this->get_setting( 'enabled', 'no' ) && Tendr_Connect::is_connected();
	}

	/**
	 * The checkout script.
	 *
	 * @return string[]
	 */
	public function get_payment_method_script_handles() {
		if ( ! wp_script_is( 'tendr-blocks', 'registered' ) ) {
			wp_register_script(
				'tendr-blocks',
				plugins_url( 'assets/js/blocks.js', TENDR_PLUGIN_FILE ),
				array( 'wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities', 'wp-i18n' ),
				TENDR_VERSION,
				true
			);
			wp_set_script_translations( 'tendr-blocks', 'tendr-pay-with-crypto' );
		}
		return array( 'tendr-blocks' );
	}

	/**
	 * What the script reads (`getSetting('tendr_data')`). No keys or secrets.
	 */
	public function get_payment_method_data() {
		$gateway = new Tendr_Gateway();
		return array(
			'title'       => $gateway->get_title(),
			'description' => $gateway->get_description(),
			'icon'        => $gateway->icon,
			'paymentHint' => __( 'Your order updates automatically after payment confirmation.', 'tendr-pay-with-crypto' ),
			'buttonLabel' => __( 'Pay with crypto', 'tendr-pay-with-crypto' ),
			'testMode'    => 'test' === Tendr_Connect::mode(),
			'supports'    => array_values( array_filter( $gateway->supports, array( $gateway, 'supports' ) ) ),
		);
	}
}
