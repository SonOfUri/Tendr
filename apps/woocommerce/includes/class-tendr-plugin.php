<?php
/**
 * Bootstrap: requirements, hooks, and the API and checkout base URLs.
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

/**
 * The plugin.
 */
final class Tendr_Plugin {

	const MIN_PHP = '8.0';
	const MIN_WC  = '8.5';

	const DEFAULT_API_BASE      = 'https://api.usetendr.tech';
	const DEFAULT_CHECKOUT_BASE = 'https://usetendr.tech';

	/**
	 * Whether boot() already registered the hooks.
	 *
	 * @var bool
	 */
	private static bool $booted = false;

	/**
	 * `plugins_loaded`: boot with the running PHP and WooCommerce versions.
	 */
	public static function init(): void {
		$wc = ( class_exists( 'WooCommerce' ) && defined( 'WC_VERSION' ) ) ? WC_VERSION : null;
		self::boot( PHP_VERSION, $wc );
	}

	/**
	 * Register the plugin's hooks, or only an admin notice when a requirement is not met.
	 *
	 * @param string      $php_version PHP version.
	 * @param string|null $wc_version  WooCommerce version, or null when WooCommerce is not active.
	 * @return bool Whether the plugin booted.
	 */
	public static function boot( string $php_version, ?string $wc_version ): bool {
		$error = self::requirement_error( $php_version, $wc_version );
		if ( null !== $error ) {
			add_action(
				'admin_notices',
				static function () use ( $error ) {
					if ( current_user_can( 'activate_plugins' ) ) {
						echo self::requirements_notice_html( $error ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in requirements_notice_html().
					}
				}
			);
			return false;
		}
		if ( self::$booted ) {
			return true;
		}
		self::$booted = true;

		add_filter( 'woocommerce_payment_gateways', array( self::class, 'register_gateway' ) );
		Tendr_Connect::register();
		Tendr_Settings::register();
		Tendr_Brand::register();
		Tendr_Order_Status::register();
		Tendr_Webhooks::register();
		Tendr_Order_Sync::register();
		Tendr_Refunds::register();
		Tendr_Test_Purchase::register();
		if ( class_exists( 'Tendr_Gateway' ) ) {
			Tendr_Gateway::register();
		}
		add_action( 'woocommerce_blocks_payment_method_type_registration', array( self::class, 'register_blocks' ) );
		return true;
	}

	/**
	 * Why the plugin cannot run here, or null when it can.
	 *
	 * @param string      $php_version PHP version.
	 * @param string|null $wc_version  WooCommerce version, or null when WooCommerce is not active.
	 */
	public static function requirement_error( string $php_version, ?string $wc_version ): ?string {
		if ( version_compare( $php_version, self::MIN_PHP, '<' ) ) {
			/* translators: %s: the PHP version this site runs. */
			return sprintf( __( 'tendr: Pay with crypto needs PHP 8.0 or later. This site runs PHP %s.', 'tendr' ), $php_version );
		}
		if ( null === $wc_version ) {
			return __( 'tendr: Pay with crypto needs WooCommerce. Install and activate WooCommerce 8.5 or later.', 'tendr' );
		}
		if ( version_compare( $wc_version, self::MIN_WC, '<' ) ) {
			/* translators: %s: the WooCommerce version this site runs. */
			return sprintf( __( 'tendr: Pay with crypto needs WooCommerce 8.5 or later. This site runs WooCommerce %s.', 'tendr' ), $wc_version );
		}
		return null;
	}

	/**
	 * An admin error notice.
	 *
	 * @param string $message Plain text.
	 */
	public static function requirements_notice_html( string $message ): string {
		return '<div class="notice notice-error"><p>' . esc_html( $message ) . '</p></div>';
	}

	/**
	 * `woocommerce_payment_gateways`.
	 *
	 * @param array $gateways Gateway class names.
	 */
	public static function register_gateway( $gateways ): array {
		$gateways   = is_array( $gateways ) ? $gateways : array();
		$gateways[] = Tendr_Gateway::class;
		return $gateways;
	}

	/**
	 * `woocommerce_blocks_payment_method_type_registration`: "Pay with crypto" in the block checkout.
	 *
	 * @param object $registry Automattic\WooCommerce\Blocks\Payments\PaymentMethodRegistry.
	 */
	public static function register_blocks( $registry ): void {
		if ( ! class_exists( \Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType::class ) || ! class_exists( 'Tendr_Gateway' ) ) {
			return;
		}
		require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-blocks.php';
		Tendr_Blocks::register( $registry );
	}

	/**
	 * The tendr API, e.g. `https://api.usetendr.tech` (`TENDR_API_BASE` in wp-config.php overrides it).
	 */
	public static function api_base(): string {
		$base = defined( 'TENDR_API_BASE' ) ? (string) constant( 'TENDR_API_BASE' ) : self::DEFAULT_API_BASE;
		return untrailingslashit( $base );
	}

	/**
	 * The tendr site hosting `/connect` and checkout (`TENDR_CHECKOUT_BASE` overrides it).
	 */
	public static function checkout_base(): string {
		$base = defined( 'TENDR_CHECKOUT_BASE' ) ? (string) constant( 'TENDR_CHECKOUT_BASE' ) : self::DEFAULT_CHECKOUT_BASE;
		return untrailingslashit( $base );
	}

	/**
	 * A tendr dashboard page for this site's store and a mode (M3): `?store=<store id>&mode=…`, so
	 * a merchant with several stores, or whose dashboard is in the other mode, lands on the right
	 * queue.
	 *
	 * @param string $path Dashboard path, e.g. `/dashboard/review`.
	 * @param string $mode 'test' | 'live'.
	 */
	public static function dashboard_url( string $path, string $mode ): string {
		$args       = array();
		$connection = class_exists( 'Tendr_Connect' ) ? Tendr_Connect::connection() : null;
		$store      = is_array( $connection ) ? (string) ( $connection['store_id'] ?? '' ) : '';
		if ( '' !== $store && preg_match( '/^[A-Za-z0-9_]{1,64}$/', $store ) ) {
			$args['store'] = $store;
		}
		$args['mode'] = 'live' === $mode ? 'live' : 'test';
		return add_query_arg( $args, self::checkout_base() . $path );
	}

	/**
	 * `tendr-woocommerce/<plugin> WordPress/<wp> WooCommerce/<wc>`.
	 */
	public static function user_agent(): string {
		global $wp_version;
		$wc = defined( 'WC_VERSION' ) ? WC_VERSION : 'unknown';
		return sprintf( 'tendr-woocommerce/%s WordPress/%s WooCommerce/%s', TENDR_VERSION, (string) $wp_version, $wc );
	}
}
